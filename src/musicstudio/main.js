// Studio musical — moteur génératif 100 % local (Web Audio API). Aucun samples
// distant : tout est synthétisé (accords, basse, arpège, lead, batterie). Un
// séquenceur à lookahead boucle une progression ; l'IA (llmChat) traduit un
// prompt en « spec » musical. Export WAV via OfflineAudioContext.

import { translatePage, observeTranslations } from "../apps-i18n.js";
import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { recordOllamaUsage } from "../ollama-usage.js";

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};

const $ = (id) => document.getElementById(id);

// ===== Théorie =====
const ROOTS = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
const KEYS = Object.keys(ROOTS);
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  pentatonic: [0, 3, 5, 7, 10], // mineure pentatonique
};
const SCALE_LABELS = { major: "Majeure", minor: "Mineure", dorian: "Dorien", lydian: "Lydien", pentatonic: "Pentatonique" };

const LAYERS = [
  { id: "drums", label: "Batterie" }, { id: "bass", label: "Basse" },
  { id: "chords", label: "Accords" }, { id: "arp", label: "Arpège" }, { id: "lead", label: "Lead" },
];

// progression = degrés de gamme (0 = tonique) servant de fondamentale d'accord par mesure.
const PRESETS = {
  Lofi:        { tempo: 78,  scale: "dorian",     key: "F",  energy: 0.45, swing: 0.32, space: 0.5,
                 prog: [0, 3, 5, 4], drums: "lofi",  bass: "root",    osc: "triangle", cutoff: 1600,
                 layers: { drums: 1, bass: 1, chords: 1, arp: 0, lead: 0 } },
  Synthwave:   { tempo: 100, scale: "minor",      key: "A",  energy: 0.65, swing: 0,    space: 0.45,
                 prog: [0, 5, 2, 6], drums: "four",  bass: "drive",   osc: "sawtooth", cutoff: 2200,
                 layers: { drums: 1, bass: 1, chords: 1, arp: 1, lead: 1 } },
  Ambient:     { tempo: 62,  scale: "lydian",     key: "D",  energy: 0.25, swing: 0,    space: 0.8,
                 prog: [0, 4, 5, 3], drums: "none",  bass: "root",    osc: "sine",     cutoff: 1400,
                 layers: { drums: 0, bass: 1, chords: 1, arp: 0, lead: 1 } },
  Cinematic:   { tempo: 84,  scale: "minor",      key: "C",  energy: 0.5,  swing: 0,    space: 0.7,
                 prog: [0, 5, 3, 4], drums: "soft",  bass: "root",    osc: "sawtooth", cutoff: 1700,
                 layers: { drums: 1, bass: 1, chords: 1, arp: 0, lead: 1 } },
  Chiptune:    { tempo: 132, scale: "major",      key: "C",  energy: 0.75, swing: 0,    space: 0.2,
                 prog: [0, 4, 5, 3], drums: "four",  bass: "drive",   osc: "square",   cutoff: 3200,
                 layers: { drums: 1, bass: 1, chords: 1, arp: 1, lead: 1 } },
  House:       { tempo: 124, scale: "minor",      key: "G",  energy: 0.8,  swing: 0,    space: 0.4,
                 prog: [0, 2, 5, 4], drums: "house", bass: "offbeat", osc: "sawtooth", cutoff: 2400,
                 layers: { drums: 1, bass: 1, chords: 0, arp: 1, lead: 0 } },
};

const STEPS_PER_BAR = 16, LOOP_BARS = 4, TOTAL_STEPS = STEPS_PER_BAR * LOOP_BARS;

// ===== État =====
let spec = makeSpec("Synthwave");
let melody = [];
let presetName = "Synthwave";

function makeSpec(name) {
  const p = PRESETS[name];
  return {
    tempo: p.tempo, key: p.key, scale: p.scale, energy: p.energy, swing: p.swing, space: p.space,
    prog: p.prog.slice(), drums: p.drums, bass: p.bass, osc: p.osc, cutoff: p.cutoff,
    volume: 0.8, layers: { ...p.layers }, mood: name,
  };
}

// ===== PRNG + mélodie =====
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let rng = mulberry32(1234);

