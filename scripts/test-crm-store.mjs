#!/usr/bin/env node
// Tests de la couche données du mini-ERP (src/crm/store.js).
//
//   node --test scripts/test-crm-store.mjs
//
// Le backend `table_*` adresse les colonnes par identifiant opaque (`c_<id>`) :
// tout l'intérêt de store.js est la traduction « nom convivial ⇄ col_id ». On
// simule donc les commandes Tauri en mémoire — assez fidèlement pour que la
// traduction soit réellement exercée — et on vérifie l'aller-retour, la
// création idempotente du schéma et l'ajout de colonne sur une base existante.

import assert from "node:assert/strict";
import test from "node:test";

const db = { bases: [], tables: [], columns: [], rows: new Map(), seq: 0 };
const id = () => `x${++db.seq}`;

const commands = {
  table_base_list: () => db.bases.map((b) => ({ ...b, tables: db.tables.filter((t) => t.base_id === b.base_id).length })),
  table_base_create: ({ name }) => { const base_id = id(); db.bases.push({ base_id, name }); return base_id; },
  table_list: ({ baseId }) => db.tables.filter((t) => t.base_id === baseId),
  table_create: ({ baseId, name, columns }) => {
    const table_id = id();
    db.tables.push({ table_id, base_id: baseId, name });
    (columns || []).forEach((c) => db.columns.push({ col_id: id(), table_id, name: c.name, type: c.type }));
    db.rows.set(table_id, []);
    return table_id;
  },
  table_schema: ({ tableId }) => db.columns.filter((c) => c.table_id === tableId),
  table_column_add: ({ tableId, name, colType }) => { db.columns.push({ col_id: id(), table_id: tableId, name, type: colType }); },
  table_rows: ({ tableId }) => ({ rows: db.rows.get(tableId) || [] }),
  table_row_insert: ({ tableId, values }) => {
    const rows = db.rows.get(tableId);
    const _id = rows.length + 1;
    rows.push({ _id, ...values });
    return _id;
  },
  table_row_update: ({ tableId, rowId, values }) => {
    const row = db.rows.get(tableId).find((r) => r._id === rowId);
    Object.assign(row, values);
  },
  table_row_delete: ({ tableId, rowId }) => {
    const rows = db.rows.get(tableId);
    rows.splice(rows.findIndex((r) => r._id === rowId), 1);
  },
};

globalThis.window = globalThis;
globalThis.__TAURI__ = { core: { invoke: async (cmd, args = {}) => {
  if (!commands[cmd]) throw new Error(`commande non simulée : ${cmd}`);
  return commands[cmd](args);
} } };

const store = await import("../src/crm/store.js");

test("le schéma crée la base ERP et ses tables", async () => {
  await store.ensureSchema();
  assert.equal(db.bases.length, 1);
  assert.equal(db.bases[0].name, "ERP");
  const names = db.tables.map((t) => t.name).sort();
  assert.deepEqual(names, ["Articles", "Clients", "Devis", "Factures", "Lignes devis", "Lignes facture", "Mouvements stock", "Projets", "Société", "Tâches"]);
});

test("un second démarrage ne duplique rien", async () => {
  await store.ensureSchema();
  assert.equal(db.bases.length, 1);
  assert.equal(db.tables.length, 10);
});

test("les lignes font l'aller-retour par nom de colonne", async () => {
  await store.insert("articles", { "Référence": "FORM-01", "Désignation": "Formation", "Prix HT": 800, "TVA": 20, "Suivi stock": true, "Stock": 5 });
  const [article] = await store.list("articles");
  assert.equal(article["Référence"], "FORM-01");
  assert.equal(article["Prix HT"], 800);
  assert.equal(article["Suivi stock"], true);
  // La ligne physique n'utilise QUE des identifiants de colonnes : c'est ce
  // que le backend attend, et ce que l'app ne doit jamais manipuler.
  const physical = db.rows.get(db.tables.find((t) => t.name === "Articles").table_id)[0];
  assert.ok(Object.keys(physical).every((k) => k === "_id" || /^x\d+$/.test(k)));
});

test("une mise à jour ne touche que les champs fournis", async () => {
  const [article] = await store.list("articles");
  await store.update("articles", article._id, { "Stock": 2 });
  const [after] = await store.list("articles");
  assert.equal(after["Stock"], 2);
  assert.equal(after["Désignation"], "Formation");
});

test("les lignes d'un document sont remplacées, pas empilées", async () => {
  await store.replaceLines("lignesDevis", "D2026-0001", [
    { "Désignation": "Jour 1", "Quantité": 1 },
    { "Désignation": "Jour 2", "Quantité": 1 },
  ]);
  await store.replaceLines("lignesDevis", "D2026-0001", [{ "Désignation": "Forfait", "Quantité": 1 }]);
  const lines = await store.linesOf("lignesDevis", "D2026-0001");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]["Désignation"], "Forfait");
  assert.equal(lines[0]["Rang"], 1);
});

test("les lignes d'un autre document ne sont pas emportées", async () => {
  await store.replaceLines("lignesDevis", "D2026-0002", [{ "Désignation": "Audit", "Quantité": 2 }]);
  await store.replaceLines("lignesDevis", "D2026-0001", [{ "Désignation": "Forfait revu", "Quantité": 1 }]);
  assert.equal((await store.linesOf("lignesDevis", "D2026-0002")).length, 1);
  assert.equal((await store.linesOf("lignesDevis", "D2026-0001"))[0]["Désignation"], "Forfait revu");
});

test("une colonne ajoutée au schéma apparaît sur une base existante", async () => {
  const articles = db.tables.find((t) => t.name === "Articles");
  const removed = db.columns.findIndex((c) => c.table_id === articles.table_id && c.name === "Coût achat");
  db.columns.splice(removed, 1);            // simule une base créée par une version antérieure
  await store.ensureSchema();
  assert.ok(db.columns.some((c) => c.table_id === articles.table_id && c.name === "Coût achat"));
});

test("les tags sont une colonne de la base, lisible par les autres apps", async () => {
  await store.insert("clients", { "Nom": "Dupont SAS", "Tags": "grossiste, prioritaire" });
  const [client] = await store.list("clients");
  assert.equal(client["Tags"], "grossiste, prioritaire");
  for (const table of ["Articles", "Clients", "Devis", "Factures"]) {
    const t = db.tables.find((x) => x.name === table);
    assert.ok(db.columns.some((c) => c.table_id === t.table_id && c.name === "Tags"), `${table} sans colonne Tags`);
  }
});
