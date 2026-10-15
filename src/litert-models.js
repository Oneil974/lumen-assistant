// Catalogue des modèles LiteRT-LM (Google AI Edge), distribués par la
// communauté LiteRT sur Hugging Face en Apache 2.0, sans gating.
//
// Format `.litertlm` : ce n'est PAS du GGUF et llama.cpp ne sait pas le lire.
// Chaque dépôt publie plusieurs variantes du même modèle (`-gpu`, `-web`, et
// des déclinaisons par SoC Qualcomm/Intel/Tensor). Lumen ne référence que la
// variante CPU générique : c'est la seule que le Raspberry Pi sait exécuter, et
// proposer les autres reviendrait à faire télécharger 3 Go inutilisables.
//
// `sizeBytes` est la taille réelle du blob sur Hugging Face, relevée via son
// API — elle sert à vérifier la place disque avant de lancer.
export const LITERT_MODEL_CATALOG = [
  {
    id: "gemma-4-e2b-it",
    label: "Google Gemma 4 E2B",
    filename: "gemma-4-E2B-it.litertlm",
    description:
      "Le modèle de référence de LiteRT-LM sur Raspberry Pi 5 : environ 8 jetons par seconde en génération, pour 1,4 Go de mémoire au pic.",
    descriptionEn:
      "The reference LiteRT-LM model on Raspberry Pi 5: around 8 tokens per second when generating, for 1.4 GB peak memory.",
    about:
      "Par Google. Quantification mixte 2/4/8 bits propre à Gemma 4, conçue pour l'embarqué. Sur un Pi 5, comptez une réponse qui s'écrit à peu près deux fois plus vite qu'on ne parle — confortable en conversation, lent dès qu'un agent enchaîne les tours.",
    aboutEn:
      "By Google. A mixed 2/4/8-bit quantization specific to Gemma 4, designed for edge devices. On a Pi 5, expect text to appear about twice as fast as speech — comfortable for conversation, slow as soon as an agent chains several turns.",
    sizeLabel: "≈ 2,4 Go",
    sizeBytes: 2588147712,
    ramHint: "8 Go",
    url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm?download=true",
  },
  {
    id: "gemma-4-e4b-it",
    label: "Google Gemma 4 E4B",
    filename: "gemma-4-E4B-it.litertlm",
    description:
      "Le grand frère du E2B : nettement meilleur, mais il ne laisse presque rien à Lumen sur un Pi 8 Go et génère environ deux fois plus lentement.",
    descriptionEn:
      "The E2B's big sibling: clearly better, but it leaves almost nothing to Lumen on an 8 GB Pi and generates roughly twice as slowly.",
    about:
      "Par Google. À réserver aux Raspberry Pi 5 de 16 Go, ou aux machines Linux x86 : sur un Pi 8 Go, le modèle tient mais laisse trop peu de mémoire au reste du bureau.",
    aboutEn:
      "By Google. Best kept for 16 GB Raspberry Pi 5 boards, or x86 Linux machines: on an 8 GB Pi it fits but leaves too little memory for the rest of the desktop.",
    sizeLabel: "≈ 3,4 Go",
    sizeBytes: 3659530240,
    ramHint: "16 Go",
    url: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it.litertlm?download=true",
  },
];

/// Identifiant de registre attendu par `litert-lm` : le nom de fichier sans son
/// extension. Le backend Rust applique exactement la même règle — la dupliquer
/// ici évite un aller-retour rien que pour afficher le nom du modèle actif.
export function litertModelId(filename) {
  return String(filename || "").replace(/\.litertlm$/, "");
}
