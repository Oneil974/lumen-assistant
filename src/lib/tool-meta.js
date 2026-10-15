// Métadonnées EXPLICITES des outils de l'IA : lecture seule ? résultat
// réutilisable, et combien de temps ? relance sans risque ?
//
// Rien n'est déduit du nom ou de la catégorie : « notes_append » se classait
// avec les lectures d'apps et se retrouvait en cache — deux ajouts identiques
// demandés à la suite ne produisaient qu'une écriture. Un outil absent de
// cette table est traité comme une ACTION : jamais mis en cache, jamais lancé
// en parallèle, jamais relancé automatiquement.
//
//   readOnly   : aucun effet de bord (peut tourner en parallèle d'autres lectures)
//   ttl        : durée de validité d'un résultat en cache (ms), 0 = jamais
//   idempotent : une relance après échec ne peut pas doubler l'effet

const MIN = 60e3;

/** Lectures, avec leur durée de cache. */
const READS = {
  // Données vivantes : quelques minutes.
  weather_now: 10 * MIN, sport_score: 2 * MIN, market_quote: 2 * MIN, exchange_rate: 10 * MIN,
  air_quality: 10 * MIN, news_headlines: 5 * MIN, time_now: 0,
  // Web.
  web_search: 5 * MIN, web_read_page: 5 * MIN, web_fetch: 5 * MIN,
  // Fichiers, connaissances, apps (lecture).
  sandbox_list: 2 * MIN, sandbox_list_files: 2 * MIN, sandbox_search: 2 * MIN, sandbox_read: 2 * MIN,
  sandbox_read_file: 2 * MIN, search_personal_data: 2 * MIN, search_documents: 2 * MIN, rag_search: 2 * MIN,
  notes_search: 2 * MIN, notes_read: 2 * MIN, tables_list: 2 * MIN, tables_schema: 2 * MIN,
  query_tables: 2 * MIN, tables_query: 2 * MIN, apps_list: 2 * MIN, app_data: 2 * MIN, apps_search: 2 * MIN,
  search_lumen_docs: 10 * MIN, lumen_search: 2 * MIN, memory_recall: 2 * MIN, day_overview: 2 * MIN,
  project_list_conversations: 2 * MIN, project_read_conversation: 2 * MIN,
  // Courrier (lecture ; le brouillon est une écriture).
  mail_boite: 2 * MIN, mail_lire: 2 * MIN, mail_rechercher: 2 * MIN, mail_trouver_info: 2 * MIN,
  mail_resumer: 2 * MIN, mail_list_messages: 2 * MIN, mail_read_message: 2 * MIN, mail_search: 2 * MIN,
  // Coffre unifié : l'iPhone y écrit souvent, cache court.
  data_get: 30e3, data_search: 30e3, data_overview: 30e3, data_agenda: 30e3, data_tasks: 30e3,
  data_metrics: 30e3, vault_get: 0, vault_list: 0, vault_overview: 0, vault_sources: 0, vault_source_get: 0, vault_schema: 0, vault_query: 0,
  // État d'appareils : lecture, mais il change à tout instant.
  domotique_list_devices: 2 * MIN, domotique_get_state: 0,
  // Demande à l'utilisateur : sans effet de bord, mais jamais en cache ni en parallèle.
  ask_user: 0,
};

/** Écritures qui peuvent être rejouées sans doubler l'effet (même valeur posée). */
const IDEMPOTENT_WRITES = new Set(["vault_set"]);

const extra = new Map();

/**
 * Déclare les métadonnées d'un outil hors de cette table (App Intents,
 * connecteurs MCP qui annoncent `readOnlyHint`…).
 */
export function registerToolMeta(name, meta = {}) {
  extra.set(String(name), {
    readOnly: !!meta.readOnly,
    ttl: meta.readOnly ? Math.max(0, Number(meta.ttl) || 0) : 0,
    idempotent: !!(meta.readOnly || meta.idempotent),
  });
}

/** @returns {{readOnly:boolean, ttl:number, idempotent:boolean}} */
export function toolMeta(name) {
  const n = String(name || "");
  if (extra.has(n)) return extra.get(n);
  if (Object.prototype.hasOwnProperty.call(READS, n)) return { readOnly: true, ttl: READS[n], idempotent: true };
  return { readOnly: false, ttl: 0, idempotent: IDEMPOTENT_WRITES.has(n) };
}

/** Peut tourner en parallèle d'autres lectures (ask_user reste en série). */
export const isParallelSafe = (name) => name !== "ask_user" && toolMeta(name).readOnly;

/** Une relance automatique après erreur passagère est sans risque. */
export const isRetrySafe = (name) => toolMeta(name).idempotent;

/**
 * Sérialisation STABLE et COMPLÈTE des arguments (clés triées à chaque
 * niveau). `JSON.stringify(args, Object.keys(args))` filtrait les clés
 * imbriquées : {filters:{status:"a"}} et {filters:{status:"b"}} donnaient
 * tous deux {"filters":{}} et partageaient un résultat.
 */
export function stableStringify(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
