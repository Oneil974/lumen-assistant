// Analyse de données — un mini Power BI local, qui absorbe l'ancien Reporting.
//
//   • Modèle : des tables chargées depuis les sandboxes (CSV/TSV), les Bases
//     locales et connexions du catalogue, ou des requêtes SQL paramétrées par
//     la période (:debut / :fin) — model.js.
//   • Rapport : des pages de visuels posés librement sur une grille (cartes,
//     histogrammes, courbes, secteurs, compartimentage, entonnoir, cascade,
//     nuage, jauge, table, matrice, segments, texte, analyse IA) — viz.js.
//     Les segments filtrent la page, un clic sur une barre filtre les autres
//     visuels (filtre croisé), la période se compare à la précédente.
//   • Export PDF/HTML, envoi par email et abonnements planifiés (envoi
//     automatique, côté Rust : report_subs.rs) — export.js.
//   • Assistant IA : construit des visuels, répond aux questions (Q&A),
//     rédige des analyses — avec les outils déclarés ici.
//
// Un rapport est un fichier JSON dans une sandbox (`Rapports/`), lisible,
// copiable, versionnable ; les anciens rapports Reporting (`reporting/*.json`)
// et tableaux de bord (`analysis/*-dashboard.json`) s'importent tels quels.

import { autoTranslate, tt } from "../apps-i18n.js";
import { createStore } from "../lib/app-state.js";
import { icon } from "../lib/icons.js";
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { ensureSessionUnlocked, invokeUnlocked, isSessionUnlocked } from "../lib/session-unlock.js";
import { mountAiPrompt, runAiTools, tool, T as PT } from "../lib/ai-prompt.js?v=5";
import { llmChat } from "../llm.js";
import { renderMarkdown } from "../sandbox/render.js";
import { receive } from "../lib/interop.js";
import * as db from "../tables/client.js";
import { listDatasets } from "../lib/data-catalog.js";
import { periodPreset } from "../lib/pro-data.js";
import { replyLang } from "../lib/prompt-lang.js";
import { previousPeriod } from "./run.js";
import * as Mo from "./model.js";
import * as V from "./viz.js";
import * as X from "./export.js";
import * as DI from "./doc-insert.js";
import { PROMPTS } from "./prompts.js";

const TAURI = window.__TAURI__ || window.parent?.__TAURI__ || {};
const invoke = TAURI.core?.invoke;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = (p = "") => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ic = (n) => icon(n) || "";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const today = () => new Date().toISOString().slice(0, 10);
const slug = (s) => String(s || "rapport").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "rapport";
const COLS = 12, ROW = 40;
const REPORT_DIR = "Rapports";
const store = createStore("dataanalysis");

// ===== État =====================================================================
const state = {
  report: null,
  file: null,            // { sandboxId, path }
  sandboxes: [],
  tables: new Map(),     // id de source → table chargée
  prev: new Map(),       // id de source → table de la période précédente (SQL)
  errors: new Map(),
  loading: false,
  view: "report",
  pageId: "",
  selId: "",             // visuel sélectionné
  pane: "build",
  lastRes: new Map(),    // id de visuel → dernier résultat calculé (couleurs par série)
  selection: null,       // filtre croisé { page, visualId, col, key, bucket, label }
  dataTable: "",
  dirty: false,
  locked: false,
  subs: [],
};
let saveTimer = 0;

function toast(msg, ms = 3200) {
  const el = $("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

// ===== Modèle de rapport ===========================================================
function blankReport(name = tt("Nouveau rapport")) {
  const per = periodPreset("month");
  return {
    kind: "lumen-report", v: 2, id: uid("r"), name, palette: "lumen", notes: "",
    tables: [], filters: [],
    period: { enabled: false, from: per.from, to: per.to, compare: true },
    pages: [{ id: uid("p"), name: tt("Page 1"), visuals: [], filters: [], slicers: {} }],
    updatedAt: Date.now(),
  };
}
function normalize(r) {
  r.kind = "lumen-report"; r.v = 2;
  r.tables ||= []; r.filters ||= []; r.pages ||= [];
  r.period = { enabled: false, compare: true, ...periodPreset("month"), ...(r.period || {}) };
  if (!r.pages.length) r.pages.push({ id: uid("p"), name: tt("Page 1"), visuals: [], filters: [], slicers: {} });
  for (const p of r.pages) { p.visuals ||= []; p.filters ||= []; p.slicers ||= {}; for (const v of p.visuals) { v.opts ||= {}; v.values ||= []; v.filters ||= []; } }
  r.palette ||= "lumen";
  return r;
}
const R = () => state.report;
const curPage = () => R().pages.find((p) => p.id === state.pageId) || R().pages[0];
const selVisual = () => curPage()?.visuals.find((v) => v.id === state.selId) || null;
const srcOf = (id) => R().tables.find((t) => t.id === id);
const tableName = (id) => srcOf(id)?.name || "—";

// ---- Conversion des anciens formats -----------------------------------------------
const WIDTH = { third: 4, half: 6, two: 8, full: 12 };
function fromLegacyReporting(spec) {
  const r = blankReport(spec.name || "Rapport");
  r.period = { enabled: true, compare: !!spec.params?.compare, from: spec.params?.from || r.period.from, to: spec.params?.to || r.period.to };
  r.tables = (spec.sources || []).map((s) => ({ id: s.id, name: s.name || "Source", kind: "sql", baseId: spec.baseId, sql: s.sql }));
  const page = r.pages[0];
  page.name = spec.subtitle || tt("Synthèse");
  let x = 0, y = 0, rowH = 0;
  const place = (w, h) => { if (x + w > COLS) { x = 0; y += rowH; rowH = 0; } const pos = { x, y, w, h }; x += w; rowH = Math.max(rowH, h); return pos; };
  for (const b of spec.blocks || []) {
    const w = WIDTH[b.width] || (b.type === "kpi" ? 4 : 12);
    const base = { id: b.id || uid("v"), title: b.title || "", table: b.sourceId, opts: { format: b.format || "auto", prefix: b.prefix || "", suffix: b.suffix || "", decimals: b.decimals ?? "", compare: true }, values: [], filters: [] };
    let v;
    if (b.type === "heading") v = { ...base, type: "text", text: `## ${b.title || b.text || ""}`, title: "", ...place(12, 2) };
    else if (b.type === "text") v = { ...base, type: "text", text: b.text || "", ...place(w, 4) };
    else if (b.type === "kpi") v = { ...base, type: "card", values: [{ col: b.y || "", agg: b.y ? b.agg || "sum" : "count" }], ...place(w, 3) };
    else if (b.type === "chart") v = { ...base, type: { bar: "bar", hbar: "hbar", line: "line", area: "area", pie: "pie", donut: "donut", scatter: "scatter", gauge: "gauge" }[b.chart] || "bar", axis: b.x ? { col: b.x, bucket: "" } : null, values: b.chart === "scatter" ? [{ col: b.x, agg: "sum" }, { col: b.y, agg: "sum" }] : [{ col: b.y || "", agg: b.y ? b.agg || "sum" : "count" }], opts: { ...base.opts, limit: b.limit || 0 }, ...place(w, Math.round((b.height || 260) / ROW) + 1) };
    else if (b.type === "table") v = { ...base, type: "table", columns: b.columns || [], opts: { ...base.opts, limit: b.limit || 50 }, ...place(w, 7) };
    else if (b.type === "pivot") v = { ...base, type: "matrix", pivot: { rows: b.rows || [], cols: b.cols || [], values: b.values || [], buckets: b.buckets || {}, showAs: b.showAs || "value", sort: b.sort || "label", sortDir: b.sortDir || "asc", topN: b.topN || 0, compare: !!b.compare, subtotals: b.subtotals !== false, rowTotals: true, colTotals: true, heatmap: !!b.heatmap }, ...place(w, 8) };
    else if (b.type === "ai") v = { ...base, type: "ai", question: b.question || "", answer: b.answer || "", ...place(w, 5) };
    if (v) page.visuals.push(v);
  }
  r.migratedFrom = "reporting";
  return r;
}
function fromLegacyDashboard(spec, src) {
  const r = blankReport(String(spec.file || src.path).split("/").pop().replace(/\.[^.]+$/, ""));
  const tid = uid("t");
  r.tables.push({ id: tid, name: r.name, kind: "file", sandboxId: src.sandboxId, path: spec.file || "" });
  const page = r.pages[0];
  let x = 0, y = 0;
  for (const w of spec.widgets || []) {
    const type = w.type === "kpi" ? "card" : V.VISUALS.some((d) => d.id === w.type) ? w.type : "bar";
    const width = type === "card" ? 3 : 6, h = type === "card" ? 3 : 7;
    if (x + width > COLS) { x = 0; y += 7; }
    page.visuals.push({ id: uid("v"), type, title: w.title || "", table: tid, axis: w.x ? { col: w.x, bucket: "" } : null, values: type === "scatter" ? [{ col: w.x, agg: "sum" }, { col: w.y, agg: "sum" }] : [{ col: w.y || "", agg: w.y ? w.agg || "sum" : "count" }], opts: { limit: w.limit || 0 }, filters: [], x, y, w: width, h });
    x += width;
  }
  r.migratedFrom = "dashboard";
  return r;
}

// ===== Persistance =================================================================
function touch() {
  R().updatedAt = Date.now();
  state.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveReport({ silent: true }), 900);
  renderTitle();
}

async function sandboxes() {
  try { state.sandboxes = (await invoke("sandbox_list")) || []; } catch { state.sandboxes = []; }
  return state.sandboxes;
}

async function saveReport({ silent = false, as = false } = {}) {
  clearTimeout(saveTimer);
  if (!invoke || !R()) return false;
  if (state.locked && !(await unlock(tt("Enregistrer le rapport")))) return false;
  if (!state.file || as) {
    const list = state.sandboxes.length ? state.sandboxes : await sandboxes();
    if (!list.length) { if (!silent) toast(tt("Créez d'abord une sandbox dans Fichiers.")); return false; }
    const sb = list.find((s) => s.id === store.get("sandbox", "")) || list[0];
    state.file = { sandboxId: sb.id, path: `${REPORT_DIR}/${slug(R().name)}-${R().id.slice(-4)}.json` };
  }
  try {
    await invoke("sandbox_write_file", { id: state.file.sandboxId, path: state.file.path, content: JSON.stringify(R(), null, 2) });
    state.dirty = false;
    store.set("last", state.file);
    renderTitle();
    if (!silent) toast(tt("Rapport enregistré."));
    return true;
  } catch (e) { if (!silent) toast(`${tt("Enregistrement impossible")} : ${e?.message || e}`); return false; }
}

async function readJson(sandboxId, path) {
  const res = await invoke("sandbox_read_file", { id: sandboxId, path });
  return JSON.parse(typeof res === "string" ? res : res?.content || "null");
}

/** Rapports de toutes les sandboxes (nouveaux, Reporting, tableaux de bord). */
async function listAllReports() {
  const out = [];
  for (const sb of await sandboxes()) {
    for (const [dir, kind] of [[REPORT_DIR, "report"], ["reporting", "legacy"], ["analysis", "dashboard"]]) {
      let entries = [];
      try { entries = (await invoke("sandbox_read_dir", { id: sb.id, path: dir })) || []; } catch { continue; }
      for (const e of entries) {
        if (e.is_dir || !String(e.name).endsWith(".json")) continue;
        if (kind === "dashboard" && !/-dashboard\.json$/.test(e.name)) continue;
        const path = `${dir}/${e.name}`;
        let spec = null;
        try { spec = await readJson(sb.id, path); } catch { continue; }
        if (!spec) continue;
        out.push({ sandboxId: sb.id, sandbox: sb.name, path, kind, name: spec.name || String(spec.file || e.name).split("/").pop().replace(/(-dashboard)?\.json$/, ""), updatedAt: spec.updatedAt || 0, spec });
      }
    }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function openReportFile(entry) {
  let r;
  if (entry.kind === "legacy") r = fromLegacyReporting(entry.spec);
  else if (entry.kind === "dashboard") r = fromLegacyDashboard(entry.spec, entry);
  else r = entry.spec;
  state.report = normalize(r);
  state.file = entry.kind === "report" ? { sandboxId: entry.sandboxId, path: entry.path } : null;
  if (!state.file) store.set("sandbox", entry.sandboxId);
  afterLoad();
  await refreshData();
  if (entry.kind !== "report") { await saveReport({ silent: true }); toast(tt("Ancien rapport importé dans le nouveau format.")); }
}

function afterLoad() {
  state.pageId = R().pages[0].id;
  state.selId = ""; state.selection = null;
  state.dataTable = R().tables[0]?.id || "";
  renderAll();
}

// ===== Données ======================================================================
async function refreshData({ only = null } = {}) {
  if (!R()) return;
  state.loading = true;
  renderStatus();
  const period = R().period?.enabled ? R().period : null;
  for (const src of R().tables) {
    if (only && src.id !== only) continue;
    try {
      const t = await Mo.loadSource(src, { invoke, period: period || { from: "1900-01-01", to: "2999-12-31" } });
      state.tables.set(src.id, t);
      state.errors.delete(src.id);
      if (!src.dateColumn) src.dateColumn = t.columns.find((c) => t.types[c] === "date") || "";
      if (period?.compare && src.kind === "sql") state.prev.set(src.id, await Mo.loadPrevious(src, { invoke, period }));
      else state.prev.delete(src.id);
    } catch (e) {
      state.errors.set(src.id, String(e?.message || e));
      state.tables.delete(src.id);
    }
  }
  state.loading = false;
  renderStatus();
  renderView();
  renderPanes();
}

/** Filtres effectifs d'un visuel. Les segments et le filtre croisé
 *  s'appliquent à toute table ayant une colonne du même nom. */
function effFilters(v, page, T, { noPeriod = false } = {}) {
  const has = (c) => T.columns.includes(c);
  const fs = [];
  for (const f of [...(R().filters || []), ...(page.filters || []), ...(v.filters || [])]) if ((!f.table || f.table === v.table) && has(f.col)) fs.push(f);
  for (const s of page.visuals) {
    if (s.type !== "slicer" || s.id === v.id) continue;
    const f = page.slicers?.[s.id];
    if (f && has(f.col)) fs.push(f);
  }
  const sel = state.selection;
  if (sel && sel.page === page.id && sel.visualId !== v.id && has(sel.col)) fs.push({ col: sel.col, op: "in", values: [sel.key], bucket: sel.bucket });
  if (!noPeriod && R().period?.enabled) {
    const src = srcOf(v.table);
    if (src && src.kind !== "sql" && src.dateColumn) fs.push(...Mo.periodFilters(T, R().period, src.dateColumn));
  }
  return fs;
}

function dataFor(v, page = curPage()) {
  const T0 = state.tables.get(v.table);
  if (!T0) return { T: null, P: null };
  const T = Mo.filterTable(T0, effFilters(v, page, T0));
  let P = null;
  const per = R().period;
  if (per?.enabled && per.compare) {
    const src = srcOf(v.table);
    if (src?.kind === "sql") { const P0 = state.prev.get(v.table); if (P0) P = Mo.filterTable(P0, effFilters(v, page, P0, { noPeriod: true })); }
    else if (src?.dateColumn) P = Mo.filterTable(T0, [...effFilters(v, page, T0, { noPeriod: true }), ...Mo.periodFilters(T0, previousPeriod(per), src.dateColumn)]);
  }
  return { T, P };
}

// ===== Rendu général ============================================================
function renderAll() {
  renderTitle(); renderPeriod(); renderView(); renderPanes(); renderPages();
}
function renderTitle() {
  if (!R()) return;
  if (document.activeElement !== $("report-name")) $("report-name").value = R().name;
  $("save-state").textContent = state.dirty ? tt("Modifié") : state.file ? tt("Enregistré") : tt("Non enregistré");
  $("save-state").dataset.dirty = String(state.dirty || !state.file);
}
function renderStatus() {
  const errs = [...state.errors.entries()];
  $("data-status").innerHTML = state.loading ? `${ic("refresh-cw")}${esc(tt("Chargement…"))}`
    : errs.length ? `<span class="err">${ic("triangle-alert")}${esc(tt("{n} source(s) en erreur", { n: errs.length }))}</span>`
    : R()?.tables.length ? `${ic("database")}${R().tables.length} ${esc(tt("table(s)"))} · ${[...state.tables.values()].reduce((a, t) => a + t.rows.length, 0).toLocaleString("fr-FR")} ${esc(tt("lignes"))}` : "";
}
function setView(view) {
  state.view = view;
  document.querySelectorAll(".rail-btn[data-view]").forEach((b) => b.classList.toggle("is-on", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((s) => { s.hidden = s.id !== `view-${view}`; });
  $("app").dataset.view = view;
  renderView();
  renderPanes();
}
function renderView() {
  if (!R()) return;
  if (state.view === "report") renderCanvas();
  else if (state.view === "data") renderDataView();
  else if (state.view === "model") renderModelView();
  else if (state.view === "subs") renderSubsView();
}

// ===== Période ==================================================================
function renderPeriod() {
  const p = R().period;
  $("per-on").checked = !!p.enabled;
  $("per-from").value = p.from || ""; $("per-to").value = p.to || "";
  $("per-compare").checked = !!p.compare;
  $("period").classList.toggle("off", !p.enabled);
}
function wirePeriod() {
  const apply = () => {
    const p = R().period;
    p.enabled = $("per-on").checked; p.from = $("per-from").value; p.to = $("per-to").value; p.compare = $("per-compare").checked;
    $("period").classList.toggle("off", !p.enabled);
    touch(); refreshData();
  };
  ["per-on", "per-from", "per-to", "per-compare"].forEach((id) => $(id).addEventListener("change", apply));
  $("per-preset").addEventListener("change", (e) => {
    if (!e.target.value) return;
    const pp = periodPreset(e.target.value);
    $("per-from").value = pp.from; $("per-to").value = pp.to; $("per-on").checked = true;
    e.target.value = "";
    apply();
  });
}

// ===== Pages ======================================================================
function renderPages() {
  $("pages").innerHTML = R().pages.map((p) => `<button class="page-tab${p.id === curPage().id ? " is-on" : ""}" data-page="${p.id}" title="${esc(tt("Double-clic pour renommer"))}">${esc(p.name)}${R().pages.length > 1 ? `<span class="page-x" data-del-page="${p.id}">×</span>` : ""}</button>`).join("")
    + `<button class="page-add" data-add-page title="${esc(tt("Nouvelle page"))}">${ic("plus")}</button>`;
}
function wirePages() {
  $("pages").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-page]");
    if (del) {
      e.stopPropagation();
      const p = R().pages.find((x) => x.id === del.dataset.delPage);
      if (!(await confirmSheet({ title: tt("Supprimer la page « {n} » ?", { n: p.name }), confirm: tt("Supprimer"), cancel: tt("Annuler"), danger: true }))) return;
      R().pages = R().pages.filter((x) => x !== p);
      if (state.pageId === p.id) state.pageId = R().pages[0].id;
      touch(); renderPages(); renderCanvas(); renderPanes();
      return;
    }
    if (e.target.closest("[data-add-page]")) { addPage(); return; }
    const b = e.target.closest("[data-page]");
    if (b) { state.pageId = b.dataset.page; state.selId = ""; state.selection = null; renderPages(); renderCanvas(); renderPanes(); }
  });
  $("pages").addEventListener("dblclick", async (e) => {
    const b = e.target.closest("[data-page]");
    if (!b) return;
    const p = R().pages.find((x) => x.id === b.dataset.page);
    const name = await promptSheet({ title: tt("Nom de la page"), value: p.name });
    if (name) { p.name = name; touch(); renderPages(); }
  });
}
function addPage(name = "") {
  const p = { id: uid("p"), name: name || `${tt("Page")} ${R().pages.length + 1}`, visuals: [], filters: [], slicers: {} };
  R().pages.push(p);
  state.pageId = p.id; state.selId = "";
  touch(); renderPages(); renderCanvas(); renderPanes();
  return p;
}

// ===== Canevas ======================================================================
function colW() { return Math.max(40, ($("canvas").clientWidth - 32) / COLS); }

function renderCanvas() {
  const page = curPage();
  const host = $("canvas");
  V.disposeAllVisuals();
  const cw = colW();
  const maxY = Math.max(10, ...page.visuals.map((v) => v.y + v.h));
  const sel = state.selection && state.selection.page === page.id ? state.selection : null;
  host.innerHTML = `<div class="surface" id="surface" style="height:${(maxY + 4) * ROW}px">${page.visuals.length ? "" : `<div class="canvas-empty">
      <div class="ce-ic">${ic("layout-dashboard")}</div>
      <h3>${esc(tt(R().tables.length ? "Composez votre rapport" : "Commencez par ajouter des données"))}</h3>
      <p>${esc(tt(R().tables.length ? "Choisissez un visuel dans le volet de droite, cliquez sur un champ, ou posez une question à l'IA." : "Ouvrez l'onglet Modèle pour charger un CSV, une base ou une requête SQL."))}</p>
      <div class="row">${R().tables.length ? `<button class="btn primary sm" data-act="auto-dash">${ic("sparkles")}${esc(tt("Générer un tableau de bord"))}</button><button class="btn outline sm" data-act="add-card">${ic("plus")}${esc(tt("Ajouter un visuel"))}</button>` : `<button class="btn primary sm" data-act="go-model">${ic("database")}${esc(tt("Ajouter des données"))}</button>`}</div>
    </div>`}</div>`;
  $("selection-chip").hidden = !sel;
  if (sel) $("selection-chip").innerHTML = `${ic("filter")}<span>${esc(sel.col)} = <b>${esc(sel.label || sel.key)}</b></span><button data-act="clear-sel" title="${esc(tt("Effacer le filtre croisé"))}">×</button>`;
  const surface = $("surface");
  for (const v of page.visuals) {
    const el = document.createElement("div");
    el.className = `vis vis-${v.type}${v.id === state.selId ? " is-sel" : ""}`;
    el.dataset.id = v.id;
    el.style.cssText = V.visualStyle(v);
    place(el, v, cw);
    const showTitle = v.opts?.showTitle !== false && v.type !== "text";
    el.innerHTML = `<div class="vis-head">${showTitle ? `<span class="vis-title">${esc(v.title || defaultTitle(v))}</span>` : `<span class="vis-title"></span>`}
      <span class="vis-tools"><button data-vact="todoc" title="${esc(tt("Insérer dans un document ou une présentation"))}">${ic("presentation")}</button><button data-vact="focus" title="${esc(tt("Agrandir"))}">${ic("maximize")}</button><button data-vact="dup" title="${esc(tt("Dupliquer"))}">${ic("copy")}</button><button data-vact="del" title="${esc(tt("Supprimer"))}">${ic("trash-2")}</button></span></div>
      <div class="vis-body"></div><i class="vis-resize"></i>`;
    surface.appendChild(el);
    paintVisual(el, v, page);
  }
}
function place(el, v, cw = colW()) {
  el.style.left = `${16 + v.x * cw}px`;
  el.style.top = `${8 + v.y * ROW}px`;
  el.style.width = `${v.w * cw - 10}px`;
  el.style.height = `${v.h * ROW - 10}px`;
}
function paintVisual(el, v, page = curPage()) {
  const body = el.querySelector(".vis-body");
  const { T, P } = dataFor(v, page);
  const err = state.errors.get(v.table);
  if (err) { body.innerHTML = `<div class="v-empty err">${esc(err)}</div>`; return; }
  const res = V.renderVisual(body, v, {
    T, P, theme: V.reportTheme(R()), selection: state.selection && state.selection.page === page.id ? state.selection : null,
    slicerState: page.slicers?.[v.id],
    onSelect: (key, col, bucket) => {
      const s = state.selection;
      if (s && s.visualId === v.id && s.key === key) state.selection = null;
      else {
        const label = Mo.bucketOf(key, "").label;
        state.selection = { page: page.id, visualId: v.id, col, key, bucket, label: bucket ? labelForKey(T, col, key, bucket) : label };
      }
      renderCanvas();
    },
    onSlicer: (f) => { if (f) page.slicers[v.id] = f; else delete page.slicers[v.id]; touch(); repaintExcept(v.id); },
    onSort: (i) => { v.opts.sortDir = v.opts.sortCol === i && v.opts.sortDir !== "desc" ? "desc" : "asc"; v.opts.sortCol = i; touch(); paintVisual(el, v, page); },
  });
  if (res) state.lastRes.set(v.id, res);
}
function labelForKey(T, col, key, bucket) {
  const i = T?.columns.indexOf(col);
  if (i == null || i < 0) return key;
  for (const r of T.rows) { const b = Mo.bucketOf(r[i], bucket); if (b.key === key) return b.label; }
  return key;
}
function repaintExcept(id) {
  const page = curPage();
  for (const v of page.visuals) {
    if (v.id === id) continue;
    const el = document.querySelector(`.vis[data-id="${v.id}"]`);
    if (el) paintVisual(el, v, page);
  }
}
function repaintVisual(v) {
  const el = document.querySelector(`.vis[data-id="${v.id}"]`);
  if (!el) return renderCanvas();
  el.className = `vis vis-${v.type}${v.id === state.selId ? " is-sel" : ""}`;
  el.style.cssText = V.visualStyle(v);
  const title = el.querySelector(".vis-title");
  if (title) title.textContent = v.opts?.showTitle !== false && v.type !== "text" ? v.title || defaultTitle(v) : "";
  place(el, v);
  paintVisual(el, v);
}
function defaultTitle(v) {
  const m = v.values?.[0];
  const base = V.measureLabel(m && (m.col || m.agg === "count") ? m : null);
  if (v.type === "slicer") return v.slicer?.col || tt("Segment");
  if (v.type === "table") return tableName(v.table);
  if (v.type === "matrix") return tt("Matrice");
  if (v.type === "ai") return tt("Analyse IA");
  return v.axis?.col ? `${base} ${tt("par")} ${v.axis.col}` : base;
}

/** Titre modifiable directement sur le canevas (double-clic). */
function editTitleInline(ttl) {
  const v = curPage().visuals.find((x) => x.id === ttl.closest(".vis")?.dataset.id);
  if (!v || ttl.querySelector("input")) return;
  const inp = document.createElement("input");
  inp.className = "vis-title-edit";
  inp.value = v.title || defaultTitle(v);
  ttl.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save) { v.title = inp.value.trim() === defaultTitle(v) ? "" : inp.value.trim(); if (v.opts) v.opts.showTitle = true; touch(); }
    const span = document.createElement("span");
    span.className = "vis-title";
    span.textContent = v.title || defaultTitle(v);
    inp.replaceWith(span);
    if (state.pane === "format" && state.selId === v.id) renderPanes();
  };
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  inp.addEventListener("blur", () => finish(true));
}