// Mélodie de lead : pour chaque mesure, quelques notes alignées sur l'accord +
// notes de passage de la gamme. Renvoie un tableau TOTAL_STEPS de {midi,dur}|null.
function generateMelody() {
  const out = new Array(TOTAL_STEPS).fill(null);
  const sc = SCALES[spec.scale];
  let cur = 0; // index dans la gamme
  for (let bar = 0; bar < LOOP_BARS; bar++) {
    const rootDeg = spec.prog[bar % spec.prog.length];
    const onsets = [0, 4, 8, 12].filter(() => rng() < 0.4 + spec.energy * 0.4);
    if (!onsets.length) onsets.push(rng() < 0.5 ? 0 : 8);
    for (const o of onsets) {
      // se rapproche d'une note d'accord, avec marche aléatoire
      const target = [rootDeg, rootDeg + 2, rootDeg + 4][Math.floor(rng() * 3)];
      cur += Math.sign(target - cur) * (rng() < 0.6 ? 1 : 0) || (rng() < 0.5 ? 1 : -1);
      cur = Math.max(-2, Math.min(sc.length + 4, cur));
      const midi = degreeToMidi(cur, 1);
      const dur = [2, 4, 4, 6][Math.floor(rng() * 4)];
      out[bar * STEPS_PER_BAR + o] = { midi, dur };
    }
  }
  return out;
}

// degré (peut dépasser l'octave) -> midi, octaveBase 0 ≈ C4..B4
function degreeToMidi(degree, octave = 0) {
  const sc = SCALES[spec.scale];
  const oct = Math.floor(degree / sc.length) + octave;
  const idx = ((degree % sc.length) + sc.length) % sc.length;
  return 60 + ROOTS[spec.key] + sc[idx] + oct * 12;
}
function chordMidis(rootDeg, octave = 0) {
  return [rootDeg, rootDeg + 2, rootDeg + 4].map((d) => degreeToMidi(d, octave));
}
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ===== Audio =====
let ctx = null, master = null, analyser = null, freqData = null;
let playing = false, schedTimer = null, step = 0, nextTime = 0;
let noiseBuf = null;

