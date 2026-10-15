// Compositeur de sprites MetroCity (pack topdown jik-a-4, libre).
// Système EN CALQUES : corps (6 teintes de peau) + tenue + coiffure, composités
// à la volée sur un canvas 32×32. Les feuilles sont des grilles de 24 colonnes
// (4 directions × 6 frames), dans l'ordre HAUT(0‑5) DROITE(6‑11) BAS(12‑17)
// GAUCHE(18‑23). Importé par le Village ET l'éditeur d'agents.

export const MC_FRAME = 32;     // taille d'une frame (px)
const COLS = 24;
// Colonne de départ par direction. Ordre réel de la feuille : BAS(0‑5, face),
// DROITE(6‑11), HAUT(12‑17, dos), GAUCHE(18‑23).
const DIR_BASE = { down: 0, right: 6, up: 12, left: 18 };
const WALK_FRAMES = 6;          // frames par direction

const BASE = "/lib/avatars/metrocity/";

// ===== Catalogues exposés à l'éditeur d'apparence =====
export const MC_SKINS = [
  { key: "s0", label: "Peau 1", row: 0 },
  { key: "s1", label: "Peau 2", row: 1 },
  { key: "s2", label: "Peau 3", row: 2 },
  { key: "s3", label: "Peau 4", row: 3 },
  { key: "s4", label: "Peau 5", row: 4 },
  { key: "s5", label: "Peau 6", row: 5 },
];
export const MC_OUTFITS = [
  { key: "none", label: "Aucune", file: null },
  { key: "o1", label: "Tenue 1", file: "outfits/outfit1.png" },
  { key: "o2", label: "Tenue 2", file: "outfits/outfit2.png" },
  { key: "o3", label: "Tenue 3", file: "outfits/outfit3.png" },
  { key: "o4", label: "Tenue 4", file: "outfits/outfit4.png" },
  { key: "o5", label: "Tenue 5", file: "outfits/outfit5.png" },
  { key: "o6", label: "Tenue 6", file: "outfits/outfit6.png" },
];
export const MC_HAIRS = [
  { key: "none", label: "Aucune", row: -1 },
  { key: "h0", label: "Cheveux 1", row: 0 },
  { key: "h1", label: "Cheveux 2", row: 1 },
  { key: "h2", label: "Cheveux 3", row: 2 },
  { key: "h3", label: "Cheveux 4", row: 3 },
  { key: "h4", label: "Cheveux 5", row: 4 },
  { key: "h5", label: "Cheveux 6", row: 5 },
  { key: "h6", label: "Cheveux 7", row: 6 },
  { key: "h7", label: "Cheveux 8", row: 7 },
];

// ===== Chargement des feuilles =====
const images = new Map();        // url -> { img, ready }
function load(url) {
  let e = images.get(url);
  if (e) return e;
  e = { img: new Image(), ready: false };
  e.img.onload = () => { e.ready = true; };
  e.img.src = url;
  images.set(url, e);
  return e;
}
// Précharge les feuilles communes.
const bodySheet = load(BASE + "body.png");
const hairSheet = load(BASE + "hairs.png");
MC_OUTFITS.forEach((o) => { if (o.file) load(BASE + o.file); });

// La feuille corps est le minimum requis pour afficher quelque chose.
export function mcReady() { return bodySheet.ready; }

function pickSkin(key) { return MC_SKINS.find((s) => s.key === key) || MC_SKINS[0]; }
function pickOutfit(key) { return MC_OUTFITS.find((o) => o.key === key) || MC_OUTFITS[0]; }
function pickHair(key) { return MC_HAIRS.find((h) => h.key === key) || MC_HAIRS[0]; }

// Normalise les slots MetroCity d'une apparence (avec défaut déterministe via seed).
export function normalizeMc(a = {}, seed = "x") {
  let h = 2166136261;
  for (let i = 0; i < String(seed).length; i++) { h ^= String(seed).charCodeAt(i); h = Math.imul(h, 16777619); }
  h = h >>> 0;
  const d = {
    mcSkin: MC_SKINS[h % MC_SKINS.length].key,
    mcOutfit: MC_OUTFITS[1 + (h >>> 3) % (MC_OUTFITS.length - 1)].key,
    mcHair: MC_HAIRS[1 + (h >>> 6) % (MC_HAIRS.length - 1)].key,
  };
  const valid = (list, k, fb) => (list.some((o) => o.key === k) ? k : fb);
  return {
    mcSkin: valid(MC_SKINS, a.mcSkin, d.mcSkin),
    mcOutfit: valid(MC_OUTFITS, a.mcOutfit, d.mcOutfit),
    mcHair: valid(MC_HAIRS, a.mcHair, d.mcHair),
  };
}

// ===== Composition =====
const cache = new Map();
function blit(c, e, col, row) {
  if (!e || !e.ready) return;
  c.drawImage(e.img, col * MC_FRAME, row * MC_FRAME, MC_FRAME, MC_FRAME, 0, 0, MC_FRAME, MC_FRAME);
}

// Retourne un canvas 32×32 composité, ou null si le corps n'est pas prêt.
// opts : { skin, outfit, hair, dir:'up|right|down|left', frame:0..5 }
export function mcSprite(opts = {}) {
  if (!bodySheet.ready) return null;
  const skin = pickSkin(opts.skin), outfit = pickOutfit(opts.outfit), hair = pickHair(opts.hair);
  const dir = DIR_BASE[opts.dir] != null ? opts.dir : "down";
  const frame = ((opts.frame | 0) % WALK_FRAMES + WALK_FRAMES) % WALK_FRAMES;
  const col = DIR_BASE[dir] + frame;
  const key = `${skin.key}|${outfit.key}|${hair.key}|${col}`;
  let off = cache.get(key);
  if (off) return off;

  off = document.createElement("canvas");
  off.width = MC_FRAME; off.height = MC_FRAME;
  const c = off.getContext("2d");
  c.imageSmoothingEnabled = false;
  blit(c, bodySheet, col, skin.row);
  if (outfit.file) blit(c, load(BASE + outfit.file), col, 0);   // tenue : 1 ligne
  if (hair.row >= 0) blit(c, hairSheet, col, hair.row);
  if (cache.size > 600) cache.clear();
  cache.set(key, off);
  return off;
}

// Aperçu data URL (face avant immobile) pour l'éditeur d'agents.
export function mcDataUrl(a, seed) {
  const n = normalizeMc(a, seed);
  const s = mcSprite({ skin: n.mcSkin, outfit: n.mcOutfit, hair: n.mcHair, dir: "down", frame: 0 });
  return s ? s.toDataURL() : "";
}
