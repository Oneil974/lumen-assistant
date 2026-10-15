// Moteur de décision de Lumen : Tev1-0.8B-experimental (Together AI).
//
// Un modèle de 0,8 B entraîné à UNE tâche : lire `{state, question, options}`
// et répondre la lettre d'une option. Lumen s'en sert pour l'aiguillage de
// départ de chaque demande du mode Discussion :
//   direct      → le modèle principal répond seul ;
//   tools       → boucle d'appel d'outils (catalogue réduit) ;
//   orchestrate → réponse orchestrée (lib/orchestrator.js).
//
// Deux moteurs, côté Rust (`decision_decide`, llama.rs) :
//   « llama »  : GGUF servi par un llama-server dédié (port 11439) ;
//   « ollama » : le même GGUF tiré depuis Hugging Face par Ollama.
// La sortie est contrainte (grammaire / enum) : jamais de prose à parser.
//
// Tout échec rend `null` : l'appelant retombe sur l'heuristique existante
// (signaux forts de l'orchestrateur). Le moteur ne doit JAMAIS bloquer un tour.

export const DECISION_LLAMA = {
  id: "tev1-decision",
  filename: "Tev1-0.8B-experimental-Q8_0.gguf",
  url: "https://huggingface.co/DreamBlooms/Tev1-0.8B-experimental-GGUF/resolve/main/tev1-Q8_0.gguf",
  size: 811843360,
};
export const DECISION_OLLAMA_MODEL = "hf.co/DreamBlooms/Tev1-0.8B-experimental-GGUF:Q8_0";
/** Nom après import du GGUF local (repli quand Ollama refuse le tirage hf.co). */
export const DECISION_OLLAMA_IMPORTED = "tev1-decision";

/**
 * Modèles de décision au choix (Réglages › Modèles). MÊME liste que
 * `DECISION_MODELS` côté Rust (llama.rs). `filename` = GGUF pour le llama.cpp
 * intégré ("" : Ollama seulement) ; `ollama` = noms reconnus dans Ollama, le
 * premier est celui qu'on tire. Licences permissives uniquement.
 */
export const DECISION_MODELS = [
  { id: "tev1", label: "Tev1 0.8B", size: DECISION_LLAMA.size, filename: DECISION_LLAMA.filename, url: DECISION_LLAMA.url,
    ollama: ["tev1:0.8b", DECISION_OLLAMA_MODEL, DECISION_OLLAMA_IMPORTED], recommended: true,
    desc: "Recommandé : rapide, mesuré sur l'aiguillage de Lumen.", descEn: "Recommended: fast, measured on Lumen's routing." },
  { id: "tev1-4b", label: "Tev1 4B", size: 4.5e9, filename: "", url: "", ollama: ["tev1:4b"],
    desc: "Plus juste, plus lourd. Ollama uniquement.", descEn: "More accurate, heavier. Ollama only." },
  { id: "kev-08b", label: "Kev 0.8B · GGUF", size: 812000000, filename: "Kev-0.8B-Q8_0.gguf",
    url: "https://huggingface.co/ggml-org/Kev-0.8B-GGUF/resolve/main/Kev-0.8B-Q8_0.gguf", ollama: [],
    desc: "Léger, décisions simples. llama.cpp intégré, Apache-2.0.", descEn: "Lightweight, simple decisions. Built-in llama.cpp, Apache-2.0." },
  { id: "kev-4b", label: "Kev 4B · GGUF", size: 3030000000, filename: "Kev-4B-Q4_K_M.gguf",
    url: "https://huggingface.co/ggml-org/Kev-4B-GGUF/resolve/main/Kev-4B-Q4_K_M.gguf", ollama: [],
    desc: "Plus de capacité, environ 3 Go à télécharger. llama.cpp intégré.", descEn: "More capable, about 3 GB download. Built-in llama.cpp." },
  { id: "kev-9b", label: "Kev 9B · GGUF", size: 6360000000, filename: "Kev-9B-Q4_K_M.gguf",
    url: "https://huggingface.co/ggml-org/Kev-9B-GGUF/resolve/main/Kev-9B-Q4_K_M.gguf", ollama: [],
    desc: "Pour les décisions complexes ; mémoire plus importante. llama.cpp intégré.", descEn: "For complex decisions; more memory required. Built-in llama.cpp." },
  { id: "laya", label: "Laya 421M", size: 449397600, filename: "Laya-Q8_0.gguf",
    url: "https://huggingface.co/ggml-org/Laya-GGUF/resolve/main/Laya-Q8_0.gguf?download=true", ollama: [],
    desc: "Très léger (anglais). llama.cpp intégré.", descEn: "Very light (English). Built-in llama.cpp." },
  { id: "laya-multilingual", label: "Laya 322M Multilingual", size: 361712736, filename: "laya_multilingual_q8_0.gguf",
    url: "https://huggingface.co/mys/laya-multilingual-GGUF/resolve/main/laya_multilingual_q8_0.gguf?download=true", ollama: [],
    desc: "Très léger, multilingue. llama.cpp intégré.", descEn: "Very light, multilingual. Built-in llama.cpp." },
  { id: "clef-flash", label: "Cloudflare Clef Flash 9B", size: 6486448288, filename: "Clef-Flash-Q4_K_M.gguf",
    url: "https://huggingface.co/ggml-org/Clef-Flash-GGUF/resolve/main/Clef-Flash-Q4_K_M.gguf?download=true", ollama: ["clef-flash:9b"],
    desc: "Le plus précis, demande 16 Go de RAM.", descEn: "The most accurate, needs 16 GB of RAM." },
  // LiquidAI Open d1 : point d'entrée natif /v1/systemone de llama.cpp
  // (≥ b11488) — choix et confiance en une passe, sans texte généré.
  { id: "d1-3b", label: "LiquidAI Open d1 3B", size: 1674456672, filename: "d1-3B-Q4_K_M.gguf",
    url: "https://huggingface.co/LiquidAI/d1-3B-GGUF/resolve/main/d1-3B-Q4_K_M.gguf?download=true", ollama: [],
    desc: "Décision calibrée de Liquid AI (texte et image), multilingue. llama.cpp intégré.", descEn: "Liquid AI's calibrated decisions (text and image), multilingual. Built-in llama.cpp." },
  { id: "d1-omni", label: "LiquidAI Open d1 Omni 600M", size: 407207584, filename: "d1-omni-600M-Q8_0.gguf",
    url: "https://huggingface.co/LiquidAI/d1-omni-600M-GGUF/resolve/main/d1-omni-600M-Q8_0.gguf?download=true", ollama: [],
    desc: "Très léger, expérimental (texte, image, voix). llama.cpp intégré.", descEn: "Very light, experimental (text, image, speech). Built-in llama.cpp." },
];

