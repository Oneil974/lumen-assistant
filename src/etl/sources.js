// Connecteurs de l'app Flux de données : d'où viennent les tables, où elles vont.
//
// Un connecteur est une FICHE déclarative (label, famille, champs) et deux
// fonctions : `read(params, limit)` pour une source, `write(params, table)`
// pour une destination. L'inspecteur du canevas dessine le formulaire à
// partir des champs — exactement comme pour les étapes de pipeline.js.
//
// Quatre familles :
//   • Lumen             — ce que l'app a déjà sous la main : les tables de
//                         Prisme / DB Studio / Relia (toutes les bases), une
//                         requête SQL sur une base, les fichiers d'un espace
//                         (CSV, JSON, JSON Lines), les cartes Kanban.
//   • Sources connectées — le centre « Sources de données » : jeux tabulaires
//                         (PostgreSQL, MySQL, SQL Server, SQLite, Excel, CSV,
//                         REST), requête SQL libre (si la source l'autorise),
//                         et fichiers d'un stockage (S3, WebDAV, Nextcloud,
//                         SharePoint, OneDrive, Google Drive, GitHub).
//   • Web               — une URL qui renvoie du CSV ou du JSON.
//   • Saisie            — des données collées, pour essayer un flux sans rien
//                         brancher.
//
// Les lectures passent TOUTES par les commandes Rust existantes : le
// connecteur ne connaît ni mot de passe ni jeton, il demande des lignes.

import { parseCsv, parseJsonTable, tableFrom, toCsv } from "./pipeline.js";

const F = {
  select: (key, label, options, opts = {}) => ({ key, label, kind: "select", options, ...opts }),
  text: (key, label, opts = {}) => ({ key, label, kind: "text", ...opts }),
  textarea: (key, label, opts = {}) => ({ key, label, kind: "textarea", ...opts }),
  number: (key, label, opts = {}) => ({ key, label, kind: "number", ...opts }),
  bool: (key, label, opts = {}) => ({ key, label, kind: "bool", ...opts }),
};

const FORMAT_OPTIONS = [{ value: "auto", label: "détecter" }, { value: "csv", label: "CSV / TSV" }, { value: "json", label: "JSON / JSON Lines" }];

/** Devine le format d'un contenu texte quand l'extension ne dit rien. */
function parseAny(text, { format = "auto", limit, delimiter, rowsPath, name = "" } = {}) {
  let fmt = format;
  if (fmt === "auto") {
    if (/\.(json|jsonl|ndjson)$/i.test(name)) fmt = "json";
    else if (/\.(csv|tsv|txt)$/i.test(name)) fmt = "csv";
    else fmt = /^\s*[\[{]/.test(String(text ?? "")) ? "json" : "csv";
  }
  return fmt === "json" ? parseJsonTable(text, limit, rowsPath) : parseCsv(text, limit, delimiter || undefined);
}

/** Contenu texte d'un objet renvoyé par datasources_object / sandbox_read_file. */
function textOf(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  if (payload.error) throw new Error(payload.error);
  if (payload.encoding === "base64") {
    try { return decodeURIComponent(escape(atob(payload.content))); } catch { return atob(payload.content); }
  }
  return payload.content ?? payload.text ?? "";
}

/** Page { columns, rows: [[…]] } (Rust) → table { columns, rows: [{…}] }. */
const pageToTable = (page) => ({
  columns: page?.columns || [],
  rows: (page?.rows || []).map((row) => (Array.isArray(row)
    ? Object.fromEntries((page.columns || []).map((c, i) => [c, row[i]]))
    : row)),
});

// ============================ Catalogue ============================
//
// Découvert une fois par session : espaces et leurs fichiers, bases et leurs
// tables, sources connectées. Les listes dépendantes (jeux d'une source,
// objets d'un stockage) se chargent à la demande, quand on choisit la source.

export async function discoverCatalog(call) {
  const catalog = { sandboxes: [], files: {}, bases: [], tables: [], datasources: [] };

  try { catalog.sandboxes = (await call("sandbox_list")).map((s) => ({ id: s.id, name: s.name })); } catch { /* sandbox indisponible */ }

  // Fichiers tabulaires de chaque espace, trois niveaux de profondeur : assez
  // pour « exports/2026/ventes.csv », pas de quoi parcourir un dépôt entier.
  for (const sb of catalog.sandboxes) {
    const found = [];
    const walk = async (dir, depth) => {
      const entries = await call("sandbox_read_dir", { id: sb.id, path: dir }).catch(() => []);
      for (const e of entries || []) {
        const path = dir ? `${dir}/${e.name}` : e.name;
        if (e.is_dir) { if (depth < 3 && !e.name.startsWith(".")) await walk(path, depth + 1); continue; }
        if (/\.(csv|tsv|txt|json|jsonl|ndjson)$/i.test(e.name)) found.push(path);
      }
    };
    await walk("", 0);
    catalog.files[sb.id] = found.sort();
  }

  try {
    catalog.bases = (await call("table_base_list")).map((b) => ({ id: b.base_id, name: b.name }));
    for (const base of catalog.bases) {
      const tables = await call("table_list", { baseId: base.id }).catch(() => []);
      for (const t of tables) catalog.tables.push({ baseId: base.id, tableId: t.table_id, label: `${base.name} · ${t.name}`, name: t.name, rows: t.rows });
    }
  } catch { /* pas de base locale */ }

  try {
    catalog.datasources = (await call("datasources_list"))
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.id, name: s.name, kind: s.kind, capabilities: s.capabilities || {}, allowSql: !!s.allow_sql }));
  } catch { /* centre de sources absent */ }

  return catalog;
}

