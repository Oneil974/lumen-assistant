// DB Studio — les deux MOTEURS derrière un même modèle.
//
// Le modélisateur ne parle jamais SQL directement : il manipule des « modèles »
// (une table, ses champs, son formulaire) et délègue à un moteur. Deux moteurs
// existent, avec la même interface exactement :
//
//   • sqlite   — la base locale de Lumen (tables.rs). C'est le défaut : les
//                données restent visibles par Prisme, Calc, le NL→SQL, Fluxo et
//                les agents, sans passerelle.
//   • postgres — un PostgreSQL d'entreprise, réservé à l'édition Pro. Le modèle
//                y devient de vraies tables avec de vraies clés étrangères ;
//                les tables de jonction des relations n–n sont créées pour vous.
//
// Ce qu'un moteur doit savoir faire est court, et c'est voulu :
//   ready() · listModels() · createModel() · renameModel() · deleteModel()
//   addField() · updateField() · deleteField() · reorderFields() · setForm()
//   rows() · insertRow() · updateRow() · deleteRow() · query() · schemaPrompt()

import * as db from "../tables/client.js";
import { FIELD_KINDS, blankField, coerceValue, slug } from "./fields.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;

// ============================ Moteur SQLite ============================
//
// Les champs sont des colonnes de tables.rs. Le TYPE stocké reste un type
// convivial connu des autres apps (text, number, bool, date, select) ; la
// nature exacte du champ (e-mail, montant, relation…) et ses contraintes vivent
// dans les métadonnées JSON de la colonne. Une table de DB Studio reste donc
// une table ordinaire pour le reste de Lumen — c'est tout l'intérêt.

const parseMeta = (raw) => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } };

/** Type de colonne historique → type de champ, pour les tables déjà existantes. */
function inferKind(colType) {
  if (colType === "number") return "number";
  if (colType === "bool") return "bool";
  if (colType === "date") return "date";
  if (colType === "select") return "select";
  return "text";
}

function sqliteEngine(baseName) {
  let baseId = "";
  const cache = new Map(); // tableId → { fields, byName }

  const fieldFromColumn = (col) => {
    const meta = parseMeta(col.meta);
    return {
      ...blankField(meta.kind || inferKind(col.type), col.name),
      ...meta,
      id: col.col_id,
      name: col.name,
      kind: meta.kind || inferKind(col.type),
    };
  };

  return {
    id: "sqlite",
    label: `SQLite local · base « ${baseName} »`,
    supportsRelations: true,

    async ready() {
      if (!db.hasBackend) throw new Error("Ouvrez cette application depuis Lumen.");
      const bases = await db.listBases();
      baseId = bases.find((b) => b.name === baseName)?.base_id || "";
      if (!baseId) baseId = await db.createBase(baseName);
      return true;
    },

    baseId: () => baseId,

    async listModels() {
      const tables = await db.listTables(baseId);
      const out = [];
      for (const t of tables) {
        const cols = await db.tableSchema(t.table_id);
        const fields = cols.map(fieldFromColumn);
        cache.set(t.table_id, fields);
        let form = {};
        try { form = JSON.parse((await db.getTableMeta(t.table_id)) || "{}"); } catch { form = {}; }
        out.push({ id: t.table_id, name: t.name, rows: t.rows, fields, form });
      }
      return out;
    },

    async createModel(name, fields) {
      const cols = fields.map((f) => ({ name: f.name, type: FIELD_KINDS[f.kind]?.sql || "text" }));
      const tableId = await db.createTable(baseId, name, cols.length ? cols : [{ name: "Nom", type: "text" }]);
      const schema = await db.tableSchema(tableId);
      for (const f of fields) {
        const col = schema.find((c) => c.name === f.name);
        if (col) await db.setColumnMeta(col.col_id, JSON.stringify(stripField(f)));
      }
      return tableId;
    },

    renameModel: (id, name) => db.renameTable(id, name),
    deleteModel: (id) => db.deleteTable(id),

    async addField(tableId, field) {
      const colId = await db.addColumn(tableId, field.name, FIELD_KINDS[field.kind]?.sql || "text");
      await db.setColumnMeta(colId, JSON.stringify(stripField(field)));
      return colId;
    },

    async updateField(tableId, fieldId, field) {
      await db.renameColumn(fieldId, field.name);
      await db.retypeColumn(fieldId, FIELD_KINDS[field.kind]?.sql || "text");
      await db.setColumnMeta(fieldId, JSON.stringify(stripField(field)));
    },

    deleteField: (tableId, fieldId) => db.deleteColumn(fieldId),
    reorderFields: (tableId, ids) => db.reorderColumns(ids),
    setForm: (tableId, form) => db.setTableMeta(tableId, JSON.stringify(form)),

    async rows(model, limit = 500, offset = 0) {
      const res = await db.rows(model.id, limit, offset);
      return (res?.rows || []).map((r) => {
        const values = {};
        for (const f of model.fields) values[f.id] = r[f.id] ?? null;
        return { _id: r._id, values };
      });
    },

    insertRow: (model, values) => db.insertRow(model.id, values),
    updateRow: (model, rowId, values) => db.updateRow(model.id, rowId, values),
    deleteRow: (model, rowId) => db.deleteRow(model.id, rowId),

    query: (sql) => db.query(baseId, sql),
    schemaPrompt: () => db.schemaPrompt(baseId),
  };
}

