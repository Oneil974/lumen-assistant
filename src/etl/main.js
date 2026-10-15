// Flux de données (édition Pro) — l'ETL de Lumen, sur un canevas.
//
// Trois idées le tiennent :
//
//   1. **On voit ce qu'on fait.** Chaque changement rejoue le flux sur un
//      échantillon et chaque bloc affiche combien de lignes en sortent. Un ETL
//      qui ne montre son résultat qu'à l'exécution finale se débogue à l'aveugle.
//   2. **Un graphe, pas une liste.** Un flux se compose de blocs reliés : une
//      jointure a deux entrées, une source peut alimenter plusieurs branches,
//      un même flux peut écrire dans deux destinations. Même canevas, mêmes
//      gestes que l'app Automatisations.
//   3. **La source n'est jamais modifiée.** Un flux LIT des sources et ÉCRIT des
//      destinations — toujours distinctes. Un ETL qui écrase ses entrées n'est
//      pas rejouable, et rejouer est tout l'intérêt d'un flux enregistré.
//
// Le moteur vit à part (pipeline.js, fonctions pures) ; les connecteurs aussi
// (sources.js). Ici : le canevas, l'inspecteur engendré à partir des fiches,
// l'aperçu, l'exécution, l'enregistrement et l'assistant.

import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { autoTranslate } from "../apps-i18n.js";
import { mountShell } from "../lib/app-shell.js";
import { requireProPage } from "../lib/pro-edition.js";
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { llmChat, llmBackend } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { STEPS, CATEGORIES, stepInputs, runGraph } from "./pipeline.js";
import { SOURCES, DESTINATIONS, FAMILIES, discoverCatalog } from "./sources.js";

mountShell();

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const call = (cmd, args) => (invoke ? invoke(cmd, args) : Promise.reject(new Error("Ouvrez cette application depuis Lumen.")));

/** Taille de l'échantillon d'aperçu. Assez pour juger, assez peu pour être instantané. */
const SAMPLE = 200;
const FULL = 100000;
const FLOW_DIR = "flux";
const LAYOUT_PREFIX = "lumen.etl.view.";

// ============================ État ============================

const state = {
  sandboxId: "",
  flows: [],
  catalog: { sandboxes: [], files: {}, bases: [], tables: [], datasources: [] },
  dyn: {},            // listes chargées à la demande (jeux d'une source, objets d'un stockage)
  graph: freshGraph(),
  view: { x: 60, y: 60, scale: 1 },
  selectedId: null,
  results: {},        // nodeId → { table, error, skipped, ms } — dernier aperçu ou exécution
  resultMode: "preview",
  sampleCache: new Map(), // clé (type+params) → table d'échantillon, pour ne pas relire à chaque frappe
  dirty: false,
  busy: false,
  bottomTab: "preview",
};

function freshGraph(name = "") { return { name, nodes: [], edges: [], version: 2 }; }
const newId = (p = "n") => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** Fiche d'un bloc, quel que soit son genre. */
function specOf(node) {
  return SOURCES[node.type] || DESTINATIONS[node.type] || STEPS[node.type] || { label: node.type, hint: "Bloc inconnu", fields: [] };
}
const kindOf = (type) => (SOURCES[type] ? "source" : DESTINATIONS[type] ? "destination" : STEPS[type] ? "transform" : "transform");
const nodeById = (id) => state.graph.nodes.find((n) => n.id === id);

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3600);
}

function touch({ preview = true } = {}) {
  state.dirty = true;
  render();
  if (preview) schedulePreview();
}

// ============================ Palette ============================

const foldAccents = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function renderPalette() {
  const q = foldAccents($("block-search").value).trim();
  const match = (type, spec) => !q || foldAccents(`${type} ${spec.label} ${spec.hint || ""} ${spec.category || spec.family || ""}`).includes(q);
  const item = (type, spec, color) => `
    <button class="block-item" data-add="${esc(type)}" style="--b-color:${color}">
      <span class="block-icon">${esc(spec.label.slice(0, 1))}</span>
      <span><span class="block-title">${esc(spec.label)}</span><span class="block-desc">${esc(spec.hint || "")}</span></span>
    </button>`;
  let html = "";
  // Sources, par famille.
  const src = Object.entries(SOURCES).filter(([t, s]) => match(t, s));
  if (src.length) {
    html += `<div class="group-label" style="--g-color:var(--c-source)"><i></i>Sources</div>`;
    for (const fam of FAMILIES) {
      const items = src.filter(([, s]) => s.family === fam);
      if (!items.length) continue;
      html += `<div class="category-label">${esc(fam)}</div>` + items.map(([t, s]) => item(t, s, "var(--c-source)")).join("");
    }
  }
  const tr = Object.entries(STEPS).filter(([t, s]) => match(t, s));
  if (tr.length) {
    html += `<div class="group-label" style="--g-color:var(--c-transform)"><i></i>Transformations</div>`;
    for (const cat of CATEGORIES) {
      const items = tr.filter(([, s]) => s.category === cat);
      if (!items.length) continue;
      html += `<div class="category-label">${esc(cat)}</div>` + items.map(([t, s]) => item(t, s, cat === "IA" ? "var(--c-ai)" : "var(--c-transform)")).join("");
    }
  }
  const dst = Object.entries(DESTINATIONS).filter(([t, s]) => match(t, s));
  if (dst.length) {
    html += `<div class="group-label" style="--g-color:var(--c-dest)"><i></i>Destinations</div>` + dst.map(([t, s]) => item(t, s, "var(--c-dest)")).join("");
  }
  $("block-list").innerHTML = html || `<div class="empty small">Aucun bloc ne correspond.</div>`;
  $("block-count").textContent = `${Object.keys(SOURCES).length + Object.keys(STEPS).length + Object.keys(DESTINATIONS).length} blocs`;
  $("block-list").querySelectorAll("[data-add]").forEach((el) => el.addEventListener("click", () => addNode(el.dataset.add)));
}

/**
 * Pose un bloc. Sans position : à droite du bloc sélectionné (et relié à
 * lui si les genres s'y prêtent), sinon au centre de la scène. Poser puis
 * relier à la main est possible, mais « le bloc suivant » est le geste de
 * loin le plus fréquent.
 */
function addNode(type, { x, y, label, params, connectFrom } = {}) {
  const spec = specOf({ type });
  const kind = kindOf(type);
  const from = connectFrom === undefined ? nodeById(state.selectedId) : nodeById(connectFrom);
  const canLink = from && kind !== "source" && from.kind !== "destination";
  let px = x, py = y;
  if (px === undefined) {
    if (from) { px = from.x + 300; py = from.y + (canLink ? 0 : 140); }
    else { const c = screenToWorld($("stage").clientWidth / 2, $("stage").clientHeight / 2); px = c.x - 125; py = c.y - 40; }
    // Évite de poser pile sur un bloc existant.
    while (state.graph.nodes.some((n) => Math.abs(n.x - px) < 40 && Math.abs(n.y - py) < 40)) py += 120;
  }
  const node = { id: newId(kind.slice(0, 1)), kind, type, label: label || spec.label, x: px, y: py, params: { ...defaultParams(spec), ...(params || {}) } };
  state.graph.nodes.push(node);
  if (canLink) {
    // Sur un bloc à deux entrées, on branche le premier port libre.
    const ports = stepInputs(type);
    const used = new Set(state.graph.edges.filter((e) => e.to === node.id).map((e) => e.port || 0));
    const port = ports === "multi" ? 0 : ports.findIndex((_, i) => !used.has(i));
    if (port >= 0) state.graph.edges.push({ id: newId("e"), from: from.id, to: node.id, port });
  }
  state.selectedId = node.id;
  touch();
  return node;
}

