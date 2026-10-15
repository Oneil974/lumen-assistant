// Collecteur du Profiler : une trace fine de CHAQUE appel de modèle, partagée
// par toutes les surfaces de Lumen (barre, bureau, mini-apps en iframe).
//
// Le journal LLM (llmlog.rs) répond à « qu'est-ce que les modèles ont fait ? ».
// Le Profiler répond à une autre question : « à quel coût, et est-ce que ça
// tient ? ». Il lui faut donc des grandeurs que le journal n'enregistre pas :
// occupation réelle du contexte, vitesse de génération, outils PRÉSENTÉS au
// modèle (ils occupent le contexte même quand ils ne sont jamais appelés) vs
// outils RÉELLEMENT appelés, température, et surtout les RUPTURES de contexte
// (une conversation repartie de zéro coûte un préremplissage complet).
//
// Deux moitiés d'information, capturées à deux endroits différents :
//  - la REQUÊTE (outils offerts, température, contexte demandé) n'est connue
//    que de `llmChat` (llm.js), qui ignore quelle app l'appelle ;
//  - la RÉPONSE (tokens, durées, outils appelés) passe par `recordOllamaUsage`
//    (ollama-usage.js), que chaque app appelle AVEC son nom.
// On les recolle via une WeakMap indexée par l'objet `data` de la réponse :
// aucun identifiant à propager dans les vingt et quelques points d'appel
// existants, et rien à nettoyer (le GC s'en charge quand `data` disparaît).

const BASE_KEY = "lumenProfilerSamples";
const MAX_SAMPLES = 600;
const CHANNEL = "lumen-profiler";

// ===== Transcription attachée à un échantillon ============================
//
// Les chiffres seuls ne disent pas POURQUOI un appel a coûté 6 000 tokens : il
// faut voir ce qui a été envoyé. Chaque échantillon porte donc la conversation
// réellement transmise au modèle, plus la réponse obtenue.
//
// Le stockage est localStorage (quelques Mo, partagés avec tout le reste de
// Lumen) : on borne agressivement. Chaque message est tronqué, on ne garde que
// les derniers, et la transcription est PURGÉE des échantillons anciens — les
// mesures, elles, restent (l'historique des courbes ne perd rien).
const MSG_CHARS = 1200;      // caractères conservés par message (défaut)
const MSG_KEEP = 14;         // messages conservés (les plus récents)
const TRANSCRIPT_KEEP = 60;  // échantillons portant encore leur transcription

// Budget par rôle. Le prompt SYSTÈME est précisément ce qu'on vient auditer
// dans le Profiler (« pourquoi 1 400 tokens avant même la question ? ») : le
// tronquer, même de 200 caractères, rend l'inspection inutile — on le garde
// entier en pratique. Les résultats d'outils, à l'inverse, sont le poste le
// plus volumineux et le moins utile en intégralité.
const ROLE_CHARS = { system: 12000, tool: 2000, assistant: 2400 };
const roleBudget = (role) => ROLE_CHARS[role] || MSG_CHARS;

function clip(text, max = MSG_CHARS) {
  const s = typeof text === "string" ? text : contentToText(text);
  if (s.length <= max) return { text: s, clipped: 0 };
  return { text: s.slice(0, max), clipped: s.length - max };
}

/** Contenu d'un message, qu'il soit texte simple ou tableau de parties (API). */
function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" || typeof part?.text === "string") return part.text || "";
      if (part?.type === "image_url" || part?.image_url) return "[image]";
      return "";
    }).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return String(content);
}

/** Appels d'outils d'un message assistant, en forme lisible. */
function callsOf(message) {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) return undefined;
  return calls.map((call) => {
    let args = call?.function?.arguments;
    if (typeof args !== "string") {
      try { args = JSON.stringify(args); } catch { args = String(args); }
    }
    return { name: call?.function?.name || call?.name || "?", args: clip(args || "", 400).text };
  });
}

/**
 * Conversation envoyée au modèle, condensée pour le Profiler.
 * Les messages `images` (barre) sont signalés sans être copiés : une image en
 * base64 ferait exploser le quota à elle seule.
 */
export function captureTranscript(messages) {
  if (!Array.isArray(messages) || !messages.length) return undefined;
  const kept = messages.slice(-MSG_KEEP);
  const out = kept.map((message) => {
    const { text, clipped } = clip(message?.content, roleBudget(String(message?.role || "")));
    const entry = { role: String(message?.role || "?"), text };
    if (clipped) entry.clipped = clipped;
    if (message?.name) entry.name = String(message.name);
    const calls = callsOf(message);
    if (calls) entry.calls = calls;
    if (Array.isArray(message?.images) && message.images.length) entry.images = message.images.length;
    return entry;
  });
  if (messages.length > kept.length) out.unshift({ role: "…", text: `${messages.length - kept.length} message(s) plus ancien(s) non conservé(s) par le Profiler` });
  return out;
}

