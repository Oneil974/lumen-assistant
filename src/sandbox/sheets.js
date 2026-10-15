// Calc — le tableur de Lumen (.lumensheet).
//
// Troisième pièce de l'atelier bureautique, à côté d'Opus (documents et
// présentations) : grille de cellules, formules, formats, tri, graphiques.
//
// Sa particularité par rapport à un tableur classique : il est branché sur le
// hub Prisme. Une feuille peut VENIR d'une table SQLite locale ou d'une question
// posée en langage naturel, et repartir vers l'Analyse de données ou vers une
// nouvelle table — sans passer par un fichier intermédiaire à la main.
//
// Comme creative-editor.js, le module est découplé du shell bureau par
// injection de dépendances (setSheetsContext).

const { invoke } = window.__TAURI__.core;
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { escapeHtml, fileExt } from "./render.js";
import { tt } from "../apps-i18n.js";
import { llmChat } from "../llm.js";
import { icon as lumenIcon } from "../lib/icons.js";
import * as tablesDb from "../tables/client.js";
import { colName, colIndex, cellKey, parseKey, createEvaluator, toText, rawNumber, isFormulaError, FUNCTION_NAMES } from "./sheets-formula.js";
import { isChartSheet, blankChartSheet, autoConfigure, renderChartSheet, renderChartConfig, renderChartCreate, chartPng } from "./sheets-charts.js";
import { replyLang } from "../lib/prompt-lang.js";
import { PROMPTS as CALC_PROMPTS } from "./sheets-prompts.js";
import { readSandboxBytes, writeSandboxBytes } from "../lib/office/ooxml.js";
import { listAgents, matchAgentMention, delegateToAgent, openLivingDialog, listLiving, livingCardHTML, wireLivingCards, onLivingUpdated, runLiving, ensureLivingStyles } from "../lib/living-docs.js";

const ICN = new Proxy({}, { get: (_, name) => lumenIcon(String(name)) });

// ── Contexte injecté par desktop.js ─────────────────────────────────────────
let ctx = {
  createWindow: () => null,
  closeWindow: () => {},
  getCurrent: () => null,
  listSandboxes: async () => [],
  requestSandboxRefresh: () => {},
  openHub: () => {},
};
export function setSheetsContext(next) { ctx = { ...ctx, ...next }; }

const SHEETS_ID = "calc";
const DEFAULT_COLS = 26;
const DEFAULT_ROWS = 100;
const DEFAULT_W = 108;
const ROW_H = 26;

// ── Modèle ──────────────────────────────────────────────────────────────────
// Une feuille ne stocke que les cellules réellement remplies : une grille de
// 100×26 vide pèse quelques octets, pas 2 600 objets.
function blankSheet(name = "Feuille 1") {
  return { name, cells: {}, fmt: {}, widths: {}, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, source: null };
}
function blankDoc(title = "Classeur") {
  return { title, sheets: [blankSheet()], active: 0 };
}

function createState(doc, meta) {
  return {
    doc,
    sel: { r: 0, c: 0, r2: 0, c2: 0 },
    path: meta?.path || "",
    // « xlsx » : classeur ouvert depuis Excel, réenregistré dans ce format.
    format: meta?.format || "lumen",
    sandboxId: meta?.sandboxId || "",
    undo: [], redo: [],
    clip: null,
    panel: "data",     // volet droit : 'data' | 'chart' | 'ai'
    refs: {},
    evalr: null,
  };
}
const sheet = (st) => st.doc.sheets[st.doc.active] || st.doc.sheets[0];
const rawAt = (sh, key) => sh.cells[key] ?? "";
const fmtAt = (sh, key) => sh.fmt[key] || null;

function snapshot(st) {
  st.undo.push(JSON.stringify(st.doc));
  if (st.undo.length > 60) st.undo.shift();
  st.redo.length = 0;
}
function doUndo(st) {
  if (!st.undo.length) return;
  st.redo.push(JSON.stringify(st.doc));
  st.doc = JSON.parse(st.undo.pop());
  clampSelection(st);
}
function doRedo(st) {
  if (!st.redo.length) return;
  st.undo.push(JSON.stringify(st.doc));
  st.doc = JSON.parse(st.redo.pop());
  clampSelection(st);
}
function clampSelection(st) {
  if (st.doc.active >= st.doc.sheets.length) st.doc.active = st.doc.sheets.length - 1;
  const sh = sheet(st);
  st.sel.r = Math.min(st.sel.r, sh.rows - 1); st.sel.r2 = Math.min(st.sel.r2, sh.rows - 1);
  st.sel.c = Math.min(st.sel.c, sh.cols - 1); st.sel.c2 = Math.min(st.sel.c2, sh.cols - 1);
}

// ── Ouverture ───────────────────────────────────────────────────────────────
export function openSheetsApp(initial = null) {
  if (initial) ctx.closeWindow(SHEETS_ID);
  const win = ctx.createWindow({ id: SHEETS_ID, title: "Calc", w: 1240, h: 780, x: 74, y: 46 });
  if (!win) return;
  const doc = initial?.doc || blankDoc(initial?.title);
  if (initial?.title) doc.title = initial.title;
  const st = createState(doc, initial);
  win.body.innerHTML = shell(st);
  wire(win, st);
  renderAll(st, true);
}

/**
 * Ouvre un tableau reçu par le bus d'interop (objet de nature `table`), sans
 * passer par un fichier : l'expéditeur n'a que des données en mémoire.
 * Cf. src/lib/interop.js.
 */
export function openSheetsRows(title, columns, rows) {
  const doc = blankDoc(title || "Sans titre");
  const grid = Array.isArray(columns) && columns.length ? [columns, ...(rows || [])] : (rows || []);
  fillSheetFromRows(doc.sheets[0], grid);
  openSheetsApp({ doc, title: doc.title });
}

export async function openSheetsFile(path, sandboxId = "") {
  const sb = sandboxId ? { id: sandboxId } : ctx.getCurrent();
  if (!sb || !path) return;
  const ext = fileExt(path);
  if (ext === "xlsx") {
    try {
      const bytes = await readSandboxBytes(invoke, sb.id, path);
      const { xlsxToSheets } = await import("../lib/office/xlsx.js");
      const doc = await xlsxToSheets(bytes, baseName(path));
      openSheetsApp({ doc, path, title: doc.title, format: "xlsx", sandboxId: sb.id });
    } catch (e) { console.error("[xlsx]", e); }
    return;
  }
  const file = await invoke("sandbox_read_file", { id: sb.id, path }).catch(() => null);
  if (!file || file.binary) return;
  let doc = null;
  if (ext === "lumensheet") {
    try { const data = JSON.parse(file.content || "{}"); doc = data.doc || null; } catch { doc = null; }
  } else if (ext === "csv" || ext === "tsv") {
    doc = blankDoc(baseName(path));
    fillSheetFromRows(doc.sheets[0], parseDelimited(file.content || "", ext === "tsv" ? "\t" : ","));
  }
  if (!doc) return;
  openSheetsApp({ doc, path, title: doc.title || baseName(path), sandboxId: sb.id });
}
const baseName = (p) => String(p).split("/").pop().replace(/\.[^.]+$/, "");