function defaultParams(spec) {
  const out = {};
  for (const f of spec.fields || []) {
    if (f.kind === "select" && Array.isArray(f.options) && f.options.length) out[f.key] = f.options[0].value ?? f.options[0];
    // Une liste dynamique à UN seul choix (un seul espace, une seule base) :
    // inutile de le demander.
    if (f.kind === "select" && typeof f.options === "function" && !f.load) {
      const opts = f.options({ catalog: state.catalog, params: out, dyn: state.dyn });
      if (opts.length === 1) out[f.key] = opts[0].value ?? opts[0];
    }
    if (f.kind === "repeat") out[f.key] = [];
    if (f.kind === "bool") out[f.key] = false;
  }
  return out;
}

function removeNode(id) {
  state.graph.nodes = state.graph.nodes.filter((n) => n.id !== id);
  state.graph.edges = state.graph.edges.filter((e) => e.from !== id && e.to !== id);
  if (state.selectedId === id) state.selectedId = null;
  delete state.results[id];
  touch();
}

/** Relie deux blocs. Rend un message d'erreur, ou null. */
function connect(fromId, toId, port = 0) {
  const from = nodeById(fromId), to = nodeById(toId);
  if (!from || !to) return "Bloc introuvable.";
  if (from.id === to.id) return "Un bloc ne peut pas se relier à lui-même.";
  if (from.kind === "destination") return "Une destination n'a pas de sortie.";
  if (to.kind === "source") return "Une source n'a pas d'entrée.";
  const ports = stepInputs(to.type);
  if (ports !== "multi" && port >= ports.length) return "Ce bloc n'a pas ce port.";
  if (state.graph.edges.some((e) => e.from === fromId && e.to === toId && (e.port || 0) === port)) return null;
  if (ports !== "multi") {
    // Un port reçoit UNE entrée : relier remplace l'ancienne liaison.
    state.graph.edges = state.graph.edges.filter((e) => !(e.to === toId && (e.port || 0) === port));
  }
  state.graph.edges.push({ id: newId("e"), from: fromId, to: toId, port });
  if (hasCycle()) { state.graph.edges.pop(); return "Cette liaison créerait une boucle."; }
  return null;
}

function hasCycle() {
  const deg = Object.fromEntries(state.graph.nodes.map((n) => [n.id, 0]));
  state.graph.edges.forEach((e) => { if (deg[e.to] !== undefined) deg[e.to]++; });
  const q = Object.keys(deg).filter((k) => !deg[k]);
  let seen = 0;
  while (q.length) { const c = q.shift(); seen++; state.graph.edges.filter((e) => e.from === c).forEach((e) => { if (!--deg[e.to]) q.push(e.to); }); }
  return seen !== state.graph.nodes.length;
}

/** Entrées d'un bloc : { port → nodeId }. */
const inputsOf = (id) => Object.fromEntries(state.graph.edges.filter((e) => e.to === id).map((e) => [e.port || 0, e.from]));

/** Colonnes disponibles sur un port d'entrée (d'après le dernier aperçu). */
function inputColumns(node, port = 0) {
  const from = inputsOf(node.id)[port];
  if (!from) return [];
  return state.results[from]?.table?.columns || [];
}

// ============================ Aperçu ============================
//
// Rejoué sur un échantillon à chaque changement, avec un léger délai pour ne
// pas relancer à chaque frappe. Les sources sont mises en cache par contenu
// de leurs paramètres : taper un filtre ne relit pas PostgreSQL.

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => refreshPreview().catch((e) => toast(String(e?.message || e))), 260);
}

const sourceKey = (node) => `${node.type}:${JSON.stringify(node.params || {})}`;

function readerFor(limit, { cache }) {
  return async (node) => {
    const spec = SOURCES[node.type];
    if (!spec) throw new Error(`Source inconnue : ${node.type}`);
    const key = sourceKey(node);
    if (cache && state.sampleCache.has(key)) return state.sampleCache.get(key);
    const table = await spec.read(node.params || {}, limit, { call, catalog: state.catalog });
    if (cache) state.sampleCache.set(key, table);
    return table;
  };
}

/** Le modèle, pour l'étape « Colonne générée par l'IA ». */
async function llmAnswer(prompt) {
  const { data } = await llmChat(PROMPTS["app.etl.column"].build({ prompt }).messages, { backend: llmBackend(), rawSystem: true });
  const b = llmBackend();
  const msg = (b.api || b.llama || b.litert) ? data?.choices?.[0]?.message : data?.message;
  return msg?.content || "";
}

let previewSeq = 0;
async function refreshPreview() {
  if (!state.graph.nodes.length) { state.results = {}; renderBottom(); renderNodesStatus(); return; }
  // Deux aperçus peuvent se chevaucher (frappe rapide dans une formule) : seul
  // le plus récent a le droit d'afficher son résultat, sinon un aperçu calculé
  // sur une formule à moitié tapée pouvait recouvrir le bon.
  const seq = ++previewSeq;
  state.busy = true;
  renderNodesStatus("run");
  let results;
  try {
    ({ results } = await runGraph(state.graph, { readSource: readerFor(SAMPLE, { cache: true }), llm: llmAnswer }));
  } finally {
    if (seq === previewSeq) state.busy = false;
  }
  if (seq !== previewSeq) return;
  state.results = results;
  state.resultMode = "preview";
  renderNodesStatus();
  renderBottom();
  // L'inspecteur liste les colonnes d'entrée (et l'erreur du bloc) : elles
  // peuvent avoir changé. Il restaure lui-même le champ actif et son curseur.
  renderInspector();
}

// ============================ Exécution ============================

async function runFlow() {
  if (!state.graph.nodes.length) { toast("Posez au moins un bloc."); return null; }
  if (!state.graph.nodes.some((n) => n.kind === "destination" && n.type !== "dst_preview")) {
    toast("Aucune destination : le flux est joué en entier, rien n'est écrit.");
  }
  const hud = $("run-hud");
  hud.hidden = false; hud.classList.remove("done");
  $("run-status").textContent = "Lecture des sources…";
  state.busy = true;
  renderNodesStatus("run");
  const written = [];
  let outcome;
  try {
    outcome = await runGraph(state.graph, {
      readSource: readerFor(FULL, { cache: false }),
      llm: llmAnswer,
      writeDestination: async (node, table) => {
        $("run-status").textContent = `Écriture : ${node.label}…`;
        const msg = await DESTINATIONS[node.type].write(node.params || {}, table, { call, catalog: state.catalog });
        if (msg) written.push(msg);
      },
    });
    state.results = outcome.results;
    state.resultMode = "run";
    $("run-status").textContent = outcome.failed ? "Le flux s'est arrêté sur une erreur." : "Terminé.";
    toast(outcome.failed ? "Le flux a échoué : voyez la trace." : (written.join(" · ") || "Flux exécuté."));
    if (outcome.failed) { state.bottomTab = "trace"; $("bottom").classList.remove("collapsed"); }
    // Une table écrite est une table lisible : le catalogue doit la connaître.
    if (written.length) discoverCatalog(call).then((c) => { state.catalog = c; renderInspector(); });
  } catch (e) {
    $("run-status").textContent = "Erreur.";
    toast(String(e?.message || e));
  } finally {
    state.busy = false;
    hud.classList.add("done");
    setTimeout(() => { hud.hidden = true; }, 2600);
  }
  renderNodesStatus();
  renderBottom();
  return outcome;
}

// ============================ Rendu du canevas ============================

