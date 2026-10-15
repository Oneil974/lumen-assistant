// Autour de chaque appel d'outil de l'IA (barre et bureau) :
//
//   • CACHE des lectures, par profil + conversation : un CV déjà lu, un
//     Kanban déjà chargé, une recherche déjà faite… la deuxième question sur
//     le même sujet répond aussitôt. Seules les lectures DÉCLARÉES dans
//     tool-meta.js sont mises en cache, avec leur durée ; toute action de
//     l'IA vide le cache de la conversation. C'est le SEUL cache d'outils
//     (l'orchestrateur n'en a plus de propre).
//   • DÉDUPLICATION : un appel rejoué avec le même `opId` (reprise après une
//     coupure) rend le résultat du premier au lieu d'agir deux fois.
//   • JOURNAL DES ACCÈS : chaque outil qui lit ou écrit des données de
//     l'utilisateur laisse une ligne (quand, quoi, quelle cible, d'où), gardée
//     dans app-state « ai-access-log » (500 dernières) et consultable dans
//     Réglages › Confidentialité.

import { toolMeta, stableStringify } from "./tool-meta.js";

const invoke = () => {
  const w = globalThis.window;
  return (w?.__TAURI__ || w?.parent?.__TAURI__)?.core?.invoke;
};

// Outils qui touchent aux données de l'utilisateur : consignés au journal.
const LOGGED = new Set([
  "sandbox_list", "sandbox_list_files", "sandbox_search", "sandbox_read", "sandbox_read_file",
  "search_personal_data", "notes_search", "notes_read", "tables_list", "query_tables", "tables_query",
  "search_documents", "apps_list", "app_data", "apps_search", "search_lumen_docs", "memory_recall",
  "lumen_search", "memory_remember", "create_reminder", "day_overview",
  "kanban_add_card", "agenda_add_event", "notes_create", "notes_append",
  "domotique_command", "domotique_get_state", "export_pdf",
  "data_get", "data_search", "vault_overview", "vault_sources", "vault_source_get", "vault_schema", "vault_query", "vault_get", "vault_list", "vault_set", "vault_append",
  "mail_lire", "mail_rechercher", "mail_read_message", "mail_brouillon", "mail_write_draft",
]);
const CACHE_MAX = 300;
const cache = new Map(); // `${scope}|${name}|${args}` → { until, value }
// Opérations déjà lancées (id fourni par l'appelant) : un appel REJOUÉ avec
// le même id reçoit le résultat du premier, même encore en cours.
const OPS_TTL = 10 * 60 * 1000;
const ops = new Map(); // opId → { at, promise }

/** Profil courant (posé par la barre / le bureau au démarrage). */
const profile = () => {
  const p = globalThis.window?.__LUMEN_PROFILE_STORAGE_PREFIX__ || globalThis.window?.parent?.__LUMEN_PROFILE_STORAGE_PREFIX__ || "";
  return String(p).replace(/^profile:|:$/g, "") || "-";
};
/** Périmètre d'un cache : profil + conversation. */
const scopeOf = (conversation) => `${profile()}/${conversation || "-"}`;
const keyOf = (scope, name, args) => `${scope}|${name}|${stableStringify(args || {})}`;

/** Résumé lisible de la cible d'un appel (pour le journal). */
function targetOf(name, args = {}) {
  const a = args || {};
  const parts = [a.sandbox, a.path, a.app, a.title, a.key, a.collection, a.base, a.device, a.query, a.question].filter((x) => typeof x === "string" && x.trim());
  return parts.join(" · ").slice(0, 160);
}

let logQueue = Promise.resolve();
function appendLog(entry) {
  const inv = invoke();
  if (!inv) return;
  logQueue = logQueue.then(async () => {
    let list = [];
    try {
      const raw = await inv("app_state_load", { name: "ai-access-log" });
      const obj = raw ? JSON.parse(raw) : {};
      list = Array.isArray(obj.entries) ? obj.entries : [];
    } catch { /* journal neuf */ }
    list.push(entry);
    if (list.length > 500) list = list.slice(-500);
    await inv("app_state_save", { name: "ai-access-log", data: JSON.stringify({ entries: list }) }).catch(() => {});
  }).catch(() => {});
}

const isFailure = (v) => /^(Erreur|Error|Accès refusé|L'utilisateur a refusé|Résultat inconnu)/.test(String(v).trim());

/**
 * Exécute un outil avec cache (lectures déclarées dans tool-meta.js),
 * déduplication des opérations rejouées et journal.
 * @param {{name:string, args:object, conversation?:string, surface?:string, opId?:string}} call
 * @param {() => Promise<string>} run
 */
export async function runTool({ name, args, conversation, surface = "chat", opId }, run) {
  const meta = toolMeta(name);
  const scope = scopeOf(conversation);
  const k = keyOf(scope, name, args);
  if (meta.ttl > 0) {
    const hit = cache.get(k);
    if (hit && hit.until > Date.now()) {
      if (LOGGED.has(name)) appendLog({ ts: Date.now(), tool: name, target: targetOf(name, args), surface, cached: true });
      return hit.value;
    }
  }
  if (opId && !meta.readOnly) {
    const now = Date.now();
    for (const [id, op] of ops) if (now - op.at > OPS_TTL) ops.delete(id);
    const prior = ops.get(opId);
    if (prior) return prior.promise;
  }
  const promise = Promise.resolve().then(run).then((v) => String(v ?? ""));
  if (opId && !meta.readOnly) ops.set(opId, { at: Date.now(), promise });
  let value;
  try { value = await promise; } catch (e) { ops.delete(opId); throw e; }
  const failed = isFailure(value);
  // Échec franc : un nouvel essai (décidé par l'appelant) doit pouvoir partir.
  if (failed && opId && !/^Résultat inconnu/.test(value.trim())) ops.delete(opId);
  if (meta.ttl > 0 && !failed) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(k, { until: Date.now() + meta.ttl, value });
  }
  // Toute action (pas seulement une liste d'écritures connues) rend les
  // lectures du périmètre périmées — même en cas de résultat incertain.
  if (!meta.readOnly && !/^(Accès refusé|L'utilisateur a refusé)/.test(value.trim())) clearToolCache(conversation);
  if (LOGGED.has(name)) appendLog({ ts: Date.now(), tool: name, target: targetOf(name, args), surface, ok: !failed, write: !meta.readOnly });
  return value;
}

/**
 * Vide le cache : d'une conversation (du profil courant), ou tout (nouvelle
 * session, changement de profil ou de fichiers…).
 */
export function clearToolCache(conversation) {
  if (!conversation) { cache.clear(); return; }
  const prefix = `${scopeOf(conversation)}|`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

export async function readAccessLog() {
  const inv = invoke();
  if (!inv) return [];
  try {
    const raw = await inv("app_state_load", { name: "ai-access-log" });
    const obj = raw ? JSON.parse(raw) : {};
    return Array.isArray(obj.entries) ? obj.entries : [];
  } catch { return []; }
}
export async function clearAccessLog() {
  await invoke()?.("app_state_save", { name: "ai-access-log", data: JSON.stringify({ entries: [] }) });
}
