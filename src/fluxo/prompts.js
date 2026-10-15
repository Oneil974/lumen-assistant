// Prompts IA de Fluxo (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.fluxo.compose": {
    kind: "json",
    label: "Fluxo — composer un workflow",
    role: "Tu es FlowCraft, l'assistant de création de workflows Fluxo. Tu enchaînes uniquement des actions de la liste fournie, avec leurs clés de paramètres exactes. {{input}} désigne la demande de l'utilisateur, {{last}} la sortie du bloc précédent. Fais simple, robuste et compréhensible par un non-programmeur.",
    build: ({ request, actions }) => ({
      messages: buildPrompt({ id: "app.fluxo.compose", kind: "json", lang: "", role: PROMPTS["app.fluxo.compose"].role,
        data: { "ACTIONS DISPONIBLES (JSON)": typeof actions === "string" ? actions : JSON.stringify(actions) },
        request, format: "uniquement des ids de la liste, avec leurs clés de paramètres exactes et des valeurs réelles.", example: { name: "Veille du soir", steps: [{ action: "http_get", params: { url: "https://exemple.org/flux" } }, { action: "llm_infer", params: { prompt: "Résume : {{last}}" } }] } }),
      opts: { json: true },
    }),
    bench: [{ vars: { request: "Chaque matin, résume la météo de Lyon et envoie-la en notification.",
      actions: [
        { id: "weather_get", name: "Météo", params: [{ key: "city", kind: "text" }] },
        { id: "llm_infer", name: "IA", params: [{ key: "prompt", kind: "text" }] },
        { id: "notify_center", name: "Notification", params: [{ key: "title", kind: "text" }, { key: "body", kind: "text" }] },
        { id: "http_get", name: "Requête HTTP", params: [{ key: "url", kind: "text" }] },
      ] },
      expect: { json: true, keys: ["steps"], jsonCheck: { "ids connus seulement": (j) => (j.steps || []).length >= 2 && j.steps.every((st) => ["weather_get", "llm_infer", "notify_center", "http_get"].includes(st.action)), "finit par notifier": (j) => (j.steps || []).some((st) => st.action === "notify_center"), "Lyon en paramètre": (j) => /Lyon/.test(JSON.stringify(j.steps)) } } }],
  },
};
