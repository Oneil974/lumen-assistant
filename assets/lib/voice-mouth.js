// Niveau d'ouverture de la bouche de l'orbe.
//
// Cette partie est isolée d'orb.js pour une raison simple : orb.js ne tourne que
// dans une WebView, avec WebGL et une boucle d'animation, donc rien de ce qu'il
// contient n'est vérifiable hors de l'application. Le calcul du niveau, lui, est
// une fonction pure — il est ici, et il est couvert par
// `scripts/test-voice-mouth.mjs`.
//
// Deux sources de niveau, dans cet ordre :
//   1. l'enveloppe RÉELLE de la voix (RMS par tranche) calculée par le backend
//      sur le WAV qu'il s'apprête à lire, rejouée à l'horloge ;
//   2. à défaut — voix système, Raccourcis macOS, aucun échantillon disponible —
//      une enveloppe synthétique au rythme de la parole.

/**
 * Niveau (0–1) lu dans une enveloppe à un instant donné.
 * @param {number[]|null} envelope niveaux 0–255, un par tranche
 * @param {number} frameMs durée d'une tranche, en millisecondes
 * @param {number} elapsedMs temps écoulé depuis le début de la lecture
 * @returns {number|null} null quand l'enveloppe est absente ou terminée —
 *   l'appelant retombe alors sur l'enveloppe synthétique.
 */
export function envelopeLevel(envelope, frameMs, elapsedMs) {
  if (!Array.isArray(envelope) || envelope.length === 0) return null;
  const frame = Number(frameMs) > 0 ? Number(frameMs) : 40;
  const index = Math.floor(elapsedMs / frame);
  if (index < 0) return 0;
  if (index >= envelope.length) return null;   // lecture finie
  const value = Number(envelope[index]);
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / 255));
}

/**
 * Enveloppe synthétique : une oscillation au rythme des syllabes, modulée par
 * deux ondes plus lentes pour éviter le battement mécanique.
 * @param {number} t temps en secondes
 */
export function syntheticLevel(t) {
  let a = Math.abs(Math.sin(t * 8.5));
  a *= 0.55 + 0.45 * Math.sin(t * 3.1 + 1.0);
  a *= 0.6 + 0.4 * Math.sin(t * 1.6 + 0.5);
  a += 0.12 * Math.sin(t * 21.0);
  return Math.min(1, Math.max(0, a));
}

/**
 * Dimensions de la bouche, déduites de celles d'un œil.
 *
 * La bouche est « la forme des yeux, à l'horizontale » : elle doit donc suivre
 * les yeux, pas le diamètre de l'orbe. C'est important en pratique, parce que
 * les yeux sont dimensionnés en CSS par chaque surface (7 × 22 px dans la barre,
 * 6 × 20 sur le bureau, 5 × 15 dans le Compagnon IA) et ne changent PAS quand
 * l'utilisateur agrandit l'orbe. Une bouche proportionnelle à l'orbe finissait
 * énorme à côté d'yeux restés petits.
 *
 * @param {{width:number, height:number}} eye dimensions mesurées d'un œil
 */
export function mouthSizeFromEye(eye) {
  const w = Number(eye?.width) > 0 ? Number(eye.width) : 7;
  const h = Number(eye?.height) > 0 ? Number(eye.height) : 22;
  return {
    // Plus courte que la paire d'yeux (2 yeux + l'écart ≈ 3,9 × la largeur d'un
    // œil) : une barre aussi large que la paire écrase le visage.
    width: Math.round(w * 2.4),
    // Un peu plus fine qu'un œil n'est large : un trait, pas une barre.
    height: Math.max(3, Math.round(w * 0.72)),
    // Distance entre le centre de l'orbe et le centre de la bouche. Assez bas
    // pour que le trait ne colle pas au bas des yeux : le visage respire.
    offsetY: Math.round(h * 0.95),
  };
}

/** Repli quand aucun œil n'est mesurable : proportions du diamètre de l'orbe. */
export const MOUTH_FALLBACK = { width: 0.145, height: 0.043, offsetY: 0.18 };

/**
 * Déformation de la barre : elle s'ouvre en hauteur et se resserre légèrement
 * en largeur, comme une bouche qui s'arrondit. Au repos (niveau 0) elle reste
 * la fine barre fermée, à l'échelle 1.
 *
 * L'ouverture est volontairement contenue : à plein niveau la bouche atteint
 * environ 12 px sur un orbe de 116, soit à peine plus que la largeur d'un œil.
 * Au-delà, elle mange le visage et l'orbe cesse de ressembler à Lumen.
 * @param {number} level 0–1
 */
export function mouthScale(level) {
  const l = Math.min(1, Math.max(0, level));
  return { x: 1 - l * 0.1, y: 1 + l * 1.5 };
}

/**
 * Opacité de la bouche pour un niveau donné.
 *
 * Au repos, la bouche est INVISIBLE : un trait fermé en permanence donnait un
 * visage figé, et l'orbe de Lumen n'a jamais eu de bouche au repos. Elle
 * apparaît dès que la voix la fait s'ouvrir et s'efface avec le silence.
 * @param {number} level 0–1
 */
export function mouthOpacity(level) {
  const l = Math.min(1, Math.max(0, level));
  return Math.min(1, l / 0.12);   // pleine opacité dès une ouverture franche
}
