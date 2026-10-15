// Harnais de code de l'Éditeur : boucle agent « lire → modifier → vérifier »
// sur une copie de travail EN MÉMOIRE du dossier. Rien n'est écrit sur disque :
// à la fin, l'appelant transforme la copie en diffs que l'utilisateur valide.
//
// Pourquoi un protocole d'actions JSON plutôt que les tool calls natifs ou un
// schéma strict : il passe à l'identique sur tous les backends (API cloud,
// Lumen Server, Ollama, llama.cpp, Apple FM). On demande `json: true`
// (response_format json_object) SANS schéma — c'est le schéma strict dérivé
// de l'exemple qui faisait répondre HTTP 400 aux API OpenAI.
//
// Le module est pur (pas de DOM) : `llm` et `runtimeCheck` sont injectés, ce qui
// permet de le rejouer hors navigateur (npm run eval:code).

export const HARNESS_LIMITS = {
  maxSteps: 12,            // tours LLM maximum
  inlineBudget: 24000,     // caractères de fichiers joints d'office au 1er tour
  readMax: 40000,          // caractères renvoyés par une lecture
  obsMax: 6000,            // caractères par observation renvoyée au modèle
  historyKeep: 6,          // derniers échanges conservés en entier
};

const SYSTEM = `Tu es un agent de code dans l'Éditeur de Lumen. Tu travailles sur une app web (HTML, CSS, JS) contenue dans un dossier, via des ACTIONS que le harnais exécute sur une copie de travail.

Réponds TOUJOURS par UN SEUL objet JSON, sans texte autour :
{"thought":"ce que tu fais et pourquoi (bref)","actions":[ ... ]}

Actions disponibles :
- {"type":"list"} : arborescence et tailles.
- {"type":"read","path":"app.js"} : contenu d'un fichier (numéroté).
- {"type":"write","path":"app.js","content":"..."} : crée ou remplace le fichier ENTIER.
- {"type":"edit","path":"app.js","search":"texte EXACT et UNIQUE","replace":"nouveau texte"} : édition ciblée.
- {"type":"check"} : vérifie la syntaxe JS/JSON, les liens de index.html et exécute l'app (erreurs console).
- {"type":"done","summary":"ce qui a été fait, en une ou deux phrases"} : termine.

Règles :
- Lis un fichier avant de l'éditer s'il n'est pas déjà dans le contexte.
- Préfère "edit" pour de petites modifications, "write" pour créer ou refondre.
- Aucune dépendance externe, aucun CDN ; chemins relatifs au dossier.
- Une app neuve : index.html qui lie styles.css et app.js (script defer).
- Après tes modifications, lance "check" ; corrige les erreurs signalées ; puis "done".
- Plusieurs actions par tour sont permises ; elles s'exécutent dans l'ordre.`;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} caractères coupés]` : s);

export function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..").join("/");
}

/** Extrait l'objet JSON de la réponse (balises ```, texte parasite, <think>). */
export function parseTurn(content) {
  let raw = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(raw); } catch {
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) { try { obj = JSON.parse(raw.slice(start, end + 1)); } catch {} }
  }
  if (!obj || typeof obj !== "object") return null;
  // Tolérances : une action seule, ou l'ancien format { files: [...] }.
  let actions = Array.isArray(obj.actions) ? obj.actions : obj.type ? [obj] : [];
  if (!actions.length && Array.isArray(obj.files)) {
    for (const f of obj.files) {
      if (Array.isArray(f.hunks)) f.hunks.forEach((h) => actions.push({ type: "edit", path: f.path, search: h.search, replace: h.replace }));
      else if (typeof f.content === "string") actions.push({ type: "write", path: f.path, content: f.content });
    }
    if (obj.summary) actions.push({ type: "done", summary: obj.summary });
  }
  return { thought: String(obj.thought || ""), actions: actions.filter((a) => a && typeof a === "object") };
}

/** Vérifications statiques, sans exécuter le code. */
export function staticCheck(files) {
  const problems = [];
  for (const [path, code] of Object.entries(files)) {
    if (/\.json$/i.test(path)) {
      try { JSON.parse(code); } catch (e) { problems.push(`${path} : JSON invalide (${e.message})`); }
    } else if (/\.(c|m)?js$/i.test(path)) {
      // Les modules (import/export) ne passent pas par new Function : on retire
      // les lignes d'import/export pour quand même attraper le reste.
      const body = code.replace(/^\s*import\s[^;]*;?\s*$/gm, "").replace(/^\s*export\s+(default\s+)?/gm, "");
      try { new Function(body); } catch (e) { problems.push(`${path} : erreur de syntaxe — ${e.message}`); }
    } else if (/\.html?$/i.test(path)) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      const refs = [...code.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"'#?]+)/gi)].map((m) => m[1]);
      for (const ref of refs) {
        if (/^(https?:|data:|\/\/|mailto:)/i.test(ref)) {
          if (/^(https?:|\/\/)/i.test(ref)) problems.push(`${path} : ressource externe interdite (${ref})`);
          continue;
        }
        const target = normalizePath(dir + ref);
        if (!(target in files)) problems.push(`${path} : référence vers « ${ref} » mais ce fichier n'existe pas`);
      }
    }
  }
  return problems;
}

