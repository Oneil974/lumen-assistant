// Module sprite partagé — Village ET éditeur d'agents l'importent pour garantir
// que l'avatar pixel art dessiné dans Agents correspond exactement à celui du
// Village. Aucune dépendance : on peint sur un canvas hors-écran à résolution
// native puis on agrandit (image-rendering: pixelated) côté appelant.

export const PW = 24, PH = 30; // résolution native d'un sprite (pixels)

// ===== Catalogues d'apparence (clé -> rendu) =====
// Chaque slot expose une liste { key, label, ... } pour piloter le sélecteur.
export const BODY_COLORS = [
  { key: "violet", label: "Violet", c: ["#7c6cff", "#5a4bd6"] },
  { key: "rose",   label: "Rose",   c: ["#ff8fb0", "#e0668c"] },
  { key: "cyan",   label: "Cyan",   c: ["#34c7ff", "#1f9fd6"] },
  { key: "vert",   label: "Vert",   c: ["#34c759", "#23a047"] },
  { key: "ambre",  label: "Ambre",  c: ["#ffb340", "#e0922a"] },
  { key: "corail", label: "Corail", c: ["#ff6f61", "#d9534a"] },
  { key: "indigo", label: "Indigo", c: ["#9b6bff", "#7a4bd6"] },
  { key: "teal",   label: "Teal",   c: ["#30d1c8", "#1fa9a1"] },
];
export const SKIN_TONES = [
  { key: "clair",  label: "Clair",  c: ["#f3c6a0", "#d9a87f"] },
  { key: "hale",   label: "Hâlé",   c: ["#e0a878", "#c08a5c"] },
  { key: "mat",    label: "Mat",    c: ["#b9794a", "#9a5f37"] },
  { key: "fonce",  label: "Foncé",  c: ["#8a5a35", "#6e4526"] },
  { key: "ebene",  label: "Ébène",  c: ["#5e3c22", "#472c18"] },
];
export const HAIR_COLORS = [
  { key: "brun",   label: "Brun",   c: "#3a2f2a" },
  { key: "chatain",label: "Châtain",c: "#5b3a29" },
  { key: "noir",   label: "Noir",   c: "#1f1d2b" },
  { key: "roux",   label: "Roux",   c: "#a4502b" },
  { key: "blond",  label: "Blond",  c: "#caa15a" },
  { key: "gris",   label: "Gris",   c: "#9aa0aa" },
  { key: "bleu",   label: "Bleu",   c: "#4a78d6" },
];
export const HATS = [
  { key: "none",   label: "Aucun" },
  { key: "cap",    label: "Casquette" },
  { key: "straw",  label: "Paille" },
  { key: "wizard", label: "Magicien" },
  { key: "beanie", label: "Bonnet" },
  { key: "crown",  label: "Couronne" },
];
export const OUTFITS = [
  { key: "tunic",  label: "Tunique" },
  { key: "apron",  label: "Tablier" },
  { key: "robe",   label: "Robe" },
  { key: "armor",  label: "Armure" },
  { key: "hoodie", label: "Sweat" },
];
export const ACCESSORIES = [
  { key: "none",   label: "Aucun" },
  { key: "glasses",label: "Lunettes" },
  { key: "scarf",  label: "Écharpe" },
  { key: "cape",   label: "Cape" },
  { key: "badge",  label: "Badge" },
];

// Style de rendu : sprite procédural « maison » ou pack pixel MetroCity.
export const STYLES = [
  { key: "proc",      label: "Pixel Lumen" },
  { key: "metrocity", label: "MetroCity" },
];

export const APPEARANCE_OPTIONS = {
  style: STYLES,
  body: BODY_COLORS, skin: SKIN_TONES, hair: HAIR_COLORS,
  hat: HATS, outfit: OUTFITS, accessory: ACCESSORIES,
};

// ===== Hash déterministe (repris du Village) =====
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Apparence par défaut, déterministe depuis un identifiant.
export function defaultAppearance(seed) {
  const h = hashStr(seed || "x");
  return {
    body: BODY_COLORS[h % BODY_COLORS.length].key,
    skin: SKIN_TONES[(h >>> 3) % SKIN_TONES.length].key,
    hair: HAIR_COLORS[(h >>> 6) % HAIR_COLORS.length].key,
    hat: "none",
    outfit: "tunic",
    accessory: "none",
  };
}

