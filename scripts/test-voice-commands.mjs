#!/usr/bin/env node
// Tests de la commande vocale (src/lib/voice-commands.js) — la grammaire et la
// correspondance avec les apps/fichiers, sans DOM ni Tauri.
//
//   node --test scripts/test-voice-commands.mjs

import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const vc = await import("../src/lib/voice-commands.js");

const APPS = [
  { id: "notes", name: "Notes" },
  { id: "photos", name: "Photos" },
  { id: "kanban", name: "Tableau" },
  { id: "tables", name: "Bases de données" },
  { id: "documents", name: "Documents" },
  { id: "dataanalysis", name: "Analyse de données" },
];
const FILES = [
  { id: "sb1", sandbox: "Démo", path: "factures/facture_2026_03.pdf" },
  { id: "sb1", sandbox: "Démo", path: "factures/facture_2025_12.pdf" },
  { id: "sb1", sandbox: "Démo", path: "notes/rapport.md" },
];

test("normalisation : accents, ponctuation, casse", () => {
  assert.equal(vc.normalizeText("Ouvre Notes, s'il te plaît !"), "ouvre notes s il te plait");
});

test("grammaire FR : ouvrir une app, avec ou sans article", () => {
  assert.deepEqual(vc.parseCommand("Ouvre Notes."), { kind: "open_app", arg: "notes" });
  assert.deepEqual(vc.parseCommand("lance l'application photos"), { kind: "open_app", arg: "photos" });
  assert.deepEqual(vc.parseCommand("va dans les bases de données"), { kind: "open_app", arg: "bases de donnees" });
});

test("grammaire EN", () => {
  assert.deepEqual(vc.parseCommand("open the app notes", "en"), { kind: "open_app", arg: "notes" });
  assert.deepEqual(vc.parseCommand("search for invoice 2026", "en"), { kind: "search", arg: "invoice 2026" });
  assert.equal(vc.parseCommand("dark mode", "en").kind, "theme_dark");
});

test("grammaire : fichiers, recherche, workflows, commandes fixes", () => {
  assert.deepEqual(vc.parseCommand("ouvre le fichier rapport"), { kind: "open_file", arg: "rapport" });
  assert.deepEqual(vc.parseCommand("cherche facture 2026"), { kind: "search", arg: "facture 2026" });
  assert.deepEqual(vc.parseCommand("lance le workflow veille"), { kind: "workflow", arg: "veille" });
  assert.equal(vc.parseCommand("mode sombre").kind, "theme_dark");
  assert.equal(vc.parseCommand("ouvre les réglages").kind, "settings");
  assert.equal(vc.parseCommand("nouvelle discussion").kind, "new_conversation");
  assert.equal(vc.parseCommand("réduis tout").kind, "show_desktop");
});

test("« demande à Lumen » passe la main au chat", () => {
  assert.deepEqual(vc.parseCommand("Demande à Lumen quelle heure il est"), { kind: "ask", arg: "quelle heure il est" });
});

test("correspondance d'app : exacte, partielle, faute de transcription", () => {
  assert.equal(vc.matchApp("notes", APPS).best?.id, "notes");
  assert.equal(vc.matchApp("note", APPS).best?.id, "notes");
  assert.equal(vc.matchApp("fotos", APPS).best?.id, "photos");
  assert.equal(vc.matchApp("bases de donnees", APPS).best?.id, "tables");
});

test("correspondance d'app : ambiguïté → candidats, pas de gagnant", () => {
  const r = vc.matchApp("données", APPS);
  assert.equal(r.best, null);
  assert.ok(r.candidates.length >= 2);
});

test("fichiers : tous les mots, les chemins courts d'abord", () => {
  const hits = vc.matchFiles("facture 2026", FILES);
  assert.deepEqual(hits.map((f) => f.path), ["factures/facture_2026_03.pdf"]);
  assert.equal(vc.matchFiles("facture", FILES).length, 2);
});

test("interpret : app nette → action exécutable", async () => {
  const opened = [];
  const r = await vc.interpret("ouvre notes", { lang: "fr", apps: () => APPS, actions: { openApp: (id) => opened.push(id) } });
  assert.equal(r.kind, "open_app");
  r.run();
  assert.deepEqual(opened, ["notes"]);
});

test("interpret : « ouvre facture 2026 » n'est pas une app → fichier unique ouvert", async () => {
  const opened = [];
  const r = await vc.interpret("ouvre facture 2026", { lang: "fr", apps: () => APPS, files: async () => FILES, actions: { openFile: (f) => opened.push(f.path) } });
  assert.equal(r.kind, "open_file");
  r.run();
  assert.deepEqual(opened, ["factures/facture_2026_03.pdf"]);
});

test("interpret : plusieurs fichiers → choix, pas d'ouverture", async () => {
  const r = await vc.interpret("cherche facture", { lang: "fr", apps: () => APPS, files: async () => FILES, actions: {} });
  assert.equal(r.kind, "search");
  assert.equal(r.choices.length, 2);
  assert.equal(r.run, undefined);
});

test("interpret : fermer la fenêtre demande confirmation", async () => {
  const r = await vc.interpret("ferme la fenêtre", { lang: "fr", apps: () => APPS, actions: { closeWindow() {} } });
  assert.equal(r.kind, "close_window");
  assert.equal(r.confirm, true);
});

test("interpret : routeur (étage 2) consulté seulement si la grammaire échoue", async () => {
  let asked = 0;
  const router = async () => { asked++; return { action: "open_app", target: "Photos" }; };
  const r1 = await vc.interpret("ouvre notes", { lang: "fr", apps: () => APPS, actions: {}, router });
  assert.equal(asked, 0);
  assert.equal(r1.kind, "open_app");
  const r2 = await vc.interpret("j'aimerais voir mes images", { lang: "fr", apps: () => APPS, files: async () => [], actions: {}, router });
  assert.equal(asked, 1);
  assert.equal(r2.arg, "photos");
});

test("interpret : rien compris et pas de routeur → proposer le chat, sans agir", async () => {
  const r = await vc.interpret("blablabla", { lang: "fr", apps: () => APPS, files: async () => [], actions: {} });
  assert.equal(r.kind, "none");
  assert.equal(r.choices.length, 2);
});

test("réglages : OFF par défaut", () => {
  assert.equal(vc.voiceControlEnabled(), false);
  assert.equal(vc.voiceControlPrefs().shortcut, "alt+space");
});
