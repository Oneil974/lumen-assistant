import { autoTranslate, tt } from "../apps-i18n.js";
// App « Bases de données » (type Baserow). Voir client.js pour l'accès backend.
import * as db from "./client.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";

import { receive } from "../lib/interop.js";
import { pageToCsv } from "../lib/data-catalog.js";
const $ = (id) => document.getElementById(id);
const COL_TYPES = ["text", "number", "date", "bool", "select"];
const TYPE_LABEL = { text: "Texte", number: "Nombre", date: "Date", bool: "Booléen", select: "Choix" };

let bases = [];
let tables = [];
let currentBaseId = "";
let currentTableId = "";
let schema = [];
// Portée d'interrogation de l'IA : { mode: "base" } (toute la base) ou
// { mode: "tables", ids: [...] } (sous-ensemble). Réinitialisée par base.
let aiScope = { mode: "base" };
// Connexions de « Sources de données » : consultées ici en LECTURE SEULE, sans
// copie. Une connexion est choisie dans le même sélecteur que les bases.
let connections = [];
const onConnection = () => db.isConnection(currentBaseId);
const connectionOf = (baseId) => connections.find((c) => db.CONNECTION_PREFIX + c.id === baseId);

// ---------- Assistant IA (boîte de prompt partagée) ----------
// La base entière se pilote au prompt : créer des tables, ajouter des colonnes
// et des lignes, corriger, supprimer, interroger. Les SELECT passent par
// table_query (garde lecture seule côté Rust) ; les écritures par les commandes
// table_row_* dédiées — jamais par du SQL libre.
const tableByRef = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return tables.find((t) => t.table_id === ref)
    || tables.find((t) => String(t.name).toLowerCase() === r)
    || tables.find((t) => String(t.name).toLowerCase().includes(r));
};

const TABLES_TOOLS = [
  tool("describe_base", "Schéma de la base active : tables, colonnes, types, nombre de lignes.", {}),
  tool("query", "Exécute une requête SQL de LECTURE (SELECT) sur la base et renvoie les lignes.",
    { sql: T.str("Requête SELECT complète, avec les noms de tables entre guillemets doubles") }, ["sql"]),
  tool("read_rows", "Lit les premières lignes d'une table.", { table: T.str("Nom ou identifiant"), limit: T.int("Défaut 20") }, ["table"]),
  tool("create_table", "Crée une table avec ses colonnes.",
    { name: T.str("Nom de la table"),
      columns: { type: "array", description: "Colonnes",
        items: { type: "object", properties: { name: T.str(""), type: T.enum(COL_TYPES, "Type de colonne") }, required: ["name"] } } },
    ["name", "columns"]),
  tool("add_column", "Ajoute une colonne à une table.", { table: T.str(""), name: T.str(""), type: T.enum(COL_TYPES, "") }, ["table", "name"]),
  tool("insert_rows", "Insère une ou plusieurs lignes dans une table.",
    { table: T.str(""), rows: { type: "array", description: "Lignes, chacune { colonne: valeur }", items: { type: "object" } } },
    ["table", "rows"]),
  tool("update_row", "Modifie une ligne existante.",
    { table: T.str(""), row_id: T.str("Identifiant de la ligne"), values: { type: "object", description: "{ colonne: valeur }" } },
    ["table", "row_id", "values"]),
  tool("delete_row", "Supprime une ligne.", { table: T.str(""), row_id: T.str("") }, ["table", "row_id"]),
  tool("delete_table", "Supprime une table entière.", { table: T.str("") }, ["table"]),
  tool("create_base", "Crée une nouvelle base de données.", { name: T.str("") }, ["name"]),
];

