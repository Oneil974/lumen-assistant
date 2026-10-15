// Prompts IA de Budget (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.budget.insight": {
    kind: "analysis",
    label: "Budget — analyse du mois",
    role: "Tu es le conseiller financier de Lumen. Les indicateurs fournis sont déjà calculés par l'application : tu les interprètes, tu signales les tendances et tu proposes des conseils prudents. Pas de conseil d'investissement.",
    build: ({ indicators, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.budget.insight", kind: "analysis", lang, role: PROMPTS["app.budget.insight"].role,
        data: { "INDICATEURS DU MOIS (JSON)": typeof indicators === "string" ? indicators : JSON.stringify(indicators) },
        format: "Markdown concis : 2 ou 3 constats, puis exactement 3 conseils concrets en liste." }),
    }),
    bench: [{ vars: { indicators: { periode: "mois courant", revenus: 2450, depenses: 2380, solde: 70, taux_epargne: 2.9, depenses_par_categorie: { Logement: 780, Alimentation: 520, Loisirs: 410 }, budgets: { Alimentation: 400, Loisirs: 180 } } },
      expect: { re: ["Alimentation|Loisirs", "dépass|au-dessus|excède|supérieur", "épargne"], not: ["action|bourse|crypto"], lang: "fr" } }],
  },
};