function ensureCtx() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  buildMaster();
  noiseBuf = makeNoise(ctx);
}
function buildMaster() {
  master = ctx.createGain();
  master.gain.value = spec.volume;
  const warm = ctx.createBiquadFilter(); warm.type = "lowpass"; warm.frequency.value = 16000;
  // « espace » : delay en feedback filtré
  const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.26;
  const fb = ctx.createGain(); fb.gain.value = 0.25 + spec.space * 0.2;
  const wet = ctx.createGain(); wet.gain.value = spec.space * 0.5;
  const fbFilter = ctx.createBiquadFilter(); fbFilter.type = "lowpass"; fbFilter.frequency.value = 2600;
  delay.connect(fbFilter); fbFilter.connect(fb); fb.connect(delay);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.18;
  analyser = ctx.createAnalyser(); analyser.fftSize = 256; freqData = new Uint8Array(analyser.frequencyBinCount);

  master.connect(warm);
  warm.connect(comp);
  warm.connect(delay); delay.connect(wet); wet.connect(comp);
  comp.connect(analyser); analyser.connect(ctx.destination);
  master._wet = wet; master._fb = fb;
}
function makeNoise(c) {
  const buf = c.createBuffer(1, c.sampleRate * 1, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// --- Voix ---
function synthNote(c, dest, t, freq, dur, { osc = "sawtooth", cutoff = 1800, gain = 0.2, attack = 0.01, release = 0.18, detune = 6 }) {
  const o1 = c.createOscillator(), o2 = c.createOscillator();
  const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cutoff; f.Q.value = 6;
  const g = c.createGain();
  o1.type = o2.type = osc; o1.frequency.value = o2.frequency.value = freq;
  o1.detune.value = -detune; o2.detune.value = detune;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
  o1.connect(f); o2.connect(f); f.connect(g); g.connect(dest);
  o1.start(t); o2.start(t); o1.stop(t + dur + release + 0.05); o2.stop(t + dur + release + 0.05);
}
function kick(c, dest, t) {
  const o = c.createOscillator(), g = c.createGain();
  o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
  g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.34);
}
function snare(c, dest, t) {
  const n = c.createBufferSource(); n.buffer = noiseBuf;
  const bp = c.createBiquadFilter(); bp.type = "highpass"; bp.frequency.value = 1400;
  const g = c.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  n.connect(bp); bp.connect(g); g.connect(dest); n.start(t); n.stop(t + 0.2);
}
function hat(c, dest, t, open) {
  const n = c.createBufferSource(); n.buffer = noiseBuf;
  const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7000;
  const g = c.createGain(); const d = open ? 0.18 : 0.05;
  g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  n.connect(hp); hp.connect(g); g.connect(dest); n.start(t); n.stop(t + d + 0.02);
}

// ===== Génération des évènements d'un pas =====
function stepEvents(absStep) {
  const local = ((absStep % TOTAL_STEPS) + TOTAL_STEPS) % TOTAL_STEPS;
  const inBar = local % STEPS_PER_BAR;
  const bar = Math.floor(local / STEPS_PER_BAR);
  const rootDeg = spec.prog[bar % spec.prog.length];
  const e = spec.energy, L = spec.layers, ev = [];

  // Accords / pad : au début de mesure (tenus), ou stabs offbeat selon énergie.
  if (L.chords && inBar === 0) {
    const dur = (60 / spec.tempo) * 3.6;
    for (const m of chordMidis(rootDeg, 0)) ev.push({ v: "synth", freq: midiToFreq(m), dur, g: 0.05, osc: spec.osc, cutoff: spec.cutoff * 0.8, attack: 0.04, release: 0.6 });
  }
  // Basse
  if (L.bass) {
    const bMidi = degreeToMidi(rootDeg, -2);
    const hit = spec.bass === "offbeat" ? (inBar % 4 === 2) : spec.bass === "drive" ? (inBar % 2 === 0) : (inBar % 4 === 0);
    if (hit) ev.push({ v: "synth", freq: midiToFreq(bMidi), dur: 0.22, g: 0.32, osc: "sawtooth", cutoff: 600, attack: 0.005, release: 0.1 });
  }
  // Arpège : monte/descend les notes de l'accord sur la grille
  if (L.arp) {
    const every = e > 0.6 ? 1 : 2;
    if (inBar % every === 0) {
      const notes = chordMidis(rootDeg, 1);
      const m = notes[(Math.floor(absStep / every)) % notes.length];
      ev.push({ v: "synth", freq: midiToFreq(m), dur: 0.16, g: 0.12, osc: spec.osc === "sine" ? "triangle" : spec.osc, cutoff: spec.cutoff, attack: 0.005, release: 0.12 });
    }
  }
  // Lead
  if (L.lead) {
    const note = melody[local];
    if (note) ev.push({ v: "synth", freq: midiToFreq(note.midi), dur: note.dur * (60 / spec.tempo) / 4, g: 0.16, osc: spec.osc === "square" ? "square" : "triangle", cutoff: spec.cutoff * 1.1, attack: 0.01, release: 0.2 });
  }
  // Batterie
  if (L.drums && spec.drums !== "none") {
    const ds = spec.drums;
    const kickOn = ds === "lofi" ? (inBar === 0 || inBar === 10) : ds === "soft" ? (inBar === 0 || inBar === 8) : (inBar % 4 === 0);
    if (kickOn) ev.push({ v: "kick" });
    if (ds !== "soft" && (inBar === 4 || inBar === 12)) ev.push({ v: "snare" });
    if (ds === "soft" && inBar === 8) ev.push({ v: "snare" });
    const hatEvery = e > 0.6 ? 1 : 2;
    if (ds !== "soft" && inBar % (hatEvery * 2) === 0) ev.push({ v: "hat", open: inBar % 8 === 4 && e > 0.5 });
  }
  return ev;
}

function fireEvents(c, dest, evs, t) {
  for (const x of evs) {
    if (x.v === "synth") synthNote(c, dest, t, x.freq, x.dur, { osc: x.osc, cutoff: x.cutoff, gain: x.g, attack: x.attack, release: x.release });
    else if (x.v === "kick") kick(c, dest, t);
    else if (x.v === "snare") snare(c, dest, t);
    else if (x.v === "hat") hat(c, dest, t, x.open);
  }
}

// ===== Séquenceur (lookahead) =====
function stepDur() { return (60 / spec.tempo) / 4; }
function scheduler() {
  const ahead = 0.12;
  while (nextTime < ctx.currentTime + ahead) {
    // swing : retarde les 16e impairs
    const sw = (step % 2 === 1) ? stepDur() * spec.swing * 0.5 : 0;
    fireEvents(ctx, master, stepEvents(step), nextTime + sw);
    nextTime += stepDur();
    step++;
  }
}
function play() {
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  if (playing) return;
  playing = true;
  step = 0; nextTime = ctx.currentTime + 0.06;
  schedTimer = setInterval(scheduler, 25);
  $("play").classList.add("on"); $("play").textContent = "■";
  drawViz();
}
function stop() {
  playing = false;
  clearInterval(schedTimer); schedTimer = null;
  $("play").classList.remove("on"); $("play").textContent = "▶";
}
function toggle() { playing ? stop() : play(); }

function applyLiveParams() {
  if (master) master.gain.setTargetAtTime(spec.volume, ctx.currentTime, 0.05);
}

// ===== Visualiseur =====
let vizRAF = null;
function drawViz() {
  const cv = $("viz"); const c = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const resize = () => { cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr; };
  resize();
  const loop = () => {
    if (!playing) { c.clearRect(0, 0, cv.width, cv.height); vizRAF = null; return; }
    analyser.getByteFrequencyData(freqData);
    const W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    const n = freqData.length, bw = W / n;
    const grad = c.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, "#7c5cff"); grad.addColorStop(1, "#19c3ff");
    c.fillStyle = grad; c.shadowColor = "#7c5cff"; c.shadowBlur = 18 * dpr;
    for (let i = 0; i < n; i++) {
      const v = freqData[i] / 255; const h = Math.pow(v, 1.4) * H * 0.92;
      const x = i * bw; const bh = Math.max(2 * dpr, h);
      c.fillRect(x + bw * 0.15, H - bh, bw * 0.7, bh);
    }
    vizRAF = requestAnimationFrame(loop);
  };
  if (!vizRAF) loop();
}