async function runTablesTool(name, a) {
  const need = (ref) => { const t = tableByRef(ref); if (!t) throw new Error(`table « ${ref} » introuvable ; appelle describe_base.`); return t; };
  const fmtRows = (columns, rowsArr, max = 30) => {
    if (!rowsArr?.length) return "(aucune ligne)";
    const head = (columns || []).join(" | ");
    return head + "\n" + rowsArr.slice(0, max).map((r) => (Array.isArray(r) ? r : Object.values(r)).join(" | ")).join("\n")
      + (rowsArr.length > max ? `\n… ${rowsArr.length - max} ligne(s) de plus` : "");
  };
  switch (name) {
    case "describe_base": {
      if (!currentBaseId) return "Aucune base active. Utilise create_base.";
      return await db.schemaPrompt(currentBaseId);
    }
    case "query": {
      const res = await db.query(currentBaseId, String(a.sql || ""));
      return `SQL : ${a.sql}\n` + fmtRows(res?.columns, res?.rows);
    }
    case "read_rows": {
      const t = need(a.table);
      const res = await db.rows(t.table_id, Math.min(100, Number(a.limit) || 20), 0);
      return fmtRows(res?.columns || (res?.[0] && Object.keys(res[0])), res?.rows || res);
    }
    case "create_table": {
      if (!currentBaseId) throw new Error("aucune base active ; appelle create_base d'abord.");
      const cols = (a.columns || []).map((c) => ({ name: String(c.name), type: COL_TYPES.includes(c.type) ? c.type : "text" }));
      if (!cols.length) throw new Error("fournis au moins une colonne.");
      currentTableId = await db.createTable(currentBaseId, String(a.name), cols);
      return `Table « ${a.name} » créée avec ${cols.length} colonne(s).`;
    }
    case "add_column": {
      const t = need(a.table);
      await db.addColumn(t.table_id, String(a.name), COL_TYPES.includes(a.type) ? a.type : "text");
      return `Colonne « ${a.name} » ajoutée à « ${t.name} ».`;
    }
    case "insert_rows": {
      const t = need(a.table);
      const list = Array.isArray(a.rows) ? a.rows : [a.rows];
      for (const values of list) await db.insertRow(t.table_id, values || {});
      return `${list.length} ligne(s) insérée(s) dans « ${t.name} ».`;
    }
    case "update_row": { const t = need(a.table); await db.updateRow(t.table_id, a.row_id, a.values || {}); return `Ligne ${a.row_id} modifiée dans « ${t.name} ».`; }
    case "delete_row": { const t = need(a.table); await db.deleteRow(t.table_id, a.row_id); return `Ligne ${a.row_id} supprimée de « ${t.name} ».`; }
    case "delete_table": { const t = need(a.table); await db.deleteTable(t.table_id); return `Table « ${t.name} » supprimée.`; }
    case "create_base": { currentBaseId = await db.createBase(String(a.name)); return `Base « ${a.name} » créée et activée.`; }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountTablesAI() {
  mountAiPrompt(null, {
    app: "Bases de données",
    intro: "Tu conçois et remplis les bases SQLite locales de l'utilisateur, et tu les interroges.",
    rules: "- Commence par describe_base pour connaître les tables et colonnes.\n- Les SELECT passent par query ; toute écriture passe par insert_rows / update_row / delete_row (jamais de SQL d'écriture).\n- Cite les chiffres que renvoient réellement les outils, n'invente aucune valeur.",
    placeholder: "Ex. : crée une table Clients et remplis-la avec ces cinq lignes…",
    suggestions: [
      { label: "Concevoir une table", prompt: "Crée une table adaptée à ce que je vais décrire, avec des colonnes bien typées." },
      { label: "Interroger", prompt: "Réponds à ma question à partir des données de la base, en montrant la requête utilisée." },
      { label: "Analyser", prompt: "Décris la base, repère les colonnes vides ou incohérentes et propose des corrections." },
      { label: "Remplir", prompt: "Ajoute des lignes d'exemple réalistes dans la table active." },
    ],
    tools: TABLES_TOOLS,
    context: async () => {
      if (!currentBaseId) return "Aucune base active.";
      try { return await db.schemaPrompt(currentBaseId); } catch { return "(schéma indisponible)"; }
    },
    execute: runTablesTool,
    onApplied: async () => { await loadBases(); },
  });
}

// ---------- Démarrage ----------
async function init() {
  if (!db.hasBackend) {
    $("status").textContent = "Hors application";
    $("empty").textContent = "Ouvrez cette app depuis Lumen Desktop (le bureau).";
    return;
  }
  await loadBases();
  wire();
  mountTablesAI();
  // « Envoyer vers Bases de données » : un tableau devient une table remplie.
  receive("tables", async (obj) => {
    const cols = (obj.columns || []).map((c) => String(c || "").trim()).filter(Boolean);
    if (!cols.length) return;
    const name = (obj.title || "import").replace(/[^\w\s-]/g, "").trim().slice(0, 40) || "import";
    await runTablesTool("create_table", { name, columns: cols.map((c) => ({ name: c, type: "text" })) });
    const rows = (obj.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r?.[i] ?? ""])));
    if (rows.length) await runTablesTool("insert_rows", { table: name, rows });
    await loadBases();
  });
}