// ── Coquille ────────────────────────────────────────────────────────────────
function shell(st) {
  const group = (label, inner) => `<div class="sh-grp"><div class="sh-grp-body">${inner}</div><div class="sh-grp-lbl">${label}</div></div>`;
  const btn = (act, icon, label, title = label) =>
    `<button class="sh-btn" data-act="${act}" title="${escapeHtml(title)}"><span class="sh-btn-ic">${icon}</span><span class="sh-btn-lbl">${escapeHtml(label)}</span></button>`;
  const mini = (act, content, title, extra = "") =>
    `<button class="sh-mini ${extra}" data-act="${act}" title="${escapeHtml(title)}">${content}</button>`;

  return `
  <div class="sh-app">
    <div class="sh-top">
      <span class="sh-logo">${ICN.table}</span>
      <input class="sh-title" value="${escapeHtml(st.doc.title || "")}" aria-label="${tt("Titre du classeur")}">
      <span class="sh-spacer"></span>
      <div class="sh-top-actions">
        ${btn("new", ICN.file, tt("Nouveau"))}
        ${btn("open", ICN.folderOpen, tt("Ouvrir"))}
        ${btn("import-csv", ICN.download, tt("Importer CSV"), tt("Importer un CSV de la sandbox"))}
        ${btn("export-csv", ICN.code, tt("Exporter CSV"))}
        ${btn("export-xlsx", ICN.tables, tt("Exporter en Excel (.xlsx)"))}
        <button class="sh-btn primary" data-act="save" title="${tt("Enregistrer")}"><span class="sh-btn-ic">${ICN.save}</span><span class="sh-btn-lbl">${tt("Enregistrer")}</span></button>
      </div>
    </div>

    <div class="sh-ribbon">
      ${group(tt("Historique"), `${mini("undo", ICN.undo, tt("Annuler"))}${mini("redo", ICN.redo, tt("Rétablir"))}`)}
      ${group(tt("Presse-papiers"), `${mini("copy", ICN.dup, tt("Copier"))}${mini("paste", ICN.clipboard || ICN.file, tt("Coller"))}${mini("clear", ICN.trash, tt("Effacer le contenu"))}`)}
      ${group(tt("Style"), `
        ${mini("bold", "<b>G</b>", tt("Gras"))}
        ${mini("italic", "<i>I</i>", tt("Italique"))}
        ${mini("underline", "<u>S</u>", tt("Souligné"))}
        <label class="sh-color" title="${tt("Couleur du texte")}">${ICN.text}<input type="color" data-act="fg" value="#1d1d1f"></label>
        <label class="sh-color" title="${tt("Couleur de fond")}">${ICN.paint || ICN.rect}<input type="color" data-act="bg" value="#ffe08a"></label>
        ${mini("style-reset", "⌫", tt("Effacer la mise en forme"))}
      `)}
      ${group(tt("Alignement"), `
        ${mini("align-left", "⬅", tt("Aligner à gauche"))}
        ${mini("align-center", "↔", tt("Centrer"))}
        ${mini("align-right", "➡", tt("Aligner à droite"))}
      `)}
      ${group(tt("Nombre"), `
        ${mini("fmt-auto", "123", tt("Automatique"))}
        ${mini("fmt-currency", "€", tt("Monnaie"))}
        ${mini("fmt-percent", "%", tt("Pourcentage"))}
        ${mini("fmt-date", ICN.calendar || "📅", tt("Date"))}
        ${mini("dec-more", ".0→", tt("Ajouter une décimale"))}
        ${mini("dec-less", "←.0", tt("Retirer une décimale"))}
      `)}
      ${group(tt("Cellules"), `
        ${mini("row-add", "+↔", tt("Insérer une ligne"))}
        ${mini("row-del", "−↔", tt("Supprimer la ligne"))}
        ${mini("col-add", "+↕", tt("Insérer une colonne"))}
        ${mini("col-del", "−↕", tt("Supprimer la colonne"))}
      `)}
      ${group(tt("Données"), `
        ${mini("sort-asc", "A→Z", tt("Trier par cette colonne (croissant)"))}
        ${mini("sort-desc", "Z→A", tt("Trier par cette colonne (décroissant)"))}
        ${mini("autosum", "Σ", tt("Somme automatique"))}
      `)}
      ${group(tt("Agents"), `
        ${mini("live", ICN["refresh-cw"], tt("Feuille vivante : un agent la tient à jour selon un rythme et des sources"))}
        ${mini("ask-agent", "@", tt("Confier une plage à un agent : tapez @Agent demande dans une cellule"))}
      `)}
    </div>

    <div class="sh-live" hidden></div>
    <div class="sh-formula-bar">
      <span class="sh-cellref">A1</span>
      <span class="sh-fx">fx</span>
      <input class="sh-formula" spellcheck="false" placeholder="${tt("Valeur ou formule (=SOMME(A1:A9))")}">
    </div>

    <div class="sh-work">
      <div class="sh-gridwrap"><div class="sh-grid"></div><input class="sh-editor" spellcheck="false" hidden></div>
      <aside class="sh-side">
        <div class="sh-side-tabs" role="tablist">
          <button data-panel="data" class="active">${ICN.database || ICN.table}<span>${tt("Données")}</span></button>
          <button data-panel="chart">${ICN.chart || ICN.rect}<span>${tt("Graphique")}</span></button>
          <button data-panel="ai">${ICN.ai}<span>${tt("IA")}</span></button>
        </div>
        <div class="sh-side-body"></div>
      </aside>
    </div>

    <div class="sh-tabs">
      <div class="sh-tabs-list"></div>
      <button class="sh-mini" data-act="sheet-add" title="${tt("Ajouter une feuille")}">${ICN.add}</button>
      <button class="sh-mini" data-act="chart-add" title="${tt("Ajouter une feuille graphique")}">${ICN.chart || ICN.rect}</button>
      <span class="sh-spacer"></span>
      <span class="sh-stats"></span>
      <span class="sh-status"></span>
    </div>
  </div>`;
}

// ── Câblage ─────────────────────────────────────────────────────────────────
function wire(win, st) {
  const body = win.body;
  st.refs = {
    win, body,
    grid: body.querySelector(".sh-grid"),
    wrap: body.querySelector(".sh-gridwrap"),
    editor: body.querySelector(".sh-editor"),
    formula: body.querySelector(".sh-formula"),
    cellref: body.querySelector(".sh-cellref"),
    tabs: body.querySelector(".sh-tabs-list"),
    side: body.querySelector(".sh-side-body"),
    stats: body.querySelector(".sh-stats"),
    status: body.querySelector(".sh-status"),
    title: body.querySelector(".sh-title"),
  };

  st.refs.title.addEventListener("input", () => {
    st.doc.title = st.refs.title.value;
    win.setTitle?.(st.doc.title ? `Calc — ${st.doc.title}` : "Calc");
  });

  body.querySelectorAll("[data-act]").forEach((el) => {
    if (el.tagName === "INPUT") el.addEventListener("input", () => runAction(st, el.dataset.act, el.value));
    else el.addEventListener("click", () => runAction(st, el.dataset.act));
  });
  body.querySelectorAll("[data-panel]").forEach((b) => b.addEventListener("click", () => {
    setPanel(st, b.dataset.panel);
    renderSide(st);
  }));

  // Barre de formule : Entrée valide et descend, Échap annule.
  st.refs.formula.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitCell(st, st.refs.formula.value); moveSel(st, 1, 0); st.refs.grid.focus(); }
    if (e.key === "Escape") { e.preventDefault(); syncFormulaBar(st); st.refs.grid.focus(); }
  });

  wireGrid(st);
  st.refs.grid.setAttribute("tabindex", "0");
  ensureLivingStyles();
  watchLiving(st);
}

const DOC_ACTIONS = new Set(["new", "open", "save", "import-csv", "undo", "redo", "sheet-add", "chart-add", "live"]);

function runAction(st, act, value) {
  const sh = sheet(st);
  // Une feuille graphique n'a pas de cellules : les actions de cellule y sont sans objet.
  if (isChartSheet(sh) && !DOC_ACTIONS.has(act)) return setStatus(st, tt("Cette feuille est un graphique : modifiez-la dans le volet Graphique."));
  const each = (fn) => { snapshot(st); forEachSelected(st, fn); renderAll(st); };
  switch (act) {
    case "chart-add": return addChartSheet(st, "bar");
    case "live": return openLiveSheet(st);
    case "ask-agent": {
      const f = st.refs.formula;
      f.value = "@";
      f.focus();
      return setStatus(st, tt("Tapez le nom d'un agent puis votre demande, et Entrée : sa réponse remplit la feuille à partir de cette cellule."));
    }
    case "new": return newDoc(st);
    case "open": return openPicker(st);
    case "save": return saveDoc(st);
    case "export-csv": return exportCsv(st);
    case "export-xlsx": return saveXlsx(st, true);
    case "import-csv": return importCsvPicker(st);
    case "undo": doUndo(st); return renderAll(st);
    case "redo": doRedo(st); return renderAll(st);
    case "copy": return copySelection(st);
    case "paste": return pasteClipboard(st);
    case "clear": return each((key) => { delete sh.cells[key]; });
    case "bold": return each((key) => toggleFmt(sh, key, "b"));
    case "italic": return each((key) => toggleFmt(sh, key, "i"));
    case "underline": return each((key) => toggleFmt(sh, key, "u"));
    case "fg": return each((key) => setFmt(sh, key, { fg: value }));
    case "bg": return each((key) => setFmt(sh, key, { bg: value }));
    case "style-reset": return each((key) => { delete sh.fmt[key]; });
    case "align-left": return each((key) => setFmt(sh, key, { a: "left" }));
    case "align-center": return each((key) => setFmt(sh, key, { a: "center" }));
    case "align-right": return each((key) => setFmt(sh, key, { a: "right" }));
    case "fmt-auto": return each((key) => setFmt(sh, key, { t: null }));
    case "fmt-currency": return each((key) => setFmt(sh, key, { t: "currency", d: 2 }));
    case "fmt-percent": return each((key) => setFmt(sh, key, { t: "percent", d: 1 }));
    case "fmt-date": return each((key) => setFmt(sh, key, { t: "date" }));
    case "dec-more": return each((key) => setFmt(sh, key, { d: Math.min(8, (fmtAt(sh, key)?.d ?? 2) + 1) }));
    case "dec-less": return each((key) => setFmt(sh, key, { d: Math.max(0, (fmtAt(sh, key)?.d ?? 2) - 1) }));
    case "row-add": return insertRow(st);
    case "row-del": return deleteRow(st);
    case "col-add": return insertCol(st);
    case "col-del": return deleteCol(st);
    case "sort-asc": return sortByColumn(st, true);
    case "sort-desc": return sortByColumn(st, false);
    case "autosum": return autoSum(st);
    case "sheet-add": {
      snapshot(st);
      st.doc.sheets.push(blankSheet(`${tt("Feuille")} ${st.doc.sheets.length + 1}`));
      st.doc.active = st.doc.sheets.length - 1;
      st.sel = { r: 0, c: 0, r2: 0, c2: 0 };
      return renderAll(st, true);
    }
    default: return undefined;
  }
}