function wireCanvas() {
  const host = $("canvas");
  let d = null;
  let lastTitleDown = { id: "", t: 0 };
  host.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".vis");
    if (!el) {
      if (e.target.closest(".surface") && !e.target.closest(".canvas-empty")) { state.selId = ""; document.querySelectorAll(".vis.is-sel").forEach((n) => n.classList.remove("is-sel")); renderPanes(); }
      return;
    }
    const v = curPage().visuals.find((x) => x.id === el.dataset.id);
    if (!v) return;
    if (state.selId !== v.id) {
      state.selId = v.id;
      document.querySelectorAll(".vis.is-sel").forEach((n) => n.classList.remove("is-sel"));
      el.classList.add("is-sel");
      renderPanes();
    }
    // Double-clic sur le titre : renommer sur place (avant la capture du
    // pointeur, qui détournerait le dblclick vers le canevas).
    // (pointerdown n'a pas de `detail` : on mesure l'écart entre deux appuis.)
    const onTitle = e.target.closest(".vis-title");
    const now = performance.now();
    if (onTitle && lastTitleDown.id === v.id && now - lastTitleDown.t < 450) { lastTitleDown = { id: "", t: 0 }; e.preventDefault(); editTitleInline(onTitle); return; }
    lastTitleDown = onTitle ? { id: v.id, t: now } : { id: "", t: 0 };
    if (e.target.closest(".vis-title-edit")) return;
    const resize = e.target.classList.contains("vis-resize");
    const head = e.target.closest(".vis-head") && !e.target.closest(".vis-tools, .vis-title-edit");
    if (!resize && !head) return;
    e.preventDefault();
    d = { v, el, resize, x0: e.clientX, y0: e.clientY, snap: { x: v.x, y: v.y, w: v.w, h: v.h }, moved: false };
    host.setPointerCapture(e.pointerId);
  });
  host.addEventListener("pointermove", (e) => {
    if (!d) return;
    const dx = Math.round((e.clientX - d.x0) / colW()), dy = Math.round((e.clientY - d.y0) / ROW);
    const v = d.v, s = d.snap;
    if (d.resize) { v.w = clamp(s.w + dx, 2, COLS - v.x); v.h = clamp(s.h + dy, 2, 40); }
    else { v.x = clamp(s.x + dx, 0, COLS - v.w); v.y = Math.max(0, s.y + dy); }
    if (v.x !== s.x || v.y !== s.y || v.w !== s.w || v.h !== s.h) d.moved = true;
    place(d.el, v);
    if (d.resize) { const c = d.el.querySelector(".vis-body"); c && V.resizeVisuals(); }
  });
  const up = () => {
    if (!d) return;
    const { moved, resize, v } = d;
    d = null;
    if (moved) { touch(); if (resize) repaintVisual(v); const sf = $("surface"); if (sf) sf.style.height = `${(Math.max(10, ...curPage().visuals.map((x) => x.y + x.h)) + 4) * ROW}px`; }
  };
  host.addEventListener("pointerup", up);
  host.addEventListener("pointercancel", up);
  host.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-vact]");
    if (t) {
      const v = curPage().visuals.find((x) => x.id === t.closest(".vis").dataset.id);
      if (t.dataset.vact === "del") removeVisual(v.id);
      else if (t.dataset.vact === "dup") { const c = { ...structuredClone(v), id: uid("v"), y: v.y + v.h }; curPage().visuals.push(c); state.selId = c.id; touch(); renderCanvas(); renderPanes(); }
      else if (t.dataset.vact === "focus") focusVisual(v);
      else if (t.dataset.vact === "todoc") insertIntoDoc([v]);
      return;
    }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "auto-dash") autoDashboard();
    else if (a.dataset.act === "add-card") addVisual("bar");
    else if (a.dataset.act === "go-model") setView("model");
  });
  host.addEventListener("dblclick", (e) => {
    const el = e.target.closest(".vis-text, .vis-ai");
    if (!el) return;
    state.pane = "format"; renderPanes();
    setTimeout(() => document.querySelector('#pane-body textarea[data-k="text"], #pane-body textarea[data-k="question"]')?.focus(), 30);
  });
  host.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/da-field")) e.preventDefault(); });
  host.addEventListener("drop", (e) => {
    const raw = e.dataTransfer.getData("text/da-field");
    if (!raw) return;
    e.preventDefault();
    const f = JSON.parse(raw);
    const el = e.target.closest(".vis");
    if (el) { state.selId = el.dataset.id; addFieldToVisual(f.table, f.col); }
    else { state.selId = ""; addFieldToVisual(f.table, f.col); }
  });
  $("selection-chip").addEventListener("click", (e) => { if (e.target.closest("[data-act=clear-sel]")) { state.selection = null; renderCanvas(); } });
  new ResizeObserver(() => { if (state.view === "report") { document.querySelectorAll(".vis").forEach((el) => { const v = curPage().visuals.find((x) => x.id === el.dataset.id); if (v) place(el, v); }); V.resizeVisuals(); } }).observe(host);
}

function focusVisual(v) {
  const ov = document.createElement("div");
  ov.className = "focus-ov";
  ov.innerHTML = `<div class="focus-card"><div class="focus-head"><b>${esc(v.title || defaultTitle(v))}</b><span class="spacer"></span><button class="btn ghost sm" data-close>${ic("x")}${esc(tt("Fermer"))}</button></div><div class="vis-body focus-body"></div></div>`;
  document.body.appendChild(ov);
  const fv = { ...v, id: `${v.id}-focus` };
  const { T, P } = dataFor(v);
  requestAnimationFrame(() => V.renderVisual(ov.querySelector(".focus-body"), fv, { T, P, theme: V.reportTheme(R()) }));
  const close = () => { V.disposeVisual(fv.id); ov.remove(); };
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-close]")) close(); });
  document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
}

// ===== Visuels : création et champs ===================================================
function freeSpot(w, h) {
  const vis = curPage().visuals;
  for (let y = 0; y < 200; y++) for (let x = 0; x + w <= COLS; x++) {
    if (!vis.some((v) => x < v.x + v.w && x + w > v.x && y < v.y + v.h && y + h > v.y)) return { x, y };
  }
  return { x: 0, y: Math.max(0, ...vis.map((v) => v.y + v.h)) };
}
const SIZE = { card: [3, 3], multicard: [6, 3], gauge: [4, 5], slicer: [3, 6], text: [6, 3], table: [6, 8], matrix: [8, 8], ai: [6, 6] };

