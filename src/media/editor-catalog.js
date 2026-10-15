// Catalogues du montage : filtres, transitions, styles de texte, animations,
// mouvements, stickers. Partagés par l'interface, le rendu et l'assistant IA
// (qui reçoit les identifiants dans la description de ses outils).

/** Filtres « en un clic » : des réglages, rien d'autre — l'utilisateur peut
 *  les retoucher ensuite curseur par curseur. Valeurs dans [-1, 1]. */
export const FILTER_PRESETS = [
  { id: "none", label: "Original", v: {} },
  { id: "vivid", label: "Vif", v: { saturation: 0.35, contrast: 0.12 } },
  { id: "cinema", label: "Cinéma", v: { contrast: 0.22, saturation: -0.15, temperature: 0.18, vignette: 0.35 } },
  { id: "teal", label: "Bleu-orangé", v: { contrast: 0.15, temperature: -0.25, hue: -0.04, saturation: 0.1 } },
  { id: "warm", label: "Chaud", v: { temperature: 0.4, saturation: 0.08 } },
  { id: "cool", label: "Froid", v: { temperature: -0.4 } },
  { id: "bw", label: "Noir et blanc", v: { saturation: -1, contrast: 0.15 } },
  { id: "noir", label: "Film noir", v: { saturation: -1, contrast: 0.45, brightness: -0.1, vignette: 0.6 } },
  { id: "vintage", label: "Vintage", v: { saturation: -0.35, temperature: 0.35, contrast: -0.12, brightness: 0.05, vignette: 0.4 } },
  { id: "fade", label: "Délavé", v: { contrast: -0.3, brightness: 0.1, saturation: -0.2 } },
  { id: "dream", label: "Rêve", v: { brightness: 0.12, blur: 0.08, saturation: 0.1, contrast: -0.1 } },
  { id: "drama", label: "Drame", v: { contrast: 0.5, saturation: -0.3, vignette: 0.5 } },
  { id: "pop", label: "Pop", v: { saturation: 0.7, contrast: 0.2, brightness: 0.05 } },
  { id: "night", label: "Nuit", v: { brightness: -0.25, temperature: -0.5, saturation: -0.2, vignette: 0.4 } },
];

/** Réglages manuels (inspecteur). */
export const ADJUSTMENTS = [
  { k: "brightness", label: "Luminosité" },
  { k: "contrast", label: "Contraste" },
  { k: "saturation", label: "Saturation" },
  { k: "temperature", label: "Température" },
  { k: "hue", label: "Teinte" },
  { k: "blur", label: "Flou", min: 0 },
  { k: "vignette", label: "Vignette", min: 0 },
];

export const TRANSITIONS = [
  { id: "none", label: "Aucune" },
  { id: "fade", label: "Fondu enchaîné" },
  { id: "black", label: "Fondu au noir" },
  { id: "white", label: "Flash blanc" },
  { id: "slideleft", label: "Glisser à gauche" },
  { id: "slideright", label: "Glisser à droite" },
  { id: "slideup", label: "Glisser vers le haut" },
  { id: "zoom", label: "Zoom" },
  { id: "wipe", label: "Balayage" },
  { id: "circle", label: "Cercle" },
  { id: "blur", label: "Flou" },
  { id: "spin", label: "Rotation" },
];

/** Mouvements de caméra simulés (photos et plans fixes). */
export const MOTIONS = [
  { id: "none", label: "Aucun" },
  { id: "in", label: "Zoom avant lent" },
  { id: "out", label: "Zoom arrière lent" },
  { id: "left", label: "Panoramique gauche" },
  { id: "right", label: "Panoramique droite" },
  { id: "up", label: "Panoramique haut" },
];

export const FONTS = [
  { id: "sans", label: "Sans", css: `-apple-system, "SF Pro Display", "Segoe UI", Roboto, sans-serif` },
  { id: "rounded", label: "Arrondie", css: `ui-rounded, "SF Pro Rounded", "Nunito", "Arial Rounded MT Bold", sans-serif` },
  { id: "serif", label: "Serif", css: `"New York", Georgia, "Times New Roman", serif` },
  { id: "condensed", label: "Condensée", css: `"Impact", "Haettenschweiler", "Arial Narrow Bold", "Oswald", sans-serif` },
  { id: "mono", label: "Machine", css: `ui-monospace, "SF Mono", Menlo, Consolas, monospace` },
  { id: "script", label: "Manuscrite", css: `"Snell Roundhand", "Segoe Script", "Brush Script MT", cursive` },
];
export const fontCss = (id) => (FONTS.find((f) => f.id === id) || FONTS[0]).css;