function render() {
  $("flow-name").value = state.graph.name || "";
  document.title = `Lumen — Flux de données${state.graph.name ? ` · ${state.graph.name}` : ""}`;
  const world = $("world");
  world.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
  $("zoom-reset").textContent = `${Math.round(state.view.scale * 100)}%`;
  world.innerHTML = "";
  for (const node of state.graph.nodes) {
    const spec = specOf(node);
    const ports = node.kind === "transform" ? stepInputs(node.type) : node.kind === "destination" ? ["Entrée"] : [];
    const el = document.createElement("article");
    el.className = `node${state.selectedId === node.id ? " selected" : ""}${node.disabled ? " off" : ""}${ports.length === 2 ? " two-in" : ""}${ports === "multi" ? " multi-in" : ""}`;
    el.dataset.id = node.id;
    el.dataset.kind = node.kind;
    if (spec.category) el.dataset.cat = spec.category;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    let desc = "";
    try { desc = spec.describe ? spec.describe(node.params || {}, { catalog: state.catalog }) : ""; } catch { desc = ""; }
    const inPorts = ports === "multi"
      ? `<button class="port in" data-port="0" aria-label="Entrées" title="Entrées (plusieurs)"></button>`
      : ports.map((p, i) => `<button class="port in" data-port="${i}" aria-label="${esc(p)}" title="${esc(p)}"></button>${ports.length > 1 ? `<span class="port-label p${i}">${esc(p[0])}</span>` : ""}`).join("");
    el.innerHTML = `${inPorts}
      <div class="node-head"><span class="node-icon">${esc(spec.label.slice(0, 1))}</span><span class="node-title" title="${esc(node.label)}">${esc(node.label)}</span><span class="node-kind">${esc(node.kind === "source" ? "source" : node.kind === "destination" ? "sortie" : spec.category || "")}</span></div>
      <div class="node-body">${esc(desc || spec.hint || "")}</div>
      <div class="node-foot"><span class="st"></span><span class="cnt">—</span><span class="spacer"></span><span class="node-err"></span></div>
      ${node.kind !== "destination" ? `<button class="port out" aria-label="Sortie" title="Sortie"></button>` : ""}`;
    el.addEventListener("pointerdown", (ev) => onNodePointerDown(ev, node));
    el.querySelector(".port.out")?.addEventListener("pointerdown", (ev) => beginConnection(ev, node));
    el.querySelectorAll(".port.in").forEach((p) => p.addEventListener("pointerup", (ev) => endConnection(ev, node, Number(p.dataset.port))));
    world.append(el);
  }
  drawEdges();
  $("empty-state").hidden = state.graph.nodes.length > 0;
  $("toggle-node").disabled = !state.selectedId || nodeById(state.selectedId)?.kind !== "transform";
  $("delete-node").disabled = !state.selectedId;
  renderNodesStatus();
  renderInspector();
  renderBottom();
}

function renderNodesStatus(force) {
  for (const el of $("world").querySelectorAll(".node")) {
    const r = state.results[el.dataset.id];
    const cnt = el.querySelector(".cnt"), err = el.querySelector(".node-err");
    if (force === "run") { el.dataset.st = "run"; cnt.textContent = "…"; err.textContent = ""; continue; }
    if (!r) { el.dataset.st = ""; cnt.textContent = "—"; err.textContent = ""; continue; }
    el.dataset.st = r.error ? "err" : r.skipped ? "skip" : "ok";
    cnt.textContent = r.error ? "erreur" : r.skipped ? "non joué" : `${r.table.rows.length} l · ${r.table.columns.length} c`;
    err.textContent = r.error || "";
    err.title = r.error || "";
  }
}

