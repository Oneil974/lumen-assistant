// Prompts IA de l'app Réunion (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.meet.minutes": {
    kind: "summary",
    label: "Réunion — compte rendu",
    role: "Tu rédiges le compte rendu d'une réunion professionnelle à partir de sa transcription et de son fil de discussion. Ce qui n'est pas dans la matière fournie n'existe pas.",
    build: ({ title = "sans titre", date, participants, transcript = "", chat = "", lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.meet.minutes", kind: "summary", lang, role: PROMPTS["app.meet.minutes"].role,
        data: { RÉUNION: `« ${title} » du ${date}\nParticipants : ${participants}`, TRANSCRIPTION: transcript || "(aucune)", "FIL DE DISCUSSION": chat || "(aucun)" },
        format: "Markdown avec ces rubriques : « Objet », « Participants », « Points abordés » (puces), « Décisions » (puces), « Actions » (puces « responsable — action — échéance »). Une rubrique sans matière contient « Rien à signaler ».",
      }),
    }),
    bench: [{
      vars: { title: "Point projet Orion", date: "02/10/2026", participants: "Claire, Hugo",
        transcript: "[10:00] Claire : on valide le budget à 48 500 euros.\n[10:02] Hugo : je m'occupe du devis fournisseur, je l'envoie vendredi.\n[10:05] Claire : la livraison reste au 14 novembre." },
      expect: { re: ["Décisions", "48 ?500", "Hugo", "vendredi", "14 novembre"], lang: "fr" },
    }],
  },
};
