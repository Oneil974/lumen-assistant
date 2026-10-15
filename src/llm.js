import { matchesSchema, promptExamples } from "./lib/robust.js";
// Backend LLM unifié (côté front). Dispatche entre Ollama natif et une API cloud
// compatible OpenAI (ChatGPT, Groq, OpenRouter…) selon la config partagée en
// localStorage : `aiSource` ('api' active le cloud), `apiKey`, `apiBaseUrl`,
// `apiModel` (sinon `ollamaUrl` / `selectedModel`). Utilisé par TOUTES les
// mini-apps (Documents, Moodboard, Data Analysis, Kanban, Designer, Sandbox,
// bureau…) pour qu'elles basculent toutes ensemble quand l'API cloud est active.
import { buildLumenSystemPrompt, isLumenSystemPrompt } from "./lib/system-prompt.js";
import { hybridState } from "./lib/hybrid.js";
import { isLfmModel, isLfmThinkingModel, lfmSampling, extractLfmToolCalls } from "./lib/lfm.js";

// Plafond de sortie d'un LFM « Thinking » sur une tâche courte (raisonnement + réponse).
const LFM_THINKING_SHORT_TASK_TOKENS = 3072;
import { captureTranscript, configuredContextWindow, noteRequest, notePayloadRequest } from "./lib/profiler.js";
import { markUsageHandled, scheduleUsageFallback } from "./ollama-usage.js";
import { canStream, streamInvoke, stripThink } from "./lib/llm-stream.js";

export { canStream, streamInvoke, splitThink, StreamState } from "./lib/llm-stream.js";
export { createStreamView, thinkBlock, toolBlock } from "./lib/stream-view.js";

// Flux demandé par l'appelant : il fournit un rappel de progression. Sans
// rappel, rien ne change (appels structurés JSON, routeurs, résumés…).
function wantsStream(opts) {
  return canStream() && (typeof opts.onUpdate === "function" || typeof opts.onDelta === "function");
}
// Pénalité de répétition par défaut des modèles locaux hors LFM : llama-server
// n'en applique AUCUNE (1,0), contrairement à Ollama (1,1).
export const LOCAL_REPEAT_PENALTY = 1.1;

// Flux coupé pour boucle (lib/llm-stream.js) : UNE relance, plus pénalisée.
// Si elle boucle aussi, on garde sa réponse tronquée plutôt qu'un mur répété.
async function streamWithLoopRetry(req, opts) {
  const data = await streamInvoke(req, streamHooks(opts));
  if (!data?.looped || opts.signal?.aborted) return data;
  const payload = structuredClone(req.payload);
  if (req.target === "llama") payload.repeat_penalty = Math.max(1.25, payload.repeat_penalty || 0);
  else if (req.target === "ollama") payload.options = { ...(payload.options || {}), repeat_penalty: 1.25 };
  else if (req.target === "api") payload.frequency_penalty = 0.5;
  else return data;
  console.warn("[llm] boucle de génération détectée : relance plus pénalisée");
  try { return (await streamInvoke({ ...req, payload }, streamHooks(opts))) || data; } catch { return data; }
}

function streamHooks(opts) {
  return {
    signal: opts.signal,
    onUpdate: (state) => {
      opts.onUpdate?.(state);
      opts.onDelta?.(state.answer, state);
    },
  };
}

// Dans une fenêtre intégrée (iframe même-origine du bureau), `__TAURI__` est
// porté par la fenêtre parente, pas par l'iframe : on retombe dessus.
const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const IS_WINDOWS = /Windows/i.test(navigator.userAgent || navigator.platform || "");

// La CSP de la WebView n'autorise en HTTP clair que `localhost`/`127.0.0.1`
// (cf. connect-src dans tauri.conf.json). Un Ollama hébergé sur un AUTRE hôte
// local (IP LAN, *.local, autre machine) serait donc bloqué si on faisait un
// `fetch` direct depuis le front. On route alors la requête par le backend Rust
// (reqwest, hors CSP) — exactement le contournement déjà utilisé sous Windows
// pour éviter le CORS. Renvoie true si l'appel doit passer par le backend.
export function ollamaUsesBackend(url) {
  if (!invoke) return false;
  // llama-server et litert-lm ne sont pas Ollama : tous les appels locaux
  // doivent passer par les commandes Rust afin d'utiliser leur port privé et
  // leur API OpenAI.
  if (["llama", "litert"].includes(localStorage.getItem("aiSource"))) return true;
  if (IS_WINDOWS) return true;
  try {
    const h = new URL(url).hostname;
    return !(h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]");
  } catch {
    return false;
  }
}

