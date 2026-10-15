// Modèle d'un projet de montage (v2) — pistes façon CapCut.
//
//   { v: 2, id, title, aspect, quality, fps,
//     bg:       { mode: "black"|"color"|"blur", color },
//     clips:    piste PRINCIPALE, magnétique : les clips s'enchaînent ;
//               { id, kind: "video"|"image"|"color", src, in, out, dur, speed,
//                 volume, mute, fit, fadeIn, fadeOut, motion, color,
//                 transform, filter, transition: { type, dur } | null }
//               `transition` = passage VERS le clip suivant (chevauchement).
//     overlays: incrustations libres (image dans l'image) ;
//               { id, kind, src, start, in, out, dur, speed, volume, mute,
//                 lane, transform, filter, fadeIn, fadeOut, motion }
//     texts:    textes, légendes, sous-titres, stickers ;
//               { id, kind: "text"|"caption"|"sticker", start, end, lane, text,
//                 font, weight, size, color, stroke, strokeColor, bg, shadow,
//                 align, upper, x, y, maxW, anim: { in, out, dur } }
//     audio:    musique, voix off, effets ;
//               { id, kind: "music"|"voice"|"sfx", src, start, in, out, lane,
//                 volume, fadeIn, fadeOut, speed }
//     markers:  [secondes] — repères (rythme, points de coupe) }
//
// Tout ce qui calcule un temps passe par ici : l'aperçu, la timeline, l'export
// et l'assistant IA voient exactement le même montage.

export const ASPECTS = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:5": [4, 5], "4:3": [4, 3], "21:9": [21, 9] };

export const uid = (p = "c") => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const DEFAULT_TRANSFORM = () => ({ x: 0, y: 0, scale: 1, rotate: 0, flipH: false, flipV: false, opacity: 1 });
export const DEFAULT_FILTER = () => ({ preset: "none", brightness: 0, contrast: 0, saturation: 0, temperature: 0, hue: 0, blur: 0, vignette: 0 });

export function blankProject(title = "Mon montage") {
  return { v: 2, id: uid("p"), title, aspect: "16:9", quality: 1080, fps: 30, bg: { mode: "black", color: "#101014" }, clips: [], overlays: [], texts: [], audio: [], markers: [] };
}

function normClip(c, main) {
  const o = { ...c };
  o.id ||= uid();
  o.kind ||= "video";
  o.speed = clamp(Number(o.speed) || 1, 0.1, 8);
  o.volume = o.volume ?? 1;
  o.mute = !!o.mute;
  o.fit ||= main ? "cover" : "contain";
  o.fadeIn = Number(o.fadeIn) || 0;
  o.fadeOut = Number(o.fadeOut) || 0;
  o.in = Number(o.in) || 0;
  o.out = Number(o.out) || 0;
  o.dur = Number(o.dur) || (o.kind === "video" ? 0 : 4);
  // v1 : `zoom: true` = Ken Burns.
  if (o.motion == null) o.motion = o.zoom ? "in" : "none";
  delete o.zoom;
  o.transform = { ...DEFAULT_TRANSFORM(), ...(o.transform || {}) };
  o.filter = { ...DEFAULT_FILTER(), ...(o.filter || {}) };
  if (main) o.transition = o.transition && o.transition.type && o.transition.type !== "none" ? { type: o.transition.type, dur: clamp(Number(o.transition.dur) || 0.5, 0.1, 3) } : null;
  else { o.start = Math.max(0, Number(o.start) || 0); o.lane = o.lane | 0; }
  return o;
}

const V1_POS = { top: 0.12, center: 0.5, bottom: 0.84 };

