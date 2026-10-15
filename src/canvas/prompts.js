// Prompts IA du Canevas génératif (lus aussi par le banc `npm run bench`).
// Le « contexte » est le contenu du node parent (filiation) : une DONNÉE, donc
// placé dans le tour utilisateur, jamais mêlé à la consigne.
import { buildPrompt } from "../lib/prompt-kit.js";

const HEX = /^#[0-9a-f]{6}$/i;
const CTX = "CONTEXTE (élément parent ou projet)";

export const PROMPTS = {
  "app.canvas.text": {
    kind: "creative",
    label: "Canevas — texte",
    role: "Tu poursuis une exploration créative : tu produis la suite demandée en t'appuyant sur l'élément précédent, sans le répéter.",
    build: ({ prompt, context = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.canvas.text", kind: "creative", lang, role: PROMPTS["app.canvas.text"].role, data: { [CTX]: context }, request: prompt }),
    }),
    bench: [{ vars: { prompt: "Propose 3 noms pour cette marque.", context: "Marque de thé glacé artisanal, ton joyeux, cible 20-30 ans." }, expect: { re: ["\\n.*\\n|1[.)]|[-*•]"], lang: "fr", not: ["Marque de thé glacé artisanal, ton joyeux"] } }],
  },
  "app.canvas.charte": {
    kind: "json",
    label: "Canevas — charte graphique",
    role: "Tu es directeur artistique : tu conçois des chartes graphiques cohérentes (couleurs et typographie). Les polices sont des familles RÉELLES de Google Fonts (Inter, Poppins, Playfair Display, Montserrat, Lora, Space Grotesk…).",
    build: ({ prompt, context = "" }) => ({
      messages: buildPrompt({ id: "app.canvas.charte", kind: "json", lang: "", role: PROMPTS["app.canvas.charte"].role, data: { [CTX]: context }, request: prompt,
        format: "palette de 4 à 6 couleurs ; role parmi primary, secondary, accent, neutral, background ; polices Google Fonts réelles.", example: { name: "Atelier Céramique", mood: "Artisanal, terreux et lumineux.", fonts: { heading: "Playfair Display", body: "Lato" }, palette: [{ name: "Argile", hex: "#B5651D", role: "primary" }, { name: "Sable", hex: "#E8D5B7", role: "background" }, { name: "Olive", hex: "#6B7B3A", role: "secondary" }, { name: "Encre", hex: "#2B2B2B", role: "neutral" }], headings: { h1: { size: 40, weight: 700 }, h2: { size: 30, weight: 600 }, h3: { size: 22, weight: 600 } } } }),
      opts: { json: true },
    }),
    bench: [{ vars: { prompt: "Charte pour une librairie indépendante chaleureuse" },
      expect: { json: true, keys: ["fonts", "palette"], jsonCheck: { "4 à 6 couleurs hex": (j) => Array.isArray(j.palette) && j.palette.length >= 4 && j.palette.length <= 6 && j.palette.every((c) => HEX.test(c.hex || "")), "deux polices": (j) => !!(j.fonts?.heading && j.fonts?.body) } } }],
  },
  "app.canvas.jingle": {
    kind: "creative",
    label: "Canevas — jingle",
    role: "Tu écris des jingles publicitaires courts, rythmés et mémorables, qui se lisent ou se chantent bien à voix haute.",
    build: ({ prompt, context = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.canvas.jingle", kind: "creative", lang, role: PROMPTS["app.canvas.jingle"].role, data: { [CTX]: context }, request: prompt, format: "le texte du jingle seul : 2 à 4 lignes, sans guillemets ni didascalies." }),
    }),
    bench: [{ vars: { prompt: "Jingle pour une boulangerie de quartier qui ouvre à 6 h" }, expect: { maxChars: 320, not: ["^[\"«]", "\\[", "voici"], lang: "fr" } }],
  },
  "app.canvas.music": {
    kind: "json",
    label: "Canevas — identité sonore",
    role: "Tu es compositeur de jingles et sound designer façon Text-to-Music. Tu traduis une accroche de marque en mini identité sonore bouclable, jouable en MIDI et adaptée à une voix off : D'ABORD un musicPrompt riche (genre, instruments concrets adaptés au brief, énergie, structure intro → motif → résolution), PUIS un patch synthé dont le timbre imite l'instrument principal (cloche → triangle, filtre haut ; nappe → sine, attaque lente ; pluck/lead → square ou sawtooth, attaque très courte ; basse ronde → sine/triangle). Instruments selon la marque : luxe → piano feutré, cordes ; tech → synthés FM, arpèges ; enfance → cloches ; sport → basse punchy, cuivres ; nature → guitare douce, flûte.",
    build: ({ prompt, jingle = "", context = "", durationSec = 0 }) => {
      const dur = durationSec ? `~${Number(durationSec).toFixed(1)} s` : "la durée du jingle";
      const bars = durationSec ? `"bars" ≈ durée_s × tempo ÷ 240, notes étalées sur toute la durée` : `"bars" de 2 à 8`;
      return {
        messages: buildPrompt({ id: "app.canvas.music", kind: "json", lang: "", role: PROMPTS["app.canvas.music"].role,
          data: { [CTX]: context, BRIEF: prompt, "JINGLE VOIX": jingle, "DURÉE CIBLE": dur },
          request: `Compose l'identité sonore : ${bars}.`,
          format: "tempo 70 à 150 ; key parmi C, Db, D, Eb, E, F, Gb, G, Ab, A, Bb, B ; 12 à 32 notes de mélodie, 4 à 12 basses, 2 à 8 accords ; start et dur en temps.", example: { musicPrompt: "jingle acoustique chaleureux ~6 s : intro guitare folk, motif de ukulélé sautillant, résolution sur un accord majeur", instruments: ["guitare folk", "ukulélé", "shaker"], mood: "chaleureux", tempo: 104, key: "G", scale: "major", bars: 3, synthPrompt: "bright plucked ukulele", synth: { osc: "triangle", filter: 2200, attack: 0.005, release: 0.2, drive: 0.1, delay: 0.1 }, melody: [{ degree: 0, octave: 0, start: 0, dur: 0.5, velocity: 0.8 }, { degree: 2, octave: 0, start: 0.5, dur: 0.5, velocity: 0.7 }, { degree: 4, octave: 0, start: 1, dur: 1, velocity: 0.8 }], bass: [{ degree: 0, octave: -2, start: 0, dur: 2, velocity: 0.55 }], chords: [{ degrees: [0, 2, 4], start: 0, dur: 4, velocity: 0.28 }] } }),
        opts: { json: true },
      };
    },
    bench: [{ vars: { prompt: "Marque de glaces artisanales pour enfants", jingle: "Une boule, deux boules, la joie qui roule !", durationSec: 6 },
      expect: { json: true, keys: ["musicPrompt", "tempo", "melody"], jsonCheck: { "tempo 70-150": (j) => Number(j.tempo) >= 70 && Number(j.tempo) <= 150, "≥ 8 notes": (j) => Array.isArray(j.melody) && j.melody.length >= 8, "osc valide": (j) => ["sine", "triangle", "square", "sawtooth"].includes(j.synth?.osc) } } }],
  },
  "app.canvas.vision": {
    kind: "vision",
    label: "Canevas — analyse d'image",
    role: "Tu es directeur artistique : tu analyses une image (sujet, composition, couleurs dominantes en hex, ambiance, style) et proposes une direction artistique exploitable.",
    build: ({ prompt = "", image, context = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.canvas.vision", kind: "vision", lang, role: PROMPTS["app.canvas.vision"].role, data: { [CTX]: context }, request: prompt || "Analyse cette image et propose une direction artistique.", images: image ? [image] : undefined }),
    }),
    bench: [{ vars: { image: "@red-square", prompt: "Quelles sont les couleurs dominantes ?" }, expect: { re: ["rouge|red|#f|#e", "blanc|white|#fff"] }, vision: true }],
  },
  "app.canvas.mockup": {
    kind: "json",
    label: "Canevas — texte d'un visuel",
    role: "Tu es directeur artistique : à partir d'un brief et de la charte de marque, tu rédiges le TEXTE d'un visuel percutant.",
    build: ({ prompt, context = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.canvas.mockup", kind: "json", lang, role: PROMPTS["app.canvas.mockup"].role, data: { [CTX]: context }, request: prompt,
        format: "title de 6 mots au plus, subtitle de 14 mots au plus, cta de 4 mots au plus.", example: { eyebrow: "Nouveau", title: "Le vélo qui se plie", subtitle: "Léger, robuste et rangé en dix secondes sous votre bureau.", benefits: ["9 kg seulement", "Pliage en 10 s"], cta: "Essayer gratuitement", footer: "Fabriqué à Lyon" } }),
      opts: { json: true },
    }),
    bench: [{ vars: { prompt: "Affiche de lancement d'une appli de covoiturage entre voisins" },
      expect: { json: true, keys: ["title", "cta"], jsonCheck: { "titre ≤ 6 mots": (j) => String(j.title || "").split(/\s+/).filter(Boolean).length <= 7, "CTA ≤ 4 mots": (j) => String(j.cta || "").split(/\s+/).filter(Boolean).length <= 5 } } }],
  },
};
