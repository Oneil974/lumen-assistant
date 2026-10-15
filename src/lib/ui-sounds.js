// Sons d'interface de Lumen — petits bruitages générés en WebAudio (aucun
// fichier à charger, rien qui sorte de la machine). Ils donnent du corps aux
// gestes : la capsule qui s'ouvre, une étape d'agent qui se termine, l'orbe
// qu'on tapote. Distincts des sons du centre de notifications
// (lib/notif-sounds.js), qui signalent une ARRIVÉE et se règlent par type.
//
// Réglage unique : `uiSounds` (localStorage, "false" = muet) et `uiSoundsVolume`
// (0–100). Chaque son est court (< 400 ms) et doux : on doit pouvoir les
// entendre cent fois par jour sans s'en lasser.

let ctx = null;
const last = new Map(); // anti-rafale : un même son au plus toutes les 70 ms

function audio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { return null; }
  return ctx;
}

export function uiSoundsEnabled() {
  try { return localStorage.getItem("uiSounds") !== "false"; } catch { return true; }
}
function volume() {
  let v = 60;
  try { v = parseInt(localStorage.getItem("uiSoundsVolume") || "60", 10); } catch { /* défaut */ }
  return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 60)) / 100 * 0.22;
}

// Une note : oscillateur + enveloppe, avec glissando facultatif.
function tone(a, { f = 660, f2, type = "sine", at = 0, dur = 0.12, gain = 1, attack = 0.006 }) {
  const t0 = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  const peak = volume() * gain;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

// Souffle filtré (glissé de la capsule).
function noise(a, { at = 0, dur = 0.18, from = 900, to = 2600, gain = 0.5 }) {
  const t0 = a.currentTime + at;
  const len = Math.ceil(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(from, t0);
  bp.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(volume() * gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp).connect(g).connect(a.destination);
  src.start(t0);
}

const SOUNDS = {
  // Capsule qui s'ouvre / se replie / jette un œil hors de l'encoche.
  open: (a) => { noise(a, { dur: 0.16, from: 700, to: 2400, gain: 0.35 }); tone(a, { f: 520, f2: 780, dur: 0.12, gain: 0.5 }); },
  close: (a) => { noise(a, { dur: 0.14, from: 2200, to: 600, gain: 0.3 }); tone(a, { f: 700, f2: 460, dur: 0.1, gain: 0.4 }); },
  peek: (a) => tone(a, { f: 880, f2: 1180, dur: 0.07, gain: 0.35 }),
  // Étape d'agent terminée (discret : il y en a beaucoup).
  tick: (a) => tone(a, { f: 1320, dur: 0.05, type: "triangle", gain: 0.35 }),
  // Tâche finie : petit arpège montant.
  success: (a) => { tone(a, { f: 660, dur: 0.12 }); tone(a, { f: 880, at: 0.07, dur: 0.12 }); tone(a, { f: 1320, at: 0.14, dur: 0.22, gain: 0.8 }); },
  // Échec : deux notes qui descendent, sans dramatiser.
  error: (a) => { tone(a, { f: 440, dur: 0.14, type: "triangle" }); tone(a, { f: 330, at: 0.11, dur: 0.2, type: "triangle" }); },
  // Lumen a besoin de toi : question montante.
  ask: (a) => { tone(a, { f: 600, dur: 0.1 }); tone(a, { f: 900, f2: 1000, at: 0.09, dur: 0.16 }); },
  // Envoi d'un message.
  send: (a) => tone(a, { f: 500, f2: 900, dur: 0.09, gain: 0.5 }),
  // Orbe : « squish » au clic, tournis, joie, endormissement, réveil.
  squish: (a) => { tone(a, { f: 260, f2: 140, dur: 0.11, type: "sine", gain: 0.9 }); tone(a, { f: 520, f2: 380, at: 0.02, dur: 0.06, gain: 0.3 }); },
  dizzy: (a) => { for (let i = 0; i < 4; i++) tone(a, { f: 700 - i * 60, f2: 900 - i * 60, at: i * 0.07, dur: 0.07, gain: 0.45 }); },
  joy: (a) => { tone(a, { f: 784, dur: 0.09 }); tone(a, { f: 1046, at: 0.08, dur: 0.16 }); },
  sleep: (a) => tone(a, { f: 330, f2: 220, dur: 0.35, gain: 0.35 }),
  wake: (a) => tone(a, { f: 330, f2: 660, dur: 0.16, gain: 0.45 }),
  drop: (a) => { tone(a, { f: 900, f2: 300, dur: 0.12, gain: 0.5 }); tone(a, { f: 600, at: 0.1, dur: 0.08, gain: 0.4 }); },
};

export const UI_SOUND_NAMES = Object.keys(SOUNDS);

// Échantillons facultatifs (packs CC0 de Kenney : Interface Sounds / UI Audio),
// déclarés dans sounds/ui/manifest.json : { "open": "fichier.ogg", … }. Un son
// absent du manifeste — ou un manifeste absent — retombe sur la synthèse.
const BASE = new URL("../sounds/ui/", import.meta.url);
let manifest = null;
const buffers = new Map();
function loadManifest() {
  if (!manifest) {
    manifest = fetch(new URL("manifest.json", BASE)).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  }
  return manifest;
}
async function sample(a, name) {
  if (buffers.has(name)) return buffers.get(name);
  const file = (await loadManifest())[name];
  let buf = null;
  if (file) {
    try { buf = await a.decodeAudioData(await (await fetch(new URL(file, BASE))).arrayBuffer()); } catch { buf = null; }
  }
  buffers.set(name, buf);
  return buf;
}
function playBuffer(a, buf) {
  const src = a.createBufferSource();
  src.buffer = buf;
  const g = a.createGain();
  g.gain.value = volume() * 3.2;
  src.connect(g).connect(a.destination);
  src.start();
}

/** Joue un son d'interface (silencieux si désactivé ou sans WebAudio). */
export function playUi(name, { force = false } = {}) {
  if (!force && !uiSoundsEnabled()) return;
  const fn = SOUNDS[name];
  if (!fn) return;
  const now = performance.now();
  if (now - (last.get(name) || 0) < 70) return;
  last.set(name, now);
  const a = audio();
  if (!a) return;
  if (a.state === "suspended") a.resume().catch(() => {});
  const cached = buffers.get(name);
  if (cached) { try { playBuffer(a, cached); } catch { /* contexte fermé */ } return; }
  if (cached === null) { try { fn(a); } catch { /* contexte fermé */ } return; }
  // Premier appel : on tente l'échantillon, la synthèse sert de repli.
  sample(a, name).then((buf) => {
    try { if (buf) playBuffer(a, buf); else fn(a); } catch { /* contexte fermé */ }
  });
}