/** Réponse du modèle, telle qu'elle est revenue (Ollama ou OpenAI). */
function captureReply(data) {
  const message = data?.message || data?.choices?.[0]?.message;
  if (!message) return undefined;
  const { text, clipped } = clip(message.content, roleBudget("assistant"));
  const entry = { role: "assistant", text };
  if (clipped) entry.clipped = clipped;
  const thinking = message.thinking || message.reasoning_content;
  if (thinking) entry.thinking = clip(thinking, MSG_CHARS).text;
  const calls = callsOf(message);
  if (calls) entry.calls = calls;
  return entry;
}

/** Retire les transcriptions des échantillons les plus anciens (quota). */
function trimTranscripts(list) {
  const cut = list.length - TRANSCRIPT_KEEP;
  if (cut <= 0) return list;
  return list.map((sample, i) => {
    if (i >= cut || !sample || (!sample.transcript && !sample.reply)) return sample;
    const { transcript, reply, ...rest } = sample;
    return { ...rest, transcriptDropped: true };
  });
}

// PIÈGE (corrigé le 05/08/2026) — la clé de stockage est préfixée par le
// profil actif (`profile:<id>:`), mais ce préfixe n'est posé que sur la fenêtre
// du bureau et celle des Paramètres. Conséquences observées :
//  - le bureau ÉCRIVAIT `profile:x:lumenProfilerSamples` ;
//  - la barre principale, qui ne pose pas le préfixe, écrivait la clé nue ;
//  - le Profiler, ouvert en IFRAME (donc sans préfixe non plus), ne relisait que
//    la clé nue et repartait donc d'une liste vide.
// D'où le symptôme : un appel s'affichait en direct (BroadcastChannel), puis
// disparaissait à la resynchronisation suivante, et « Outils » restait vide
// alors que le mode outils était bien actif.
// La lecture réunit désormais TOUTES les clés qui se terminent par BASE_KEY.
function storagePrefix() {
  if (window.__LUMEN_PROFILE_STORAGE_PREFIX__) return window.__LUMEN_PROFILE_STORAGE_PREFIX__;
  // Fenêtre hôte (même origine) : cas des apps ouvertes en iframe par le bureau.
  try {
    const parentPrefix = window.parent && window.parent !== window && window.parent.__LUMEN_PROFILE_STORAGE_PREFIX__;
    if (parentPrefix) return parentPrefix;
  } catch { /* origine différente : on reste sur la clé nue */ }
  // Dernier recours : un profil déjà présent dans le stockage (fenêtres
  // secondaires, qui n'ont ni préfixe ni parent).
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k !== BASE_KEY && k.endsWith(BASE_KEY)) return k.slice(0, -BASE_KEY.length);
    }
  } catch { /* stockage inaccessible */ }
  return "";
}

function key() {
  return storagePrefix() + BASE_KEY;
}

/** Toutes les clés de stockage susceptibles de contenir des échantillons. */
function allKeys() {
  const keys = new Set([BASE_KEY, key()]);
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.endsWith(BASE_KEY)) keys.add(k);
    }
  } catch { /* stockage inaccessible */ }
  return [...keys];
}

// Métadonnées de requête en attente de leur réponse. Clé = objet `data` renvoyé
// par le backend, donc jamais partagé entre deux appels.
const pending = new WeakMap();

// BroadcastChannel pousse l'échantillon aux fenêtres ouvertes du même contexte
// (iframes du bureau). Les WebViews Tauri distinctes ne le partagent pas
// forcément : le Profiler relit aussi localStorage à intervalle régulier.
let channel = null;
function bus() {
  if (channel === null) {
    try { channel = new BroadcastChannel(CHANNEL); } catch { channel = false; }
  }
  return channel || null;
}

/** Nom de l'app courante déduit de l'URL de la page (« /notes/notes.html » → « notes »). */
export function currentSurface() {
  try {
    const segments = location.pathname.split("/").filter(Boolean);
    if (segments.length > 1) return segments[0];
    // Racine = la barre principale de Lumen.
    return segments.length ? segments[0].replace(/\.html$/, "") : "barre";
  } catch {
    return "inconnu";
  }
}