function portPoint(nodeId, out, port = 0) {
  const sel = out ? `.node[data-id="${CSS.escape(nodeId)}"] .port.out` : `.node[data-id="${CSS.escape(nodeId)}"] .port.in[data-port="${port}"]`;
  const p = document.querySelector(sel), stage = $("stage");
  if (!p || !stage) return null;
  const a = p.getBoundingClientRect(), b = stage.getBoundingClientRect();
  return { x: a.left + a.width / 2 - b.left, y: a.top + a.height / 2 - b.top };
}
const curve = (a, b) => { const dx = Math.max(50, Math.abs(b.x - a.x) * .5); return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`; };

function drawEdges() {
  const svg = $("links");
  svg.innerHTML = "";
  for (const e of state.graph.edges) {
    const a = portPoint(e.from, true), b = portPoint(e.to, false, e.port || 0);
    if (!a || !b) continue;
    const d = curve(a, b);
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", d); hit.setAttribute("class", "edge-hit");
    hit.addEventListener("click", () => { state.graph.edges = state.graph.edges.filter((x) => x.id !== e.id); touch(); });
    hit.setAttribute("title", "Cliquer pour retirer la liaison");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    const bad = state.results[e.from]?.error || state.results[e.from]?.skipped;
    path.setAttribute("class", `edge${bad ? " bad" : ""}`);
    svg.append(path, hit);
  }
}

function drawLiveEdge(clientX, clientY) {
  const svg = $("links"), stage = $("stage");
  svg.querySelector(".edge-live")?.remove();
  if (!connecting) return;
  const rect = stage.getBoundingClientRect();
  const a = portPoint(connecting, true);
  if (!a) return;
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", curve(a, { x: clientX - rect.left, y: clientY - rect.top }));
  p.setAttribute("class", "edge-live");
  svg.append(p);
}

// ----- Interactions : glisser, relier, déplacer la vue, zoomer -----

let dragging = null, connecting = null, spacePressed = false;
const screenToWorld = (x, y) => { const r = $("stage").getBoundingClientRect(); return { x: (x - r.left - state.view.x) / state.view.scale, y: (y - r.top - state.view.y) / state.view.scale }; };

function onNodePointerDown(ev, node) {
  if (ev.target.closest(".port")) return;
  ev.preventDefault();
  const changed = state.selectedId !== node.id;
  state.selectedId = node.id;
  const p = screenToWorld(ev.clientX, ev.clientY);
  dragging = { node, dx: p.x - node.x, dy: p.y - node.y, moved: false };
  if (changed) { render(); }
}
function beginConnection(ev, node) { ev.preventDefault(); ev.stopPropagation(); connecting = node.id; drawLiveEdge(ev.clientX, ev.clientY); }
function endConnection(ev, node, port) {
  if (!connecting) return;
  ev.preventDefault(); ev.stopPropagation();
  const err = connect(connecting, node.id, port);
  connecting = null;
  $("links").querySelector(".edge-live")?.remove();
  if (err) { toast(err); render(); } else touch();
}

function bindStage() {
  const stage = $("stage");
  stage.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest(".node,.canvas-controls,.run-hud,.empty-state")) return;
    if (ev.button === 1 || ev.button === 0 || spacePressed) {
      dragging = { pan: true, x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y };
      stage.setPointerCapture?.(ev.pointerId);
      stage.classList.add("panning");
    }
  });
  window.addEventListener("pointermove", (ev) => {
    if (connecting) drawLiveEdge(ev.clientX, ev.clientY);
    if (!dragging) return;
    if (dragging.pan) { state.view.x = dragging.vx + ev.clientX - dragging.x; state.view.y = dragging.vy + ev.clientY - dragging.y; applyView(); return; }
    const p = screenToWorld(ev.clientX, ev.clientY);
    dragging.node.x = Math.round(p.x - dragging.dx); dragging.node.y = Math.round(p.y - dragging.dy); dragging.moved = true;
    const el = $("world").querySelector(`.node[data-id="${CSS.escape(dragging.node.id)}"]`);
    if (el) { el.style.left = `${dragging.node.x}px`; el.style.top = `${dragging.node.y}px`; }
    drawEdges();
  });
  window.addEventListener("pointerup", () => {
    if (dragging?.moved) { state.dirty = true; saveView(); }
    dragging = null;
    stage.classList.remove("panning");
    if (connecting) { connecting = null; $("links").querySelector(".edge-live")?.remove(); }
    saveView();
  });
  stage.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      const before = screenToWorld(ev.clientX, ev.clientY);
      state.view.scale = Math.max(.4, Math.min(1.8, state.view.scale + (ev.deltaY > 0 ? -.08 : .08)));
      const after = screenToWorld(ev.clientX, ev.clientY);
      state.view.x += (after.x - before.x) * state.view.scale; state.view.y += (after.y - before.y) * state.view.scale;
    } else { state.view.x -= ev.deltaX; state.view.y -= ev.deltaY; }
    applyView();
  }, { passive: false });
  window.addEventListener("keydown", (ev) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (ev.code === "Space" && !typing) { spacePressed = true; stage.classList.add("panning"); ev.preventDefault(); }
    if ((ev.key === "Backspace" || ev.key === "Delete") && state.selectedId && !typing) removeNode(state.selectedId);
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") { ev.preventDefault(); saveFlow(); }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); runFlow(); }
  });
  window.addEventListener("keyup", (ev) => { if (ev.code === "Space") { spacePressed = false; if (!dragging) stage.classList.remove("panning"); } });
  // Les liens sont tracés d'après la position réelle des ports : tout ce qui
  // déplace la scène (redimensionnement, volet du bas replié) les redessine.
  window.addEventListener("resize", drawEdges);
  new ResizeObserver(() => drawEdges()).observe(stage);
  $("zoom-in").onclick = () => { state.view.scale = Math.min(1.8, state.view.scale + .1); applyView(); };
  $("zoom-out").onclick = () => { state.view.scale = Math.max(.4, state.view.scale - .1); applyView(); };
  $("zoom-reset").onclick = () => { state.view = { x: 60, y: 60, scale: 1 }; applyView(); };
  $("auto-layout").onclick = () => { autoLayout(); touch({ preview: false }); };
}
function applyView() {
  $("world").style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
  $("zoom-reset").textContent = `${Math.round(state.view.scale * 100)}%`;
  drawEdges();
}

/** Range les blocs par colonnes selon leur profondeur dans le graphe. */
function autoLayout() {
  const depth = {};
  const inc = Object.fromEntries(state.graph.nodes.map((n) => [n.id, state.graph.edges.filter((e) => e.to === n.id)]));
  const d = (id, seen = new Set()) => {
    if (depth[id] !== undefined) return depth[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    depth[id] = inc[id].length ? 1 + Math.max(...inc[id].map((e) => d(e.from, seen))) : 0;
    return depth[id];
  };
  state.graph.nodes.forEach((n) => d(n.id));
  const cols = {};
  for (const n of state.graph.nodes) (cols[depth[n.id]] ||= []).push(n);
  for (const [c, nodes] of Object.entries(cols)) nodes.forEach((n, i) => { n.x = 40 + Number(c) * 310; n.y = 40 + i * 150; });
  state.view = { x: 40, y: 40, scale: state.view.scale };
}

// ============================ Inspecteur ============================
//
// Le formulaire est ENGENDRÉ à partir des champs déclarés par la fiche du
// bloc. Les champs « colonne » proposent les colonnes réelles de l'entrée
// (d'après l'aperçu) ; les listes dépendantes se chargent à la demande.

function optionsOf(field, node) {
  const params = node.params || {};
  const ctx = { catalog: state.catalog, params, dyn: state.dyn };
  if (field.load) {
    const key = `${node.type}.${field.key}:${params[field.dependsOn] ?? ""}`;
    if (state.dyn[key] === undefined) {
      state.dyn[key] = null; // en cours
      field.load(params, { call }).then((opts) => { state.dyn[key] = opts || []; renderInspector(); }).catch((e) => { state.dyn[key] = []; toast(String(e?.message || e)); });
    }
    return state.dyn[key] || [];
  }
  const raw = typeof field.options === "function" ? field.options(ctx) : field.options || [];
  return raw.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
}

function fieldHtml(field, value, node, path) {
  const id = `f_${path.replace(/[^a-z0-9_]/gi, "_")}`;
  const hint = field.hint ? `<small>${esc(field.hint)}</small>` : "";
  const label = `<label for="${id}">${esc(field.label)}</label>`;
  switch (field.kind) {
    case "column": case "columns": {
      const cols = inputColumns(node, field.from === "right" ? 1 : 0);
      if (field.kind === "columns") {
        const chosen = new Set(Array.isArray(value) ? value : []);
        const all = [...new Set([...cols, ...chosen])];
        return `<div class="field"><label>${esc(field.label)}</label>
          <div class="chips" data-chips="${esc(path)}">${all.map((c) => `<button type="button" class="chip${chosen.has(c) ? " on" : ""}" data-col="${esc(c)}">${esc(c)}</button>`).join("") || `<small>Reliez une entrée pour voir ses colonnes.</small>`}</div>
          <input data-path="${esc(path)}" data-kind="list" id="${id}" value="${esc((Array.isArray(value) ? value : []).join(", "))}" placeholder="ou saisir : a, b, c" />${hint}</div>`;
      }
      const all = [...new Set([...cols, ...(value ? [value] : [])])];
      if (!all.length) return `<div class="field">${label}<input data-path="${esc(path)}" id="${id}" value="${esc(value ?? "")}" placeholder="nom de la colonne" />${hint}</div>`;
      return `<div class="field">${label}<select data-path="${esc(path)}" id="${id}">${field.optional ? `<option value="">—</option>` : ""}${all.map((c) => `<option value="${esc(c)}" ${c === value ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>${hint}</div>`;
    }
    case "select": {
      const opts = optionsOf(field, node);
      const loading = field.load && state.dyn[`${node.type}.${field.key}:${node.params?.[field.dependsOn] ?? ""}`] === null;
      if (field.free) {
        return `<div class="field">${label}<input data-path="${esc(path)}" id="${id}" list="${id}_l" value="${esc(value ?? "")}" placeholder="${esc(loading ? "chargement…" : "choisir ou saisir")}" /><datalist id="${id}_l">${opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</datalist>${hint}</div>`;
      }
      // Une liste fixe sans valeur choisie vaut sa première option : c'est ce
      // que le moteur applique par défaut, autant l'afficher.
      if ((value === undefined || value === "") && Array.isArray(field.options) && opts.length) value = opts[0].value;
      const has = opts.some((o) => String(o.value) === String(value ?? ""));
      return `<div class="field">${label}<select data-path="${esc(path)}" id="${id}">
        ${loading ? `<option value="">chargement…</option>` : ""}${!has ? `<option value="${esc(value ?? "")}" selected>${esc(value ? String(value) : "— choisir —")}</option>` : ""}
        ${opts.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value ?? "") ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>${hint}</div>`;
    }
    case "textarea": case "expression":
      return `<div class="field">${label}<textarea data-path="${esc(path)}" id="${id}" rows="${field.rows || 3}" placeholder="${esc(field.placeholder || "")}">${esc(value ?? "")}</textarea>${hint}</div>`;
    case "number":
      return `<div class="field">${label}<input type="number" step="any" data-path="${esc(path)}" data-kind="number" id="${id}" value="${esc(value ?? "")}" placeholder="${esc(field.placeholder || "")}" />${hint}</div>`;
    case "bool":
      return `<div class="field check"><input type="checkbox" data-path="${esc(path)}" data-kind="bool" id="${id}" ${value ? "checked" : ""} /><label for="${id}">${esc(field.label)}</label></div>`;
    case "list":
      return `<div class="field">${label}<input data-path="${esc(path)}" data-kind="list" id="${id}" value="${esc((Array.isArray(value) ? value : []).join(", "))}" placeholder="a, b, c" />${hint}</div>`;
    case "repeat": {
      const rows = Array.isArray(value) ? value : [];
      return `<div class="field"><label>${esc(field.label)}</label><div class="repeat" data-repeat="${esc(path)}">
        ${rows.map((row, i) => `<div class="repeat-row"><div class="sub">${field.fields.map((sf) => fieldHtml(sf, row?.[sf.key], node, `${path}.${i}.${sf.key}`)).join("")}</div><button type="button" class="rm" data-rm="${esc(path)}" data-i="${i}" title="Retirer">×</button></div>`).join("")}
        <button type="button" class="repeat-add" data-addrow="${esc(path)}">+ Ajouter</button></div>${hint}</div>`;
    }
    default:
      return `<div class="field">${label}<input data-path="${esc(path)}" id="${id}" value="${esc(value ?? "")}" placeholder="${esc(field.placeholder || "")}" />${hint}</div>`;
  }
}

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { const k = keys[i]; if (o[k] == null || typeof o[k] !== "object") o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {}; o = o[k]; }
  o[keys[keys.length - 1]] = value;
}

