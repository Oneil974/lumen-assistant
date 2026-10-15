// Mini moteur musical local pour les blocs Jingle.
// Format interne compatible avec l'esprit NoteSequence, rendu via WebAudio.

let activeCtx = null;
let activeTimers = [];

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

const ROOTS = { C: 60, Db: 61, D: 62, Eb: 63, E: 64, F: 65, Gb: 66, G: 67, Ab: 68, A: 69, Bb: 70, B: 71 };

// Progression d'accords par défaut (degrés de gamme) : I – vi – IV – V, jouée
// un accord par mesure et bouclée. Donne « plusieurs accords » même sans spec LLM.
const DEFAULT_PROGRESSION = [[0, 2, 4], [5, 0, 2], [3, 5, 0], [4, 6, 1]];

function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function clamp(n, min, max) {
  return Math.min(Math.max(Number(n) || min, min), max);
}

// Estime la durée parlée (en secondes) d'un jingle à partir de son texte.
// Sert à dimensionner la musique sur la longueur de la voix off : ~2.5 mots/s
// en lecture posée façon voix off FR, plus une petite respiration en fin.
export function estimateJingleSeconds(text = "") {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 6;
  const WORDS_PER_SEC = 2.5;
  return clamp(words / WORDS_PER_SEC + 0.8, 3, 30);
}

// Nombre de mesures (4/4) couvrant ~`seconds` à `tempo` BPM.
export function barsForDuration(seconds, tempo) {
  const t = clamp(tempo || 112, 70, 150);
  return clamp(Math.round((clamp(seconds, 3, 30) * t) / 240), 2, 16);
}

function normEvent(e = {}, i = 0, fallbackDur = 0.5) {
  return {
    degree: clamp(parseInt(e.degree, 10) || 0, 0, 7),
    octave: clamp(parseInt(e.octave, 10) || 0, -3, 3),
    start: Math.max(Number(e.start) || i * fallbackDur, 0),
    dur: clamp(Number(e.dur) || fallbackDur, 0.125, 4),
    velocity: clamp(Number(e.velocity) || 0.7, 0.1, 1),
  };
}

export function normalizeMusicSpec(spec = {}, prompt = "") {
  const tempo = clamp(spec.tempo || 112, 70, 150);
  // Durée cible (s) : longueur approximative de la voix off du jingle. Quand elle
  // est connue, elle PRIME sur `bars` pour caler la musique sur le besoin réel.
  const durationSec = spec.durationSec ? clamp(spec.durationSec, 3, 30) : 0;
  const bars = durationSec ? barsForDuration(durationSec, tempo) : clamp(spec.bars || 4, 2, 16);
  const root = ROOTS[String(spec.key || "C").replace(/m$/, "")] ? String(spec.key || "C").replace(/m$/, "") : "C";
  const scale = SCALES[spec.scale] ? spec.scale : "major";
  const osc = ["sine", "triangle", "square", "sawtooth"].includes(spec.synth?.osc) ? spec.synth.osc : (
    spec.sound === "pad" ? "sine" : spec.sound === "bass" ? "sawtooth" : spec.sound === "bell" ? "triangle" : "square"
  );
  const mood = String(spec.mood || prompt || "brand jingle").slice(0, 80);
  const synthPrompt = String(spec.synthPrompt || spec.mood || prompt || "bright playable synth").slice(0, 120);
  // Prompt texte en langage naturel décrivant la musique (genre, instruments,
  // énergie, époque…). C'est l'entrée attendue par un moteur Text-to-Music type
  // Magenta RealTime ; on la conserve même quand le rendu local reste WebAudio.
  const musicPrompt = String(spec.musicPrompt || spec.synthPrompt || spec.mood || prompt || "warm uplifting brand jingle bed").slice(0, 200);
  // Instruments adaptés au brief, choisis par le modèle (descriptifs ; servent
  // l'affichage et un futur backend Text-to-Music qui les consommerait).
  const instruments = (Array.isArray(spec.instruments) ? spec.instruments : []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 4);
  const synth = {
    osc,
    filter: clamp(spec.synth?.filter || 1600, 180, 5000),
    attack: clamp(spec.synth?.attack || 0.015, 0.005, 0.5),
    release: clamp(spec.synth?.release || 0.28, 0.05, 2),
    drive: clamp(spec.synth?.drive || 0.12, 0, 1),
    delay: clamp(spec.synth?.delay || 0.08, 0, 0.45),
  };
  const pattern = Array.isArray(spec.pattern) && spec.pattern.length
    ? spec.pattern.map((n) => clamp(n, 0, SCALES[scale].length - 1)).slice(0, 32)
    : [0, 2, 4, 5, 4, 2, 1, 0, 3, 4, 5, 7, 5, 4, 2, 0];
  const melody = (Array.isArray(spec.melody) && spec.melody.length
    ? spec.melody
    : pattern.map((degree, i) => ({ degree, octave: i % 8 > 5 ? 1 : 0, start: i * 0.5, dur: 0.45, velocity: 0.78 }))
  ).map((e, i) => normEvent(e, i, 0.5)).slice(0, 36);
  // Basses et accords par défaut : un par mesure, déroulés sur toute la boucle
  // (suivent DEFAULT_PROGRESSION) → la musique reste pleine quelle que soit la durée.
  const bass = (Array.isArray(spec.bass) && spec.bass.length
    ? spec.bass
    : Array.from({ length: bars }, (_, i) => ({ degree: DEFAULT_PROGRESSION[i % DEFAULT_PROGRESSION.length][0], octave: -2, start: i * 4, dur: 3.5, velocity: 0.5 }))
  ).map((e, i) => normEvent(e, i, 1)).slice(0, 16);
  const chords = (Array.isArray(spec.chords) && spec.chords.length
    ? spec.chords
    : Array.from({ length: bars }, (_, i) => ({ degrees: DEFAULT_PROGRESSION[i % DEFAULT_PROGRESSION.length], start: i * 4, dur: 4, velocity: 0.26 }))
  ).map((c, i) => ({
    degrees: (Array.isArray(c.degrees) ? c.degrees : [0, 2, 4]).map((n) => clamp(parseInt(n, 10) || 0, 0, 7)).slice(0, 4),
    start: Math.max(Number(c.start) || i * 4, 0),
    dur: clamp(Number(c.dur) || 4, 0.5, 4),
    velocity: clamp(Number(c.velocity) || 0.26, 0.08, 0.7),
  })).slice(0, 16);
  return { tempo, bars, durationSec, key: root, scale, sound: "synth", mood, musicPrompt, instruments, synthPrompt, synth, pattern, melody, bass, chords };
}