async function loadBases() {
  bases = await db.listBases().catch(() => []);
  connections = ((await tauriInvoke?.("datasources_list").catch(() => [])) || []).filter((c) => c.enabled !== false);
  const sel = $("base-select");
  sel.innerHTML = "";
  for (const b of bases) {
    const o = document.createElement("option");
    o.value = b.base_id; o.textContent = `${b.name} (${b.tables})`;
    sel.appendChild(o);
  }
  if (connections.length) {
    const g = document.createElement("optgroup");
    g.label = "Connexions partagées (lecture seule)";
    for (const c of connections) {
      const o = document.createElement("option");
      o.value = db.CONNECTION_PREFIX + c.id; o.textContent = c.name || c.id;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  const all = [...bases.map((b) => b.base_id), ...connections.map((c) => db.CONNECTION_PREFIX + c.id)];
  if (all.length) {
    currentBaseId = all.includes(currentBaseId) ? currentBaseId : all[0];
    sel.value = currentBaseId;
    await loadTables();
  } else {
    currentBaseId = ""; tables = []; currentTableId = "";
    renderTableList(); renderGrid();
  }
}

async function loadTables() {
  applyReadOnly();
  if (onConnection()) {
    // Jeux de données de la connexion, présentés comme des tables.
    const src = connectionOf(currentBaseId);
    const sets = src ? await tauriInvoke("datasources_datasets", { id: src.id }).catch(() => []) : [];
    tables = (sets || []).map((d) => ({ table_id: d.name, name: d.name, rows: d.rows ?? "" }));
  } else tables = currentBaseId ? await db.listTables(currentBaseId).catch(() => []) : [];
  currentTableId = tables.some((t) => t.table_id === currentTableId) ? currentTableId : (tables[0]?.table_id || "");
  // La portée IA est propre à chaque base : on revient à « toute la base ».
  aiScope = { mode: "base" };
  updateScopeLabel();
  renderTableList();
  await loadGrid();
}

function updateScopeLabel() {
  const btn = $("ai-scope");
  if (!btn) return;
  if (aiScope.mode === "tables" && (aiScope.ids || []).length) {
    const n = aiScope.ids.length;
    btn.textContent = n === 1
      ? `Portée : ${truncate(tables.find((t) => t.table_id === aiScope.ids[0])?.name || "1 table", 18)}`
      : `Portée : ${n} tables`;
  } else {
    btn.textContent = "Portée : toute la base";
  }
}
function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// Sélecteur de portée : « toute la base » ou un sous-ensemble de tables (cases).
async function chooseScope() {
  if (!currentBaseId) { toast("Sélectionnez une base."); return; }
  if (!tables.length) { toast("Aucune table à interroger."); return; }
  const wrap = document.createElement("form");
  wrap.className = "modal-pick scope-pick";
  const allLab = document.createElement("label");
  allLab.className = "scope-all";
  const allCb = document.createElement("input");
  allCb.type = "radio"; allCb.name = "scope-mode"; allCb.checked = aiScope.mode !== "tables";
  allLab.append(allCb, document.createTextNode(" Toute la base"));
  wrap.appendChild(allLab);
  const subLab = document.createElement("label");
  subLab.className = "scope-all";
  const subCb = document.createElement("input");
  subCb.type = "radio"; subCb.name = "scope-mode"; subCb.checked = aiScope.mode === "tables";
  subLab.append(subCb, document.createTextNode(" Tables choisies :"));
  wrap.appendChild(subLab);
  const list = document.createElement("div");
  list.className = "scope-list";
  const boxes = [];
  for (const t of tables) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = t.table_id;
    cb.checked = aiScope.mode === "tables" && (aiScope.ids || []).includes(t.table_id);
    cb.addEventListener("change", () => { if (cb.checked) subCb.checked = true; });
    lab.append(cb, document.createTextNode(" " + t.name));
    list.appendChild(lab); boxes.push(cb);
  }
  wrap.appendChild(list);
  const row = document.createElement("div"); row.className = "row";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn ghost"; cancel.textContent = "Annuler";
  cancel.addEventListener("click", () => closeModal());
  const ok = document.createElement("button"); ok.type = "submit"; ok.className = "btn primary"; ok.textContent = "Appliquer";
  row.append(cancel, ok); wrap.appendChild(row);
  wrap.addEventListener("submit", (e) => {
    e.preventDefault();
    if (subCb.checked) {
      const ids = boxes.filter((b) => b.checked).map((b) => b.value);
      aiScope = ids.length ? { mode: "tables", ids } : { mode: "base" };
    } else {
      aiScope = { mode: "base" };
    }
    modalResolve = null; closeModal(); updateScopeLabel();
  });
  modalResolve = () => {};
  openModal("Portée de l'IA", wrap);
}

function renderTableList() {
  const ul = $("table-list");
  ul.innerHTML = "";
  for (const t of tables) {
    const li = document.createElement("li");
    li.className = t.table_id === currentTableId ? "active" : "";
    li.innerHTML = `<span class="t-name">${esc(t.name)}</span><span class="t-right"><span class="t-count">${t.rows}</span>${onConnection() ? "" : `<button class="t-del" type="button" title="Supprimer la table">✕</button>`}</span>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".t-del")) return;
      currentTableId = t.table_id; renderTableList(); loadGrid();
    });
    if (onConnection()) { ul.appendChild(li); continue; }
    li.addEventListener("dblclick", () => renameTablePrompt(t));
    li.querySelector(".t-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await confirmModal(`Supprimer la table « ${t.name} » et toutes ses données ?`))) return;
      await db.deleteTable(t.table_id);
      if (currentTableId === t.table_id) currentTableId = "";
      if (aiScope.mode === "tables") aiScope.ids = (aiScope.ids || []).filter((id) => id !== t.table_id);
      await loadTables();
      toast("Table supprimée.");
    });
    ul.appendChild(li);
  }
}

async function loadGrid() {
  if (!currentTableId) { schema = []; renderGrid(); return; }
  if (onConnection()) {
    const src = connectionOf(currentBaseId);
    try {
      const page = await tauriInvoke("datasources_rows", { id: src.id, dataset: currentTableId, limit: 1000 });
      const cols = page?.columns || [];
      schema = cols.map((c) => ({ col_id: c, name: c, type: "text" }));
      renderGrid((page?.rows || []).map((r) => (Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r)));
    } catch (e) {
      schema = [];
      $("grid-wrap").innerHTML = `<p class="empty-note">${esc(String(e?.message || e))}</p>`;
    }
    return;
  }
  schema = await db.tableSchema(currentTableId).catch(() => []);
  const res = await db.rows(currentTableId, 1000, 0).catch(() => ({ rows: [] }));
  renderGrid(res.rows || []);
}

function renderGrid(rowData = []) {
  const wrap = $("grid-wrap");
  const tools = $("grid-tools");
  if (!currentTableId) {
    tools.hidden = true;
    wrap.innerHTML = `<p class="empty-note">${bases.length ? "Créez ou sélectionnez une table." : "Créez une base puis une table pour commencer."}</p>`;
    return;
  }
  tools.hidden = false;
  const table = document.createElement("table");
  table.className = "grid";
  // En-têtes
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  htr.innerHTML = `<th class="col-th-idx">#</th>`;
  for (const c of schema) {
    const th = document.createElement("th");
    const inner = document.createElement("div");
    inner.className = "th-inner";
    inner.innerHTML = `<span class="th-name">${esc(c.name)}</span><span class="th-type">${TYPE_LABEL[c.type] || c.type}</span>`;
    if (!onConnection()) inner.addEventListener("click", () => columnMenu(c));
    th.appendChild(inner);
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);
  // Lignes
  const tbody = document.createElement("tbody");
  rowData.forEach((row, i) => {
    const tr = document.createElement("tr");
    const idx = document.createElement("td");
    idx.className = "col-th-idx";
    idx.textContent = String(i + 1);
    const readOnly = onConnection();
    const del = document.createElement("button");
    del.className = "row-del"; del.textContent = "✕"; del.title = "Supprimer la ligne";
    del.addEventListener("click", async () => { await db.deleteRow(currentTableId, row._id); await loadGrid(); await refreshCounts(); });
    if (!readOnly) idx.appendChild(del);
    tr.appendChild(idx);
    for (const c of schema) {
      const td = document.createElement("td");
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.contentEditable = readOnly ? "false" : "true";
      const v = row[c.col_id];
      cell.textContent = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      if (!readOnly) cell.addEventListener("blur", async () => {
        const raw = cell.textContent;
        const val = coerce(raw, c.type);
        await db.updateRow(currentTableId, row._id, { [c.col_id]: val }).catch((e) => toast("Échec : " + (e.message || e)));
      });
      td.appendChild(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function coerce(raw, type) {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  if (type === "number") { const n = Number(s); return Number.isFinite(n) ? n : s; }
  if (type === "bool") return /^(1|true|vrai|oui|x)$/i.test(s);
  return s;
}

/** Connexion partagée : on masque tout ce qui écrit, on garde lecture, export, IA (si SQL). */
function applyReadOnly() {
  const ro = onConnection();
  for (const id of ["row-add", "col-add", "table-new", "base-del", "csv-import"]) { const el = $(id); if (el) el.hidden = ro; }
  const copy = $("conn-copy"); if (copy) copy.hidden = !ro;
  const src = ro ? connectionOf(currentBaseId) : null;
  const sqlOk = !ro || !!src?.allowSql;
  $("ai-go").disabled = !sqlOk;
  $("ai-q").placeholder = sqlOk
    ? "Demandez à l'IA : « combien de lignes par catégorie ? »"
    : "SQL libre désactivé sur cette connexion (Sources de données) : IA indisponible";
  $("status").textContent = ro ? `Connexion partagée · ${src?.kind || ""} · lecture seule` : "SQLite local";
}

/** Recopie le jeu affiché dans une base locale (pour l'éditer ou le croiser). */
async function copyToLocal() {
  if (!onConnection() || !currentTableId) return;
  if (!bases.length) { toast("Créez d'abord une base locale."); return; }
  const target = bases.length === 1 ? bases[0] : await pickModal("Copier dans la base…", bases.map((b) => ({ value: b, label: b.name })));
  if (!target) return;
  try {
    const src = connectionOf(currentBaseId);
    const page = await tauriInvoke("datasources_rows", { id: src.id, dataset: currentTableId, limit: 100000 });
    const csv = pageToCsv(page);
    await db.importCsv(target.base_id, `${currentTableId}`.slice(0, 40), csv);
    toast(`Copié dans « ${target.name} ».`);
    await loadBases();
  } catch (e) { toast("Échec de la copie : " + (e.message || e)); }
}

async function refreshCounts() {
  tables = currentBaseId ? await db.listTables(currentBaseId).catch(() => tables) : tables;
  renderTableList();
}

// ---------- Actions base / table ----------
async function newBase() {
  const name = await formModal("Nouvelle base", [{ key: "name", label: "Nom", value: "" }]);
  if (!name) return;
  currentBaseId = await db.createBase(name.name || "Nouvelle base");
  await loadBases();
}
async function delBase() {
  if (!currentBaseId) return;
  const b = bases.find((x) => x.base_id === currentBaseId);
  if (!(await confirmModal(`Supprimer la base « ${b?.name || ""} » et toutes ses tables ?`))) return;
  await db.deleteBase(currentBaseId);
  currentBaseId = "";
  await loadBases();
  toast("Base supprimée.");
}
async function newTable() {
  if (!currentBaseId) { toast("Créez d'abord une base."); return; }
  const r = await formModal("Nouvelle table", [{ key: "name", label: "Nom de la table", value: "Table" }]);
  if (!r) return;
  currentTableId = await db.createTable(currentBaseId, r.name || "Table", [{ name: "Nom", type: "text" }]);
  await loadTables();
}
async function renameTablePrompt(t) {
  const r = await formModal("Renommer la table", [{ key: "name", label: "Nom", value: t.name }]);
  if (!r) return;
  await db.renameTable(t.table_id, r.name || t.name);
  await loadTables();
}

async function columnMenu(c) {
  const r = await formModal(`Colonne « ${c.name} »`, [
    { key: "name", label: "Nom", value: c.name },
    { key: "type", label: "Type", value: c.type, options: COL_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })) },
  ], { extraButton: "Supprimer la colonne" });
  if (r === "EXTRA") {
    if (await confirmModal(`Supprimer la colonne « ${c.name} » et ses données ?`)) {
      await db.deleteColumn(c.col_id); await loadGrid();
    }
    return;
  }
  if (!r) return;
  if (r.name && r.name !== c.name) await db.renameColumn(c.col_id, r.name);
  if (r.type && r.type !== c.type) await db.retypeColumn(c.col_id, r.type);
  await loadGrid();
}

async function addColumn() {
  const r = await formModal("Nouvelle colonne", [
    { key: "name", label: "Nom", value: "Colonne" },
    { key: "type", label: "Type", value: "text", options: COL_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })) },
  ]);
  if (!r) return;
  await db.addColumn(currentTableId, r.name || "Colonne", r.type || "text");
  await loadGrid();
}
async function addRow() {
  await db.insertRow(currentTableId, {});
  await loadGrid(); await refreshCounts();
}

// ---------- CSV ----------
async function exportCsv() {
  if (!currentTableId) return;
  try {
    const csv = onConnection()
      ? pageToCsv(await tauriInvoke("datasources_rows", { id: connectionOf(currentBaseId).id, dataset: currentTableId, limit: 100000 }))
      : await db.exportCsv(currentTableId);
    const boxes = await invokeSandboxList();
    if (!boxes.length) { toast("Aucune sandbox. Créez-en une dans Fichiers."); return; }
    const box = boxes.length === 1 ? boxes[0] : await pickModal("Exporter dans…", boxes.map((b) => ({ value: b, label: b.name || b.id })));
    if (!box) return;
    const t = tables.find((x) => x.table_id === currentTableId);
    const name = `tables/${slug(t?.name || "table")}.csv`;
    await sandboxWrite(box.id, name, csv);
    toast(`Exporté → ${box.name || box.id} / ${name}`);
  } catch (e) { toast("Échec export : " + (e.message || e)); }
}
async function importCsv(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if (!file) return;
  if (!currentBaseId) { toast("Sélectionnez d'abord une base."); return; }
  const text = await file.text();
  const name = file.name.replace(/\.csv$/i, "") || "Import";
  try {
    currentTableId = await db.importCsv(currentBaseId, name, text);
    await loadTables();
    toast("CSV importé.");
  } catch (e) { toast("Échec import : " + (e.message || e)); }
}

// Accès sandbox direct (l'app tables est privilégiée — même origine que Lumen).
const tauriInvoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const invokeSandboxList = () => tauriInvoke("sandbox_list").catch(() => []);
const sandboxWrite = (id, path, content) => tauriInvoke("sandbox_write_file", { id, path, content });

// ---------- IA ----------
async function askAi() {
  const q = $("ai-q").value.trim();
  if (!q) return;
  if (!currentBaseId) { toast("Sélectionnez une base."); return; }
  const btn = $("ai-go"); btn.disabled = true; btn.textContent = "…";
  try {
    const onlyIds = aiScope.mode === "tables" ? aiScope.ids : null;
    const { answer, steps } = await db.investigate(currentBaseId, q, onlyIds);
    showInvestigation(q, answer, steps);
  } catch (e) {
    toast("Échec : " + (e.message || e));
  } finally { btn.disabled = false; btn.textContent = "Interroger l'IA"; }
}

// Affiche la réponse rédigée par l'IA, puis le détail des requêtes exécutées.
function showInvestigation(question, answer, steps) {
  const body = document.createElement("div");

  const ansBox = document.createElement("div");
  ansBox.className = "ai-answer";
  ansBox.textContent = answer || "(pas de réponse)";
  body.appendChild(ansBox);

  if (steps && steps.length) {
    const det = document.createElement("details");
    det.className = "ai-steps";
    const sum = document.createElement("summary");
    sum.textContent = steps.length === 1 ? "Voir la requête SQL" : `Voir les ${steps.length} requêtes SQL`;
    det.appendChild(sum);
    steps.forEach((st, i) => {
      const pre = document.createElement("div");
      pre.className = "sql";
      pre.textContent = (steps.length > 1 ? `-- Requête ${i + 1}\n` : "") + st.sql;
      det.appendChild(pre);
      if (st.rows && st.rows.length) {
        const tbl = document.createElement("table");
        tbl.innerHTML = "<thead><tr>" + (st.columns || []).map((c) => `<th>${esc(c)}</th>`).join("") + "</tr></thead>";
        const tb = document.createElement("tbody");
        for (const r of st.rows.slice(0, 200)) {
          tb.innerHTML += "<tr>" + r.map((v) => `<td>${esc(v == null ? "" : String(v))}</td>`).join("") + "</tr>";
        }
        tbl.appendChild(tb);
        det.appendChild(tbl);
      } else {
        const p = document.createElement("p"); p.className = "ai-empty"; p.textContent = "Aucune ligne.";
        det.appendChild(p);
      }
    });
    body.appendChild(det);
  }
  openModal("Réponse de l'IA", body);
}

// ---------- Modales ----------
let modalResolve = null;
function openModal(title, bodyEl) {
  $("modal-title").textContent = title;
  const body = $("modal-body"); body.innerHTML = ""; body.appendChild(bodyEl);
  $("modal").hidden = false;
}
function closeModal() {
  $("modal").hidden = true; $("modal-body").innerHTML = "";
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(null); }
}

