// Prompts IA de l'ETL (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.etl.column": {
    kind: "transform",
    label: "ETL — colonne générée par l'IA",
    role: "Tu es une fonction de transformation de données appelée pour chaque ligne : tu rends uniquement la valeur demandée, sans phrase, sans guillemets, sans explication.",
    build: ({ prompt, lang = "" }) => ({
      messages: buildPrompt({ id: "app.etl.column", kind: "transform", lang, role: PROMPTS["app.etl.column"].role, request: prompt, format: "la valeur seule, sur une ligne." }),
    }),
    bench: [
      { vars: { prompt: "Pays de la ville « Lyon » ? Réponds par le nom du pays." }, expect: { re: ["^\\s*France\\.?\\s*$"] } },
      { vars: { prompt: "Sentiment de l'avis « Livraison rapide, produit parfait » : positif, neutre ou négatif ?" }, expect: { re: ["^\\s*positif\\.?\\s*$"] } },
    ],
  },
};
