// Personnes partagées entre Contacts, Annuaire et Relia (lib/contacts-store.js).
import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.window = {};
const { upsertContact, contextsOf, viewFor, findByLink, duplicateGroups, mergePeople } = await import("../src/lib/contacts-store.js");

test("une même personne vue par Relia puis l'Annuaire garde un seul identifiant", () => {
  let list = upsertContact([], { name: "Léa Martin", email: "lea@acme.fr", origin: "crm", ref: "42", company: "Acme" });
  const id = list[0].id;
  list = upsertContact(list, { name: "Léa Martin", email: "LEA@acme.fr", origin: "directory", ref: "u-7" });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.deepEqual(contextsOf(list[0]).sort(), ["client", "team"]);
  assert.equal(findByLink(list, "relia", "42").id, id);
  assert.equal(findByLink(list, "directory", "u-7").id, id);
  assert.equal(list[0].origin, "crm");
});

test("les informations d'un contexte non autorisé sont masquées", () => {
  const c = { id: "x", name: "A", contexts: ["personal", "client"], fields: { client: { tarif: "remise 10 %" }, personal: { anniversaire: "12/03" } } };
  const v = viewFor(c, ["personal"]);
  assert.deepEqual(Object.keys(v.fields), ["personal"]);
  assert.deepEqual(v.contexts, ["personal"]);
});

test("doublons proposés, fusion sans perte", () => {
  const list = [
    { id: "a", name: "Paul Durand", email: "", phone: "06 12 34 56 78", links: [{ app: "relia", ref: "1" }] },
    { id: "b", name: "Paul Durand", email: "paul@x.fr", phone: "0612345678", links: [{ app: "directory", ref: "u1" }] },
  ];
  assert.equal(duplicateGroups(list).length, 1);
  const merged = mergePeople(list, "a", "b");
  assert.equal(merged.length, 1);
  assert.equal(merged[0].email, "paul@x.fr");
  assert.equal(merged[0].links.length, 2);
});