// Formulaire générique → résout avec un objet {key:value}, "EXTRA", ou null.
function formModal(title, fields, opts = {}) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    const form = document.createElement("form");
    form.className = "modal-pick";
    const inputs = {};
    for (const f of fields) {
      const lab = document.createElement("label"); lab.textContent = f.label;
      let input;
      if (f.options) {
        input = document.createElement("select");
        for (const o of f.options) {
          const opt = document.createElement("option"); opt.value = o.value; opt.textContent = o.label; input.appendChild(opt);
        }
        input.value = f.value || f.options[0].value;
      } else {
        input = document.createElement("input"); input.value = f.value || "";
      }
      inputs[f.key] = input;
      lab.appendChild(input); form.appendChild(lab);
    }
    const row = document.createElement("div"); row.className = "row";
    if (opts.extraButton) {
      const ex = document.createElement("button"); ex.type = "button"; ex.className = "btn ghost"; ex.textContent = opts.extraButton;
      ex.style.marginRight = "auto"; ex.style.color = "var(--red)";
      ex.addEventListener("click", () => { modalResolve = null; closeModal(); resolve("EXTRA"); });
      row.appendChild(ex);
    }
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn ghost"; cancel.textContent = "Annuler";
    cancel.addEventListener("click", () => closeModal());
    const ok = document.createElement("button"); ok.type = "submit"; ok.className = "btn primary"; ok.textContent = "Valider";
    row.append(cancel, ok); form.appendChild(row);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const out = {}; for (const k in inputs) out[k] = inputs[k].value.trim ? inputs[k].value.trim() : inputs[k].value;
      modalResolve = null; closeModal(); resolve(out);
    });
    openModal(title, form);
    setTimeout(() => fields[0] && inputs[fields[0].key]?.focus(), 30);
  });
}

