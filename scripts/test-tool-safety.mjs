// Sûreté des appels d'outils de la réponse orchestrée :
//   • deux écritures identiques demandées l'une après l'autre sont EXÉCUTÉES
//     deux fois (pas de cache sur une action) ;
//   • une écriture dont la confirmation se perd n'est pas relancée ;
//   • une lecture en erreur passagère, elle, est retentée ;
//   • le cache distingue les arguments imbriqués ;
//   • la barre et le bureau transmettent le même profil de backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runOrchestrated, clearToolCache, limitsFor } from "../src/lib/orchestrator.js";
import { runTool } from "../src/lib/tool-cache.js";
import { toolMeta, stableStringify, isRetrySafe } from "../src/lib/tool-meta.js";
import { mainBackendSnapshot } from "../src/lib/orchestrator-host.js";

const spec = (name, props = {}) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: Object.fromEntries(Object.keys(props).map((k) => [k, { type: props[k] }])) } } });
const TOOLS = [
  spec("notes_append", { title: "string", text: "string" }),
  spec("create_reminder", { text: "string" }),
  spec("weather_now", { place: "string" }),
  spec("generate_image", { prompt: "string" }),
];

/** Modèle scripté : un tour d'appels, puis « PRÊT ». */
function scripted(calls, categories) {
  let round = 0;
  return async (messages, opts = {}) => {
    const step = (opts.schemaName || "").replace("lumen_", "");
    let content = "", message = {};
    if (step === "analyze") content = JSON.stringify({ intent: "x", needs_tools: true, needs_data: true, complexity: "moderate", subquestions: [] });
    else if (step === "route") content = JSON.stringify({ categories, reason: "test" });
    else if (step === "verify") content = JSON.stringify({ grounded: true, complete: true, issues: [] });
    else if (opts.tools) {
      message = round++ === 0
        ? { role: "assistant", content: "", tool_calls: calls.map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : { role: "assistant", content: "PRÊT" };
      content = message.content;
    } else content = "Fait.";
    return { content, data: { choices: [{ message: { ...message, content } }], usage: {} } };
  };
}
const view = { update() {}, toolResult() {}, nextTurn() {}, finish() {} };
const plan = () => ({ start() {}, done() {}, skip() {}, note() {}, wait() {}, tool() {}, hold() {}, release() {}, finish() {}, fail() {}, count: () => 0, snapshot: () => ({ steps: [] }) });
const run = (query, calls, categories, execTool, extra = {}) => runOrchestrated({
  query, history: [], tools: TOOLS, chat: scripted(calls, categories), execTool, view, plan: plan(),
  limits: { heartbeatMs: 1e9 }, ...extra,
});

test("deux ajouts identiques à une note sont exécutés deux fois", async () => {
  clearToolCache();
  let writes = 0;
  const exec = async () => { writes++; return "Ajouté à la note « Courses »."; };
  const call = [{ name: "notes_append", args: { title: "Courses", text: "lait" } }];
  await run("Ajoute lait à Courses", call, ["apps"], exec, { cacheScope: "conv-1" });
  await run("Ajoute lait à Courses", call, ["apps"], exec, { cacheScope: "conv-1" });
  assert.equal(writes, 2);
});

test("une image générée deux fois n'est pas servie depuis le cache", async () => {
  clearToolCache();
  let n = 0;
  const exec = async () => `Image ${++n}`;
  const call = [{ name: "generate_image", args: { prompt: "chat" } }];
  await run("Dessine un chat", call, ["live"], exec, { cacheScope: "conv-1" });
  await run("Dessine un chat", call, ["live"], exec, { cacheScope: "conv-1" });
  assert.equal(n, 2);
});

test("un rappel dont la confirmation se perd n'est pas recréé", async () => {
  clearToolCache();
  let created = 0;
  const exec = async () => { created++; return "Erreur : délai réseau dépassé (ECONNRESET)"; };
  await run("Rappelle-moi d'appeler Léa", [{ name: "create_reminder", args: { text: "appeler Léa" } }], ["memory"], exec);
  assert.equal(created, 1);
});

test("une lecture en erreur passagère est retentée une fois", async () => {
  clearToolCache();
  let calls = 0;
  const exec = async () => (++calls === 1 ? "Erreur : timeout réseau" : "Paris : 18 °C");
  await run("Météo à Paris", [{ name: "weather_now", args: { place: "Paris" } }], ["live"], exec);
  assert.equal(calls, 2);
});

test("le même identifiant d'opération n'agit qu'une fois", async () => {
  clearToolCache();
  let n = 0;
  const op = () => runTool({ name: "create_reminder", args: { text: "x" }, conversation: "c", opId: "op-1" }, async () => { n++; return "Rappel créé."; });
  const [a, b] = await Promise.all([op(), op()]);
  assert.equal(n, 1);
  assert.equal(a, b);
});

test("le cache distingue les arguments imbriqués", async () => {
  clearToolCache();
  assert.notEqual(stableStringify({ filters: { status: "a" } }), stableStringify({ filters: { status: "b" } }));
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  const read = (status) => runTool({ name: "query_tables", args: { filters: { status } }, conversation: "c" }, async () => `rangs ${status}`);
  assert.equal(await read("a"), "rangs a");
  assert.equal(await read("b"), "rangs b");
});

test("une écriture vide le cache de lecture de la conversation", async () => {
  clearToolCache();
  let reads = 0;
  const read = () => runTool({ name: "notes_read", args: { title: "N" }, conversation: "c" }, async () => `v${++reads}`);
  await read(); await read();
  assert.equal(reads, 1);
  await runTool({ name: "notes_append", args: { title: "N", text: "x" }, conversation: "c" }, async () => "ok");
  await read();
  assert.equal(reads, 2);
});

test("métadonnées : action par défaut, lectures déclarées", () => {
  assert.deepEqual(toolMeta("outil_inconnu"), { readOnly: false, ttl: 0, idempotent: false });
  assert.equal(toolMeta("notes_append").readOnly, false);
  assert.equal(toolMeta("generate_image").ttl, 0);
  assert.equal(toolMeta("weather_now").readOnly, true);
  assert.equal(isRetrySafe("create_reminder"), false);
});

test("profil du backend principal, identique pour la barre et le bureau", () => {
  const store = (o) => ({ getItem: (k) => o[k] ?? null });
  assert.deepEqual(mainBackendSnapshot({ api: true, applefm: true, model: "system" }, store({})), { model: "system", source: "applefm", contextTokens: 4096 });
  assert.equal(mainBackendSnapshot({ api: true, llama: true, model: "q.gguf" }, store({ llamaNumCtx: "16384" })).contextTokens, 16384);
  assert.equal(limitsFor("system", "applefm").contextTokens, 4096);
  for (const host of ["src/main.js", "src/sandbox/desktop.js"]) {
    const src = readFileSync(new URL(`../${host}`, import.meta.url), "utf8");
    assert.match(src, /\.\.\.orchestrationBackends\(llmBackend\(\)\)/, `${host} doit transmettre le backend principal`);
    assert.match(src, /opId: ctx\?\.opId/, `${host} doit transmettre l'identifiant d'opération`);
  }
});
