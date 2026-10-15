// Commande vocale du bureau : interpréter une phrase (dictée Whisper, texte
// tapé, message du compagnon) en une action de Lumen Desktop.
//
// DEUX ÉTAGES, et l'ordre compte :
//   1. une grammaire déterministe (ce fichier) — 0 token, instantanée, hors
//      ligne : « ouvre Notes », « cherche facture 2026 », « mode sombre »… ;
//   2. en repli, et seulement si l'utilisateur l'a activé, un petit routeur
//      LLM (cf. lib/lfm.js) avec un schéma JSON de quelques actions.
// Aucun outil n'est ajouté au catalogue des conversations : la commande vocale
// vit à côté du chat, pas dedans, ce qui ne coûte rien au contexte du modèle.
//
// Ce module est PUR (pas de DOM, pas de Tauri) pour rester testable en Node :
// le bureau lui passe ses données (apps, fichiers, workflows) et ses gestes
// via `ctx`, cf. `interpret()`.

// ===== Réglages ===============================================================

export const VOICE_PREFS_KEY = "voiceControl";
export const DEFAULT_VOICE_PREFS = Object.freeze({
  enabled: false,      // OFF par défaut : rien n'est chargé tant que c'est faux
  shortcut: "alt+space", // maintenir pour parler (push-to-talk)
  router: false,       // étage 2 (routeur LLM) si la grammaire ne comprend pas
  intents: false,      // le routeur peut aussi viser les intentions des apps
  speak: false,        // confirmer à la voix (Piper) l'action exécutée
});

export function voiceControlPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) || "{}");
    return { ...DEFAULT_VOICE_PREFS, ...(raw && typeof raw === "object" ? raw : {}) };
  } catch {
    return { ...DEFAULT_VOICE_PREFS };
  }
}

export function saveVoiceControlPrefs(patch) {
  const next = { ...voiceControlPrefs(), ...patch };
  try { localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(next)); } catch {}
  return next;
}

export function voiceControlEnabled() {
  return voiceControlPrefs().enabled === true;
}

// ===== Normalisation ==========================================================