/** Modèle de décision choisi (Tev1 0.8B par défaut). */
export function decisionModel() {
  let id = "";
  try { id = localStorage.getItem("decisionModel") || ""; } catch {}
  return DECISION_MODELS.find((m) => m.id === id) || DECISION_MODELS[0];
}
export async function setDecisionModel(id, invoke = tauriInvoke) {
  try { localStorage.setItem("decisionModel", id); } catch {}
  resetDecisionCache();
  // Copie côté Rust (Messages, téléphone) ; arrête le serveur dédié.
  try { await invoke("decision_set_model", { id }); } catch (e) { console.warn("[decision] modèle", e); }
}

/** Confiance minimale pour suivre le modèle (quand le moteur l'expose). */
const MIN_CONFIDENCE = 0.5;

const tauriInvoke = (...a) => window.__TAURI__.core.invoke(...a);

/** Activé par défaut ; « off » le coupe (Réglages › Modèles). */
export function decisionEnabled() {
  try { return localStorage.getItem("decisionEngine") !== "off"; } catch { return true; }
}
export function setDecisionEnabled(on) {
  try { localStorage.setItem("decisionEngine", on ? "on" : "off"); } catch {}
  // Copie côté Rust : Messages (et le téléphone) aiguillent sans WebView.
  try { window.__TAURI__?.core?.invoke("decision_set_enabled", { enabled: !!on }).catch(() => {}); } catch {}
}

/**
 * Moteur à utiliser pour une source d'IA : Ollama quand la discussion passe
 * par Ollama (il y est déjà chargé), llama.cpp embarqué sinon.
 */
export function decisionEngineFor(aiSource, model = decisionModel()) {
  if (!model.filename) return "ollama";          // Ollama seulement
  if (!model.ollama.length) return "llama";      // GGUF seulement
  return aiSource === "ollama" ? "ollama" : "llama";
}

let statusCache = null;
let statusAt = 0;
/** État d'installation (mis en cache 30 s : appelé à chaque tour). */
export async function decisionStatus(invoke = tauriInvoke, { fresh = false } = {}) {
  if (!fresh && statusCache && Date.now() - statusAt < 30_000) return statusCache;
  try {
    statusCache = await invoke("decision_status");
  } catch {
    statusCache = { installed: false, running: false, llama_available: false };
  }
  statusAt = Date.now();
  return statusCache;
}