function toggleFmt(sh, key, prop) {
  const f = sh.fmt[key] || (sh.fmt[key] = {});
  f[prop] = !f[prop];
}
function setFmt(sh, key, patch) {
  const f = sh.fmt[key] || (sh.fmt[key] = {});
  Object.assign(f, patch);
  if (patch.t === null) delete f.t;
}

// ── Sélection ───────────────────────────────────────────────────────────────
function selBounds(st) {
  const s = st.sel;
  return { r0: Math.min(s.r, s.r2), r1: Math.max(s.r, s.r2), c0: Math.min(s.c, s.c2), c1: Math.max(s.c, s.c2) };
}
function forEachSelected(st, fn) {
  const { r0, r1, c0, c1 } = selBounds(st);
  for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) fn(cellKey(r, c), r, c);
}
function moveSel(st, dr, dc, extend = false) {
  const sh = sheet(st);
  const r = Math.max(0, Math.min(sh.rows - 1, (extend ? st.sel.r2 : st.sel.r) + dr));
  const c = Math.max(0, Math.min(sh.cols - 1, (extend ? st.sel.c2 : st.sel.c) + dc));
  if (extend) { st.sel.r2 = r; st.sel.c2 = c; }
  else { st.sel = { r, c, r2: r, c2: c }; }
  renderSelection(st);
  scrollSelIntoView(st);
  syncFormulaBar(st);
}

// ── Rendu de la grille ──────────────────────────────────────────────────────
function renderAll(st, withSide = false) {
  st.evalr = createEvaluator((key) => rawAt(sheet(st), key));
  renderGrid(st);
  renderTabs(st);
  renderLiveBanner(st);
  if (withSide) renderSide(st);
  syncFormulaBar(st);
}

function displayValue(st, sh, key) {
  const raw = rawAt(sh, key);
  if (raw === "" || raw == null) return "";
  const v = st.evalr.valueOf(key);
  if (isFormulaError(v)) return v.err;
  const f = fmtAt(sh, key);
  const n = typeof v === "number" ? v : rawNumber(v);
  if (n == null) return toText(v);
  const d = f?.d;
  if (f?.t === "currency") return n.toLocaleString(undefined, { style: "currency", currency: "EUR", minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 });
  if (f?.t === "percent") return (n * 100).toLocaleString(undefined, { minimumFractionDigits: d ?? 1, maximumFractionDigits: d ?? 1 }) + " %";
  if (f?.t === "date") { const dt = new Date(toText(v)); return Number.isNaN(dt.getTime()) ? toText(v) : dt.toLocaleDateString(); }
  if (d != null) return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  return String(Math.round(n * 1e10) / 1e10);
}

function cellStyle(sh, key, isNum) {
  const f = fmtAt(sh, key);
  let s = "";
  if (f?.b) s += "font-weight:700;";
  if (f?.i) s += "font-style:italic;";
  if (f?.u) s += "text-decoration:underline;";
  if (f?.fg) s += `color:${f.fg};`;
  if (f?.bg) s += `background:${f.bg};`;
  s += `text-align:${f?.a || (isNum ? "right" : "left")};`;
  return s;
}

function renderGrid(st) {
  const sh = sheet(st);
  if (isChartSheet(sh)) {
    st.refs.grid.classList.add("is-chart");
    st.refs.stats.textContent = "";
    renderChartSheet(st, sh, st.refs.grid);
    return;
  }
  st.refs.grid.classList.remove("is-chart");
  st.chartInstance?.dispose(); st.chartResize?.disconnect(); st.chartInstance = null;
  const widths = [];
  for (let c = 0; c < sh.cols; c += 1) widths.push(sh.widths[c] || DEFAULT_W);

  let head = `<div class="sh-corner"></div>`;
  for (let c = 0; c < sh.cols; c += 1) {
    head += `<div class="sh-colh" data-c="${c}" style="width:${widths[c]}px">${colName(c)}<span class="sh-colgrip" data-grip="${c}"></span></div>`;
  }
  let rowsHtml = "";
  for (let r = 0; r < sh.rows; r += 1) {
    let cells = `<div class="sh-rowh" data-r="${r}">${r + 1}</div>`;
    for (let c = 0; c < sh.cols; c += 1) {
      const key = cellKey(r, c);
      const raw = rawAt(sh, key);
      const text = displayValue(st, sh, key);
      const isNum = raw !== "" && rawNumber(raw) != null || (typeof raw === "string" && raw.startsWith("=") && typeof st.evalr.valueOf(key) === "number");
      const errCls = text.startsWith("#") && raw !== "" && String(raw).startsWith("=") ? " sh-cell-err" : "";
      cells += `<div class="sh-cell${errCls}" data-r="${r}" data-c="${c}" style="width:${widths[c]}px;${cellStyle(sh, key, isNum)}">${escapeHtml(text)}</div>`;
    }
    rowsHtml += `<div class="sh-row" style="height:${ROW_H}px">${cells}</div>`;
  }
  st.refs.grid.innerHTML = `<div class="sh-head">${head}</div><div class="sh-rows">${rowsHtml}</div>`;
  renderSelection(st);
}

function renderSelection(st) {
  const { r0, r1, c0, c1 } = selBounds(st);
  const grid = st.refs.grid;
  grid.querySelectorAll(".sh-cell.sel, .sh-cell.anchor").forEach((el) => el.classList.remove("sel", "anchor"));
  grid.querySelectorAll(".sh-colh.hl, .sh-rowh.hl").forEach((el) => el.classList.remove("hl"));
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const el = grid.querySelector(`.sh-cell[data-r="${r}"][data-c="${c}"]`);
      if (el) el.classList.add("sel");
    }
    grid.querySelector(`.sh-rowh[data-r="${r}"]`)?.classList.add("hl");
  }
  for (let c = c0; c <= c1; c += 1) grid.querySelector(`.sh-colh[data-c="${c}"]`)?.classList.add("hl");
  grid.querySelector(`.sh-cell[data-r="${st.sel.r}"][data-c="${st.sel.c}"]`)?.classList.add("anchor");
  renderStats(st);
}

function renderStats(st) {
  const sh = sheet(st);
  if (isChartSheet(sh)) return;
  const vals = [];
  let count = 0;
  forEachSelected(st, (key) => {
    const raw = rawAt(sh, key);
    if (raw === "" || raw == null) return;
    count += 1;
    const v = st.evalr.valueOf(key);
    const n = typeof v === "number" ? v : rawNumber(v);
    if (n != null) vals.push(n);
  });
  const fmtN = (n) => (Math.round(n * 1e6) / 1e6).toLocaleString();
  st.refs.stats.textContent = vals.length
    ? `${tt("Somme")} ${fmtN(vals.reduce((a, b) => a + b, 0))} · ${tt("Moyenne")} ${fmtN(vals.reduce((a, b) => a + b, 0) / vals.length)} · ${tt("Nb")} ${count}`
    : count ? `${tt("Nb")} ${count}` : "";
}