// Complète/normalise une apparence (valeurs manquantes -> défaut déterministe).
export function normalizeAppearance(appearance, seed) {
  const d = defaultAppearance(seed);
  const a = appearance || {};
  const pick = (list, key, fb) => (list.some((o) => o.key === key) ? key : fb);
  return {
    style: pick(STYLES, a.style, "proc"),
    // Slots MetroCity (préservés ; normalisés/défaut par metrocity.js)
    mcSkin: a.mcSkin || "", mcOutfit: a.mcOutfit || "", mcHair: a.mcHair || "",
    body: pick(BODY_COLORS, a.body, d.body),
    skin: pick(SKIN_TONES, a.skin, d.skin),
    hair: pick(HAIR_COLORS, a.hair, d.hair),
    hat: pick(HATS, a.hat, "none"),
    outfit: pick(OUTFITS, a.outfit, "tunic"),
    accessory: pick(ACCESSORIES, a.accessory, "none"),
    // Réfs d'assets perso (préservées telles quelles ; vide = sprite généré)
    assetId: a.assetId || "",
    houseAssetId: a.houseAssetId || "",
  };
}

function lookup(list, key) { return list.find((o) => o.key === key) || list[0]; }
function px(c, x, y, w, h, col) { c.fillStyle = col; c.fillRect(x, y, w, h); }

// ===== Construction du sprite =====
// appearance : objet de slots ; opts : { state: 'work'|'idle'|'sleep', frame: 0|1, level }
export function buildSprite(appearance, opts = {}) {
  const a = normalizeAppearance(appearance, opts.seed || "x");
  const state = opts.state || "idle";
  const frame = opts.frame ? 1 : 0;
  const level = opts.level || 1;

  const [body, bodyDark] = lookup(BODY_COLORS, a.body).c;
  const [skin, skinDark] = lookup(SKIN_TONES, a.skin).c;
  const hairCol = lookup(HAIR_COLORS, a.hair).c;
  const dark = "#2b2540";

  const off = document.createElement("canvas");
  off.width = PW; off.height = PH;
  const c = off.getContext("2d");

  const walk = !!opts.walk;                       // en déplacement → cycle de marche
  // Balancement vertical : au repos (idle) ET en marche pour donner vie au pas.
  const bob = (state === "idle" || walk) ? frame : 0;
  const y0 = 4 + bob;

  // Ombre portée
  c.fillStyle = "rgba(40,30,70,0.18)";
  c.beginPath(); c.ellipse(PW / 2, PH - 3, 8, 3, 0, 0, Math.PI * 2); c.fill();

  // Cape (accessoire) — derrière le corps
  if (a.accessory === "cape") {
    px(c, 6, y0 + 9, 12, 11, "#c0392b");
    px(c, 6, y0 + 9, 12, 2, "#e05545");
  }

  // Jambes — cycle de marche : les deux jambes alternent en avant/arrière selon
  // la frame quand l'agent se déplace (sinon position fixe, debout).
  if (walk) {
    const step = frame ? 1 : 0;
    px(c, 9,  y0 + 17 + step,       3, 6, dark);   // jambe gauche
    px(c, 12, y0 + 17 + (1 - step), 3, 6, dark);   // jambe droite
  } else {
    px(c, 9, y0 + 17, 3, 6, dark);
    px(c, 12, y0 + 17, 3, 6, dark);
  }

  // Corps + variations de tenue
  px(c, 7, y0 + 9, 10, 9, bodyDark);
  px(c, 8, y0 + 9, 8, 8, body);
  px(c, 8, y0 + 8, 8, 1, body);
  if (a.outfit === "apron") { px(c, 9, y0 + 11, 6, 7, "#f3efe6"); px(c, 11, y0 + 11, 2, 7, "#dcd6c6"); }
  else if (a.outfit === "robe") { px(c, 7, y0 + 17, 10, 3, body); px(c, 7, y0 + 19, 10, 2, bodyDark); }
  else if (a.outfit === "armor") { px(c, 8, y0 + 9, 8, 8, "#9aa6b2"); px(c, 8, y0 + 12, 8, 1, "#6f7b88"); px(c, 11, y0 + 9, 2, 8, "#c2ccd6"); }
  else if (a.outfit === "hoodie") { px(c, 7, y0 + 8, 10, 3, bodyDark); px(c, 11, y0 + 11, 2, 4, "#000"); c.globalAlpha = 0.15; px(c, 11, y0 + 11, 2, 4, "#fff"); c.globalAlpha = 1; }

  // Bras — frappe quand au travail
  const armY = state === "work" ? (frame ? y0 + 12 : y0 + 14) : y0 + 12;
  px(c, 5, armY, 3, 4, body);
  px(c, 16, armY, 3, 4, body);
  px(c, 5, armY + 4, 3, 2, skin);
  px(c, 16, armY + 4, 3, 2, skin);

  // Écharpe (accessoire)
  if (a.accessory === "scarf") { px(c, 8, y0 + 8, 8, 2, "#e74c3c"); px(c, 9, y0 + 10, 2, 3, "#c0392b"); }

  // Tête
  px(c, 8, y0 + 1, 8, 8, skinDark);
  px(c, 8, y0, 8, 7, skin);

  // Cheveux (sauf si chapeau couvrant total)
  const fullHat = a.hat === "wizard" || a.hat === "beanie";
  if (!fullHat) {
    px(c, 7, y0 - 1, 10, 3, hairCol);
    px(c, 7, y0 + 1, 2, 3, hairCol);
    px(c, 15, y0 + 1, 2, 3, hairCol);
  }

  // Yeux / expression
  if (state === "sleep") { px(c, 10, y0 + 4, 2, 1, dark); px(c, 13, y0 + 4, 2, 1, dark); }
  else { px(c, 10, y0 + 3, 2, 2, dark); px(c, 13, y0 + 3, 2, 2, dark); }
  // Lunettes
  if (a.accessory === "glasses") {
    px(c, 9, y0 + 3, 3, 2, "#2b2540"); px(c, 12, y0 + 3, 3, 2, "#2b2540");
    px(c, 10, y0 + 3, 1, 1, "#bfe3ff"); px(c, 13, y0 + 3, 1, 1, "#bfe3ff");
  }
  // Joues
  c.fillStyle = "rgba(255,140,160,0.5)";
  c.fillRect(9, y0 + 5, 1, 1); c.fillRect(15, y0 + 5, 1, 1);

  // Chapeaux
  drawHat(c, a.hat, y0);

  // Badge (accessoire) — pastille sur la poitrine
  if (a.accessory === "badge") { px(c, 9, y0 + 11, 2, 2, "#ffd60a"); px(c, 9, y0 + 11, 1, 1, "#fff"); }

  // Liseré de rang : aura dorée discrète aux niveaux élevés
  if (level >= 8) {
    c.save(); c.globalAlpha = 0.5; c.strokeStyle = "#ffd60a"; c.lineWidth = 1;
    c.beginPath(); c.ellipse(PW / 2, PH - 3, 9, 3.5, 0, 0, Math.PI * 2); c.stroke(); c.restore();
  }

  return off;
}

