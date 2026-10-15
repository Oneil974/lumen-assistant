#!/usr/bin/env node
// Données de TEST pour le rituel du matin de Lumen XR.
//
//   node scripts/seed-morning.mjs           # ajoute les données de test
//   node scripts/seed-morning.mjs --clean   # retire tout ce que ce script a ajouté
//   node scripts/seed-morning.mjs --dir <dossier de données>   # autre profil / autre OS
//
// Fermer Lumen avant : l'app réécrit ses fichiers en mémoire à la fermeture.
//
// Rien n'est écrasé : les données existantes sont gardées, une copie
// `<fichier>.bak-<date>` est faite avant toute écriture, et chaque élément
// ajouté porte la marque `seed-morning` (retiré par --clean).
//
//   reminders.json   évènements de l'agenda (aujourd'hui → J+6, horaires réalistes)
//   kanban.json      trois projets (étiquettes) répartis dans les colonnes
//   morning.json     réglages du rituel : ville météo, thèmes d'actualité, objectifs
//                    des projets (créé s'il n'existe pas, sinon complété)
//   agents.json      l'agent « Intendant du matin » (modèle src/lib/agent-templates.js),
//                    qui sait créer ces mêmes données POUR DE VRAI depuis Lumen

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_TEMPLATES, templateDraft } from "../src/lib/agent-templates.js";

const args = process.argv.slice(2);
const MARK = "seed-morning";
const dirArg = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : null;
const DIR = dirArg || (process.platform === "darwin"
  ? path.join(os.homedir(), "Library/Application Support/com.lumen.app")
  : process.platform === "win32"
    ? path.join(process.env.APPDATA || "", "com.lumen.app")
    : path.join(os.homedir(), ".local/share/com.lumen.app"));
const clean = args.includes("--clean");