// ===== Rendu offline -> octets WAV (partagé export & sandbox) =====
async function renderWavBytes() {
  const bars = LOOP_BARS * 2, steps = bars * STEPS_PER_BAR;
  const sd = stepDur(), seconds = steps * sd + 1.2;
  const sr = 44100;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) throw new Error("rendu audio non supporté ici");
  const off = new OAC(2, Math.ceil(sr * seconds), sr);
  // chaîne master simplifiée pour l'offline
  const m = off.createGain(); m.gain.value = spec.volume;
  const comp = off.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3;
  const delay = off.createDelay(1.0); delay.delayTime.value = 0.26;
  const fb = off.createGain(); fb.gain.value = 0.25 + spec.space * 0.2;
  const wet = off.createGain(); wet.gain.value = spec.space * 0.5;
  const fbF = off.createBiquadFilter(); fbF.type = "lowpass"; fbF.frequency.value = 2600;
  delay.connect(fbF); fbF.connect(fb); fb.connect(delay);
  m.connect(comp); m.connect(delay); delay.connect(wet); wet.connect(comp); comp.connect(off.destination);
  const savedNoise = noiseBuf; noiseBuf = makeNoise(off);
  let t = 0.05;
  for (let s = 0; s < steps; s++) {
    const sw = (s % 2 === 1) ? sd * spec.swing * 0.5 : 0;
    fireEvents(off, m, stepEvents(s), t + sw);
    t += sd;
  }
  try {
    const buf = await off.startRendering();
    return new Uint8Array(encodeWav(buf));
  } finally { noiseBuf = savedNoise; }
}
function wavName() { return `${(spec.mood || "lumen").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.wav`; }
function bytesToBase64(u8) {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}

async function loadSandboxes() {
  const sel = $("sandbox");
  if (!sel) return;
  if (!invoke) {
    sel.disabled = true;
    sel.innerHTML = `<option value="">Hors Lumen</option>`;
    return;
  }
  try {
    const boxes = await invoke("sandbox_list");
    sel.innerHTML = `<option value="">Sandbox…</option>`;
    (Array.isArray(boxes) ? boxes : []).forEach((box) => {
      const opt = document.createElement("option");
      opt.value = box.id;
      opt.textContent = box.name || box.id;
      sel.appendChild(opt);
    });
    if (sel.options.length > 1) sel.selectedIndex = 1;
  } catch {
    sel.disabled = true;
    sel.innerHTML = `<option value="">Indisponible</option>`;
  }
}