function renderInspector() {
  const node = nodeById(state.selectedId);
  const form = $("node-form");
  $("inspector-empty").hidden = !!node;
  form.hidden = !node;
  if (!node) return;
  // Le champ actif garde le focus et sa position : l'inspecteur est redessiné
  // à chaque aperçu, et perdre le curseur au milieu d'une requête SQL est
  // insupportable.
  const active = document.activeElement;
  const activePath = active?.dataset?.path, selStart = active?.selectionStart, selEnd = active?.selectionEnd;
  const spec = specOf(node);
  const color = node.kind === "source" ? "var(--c-source)" : node.kind === "destination" ? "var(--c-dest)" : spec.category === "IA" ? "var(--c-ai)" : "var(--c-transform)";
  const ports = node.kind === "transform" ? stepInputs(node.type) : node.kind === "destination" ? ["Entrée"] : [];
  const ins = inputsOf(node.id);
  const io = ports.length || ports === "multi"
    ? `<div class="insp-io">${ports === "multi"
      ? `<b>Entrées :</b> ${state.graph.edges.filter((e) => e.to === node.id).map((e) => nodeById(e.from)?.label).filter(Boolean).join(", ") || "aucune — reliez plusieurs blocs"}`
      : ports.map((p, i) => `<b>${esc(p)} :</b> ${ins[i] ? esc(nodeById(ins[i])?.label || "") + ` (${inputColumns(node, i).length} col.)` : "non reliée"}`).join("<br>")}</div>`
    : "";
  const r = state.results[node.id];
  form.innerHTML = `
    <div class="insp-type"><span class="block-icon" style="--b-color:${color}">${esc(spec.label.slice(0, 1))}</span><span><b>${esc(spec.label)}</b><small>${esc(spec.hint || "")}</small></span></div>
    <div class="field"><label for="f_label">Nom du bloc</label><input id="f_label" data-label value="${esc(node.label)}" /></div>
    ${io}
    ${r?.error ? `<div class="insp-err">${esc(r.error)}</div>` : ""}
    ${(spec.fields || []).map((f) => fieldHtml(f, getPath(node.params || {}, f.key), node, f.key)).join("") || `<div class="inspector-empty">Ce bloc n'a pas de réglage.</div>`}`;

  form.querySelector("[data-label]").oninput = (e) => { node.label = e.target.value; state.dirty = true; const t = $("world").querySelector(`.node[data-id="${CSS.escape(node.id)}"] .node-title`); if (t) t.textContent = node.label; };
  form.querySelectorAll("[data-path]").forEach((ctl) => {
    const handler = () => {
      const kind = ctl.dataset.kind;
      let v = ctl.value;
      if (kind === "number") v = ctl.value === "" ? "" : Number(ctl.value);
      if (kind === "bool") v = ctl.checked;
      if (kind === "list") v = ctl.value.split(",").map((s) => s.trim()).filter(Boolean);
      setPath(node.params, ctl.dataset.path, v);
      // Un champ dont d'autres dépendent (source → jeu) redessine l'inspecteur.
      const field = (spec.fields || []).find((f) => f.key === ctl.dataset.path);
      const dependents = (spec.fields || []).some((f) => f.dependsOn === ctl.dataset.path);
      if (dependents && ctl.tagName === "SELECT") { for (const f of spec.fields) if (f.dependsOn === ctl.dataset.path) node.params[f.key] = ""; renderInspector(); }
      if (field?.kind === "columns" || ctl.dataset.kind === "list") renderChips(ctl);
      touch();
    };
    ctl.addEventListener(ctl.tagName === "SELECT" || ctl.type === "checkbox" ? "change" : "input", handler);
  });
  form.querySelectorAll("[data-chips] .chip").forEach((chip) => chip.addEventListener("click", () => {
    const path = chip.closest("[data-chips]").dataset.chips;
    const cur = Array.isArray(getPath(node.params, path)) ? [...getPath(node.params, path)] : [];
    const i = cur.indexOf(chip.dataset.col);
    if (i >= 0) cur.splice(i, 1); else cur.push(chip.dataset.col);
    setPath(node.params, path, cur);
    chip.classList.toggle("on", i < 0);
    const input = form.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (input) input.value = cur.join(", ");
    touch();
  }));
  form.querySelectorAll("[data-addrow]").forEach((b) => b.addEventListener("click", () => {
    const path = b.dataset.addrow;
    const field = findField(spec.fields, path);
    const cur = Array.isArray(getPath(node.params, path)) ? getPath(node.params, path) : [];
    const row = {};
    for (const sf of field?.fields || []) {
      if (sf.kind === "select" && Array.isArray(sf.options) && sf.options.length) row[sf.key] = sf.options[0].value ?? sf.options[0];
      if (sf.kind === "column") row[sf.key] = inputColumns(node, sf.from === "right" ? 1 : 0)[0] || "";
      if (sf.kind === "bool") row[sf.key] = false;
    }
    setPath(node.params, path, [...cur, row]);
    renderInspector();
    touch();
  }));
  form.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
    const cur = [...(getPath(node.params, b.dataset.rm) || [])];
    cur.splice(Number(b.dataset.i), 1);
    setPath(node.params, b.dataset.rm, cur);
    renderInspector();
    touch();
  }));
  form.onsubmit = (e) => e.preventDefault();

  if (activePath) {
    const again = form.querySelector(`[data-path="${CSS.escape(activePath)}"]`);
    if (again) { again.focus({ preventScroll: true }); try { if (selStart != null) again.setSelectionRange(selStart, selEnd); } catch { /* select */ } }
  }
}
const findField = (fields, path) => (fields || []).find((f) => f.key === path.split(".")[0]);
function renderChips(ctl) {
  const box = ctl.parentElement.querySelector("[data-chips]");
  if (!box) return;
  const chosen = new Set(ctl.value.split(",").map((s) => s.trim()).filter(Boolean));
  box.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", chosen.has(c.dataset.col)));
}

// ============================ Volet du bas ============================

const fmt = (v) => (v === null || v === undefined ? "" : typeof v === "number" ? v.toLocaleString("fr-FR", { maximumFractionDigits: 4 }) : typeof v === "object" ? JSON.stringify(v) : String(v));

