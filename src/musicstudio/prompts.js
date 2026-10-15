// Prompts IA du Studio musical (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.musicstudio.spec": {
    kind: "json",
    label: "Studio musical — ambiance → morceau",
    role: "Tu es directeur musical : tu traduis une ambiance décrite en réglages de morceau cohérents (un tempo lent pour le calme, des couches nombreuses pour l'énergie).",
    build: ({ prompt, keys = ["C", "D", "E", "F", "G", "A", "B"], lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.musicstudio.spec", kind: "json", lang, role: PROMPTS["app.musicstudio.spec"].role,
        request: `Ambiance : ${prompt}`,
        format: "preset : Lofi, Synthwave, Ambient, Cinematic, Chiptune, House ou null ; tempo 60 à 160 ; scale : major, minor, dorian, lydian ou pentatonic ; energy de 0 à 1 ; layers à 0 ou 1.", example: { mood: "Nuit électrique", preset: "Synthwave", tempo: 118, key: "A", scale: "minor", energy: 0.7, layers: { drums: 1, bass: 1, chords: 1, arp: 1, lead: 0 } },
      }),
      opts: { json: true },
    }),
    bench: [{
      vars: { prompt: "Pluie douce un dimanche matin, café et lecture" },
      expect: { json: true, keys: ["tempo", "scale", "layers"], jsonCheck: { "tempo calme ≤ 100": (j) => Number(j.tempo) >= 60 && Number(j.tempo) <= 100, "énergie basse": (j) => Number(j.energy) <= 0.6 } },
    }],
  },
};