const sandboxOptions = (ctx) => ctx.catalog.sandboxes.map((s) => ({ value: s.id, label: s.name }));
const baseOptions = (ctx) => ctx.catalog.bases.map((b) => ({ value: b.id, label: b.name }));
const dsOptions = (cap) => (ctx) => ctx.catalog.datasources.filter((d) => !cap || d.capabilities?.[cap]).map((d) => ({ value: d.id, label: `${d.name} · ${d.kind}` }));

// ============================ Sources ============================

export const SOURCES = {
  src_table: {
    label: "Table de Lumen", family: "Lumen", hint: "Une table de Prisme, DB Studio ou Relia — n'importe quelle base locale.",
    fields: [F.select("tableId", "Table", (ctx) => ctx.catalog.tables.map((t) => ({ value: t.tableId, label: `${t.label} (${t.rows ?? 0})` })))],
    describe: (p, ctx) => ctx?.catalog?.tables.find((t) => t.tableId === p.tableId)?.label || "table à choisir",
    read: async (p, limit, { call }) => {
      if (!p.tableId) throw new Error("Choisissez une table.");
      const page = await call("table_rows", { tableId: p.tableId, limit: limit || 100000, offset: 0 });
      const cols = await call("table_schema", { tableId: p.tableId });
      // Les lignes arrivent indexées par identifiant de colonne : on les renomme
      // par leur nom lisible, sinon toutes les étapes parleraient en `c_ab12`.
      const byId = Object.fromEntries(cols.map((c) => [c.col_id, c.name]));
      const rows = (page.rows || []).map((r) => {
        const out = {};
        for (const [k, v] of Object.entries(r)) { if (k !== "_id") out[byId[k] || k] = v; }
        return out;
      });
      return { columns: cols.map((c) => c.name), rows };
    },
  },
  src_sql: {
    label: "Requête SQL (base locale)", family: "Lumen", hint: "Un SELECT sur une base de Lumen ; les tables s'appellent par leur nom.",
    fields: [F.select("baseId", "Base", baseOptions), F.textarea("sql", "Requête SELECT", { placeholder: "SELECT * FROM \"Clients\" WHERE ville = 'Lyon'" })],
    describe: (p) => (p.sql ? String(p.sql).replace(/\s+/g, " ").slice(0, 60) : "requête à écrire"),
    read: async (p, limit, { call }) => {
      if (!p.baseId || !p.sql?.trim()) throw new Error("Choisissez une base et écrivez la requête.");
      const page = await call("table_query", { baseId: p.baseId, sql: p.sql });
      const t = pageToTable(page);
      return limit ? { columns: t.columns, rows: t.rows.slice(0, limit) } : t;
    },
  },
  src_file: {
    label: "Fichier d'un espace", family: "Lumen", hint: "CSV, TSV, JSON ou JSON Lines déposé dans un espace (sandbox).",
    fields: [
      F.select("sandboxId", "Espace", sandboxOptions),
      F.select("path", "Fichier", (ctx) => (ctx.catalog.files[ctx.params.sandboxId] || []).map((f) => ({ value: f, label: f })), { dependsOn: "sandboxId", free: true }),
      F.select("format", "Format", FORMAT_OPTIONS),
      F.text("delimiter", "Séparateur CSV (vide = deviné)", { placeholder: ";" }),
    ],
    describe: (p) => p.path || "fichier à choisir",
    read: async (p, limit, { call }) => {
      if (!p.sandboxId || !p.path) throw new Error("Choisissez un espace et un fichier.");
      const file = await call("sandbox_read_file", { id: p.sandboxId, path: p.path });
      return parseAny(textOf(file), { format: p.format, limit, delimiter: p.delimiter, name: p.path });
    },
  },
  src_kanban: {
    label: "Cartes Kanban", family: "Lumen", hint: "Le tableau Kanban : une ligne par carte, avec sa colonne, son responsable, son échéance.",
    fields: [],
    describe: () => "toutes les cartes",
    read: async (p, limit, { call }) => {
      const raw = await call("kanban_load");
      const board = raw ? JSON.parse(raw) : {};
      const colName = Object.fromEntries((board.columns || []).map((c) => [c.id, c.title]));
      const member = Object.fromEntries((board.members || []).map((m) => [m.id, m.name]));
      const rows = (board.cards || []).map((c) => ({
        id: c.id, titre: c.title, description: c.desc || "", colonne: colName[c.colId] || c.colId,
        responsable: member[c.assignee] || c.assignee || "", agent: c.agentId || "",
        echeance: c.due ? new Date(c.due).toISOString().slice(0, 10) : null,
        etiquettes: (c.labels || []).join(", "), commentaires: (c.comments || []).length,
        cree_le: c.created ? new Date(c.created).toISOString().slice(0, 10) : null,
      }));
      return { columns: ["id", "titre", "description", "colonne", "responsable", "agent", "echeance", "etiquettes", "commentaires", "cree_le"], rows: rows.slice(0, limit || 100000) };
    },
  },
  src_datasource: {
    label: "Jeu d'une source connectée", family: "Sources connectées", hint: "Une table, une feuille ou un point d'entrée d'une source du centre « Sources de données ».",
    fields: [
      F.select("id", "Source", dsOptions("datasets")),
      F.select("dataset", "Jeu de données", (ctx) => ctx.dyn[`datasets:${ctx.params.id}`] || [], {
        dependsOn: "id",
        load: async (p, { call }) => (p.id ? (await call("datasources_datasets", { id: p.id })).map((d) => ({ value: d.name, label: `${d.name}${d.rows != null ? ` (${d.rows})` : ""}${d.note ? ` · ${d.note}` : ""}` })) : []),
      }),
    ],
    describe: (p, ctx) => `${ctx?.catalog?.datasources.find((d) => d.id === p.id)?.name || "source"} · ${p.dataset || "jeu à choisir"}`,
    read: async (p, limit, { call }) => {
      if (!p.id || !p.dataset) throw new Error("Choisissez une source et un jeu de données.");
      return pageToTable(await call("datasources_rows", { id: p.id, dataset: p.dataset, limit: limit || 100000 }));
    },
  },
  src_ds_sql: {
    label: "Requête SQL (source connectée)", family: "Sources connectées", hint: "Un SELECT libre sur PostgreSQL, MySQL, SQL Server ou SQLite — si la source autorise le SQL.",
    fields: [F.select("id", "Source", dsOptions("sql")), F.textarea("sql", "Requête SELECT", { placeholder: "SELECT c.nom, SUM(f.montant) AS total FROM factures f JOIN clients c ON c.id = f.client_id GROUP BY c.nom" })],
    describe: (p) => (p.sql ? String(p.sql).replace(/\s+/g, " ").slice(0, 60) : "requête à écrire"),
    read: async (p, limit, { call }) => {
      if (!p.id || !p.sql?.trim()) throw new Error("Choisissez une source et écrivez la requête.");
      return pageToTable(await call("datasources_query", { id: p.id, sql: p.sql, limit: limit || 100000 }));
    },
  },
  src_ds_object: {
    label: "Fichier d'un stockage", family: "Sources connectées", hint: "Un CSV ou JSON dans S3, WebDAV, Nextcloud, SharePoint, OneDrive, Google Drive ou GitHub.",
    fields: [
      F.select("id", "Stockage", dsOptions("objects")),
      F.select("path", "Chemin du fichier", (ctx) => ctx.dyn[`objects:${ctx.params.id}`] || [], {
        dependsOn: "id", free: true,
        load: async (p, { call }) => {
          if (!p.id) return [];
          // Deux niveaux suffisent à proposer l'essentiel ; on peut toujours taper le chemin.
          const out = [];
          const walk = async (dir, depth) => {
            const entries = await call("datasources_objects", { id: p.id, path: dir }).catch(() => []);
            for (const e of entries || []) {
              if (e.dir) { if (depth < 2) await walk(e.path, depth + 1); continue; }
              if (/\.(csv|tsv|txt|json|jsonl|ndjson)$/i.test(e.name)) out.push({ value: e.path, label: e.path });
            }
          };
          await walk("", 0);
          return out;
        },
      }),
      F.select("format", "Format", FORMAT_OPTIONS),
      F.text("delimiter", "Séparateur CSV (vide = deviné)"),
    ],
    describe: (p) => p.path || "fichier à choisir",
    read: async (p, limit, { call }) => {
      if (!p.id || !p.path) throw new Error("Choisissez un stockage et un fichier.");
      const obj = await call("datasources_object", { id: p.id, path: p.path });
      return parseAny(textOf(obj), { format: p.format, limit, delimiter: p.delimiter, name: p.path });
    },
  },
  src_url: {
    label: "URL (CSV ou JSON)", family: "Web", hint: "Une adresse publique qui renvoie un CSV ou un JSON.",
    fields: [F.text("url", "URL", { placeholder: "https://exemple.fr/export.csv" }), F.select("format", "Format", FORMAT_OPTIONS), F.text("rowsPath", "Chemin des lignes dans le JSON (facultatif)", { placeholder: "data.items" }), F.text("delimiter", "Séparateur CSV (vide = deviné)")],
    describe: (p) => p.url || "URL à saisir",
    read: async (p, limit, { call }) => {
      if (!p.url) throw new Error("Saisissez une URL.");
      // web_fetch_raw rend le contenu tel quel : web_fetch, fait pour nourrir
      // un modèle, nettoie et coupe à 40 k caractères — trop court pour un export.
      const text = await call("web_fetch_raw", { url: p.url });
      return parseAny(text, { format: p.format, limit, delimiter: p.delimiter, rowsPath: p.rowsPath, name: p.url.split("?")[0] });
    },
  },
  src_inline: {
    label: "Données saisies", family: "Saisie", hint: "Collez un CSV ou un JSON : pratique pour essayer un flux ou fournir une table de correspondance.",
    fields: [F.textarea("text", "Données", { placeholder: "code;libellé\nA;Alimentaire\nB;Boissons", rows: 8 }), F.select("format", "Format", FORMAT_OPTIONS)],
    describe: (p) => `${String(p.text || "").split("\n").filter((l) => l.trim()).length - 1 || 0} ligne(s) saisie(s)`,
    read: async (p, limit) => parseAny(p.text || "", { format: p.format, limit }),
  },
};

