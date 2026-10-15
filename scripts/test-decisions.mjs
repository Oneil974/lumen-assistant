// Tests du « système 1 » (src/lib/decisions.js) sans modèle : transport simulé.
import test from "node:test";
import assert from "node:assert/strict";
import { createDecider, DECISIONS } from "../src/lib/decisions.js";

const fixed = (key, confidence = 0.9) => async () => ({ key, confidence });

test("oui/non typé", async () => {
  const d = createDecider(fixed("yes"));
  assert.deepEqual((await d.decide("injection", { content: "x" })).value, true);
});

test("note : niveau et valeurs dérivées", async () => {
  const r = await createDecider(fixed("trivial")).decide("effort", { query: "merci" });
  assert.equal(r.level, 0);
  assert.equal(r.verify, false);
  assert.equal(r.think, false);
  const high = await createDecider(fixed("high")).decide("actionRisk", { tool: "mail_send", args: {} });
  assert.equal(high.needsApproval, true);
});

test("confiance sous le seuil global : abstention (null)", async () => {
  assert.equal(await createDecider(fixed("yes", 0.3)).decide("injection", { content: "x" }), null);
});

test("seuil propre à la décision", async () => {
  // toolPick exige 0,6 : 0,55 passe le seuil global mais pas le sien.
  const tools = [{ name: "weather_now", description: "Météo" }];
  assert.equal(await createDecider(fixed("weather_now", 0.55)).decide("toolPick", { query: "pluie ?", tools }), null);
  assert.equal((await createDecider(fixed("weather_now", 0.7)).decide("toolPick", { query: "pluie ?", tools })).value, "weather_now");
});

test("moteur en erreur ou absent : abstention, jamais d'exception", async () => {
  const boom = createDecider(async () => { throw new Error("hors ligne"); });
  assert.equal(await boom.decide("triage", { subject: "x" }), null);
  assert.equal(await createDecider(null).decide("mood", { event: "x" }), null);
});

test("chaque décision construit 2 à 24 options et a des cas de banc", () => {
  for (const [name, d] of Object.entries(DECISIONS)) {
    const vars = { ...(d.bench?.[0]?.vars || {}) };
    if (vars.tools === "@tools") vars.tools = [{ name: "a", description: "A" }, { name: "b", description: "B" }];
    const { options } = d.build(vars);
    const n = Array.isArray(options) ? options.length : 2;
    assert.ok(n >= 2 && n <= 24, `${name} : ${n} options`);
    assert.ok(d.bench?.length, `${name} sans cas de banc`);
  }
});

test("un seuil de décision plus BAS que le seuil global s'applique", async () => {
  // xrIntent accepte 0,4 (ses erreurs retombent sur « chat », le repli sûr).
  const r = await createDecider(fixed("open_agents", 0.44)).decide("xrIntent", { text: "Montre-moi mes agents" });
  assert.equal(r.value, "open_agents");
  assert.equal(await createDecider(fixed("open_agents", 0.3)).decide("xrIntent", { text: "x" }), null);
});
