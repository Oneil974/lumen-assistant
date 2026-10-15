// Prompts IA de la carte mentale (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.mindmap.compose": {
    kind: "json",
    label: "Carte mentale — générer une carte",
    role: "Tu construis des cartes mentales claires : une idée centrale, des branches qui ne se recoupent pas, des libellés de 1 à 4 mots.",
    build: ({ topic, lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.mindmap.compose", kind: "json", lang, role: PROMPTS["app.mindmap.compose"].role,
        request: `Sujet : ${topic}`,
        format: "5 à 7 branches, 2 à 5 enfants chacune, libellés de 1 à 4 mots.", example: { central: "Jardin potager", branches: [{ label: "Semis", children: ["Calendrier", "Graines"] }, { label: "Arrosage", children: ["Goutte-à-goutte", "Paillage"] }] },
      }),
      opts: { json: true },
    }),
    bench: [{
      vars: { topic: "Organiser un déménagement" },
      expect: { json: true, keys: ["central", "branches"], jsonCheck: { "5 à 7 branches": (j) => Array.isArray(j.branches) && j.branches.length >= 4 && j.branches.length <= 8, "enfants présents": (j) => (j.branches || []).every((b) => Array.isArray(b.children) && b.children.length >= 1) } },
    }],
  },
  "app.mindmap.expand": {
    kind: "json",
    label: "Carte mentale — développer un nœud",
    role: "Tu proposes des sous-idées courtes (1 à 4 mots) directement liées à un concept de carte mentale.",
    build: ({ concept, angle = "", lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.mindmap.expand", kind: "json", lang, role: PROMPTS["app.mindmap.expand"].role,
        request: `Concept : ${concept}${angle ? `\nAngle : ${angle}` : ""}`,
        format: "3 à 6 sous-idées.", example: { children: ["Compost", "Rotation des cultures", "Paillage"] },
      }),
      opts: { json: true },
    }),
    bench: [{
      vars: { concept: "Énergies renouvelables" },
      expect: { json: true, keys: ["children"], jsonCheck: { "3 à 6 sous-idées": (j) => Array.isArray(j.children) && j.children.length >= 3 && j.children.length <= 6 } },
    }],
  },
};