function confirmModal(message) {
  return new Promise((resolve) => {
    modalResolve = () => resolve(false);
    const wrap = document.createElement("div"); wrap.className = "modal-pick";
    const p = document.createElement("p"); p.textContent = message; wrap.appendChild(p);
    const row = document.createElement("div"); row.className = "row";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn ghost"; cancel.textContent = "Annuler";
    cancel.addEventListener("click", () => closeModal());
    const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn primary"; ok.textContent = "Confirmer";
    ok.addEventListener("click", () => { modalResolve = null; closeModal(); resolve(true); });
    row.append(cancel, ok); wrap.appendChild(row);
    openModal("Confirmation", wrap);
  });
}

function pickModal(title, options) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    const wrap = document.createElement("div"); wrap.className = "modal-pick";
    for (const o of options) {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.textContent = o.label;
      b.addEventListener("click", () => { modalResolve = null; closeModal(); resolve(o.value); });
      wrap.appendChild(b);
    }
    openModal(title, wrap);
  });
}

// ---------- Câblage ----------
function wire() {
  $("base-select").addEventListener("change", (e) => { currentBaseId = e.target.value; loadTables(); });
  $("base-new").addEventListener("click", newBase);
  $("base-del").addEventListener("click", delBase);
  $("table-new").addEventListener("click", newTable);
  $("row-add").addEventListener("click", addRow);
  $("col-add").addEventListener("click", addColumn);
  $("csv-export").addEventListener("click", exportCsv);
  $("conn-copy")?.addEventListener("click", copyToLocal);
  $("csv-import").addEventListener("click", () => $("csv-file").click());
  $("csv-file").addEventListener("change", importCsv);
  $("ai-go").addEventListener("click", askAi);
  $("ai-scope").addEventListener("click", chooseScope);
  $("ai-q").addEventListener("keydown", (e) => { if (e.key === "Enter") askAi(); });
  $("modal-close").addEventListener("click", closeModal);
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").hidden) closeModal(); });
}

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2800);
}
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function slug(s) { return String(s || "table").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "table"; }

init();

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
