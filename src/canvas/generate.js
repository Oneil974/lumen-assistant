import { explicitInferenceSource, assertAppleModel } from "../lib/inference-source.js";
// Routeur de génération « local-first » du Canvas génératif.
//
// Stratégie demandée : utiliser le LOCAL en priorité, et basculer sur le CLOUD
// uniquement si le local est indisponible (modèle absent, moteur arrêté, erreur).
// Le choix se fait PAR TYPE (texte / image) et indépendamment : le texte peut
// venir d'Ollama pendant que l'image part en cloud, ou l'inverse.
//
// On s'appuie sur les primitives déjà intégrées à l'app :
//   - texte local  : Ollama  (api/chat) via ../llm.js
//   - texte cloud  : commande backend `llm_api_request` (clé jamais côté front)
//   - image local  : Bonsai Image (commande `bonsai_generate_*`, provider "bonsai")
//                    ou un modèle d'image servi par Ollama (provider "ollama")
//   - image cloud  : même commande, provider "openai"
// Les sondes de disponibilité sont mises en cache quelques secondes pour ne pas
// pinger les backends à chaque node créé.

import { ollamaGetJson, ollamaPostJson, llmChat, backendForSource, appleFmBackendState } from "../llm.js";
import { recordOllamaUsage, recordImageGeneration } from "../ollama-usage.js";
import { recallPromptBlock } from "../memory-bridge.js";
import { barsForDuration } from "./music.js";
import { imageGenerationConfig, imageProvider, imageErrorMessage } from "../lib/image-provider.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const invoke = __TAURI.core?.invoke;

// ---------------------------------------------------------------------------
//  Sondes de disponibilité (cache court)
// ---------------------------------------------------------------------------
const PROBE_TTL = 5000; // ms
const probeCache = new Map(); // key -> { at, value }
const BACKEND_PREFS = new Set(["auto", "local", "cloud", "ollama", "applefm"]);
// Le moteur d'IMAGE est choisi explicitement (plus d'« auto » ni de « local » :
// chaque moteur a ses modèles et ses résolutions, un repli silencieux
// produirait une image d'un autre modèle que celui affiché).
const IMAGE_PREFS = new Set(["bonsai", "ollama", "openai", "playground"]);

async function canvasContext(prompt, context = "") {
  const block = await recallPromptBlock(invoke, `canvas génératif ${prompt}`, {
    context: "bar",
    limit: 4,
    title: "Souvenirs utiles pour ce canvas",
  });
  return [block, context].filter(Boolean).join("\n\n");
}

async function probe(key, fn) {
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit.value;
  let value = false;
  try { value = await fn(); } catch { value = false; }
  probeCache.set(key, { at: Date.now(), value });
  return value;
}

// Vide le cache des sondes (à appeler quand l'utilisateur change de réglage IA).
export function resetProbes() { probeCache.clear(); }

function pref(kind) {
  if (kind === "image") {
    // Anciennes valeurs (« auto », « local », « cloud ») : on retombe sur le
    // moteur des réglages.
    const value = localStorage.getItem("canvasImageBackend") || "";
    return IMAGE_PREFS.has(value) ? value : imageProvider();
  }
  const value = localStorage.getItem("canvasTextBackend") || "auto";
  return BACKEND_PREFS.has(value) ? value : "auto";
}

async function localTextReady() {
  return probe("text:local", async () => {
    const tags = await ollamaGetJson("api/tags");
    const models = tags?.models || [];
    if (!models.length) return false;
    // Un modèle doit être sélectionné (ou on prend le premier disponible).
    return true;
  });
}

async function cloudReady() {
  return probe("cloud", async () => {
    if (!invoke) return false;
    const st = await invoke("llm_secret_status");
    return !!(st && st.configured);
  });
}

async function localImageReady() {
  return probe("image:local", async () => {
    if (!invoke) return false;
    const st = await invoke("bonsai_status");
    return !!(st && st.running);
  });
}

