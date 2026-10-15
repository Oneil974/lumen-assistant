// Client partagé des bases de données Lumen (type Baserow).
// Réutilisé par l'app « Bases de données » ET par les intégrations (Data Analysis,
// Atelier ML, Recherche profonde). Wrappe les commandes Tauri `table_*` et offre
// un helper NL→SQL (lecture seule) qui s'appuie sur le backend LLM actif.
import { llmChat } from "../llm.js";
import { replyLang } from "../lib/prompt-lang.js";
import { PROMPTS } from "./prompts.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;

export const hasBackend = !!invoke;

// --- Bases ---
export const listBases = () => invoke("table_base_list");
export const createBase = (name) => invoke("table_base_create", { name });
export const renameBase = (baseId, name) => invoke("table_base_rename", { baseId, name });
export const deleteBase = (baseId) => invoke("table_base_delete", { baseId });

// --- Tables ---
export const listTables = (baseId) => invoke("table_list", { baseId });
export const createTable = (baseId, name, columns) => invoke("table_create", { baseId, name, columns });
export const renameTable = (tableId, name) => invoke("table_rename", { tableId, name });
export const deleteTable = (tableId) => invoke("table_delete", { tableId });
export const tableSchema = (tableId) => invoke("table_schema", { tableId });
export const baseSchema = (baseId) => invoke("table_base_schema", { baseId });

// --- Colonnes ---
export const addColumn = (tableId, name, colType) => invoke("table_column_add", { tableId, name, colType });
export const renameColumn = (colId, name) => invoke("table_column_rename", { colId, name });
export const retypeColumn = (colId, colType) => invoke("table_column_retype", { colId, colType });
export const deleteColumn = (colId) => invoke("table_column_delete", { colId });
// Métadonnées libres (JSON en chaîne) posées par DB Studio : contrainte
// « requis », valeur par défaut, options d'une liste, cible d'une relation,
// libellés du formulaire. Les autres apps les ignorent sans dommage.
export const setColumnMeta = (colId, meta) => invoke("table_column_meta", { colId, meta });
export const reorderColumns = (colIds) => invoke("table_column_reorder", { colIds });
export const setTableMeta = (tableId, meta) => invoke("table_meta_set", { tableId, meta });
export const getTableMeta = (tableId) => invoke("table_meta_get", { tableId });

// --- Lignes ---
export const rows = (tableId, limit, offset) => invoke("table_rows", { tableId, limit, offset });
export const insertRow = (tableId, values) => invoke("table_row_insert", { tableId, values });
export const updateRow = (tableId, rowId, values) => invoke("table_row_update", { tableId, rowId, values });
export const deleteRow = (tableId, rowId) => invoke("table_row_delete", { tableId, rowId });

// --- Connexions partagées (« Sources de données ») ---
// Une connexion dont le SQL libre est autorisé se présente comme une base de
// plus, d'identifiant `ds:<id>` : requête, schéma, NL→SQL et enquête marchent
// dessus sans que Reporting, Tables ou Analyse aient à la distinguer. La garde
// lecture seule est appliquée côté Rust (`datasources_query`).
export const CONNECTION_PREFIX = "ds:";
export const isConnection = (baseId) => String(baseId || "").startsWith(CONNECTION_PREFIX);
const connectionId = (baseId) => String(baseId).slice(CONNECTION_PREFIX.length);

/** Connexions partagées interrogeables en SQL, au format `{ base_id, name }`. */
export async function listSqlConnections() {
  try {
    return ((await invoke("datasources_list")) || [])
      .filter((s) => s.enabled !== false && s.allowSql)
      .map((s) => ({ base_id: CONNECTION_PREFIX + s.id, name: s.name || s.id, connection: true, kind: s.kind }));
  } catch { return []; }
}

/** Bases locales + connexions SQL partagées. */
export async function listQueryableBases() {
  let local = [];
  try { local = (await listBases()) || []; } catch { local = []; }
  return [...local, ...(await listSqlConnections())];
}

/** Dialecte à annoncer à l'IA pour une base. */
async function dialectOf(baseId) {
  if (!isConnection(baseId)) return "SQLite";
  const src = ((await invoke("datasources_list").catch(() => [])) || []).find((s) => s.id === connectionId(baseId));
  return { postgres: "PostgreSQL", mysql: "MySQL", mssql: "SQL Server", sqlite: "SQLite" }[src?.kind] || "SQL standard";
}

// --- Requête lecture seule (SELECT validé côté Rust) ---
export async function query(baseId, sql) {
  if (!isConnection(baseId)) return invoke("table_query", { baseId, sql });
  const page = await invoke("datasources_query", { id: connectionId(baseId), sql });
  const columns = page?.columns || [];
  const rows = (page?.rows || []).map((r) => (Array.isArray(r) ? r : columns.map((c) => r?.[c])));
  return { columns, rows };
}

// --- CSV ---
export const exportCsv = (tableId) => invoke("table_export_csv", { tableId });
export const importCsv = (baseId, name, csv) => invoke("table_import_csv", { baseId, name, csv });