async function exportWav() {
  toast("Rendu de l'audio…");
  try {
    const bytes = await renderWavBytes();
    const blob = new Blob([bytes], { type: "audio/wav" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = wavName(); a.click();
    URL.revokeObjectURL(a.href);
    toast("WAV exporté ✓");
  } catch (e) { toast("Échec de l'export : " + (e.message || e)); }
}

async function saveToSandbox() {
  if (!invoke) { toast("Sandbox indisponible (hors Lumen)."); return; }
  toast("Rendu + enregistrement…");
  try {
    const boxes = await invoke("sandbox_list");
    if (!boxes || !boxes.length) { toast("Aucune sandbox — crée-en une dans Fichiers."); return; }
    const selectedId = $("sandbox")?.value;
    const box = boxes.find((b) => b.id === selectedId) || boxes[0];
    const b64 = bytesToBase64(await renderWavBytes());
    const path = `musique/${wavName()}`;
    await invoke("sandbox_import_file", { id: box.id, path, dataB64: b64 });
    toast(`Enregistré dans « ${box.name || box.id} » → ${path}`);
  } catch (e) { toast("Échec : " + (e.message || e)); }
}
function encodeWav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + len * ch * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, len * ch * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(c)[i]));
      out.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
    }
  }
  return out.buffer;
}

// ===== IA : prompt -> spec =====
async function generateFromPrompt() {
  const prompt = $("prompt").value.trim();
  if (!prompt) { toast("Décris une ambiance d'abord."); return; }
  const btn = $("gen"); btn.disabled = true; btn.textContent = "🎛️ …";
  try {
    const { messages, opts } = PROMPTS["app.musicstudio.spec"].build({ prompt, keys: KEYS, lang: replyLang() });
    const { content, data } = await llmChat(messages, { ...opts, rawSystem: true });
    recordOllamaUsage(data, "music-studio");
    let o = {}; try { o = JSON.parse(content); } catch { const mm = content.match(/\{[\s\S]*\}/); if (mm) o = JSON.parse(mm[0]); }
    // base : preset reconnu, sinon le courant
    if (o.preset && PRESETS[o.preset]) { presetName = o.preset; spec = makeSpec(o.preset); markPreset(); }
    if (o.tempo) spec.tempo = clamp(+o.tempo, 60, 160);
    if (o.key && ROOTS[o.key] !== undefined) spec.key = o.key;
    if (o.scale && SCALES[o.scale]) spec.scale = o.scale;
    if (o.energy != null) spec.energy = clamp(+o.energy, 0, 1);
    if (o.layers && typeof o.layers === "object") for (const k in spec.layers) if (o.layers[k] != null) spec.layers[k] = o.layers[k] ? 1 : 0;
    if (o.mood) spec.mood = String(o.mood).slice(0, 40);
    rng = mulberry32(Math.floor(Math.random() * 1e9)); melody = generateMelody();
    syncUI(); applyLiveParams();
    if (!playing) play();
    toast("Morceau généré ✓");
  } catch (e) { toast("Échec : " + (e.message || e) + " — modèle sélectionné ?"); }
  finally { btn.disabled = false; btn.textContent = "✨ Générer"; }
}
const clamp = (n, a, b) => Math.min(Math.max(n, a), b);