export function toNoteSequence(spec) {
  const s = normalizeMusicSpec(spec);
  const beat = 60 / s.tempo;
  const notes = [];
  const pitchOf = (degree, octave = 0) => ROOTS[s.key] + SCALES[s.scale][degree % SCALES[s.scale].length] + octave * 12;
  const push = (pitch, start, dur, velocity, part) => notes.push({
    pitch,
    startTime: start * beat,
    endTime: (start + dur) * beat,
    velocity: Math.round((velocity || 0.7) * 100),
    part,
  });
  for (const n of s.melody) push(pitchOf(n.degree, n.octave), n.start, n.dur, n.velocity, "melody");
  for (const n of s.bass) push(pitchOf(n.degree, n.octave), n.start, n.dur, n.velocity, "bass");
  for (const c of s.chords) for (const d of c.degrees) push(pitchOf(d, -1), c.start, c.dur, c.velocity, "chord");
  const totalTime = Math.max(s.bars * 4 * beat, ...notes.map((n) => n.endTime), 2);
  return {
    ticksPerQuarter: 220,
    totalTime,
    tempos: [{ time: 0, qpm: s.tempo }],
    notes,
  };
}

function synthEnvelope(gain, now, dur, level, synth) {
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(level, now + (synth.attack || 0.018));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur + (synth.release || 0.2));
}

function playNote(ctx, pitch, start, dur, spec, part = "melody", volume = 0.12) {
  const synth = spec.synth || {};
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const delay = ctx.createDelay(0.6);
  const delayGain = ctx.createGain();
  const hz = midiToHz(pitch);
  osc.frequency.setValueAtTime(hz, start);
  osc.type = part === "bass" ? "sawtooth" : synth.osc || "square";
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(part === "bass" ? Math.min(synth.filter || 900, 700) : synth.filter || 1600, start);
  const level = part === "chord" ? volume * 0.42 : part === "bass" ? volume * 0.7 : volume;
  synthEnvelope(gain, start, dur, level * (1 + (synth.drive || 0) * 0.45), synth);
  delay.delayTime.setValueAtTime(synth.delay || 0.08, start);
  delayGain.gain.setValueAtTime(part === "melody" ? 0.18 : 0.08, start);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  gain.connect(delay);
  delay.connect(delayGain);
  delayGain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + (synth.release || 0.2) + 0.05);
}

function scheduleWebAudio(seq, spec, { voiceDelay = 0 } = {}) {
  stopMusic();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("WebAudio indisponible.");
  const ctx = new AudioCtx();
  activeCtx = ctx;
  const now = ctx.currentTime + 0.08 + voiceDelay;
  for (const n of seq.notes || []) {
    playNote(ctx, n.pitch, now + n.startTime, Math.max(0.08, n.endTime - n.startTime), spec, n.part);
  }
  const stopAt = (seq.totalTime || 4) * 1000 + voiceDelay * 1000 + 500;
  activeTimers.push(setTimeout(stopMusic, stopAt));
}

// Boucle la séquence en l'enchaînant tuile par tuile (chaque tuile = un cycle
// complet de `totalTime`). Ne s'arrête JAMAIS seule : elle tourne jusqu'à
// `stopMusic()` — ce qui permet de la couper pile à la fin de l'énonciation.
function scheduleWebAudioLoop(seq, spec, { voiceDelay = 0 } = {}) {
  stopMusic();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("WebAudio indisponible.");
  const ctx = new AudioCtx();
  activeCtx = ctx;
  const period = Math.max(seq.totalTime || 4, 1);
  const startBase = ctx.currentTime + 0.08 + voiceDelay;
  let iteration = 0;
  const scheduleTile = () => {
    if (activeCtx !== ctx) return; // coupé par stopMusic → on cesse de replanifier
    const tileStart = startBase + iteration * period;
    for (const n of seq.notes || []) {
      playNote(ctx, n.pitch, tileStart + n.startTime, Math.max(0.08, n.endTime - n.startTime), spec, n.part);
    }
    iteration += 1;
    // Replanifie la tuile suivante un peu avant la fin de l'actuelle (anti-trou).
    activeTimers.push(setTimeout(scheduleTile, Math.max(60, period * 1000 - 250)));
  };
  scheduleTile();
}

export async function playMusic(spec, options = {}) {
  const normalized = normalizeMusicSpec(spec);
  const seq = toNoteSequence(normalized);
  if (options.loop) {
    scheduleWebAudioLoop(seq, normalized, options);
    return { engine: "webaudio", sequence: seq, loop: true };
  }
  scheduleWebAudio(seq, normalized, options);
  return { engine: "webaudio", sequence: seq };
}

export function stopMusic() {
  for (const t of activeTimers) clearTimeout(t);
  activeTimers = [];
  if (activeCtx) {
    try { activeCtx.close(); } catch {}
    activeCtx = null;
  }
}