function addVisual(type, patch = {}) {
  const [w, h] = SIZE[type] || [6, 7];
  const pos = patch.x != null ? {} : freeSpot(patch.w || w, patch.h || h);
  const v = { id: uid("v"), type, title: "", table: R().tables[0]?.id || "", axis: null, legend: null, values: [], columns: [], filters: [], opts: { compare: true }, w, h, ...pos, ...patch };
  if (type === "slicer") v.slicer ||= { col: "", mode: "" };
  if (type === "matrix") v.pivot ||= { rows: [], cols: [], values: [] };
  if (type === "text" && v.text == null) v.text = tt("## Titre\nVotre commentaire…");
  curPage().visuals.push(v);
  state.selId = v.id;
  state.pane = "build";
  touch(); renderCanvas(); renderPanes();
  return v;
}
function removeVisual(id) {
  const page = curPage();
  page.visuals = page.visuals.filter((v) => v.id !== id);
  delete page.slicers[id];
  if (state.selection?.visualId === id) state.selection = null;
  if (state.selId === id) state.selId = "";
  touch(); renderCanvas(); renderPanes();
}

/** Clic ou dépôt d'un champ : il va dans le puits le plus logique. */
function addFieldToVisual(tableId, col) {
  const T = state.tables.get(tableId);
  const type = T?.types[col] || "text";
  let v = selVisual();
  if (!v) {
    // Aucun visuel choisi : comme Power BI, on en crée un adapté au champ.
    v = addVisual(type === "number" ? "card" : type === "date" ? "line" : "bar", { table: tableId });
  }
  if (!v.table) v.table = tableId;
  if (v.table !== tableId) { toast(tt("Ce visuel lit la table « {t} ».", { t: tableName(v.table) })); return; }
  const def = V.visualDef(v.type);
  const num = type === "number";
  if (v.type === "slicer") v.slicer = { ...(v.slicer || {}), col };
  else if (v.type === "table") { if (num && (v.columns || []).length) v.values.push({ col, agg: "sum" }); else v.columns = [...new Set([...(v.columns || []), col])]; }
  else if (v.type === "matrix") {
    v.pivot ||= { rows: [], cols: [], values: [] };
    if (num) v.pivot.values.push({ field: col, agg: "sum" });
    else if (!v.pivot.rows.length) v.pivot.rows.push(col);
    else v.pivot.cols.push(col);
    if (type === "date") v.pivot.buckets = { ...(v.pivot.buckets || {}), [col]: "month" };
  } else if (num || !def.wells.includes("axis")) v.values.push({ col, agg: num ? "sum" : "count" });
  else if (!v.axis?.col) v.axis = { col, bucket: type === "date" ? "month" : "" };
  else if (def.wells.includes("legend") && !v.legend?.col) v.legend = { col, bucket: type === "date" ? "year" : "" };
  else v.axis = { col, bucket: type === "date" ? "month" : "" };
  touch(); repaintVisual(v); renderPanes();
}

// ===== Volets (Visualisations, Format, Filtres, Champs) ===============================
function fieldOptions(tableId, value, { empty = true, numericOnly = false } = {}) {
  const T = state.tables.get(tableId);
  const cols = T ? T.columns.filter((c) => !numericOnly || T.types[c] === "number") : [];
  return `${empty ? `<option value="">—</option>` : ""}${cols.map((c) => `<option value="${esc(c)}"${c === value ? " selected" : ""}>${esc(c)} · ${esc(typeLabel(T.types[c]))}</option>`).join("")}`;
}
const typeLabel = (t) => ({ number: "123", date: "date", category: "abc", text: "txt" }[t] || "txt");
const typeIcon = (t) => ({ number: "∑", date: "◷", category: "◇", text: "Aa" }[t] || "Aa");
const opts = (obj, val) => Object.entries(obj).map(([k, l]) => `<option value="${esc(k)}"${String(val) === k ? " selected" : ""}>${esc(tt(l))}</option>`).join("");

function renderPanes() {
  const pane = $("pane-body");
  if (!R() || state.view !== "report") return;
  document.querySelectorAll("[data-pane]").forEach((b) => b.classList.toggle("is-on", b.dataset.pane === state.pane));
  const v = selVisual();
  if (state.pane === "fields") pane.innerHTML = fieldsPane();
  else if (state.pane === "filters") pane.innerHTML = filtersPane(v);
  else if (state.pane === "format") pane.innerHTML = v ? formatPane(v) : reportFormatPane();
  else pane.innerHTML = buildPane(v);
}

function buildPane(v) {
  const gallery = `<div class="viz-gallery" lang="fr" style="--viz-fill:${V.reportTheme(R()).palette[0]}">${V.VISUALS.map((d) => `<button class="viz-btn${v?.type === d.id ? " is-on" : ""}" data-viz="${d.id}" title="${esc(tt(d.label))}"><span class="viz-ic">${V.vizIcon(d.id)}</span><small>${esc(tt(d.label))}</small></button>`).join("")}</div>`;
  if (!v) return `<div class="pane-sect"><div class="pane-title">${esc(tt("Ajouter un visuel"))}</div>${gallery}<p class="pane-hint">${esc(tt("Astuce : cliquez un champ dans « Champs » pour créer un visuel adapté."))}</p></div>`;
  const def = V.visualDef(v.type);
  let wells = `<label class="f"><span>${esc(tt("Table"))}</span><select class="select" data-w="table">${R().tables.map((t) => `<option value="${t.id}"${t.id === v.table ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>`;
  const T = state.tables.get(v.table);
  const bucketSel = (key, cur, col) => (T?.types[col] === "date" ? `<select class="select sm" data-w="${key}.bucket">${opts(V.DATE_BUCKETS, cur || "none")}</select>` : "");
  const drop = (key, label, inner) => `<div class="well" data-drop="${key}"><div class="well-title">${esc(tt(label))}</div>${inner}</div>`;
  if (def.wells.includes("axis")) wells += drop("axis", v.type === "scatter" ? "Détails (points)" : ["pie", "donut", "treemap", "funnel"].includes(v.type) ? "Catégorie" : "Axe", `<div class="row"><select class="select" data-w="axis.col">${fieldOptions(v.table, v.axis?.col)}</select>${bucketSel("axis", v.axis?.bucket, v.axis?.col)}</div>`);
  if (def.wells.includes("legend")) wells += drop("legend", "Légende (séries)", `<div class="row"><select class="select" data-w="legend.col">${fieldOptions(v.table, v.legend?.col)}</select>${bucketSel("legend", v.legend?.bucket, v.legend?.col)}</div>`);
  if (def.wells.includes("columns")) wells += drop("columns", "Colonnes", `${(v.columns || []).map((c, i) => `<div class="chip-row"><span class="chip-f">${esc(c)}</span><button class="x" data-rm="columns.${i}">×</button></div>`).join("")}<select class="select" data-add="columns"><option value="">+ ${esc(tt("Ajouter une colonne"))}</option>${fieldOptions(v.table, "", { empty: false })}</select>`);
  if (def.wells.includes("rows")) {
    const pv = v.pivot || {};
    const list = (k) => `${(pv[k] || []).map((c, i) => `<div class="chip-row"><span class="chip-f">${esc(c)}</span>${T?.types[c] === "date" ? `<select class="select sm" data-pbucket="${esc(c)}">${opts(V.DATE_BUCKETS, pv.buckets?.[c] || "none")}</select>` : ""}<button class="x" data-rm="pivot.${k}.${i}">×</button></div>`).join("")}<select class="select" data-add="pivot.${k}"><option value="">+ ${esc(tt("Ajouter"))}</option>${fieldOptions(v.table, "", { empty: false })}</select>`;
    wells += drop("rows", "Lignes", list("rows")) + drop("cols", "Colonnes", list("cols"));
    wells += drop("pvalues", "Valeurs", `${(pv.values || []).map((m, i) => `<div class="chip-row"><select class="select sm" data-pv="${i}.field">${fieldOptions(v.table, m.field, { empty: false })}</select><select class="select sm" data-pv="${i}.agg">${opts({ ...V.AGGS, count_distinct: "Nombre distinct" }, m.agg)}</select><button class="x" data-rm="pivot.values.${i}">×</button></div>`).join("")}<select class="select" data-add="pivot.values"><option value="">+ ${esc(tt("Ajouter une valeur"))}</option>${fieldOptions(v.table, "", { empty: false })}</select>`);
  }
  if (def.wells.includes("values")) {
    const label = v.type === "scatter" ? "Valeurs (X, Y, taille)" : v.type === "combo" ? "Valeurs (barres, courbe)" : "Valeurs";
    wells += drop("values", label, `${(v.values || []).map((m, i) => `<div class="chip-row"><select class="select sm" data-mv="${i}.col"><option value="">${esc(tt("(lignes)"))}</option>${fieldOptions(v.table, m.col, { empty: false })}</select><select class="select sm" data-mv="${i}.agg">${opts(V.AGGS, m.agg)}</select><button class="x" data-rm="values.${i}">×</button></div>`).join("")}<select class="select" data-add="values"><option value="">+ ${esc(tt("Ajouter une valeur"))}</option><option value="__count">${esc(tt("Nombre de lignes"))}</option>${fieldOptions(v.table, "", { empty: false })}</select>`);
  }
  if (def.wells.includes("field")) {
    const s = v.slicer || {};
    const ty = T?.types[s.col];
    wells += drop("field", "Champ", `<select class="select" data-w="slicer.col">${fieldOptions(v.table, s.col)}</select>
      <label class="f"><span>${esc(tt("Style"))}</span><select class="select" data-w="slicer.mode">${opts(ty === "date" ? { date: "Plage de dates", list: "Liste", dropdown: "Menu déroulant" } : ty === "number" ? { range: "Plage de valeurs", list: "Liste", dropdown: "Menu déroulant" } : { list: "Liste", dropdown: "Menu déroulant", tiles: "Vignettes" }, s.mode || (ty === "date" ? "date" : ty === "number" ? "range" : "list"))}</select></label>
      ${ty === "date" && s.mode && s.mode !== "date" ? `<label class="f"><span>${esc(tt("Regrouper par"))}</span><select class="select" data-w="slicer.bucket">${opts(V.DATE_BUCKETS, s.bucket || "none")}</select></label>` : ""}`);
  }
  if (!def.wells.length) wells = `<p class="pane-hint">${esc(tt(v.type === "text" ? "Écrivez le texte dans l'onglet Format (Markdown accepté)." : "Rédigez la question dans l'onglet Format, puis « Générer »."))}</p>`;
  return `<div class="pane-sect"><div class="pane-title">${esc(tt("Type de visuel"))}</div>${gallery}</div><div class="pane-sect">${wells}</div>`;
}

function formatPane(v) {
  const o = v.opts || {};
  const chk = (k, label, val) => `<label class="chk"><input type="checkbox" data-o="${k}"${val ? " checked" : ""}/> ${esc(tt(label))}</label>`;
  const inp = (k, label, val, type = "text", ph = "") => `<label class="f"><span>${esc(tt(label))}</span><input class="input" type="${type}" data-o="${k}" value="${esc(val ?? "")}" placeholder="${esc(ph)}"/></label>`;
  let html = `<div class="pane-sect"><label class="f"><span>${esc(tt("Titre"))}</span><input class="input" data-k="title" value="${esc(v.title || "")}" placeholder="${esc(defaultTitle(v))}"/></label>${chk("showTitle", "Afficher le titre", o.showTitle !== false)}</div>`;
  if (v.type === "text") html += `<div class="pane-sect"><label class="f"><span>${esc(tt("Texte (Markdown)"))}</span><textarea class="input" rows="10" data-k="text">${esc(v.text || "")}</textarea></label></div>`;
  if (v.type === "ai") html += `<div class="pane-sect"><label class="f"><span>${esc(tt("Question posée à l'IA"))}</span><textarea class="input" rows="3" data-k="question" placeholder="${esc(tt("Ex. : commente l'évolution des ventes et les régions en retrait"))}">${esc(v.question || "")}</textarea></label><button class="btn primary sm" data-act="ai-gen">${ic("sparkles")}${esc(tt("Générer l'analyse"))}</button><label class="f"><span>${esc(tt("Réponse (modifiable)"))}</span><textarea class="input" rows="8" data-k="answer">${esc(v.answer || "")}</textarea></label></div>`;
  if (!["text", "ai", "slicer", "matrix"].includes(v.type)) {
    html += `<div class="pane-sect"><div class="pane-title">${esc(tt("Nombres"))}</div><div class="grid2"><label class="f"><span>${esc(tt("Format"))}</span><select class="select" data-o="format">${opts(V.FORMATS, o.format || "auto")}</select></label>${inp("decimals", "Décimales", o.decimals, "number")}${inp("prefix", "Préfixe", o.prefix)}${inp("suffix", "Suffixe", o.suffix)}</div></div>`;
  }
  if (["card", "multicard"].includes(v.type)) html += `<div class="pane-sect">${chk("compare", "Comparer à la période précédente", o.compare !== false)}${chk("invert", "Une baisse est une bonne nouvelle", o.invert)}${inp("label", "Libellé", o.label, "text", "")}${v.type === "card" ? `<label class="f"><span>${esc(tt("Tendance (courbe)"))}</span><select class="select" data-w="axis.col">${fieldOptions(v.table, v.axis?.col)}</select></label>` : ""}</div>`;
  if (v.type === "gauge") html += `<div class="pane-sect">${inp("target", "Objectif (maximum)", o.target, "number")}</div>`;
  if (V.isChart(v.type) && v.type !== "gauge") {
    html += `<div class="pane-sect"><div class="pane-title">${esc(tt("Graphique"))}</div>${chk("labels", "Étiquettes de données", o.labels)}`;
    if (["line", "area"].includes(v.type)) html += chk("smooth", "Courbe lissée", o.smooth !== false) + (v.type === "area" ? chk("stacked", "Empiler les séries", o.stacked) : "");
    if (!["scatter", "waterfall"].includes(v.type)) html += `<div class="grid2"><label class="f"><span>${esc(tt("Tri"))}</span><select class="select" data-o="sort">${opts({ "": "Automatique", value: "Valeur décroissante", asc: "Valeur croissante", label: "Libellé / date" }, o.sort || "")}</select></label>${inp("limit", "Top N", o.limit, "number", "0 = tout")}</div>`;
    html += `</div>`;
  }
  if (v.type === "table") html += `<div class="pane-sect">${inp("limit", "Lignes affichées", o.limit, "number", "500")}</div>`;
  if (v.type === "matrix") {
    const pv = v.pivot || {};
    html += `<div class="pane-sect"><div class="pane-title">${esc(tt("Matrice"))}</div><label class="f"><span>${esc(tt("Afficher"))}</span><select class="select" data-p="showAs">${opts({ value: "Valeur", pct_total: "% du total", pct_row: "% de la ligne", pct_col: "% de la colonne" }, pv.showAs || "value")}</select></label>
      <label class="chk"><input type="checkbox" data-p="subtotals"${pv.subtotals !== false ? " checked" : ""}/> ${esc(tt("Sous-totaux"))}</label><label class="chk"><input type="checkbox" data-p="heatmap"${pv.heatmap ? " checked" : ""}/> ${esc(tt("Mise en forme conditionnelle"))}</label><label class="chk"><input type="checkbox" data-p="compare"${pv.compare ? " checked" : ""}/> ${esc(tt("Variation vs période précédente"))}</label>
      ${`<label class="f"><span>${esc(tt("Top N lignes"))}</span><input class="input" type="number" data-p="topN" value="${esc(pv.topN || 0)}"/></label>`}</div>`;
  }
  html += colorsSection(v);
  html += `<div class="pane-sect"><div class="grid2"><label class="f"><span>${esc(tt("Largeur (colonnes)"))}</span><input class="input" type="number" min="2" max="12" data-k="w" value="${v.w}"/></label><label class="f"><span>${esc(tt("Hauteur"))}</span><input class="input" type="number" min="2" max="40" data-k="h" value="${v.h}"/></label></div><button class="btn ghost sm destructive-text" data-act="del-visual">${ic("trash-2")}${esc(tt("Supprimer le visuel"))}</button></div>`;
  return html;
}

// Couleurs : rangée « pastille + libellé + réinitialiser ».
const SWATCHES = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#ffd60a", "#32d74b", "#0f9b8e", "#64d2ff", "#18181b", "#71717a", "#ffffff"];
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || "")) ? c : /^#[0-9a-f]{3}$/i.test(String(c || "")) ? `#${[...c.slice(1)].map((x) => x + x).join("")}` : "#888888");
function colorRow(attr, key, label, val, fallback) {
  return `<label class="color-row${val ? "" : " unset"}"><input type="color" class="color-in" ${attr}="${esc(key)}" value="${hex(val || fallback)}"/><span title="${esc(label)}">${esc(label)}</span>${val ? `<button class="x" data-clear="${attr}:${esc(key)}" title="${esc(tt("Couleur automatique"))}">×</button>` : ""}</label>`;
}
function colorsSection(v) {
  const o = v.opts || {};
  const t = V.reportTheme(R());
  let html = `<div class="pane-sect"><div class="pane-title">${esc(tt("Couleurs"))}</div>`;
  if (v.type !== "text" && v.type !== "ai" && v.type !== "slicer") {
    html += colorRow("data-o", "color", tt("Couleur principale"), o.color, t.palette[0]);
    html += `<div class="swatches">${SWATCHES.map((c) => `<button class="swatch${o.color === c ? " is-on" : ""}" data-swatch="${c}" style="background:${c}" title="${c}"></button>`).join("")}</div>`;
  }
  const targets = V.colorTargets(v, state.lastRes.get(v.id));
  if (targets.length) {
    const pal = o.color ? [o.color, ...t.palette.filter((c) => c !== o.color)] : t.palette;
    html += `<div class="pane-hint">${esc(tt("Par série ou par catégorie"))}</div>`;
    html += targets.map((name, i) => colorRow("data-oc", name, name, o.colors?.[name], v.type === "waterfall" ? ["#16a34a", "#dc2626"][i] : ["pie", "donut", "treemap", "funnel"].includes(v.type) || (state.lastRes.get(v.id)?.series?.length || 0) > 1 ? pal[i % pal.length] : pal[0])).join("");
  }
  html += `<div class="pane-hint">${esc(tt("Visuel"))}</div>`;
  html += colorRow("data-o", "bg", tt("Fond"), o.bg, "#ffffff");
  html += colorRow("data-o", "titleColor", tt("Titre"), o.titleColor, "#18181b");
  html += colorRow("data-o", "textColor", tt("Texte et axes"), o.textColor, "#3f3f46");
  return `${html}</div>`;
}

