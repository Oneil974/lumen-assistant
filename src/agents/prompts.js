// Prompts IA de l'Équipage (assistant de création d'agent). Lus aussi par le
// banc `npm run bench`.
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.agents.wizard": {
    kind: "json",
    label: "Équipage — configurer un agent à partir d'une demande",
    role: "Tu configures un agent personnel pour l'utilisateur de Lumen à partir de sa demande. name : deux mots au plus. description : une ligne, ce que l'agent fait pour l'utilisateur. instruction : le prompt système de l'agent, à la deuxième personne, concret, sans promesse qu'il ne peut pas tenir. native_tools : uniquement ce que la mission exige. permission_mode : « strict » si la mission touche des données sensibles, « trusted » si elle est anodine et répétitive, sinon « balanced ». tasks : une à quatre premières tâches concrètes. color et face : un avatar qui colle à sa personnalité.",
    build: ({ brief, tools = "(aucun)", rhythms = "", faces = "", schema }) => ({
      messages: buildPrompt({ id: "app.agents.wizard", kind: "json", lang: "", role: PROMPTS["app.agents.wizard"].role,
        data: { "OUTILS DISPONIBLES": tools, "RYTHMES ACCEPTÉS (valeur exacte)": rhythms, "HUMEURS D'AVATAR": faces },
        request: brief, format: "native_tools pris dans la liste fournie ; cron = une valeur exacte de la liste des rythmes ; dans la langue de la demande.", example: { name: "Veilleur prix", description: "Surveille le prix d'un article et te prévient s'il baisse.", instruction: "Tu surveilles le prix de l'article indiqué et tu signales toute baisse avec le nouveau prix et le lien.", color: "blue", face: "focused", native_tools: ["web_fetch"], permission_mode: "balanced", cron: "0 0 9 * * *", tasks: ["Relever le prix actuel de l'article"] } }),
      opts: { schema, schemaName: "lumen_agent_draft", json: true, think: false },
    }),
    bench: [{ vars: { brief: "Un agent qui me prépare chaque matin un résumé de mes mails non lus.",
      tools: "- mail_search : cherche dans les mails\n- mail_summarize : résume des mails\n- web_search : recherche web (sort de la machine)\n- sandbox_write_file : écrit un fichier",
      rhythms: '- "0 0 8 * * *" : chaque matin à 8 h\n- "" : à la demande', faces: "happy = joyeux, focused = concentré, calm = calme" },
      expect: { json: true, keys: ["name", "instruction", "native_tools", "cron"], jsonCheck: { "outils mail seulement": (j) => Array.isArray(j.native_tools) && j.native_tools.some((t) => /mail/.test(t)) && !j.native_tools.includes("web_search"), "chaque matin": (j) => j.cron === "0 0 8 * * *", "nom court": (j) => String(j.name || "").split(/\s+/).length <= 3 } } }],
  },
};
