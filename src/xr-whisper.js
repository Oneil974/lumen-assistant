// Whisper DANS LE CASQUE (Lumen XR).
//
// Le navigateur du Quest n'expose pas la reconnaissance vocale web
// (SpeechRecognition) : sans ce module, toute la voix partait au Mac, qui
// faisait tourner Whisper À CÔTÉ du LLM. Ici, la transcription se fait dans le
// casque, dans un worker (lib/whisper-worker.js, le même moteur que le
// bureau) : transformers.js en WASM, modèle quantifié téléchargé une fois
// depuis Hugging Face puis gardé en cache par le navigateur.
//
// Échec (pas de réseau au premier usage, mémoire, worker refusé) : l'appelant
// renvoie l'audio au Mac comme avant — l'utilisateur n'a jamais à répéter.

import { cleanTranscript } from "/lib/whisper-filter.js";

export const HEADSET_MODELS = [
  { id: "Xenova/whisper-tiny", label: "tiny", size: "≈ 40 Mo" },
  { id: "Xenova/whisper-base", label: "base", size: "≈ 80 Mo" },
];

let worker = null;
let broken = false;
let seq = 0;
const pending = new Map();
let loadedModel = "";

function ensureWorker() {
  if (worker || broken) return worker;
  try {
    worker = new Worker("/lib/whisper-worker.js", { type: "module" });
    worker.onmessage = (ev) => {
      const { id, type, payload } = ev.data || {};
      const job = pending.get(id);
      if (!job) return;
      if (type === "progress") { job.onProgress?.(payload); return; }
      pending.delete(id);
      if (type === "error") job.reject(new Error(payload));
      else job.resolve(payload);
    };
    worker.onerror = () => {
      broken = true;
      for (const [, job] of pending) job.reject(new Error("worker Whisper indisponible"));
      pending.clear();
      try { worker.terminate(); } catch {}
      worker = null;
    };
  } catch { broken = true; worker = null; }
  return worker;
}

function call(type, payload, onProgress) {
  const w = ensureWorker();
  if (!w) return Promise.reject(new Error("worker Whisper indisponible"));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, type, payload });
  });
}

/** Le casque peut-il faire tourner Whisper ? (workers modules + WASM + Cache API) */
export function headsetWhisperSupported() {
  return typeof Worker !== "undefined" && typeof WebAssembly !== "undefined" && !broken;
}

/** Progression lisible du téléchargement : pourcentage global des fichiers lourds. */
function progressReporter(onProgress) {
  const files = new Map();
  let last = -1;
  return (p) => {
    if (!onProgress || p?.status !== "progress" || !p.total) return;
    files.set(p.file, { loaded: p.loaded, total: p.total });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    const pct = Math.round((loaded / total) * 100);
    if (pct !== last) { last = pct; onProgress(pct); }
  };
}

/** Charge le modèle à l'avance (au choix du réglage) : la première dictée n'attend pas. */
export async function preloadHeadsetWhisper(modelId, onProgress) {
  await call("load", { modelId }, progressReporter(onProgress));
  loadedModel = modelId;
}

export function headsetWhisperReady(modelId) { return loadedModel === modelId; }

/**
 * Transcrit un PCM mono 16 kHz (Float32Array) dans le casque.
 * @returns {Promise<string>} texte nettoyé (marqueurs et phrases inventées retirés)
 */
export async function transcribeInHeadset(pcm, { modelId, lang = "fr", onProgress } = {}) {
  const out = await call("transcribe", { modelId, language: lang === "en" ? "english" : "french", audio: pcm }, progressReporter(onProgress));
  loadedModel = modelId;
  return cleanTranscript(out?.text || "");
}