function renderBottom() {
  document.querySelectorAll(".bottom-head .tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === state.bottomTab));
  $("pane-preview").classList.toggle("on", state.bottomTab === "preview");
  $("pane-trace").classList.toggle("on", state.bottomTab === "trace");
  // L'aperçu montre le bloc sélectionné, sinon la dernière feuille du graphe.
  const node = nodeById(state.selectedId) || [...state.graph.nodes].reverse().find((n) => !state.graph.edges.some((e) => e.from === n.id)) || state.graph.nodes[state.graph.nodes.length - 1];
  const r = node ? state.results[node.id] : null;
  $("bottom-title").textContent = node ? `${node.label}${state.resultMode === "run" ? " · exécution complète" : " · échantillon"}` : "—";
  if (!node) {
    $("preview").innerHTML = `<div class="empty">Posez une source : l'aperçu se met à jour à chaque changement.</div>`;
    $("preview-count").textContent = "";
  } else if (!r) {
    $("preview").innerHTML = `<div class="empty">Aperçu en attente…</div>`;
    $("preview-count").textContent = "";
  } else if (r.error) {
    $("preview").innerHTML = `<div class="err">${esc(r.error)}</div>`;
    $("preview-count").textContent = "";
  } else if (r.skipped) {
    $("preview").innerHTML = `<div class="empty">Non joué : une entrée est en erreur.</div>`;
    $("preview-count").textContent = "";
  } else {
    const { table } = r;
    const rows = table.rows.slice(0, 100);
    $("preview-count").textContent = `${table.rows.length} ligne(s) · ${table.columns.length} colonne(s)${table.rows.length > 100 ? " · 100 affichées" : ""}`;
    $("preview").innerHTML = table.columns.length
      ? `<table class="grid"><thead><tr>${table.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
         <tbody>${rows.map((row) => `<tr>${table.columns.map((c) => { const v = row[c]; return `<td class="${v == null || v === "" ? "null" : typeof v === "number" ? "num" : ""}" title="${esc(fmt(v))}">${v == null || v === "" ? "∅" : esc(fmt(v))}</td>`; }).join("")}</tr>`).join("")
        || `<tr><td colspan="${table.columns.length}"><div class="empty">Aucune ligne ne sort de ce bloc.</div></td></tr>`}</tbody></table>`
      : `<div class="empty">Aucune colonne à ce stade.</div>`;
  }
  // Trace : tous les blocs dans l'ordre d'exécution.
  const order = topoOrder();
  $("trace").innerHTML = order.map((n) => {
    const x = state.results[n.id];
    const color = n.kind === "source" ? "var(--c-source)" : n.kind === "destination" ? "var(--c-dest)" : "var(--c-transform)";
    return `<div class="tr-row${x?.error ? " bad" : ""}${x?.skipped || n.disabled ? " off" : ""}${n.id === state.selectedId ? " on" : ""}" data-sel="${esc(n.id)}">
      <span class="tr-kind" style="background:${color}"></span>
      <span class="tr-label">${esc(n.label)}${n.disabled ? " (désactivé)" : ""}</span>
      <span class="tr-count">${x ? (x.error ? "erreur" : x.skipped ? "non joué" : `${x.table.rows.length} l · ${x.table.columns.length} c`) : "—"}</span>
      <span class="tr-ms">${x?.ms != null ? `${x.ms} ms` : ""}</span>
      ${x?.error ? `<span class="tr-err">${esc(x.error)}</span>` : ""}</div>`;
  }).join("") || `<div class="empty small">Aucun bloc.</div>`;
  $("trace").querySelectorAll("[data-sel]").forEach((el) => el.addEventListener("click", () => { state.selectedId = el.dataset.sel; render(); }));
}

function topoOrder() {
  const deg = Object.fromEntries(state.graph.nodes.map((n) => [n.id, 0]));
  state.graph.edges.forEach((e) => { if (deg[e.to] !== undefined) deg[e.to]++; });
  const q = state.graph.nodes.filter((n) => !deg[n.id]).sort((a, b) => a.y - b.y);
  const out = [];
  while (q.length) { const n = q.shift(); out.push(n); state.graph.edges.filter((e) => e.from === n.id).forEach((e) => { if (!--deg[e.to]) q.push(nodeById(e.to)); }); }
  return out.length === state.graph.nodes.length ? out : state.graph.nodes;
}

// ============================ Enregistrement ============================
//
// Un flux est un fichier JSON dans un espace — comme un rapport. Il se copie,
// se sauvegarde, se relit, et Fluxo pourra le déclencher sans que l'ETL ait
// besoin d'une base à lui. La vue (position, zoom) est locale à ce poste.

function renderSandboxPick() {
  const pick = $("sandbox-pick");
  if (!state.catalog.sandboxes.length) { pick.innerHTML = `<option value="">Aucun espace — en créer un</option>`; return; }
  pick.innerHTML = state.catalog.sandboxes.map((s) => `<option value="${esc(s.id)}" ${s.id === state.sandboxId ? "selected" : ""}>${esc(s.name)}</option>`).join("") + `<option value="__new">+ Nouvel espace…</option>`;
}

async function createSandbox() {
  const name = await promptSheet({ title: "Nouvel espace", body: "Les flux et leurs résultats y seront enregistrés.", value: "Flux de données" });
  if (!name?.trim()) { renderSandboxPick(); return; }
  try {
    const meta = await call("sandbox_create", { name: name.trim(), maxMb: 512 });
    state.catalog.sandboxes.push({ id: meta.id, name: meta.name });
    state.catalog.files[meta.id] = [];
    state.sandboxId = meta.id;
    renderSandboxPick();
    await listFlows();
    toast(`Espace « ${meta.name} » créé.`);
  } catch (e) { toast(String(e?.message || e)); renderSandboxPick(); }
}

async function listFlows() {
  if (!state.sandboxId) { state.flows = []; return; }
  const entries = await call("sandbox_read_dir", { id: state.sandboxId, path: FLOW_DIR }).catch(() => []);
  state.flows = entries.filter((e) => !e.is_dir && e.name.endsWith(".json")).map((e) => e.name.replace(/\.json$/, "")).sort();
}

const viewKey = () => LAYOUT_PREFIX + (state.graph.name || "untitled");
function saveView() { try { localStorage.setItem(viewKey(), JSON.stringify(state.view)); } catch { /* stockage indisponible */ } }

async function saveFlow() {
  const name = $("flow-name").value.trim();
  if (!name) { $("flow-name").focus(); toast("Donnez un nom au flux."); return; }
  state.graph.name = name;
  if (!state.sandboxId) { toast("Aucun espace d'enregistrement : créez-en un."); await createSandbox(); if (!state.sandboxId) return; }
  const data = { name, version: 2, nodes: state.graph.nodes.map((n) => ({ ...n })), edges: state.graph.edges.map((e) => ({ ...e })) };
  await call("sandbox_write_file", { id: state.sandboxId, path: `${FLOW_DIR}/${name}.json`, content: JSON.stringify(data, null, 2) });
  state.dirty = false;
  saveView();
  await listFlows();
  toast("Flux enregistré.");
}

async function openFlow(name) {
  const file = await call("sandbox_read_file", { id: state.sandboxId, path: `${FLOW_DIR}/${name}.json` });
  const data = JSON.parse(file?.content ?? file);
  state.graph = data.version === 2 ? { name: data.name || name, version: 2, nodes: data.nodes || [], edges: data.edges || [] } : migrateLinear(data, name);
  for (const n of state.graph.nodes) { n.kind = kindOf(n.type); n.params ||= {}; }
  try { state.view = JSON.parse(localStorage.getItem(viewKey())) || { x: 60, y: 60, scale: 1 }; } catch { state.view = { x: 60, y: 60, scale: 1 }; }
  state.selectedId = null;
  state.results = {};
  state.dirty = false;
  render();
  await refreshPreview();
}

/** Un flux de l'ancienne forme (source → étapes → destination) devient une chaîne de blocs. */
function migrateLinear(data, name) {
  const graph = freshGraph(data.name || name);
  let x = 40, prev = null;
  const put = (kind, type, label, params) => {
    const n = { id: newId(kind[0]), kind, type, label, x, y: 60, params };
    graph.nodes.push(n);
    if (prev) graph.edges.push({ id: newId("e"), from: prev.id, to: n.id, port: 0 });
    prev = n; x += 310;
    return n;
  };
  const s = data.source;
  if (s?.kind === "table") put("source", "src_table", s.label || "Table", { tableId: s.tableId });
  else if (s?.kind === "datasource") put("source", "src_datasource", s.label || "Source", { id: s.id, dataset: s.dataset });
  else if (s?.kind === "file") put("source", "src_file", s.label || "Fichier", { sandboxId: s.sandboxId, path: s.path, format: "csv" });
  for (const step of data.steps || []) {
    const { id, type, ...params } = step;
    if (type === "join" && params.rightId) {
      // La jointure lisait son jeu de droite elle-même : il devient un bloc source.
      const [k, a, b] = String(params.rightId).split(":");
      const right = { id: newId("s"), kind: "source", type: k === "table" ? "src_table" : "src_file", label: params.rightName || "Jeu de droite", x, y: 220, params: k === "table" ? { tableId: a } : { sandboxId: a, path: b, format: "csv" } };
      graph.nodes.push(right);
      const j = put("transform", "join", STEPS.join.label, { ...params, mode: params.inner ? "inner" : "left" });
      graph.edges.push({ id: newId("e"), from: right.id, to: j.id, port: 1 });
      continue;
    }
    // Les anciennes étapes à une condition / une clé / un renommage prennent la
    // forme en liste du canevas, sinon l'inspecteur les afficherait vides.
    if (type === "filter" && !params.conditions) Object.assign(params, { match: "all", conditions: [{ column: params.column, op: params.op, value: params.value }] });
    if (type === "sort" && !params.keys) params.keys = [{ column: params.column, desc: !!params.desc }];
    if (type === "rename" && !params.mappings) params.mappings = [{ column: params.column, to: params.to }];
    if (STEPS[type]) put("transform", type, STEPS[type].label, params);
  }
  const d = data.destination;
  if (d?.kind === "csv") put("destination", "dst_csv", "Fichier CSV", { sandboxId: d.sandboxId, path: d.path, delimiter: ";" });
  else if (d?.kind === "table") put("destination", "dst_table", "Table de Lumen", { name: d.name, mode: "append" });
  return graph;
}

async function mayDiscard() {
  if (!state.dirty || !state.graph.nodes.length) return true;
  return confirmSheet({ title: `Abandonner « ${state.graph.name || "ce flux"} » ?`, body: "Ce flux a des modifications non enregistrées. Elles seront perdues.", confirm: "Abandonner", danger: true });
}

function sheet(html, onMount) { $("sheet-card").innerHTML = html; $("sheet").hidden = false; onMount?.(); }
const closeSheet = () => { $("sheet").hidden = true; };

async function openSheet() {
  await listFlows();
  sheet(`
    <div class="modal-head"><h4>Ouvrir un flux</h4><button class="modal-close" data-close>×</button></div>
    <div class="modal-body">${state.flows.map((f) => `<div class="pick-row" data-open="${esc(f)}"><span>${esc(f)}</span><button class="del" data-del="${esc(f)}" title="Supprimer">×</button></div>`).join("")
      || `<div class="empty">Aucun flux enregistré dans cet espace.</div>`}</div>`, () => {
    $("sheet-card").querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", async (ev) => {
      if (ev.target.closest("[data-del]")) return;
      closeSheet();
      if (!(await mayDiscard())) return;
      try { await openFlow(el.dataset.open); } catch (e) { toast(`Flux illisible : ${String(e?.message || e)}`); }
    }));
    $("sheet-card").querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      closeSheet();
      if (!(await confirmSheet({ title: `Supprimer « ${el.dataset.del} » ?`, body: "Le fichier du flux sera retiré de l'espace.", confirm: "Supprimer", danger: true }))) return;
      await call("sandbox_delete_path", { id: state.sandboxId, path: `${FLOW_DIR}/${el.dataset.del}.json` }).catch((e) => toast(String(e?.message || e)));
      await listFlows();
      toast("Flux supprimé.");
    }));
  });
}

