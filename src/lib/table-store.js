// Petit magasin adossé aux bases SQLite de Lumen (tables.rs).
//
// Le backend adresse les colonnes par identifiant opaque (`c_<col_id>`) : toute
// app qui veut y écrire doit traduire « nom convivial ⇄ col_id ». Relia le fait
// depuis longtemps dans son propre store ; ce module en sort la mécanique pour
// que les applications suivantes n'aient plus qu'à déclarer leur schéma.
//
// Le contrat est le même que celui de Relia, et c'est ce qui compte : les
// données ne sont pas enfermées dans l'app. Elles apparaissent telles quelles
// dans Prisme, dans le NL→SQL, dans Fluxo et pour les agents.
//
//   const store = createStore("Réunions", {
//     meetings: { name: "Réunions", columns: [["Titre", "text"], ["Date", "date"]] },
//   });
//   await store.ensureSchema();
//   await store.insert("meetings", { "Titre": "Comité", "Date": "2026-09-06" });

import * as db from "../tables/client.js";

export function createStore(baseName, schema) {
  let baseId = "";
  const meta = {}; // clé logique → { tableId, cols: { "Nom convivial": col_id } }

  const toRow = (key, obj) => {
    const { cols } = meta[key];
    const out = {};
    for (const [name, value] of Object.entries(obj)) {
      const id = cols[name];
      if (id !== undefined) out[id] = value === undefined ? null : value;
    }
    return out;
  };

  const fromRow = (key, row) => {
    const { cols } = meta[key];
    const out = { _id: row._id };
    for (const [name, id] of Object.entries(cols)) out[name] = row[id] ?? null;
    return out;
  };

  return {
    get hasBackend() { return db.hasBackend; },
    get baseId() { return baseId; },
    tableId: (key) => meta[key]?.tableId || "",

    /**
     * Crée la base et les tables manquantes, et complète les colonnes ajoutées
     * depuis. Une colonne ajoutée au schéma apparaît donc au démarrage suivant
     * sur les installations existantes, sans toucher aux données.
     */
    async ensureSchema() {
      const bases = await db.listBases();
      baseId = bases.find((b) => b.name === baseName)?.base_id || "";
      if (!baseId) baseId = await db.createBase(baseName);
      const tables = await db.listTables(baseId);
      for (const [key, def] of Object.entries(schema)) {
        let table = tables.find((t) => t.name === def.name);
        if (!table) {
          const id = await db.createTable(baseId, def.name, def.columns.map(([name, type]) => ({ name, type })));
          table = { table_id: id, name: def.name };
        }
        let cols = await db.tableSchema(table.table_id);
        for (const [name, type] of def.columns) {
          if (!cols.some((c) => c.name === name)) await db.addColumn(table.table_id, name, type);
        }
        cols = await db.tableSchema(table.table_id);
        meta[key] = { tableId: table.table_id, cols: Object.fromEntries(cols.map((c) => [c.name, c.col_id])) };
      }
      return baseId;
    },

    async list(key, limit = 5000) {
      const res = await db.rows(meta[key].tableId, limit, 0);
      return (res?.rows || []).map((r) => fromRow(key, r));
    },

    insert: (key, obj) => db.insertRow(meta[key].tableId, toRow(key, obj)),
    update: (key, rowId, obj) => db.updateRow(meta[key].tableId, rowId, toRow(key, obj)),
    remove: (key, rowId) => db.deleteRow(meta[key].tableId, rowId),

    query: (sql) => db.query(baseId, sql),
    schemaPrompt: () => db.schemaPrompt(baseId),
  };
}
