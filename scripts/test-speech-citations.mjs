#!/usr/bin/env node
// Tests du nettoyage du texte AVANT énonciation (src/sandbox/render.js).
//
//   node --test scripts/test-speech-citations.mjs
//
// Depuis que le RAG demande au modèle de citer ses sources — « (Source 2) » dans
// la barre, « [2] » dans les rapports — chaque phrase énoncée se terminait par
// un « parenthèse source deux » incompréhensible à l'oreille. Les renvois
// restent à l'écran, où ils pointent vers une pastille cliquable ; ils
// disparaissent de la voix.

import assert from "node:assert/strict";
import test from "node:test";

import { stripCitations, markdownToSpeech } from "../src/sandbox/render.js";

test("renvoi simple, avec la ponctuation qui suit", () => {
  assert.equal(
    stripCitations("Le document décrit l'assemblage (Source 1)."),
    "Le document décrit l'assemblage.",
  );
});

test("renvois multiples dans une phrase", () => {
  assert.equal(
    stripCitations("Dépoussiérer (Source 1) puis contrôler le ventilateur (Source 3)."),
    "Dépoussiérer puis contrôler le ventilateur.",
  );
});

test("liste de numéros, en français comme en anglais", () => {
  assert.equal(stripCitations("Voir le manuel (Sources 1, 2 et 5)."), "Voir le manuel.");
  assert.equal(stripCitations("See the manual (Sources 1 and 2)."), "See the manual.");
  assert.equal(stripCitations("Casse (source 4) minuscule."), "Casse minuscule.");
});

test("crochets numériques des rapports de recherche", () => {
  assert.equal(stripCitations("Inspecter les aimants [9]."), "Inspecter les aimants.");
  assert.equal(stripCitations("Deux passages [3, 5] concordent."), "Deux passages concordent.");
});

test("ce qui n'est pas un renvoi n'est pas touché", () => {
  // Une parenthèse ordinaire, une référence à une source non numérotée, et un
  // nombre entre parenthèses doivent survivre intacts.
  assert.equal(stripCitations("La softbox (DIY) tient en 20 pages."), "La softbox (DIY) tient en 20 pages.");
  assert.equal(stripCitations("Citez vos sources dans le rapport."), "Citez vos sources dans le rapport.");
  assert.equal(stripCitations("Serrer à 2,5 N·m (couple max)."), "Serrer à 2,5 N·m (couple max).");
});

test("le nettoyage s'applique à toute énonciation", () => {
  // markdownToSpeech est le passage obligé des deux applications (barre et
  // bureau) : c'est là que la règle doit vivre, pas dans un seul appelant.
  // (Le passage à la ligne unique vient du retrait de la puce, qui absorbe la
  // ligne vide : comportement d'origine, sans effet à l'oreille.)
  assert.equal(
    markdownToSpeech("## Entretien\n\n- Dépoussiérer le nid d'abeille (Source 1)."),
    "Entretien\nDépoussiérer le nid d'abeille.",
  );
});

test("texte vide ou absent", () => {
  assert.equal(stripCitations(""), "");
  assert.equal(stripCitations(null), "");
  assert.equal(markdownToSpeech(undefined), "");
});
