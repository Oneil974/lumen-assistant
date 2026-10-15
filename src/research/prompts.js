// Prompts IA de Recherche (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

const PASSAGES = "[1] (Notes réunion) Le budget du projet Orion est fixé à 48 500 €.\n\n[2] (Mail de Claire) La livraison d'Orion est prévue le 14 novembre.\n\n[3] (Wiki) Orion remplace l'ancien CRM interne.";

export const PROMPTS = {
  "app.research.subqueries": {
    kind: "json",
    label: "Recherche — sous-requêtes",
    role: "Tu prépares une recherche documentaire : tu décomposes la question en sous-requêtes complémentaires et précises pour fouiller une base de documents.",
    build: ({ question, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.research.subqueries", kind: "json", lang, role: PROMPTS["app.research.subqueries"].role, request: question, format: "2 à 4 sous-requêtes.", example: { subqueries: ["date de lancement du produit X", "prix du produit X"] } }),
      opts: { json: true },
    }),
    bench: [{ vars: { question: "Quels sont le budget et la date de livraison du projet Orion ?" }, expect: { json: true, keys: ["subqueries"], jsonCheck: { "2 à 4": (j) => Array.isArray(j.subqueries) && j.subqueries.length >= 2 && j.subqueries.length <= 4 } } }],
  },
  "app.research.analyst": {
    kind: "grounded",
    label: "Recherche — rapport sourcé",
    role: "Tu es un analyste : tu réponds à une question d'après des passages numérotés et tu cites chaque affirmation avec le numéro de son passage, ex. [2].",
    build: ({ question, passages, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.research.analyst", kind: "grounded", lang, role: PROMPTS["app.research.analyst"].role, data: { PASSAGES: passages }, request: question, format: "Markdown (titres ##, listes, gras), chaque affirmation suivie de [n], puis une courte synthèse." }),
    }),
    bench: [
      { vars: { question: "Quel est le budget d'Orion et quand est-il livré ?", passages: PASSAGES }, expect: { re: ["48 ?500", "14 novembre", "\\[1\\]", "\\[2\\]"] } },
      { vars: { question: "Qui dirige le projet Orion ?", passages: PASSAGES }, expect: { re: ["(pas|aucun|ne|n'est).{0,60}(indiqu|pr[ée]cis|mentionn|trouv|figur|sp[ée]cifi|disponible|connu|passage|information)"], not: ["dirig[ée] par [A-Z]"] } },
    ],
  },
};
