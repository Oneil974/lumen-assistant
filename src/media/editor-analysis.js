// Analyse des médias du montage, entièrement locale : forme d'onde, silences,
// rythme (beats), segments de parole pour les sous-titres, vignettes.
//
// Les fichiers sont relus par le flux lumenmedia:// : le serveur rend au plus
// 4 Mo par réponse, d'où une lecture par plages successives (Range).

const MAX_BYTES = 450 * 1024 * 1024;
const bytesCache = new Map();
const bufferCache = new Map();
const peaksCache = new Map();
const stripCache = new Map();

/** Fichier entier, par plages de 4 Mo (le flux média refuse les gros blocs). */
export async function fetchBytes(url, onProgress) {
  if (bytesCache.has(url)) return bytesCache.get(url);
  if (url.startsWith("blob:") || url.startsWith("data:")) {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    bytesCache.set(url, buf);
    return buf;
  }
  const parts = [];
  let start = 0, size = Infinity;
  while (start < size) {
    const r = await fetch(url, { headers: { Range: `bytes=${start}-${start + 4 * 1024 * 1024 - 1}` } });
    if (r.status === 403) throw new Error("session verrouillée");
    if (!r.ok) throw new Error(`lecture impossible (${r.status})`);
    const chunk = new Uint8Array(await r.arrayBuffer());
    const cr = r.headers.get("content-range");
    if (cr) size = Number(cr.split("/")[1]) || start + chunk.length;
    else size = chunk.length; // réponse complète (200)
    if (size > MAX_BYTES) throw new Error("fichier trop volumineux pour l'analyse (> 450 Mo)");
    parts.push(chunk);
    start += chunk.length;
    onProgress?.(Math.min(1, start / size));
    if (!chunk.length) break;
  }
  const out = new Uint8Array(start);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  bytesCache.set(url, out);
  return out;
}

let ac = null;
const ctx = () => (ac ||= new (window.AudioContext || window.webkitAudioContext)());

/** AudioBuffer d'un fichier audio ou vidéo (piste son). */
export async function decodeAudio(url, onProgress) {
  if (bufferCache.has(url)) return bufferCache.get(url);
  const bytes = await fetchBytes(url, onProgress);
  const buf = await ctx().decodeAudioData(bytes.slice().buffer);
  bufferCache.set(url, buf);
  return buf;
}

/** Amplitude crête par tranche (perSec tranches par seconde), 0..1. */
export function peaksOf(buffer, perSec = 50) {
  const key = buffer;
  if (peaksCache.has(key)) return peaksCache.get(key);
  const n = Math.ceil(buffer.duration * perSec);
  const out = new Float32Array(n);
  const step = buffer.sampleRate / perSec;
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step), b = Math.min(chans[0].length, Math.floor((i + 1) * step));
    let m = 0;
    for (const ch of chans) for (let j = a; j < b; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
    out[i] = m;
  }
  const res = { perSec, data: out };
  peaksCache.set(key, res);
  return res;
}

/** Peaks d'une URL (décodage compris) ; null si le fichier n'a pas de son. */
export async function peaksForUrl(url) {
  try { return peaksOf(await decodeAudio(url)); } catch { return null; }
}

/** Chemin SVG d'une forme d'onde sur [from, to] secondes, largeur w, hauteur h. */
export function waveformPath(peaks, from, to, w, h) {
  if (!peaks || w < 2) return "";
  const { perSec, data } = peaks;
  const cols = Math.max(2, Math.min(600, Math.floor(w / 2)));
  let d = `M0 ${h}`;
  for (let i = 0; i < cols; i++) {
    const t0 = from + ((to - from) * i) / cols, t1 = from + ((to - from) * (i + 1)) / cols;
    let m = 0;
    for (let k = Math.floor(t0 * perSec); k < Math.ceil(t1 * perSec) && k < data.length; k++) m = Math.max(m, data[k] || 0);
    const y = h - Math.min(1, m * 1.4) * h * 0.92;
    d += ` L${((i + 0.5) * w) / cols} ${y.toFixed(1)}`;
  }
  return `${d} L${w} ${h} Z`;
}

/** Seuil automatique : entre le bruit de fond et le niveau de parole. */
function autoThreshold(data) {
  const sorted = Array.from(data).filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0.02;
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 0.1;
  return Math.max(0.012, floor + (loud - floor) * 0.18);
}

/**
 * Plages silencieuses dans [from, to] (secondes du fichier).
 * @returns {{start:number,end:number}[]}
 */
export function detectSilences(peaks, from, to, { minDur = 0.6, pad = 0.12, threshold } = {}) {
  const { perSec, data } = peaks;
  const a = Math.floor(from * perSec), b = Math.min(data.length, Math.ceil(to * perSec));
  const th = threshold ?? autoThreshold(data.subarray(a, b));
  const out = [];
  let s = -1;
  for (let i = a; i <= b; i++) {
    const quiet = i < b && data[i] < th;
    if (quiet && s < 0) s = i;
    else if (!quiet && s >= 0) {
      const st = s / perSec, en = i / perSec;
      if (en - st >= minDur) out.push({ start: st + pad, end: en - pad });
      s = -1;
    }
  }
  return out.filter((r) => r.end - r.start > 0.15);
}

