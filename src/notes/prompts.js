// Prompts IA de Notes (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.notes.write": {
    kind: "write",
    label: "Notes — rédiger",
    role: "Tu rédiges du contenu de note clair et bien structuré.",
    build: ({ request, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.notes.write", kind: "write", lang, role: PROMPTS["app.notes.write"].role, request, format: "Markdown (titres, listes si utile), sans préambule." }),
    }),
    bench: [{ vars: { request: "Écris une courte note sur les règles de sécurité d'un atelier bois (5 points)." }, expect: { lang: "fr", re: ["^\\s*([-*•]|\\d+[.)])|\\n\\s*([-*•]|\\d+[.)])"], not: ["^voici", "^bien sûr"] } }],
  },
  "app.notes.rewrite": {
    kind: "transform",
    label: "Notes — réécrire",
    role: "Tu réécris une note en suivant la consigne de l'utilisateur, sans perdre d'information.",
    build: ({ instruction, note, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.notes.rewrite", kind: "transform", lang, role: PROMPTS["app.notes.rewrite"].role, data: { NOTE: note }, request: instruction, format: "la note réécrite, en Markdown." }),
    }),
    bench: [{ vars: { instruction: "mets-la au propre en liste à puces", note: "acheter pain lait oeufs, appeler maman dimanche, rdv garage mardi 9h" },
      expect: { re: ["^\\s*[-*•]", "garage", "mardi"], not: ["^voici"], lang: "fr" } }],
  },
};