// ============================ Destinations ============================
//
// Une destination ÉCRIT ; la source n'est jamais modifiée. Un flux qui écrase
// ses entrées n'est pas rejouable, et rejouer est tout l'intérêt d'un flux.

export const DESTINATIONS = {
  dst_preview: {
    label: "Aperçu", family: "Sortie", hint: "Ne rien écrire : voir le résultat, c'est tout. Utile pour explorer.",
    fields: [],
    describe: () => "aperçu seulement",
    write: async () => null,
  },
  dst_csv: {
    label: "Fichier CSV", family: "Sortie", hint: "Écrit dans un espace ; lisible par Calc, Prisme, les agents et les autres apps.",
    fields: [F.select("sandboxId", "Espace", sandboxOptions), F.text("path", "Chemin du fichier", { placeholder: "flux/resultat.csv" }), F.select("delimiter", "Séparateur", [{ value: ";", label: "point-virgule (Excel FR)" }, { value: ",", label: "virgule" }, { value: "\t", label: "tabulation" }])],
    describe: (p) => p.path || "chemin à saisir",
    write: async (p, table, { call }) => {
      if (!p.sandboxId) throw new Error("Choisissez un espace.");
      await call("sandbox_write_file", { id: p.sandboxId, path: p.path || "flux/resultat.csv", content: toCsv(table, p.delimiter || ";") });
      return `${table.rows.length} ligne(s) écrites dans ${p.path || "flux/resultat.csv"}`;
    },
  },
  dst_json: {
    label: "Fichier JSON", family: "Sortie", hint: "Un tableau d'objets, pour une mini-app, un script ou une API.",
    fields: [F.select("sandboxId", "Espace", sandboxOptions), F.text("path", "Chemin du fichier", { placeholder: "flux/resultat.json" }), F.bool("lines", "JSON Lines (un objet par ligne)")],
    describe: (p) => p.path || "chemin à saisir",
    write: async (p, table, { call }) => {
      if (!p.sandboxId) throw new Error("Choisissez un espace.");
      const content = p.lines ? table.rows.map((r) => JSON.stringify(r)).join("\n") : JSON.stringify(table.rows, null, 2);
      await call("sandbox_write_file", { id: p.sandboxId, path: p.path || "flux/resultat.json", content });
      return `${table.rows.length} ligne(s) écrites dans ${p.path || "flux/resultat.json"}`;
    },
  },
  dst_table: {
    label: "Table de Lumen", family: "Sortie", hint: "Crée ou alimente une table locale : visible dans Prisme, Calc, DB Studio, et par les agents.",
    fields: [F.select("baseId", "Base", baseOptions), F.text("name", "Nom de la table", { placeholder: "Résultat du flux" }), F.select("mode", "Si la table existe", [{ value: "append", label: "ajouter les lignes à la suite" }, { value: "replace", label: "remplacer son contenu" }])],
    describe: (p) => `table « ${p.name || "à nommer"} »${p.mode === "replace" ? " (remplacée)" : ""}`,
    write: async (p, table, { call, catalog }) => {
      if (!p.name?.trim()) throw new Error("Donnez un nom à la table.");
      let baseId = p.baseId || catalog?.bases?.[0]?.id;
      if (!baseId) baseId = await call("table_base_create", { name: "Lumen" });
      const existing = (await call("table_list", { baseId })).find((t) => t.name === p.name.trim());
      let tableId = existing?.table_id;
      if (tableId && p.mode === "replace") {
        await call("table_delete", { tableId });
        tableId = null;
      }
      if (!tableId) {
        // Les types sont devinés sur les valeurs : une colonne de nombres
        // devient numérique, sinon Prisme la trierait comme du texte.
        const columns = table.columns.map((c) => ({ name: c, type: guessColumnType(table.rows.map((r) => r[c])) }));
        tableId = await call("table_create", { baseId, name: p.name.trim(), columns });
      } else {
        // Colonnes nouvelles depuis la dernière exécution : on les ajoute.
        const have = new Set((await call("table_schema", { tableId })).map((c) => c.name));
        for (const c of table.columns) if (!have.has(c)) await call("table_column_add", { tableId, name: c, colType: guessColumnType(table.rows.map((r) => r[c])) });
      }
      const cols = await call("table_schema", { tableId });
      const byName = Object.fromEntries(cols.map((c) => [c.name, c.col_id]));
      for (const row of table.rows) {
        const values = {};
        for (const c of table.columns) if (byName[c]) values[byName[c]] = row[c] ?? null;
        await call("table_row_insert", { tableId, values });
      }
      return `${table.rows.length} ligne(s) écrites dans « ${p.name.trim()} »`;
    },
  },
};

function guessColumnType(values) {
  const vals = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (!vals.length) return "text";
  if (vals.every((v) => typeof v === "boolean")) return "bool";
  if (vals.every((v) => typeof v === "number" || (typeof v === "string" && /^-?\d+([.,]\d+)?$/.test(v.trim())))) return "number";
  if (vals.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))) return "date";
  return "text";
}

export const FAMILIES = ["Lumen", "Sources connectées", "Web", "Saisie"];

/** Fiche d'un bloc, quel qu'il soit : source, transformation ou destination. */
export const isSource = (type) => !!SOURCES[type];
export const isDestination = (type) => !!DESTINATIONS[type];
export { tableFrom };