const ollamaPresence = new Map();   // url|modèle → { name, at }
/** Nom du modèle de décision présent dans cet Ollama (tiré ou importé), sinon "". */
export async function ollamaDecisionModel(url, invoke = tauriInvoke) {
  const key = `${url}|${decisionModel().id}`;
  const hit = ollamaPresence.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.name;
  let name = "";
  try {
    const models = await invoke("ollama_list_models", { url });
    const names = (Array.isArray(models) ? models : []).map((m) => (typeof m === "string" ? m : m?.name || m?.model || ""));
    const want = decisionModel().ollama.map((n) => n.toLowerCase());
    name = names.find((n) => want.some((w) => n.toLowerCase() === w || n.toLowerCase().startsWith(w + ":"))) || "";
  } catch { name = ""; }
  ollamaPresence.set(key, { name, at: Date.now() });
  return name;
}
export async function ollamaHasDecisionModel(url, invoke = tauriInvoke) {
  return Boolean(await ollamaDecisionModel(url, invoke));
}

/** Oublie les caches (après une installation). */
export function resetDecisionCache() {
  statusCache = null;
  ollamaPresence.clear();
}

/** Le moteur est-il utilisable tout de suite pour cette source ? */
export async function decisionReady({ aiSource, ollamaUrl, invoke = tauriInvoke }) {
  if (!decisionEnabled() || aiSource === "shortcut") return false;
  if (decisionEngineFor(aiSource) === "ollama") return ollamaHasDecisionModel(ollamaUrl, invoke);
  const st = await decisionStatus(invoke);
  return Boolean(st.installed && st.llama_available);
}

/**
 * Décision générique : `options` = [{ key, description }] (2 à 24).
 * Renvoie `{ key, label, confidence, engine, ms }` ou `null`.
 */
export async function decide({ state, question, options, aiSource, ollamaUrl, invoke = tauriInvoke }) {
  if (!(await decisionReady({ aiSource, ollamaUrl, invoke }))) return null;
  try {
    return await invoke("decision_decide", {
      engine: decisionEngineFor(aiSource),
      ollamaUrl: ollamaUrl || null,
      ollamaModel: decisionEngineFor(aiSource) === "ollama" ? (await ollamaDecisionModel(ollamaUrl, invoke)) || null : null,
      stateText: String(state || ""),
      question,
      options,
    });
  } catch (e) {
    console.warn("[decision]", e);
    return null;
  }
}

// Options rédigées en anglais : c'est la langue d'entraînement du modèle. La
// demande de l'utilisateur, elle, reste dans sa langue (dans `state`).
const ROUTE_QUESTION = "How should the assistant handle the latest user message?";
const ROUTE_OPTIONS = [
  {
    key: "direct",
    description: "Answer directly from general knowledge or the conversation itself: greetings, small talk, "
      + "explanations, definitions, writing, rewriting, translation, brainstorming, code or math. "
      + "No live data, no personal data and no action needed.",
  },
  {
    key: "tools",
    description: "Call one or two tools first: live or current information (weather, news, sports scores, "
      + "web search, today's date-dependent facts), the user's own data (emails, calendar, files, notes, "
      + "memory, contacts, tasks) or a single action in an app or device (create a reminder, open, add, send, "
      + "turn on the lights).",
  },
  {
    key: "orchestrate",
    description: "Complex multi-step request: several sub-tasks or several sources to gather, compare and "
      + "combine into a report, plan or analysis that needs planning and verification.",
  },
];

/**
 * Aiguillage de départ d'un tour de discussion.
 * `history` = messages {role, content|display} AVANT la demande courante.
 * `toolFamilies` = noms des familles d'outils disponibles (informatif).
 * Renvoie `{ route: "direct"|"tools"|"orchestrate", confidence, ms, engine }` ou `null`.
 */