function scrollSelIntoView(st) {
  const el = st.refs.grid.querySelector(`.sh-cell[data-r="${st.sel.r}"][data-c="${st.sel.c}"]`);
  el?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function syncFormulaBar(st) {
  const sh = sheet(st);
  const key = cellKey(st.sel.r, st.sel.c);
  st.refs.cellref.textContent = key;
  st.refs.formula.value = String(rawAt(sh, key) ?? "");
}

// ── Interactions de la grille ───────────────────────────────────────────────
function wireGrid(st) {
  const grid = st.refs.grid;

  grid.addEventListener("pointerdown", (e) => {
    // Un pointerdown non annulé lance la SÉLECTION DE TEXTE native du navigateur.
    // `.sh-grid` est bien en `user-select: none`, mais ça n'empêche pas la
    // sélection de s'ancrer juste à côté et de s'étendre au reste de la fenêtre
    // pendant qu'on glisse sur les cellules : on se retrouvait avec la barre de
    // formule, le ruban et les onglets surlignés en bleu par-dessus la sélection
    // de cellules. On annule donc le comportement par défaut (le focus du
    // quadrillage est donné explicitement plus bas) et on purge une éventuelle
    // sélection déjà en cours.
    if (e.button === 0) {
      e.preventDefault();
      const sel = st.refs.grid.ownerDocument.getSelection?.();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    }
    const grip = e.target.closest("[data-grip]");
    if (grip) { startColResize(st, Number(grip.dataset.grip), e); return; }
    const colh = e.target.closest(".sh-colh");
    if (colh) { const c = Number(colh.dataset.c); const sh = sheet(st); st.sel = { r: 0, c, r2: sh.rows - 1, c2: c }; renderSelection(st); syncFormulaBar(st); return; }
    const rowh = e.target.closest(".sh-rowh");
    if (rowh) { const r = Number(rowh.dataset.r); const sh = sheet(st); st.sel = { r, c: 0, r2: r, c2: sh.cols - 1 }; renderSelection(st); syncFormulaBar(st); return; }
    const cell = e.target.closest(".sh-cell");
    if (!cell) return;
    grid.focus();
    const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
    if (e.shiftKey) { st.sel.r2 = r; st.sel.c2 = c; }
    else st.sel = { r, c, r2: r, c2: c };
    renderSelection(st); syncFormulaBar(st);
    // Glisser pour étendre la sélection.
    const onMove = (ev) => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".sh-cell");
      if (!t) return;
      st.sel.r2 = Number(t.dataset.r); st.sel.c2 = Number(t.dataset.c);
      renderSelection(st);
    };
    const onUp = () => {
      document.body.classList.remove("sh-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    document.body.classList.add("sh-dragging");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  grid.addEventListener("dblclick", (e) => {
    const cell = e.target.closest(".sh-cell");
    if (cell) beginEdit(st, "");
  });

  grid.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo(st) : doUndo(st); return renderAll(st); }
    if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(st); return renderAll(st); }
    if (meta && e.key.toLowerCase() === "c") { e.preventDefault(); return copySelection(st); }
    if (meta && e.key.toLowerCase() === "x") { e.preventDefault(); copySelection(st); snapshot(st); forEachSelected(st, (k) => { delete sheet(st).cells[k]; }); return renderAll(st); }
    if (meta && e.key.toLowerCase() === "v") { e.preventDefault(); return pasteClipboard(st); }
    if (meta && e.key.toLowerCase() === "b") { e.preventDefault(); return runAction(st, "bold"); }
    if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); return saveDoc(st); }
    switch (e.key) {
      case "ArrowUp": e.preventDefault(); return moveSel(st, -1, 0, e.shiftKey);
      case "ArrowDown": e.preventDefault(); return moveSel(st, 1, 0, e.shiftKey);
      case "ArrowLeft": e.preventDefault(); return moveSel(st, 0, -1, e.shiftKey);
      case "ArrowRight": e.preventDefault(); return moveSel(st, 0, 1, e.shiftKey);
      case "Tab": e.preventDefault(); return moveSel(st, 0, e.shiftKey ? -1 : 1);
      case "Enter": e.preventDefault(); return beginEdit(st, "");
      case "F2": e.preventDefault(); return beginEdit(st, "");
      case "Backspace": case "Delete":
        e.preventDefault(); snapshot(st);
        forEachSelected(st, (k) => { delete sheet(st).cells[k]; });
        return renderAll(st);
      case "Home": e.preventDefault(); st.sel = { r: st.sel.r, c: 0, r2: st.sel.r, c2: 0 }; renderSelection(st); return syncFormulaBar(st);
      default: break;
    }
    // Une frappe imprimable ouvre l'édition, comme dans tout tableur.
    if (!meta && e.key.length === 1) { e.preventDefault(); beginEdit(st, e.key); }
  });
}

function beginEdit(st, seed) {
  const sh = sheet(st);
  const key = cellKey(st.sel.r, st.sel.c);
  const cell = st.refs.grid.querySelector(`.sh-cell[data-r="${st.sel.r}"][data-c="${st.sel.c}"]`);
  if (!cell) return;
  const editor = st.refs.editor;
  const gridRect = st.refs.wrap.getBoundingClientRect();
  const rect = cell.getBoundingClientRect();
  editor.hidden = false;
  editor.style.cssText = `left:${rect.left - gridRect.left + st.refs.wrap.scrollLeft}px;top:${rect.top - gridRect.top + st.refs.wrap.scrollTop}px;width:${rect.width}px;height:${rect.height}px;`;
  editor.value = seed || String(rawAt(sh, key) ?? "");
  editor.focus();
  if (!seed) editor.select();
  else editor.setSelectionRange(editor.value.length, editor.value.length);

  const finish = (commit, dr = 0, dc = 0) => {
    editor.hidden = true;
    editor.onkeydown = null; editor.onblur = null;
    if (commit) commitCell(st, editor.value);
    else renderAll(st);
    if (dr || dc) moveSel(st, dr, dc);
    st.refs.grid.focus();
  };
  editor.onkeydown = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true, 1, 0); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    else if (ev.key === "Tab") { ev.preventDefault(); finish(true, 0, ev.shiftKey ? -1 : 1); }
  };
  editor.onblur = () => { if (!editor.hidden) finish(true); };
}

function commitCell(st, value) {
  const sh = sheet(st);
  if (isChartSheet(sh)) return;
  const key = cellKey(st.sel.r, st.sel.c);
  const next = String(value ?? "");
  // « @Agent demande » : délégation (la cellule garde sa valeur si aucun agent
  // ne correspond — un « @ » ordinaire reste du texte).
  if (next.startsWith("@")) {
    const r = st.sel.r, c = st.sel.c;
    delegateCell(st, r, c, next).then((done) => { if (!done) { snapshot(st); sh.cells[key] = next; renderAll(st); } });
    return;
  }
  if (String(rawAt(sh, key) ?? "") === next) { renderAll(st); return; }
  snapshot(st);
  if (next === "") delete sh.cells[key];
  else sh.cells[key] = next;
  renderAll(st);
}