function reportFormatPane() {
  const r = R();
  const custom = r.palette === "custom" ? `<div class="pane-hint">${esc(tt("Couleurs de la palette"))}</div>${(r.customPalette || []).map((c, i) => `<label class="color-row"><input type="color" class="color-in" data-cp="${i}" value="${hex(c)}"/><span>${esc(tt("Couleur {n}", { n: i + 1 }))}</span></label>`).join("")}` : "";
  return `<div class="pane-sect"><div class="pane-title">${esc(tt("Rapport"))}</div><label class="f"><span>${esc(tt("Palette de couleurs"))}</span><select class="select" data-r="palette">${opts(V.PALETTE_LABELS, r.palette)}</select></label>
    <div class="swatches">${V.reportTheme(r).palette.slice(0, 10).map((c) => `<span class="swatch" style="background:${c}"></span>`).join("")}</div>${custom}
    <p class="pane-hint">${esc(tt("Sélectionnez un visuel pour régler son format et ses couleurs."))}</p></div>`;
}

function filterRows(list, scope, tableId) {
  const tables = tableId ? [srcOf(tableId)].filter(Boolean) : R().tables;
  return `${list.map((f, i) => {
    const tid = f.table || tableId || tables[0]?.id;
    const T = state.tables.get(tid);
    const ty = T?.types[f.col];
    const two = f.op === "between";
    const noval = ["empty", "filled"].includes(f.op);
    return `<div class="filter-card" data-scope="${scope}" data-i="${i}">
      ${tableId ? "" : `<select class="select sm" data-ff="table">${tables.map((t) => `<option value="${t.id}"${t.id === tid ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select>`}
      <select class="select sm" data-ff="col">${fieldOptions(tid, f.col)}</select>
      <select class="select sm" data-ff="op">${opts({ in: "est l'une des valeurs", notin: "n'est aucune de", eq: "est égal à", ne: "est différent de", contains: "contient", gt: "est supérieur à", lt: "est inférieur à", between: "est entre", empty: "est vide", filled: "n'est pas vide" }, f.op || "in")}</select>
      ${noval ? "" : f.op === "in" || f.op === "notin" ? `<input class="input sm" data-ff="values" value="${esc((f.values || []).join(", "))}" placeholder="${esc(tt("valeurs séparées par des virgules"))}"/>` : `<input class="input sm" data-ff="value" type="${ty === "date" ? "date" : "text"}" value="${esc(f.value ?? "")}"/>${two ? `<input class="input sm" data-ff="value2" type="${ty === "date" ? "date" : "text"}" value="${esc(f.value2 ?? "")}"/>` : ""}`}
      <button class="x" data-frm title="${esc(tt("Retirer"))}">×</button></div>`;
  }).join("")}<button class="btn outline xs" data-fadd="${scope}">${ic("plus")}${esc(tt("Ajouter un filtre"))}</button>`;
}
function filtersPane(v) {
  const page = curPage();
  const slicers = page.visuals.filter((s) => s.type === "slicer" && page.slicers[s.id]);
  return `${v ? `<div class="pane-sect"><div class="pane-title">${esc(tt("Filtres de ce visuel"))}</div>${filterRows(v.filters || [], "visual", v.table)}</div>` : ""}
    <div class="pane-sect"><div class="pane-title">${esc(tt("Filtres de la page"))}</div>${filterRows(page.filters, "page")}</div>
    <div class="pane-sect"><div class="pane-title">${esc(tt("Filtres du rapport (toutes les pages)"))}</div>${filterRows(R().filters, "report")}</div>
    ${slicers.length ? `<div class="pane-sect"><div class="pane-title">${esc(tt("Segments actifs"))}</div>${slicers.map((s) => `<div class="chip-row"><span class="chip-f">${esc(page.slicers[s.id].col)}</span><button class="x" data-clear-slicer="${s.id}">×</button></div>`).join("")}</div>` : ""}
    <p class="pane-hint">${esc(tt("Segments et filtre croisé s'appliquent à toutes les tables qui ont une colonne du même nom."))}</p>`;
}
function fieldsPane() {
  if (!R().tables.length) return `<p class="pane-hint">${esc(tt("Aucune table : ajoutez des données dans l'onglet Modèle."))}</p><button class="btn primary sm" data-act="go-model">${ic("database")}${esc(tt("Ajouter des données"))}</button>`;
  return `<input class="input" id="field-q" placeholder="${esc(tt("Rechercher un champ"))}"/>` + R().tables.map((src) => {
    const T = state.tables.get(src.id);
    return `<details class="ftable" open><summary>${ic("table")}${esc(src.name)}<small>${T ? T.rows.length.toLocaleString("fr-FR") : "—"}</small></summary>${T ? T.columns.map((c) => `<div class="field" draggable="true" data-field="${esc(JSON.stringify({ table: src.id, col: c }))}" data-name="${esc(c.toLowerCase())}"><span class="ft ${T.types[c]}">${typeIcon(T.types[c])}</span>${esc(c)}</div>`).join("") : `<div class="pane-hint">${esc(state.errors.get(src.id) || tt("Non chargée"))}</div>`}</details>`;
  }).join("");
}

function setPath(o, path, val) {
  const ps = path.split(".");
  const last = ps.pop();
  const tgt = ps.reduce((a, p) => (a[p] ??= {}), o);
  tgt[last] = val;
}

function wirePanes() {
  document.querySelectorAll("[data-pane]").forEach((b) => b.addEventListener("click", () => { state.pane = b.dataset.pane; renderPanes(); }));
  const pane = $("pane-body");
  const vis = () => selVisual();
  pane.addEventListener("click", async (e) => {
    const vb = e.target.closest("[data-viz]");
    if (vb) {
      const v = vis();
      if (v) { v.type = vb.dataset.viz; if (v.type === "slicer") v.slicer ||= { col: v.axis?.col || "", mode: "" }; if (v.type === "matrix") v.pivot ||= { rows: v.axis?.col ? [v.axis.col] : [], cols: [], values: (v.values || []).filter((m) => m.col).map((m) => ({ field: m.col, agg: m.agg })) }; touch(); repaintVisual(v); renderPanes(); }
      else addVisual(vb.dataset.viz);
      return;
    }
    const rm = e.target.closest("[data-rm]");
    if (rm) { const v = vis(); const ps = rm.dataset.rm.split("."); const i = Number(ps.pop()); const arr = ps.reduce((a, p) => a[p], v); arr.splice(i, 1); touch(); repaintVisual(v); renderPanes(); return; }
    const clr = e.target.closest("[data-clear]");
    if (clr) {
      e.preventDefault();
      const v = vis(); if (!v) return;
      const [attr, ...rest] = clr.dataset.clear.split(":"); const key = rest.join(":");
      if (attr === "data-oc") { if (v.opts.colors) delete v.opts.colors[key]; } else delete v.opts[key];
      touch(); repaintVisual(v); renderPanes(); return;
    }
    const sw = e.target.closest("[data-swatch]");
    if (sw) { const v = vis(); if (!v) return; v.opts.color = sw.dataset.swatch; touch(); repaintVisual(v); renderPanes(); return; }
    const fadd = e.target.closest("[data-fadd]");
    if (fadd) { const list = filterList(fadd.dataset.fadd); list.push({ col: "", op: "in", values: [] }); touch(); renderPanes(); return; }
    const frm = e.target.closest("[data-frm]");
    if (frm) { const card = frm.closest(".filter-card"); filterList(card.dataset.scope).splice(Number(card.dataset.i), 1); touch(); renderPanes(); repaintAll(); return; }
    const cs = e.target.closest("[data-clear-slicer]");
    if (cs) { delete curPage().slicers[cs.dataset.clearSlicer]; touch(); renderCanvas(); renderPanes(); return; }
    const fld = e.target.closest("[data-field]");
    if (fld) { const f = JSON.parse(fld.dataset.field); addFieldToVisual(f.table, f.col); return; }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "del-visual") removeVisual(state.selId);
    else if (a.dataset.act === "ai-gen") await generateAiVisual(vis());
    else if (a.dataset.act === "go-model") setView("model");
  });
  pane.addEventListener("dragstart", (e) => { const f = e.target.closest("[data-field]"); if (f) e.dataTransfer.setData("text/da-field", f.dataset.field); });
  pane.addEventListener("dragover", (e) => { if (e.target.closest("[data-drop]") && e.dataTransfer.types.includes("text/da-field")) { e.preventDefault(); e.target.closest("[data-drop]").classList.add("over"); } });
  pane.addEventListener("dragleave", (e) => e.target.closest?.("[data-drop]")?.classList.remove("over"));
  pane.addEventListener("drop", (e) => {
    const well = e.target.closest("[data-drop]");
    const raw = e.dataTransfer.getData("text/da-field");
    if (!well || !raw) return;
    e.preventDefault();
    const f = JSON.parse(raw);
    const v = vis();
    if (!v) return;
    if (!v.table) v.table = f.table;
    if (v.table !== f.table) { toast(tt("Ce visuel lit la table « {t} ».", { t: tableName(v.table) })); return; }
    const T = state.tables.get(f.table);
    const isDate = T?.types[f.col] === "date";
    switch (well.dataset.drop) {
      case "axis": v.axis = { col: f.col, bucket: isDate ? "month" : "" }; break;
      case "legend": v.legend = { col: f.col, bucket: isDate ? "year" : "" }; break;
      case "values": v.values.push({ col: f.col, agg: T?.types[f.col] === "number" ? "sum" : "count" }); break;
      case "columns": v.columns = [...new Set([...(v.columns || []), f.col])]; break;
      case "rows": case "cols": v.pivot[well.dataset.drop].push(f.col); break;
      case "pvalues": v.pivot.values.push({ field: f.col, agg: T?.types[f.col] === "number" ? "sum" : "count" }); break;
      case "field": v.slicer = { ...(v.slicer || {}), col: f.col }; break;
      default: break;
    }
    touch(); repaintVisual(v); renderPanes();
  });
  const onEdit = (e, final) => {
    const t = e.target;
    const v = vis();
    if (t.id === "field-q") { const q = t.value.toLowerCase(); pane.querySelectorAll(".field").forEach((f) => { f.hidden = q && !f.dataset.name.includes(q); }); return; }
    if (t.dataset.r) {
      R()[t.dataset.r] = t.value;
      if (t.dataset.r === "palette" && t.value === "custom" && !R().customPalette?.length) R().customPalette = V.theme("lumen").palette.slice(0, 8);
      touch(); renderCanvas(); if (final) renderPanes(); return;
    }
    if (t.dataset.cp != null) { R().customPalette[Number(t.dataset.cp)] = t.value; touch(); if (final) { renderCanvas(); renderPanes(); } return; }
    if (t.dataset.ff) {
      const card = t.closest(".filter-card");
      const f = filterList(card.dataset.scope)[Number(card.dataset.i)];
      const k = t.dataset.ff;
      f[k] = k === "values" ? t.value.split(",").map((s) => s.trim()).filter(Boolean) : t.value;
      if (k === "table") f.col = "";
      touch();
      if (final) { renderPanes(); repaintAll(); }
      return;
    }
    if (!v) return;
    if (t.dataset.w) {
      const k = t.dataset.w;
      if (k === "table") { v.table = t.value; v.axis = null; v.legend = null; v.values = []; v.columns = []; if (v.pivot) v.pivot = { rows: [], cols: [], values: [] }; if (v.slicer) v.slicer = { col: "", mode: "" }; }
      else if (k.endsWith(".col") && !t.value) setPath(v, k.split(".")[0], null);
      else {
        if (k === "axis.col" || k === "legend.col") { const T = state.tables.get(v.table); const base = k.split(".")[0]; v[base] = { col: t.value, bucket: T?.types[t.value] === "date" ? (base === "axis" ? "month" : "year") : "" }; }
        else setPath(v, k, t.value === "none" ? "" : t.value);
      }
      if (k === "slicer.col" || k === "slicer.mode") delete curPage().slicers[v.id];
    } else if (t.dataset.mv) { const [i, k] = t.dataset.mv.split("."); v.values[Number(i)][k] = t.value; }
    else if (t.dataset.pv) { const [i, k] = t.dataset.pv.split("."); v.pivot.values[Number(i)][k] = t.value; }
    else if (t.dataset.pbucket) { v.pivot.buckets = { ...(v.pivot.buckets || {}), [t.dataset.pbucket]: t.value === "none" ? "" : t.value }; }
    else if (t.dataset.add) {
      if (!t.value) return;
      const T = state.tables.get(v.table);
      const k = t.dataset.add;
      if (k === "values") v.values.push(t.value === "__count" ? { col: "", agg: "count" } : { col: t.value, agg: T?.types[t.value] === "number" ? "sum" : "count" });
      else if (k === "columns") v.columns = [...new Set([...(v.columns || []), t.value])];
      else if (k === "pivot.values") v.pivot.values.push({ field: t.value, agg: T?.types[t.value] === "number" ? "sum" : "count" });
      else { const arr = k.split(".").reduce((a, p) => a[p], v); arr.push(t.value); if (T?.types[t.value] === "date") v.pivot.buckets = { ...(v.pivot.buckets || {}), [t.value]: "month" }; }
    } else if (t.dataset.o) { v.opts[t.dataset.o] = t.type === "checkbox" ? t.checked : t.type === "number" ? (t.value === "" ? "" : Number(t.value)) : t.value; }
    else if (t.dataset.oc != null) { v.opts.colors = { ...(v.opts.colors || {}), [t.dataset.oc]: t.value }; }
    else if (t.dataset.p) { v.pivot[t.dataset.p] = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value; }
    else if (t.dataset.k) { v[t.dataset.k] = ["w", "h"].includes(t.dataset.k) ? clamp(Number(t.value) || 2, 2, t.dataset.k === "w" ? COLS - v.x : 40) : t.value; }
    else return;
    touch();
    if (final || !["title", "text", "question", "answer", "prefix", "suffix", "label"].includes(t.dataset.k || t.dataset.o)) repaintVisual(v);
    else { const ttl = document.querySelector(`.vis[data-id="${v.id}"] .vis-title`); if (ttl && t.dataset.k === "title") ttl.textContent = v.title || defaultTitle(v); }
    if (final && (t.dataset.add || t.dataset.w || t.tagName === "SELECT" || t.type === "color")) renderPanes();
  };
  pane.addEventListener("input", (e) => { if (e.target.tagName !== "SELECT") onEdit(e, false); });
  pane.addEventListener("change", (e) => onEdit(e, true));
}
function filterList(scope) {
  if (scope === "visual") return selVisual().filters;
  if (scope === "page") return curPage().filters;
  return R().filters;
}
function repaintAll() { if (state.view === "report") renderCanvas(); }

// ===== Vue « Données » =================================================================
function renderDataView() {
  const host = $("view-data");
  if (!R().tables.length) { host.innerHTML = emptyBlock("table", "Aucune table", "Ajoutez des données dans l'onglet Modèle.", `<button class="btn primary sm" data-go="model">${ic("database")}${esc(tt("Ajouter des données"))}</button>`); return; }
  if (!srcOf(state.dataTable)) state.dataTable = R().tables[0].id;
  const T = state.tables.get(state.dataTable);
  const tabs = `<div class="dv-tabs">${R().tables.map((t) => `<button class="chip${t.id === state.dataTable ? " is-on" : ""}" data-dt="${t.id}">${esc(t.name)}</button>`).join("")}</div>`;
  if (!T) { host.innerHTML = tabs + emptyBlock("triangle-alert", "Table non chargée", state.errors.get(state.dataTable) || ""); return; }
  const p = Mo.profileTable(T);
  const dups = (() => { const s = new Set(); let d = 0; for (const r of T.rows) { const k = r.join("\u0001"); if (s.has(k)) d++; else s.add(k); } return d; })();
  const missing = p.columns.reduce((a, c) => a + c.missing, 0);
  const kpi = (label, val, i) => `<div class="kpi"><span class="kpi-ic">${ic(i)}</span><div><b>${esc(String(val))}</b><small>${esc(tt(label))}</small></div></div>`;
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : "—");
  const quality = [
    ...p.columns.filter((c) => c.missing_rate > 0.05).map((c) => `<li><b>${esc(c.name)}</b> — ${Math.round(c.missing_rate * 100)} % ${esc(tt("de valeurs manquantes"))}</li>`),
    ...(dups ? [`<li>${dups} ${esc(tt("ligne(s) en double"))}</li>`] : []),
    ...p.columns.filter((c) => c.type === "number" && c.stddev > 0 && (c.max - c.mean) / c.stddev > 4).map((c) => `<li><b>${esc(c.name)}</b> — ${esc(tt("valeurs extrêmes possibles (max très au-dessus de la moyenne)"))}</li>`),
  ];
  host.innerHTML = `${tabs}
    <div class="kpis">${kpi("lignes", T.rows.length.toLocaleString("fr-FR"), "list")}${kpi("colonnes", T.columns.length, "layout-grid")}${kpi("cellules manquantes", missing.toLocaleString("fr-FR"), "circle-help")}${kpi("doublons", dups, "copy")}</div>
    <div class="dv-grid">
      <section class="card dv-table"><div class="card-head"><h3>${esc(tt("Aperçu"))}</h3><small class="muted">${Math.min(200, T.rows.length)} / ${T.rows.length.toLocaleString("fr-FR")}</small><span class="spacer"></span><button class="btn outline xs" data-act="export-csv">${ic("download")}CSV</button></div>
        <div class="grid-wrap"><table class="v-table"><thead><tr>${T.columns.map((c) => `<th class="${T.types[c] === "number" ? "num" : ""}"><span class="ft ${T.types[c]}">${typeIcon(T.types[c])}</span>${esc(c)}</th>`).join("")}</tr></thead><tbody>${T.rows.slice(0, 200).map((r) => `<tr>${r.map((v, i) => `<td class="${T.types[T.columns[i]] === "number" ? "num" : ""}">${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h3>${esc(tt("Colonnes"))}</h3></div><div class="grid-wrap"><table class="v-table"><thead><tr><th>${esc(tt("Colonne"))}</th><th>${esc(tt("Type"))}</th><th class="num">${esc(tt("Manq."))}</th><th class="num">${esc(tt("Uniques"))}</th><th>${esc(tt("Statistiques"))}</th></tr></thead><tbody>${p.columns.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td><span class="ft ${c.type}">${typeIcon(c.type)}</span> ${esc(c.type)}</td><td class="num">${c.missing}</td><td class="num">${c.unique}</td><td class="muted">${c.type === "number" ? `min ${fmt(c.min)} · moy ${fmt(c.mean)} · max ${fmt(c.max)} · Σ ${fmt(c.sum)}` : c.type === "date" ? `${esc(c.min_date)} → ${esc(c.max_date)}` : esc(c.top.slice(0, 3).map((x) => `${x.value} (${x.count})`).join(", "))}</td></tr>`).join("")}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h3>${esc(tt("Qualité"))}</h3></div>${quality.length ? `<ul class="dv-list">${quality.join("")}</ul>` : `<p class="muted">${esc(tt("Rien à signaler."))}</p>`}
        <div class="card-head"><h3>${esc(tt("Corrélations"))}</h3></div>${p.correlations.length ? `<ul class="dv-list">${p.correlations.map((c) => `<li><b>${esc(c.x)}</b> ↔ <b>${esc(c.y)}</b> : ${c.corr.toFixed(2)} <span class="muted">(${c.n})</span></li>`).join("")}</ul>` : `<p class="muted">${esc(tt("Pas assez de colonnes numériques."))}</p>`}</section>
      <section class="card dv-ai"><div class="card-head"><h3>${ic("sparkles")}${esc(tt("Synthèse IA"))}</h3><span class="spacer"></span><button class="btn outline xs" data-act="ai-summary">${esc(tt("Générer"))}</button></div><div class="md" id="ai-summary">${R().summary ? renderMarkdown(R().summary) : `<p class="muted">${esc(tt("Résumé exécutif, signaux, risques qualité et pistes d'analyse."))}</p>`}</div>
        <div class="card-head"><h3>${esc(tt("Notes"))}</h3></div><textarea class="input" id="report-notes" rows="5" placeholder="${esc(tt("Vos notes d'analyse…"))}">${esc(R().notes || "")}</textarea></section>
    </div>`;
}
function emptyBlock(i, title, hint, action = "") {
  return `<div class="empty-block"><div class="ce-ic">${ic(i)}</div><h3>${esc(tt(title))}</h3><p>${esc(tt(hint))}</p>${action}</div>`;
}
function wireDataView() {
  const host = $("view-data");
  host.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-dt]");
    if (t) { state.dataTable = t.dataset.dt; renderDataView(); return; }
    const g = e.target.closest("[data-go]");
    if (g) { setView(g.dataset.go); return; }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "export-csv") {
      const T = state.tables.get(state.dataTable);
      if (!T) return;
      const path = `${REPORT_DIR}/exports/${slug(T.name)}-${today()}.csv`;
      const sb = state.file?.sandboxId || state.sandboxes[0]?.id;
      try { await invokeUnlocked(invoke, "sandbox_write_file", { id: sb, path, content: Mo.toCsv(T.columns, T.rows) }); toast(tt("Exporté : {p}", { p: path })); } catch (err) { toast(String(err?.message || err)); }
    } else if (a.dataset.act === "ai-summary") {
      const T = state.tables.get(state.dataTable);
      const box = $("ai-summary");
      box.innerHTML = `<p class="muted">${esc(tt("Analyse en cours…"))}</p>`;
      try {
        const { messages } = PROMPTS["app.dataanalysis.synthesis"].build({ profile: JSON.stringify(Mo.digest(T, 12)), lang: replyLang() });
        const { content } = await llmChat(messages, { rawSystem: true, onDelta: (txt) => { if (txt) box.innerHTML = renderMarkdown(txt); } });
        R().summary = content; touch();
        box.innerHTML = renderMarkdown(content);
      } catch (err) { box.innerHTML = `<p class="err">${esc(String(err?.message || err))}</p>`; }
    }
  });
  host.addEventListener("input", (e) => { if (e.target.id === "report-notes") { R().notes = e.target.value; touch(); } });
}