async function newFlow() {
  if (!(await mayDiscard())) return;
  state.graph = freshGraph("");
  state.view = { x: 60, y: 60, scale: 1 };
  state.selectedId = null;
  state.results = {};
  state.dirty = false;
  render();
  $("flow-name").focus();
}

// ============================ Assistant ============================

const ETL_TOOLS = [
  tool("list_blocks", "Liste les blocs disponibles (sources, transformations, destinations) avec leur identifiant, leur description et leurs paramètres. À appeler AVANT de construire.", { query: T.str("Filtre sur le nom ou la description"), kind: T.enum(["source", "transform", "destination"], "Genre de bloc") }),
  tool("describe_block", "Détail d'un bloc : ses paramètres, leurs types et valeurs possibles.", { type: T.str("Identifiant du bloc") }, ["type"]),
  tool("describe_flow", "État du flux ouvert : blocs, liaisons, colonnes disponibles en sortie de chaque bloc, erreurs. À lire AVANT toute modification.", {}),
  tool("add_block", "Pose un bloc et renvoie son identifiant. `after` le relie à la sortie d'un bloc existant (port 0 par défaut, 1 pour l'entrée « Droite » d'une jointure).", {
    type: T.str("Identifiant du bloc (voir list_blocks)"), label: T.str("Nom affiché"),
    params: { type: "object", description: "Paramètres { clé: valeur }" },
    after: T.str("Identifiant ou nom du bloc amont"), port: T.int("Port d'entrée (0 ou 1)"),
  }, ["type"]),
  tool("set_params", "Règle les paramètres d'un bloc déjà posé (fusion avec l'existant).", { block: T.str("Identifiant ou nom du bloc"), params: { type: "object", description: "{ clé: valeur }" } }, ["block", "params"]),
  tool("connect_blocks", "Relie la sortie d'un bloc à l'entrée d'un autre.", { from: T.str(""), to: T.str(""), port: T.int("0 = entrée principale / Gauche, 1 = Droite") }, ["from", "to"]),
  tool("remove_block", "Retire un bloc du canevas.", { block: T.str("") }, ["block"]),
  tool("preview", "Rejoue le flux sur l'échantillon et rend, pour chaque bloc, le nombre de lignes et colonnes, les erreurs, et les premières lignes du bloc demandé (sinon du dernier).", { block: T.str("Bloc dont on veut les premières lignes") }),
  tool("run_flow", "Exécute le flux en entier et ÉCRIT dans les destinations. Seulement si l'utilisateur le demande.", {}),
  tool("save_flow", "Enregistre le flux.", { name: T.str("Nom du flux") }),
  tool("list_flows", "Liste les flux enregistrés.", {}),
  tool("open_flow", "Ouvre un flux enregistré.", { name: T.str("") }, ["name"]),
];

const blockByRef = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return nodeById(ref) || state.graph.nodes.find((n) => String(n.label || "").toLowerCase() === r) || state.graph.nodes.find((n) => String(n.label || "").toLowerCase().includes(r));
};
const fieldsDoc = (spec) => (spec.fields || []).map((f) => {
  let t = f.kind;
  if (f.kind === "select" && Array.isArray(f.options)) t = f.options.map((o) => o.value ?? o).join("|");
  if (f.kind === "repeat") t = `liste de { ${f.fields.map((sf) => `${sf.key}: ${sf.kind === "select" && Array.isArray(sf.options) ? sf.options.map((o) => o.value ?? o).join("|") : sf.kind}`).join(", ")} }`;
  if (f.kind === "columns" || f.kind === "list") t = "liste de chaînes";
  return `${f.key} (${t})${f.from === "right" ? " [entrée Droite]" : ""}`;
}).join(", ") || "aucun";