function startColResize(st, c, e) {
  e.preventDefault();
  const sh = sheet(st);
  const start = e.clientX;
  const w0 = sh.widths[c] || DEFAULT_W;
  const onMove = (ev) => {
    sh.widths[c] = Math.max(44, Math.round(w0 + (ev.clientX - start)));
    st.refs.grid.querySelectorAll(`[data-c="${c}"]`).forEach((el) => { el.style.width = sh.widths[c] + "px"; });
  };
  const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// ── Presse-papiers (TSV, compatible LibreOffice / Excel / Google Sheets) ────
function selectionToTsv(st) {
  const sh = sheet(st);
  const { r0, r1, c0, c1 } = selBounds(st);
  const lines = [];
  for (let r = r0; r <= r1; r += 1) {
    const row = [];
    for (let c = c0; c <= c1; c += 1) row.push(displayValue(st, sh, cellKey(r, c)));
    lines.push(row.join("\t"));
  }
  return lines.join("\n");
}
function copySelection(st) {
  const sh = sheet(st);
  const { r0, r1, c0, c1 } = selBounds(st);
  const cells = [];
  for (let r = r0; r <= r1; r += 1) {
    const row = [];
    for (let c = c0; c <= c1; c += 1) { const key = cellKey(r, c); row.push({ raw: rawAt(sh, key), fmt: fmtAt(sh, key) }); }
    cells.push(row);
  }
  st.clip = cells;
  st.clipOrigin = { r: r0, c: c0 };   // origine mémorisée : le collage décale les références relatives
  navigator.clipboard?.writeText(selectionToTsv(st)).catch(() => {});
  setStatus(st, tt("Copié"));
}
async function pasteClipboard(st) {
  const sh = sheet(st);
  snapshot(st);
  // Le presse-papiers interne conserve formules et formats ; le presse-papiers
  // système (venu d'un autre tableur) arrive en TSV.
  let block = st.clip;
  let origin = st.clipOrigin;
  if (!block) {
    const text = await navigator.clipboard?.readText().catch(() => "");
    if (!text) return;
    block = text.split(/\r?\n/).map((line) => line.split("\t").map((v) => ({ raw: v, fmt: null })));
    origin = null;   // venu d'un autre tableur : aucune référence à décaler
  }
  const { r0, c0 } = selBounds(st);
  const shiftR = origin ? r0 - origin.r : 0;
  const shiftC = origin ? c0 - origin.c : 0;
  block.forEach((row, dr) => row.forEach((cell, dc) => {
    const r = r0 + dr, c = c0 + dc;
    if (r >= sh.rows) sh.rows = r + 1;
    if (c >= sh.cols) sh.cols = c + 1;
    const key = cellKey(r, c);
    const raw = typeof cell.raw === "string" && cell.raw.startsWith("=") ? shiftFormula(cell.raw, shiftR, shiftC) : cell.raw;
    if (raw === "" || raw == null) delete sh.cells[key]; else sh.cells[key] = raw;
    if (cell.fmt) sh.fmt[key] = { ...cell.fmt }; else delete sh.fmt[key];
  }));
  renderAll(st);
}
// Décale les références relatives d'une formule (collage, recopie).
function shiftFormula(src, dr, dc) {
  if (!dr && !dc) return src;
  return String(src).replace(/(\$?)([A-Za-z]+)(\$?)(\d+)/g, (m, ac, col, ar, row) => {
    const c = ac ? colIndex(col) : colIndex(col) + dc;
    const r = ar ? parseInt(row, 10) - 1 : parseInt(row, 10) - 1 + dr;
    if (c < 0 || r < 0) return "#REF!";
    return `${ac}${colName(c)}${ar}${r + 1}`;
  });
}

// ── Lignes / colonnes ───────────────────────────────────────────────────────
// Insérer ou supprimer déplace les cellules ET leurs formats. Les formules ne
// sont volontairement PAS réécrites (comportement assumé, cf. README d'app) :
// un décalage silencieux de références fait plus de dégâts qu'un #REF! visible.
function remap(sh, fn) {
  const cells = {}, fmt = {};
  for (const [key, v] of Object.entries(sh.cells)) { const k = fn(key); if (k) cells[k] = v; }
  for (const [key, v] of Object.entries(sh.fmt)) { const k = fn(key); if (k) fmt[k] = v; }
  sh.cells = cells; sh.fmt = fmt;
}
function insertRow(st) {
  const sh = sheet(st); const at = selBounds(st).r0;
  snapshot(st);
  remap(sh, (key) => { const p = parseKey(key); return p.r >= at ? cellKey(p.r + 1, p.c) : key; });
  sh.rows += 1;
  renderAll(st);
}
function deleteRow(st) {
  const sh = sheet(st); const { r0, r1 } = selBounds(st); const n = r1 - r0 + 1;
  if (sh.rows - n < 1) return;
  snapshot(st);
  remap(sh, (key) => { const p = parseKey(key); if (p.r >= r0 && p.r <= r1) return null; return p.r > r1 ? cellKey(p.r - n, p.c) : key; });
  sh.rows -= n;
  clampSelection(st);
  renderAll(st);
}
function insertCol(st) {
  const sh = sheet(st); const at = selBounds(st).c0;
  snapshot(st);
  remap(sh, (key) => { const p = parseKey(key); return p.c >= at ? cellKey(p.r, p.c + 1) : key; });
  sh.cols += 1;
  renderAll(st);
}
function deleteCol(st) {
  const sh = sheet(st); const { c0, c1 } = selBounds(st); const n = c1 - c0 + 1;
  if (sh.cols - n < 1) return;
  snapshot(st);
  remap(sh, (key) => { const p = parseKey(key); if (p.c >= c0 && p.c <= c1) return null; return p.c > c1 ? cellKey(p.r, p.c - n) : key; });
  sh.cols -= n;
  clampSelection(st);
  renderAll(st);
}

// Tri de la plage utilisée sur la colonne active. La première ligne est
// considérée comme un en-tête si elle est du texte au-dessus de nombres.
function sortByColumn(st, asc) {
  const sh = sheet(st);
  const c = st.sel.c;
  const used = usedBounds(sh);
  if (!used) return;
  const headerRow = looksLikeHeader(st, sh, used);
  const first = used.r0 + (headerRow ? 1 : 0);
  snapshot(st);
  const rows = [];
  for (let r = first; r <= used.r1; r += 1) {
    const row = {};
    for (let cc = used.c0; cc <= used.c1; cc += 1) {
      const key = cellKey(r, cc);
      row[cc] = { raw: sh.cells[key], fmt: sh.fmt[key] };
    }
    rows.push(row);
  }
  const keyOf = (row) => {
    const raw = row[c]?.raw ?? "";
    const n = rawNumber(raw);
    return n == null ? String(raw).toLowerCase() : n;
  };
  rows.sort((a, b) => {
    const x = keyOf(a), y = keyOf(b);
    if (typeof x === "number" && typeof y === "number") return asc ? x - y : y - x;
    return asc ? String(x).localeCompare(String(y)) : String(y).localeCompare(String(x));
  });
  rows.forEach((row, i) => {
    const r = first + i;
    for (let cc = used.c0; cc <= used.c1; cc += 1) {
      const key = cellKey(r, cc);
      if (row[cc]?.raw == null || row[cc].raw === "") delete sh.cells[key]; else sh.cells[key] = row[cc].raw;
      if (row[cc]?.fmt) sh.fmt[key] = row[cc].fmt; else delete sh.fmt[key];
    }
  });
  renderAll(st);
  setStatus(st, `${tt("Trié sur la colonne")} ${colName(c)}`);
}

function usedBounds(sh) {
  let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1;
  for (const key of Object.keys(sh.cells)) {
    const p = parseKey(key);
    if (!p) continue;
    r0 = Math.min(r0, p.r); r1 = Math.max(r1, p.r);
    c0 = Math.min(c0, p.c); c1 = Math.max(c1, p.c);
  }
  return r1 < 0 ? null : { r0, r1, c0, c1 };
}
function looksLikeHeader(st, sh, used) {
  let textHead = 0, numBelow = 0;
  for (let c = used.c0; c <= used.c1; c += 1) {
    if (rawNumber(rawAt(sh, cellKey(used.r0, c))) == null && rawAt(sh, cellKey(used.r0, c)) !== "") textHead += 1;
    if (used.r1 > used.r0 && rawNumber(rawAt(sh, cellKey(used.r0 + 1, c))) != null) numBelow += 1;
  }
  return textHead > 0 && numBelow > 0;
}

// Σ : écrit une somme sous (ou à droite de) la plage sélectionnée.
function autoSum(st) {
  const sh = sheet(st);
  const { r0, r1, c0, c1 } = selBounds(st);
  snapshot(st);
  if (r0 === r1 && c0 === c1) {
    // Cellule seule : on remonte la colonne tant qu'elle contient des nombres.
    let r = r0 - 1;
    while (r >= 0 && rawAt(sh, cellKey(r, c0)) !== "") r -= 1;
    const start = r + 1;
    if (start > r0 - 1) { setStatus(st, tt("Rien à additionner au-dessus.")); return; }
    sh.cells[cellKey(r0, c0)] = `=SOMME(${cellKey(start, c0)}:${cellKey(r0 - 1, c0)})`;
  } else {
    for (let c = c0; c <= c1; c += 1) {
      const target = r1 + 1 < sh.rows ? cellKey(r1 + 1, c) : null;
      if (target) sh.cells[target] = `=SOMME(${cellKey(r0, c)}:${cellKey(r1, c)})`;
    }
  }
  renderAll(st);
}

// ── Onglets de feuilles ─────────────────────────────────────────────────────
function renderTabs(st) {
  const wrap = st.refs.tabs;
  wrap.innerHTML = "";
  st.doc.sheets.forEach((sh, i) => {
    const b = document.createElement("button");
    b.className = "sh-tab" + (i === st.doc.active ? " active" : "") + (isChartSheet(sh) ? " chart" : "");
    b.innerHTML = isChartSheet(sh) ? `${ICN.chart || ""}<span></span>` : "<span></span>";
    b.querySelector("span").textContent = sh.name;
    if (sh.source) { b.title = sheetSourceLabel(sh); b.classList.add("linked"); }
    b.addEventListener("click", () => {
      st.doc.active = i; st.sel = { r: 0, c: 0, r2: 0, c2: 0 };
      // Ouvrir un graphique ouvre son volet de réglages : c'est là que tout se passe.
      if (isChartSheet(sh)) setPanel(st, "chart");
      renderAll(st, true);
    });
    b.addEventListener("dblclick", async () => {
      const name = await promptSheet({ title: tt("Nom de la feuille"), value: sh.name, confirm: tt("Renommer"), cancel: tt("Annuler") });
      if (name) { snapshot(st); sh.name = name; renderTabs(st); }
    });
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (st.doc.sheets.length <= 1) return;
      snapshot(st);
      st.doc.sheets.splice(i, 1);
      st.doc.active = Math.max(0, st.doc.active - 1);
      renderAll(st);
    });
    wrap.appendChild(b);
  });
}
function sheetSourceLabel(sh) {
  if (!sh.source) return "";
  if (sh.source.kind === "table") return `${tt("Liée à la table")} « ${sh.source.name} »`;
  if (sh.source.kind === "query") return `${tt("Résultat de requête")} : ${sh.source.sql}`;
  return "";
}

function setStatus(st, msg) { st.refs.status.textContent = msg || ""; }

// ── Volet droit ─────────────────────────────────────────────────────────────
function setPanel(st, name) {
  st.panel = name;
  st.refs.body.querySelectorAll("[data-panel]").forEach((x) => x.classList.toggle("active", x.dataset.panel === name));
}

function renderSide(st) {
  if (st.panel === "chart") return renderChartPanel(st);
  if (st.panel === "ai") return renderAiPanel(st);
  return renderDataPanel(st);
}

function panelSection(title, hint, inner) {
  return `<div class="sh-sect"><div class="sh-sect-t">${escapeHtml(title)}</div>${hint ? `<p class="sh-hint">${escapeHtml(hint)}</p>` : ""}${inner}</div>`;
}