// ===== Vue « Modèle » ==================================================================
function renderModelView() {
  const host = $("view-model");
  const cards = R().tables.map((src) => {
    const T = state.tables.get(src.id);
    const err = state.errors.get(src.id);
    const desc = src.kind === "file" ? `${ic("file-text")} ${esc(state.sandboxes.find((s) => s.id === src.sandboxId)?.name || "")} / ${esc(src.path)}` : src.kind === "sql" ? `${ic("database")} SQL · ${esc(src.baseName || src.baseId)}` : `${ic("plug")} ${esc(src.item?.label || "")}`;
    const dateCols = T ? T.columns.filter((c) => T.types[c] === "date") : [];
    return `<section class="card model-card" data-src="${src.id}">
      <div class="card-head"><span class="mc-ic">${ic(src.kind === "sql" ? "database" : src.kind === "file" ? "file-text" : "plug")}</span><input class="title-input" data-mf="name" value="${esc(src.name)}"/><span class="spacer"></span>
        <button class="btn ghost icon sm" data-mact="refresh" title="${esc(tt("Actualiser"))}">${ic("refresh-cw")}</button>${src.kind === "sql" ? `<button class="btn ghost icon sm" data-mact="edit" title="${esc(tt("Modifier la requête"))}">${ic("pencil")}</button>` : ""}<button class="btn ghost icon sm" data-mact="del" title="${esc(tt("Retirer du modèle"))}">${ic("trash-2")}</button></div>
      <div class="mc-desc">${desc}</div>
      ${err ? `<div class="mc-err">${ic("triangle-alert")}${esc(err)}</div>` : T ? `<div class="mc-stats"><span><b>${T.rows.length.toLocaleString("fr-FR")}</b> ${esc(tt("lignes"))}</span><span><b>${T.columns.length}</b> ${esc(tt("colonnes"))}</span></div><div class="mc-cols">${T.columns.slice(0, 18).map((c) => `<span class="mc-col"><span class="ft ${T.types[c]}">${typeIcon(T.types[c])}</span>${esc(c)}</span>`).join("")}${T.columns.length > 18 ? `<span class="muted">+${T.columns.length - 18}</span>` : ""}</div>` : `<div class="muted">${esc(tt("Non chargée"))}</div>`}
      ${src.kind !== "sql" && dateCols.length ? `<label class="f inline"><span>${esc(tt("Colonne de date (période)"))}</span><select class="select sm" data-mf="dateColumn"><option value="">—</option>${dateCols.map((c) => `<option${c === src.dateColumn ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>` : src.kind === "sql" ? `<p class="pane-hint">${esc(tt("La période du rapport remplace :debut et :fin dans la requête."))}</p>` : ""}
    </section>`;
  }).join("");
  host.innerHTML = `<div class="model-head"><div><h2>${esc(tt("Modèle de données"))}</h2><p class="muted">${esc(tt("Les tables que lisent les visuels du rapport."))}</p></div><span class="spacer"></span>
      <div class="menu-wrap"><button class="btn primary sm" data-madd>${ic("plus")}${esc(tt("Obtenir des données"))}</button>
      <div class="menu" id="add-menu" hidden>
        <button class="menu-item" data-src-add="file">${ic("file-text")}${esc(tt("Fichier CSV d'une sandbox"))}</button>
        <button class="menu-item" data-src-add="upload">${ic("upload")}${esc(tt("Importer un CSV depuis l'ordinateur"))}</button>
        <button class="menu-item" data-src-add="dataset">${ic("database")}${esc(tt("Base locale ou connexion"))}</button>
        <button class="menu-item" data-src-add="sql">${ic("code")}${esc(tt("Requête SQL (paramétrée)"))}</button>
        <button class="menu-item" data-src-add="ask">${ic("sparkles")}${esc(tt("Depuis une question (IA → SQL)"))}</button>
        <div class="menu-sep"></div>
        <button class="menu-item" data-src-add="legacy">${ic("history")}${esc(tt("Importer un ancien rapport ou tableau de bord"))}</button>
      </div></div><input type="file" id="csv-upload" accept=".csv,.tsv,text/csv" hidden /></div>
    <div class="model-grid">${cards || emptyBlock("database", "Aucune donnée", "Ajoutez un CSV, une table de vos Bases, une connexion ou une requête SQL.")}</div>`;
}
function wireModelView() {
  const host = $("view-model");
  host.addEventListener("click", async (e) => {
    if (e.target.closest("[data-madd]")) { e.stopPropagation(); $("add-menu").hidden = !$("add-menu").hidden; return; }
    const add = e.target.closest("[data-src-add]");
    if (add) { $("add-menu").hidden = true; await addSource(add.dataset.srcAdd); return; }
    const m = e.target.closest("[data-mact]");
    if (!m) return;
    const id = m.closest("[data-src]").dataset.src;
    const src = srcOf(id);
    if (m.dataset.mact === "refresh") { await refreshData({ only: id }); renderModelView(); }
    else if (m.dataset.mact === "del") {
      if (!(await confirmSheet({ title: tt("Retirer « {n} » du modèle ?", { n: src.name }), body: tt("Les visuels qui la lisent n'auront plus de données."), confirm: tt("Retirer"), cancel: tt("Annuler"), danger: true }))) return;
      R().tables = R().tables.filter((t) => t.id !== id);
      state.tables.delete(id); state.errors.delete(id);
      touch(); renderModelView();
    } else if (m.dataset.mact === "edit") await sqlDialog(src);
  });
  host.addEventListener("change", async (e) => {
    const f = e.target.dataset.mf;
    if (!f) return;
    const src = srcOf(e.target.closest("[data-src]").dataset.src);
    src[f] = e.target.value;
    touch();
  });
  host.addEventListener("change", async (e) => {
    if (e.target.id !== "csv-upload") return;
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!(await unlock(tt("Importer un CSV")))) return;
    const list = await sandboxes();
    const sb = list.find((s) => s.id === state.file?.sandboxId) || list[0];
    if (!sb) { toast(tt("Créez d'abord une sandbox dans Fichiers.")); return; }
    const path = `${REPORT_DIR}/données/${file.name.replace(/[\\/:*?"<>|]+/g, "_")}`;
    await invoke("sandbox_write_file", { id: sb.id, path, content: await file.text() });
    pushSource({ id: uid("t"), name: file.name.replace(/\.[^.]+$/, ""), kind: "file", sandboxId: sb.id, path });
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) document.querySelectorAll(".menu").forEach((m) => { m.hidden = true; }); });
}
async function pushSource(src) {
  R().tables.push(src);
  if (!state.dataTable) state.dataTable = src.id;
  touch();
  await refreshData({ only: src.id });
  for (const p of R().pages) for (const v of p.visuals) if (!v.table) v.table = src.id;
  renderModelView();
  toast(tt("« {n} » ajoutée au modèle.", { n: src.name }));
}

/** Petit sélecteur en feuille (liste filtrable). Résout avec l'élément choisi. */
function pick(title, items, { label = (x) => x.label, sub = () => "" } = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "modal";
    ov.innerHTML = `<div class="modal-card"><h3>${esc(title)}</h3><input class="input" placeholder="${esc(tt("Rechercher"))}"/><div class="pick-list">${items.map((x, i) => `<button class="menu-item" data-i="${i}"><span>${esc(label(x))}</span><small>${esc(sub(x))}</small></button>`).join("") || `<p class="muted">${esc(tt("Rien à proposer."))}</p>`}</div><div class="modal-actions"><span class="grow"></span><button class="btn outline" data-x>${esc(tt("Annuler"))}</button></div></div>`;
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    ov.querySelector("input").addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); ov.querySelectorAll("[data-i]").forEach((b) => { b.hidden = q && !b.textContent.toLowerCase().includes(q); }); });
    ov.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) done(items[Number(b.dataset.i)]); else if (e.target.closest("[data-x]") || e.target === ov) done(null); });
    setTimeout(() => ov.querySelector("input").focus(), 20);
  });
}

async function addSource(kind) {
  if (kind !== "upload" && !(await unlock(tt("Accéder aux données")))) return;
  if (kind === "upload") { $("csv-upload").click(); return; }
  if (kind === "file") {
    toast(tt("Recherche des fichiers CSV…"));
    const found = [];
    const walk = async (sb, path, depth) => {
      let entries = [];
      try { entries = (await invoke("sandbox_read_dir", { id: sb.id, path })) || []; } catch { return; }
      for (const e of entries) {
        const p = path ? `${path}/${e.name}` : e.name;
        if (e.is_dir) { if (depth < 5 && !e.name.startsWith(".")) await walk(sb, p, depth + 1); }
        else if (/\.(csv|tsv)$/i.test(e.name)) found.push({ sb, path: p });
      }
    };
    for (const sb of await sandboxes()) await walk(sb, "", 0);
    const f = await pick(tt("Choisir un fichier CSV"), found, { label: (x) => x.path.split("/").pop(), sub: (x) => `${x.sb.name} / ${x.path}` });
    if (f) pushSource({ id: uid("t"), name: f.path.split("/").pop().replace(/\.[^.]+$/, ""), kind: "file", sandboxId: f.sb.id, path: f.path });
  } else if (kind === "dataset") {
    const list = await listDatasets().catch(() => []);
    const d = await pick(tt("Choisir une table ou une connexion"), list);
    if (d) pushSource({ id: uid("t"), name: d.name, kind: "dataset", item: d });
  } else if (kind === "sql" || kind === "ask") {
    await sqlDialog(null, kind === "ask");
  } else if (kind === "legacy") {
    const list = (await listAllReports()).filter((x) => x.kind !== "report");
    const r = await pick(tt("Importer un ancien rapport"), list, { label: (x) => x.name, sub: (x) => `${x.kind === "legacy" ? "Reporting" : tt("Tableau de bord")} · ${x.sandbox}` });
    if (r) openReportFile(r);
  }
}

