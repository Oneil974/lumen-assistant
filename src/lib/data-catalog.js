// Navigateur de sources commun à l'espace Données : les tables des Bases
// locales ET les connexions déclarées une seule fois dans « Sources de
// données » (bases externes, fichiers, API). Analyse, ETL, Reporting… y lisent
// au lieu de réinventer chacun sa liste — une connexion se configure une fois.
import * as tablesDb from "../tables/client.js";

const call = (cmd, args) => (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke?.(cmd, args);

/**
 * Tous les jeux de données lisibles.
 * @returns {Promise<Array<{label:string, kind:"table"|"connection", name:string, table_id?:string, source_id?:string, dataset?:string}>>}
 */
export async function listDatasets() {
  const out = [];
  if (tablesDb.hasBackend) {
    try {
      for (const b of await tablesDb.listBases()) {
        for (const t of await tablesDb.listTables(b.base_id)) {
          out.push({ label: `${b.name} / ${t.name}`, kind: "table", name: t.name, table_id: t.table_id });
        }
      }
    } catch { /* Bases indisponibles : on garde les connexions */ }
  }
  try {
    for (const src of (await call("datasources_list")) || []) {
      const sets = await call("datasources_datasets", { id: src.id }).catch(() => []);
      for (const d of sets || []) {
        out.push({ label: `${src.name || src.id} ⟶ ${d.name}`, kind: "connection", name: d.name, source_id: src.id, dataset: d.name });
      }
    }
  } catch { /* aucune connexion déclarée */ }
  return out;
}

const csvCell = (v) => {
  const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Page `{ columns, rows }` (lignes tableau ou objet) → CSV. */
export function pageToCsv(page) {
  const cols = page?.columns || [];
  const rows = (page?.rows || []).map((r) => (Array.isArray(r) ? r : cols.map((c) => r?.[c])));
  return [cols.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}

/** Contenu d'un jeu de données en CSV (tables : export natif ; connexions : lignes). */
export async function readDatasetCsv(item, { limit = 100000 } = {}) {
  if (item.kind === "table") return tablesDb.exportCsv(item.table_id);
  const page = await call("datasources_rows", { id: item.source_id, dataset: item.dataset, limit });
  return pageToCsv(page);
}

// ---- Bases interrogeables en SQL : locales ET connexions partagées ---------
// La logique vit dans tables/client.js (requête, schéma, NL→SQL) ; on la
// réexporte ici pour les apps qui passent par le catalogue.
export { CONNECTION_PREFIX, isConnection, listSqlConnections, listQueryableBases } from "../tables/client.js";
export const queryBase = (baseId, sql) => tablesDb.query(baseId, sql);
export const schemaText = (baseId) => tablesDb.schemaPrompt(baseId);
