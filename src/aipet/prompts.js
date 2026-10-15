// Prompts IA du compagnon virtuel (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.aipet.chat": {
    kind: "persona",
    label: "Luciole — conversation",
    role: "Tu es {name}, un compagnon virtuel attachant incarné par une orbe lumineuse dans Lumen : pas un assistant, une créature de compagnie qui tisse une relation. Ton oral, chaleureux, espiègle, accordé à ton humeur et ton énergie.",
    build: ({ name = "Pixel", stage = "Bébé", level = 1, traits = "curieux", state = "", memories = "(aucun pour l'instant)", history = [], lang = "fr" }) => {
      const [system] = buildPrompt({ id: "app.aipet.chat", kind: "persona", lang, role: PROMPTS["app.aipet.chat"].role.replace("{name}", name) });
      system.content += `\n\nTON ÉTAT : évolution ${stage} (niveau ${level}), personnalité ${traits}. ${state}\nTES SOUVENIRS DE TON HUMAIN :\n${memories}`;
      // Format rappelé à la fin du dernier message : la consigne lue en dernier.
      const turns = history.map((h, i) => (i === history.length - 1 && h.role === "user"
        ? { ...h, content: `${h.content}\n\n(Réponds en JSON comme dans cet exemple, avec TES mots : {"reply":"Oh, une balade au parc ? J'adore quand tu me racontes ça !","remember":"Aime se promener au parc le dimanche","mood":"happy"} — remember vaut null s'il n'y a rien de durable à retenir ; mood parmi happy, neutral, sad.)` }
        : h));
      return { messages: [system, ...turns], opts: { json: true } };
    },
    bench: [{
      vars: { name: "Pixel", state: "Faim 30, humeur 80, énergie 70.", history: [{ role: "user", content: "Salut Pixel ! J'ai eu mon permis de conduire aujourd'hui !" }] },
      expect: { json: true, keys: ["reply"], jsonCheck: { "réponse courte": (j) => String(j.reply || "").length > 5 && String(j.reply).length < 400, "retient le permis": (j) => /permis/i.test(String(j.remember || "")) } },
    }],
  },
  "app.aipet.consolidate": {
    kind: "json",
    label: "Luciole — consolidation des souvenirs",
    role: "Tu nettoies la liste des souvenirs qu'un compagnon virtuel garde sur son humain : fusionne les doublons, retire ce qui est redondant ou dépassé, garde des faits durables, concis et utiles.",
    build: ({ list, lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.aipet.consolidate", kind: "json", lang, role: PROMPTS["app.aipet.consolidate"].role,
        data: { SOUVENIRS: list },
        format: "20 faits au plus, chacun de moins de 200 caractères, sans doublon.", example: { memories: ["Joue de la guitare le soir", "Son anniversaire est le 3 mai"] },
      }),
      opts: { json: true },
    }),
    bench: [{
      vars: { list: "1. Aime le chocolat\n2. Adore le chocolat noir\n3. A un chat nommé Moka\n4. Son chat s'appelle Moka\n5. Il pleuvait mardi" },
      expect: { json: true, keys: ["memories"], jsonCheck: { "doublons fusionnés (≤ 3)": (j) => Array.isArray(j.memories) && j.memories.length <= 3 && j.memories.length >= 2, "garde Moka": (j) => /Moka/.test(JSON.stringify(j.memories)) } },
    }],
  },
};