async function sqlDialog(src, askMode = false) {
  const bases = await db.listQueryableBases().catch(() => []);
  if (!bases.length) { toast(tt("Aucune base : créez-en une dans « Bases de données ».")); return; }
  const ov = document.createElement("div");
  ov.className = "modal";
  const cur = src || { id: uid("t"), name: "", kind: "sql", baseId: bases[0].base_id, sql: "SELECT *\nFROM \"table\"\nWHERE \"Date\" BETWEEN :debut AND :fin" };
  ov.innerHTML = `<div class="modal-card wide"><h3>${esc(tt(src ? "Modifier la requête" : "Requête SQL"))}</h3>
    <div class="grid2"><label class="f"><span>${esc(tt("Nom de la table"))}</span><input class="input" data-q="name" value="${esc(cur.name)}" placeholder="${esc(tt("Ex. : Ventes par mois"))}"/></label>
    <label class="f"><span>${esc(tt("Base"))}</span><select class="select" data-q="base">${bases.map((b) => `<option value="${esc(b.base_id)}"${b.base_id === cur.baseId ? " selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label></div>
    <div class="ask-row"><input class="input" data-q="question" placeholder="${esc(tt("Décrivez les données voulues, l'IA écrit le SQL…"))}"/><button class="btn outline sm" data-q-ask>${ic("sparkles")}${esc(tt("Écrire le SQL"))}</button></div>
    <label class="f"><span>${esc(tt("SQL (lecture seule) — :debut et :fin = période du rapport"))}</span><textarea class="input mono" rows="7" data-q="sql" spellcheck="false">${esc(cur.sql)}</textarea></label>
    <div class="row"><button class="btn outline sm" data-q-run>${ic("play")}${esc(tt("Tester"))}</button><span class="muted small" data-q-status></span></div>
    <div class="grid-wrap small-grid" data-q-preview></div>
    <div class="modal-actions"><span class="grow"></span><button class="btn outline" data-x>${esc(tt("Annuler"))}</button><button class="btn primary" data-ok>${esc(tt("Enregistrer"))}</button></div></div>`;
  document.body.appendChild(ov);
  const q = (k) => ov.querySelector(`[data-q="${k}"]`);
  const status = ov.querySelector("[data-q-status]");
  const preview = (res) => { ov.querySelector("[data-q-preview]").innerHTML = `<table class="v-table"><thead><tr>${(res.columns || []).map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${(res.rows || []).slice(0, 20).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`; };
  const period = R().period?.enabled ? R().period : periodPreset("year");
  ov.querySelector("[data-q-run]").onclick = async () => {
    status.textContent = tt("Exécution…");
    try { const res = await Mo.loadSource({ kind: "sql", baseId: q("base").value, sql: q("sql").value }, { invoke, period }); preview(res); status.textContent = tt("{n} ligne(s)", { n: res.rows.length }); } catch (e) { status.textContent = String(e?.message || e); }
  };
  ov.querySelector("[data-q-ask]").onclick = async () => {
    const question = q("question").value.trim();
    if (!question) return;
    status.textContent = tt("L'IA écrit la requête…");
    try { const res = await db.askAi(q("base").value, question); q("sql").value = res.sql; preview(res); status.textContent = tt("{n} ligne(s)", { n: res.rows.length }); if (!q("name").value) q("name").value = question.slice(0, 50); } catch (e) { status.textContent = String(e?.message || e); }
  };
  if (askMode) setTimeout(() => q("question").focus(), 20);
  await new Promise((resolve) => {
    ov.addEventListener("click", async (e) => {
      if (e.target.closest("[data-x]") || e.target === ov) { ov.remove(); resolve(); return; }
      if (!e.target.closest("[data-ok]")) return;
      const base = bases.find((b) => b.base_id === q("base").value);
      const next = { ...cur, name: q("name").value.trim() || tt("Requête"), baseId: q("base").value, baseName: base?.name || "", sql: q("sql").value };
      ov.remove();
      if (src) { Object.assign(src, next); touch(); await refreshData({ only: src.id }); renderModelView(); }
      else await pushSource(next);
      resolve();
    });
  });
}

// ===== Vue « Envois » (abonnements) =========================================================
async function loadSubs() {
  try { state.subs = (await invoke("report_subs_list")) || []; } catch { state.subs = []; }
}
async function renderSubsView() {
  const host = $("view-subs");
  await loadSubs();
  let account = null;
  try { account = await invoke("mail_account_get"); } catch {}
  const mailOk = !!(account && account.email && account.smtp_host);
  const mine = state.subs.filter((s) => state.file && s.report?.path === state.file.path && s.report?.sandboxId === state.file.sandboxId);
  const others = state.subs.filter((s) => !mine.includes(s));
  const when = (s) => ({ daily: tt("Chaque jour"), weekdays: tt("En semaine"), weekly: `${tt("Chaque")} ${["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"][s.weekday] || ""}`, monthly: `${tt("Le")} ${s.monthday} ${tt("du mois")}` }[s.freq] || s.freq) + ` · ${s.time}`;
  const row = (s) => `<div class="sub-row" data-sub="${esc(s.id)}"><div class="sub-main"><b>${esc(s.name)}</b><small>${esc(when(s))} · ${esc(s.to)} · ${esc(String(s.format).toUpperCase())}</small><small class="muted">${s.nextDue ? `${esc(tt("Prochain envoi"))} : ${new Date(s.nextDue * 1000).toLocaleString("fr-FR")}` : esc(tt("Désactivé"))}${s.lastRun ? ` · ${esc(tt("Dernier"))} : ${new Date(s.lastRun * 1000).toLocaleString("fr-FR")}` : ""}${s.lastStatus ? ` · ${esc(s.lastStatus)}` : ""}${s.pending ? ` · <span class="err">${esc(tt("en attente"))}</span>` : ""}</small></div>
    <label class="switch"><input type="checkbox" data-sub-toggle${s.enabled ? " checked" : ""}/><span></span></label><button class="btn ghost icon sm" data-sub-edit title="${esc(tt("Modifier"))}">${ic("pencil")}</button><button class="btn ghost icon sm" data-sub-send title="${esc(tt("Envoyer maintenant"))}">${ic("send")}</button><button class="btn ghost icon sm" data-sub-del title="${esc(tt("Supprimer"))}">${ic("trash-2")}</button></div>`;
  host.innerHTML = `<div class="model-head"><div><h2>${esc(tt("Envois par email"))}</h2><p class="muted">${esc(tt("Envoyez ce rapport maintenant, ou abonnez des destinataires : Lumen le recalcule et l'envoie automatiquement."))}</p></div><span class="spacer"></span>
      <button class="btn outline sm" data-send-now>${ic("send")}${esc(tt("Envoyer maintenant"))}</button><button class="btn primary sm" data-sub-new>${ic("plus")}${esc(tt("Nouvel abonnement"))}</button></div>
    ${mailOk ? "" : `<div class="banner warn">${ic("triangle-alert")}<span>${esc(tt("Aucun compte d'envoi : configurez votre adresse (SMTP) dans l'app Email."))}</span><button class="btn outline xs" data-open-mail>${esc(tt("Ouvrir Email"))}</button></div>`}
    ${!state.file ? `<div class="banner">${ic("info")}<span>${esc(tt("Enregistrez d'abord le rapport pour pouvoir l'abonner."))}</span><button class="btn outline xs" data-save>${esc(tt("Enregistrer"))}</button></div>` : ""}
    <section class="card"><div class="card-head"><h3>${esc(tt("Abonnements de ce rapport"))}</h3></div>${mine.length ? mine.map(row).join("") : `<p class="muted">${esc(tt("Aucun abonnement pour ce rapport."))}</p>`}</section>
    ${others.length ? `<section class="card"><div class="card-head"><h3>${esc(tt("Autres rapports"))}</h3></div>${others.map(row).join("")}</section>` : ""}
    <p class="pane-hint">${esc(tt("Les envois partent tant que Lumen tourne (mode Bureau) et que la session est déverrouillée ; un envoi manqué est rattrapé à la prochaine ouverture de l'app."))}</p>`;
}
function subDialog(sub = null) {
  const s = sub || { id: uid("s"), name: R().name, report: { ...state.file }, to: "", cc: "", subject: `${tt("Rapport")} — ${R().name}`, freq: "weekly", time: "08:00", weekday: 1, monthday: 1, format: "pdf", message: "", enabled: true };
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "modal";
    ov.innerHTML = `<form class="modal-card wide"><h3>${esc(tt(sub ? "Modifier l'abonnement" : "Nouvel abonnement"))}</h3>
      <div class="grid2"><label class="f"><span>${esc(tt("Nom"))}</span><input class="input" name="name" value="${esc(s.name)}"/></label><label class="f"><span>${esc(tt("Format"))}</span><select class="select" name="format"><option value="pdf"${s.format === "pdf" ? " selected" : ""}>PDF</option><option value="html"${s.format === "html" ? " selected" : ""}>HTML</option></select></label>
      <label class="f"><span>${esc(tt("Destinataires"))}</span><input class="input" name="to" value="${esc(s.to)}" placeholder="a@exemple.fr, b@exemple.fr" required/></label><label class="f"><span>${esc(tt("Copie"))}</span><input class="input" name="cc" value="${esc(s.cc)}"/></label></div>
      <label class="f"><span>${esc(tt("Objet"))}</span><input class="input" name="subject" value="${esc(s.subject)}"/></label>
      <div class="grid2"><label class="f"><span>${esc(tt("Fréquence"))}</span><select class="select" name="freq">${opts({ daily: "Chaque jour", weekdays: "Du lundi au vendredi", weekly: "Chaque semaine", monthly: "Chaque mois" }, s.freq)}</select></label><label class="f"><span>${esc(tt("Heure"))}</span><input class="input" type="time" name="time" value="${esc(s.time)}"/></label>
      <label class="f"><span>${esc(tt("Jour (hebdomadaire)"))}</span><select class="select" name="weekday">${["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"].map((d, i) => `<option value="${i}"${Number(s.weekday) === i ? " selected" : ""}>${esc(tt(d))}</option>`).join("")}</select></label><label class="f"><span>${esc(tt("Jour du mois (mensuel)"))}</span><input class="input" type="number" min="1" max="28" name="monthday" value="${esc(s.monthday)}"/></label></div>
      <label class="f"><span>${esc(tt("Message"))}</span><textarea class="input" rows="3" name="message">${esc(s.message || "")}</textarea></label>
      <div class="modal-actions"><span class="grow"></span><button type="button" class="btn outline" data-x>${esc(tt("Annuler"))}</button><button type="submit" class="btn primary">${esc(tt("Enregistrer"))}</button></div></form>`;
    document.body.appendChild(ov);
    const form = ov.querySelector("form");
    ov.addEventListener("click", (e) => { if (e.target.closest("[data-x]") || e.target === ov) { ov.remove(); resolve(null); } });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const out = { ...s, name: fd.get("name"), format: fd.get("format"), to: fd.get("to"), cc: fd.get("cc"), subject: fd.get("subject"), freq: fd.get("freq"), time: fd.get("time"), weekday: Number(fd.get("weekday")), monthday: Number(fd.get("monthday")), message: fd.get("message") };
      ov.remove(); resolve(out);
    });
  });
}
async function saveSubs(list) {
  try { state.subs = await invoke("report_subs_save", { subs: list.map(({ nextDue, ...s }) => s) }); return true; } catch (e) { toast(String(e?.message || e)); return false; }
}
function wireSubsView() {
  const host = $("view-subs");
  host.addEventListener("click", async (e) => {
    if (e.target.closest("[data-open-mail]")) { window.lumen?.apps?.open?.("mail") ?? window.top?.LumenOpenApp?.("mail"); return; }
    if (e.target.closest("[data-save]")) { await saveReport(); renderSubsView(); return; }
    if (e.target.closest("[data-send-now]")) { await sendDialog(); return; }
    if (e.target.closest("[data-sub-new]")) {
      if (!state.file && !(await saveReport())) return;
      const s = await subDialog();
      if (s && (await saveSubs([...state.subs, s]))) { toast(tt("Abonnement créé.")); renderSubsView(); }
      return;
    }
    const row = e.target.closest("[data-sub]");
    if (!row) return;
    const sub = state.subs.find((x) => x.id === row.dataset.sub);
    if (e.target.closest("[data-sub-del]")) {
      if (!(await confirmSheet({ title: tt("Supprimer l'abonnement « {n} » ?", { n: sub.name }), confirm: tt("Supprimer"), cancel: tt("Annuler"), danger: true }))) return;
      await saveSubs(state.subs.filter((x) => x !== sub)); renderSubsView();
    } else if (e.target.closest("[data-sub-edit]")) {
      const s = await subDialog(sub);
      if (s) { await saveSubs(state.subs.map((x) => (x.id === s.id ? s : x))); renderSubsView(); }
    } else if (e.target.closest("[data-sub-send]")) {
      const r = await runSubscription(sub);
      toast(r.ok ? tt("Rapport envoyé à {to}.", { to: sub.to }) : r.error);
      renderSubsView();
    }
  });
  host.addEventListener("change", async (e) => {
    if (!e.target.matches("[data-sub-toggle]")) return;
    const sub = state.subs.find((x) => x.id === e.target.closest("[data-sub]").dataset.sub);
    sub.enabled = e.target.checked;
    await saveSubs(state.subs); renderSubsView();
  });
}

// ===== Export et envoi ==================================================================
async function exportReport(format = "pdf", report = R()) {
  if (!(await unlock(tt("Exporter le rapport")))) return null;
  // Titres automatiques (« Somme de montant par ville ») écrits en clair dans
  // une copie : l'export ne doit pas afficher « Histogramme » partout.
  const titled = { ...report, pages: report.pages.map((p) => ({ ...p, visuals: p.visuals.map((v) => ({ ...v, title: v.title || (v.type === "text" ? "" : defaultTitle(v)) })) })) };
  const pages = await X.snapshot(titled, (v, page) => ({ ...dataForReport(report, v, report.pages.find((p) => p.id === page.id) || page) }));
  const sb = state.file?.sandboxId || (await sandboxes())[0]?.id;
  if (!sb) throw new Error(tt("Créez d'abord une sandbox dans Fichiers."));
  const stamp = today();
  const base = `${REPORT_DIR}/exports/${slug(report.name)}-${stamp}`;
  if (format === "html") {
    const html = X.toHtml(report, pages);
    await invoke("sandbox_write_file", { id: sb, path: `${base}.html`, content: html });
    return { sandboxId: sb, path: `${base}.html`, pages, html };
  }
  const md = X.toMarkdown(report, pages);
  const out = await invoke("sandbox_write_pdf", { id: sb, title: report.name, content: md, path: `${base}.pdf` });
  return { sandboxId: sb, path: out?.path || `${base}.pdf`, pages, md };
}
/** Données d'un visuel pour un rapport donné (export d'un rapport non affiché). */
function dataForReport(report, v, page) {
  if (report === R()) return { ...dataFor(v, page), slicerState: page.slicers?.[v.id] };
  return { T: null, P: null };
}

async function sendReport({ to, cc = "", subject = "", message = "", format = "pdf" }) {
  try {
    if (!String(to || "").trim()) throw new Error(tt("Aucun destinataire."));
    const exp = await exportReport(format);
    if (!exp) throw new Error(tt("Export impossible."));
    const body = X.emailBody(R(), exp.pages, message);
    const data = format === "html" ? X.b64utf8(exp.html) : await invoke("sandbox_read_b64", { id: exp.sandboxId, path: exp.path });
    const name = exp.path.split("/").pop();
    await invoke("mail_send_rich", { to, cc, subject: subject || R().name, text: body.text, html: body.html, attachments: [{ name, mime: format === "html" ? "text/html" : "application/pdf", dataB64: data }] });
    return { ok: true, path: exp.path };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

async function sendDialog() {
  const ov = document.createElement("div");
  ov.className = "modal";
  ov.innerHTML = `<form class="modal-card"><h3>${esc(tt("Envoyer le rapport par email"))}</h3>
    <label class="f"><span>${esc(tt("Destinataires"))}</span><input class="input" name="to" required placeholder="a@exemple.fr, b@exemple.fr" value="${esc(store.get("lastTo", ""))}"/></label>
    <label class="f"><span>${esc(tt("Objet"))}</span><input class="input" name="subject" value="${esc(`${tt("Rapport")} — ${R().name}`)}"/></label>
    <label class="f"><span>${esc(tt("Message"))}</span><textarea class="input" name="message" rows="3"></textarea></label>
    <label class="f"><span>${esc(tt("Pièce jointe"))}</span><select class="select" name="format"><option value="pdf">PDF</option><option value="html">HTML</option></select></label>
    <p class="muted small" data-st></p>
    <div class="modal-actions"><span class="grow"></span><button type="button" class="btn outline" data-x>${esc(tt("Annuler"))}</button><button type="submit" class="btn primary">${ic("send")}${esc(tt("Envoyer"))}</button></div></form>`;
  document.body.appendChild(ov);
  const form = ov.querySelector("form");
  ov.addEventListener("click", (e) => { if (e.target.closest("[data-x]") || e.target === ov) ov.remove(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    form.querySelector("[data-st]").textContent = tt("Calcul, export et envoi…");
    form.querySelector("[type=submit]").disabled = true;
    store.set("lastTo", fd.get("to"));
    const r = await sendReport({ to: fd.get("to"), subject: fd.get("subject"), message: fd.get("message"), format: fd.get("format") });
    if (r.ok) { ov.remove(); toast(tt("Rapport envoyé à {to}.", { to: fd.get("to") })); }
    else { form.querySelector("[data-st]").textContent = r.error; form.querySelector("[type=submit]").disabled = false; }
  });
}

/** Exécute un abonnement : ouvre son rapport, calcule, exporte, envoie, confirme. */
async function runSubscription(sub) {
  const finish = async (ok, status) => { try { await invoke("report_subs_mark", { id: sub.id, ok, status }); } catch {} return ok ? { ok: true } : { ok: false, error: status }; };
  if (!(await isSessionUnlocked(invoke))) return finish(false, tt("Session verrouillée"));
  const keep = { report: state.report, file: state.file, tables: state.tables, prev: state.prev, errors: state.errors };
  try {
    const spec = await readJson(sub.report.sandboxId, sub.report.path);
    state.report = normalize(spec); state.file = { ...sub.report };
    state.tables = new Map(); state.prev = new Map(); state.errors = new Map();
    await refreshData();
    const r = await sendReport({ to: sub.to, cc: sub.cc, subject: sub.subject, message: sub.message, format: sub.format || "pdf" });
    return finish(r.ok, r.ok ? tt("Envoyé") : r.error);
  } catch (e) {
    return finish(false, String(e?.message || e));
  } finally {
    Object.assign(state, keep);
    if (state.report) renderAll();
  }
}

// ===== IA ===============================================================================
async function generateAiVisual(v) {
  if (!v) return;
  const page = curPage();
  const ctx = [];
  for (const o of page.visuals) {
    if (o === v || ["text", "ai", "slicer"].includes(o.type)) continue;
    const { T, P } = dataFor(o, page);
    if (!T) continue;
    try { ctx.push(V.visualMarkdown(o, V.compute(o, T, P))); } catch {}
  }
  const tables = R().tables.map((s) => state.tables.get(s.id)).filter(Boolean).map((t) => Mo.digest(t, 5));
  toast(tt("L'IA rédige l'analyse…"));
  try {
    const sys = "Tu es analyste de données. Tu rédiges un commentaire de rapport clair et chiffré, en Markdown (titres courts, puces), à partir UNIQUEMENT des chiffres fournis. N'invente rien ; signale les limites.";
    const user = `Question : ${v.question || "Commente les chiffres clés de la page, les tendances et les points d'attention."}\n\nPériode : ${X.periodText(R()) || "non précisée"}\n\nVISUELS DE LA PAGE :\n${ctx.join("\n\n") || "(aucun)"}\n\nTABLES (profil) :\n${JSON.stringify(tables).slice(0, 6000)}`;
    const { content } = await llmChat([{ role: "system", content: sys }, { role: "user", content: user }], { rawSystem: true, onDelta: (txt) => { if (txt) { v.answer = txt; repaintVisual(v); } } });
    v.answer = content; touch(); repaintVisual(v); renderPanes();
  } catch (e) { toast(String(e?.message || e)); }
}

function findTable(name) {
  const q = String(name || "").toLowerCase();
  return R().tables.find((t) => t.id === name) || R().tables.find((t) => t.name.toLowerCase() === q) || R().tables.find((t) => t.name.toLowerCase().includes(q)) || (R().tables.length === 1 ? R().tables[0] : null);
}

const AI_TOOLS = [
  tool("list_tables", "Tables du modèle : nom, lignes, colonnes et types.", {}),
  tool("describe_table", "Profil d'une table : colonnes, types, statistiques, valeurs fréquentes, échantillon.", { table: PT.str("Nom de la table") }, ["table"]),
  tool("aggregate", "Calcule une mesure sur une table, éventuellement regroupée (pour répondre à une question chiffrée).", { table: PT.str("Table"), measure: PT.str("Colonne mesurée (vide = nombre de lignes)"), agg: PT.enum(Object.keys(Mo.AGGS), "Agrégation"), group_by: PT.str("Colonne de regroupement (facultatif)"), bucket: PT.enum(Object.keys(Mo.DATE_BUCKETS), "Regroupement de date"), top: PT.int("Nombre max de groupes"), filter_col: PT.str("Colonne filtrée (facultatif)"), filter_values: PT.list("Valeurs gardées") }, ["table"]),
  tool("list_visuals", "Visuels de la page courante (id, type, titre, champs, position).", {}),
  tool("add_visual", "Ajoute un visuel à la page courante.", { type: PT.enum(V.VISUALS.map((v) => v.id), "Type de visuel"), table: PT.str("Table"), title: PT.str("Titre"), axis: PT.str("Colonne d'axe/catégorie"), bucket: PT.enum(Object.keys(Mo.DATE_BUCKETS), "Regroupement si l'axe est une date"), legend: PT.str("Colonne de légende (séries)"), values: { type: "array", description: "Mesures", items: { type: "object", properties: { col: { type: "string" }, agg: { type: "string", enum: Object.keys(Mo.AGGS) } } } }, columns: PT.list("Colonnes (table)"), text: PT.str("Texte Markdown (zone de texte)"), width: PT.int("Largeur 2-12"), height: PT.int("Hauteur 2-20") }, ["type"]),
  tool("update_visual", "Modifie un visuel (titre, type, champs, format).", { id: PT.str("Identifiant"), type: PT.str("Nouveau type"), title: PT.str("Titre"), axis: PT.str("Axe"), bucket: PT.str("Regroupement"), legend: PT.str("Légende"), values: { type: "array", items: { type: "object", properties: { col: { type: "string" }, agg: { type: "string" } } } }, format: PT.enum(Object.keys(V.FORMATS), "Format des nombres"), sort: PT.enum(["value", "asc", "label"], "Tri"), limit: PT.int("Top N") }, ["id"]),
  tool("remove_visual", "Supprime un visuel.", { id: PT.str("Identifiant") }, ["id"]),
  tool("add_page", "Ajoute une page au rapport et s'y place.", { name: PT.str("Nom") }, ["name"]),
  tool("add_filter", "Ajoute un filtre (page ou rapport).", { scope: PT.enum(["page", "report"], "Portée"), table: PT.str("Table"), col: PT.str("Colonne"), op: PT.enum(["in", "notin", "eq", "contains", "gt", "lt", "between"], "Opérateur"), values: PT.list("Valeurs (in/notin)"), value: PT.str("Valeur"), value2: PT.str("Seconde valeur (between)") }, ["col", "op"]),
  tool("set_period", "Règle la période du rapport (et sa comparaison à la période précédente).", { from: PT.str("AAAA-MM-JJ"), to: PT.str("AAAA-MM-JJ"), preset: PT.enum(["month", "last-month", "year", "30d"], "Préréglage"), compare: PT.bool("Comparer"), enabled: PT.bool("Activer") }),
  tool("add_sql_table", "Ajoute au modèle une table issue d'une base locale : à partir d'une question (l'IA écrit le SQL) ou d'une requête.", { name: PT.str("Nom"), question: PT.str("Question en langage naturel"), sql: PT.str("Requête SELECT (facultatif)"), base: PT.str("Nom de la base (facultatif)") }),
  tool("export_report", "Exporte le rapport (PDF ou HTML) dans la sandbox.", { format: PT.enum(["pdf", "html"], "Format") }),
  tool("send_report", "Envoie le rapport par email (pièce jointe).", { to: PT.str("Destinataires"), subject: PT.str("Objet"), message: PT.str("Message"), format: PT.enum(["pdf", "html"], "Format") }, ["to"]),
];

async function runTool(name, a = {}) {
  const page = curPage();
  switch (name) {
    case "list_tables":
      return JSON.stringify(R().tables.map((s) => { const T = state.tables.get(s.id); return { name: s.name, rows: T?.rows.length ?? 0, columns: T ? T.columns.map((c) => `${c} (${T.types[c]})`) : [], error: state.errors.get(s.id) || undefined }; }));
    case "describe_table": {
      const s = findTable(a.table); const T = s && state.tables.get(s.id);
      return T ? JSON.stringify(Mo.digest(T, 10)) : `Table introuvable : ${a.table}`;
    }
    case "aggregate": {
      const s = findTable(a.table); let T = s && state.tables.get(s.id);
      if (!T) return `Table introuvable : ${a.table}`;
      if (a.filter_col && a.filter_values?.length) T = Mo.filterTable(T, [{ col: a.filter_col, op: "in", values: a.filter_values }]);
      const m = { col: a.measure || "", agg: a.agg || (a.measure ? "sum" : "count") };
      if (!a.group_by) return JSON.stringify({ value: Mo.measureValue(T, m), rows: T.rows.length });
      const g = Mo.groupBy(T, { axis: { col: a.group_by, bucket: a.bucket || "" }, measures: [m], limit: a.top || 30 });
      return JSON.stringify(g.categories.map((c, i) => ({ [a.group_by]: c.label, value: Math.round(g.series[0].values[i] * 100) / 100 })));
    }
    case "list_visuals":
      return JSON.stringify(page.visuals.map((v) => ({ id: v.id, type: v.type, title: v.title || defaultTitle(v), table: tableName(v.table), axis: v.axis?.col, legend: v.legend?.col, values: v.values, x: v.x, y: v.y, w: v.w, h: v.h })));
    case "add_visual": {
      const s = findTable(a.table) || R().tables[0];
      if (!s && !["text", "ai"].includes(a.type)) return "Aucune table dans le modèle.";
      const T = s && state.tables.get(s.id);
      const patch = { table: s?.id || "", title: a.title || "" };
      if (a.axis) patch.axis = { col: a.axis, bucket: a.bucket || (T?.types[a.axis] === "date" ? "month" : "") };
      if (a.legend) patch.legend = { col: a.legend, bucket: "" };
      if (a.values?.length) patch.values = a.values.map((m) => ({ col: m.col || "", agg: m.agg || (m.col ? "sum" : "count") }));
      if (a.columns?.length) patch.columns = a.columns;
      if (a.text) patch.text = a.text;
      if (a.type === "slicer") patch.slicer = { col: a.axis || a.columns?.[0] || "", mode: "" };
      if (a.type === "matrix") patch.pivot = { rows: a.axis ? [a.axis] : [], cols: a.legend ? [a.legend] : [], values: (a.values || []).map((m) => ({ field: m.col, agg: m.agg || "sum" })), buckets: a.axis && T?.types[a.axis] === "date" ? { [a.axis]: a.bucket || "month" } : {} };
      if (a.width) patch.w = clamp(a.width, 2, 12);
      if (a.height) patch.h = clamp(a.height, 2, 20);
      const v = addVisual(a.type, patch);
      return `Visuel ajouté (id ${v.id}).`;
    }
    case "update_visual": {
      const v = page.visuals.find((x) => x.id === a.id);
      if (!v) return "Visuel introuvable.";
      const T = state.tables.get(v.table);
      if (a.type) v.type = a.type;
      if (a.title != null) v.title = a.title;
      if (a.axis) v.axis = { col: a.axis, bucket: a.bucket || (T?.types[a.axis] === "date" ? "month" : "") };
      if (a.legend) v.legend = { col: a.legend, bucket: "" };
      if (a.values?.length) v.values = a.values.map((m) => ({ col: m.col || "", agg: m.agg || "sum" }));
      if (a.format) v.opts.format = a.format;
      if (a.sort) v.opts.sort = a.sort;
      if (a.limit != null) v.opts.limit = a.limit;
      touch(); repaintVisual(v); renderPanes();
      return "Visuel modifié.";
    }
    case "remove_visual": removeVisual(a.id); return "Visuel supprimé.";
    case "add_page": addPage(a.name); return "Page ajoutée.";
    case "add_filter": {
      const s = findTable(a.table);
      const f = { table: s?.id || "", col: a.col, op: a.op, values: a.values || [], value: a.value ?? "", value2: a.value2 ?? "" };
      (a.scope === "report" ? R().filters : page.filters).push(f);
      touch(); renderCanvas(); renderPanes();
      return "Filtre ajouté.";
    }
    case "set_period": {
      const p = R().period;
      if (a.preset) Object.assign(p, periodPreset(a.preset));
      if (a.from) p.from = a.from;
      if (a.to) p.to = a.to;
      if (a.compare != null) p.compare = !!a.compare;
      p.enabled = a.enabled ?? true;
      touch(); renderPeriod(); await refreshData();
      return `Période : ${p.from} → ${p.to}.`;
    }
    case "add_sql_table": {
      const bases = await db.listQueryableBases().catch(() => []);
      const base = bases.find((b) => b.name.toLowerCase() === String(a.base || "").toLowerCase()) || bases[0];
      if (!base) return "Aucune base disponible.";
      let sql = a.sql || "";
      if (!sql && a.question) { const res = await db.askAi(base.base_id, a.question); sql = res.sql; }
      if (!sql) return "Indique une question ou une requête.";
      await pushSource({ id: uid("t"), name: a.name || a.question?.slice(0, 40) || "Requête", kind: "sql", baseId: base.base_id, baseName: base.name, sql });
      return `Table ajoutée. Colonnes : ${state.tables.get(R().tables.at(-1).id)?.columns.join(", ") || "?"}`;
    }
    case "export_report": { const r = await exportReport(a.format || "pdf"); return r ? `Exporté : ${r.path}` : "Export interrompu."; }
    case "send_report": { const r = await sendReport({ to: a.to, subject: a.subject, message: a.message, format: a.format || "pdf" }); return r.ok ? `Envoyé à ${a.to}.` : `Échec : ${r.error}`; }
    default: return `Outil inconnu : ${name}`;
  }
}

const AI_OPTS = {
  app: "Analyse de données",
  title: tt("Assistant d'analyse"),
  className: "da-ai",
  intro: "Tu es analyste BI : tu construis des rapports (pages de visuels), réponds aux questions sur les données (outil aggregate) et rédiges des commentaires chiffrés.",
  placeholder: tt("Ex. : crée un tableau de bord des ventes par région et par mois"),
  rules: `- Commence par list_tables / describe_table pour connaître les colonnes exactes.
- Pour une question chiffrée, calcule avec aggregate puis réponds avec les chiffres.
- Pour un tableau de bord : 3-4 cartes (type card, largeur 3) en haut, puis 2-4 graphiques (largeur 6), un segment sur une catégorie utile.
- Les colonnes de date se regroupent par mois (bucket month) sur l'axe.`,
  suggestions: [
    { label: tt("Tableau de bord"), prompt: "Crée un tableau de bord complet de mes données : indicateurs clés, évolution dans le temps, répartition par catégorie et un segment." },
    { label: tt("Questions clés"), prompt: "Quels sont les 3 constats les plus importants dans ces données ? Calcule-les." },
    { label: tt("Top 10"), prompt: "Ajoute un graphique des 10 premières catégories selon la mesure principale." },
  ],
  tools: AI_TOOLS,
  execute: (name, args) => runTool(name, args),
  context: () => `Rapport « ${R().name} » — page « ${curPage().name} » (${curPage().visuals.length} visuels). Tables : ${R().tables.map((s) => { const T = state.tables.get(s.id); return `${s.name} (${T ? `${T.rows.length} lignes ; ${T.columns.map((c) => `${c}:${T.types[c]}`).join(", ")}` : "non chargée"})`; }).join(" ; ") || "aucune"}. ${X.periodText(R())}`,
  maxTurns: 14,
};

async function autoDashboard() {
  ai?.open();
  ai?.ask(AI_OPTS.suggestions[0].prompt);
}

/** Q&A : une question → un visuel qui y répond (ou une réponse chiffrée). */
async function askQuestion(q) {
  if (!q.trim()) return;
  if (!R().tables.length) { toast(tt("Ajoutez d'abord des données.")); return; }
  $("qa-input").value = "";
  ai?.open();
  ai?.ask(`${q}\n\n(Réponds avec les chiffres via aggregate ; si un visuel aide, ajoute-le à la page avec add_visual.)`);
}

// ===== Fichier : nouveau, ouvrir, enregistrer, exporter ======================================
async function fileAction(act) {
  $("file-menu").hidden = true;
  if (act === "new") {
    if (state.dirty) await saveReport({ silent: true });
    state.report = blankReport(); state.file = null; state.tables = new Map(); state.prev = new Map(); state.errors = new Map();
    afterLoad(); setView("model");
  } else if (act === "open") {
    if (!(await unlock(tt("Ouvrir un rapport")))) return;
    const list = await listAllReports();
    const r = await pick(tt("Ouvrir un rapport"), list, { label: (x) => x.name, sub: (x) => `${x.kind === "legacy" ? "Reporting · " : x.kind === "dashboard" ? `${tt("Tableau de bord")} · ` : ""}${x.sandbox} · ${x.updatedAt ? new Date(x.updatedAt).toLocaleDateString("fr-FR") : ""}` });
    if (r) { if (state.dirty) await saveReport({ silent: true }); state.tables = new Map(); state.prev = new Map(); state.errors = new Map(); await openReportFile(r); }
  } else if (act === "save") await saveReport();
  else if (act === "saveas") {
    const name = await promptSheet({ title: tt("Enregistrer sous"), value: `${R().name} (copie)` });
    if (!name) return;
    R().name = name; R().id = uid("r");
    await saveReport({ as: true });
  } else if (act === "pdf" || act === "html") {
    toast(tt("Export en cours…"));
    try { const r = await exportReport(act); if (r) toast(tt("Exporté : {p}", { p: r.path }), 5000); } catch (e) { toast(String(e?.message || e)); }
  } else if (act === "email") { setView("subs"); await sendDialog(); }
  else if (act === "subs") setView("subs");
  else if (act === "todoc") insertIntoDoc(curPage().visuals, { wholePage: true });
}

// ===== Documents et présentations augmentés ===========================================
/** Liste les documents/présentations Opus de toutes les sandboxes. */
async function listOpusFiles() {
  const found = [];
  const walk = async (sb, path, depth) => {
    let entries = [];
    try { entries = (await invoke("sandbox_read_dir", { id: sb.id, path })) || []; } catch { return; }
    for (const e of entries) {
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.is_dir) { if (depth < 4 && !e.name.startsWith(".")) await walk(sb, p, depth + 1); }
      else if (/\.(lumenkey|lumenpages)$/i.test(e.name) && !e.name.startsWith("._")) found.push({ sb, path: p, kind: /\.lumenkey$/i.test(e.name) ? "presentation" : "document" });
    }
  };
  for (const sb of await sandboxes()) await walk(sb, "", 0);
  return found;
}

/**
 * Pose un ou plusieurs visuels dans un document ou une présentation : choix de
 * la cible (nouvelle ou existante), capture, écriture du fichier, ouverture.
 */
async function insertIntoDoc(visuals, { wholePage = false } = {}) {
  const list = visuals.filter((v) => v.type !== "slicer");
  if (!list.length) { toast(tt("Rien à insérer sur cette page.")); return; }
  if (!(await unlock(tt("Insérer dans un document")))) return;
  if (!state.file) { const ok = await saveReport({ silent: true }); if (!ok) { toast(tt("Enregistrez d'abord le rapport.")); return; } }
  const found = await listOpusFiles();
  const NEW_DECK = { label: tt("Nouvelle présentation"), sub: tt("Une diapositive par visuel"), create: "presentation" };
  const NEW_DOC = { label: tt("Nouveau document"), sub: tt("Les visuels à la suite, prêts à commenter"), create: "document" };
  const target = await pick(tt(list.length > 1 ? "Insérer la page dans…" : "Insérer le visuel dans…"), [NEW_DECK, NEW_DOC, ...found], {
    label: (x) => x.label || x.path.split("/").pop(),
    sub: (x) => x.sub || `${x.kind === "presentation" ? tt("Présentation") : tt("Document")} · ${x.sb.name} / ${x.path}`,
  });
  if (!target) return;
  let asPage = false;
  if (wholePage && list.length > 1 && (target.create === "presentation" || target.kind === "presentation")) {
    asPage = await confirmSheet({ title: tt("Mise en page"), body: tt("Reproduire la page du rapport sur une seule diapositive ? (Sinon : une diapositive par visuel.)"), confirm: tt("Une diapositive"), cancel: tt("Une par visuel") });
  }
  toast(tt("Capture des visuels…"));
  const page = curPage();
  const slug = state.file.path.split("/").pop().replace(/\.json$/i, "");
  const items = [];
  for (const v of list.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    const { T, P } = dataFor(v, page);
    const cap = await DI.captureVisual(v, { T, P, theme: V.reportTheme(R()), slicerState: page.slicers?.[v.id] });
    if (!cap) continue;
    const dataRef = { kind: "lumen-visual", sandboxId: state.file.sandboxId, path: state.file.path, pageId: page.id, visualId: v.id, at: Date.now() };
    let sandboxPath = "";
    if (cap.kind === "image") { try { sandboxPath = await DI.storeCapture(invoke, state.file.sandboxId, slug, v, cap.png); } catch {} }
    items.push({ v, cap, title: v.type === "text" ? "" : (v.opts?.showTitle === false ? "" : v.title || defaultTitle(v)), dataRef, sandboxId: sandboxPath ? state.file.sandboxId : "", sandboxPath });
  }
  if (!items.length) { toast(tt("Aucun visuel à insérer (segments et visuels vides ignorés).")); return; }
  try {
    let sb, path, file;
    if (target.create) {
      sb = state.sandboxes.find((x) => x.id === state.file.sandboxId) || (await sandboxes())[0];
      const ext = target.create === "presentation" ? "lumenkey" : "lumenpages";
      const base = slug.replace(/-[a-z0-9]{4}$/i, "") || "rapport";
      path = `${base}-${Date.now().toString(36).slice(-4)}.${ext}`;
      file = { kind: target.create, title: list.length === 1 ? items[0].title || R().name : `${R().name}${wholePage && R().pages.length > 1 ? ` — ${page.name}` : ""}`, doc: { kind: target.create, title: "", pages: [] } };
      file.doc.title = file.title;
      if (target.create === "presentation") file.doc.pages.push(coverSlide(file.title));
    } else {
      sb = target.sb; path = target.path;
      const raw = await invoke("sandbox_read_file", { id: sb.id, path });
      file = JSON.parse(typeof raw === "string" ? raw : raw?.content || "{}");
      file.doc ||= { pages: [] };
    }
    const kind = file.kind === "presentation" || /\.lumenkey$/i.test(path) ? "presentation" : "document";
    DI.placeInDoc(file.doc, kind, items, { asPage, pageTitle: page.name !== "Page 1" ? page.name : R().name });
    file.updatedAt = Date.now();
    delete file.html; // rendu statique régénéré par Opus au prochain enregistrement
    await invokeUnlocked(invoke, "sandbox_write_file", { id: sb.id, path, content: JSON.stringify(file, null, 2) });
    toast(tt("{n} visuel(s) inséré(s) dans « {p} ».", { n: items.length, p: path.split("/").pop() }), 5000);
    const opened = await window.lumen?.apps?.openFile?.(sb.id, path);
    if (opened === undefined) window.top?.LumenOpenFile?.(path, sb.id);
  } catch (e) { toast(`${tt("Insertion impossible")} : ${e?.message || e}`); }
}

function coverSlide(title) {
  const sys = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
  const t = (o) => ({ id: uid("el-"), type: "text", rotation: 0, fontFamily: sys, letterSpacing: 0, padding: 4, opacity: 1, bg: "transparent", align: "left", lineHeight: 1.2, weight: 400, ...o });
  return { w: 1280, h: 720, background: "#0b1020", notes: "", elements: [
    t({ x: 120, y: 250, w: 1040, h: 120, html: esc(title), fontSize: 72, weight: 800, color: "#ffffff" }),
    t({ x: 120, y: 390, w: 900, h: 60, html: esc([X.periodText(R()), new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })].filter(Boolean).join(" · ")), fontSize: 26, color: "#aab2d5" }),
  ] };
}

