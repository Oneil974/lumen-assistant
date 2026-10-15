// Prompts IA transverses : résumé et compaction des conversations, OCR, vision,
// étiquettes XR, assistant des apps AppKit. Lus aussi par le banc `npm run bench`
// (une image de test « @red-square » y remplace la capture réelle).
import { buildPrompt } from "./prompt-kit.js";

const CONVO = "Utilisateur : Je cherche une idée de dîner pour 6 personnes samedi.\n\nAssistant : Un gratin dauphinois avec une salade verte.\n\nUtilisateur : Il y a un végétarien, et je n'ai pas de four.\n\nAssistant : Alors un risotto aux champignons, à la poêle.\n\nUtilisateur : Parfait, il me faut la liste de courses.";

/** Transcription d'une conversation pour les résumés (texte, sans appels d'outils). */
export function transcriptOf(history = [], max = 12000) {
  return history
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && !m.tool_calls)
    .map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.display || m.content}`)
    .join("\n\n")
    .slice(0, max); // au-delà, on dépasse le contexte des petits modèles locaux
}

export const PROMPTS = {
  "core.conversation.summary": {
    kind: "summary",
    label: "Conversations — résumé",
    role: "Tu résumes une discussion entre un utilisateur et son assistant : la demande, la décision FINALE (une proposition remplacée par une autre ne compte plus) et ce qui reste à faire. Nomme les éléments concrets (choix retenus, noms, nombres, contraintes) au lieu de rester général.",
    build: ({ transcript, lang = "fr" }) => ({
      messages: buildPrompt({ id: "core.conversation.summary", kind: "summary", lang, role: PROMPTS["core.conversation.summary"].role,
        data: { DISCUSSION: transcript }, format: "4 phrases au plus, texte simple, sans titre ni liste, avec les éléments concrets." }),
    }),
    bench: [{ vars: { transcript: CONVO }, expect: { re: ["risotto", "végétarien|four", "courses"], not: ["^#", "^\\s*[-*•]"], maxChars: 700, lang: "fr" } }],
  },
  "core.conversation.memo": {
    kind: "summary",
    label: "Conversations — note de mémoire (compaction)",
    role: "Tu écris la note de mémoire d'une discussion pour un assistant qui va la poursuivre sans voir les messages : chaque fait, décision, nom, chiffre et question en suspens utile pour la suite ; ni politesses ni répétitions.",
    build: ({ transcript, previous = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "core.conversation.memo", kind: "summary", lang, role: PROMPTS["core.conversation.memo"].role,
        data: { "NOTE PRÉCÉDENTE (début de la discussion, à reprendre intégralement)": previous, DISCUSSION: transcript },
        request: "Écris la note : recopie d'abord les faits de la note précédente, puis ajoute chaque fait utile de la discussion (qui, combien, contraintes, décision, ce qui reste à faire).",
        format: "une ligne par fait, commençant par « - » : d'abord ceux de la note précédente, puis chaque fait, contrainte, chiffre et décision de la discussion. 15 lignes au plus." }),
    }),
    bench: [{ vars: { transcript: CONVO, previous: "L'utilisateur s'appelle Nadia et reçoit chez elle à Lille." },
      expect: { re: ["6|six", "végétarien", "four", "risotto", "Nadia|Lille"], lang: "fr" } }],
  },
  "core.ocr": {
    kind: "vision",
    label: "OCR — transcrire une page",
    role: "Tu transcris FIDÈLEMENT tout le texte visible sur une page, dans l'ordre de lecture, sans rien résumer. Garde les titres, listes et tableaux (en Markdown si utile).",
    build: ({ image, lang = "fr" }) => ({
      messages: buildPrompt({ id: "core.ocr", kind: "vision", lang: "", role: PROMPTS["core.ocr"].role, images: [image],
        request: lang === "en" ? "Transcribe this page." : "Transcris cette page.",
        format: lang === "en" ? "the text only; if the page has no text, exactly: (page without text)." : "le texte seul ; si la page ne contient aucun texte, exactement : (page sans texte)." }),
      opts: { think: false, maxTokens: 1800 },
    }),
    bench: [{ vars: { image: "@red-square" }, expect: { re: ["\\(page sans texte\\)"] }, vision: true }],
  },
  "core.vision.describe": {
    kind: "vision",
    label: "Vision — décrire une image (indexation)",
    role: "Tu décris une image précisément et complètement pour qu'on puisse la retrouver par une recherche : sujet, texte visible, chiffres, disposition, couleurs.",
    build: ({ image, lang = "fr" }) => ({
      messages: buildPrompt({ id: "core.vision.describe", kind: "vision", lang, role: PROMPTS["core.vision.describe"].role, images: [image], request: "Décris cette image.", format: "texte simple, sans préambule." }),
    }),
    bench: [{ vars: { image: "@red-square" }, expect: { re: ["rouge", "carré|square"], lang: "fr" }, vision: true }],
  },
  "core.vision.query": {
    kind: "vision",
    label: "Vision — requête web pour une image",
    role: "Tu formules une requête de recherche web courte sur ce que montre une image.",
    build: ({ image, lang = "fr" }) => ({
      messages: buildPrompt({ id: "core.vision.query", kind: "vision", lang, role: PROMPTS["core.vision.query"].role, images: [image], request: "Requête pour cette image.", format: "une seule requête de 8 mots au plus, sans guillemets." }),
      opts: { think: false },
    }),
    bench: [{ vars: { image: "@red-square" }, expect: { re: ["rouge|red|carré|square"], maxChars: 80, not: ["^[\"«]"] }, vision: true }],
  },
  "core.xr.labels": {
    kind: "vision",
    label: "Lumen XR — étiqueter les objets visibles",
    role: "Tu repères jusqu'à 6 objets distincts et utiles sur une image, avec la position de leur centre en fraction de la largeur et de la hauteur (0 = gauche/haut).",
    build: ({ image, lang = "fr" }) => ({
      messages: buildPrompt({ id: "core.xr.labels", kind: "json", lang, role: PROMPTS["core.xr.labels"].role, images: [image], request: "Liste les objets visibles.", format: "6 objets au plus ; x et y entre 0 et 1.", example: [{ label: "tasse", x: 0.31, y: 0.62 }, { label: "clavier", x: 0.55, y: 0.8 }] }),
      opts: { maxTokens: 300, think: false },
    }),
    bench: [{ vars: { image: "@red-square" }, expect: { json: true, jsonCheck: { "centre ≈ 0,5": (j) => Array.isArray(j) && j.some((o) => Math.abs(+o.x - 0.5) < 0.25 && Math.abs(+o.y - 0.5) < 0.25) } }, vision: true }],
  },
  "core.xr.translate": {
    kind: "transform",
    label: "Lumen XR — traduire un texte lu par le casque (OCR)",
    role: "Tu traduis fidèlement un texte lu sur un objet réel (menu, panneau, notice), en gardant les lignes, les prix et les chiffres.",
    build: ({ text, target = "français", lang = "fr" }) => ({
      messages: buildPrompt({ id: "core.xr.translate", kind: "transform", lang, role: PROMPTS["core.xr.translate"].role,
        data: { "TEXTE LU": text }, request: `Traduis ce texte en ${target}. S'il est déjà en ${target}, recopie-le.`, format: "le texte traduit seul, ligne par ligne." }),
      // Marge pour un modèle « Thinking » (son raisonnement compte dans le plafond).
      opts: { maxTokens: 2048, think: false },
    }),
    bench: [{ vars: { text: "Soup of the day 6.50\nGrilled salmon with lemon 18.00\nChocolate cake 7.00", target: "français" }, expect: { re: ["saumon", "18", "chocolat|g[âa]teau"], lang: "fr", not: ["^voici"] } }],
  },
  "core.appkit.assistant": {
    kind: "grounded",
    label: "Apps (AppKit) — assistant intégré",
    role: "Tu assistes l'utilisateur dans l'application « {app} », d'après le contexte qu'elle te transmet.",
    build: ({ app, question, context = null, lang = "fr" }) => ({
      messages: buildPrompt({ id: "core.appkit.assistant", kind: "grounded", lang, role: PROMPTS["core.appkit.assistant"].role.replace("{app}", app),
        data: { "CONTEXTE DE L'APP (JSON)": context ? JSON.stringify(context) : "" }, request: String(question), format: "une réponse brève." }),
    }),
    bench: [{ vars: { app: "Recettes", question: "Combien de temps de cuisson pour cette recette ?", context: { recette: "Clafoutis", cuisson_min: 35, four: "180 °C" } }, expect: { re: ["35"], lang: "fr", maxChars: 500 } }],
  },
};
