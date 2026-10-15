#!/usr/bin/env node
// Tests des primitives des menus « @ » / « # » du chat (src/lib/chat-mentions.js).
//
//   node --test scripts/test-chat-mentions.mjs
//
// Seules les deux fonctions pures sont testables hors navigateur : la détection
// du jeton sous le curseur (c'est elle qui décide d'ouvrir le menu — et surtout
// de ne PAS l'ouvrir sur une adresse e-mail ou un « #1 » collé à un mot) et le
// classement des entrées.

import assert from "node:assert/strict";
import test from "node:test";

const { tokenAtCaret, filterItems, mentionNames, decorateMentions } =
  await import("../src/lib/chat-mentions.js");

test("le jeton n'est reconnu qu'en début de mot", () => {
  assert.equal(tokenAtCaret("bonjour@lumen.app", 17), null);
  assert.equal(tokenAtCaret("issue#12", 8), null);
  assert.deepEqual(tokenAtCaret("@", 1), { sigil: "@", query: "", start: 0, end: 1 });
  assert.deepEqual(tokenAtCaret("lance @web", 10), { sigil: "@", query: "web", start: 6, end: 10 });
  assert.deepEqual(tokenAtCaret("relis #not", 10), { sigil: "#", query: "not", start: 6, end: 10 });
});

test("le jeton s'arrête à l'espace suivante", () => {
  assert.equal(tokenAtCaret("@web_search puis", 16), null);
  // Curseur au milieu du texte : c'est le mot COURANT qui compte.
  assert.deepEqual(tokenAtCaret("@web puis", 4), { sigil: "@", query: "web", start: 0, end: 4 });
});

test("le classement met les préfixes en tête", () => {
  const items = [
    { label: "search_documents", sub: "cherche dans les documents" },
    { label: "web_search", sub: "recherche web" },
    { label: "memory_recall", sub: "rappelle une note web" },
  ];
  assert.deepEqual(filterItems(items, "web").map((i) => i.label),
    ["web_search", "memory_recall"]);   // le 3ᵉ ne mentionne « web » nulle part
  // Sans requête, tout ressort dans l'ordre d'origine.
  assert.equal(filterItems(items, "").length, 3);
  assert.equal(filterItems(items, "zzz").length, 0);
});

test("les mentions deviennent des pastilles, sauf dans du code", () => {
  assert.equal(
    decorateMentions("<p>lance @web_search et <code>@decorator</code></p>"),
    '<p>lance <span class="mention-chip">@web_search</span> et <code>@decorator</code></p>');
  // Une adresse e-mail n'est pas une mention (le « @ » n'ouvre pas un mot).
  assert.equal(decorateMentions("<p>ecris a lumen@example.com</p>"),
    "<p>ecris a lumen@example.com</p>");
});

test("les noms mentionnés sont dédoublonnés", () => {
  assert.deepEqual(mentionNames("@web_search puis @export_pdf puis @web_search"),
    ["web_search", "export_pdf"]);
});
