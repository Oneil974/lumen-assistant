// Prompts IA de la Messagerie des agents (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.inbox.task": {
    kind: "json",
    label: "Messagerie — demande → tâche d'agent",
    role: "Tu transformes la demande d'un utilisateur en UNE tâche claire et actionnable pour un agent IA, et tu extrais sa date d'exécution si elle est donnée.",
    build: ({ request, today, lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.inbox.task", kind: "json", lang, role: PROMPTS["app.inbox.task"].role,
        data: { "DATE DU JOUR": today },
        request,
        format: "due au format AAAA-MM-JJ calculé depuis la date du jour (demain = date du jour + 1), ou null si aucune date n'est demandée.", example: { task: "Envoyer le devis signé au client Durand", due: "2026-01-16" },
      }),
      opts: { json: true },
    }),
    bench: [
      { vars: { request: "Peux-tu me préparer un résumé des ventes de septembre pour demain ?", today: "2026-10-02" },
        expect: { json: true, keys: ["task", "due"], jsonCheck: { "due = 2026-10-03": (j) => j.due === "2026-10-03", "tâche sans date": (j) => !/demain|2026/.test(j.task || "") } } },
      { vars: { request: "Range les factures du dossier Compta.", today: "2026-10-02" },
        expect: { json: true, keys: ["task"], jsonCheck: { "due = null": (j) => j.due == null || j.due === "null" } } },
    ],
  },
};
