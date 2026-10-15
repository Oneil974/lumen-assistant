// Avatars des agents Lumen — personnages « Shape Characters » de Kenney (CC0).
//
// Un agent porte un objet `avatar` : { color, shape, face, hand, hand2, anim }
// (`hand` = main gauche, `hand2` = main droite, la même par défaut). Chaque
// champ est une CLÉ de catalogue ci-dessous, jamais une URL : le rendu (et donc
// l'emplacement des images) reste l'affaire de ce module. Toute surface qui
// affiche un agent — app Agents, assistant de création, cartes de délégation du
// chat, menu « @ », consultation — passe par `agentAvatarHTML()`.
//
// Un agent sans avatar (créé avant ce système) en reçoit un DÉTERMINISTE, tiré
// de son id : il garde la même tête d'une session à l'autre sans rien écrire.
//
// Animation : tout est en CSS (respiration, clignement, mains flottantes). L'état
// se pilote par `setAvatarState(el, "work" | "done" | "fail" | "idle")` : le
// visage et les mains changent, la cadence s'accélère pendant le travail.
//
// Les images vivent dans `lib/avatars/kenney/` ; le packager d'apps joint ce
// dossier dès que ce module entre dans un paquet (scripts/package-apps.mjs).

const BASE = new URL("./avatars/kenney/", import.meta.url).href;

export const AVATAR_COLORS = [
  { key: "blue", label: "Bleu", hex: "#6f8ff0", emoji: ":large_blue_circle:" },
  { key: "purple", label: "Violet", hex: "#8e5be0", emoji: ":large_purple_circle:" },
  { key: "pink", label: "Rose", hex: "#f27fbf", emoji: ":cherry_blossom:" },
  { key: "red", label: "Rouge", hex: "#e0545f", emoji: ":red_circle:" },
  { key: "yellow", label: "Jaune", hex: "#f5b12d", emoji: ":large_yellow_circle:" },
  { key: "green", label: "Vert", hex: "#5cbf6e", emoji: ":large_green_circle:" },
];

export const AVATAR_SHAPES = [
  { key: "squircle", label: "Galet" },
  { key: "circle", label: "Rond" },
  { key: "square", label: "Carré" },
  { key: "rhombus", label: "Losange" },
];

// Largeur/hauteur natives (dossier « Double ») : les visages n'ont pas tous le
// même gabarit, les poser à l'échelle du corps garde les proportions du pack.
const FACE_DIMS = {
  a: [100, 58], b: [100, 48], c: [118, 60], d: [106, 66], e: [110, 80], f: [110, 66],
  g: [110, 64], h: [110, 72], i: [118, 84], j: [100, 78], k: [110, 80], l: [106, 74],
};

// `j` (yeux en croix) est réservé à l'état « échec » : on ne le propose pas.
export const AVATAR_FACES = [
  { key: "a", label: "Enjoué" },
  { key: "l", label: "Ravi" },
  { key: "c", label: "Malicieux" },
  { key: "b", label: "Serein" },
  { key: "f", label: "Déterminé" },
  { key: "d", label: "Narquois" },
  { key: "e", label: "Sceptique" },
  { key: "h", label: "Blasé" },
  { key: "g", label: "Grincheux" },
  { key: "i", label: "Inquiet" },
  { key: "k", label: "Pensif" },
];

const HAND_DIMS = { open: [68, 76], closed: [64, 60], peace: [52, 80], point: [68, 72], rock: [60, 78], thumb: [56, 72] };
export const AVATAR_HANDS = [
  { key: "open", label: "Salut" },
  { key: "peace", label: "Peace" },
  { key: "thumb", label: "Pouce" },
  { key: "point", label: "Index" },
  { key: "rock", label: "Rock" },
  { key: "closed", label: "Poing" },
];

export const AVATAR_ANIMS = [
  { key: "float", label: "Flotte" },
  { key: "bounce", label: "Rebondit" },
  { key: "sway", label: "Se balance" },
  { key: "still", label: "Immobile" },
];

const KEYS = (list) => list.map((x) => x.key);