export const TEXT_ANIMS_IN = [
  { id: "none", label: "Aucune" }, { id: "fade", label: "Fondu" }, { id: "pop", label: "Pop" },
  { id: "slideup", label: "Monte" }, { id: "slidedown", label: "Descend" }, { id: "slideleft", label: "Glisse" },
  { id: "zoom", label: "Zoom" }, { id: "typewriter", label: "Machine à écrire" }, { id: "bounce", label: "Rebond" },
  { id: "blur", label: "Mise au point" },
];
export const TEXT_ANIMS_OUT = [
  { id: "none", label: "Aucune" }, { id: "fade", label: "Fondu" }, { id: "pop", label: "Pop" },
  { id: "slideup", label: "Monte" }, { id: "slidedown", label: "Descend" }, { id: "zoom", label: "Zoom" },
];

/** Styles de texte prêts à l'emploi. `y` = centre vertical (0 haut → 1 bas). */
export const TEXT_PRESETS = [
  { id: "plain", label: "Simple", sample: "Texte", s: { font: "sans", weight: 700, size: 72, color: "#ffffff", bg: "transparent", shadow: true, y: 0.5 } },
  { id: "title", label: "Titre", sample: "TITRE", s: { font: "condensed", weight: 800, size: 140, color: "#ffffff", bg: "transparent", shadow: true, upper: true, y: 0.45, anim: { in: "pop", out: "fade", dur: 0.4 } } },
  { id: "subtitle", label: "Sous-titre", sample: "Sous-titre", s: { font: "sans", weight: 600, size: 56, color: "#ffffff", bg: "rgba(0,0,0,0.55)", shadow: false, y: 0.86 } },
  { id: "caption", label: "Légende TikTok", sample: "Légende", s: { kind: "caption", font: "rounded", weight: 800, size: 68, color: "#ffffff", stroke: 8, strokeColor: "#000000", bg: "transparent", shadow: false, y: 0.72, anim: { in: "pop", out: "none", dur: 0.15 } } },
  { id: "highlight", label: "Surligné", sample: "Surligné", s: { font: "sans", weight: 800, size: 64, color: "#111111", bg: "#ffd60a", shadow: false, y: 0.8 } },
  { id: "neon", label: "Néon", sample: "Néon", s: { font: "rounded", weight: 700, size: 96, color: "#5ef1ff", bg: "transparent", shadow: true, glow: "#00d5ff", y: 0.5, anim: { in: "blur", out: "fade", dur: 0.5 } } },
  { id: "outline", label: "Contour", sample: "Contour", s: { font: "condensed", weight: 800, size: 110, color: "#ffffff", stroke: 10, strokeColor: "#ff375f", bg: "transparent", shadow: false, upper: true, y: 0.5 } },
  { id: "badge", label: "Badge", sample: "Nouveau", s: { font: "sans", weight: 800, size: 48, color: "#ffffff", bg: "#ff375f", shadow: false, upper: true, x: 0.2, y: 0.12, maxW: 0.5, anim: { in: "pop", out: "pop", dur: 0.25 } } },
  { id: "typewriter", label: "Machine à écrire", sample: "Il était une fois…", s: { font: "mono", weight: 600, size: 54, color: "#f5f5f7", bg: "transparent", shadow: true, y: 0.5, anim: { in: "typewriter", out: "fade", dur: 1.2 } } },
  { id: "quote", label: "Citation", sample: "« Citation »", s: { font: "serif", weight: 500, size: 70, color: "#ffffff", bg: "transparent", shadow: true, y: 0.5, maxW: 0.7, anim: { in: "fade", out: "fade", dur: 0.8 } } },
  { id: "lower", label: "Bandeau nom", sample: "Prénom Nom", s: { font: "sans", weight: 700, size: 46, color: "#ffffff", bg: "rgba(10,10,14,0.78)", shadow: false, align: "left", x: 0.08, y: 0.82, maxW: 0.6, anim: { in: "slideleft", out: "fade", dur: 0.35 } } },
  { id: "credits", label: "Générique", sample: "Réalisation\nVotre nom", s: { font: "serif", weight: 500, size: 52, color: "#ffffff", bg: "transparent", shadow: true, y: 0.5, anim: { in: "slideup", out: "slideup", dur: 0.8 } } },
];

export const STICKERS = ["🔥", "✨", "❤️", "😂", "😍", "🤯", "👍", "👏", "🎉", "💯", "⭐️", "⚡️", "🚀", "🎬", "📍", "✅", "❌", "👀", "💡", "🎵", "☀️", "🌙", "🌈", "🍿", "😎", "🥳", "🙌", "💪", "🤔", "😱", "➡️", "⬇️", "⬆️", "👉", "🔔", "📢", "💬", "🏆", "🎯", "📸"];

export const ASPECT_LABELS = { "16:9": "Paysage 16:9", "9:16": "Portrait 9:16", "1:1": "Carré 1:1", "4:5": "Portrait 4:5", "4:3": "Classique 4:3", "21:9": "Cinéma 21:9" };

/** Applique un préréglage de filtre (remplace tous les curseurs). */
export function filterFromPreset(id) {
  const p = FILTER_PRESETS.find((x) => x.id === id) || FILTER_PRESETS[0];
  return { preset: p.id, brightness: 0, contrast: 0, saturation: 0, temperature: 0, hue: 0, blur: 0, vignette: 0, ...p.v };
}