/** Segments de parole ≤ maxDur s, coupés dans les creux (pour Whisper). */
export function speechSegments(peaks, from, to, { maxDur = 9, minDur = 0.5 } = {}) {
  const sil = detectSilences(peaks, from, to, { minDur: 0.35, pad: 0 });
  const voiced = [];
  let cur = from;
  for (const s of sil) { if (s.start - cur >= minDur) voiced.push({ start: cur, end: s.start }); cur = s.end; }
  if (to - cur >= minDur) voiced.push({ start: cur, end: to });
  // Découpe des longs passages : au point le plus calme de la fenêtre.
  const { perSec, data } = peaks;
  const out = [];
  for (const v of voiced) {
    let s = v.start;
    while (v.end - s > maxDur) {
      const lo = Math.floor((s + maxDur * 0.55) * perSec), hi = Math.floor((s + maxDur) * perSec);
      let best = hi, bv = Infinity;
      for (let k = lo; k < hi && k < data.length; k++) if (data[k] < bv) { bv = data[k]; best = k; }
      const cut = best / perSec;
      out.push({ start: s, end: cut });
      s = cut;
    }
    out.push({ start: s, end: v.end });
  }
  return out;
}

/**
 * Temps des attaques rythmiques (beats) et tempo estimé.
 * Flux d'énergie basse fréquence, seuil adaptatif, écart mini 0,25 s.
 */
export function detectBeats(buffer, { from = 0, to = buffer.duration } = {}) {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const hop = Math.floor(sr / 100); // 10 ms
  const a = Math.floor(from * sr), b = Math.min(ch.length, Math.floor(to * sr));
  const energy = [];
  let lp = 0;
  for (let i = a; i < b; i += hop) {
    let e = 0;
    for (let j = i; j < Math.min(b, i + hop); j++) { lp += 0.08 * (ch[j] - lp); e += lp * lp; } // passe-bas grossier
    energy.push(e);
  }
  const flux = energy.map((e, i) => Math.max(0, e - (energy[i - 1] || 0)));
  const beats = [];
  const win = 50; // 0,5 s
  let last = -1e9;
  for (let i = 1; i < flux.length - 1; i++) {
    const lo = Math.max(0, i - win), hi = Math.min(flux.length, i + win);
    let mean = 0; for (let k = lo; k < hi; k++) mean += flux[k]; mean /= hi - lo;
    const t = from + (i * hop) / sr;
    if (flux[i] > mean * 1.8 && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && t - last >= 0.25) { beats.push(t); last = t; }
  }
  // Tempo : intervalle médian.
  const iv = beats.slice(1).map((t, i) => t - beats[i]).filter((d) => d > 0.25 && d < 1.5).sort((x, y) => x - y);
  const med = iv[Math.floor(iv.length / 2)] || 0.5;
  return { beats, bpm: Math.round(60 / med), interval: med };
}

/** Extrait [from, to] en mono 16 kHz (format Whisper). */
export async function pcm16k(buffer, from, to) {
  const len = Math.max(1, Math.ceil((to - from) * 16000));
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start(0, Math.max(0, from), Math.max(0.05, to - from));
  const out = await off.startRendering();
  return out.getChannelData(0);
}

/** Bande de vignettes d'une vidéo (n images côte à côte), en data: URL. */
export async function filmstrip(url, duration, n = 8, h = 48) {
  const key = `${url}|${n}|${h}`;
  if (stripCache.has(key)) return stripCache.get(key);
  const p = new Promise((resolve) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous"; v.muted = true; v.preload = "auto"; v.playsInline = true; v.src = url;
    const c = document.createElement("canvas");
    const g = c.getContext("2d");
    let i = 0;
    const fail = () => resolve("");
    const next = () => {
      if (i >= n) { try { resolve(c.toDataURL("image/jpeg", 0.6)); } catch { resolve(""); } v.removeAttribute("src"); v.load(); return; }
      v.currentTime = Math.min(Math.max(0, duration - 0.05), ((i + 0.5) * duration) / n);
    };
    v.addEventListener("loadeddata", () => {
      const w = Math.round((h * (v.videoWidth || 16)) / (v.videoHeight || 9));
      c.width = w * n; c.height = h;
      next();
    }, { once: true });
    v.addEventListener("seeked", () => {
      const w = c.width / n;
      try { g.drawImage(v, i * w, 0, w, h); } catch {}
      i++; next();
    });
    v.addEventListener("error", fail, { once: true });
    setTimeout(fail, 20000);
  });
  stripCache.set(key, p);
  return p;
}