/** Minuscules, sans accents ni ponctuation, espaces réduits. */
export function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[^\p{L}\p{N}\s.\-_/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distance de Levenshtein bornée — assez pour absorber une faute de Whisper. */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Forme phonétique grossière, pour rapprocher ce que Whisper a entendu de ce
 * qui est écrit (« fotos » ↔ « Photos », « kanbane » ↔ « Kanban »).
 */
export function phonetic(s) {
  return normalizeText(s)
    .replace(/ph/g, "f").replace(/ck|qu|k/g, "c").replace(/y/g, "i")
    .replace(/h/g, "").replace(/(.)\1+/g, "$1").replace(/e\b/g, "");
}

// ===== Grammaire ==============================================================
// Les verbes sont volontairement larges : Whisper transcrit ce qu'il entend,
// et l'utilisateur ne dira pas deux fois la même chose.

const VERBS = {
  fr: {
    open: ["ouvre", "ouvrir", "ouvres", "lance", "lancer", "demarre", "demarrer", "affiche", "afficher", "montre", "montrer", "va dans", "va sur", "aller dans", "aller sur", "passe sur", "bascule sur"],
    search: ["cherche", "chercher", "recherche", "rechercher", "trouve", "trouver", "retrouve", "retrouver"],
    file: ["le fichier", "un fichier", "fichier", "le document", "document"],
    workflow: ["le workflow", "workflow", "l automatisation", "automatisation"],
    app: ["l application", "l app", "application", "app"],
    ask: ["demande a lumen", "demande lumen", "dis a lumen", "lumen"],
  },
  en: {
    open: ["open", "launch", "start", "show", "go to", "switch to"],
    search: ["search", "search for", "find", "look for", "look up"],
    file: ["the file", "a file", "file", "the document", "document"],
    workflow: ["the workflow", "workflow", "the automation", "automation"],
    app: ["the app", "the application", "app", "application"],
    ask: ["ask lumen", "tell lumen", "lumen"],
  },
};

/** Commandes fixes : tournures acceptées par langue → identifiant d'action. */
export const FIXED_COMMANDS = [
  { id: "new_conversation", fr: ["nouvelle discussion", "nouvelle conversation", "nouveau chat", "nouvelle conv"], en: ["new conversation", "new chat", "new discussion"] },
  { id: "close_window", fr: ["ferme la fenetre", "fermer la fenetre", "ferme cette fenetre", "ferme"], en: ["close the window", "close window", "close this window", "close"] },
  { id: "minimize_window", fr: ["reduis la fenetre", "reduire la fenetre", "minimise la fenetre", "reduis"], en: ["minimize the window", "minimise the window", "minimize window", "minimize"] },
  { id: "show_desktop", fr: ["reduis tout", "reduire tout", "montre le bureau", "afficher le bureau", "affiche le bureau", "masque tout", "cache tout"], en: ["show desktop", "show the desktop", "minimize all", "minimise all", "hide everything"] },
  { id: "fullscreen", fr: ["plein ecran", "mode plein ecran", "passe en plein ecran"], en: ["full screen", "fullscreen", "go full screen"] },
  { id: "theme_dark", fr: ["mode sombre", "theme sombre", "passe en sombre", "mode nuit"], en: ["dark mode", "dark theme", "night mode", "switch to dark"] },
  { id: "theme_light", fr: ["mode clair", "theme clair", "passe en clair", "mode jour"], en: ["light mode", "light theme", "day mode", "switch to light"] },
  // `open_search` OUVRE le panneau ⌘K ; `search` (plus bas) cherche des
  // fichiers ou du contenu. Deux choses différentes, deux identifiants —
  // les confondre ferait passer « cherche facture » pour « ouvre la recherche ».
  { id: "open_search", fr: ["recherche", "rechercher", "ouvre la recherche"], en: ["search", "open search", "open the search"] },
  { id: "help", fr: ["aide", "raccourcis", "affiche les raccourcis", "que peux tu faire", "que sais tu faire"], en: ["help", "shortcuts", "show shortcuts", "what can you do"] },
  { id: "notifications", fr: ["notifications", "ouvre les notifications", "centre de notifications"], en: ["notifications", "open notifications", "notification center", "notification centre"] },
  { id: "settings", fr: ["reglages", "ouvre les reglages", "parametres", "ouvre les parametres", "preferences"], en: ["settings", "open settings", "preferences", "open preferences"] },
  { id: "lock", fr: ["verrouille", "verrouille la session", "verrouiller", "deconnexion"], en: ["lock", "lock the session", "log out", "sign out"] },
];

/** Actions destructrices : on demande confirmation avant d'agir. */
export const CONFIRM_ACTIONS = new Set(["close_window", "lock"]);

function stripLead(text, leads) {
  for (const lead of [...leads].sort((a, b) => b.length - a.length)) {
    if (text === lead) return "";
    if (text.startsWith(lead + " ")) return text.slice(lead.length + 1).trim();
  }
  return null;
}

function stripArticles(text, lang) {
  const arts = lang === "en" ? ["the", "a", "an", "my"] : ["le", "la", "les", "l", "un", "une", "des", "mon", "ma", "mes"];
  const words = text.split(" ");
  while (words.length > 1 && arts.includes(words[0])) words.shift();
  return words.join(" ");
}

/**
 * Analyse une phrase. Renvoie { kind, arg } — `kind` parmi :
 * open_app | search | open_file | workflow | ask | <commande fixe> | none.
 * Pur et synchrone : ne connaît ni les apps ni les fichiers, seulement la
 * forme de la phrase ; `interpret()` fait ensuite le lien avec les données.
 */
export function parseCommand(input, lang = "fr") {
  const L = VERBS[lang] || VERBS.fr;
  const text = normalizeText(input).replace(/[.]+$/, "").trim();
  if (!text) return { kind: "none", arg: "" };

  // Politesse : « s'il te plaît », « please » — n'apportent rien.
  const cleaned = text.replace(/\b(s il te plait|s il vous plait|please|stp|svp)\b/g, " ").replace(/\s+/g, " ").trim();

  // 1) « demande à Lumen … » prime : c'est l'issue de secours explicite.
  const asked = stripLead(cleaned, L.ask);
  if (asked) return { kind: "ask", arg: asked };

  // 2) Commandes fixes, phrase entière.
  for (const cmd of FIXED_COMMANDS) {
    const forms = cmd[lang] || cmd.fr;
    if (forms.includes(cleaned)) return { kind: cmd.id, arg: "" };
  }

  // 3) Verbe + complément.
  let rest = stripLead(cleaned, L.open);
  if (rest !== null) {
    if (!rest) return { kind: "open_search", arg: "" };
    const wf = stripLead(rest, L.workflow);
    if (wf) return { kind: "workflow", arg: wf };
    const file = stripLead(rest, L.file);
    if (file) return { kind: "open_file", arg: file };
    const app = stripLead(rest, L.app);
    const target = stripArticles(app ?? rest, lang);
    // « ouvre les réglages » etc. : une commande fixe formulée avec un verbe.
    for (const cmd of FIXED_COMMANDS) {
      const forms = cmd[lang] || cmd.fr;
      if (forms.includes(target) || forms.includes(rest)) return { kind: cmd.id, arg: "" };
    }
    return { kind: "open_app", arg: target };
  }
  rest = stripLead(cleaned, L.search);
  if (rest !== null) {
    if (!rest) return { kind: "open_search", arg: "" };
    const file = stripLead(rest, L.file);
    return { kind: "search", arg: stripArticles(file ?? rest, lang) };
  }
  const wf = stripLead(cleaned, [...L.workflow.map((w) => `${lang === "en" ? "run" : "execute"} ${w}`), ...(lang === "en" ? ["run workflow", "run the workflow"] : ["execute le workflow", "execute workflow", "joue le workflow"])]);
  if (wf) return { kind: "workflow", arg: wf };

  return { kind: "none", arg: cleaned };
}

// ===== Correspondance avec les données du bureau ===============================

/**
 * Trouve l'app désignée. `apps` : [{ id, name, aliases? }]. Tolère une faute
 * ou deux (Whisper entend « note » pour « Notes ») et les noms partiels.
 * @returns {{ best: object|null, candidates: object[] }}
 */
export function matchApp(query, apps) {
  const q = normalizeText(query);
  if (!q) return { best: null, candidates: [] };
  const scored = [];
  for (const app of apps || []) {
    const names = [app.name, app.id, ...(app.aliases || [])].filter(Boolean).map(normalizeText);
    let score = 0;
    for (const n of names) {
      if (n === q) score = Math.max(score, 100);
      else if (n.startsWith(q) || q.startsWith(n)) score = Math.max(score, 80);
      else if (n.includes(q) || q.includes(n)) score = Math.max(score, 60);
      else if (phonetic(n) === phonetic(q)) score = Math.max(score, 70);
      else {
        // Tolérance phonétique : distance relative à la longueur du nom.
        const d = editDistance(n, q);
        const tol = n.length >= 8 ? 3 : n.length >= 5 ? 2 : 1;
        if (d <= tol) score = Math.max(score, 50 - d * 5);
      }
    }
    if (score > 0) scored.push({ app, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.map((s) => s.app);
  if (!scored.length) return { best: null, candidates };
  // Un gagnant net : score dominant, ou seul candidat.
  const top = scored[0];
  const second = scored[1];
  const clear = !second || top.score - second.score >= 20;
  return { best: clear ? top.app : null, candidates: candidates.slice(0, 6) };
}

/**
 * Fichiers dont le chemin contient tous les mots de la requête. `files` :
 * [{ path, sandbox, id }]. Les chemins courts d'abord (le plus précis).
 */
export function matchFiles(query, files) {
  const words = normalizeText(query).split(" ").filter((w) => w.length > 1);
  if (!words.length) return [];
  const hits = [];
  for (const f of files || []) {
    const hay = normalizeText(f.path);
    if (words.every((w) => hay.includes(w))) hits.push(f);
  }
  hits.sort((a, b) => a.path.length - b.path.length);
  return hits.slice(0, 12);
}

/** Workflow désigné, tolérant (nom partiel, faute légère). */
export function matchWorkflow(query, names) {
  const q = normalizeText(query);
  const list = (names || []).map((n) => ({ n, k: normalizeText(n) }));
  const exact = list.find((x) => x.k === q);
  if (exact) return exact.n;
  const partial = list.filter((x) => x.k.includes(q) || q.includes(x.k));
  if (partial.length === 1) return partial[0].n;
  const near = list.filter((x) => editDistance(x.k, q) <= 2);
  if (near.length === 1) return near[0].n;
  return null;
}

// ===== Étage 2 : routeur LLM (optionnel) =======================================

export const VOICE_ROUTER_ACTIONS = ["open_app", "search_files", "open_file", "run_workflow", "set_theme", "new_conversation", "ask_assistant", "none"];

export const VOICE_ROUTER_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: VOICE_ROUTER_ACTIONS },
    target: { type: "string" },
  },
  required: ["action"],
};

/**
 * Consigne du routeur : courte, avec la liste des apps (noms exacts) et des
 * workflows, pour qu'il renvoie une cible que le bureau saura ouvrir.
 */
export function voiceRouterSystem({ lang = "fr", apps = [], workflows = [], intents = [] } = {}) {
  const appNames = apps.map((a) => a.name).filter(Boolean).join(", ");
  const wf = workflows.length ? workflows.join(", ") : "";
  const it = intents.length ? intents.map((i) => i.name).join(", ") : "";
  if (lang === "en") {
    return [
      "You turn a spoken command into ONE desktop action for Lumen. Reply with JSON only: {\"action\": …, \"target\": …}.",
      `Actions: ${VOICE_ROUTER_ACTIONS.join(", ")}. target = exact app name, file words, workflow name, \"dark\"/\"light\", or the question for ask_assistant.`,
      `Apps: ${appNames}.`,
      wf ? `Workflows: ${wf}.` : "",
      it ? `App intents (use action \"intent\" with target = intent name): ${it}.` : "",
      "If the sentence is a question or a request for content, use ask_assistant. If nothing fits, use none.",
    ].filter(Boolean).join("\n");
  }
  return [
    "Tu transformes une commande vocale en UNE action du bureau Lumen. Réponds en JSON seulement : {\"action\": …, \"target\": …}.",
    `Actions : ${VOICE_ROUTER_ACTIONS.join(", ")}. target = nom exact de l'app, mots du fichier, nom du workflow, \"dark\"/\"light\", ou la question pour ask_assistant.`,
    `Apps : ${appNames}.`,
    wf ? `Workflows : ${wf}.` : "",
    it ? `Intentions d'apps (action \"intent\", target = nom de l'intention) : ${it}.` : "",
    "Si la phrase est une question ou une demande de contenu, choisis ask_assistant. Si rien ne convient, none.",
  ].filter(Boolean).join("\n");
}

// ===== Interprétation complète =================================================

/**
 * Transforme une phrase en action exécutable.
 *
 * @param {string} text
 * @param {object} ctx
 *   lang       : "fr" | "en"
 *   apps       : () => [{ id, name, aliases? }]
 *   files      : async () => [{ path, sandbox, id }]   (index de la recherche globale)
 *   workflows  : async () => string[]
 *   router     : async (text) => { action, target } | null   (étage 2, optionnel)
 * @returns {Promise<{ kind, label, run?, choices?, confirm?, arg? }>}
 *   run      : la fonction à appeler (sur `ctx.actions`) — absente si `choices`.
 *   choices  : plusieurs cibles plausibles [{ label, sub, run }] — à faire choisir.
 *   confirm  : vrai si l'action mérite une confirmation avant exécution.
 */
export async function interpret(text, ctx) {
  const lang = ctx.lang === "en" ? "en" : "fr";
  const T = (fr, en) => (lang === "en" ? en : fr);
  const A = ctx.actions || {};
  let cmd = parseCommand(text, lang);

  const fixed = (kind) => ({
    new_conversation: { label: T("Nouvelle discussion", "New conversation"), run: A.newConversation },
    close_window: { label: T("Fermer la fenêtre", "Close the window"), run: A.closeWindow },
    minimize_window: { label: T("Réduire la fenêtre", "Minimize the window"), run: A.minimizeWindow },
    show_desktop: { label: T("Afficher le bureau", "Show the desktop"), run: A.showDesktop },
    fullscreen: { label: T("Plein écran", "Full screen"), run: A.fullscreen },
    theme_dark: { label: T("Mode sombre", "Dark mode"), run: () => A.setTheme?.("dark") },
    theme_light: { label: T("Mode clair", "Light mode"), run: () => A.setTheme?.("light") },
    open_search: { label: T("Recherche", "Search"), run: () => A.search?.("") },
    help: { label: T("Aide", "Help"), run: A.help },
    notifications: { label: T("Notifications", "Notifications"), run: A.notifications },
    settings: { label: T("Réglages", "Settings"), run: A.settings },
    lock: { label: T("Verrouiller la session", "Lock the session"), run: A.lock },
  })[kind];

  const resolveApp = (name) => {
    const { best, candidates } = matchApp(name, ctx.apps?.() || []);
    if (best) return { kind: "open_app", label: T(`Ouvrir ${best.name}`, `Open ${best.name}`), run: () => A.openApp?.(best.id), arg: best.id };
    if (candidates.length) {
      return {
        kind: "open_app", label: T("Quelle app ?", "Which app?"), arg: name,
        choices: candidates.map((app) => ({ label: app.name, sub: app.desc || "", run: () => A.openApp?.(app.id) })),
      };
    }
    return null;
  };

  const resolveFiles = async (query, openSingle) => {
    const hits = matchFiles(query, await (ctx.files?.() || []));
    if (hits.length === 1 && openSingle) {
      const f = hits[0];
      return { kind: "open_file", label: T(`Ouvrir ${f.path}`, `Open ${f.path}`), run: () => A.openFile?.(f), arg: f.path };
    }
    if (hits.length) {
      return {
        kind: "search", label: T(`Fichiers pour « ${query} »`, `Files for “${query}”`), arg: query,
        choices: hits.map((f) => ({ label: f.path.split("/").pop(), sub: `${f.sandbox} · ${f.path}`, run: () => A.openFile?.(f) })),
      };
    }
    // Rien dans l'index : la recherche globale préremplie fera la recherche de contenu.
    return { kind: "search", label: T(`Rechercher « ${query} »`, `Search “${query}”`), run: () => A.search?.(query), arg: query };
  };

  const resolveWorkflow = async (name) => {
    const wf = matchWorkflow(name, await (ctx.workflows?.() || []));
    if (!wf) return null;
    return { kind: "workflow", label: T(`Lancer le workflow ${wf}`, `Run workflow ${wf}`), run: () => A.runWorkflow?.(wf), arg: wf };
  };

  // ----- Étage 1 -----
  if (cmd.kind === "ask") return { kind: "ask", label: T("Demander à Lumen", "Ask Lumen"), run: () => A.ask?.(cmd.arg), arg: cmd.arg };
  if (fixed(cmd.kind)) return { kind: cmd.kind, confirm: CONFIRM_ACTIONS.has(cmd.kind), ...fixed(cmd.kind) };
  if (cmd.kind === "open_app") {
    const r = resolveApp(cmd.arg);
    if (r) return r;
    // « ouvre facture 2026 » : pas une app → peut-être un fichier.
    const files = matchFiles(cmd.arg, await (ctx.files?.() || []));
    if (files.length) return resolveFiles(cmd.arg, true);
    const wf = await resolveWorkflow(cmd.arg);
    if (wf) return wf;
  }
  if (cmd.kind === "open_file") return resolveFiles(cmd.arg, true);
  if (cmd.kind === "search") return resolveFiles(cmd.arg, false);
  if (cmd.kind === "workflow") {
    const wf = await resolveWorkflow(cmd.arg);
    if (wf) return wf;
  }

  // ----- Étage 2 (optionnel) -----
  if (ctx.router) {
    let decision = null;
    try { decision = await ctx.router(text); } catch { decision = null; }
    const target = String(decision?.target || "").trim();
    switch (decision?.action) {
      case "open_app": { const r = target ? resolveApp(target) : null; if (r) return r; break; }
      case "open_file": if (target) return resolveFiles(target, true); break;
      case "search_files": if (target) return resolveFiles(target, false); break;
      case "run_workflow": { const wf = target ? await resolveWorkflow(target) : null; if (wf) return wf; break; }
      case "set_theme": return /light|clair/i.test(target) ? { kind: "theme_light", ...fixed("theme_light") } : { kind: "theme_dark", ...fixed("theme_dark") };
      case "new_conversation": return { kind: "new_conversation", ...fixed("new_conversation") };
      case "intent": if (target && A.runIntent) return { kind: "intent", label: target, run: () => A.runIntent(target, decision), arg: target }; break;
      case "ask_assistant": return { kind: "ask", label: T("Demander à Lumen", "Ask Lumen"), run: () => A.ask?.(target || text), arg: target || text };
      default: break;
    }
  }

  // ----- Rien compris : proposer le chat, sans agir tout seul -----
  return {
    kind: "none", label: T("Commande non reconnue", "Command not recognised"), arg: text,
    choices: [
      { label: T("Demander à Lumen", "Ask Lumen"), sub: text, run: () => A.ask?.(text) },
      { label: T("Rechercher", "Search"), sub: text, run: () => A.search?.(text) },
    ],
  };
}
