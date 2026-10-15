// Prompts IA du lecteur PDF (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

const PAGE = "[Page 3]\nLa loi d'Ohm relie la tension U (en volts), l'intensité I (en ampères) et la résistance R (en ohms) : U = R × I. Une résistance de 10 Ω traversée par 2 A présente une tension de 20 V.";

export const PROMPTS = {
  "app.pdf.page": {
    kind: "explain",
    label: "PDF — expliquer la page",
    role: "Tu es un tuteur patient : tu expliques une page de cours à un étudiant (idées principales, définitions, un exemple concret).",
    build: ({ text, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.pdf.page", kind: "explain", lang, role: PROMPTS["app.pdf.page"].role, data: { PAGE: text }, format: "Markdown court." }),
    }),
    bench: [{ vars: { text: PAGE }, expect: { re: ["U ?= ?R|tension", "exemple|par exemple|ex\\."], lang: "fr" } }],
  },
  "app.pdf.part": {
    kind: "summary",
    label: "PDF — notes d'une partie (résumé long)",
    role: "Tu prends des notes fidèles sur UNE partie d'un document plus long, pour préparer son résumé.",
    build: ({ text, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.pdf.part", kind: "summary", lang, role: PROMPTS["app.pdf.part"].role, data: { PARTIE: text }, format: "4 à 6 puces factuelles (chiffres, noms, idées), rien d'autre." }),
    }),
    bench: [{ vars: { text: PAGE }, expect: { re: ["^\\s*[-*•]", "Ohm"], lang: "fr" } }],
  },
  "app.pdf.summary": {
    kind: "summary",
    label: "PDF — résumer le document",
    role: "Tu résumes un document PDF pour un lecteur pressé.",
    build: ({ text, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.pdf.summary", kind: "summary", lang, role: PROMPTS["app.pdf.summary"].role, data: { DOCUMENT: text }, format: "Markdown : 8 à 12 puces claires, puis « Notions clés » en liste." }),
    }),
    bench: [{ vars: { text: PAGE }, expect: { re: ["^\\s*[-*•]", "Ohm"], lang: "fr" } }],
  },
};