// Volet « Données » : c'est ici que Calc rejoint le hub Prisme.
function renderDataPanel(st) {
  const sh = sheet(st);
  const side = st.refs.side;
  side.innerHTML = [
    panelSection(tt("Bases de données"), tt("Charger une table locale dans une nouvelle feuille, ou renvoyer cette feuille vers une table."), `
      <button class="sh-wide" data-d="import-table">${ICN.table}<span>${tt("Importer une table…")}</span></button>
      <button class="sh-wide" data-d="push-table">${ICN.upload || ICN.save}<span>${tt("Envoyer cette feuille vers une base")}</span></button>
      ${sh.source ? `<div class="sh-linked">${escapeHtml(sheetSourceLabel(sh))}<button class="sh-mini" data-d="refresh">${ICN.refresh || "⟳"}</button></div>` : ""}`),
    panelSection(tt("Interroger"), tt("Une question en français, ou du SQL. Le résultat arrive dans une nouvelle feuille, en lecture seule."), `
      <select class="sh-base"></select>
      <textarea class="sh-question" rows="3" placeholder="${tt("Ex. : chiffre d'affaires par mois en 2026")}"></textarea>
      <div class="sh-row2">
        <button class="sh-wide primary" data-d="ask">${ICN.ai}<span>${tt("Demander")}</span></button>
        <button class="sh-wide" data-d="sql">${ICN.code}<span>SQL</span></button>
      </div>`),
    panelSection(tt("Analyse"), tt("Exporte la feuille en CSV dans la sandbox et ouvre l'onglet Analyse du hub Prisme."), `
      <button class="sh-wide" data-d="to-analysis">${ICN.chart || ICN.rect}<span>${tt("Ouvrir dans Analyse")}</span></button>`),
  ].join("");

  const baseSel = side.querySelector(".sh-base");
  loadBases(baseSel);
  side.querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => {
    const q = side.querySelector(".sh-question")?.value?.trim() || "";
    const baseId = baseSel?.value || "";
    switch (b.dataset.d) {
      case "import-table": return importTable(st);
      case "push-table": return pushToTable(st);
      case "refresh": return refreshSheetSource(st);
      case "ask": return askData(st, baseId, q, false);
      case "sql": return askData(st, baseId, q, true);
      case "to-analysis": return sendToAnalysis(st);
      default: return undefined;
    }
  }));
}

async function loadBases(select) {
  if (!select) return;
  if (!tablesDb.hasBackend) { select.innerHTML = `<option>${tt("Bases indisponibles")}</option>`; select.disabled = true; return; }
  const bases = await tablesDb.listBases().catch(() => []);
  select.innerHTML = bases.length
    ? bases.map((b) => `<option value="${escapeHtml(b.base_id)}">${escapeHtml(b.name)}</option>`).join("")
    : `<option value="">${tt("Aucune base")}</option>`;
}

async function pickFromList(title, items) {
  ctx.closeWindow("sh-picker");
  return new Promise((resolve) => {
    const win = ctx.createWindow({ id: "sh-picker", title, w: 460, h: 460, x: 260, y: 130 });
    if (!win) return resolve(null);
    win.body.innerHTML = `<div class="sh-picker"></div>`;
    const list = win.body.querySelector(".sh-picker");
    if (!items.length) { list.innerHTML = `<div class="sh-picker-empty">${tt("Rien à afficher.")}</div>`; return; }
    items.forEach((it) => {
      const b = document.createElement("button");
      b.className = "sh-picker-row";
      b.innerHTML = `<b>${escapeHtml(it.label)}</b>${it.sub ? `<small>${escapeHtml(it.sub)}</small>` : ""}`;
      b.addEventListener("click", () => { ctx.closeWindow("sh-picker"); resolve(it); });
      list.appendChild(b);
    });
  });
}

async function importTable(st) {
  if (!tablesDb.hasBackend) return setStatus(st, tt("Bases de données indisponibles"));
  setStatus(st, tt("Lecture des bases…"));
  const items = [];
  for (const b of await tablesDb.listBases().catch(() => [])) {
    for (const t of await tablesDb.listTables(b.base_id).catch(() => [])) {
      items.push({ label: `${b.name} / ${t.name}`, sub: `${t.rows ?? "?"} ${tt("lignes")}`, table_id: t.table_id, name: t.name, base_id: b.base_id });
    }
  }
  const pick = await pickFromList(tt("Importer une table"), items);
  if (!pick) return setStatus(st, "");
  const csv = await tablesDb.exportCsv(pick.table_id).catch(() => "");
  if (!csv) return setStatus(st, tt("Table vide ou illisible."));
  snapshot(st);
  const sh = blankSheet(pick.name.slice(0, 28));
  fillSheetFromRows(sh, parseDelimited(csv, ","));
  sh.source = { kind: "table", table_id: pick.table_id, base_id: pick.base_id, name: pick.name };
  st.doc.sheets.push(sh);
  st.doc.active = st.doc.sheets.length - 1;
  st.sel = { r: 0, c: 0, r2: 0, c2: 0 };
  renderAll(st, true);
  setStatus(st, `${tt("Table importée")} : ${pick.name}`);
}

async function refreshSheetSource(st) {
  const sh = sheet(st);
  if (!sh.source) return;
  setStatus(st, tt("Actualisation…"));
  try {
    snapshot(st);
    if (sh.source.kind === "table") {
      const csv = await tablesDb.exportCsv(sh.source.table_id);
      sh.cells = {}; sh.fmt = {};
      fillSheetFromRows(sh, parseDelimited(csv, ","));
    } else if (sh.source.kind === "query") {
      const res = await tablesDb.query(sh.source.base_id, sh.source.sql);
      sh.cells = {}; sh.fmt = {};
      fillSheetFromRows(sh, [res.columns || [], ...(res.rows || [])]);
    }
    renderAll(st, true);
    setStatus(st, tt("Actualisé ✓"));
  } catch (e) { setStatus(st, tt("Échec :") + " " + (e?.message || e)); }
}

async function askData(st, baseId, question, isSql) {
  if (!tablesDb.hasBackend) return setStatus(st, tt("Bases de données indisponibles"));
  if (!baseId) return setStatus(st, tt("Choisis une base."));
  if (!question) return setStatus(st, tt("Écris une question ou une requête."));
  setStatus(st, isSql ? tt("Requête…") : tt("Traduction en SQL…"));
  try {
    const res = isSql
      ? { sql: question, ...(await tablesDb.query(baseId, question)) }
      : await tablesDb.askAi(baseId, question);
    snapshot(st);
    const sh = blankSheet(tt("Requête") + " " + (st.doc.sheets.length + 1));
    fillSheetFromRows(sh, [res.columns || [], ...(res.rows || [])]);
    for (let c = 0; c < (res.columns || []).length; c += 1) sh.fmt[cellKey(0, c)] = { b: true };
    sh.source = { kind: "query", base_id: baseId, sql: res.sql };
    st.doc.sheets.push(sh);
    st.doc.active = st.doc.sheets.length - 1;
    st.sel = { r: 0, c: 0, r2: 0, c2: 0 };
    renderAll(st, true);
    setStatus(st, `${(res.rows || []).length} ${tt("ligne(s)")} — ${res.sql}`);
  } catch (e) { setStatus(st, tt("Échec :") + " " + (e?.message || e)); }
}

async function pushToTable(st) {
  if (!tablesDb.hasBackend) return setStatus(st, tt("Bases de données indisponibles"));
  const bases = await tablesDb.listBases().catch(() => []);
  const pick = await pickFromList(tt("Base de destination"), bases.map((b) => ({ label: b.name, base_id: b.base_id })));
  if (!pick) return;
  const name = (await promptSheet({ title: tt("Nom de la nouvelle table"), value: sheet(st).name, confirm: tt("Créer"), cancel: tt("Annuler") })) || sheet(st).name;
  setStatus(st, tt("Envoi…"));
  try {
    await tablesDb.importCsv(pick.base_id, name, sheetToCsv(st, sheet(st)));
    setStatus(st, `${tt("Table créée")} : ${name}`);
  } catch (e) { setStatus(st, tt("Échec :") + " " + (e?.message || e)); }
}

async function sendToAnalysis(st) {
  const sb = ctx.getCurrent();
  if (!sb) return setStatus(st, tt("Aucune sandbox active"));
  const name = safeName(sheet(st).name || st.doc.title || "feuille") + ".csv";
  try {
    await invoke("sandbox_write_file", { id: sb.id, path: name, content: sheetToCsv(st, sheet(st)) });
    ctx.requestSandboxRefresh();
    setStatus(st, `${tt("CSV écrit")} : ${name}`);
    ctx.openHub?.("prisme", "analysis");
  } catch (e) { setStatus(st, tt("Échec :") + " " + (e?.message || e)); }
}

