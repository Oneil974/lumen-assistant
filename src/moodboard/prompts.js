// Prompts IA du Moodboard (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

const HEX = (s) => /^#?[0-9a-f]{6}$/i.test(String(s).trim());
const theme = (t) => `Thème : ${t}`;

export const PROMPTS = {
  "app.moodboard.brief": {
    kind: "creative",
    label: "Moodboard — brief créatif",
    role: "Tu es directeur de création : tu rédiges un brief créatif concis (ton, cible, intention, supports).",
    build: ({ topic, lang = "fr" }) => ({ messages: buildPrompt({ id: "app.moodboard.brief", kind: "creative", lang, role: PROMPTS["app.moodboard.brief"].role, request: theme(topic), format: "3 à 5 phrases, texte simple, sans titre." }) }),
    bench: [{ vars: { topic: "café de quartier écoresponsable" }, expect: { re: ["cible|public|client|s'adresse|habitants"], lang: "fr", maxChars: 1200, not: ["^#"] } }],
  },
  "app.moodboard.quote": {
    kind: "creative",
    label: "Moodboard — accroche",
    role: "Tu écris une accroche publicitaire évocatrice.",
    build: ({ topic, lang = "fr" }) => ({ messages: buildPrompt({ id: "app.moodboard.quote", kind: "creative", lang, role: PROMPTS["app.moodboard.quote"].role, request: theme(topic), format: "l'accroche seule : 2 à 4 mots, sans guillemets." }) }),
    bench: [{ vars: { topic: "café de quartier écoresponsable" }, expect: { maxChars: 60, not: ["^[\"«]", "voici"] } }],
  },
  "app.moodboard.palette": {
    kind: "json",
    label: "Moodboard — palette",
    role: "Tu es coloriste : tu proposes une palette de 5 couleurs cohérentes avec un thème.",
    build: ({ topic }) => ({ messages: buildPrompt({ id: "app.moodboard.palette", kind: "json", lang: "", role: PROMPTS["app.moodboard.palette"].role, request: theme(topic), format: "exactement 5 codes hexadécimaux.", example: { palette: ["#1B4D3E", "#F2C14E", "#F78154", "#4D9078", "#B4436C"] } }), opts: { json: true } }),
    bench: [{ vars: { topic: "forêt d'automne" }, expect: { json: true, keys: ["palette"], jsonCheck: { "5 couleurs hex": (j) => Array.isArray(j.palette) && j.palette.filter(HEX).length === 5 } } }],
  },
  "app.moodboard.font": {
    kind: "transform",
    label: "Moodboard — typographie",
    role: "Tu suggères UNE police d'affichage élégante adaptée à un thème.",
    build: ({ topic }) => ({ messages: buildPrompt({ id: "app.moodboard.font", kind: "transform", lang: "", role: PROMPTS["app.moodboard.font"].role, request: theme(topic), format: "le nom de la police seul." }) }),
    bench: [{ vars: { topic: "magazine de mode années 70" }, expect: { maxChars: 40, not: ["\\.\\s+\\w", "voici"] } }],
  },
  "app.moodboard.board": {
    kind: "json",
    label: "Moodboard — direction artistique complète",
    role: "Tu es directeur artistique : à partir d'un thème, tu fixes la direction d'un moodboard cohérent (titre, mots-clés, brief, accroche, police, palette, prompts d'images).",
    build: ({ topic, count = 4 }) => ({
      messages: buildPrompt({ id: "app.moodboard.board", kind: "json", lang: "", role: PROMPTS["app.moodboard.board"].role, request: theme(topic),
        format: "palette de 5 couleurs hexadécimales ; imagePrompts en anglais, au nombre demandé.", example: { title: "Marée basse", tags: "iode · lin · calme", brief: "Une marque de linge de maison inspirée des côtes bretonnes.", quote: "Respirer\nle large", font: "Cormorant Garamond", palette: ["#2E4A62", "#DCE3E8", "#C9A66B", "#F5F1EA", "#7A8B8C"], imagePrompts: ["linen sheets drying on a line by the sea, soft morning light", "close-up of seashells on wet sand, muted tones"] } }),
      opts: { json: true },
    }),
    bench: [{ vars: { topic: "voyage au Japon en train", count: 3 },
      expect: { json: true, keys: ["title", "palette", "imagePrompts"], jsonCheck: { "5 couleurs": (j) => Array.isArray(j.palette) && j.palette.filter(HEX).length === 5, "3 prompts en anglais": (j) => Array.isArray(j.imagePrompts) && j.imagePrompts.length === 3 && /\b(the|a|with|of|train|japan)\b/i.test(j.imagePrompts.join(" ")) } } }],
  },
};
