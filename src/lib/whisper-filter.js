// Nettoyage des transcriptions Whisper, partagé par le bureau
// (whisper-dictation.js) et Lumen XR (xr-whisper.js, Whisper dans le casque).

// Phrases que Whisper (surtout base/tiny) INVENTE sur un silence ou un bruit :
// elles viennent des sous-titres de son corpus d'entraînement. Envoyées telles
// quelles, elles devenaient une question posée à Lumen.
const HALLUCINATIONS = [
  /sous-titr(es|age)[^.]*(amara|communaut|soci[ée]t[ée] radio-canada|st'? ?501)/i,
  /^merci d'avoir regard[ée]/i,
  /^(abonnez-vous|n'oubliez pas de vous abonner)/i,
  /^thanks? (you )?for watching/i,
  /^please subscribe/i,
  /^(\.+|…)$/,
];
export function dropWhisperHallucination(text) {
  const t = String(text || "").trim();
  if (HALLUCINATIONS.some((re) => re.test(t))) return "";
  // Boucle de répétition (« je je je je… ») : garder la première occurrence.
  return t.replace(/\b(\S+(?:\s+\S+){0,3}?)(?:[\s,.]+\1\b){3,}/gi, "$1");
}

/** Texte final : marqueurs non-parole retirés ([Musique], (toux)…), puis filtre. */
export function cleanTranscript(text) {
  return dropWhisperHallucination(String(text || "").replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim());
}
