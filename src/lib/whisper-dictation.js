// Dictée vocale locale via Whisper (ONNX quantifié, transformers.js) — option
// multi-OS activable dans les Réglages. Le moteur et les poids ne sont PAS
// inclus dans le build : téléchargés au clic (cf. transformers-loader.js) puis
// mis en cache pour un usage hors-ligne.
//
// Capture micro portable : PCM brut via ScriptProcessorNode (WebKitGTK n'a pas
// toujours MediaRecorder), rééchantillonné en 16 kHz mono — le format attendu
// par Whisper. La transcription tourne entièrement dans la WebView (WASM).
//
// Clés localStorage :
//   whisperDictation = "1"  → la dictée Whisper est active (sinon dictée native)
//   whisperModel             → id Hugging Face du modèle (défaut whisper-base)

import { loadTransformers } from "./transformers-loader.js";
import { dropWhisperHallucination } from "./whisper-filter.js";
export { dropWhisperHallucination };

// `sizeBytes` : ordre de grandeur du téléchargement (poids ONNX quantifié), utilisé
// pour afficher la taille et vérifier la place disque avant de lancer.
export const WHISPER_MODELS = [
  { id: "Xenova/whisper-tiny", label: "Whisper tiny", sizeLabel: "≈ 40 Mo", sizeBytes: 42_000_000, hint: "fast" },
  { id: "Xenova/whisper-base", label: "Whisper base", sizeLabel: "≈ 80 Mo", sizeBytes: 84_000_000, hint: "balanced" },
  { id: "Xenova/whisper-small", label: "Whisper small", sizeLabel: "≈ 250 Mo", sizeBytes: 262_000_000, hint: "powerful" },
];
const DEFAULT_MODEL = "Xenova/whisper-base";

// ---- Moteur : un WORKER dédié (cf. lib/whisper-worker.js) ------------------
//
// Le backend ONNX WASM est synchrone : exécuté sur le thread principal, il
// gèle la fenêtre le temps de la transcription. Invisible sur un Mac rapide,
// très visible sous Windows. Tout passe donc par un worker — sur toutes les
// plateformes, parce que le gel n'était pas propre à Windows, seulement plus
// long. Repli sur le thread principal si le worker ne démarre pas (WebView
// ancienne, module bloqué) : mieux vaut une dictée qui rame qu'une dictée qui
// n'existe pas.
let worker = null;
let workerBroken = false;
let seq = 0;
const pending = new Map();

function ensureWorker() {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
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
      // Le worker est mort : on rend la main à tous les appels en attente et on
      // repasse définitivement en repli pour cette session.
      workerBroken = true;
      for (const [, job] of pending) job.reject(new Error("Worker Whisper indisponible"));
      pending.clear();
      try { worker.terminate(); } catch {}
      worker = null;
    };
  } catch { workerBroken = true; worker = null; }
  return worker;
}

function callWorker(type, payload, onProgress) {
  const w = ensureWorker();
  if (!w) return null;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, type, payload });
  });
}

// Traduit la progression brute de transformers.js en (fichier, pourcentage),
// contrat déjà utilisé par les appelants (Réglages, bouton micro).
function progressAdapter(onProgress) {
  let lastPct = -1;
  return (p) => {
    if (!onProgress || p?.status !== "progress" || !p.total) return;
    const pct = Math.round((p.loaded / p.total) * 100);
    if (pct !== lastPct) { lastPct = pct; onProgress(p.file || "", pct); }
  };
}

// Repli : pipeline exécuté dans la page (comportement historique).
let asrPromise = null;
let asrModelId = "";

function whisperLanguage() {
  const lang = (localStorage.getItem("whisperLanguage") || localStorage.getItem("lang") || navigator.language || "fr").toLowerCase();
  if (lang.startsWith("en")) return "english";
  return "french";
}

