#!/usr/bin/env node
// Tests du rendu Markdown des rapports de Recherche profonde
// (src/research/markdown.js).
//
//   node --test scripts/test-research-markdown.mjs
//
// Le module est volontairement sans dépendance (ni DOM ni Tauri) : il se teste
// à plat. Ce qui est vérifié, c'est ce qu'un modèle produit spontanément dans
// un rapport — titres, listes, code, citations — et l'échappement, puisque le
// résultat part directement en innerHTML.

import assert from "node:assert/strict";
import test from "node:test";

import { mdToHtml, inlineMd } from "../src/research/markdown.js";

test("titre de niveau 1", () => {
  // Le cas qui a motivé ces tests : seuls `##` et `###` étaient reconnus, donc
  // un `# Titre` s'affichait dièse compris au milieu du rapport.
  assert.equal(mdToHtml("# Entretien courant de Lumio"), "<h1>Entretien courant de Lumio</h1>");
});

test("titres 2 à 4", () => {
  assert.equal(mdToHtml("## Deux\n### Trois\n#### Quatre"), "<h2>Deux</h2><h3>Trois</h3><h4>Quatre</h4>");
});

test("un dièse sans espace reste du texte", () => {
  assert.equal(mdToHtml("#hashtag"), "<p>#hashtag</p>");
});

test("liste numérotée, en conservant les numéros", () => {
  assert.equal(mdToHtml("1. Un\n2. Deux"), '<ol><li value="1">Un</li><li value="2">Deux</li></ol>');
});

test("bascule d'une liste à puces vers une liste numérotée", () => {
  assert.equal(mdToHtml("- Un\n1. Deux"), '<ul><li>Un</li></ul><ol><li value="1">Deux</li></ol>');
});

test("une ligne vide referme la liste", () => {
  assert.equal(mdToHtml("- a\n\nSuite"), "<ul><li>a</li></ul><p>Suite</p>");
});

test("gras, italique et code intra-ligne", () => {
  assert.equal(
    inlineMd("**gras** et *ital* et `du code`"),
    "<strong>gras</strong> et <em>ital</em> et <code>du code</code>",
  );
});

test("un nombre isolé n'est pas pris pour un code", () => {
  // La substitution des codes passe par une sentinelle : avec un simple numéro
  // entre espaces, « il y a 3 vis » aurait été réécrit.
  assert.equal(inlineMd("il y a 3 vis et `M3` en tout"), "il y a 3 vis et <code>M3</code> en tout");
});

test("le contenu d'un code reste littéral", () => {
  assert.equal(inlineMd("`a**b**c`"), "<code>a**b**c</code>");
});

test("un astérisque de multiplication n'ouvre pas d'italique", () => {
  assert.equal(inlineMd("2 * 3 = 6"), "2 * 3 = 6");
});

test("citations simples et groupées", () => {
  assert.equal(inlineMd("voir [3]"), 'voir <span class="cite" data-n="3">[3]</span>');
  assert.equal(
    inlineMd("voir [3, 5]"),
    'voir <span class="cite" data-n="3">[3]</span><span class="cite" data-n="5">[5]</span>',
  );
});

test("le HTML produit par le modèle est échappé", () => {
  // Le rapport part en innerHTML : un passage de document ne doit jamais
  // pouvoir injecter de balise.
  assert.equal(
    mdToHtml('<img src=x onerror="alert(1)">'),
    "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
  );
});

test("bloc de code avec langage", () => {
  assert.equal(mdToHtml("```py\nx = 1\n```"), '<pre class="md-code" data-lang="py"><code>x = 1</code></pre>');
});

test("bloc de code laissé ouvert par une réponse tronquée", () => {
  assert.match(mdToHtml("```\nx = 1"), /<pre class="md-code"><code>x = 1<\/code><\/pre>/);
});

test("filet horizontal et citation en bloc", () => {
  assert.equal(mdToHtml("---\n> note"), "<hr><blockquote>note</blockquote>");
});