function treeOf(files) {
  return Object.keys(files).sort().map((p) => `${p} (${files[p].length} car.)`).join("\n") || "(dossier vide)";
}

function numbered(code) {
  return code.split("\n").map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n");
}

function firstMessage(instruction, files) {
  let budget = HARNESS_LIMITS.inlineBudget;
  const shown = [];
  for (const p of Object.keys(files).sort((a, b) => files[a].length - files[b].length)) {
    if (files[p].length > budget) continue;
    budget -= files[p].length;
    shown.push(`===== ${p} =====\n${files[p]}`);
  }
  const hidden = Object.keys(files).length - shown.length;
  return `DEMANDE DE L'UTILISATEUR :\n${instruction}\n\nARBORESCENCE :\n${treeOf(files)}\n\n`
    + (shown.length ? `FICHIERS JOINTS :\n${shown.join("\n\n")}\n\n` : "")
    + (hidden ? `${hidden} fichier(s) non joints : utilise "read" si besoin.\n\n` : "")
    + `Réponds par l'objet JSON {"thought":…,"actions":[…]}.`;
}

/**
 * Lance la boucle.
 * @param {object} p
 * @param {string} p.instruction
 * @param {Record<string,string>} p.files      copie de travail (non modifiée : clonée)
 * @param {(messages:object[]) => Promise<string>} p.llm   renvoie le texte du modèle
 * @param {(files:Record<string,string>) => Promise<string[]>} [p.runtimeCheck] erreurs d'exécution
 * @param {(ev:{kind:string,title:string,body?:string}) => void} [p.onEvent]
 * @param {number} [p.maxSteps]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{files:Record<string,string>, summary:string, steps:number, status:"done"|"budget"|"stalled", problems:string[]}>}
 */
