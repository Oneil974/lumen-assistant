// Prompts IA de l'Atelier ML (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.ml": {
    kind: "analysis",
    label: "Atelier ML — lecture d'un entraînement",
    role: "Tu es un expert ML concis, pédagogique et actionnable. Tu analyses un entraînement de classification de texte (DistilBERT, tête linéaire, export ONNX FP32 puis quantification INT8 pour CPU).",
    build: ({ snapshot, report = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.ml", kind: "analysis", lang, role: PROMPTS["app.ml"].role,
        data: { "ÉTAT DE L'ATELIER": typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot, null, 2), "RAPPORT / MÉTRIQUES": report || "(aucun rapport : analyse l'état et les risques probables)" },
        format: "Markdown en 5 parties numérotées : 1. diagnostic court, 2. lecture des métriques, 3. risques de données et de validation, 4. recommandations priorisées, 5. impact attendu de l'export ONNX INT8 sur CPU." }),
    }),
    bench: [{ vars: { snapshot: { classes: ["spam", "ok"], examples: 120, class_counts: { spam: 100, ok: 20 }, epochs: 20 }, report: "train accuracy 0.99, validation accuracy 0.62" },
      expect: { re: ["surapprentissage|sur-apprentissage|overfitting|surajust", "déséquilibr|imbalanc|20"], lang: "fr" } }],
  },
};