// Volet « Graphique » : ECharts est vendorisé, on ne le charge qu'à l'ouverture
// du volet (le module pèse lourd, l'import est différé).
// Volet « Graphique » : sur une feuille de données, on en crée un ; sur une
// feuille graphique, on le règle (source, champs, agrégations, champs calculés).
function renderChartPanel(st) {
  const sh = sheet(st);
  const side = st.refs.side;
  if (!isChartSheet(sh)) return renderChartCreate(st, side, { onCreate: (type) => addChartSheet(st, type) });
  renderChartConfig(st, sh, side, {
    onChange: (rebuildPanel) => {
      snapshot(st);
      renderGrid(st);
      if (rebuildPanel) renderSide(st);
    },
    onExport: () => exportChartPng(st),
  });
}

/**
 * Crée une feuille graphique à partir de la feuille de données active. La
 * sélection courante (si elle couvre plus d'une cellule) devient la plage ;
 * sinon toute la feuille. La configuration initiale est devinée : première
 * colonne texte = catégorie, colonnes numériques = séries.
 */
function addChartSheet(st, type = "bar") {
  const src = isChartSheet(sheet(st)) ? st.doc.sheets.find((x) => !isChartSheet(x)) : sheet(st);
  if (!src) return setStatus(st, tt("Ajoutez d'abord une feuille de données."));
  const { r0, r1, c0, c1 } = selBounds(st);
  const range = !isChartSheet(sheet(st)) && (r0 !== r1 || c0 !== c1) ? { r0, r1, c0, c1 } : null;
  snapshot(st);
  const n = st.doc.sheets.filter(isChartSheet).length + 1;
  const ch = blankChartSheet(`${tt("Graphique")} ${n}`, src.name, range);
  ch.chart.type = type;
  autoConfigure(st.doc, ch.chart);
  st.doc.sheets.push(ch);
  st.doc.active = st.doc.sheets.length - 1;
  st.sel = { r: 0, c: 0, r2: 0, c2: 0 };
  setPanel(st, "chart");
  renderAll(st, true);
  setStatus(st, tt("Feuille graphique créée : réglez-la dans le volet de droite."));
}

async function exportChartPng(st) {
  const sb = ctx.getCurrent();
  if (!sb) return setStatus(st, tt("Aucune sandbox active"));
  const url = chartPng(st);
  if (!url) return setStatus(st, tt("Aucun graphique à exporter."));
  // `sandbox_import_file` prend du base64 : c'est la commande d'écriture binaire
  // exposée à la WebView (sandbox_write_binary n'est qu'un helper Rust interne).
  const path = `${safeName(sheet(st).name || "graphique")}.png`;
  try {
    await invoke("sandbox_import_file", { id: sb.id, path, dataB64: url.split(",")[1] });
    ctx.requestSandboxRefresh();
    setStatus(st, `${tt("Exporté")} : ${path}`);
  } catch (e) { setStatus(st, tt("Échec :") + " " + (e?.message || e)); }
}

function selectionMatrix(st) {
  const sh = sheet(st);
  const { r0, r1, c0, c1 } = selBounds(st);
  const out = [];
  for (let r = r0; r <= r1; r += 1) {
    const row = [];
    for (let c = c0; c <= c1; c += 1) {
      const v = st.evalr.valueOf(cellKey(r, c));
      row.push(isFormulaError(v) ? "" : v);
    }
    out.push(row);
  }
  return out;
}