// ===== UI =====
function buildPresets() {
  const host = $("presets"); host.innerHTML = "";
  Object.keys(PRESETS).forEach((name) => {
    const b = document.createElement("button");
    b.className = "chip" + (name === presetName ? " active" : "");
    b.textContent = name; b.dataset.name = name;
    b.addEventListener("click", () => {
      presetName = name; spec = makeSpec(name);
      rng = mulberry32(Math.floor(Math.random() * 1e9)); melody = generateMelody();
      markPreset(); syncUI(); applyLiveParams();
      if (!playing) play();
    });
    host.appendChild(b);
  });
}
function markPreset() { document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.name === presetName)); }
function buildLayers() {
  const host = $("layers"); host.innerHTML = "";
  LAYERS.forEach((l) => {
    const d = document.createElement("button");
    d.className = "layer" + (spec.layers[l.id] ? " on" : "");
    d.dataset.id = l.id; d.innerHTML = `<span class="led"></span>${l.label}`;
    d.addEventListener("click", () => { spec.layers[l.id] = spec.layers[l.id] ? 0 : 1; d.classList.toggle("on", !!spec.layers[l.id]); });
    host.appendChild(d);
  });
}
function buildSelects() {
  const ks = $("key"); ks.innerHTML = "";
  KEYS.forEach((k) => { const o = document.createElement("option"); o.value = k; o.textContent = k; ks.appendChild(o); });
  const ss = $("scale"); ss.innerHTML = "";
  Object.keys(SCALES).forEach((s) => { const o = document.createElement("option"); o.value = s; o.textContent = SCALE_LABELS[s]; ss.appendChild(o); });
}
function syncUI() {
  $("bpm").value = spec.tempo; $("bpm-val").textContent = spec.tempo;
  $("energy").value = Math.round(spec.energy * 100); $("energy-val").textContent = Math.round(spec.energy * 100) + "%";
  $("vol").value = Math.round(spec.volume * 100); $("vol-val").textContent = Math.round(spec.volume * 100) + "%";
  $("key").value = spec.key; $("scale").value = spec.scale;
  document.querySelectorAll(".layer").forEach((d) => d.classList.toggle("on", !!spec.layers[d.dataset.id]));
  $("mood").textContent = spec.mood;
  $("sub").textContent = `${spec.key} ${SCALE_LABELS[spec.scale]} · ${spec.tempo} BPM`;
}

// ===== Assistant IA (boîte de prompt partagée) =====
// Le studio se pilote au prompt : régler le morceau, changer d'ambiance,
// relancer une variation, lancer la lecture, exporter.
const MUSIC_TOOLS = [
  tool("describe_track", "État du morceau : préréglage, tonalité, gamme, tempo, énergie, couches actives.", {}),
  tool("apply_preset", "Applique un préréglage d'ambiance.", { preset: T.enum(Object.keys(PRESETS), "Préréglage") }, ["preset"]),
  tool("set_track", "Règle le morceau. Ne passe que ce que tu veux changer.",
    { tempo: T.int("BPM entre 60 et 160"), key: T.enum(KEYS, "Tonalité"), scale: T.enum(Object.keys(SCALES), "Gamme"),
      energy: T.num("Énergie de 0 à 1"), swing: T.num("Swing de 0 à 1"), space: T.num("Réverbération de 0 à 1"),
      layers: { type: "object", description: "Couches actives : { drums, bass, chords, arp, lead } à 0 ou 1" } }),
  tool("new_variation", "Tire une nouvelle variation mélodique sur les mêmes réglages.", {}),
  tool("play", "Lance ou arrête la lecture.", { on: T.bool("true = jouer, false = arrêter") }, ["on"]),
  tool("export_wav", "Exporte le morceau en WAV (téléchargement).", {}),
];

