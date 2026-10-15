// Prompts IA du Navigateur : volet de l'app (main.js) et barre native (chrome.js).
// Lus aussi par le banc `npm run bench`.
import { buildPrompt } from "../lib/prompt-kit.js";

const PAGE = "Titre : Lumen 0.2\n\nLumen 0.2 est sorti le 27 septembre 2026. Les applications sont désormais des paquets .lumenapp installables depuis le Catalogue. La licence Pro est retirée : seule l'édition Server reste payante. Le noyau embarque Fluxo, l'Équipage et l'Assistant.";

export const PROMPTS = {
  "app.browser.summary": {
    kind: "summary",
    label: "Navigateur — résumer la page",
    role: "Tu résumes des pages web fidèlement et de façon concise.",
    build: ({ page, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.browser.summary", kind: "summary", lang, role: PROMPTS["app.browser.summary"].role, data: { PAGE: page }, format: "Markdown : un court paragraphe, puis 3 à 5 puces commençant par « - »." }),
    }),
    bench: [{ vars: { page: PAGE }, expect: { re: ["27 septembre|0\\.2", "^\\s*[-*•] "], lang: "fr" } }],
  },
  "app.browser.qa": {
    kind: "grounded",
    label: "Navigateur — question sur la page",
    role: "Tu réponds à des questions sur une page web, d'après son contenu.",
    build: ({ page, question, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.browser.qa", kind: "grounded", lang, role: PROMPTS["app.browser.qa"].role, data: { PAGE: page }, request: question, format: "une réponse courte." }),
    }),
    bench: [
      { vars: { page: PAGE, question: "Quelle édition reste payante ?" }, expect: { re: ["Server"] } },
      { vars: { page: PAGE, question: "Quel est le prix de l'édition Server ?" }, expect: { re: ["(pas|aucun|ne|n'est).{0,60}(indiqu|pr[ée]cis|mentionn|trouv|figur|sp[ée]cifi|disponible|connu|passage|information)"], not: ["\\d+ ?(€|euros|\\$)"] } },
    ],
  },
  "app.browser.selection": {
    kind: "explain",
    label: "Navigateur — expliquer la sélection",
    role: "Tu expliques simplement un passage sélectionné dans une page web.",
    build: ({ text, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.browser.selection", kind: "explain", lang, role: PROMPTS["app.browser.selection"].role, data: { PASSAGE: text }, format: "Markdown court, avec un exemple." }),
    }),
    bench: [{ vars: { text: "Le taux d'intérêt directeur est le taux auquel les banques commerciales empruntent auprès de la banque centrale." }, expect: { re: ["banc|banque"], lang: "fr", maxChars: 1500 } }],
  },
  "app.browser.translate": {
    kind: "transform",
    label: "Navigateur — traduire",
    role: "Tu traduis fidèlement le texte d'une page web en gardant sa structure.",
    build: ({ text, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.browser.translate", kind: "transform", lang, role: PROMPTS["app.browser.translate"].role, data: { TEXTE: text }, format: "Markdown, même structure que l'original." }),
    }),
    bench: [{ vars: { text: "The new update ships next Tuesday. It fixes battery drain and adds dark mode." }, expect: { re: ["mardi", "batterie", "sombre"], lang: "fr" } }],
  },
  "app.browser.keypoints": {
    kind: "summary",
    label: "Navigateur — points clés",
    role: "Tu extrais les informations clés d'une page web : points essentiels, chiffres et conclusions.",
    build: ({ page, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.browser.keypoints", kind: "summary", lang, role: PROMPTS["app.browser.keypoints"].role, data: { PAGE: page }, format: "une liste à puces Markdown." }),
    }),
    bench: [{ vars: { page: PAGE }, expect: { re: ["^\\s*[-*•] ", "Server|\\.lumenapp|27 septembre"] } }],
  },
  "app.browser.compare": {
    kind: "grounded",
    label: "Navigateur — comparer les onglets",
    role: "Tu compares plusieurs pages web : leurs points de convergence et de divergence. Si elles ne traitent pas du même sujet, dis-le.",
    build: ({ page, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.browser.compare", kind: "grounded", lang, role: PROMPTS["app.browser.compare"].role, data: { PAGES: page }, format: "Markdown : un tableau convergences / divergences, puis un court paragraphe de synthèse." }),
    }),
    bench: [{ vars: { page: "[Onglet 1] Le train Paris-Lyon dure 2 h et coûte 60 €.\n\n[Onglet 2] Le trajet Paris-Lyon en train prend 2 h ; le billet coûte 45 € en semaine." },
      expect: { re: ["\\|", "2 ?h", "60|45"] } }],
  },
  "app.browser.translate-to": {
    kind: "transform",
    label: "Navigateur — traduire la page vers une langue",
    role: "Tu es un traducteur : tu traduis fidèlement le contenu principal d'une page web vers la langue demandée, en Markdown.",
    build: ({ page, target = "anglais" }) => ({
      messages: buildPrompt({ id: "app.browser.translate-to", kind: "transform", lang: "", role: PROMPTS["app.browser.translate-to"].role, data: { PAGE: page }, request: `Langue cible : ${target}.`, format: `le contenu traduit en ${target}, en Markdown.` }),
    }),
    bench: [{ vars: { page: "Le musée ouvre à 9 h et ferme à 18 h. L'entrée est gratuite le dimanche.", target: "anglais" }, expect: { re: ["museum", "Sunday", "free"], lang: "en" } }],
  },
};