function drawHat(c, hat, y0) {
  if (hat === "cap") { px(c, 7, y0 - 1, 10, 3, "#2f7cf6"); px(c, 15, y0 + 1, 5, 2, "#2f7cf6"); }
  else if (hat === "straw") { px(c, 5, y0 + 1, 14, 2, "#d8b24a"); px(c, 7, y0 - 2, 10, 3, "#e8c75f"); }
  else if (hat === "beanie") { px(c, 7, y0 - 2, 10, 4, "#d9534a"); px(c, 7, y0 + 1, 10, 1, "#fff"); }
  else if (hat === "wizard") { px(c, 7, y0 - 1, 10, 2, "#3a2d7a"); px(c, 9, y0 - 5, 6, 4, "#4a3d9a"); px(c, 11, y0 - 8, 2, 3, "#4a3d9a"); px(c, 10, y0 - 2, 2, 1, "#ffd60a"); }
  else if (hat === "crown") { px(c, 7, y0 - 2, 10, 2, "#ffcf33"); c.fillStyle = "#ffcf33"; c.fillRect(7, y0 - 4, 1, 2); c.fillRect(11, y0 - 5, 1, 3); c.fillRect(16, y0 - 4, 1, 2); px(c, 11, y0 - 2, 1, 1, "#ff3b6b"); }
}

// Pratique : rendre une apparence en data URL (pour un aperçu CSS dans Agents).
export function spriteDataUrl(appearance, opts = {}) {
  return buildSprite(appearance, opts).toDataURL();
}