/** Backend actif, tel que le Profiler doit l'étiqueter. */
export function currentBackend() {
  const source = localStorage.getItem("aiSource") || "shortcut";
  return source === "llama" ? "llama.cpp" : source === "api" ? "api" : source === "applefm" ? "applefm" : source === "shortcut" ? "apple" : "ollama";
}

/**
 * Fenêtre de contexte configurée pour ce backend, en tokens. 0 quand elle est
 * laissée au défaut du modèle (Ollama) ou hors de notre contrôle (API cloud).
 * Vit ici plutôt que dans `llm.js` : `llm.js` importe ce module, l'inverse
 * créerait un cycle, et les appelants historiques (barre) n'ont pas `llm.js`.
 */
export function configuredContextWindow(backend) {
  if (backend === "llama.cpp") return parseInt(localStorage.getItem("llamaNumCtx") || "8192", 10) || 8192;
  if (backend === "api") return 0;
  // Apple Foundation Models : la fenêtre est celle annoncée par le framework
  // (`contextSize`, relevée par la passerelle et mémorisée par llm.js) — elle
  // dépend du Mac : 4 096 sur certains, 8 192 sur d'autres sous macOS 27.
  // Repli sur les valeurs documentées si la sonde n'a pas encore tourné.
  if (backend === "applefm") {
    const model = localStorage.getItem("applefmModel") || "apple-on-device";
    const known = parseInt(localStorage.getItem(`applefmContext:${model}`) || "0", 10);
    return known > 0 ? known : (model === "apple-private-cloud" ? 32000 : 4096);
  }
  return parseInt(localStorage.getItem("ollamaNumCtx") || "0", 10) || 0;
}

/** Noms des outils d'une liste au format OpenAI/Ollama. */
function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => tool?.function?.name || tool?.name).filter(Boolean).map(String);
}

/** Outils réellement appelés, dans la réponse Ollama comme dans la réponse OpenAI. */
function calledToolNames(data) {
  const calls = data?.message?.tool_calls || data?.choices?.[0]?.message?.tool_calls || [];
  return toolNames(calls);
}

/**
 * Enregistre le CÔTÉ REQUÊTE d'un appel. Appelé par `llmChat` juste après avoir
 * reçu `data`, avant que l'app n'appelle `recordOllamaUsage`.
 */
export function noteRequest(data, meta) {
  if (!data || typeof data !== "object") return;
  try { pending.set(data, meta || {}); } catch { /* data non extensible : tant pis */ }
}

/**
 * Même chose, à partir du PAYLOAD de chat brut (contrat Ollama ou OpenAI).
 *
 * Toutes les surfaces ne passent pas par `llmChat` : la barre principale a son
 * propre `ollamaPostJson`, et c'est précisément elle qui présente le plus
 * d'outils au modèle. Sans ce relais, la colonne « Présenté » du Profiler
 * restait vide alors que les outils occupaient bel et bien le contexte.
 */
export function notePayloadRequest(data, payload, backend) {
  if (!data || !payload || typeof payload !== "object") return;
  // Sur le chemin chaud de CHAQUE appel de modèle : le Profiler ne doit jamais
  // pouvoir faire échouer la requête qu'il observe.
  try { notePayload(data, payload, backend); } catch { /* mesure perdue, sans conséquence */ }
}

function notePayload(data, payload, backend) {
  const label = backend || currentBackend();
  noteRequest(data, {
    backend: label,
    model: payload.model || "",
    ctxSize: configuredContextWindow(label),
    // Ollama loge les réglages d'échantillonnage dans `options`, l'API OpenAI
    // (et donc llama-server) à la racine du corps.
    temperature: payload.options?.temperature ?? payload.temperature ?? null,
    thinking: payload.think ?? payload.chat_template_kwargs?.enable_thinking ?? null,
    toolsOffered: toolNames(payload.tools),
    structured: payload.format || payload.response_format
      ? (typeof (payload.format ?? payload.response_format) === "object" ? "schema" : "json")
      : "",
    messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
    transcript: captureTranscript(payload.messages),
  });
}