/** Ce qu'on écrit dans les métadonnées : le champ, sans son identifiant. */
function stripField(f) {
  const { id, ...rest } = f;
  return rest;
}

// ============================ Moteur PostgreSQL ============================
//
// Ici le modèle devient du vrai DDL. Deux règles tiennent le module :
//   1. Toute écriture passe par des paramètres `$1…$n` (jamais de valeur
//      concaténée dans le SQL) ; les seules chaînes interpolées sont des
//      identifiants, produits par `slug()` puis mis entre guillemets.
//   2. Les métadonnées du modèle (nature des champs, formulaire) vivent dans
//      une table technique `lumen_dbstudio_meta` de la même base : le modèle
//      voyage donc avec les données, pas dans le poste de l'utilisateur.

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

function pgEngine(cfg) {
  const url = () => cfg.url;
  const schema = () => cfg.schema || "public";
  const call = (cmd, args) => {
    if (!invoke) throw new Error("Ouvrez cette application depuis Lumen.");
    return invoke(cmd, args);
  };
  const exec = (sql, params) => call("prodb_pg_exec", { url: url(), sql, params: params || [] });
  const query = (sql, limit) => call("prodb_pg_query", { url: url(), sql, limit: limit || 1000 });
  const migrate = (statements) => call("prodb_pg_migrate", { url: url(), statements });

  // Le type PostgreSQL d'un champ, contrainte de clé étrangère comprise.
  const columnDdl = (table, f) => {
    const name = q(slug(f.name));
    if (f.kind === "relation" && f.cardinality === "one") {
      return `${name} BIGINT${f.required ? " NOT NULL" : ""} REFERENCES ${q(schema())}.${q(slug(f.target))}(id) ON DELETE SET NULL`;
    }
    const type = FIELD_KINDS[f.kind]?.pg || "TEXT";
    const parts = [`${name} ${type}`];
    if (f.required) parts.push("NOT NULL");
    if (f.unique) parts.push("UNIQUE");
    if (f.def !== "" && f.def !== undefined && f.def !== null) {
      parts.push(`DEFAULT ${f.kind === "number" || f.kind === "integer" || f.kind === "money" ? Number(f.def) || 0 : `'${String(f.def).replace(/'/g, "''")}'`}`);
    }
    if (f.kind === "select" && f.options?.length) {
      const list = f.options.map((o) => `'${String(o).replace(/'/g, "''")}'`).join(", ");
      parts.push(`CHECK (${name} IS NULL OR ${name} IN (${list}))`);
    }
    return parts.join(" ");
  };

  // Table de jonction d'une relation n–n : c'est ce que PostgreSQL sait faire
  // de mieux, et cela reste interrogeable par n'importe quel autre outil.
  const junctionName = (table, field) => slug(`${table}_${field.name}_lien`);
  const junctionDdl = (table, f) => `CREATE TABLE IF NOT EXISTS ${q(schema())}.${q(junctionName(table, f))} (
  source_id BIGINT NOT NULL REFERENCES ${q(schema())}.${q(slug(table))}(id) ON DELETE CASCADE,
  cible_id BIGINT NOT NULL REFERENCES ${q(schema())}.${q(slug(f.target))}(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, cible_id))`;

  const META_DDL = `CREATE TABLE IF NOT EXISTS ${q(schema())}.lumen_dbstudio_meta (
  table_name TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT '', meta JSONB NOT NULL,
  PRIMARY KEY (table_name, column_name))`;

  const readMeta = async () => {
    const res = await query(`SELECT table_name, column_name, meta FROM ${q(schema())}.lumen_dbstudio_meta`, 5000);
    const map = new Map();
    for (const r of res.rows || []) map.set(`${r.table_name}::${r.column_name}`, r.meta);
    return map;
  };
  const writeMeta = (table, column, meta) => exec(
    `INSERT INTO ${q(schema())}.lumen_dbstudio_meta(table_name, column_name, meta) VALUES($1,$2,$3::jsonb)
     ON CONFLICT (table_name, column_name) DO UPDATE SET meta = EXCLUDED.meta`,
    [table, column, JSON.stringify(meta)],
  );

  // Valeur envoyée à PostgreSQL + cast explicite quand le type l'exige : un
  // texte n'est pas converti tout seul en date côté serveur.
  const bind = (f, i) => {
    if (f.kind === "date") return `$${i}::date`;
    if (f.kind === "datetime") return `$${i}::timestamptz`;
    if (f.kind === "money") return `$${i}::numeric`;
    return `$${i}`;
  };

  return {
    id: "postgres",
    label: `PostgreSQL · ${cfg.url ? cfg.url.replace(/\/\/[^@]*@/, "//••••@") : "non configuré"}`,
    supportsRelations: true,

    async ready() {
      if (!cfg.url) throw new Error("Renseignez l'URL de connexion PostgreSQL dans les réglages.");
      await call("prodb_pg_ping", { url: url() });
      await migrate([META_DDL]);
      return true;
    },

    async listModels() {
      const [info, meta] = await Promise.all([
        call("prodb_pg_schema", { url: url(), schema: schema() }),
        readMeta().catch(() => new Map()),
      ]);
      return (info.tables || [])
        .filter((t) => t.name !== "lumen_dbstudio_meta")
        .map((t) => {
          const form = meta.get(`${t.name}::`) || {};
          const fields = t.columns
            .filter((c) => c.name !== "id")
            .map((c) => {
              const m = meta.get(`${t.name}::${c.name}`) || {};
              const rel = t.relations.find((r) => r.column === c.name);
              return {
                ...blankField(m.kind || pgKind(c.type, !!rel), m.name || c.name),
                ...m,
                id: c.name,
                name: m.name || c.name,
                required: m.required ?? !c.nullable,
                target: m.target || rel?.refTable || "",
              };
            });
          return { id: t.name, name: form.title || t.name, rows: t.rows, fields, form, physical: t.name };
        });
    },

    async createModel(name, fields) {
      const table = slug(name, "table");
      const cols = fields.filter((f) => !(f.kind === "relation" && f.cardinality === "many"));
      const statements = [
        `CREATE TABLE ${q(schema())}.${q(table)} (id BIGSERIAL PRIMARY KEY${cols.length ? ", " + cols.map((f) => columnDdl(table, f)).join(", ") : ""})`,
        ...fields.filter((f) => f.kind === "relation" && f.cardinality === "many").map((f) => junctionDdl(table, f)),
      ];
      await migrate(statements);
      await writeMeta(table, "", { title: name });
      for (const f of fields) await writeMeta(table, slug(f.name), stripField(f));
      return table;
    },

    async renameModel(id, name) {
      // Le nom convivial est une métadonnée : renommer dans DB Studio ne
      // renomme pas la table physique, dont dépendent peut-être d'autres outils.
      await writeMeta(id, "", { title: name });
    },

    deleteModel: (id) => migrate([`DROP TABLE IF EXISTS ${q(schema())}.${q(id)} CASCADE`]),

    async addField(tableId, field) {
      if (field.kind === "relation" && field.cardinality === "many") {
        await migrate([junctionDdl(tableId, field)]);
      } else {
        await migrate([`ALTER TABLE ${q(schema())}.${q(tableId)} ADD COLUMN ${columnDdl(tableId, field)}`]);
      }
      await writeMeta(tableId, slug(field.name), stripField(field));
      return slug(field.name);
    },

    async updateField(tableId, fieldId, field) {
      // Seul le libellé et les contraintes « douces » sont modifiables sans
      // migration destructive ; le renommage physique reste explicite.
      if (slug(field.name) !== fieldId) {
        await migrate([`ALTER TABLE ${q(schema())}.${q(tableId)} RENAME COLUMN ${q(fieldId)} TO ${q(slug(field.name))}`]);
      }
      await writeMeta(tableId, slug(field.name), stripField(field));
    },

    async deleteField(tableId, fieldId) {
      await migrate([`ALTER TABLE ${q(schema())}.${q(tableId)} DROP COLUMN IF EXISTS ${q(fieldId)}`]);
      await exec(`DELETE FROM ${q(schema())}.lumen_dbstudio_meta WHERE table_name=$1 AND column_name=$2`, [tableId, fieldId]);
    },

    async reorderFields(tableId, ids) {
      // PostgreSQL ne réordonne pas ses colonnes : l'ordre d'affichage est une
      // métadonnée du formulaire, pas une propriété de la table.
      await writeMeta(tableId, "", { order: ids });
    },

    setForm: (tableId, form) => writeMeta(tableId, "", form),

    async rows(model, limit = 500, offset = 0) {
      const cols = model.fields
        .filter((f) => !(f.kind === "relation" && f.cardinality === "many"))
        .map((f) => q(f.id)).join(", ");
      const res = await query(`SELECT id${cols ? ", " + cols : ""} FROM ${q(schema())}.${q(model.id)} ORDER BY id LIMIT ${Math.max(1, Math.floor(limit))} OFFSET ${Math.max(0, Math.floor(offset))}`, limit);
      return (res.rows || []).map((r) => {
        const values = {};
        for (const f of model.fields) values[f.id] = r[f.id] ?? null;
        return { _id: r.id, values };
      });
    },

    async insertRow(model, values) {
      const entries = Object.entries(values).filter(([, v]) => v !== undefined);
      if (!entries.length) return null;
      const fields = entries.map(([id]) => model.fields.find((f) => f.id === id)).filter(Boolean);
      const sql = `INSERT INTO ${q(schema())}.${q(model.id)} (${fields.map((f) => q(f.id)).join(", ")})
                   VALUES (${fields.map((f, i) => bind(f, i + 1)).join(", ")})`;
      await exec(sql, entries.map(([, v]) => v));
      return null;
    },

    async updateRow(model, rowId, values) {
      const entries = Object.entries(values).filter(([, v]) => v !== undefined);
      if (!entries.length) return;
      const fields = entries.map(([id]) => model.fields.find((f) => f.id === id)).filter(Boolean);
      const sets = fields.map((f, i) => `${q(f.id)} = ${bind(f, i + 1)}`).join(", ");
      await exec(
        `UPDATE ${q(schema())}.${q(model.id)} SET ${sets} WHERE id = $${fields.length + 1}`,
        [...entries.map(([, v]) => v), Number(rowId)],
      );
    },

    deleteRow: (model, rowId) => exec(`DELETE FROM ${q(schema())}.${q(model.id)} WHERE id = $1`, [Number(rowId)]),

    async query(sql) {
      const res = await query(sql, 1000);
      return { columns: res.columns, rows: res.rows };
    },

    async schemaPrompt() {
      const info = await call("prodb_pg_schema", { url: url(), schema: schema() });
      return (info.tables || [])
        .map((t) => `Table "${t.name}" — ${t.rows} ligne(s) — colonnes : ${t.columns.map((c) => `"${c.name}" (${c.type})`).join(", ")}`)
        .join("\n") || "(base vide)";
    },
  };
}

