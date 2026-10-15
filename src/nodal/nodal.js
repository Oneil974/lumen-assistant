// Studio Nodal — coque de l'app : projets (sandbox « Canevas », dossier
// canevas/, `app: "nodal"`), moteurs de génération, bibliothèque de nœuds et
// éditeur de graphe (graph/editor.js).

import { autoTranslate, tt } from "../apps-i18n.js";
import { icon } from "../lib/icons.js";
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import * as store from "../canvas/store.js";
import { mountBackendSwitches, refreshBackendStatus } from "../canvas/backends.js";
import { resetProbes } from "../canvas/generate.js";
import { createGraphEditor, blankGraph } from "./graph/editor.js";
import { CATEGORIES, NODE_DEFS, TYPES, nodeIcon, nodeColor } from "./graph/nodes.js";

const TAURI = window.__TAURI__ || window.parent?.__TAURI__ || {};
const invoke = TAURI.core?.invoke;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let project = null;
let editor = null;
let saveTimer = null;
let toastTimer = null;

function toast(msg, ms = 3000) {
  const el = $("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
const ask = (title, value = "") => promptSheet({ title: tt(title), value });

function queueSave() {
  if (!project) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.saveProject(project).catch((e) => toast(`${tt("Sauvegarde")} : ${e.message || e}`)), 400);
}

// ---- Bibliothèque de nœuds ---------------------------------------------------------
function renderLibrary(q = "") {
  const query = q.trim().toLowerCase();
  const html = CATEGORIES.map((c) => {
    const defs = Object.values(NODE_DEFS).filter((d) => d.cat === c.id && (!query || `${d.title} ${d.type} ${c.label}`.toLowerCase().includes(query)));
    if (!defs.length) return "";
    return `<details class="nd-cat" open><summary>${esc(tt(c.label))}<small>${defs.length}</small></summary>
      ${defs.map((d) => {
        const dots = [...new Set([...(d.inputs || []), ...(d.outputs || [])].map((p) => p.type))].slice(0, 4).map((t) => `<i style="background:${TYPES[t]?.color || "#9ca3af"}" title="${esc(TYPES[t]?.label || t)}"></i>`).join("");
        return `<button class="nd-node" draggable="true" data-type="${esc(d.type)}" title="${esc(tt(d.title))}"><span class="nd-block-icon" style="--block-color:${nodeColor(d)}">${icon(nodeIcon(d))}</span><span class="nd-node-t"><b>${esc(tt(d.title))}</b><small>${esc(tt(d.description || `${d.inputs?.length || 0} entrées · ${d.outputs?.length || 0} sorties`))}</small></span><span class="nd-dots">${dots}</span></button>`;
      }).join("")}</details>`;
  }).join("");
  $("lib-list").innerHTML = html || `<p class="nd-empty">${esc(tt("Aucun nœud ne correspond."))}</p>`;
}

function wireLibrary() {
  $("lib-q").addEventListener("input", (e) => renderLibrary(e.target.value));
  $("lib-list").addEventListener("dragstart", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b) return;
    e.dataTransfer.setData("text/nodal-node", b.dataset.type);
    e.dataTransfer.effectAllowed = "copy";
  });
  $("lib-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (b) editor?.addNodeAtCenter(b.dataset.type);
  });
}

// ---- Projets -----------------------------------------------------------------------
async function refreshProjects(selectSlug) {
  let list = [];
  try { list = await store.listProjects({ kind: "nodal" }); } catch {}
  $("project-select").innerHTML = list.map((p) => `<option value="${esc(p.slug)}">${esc(p.title)}</option>`).join("");
  if (selectSlug) $("project-select").value = selectSlug;
  return list;
}

async function openProject(slug) {
  try {
    const p = await store.loadProject(slug);
    p.app = "nodal";
    p.graph ||= blankGraph();
    project = p;
    editor.open(project);
    $("project-select").value = slug;
  } catch (e) { toast(`${tt("Ouverture impossible")} : ${e.message || e}`, 5000); }
}

async function createProject(title) {
  const p = await store.createProject(title);
  p.app = "nodal"; p.mode = "graph"; p.graph = blankGraph();
  await store.saveProject(p);
  await refreshProjects(p.slug);
  project = p;
  editor.open(project);
  return p;
}

async function projectAction(act) {
  $("more-menu").hidden = true;
  if (!project) return;
  if (act === "rename") {
    const t = await ask("Renommer le projet", project.title);
    if (!t) return;
    await store.renameProject(project, t);
    await refreshProjects(project.slug);
  } else if (act === "duplicate") {
    const t = await ask("Nom de la copie", `${project.title} (copie)`);
    if (!t) return;
    const copy = await store.createProject(t);
    Object.assign(copy, { app: "nodal", mode: "graph", graph: JSON.parse(JSON.stringify(project.graph || blankGraph())) });
    // Les sorties mémorisées pointent dans le dossier de l'original : on repart à neuf.
    for (const n of copy.graph.nodes || []) delete n.saved;
    await store.saveProject(copy);
    await refreshProjects(copy.slug);
    await openProject(copy.slug);
  } else if (act === "delete") {
    const ok = await confirmSheet({ title: tt("Supprimer le projet"), body: tt("« {t} » et tout son dossier (images produites) seront supprimés. Cette action est irréversible.", { t: project.title }), confirm: tt("Supprimer"), danger: true });
    if (!ok) return;
    await store.deleteProject(project.slug);
    const list = await refreshProjects();
    if (list[0]) await openProject(list[0].slug); else await createProject(tt("Mon premier workflow"));
  }
}

// ---- Démarrage ---------------------------------------------------------------------
async function init() {
  document.querySelectorAll("[data-ic]").forEach((n) => { n.innerHTML = icon(n.dataset.ic); });
  renderLibrary();
  wireLibrary();
  editor = createGraphEditor($("graph-root"), { store, invoke, toast, ask: (title, value) => ask(title, value), onChange: () => queueSave() });

  const menus = [["btn-more", "more-menu"], ["btn-engines", "engines"]];
  for (const [btn, menu] of menus) $(btn).addEventListener("click", (e) => { e.stopPropagation(); for (const [, m] of menus) if (m !== menu) $(m).hidden = true; $(menu).hidden = !$(menu).hidden; });
  document.addEventListener("click", (e) => { for (const [, m] of menus) if (!e.target.closest(`#${m}`)) $(m).hidden = true; });
  $("more-menu").addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) projectAction(b.dataset.act); });
  $("btn-new").addEventListener("click", async () => { const t = await ask("Nouveau projet", tt("Nouveau workflow")); if (t) await createProject(t); });
  $("project-select").addEventListener("change", (e) => openProject(e.target.value));

  mountBackendSwitches(document, { invoke });
  window.addEventListener("storage", (e) => {
    if (["aiSource", "imageProvider", "canvasTextBackend", "canvasImageBackend"].includes(e?.key)) { resetProbes(); refreshBackendStatus($("status-text")); }
  });
  try { autoTranslate({ observe: true }); } catch {}

  if (!store.hasBackend()) { toast(tt("Disponible uniquement dans l'app Lumen (stockage sandbox)."), 6000); return; }
  try {
    await store.ensureSandbox();
    const list = await refreshProjects();
    if (list[0]) await openProject(list[0].slug);
    else await createProject(tt("Mon premier workflow"));
  } catch (e) { toast(`${tt("Initialisation")} : ${e.message || e}`, 5000); }
}

init();