async function unlock(reason) {
  if (!state.locked && (await isSessionUnlocked(invoke))) return true;
  const ok = await ensureSessionUnlocked({ invoke, reason });
  if (ok) { state.locked = false; $("lock-banner").hidden = true; }
  return ok;
}

// ===== Modes sans écran (bureau) ===========================================================
/** Export demandé par le bloc Fluxo « Exporter un rapport » : { id, report, sandbox, format, period }. */
async function headlessExport(raw) {
  let req = {};
  try { req = JSON.parse(raw); } catch { return; }
  const reply = (payload) => invoke("reporting_export_result", { id: req.id, ...payload }).catch(() => {});
  try {
    const wanted = String(req.report || "").trim().toLowerCase();
    const list = (await listAllReports()).filter((x) => !req.sandbox || x.sandbox.toLowerCase() === String(req.sandbox).toLowerCase() || x.sandboxId === req.sandbox);
    const found = list.find((x) => x.name.toLowerCase() === wanted) || list.find((x) => x.name.toLowerCase().includes(wanted));
    if (!found) throw new Error(`Rapport « ${req.report} » introuvable${req.sandbox ? ` dans « ${req.sandbox} »` : ""}.`);
    await openReportFile(found);
    if (req.period && req.period !== "saved") { Object.assign(R().period, periodPreset(req.period), { enabled: true }); await refreshData(); }
    const format = String(req.format || "pdf");
    const paths = [];
    if (format === "html" || format === "both") paths.push((await exportReport("html")).path);
    if (format === "pdf" || format === "both") paths.push((await exportReport("pdf")).path);
    await reply({ result: { report: R().name, sandbox: found.sandbox, sandboxId: found.sandboxId, paths, period: R().period } });
  } catch (e) { await reply({ error: String(e?.message || e) }); }
}

