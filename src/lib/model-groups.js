// Familles de modèles, façon bibliothèque Ollama : chaque modèle des catalogues
// (GGUF llama.cpp, Ollama, image Bonsai) range dans UN groupe principal, et
// garde ses tags (vision, outils, raisonnement…) comme étiquettes secondaires.
// Partagé par les Réglages (catalog-picker) et l'app Catalogue.

/// Ordre d'affichage des groupes. Le premier test qui passe l'emporte : un
/// modèle de code multimodal reste « Vision », un modèle de décision qui
/// raisonne reste « Décision ».
export const MODEL_GROUPS = [
  { id: "chat", fr: "Discussion", en: "Chat", test: () => false },
  { id: "decision", fr: "Décision", en: "Decision", test: (m) => m.tags?.includes("decision") },
  { id: "embedding", fr: "Embedding", en: "Embedding", test: (m) => m.tags?.includes("embedding") },
  { id: "image", fr: "Image", en: "Image", test: (m) => m.kind === "image" },
  { id: "ocr", fr: "OCR", en: "OCR", test: (m) => m.tags?.includes("ocr") },
  { id: "vision", fr: "Vision", en: "Vision", test: (m) => m.tags?.includes("vision") || Boolean(m.mmprojFilename) },
  { id: "code", fr: "Code", en: "Code", test: (m) => m.tags?.includes("code") },
  { id: "reasoning", fr: "Raisonnement", en: "Reasoning", test: (m) => m.tags?.includes("reasoning") },
];

const ORDER = ["chat", "reasoning", "ocr", "vision", "code", "decision", "embedding", "image"];

/// Groupe principal d'un modèle de catalogue.
export function modelGroup(model) {
  const hit = MODEL_GROUPS.slice(1).find((g) => g.test(model));
  return hit?.id || "chat";
}

export function modelGroupLabel(id, lang) {
  const g = MODEL_GROUPS.find((x) => x.id === id);
  return g ? (lang === "en" ? g.en : g.fr) : id;
}

export function modelGroupOrder(id) {
  const i = ORDER.indexOf(id);
  return i < 0 ? ORDER.length : i;
}

/// Étiquettes (tags) lisibles, vocabulaire commun aux deux écrans.
const TAG_LABELS = {
  ocr: ["OCR", "OCR"],
  tools: ["Appel d'outils", "Tools"],
  vision: ["Vision", "Vision"],
  reasoning: ["Raisonnement", "Thinking"],
  think: ["Réflexion", "Thinking"],
  code: ["Code", "Code"],
  multilingual: ["Multilingue", "Multilingual"],
  embedding: ["Embedding", "Embedding"],
  decision: ["Décision", "Decision"],
  image: ["Image", "Image"],
  local: ["Local", "Local"],
};

export function modelTagLabel(tag, lang) {
  const l = TAG_LABELS[tag];
  return l ? l[lang === "en" ? 1 : 0] : String(tag);
}
