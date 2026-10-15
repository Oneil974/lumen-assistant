// Intelligence hybride — une seule notion depuis le 08/10/2026 : l'ESCALADE
// vers l'API cloud. Les demandes tournent d'abord sur les modèles de ce poste ;
// quand une réponse locale échoue, Lumen propose de la rejouer sur l'API cloud
// configurée (clé `llmHybrid`, cf. llm.js › withApiEscalation). Rien ne part
// vers le cloud sans un clic.
//
// L'accès aux fichiers et les actions dans les apps ne sont plus des options :
// ils sont toujours disponibles (les écritures restent confirmées une à une).
// Les anciennes clés `hybridIntelligence`, `hybridFiles` et `hybridActions`
// sont ignorées.

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

/** État : fichiers et actions toujours actifs ; escalade cloud en opt-in. */
export function hybridState() {
  return { on: true, files: true, actions: true, local: read("llmHybrid") === "true" };
}

// ----- Classement des outils par pilier -----------------------------------

const FILE_TOOLS = new Set([
  "sandbox_list", "sandbox_search", "sandbox_read", "sandbox_read_file", "search_personal_data",
  "notes_search", "notes_read", "tables_list", "query_tables", "tables_query", "search_documents",
  "data_search", "data_get", "data_query", "data_list",
]);
const FILE_PREFIX = /^(sandbox_|data_)/;

const ACTION_TOOLS = new Set([
  // Écriture dans les apps (lib/app-write.js) et actions sur Lumen (system-actions.js).
  "kanban_add_card", "agenda_add_event", "notes_create", "notes_append",
  "lumen_open_app", "lumen_open_settings", "lumen_set_theme",
  // Objets, rappels, mémoire, documents et brouillons produits.
  "domotique_command", "create_reminder", "memory_remember", "export_pdf", "mail_brouillon",
]);
const ACTION_PREFIX = /^(agent_|doc_)/;

// Noms déclarés à l'exécution : intentions des apps installées, workflows
// Fluxo, outils des connecteurs MCP — leurs noms ne se devinent pas.
const registered = new Set();
export function registerActionTools(names) {
  for (const n of names || []) if (n) registered.add(String(n));
}

export function toolPillar(name) {
  const n = String(name || "");
  if (FILE_TOOLS.has(n) || FILE_PREFIX.test(n)) return "files";
  if (ACTION_TOOLS.has(n) || ACTION_PREFIX.test(n) || registered.has(n)) return "actions";
  return "";
}

/** Retire les outils des piliers coupés (aucun aujourd'hui : gardé pour le
 *  classement toolPillar, utile si un pilier redevient optionnel). */
export function filterHybridTools(tools) {
  const st = hybridState();
  if (st.files && st.actions) return tools;
  return (tools || []).filter((t) => {
    const p = toolPillar(t?.function?.name);
    return !(p === "files" && !st.files) && !(p === "actions" && !st.actions);
  });
}
