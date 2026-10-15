// Espace Création : projets, versions et exports communs (lib/creative-kit.js).
import { test } from "node:test";
import assert from "node:assert/strict";

const disk = new Map();
const written = [];
globalThis.window = { __TAURI__: { core: { invoke: async (cmd, a) => {
  if (cmd === "app_state_load") return disk.get(a.name) ?? null;
  if (cmd === "app_state_save") { disk.set(a.name, a.data); return null; }
  if (cmd === "sandbox_write_file") { written.push(a); return null; }
  if (cmd === "sandbox_export_pdf") return a.path.replace(/\.html$/, ".pdf");
  throw new Error(cmd);
} } } };
const ck = await import("../src/lib/creative-kit.js");

test("un projet réunit des documents de plusieurs éditeurs, sans doublon", async () => {
  const p = await ck.createProject("Lancement");
  await ck.attachToProject(p.id, { app: "notes", ref: "n1", title: "Idées" });
  await ck.attachToProject(p.id, { app: "mindmap", ref: "map-1", title: "Plan" });
  await ck.attachToProject(p.id, { app: "notes", ref: "n1", title: "Idées v2" });
  const [got] = await ck.listProjects();
  assert.equal(got.items.length, 2);
  assert.equal(got.items[0].title, "Idées v2");
  assert.deepEqual((await ck.projectsOf("mindmap", "map-1")).map((x) => x.id), [p.id]);
  await ck.detachFromProject(p.id, "notes", "n1");
  assert.equal((await ck.listProjects())[0].items.length, 1);
});

test("versions : pas de doublon, plus récente d'abord, plafonnées", async () => {
  await ck.saveVersion("canvas", "c1", { content: "a" });
  await ck.saveVersion("canvas", "c1", { content: "a" });
  await ck.saveVersion("canvas", "c1", { content: "b" });
  assert.deepEqual((await ck.listVersions("canvas", "c1")).map((v) => v.content), ["b", "a"]);
  for (let i = 0; i < 30; i++) await ck.saveVersion("canvas", "c1", { content: `x${i}` });
  assert.equal((await ck.listVersions("canvas", "c1")).length, 20);
  assert.equal((await ck.listVersions("notes", "c1")).length, 0);
});

test("exports : formats déduits du Markdown, PDF via une page HTML", async () => {
  const doc = { title: "Plan été", markdown: "## Axes\n- **Soleil**\n- Mer" };
  assert.match(ck.renderAs("md", doc), /^# Plan été\n\n## Axes/);
  assert.match(ck.renderAs("html", doc), /<h2>Axes<\/h2>\n<ul>\n<li><strong>Soleil<\/strong><\/li>/);
  assert.doesNotMatch(ck.renderAs("txt", doc), /\*\*/);
  const pdf = await ck.exportDocument("pdf", doc, "sb");
  assert.equal(pdf, "exports/plan-ete.pdf");
  assert.equal(written.at(-1).path, "exports/plan-ete.html");
});