// Ollama sert la génération d'images sur son endpoint compatible OpenAI. On ne
// peut pas sonder ce endpoint sans lancer une génération : on se contente donc
// de vérifier que le serveur répond, comme pour le texte.
async function ollamaImageReady() {
  return probe("image:ollama", async () => {
    if (!invoke) return false;
    const models = await invoke("ollama_list_models", { url: localStorage.getItem("ollamaUrl") || null });
    return Array.isArray(models);
  });
}

// Image Playground (macOS 27) : disponible dès qu'Apple Intelligence répond ;
// la génération elle-même passe par la feuille système, validée par l'utilisateur.
async function playgroundReady() {
  return probe("image:playground", async () => {
    if (!invoke) return false;
    const st = await invoke("imageplayground_status");
    return !!(st && st.available);
  });
}

async function providerReady(provider) {
  if (provider === "openai") return cloudReady();
  if (provider === "ollama") return ollamaImageReady();
  if (provider === "playground") return playgroundReady();
  return localImageReady();
}

// État synthétique pour l'UI (badges, message « aucun backend »).
export async function backendsStatus() {
  const textPref = pref("text");
  const imagePref = pref("image");
  const [tLocal, cloud] = await Promise.all([localTextReady(), cloudReady()]);
  const explicitReady = textPref === 'applefm' ? (await appleFmBackendState()).available : textPref === 'ollama' ? await probe('text:ollama', async () => (await ollamaGetJson('api/tags', undefined, { source: 'ollama' }))?.models?.length > 0) : false;
  const pick = (p, localOk, cloudOk) => {
    if (p === "local") return localOk ? "local" : null;
    if (p === "cloud") return cloudOk ? "cloud" : null;
    return localOk ? "local" : cloudOk ? "cloud" : null;
  };
  // Côté image, un seul moteur : celui choisi. `null` = sa sonde a échoué.
  const image = (await providerReady(imagePref)) ? imagePref : null;
  return {
    text: ['ollama','applefm'].includes(textPref) ? (explicitReady ? textPref : null) : pick(textPref, tLocal, cloud),
    image,
    textPref,
    imagePref,
  };
}

// ---------------------------------------------------------------------------
//  Génération de TEXTE
// ---------------------------------------------------------------------------
// Les fonctions bas-niveau renvoient la réponse BRUTE (pour comptabiliser les
// tokens dans le widget d'usage via recordOllamaUsage).
async function textLocal(messages, json = false, opts = {}) {
  const model = localStorage.getItem("selectedModel") || "";
  const body = { model: opts.model || model, messages };
  if (opts.maxTokens) { body.options = { num_predict: Math.min(8192, Math.max(1, Number(opts.maxTokens) || 1024)) }; }
  if (json) body.format = "json";
  return ollamaPostJson("api/chat", body);
}

async function textCloud(messages, json = false, opts = {}) {
  if (!invoke) throw new Error("Backend indisponible");
  const model = localStorage.getItem("apiModel") || "gpt-4o-mini";
  const body = { model: opts.model || model, messages };
  if (opts.maxTokens) body.max_tokens = Math.min(8192, Math.max(1, Number(opts.maxTokens) || 1024));
  if (json) body.response_format = { type: "json_object" };
  return invoke("llm_api_request", { path: "chat/completions", body, ...(opts.backend === "cloud" ? { backend: "api" } : {}) });
}