function hash(str) {
  let h = 2166136261;
  for (const ch of String(str || "lumen")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Avatar complet et valide. Champs absents ⇒ tirés de `seed` (stable). */
export function normalizeAvatar(av, seed = "") {
  const a = av && typeof av === "object" ? av : {};
  const h = hash(seed);
  const pick = (list, v, shift) => (KEYS(list).includes(v) ? v : list[(h >>> shift) % list.length].key);
  return {
    color: pick(AVATAR_COLORS, a.color, 0),
    shape: pick(AVATAR_SHAPES, a.shape, 5),
    face: pick(AVATAR_FACES, a.face, 9),
    hand: pick(AVATAR_HANDS, a.hand, 14),
    // Main droite : absente (anciens avatars) ⇒ la même que la gauche.
    hand2: KEYS(AVATAR_HANDS).includes(a.hand2) ? a.hand2 : pick(AVATAR_HANDS, a.hand, 14),
    anim: KEYS(AVATAR_ANIMS).includes(a.anim) ? a.anim : "float",
  };
}

/** Avatar d'un agent (objet de `agent_list`), défaut déterministe compris. */
export function avatarOf(agent) {
  return normalizeAvatar(agent?.avatar, agent?.id || agent?.name || "");
}

export function avatarColor(agentOrAvatar) {
  const av = agentOrAvatar?.color ? agentOrAvatar : avatarOf(agentOrAvatar);
  return (AVATAR_COLORS.find((c) => c.key === av.color) || AVATAR_COLORS[0]).hex;
}

/** Émoji Slack le plus proche de la couleur (utilisé par la passerelle). */
export function avatarEmoji(agent) {
  const av = avatarOf(agent);
  return (AVATAR_COLORS.find((c) => c.key === av.color) || AVATAR_COLORS[0]).emoji;
}

/** Avatar au hasard — bouton « Surprends-moi ». */
export function randomAvatar() {
  const r = (list) => list[Math.floor(Math.random() * list.length)].key;
  const hand = r(AVATAR_HANDS);
  // Une fois sur deux, deux gestes différents (pouce + main ouverte…).
  return { color: r(AVATAR_COLORS), shape: r(AVATAR_SHAPES), face: r(AVATAR_FACES), hand, hand2: Math.random() < 0.5 ? hand : r(AVATAR_HANDS), anim: r(AVATAR_ANIMS.slice(0, 3)) };
}

const bodySrc = (av) => `${BASE}${av.color}_body_${av.shape}.png`;
const faceSrc = (face) => `${BASE}face_${face}.png`;
// Les mains jaunes du pack sont nommées à l'envers (`hand_yellow_open`).
const handSrc = (color, hand) => (color === "yellow" ? `${BASE}hand_yellow_${hand}.png` : `${BASE}${color}_hand_${hand}.png`);

// Géométrie, en % de la boîte (carrée) : le corps (160 px natifs) occupe 64 %
// de la largeur, tout le reste est mis à la même échelle.
const BODY = 60;
const SCALE = BODY / 160;
const faceStyle = (face) => {
  // Le visage est posé DANS le corps : sa largeur est relative au corps.
  const [w] = FACE_DIMS[face] || FACE_DIMS.a;
  return `width:${((w / 160) * 100).toFixed(2)}%`;
};
// Pose de chaque geste, calée sur l'illustration du pack Kenney : les mains
// flottent de part et d'autre du corps, à hauteur du visage pour les gestes
// « levés », plus bas pour le poing. Valeurs pour la main GAUCHE (image native) ;
// la droite en est le miroir. `rot` > 0 incline le bout des doigts vers le
// visage. y = centre vertical de la main, en % de la boîte.
const HAND_POSE = {
  open: { y: 40, rot: -14 },
  closed: { y: 56, rot: 0 },
  peace: { y: 34, rot: 16 },
  point: { y: 40, rot: -12 },
  rock: { y: 34, rot: -8 },
  thumb: { y: 40, rot: 6 },
};
function handWrapStyle(hand, side) {
  const [w, h] = HAND_DIMS[hand] || HAND_DIMS.open;
  const pose = HAND_POSE[hand] || HAND_POSE.open;
  const width = w * SCALE * 0.95;
  const height = h * SCALE * 0.95;
  const cx = side === "l" ? 11 : 89;
  return `width:${width.toFixed(2)}%;height:${height.toFixed(2)}%;left:${(cx - width / 2).toFixed(2)}%;top:${(pose.y - height / 2).toFixed(2)}%`;
}
function handImgStyle(hand, side) {
  const rot = (HAND_POSE[hand] || HAND_POSE.open).rot;
  return `transform:${side === "r" ? "scaleX(-1) " : ""}rotate(${rot}deg)`;
}
const handHTML = (color, hand, side) =>
  `<span class="ka-hand ka-hand-${side}" style="${handWrapStyle(hand, side)}"><img src="${handSrc(color, hand)}" alt="" draggable="false" style="${handImgStyle(hand, side)}"></span>`;
// Gestes imposés par l'état : pouces levés à la réussite, poings à l'échec.
const stateHands = (state, l, r) => (state === "done" ? ["thumb", "thumb"] : state === "fail" ? ["closed", "closed"] : [l, r]);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * HTML d'un avatar. `src` = agent (avec `avatar`/`id`) ou avatar déjà normalisé.
 * Options : size (px), state (idle|work|done|fail), hands (défaut : si ≥ 30 px),
 * animate (défaut true), title, ring (anneau de couleur derrière, pour les
 * petites tailles).
 */
export function agentAvatarHTML(src, opts = {}) {
  ensureAvatarStyles();
  const av = src && src.color && src.shape ? normalizeAvatar(src) : avatarOf(src);
  const size = opts.size || 40;
  const hands = opts.hands ?? size >= 30;
  const state = opts.state || "idle";
  const animate = opts.animate !== false;
  const delay = -((hash(`${av.color}${av.face}${src?.id || ""}`) % 4000) / 1000);
  const face = state === "fail" ? "j" : state === "done" ? "l" : av.face;
  const [hl, hr] = stateHands(state, av.hand, av.hand2);
  const title = opts.title ? ` title="${esc(opts.title)}"` : "";
  return `<span class="ka ka-${av.shape}${animate ? "" : " ka-static"}${opts.ring ? " ka-ring" : ""}${hands ? "" : " ka-nohands"}"`
    + ` data-state="${state}" data-anim="${av.anim}" data-face="${av.face}" data-hand="${av.hand}" data-hand2="${av.hand2}" data-color="${av.color}"`
    + ` style="--ka-size:${size}px;--ka-c:${avatarColor(av)};--ka-delay:${delay}s" role="img" aria-label="${esc(opts.title || "Avatar")}"${title}>`
    + `<span class="ka-shadow"></span>`
    + (hands ? handHTML(av.color, hl, "l") : "")
    + `<span class="ka-rig"><img class="ka-body" src="${bodySrc(av)}" alt="" draggable="false">`
    + `<img class="ka-face" src="${faceSrc(face)}" alt="" draggable="false" style="${faceStyle(face)}"></span>`
    + (hands ? handHTML(av.color, hr, "r") : "")
    + `</span>`;
}

/**
 * Calques d'un avatar pour un rendu SANS DOM (canevas de Lumen XR) : mêmes
 * images et même géométrie que `agentAvatarHTML`, en fractions de la boîte
 * (0..1). Ordre de dessin : main gauche, corps, visage, main droite.
 * Chaque calque : { src, x, y, w, h (hauteur ; null = proportions de l'image),
 * rot (degrés), flip (miroir horizontal) }.
 */
export function avatarLayers(src, { state = "idle", hands = true } = {}) {
  const av = src && src.color && src.shape ? normalizeAvatar(src) : avatarOf(src);
  const face = state === "fail" ? "j" : state === "done" ? "l" : av.face;
  const [hl, hr] = stateHands(state, av.hand, av.hand2);
  // Corps (« rig ») : sans mains il est agrandi (.ka-nohands).
  const rig = hands ? { x: (100 - BODY) / 200, y: 0.06, w: BODY / 100, h: BODY / 100 } : { x: 0.1, y: 0.04, w: 0.8, h: 0.8 };
  const [fw, fh] = FACE_DIMS[face] || FACE_DIMS.a;
  const faceW = rig.w * (fw / 160), faceH = faceW * (fh / fw);
  const hand = (h, side) => {
    const [w, hh] = HAND_DIMS[h] || HAND_DIMS.open;
    const pose = HAND_POSE[h] || HAND_POSE.open;
    const width = (w * SCALE * 0.95) / 100, height = (hh * SCALE * 0.95) / 100;
    const cx = side === "l" ? 0.11 : 0.89;
    return { src: handSrc(av.color, h), x: cx - width / 2, y: pose.y / 100 - height / 2, w: width, h: height, rot: pose.rot, flip: side === "r" };
  };
  return [
    ...(hands ? [hand(hl, "l")] : []),
    { src: bodySrc(av), x: rig.x, y: rig.y, w: rig.w, h: rig.h, rot: 0, flip: false },
    // Visage centré sur le corps (translate(-50%, -46%) en CSS).
    { src: faceSrc(face), x: rig.x + rig.w / 2 - faceW / 2, y: rig.y + rig.h / 2 - faceH * 0.46, w: faceW, h: faceH, rot: 0, flip: false },
    ...(hands ? [hand(hr, "r")] : []),
  ];
}

/** Change l'état d'un avatar déjà rendu (visage, mains, cadence). */
export function setAvatarState(root, state) {
  const el = root?.classList?.contains("ka") ? root : root?.querySelector?.(".ka");
  if (!el) return;
  el.dataset.state = state;
  const face = state === "fail" ? "j" : state === "done" ? "l" : el.dataset.face;
  const [hl, hr] = stateHands(state, el.dataset.hand, el.dataset.hand2 || el.dataset.hand);
  const f = el.querySelector(".ka-face");
  if (f) { f.src = faceSrc(face); f.setAttribute("style", faceStyle(face)); }
  for (const [side, hand] of [["l", hl], ["r", hr]]) {
    const wrap = el.querySelector(`.ka-hand-${side}`);
    const img = wrap?.querySelector("img");
    if (!wrap || !img) continue;
    wrap.setAttribute("style", handWrapStyle(hand, side));
    img.src = handSrc(el.dataset.color, hand);
    img.setAttribute("style", handImgStyle(hand, side));
  }
}

// Précharge les images d'un avatar (évite un clignement au premier affichage
// d'un état « done »/« fail »).
export function preloadAvatar(agent) {
  const av = avatarOf(agent);
  for (const u of [bodySrc(av), faceSrc(av.face), faceSrc("l"), faceSrc("j"), handSrc(av.color, av.hand), handSrc(av.color, av.hand2), handSrc(av.color, "thumb"), handSrc(av.color, "closed")]) {
    const i = new Image(); i.src = u;
  }
}

export function ensureAvatarStyles(doc = document) {
  if (!doc || doc.getElementById("ka-css")) return;
  const st = doc.createElement("style");
  st.id = "ka-css";
  st.textContent = `
.ka{--ka-size:40px;position:relative;display:inline-block;flex:none;width:var(--ka-size);height:var(--ka-size);vertical-align:middle;
  user-select:none;-webkit-user-select:none;line-height:0}
.ka img{position:absolute;display:block;max-width:none;pointer-events:none;-webkit-user-drag:none}
.ka-ring{border-radius:30%;background:color-mix(in oklab,var(--ka-c) 16%,transparent)}
.ka-shadow{position:absolute;left:50%;bottom:4%;width:46%;height:9%;margin-left:-23%;border-radius:50%;
  background:rgba(40,40,70,.22);filter:blur(.5px);transform-origin:center}
.ka-rig{position:absolute;left:${(100 - BODY) / 2}%;top:6%;width:${BODY}%;height:${BODY}%;transform-origin:50% 100%}
.ka-body{inset:0;width:100%;height:100%}
.ka-face{left:50%;top:50%;height:auto;transform:translate(-50%,-46%)}
.ka-hand{position:absolute;pointer-events:none;transform-origin:50% 85%}
.ka-hand img{inset:0;width:100%;height:100%;object-fit:contain;transform-origin:50% 60%}
.ka-nohands .ka-rig{left:10%;width:80%;height:80%;top:4%}
.ka-nohands .ka-shadow{display:none}

/* Respiration + clignement + mains qui flottent (état repos) */
.ka:not(.ka-static) .ka-rig{animation:ka-float 3.4s ease-in-out infinite;animation-delay:var(--ka-delay)}
.ka:not(.ka-static) .ka-shadow{animation:ka-shadow 3.4s ease-in-out infinite;animation-delay:var(--ka-delay)}
.ka:not(.ka-static) .ka-face{animation:ka-blink 5.2s infinite;animation-delay:var(--ka-delay)}
.ka:not(.ka-static) .ka-hand-l{animation:ka-hand 3.4s ease-in-out infinite;animation-delay:calc(var(--ka-delay) - .35s)}
.ka:not(.ka-static) .ka-hand-r{animation:ka-hand 3.4s ease-in-out infinite;animation-delay:calc(var(--ka-delay) - 1.1s)}
.ka[data-anim="bounce"]:not(.ka-static) .ka-rig{animation:ka-bounce 1.6s cubic-bezier(.3,.1,.3,1) infinite;animation-delay:var(--ka-delay)}
.ka[data-anim="bounce"]:not(.ka-static) .ka-shadow{animation:ka-shadow 1.6s cubic-bezier(.3,.1,.3,1) infinite;animation-delay:var(--ka-delay)}
.ka[data-anim="sway"]:not(.ka-static) .ka-rig{animation:ka-sway 3s ease-in-out infinite;animation-delay:var(--ka-delay)}
.ka[data-anim="still"] .ka-rig,.ka[data-anim="still"] .ka-shadow,.ka[data-anim="still"] .ka-hand{animation:none!important}

/* Au travail : plus vif, les mains « tapent » */
.ka[data-state="work"]:not(.ka-static) .ka-rig{animation:ka-bounce .9s ease-in-out infinite!important}
.ka[data-state="work"]:not(.ka-static) .ka-shadow{animation:ka-shadow .9s ease-in-out infinite!important}
.ka[data-state="work"]:not(.ka-static) .ka-hand-l{animation:ka-type .45s ease-in-out infinite!important}
.ka[data-state="work"]:not(.ka-static) .ka-hand-r{animation:ka-type .45s ease-in-out infinite!important;animation-delay:-.22s!important}
/* Réussite : un saut, pouces levés */
.ka[data-state="done"]:not(.ka-static) .ka-rig{animation:ka-jump .8s cubic-bezier(.2,.8,.3,1) 2!important}
.ka[data-state="done"]:not(.ka-static) .ka-hand{animation:ka-cheer .8s ease-in-out 2!important}
/* Échec : il secoue la tête */
.ka[data-state="fail"]:not(.ka-static) .ka-rig{animation:ka-shake .5s ease-in-out 2!important}
.ka[data-state="fail"] .ka-hand{animation:none!important;transform:translateY(12%)}
/* Survol : il salue */
.ka-wave:hover .ka-hand-r,.ka.ka-wave:hover .ka-hand-r{animation:ka-wave .6s ease-in-out 2!important}

@keyframes ka-float{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(-6%) scale(.985,1.015)}}
@keyframes ka-shadow{0%,100%{transform:scaleX(1);opacity:1}50%{transform:scaleX(.82);opacity:.7}}
@keyframes ka-bounce{0%,100%{transform:translateY(0) scale(1.06,.94)}15%{transform:translateY(0) scale(.96,1.04)}50%{transform:translateY(-12%) scale(.98,1.02)}85%{transform:translateY(0) scale(1.04,.96)}}
@keyframes ka-sway{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}
@keyframes ka-hand{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-10%) rotate(-6deg)}}
@keyframes ka-type{0%,100%{transform:translateY(0)}50%{transform:translateY(-14%)}}
@keyframes ka-jump{0%{transform:translateY(0) scale(1.08,.92)}35%{transform:translateY(-22%) scale(.95,1.05)}70%{transform:translateY(0) scale(1.06,.94)}100%{transform:none}}
@keyframes ka-cheer{0%,100%{transform:translateY(0)}40%{transform:translateY(-30%)}}
@keyframes ka-shake{0%,100%{transform:rotate(0)}25%{transform:rotate(-8deg)}75%{transform:rotate(8deg)}}
@keyframes ka-wave{0%,100%{transform:rotate(0)}25%{transform:rotate(-18deg)}75%{transform:rotate(14deg)}}
@keyframes ka-blink{0%,92%,100%{transform:translate(-50%,-46%) scaleY(1)}95%{transform:translate(-50%,-46%) scaleY(.12)}}
@media (prefers-reduced-motion:reduce){.ka *{animation:none!important}}
`;
  (doc.head || doc.documentElement).appendChild(st);
}

/**
 * Visage « qui parle » (Lumen XR, M5 Fire) : yeux et bouche dessinés à part,
 * CALÉS SUR LE CALQUE DU VISAGE et dans les proportions des images du pack
 * (œil 20×20, bouche 20×7). Avant, des fractions fixes de la boîte donnaient
 * des yeux étirés et une bouche décalée selon la forme de l'agent.
 * `face` = calque visage d'avatarLayers ; `open` ∈ [0, 1] = ouverture de la
 * bouche. Renvoie des rectangles en fractions de la boîte.
 */
export function talkingFaceParts(face, open = 0) {
  const fw = face.w, fh = face.h ?? face.w * 0.58;
  const eye = fw * 0.32;
  const mw = fw * (0.36 + open * 0.04), mh = mw * (7 / 20) * (1 + open * 1.4);
  return {
    eyeSrc: `${BASE}facial_part_eye_open.png`,
    mouthSrc: `${BASE}facial_part_mouth_happy.png`,
    eyes: [0.2, 0.8].map((cx) => ({ x: face.x + fw * cx - eye / 2, y: face.y + fh * 0.32 - eye / 2, w: eye, h: eye })),
    mouth: { x: face.x + fw / 2 - mw / 2, y: face.y + fh * 0.84 - mh / 2, w: mw, h: mh },
  };
}