/**
 * Capture hors écran pour Opus (insertion ou actualisation d'un visuel lié) :
 * req = { sandboxId, path, items: [{ pageId, visualId }] }. Réponse transmise
 * au bureau par la pseudo-commande `dataviz_capture_result`, que le bureau
 * intercepte (elle n'existe pas côté Rust : le rejet est attendu).
 */
async function headlessCapture(raw) {
  let req = {};
  try { req = JSON.parse(raw); } catch { return; }
  const reply = (payload) => invoke("dataviz_capture_result", { token: req.token, ...payload }).catch(() => {});
  try {
    const spec = await readJson(req.sandboxId, req.path);
    if (!spec) throw new Error(tt("Rapport introuvable."));
    state.report = normalize(spec); state.file = { sandboxId: req.sandboxId, path: req.path };
    afterLoad();
    await refreshData();
    const slug = req.path.split("/").pop().replace(/\.json$/i, "");
    const out = [];
    for (const want of req.items || []) {
      const page = R().pages.find((p) => p.id === want.pageId) || R().pages.find((p) => p.visuals.some((v) => v.id === want.visualId));
      const v = page?.visuals.find((x) => x.id === want.visualId);
      if (!v) { out.push({ visualId: want.visualId, error: tt("Visuel supprimé du rapport.") }); continue; }
      const { T, P } = dataFor(v, page);
      const cap = await DI.captureVisual(v, { T, P, theme: V.reportTheme(R()), slicerState: page.slicers?.[v.id] });
      if (!cap) { out.push({ visualId: v.id, error: tt("Rien à capturer.") }); continue; }
      let sandboxPath = "";
      if (cap.kind === "image") { try { sandboxPath = await DI.storeCapture(invoke, req.sandboxId, slug, v, cap.png); } catch {} }
      const title = v.type === "text" ? "" : v.opts?.showTitle === false ? "" : v.title || defaultTitle(v);
      out.push({ visualId: v.id, pageId: page.id, title, cap, sandboxPath, sandboxId: sandboxPath ? req.sandboxId : "", dataRef: { kind: "lumen-visual", sandboxId: req.sandboxId, path: req.path, pageId: page.id, visualId: v.id, at: Date.now() } });
    }
    await reply({ report: R().name, items: out });
  } catch (e) { await reply({ error: String(e?.message || e) }); }
}

async function processPendingSubs(onlyId = null) {
  await loadSubs();
  // Rattrapage (app ouverte normalement) : seulement les échéances manquées
  // depuis plus de 3 minutes — une échéance toute fraîche est en train d'être
  // traitée par le bureau, hors écran ; l'envoyer ici la doublerait.
  const now = Date.now() / 1000;
  for (const s of state.subs.filter((x) => (onlyId ? x.id === onlyId : x.pending && x.enabled && now - (x.lastDue || 0) > 180))) await runSubscription(s);
}

// ===== Démarrage ==============================================================================
let ai = null;
function wireTop() {
  document.querySelectorAll(".rail-btn[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("report-name").addEventListener("input", (e) => { R().name = e.target.value; touch(); });
  $("btn-file").addEventListener("click", (e) => { e.stopPropagation(); $("file-menu").hidden = !$("file-menu").hidden; });
  $("file-menu").addEventListener("click", (e) => { const b = e.target.closest("[data-file]"); if (b) fileAction(b.dataset.file); });
  $("btn-refresh").addEventListener("click", () => refreshData());
  $("btn-ai").addEventListener("click", () => ai?.toggle());
  $("qa-input").addEventListener("keydown", (e) => { if (e.key === "Enter") askQuestion(e.target.value); });
  $("btn-unlock").addEventListener("click", async () => { if (await unlock()) await boot(); });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveReport(); }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selId && state.view === "report" && !e.target.matches("input, textarea, select")) { e.preventDefault(); removeVisual(state.selId); }
  });
  window.addEventListener("beforeunload", () => { if (state.dirty) saveReport({ silent: true }); });
}

async function boot() {
  state.locked = !(await isSessionUnlocked(invoke));
  $("lock-banner").hidden = !state.locked;
  if (!state.locked) await sandboxes();
  const last = store.getJSON("last", null);
  if (!state.locked && last) {
    try {
      const spec = await readJson(last.sandboxId, last.path);
      if (spec) { state.report = normalize(spec); state.file = last; }
    } catch {}
  }
  if (!state.report) state.report = blankReport();
  afterLoad();
  if (!state.locked) await refreshData();
  if (!R().tables.length) setView("model");
}

async function init() {
  await store.ready();
  document.querySelectorAll("[data-ic]").forEach((n) => { n.innerHTML = ic(n.dataset.ic); });
  const params = new URLSearchParams(location.search);
  // Ouverte hors écran par le bureau : export (bloc Fluxo) ou envoi programmé.
  if (params.get("capture")) { state.report = blankReport(); await sandboxes(); await headlessCapture(params.get("capture")); return; }
  if (params.get("export")) { state.report = blankReport(); await sandboxes(); await headlessExport(params.get("export")); return; }
  if (params.get("subscription")) { state.report = blankReport(); await sandboxes(); await processPendingSubs(params.get("subscription")); return; }
  wireTop(); wirePeriod(); wirePages(); wireCanvas(); wirePanes(); wireDataView(); wireModelView(); wireSubsView();
  await boot();
  try { ai = mountAiPrompt(null, AI_OPTS); } catch (e) { console.warn("[analyse] assistant indisponible", e); }
  registerIntents();
  // Envois programmés manqués (bureau fermé, session verrouillée) : rattrapés.
  if (!state.locked) setTimeout(() => processPendingSubs().catch(() => {}), 4000);
  window.addEventListener("focus", async () => { if (state.locked && (await isSessionUnlocked(invoke))) { state.locked = false; await boot(); } });
  // Un CSV envoyé depuis l'explorateur ou Calc (« Envoyer vers… › Analyse »).
  receive("dataanalysis", async (obj) => {
    if (obj?.kind !== "file" || !obj.path) return;
    await pushSource({ id: uid("t"), name: obj.path.split("/").pop().replace(/\.[^.]+$/, ""), kind: "file", sandboxId: obj.sandboxId, path: obj.path });
    setView("data");
  });
  autoTranslate({ observe: true });
}

function registerIntents() {
  const api = window.lumen?.intents;
  if (!api) return;
  const on = (id, fn) => api.on(id, fn).catch(() => {});
  on("analyze_data", async ({ question }) => (await runAiTools(AI_OPTS, `${question}\n(Réponds avec des chiffres calculés par aggregate.)`, () => {})) || "Analyse terminée.");
  on("create_dashboard", async ({ goal }) => { await runAiTools(AI_OPTS, `Crée un tableau de bord : ${goal || "vue d'ensemble des données"}.`, () => {}); await saveReport({ silent: true }); return `Tableau de bord créé dans « ${R().name} » (${curPage().visuals.length} visuels).`; });
  on("send_report", async ({ to, subject, format }) => { const r = await sendReport({ to, subject, format: format || "pdf" }); return r.ok ? `Rapport « ${R().name} » envoyé à ${to}.` : `Échec : ${r.error}`; });
  on("report_send", async ({ id }) => { await processPendingSubs(id); return "Envoi traité."; });
}

init();
