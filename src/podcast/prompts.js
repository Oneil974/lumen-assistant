// Prompts IA de l'app Podcast (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const TONES = {
  chill: "détendu et complice, comme deux amis curieux",
  expert: "informé et précis, mais accessible et vivant",
  fun: "drôle et plein d'esprit, avec des piques bienveillantes",
  teacher: "pédagogique : on explique clairement, avec des exemples",
};

export const PROMPTS = {
  "app.podcast.episode": {
    kind: "creative",
    label: "Podcast — script d'un épisode",
    role: "Tu écris le script d'un podcast à deux voix : un vrai dialogue oral (questions, réactions, transitions), jamais une liste lue à voix haute, sans didascalies comme [rires].",
    build: ({ source, context = "", nameA = "Alex", nameB = "Sam", turns = 11, tone = TONES.expert, lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.podcast.episode", kind: "creative", lang, role: PROMPTS["app.podcast.episode"].role,
        data: { "DOCUMENTS DE L'UTILISATEUR": context, "SUJET OU SOURCE": source },
        request: `Hôtes : ${nameA} (speaker 0) et ${nameB} (speaker 1). Ton ${tone}. Environ ${turns} répliques alternées : ${nameA} ouvre par une accroche, ${nameB} conclut chaleureusement. Ne dis que ce que la source permet d'affirmer.`,
        format: "autant de répliques que demandé, en alternant speaker 0 et 1.", example: { title: "Pourquoi le ciel est bleu", turns: [{ speaker: 0, text: "Tu t'es déjà demandé pourquoi le ciel est bleu ?" }, { speaker: 1, text: "Souvent ! Et la réponse tient à la lumière du soleil." }] },
      }),
      opts: { json: true },
    }),
    bench: [{
      vars: { source: "Le télescope James Webb, lancé en décembre 2021, observe dans l'infrarouge. Il a photographié des galaxies formées 300 millions d'années après le Big Bang.", turns: 6 },
      expect: { json: true, keys: ["title", "turns"], jsonCheck: { "≥ 4 répliques": (j) => Array.isArray(j.turns) && j.turns.length >= 4, "deux voix": (j) => new Set((j.turns || []).map((t) => Number(t.speaker))).size === 2, "fidèle à la source": (j) => /infrarouge|2021|galax/i.test(JSON.stringify(j.turns)) } },
    }],
  },
};
