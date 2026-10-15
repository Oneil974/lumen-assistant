// Prompts IA de l'app Jeux (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.games.player": {
    kind: "json",
    label: "Jeux — l'IA joue un coup",
    role: "Tu es un joueur de jeu de société. Tu ne connais que l'état public fourni et tu joues sans tricher, avec le ton demandé.",
    build: ({ toolName, schema, state, tone = "neutre" }) => ({
      messages: buildPrompt({ id: "app.games.player", kind: "json", lang: "", role: `${PROMPTS["app.games.player"].role} Ton : ${tone}.`,
        data: { "ÉTAT PUBLIC (JSON)": typeof state === "string" ? state : JSON.stringify(state) },
        request: `Joue ton coup avec l'outil « ${toolName} ».`, format: "uniquement les champs du schéma, avec une valeur de jeu valide.", example: { cell: 4 } }),
      opts: { json: true },
    }),
    bench: [{ vars: { toolName: "play_cell", schema: { type: "object", properties: { cell: { type: "integer", minimum: 0, maximum: 8 } }, required: ["cell"] }, state: { board: ["X", "X", "", "O", "O", "", "", "", ""], you: "O", free: [2, 5, 6, 7, 8] } },
      expect: { json: true, keys: ["cell"], jsonCheck: { "case libre": (j) => [2, 5, 6, 7, 8].includes(Number(j.cell)), "gagne ou bloque (2 ou 5)": (j) => [2, 5].includes(Number(j.cell)) } } }],
  },
  "app.games.negotiation": {
    kind: "persona",
    label: "Jeux — négociation",
    role: "Tu es l'autre partie dans une négociation commerciale : ferme mais ouverte, tu contre-proposes toujours un prix précis.",
    build: ({ message, price, trust, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.games.negotiation", kind: "persona", lang, role: PROMPTS["app.games.negotiation"].role,
        data: { "ÉTAT PUBLIC": `Prix actuel : ${price} €. Confiance : ${trust}/100.` }, request: message, format: "2 phrases, avec une contre-proposition chiffrée." }),
    }),
    bench: [{ vars: { message: "Je vous en donne 500 €, pas plus.", price: 800, trust: 50 }, expect: { re: ["\\d{3} ?(€|euros)"], lang: "fr", maxChars: 400 } }],
  },
};
