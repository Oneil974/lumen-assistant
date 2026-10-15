#!/usr/bin/env node
// Tests du bus d'interop (src/lib/interop.js).
//
//   node --test scripts/test-interop.mjs
//
// Le module n'a besoin que de `window`, `document` et `localStorage` : on les
// simule ici plutôt que de tirer un DOM complet. Ce qui est vérifié est la
// mécanique qui doit tenir — file d'attente, livraison à chaud, conversion en
// texte, plafond de l'étagère — pas le rendu.

import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = { title: "Test" };
globalThis.location = { pathname: "/notes/notes.html" };
const opened = [];
globalThis.window = globalThis;
globalThis.top = globalThis;
globalThis.LumenOpenAppById = (id) => opened.push(id);

const interop = await import("../src/lib/interop.js");

test("un objet porte toujours sa provenance", () => {
  const obj = interop.makeObject("text", { text: "bonjour" });
  assert.equal(obj.kind, "text");
  assert.equal(obj.meta.sourceApp, "notes");
  assert.ok(obj.meta.createdAt > 0);
});

test("une nature inconnue est refusée tout de suite", () => {
  assert.throws(() => interop.makeObject("hologramme", {}), /inconnue/);
});

test("app fermée : l'objet attend en file et l'app est ouverte", () => {
  opened.length = 0;
  const obj = interop.makeObject("text", { text: "à traiter" });
  interop.handoff("kanban", obj);
  assert.deepEqual(opened, ["kanban"]);
  const received = interop.takeHandoff("kanban");
  assert.equal(received.length, 1);
  assert.equal(received[0].text, "à traiter");
  // La file se vide : un objet n'est traité qu'une fois.
  assert.equal(interop.takeHandoff("kanban").length, 0);
});

test("app ouverte : livraison directe, sans réouverture de fenêtre", () => {
  opened.length = 0;
  const seen = [];
  const off = interop.receive("mindmap", (o) => seen.push(o));
  interop.handoff("mindmap", interop.makeObject("text", { text: "idée" }));
  assert.equal(seen.length, 1);
  // Rouvrir créerait un doublon vide : le récepteur s'en charge lui-même.
  assert.deepEqual(opened, []);
  off();
  interop.handoff("mindmap", interop.makeObject("text", { text: "plus tard" }));
  assert.equal(seen.length, 1, "après désabonnement, plus rien n'est livré à chaud");
  assert.equal(interop.takeHandoff("mindmap").length, 1);
});

test("un récepteur qui échoue ne fait pas perdre l'objet", () => {
  const off = interop.receive("memory", () => { throw new Error("boum"); });
  interop.handoff("memory", interop.makeObject("text", { text: "précieux" }));
  off();
  const queued = interop.takeHandoff("memory");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].text, "précieux");
});

test("les cibles proposées correspondent à la nature, source exclue", () => {
  const table = interop.makeObject("table", { columns: ["a"], rows: [[1]] }, { app: "tables" });
  const ids = interop.targetsFor(table).map((t) => t.appId);
  assert.ok(ids.includes("sheets"));
  assert.ok(!ids.includes("tables"), "on ne se propose pas soi-même");
  assert.ok(!ids.includes("memory"), "Mémoire n'accepte pas les tables");
});

test("une table se convertit en Markdown pour les cibles textuelles", () => {
  const table = interop.makeObject("table", {
    columns: ["Produit", "Ventes"],
    rows: [["Café", 12], ["Thé", 7]],
  });
  const md = interop.toText(table);
  assert.match(md, /\| Produit \| Ventes \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| Café \| 12 \|/);
});

test("l'étagère garde le plus récent en premier et reste plafonnée", () => {
  interop.clearShelf();
  for (let i = 0; i < 35; i += 1) {
    interop.shelve(interop.makeObject("text", { text: `objet ${i}` }));
  }
  const shelf = interop.readShelf();
  assert.equal(shelf.length, 30);
  assert.equal(shelf[0].text, "objet 34");
});

test("un objet trop gros reste en mémoire sans casser le quota disque", () => {
  interop.clearShelf();
  const huge = interop.makeObject("image", { dataUrl: "x".repeat(400 * 1024) });
  interop.shelve(huge);
  // Présent pour la session…
  assert.equal(interop.readShelf().length, 1);
  // …mais pas écrit sur le disque.
  assert.equal(JSON.parse(localStorage.getItem("lumen:shelf")).length, 0);
});