function normText(x) {
  const o = { ...x };
  o.id ||= uid("t");
  o.kind ||= "text";
  o.start = Math.max(0, Number(o.start) || 0);
  o.end = Math.max(o.start + 0.2, Number(o.end) || o.start + 3);
  o.lane = o.lane | 0;
  o.text = String(o.text ?? "");
  o.font ||= "sans";
  o.weight ||= 700;
  o.size = Number(o.size) || 64;
  o.color ||= "#ffffff";
  o.stroke = Number(o.stroke) || 0;
  o.strokeColor ||= "#000000";
  o.bg ??= "transparent";
  o.shadow ??= o.bg === "transparent";
  o.align ||= "center";
  o.upper = !!o.upper;
  if (o.y == null) o.y = V1_POS[o.pos] ?? 0.84;
  delete o.pos;
  o.x ??= 0.5;
  o.maxW ??= 0.86;
  o.anim = { in: "fade", out: "fade", dur: 0.3, ...(o.anim || {}) };
  return o;
}

function normAudio(m) {
  const o = { ...m };
  o.id ||= uid("a");
  o.kind ||= "music";
  o.start = Math.max(0, Number(o.start) || 0);
  o.in = Math.max(0, Number(o.in) || 0);
  o.out = Math.max(o.in + 0.1, Number(o.out) || o.in + 1);
  o.lane = o.lane | 0;
  o.volume = o.volume ?? (o.kind === "music" ? 0.6 : 1);
  o.fadeIn = Number(o.fadeIn) || 0;
  o.fadeOut = Number(o.fadeOut) || 0;
  o.speed = clamp(Number(o.speed) || 1, 0.25, 4);
  return o;
}

/** Projet v1 (clips/texts/music) ou v2 → v2 normalisé. */
export function migrate(P) {
  if (!P || typeof P !== "object") return blankProject();
  const base = blankProject(P.title || "Mon montage");
  const out = {
    ...base,
    id: P.id || base.id,
    title: P.title || base.title,
    aspect: ASPECTS[P.aspect] ? P.aspect : "16:9",
    quality: Number(P.quality) || 1080,
    fps: [24, 25, 30, 60].includes(Number(P.fps)) ? Number(P.fps) : 30,
    bg: { ...base.bg, ...(P.bg || {}) },
    clips: (P.clips || []).map((c) => normClip(c, true)),
    overlays: (P.overlays || []).map((c) => normClip(c, false)),
    texts: (P.texts || []).map(normText),
    audio: (P.audio || P.music || []).map(normAudio),
    markers: (P.markers || []).filter(Number.isFinite).sort((a, b) => a - b),
  };
  return out;
}

export const newClip = (c) => normClip(c, true);
export const newOverlay = (c) => normClip(c, false);
export const newText = normText;
export const newAudio = normAudio;

// ---- Durées ---------------------------------------------------------------
/** Durée à l'écran d'un clip (vitesse comprise). */
export const clipLen = (c) => (c.kind === "video" ? Math.max(0.05, (c.out - c.in) / (c.speed || 1)) : Math.max(0.1, c.dur || 0));
export const audioLen = (m) => Math.max(0.05, (m.out - m.in) / (m.speed || 1));

/** Durée effective de la transition du clip i vers i+1 (bornée par les deux clips). */
export function transDur(P, i) {
  const c = P.clips[i], n = P.clips[i + 1];
  if (!c?.transition || !n) return 0;
  return Math.min(c.transition.dur, clipLen(c) * 0.5, clipLen(n) * 0.5);
}

/** Début de chaque clip de la piste principale (les transitions chevauchent). */
export function clipStarts(P) {
  const out = [];
  let acc = 0;
  P.clips.forEach((c, i) => { out.push(acc); acc += clipLen(c) - transDur(P, i); });
  return out;
}

export function mainTotal(P) {
  if (!P.clips.length) return 0;
  const s = clipStarts(P);
  const i = P.clips.length - 1;
  return s[i] + clipLen(P.clips[i]);
}

/** Durée du montage : piste principale, incrustations, textes ; la musique ne
 *  prolonge pas une vidéo (sinon une fin noire), sauf montage sans image. */
export function total(P) {
  const v = mainTotal(P);
  const ov = P.overlays.reduce((a, o) => Math.max(a, o.start + clipLen(o)), 0);
  const tx = P.texts.reduce((a, x) => Math.max(a, x.end), 0);
  const au = P.audio.reduce((a, m) => Math.max(a, m.start + audioLen(m)), 0);
  const visual = Math.max(v, ov, tx);
  return visual || au;
}

