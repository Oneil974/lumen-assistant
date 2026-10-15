// Sons du centre de notifications — petites signatures sonores générées en
// WebAudio (aucun asset audio à charger). Chaque TYPE de notification
// (heartbeat, calendrier, fluxo, messagerie) est associé à un son configurable
// dans Paramètres → Notifications (clé localStorage `notifSounds`, JSON
// { type: soundId }). `soundId` "none" = silencieux.

// `icon` : nom du jeu Lucide partagé (lib/icons.js). Les listes de
// notifications s'en servent au lieu d'un emoji ou d'une pastille muette.
export const NOTIF_TYPES = [
  { id: "heartbeat", label: "Heartbeat", icon: "heartbeat" },
  { id: "calendar", label: "Calendrier", icon: "calendar" },
  { id: "fluxo", label: "Fluxo", icon: "fluxo" },
  { id: "messages", label: "Messagerie", icon: "mail" },
];

export const NOTIF_SOUNDS = [
  { id: "none", label: "Aucun" },
  { id: "ding", label: "Ding" },
  { id: "cristal", label: "Cristal" },
  { id: "carillon", label: "Carillon" },
  { id: "goutte", label: "Goutte" },
  { id: "pulse", label: "Impulsion" },
];

const DEFAULTS = { heartbeat: "pulse", calendar: "carillon", fluxo: "ding", messages: "cristal" };

// Couleur des NOTIFICATIONS LUMINEUSES jouées par le Lumen Controller sur son
// bandeau WS2812B (clé localStorage `notifLedColor`). C'est une décoration
// choisie par l'utilisateur : elle n'écrase pas les couleurs d'ÉTAT du
// firmware (écoute, réflexion…), qui sont une sémantique. Le firmware fait
// clignoter cette couleur quelques secondes à l'arrivée d'une notification.
export const NOTIF_LED_COLOR_DEFAULT = "#ff9f0a";

export function notifLedColor() {
  const v = localStorage.getItem("notifLedColor") || "";
  return /^#[0-9a-f]{6}$/i.test(v) ? v : NOTIF_LED_COLOR_DEFAULT;
}

export function saveNotifLedColor(color) {
  if (/^#[0-9a-f]{6}$/i.test(String(color || ""))) localStorage.setItem("notifLedColor", String(color).toLowerCase());
}

export function notifSoundPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem("notifSounds") || "{}");
    return { ...DEFAULTS, ...(v && typeof v === "object" ? v : {}) };
  } catch { return { ...DEFAULTS }; }
}

export function saveNotifSoundPrefs(prefs) {
  localStorage.setItem("notifSounds", JSON.stringify(prefs || {}));
}

/// Déduit le type d'une entrée du centre de notifications (payload
/// `heartbeat-result`) : rappels du Calendrier ("⏰ …"), bloc Fluxo
/// (`source: "fluxo"`), sinon Heartbeat.
export function notifTypeFor(payload) {
  if (!payload) return "heartbeat";
  if (payload.source === "fluxo") return "fluxo";
  if (String(payload.shortcut || "").startsWith("⏰")) return "calendar";
  return "heartbeat";
}

let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Une note : sinus/triangle avec enveloppe exponentielle courte.
function tone(ac, dest, { f = 880, at = 0, dur = 0.28, gain = 0.16, type = "sine" }) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = f;
  const t0 = ac.currentTime + at;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

const RECIPES = {
  ding: (ac, out) => { tone(ac, out, { f: 1318.5, dur: 0.4, gain: 0.14 }); tone(ac, out, { f: 2637, dur: 0.3, gain: 0.05 }); },
  cristal: (ac, out) => { tone(ac, out, { f: 1567.98, dur: 0.22, gain: 0.1, type: "triangle" }); tone(ac, out, { f: 2093, at: 0.09, dur: 0.32, gain: 0.09, type: "triangle" }); },
  carillon: (ac, out) => { tone(ac, out, { f: 783.99, dur: 0.3, gain: 0.11 }); tone(ac, out, { f: 987.77, at: 0.12, dur: 0.3, gain: 0.1 }); tone(ac, out, { f: 1174.66, at: 0.24, dur: 0.42, gain: 0.09 }); },
  goutte: (ac, out) => {
    const osc = ac.createOscillator(); const g = ac.createGain();
    const t0 = ac.currentTime;
    osc.type = "sine"; osc.frequency.setValueAtTime(1400, t0);
    osc.frequency.exponentialRampToValueAtTime(520, t0 + 0.16);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    osc.connect(g).connect(out); osc.start(t0); osc.stop(t0 + 0.3);
  },
  pulse: (ac, out) => { tone(ac, out, { f: 523.25, dur: 0.12, gain: 0.12, type: "triangle" }); tone(ac, out, { f: 523.25, at: 0.16, dur: 0.2, gain: 0.1, type: "triangle" }); },
};

/// Joue le son `soundId` (id de NOTIF_SOUNDS). Silencieux si "none"/inconnu.
export function playSound(soundId) {
  const recipe = RECIPES[soundId];
  if (!recipe) return;
  const ac = ctx();
  if (!ac) return;
  try { recipe(ac, ac.destination); } catch {}
}

/// Joue le son configuré pour un TYPE de notification.
export function playNotifSound(type) {
  playSound(notifSoundPrefs()[type] || "none");
}