function readSamples() {
  const merged = [];
  const seen = new Set();
  for (const k of allKeys()) {
    let parsed;
    try { parsed = JSON.parse(localStorage.getItem(k) || "[]"); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const sample of parsed) {
      if (!sample || typeof sample !== "object") continue;
      // Un même appel ne peut pas exister deux fois : (horodatage, app) suffit à
      // dédoublonner deux clés qui se recouvriraient.
      const id = `${sample.ts}|${sample.app}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(sample);
    }
  }
  merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return merged.slice(-MAX_SAMPLES);
}

function writeSamples(list) {
  try {
    localStorage.setItem(key(), JSON.stringify(list));
  } catch {
    // Quota dépassé : les transcriptions sont le poste lourd et le seul
    // sacrifiable — on réessaie sans elles plutôt que de perdre les mesures.
    try {
      localStorage.setItem(key(), JSON.stringify(list.map(({ transcript, reply, ...rest }) =>
        (transcript || reply ? { ...rest, transcriptDropped: true } : rest))));
    } catch { /* toujours plein : le Profiler n'est pas critique, on abandonne */ }
  }
}

/**
 * Assemble et publie un échantillon. Appelé par `recordOllamaUsage`, qui
 * connaît l'app d'origine (`source`) et détient l'objet de réponse brut.
 * Best-effort de bout en bout : le Profiler ne doit jamais faire échouer un
 * appel de modèle.
 */
export function recordCall(data, source) {
  try {
    const meta = (data && pending.get(data)) || {};
    const promptTokens = Number(data?.prompt_eval_count || data?.usage?.prompt_tokens || 0);
    const genTokens = Number(data?.eval_count || data?.usage?.completion_tokens || 0);
    if (promptTokens <= 0 && genTokens <= 0) return null;
    // Les durées Ollama sont en nanosecondes ; llm.js aligne llama-server dessus.
    const genMs = Number(data?.eval_duration || 0) / 1e6;
    const promptMs = Number(data?.prompt_eval_duration || 0) / 1e6;
    const sample = {
      ts: Date.now(),
      app: String(source || "inconnu"),
      surface: currentSurface(),
      backend: meta.backend || currentBackend(),
      model: String(meta.model || data?.model || localStorage.getItem("selectedModel") || ""),
      promptTokens,
      genTokens,
      totalTokens: promptTokens + genTokens,
      promptMs: Math.round(promptMs),
      genMs: Math.round(genMs),
      // Tokens par seconde en génération : la métrique qui dit si le contexte
      // choisi rend le modèle inutilisable.
      tps: genMs > 0 ? +(genTokens / (genMs / 1000)).toFixed(1) : 0,
      ctxSize: Number(meta.ctxSize || 0),
      temperature: meta.temperature ?? null,
      thinking: meta.thinking ?? null,
      toolsOffered: meta.toolsOffered || [],
      toolsCalled: calledToolNames(data),
      structured: meta.structured || "",
      messages: Number(meta.messages || 0),
      // Ce qui a réellement été échangé : sans ça, un pic de contexte reste une
      // barre sur un graphe qu'on ne sait pas expliquer.
      transcript: meta.transcript,
      reply: captureReply(data),
    };
    // Rupture de contexte : le préremplissage repart nettement en dessous du
    // précédent pour la même app. C'est le signal d'un historique vidé ou
    // compacté — l'événement le plus coûteux et le plus invisible d'une session.
    const list = readSamples();
    const previous = [...list].reverse().find((s) => s.app === sample.app && s.model === sample.model);
    if (previous) {
      sample.promptDelta = promptTokens - previous.promptTokens;
      sample.reset = previous.promptTokens > 400 && promptTokens < previous.promptTokens * 0.6;
    } else {
      sample.promptDelta = 0;
      sample.reset = false;
    }
    list.push(sample);
    writeSamples(trimTranscripts(list.slice(-MAX_SAMPLES)));
    try { bus()?.postMessage({ type: "sample", sample }); } catch { /* canal fermé */ }
    window.dispatchEvent(new CustomEvent("lumen-profiler-sample", { detail: sample }));
    return sample;
  } catch {
    return null;
  }
}

/** Échantillons enregistrés, du plus ancien au plus récent. */
export function getSamples() {
  return readSamples();
}

/** Vide l'historique du Profiler (toutes surfaces). */
export function clearSamples() {
  // Vider signifie vider PARTOUT : sinon les échantillons d'une autre clé de
  // profil réapparaissent à la relecture suivante.
  for (const k of allKeys()) {
    try { localStorage.removeItem(k); } catch { /* rien à faire */ }
  }
  writeSamples([]);
  try { bus()?.postMessage({ type: "cleared" }); } catch { /* canal fermé */ }
}

/** S'abonne aux échantillons publiés par les autres surfaces. */
export function onSample(handler) {
  const b = bus();
  if (b) b.addEventListener("message", (event) => handler(event.data));
  window.addEventListener("lumen-profiler-sample", (event) => handler({ type: "sample", sample: event.detail }));
}
