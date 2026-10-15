// Prompts IA du jeu d'aventure (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.adventure.scene": {
    kind: "creative",
    label: "Aventures — scène suivante",
    role: "Tu es le maître du jeu d'un jeu de rôle textuel immersif. Tu écris à la 2e personne (« tu ») et chaque scène fait avancer l'histoire de façon cohérente avec ce qui précède et avec le contexte imposé.",
    build: ({ action, summary = "", strongContext = "", lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.adventure.scene", kind: "creative", lang, role: PROMPTS["app.adventure.scene"].role,
        data: {
          "CONTEXTE IMPOSÉ (prioritaire : si le joueur le contredit, garde la cohérence et adapte la conséquence)": strongContext,
          "HISTOIRE JUSQU'ICI": summary || "(début)",
        },
        request: action,
        format: "narration de 2 à 4 phrases à la 2e personne (« tu ») ; image_prompt en anglais ; 3 choix ; summary de toute l'histoire en 2-3 phrases.", example: { narration: "Tu pousses la grille rouillée : le jardin est envahi de ronces et une lanterne brille au fond.", image_prompt: "overgrown garden at dusk, glowing lantern, storybook illustration", choices: ["Suivre la lanterne", "Fouiller les ronces", "Appeler à voix haute"], summary: "Tu explores un manoir abandonné et viens d'entrer dans son jardin." },
      }),
      opts: { json: true },
    }),
    bench: [{
      vars: { action: "Le joueur décide : « j'ouvre la porte du phare ». Décris ce qui se passe ensuite.", summary: "Tu es une gardienne de phare sur une île bretonne. Une tempête approche et la lumière s'est éteinte." },
      expect: { json: true, keys: ["narration", "choices", "summary"], jsonCheck: { "3 choix": (j) => Array.isArray(j.choices) && j.choices.length >= 2 && j.choices.length <= 4, "2e personne": (j) => /\btu\b|\bte\b|\bton\b|\bta\b/i.test(j.narration || ""), "cohérent (phare)": (j) => /phare|porte|lumi|tempête/i.test(j.narration || "") } },
    }],
  },
};