export async function ollamaGetJson(path, url = localStorage.getItem("ollamaUrl") || "http://localhost:11434", opts = {}) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  const cleanUrl = (url || "http://localhost:11434").replace(/\/+$/, "");
  if ((opts.source || localStorage.getItem("aiSource")) === "litert") {
    // Le registre de litert-lm nomme les modèles sans extension : c'est ce nom
    // que le serveur attend dans `model`, donc celui qu'on expose ici.
    if (cleanPath === "api/tags") {
      const models = await invoke("litert_list_models");
      return { models: (Array.isArray(models) ? models : []).map((m) => ({ name: m.id, size: m.size })) };
    }
    return invoke("litert_get_json", { path: cleanPath.replace(/^api\//, "") });
  }
  if ((opts.source || localStorage.getItem("aiSource")) === "llama") {
    if (cleanPath === "api/tags") {
      const models = await invoke("llama_list_models");
      return { models: (Array.isArray(models) ? models : []).map((m) => ({ name: m.filename, size: m.size })) };
    }
    return invoke("llama_get_json", { path: cleanPath.replace(/^api\//, "") });
  }
  if (ollamaUsesBackend(cleanUrl)) return invoke("ollama_get_json", { url: cleanUrl, path: cleanPath });
  const r = await fetch(`${cleanUrl}/${cleanPath}`);
  if (!r.ok) throw new Error(`Ollama indisponible (${r.status})`);
  return r.json();
}

export async function ollamaPostJson(path, payload, url = localStorage.getItem("ollamaUrl") || "http://localhost:11434", opts = {}) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  const cleanUrl = (url || "http://localhost:11434").replace(/\/+$/, "");
  const localOpenAiSource = opts.source || localStorage.getItem("aiSource");
  if (localOpenAiSource === "llama" || localOpenAiSource === "litert") {
    // Les apps historiques utilisent encore le contrat Ollama { message }.
    // On les adapte ici pour qu'elles bénéficient automatiquement de
    // llama-server, sans devoir chacune connaître l'API OpenAI-compatible.
    if (cleanPath === "api/generate") {
      return { done: true, message: { content: "" }, eval_count: 0 };
    }
    if (cleanPath !== "api/chat") {
      throw new Error(
        localOpenAiSource === "litert"
          ? "Cet endpoint n'est pas disponible avec LiteRT-LM"
          : "Cet endpoint n'est pas disponible avec llama-server",
      );
    }
    const result = await llmChat(payload?.messages || [], {
      model: payload?.model,
      maxTokens: payload?.options?.num_predict,
      tools: payload?.tools,
      tool_choice: payload?.tool_choice,
      json: payload?.format === "json",
      // Ollama passe un schéma JSON brut dans `format` : on le relaie tel quel
      // pour que llama-server le compile en grammaire.
      schema: payload?.format && typeof payload.format === "object" ? payload.format : undefined,
    });
    const data = result.data || {};
    const message = data?.choices?.[0]?.message || {};
    // Appels LFM restés dans le texte (format non reconnu par le serveur) :
    // convertis en tool_calls, et retirés du contenu affiché.
    if (typeof message.content === "string" && message.content.includes("<|tool_call_start|>")) {
      const { content, calls } = extractLfmToolCalls(message.content);
      message.content = content;
      if (calls.length && !message.tool_calls?.length) message.tool_calls = calls;
    }
    const timings = data?.timings || {};
    const evalCount = Number(data?.usage?.completion_tokens || timings.predicted_n || 0);
    const promptCount = Number(data?.usage?.prompt_tokens || timings.prompt_n || 0);
    const evalDuration = Number(timings.predicted_ms || 0) * 1e6;
    const promptDuration = Number(timings.prompt_ms || 0) * 1e6;
    const composed = {
      ...data,
      message,
      eval_count: evalCount,
      prompt_eval_count: promptCount,
      eval_duration: evalDuration,
      prompt_eval_duration: promptDuration,
      total_duration: evalDuration + promptDuration,
    };
    // `llmChat` a annoté l'objet d'ORIGINE ; celui-ci est une recomposition,
    // et c'est lui que l'app passera à `recordOllamaUsage`. Sans ce report, les
    // outils présentés se perdraient pour toutes les apps au contrat Ollama.
    // LiteRT-LM ne renvoie pas les `timings` de llama.cpp : seul `usage` est
    // rempli plus haut, et les durées restent à zéro. Le Profiler affiche alors
    // les jetons sans la vitesse, ce qui vaut mieux qu'un chiffre inventé.
    notePayloadRequest(composed, payload, localOpenAiSource === "litert" ? "litert" : "llama.cpp");
    // C'est `composed` que l'app comptera (ou que le repli comptera) : on
    // neutralise l'original annoté par `llmChat` pour ne pas compter deux fois.
    markUsageHandled(data);
    scheduleUsageFallback(composed, "llm");
    return composed;
  }
  const body = { ...(payload || {}), stream: false };
  // Some legacy apps still call ollamaPostJson directly instead of llmChat.
  // Keep their system instructions aligned with the global language as well.
  if (cleanPath === "api/chat" && Array.isArray(body.messages)) {
    body.messages = await messagesWithLumenSystem(body.messages);
  }
  let result;
  if (ollamaUsesBackend(cleanUrl)) {
    result = await invoke("ollama_post_json", { url: cleanUrl, path: cleanPath, payload: body });
  } else {
    const r = await fetch(`${cleanUrl}/${cleanPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Ollama indisponible (${r.status})`);
    result = await r.json();
  }
  // Les apps qui appellent directement cette fonction avec des outils (bureau,
  // agents du bureau) ne passent pas par `llmChat` : on annote ici aussi.
  notePayloadRequest(result, body, "ollama");
  scheduleUsageFallback(result, "llm");
  return result;
}

// ===== Modèle actif, par backend =====
//
// `selectedModel` désigne le modèle ACTIF, quel que soit le backend : c'est ce
// que lisent le Rust et toutes les surfaces (barre, bureau, agents). Mais un nom
// Ollama (« gemma3:4b ») et un fichier GGUF (« gemma-4-E2B_q4_0-it.gguf ») ne
// sont pas interchangeables. Avec cette seule clé partagée, basculer de backend
// laissait en place le modèle de l'ancien : `llama_start` recevait un nom
// Ollama et échouait, et revenir en arrière repartait sur le premier modèle
// venu. On mémorise donc le dernier modèle choisi POUR CHAQUE backend, et la
// bascule restaure celui-là.
const MODEL_MEMORY_PREFIX = "selectedModel:";

/**
 * Sources qui parlent l'API OpenAI à travers le proxy Rust `llm_api_request` :
 * le cloud (`api`), Lumen Server (`lumen`, édition Pro) et Apple Foundation
 * Models (`applefm`, macOS 27, passerelle locale). Tout ce qui vaut pour l'une
 * vaut pour les autres côté interface — seule la provenance de l'URL et du
 * jeton change, et elle est réglée côté Rust.
 */
export function isApiLike(source) {
  return source === "api" || source === "lumen" || source === "applefm";
}

/** Valeur `backend` attendue par `set_ollama_config` pour une source d'IA. */
export function rustBackend(source) {
  if (source === "api" || source === "llama" || source === "lumen" || source === "applefm") return source;
  return "ollama";
}

/** Clé localStorage du modèle d'une source « API » (cloud, Lumen Server, Apple). */
// ===== Plusieurs API cloud =====
// Les profils (URL, clé, modèle) vivent côté Rust (api-profiles.json) ; activer
// un profil le recopie dans la config active, puis on aligne ici les clés
// localStorage lues par toutes les surfaces. Les clés ne transitent jamais.
export async function listApiProfiles() {
  if (!invoke) return { active: "", profiles: [] };
  try { return await invoke("llm_api_profiles"); } catch { return { active: "", profiles: [] }; }
}

export async function activateApiProfile(id) {
  const res = await invoke("llm_api_profile_activate", { id });
  localStorage.setItem("apiBaseUrl", res.base || "https://api.openai.com/v1");
  localStorage.setItem("apiModel", res.model || "");
  return res;
}

/**
 * Modèles API proposés dans les menus : pour chaque API dont la clé est
 * enregistrée (ou serveur local), ses modèles retenus — cochés dans le
 * catalogue ou ajoutés à la main — plus son modèle courant.
 * → [{ id, name, model, active, label }]
 */
export async function listApiModelChoices() {
  const data = await listApiProfiles();
  const out = [];
  for (const p of data.profiles || []) {
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(p.base || "");
    if (!p.configured && !local) continue;
    const models = [...new Set([...(p.models || []), p.model].filter(Boolean))];
    for (const m of models) out.push({ id: p.id, name: p.name, model: m, active: data.active === p.id && p.model === m, label: `${p.name} · ${m}` });
  }
  return out;
}

/** Choisit un modèle d'une API configurée : active l'API et ce modèle. */
export async function selectApiModel(id, model) {
  const res = await invoke("llm_api_select", { id, model });
  localStorage.setItem("apiBaseUrl", res.base || "https://api.openai.com/v1");
  localStorage.setItem("apiModel", res.model || "");
  return res;
}

export function cloudModelKey(source) {
  if (source === "lumen") return "lumenModel";
  if (source === "applefm") return "applefmModel";
  return "apiModel";
}

/** Modèles Apple Foundation Models (macOS 27). */
export const APPLEFM_DEFAULT_MODEL = "apple-on-device";
export const APPLEFM_MODELS = [
  { id: "apple-on-device", label: "Apple Intelligence (sur l'appareil)" },
  { id: "apple-private-cloud", label: "Private Cloud Compute" },
];

/**
 * Apple Foundation Models utilisable ? macOS 27, passerelle embarquée et Apple
 * Intelligence activé. Renvoie l'état de la commande `applefm_status`
 * ({ available, bundled, reason, models }) ou un état « indisponible » hors
 * Tauri / hors macOS.
 */
export async function appleFmBackendState(force = false) {
  // Apple Foundation Models n'existe que sur macOS : ailleurs, pas de sonde,
  // l'option reste masquée partout (barre, Réglages, bureau, apps packagées).
  if (!/Mac/i.test(navigator.platform || navigator.userAgent || "")) {
    return { available: false, bundled: false, reason: "unsupported_platform", models: [] };
  }
  if (!invoke) return { available: false, bundled: false, reason: "no_backend", models: [] };
  try {
    const st = await invoke("applefm_status", { force });
    // Fenêtres de contexte réelles (elles dépendent du Mac) : mémorisées pour le
    // profiler et la jauge de contexte, qui ne les devinent plus.
    for (const m of (st?.models || [])) {
      if (m?.id && m.context_size > 0) { try { localStorage.setItem(`applefmContext:${m.id}`, String(m.context_size)); } catch {} }
    }
    return st && typeof st === "object" ? st : { available: false, bundled: false, reason: "unavailable", models: [] };
  } catch { return { available: false, bundled: false, reason: "unavailable", models: [] }; }
}

/** Phrase courte expliquant pourquoi Apple Foundation Models ne répond pas. */
export function appleFmReasonText(reason, lang = localStorage.getItem("lang") || "fr") {
  const en = lang === "en";
  switch (reason) {
    case "apple_intelligence_not_enabled":
      return en ? "Enable Apple Intelligence in System Settings." : "Activez Apple Intelligence dans Réglages Système.";
    case "model_not_ready":
      return en ? "The Apple model is still downloading." : "Le modèle Apple est encore en cours de téléchargement.";
    case "device_not_eligible":
      return en ? "This Mac is not eligible for Apple Intelligence." : "Ce Mac n'est pas compatible avec Apple Intelligence.";
    case "entitlement_missing":
      return en ? "Private Cloud Compute needs an Apple entitlement this build lacks." : "Private Cloud Compute exige un entitlement Apple absent de cette version.";
    case "not_bundled":
      return en ? "The Apple Foundation Models bridge is not bundled in this build." : "La passerelle Apple Foundation Models n'est pas embarquée dans cette version.";
    case "unsupported_platform":
      return en ? "Available on macOS 27 only." : "Disponible sur macOS 27 uniquement.";
    default:
      return en ? "Apple Foundation Models unavailable." : "Apple Foundation Models indisponible.";
  }
}

/**
 * Lumen Server utilisable comme backend d'inférence ? Licence Lumen Server
 * ET poste lié. Le front ne voit que l'URL (jamais le jeton).
 */
export async function lumenServerBackendState() {
  if (!invoke) return { available: false, url: "" };
  try {
    // La licence Lumen Server (et non plus une « édition Pro ») conditionne
    // l'usage du serveur comme backend.
    const { serverLicensed } = await import("./lib/pro-edition.js");
    if (!(await serverLicensed())) return { available: false, url: "" };
    const st = await invoke("netserver_state");
    const linked = !!(st && (st.linked ?? st.url));
    return { available: linked, url: st?.url || "" };
  } catch { return { available: false, url: "" }; }
}

/** Backends dont le modèle est un choix parmi une liste locale. */
function localSource(source) {
  return source === "llama" ? "llama" : "ollama";
}

/** Mémorise le modèle choisi pour ce backend (et le rend actif). */
export function rememberModelFor(source, model) {
  if (!model) return;
  localStorage.setItem(MODEL_MEMORY_PREFIX + localSource(source), model);
  localStorage.setItem("selectedModel", model);
}

/** Dernier modèle retenu pour ce backend, ou "" si on n'y est jamais allé. */
export function recallModelFor(source) {
  return localStorage.getItem(MODEL_MEMORY_PREFIX + localSource(source)) || "";
}

/**
 * Modèle à activer en arrivant sur ce backend : celui qu'on y avait laissé s'il
 * est toujours installé, sinon le premier de sa liste. Renvoie "" quand le
 * backend n'a aucun modèle — l'appelant affiche alors son propre message, il ne
 * faut surtout pas inventer un nom qui échouera au premier appel.
 */
export function pickModelForSource(source, available = []) {
  const list = Array.isArray(available) ? available.filter(Boolean) : [];
  const remembered = recallModelFor(source);
  if (remembered && list.includes(remembered)) return remembered;
  return list[0] || "";
}

// ===== Mode LLM hybride =====
// Option des Réglages (`llmHybrid`) : quand une demande échoue en local
// (harnais en erreur, réponse vide ou « je n'ai pas pu »), on propose de la
// rejouer sur l'API cloud configurée. La surcharge ci-dessous bascule la
// source le temps d'UN tour, sans toucher à `aiSource` (aucune autre fenêtre
// ne voit la bascule, rien n'est persisté).
let sourceOverride = "";

/** Source d'IA effective : surcharge temporaire (escalade) sinon `aiSource`. */
export function aiSourceNow() {
  return sourceOverride || localStorage.getItem("aiSource") || "";
}

export function llmHybridEnabled() {
  // Pilier « Modèles locaux d'abord » de l'intelligence hybride (lib/hybrid.js).
  return hybridState().local;
}

/**
 * L'escalade vers l'API a-t-elle un sens ? Mode hybride actif, source locale
 * (une source déjà cloud n'a rien au-dessus d'elle) et au moins un profil API
 * muni d'une clé. La clé n'est jamais lue : seul le drapeau `configured`.
 */
export async function apiEscalationAvailable() {
  if (!llmHybridEnabled() || isApiLike(aiSourceNow())) return false;
  const { profiles } = await listApiProfiles();
  return (profiles || []).some((p) => p.configured);
}

/** Exécute `fn` avec l'API cloud comme source, puis restaure. */
export async function withApiEscalation(fn) {
  const prev = sourceOverride;
  sourceOverride = "api";
  try { return await fn(); } finally { sourceOverride = prev; }
}

export function llmBackend() {
  return backendForSource(aiSourceNow() || "shortcut");
}

/**
 * Backend d'une source d'IA donnée, indépendamment de `aiSource` : une app
 * (l'Éditeur de code, par exemple) peut ainsi parler à un autre backend et à
 * un autre modèle que le reste de Lumen. `model` vide = modèle mémorisé de la
 * source. Le champ `source` suit l'objet jusqu'au proxy Rust.
 */
export function backendForSource(source, model = "") {
  const b = backendForSourceRaw(source || "shortcut");
  b.source = source || "shortcut";
  if (model) b.model = model;
  else if (source && source !== (localStorage.getItem("aiSource") || "") && !isApiLike(source)) {
    b.model = recallModelFor(source) || b.model;
  }
  return b;
}

function backendForSourceRaw(source) {
  // SÉCURITÉ : la clé API n'est plus lue ni stockée côté front. L'activation du
  // backend cloud dépend uniquement de `aiSource === "api"` ; les appels passent
  // par la commande backend `llm_api_request`, seule détentrice de la clé.
  if (source === "api") {
    return {
      api: true,
      base: (localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1").replace(/\/+$/, ""),
      model: localStorage.getItem("apiModel") || "gpt-4o-mini",
      key: "",
    };
  }
  // Lumen Server (édition Pro) : l'inférence part vers le serveur lié, avec le
  // jeton d'appareil. URL et jeton vivent côté Rust (lumen_server_link.json) :
  // le front n'a que le modèle, tout le reste passe par `llm_api_request`, que
  // le backend résout vers `<serveur>/v1/ai` (cf. agents.rs resolve_lumen_backend).
  if (source === "lumen") {
    return {
      api: true,
      lumen: true,
      base: "",
      model: localStorage.getItem("lumenModel") || "",
      key: "",
    };
  }
  // Apple Foundation Models (macOS 27) : passerelle locale lumen-applefm,
  // résolue côté Rust (agents.rs resolve_applefm_backend). Même chemin que le
  // cloud : `llm_api_request`, sans clé.
  if (source === "applefm") {
    return {
      api: true,
      applefm: true,
      base: "http://127.0.0.1:11437/v1",
      model: localStorage.getItem("applefmModel") || APPLEFM_DEFAULT_MODEL,
      key: "",
    };
  }
  if (source === "llama") {
    return {
      api: true,
      llama: true,
      base: "http://127.0.0.1:11435/v1",
      model: localStorage.getItem("selectedModel") || "",
      key: "",
    };
  }
  // LiteRT-LM (runtime Google AI Edge embarqué dans le build Raspberry Pi).
  // `api: true` parce que le serveur parle bien l'API OpenAI ; `litert: true`
  // pour que la requête parte vers le proxy local et non vers `llm_api_request`,
  // qui est le chemin de l'API cloud et porte la clé de l'utilisateur.
  if (source === "litert") {
    return {
      api: true,
      litert: true,
      base: "http://127.0.0.1:9379/v1",
      model: localStorage.getItem("selectedModel") || "",
      key: "",
    };
  }
  return {
    api: false,
    base: (localStorage.getItem("ollamaUrl") || "http://localhost:11434").replace(/\/+$/, ""),
    model: localStorage.getItem("selectedModel") || "",
    key: "",
  };
}

async function lumenSystemPrompt() {
  let profile = null;
  let memories = [];
  if (invoke) {
    try {
      const [profileEntry, memoriesEntry] = await Promise.all([
        invoke("memory_get", { key: "user/profile" }),
        invoke("memory_get", { key: "user/memories" }),
      ]);
      profile = profileEntry?.value && typeof profileEntry.value === "object" ? profileEntry.value : null;
      memories = Array.isArray(memoriesEntry?.value) ? memoriesEntry.value : [];
    } catch (_) { /* le prompt personnalisé reste disponible sans la mémoire */ }
  }
  return buildLumenSystemPrompt({
    profile: profile || {},
    memories,
    customPrompt: localStorage.getItem("systemPrompt") || "",
    compact: true,
    language: localStorage.getItem("lang") || "",
  });
}

// Les mini-apps envoient souvent uniquement leur message utilisateur. Pour
// llama-server, reproduire le comportement Ollama en ajoutant le prompt
// système global tant qu'un prompt explicite n'est pas déjà présent.
async function messagesWithLumenSystem(messages) {
  const normalized = Array.isArray(messages) ? messages.slice() : [];
  const systemPrompt = await lumenSystemPrompt();
  if (!systemPrompt) return normalized;
  // Ollama fournit un seul bloc système au template du modèle. On fusionne
  // donc les éventuelles consignes d'une mini-app dans ce même message.
  const explicitSystem = normalized
    .filter((message) => message?.role === "system" && !isLumenSystemPrompt(message.content))
    .map((message) => String(message.content || "").trim())
    .filter(Boolean);
  const nonSystem = normalized.filter((message) => message?.role !== "system");
  return [{ role: "system", content: [systemPrompt, ...explicitSystem].join("\n\n") }, ...nonSystem];
}

// Prépare la liste de messages. `rawSystem` court-circuite l'injection du
// prompt Lumen : indispensable pour les modèles-routeurs (LFM2.5), dont la
// fiche officielle impose un prompt système COURT — les consignes de mémoire,
// de profil et de ton dégradent nettement leur JSON.
async function prepareMessages(messages, opts = {}) {
  return opts.rawSystem ? (Array.isArray(messages) ? messages.slice() : []) : messagesWithLumenSystem(messages);
}

// Les mini-apps joignent leurs images au format Ollama (`images: [base64]`).
// llama-server (démarré avec `--mmproj`) et les API OpenAI attendent au
// contraire un contenu découpé en parties. On convertit ici, à l'entrée du
// backend, pour que les apps n'aient qu'un seul format d'image à connaître.
function base64ImageMime(b64) {
  const head = String(b64).slice(0, 12);
  if (head.startsWith("iVBOR")) return "image/png";
  if (head.startsWith("R0lGOD")) return "image/gif";
  if (head.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

export function withOpenAiImages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const images = Array.isArray(message?.images) ? message.images.filter(Boolean) : [];
    if (!images.length) return message;
    const { images: _drop, ...rest } = message;
    const text = typeof message.content === "string" ? message.content : "";
    return {
      ...rest,
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...images.map((image) => {
          const url = String(image).startsWith("data:")
            ? String(image)
            : `data:${base64ImageMime(image)};base64,${image}`;
          return { type: "image_url", image_url: { url } };
        }),
      ],
    };
  });
}

// Sortie structurée. `opts.schema` est prioritaire sur `opts.json` : llama.cpp
// et les API OpenAI compilent le schéma en grammaire, ce qui garantit un JSON
// conforme au lieu de simplement l'encourager par le prompt.
//
// Le mode `strict` d'OpenAI exige sur CHAQUE objet `additionalProperties: false`
// et toutes les propriétés dans `required` (sinon HTTP 400). On complète
// `additionalProperties` quand il manque ; si une propriété reste facultative,
// on repasse en `strict: false` plutôt que d'échouer.
function strictSchema(schema) {
  let ok = true;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    const isObject = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object")) || out.properties;
    if (isObject) {
      if (out.additionalProperties === undefined) out.additionalProperties = false;
      else if (out.additionalProperties !== false) ok = false;
      const keys = Object.keys(out.properties || {});
      const req = new Set(out.required || []);
      if (keys.some((key) => !req.has(key))) ok = false;
    }
    return out;
  };
  const schema2 = walk(schema);
  return { schema: schema2, strict: ok };
}

function responseFormat(opts) {
  if (opts.schema) {
    const { schema, strict } = strictSchema(opts.schema);
    return {
      type: "json_schema",
      json_schema: { name: opts.schemaName || "lumen_output", strict, schema },
    };
  }
  return opts.json ? { type: "json_object" } : null;
}

/**
 * Réponse OpenAI → métriques au contrat Ollama (`eval_count`, `eval_duration`…),
 * que les widgets, le bouton « infos » des bulles et le Journal LLM savent lire.
 * Les serveurs locaux (llama-server, passerelle Apple Foundation Models)
 * joignent un bloc `timings` : c'est lui qui donne les tokens/s. Une API cloud
 * n'en a pas — on ne garde alors que les compteurs de `usage`, sans vitesse.
 */
export function withOpenAiTimings(data) {
  if (!data || typeof data !== "object" || data.eval_count) return data;
  const timings = data.timings || {};
  const evalCount = Number(data.usage?.completion_tokens || timings.predicted_n || 0);
  const promptCount = Number(data.usage?.prompt_tokens || timings.prompt_n || 0);
  if (!evalCount && !promptCount) return data;
  const evalDuration = Number(timings.predicted_ms || 0) * 1e6;
  const promptDuration = Number(timings.prompt_ms || 0) * 1e6;
  return {
    ...data,
    eval_count: evalCount,
    prompt_eval_count: promptCount,
    eval_duration: evalDuration,
    prompt_eval_duration: promptDuration,
    total_duration: Number(timings.total_ms || 0) * 1e6 || evalDuration + promptDuration,
  };
}

// Chat non-stream unifié. `messages` = [{role, content}, …].
// opts.model : surcharge le modèle. opts.json : force une sortie JSON stricte.
// opts.schema : schéma JSON de sortie (grammaire côté serveur, plus fiable).
// opts.rawSystem : n'injecte pas le prompt système global de Lumen.
// opts.think : force/désactive le raisonnement (défaut : réglage global).
// Renvoie { content, data } (data = réponse brute, pour recordOllamaUsage côté Ollama).
// opts.backend : surcharge explicite { api, base, model } (utile pour qu'une app
// laisse l'utilisateur choisir local vs cloud sans toucher la config globale).
// opts.onDelta(texte, état) / opts.onUpdate(état) : réponse EN FLUX — le texte
// cumulé (raisonnement et `<think>` exclus) arrive au fil de l'eau ; `état`
// (StreamState) porte aussi le raisonnement et les appels d'outils en cours.
// Pour l'affichage, `createStreamView` fait tout (blocs repliables compris).
// opts.signal : AbortSignal pour interrompre le flux (bouton Stop).
// opts.maxTokens : plafond de jetons générés (étapes courtes, garde-fou contre
// un petit modèle qui génère sans fin).
export async function llmChat(messages, opts = {}) {
  // Schéma déduit de l'exemple d'un prompt (prompt-kit) : imposé dès que
  // l'appel demande du JSON. Le serveur ne peut alors plus produire un JSON
  // cassé ou incomplet.
  // Mesuré au banc (03/10, 22 usages JSON, 1.2B Thinking) : sans schéma 5/22,
  // schéma imposé 7/22 ; laisser d'abord raisonner donnait 8/22 mais 8× plus
  // lent (la grammaire, `json_object` compris, coupe le raisonnement).
  if (opts.json && !opts.schema && messages?.schema?.type) opts = { ...opts, schema: messages.schema };
  const res = await llmChatRaw(messages, opts);
  if (messages?.promptId && opts.schema && !opts.tools) {
    const parsed = parseLoose(res.content);
    if (parsed && matchesSchema(parsed, opts.schema)) promptExamples.remember(messages.promptId, messages.fewShotInput, JSON.stringify(parsed));
  }
  return res;
}

function parseLoose(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* repli */ }
  const m = t.match(/[[{][\s\S]*[\]}]/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

async function llmChatRaw(messages, opts = {}) {
  const b = opts.backend || llmBackend();
  const model = opts.model || b.model;
  let data;
  let viaPostJson = false;
  if (b.llama) {
    if (!invoke) throw new Error("Backend llama.cpp indisponible");
    const think = opts.think ?? (localStorage.getItem("ollamaThink") === "true");
    const isLfm = isLfmModel(model);
    const body = {
      model,
      // llama-server est démarré avec `--jinja` : il applique le template Jinja
      // du GGUF (rôles ChatML system/user/assistant/tool, marqueurs d'outils
      // LFM2 `<|tool_call_start|>`). Équivalent d'`apply_chat_template()` — on
      // n'assemble donc jamais le prompt à la main ici.
      messages: withOpenAiImages(await prepareMessages(messages, opts)),
      stream: false,
      timings_per_token: true,
    };
    if (opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
    // Un LFM « Thinking » raisonne TOUJOURS (`think: false` n'a pas d'effet sur
    // son template, cf. ci-dessous). Sur une tâche courte sans plafond, une
    // boucle de raisonnement a tenu 10 minutes au banc : on borne la sortie.
    else if (opts.think === false && isLfmThinkingModel(model)) body.max_tokens = LFM_THINKING_SHORT_TASK_TOKENS;
    // Les LFM ont un template dédié sans bascule `enable_thinking` (la variante
    // Thinking est un modèle distinct) : lui passer le kwarg n'a aucun effet et
    // brouille la détection de format côté serveur.
    if (!isLfm) body.chat_template_kwargs = { enable_thinking: think };
    // Réglages d'échantillonnage officiels Liquid AI, appliqués à TOUTE la
    // famille et non à la seule variante Thinking : sans eux, le routeur 350M
    // hallucine des noms d'outils et casse son JSON.
    Object.assign(body, lfmSampling(model) || { repeat_penalty: LOCAL_REPEAT_PENALTY });
    const format = responseFormat(opts);
    if (format) body.response_format = format;
    if (Array.isArray(opts.tools) && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.tool_choice || "auto";
      // llama.cpp construit une grammaire de réponse OU une grammaire d'outils,
      // jamais les deux : un schéma de sortie serait ignoré ici.
      delete body.response_format;
      // Le format officiel LFM émet plusieurs appels dans UN SEUL bloc
      // `<|tool_call_start|>[a(...), b(...)]<|tool_call_end|>` : les brider par
      // défaut revenait à ignorer la moitié de ce que le modèle sait faire.
      // Les trois boucles d'outils de Lumen (barre, bureau, agents) itèrent
      // déjà sur `tool_calls`. Les autres familles restent sur le comportement
      // historique (un outil à la fois).
      body.parallel_tool_calls = isLfm ? (opts.parallel_tool_calls ?? true) : false;
    }
    data = wantsStream(opts)
      ? await streamWithLoopRetry({ target: "llama", payload: body }, opts)
      : await invoke("llama_post_json", { path: "v1/chat/completions", payload: body });
    // llama-server renvoie les métriques dans `timings`, alors que les widgets
    // et le journal LLM consomment le contrat Ollama (`eval_count`, etc.).
    // Exposer les deux formes évite de perdre les tokens des apps du bureau.
    const timings = data?.timings || {};
    const evalCount = Number(data?.usage?.completion_tokens || timings.predicted_n || 0);
    const promptCount = Number(data?.usage?.prompt_tokens || timings.prompt_n || 0);
    const evalDuration = Number(timings.predicted_ms || 0) * 1e6;
    const promptDuration = Number(timings.prompt_ms || 0) * 1e6;
    data = {
      ...data,
      eval_count: evalCount,
      prompt_eval_count: promptCount,
      eval_duration: evalDuration,
      prompt_eval_duration: promptDuration,
      total_duration: Number(timings.total_ms || 0) * 1e6 || evalDuration + promptDuration,
    };
  } else if (b.litert) {
    // Serveur local compatible OpenAI, sans clé. Le proxy Rust démarre
    // `litert-lm serve` à la demande et importe le modèle dans le registre du
    // CLI — deux étapes que le front n'a pas à connaître.
    if (!invoke) throw new Error("Backend LiteRT-LM indisponible");
    const body = { model, messages: withOpenAiImages(await prepareMessages(messages, opts)) };
    if (opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
    const format = responseFormat(opts);
    if (format) body.response_format = format;
    if (Array.isArray(opts.tools) && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.tool_choice || "auto";
      delete body.response_format;
    }
    data = wantsStream(opts)
      ? await streamWithLoopRetry({ target: "litert", payload: body }, opts)
      : await invoke("litert_post_json", { path: "v1/chat/completions", payload: body });
  } else if (b.api) {
    // Passe par le proxy backend sécurisé : la clé n'entre jamais dans la WebView.
    if (!invoke) throw new Error("Backend indisponible");
    const body = { model, messages: withOpenAiImages(await prepareMessages(messages, opts)) };
    if (opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
    const format = responseFormat(opts);
    if (format) body.response_format = format;
    if (Array.isArray(opts.tools) && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.tool_choice || "auto";
      delete body.response_format;
    }
    // La source est transmise : le proxy Rust ne dépend plus d'un fichier de
    // configuration qui peut être en retard d'une bascule.
    const backend = rustBackend(b.source || aiSourceNow());
    data = withOpenAiTimings(wantsStream(opts)
      ? await streamWithLoopRetry({ target: "api", payload: body, backend }, opts)
      : await invoke("llm_api_request", { path: "chat/completions", body, backend }));
  } else {
    const body = { model, messages: await prepareMessages(messages, opts), stream: false };
    // Ollama accepte directement un schéma JSON dans `format`.
    if (opts.schema) body.format = opts.schema;
    else if (opts.json) body.format = "json";
    // Raisonnement demandé explicitement (fenêtre Assistant avec « Réflexion »).
    if (opts.think === true) body.think = true;
    if (Array.isArray(opts.tools) && opts.tools.length) {
      body.tools = opts.tools;
      delete body.format;
    }
    // Respecte les réglages globaux Ollama (taille de contexte, keep-alive) —
    // sinon les appels non-streaming (App Studio, Designer, Data Analysis…)
    // retombent sur le num_ctx par défaut du modèle, ignorant le paramètre.
    const numCtx = parseInt(localStorage.getItem("ollamaNumCtx") || "0", 10);
    // Budget de SORTIE explicite : sinon Ollama tronque les longues réponses
    // (code multi-fichiers de l'agent) sur son défaut, quel que soit le contexte.
    const npRaw = localStorage.getItem("ollamaNumPredict");
    const numPredict = npRaw == null || npRaw === "" ? -1 : (parseInt(npRaw, 10) || -1);
    body.options = { ...(body.options || {}), num_predict: opts.maxTokens > 0 ? opts.maxTokens : numPredict };
    if (numCtx > 0) body.options.num_ctx = numCtx;
    const keepAlive = localStorage.getItem("ollamaKeepAlive");
    if (keepAlive) body.keep_alive = keepAlive;
    if (wantsStream(opts)) {
      // Le flux passe toujours par Rust : ni CORS ni CSP, hôte distant compris.
      data = await streamWithLoopRetry({ target: "ollama", payload: body, url: b.base }, opts);
      notePayloadRequest(data, body, "ollama");
    } else if (ollamaUsesBackend(b.base)) {
      data = await ollamaPostJson("api/chat", body, b.base, { source: "ollama" });
      // `ollamaPostJson` a déjà armé son repli : on ne le double pas ci-dessous.
      viaPostJson = true;
    } else {
      const r = await fetch(`${b.base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Ollama indisponible");
      data = await r.json();
    }
  }
  // Côté REQUÊTE du Profiler : ces réglages ne sont plus lisibles une fois la
  // réponse remontée à l'app, alors qu'ils expliquent l'essentiel de son coût
  // (des outils présentés occupent le contexte même sans être appelés).
  noteRequest(data, {
    backend: b.llama ? "llama.cpp" : b.litert ? "litert" : b.lumen ? "lumen" : b.applefm ? "applefm" : b.api ? "api" : "ollama",
    model,
    ctxSize: llmContextWindow(b),
    temperature: (b.llama ? lfmSampling(model)?.temperature : undefined) ?? null,
    thinking: b.llama ? (opts.think ?? (localStorage.getItem("ollamaThink") === "true")) : null,
    toolsOffered: (Array.isArray(opts.tools) ? opts.tools : []).map((t) => t?.function?.name || t?.name).filter(Boolean),
    structured: opts.schema ? "schema" : opts.json ? "json" : "",
    messages: Array.isArray(messages) ? messages.length : 0,
    // Contenu échangé : consultable dans le Profiler, au clic sur le point.
    transcript: captureTranscript(messages),
  });
  // Comptage central des jetons (widget « Tokens du jour », Journal LLM) :
  // toute génération passe ici, même depuis une app qui n'appelle jamais
  // `recordOllamaUsage`. Repli déduplicaté — une app qui compte elle-même
  // garde la main (et son étiquette).
  if (!viaPostJson) scheduleUsageFallback(data, opts.source || "llm");
  // llama.cpp et LiteRT renvoient eux aussi la forme OpenAI (`choices`).
  const raw = data?.choices?.[0]?.message?.content ?? data?.message?.content ?? "";
  // Un modèle qui raisonne en ligne (`<think>`) ne doit pas livrer son brouillon
  // comme réponse à l'app qui l'a appelé.
  const content = extractLfmToolCalls(stripThink(raw)).content;
  return { content, data };
}

/**
 * Fenêtre de contexte configurée pour ce backend, en tokens. 0 quand elle est
 * laissée au défaut du modèle (Ollama) ou hors de notre contrôle (API cloud) :
 * le Profiler affiche alors l'occupation en valeur absolue, sans pourcentage
 * qu'il ne pourrait pas justifier.
 */
export function llmContextWindow(backend = llmBackend()) {
  return configuredContextWindow(backend.llama ? "llama.cpp" : backend.litert ? "litert" : backend.applefm ? "applefm" : backend.api ? "api" : "ollama");
}

/**
 * Mentions « @outil » : consigne de tour et `tool_choice` qui OBLIGENT le
 * modèle à appeler l'outil demandé au premier tour. Sans cela, un petit modèle
 * (ou Apple sur l'appareil) lit « @weather_now Quel temps… » comme du texte et
 * répond de mémoire — la mention s'affichait, mais ne faisait rien.
 * @param {Array} tools specs OpenAI des outils mentionnés
 * @param {"fr"|"en"} lang
 * @returns {{ system: {role:"system", content:string}, toolChoice: any }}
 */
export function forcedToolTurn(tools, lang = "fr") {
  const names = (tools || []).map((t) => t?.function?.name).filter(Boolean);
  const list = names.map((n) => `« ${n} »`).join(", ");
  const content = lang === "en"
    ? `The user explicitly asked to use the tool${names.length > 1 ? "s" : ""} ${list} (the “@name” in the message). Call ${names.length > 1 ? "them" : "it"} NOW with a function call — no text answer first — inferring the arguments from the request, then answer from the result.`
    : `L'utilisateur demande explicitement d'utiliser l'outil${names.length > 1 ? "s" : ""} ${list} (le « @nom » du message). Appelle-${names.length > 1 ? "les" : "le"} MAINTENANT par un appel de fonction — pas de réponse en texte d'abord — en déduisant les arguments de la demande, puis réponds à partir du résultat.`;
  // OpenAI-compatible : un seul outil → forçage nominatif ; plusieurs →
  // « required ». Ollama ignore le champ, la passerelle Apple aussi (elle ne
  // regarde que « none ») : la consigne système fait alors le travail.
  const toolChoice = names.length === 1 ? { type: "function", function: { name: names[0] } } : "required";
  return { system: { role: "system", content }, toolChoice };
}