// Variante interne factorisée : envoie `messages` au backend texte (local puis
// cloud) avec option JSON. Comptabilise les tokens, renvoie { content, backend }.
async function textDispatch(messages, json = false, opts = {}) {
  const choice = opts.backend && opts.backend !== "auto" ? opts.backend : pref("text");
  const source = explicitInferenceSource(choice);
  if (source) {
    const model = source === 'applefm' ? assertAppleModel(await appleFmBackendState(), opts.model) : opts.model;
    const result = await llmChat(messages, { backend: backendForSource(source), model, json, maxTokens: Math.min(8192, Math.max(1, Number(opts.maxTokens) || 1024)), stream: false });
    return { content: result.content || '', backend: source };
  }
  const p = ["local", "cloud"].includes(opts.backend) ? opts.backend : pref("text");
  if (p !== "cloud" && await localTextReady()) {
    try {
      const data = await textLocal(messages, json, opts);
      recordOllamaUsage(data, "canvas");
      return { content: data?.message?.content || "", backend: "local" };
    } catch (e) { if (p === "local" || !(await cloudReady())) throw e; }
  }
  if (p !== "local" && await cloudReady()) {
    const data = await textCloud(messages, json, opts);
    // Réponse OpenAI : usage.{prompt,completion}_tokens → schéma Ollama attendu.
    const u = data?.usage || {};
    recordOllamaUsage({ prompt_eval_count: u.prompt_tokens, eval_count: u.completion_tokens }, "canvas-cloud");
    return { content: data?.choices?.[0]?.message?.content || "", backend: "cloud" };
  }
  throw new Error(p === "local"
    ? "Backend texte local indisponible (Ollama/modèle local)."
    : p === "cloud"
      ? "Backend texte cloud indisponible (clé/API non configurée)."
      : "Aucun backend texte disponible (ni Ollama local, ni cloud configuré).");
}

// `context` : texte hérité du node parent (filiation). Optionnel.
// Renvoie { content, backend: "local" | "cloud" }.
export async function generateText(prompt, context = "", opts = {}) {
  context = await canvasContext(prompt, context);
  return textDispatch(PROMPTS["app.canvas.text"].build({ prompt, context, lang: replyLang() }).messages, false, opts);
}

