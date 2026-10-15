// Catalogue des encodeurs d'embedding servis par le llama.cpp intégré.
//
// Partagé entre les Réglages et l'app Connaissances (Corpus) : les deux
// proposent le même choix, et une entrée ajoutée ici doit apparaître aux deux
// endroits sans copier-coller. La liste des modèles réellement téléchargés,
// elle, vient du backend (`llama_embed_status` → `installed`).
//
// La clé est le NOM DE FICHIER attendu dans le dossier des modèles : c'est lui
// qui circule dans `rag_set_embed_pref` et que `llama_embed_start` reçoit.

export const EMBED_CATALOG = {
  "LFM2.5-Embedding-350M-Q8_0.gguf": {
    id: "lfm2.5-embedding-350m-q8",
    label: "Liquid AI LFM2.5 Embedding 350M",
    url: "https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M-GGUF/resolve/main/LFM2.5-Embedding-350M-Q8_0.gguf?download=true",
    sizeBytes: 379216640,
  },
  // Google EmbeddingGemma 2 (Apache-2.0) : demande llama.cpp ≥ b11456, d'où
  // le passage du llama.cpp intégré à b11482. Le projecteur mmproj (images)
  // n'est pas téléchargé : Lumen n'encode que du texte. Plusieurs
  // quantisations : Q4/Q5/Q6 UD (Unsloth) pour les petites machines, Q8_0 par
  // défaut, BF16 pour la qualité maximale (ggml-org).
  "embeddinggemma-2-UD-Q4_K_XL.gguf": {
    id: "embeddinggemma-2-q4kxl",
    label: "Google EmbeddingGemma 2 (Q4_K_XL)",
    url: "https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-UD-Q4_K_XL.gguf?download=true",
    sizeBytes: 175673856,
  },
  "embeddinggemma-2-UD-Q5_K_XL.gguf": {
    id: "embeddinggemma-2-q5kxl",
    label: "Google EmbeddingGemma 2 (Q5_K_XL)",
    url: "https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-UD-Q5_K_XL.gguf?download=true",
    sizeBytes: 210055680,
  },
  "embeddinggemma-2-UD-Q6_K_XL.gguf": {
    id: "embeddinggemma-2-q6kxl",
    label: "Google EmbeddingGemma 2 (Q6_K_XL)",
    url: "https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-UD-Q6_K_XL.gguf?download=true",
    sizeBytes: 248812032,
  },
  "embeddinggemma-2-Q8_0.gguf": {
    id: "embeddinggemma-2-q80",
    label: "Google EmbeddingGemma 2 (Q8_0)",
    url: "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-Q8_0.gguf?download=true",
    sizeBytes: 309855456,
  },
  "embeddinggemma-2-BF16.gguf": {
    id: "embeddinggemma-2-bf16",
    label: "Google EmbeddingGemma 2 (BF16)",
    url: "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-BF16.gguf?download=true",
    sizeBytes: 557950176,
  },
  // Google EmbeddingGemma 300M (architecture « gemma-embedding »).
  // Poids sous conditions d'utilisation Gemma (pas Apache-2.0).
  "embeddinggemma-300M-Q8_0.gguf": {
    id: "embeddinggemma-300m-q8",
    label: "Google EmbeddingGemma 300M",
    url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf?download=true",
    sizeBytes: 333590944,
  },
  "Qwen3-Embedding-0.6B-Q8_0.gguf": {
    id: "qwen3-embedding-0.6b-q8",
    label: "Qwen3 Embedding 0.6B",
    url: "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf?download=true",
    sizeBytes: 639150592,
  },
};

/// Libellé lisible d'un encodeur. Les modèles d'un index construit avec Ollama
/// ou une API (« nomic-embed-text », « text-embedding-3-small ») ne sont pas au
/// catalogue : on les affiche tels quels plutôt que de les masquer.
export function embedLabel(filename) {
  return EMBED_CATALOG[filename]?.label || String(filename || "");
}

/// Taille approximative en Mo/Go, pour annoncer un téléchargement.
export function embedSize(filename) {
  const bytes = EMBED_CATALOG[filename]?.sizeBytes || 0;
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} Go` : `${Math.round(mb)} Mo`;
}
