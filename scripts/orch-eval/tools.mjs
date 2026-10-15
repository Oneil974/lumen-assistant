// Outils simulés communs aux bancs (orch-eval.mjs, lumen-bench.mjs).
export const TOOL_SPECS = [
  spec("weather_now", "Météo actuelle et prévisions d'un lieu", { place: "string" }, ["place"]),
  spec("app_data", "Données d'une application de Lumen (agenda, kanban, contacts, notes…)", { app: "string", query: "string" }, ["app"]),
  spec("day_overview", "Vue d'ensemble d'une journée : agenda, rappels, tâches, mails", { date: "string" }),
  spec("sandbox_search", "Recherche dans les fichiers des sandboxes de l'utilisateur", { query: "string" }, ["query"]),
  spec("search_documents", "Recherche dans le Corpus de documents indexés", { query: "string" }, ["query"]),
  spec("search_personal_data", "Recherche dans toutes les données personnelles", { query: "string" }, ["query"]),
  spec("web_search", "Recherche sur internet", { query: "string" }, ["query"]),
  spec("mail_search", "Recherche dans les mails", { query: "string" }, ["query"]),
  spec("memory_remember", "Mémorise une information sur l'utilisateur", { text: "string" }, ["text"]),
  spec("create_reminder", "Crée un rappel", { text: "string", when: "string" }, ["text"]),
  spec("data_search", "Recherche plein texte dans toutes les données de l'utilisateur (coffre unifié : notes, tâches, agenda, contacts, courriels, fichiers, santé de l'iPhone…)", { query: "string", type: "string", app: "string", period: "string" }),
  spec("data_agenda", "Planning chronologique de toutes les sources (Agenda, agenda et rappels de l'iPhone, Kanban, agents)", { period: "string", days: "integer", query: "string" }),
  spec("long_report", "Rapport annuel complet des projets (long)", { query: "string" }),
  spec("data_get", "Lit une fiche complète du coffre unifié par son id (texte, lien du fichier)", { id: "string" }, ["id"]),
  spec("data_metrics", "Mesures chiffrées : santé de l'iPhone (pas, sommeil, fréquence cardiaque), compteurs du coffre", { query: "string" }),
  spec("vault_list", "Liste les valeurs brutes du coffre clé → valeur", { prefix: "string" }),
  spec("ask_user", "Pose une question de clarification à l'utilisateur", { question: "string" }, ["question"]),
];
export function spec(name, description, props, required = []) {
  return {
    type: "function",
    function: {
      name, description,
      parameters: { type: "object", properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])), required },
    },
  };
}