// Hors macOS il n'y a pas de dictée native : Whisper est le backend par défaut
// tant que l'utilisateur n'a rien choisi (l'onboarding pose la clé, mais un
// profil qui l'a sauté ne doit pas retomber sur le repli Fluxo côté Rust).
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");
export function whisperEnabled() {
  const v = localStorage.getItem("whisperDictation");
  if (v === null) return !IS_MAC;
  return v === "1";
}
export function whisperModelId() {
  return localStorage.getItem("whisperModel") || DEFAULT_MODEL;
}

// ---- Moteur natif : whisper.cpp (whisper-server, src-tauri/src/whisper.rs) ----
// Métal / tous les cœurs : bien plus rapide que le WASM, et des modèles plus
// gros (large-v3-turbo) deviennent utilisables. Repli automatique sur
// transformers.js si le binaire ou un modèle manque, ou hors de Lumen (XR,
// page web). `whisperEngine` = "auto" (défaut) | "native" | "js".
const tauriInvoke = () => {
  try { return (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke || null; } catch { return null; }
};
let nativeCache = { at: 0, ok: false };
export async function whisperNativeStatus() {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try { return await invoke("whisper_native_status"); } catch { return null; }
}
async function nativeReady() {
  if (localStorage.getItem("whisperEngine") === "js") return false;
  if (Date.now() - nativeCache.at < 30_000) return nativeCache.ok;
  const st = await whisperNativeStatus();
  nativeCache = { at: Date.now(), ok: !!st?.ready };
  return nativeCache.ok;
}
export function whisperNativeInvalidate() { nativeCache.at = 0; }
const nativeModel = () => localStorage.getItem("whisperNativeModel") || "";

// Float32 16 kHz mono → WAV PCM 16 bits → base64 (ce que lit whisper-server).
function wavBase64(pcm) {
  const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/// Charge (ou récupère) le pipeline ASR. Premier appel : téléchargement des
/// poids (progression via onProgress) ; ensuite servi depuis le cache.
export async function whisperLoad(onProgress, modelId) {
  if (!modelId && await nativeReady()) {
    try { await tauriInvoke()("whisper_warmup", { model: nativeModel() || null }); return null; }
    catch (e) { console.warn("[whisper] natif indisponible, repli JS :", e); nativeCache = { at: Date.now(), ok: false }; }
  }
  const id = modelId || whisperModelId();
  const viaWorker = callWorker("load", { modelId: id }, progressAdapter(onProgress));
  if (viaWorker) { await viaWorker; return null; }
  if (asrPromise && asrModelId === id) return asrPromise;
  asrModelId = id;
  asrPromise = (async () => {
    const mod = await loadTransformers();
    let lastPct = -1;
    return mod.pipeline("automatic-speech-recognition", id, {
      dtype: "q8",
      progress_callback: (p) => {
        if (p.status === "progress" && p.total && onProgress) {
          const pct = Math.round((p.loaded / p.total) * 100);
          if (pct !== lastPct) { lastPct = pct; onProgress(p.file || "", pct); }
        }
      },
    });
  })().catch((e) => { asrPromise = null; throw e; });
  return asrPromise;
}

// Rééchantillonnage linéaire vers 16 kHz (le contexte audio impose souvent 44,1/48 kHz).
function resampleTo16k(data, rate) {
  if (rate === 16000) return data;
  const ratio = rate / 16000;
  const n = Math.floor(data.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), frac = x - i0;
    const a = data[i0], b = data[Math.min(i0 + 1, data.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/// Enregistre le micro en PCM mono et renvoie du 16 kHz.
///
/// Fin de parole DÉTECTÉE : l'enregistrement s'arrête tout seul après
/// `silenceMs` (2 s par défaut) de silence suivant de la parole — plus besoin
/// de deviner combien de temps parler. Sans parole du tout, on abandonne au
/// bout de `noSpeechMs` ; `maxSeconds` borne l'ensemble. Le seuil de silence
/// suit le bruit de fond mesuré au début, pour ne pas confondre un ventilateur
/// avec une voix. `signal` (AbortSignal) arrête à la demande — clic sur le
/// micro — et transcrit ce qui a été capté.
///
/// `onAnalyser(analyser)` livre un AnalyserNode branché sur le micro dès que le
/// flux est ouvert : l'UI peut y lire le spectre à sa propre cadence (rAF) pour
/// un spectromètre, sans peser sur la capture. `onLevel(niveau, parle,
/// finImminente)` : le 3e argument (0→1) mesure la pause en cours après de la
/// parole — à 1 l'enregistrement s'arrête — pour annoncer la fin à l'écran.
async function recordPcm({ maxSeconds = 60, silenceMs = 2000, noSpeechMs = 8000, signal, onLevel, onAnalyser, onSnapshot, snapshotMs = 1400 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    let analyser = null;
    if (onAnalyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 128;             // 64 bandes : assez pour une barre de 24 px
      analyser.smoothingTimeConstant = 0.55;
      src.connect(analyser);
      onAnalyser(analyser);
    }
    const chunks = [];
    let done;
    const finished = new Promise((r) => { done = r; });
    const t0 = performance.now();
    let noise = 0.004, noiseSamples = 0;
    let spoke = false, lastSpeech = 0, lastSnap = 0;
    proc.onaudioprocess = (e) => {
      const buf = new Float32Array(e.inputBuffer.getChannelData(0));
      chunks.push(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      // Plancher de bruit : les 400 premières ms, puis lissage lent hors parole.
      if (now - t0 < 400) { noise = (noise * noiseSamples + rms) / (++noiseSamples); }
      const threshold = Math.max(0.012, noise * 3);
      const speaking = rms > threshold;
      if (speaking) { spoke = true; lastSpeech = now; }
      else if (!spoke) noise = noise * 0.98 + rms * 0.02;
      const ending = spoke && !speaking ? Math.min(1, (now - lastSpeech) / silenceMs) : 0;
      onLevel?.(Math.min(1, rms / (threshold * 4)), speaking, ending);
      // Instantané de ce qui a été dit jusqu'ici (transcription en direct).
      if (onSnapshot && spoke && now - lastSnap >= snapshotMs) {
        lastSnap = now;
        const n = chunks.reduce((t, c) => t + c.length, 0);
        const all = new Float32Array(n); let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        try { onSnapshot(resampleTo16k(all, ctx.sampleRate)); } catch { /* best-effort */ }
      }
      if (spoke && now - lastSpeech >= silenceMs) done();
      else if (!spoke && now - t0 >= noSpeechMs) done();
      else if (now - t0 >= maxSeconds * 1000) done();
    };
    src.connect(proc);
    proc.connect(ctx.destination); // requis par certains WebKit pour démarrer le flux
    const onAbort = () => done();
    signal?.addEventListener("abort", onAbort, { once: true });
    await finished;
    signal?.removeEventListener("abort", onAbort);
    proc.disconnect();
    analyser?.disconnect();
    src.disconnect();
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    if (!spoke) return new Float32Array(0);
    return resampleTo16k(pcm, ctx.sampleRate);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  }
}

/// Transcrit un tampon 16 kHz mono (exposé pour les tests et réutilisations).
/// Les marqueurs non-parole de Whisper ([BLANK_AUDIO], [Musique], (toux)…)
/// sont retirés : un silence renvoie une chaîne vide, pas un artefact.
export async function whisperTranscribe(audio16k, onProgress, opts = {}) {
  let text = "";
  if (!opts.forceJs && audio16k?.length && await nativeReady()) {
    try {
      const lang = whisperLanguage() === "english" ? "en" : "fr";
      text = await tauriInvoke()("whisper_transcribe", { wavB64: wavBase64(audio16k), lang, model: nativeModel() || null });
      return dropWhisperHallucination(String(text || "").replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim());
    } catch (e) {
      console.warn("[whisper] transcription native en échec, repli JS :", e);
      nativeCache = { at: Date.now(), ok: false };
    }
  }
  // Le tampon est cloné vers le worker (pas transféré) : quelques mégaoctets
  // par dictée, et le Float32Array reste utilisable côté appelant — les tests
  // et le vu-mètre s'en servent encore après l'envoi.
  const viaWorker = callWorker(
    "transcribe",
    { modelId: opts.modelId || whisperModelId(), language: whisperLanguage(), audio: audio16k },
    progressAdapter(onProgress),
  );
  if (viaWorker) {
    text = (await viaWorker)?.text || "";
  } else {
    const asr = await whisperLoad(onProgress, opts.modelId);
    const out = await asr(audio16k, { task: "transcribe", language: whisperLanguage() });
    text = String(out?.text || "");
  }
  return dropWhisperHallucination(text.replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim());
}


/// Dictée complète : écoute jusqu'à 2 s de silence après la parole (ou
/// `seconds` au maximum), puis transcrit. `onState(phase)` reçoit "loading"
/// (téléchargement/chargement du modèle), "recording" puis "transcribing"
/// pour piloter l'UI ; `onLevel(niveau, parle)` anime un vu-mètre ; `signal`
/// arrête l'écoute à la demande.
/// `onAnalyser` : cf. recordPcm (spectromètre).
export async function whisperDictate({ seconds = 60, silenceMs = 2000, onState, onProgress, onLevel, onAnalyser, onPartial, signal } = {}) {
  onState?.("loading");
  await whisperLoad(onProgress); // avant d'ouvrir le micro : pas d'attente au vol
  onState?.("recording");
  // Transcription en direct : seulement avec whisper.cpp (assez rapide pour
  // retranscrire le début de phrase toutes les ~1,4 s sans prendre de retard).
  let partialBusy = false;
  const live = onPartial && await nativeReady();
  const onSnapshot = live ? (pcm) => {
    if (partialBusy) return;
    partialBusy = true;
    whisperTranscribe(pcm).then((t) => { if (t) onPartial(t); }).catch(() => {}).finally(() => { partialBusy = false; });
  } : undefined;
  const audio = await recordPcm({ maxSeconds: seconds, silenceMs, signal, onLevel, onAnalyser, onSnapshot });
  if (!audio.length) { onState?.("idle"); return ""; }
  onState?.("transcribing");
  return whisperTranscribe(audio);
}


/// Surveille le micro pendant que Lumen parle : appelle `onSpeech()` dès que
/// l'utilisateur prend la parole (≥ `holdMs` au-dessus du bruit de fond),
/// pour couper la voix de Lumen. L'annulation d'écho du navigateur évite que
/// la propre voix de Lumen déclenche l'interruption ; le seuil est relevé
/// pour la même raison. Renvoie une fonction d'arrêt.
export async function watchBargeIn({ onSpeech, holdMs = 280, signal } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch { return () => {}; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const t0 = performance.now();
  let noise = 0.01, n = 0, above = 0, fired = false;
  proc.onaudioprocess = (e) => {
    if (fired) return;
    const buf = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    if (now - t0 < 500) { noise = (noise * n + rms) / (++n); return; }
    const threshold = Math.max(0.03, noise * 4);
    const dt = (buf.length / ctx.sampleRate) * 1000;
    above = rms > threshold ? above + dt : Math.max(0, above - dt * 0.5);
    if (above >= holdMs) { fired = true; try { onSpeech?.(); } catch {} }
  };
  src.connect(proc); proc.connect(ctx.destination);
  const stop = () => {
    try { proc.disconnect(); src.disconnect(); } catch {}
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}

/// Découpe une réponse en phrases pour une lecture enchaînée (la première est
/// dite pendant que les suivantes se synthétisent).
export function speechChunks(text, max = 220) {
  const parts = String(text || "").replace(/\s+/g, " ").match(/[^.!?…;:]+[.!?…;:]+["»”)]*|[^.!?…;:]+$/g) || [];
  const out = [];
  let cur = "";
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if ((cur + " " + p).trim().length <= max && cur.length < 60) cur = (cur + " " + p).trim();
    else { if (cur) out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}