async function runEtlTool(name, a) {
  const need = (ref) => { const n = blockByRef(ref); if (!n) throw new Error(`bloc « ${ref} » introuvable ; appelle describe_flow.`); return n; };
  switch (name) {
    case "list_blocks": {
      const q = String(a.query || "").toLowerCase();
      const all = [
        ...Object.entries(SOURCES).map(([t, s]) => ({ t, s, k: "source" })),
        ...Object.entries(STEPS).map(([t, s]) => ({ t, s, k: "transform" })),
        ...Object.entries(DESTINATIONS).map(([t, s]) => ({ t, s, k: "destination" })),
      ].filter(({ t, s, k }) => (!a.kind || k === a.kind) && (!q || `${t} ${s.label} ${s.hint || ""} ${s.category || ""}`.toLowerCase().includes(q)));
      return all.map(({ t, s, k }) => `${t} · ${s.label} [${k}${s.category ? " · " + s.category : ""}] — ${s.hint || ""}`).join("\n") || "Aucun bloc ne correspond.";
    }
    case "describe_block": {
      const spec = SOURCES[a.type] || STEPS[a.type] || DESTINATIONS[a.type];
      if (!spec) throw new Error("bloc inconnu ; appelle list_blocks.");
      const ports = STEPS[a.type] ? stepInputs(a.type) : [];
      return `${a.type} · ${spec.label}\n${spec.hint || ""}\nEntrées : ${ports === "multi" ? "plusieurs" : ports.join(", ") || (SOURCES[a.type] ? "aucune" : "une")}\nParamètres : ${fieldsDoc(spec)}`;
    }
    case "describe_flow": {
      if (!state.graph.nodes.length) return "Canevas vide.";
      const lines = topoOrder().map((n) => {
        const r = state.results[n.id];
        const ins = state.graph.edges.filter((e) => e.to === n.id).map((e) => `${nodeById(e.from)?.label || e.from}${(e.port || 0) ? " (Droite)" : ""}`);
        return `${n.id} · ${n.label} (${n.type}${n.disabled ? ", désactivé" : ""}) — params ${JSON.stringify(n.params || {})}${ins.length ? ` — entrées : ${ins.join(", ")}` : ""}${r ? ` — sortie : ${r.error ? "ERREUR " + r.error : `${r.table.rows.length} lignes, colonnes [${r.table.columns.join(", ")}]`}` : ""}`;
      });
      return `Flux « ${state.graph.name || "(sans nom)"} »\n${lines.join("\n")}`;
    }
    case "add_block": {
      if (!SOURCES[a.type] && !STEPS[a.type] && !DESTINATIONS[a.type]) throw new Error(`bloc « ${a.type} » inconnu ; appelle list_blocks.`);
      const after = a.after ? need(a.after) : null;
      const node = addNode(a.type, { label: a.label, params: a.params || {}, connectFrom: after ? after.id : null });
      if (after && a.port) { state.graph.edges = state.graph.edges.filter((e) => e.to !== node.id); const err = connect(after.id, node.id, Number(a.port)); if (err) throw new Error(err); }
      await refreshPreview();
      const r = state.results[node.id];
      return `Bloc posé : ${node.id} · ${node.label}${r?.error ? ` — mais il échoue : ${r.error}` : r ? ` — ${r.table.rows.length} ligne(s), colonnes [${r.table.columns.join(", ")}]` : ""}`;
    }
    case "set_params": {
      const node = need(a.block);
      Object.assign(node.params, a.params || {});
      touch();
      await refreshPreview();
      const r = state.results[node.id];
      return `Paramètres réglés sur « ${node.label} ».${r?.error ? ` Erreur : ${r.error}` : r ? ` ${r.table.rows.length} ligne(s) en sortie.` : ""}`;
    }
    case "connect_blocks": {
      const f = need(a.from), t = need(a.to);
      const err = connect(f.id, t.id, Number(a.port) || 0);
      if (err) throw new Error(err);
      touch();
      await refreshPreview();
      return `Relié : « ${f.label} » → « ${t.label} »${a.port ? ` (port ${a.port})` : ""}.`;
    }
    case "remove_block": { const n = need(a.block); removeNode(n.id); return `Bloc « ${n.label} » retiré.`; }
    case "preview": {
      await refreshPreview();
      const node = a.block ? need(a.block) : topoOrder().slice(-1)[0];
      const lines = topoOrder().map((n) => { const r = state.results[n.id]; return `${n.label} → ${r ? (r.error ? "ERREUR : " + r.error : r.skipped ? "non joué" : `${r.table.rows.length} lignes · ${r.table.columns.length} colonnes`) : "—"}`; });
      const r = node ? state.results[node.id] : null;
      return `${lines.join("\n")}${r && !r.error ? `\n\n« ${node.label} » — colonnes : ${r.table.columns.join(", ")}\nPremières lignes : ${JSON.stringify(r.table.rows.slice(0, 5))}` : ""}`;
    }
    case "run_flow": { const out = await runFlow(); return out?.failed ? "Le flux a échoué, voir la trace." : "Flux exécuté."; }
    case "save_flow": { if (a.name) $("flow-name").value = String(a.name); await saveFlow(); return `Flux enregistré : « ${state.graph.name} ».`; }
    case "list_flows": { await listFlows(); return state.flows.join("\n") || "Aucun flux enregistré."; }
    case "open_flow": { await openFlow(String(a.name)); return `Ouvert : « ${a.name} » (${state.graph.nodes.length} blocs).`; }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountAi() {
  mountAiPrompt(null, {
    app: "Flux de données",
    title: "Assistant",
    intro: "Tu construis un flux de données (ETL) sur un canevas : des blocs sources, des transformations, des destinations, reliés entre eux.",
    rules: [
      "- Commence TOUJOURS par describe_flow, puis list_blocks / describe_block : n'invente jamais un identifiant de bloc, un paramètre ni un nom de colonne.",
      "- Construis dans l'ordre : source, puis transformations une à une (avec `after` pour les relier), puis destination. Vérifie avec preview après chaque étape : c'est le nombre de lignes restantes qui dit si un filtre est juste.",
      "- Une jointure ou une recherche a deux entrées : relie le second jeu sur le port 1 (« Droite »).",
      "- Si un bloc vide le jeu ou échoue, dis-le et propose une correction plutôt que d'enchaîner.",
      "- N'exécute run_flow que si l'utilisateur le demande : il écrit dans les destinations.",
    ].join("\n"),
    placeholder: "Ex. : lis la table Ventes, garde 2026, joins les clients par identifiant, regroupe par ville et écris un CSV…",
    suggestions: [
      { label: "Nettoyer", prompt: "Nettoie ce jeu : espaces, doublons, types, valeurs manquantes, noms de colonnes." },
      { label: "Agréger", prompt: "Regroupe ces données par la dimension la plus utile et calcule les totaux." },
      { label: "Profiler", prompt: "Ajoute un profil des données à la source et dis-moi ce que tu y vois." },
      { label: "Expliquer", prompt: "Explique-moi ce que fait ce flux, bloc par bloc, et ce qui pourrait mal tourner." },
    ],
    tools: ETL_TOOLS,
    context: () => `Flux « ${state.graph.name || "(sans nom)"} » : ${state.graph.nodes.length} bloc(s), ${state.graph.edges.length} liaison(s). Bloc sélectionné : ${nodeById(state.selectedId)?.label || "aucun"}.`,
    execute: runEtlTool,
    onApplied: () => { render(); },
  });
}

// ============================ Démarrage ============================

async function init() {
  if (!(await requireProPage({ appName: "Flux de données" }))) return;

  document.body.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
  $("block-search").oninput = renderPalette;
  $("btn-new").onclick = newFlow;
  $("btn-open").onclick = openSheet;
  $("btn-save").onclick = saveFlow;
  $("btn-preview").onclick = () => { state.sampleCache.clear(); refreshPreview().catch((e) => toast(String(e?.message || e))); };
  $("btn-run").onclick = runFlow;
  $("flow-name").oninput = (e) => { state.graph.name = e.target.value; state.dirty = true; };
  $("delete-node").onclick = () => { if (state.selectedId) removeNode(state.selectedId); };
  $("toggle-node").onclick = () => { const n = nodeById(state.selectedId); if (n) { n.disabled = !n.disabled; touch(); } };
  $("starter").onclick = () => { const n = addNode("src_table", { x: 40, y: 60 }); state.selectedId = n.id; render(); };
  $("sandbox-pick").onchange = async (e) => {
    if (e.target.value === "__new" || !e.target.value) { await createSandbox(); return; }
    state.sandboxId = e.target.value;
    await listFlows();
  };
  document.querySelectorAll(".bottom-head .tab").forEach((t) => t.addEventListener("click", () => { state.bottomTab = t.dataset.tab; $("bottom").classList.remove("collapsed"); renderBottom(); }));
  $("bottom-toggle").onclick = () => $("bottom").classList.toggle("collapsed");
  bindStage();

  try {
    state.catalog = await discoverCatalog(call);
    state.sandboxId = state.catalog.sandboxes[0]?.id || "";
    await listFlows();
  } catch { /* Lumen indisponible : l'app le dira au premier enregistrement */ }
  renderSandboxPick();
  renderPalette();
  render();
  mountAi();
  autoTranslate({ observe: true });
}

init();

// Poignée de test pour le harnais __preview-etl.html : rien d'autre ne la lit.
if (location.pathname.includes("__preview")) window.__lumenEtl = { state, runEtlTool, addNode, connect, refreshPreview, runFlow, render };