export async function routeTurn({ query, history = [], toolFamilies = [], aiSource, ollamaUrl, invoke = tauriInvoke }) {
  const q = String(query || "").trim();
  if (!q) return null;
  if (looksMultiRequest(q)) return { route: "orchestrate", confidence: 1, ms: 0, engine: "rule" };
  const prevUser = [...history].reverse().find((m) => m?.role === "user");
  const prevText = String(prevUser?.display || prevUser?.content || "").slice(0, 400);
  const lines = [
    "Assistant: Lumen, a personal AI assistant on the user's computer.",
    `Today: ${new Date().toISOString().slice(0, 10)}.`,
  ];
  if (toolFamilies.length) lines.push(`Available tool families: ${toolFamilies.join(", ")}.`);
  if (prevText) lines.push(`Previous user message: ${prevText}`);
  lines.push(`Latest user message: ${q.slice(0, 2000)}`);
  const res = await decide({ state: lines.join("\n"), question: ROUTE_QUESTION, options: ROUTE_OPTIONS, aiSource, ollamaUrl, invoke });
  if (!res) return null;
  if (typeof res.confidence === "number" && res.confidence < MIN_CONFIDENCE) return null;
  return { route: res.key, confidence: res.confidence ?? null, ms: res.ms, engine: res.engine };
}

// ---- Suite de la discussion ou sujet détaché ----
// Seuil haut : se tromper vers « détaché » fait perdre le fil (« et demain ? »).
const DETACH_CONFIDENCE = 0.75;
const TOPIC_QUESTION = "Does the latest user message need the earlier conversation to be understood and answered?";
const TOPIC_OPTIONS = [
  { key: "continue", description: "It continues the conversation: follow-up question, reference to something said before (it, that, this, the previous one, again, and for…), correction, or the same subject." },
  { key: "detached", description: "It is a new, self-contained request on an unrelated subject: it can be fully answered without reading anything said before." },
];
/**
 * `{ key: "continue"|"detached", confidence }` ou null (moteur absent, indécis).
 * `history` = messages AVANT la demande courante.
 */
export async function topicContinuity({ query, history = [], aiSource, ollamaUrl, invoke = tauriInvoke }) {
  const q = String(query || "").trim();
  if (!q) return null;
  const recent = history.filter((m) => m?.role === "user" || m?.role === "assistant").slice(-4)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.display || m.content || "").replace(/\s+/g, " ").slice(0, 300)}`);
  const state = ["Earlier conversation (most recent last):", ...recent, `Latest user message: ${q.slice(0, 1000)}`].join("\n");
  const res = await decide({ state, question: TOPIC_QUESTION, options: TOPIC_OPTIONS, aiSource, ollamaUrl, invoke });
  if (!res) return null;
  if (res.key === "detached" && !(typeof res.confidence === "number" && res.confidence >= DETACH_CONFIDENCE)) return { key: "continue", confidence: res.confidence };
  return { key: res.key, confidence: res.confidence ?? null };
}

// ---- Plusieurs demandes dans un même message → orchestration ----
// Déterministe et consulté AVANT le modèle de décision : un 0,8 B choisit
// souvent « outils » pour « donne la météo et lis mes mails », or une boucle
// d'outils ordinaire traite la première demande et oublie la seconde.
// L'orchestrateur, lui, planifie chaque demande et vérifie qu'aucune n'est
// oubliée. MÊME logique côté Rust (messenger.rs::multi_request).
const ACTION = /^(?:cherche|recherche|trouve|donne|r[ée]cup[èe]re|lis|r[ée]sume|envoie|[ée]cri[st]|cr[ée]e|ajoute|planifie|rappelle|compare|tradui[ts]|calcule|ouvre|lance|montre|liste|explique|pr[ée]pare|analyse|v[ée]rifie|regarde|dis|fais|mets|programme|note|search|find|get|give|fetch|read|summari[sz]e|send|write|create|add|schedule|remind|translate|open|launch|show|list|explain|prepare|analy[sz]e|check|look|tell|make|put|set)\b/i;
const PRONOUN = /^(?:(?:et|puis|ensuite|aussi|also|then|and)\s+)*(?:moi\s+|me\s+|-moi\s+)?/i;

export function looksMultiRequest(query) {
  const t = String(query || "").trim();
  if (t.length < 20) return false;
  if ((t.match(/\?/g) || []).length >= 2) return true;
  if (t.split(/\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length >= 2) return true;
  // Segments séparés par ; / retour ligne / puis / ensuite / « et » + verbe /
  // phrase suivante ; on compte ceux qui commencent par un verbe d'action.
  const parts = t
    .split(/\s*(?:;|\n|\.\s+|,?\s+(?:puis|ensuite|apr[eè]s [çc]a|then|and then|after that)\s+|,?\s+(?:et|and)\s+(?=\S+))\s*/i)
    .map((p) => p.replace(PRONOUN, "").trim())
    .filter((p) => p.length > 3);
  return parts.filter((p) => ACTION.test(p)).length >= 2;
}