// ---------------------------------------------------------------------------
//  Génération d'une CHARTE (palette + typographie) — sortie JSON structurée.
//  Le modèle propose des familles Google Fonts et des couleurs hex ; l'app
//  « appelle » ensuite Google Fonts pour charger les polices (function-calling
//  côté client, fiable même avec de petits modèles locaux).
// ---------------------------------------------------------------------------
function safeParseJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = String(s).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Renvoie { charte, backend }. `charte` = objet validé/normalisé.
export async function generateCharte(prompt, context = "", opts = {}) {
  context = await canvasContext(prompt, context);
  const { content, backend } = await textDispatch(PROMPTS["app.canvas.charte"].build({ prompt, context }).messages, true, opts);
  const raw = safeParseJson(content);
  if (!raw || !raw.palette) throw new Error("Charte illisible (réponse non conforme du modèle).");
  // Normalisation défensive.
  const hex = (h) => (/^#?[0-9a-fA-F]{6}$/.test(String(h || "")) ? "#" + String(h).replace(/^#/, "").toLowerCase() : "#888888");
  const charte = {
    name: raw.name || "Charte",
    mood: raw.mood || "",
    fonts: { heading: raw.fonts?.heading || "Poppins", body: raw.fonts?.body || "Inter" },
    palette: (Array.isArray(raw.palette) ? raw.palette : []).slice(0, 6).map((c) => ({
      name: c.name || "Couleur", hex: hex(c.hex), role: c.role || "",
    })),
    headings: {
      h1: { size: raw.headings?.h1?.size || 40, weight: raw.headings?.h1?.weight || 700 },
      h2: { size: raw.headings?.h2?.size || 30, weight: raw.headings?.h2?.weight || 600 },
      h3: { size: raw.headings?.h3?.size || 22, weight: raw.headings?.h3?.weight || 600 },
    },
  };
  return { charte, backend };
}

// ---------------------------------------------------------------------------
//  Génération d'IMAGE
// ---------------------------------------------------------------------------
// Jingle / accroche audio : texte court et rythmé, destiné à être lu par la TTS.
export async function generateJingle(prompt, context = "", opts = {}) {
  context = await canvasContext(prompt, context);
  return textDispatch(PROMPTS["app.canvas.jingle"].build({ prompt, context, lang: replyLang() }).messages, false, opts);
}

// `opts.durationSec` : durée approximative de la voix off (secondes). Quand elle
// est fournie, le modèle local cale la musique sur cette longueur (nombre de
// mesures dérivé du tempo) et produit un `musicPrompt` en langage naturel,
// prêt à piloter un moteur Text-to-Music type Magenta RealTime.
export async function generateMusicSpec(prompt, jingle = "", context = "", opts = {}) {
  context = await canvasContext(prompt, context);
  const durationSec = Number(opts.durationSec) || 0;
  const { messages } = PROMPTS["app.canvas.music"].build({ prompt, jingle, context, durationSec });
  const { content, backend } = await textDispatch(messages, true, opts);
  const raw = safeParseJson(content) || {};
  const keys = new Set(["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]);
  const scales = new Set(["major", "minor", "pentatonic"]);
  const oscs = new Set(["sine", "triangle", "square", "sawtooth"]);
  const normEvents = (arr, fallback) => (Array.isArray(arr) && arr.length ? arr : fallback).map((e, i) => ({
    degree: Math.min(Math.max(parseInt(e.degree, 10) || 0, 0), 7),
    octave: Math.min(Math.max(parseInt(e.octave, 10) || 0, -3), 3),
    start: Math.max(Number(e.start) || i * 0.5, 0),
    dur: Math.min(Math.max(Number(e.dur) || 0.5, 0.125), 4),
    velocity: Math.min(Math.max(Number(e.velocity) || 0.7, 0.1), 1),
  })).slice(0, 36);
  const tempo = Math.min(Math.max(parseInt(raw.tempo, 10) || 112, 70), 150);
  // Si la durée cible est connue, les mesures en découlent (la voix off prime
  // sur la valeur proposée par le modèle) ; sinon on garde la proposition.
  const bars = durationSec
    ? barsForDuration(durationSec, tempo)
    : Math.min(Math.max(parseInt(raw.bars, 10) || 4, 2), 16);
  return {
    music: {
      mood: String(raw.mood || prompt || "jingle").slice(0, 80),
      musicPrompt: String(raw.musicPrompt || raw.synthPrompt || raw.mood || prompt || "warm uplifting brand jingle bed").slice(0, 200),
      instruments: (Array.isArray(raw.instruments) ? raw.instruments : []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 4),
      durationSec: durationSec || 0,
      tempo,
      key: keys.has(raw.key) ? raw.key : "C",
      scale: scales.has(raw.scale) ? raw.scale : "major",
      sound: "synth",
      bars,
      synthPrompt: String(raw.synthPrompt || raw.mood || prompt || "clean playable synth").slice(0, 120),
      synth: {
        osc: oscs.has(raw.synth?.osc) ? raw.synth.osc : "square",
        filter: Math.min(Math.max(parseInt(raw.synth?.filter, 10) || 1600, 180), 5000),
        attack: Math.min(Math.max(Number(raw.synth?.attack) || 0.015, 0.005), 0.5),
        release: Math.min(Math.max(Number(raw.synth?.release) || 0.28, 0.05), 2),
        drive: Math.min(Math.max(Number(raw.synth?.drive) || 0.12, 0), 1),
        delay: Math.min(Math.max(Number(raw.synth?.delay) || 0.08, 0), 0.45),
      },
      melody: normEvents(raw.melody, [{ degree: 0, start: 0, dur: 0.5 }, { degree: 2, start: 0.5, dur: 0.5 }, { degree: 4, start: 1, dur: 0.5 }, { degree: 5, start: 1.5, dur: 0.5 }]),
      // Bass/accords vides ⇒ normalizeMusicSpec déroule la progression par défaut
      // sur toutes les mesures (plusieurs accords, boucle pleine sur la durée).
      bass: normEvents(raw.bass, []).slice(0, 16),
      chords: (Array.isArray(raw.chords) && raw.chords.length ? raw.chords.map((c, i) => ({
        degrees: (Array.isArray(c.degrees) ? c.degrees : [0, 2, 4]).map((n) => Math.min(Math.max(parseInt(n, 10) || 0, 0), 7)).slice(0, 4),
        start: Math.max(Number(c.start) || i * 4, 0),
        dur: Math.min(Math.max(Number(c.dur) || 4, 0.5), 4),
        velocity: Math.min(Math.max(Number(c.velocity) || 0.28, 0.08), 0.7),
      })) : []).slice(0, 16),
      pattern: (Array.isArray(raw.pattern) ? raw.pattern : [0, 2, 4, 5, 4, 2, 1, 0])
        .map((n) => Math.min(Math.max(parseInt(n, 10) || 0, 0), 7))
        .slice(0, 24),
    },
    backend,
  };
}

// Analyse multimodale d'une image (description, direction artistique…). `imageB64`
// = base64 BRUT (sans préfixe data:). Local Ollama d'abord (modèle multimodal),
// cloud vision à défaut. Renvoie { content, backend }.
export async function generateVision(prompt, imageB64, context = "", opts = {}) {
  context = await canvasContext(prompt, context);
  const [{ content: sys }, { content: ask }] = PROMPTS["app.canvas.vision"].build({ prompt, context, lang: replyLang() }).messages;
  const choice = opts.backend && opts.backend !== "auto" ? opts.backend : pref("text");
  const source = explicitInferenceSource(choice);
  if (source) {
    if (source === 'applefm') throw new Error('Apple Foundation Models ne prend pas en charge la vision. Utilisez Ollama avec un modèle multimodal ou une API vision.');
    const result = await llmChat([{ role: 'system', content: sys }, { role: 'user', content: ask, images: [imageB64] }], { backend: backendForSource(source), model: opts.model, maxTokens: Math.min(8192, Math.max(1, Number(opts.maxTokens) || 1024)), stream: false });
    return { content: result.content || '', backend: source };
  }
  const p = ["local", "cloud"].includes(opts.backend) ? opts.backend : pref("text");
  if (p !== "cloud" && await localTextReady()) {
    try {
      const model = opts.model || localStorage.getItem("selectedModel") || "";
      const data = await ollamaPostJson("api/chat", { model, options: { num_predict: Math.min(8192, Math.max(1, Number(opts.maxTokens) || 1024)) }, messages: [{ role: "system", content: sys }, { role: "user", content: ask, images: [imageB64] }] });
      recordOllamaUsage(data, "canvas-vision");
      return { content: data?.message?.content || "", backend: "local" };
    } catch (e) { if (p === "local" || !(await cloudReady())) throw e; }
  }
  if (p !== "local" && await cloudReady()) {
    const model = opts.model || localStorage.getItem("apiModel") || "gpt-4o-mini";
    const body = { model, max_tokens: Math.min(8192, Math.max(1, Number(opts.maxTokens) || 1024)), messages: [
      { role: "system", content: sys },
      { role: "user", content: [{ type: "text", text: ask }, { type: "image_url", image_url: { url: `data:image/png;base64,${imageB64}` } }] },
    ] };
    const data = await invoke("llm_api_request", { path: "chat/completions", body, ...(opts.backend === "cloud" ? { backend: "api" } : {}) });
    const u = data?.usage || {};
    recordOllamaUsage({ prompt_eval_count: u.prompt_tokens, eval_count: u.completion_tokens }, "canvas-vision-cloud");
    return { content: data?.choices?.[0]?.message?.content || "", backend: "cloud" };
  }
  throw new Error(p === "local"
    ? "Backend vision local indisponible (modèle multimodal local)."
    : p === "cloud"
      ? "Backend vision cloud indisponible (clé/API non configurée)."
      : "Aucun backend vision disponible (modèle multimodal local ou cloud).");
}

// Rédaction du TEXTE d'un visuel/mockup (accroche, sous-titre, CTA) à partir du
// brief et du contexte (charte parente). Sortie JSON ; le rendu graphique se fait
// côté canvas avec la palette/typo de la charte.
export async function generateMockup(prompt, context = "") {
  context = await canvasContext(prompt, context);
  const { content, backend } = await textDispatch(PROMPTS["app.canvas.mockup"].build({ prompt, context, lang: replyLang() }).messages, true);
  const raw = safeParseJson(content) || {};
  const clip = (s, n) => String(s || "").slice(0, n);
  const benefits = (Array.isArray(raw.benefits) ? raw.benefits : []).map((b) => clip(b, 42)).filter(Boolean).slice(0, 2);
  return {
    copy: {
      eyebrow: clip(raw.eyebrow, 34),
      title: clip(raw.title || prompt, 72),
      subtitle: clip(raw.subtitle, 150),
      benefits,
      cta: clip(raw.cta, 32),
      footer: clip(raw.footer, 60),
    },
    backend,
  };
}

// Construit le payload commun de la commande Bonsai pour un provider donné.
function imagePayload(provider, { prompt, width, height, steps, seed = null }) {
  // Le canevas impose le moteur : on demande donc la config de CE moteur, pas
  // celle des réglages (qui peut en désigner un autre).
  // `backend` (identifiant Bonsai complet) et `apiModel` viennent tous deux de
  // la config du moteur : le canevas n'a plus sa propre notion de modèle.
  const cfg = imageGenerationConfig(provider);
  const n = Number(seed);
  return { prompt, width, height, seed: Number.isFinite(n) && seed !== null && seed !== "" ? Math.abs(Math.round(n)) % 4294967295 : null, steps, ...cfg };
}

function bonsaiPrompt(prompt, context = "") {
  const clean = (s) => String(s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\bnegative prompt\s*:.*/gi, " ")
    .replace(/\bno\s+negative\s+prompt\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const ctx = clean(context);
  const ask = clean(prompt);
  const parts = [];
  if (ask) parts.push(ask);
  if (ctx) parts.push(`Visual context: ${ctx.slice(0, 420)}`);
  parts.push("Natural-language prompt, clear subject, composition, lighting, material details, background, camera framing, coherent style, high quality.");
  return parts.join(". ").slice(0, 900);
}

// `opts` : { prompt, width, height, steps, sandboxId, path, context }
// `context` (texte du parent) enrichit le prompt image.
// Renvoie { url, sandboxId, path, backend }.
export async function generateImage(opts = {}) {
  if (!invoke) throw new Error("Génération d'image disponible uniquement dans l'app Lumen.");
  const { sandboxId, path } = opts;
  const memoryContext = await canvasContext(opts.prompt || "", opts.context || "");

  const run = async (provider) => {
    const fullPrompt = provider === "bonsai"
      ? bonsaiPrompt(opts.prompt, memoryContext)
      : (memoryContext ? `${memoryContext}\n\n${opts.prompt}` : opts.prompt);
    const base = { prompt: fullPrompt, width: opts.width || 512, height: opts.height || 512, steps: opts.steps || 4, seed: opts.seed ?? null };
    const payload = imagePayload(provider, base);
    if (opts.model) {
      if (provider === "bonsai") payload.backend = `bonsai-${opts.model}${localStorage.getItem("canvasBonsaiKind") ? `-${localStorage.getItem("canvasBonsaiKind")}` : ""}`;
      else payload.apiModel = opts.model;
    }
    // Le moteur renvoie un statut HTTP et son propre jargon : on traduit ici,
    // une fois, pour que tous les appelants du canevas affichent la même
    // phrase actionnable.
    try {
      if (sandboxId) {
        const res = await invoke("bonsai_generate_to_sandbox_url", { id: sandboxId, path, ...payload });
        return { url: res.data_url, sandboxId: res.sandbox_id, path: res.path };
      }
      return { url: await invoke("bonsai_generate_data_url", payload), sandboxId: null, path: null };
    } catch (e) { throw new Error(imageErrorMessage(e, provider)); }
  };

  // Le moteur est celui choisi dans la barre du canevas : pas de repli
  // silencieux sur un autre, dont les modèles et les résolutions diffèrent.
  const provider = IMAGE_PREFS.has(opts.provider) ? opts.provider : pref("image");
  if (!(await providerReady(provider))) {
    throw new Error(provider === "bonsai"
      ? "Moteur image Bonsai indisponible (API arrêtée)."
      : provider === "ollama"
        ? "Moteur image Ollama indisponible (serveur injoignable)."
        : "Moteur image GPT indisponible (clé/API non configurée).");
  }
  const r = { ...(await run(provider)), backend: provider === "openai" ? "cloud" : "local", provider };
  recordImageGeneration(1, `canvas-${provider}`);
  return r;
}