// Volet « IA » : produire une formule, ou expliquer/analyser la sélection.
function renderAiPanel(st) {
  const side = st.refs.side;
  side.innerHTML = panelSection(tt("Assistant"), tt("Décris le calcul voulu : la formule est écrite dans la cellule active."), `
    <textarea class="sh-question" rows="3" placeholder="${tt("Ex. : moyenne des ventes de B2 à B20, arrondie à 2 décimales")}"></textarea>
    <div class="sh-row2">
      <button class="sh-wide primary" data-a="formula">${ICN.ai}<span>${tt("Écrire la formule")}</span></button>
      <button class="sh-wide" data-a="explain">${tt("Analyser")}</button>
    </div>
    <div class="sh-ai-out"></div>`);
  const out = side.querySelector(".sh-ai-out");
  side.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", async () => {
    const q = side.querySelector(".sh-question").value.trim();
    if (!q && b.dataset.a === "formula") { out.textContent = tt("Décris d'abord le calcul."); return; }
    out.textContent = tt("Réflexion…");
    try {
      if (b.dataset.a === "formula") {
        const { messages, opts } = CALC_PROMPTS["app.calc.formula"].build({ request: q, cell: cellKey(st.sel.r, st.sel.c), preview: previewSheet(st, 12), functions: FUNCTION_NAMES.join(", ") });
        const { content } = await llmChat(messages, { ...opts, rawSystem: true });
        let f = "";
        try { f = String(JSON.parse(content).formule || "").trim(); }
        catch { f = (String(content).match(/=[^\n"]+/) || [""])[0].trim(); }
        if (!f.startsWith("=")) { out.textContent = tt("Réponse IA illisible."); return; }
        commitCell(st, f);
        out.textContent = f;
      } else {
        const { messages } = CALC_PROMPTS["app.calc.analyze"].build({ tsv: matrixToTsv(selectionMatrix(st)), question: q, lang: replyLang() });
        const { content } = await llmChat(messages, { rawSystem: true, onDelta: (txt) => { if (txt) out.textContent = txt; } });
        out.textContent = content || "";
      }
    } catch (e) { out.textContent = tt("Échec :") + " " + (e?.message || e); }
  }));
}
function previewSheet(st, maxRows) {
  const sh = sheet(st);
  const used = usedBounds(sh);
  if (!used) return "(feuille vide)";
  const lines = [];
  for (let r = used.r0; r <= Math.min(used.r1, used.r0 + maxRows - 1); r += 1) {
    const row = [];
    for (let c = used.c0; c <= used.c1; c += 1) row.push(`${cellKey(r, c)}=${displayValue(st, sh, cellKey(r, c))}`);
    lines.push(row.join(" | "));
  }
  return lines.join("\n");
}
const matrixToTsv = (m) => m.map((r) => r.map(toText).join("\t")).join("\n");

// ── CSV ─────────────────────────────────────────────────────────────────────
function parseDelimited(text, sep) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (ch === "\r") continue;
    field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function fillSheetFromRows(sh, rows) {
  sh.rows = Math.max(DEFAULT_ROWS, rows.length + 6);
  sh.cols = Math.max(DEFAULT_COLS, Math.max(0, ...rows.map((r) => r.length)) + 2);
  rows.forEach((row, r) => row.forEach((v, c) => {
    // Une valeur importée qui commence par « = » resterait interprétée comme
    // une formule : on la neutralise, l'import n'est pas une saisie.
    const val = typeof v === "string" && v.startsWith("=") ? `'${v}` : v;
    if (val !== "" && val != null) sh.cells[cellKey(r, c)] = String(val);
  }));
}
function sheetToCsv(st, sh) {
  const used = usedBounds(sh);
  if (!used) return "";
  const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [];
  for (let r = used.r0; r <= used.r1; r += 1) {
    const row = [];
    for (let c = used.c0; c <= used.c1; c += 1) row.push(esc(displayValue(st, sh, cellKey(r, c))));
    lines.push(row.join(","));
  }
  return lines.join("\n");
}
const safeName = (s) => String(s).replace(/[^\p{L}\p{N}_ -]+/gu, "").trim().replace(/\s+/g, "_") || "classeur";

// ── Fichiers ────────────────────────────────────────────────────────────────
function newDoc(st) {
  snapshot(st);
  st.doc = blankDoc();
  st.path = "";
  st.sel = { r: 0, c: 0, r2: 0, c2: 0 };
  st.refs.title.value = st.doc.title;
  renderAll(st, true);
  setStatus(st, tt("Nouveau classeur"));
}

/// Octets .xlsx du classeur : chaque formule emporte sa valeur calculée.
async function xlsxBytes(st) {
  const { sheetsToXlsx } = await import("../lib/office/xlsx.js");
  const evals = new Map();
  const valueOf = (si, key) => {
    if (!evals.has(si)) evals.set(si, createEvaluator((k) => rawAt(st.doc.sheets[si], k)));
    const v = evals.get(si).valueOf(key);
    return isFormulaError(v) ? undefined : v;
  };
  return sheetsToXlsx(st.doc, valueOf);
}

async function saveXlsx(st, asCopy) {
  const sb = st.sandboxId ? { id: st.sandboxId } : ctx.getCurrent();
  if (!sb) return setStatus(st, tt("Aucune sandbox active"));
  const path = !asCopy && st.path && fileExt(st.path) === "xlsx" ? st.path : `${safeName(st.doc.title)}.xlsx`;
  setStatus(st, tt("Conversion…"));
  try {
    await writeSandboxBytes(invoke, sb.id, path, await xlsxBytes(st));
    ctx.requestSandboxRefresh();
    setStatus(st, `${tt(asCopy ? "Exporté" : "Enregistré ✓")} ${path}`);
  } catch (e) { setStatus(st, tt("Échec :") + " " + (e?.message || e)); }
}

async function saveDoc(st) {
  if (st.format === "xlsx") return saveXlsx(st, false);
  // Le classeur se réenregistre dans SA sandbox (ouvert depuis la recherche ou
  // une note, ce n'est pas forcément la sandbox active).
  const sb = st.sandboxId ? { id: st.sandboxId } : ctx.getCurrent();
  if (!sb) return setStatus(st, tt("Aucune sandbox active"));
  const path = st.path || `${safeName(st.doc.title)}.lumensheet`;
  try {
    await invoke("sandbox_write_file", { id: sb.id, path, content: JSON.stringify({ kind: "sheet", title: st.doc.title, doc: st.doc, updatedAt: Date.now() }, null, 2) });
    st.path = path;
    st.sandboxId = sb.id;
    ctx.requestSandboxRefresh();
    setStatus(st, tt("Enregistré ✓") + " " + path);
  } catch (e) { setStatus(st, tt("Échec :") + " " + (e?.message || e)); }
}

async function exportCsv(st) {
  const sb = ctx.getCurrent();
  if (!sb) return setStatus(st, tt("Aucune sandbox active"));
  if (isChartSheet(sheet(st))) return exportChartPng(st);
  const name = `${safeName(sheet(st).name || st.doc.title)}.csv`;
  try {
    await invoke("sandbox_write_file", { id: sb.id, path: name, content: sheetToCsv(st, sheet(st)) });
    ctx.requestSandboxRefresh();
    setStatus(st, `${tt("Exporté")} : ${name}`);
  } catch (e) { setStatus(st, tt("Échec :") + " " + (e?.message || e)); }
}

async function listFiles(sandboxId, exts) {
  const out = [];
  async function walk(path, depth) {
    let list;
    try { list = await invoke("sandbox_read_dir", { id: sandboxId, path }); } catch { return; }
    for (const e of list) {
      if (e.is_dir) { if (depth < 4) await walk(e.path, depth + 1); }
      else if (exts.includes(fileExt(e.name))) out.push(e);
    }
  }
  await walk("", 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function openPicker(st) {
  const sb = ctx.getCurrent();
  if (!sb) return setStatus(st, tt("Aucune sandbox active"));
  const files = await listFiles(sb.id, ["lumensheet"]);
  const pick = await pickFromList(tt("Ouvrir un classeur"), files.map((f) => ({ label: f.name, sub: f.path, path: f.path })));
  if (pick) openSheetsFile(pick.path, sb.id);
}

async function importCsvPicker(st) {
  const sb = ctx.getCurrent();
  if (!sb) return setStatus(st, tt("Aucune sandbox active"));
  const files = await listFiles(sb.id, ["csv", "tsv"]);
  const pick = await pickFromList(tt("Importer un CSV"), files.map((f) => ({ label: f.name, sub: f.path, path: f.path, name: f.name })));
  if (!pick) return;
  const file = await invoke("sandbox_read_file", { id: sb.id, path: pick.path }).catch(() => null);
  if (!file || file.binary) return setStatus(st, tt("Fichier illisible."));
  snapshot(st);
  const sh = blankSheet(baseName(pick.path).slice(0, 28));
  fillSheetFromRows(sh, parseDelimited(file.content || "", fileExt(pick.path) === "tsv" ? "\t" : ","));
  st.doc.sheets.push(sh);
  st.doc.active = st.doc.sheets.length - 1;
  st.sel = { r: 0, c: 0, r2: 0, c2: 0 };
  renderAll(st, true);
  setStatus(st, `${tt("Importé")} : ${pick.name}`);
}

// ── Feuilles vivantes & @agents ────────────────────────────────────────────
// Une feuille peut être tenue à jour par un agent (src-tauri/src/living.rs :
// le moteur réécrit la feuille dans le fichier, même Calc fermé). Et une
// cellule qui commence par « @Agent demande » confie la suite à l'agent : sa
// réponse (un tableau) est posée à partir de cette cellule.
const sheetSandbox = (st) => st.sandboxId || ctx.getCurrent()?.id || "";

async function openLiveSheet(st) {
  const sh = sheet(st);
  if (isChartSheet(sh)) return setStatus(st, tt("Choisissez une feuille de données."));
  if (st.format === "xlsx") return setStatus(st, tt("Enregistrez d'abord le classeur au format Calc (.lumensheet)."));
  if (!st.path) await saveDoc(st);
  if (!st.path) return;
  const base = { kind: "sheet", sandbox_id: sheetSandbox(st), path: st.path, target: sh.name, title: sh.name };
  const existing = sh.live?.id ? (await listLiving()).find((b) => b.id === sh.live.id) : null;
  let block;
  try { block = await openLivingDialog(base, existing); } catch (e) { return setStatus(st, String(e?.message || e)); }
  if (!block) return;
  if (block.deleted) { delete sh.live; await saveDoc(st); return renderLiveBanner(st, true); }
  sh.live = { id: block.id };
  await saveDoc(st);
  renderLiveBanner(st, true);
  if (block.runNow) runLiving(block.id).catch((e) => setStatus(st, String(e?.message || e)));
}

async function renderLiveBanner(st, force = false) {
  const host = st.refs.body?.querySelector(".sh-live");
  if (!host) return;
  const sh = sheet(st);
  const key = `${sh?.name}|${sh?.live?.id || ""}`;
  if (!force && st.liveKey === key) return;
  st.liveKey = key;
  if (!sh?.live?.id) { host.hidden = true; host.innerHTML = ""; return; }
  const [blocks, agents] = await Promise.all([listLiving(), listAgents()]);
  host.innerHTML = livingCardHTML(blocks.find((b) => b.id === sh.live.id), agents);
  host.hidden = false;
  wireLivingCards(host, {
    onEdit: () => openLiveSheet(st),
    onDone: (_, ok, err) => setStatus(st, ok ? tt("Feuille mise à jour ✓") : `${tt("Échec :")} ${err?.message || err}`),
  });
}

// Relit le fichier quand le moteur vient d'y écrire (planifié ou manuel).
function watchLiving(st) {
  const off = onLivingUpdated(async (p) => {
    if (!st.refs.body?.isConnected) { off(); return; }
    const sh = sheet(st);
    if (p.path && p.path === st.path && p.ok) {
      const file = await invoke("sandbox_read_file", { id: sheetSandbox(st), path: st.path }).catch(() => null);
      try {
        const data = JSON.parse(file?.content || "{}");
        if (data.doc?.sheets) {
          const active = st.doc.active;
          st.doc = data.doc;
          st.doc.active = Math.min(active, st.doc.sheets.length - 1);
          renderAll(st, true);
          setStatus(st, tt("Feuille mise à jour par l'agent ✓"));
        }
      } catch { /* fichier en cours d'écriture : la prochaine notification suffira */ }
    }
    if (sh?.live?.id && (!p.id || p.id === sh.live.id)) renderLiveBanner(st, true);
  });
}

function sheetMarkdown(st, markR, markC) {
  const sh = sheet(st);
  let maxR = 0, maxC = 0;
  for (const key of Object.keys(sh.cells)) { const { r, c } = parseKey(key) || {}; if (r != null) { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); } }
  maxR = Math.min(Math.max(maxR, markR), 60); maxC = Math.min(Math.max(maxC, markC), 14);
  const rows = [];
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) row.push(r === markR && c === markC ? "⟦ICI⟧" : displayValue(st, sh, cellKey(r, c)).replace(/\|/g, "/"));
    rows.push(`| ${row.join(" | ")} |`);
    if (r === 0) rows.push(`|${" --- |".repeat(maxC + 1)}`);
  }
  return rows.join("\n");
}

async function delegateCell(st, r, c, text) {
  const hit = matchAgentMention(text, await listAgents());
  if (!hit) return false;
  const sh = sheet(st);
  const key = cellKey(r, c);
  snapshot(st);
  sh.cells[key] = `⏳ ${hit.agent.name}…`;
  renderAll(st);
  setStatus(st, tt("{name} remplit la feuille…", { name: hit.agent.name }));
  try {
    const out = await delegateToAgent({ agent: hit.agent, request: hit.request, title: `${st.doc.title} › ${sh.name}`, context: sheetMarkdown(st, r, c), format: "table" });
    const rows = await invoke("living_parse_table", { text: out });
    if (rows.length) {
      rows.forEach((row, i) => row.forEach((v, j) => {
        const k = cellKey(r + i, c + j);
        if (v === "" || v == null) delete sh.cells[k]; else sh.cells[k] = v;
      }));
    } else {
      sh.cells[key] = out.replace(/\s+/g, " ").slice(0, 500);
    }
    setStatus(st, tt("{name} a répondu ✓", { name: hit.agent.name }));
  } catch (e) {
    sh.cells[key] = text;
    setStatus(st, `${hit.agent.name} : ${e?.message || e}`);
  }
  renderAll(st);
  return true;
}