export async function runCodeHarness({ instruction, files, llm, runtimeCheck, onEvent = () => {}, maxSteps = HARNESS_LIMITS.maxSteps, signal }) {
  const work = { ...files };
  const history = [{ role: "system", content: SYSTEM }, { role: "user", content: firstMessage(instruction, work) }];
  const touched = new Set();
  let summary = "", lastProblems = [], checkedSinceWrite = false, badJson = 0, idle = 0, doneRefused = false;

  const check = async () => {
    const problems = staticCheck(work);
    if (!problems.length && runtimeCheck && Object.keys(work).some((p) => /(^|\/)index\.html?$/i.test(p))) {
      try { problems.push(...(await runtimeCheck({ ...work }))); }
      catch (e) { problems.push(`exécution impossible : ${e.message || e}`); }
    }
    lastProblems = problems; checkedSinceWrite = true;
    onEvent({ kind: problems.length ? "warn" : "ok", title: "Vérification", body: problems.length ? problems.join("\n") : "Aucune erreur détectée." });
    return problems.length ? `PROBLÈMES (${problems.length}) :\n- ${problems.join("\n- ")}` : "OK : aucune erreur de syntaxe, liens valides, exécution sans erreur.";
  };

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) throw new Error("Arrêté.");
    onEvent({ kind: "think", title: `Étape ${step}/${maxSteps}`, body: "Demande envoyée à l'IA." });
    const content = await llm(compact(history));
    history.push({ role: "assistant", content: String(content || "") });
    const turn = parseTurn(content);
    if (!turn || !turn.actions.length) {
      badJson++;
      onEvent({ kind: "warn", title: "Réponse illisible", body: "Le modèle n'a pas renvoyé d'actions JSON." });
      if (badJson >= 3) return { files: work, summary: summary || "Le modèle ne suit pas le protocole.", steps: step, status: "stalled", problems: lastProblems };
      history.push({ role: "user", content: `Réponse invalide. Renvoie UNIQUEMENT un objet JSON {"thought":"…","actions":[{"type":"…"}]}.` });
      continue;
    }
    badJson = 0;
    if (turn.thought) onEvent({ kind: "think", title: "Plan", body: turn.thought });

    const obs = [];
    let changed = false, finished = false;
    for (const a of turn.actions) {
      const type = String(a.type || "").toLowerCase();
      const path = normalizePath(a.path);
      if (type === "list") {
        obs.push(`[list]\n${treeOf(work)}`);
      } else if (type === "read") {
        if (!(path in work)) obs.push(`[read ${path}] ERREUR : fichier introuvable. Fichiers : ${Object.keys(work).join(", ") || "aucun"}`);
        else { obs.push(`[read ${path}]\n${clip(numbered(work[path]), HARNESS_LIMITS.readMax)}`); onEvent({ kind: "read", title: path, body: "Lu." }); }
      } else if (type === "write" || type === "create" || type === "rewrite") {
        if (!path || typeof a.content !== "string") { obs.push(`[write] ERREUR : "path" et "content" (texte) sont requis.`); continue; }
        const existed = path in work;
        work[path] = a.content; touched.add(path); changed = true;
        obs.push(`[write ${path}] OK (${a.content.length} car., ${existed ? "remplacé" : "créé"}).`);
        onEvent({ kind: "diff", title: path, body: existed ? "Réécrit." : "Créé." });
      } else if (type === "edit") {
        if (!(path in work)) { obs.push(`[edit ${path}] ERREUR : fichier introuvable — utilise "write" pour le créer.`); continue; }
        const search = String(a.search ?? ""), replace = String(a.replace ?? "");
        const idx = search ? work[path].indexOf(search) : -1;
        if (idx === -1) {
          if (replace && work[path].includes(replace)) { obs.push(`[edit ${path}] déjà appliqué.`); continue; }
          obs.push(`[edit ${path}] ERREUR : "search" introuvable. Relis le fichier (read) et copie le texte exact.`);
          onEvent({ kind: "warn", title: path, body: "Édition introuvable." });
        } else if (work[path].indexOf(search, idx + search.length) !== -1) {
          obs.push(`[edit ${path}] ERREUR : "search" apparaît plusieurs fois ; ajoute du contexte pour le rendre unique.`);
          onEvent({ kind: "warn", title: path, body: "Édition ambiguë." });
        } else {
          work[path] = work[path].slice(0, idx) + replace + work[path].slice(idx + search.length);
          touched.add(path); changed = true;
          obs.push(`[edit ${path}] OK.`);
          onEvent({ kind: "diff", title: path, body: "Édité." });
        }
      } else if (type === "check") {
        obs.push(`[check]\n${await check()}`);
      } else if (type === "done") {
        summary = String(a.summary || summary || "");
        finished = true;
      } else {
        obs.push(`[${type || "?"}] ERREUR : action inconnue (list, read, write, edit, check, done).`);
      }
    }
    if (changed) checkedSinceWrite = false;

    if (finished) {
      // Garde-fou : on ne termine pas sur du code non vérifié ou cassé. Une seule
      // relance, pour ne pas boucler si le modèle n'arrive pas à corriger.
      if (touched.size && !checkedSinceWrite) obs.push(`[check auto]\n${await check()}`);
      if (lastProblems.length && !doneRefused) {
        doneRefused = true;
        history.push({ role: "user", content: `${obs.join("\n\n")}\n\nTu as demandé "done" mais il reste des problèmes. Corrige-les puis relance "check".` });
        continue;
      }
      onEvent({ kind: "ok", title: "Terminé", body: summary || "Fin de l'agent." });
      return { files: work, summary, steps: step, status: "done", problems: lastProblems };
    }

    idle = changed || obs.some((o) => o.startsWith("[read") || o.startsWith("[list") || o.startsWith("[check")) ? 0 : idle + 1;
    if (idle >= 3) return { files: work, summary: summary || "L'agent tourne en rond.", steps: step, status: "stalled", problems: lastProblems };
    const left = maxSteps - step;
    history.push({ role: "user", content: clip(obs.join("\n\n"), HARNESS_LIMITS.obsMax * Math.max(1, turn.actions.length))
      + (left <= 2 ? `\n\nBudget : plus que ${left} étape(s). Vérifie (check) et termine (done).` : "") });
  }

  // Budget épuisé : vérification finale pour informer l'utilisateur.
  if (touched.size && !checkedSinceWrite) await check();
  return { files: work, summary: summary || "Budget d'étapes épuisé.", steps: maxSteps, status: "budget", problems: lastProblems };
}

/** Garde le système, la demande initiale et les derniers échanges ; résume le milieu. */
function compact(history) {
  const keep = HARNESS_LIMITS.historyKeep * 2;
  if (history.length <= 2 + keep) return history.slice();
  const dropped = history.length - 2 - keep;
  return [history[0], history[1], { role: "user", content: `(${dropped} messages plus anciens retirés du contexte ; relis les fichiers si besoin.)` }, ...history.slice(-keep)]
    // l'API attend une alternance user/assistant : on évite deux « user » de suite
    .filter((m, i, arr) => !(i === 2 && arr[3]?.role === "user"));
}

/** Construit un HTML autonome (CSS et scripts locaux inlinés) pour l'exécution. */
export function inlineApp(files, entry = "index.html") {
  let html = files[entry] || "";
  const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const href = (tag.match(/href\s*=\s*["']([^"']+)/i) || [])[1];
    const css = href && files[normalizePath(dir + href)];
    return css != null ? `<style>\n${css}\n</style>` : tag;
  });
  // Un script inline ignore `defer` : on déplace ces scripts en fin de <body>
  // pour garder l'ordre d'exécution réel (sinon faux « null » sur getElementById).
  const deferred = [];
  html = html.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
    const js = files[normalizePath(dir + src)];
    if (js == null) return tag;
    const attrs = a + b;
    const isModule = /type\s*=\s*["']module/i.test(attrs);
    const inline = `<script${isModule ? ' type="module"' : ""}>\n${js.replace(/<\/script/gi, "<\\/script")}\n</script>`;
    if (!isModule && /\bdefer\b/i.test(attrs)) { deferred.push(inline); return ""; }
    return inline;
  });
  if (deferred.length) {
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, deferred.join("\n") + "\n</body>") : html + deferred.join("\n");
  }
  return html;
}