/** Clips de la piste principale visibles à `t` (deux pendant une transition). */
export function mainAt(P, t) {
  const s = clipStarts(P);
  const hits = [];
  for (let i = 0; i < P.clips.length; i++) {
    const len = clipLen(P.clips[i]);
    if (t >= s[i] && t < s[i] + len) hits.push({ clip: P.clips[i], start: s[i], i, len });
  }
  return hits;
}

/** Clip principal « dominant » à `t` (le premier de la paire en transition). */
export function clipAt(P, t) {
  return mainAt(P, t)[0] || null;
}

export function findItem(P, id) {
  for (const [type, key] of [["clip", "clips"], ["overlay", "overlays"], ["text", "texts"], ["audio", "audio"]]) {
    const item = P[key].find((x) => x.id === id);
    if (item) return { type, key, item };
  }
  return null;
}

/** Début/fin à l'écran d'un élément, quel que soit son type. */
export function spanOf(P, id) {
  const f = findItem(P, id);
  if (!f) return null;
  if (f.type === "clip") { const i = P.clips.indexOf(f.item); const s = clipStarts(P)[i]; return { start: s, end: s + clipLen(f.item) }; }
  if (f.type === "overlay") return { start: f.item.start, end: f.item.start + clipLen(f.item) };
  if (f.type === "text") return { start: f.item.start, end: f.item.end };
  return { start: f.item.start, end: f.item.start + audioLen(f.item) };
}

/** Première piste libre de la catégorie à [start, end). */
export function freeLane(items, start, end, lenOf, skipId = null) {
  for (let lane = 0; lane < 12; lane++) {
    const busy = items.some((x) => x.id !== skipId && (x.lane | 0) === lane && x.start < end && x.start + lenOf(x) > start);
    if (!busy) return lane;
  }
  return 0;
}

// ---- Historique (annuler / rétablir) ---------------------------------------
export function createHistory(limit = 120) {
  const undo = [], redo = [];
  return {
    /** À appeler AVANT une modification, avec l'état courant. */
    push(P) { undo.push(JSON.stringify(P)); if (undo.length > limit) undo.shift(); redo.length = 0; },
    undo(P) { if (!undo.length) return null; redo.push(JSON.stringify(P)); return JSON.parse(undo.pop()); },
    redo(P) { if (!redo.length) return null; undo.push(JSON.stringify(P)); return JSON.parse(redo.pop()); },
    clear() { undo.length = 0; redo.length = 0; },
    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; },
  };
}

// ---- Description lisible (assistant IA, résumé) ---------------------------
const r2 = (v) => Math.round(v * 100) / 100;
export function describe(P) {
  const s = clipStarts(P);
  return {
    title: P.title, format: P.aspect, quality: `${P.quality}p`, fps: P.fps, duration: r2(total(P)),
    clips: P.clips.map((c, i) => ({ id: c.id, kind: c.kind, file: c.src?.name || (c.kind === "color" ? `couleur ${c.color}` : ""), start: r2(s[i]), duration: r2(clipLen(c)), in: r2(c.in), out: r2(c.out), speed: c.speed, volume: c.mute ? 0 : c.volume, filter: c.filter.preset, transition: c.transition ? `${c.transition.type} ${c.transition.dur}s` : "aucune", motion: c.motion })),
    overlays: P.overlays.map((o) => ({ id: o.id, file: o.src?.name, start: r2(o.start), duration: r2(clipLen(o)), lane: o.lane })),
    texts: P.texts.map((x) => ({ id: x.id, kind: x.kind, text: x.text.slice(0, 80), start: r2(x.start), end: r2(x.end), style: x.preset || "", anim: `${x.anim.in}/${x.anim.out}` })),
    audio: P.audio.map((m) => ({ id: m.id, kind: m.kind, file: m.src?.name, start: r2(m.start), duration: r2(audioLen(m)), volume: m.volume })),
    markers: P.markers.map(r2),
  };
}
