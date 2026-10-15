// Prompts IA du Kanban (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.kanban.card": {
    kind: "write",
    label: "Kanban — traitement IA d'une carte",
    role: "Tu traites une carte d'un tableau Kanban en suivant la consigne du tableau. Ta réponse est ajoutée en commentaire de la carte.",
    build: ({ instruction, title, desc = "", lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.kanban.card", kind: "write", lang, role: PROMPTS["app.kanban.card"].role,
        data: { "CONSIGNE DU TABLEAU": instruction, CARTE: `Tâche : ${title}${desc ? `\nDescription : ${desc}` : ""}` },
        format: "quelques lignes ou une courte liste, directement utilisables.",
      }),
    }),
    bench: [{
      vars: { instruction: "Analyse cette tâche et propose un plan d'action concret et actionnable. Sois bref et précis.", title: "Préparer la démo client", desc: "Démo de Lumen chez Acme jeudi à 14 h" },
      expect: { re: ["démo|demo", "jeudi|Acme|14"], lang: "fr", not: ["^voici"] },
    }],
  },
};
