// Garde-fous des petits modèles (src/lib/robust.js), sans modèle.
import test from "node:test";
import assert from "node:assert/strict";
import { schemaFromExample, matchesSchema, toolArgsSchema, checkGrounding, selectPassages, answerBudget, createAnswerCache, createExampleStore } from "../src/lib/robust.js";

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test("schéma déduit d'un exemple : types, clés obligatoires, tableaux", () => {
  const s = schemaFromExample({ central: "Jardin", branches: [{ label: "Semis", children: ["A"] }], n: 3, ok: true });
  assert.deepEqual(s.required, ["central", "branches", "n", "ok"]);
  assert.equal(s.properties.branches.items.properties.children.items.type, "string");
  assert.equal(s.properties.n.type, "integer");
  assert.ok(matchesSchema({ central: "x", branches: [], n: 1, ok: false }, s));
  assert.ok(!matchesSchema({ central: "x", branches: [] }, s));
});

test("schéma des arguments d'un outil", () => {
  const s = toolArgsSchema({ function: { parameters: { properties: { place: { type: "string" } }, required: ["place", "fantôme"] } } });
  assert.deepEqual(s.required, ["place"]);
  assert.equal(s.additionalProperties, false);
});

test("vérification par code : valeur inventée repérée, arrondis et formats tolérés", () => {
  const data = "Lyon : 17,4 °C. Facture : 1 250,50 €. Réunion à 14 h 30.";
  assert.deepEqual(checkGrounding("Il fait 25 °C [1].", { data }), ["25"]);
  assert.deepEqual(checkGrounding("Il fait 17 °C, la facture fait 1250,50 € et la réunion est à 14 h 30 [1].", { data }), []);
  assert.deepEqual(checkGrounding("Voici 3 options pour 2026.", { data }), []);
  assert.deepEqual(checkGrounding("Tu m'as dit 42 ans.", { data, context: "j'ai 42 ans" }), []);
  // Un calcul sur les données n'est pas une invention.
  assert.deepEqual(checkGrounding("Total : 1 450 €, soit 200 € d'écart ; le loyer pèse 70 %.", { data: "Loyer 700 €, courses 500 €, transport 250 €. Budget 1 000 €." }), []);
});

test("passages utiles : la réponse enfouie au milieu d'un long texte est gardée", () => {
  const filler = (i) => `Paragraphe ${i} sur un sujet sans rapport, rempli de mots divers pour faire du volume et occuper la place.`.repeat(4);
  const doc = [filler(0), ...Array.from({ length: 20 }, (_, i) => filler(i + 1)), "Le loyer du bureau de Nantes est de 1 800 euros par mois.", ...Array.from({ length: 20 }, (_, i) => filler(i + 30))].join("\n\n");
  const out = selectPassages(doc, "Quel est le loyer à Nantes ?", 1500);
  assert.ok(out.length <= 1500);
  assert.match(out, /1 800 euros/);
  assert.equal(selectPassages("court", "x", 1500), "court");
});

test("budget de rédaction selon l'effort", () => {
  assert.equal(answerBudget(undefined), 0);
  assert.equal(answerBudget(0), 400);
  assert.ok(answerBudget(0, { thinking: true }) > answerBudget(0));
});

test("cache des réponses : même entrée, périmé après le délai", () => {
  let t = 0;
  const c = createAnswerCache({ storage: mem(), now: () => t, ttlMs: 1000 });
  c.set(["Quel temps ?", "17 °C"], { text: "17 °C" });
  assert.deepEqual(c.get(["quel  temps ?", "17 °C"]), { text: "17 °C" });
  assert.equal(c.get(["Quel temps ?", "18 °C"]), null);
  t = 2000;
  assert.equal(c.get(["Quel temps ?", "17 °C"]), null);
});

test("exemples validés : le plus proche, jamais la demande elle-même", () => {
  const s = createExampleStore({ storage: mem() });
  s.remember("p", "Sujet : jardin potager", '{"a":1}');
  s.remember("p", "Sujet : déménagement maison", '{"a":2}');
  assert.equal(s.pick("p", "Sujet : organiser un déménagement").output, '{"a":2}');
  assert.equal(s.pick("p", "Sujet : jardin potager").output, '{"a":2}');
  assert.equal(s.pick("autre", "x"), null);
});
