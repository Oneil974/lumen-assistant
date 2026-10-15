// Espace Données : une connexion partagée se lit comme une base (tables/client.js).
import { test } from "node:test";
import assert from "node:assert/strict";

const calls = [];
globalThis.window = { __TAURI__: { core: { invoke: async (cmd, args) => {
  calls.push([cmd, args]);
  switch (cmd) {
    case "table_base_list": return [{ base_id: "b1", name: "Locale", tables: 1 }];
    case "table_query": return { columns: ["n"], rows: [[1]] };
    case "datasources_list": return [
      { id: "pg", name: "Entrepôt", kind: "postgres", enabled: true, allowSql: true },
      { id: "api", name: "API", kind: "rest", enabled: true, allowSql: false },
    ];
    case "datasources_query": return { columns: ["a", "b"], rows: [{ a: 1, b: "x" }] };
    case "datasources_datasets": return [{ name: "ventes", rows: 3 }];
    case "datasources_schema": return { columns: [{ name: "montant", type: "numeric" }] };
    default: throw new Error(`inattendu : ${cmd}`);
  }
} } } };
const db = await import("../src/tables/client.js");
const { pageToCsv } = await import("../src/lib/data-catalog.js");

test("les connexions SQL s'ajoutent aux bases, les autres non", async () => {
  const list = await db.listQueryableBases();
  assert.deepEqual(list.map((b) => b.base_id), ["b1", "ds:pg"]);
});

test("la requête part vers la bonne commande et rend des lignes tableau", async () => {
  assert.deepEqual(await db.query("b1", "SELECT 1"), { columns: ["n"], rows: [[1]] });
  assert.deepEqual(await db.query("ds:pg", "SELECT a, b FROM t"), { columns: ["a", "b"], rows: [[1, "x"]] });
  assert.deepEqual(calls.find((c) => c[0] === "datasources_query")[1], { id: "pg", sql: "SELECT a, b FROM t" });
});

test("le schéma d'une connexion est lisible par l'IA", async () => {
  assert.match(await db.schemaPrompt("ds:pg"), /Table "ventes" — 3 ligne\(s\) — colonnes : "montant" \(numeric\)/);
});

test("export CSV d'une page de connexion", () => {
  assert.equal(pageToCsv({ columns: ["a", "b"], rows: [[1, "x,y"], { a: 2, b: 'q"' }] }), 'a,b\n1,"x,y"\n2,"q"""');
});
