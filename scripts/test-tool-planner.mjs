// Planificateur d'outils par règles (src/lib/tool-planner.js) et rédaction
// encadrée des petits modèles (src/lib/small-answer.js), sans modèle.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { planTools, extractPlace, extractWhen, splitClauses, readLike } from "../src/lib/tool-planner.js";
import { badAnswer, calcFacts, extractiveAnswer, appendLinks, enforceListCount, relevantTo, cleanAnswer, answerLang } from "../src/lib/small-answer.js";
import { TOOL_SPECS, spec } from "./orch-eval/tools.mjs";

const isAction = (n) => /create|remember|command/.test(n);
const plan = (q, previous = "", tools = TOOL_SPECS) => planTools(q, tools, { previous, isAction });
const names = (p) => p.calls.map((c) => c.name);

test("chaque cas des bancs reçoit les outils attendus", () => {
  for (const f of ["cases.json", "stress.json", "long.json"]) {
    for (const c of JSON.parse(fs.readFileSync(new URL(`./orch-eval/${f}`, import.meta.url), "utf8"))) {
      const prev = [...(c.history || [])].reverse().find((m) => m.role === "user")?.content || "";
      const got = names(plan(c.query, prev));
      const e = c.expect || {};
      // Le CV : la recherche du coffre remplace le Corpus (en panne dans le banc).
      for (const t of (e.tools || []).filter((t) => t !== "search_documents")) assert.ok(got.includes(t), `${c.id} : ${t} attendu, obtenu ${got}`);
      if (e.noTools) assert.deepEqual(got, [], `${c.id} : aucun outil attendu`);
      for (const t of e.notTools || []) assert.ok(!got.includes(t), `${c.id} : ${t} interdit`);
    }
  }
});

test("arguments : lieu, relance, correction, rappel", () => {
  assert.equal(plan("Quel temps fait-il à Lyon ?").calls[0].args.place, "Lyon");
  assert.equal(plan("Et demain, il fera comment là-bas ?", "Quel temps fait-il à Lyon ?").calls[0].args.place, "Lyon");
  assert.equal(plan("Non, je voulais dire Marseille, pas Lyon.", "Quel temps fait-il à Lyon ?").calls[0].args.place, "Marseille");
  const r = plan("Rappelle-moi d'appeler le plombier demain à 9h.").calls[0];
  assert.deepEqual([r.name, r.args.text, r.args.when], ["create_reminder", "appeler le plombier", "demain à 9h"]);
  assert.equal(extractPlace("Je dois prendre un parapluie à Saint-Denis ?"), "Saint-Denis");
  assert.equal(extractWhen("un rappel pour jeudi 10h"), "jeudi 10h");
});

test("demandes composées et actions conditionnelles", () => {
  assert.equal(splitClauses("Rappelle-moi d'appeler la banque demain et retiens que je préfère le thé").length, 2);
  const p = plan("Claire m'a écrit ? Si oui crée-moi un rappel pour jeudi 10h");
  assert.ok(p.calls.find((c) => c.name === "create_reminder").conditional);
  assert.deepEqual(names(plan("Regarde mon agenda et le kanban")).sort(), ["app_data", "data_agenda"].sort());
});

test("« rappelle-moi le prénom… » n'est pas un rappel ; « reformule » n'appelle rien", () => {
  assert.ok(!names(plan("Rappelle-moi le prénom de mon chat.")).includes("create_reminder"));
  assert.deepEqual(names(plan("Reformule ta réponse précédente.", "Quel temps fait-il à Lyon ?")), []);
});

test("outils réels et inconnus : par capacité, pas par nom exact", () => {
  const real = [spec("mail_rechercher", "Recherche dans les courriels", { query: "string" }, ["query"]), spec("notion_search", "Recherche dans l'espace Notion de l'équipe", { query: "string" }, ["query"]), spec("data_search", "Recherche plein texte dans toutes les données", { query: "string" })];
  assert.deepEqual(names(plan("Qu'a dit Paul dans son dernier mail ?", "", real)), ["mail_rechercher"]);
  assert.ok(readLike(real[1]));
  assert.ok(!readLike(spec("notion_create_page", "Crée une page", {})));
});

test("réponse inutilisable : écho de consigne ou aucune valeur des données", () => {
  const data = "Kanban : En cours : « Notarisation macOS », « App iOS ».";
  assert.ok(badAnswer("La source indique la principale action.", data));
  assert.ok(badAnswer("Tout avance bien.", data));
  assert.equal(badAnswer("En cours : la Notarisation macOS et l'App iOS.", data), "");
});

test("calculs et durées faits par le code", () => {
  assert.match(calcFacts("Combien font 17 × 23 ?")[0], /= 391$/);
  assert.match(calcFacts("Un train part à 14h10 et arrive à 17h45. Combien de temps dure le trajet ?")[0], /3 h 35/);
});

test("finitions : liens joints, liste bornée, titres retirés, langue", () => {
  const notes = [{ name: "data_search", result: "• salon.jpg\n  lien : ![salon.jpg](lumenmedia://localhost/sb1/Photos/salon.jpg)" }];
  assert.match(appendLinks("Voici ta photo.", notes, "Montre-moi la photo du salon"), /!\[salon\.jpg\]\(lumenmedia/);
  assert.equal(enforceListCount("1. a\n2. b\n3. c\n4. d", "Donne exactement 3 idées").split("\n").length, 3);
  assert.equal(cleanAnswer("# Réponse finale\nIl fait 17 °C."), "Il fait 17 °C.");
  assert.equal(answerLang("Hi! Can you explain what a black hole is?", "fr"), "en");
  assert.match(extractiveAnswer([{ name: "x", result: "Budget validé : 48 500 €" }], "budget", "fr", () => "Rapport"), /48 500/);
  assert.ok(!relevantTo("Sommeil : 8,3 h", "Quel est le numéro de passeport de mon frère ?"));
  assert.ok(relevantTo("• salon.jpg image", "Montre-moi la photo du salon"));
});
