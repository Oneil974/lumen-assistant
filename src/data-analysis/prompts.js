// Prompts IA de Data Analysis (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.dataanalysis": {
    kind: "grounded",
    label: "Data Analysis — question sur le jeu de données",
    role: "Tu es un analyste de données rigoureux : tu réponds d'après le profil et l'échantillon d'un fichier CSV, avec prudence sur les limites des données.",
    build: ({ question, profile, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.dataanalysis", kind: "grounded", lang, role: PROMPTS["app.dataanalysis"].role,
        data: { "PROFIL ET ÉCHANTILLON (JSON)": profile }, request: question, format: "Markdown concis : la réponse chiffrée, puis ses limites." }),
    }),
    bench: [
      { vars: { question: "Quel mois a les meilleures ventes et lequel les pires ?", profile: JSON.stringify({ rows: 4, columns: [{ name: "mois", type: "text" }, { name: "ventes", type: "number", min: 60, max: 180, mean: 113.75 }], sample_rows: [["janvier", 120], ["février", 95], ["mars", 180], ["avril", 60]] }) }, expect: { re: ["mars", "avril"] } },
      { vars: { question: "Quelle est la marge par mois ?", profile: JSON.stringify({ rows: 4, columns: [{ name: "mois" }, { name: "ventes" }], sample_rows: [["janvier", 120], ["mars", 180]] }) }, expect: { re: ["(pas|aucun|ne).{0,80}(marge|colonne|donn|co[uû]t)"] } },
    ],
  },
  "app.dataanalysis.synthesis": {
    kind: "analysis",
    label: "Data Analysis — synthèse du fichier",
    role: "Tu es un analyste de données : tu fais la synthèse d'un fichier CSV d'après son profil et un échantillon.",
    build: ({ profile, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.dataanalysis.synthesis", kind: "analysis", lang, role: PROMPTS["app.dataanalysis.synthesis"].role,
        data: { "PROFIL ET ÉCHANTILLON (JSON)": profile }, format: "Markdown en 4 parties : 1) résumé exécutif, 2) signaux importants, 3) risques qualité, 4) prochaines analyses utiles." }),
    }),
    bench: [{ vars: { profile: JSON.stringify({ rows: 500, columns: [{ name: "ville", type: "text", missing_rate: 0.12, unique: 8 }, { name: "ventes", type: "number", min: 0, max: 98000, mean: 1200, median: 400 }] }) },
      expect: { re: ["manquant|12 ?%|0[,.]12", "asym|médiane|extrême|outlier|98 ?000"], lang: "fr" } }],
  },
  "app.dataanalysis.notes": {
    kind: "analysis",
    label: "Data Analysis — notes d'analyse",
    role: "Tu rédiges des notes d'analyse actionnables à partir du profil d'un fichier CSV.",
    build: ({ profile, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.dataanalysis.notes", kind: "analysis", lang, role: PROMPTS["app.dataanalysis.notes"].role,
        data: { "PROFIL ET ÉCHANTILLON (JSON)": profile }, format: "Markdown, titres courts, aucune phrase décorative." }),
    }),
    bench: [{ vars: { profile: JSON.stringify({ rows: 500, columns: [{ name: "ville", missing_rate: 0.12 }, { name: "ventes", min: 0, max: 98000, median: 400 }] }) }, expect: { re: ["^#|\n#|^\s*[-*•]|\n\s*[-*•]"], lang: "fr" } }],
  },
};