// ===== Relais vers le bureau ================================================
// Une fenêtre qui n'héberge pas les apps (barre principale, Réglages) ne peut
// pas ouvrir Notes : elle doit passer l'objet au bureau par un événement.

test("hors du bureau, l'objet est relayé au lieu d'être mis en file", async () => {
  const emitted = [];
  const invoked = [];
  const savedOpen = globalThis.LumenOpenAppById;
  delete globalThis.LumenOpenAppById;          // cette fenêtre n'ouvre pas d'apps
  globalThis.__TAURI__ = {
    event: { emit: (name, payload) => { emitted.push([name, payload]); } },
    core: { invoke: async (cmd, args) => { invoked.push([cmd, args]); } },
  };
  const obj = interop.makeObject("text", { text: "depuis la barre" });
  assert.equal(interop.handoff("notes", obj), true);
  // Rien ne doit rester en file locale : personne ne la lirait.
  assert.equal(interop.takeHandoff("notes").length, 0);
  // Le bureau est demandé, puis l'objet relayé (émission différée).
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(invoked[0], ["open_sandbox_explorer", { desktop: true }]);
  assert.equal(emitted[0][0], "lumen-interop-handoff");
  assert.equal(emitted[0][1].appId, "notes");
  assert.equal(emitted[0][1].object.text, "depuis la barre");
  globalThis.LumenOpenAppById = savedOpen;
  delete globalThis.__TAURI__;
});

test("le sélecteur ne propose que des apps ouvrables", () => {
  const obj = interop.makeObject("text", { text: "x" });
  const all = interop.targetsFor(obj).map((t) => t.appId);
  assert.ok(all.includes("kanban"));
  globalThis.LumenCanOpenApp = (id) => id !== "kanban";      // Tempo désinstallé
  const filtered = interop.targetsFor(obj).map((t) => t.appId);
  assert.ok(!filtered.includes("kanban"));
  assert.ok(filtered.length === all.length - 1);
  delete globalThis.LumenCanOpenApp;
});

test("bureau fermé ou verrouillé : l'objet est gardé jusqu'à l'accusé de réception", async () => {
  const emitted = [];
  const listeners = new Map();
  const savedOpen = globalThis.LumenOpenAppById;
  delete globalThis.LumenOpenAppById;
  globalThis.__TAURI__ = {
    event: {
      emit: (name, payload) => { emitted.push([name, payload]); },
      listen: (name, cb) => { listeners.set(name, cb); return Promise.resolve(() => {}); },
    },
    core: { invoke: async () => {} },
  };
  const obj = interop.makeObject("text", { text: "avant le mot de passe" });
  interop.handoff("notes", obj);
  await new Promise((r) => setTimeout(r, 400));
  const first = emitted.find(([n]) => n === "lumen-interop-handoff");
  assert.ok(first, "un premier envoi est tenté");
  // Personne n'a accusé réception (session verrouillée) : l'objet reste en attente.
  assert.ok(interop.pendingRelays().some((p) => p.id === first[1].id));
  // Le bureau se monte et l'annonce : l'objet repart.
  emitted.length = 0;
  listeners.get("lumen-interop-ready")?.({ payload: {} });
  const retry = emitted.find(([n, p]) => n === "lumen-interop-handoff" && p.id === first[1].id);
  assert.ok(retry, "l'objet est renvoyé au signal « prêt »");
  assert.equal(retry[1].object.text, "avant le mot de passe");
  // Accusé de réception : plus rien en attente, pas de troisième envoi.
  listeners.get("lumen-interop-ack")?.({ payload: { id: retry[1].id } });
  assert.ok(!interop.pendingRelays().some((p) => p.id === retry[1].id));
  emitted.length = 0;
  listeners.get("lumen-interop-ready")?.({ payload: {} });
  assert.ok(!emitted.some(([n, p]) => n === "lumen-interop-handoff" && p.id === retry[1].id));
  globalThis.LumenOpenAppById = savedOpen;
  delete globalThis.__TAURI__;
});