if (!fs.existsSync(DIR)) { console.error(`Dossier de données introuvable : ${DIR}`); process.exit(1); }
const file = (n) => path.join(DIR, n);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), "utf8")); } catch { return fallback; }
}
function write(name, data) {
  if (fs.existsSync(file(name))) fs.copyFileSync(file(name), file(`${name}.bak-${stamp}`));
  fs.writeFileSync(file(name), JSON.stringify(data, null, 2));
}
const id = (p) => `${p}-${MARK}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------- Agenda
const day = (offset, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(h, m, 0, 0); return d.getTime(); };
const EVENTS = [
  [0, 9, 30, "Point d'équipe — Lumen 0.3", "Visio, 30 min. Ordre du jour : démo XR, bugs ouverts."],
  [0, 12, 30, "Déjeuner avec Claire", "Restaurant Le Comptoir, rue des Halles."],
  [0, 18, 0, "Séance de course — fractionné", "8 × 400 m, piste du stade."],
  [1, 10, 0, "Rendez-vous artisan cuisine", "Validation du devis et des plans (8 450 € TTC)."],
  [1, 14, 30, "Dentiste", "Contrôle annuel, Dr Martin."],
  [2, 9, 0, "Revue de sprint Lumen", "Démo du rituel du matin en XR."],
  [3, 19, 30, "Anniversaire de Magalie", "Apporter le cadeau (livre de photo)."],
  [4, 8, 30, "Sortie longue — 18 km", "Allure marathon sur les 6 derniers km."],
  [6, 11, 0, "Livraison des meubles de cuisine", "Créneau 11 h – 13 h."],
].map(([o, h, m, title, note]) => ({ id: id("rem"), title, note, due_at: day(o, h, m), recur: "none", done: false, fired: false, source: MARK, created_at: Date.now() }));

// ---------------------------------------------------------------- Projets (Kanban)
const PROJECTS = {
  "Lumen 0.3": {
    goal: "Publier Lumen 0.3 avec le rituel du matin XR et les petits modèles robustes, d'ici le 31 octobre.",
    cards: [["Fait", "Planificateur d'outils par règles"], ["Fait", "Whisper dans le casque"], ["Fait", "Objets physiques XR"],
      ["En revue", "Traduction par petits modèles"], ["À traiter", "Rituel du matin XR"], ["À faire", "Notes de version 0.3"], ["À faire", "Tests sur Quest 3"]],
  },
  "Rénovation cuisine": {
    goal: "Cuisine terminée avant le 15 novembre, budget 12 000 € maximum.",
    cards: [["Fait", "Choisir l'artisan"], ["Fait", "Plans validés"], ["En revue", "Devis cuisine (8 450 €)"], ["À faire", "Commander l'électroménager"], ["À faire", "Peinture des murs"]],
  },
  "Marathon de Paris": {
    goal: "Courir le marathon en moins de 3 h 45 ; 4 sorties par semaine.",
    cards: [["Fait", "Plan d'entraînement 16 semaines"], ["En revue", "Semaine 9 : 52 km"], ["À faire", "Inscription au semi de préparation"], ["À faire", "Acheter des chaussures neuves"]],
  },
};

// ---------------------------------------------------------------- Réglages du rituel
const MORNING = {
  city: "Lyon",
  topics: ["intelligence artificielle", "réalité mixte", "course à pied"],
  projects: Object.fromEntries(Object.entries(PROJECTS).map(([k, v]) => [k, { goal: v.goal }])),
  _seed: MARK,
};

// ---------------------------------------------------------------- Agent
const AGENT_ID = `morning-steward-${MARK}`;
function stewardAgent() {
  const tpl = AGENT_TEMPLATES.find((t) => t.id === "morning");
  const d = templateDraft(tpl, "fr");
  return {
    id: AGENT_ID, name: d.name, icon: "", description: d.description, instruction: d.instruction,
    native_tools: d.native_tools, avatar: d.avatar, cron: "", enabled: true,
    created: Math.floor(Date.now() / 1000), voice: "",
    tasks: d.tasks.map((text, i) => ({ id: `t${i + 1}-${MARK}`, text, done: false })),
  };
}

// ---------------------------------------------------------------- Écriture
if (clean) {
  const rem = read("reminders.json", []);
  write("reminders.json", rem.filter((r) => r.source !== MARK));
  const kb = read("kanban.json", null);
  if (kb) { kb.cards = (kb.cards || []).filter((c) => !(c.labels || []).includes(MARK)); write("kanban.json", kb); }
  const ag = read("agents.json", null);
  if (Array.isArray(ag)) write("agents.json", ag.filter((a) => a.id !== AGENT_ID));
  const mo = read("morning.json", null);
  if (mo?._seed === MARK) fs.renameSync(file("morning.json"), file(`morning.json.bak-${stamp}`));
  console.log("Données de test retirées (copies .bak gardées).");
  process.exit(0);
}

const rem = read("reminders.json", []).filter((r) => r.source !== MARK);
write("reminders.json", [...rem, ...EVENTS]);

const kb = read("kanban.json", { name: "Tableau", members: [{ id: "moi", name: "Moi", color: "#0a84ff" }], columns: [], cards: [] });
kb.cards = (kb.cards || []).filter((c) => !(c.labels || []).includes(MARK));
const colId = (title) => {
  let c = kb.columns.find((x) => x.title.toLowerCase() === title.toLowerCase());
  if (!c) { c = { id: id("col"), title, ai: false }; kb.columns.push(c); }
  return c.id;
};
for (const [project, { cards }] of Object.entries(PROJECTS)) {
  for (const [col, title] of cards) {
    kb.cards.push({ id: id("card"), colId: colId(col), title, desc: "", assignee: kb.members?.[0]?.id || "", labels: [project, MARK], comments: [], aiProcessed: false, created: Date.now() });
  }
}
write("kanban.json", kb);

const agents = read("agents.json", []);
if (Array.isArray(agents)) write("agents.json", [...agents.filter((a) => a.id !== AGENT_ID), stewardAgent()]);

const existing = read("morning.json", null);
write("morning.json", existing ? { ...MORNING, ...existing, projects: { ...MORNING.projects, ...(existing.projects || {}) } } : MORNING);

console.log(`Données de test ajoutées dans ${DIR} :
  • ${EVENTS.length} évènements d'agenda (aujourd'hui → J+6)
  • ${Object.values(PROJECTS).reduce((n, p) => n + p.cards.length, 0)} cartes Kanban sur ${Object.keys(PROJECTS).length} projets
  • morning.json : météo ${MORNING.city}, thèmes « ${MORNING.topics.join(" », « ")} »
  • agent « Intendant du matin » (ajouté dans Agents, prêt à créer de vraies données)
Pour tout retirer : node scripts/seed-morning.mjs --clean`);