/** Type PostgreSQL → type de champ DB Studio (tables non créées par l'app). */
function pgKind(type, isRelation) {
  if (isRelation) return "relation";
  const t = String(type || "").toLowerCase();
  if (t.includes("bool")) return "bool";
  if (t.includes("timestamp")) return "datetime";
  if (t === "date") return "date";
  if (t.includes("int")) return "integer";
  if (t.includes("numeric") || t.includes("double") || t.includes("real")) return "number";
  if (t.includes("text") || t.includes("char")) return "text";
  return "text";
}

// ============================ Fabrique ============================


// ============================ Moteur Lumen Server ============================
//
// Le troisième moteur : les tables vivent sur un **Lumen Server**, donc
// plusieurs personnes saisissent dans la même. C'est le seul moteur où la
// question « qui a le droit d'écrire ? » se pose — et elle se tranche côté
// serveur, à chaque appel, jamais ici.
//
// Différence assumée avec les deux autres : le serveur range les lignes en JSON
// plutôt qu'en colonnes SQL. On y gagne de n'avoir aucune migration à jouer
// quand un champ change de nature ; on y perd le filtrage côté base, que
// DB Studio faisait déjà en mémoire pour ses sources fichiers.

function serverEngine() {
  const api = async (method, path, body) => {
    const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
    if (!invoke) throw new Error("Ouvrez cette application depuis Lumen.");
    return invoke("netserver_api", { method, path, body: body ?? null });
  };

  // Une table du serveur redevient un « modèle » DB Studio : mêmes champs,
  // même formulaire. L'app n'a pas à savoir d'où ils viennent.
  const toModel = (t) => {
    let parsed = [];
    try { parsed = typeof t.columns === "string" ? JSON.parse(t.columns) : (t.columns || []); } catch { parsed = []; }
    const fields = (parsed.fields || parsed || []).filter((f) => f && f.id);
    return {
      id: t.id,
      name: t.name,
      rows: 0,
      fields,
      form: parsed.form || {},
      access: t.access,       // "read" ou "write" — l'app grise ce qu'il faut
      remote: true,
      owner: t.owner,
    };
  };

  const pack = (model) => JSON.stringify({ fields: model.fields || [], form: model.form || {} });

  let cache = [];

  return {
    id: "server",
    label: "Lumen Server (partagé)",
    supportsRelations: true,

    async ready() {
      const state = await (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke("netserver_state");
      if (!state?.linked) {
        throw new Error("Ce poste n'est lié à aucun Lumen Server. Ouvrez l'Annuaire pour le lier.");
      }
    },

    async listModels() {
      const { tables } = await api("GET", "/v1/tables");
      cache = (tables || []).map(toModel);
      // Le nombre de lignes n'est pas rendu par la liste : on ne va pas
      // chercher toutes les tables pour afficher un compteur.
      return cache;
    },

    async createModel(name, fields) {
      const { id } = await api("PUT", "/v1/tables", { name, columns: { fields: fields || [], form: {} } });
      return id;
    },

    async renameModel(id, name) {
      const model = cache.find((m) => m.id === id);
      await api("PUT", "/v1/tables", { id, name, columns: JSON.parse(pack(model || { fields: [] })) });
    },

    deleteModel: (id) => api("DELETE", `/v1/tables/${id}`),

    async addField(tableId, field) {
      const model = cache.find((m) => m.id === tableId);
      if (!model) throw new Error("Table inconnue.");
      const id = field.id || slug(field.name);
      model.fields = [...model.fields, { ...field, id }];
      await api("PUT", "/v1/tables", { id: tableId, name: model.name, columns: JSON.parse(pack(model)) });
      return id;
    },

    async updateField(tableId, field) {
      const model = cache.find((m) => m.id === tableId);
      if (!model) throw new Error("Table inconnue.");
      model.fields = model.fields.map((f) => (f.id === field.id ? { ...f, ...field } : f));
      await api("PUT", "/v1/tables", { id: tableId, name: model.name, columns: JSON.parse(pack(model)) });
    },

    async deleteField(tableId, fieldId) {
      const model = cache.find((m) => m.id === tableId);
      if (!model) throw new Error("Table inconnue.");
      model.fields = model.fields.filter((f) => f.id !== fieldId);
      await api("PUT", "/v1/tables", { id: tableId, name: model.name, columns: JSON.parse(pack(model)) });
    },

    async reorderFields(tableId, ids) {
      const model = cache.find((m) => m.id === tableId);
      if (!model) throw new Error("Table inconnue.");
      model.fields = ids.map((id) => model.fields.find((f) => f.id === id)).filter(Boolean);
      await api("PUT", "/v1/tables", { id: tableId, name: model.name, columns: JSON.parse(pack(model)) });
    },

    async setForm(tableId, form) {
      const model = cache.find((m) => m.id === tableId);
      if (!model) throw new Error("Table inconnue.");
      model.form = form;
      await api("PUT", "/v1/tables", { id: tableId, name: model.name, columns: JSON.parse(pack(model)) });
    },

    async rows(model, limit = 500, offset = 0) {
      const { rows } = await api("GET", `/v1/tables/${model.id}/rows`);
      return (rows || []).slice(offset, offset + limit).map((r) => ({ _id: r._id, values: r.values || {} }));
    },

    insertRow: (model, values) => api("POST", `/v1/tables/${model.id}/rows`, { values }),
    updateRow: (model, rowId, values) => api("PUT", `/v1/tables/${model.id}/rows/${rowId}`, { values }),
    deleteRow: (model, rowId) => api("DELETE", `/v1/tables/${model.id}/rows/${rowId}`),

    // Pas de SQL libre sur le serveur : les lignes y sont du JSON, et ouvrir un
    // moteur de requête là-dessus donnerait l'illusion d'un SGBD qu'il n'est
    // pas. Mieux vaut refuser franchement que répondre à moitié.
    query: async () => { throw new Error("Le SQL libre n'existe pas sur le moteur Lumen Server."); },

    schemaPrompt: async () => cache
      .map((m) => `${m.name} (${m.fields.map((f) => `${f.name} [${f.kind}]`).join(", ") || "aucun champ"})`)
      .join("\n"),

    /** Droits d'une table partagée : lus et posés par le propriétaire. */
    grants: (tableId) => api("GET", `/v1/tables/${tableId}/grants`),
    setGrant: (tableId, account, access) => api("POST", `/v1/tables/${tableId}/grants`, { account, access }),
  };
}

export const ENGINES = {
  sqlite: { label: "SQLite local (Lumen)", hint: "Vos tables restent lisibles par Prisme, Calc, Fluxo et les agents." },
  postgres: { label: "PostgreSQL", hint: "Base d'entreprise partagée." },
  server: { label: "Lumen Server (partagé)", hint: "Les tables vivent sur votre serveur d'équipe : plusieurs personnes saisissent dans la même, avec des droits." },
};

/** Réglages persistés du moteur (par profil, via le préfixe de stockage). */
export function readEngineConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem("dbStudioEngine") || "{}");
    const engine = ["postgres", "server"].includes(raw.engine) ? raw.engine : "sqlite";
    return { engine, url: raw.url || "", schema: raw.schema || "public", base: raw.base || "Studio" };
  } catch {
    return { engine: "sqlite", url: "", schema: "public", base: "Studio" };
  }
}

export function saveEngineConfig(cfg) {
  localStorage.setItem("dbStudioEngine", JSON.stringify(cfg));
}

export function createEngine(cfg) {
  if (cfg.engine === "server") return serverEngine();
  return cfg.engine === "postgres" ? pgEngine(cfg) : sqliteEngine(cfg.base || "Studio");
}

export { coerceValue };