// Construit une description du schéma d'une base, lisible par le LLM (noms de
// tables + colonnes + types), pour générer une requête SQL. `onlyTableIds`
// (optionnel) restreint la portée à un sous-ensemble de tables.
export async function schemaPrompt(baseId, onlyTableIds = null) {
  if (isConnection(baseId)) return connectionSchema(baseId);
  const sc = await baseSchema(baseId);
  let tables = sc?.tables || [];
  if (Array.isArray(onlyTableIds) && onlyTableIds.length) {
    const set = new Set(onlyTableIds);
    tables = tables.filter((t) => set.has(t.table_id));
  }
  if (!tables.length) return "(aucune table dans cette base)";
  return tables
    .map((t) => {
      const cols = (t.columns || []).map((c) => `"${c.name}" (${c.type})`).join(", ");
      return `Table "${t.name}" — ${t.rows} ligne(s) — colonnes : ${cols}`;
    })
    .join("\n");
}

async function connectionSchema(baseId) {
  const id = connectionId(baseId);
  const sets = (await invoke("datasources_datasets", { id }).catch(() => [])) || [];
  if (!sets.length) return "(aucune table visible sur cette connexion)";
  const out = [];
  for (const d of sets.slice(0, 40)) {
    const sc = await invoke("datasources_schema", { id, dataset: d.name }).catch(() => null);
    const cols = (sc?.columns || sc?.fields || []).map((c) => (typeof c === "string" ? `"${c}"` : `"${c.name}"${c.type ? ` (${c.type})` : ""}`));
    out.push(`Table "${d.name}"${d.rows != null ? ` — ${d.rows} ligne(s)` : ""}${cols.length ? ` — colonnes : ${cols.join(", ")}` : ""}`);
  }
  return out.join("\n");
}

// NL → SQL → exécution lecture seule. Renvoie { sql, columns, rows }.
// `onlyTableIds` (optionnel) limite les tables visibles par l'IA.
// La garde lecture seule finale est appliquée côté Rust (`table_query`).
export async function askAi(baseId, question, onlyTableIds = null) {
  const schema = await schemaPrompt(baseId, onlyTableIds);
  const dialect = await dialectOf(baseId);
  const { messages, opts } = PROMPTS["app.tables.nl2sql"].build({ question, schema, dialect, lang: replyLang() });
  const { content } = await llmChat(messages, { ...opts, rawSystem: true });
  let sql = "";
  try {
    sql = String(JSON.parse(content).sql || "").trim();
  } catch {
    // Repli : extraire un éventuel bloc SELECT brut.
    const m = String(content).match(/select[\s\S]+/i);
    sql = m ? m[0].trim() : "";
  }
  if (!sql) throw new Error("L'IA n'a pas produit de requête exploitable.");
  const res = await query(baseId, sql);
  return { sql, columns: res.columns || [], rows: res.rows || [] };
}

// Aperçu tabulé d'un résultat, borné pour ne pas saturer le contexte du modèle.
function previewRows(columns, rows, max = 50) {
  const head = (columns || []).join(" | ");
  const body = (rows || []).slice(0, max)
    .map((r) => r.map((v) => (v == null ? "" : String(v))).join(" | "))
    .join("\n");
  const more = (rows || []).length > max ? `\n… (${rows.length - max} ligne(s) de plus)` : "";
  return `${head}\n${body}${more}`;
}

// Enquête « aboutie » : l'IA peut enchaîner plusieurs requêtes SELECT (jusqu'à
// `maxSteps`) puis rédige une RÉPONSE TEXTUELLE en français. Renvoie
// { answer, steps: [{sql, columns, rows}] }. Lecture seule garantie par `query`.
export async function investigate(baseId, question, onlyTableIds = null, maxSteps = 3) {
  const schema = await schemaPrompt(baseId, onlyTableIds);
  const dialect = await dialectOf(baseId);
  const { messages } = PROMPTS["app.tables.investigate"].build({ question, schema, dialect, lang: replyLang() });
  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    const { content } = await llmChat(messages, { json: true, rawSystem: true });
    let parsed = {};
    try { parsed = JSON.parse(content); } catch {}
    if (parsed.answer && !parsed.sql) return { answer: String(parsed.answer), steps };
    let sql = String(parsed.sql || "").trim();
    if (!sql) {
      const m = String(content).match(/select[\s\S]+/i);
      sql = m ? m[0].trim() : "";
    }
    if (!sql) {
      if (steps.length) break; // on a déjà des données → on conclut plus bas
      throw new Error("L'IA n'a pas produit de requête exploitable.");
    }
    messages.push({ role: "assistant", content: JSON.stringify({ sql }) });
    try {
      const res = await query(baseId, sql);
      steps.push({ sql, columns: res.columns || [], rows: res.rows || [] });
      messages.push({
        role: "user",
        content: `Résultat :\n${previewRows(res.columns, res.rows)}\n\n` +
          'Si cela suffit, réponds {"answer":"..."}. Sinon, fais une autre requête.',
      });
    } catch (e) {
      messages.push({ role: "user", content: `Erreur SQL : ${e?.message || e}. Corrige la requête ou conclus avec {"answer":"..."}.` });
    }
  }
  // Budget d'étapes épuisé : on force une synthèse à partir des résultats obtenus.
  messages.push({ role: "user", content: 'Donne maintenant ta réponse finale en JSON {"answer":"..."} à partir des résultats déjà obtenus.' });
  const { content } = await llmChat(messages, { json: true, rawSystem: true });
  let answer = "";
  try { answer = String(JSON.parse(content).answer || ""); } catch { answer = String(content || ""); }
  return { answer: answer || "(pas de réponse)", steps };
}