async function runMusicTool(name, a) {
  switch (name) {
    case "describe_track":
      return `Ambiance : ${presetName} · ${spec.key} ${SCALE_LABELS[spec.scale]} · ${spec.tempo} BPM · énergie ${Math.round(spec.energy * 100)} %`
        + ` · swing ${Math.round((spec.swing || 0) * 100)} % · espace ${Math.round((spec.space || 0) * 100)} %`
        + `\nCouches : ${Object.entries(spec.layers || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "aucune"}`;
    case "apply_preset": {
      const p = PRESETS[a.preset];
      if (!p) throw new Error("préréglage inconnu.");
      presetName = a.preset;
      spec = { ...spec, ...structuredClone(p) };
      melody = generateMelody();
      return `Ambiance « ${a.preset} » appliquée.`;
    }
    case "set_track": {
      const changed = [];
      if (a.tempo != null) { spec.tempo = Math.max(60, Math.min(160, Math.round(a.tempo))); changed.push("tempo"); }
      if (a.key && KEYS.includes(a.key)) { spec.key = a.key; changed.push("tonalité"); }
      if (a.scale && SCALES[a.scale]) { spec.scale = a.scale; changed.push("gamme"); }
      for (const k of ["energy", "swing", "space"]) {
        if (a[k] != null) { spec[k] = Math.max(0, Math.min(1, Number(a[k]))); changed.push(k); }
      }
      if (a.layers && typeof a.layers === "object") {
        spec.layers = { ...spec.layers, ...Object.fromEntries(Object.entries(a.layers).map(([k, v]) => [k, v ? 1 : 0])) };
        changed.push("couches");
      }
      if (!changed.length) throw new Error("aucun réglage fourni.");
      melody = generateMelody();
      return `Réglé : ${changed.join(", ")} — ${spec.key} ${SCALE_LABELS[spec.scale]} · ${spec.tempo} BPM.`;
    }
    case "new_variation": {
      rng = mulberry32(Math.floor(Math.random() * 1e9));
      melody = generateMelody();
      return "Nouvelle variation générée.";
    }
    case "play": {
      if (a.on) { if (!playing) play(); return "Lecture lancée."; }
      if (playing) stop();
      return "Lecture arrêtée.";
    }
    case "export_wav": { await exportWav(); return "Morceau exporté en WAV."; }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountMusicAI() {
  mountAiPrompt(null, {
    app: "Studio musical",
    intro: "Tu composes : ambiance, tonalité, tempo, énergie, instrumentation.",
    rules: "- Traduis une intention (« quelque chose de nostalgique pour lire ») en réglages concrets : preset le plus proche, puis set_track pour affiner.\n- Après un réglage, propose d'écouter (play) sans le déclencher toi-même sauf demande explicite.",
    placeholder: "Ex. : un lofi pluvieux, plus lent, sans lead…",
    suggestions: [
      { label: "Composer une ambiance", prompt: "Compose une ambiance pour travailler la nuit : choisis le préréglage et affine les réglages." },
      { label: "Plus calme", prompt: "Rends le morceau plus calme et plus spacieux." },
      { label: "Plus dansant", prompt: "Rends le morceau plus rythmé et énergique." },
      { label: "Variation", prompt: "Garde l'ambiance mais tire une nouvelle variation mélodique." },
    ],
    tools: MUSIC_TOOLS,
    context: () => `${presetName} · ${spec.key} ${SCALE_LABELS[spec.scale]} · ${spec.tempo} BPM · énergie ${Math.round(spec.energy * 100)} %`,
    execute: runMusicTool,
    onApplied: () => syncUI(),
  });
}

function init() {
  translatePage();
  observeTranslations();
  buildSelects(); buildPresets(); buildLayers();
  loadSandboxes();
  melody = generateMelody(); syncUI();
  mountMusicAI();
  $("play").addEventListener("click", toggle);
  $("regen").addEventListener("click", () => { rng = mulberry32(Math.floor(Math.random() * 1e9)); melody = generateMelody(); toast("Nouvelle variation 🎲"); });
  $("export").addEventListener("click", exportWav);
  $("save-sb").addEventListener("click", saveToSandbox);
  $("gen").addEventListener("click", generateFromPrompt);
  $("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter") generateFromPrompt(); });
  $("bpm").addEventListener("input", (e) => { spec.tempo = +e.target.value; $("bpm-val").textContent = spec.tempo; $("sub").textContent = `${spec.key} ${SCALE_LABELS[spec.scale]} · ${spec.tempo} BPM`; });
  $("energy").addEventListener("input", (e) => { spec.energy = +e.target.value / 100; $("energy-val").textContent = e.target.value + "%"; });
  $("vol").addEventListener("input", (e) => { spec.volume = +e.target.value / 100; $("vol-val").textContent = e.target.value + "%"; applyLiveParams(); });
  $("key").addEventListener("change", (e) => { spec.key = e.target.value; melody = generateMelody(); syncUI(); });
  $("scale").addEventListener("change", (e) => { spec.scale = e.target.value; melody = generateMelody(); syncUI(); });
  window.addEventListener("beforeunload", () => { try { stop(); ctx && ctx.close(); } catch {} });
}
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600); }
init();
