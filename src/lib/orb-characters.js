// Characters are independent of UI palettes. Old theme IDs remain readable.
export const ORB_CHARACTERS = Object.freeze({
  default: { name: 'Original', en: 'Original', renderer: 'original', description: 'L’orbe de verre historique, avec ses couleurs personnalisables.', enDescription: 'The original glass orb with custom colours.' },
  'soft-white': { name: 'Nuage · blanc', en: 'Cloud · white', color: '#fafafa', shade: '#dedee5', eyes: '#171719', tempo: 5.4, tilt: 2, description: 'Calme et discret, une respiration douce.', enDescription: 'Calm and quiet, with gentle breathing.' },
  'soft-sky': { name: 'Azur · bleu', en: 'Azure · blue', color: '#a9ddff', shade: '#4396d4', eyes: '#11253a', tempo: 4.4, tilt: 5, description: 'Curieux, un regard attentif et un léger balancement.', enDescription: 'Curious, attentive eyes and a gentle sway.' },
  'soft-mint': { name: 'Sauge · vert', en: 'Sage · green', color: '#bdebd1', shade: '#58a982', eyes: '#16342a', tempo: 6.2, tilt: 1, description: 'Posé, avec une respiration lente.', enDescription: 'Grounded, with slow breathing.' },
  'soft-coral': { name: 'Braise · corail', en: 'Ember · coral', color: '#ffc0ae', shade: '#e6746b', eyes: '#3a191d', tempo: 3.8, tilt: 6, description: 'Vif, avec des réactions plus enjouées.', enDescription: 'Lively, with playful reactions.' },
  'soft-violet': { name: 'Iris · violet', en: 'Iris · violet', color: '#ddcaff', shade: '#9471d4', eyes: '#291b43', tempo: 5.8, tilt: 4, description: 'Rêveur, un flottement souple.', enDescription: 'Dreamy, with a soft floating motion.' },
  // Framboise : clin d'œil au Raspberry Pi, en rose framboise pastel.
  'soft-raspberry': { name: 'Framboise · rose', en: 'Raspberry · pink', color: '#ffc4d8', shade: '#d4547f', eyes: '#3d1424', tempo: 4.6, tilt: 4, description: 'Espiègle et tendre, un rebond léger.', enDescription: 'Playful and tender, with a light bounce.' },
  'soft-amber': { name: 'Miel · ambre', en: 'Honey · amber', color: '#ffe0a0', shade: '#d5a143', eyes: '#382816', tempo: 4.8, tilt: 3, description: 'Chaleureux, des mouvements ronds et accueillants.', enDescription: 'Warm, with rounded, welcoming movements.' },
});
const LEGACY = { raspberry: 'soft-raspberry', framboise: 'soft-raspberry', ice: 'soft-white', sky: 'soft-sky', navy: 'soft-sky', ardoise: 'soft-sky', emeraude: 'soft-mint', rubis: 'soft-coral', metalred: 'soft-coral', bordeaux: 'soft-coral', rose: 'soft-coral', violet: 'soft-violet', gold: 'soft-amber', amber: 'soft-amber', graphite: 'default', dark: 'default', accent: 'default' };
export function characterId(value) { return Object.hasOwn(ORB_CHARACTERS, value) ? value : LEGACY[value] || 'default'; }
export function character(value) { return ORB_CHARACTERS[characterId(value)]; }
