// Calc — feuilles graphiques.
//
// Un graphique n'est pas une image collée dans le volet : c'est une FEUILLE du
// classeur, dédiée, qui se recalcule à partir d'une feuille de données. Sa
// configuration (source, champs, agrégations, champs calculés, type) est
// enregistrée dans le .lumensheet ; le tracé, lui, est refait à l'ouverture.
// Modifier la feuille de données met le graphique à jour au prochain affichage.
//
// Le modèle :
//   { name, kind: "chart", chart: {
//       title, type: bar|hbar|line|area|pie|donut|scatter,
//       source: <nom de la feuille de données>, range: {r0,r1,c0,c1}|null,
//       header: true, category: <champ>, series: [{ field, agg, label }],
//       computed: [{ name, expression }], groupBy: true, sort: none|asc|desc,
//       topN: 0, stacked: false, labels: false, smooth: true } }
//
// Les agrégations et le langage de formule (colonnes entre crochets, quatre
// opérations, comparaisons, fonctions) sont ceux du moteur ETL : une même
// syntaxe partout où Lumen calcule une colonne.

import { escapeHtml } from "./render.js";
import { tt } from "../apps-i18n.js";
import { icon as lumenIcon } from "../lib/icons.js";
import { cellKey, colName, createEvaluator, toText, rawNumber, isFormulaError, parseKey } from "./sheets-formula.js";
import { AGGREGATES, evalExpression, EXPRESSION_HELP, isBlank, num } from "../etl/pipeline.js";

const CHART_TYPES = [
  ["bar", "Barres"], ["hbar", "Barres horizontales"], ["line", "Courbes"], ["area", "Aires"],
  ["pie", "Secteurs"], ["donut", "Anneau"], ["scatter", "Nuage de points"],
];
/** Agrégations proposées : celles du moteur ETL, plus « aucune » (valeurs brutes). */
const AGG_OPTIONS = [["none", "aucune (valeurs brutes)"], ...Object.entries(AGGREGATES).map(([k, a]) => [k, a.label])];

export const isChartSheet = (sh) => sh?.kind === "chart";

/** Une feuille graphique neuve, branchée sur `sourceName` et une plage. */
export function blankChartSheet(name, sourceName, range = null) {
  return {
    name, kind: "chart", cells: {}, fmt: {}, widths: {}, cols: 0, rows: 0, source: null,
    chart: {
      title: "", type: "bar", source: sourceName, range, header: true,
      category: "", series: [], computed: [], groupBy: true, sort: "none", topN: 0,
      stacked: false, labels: false, smooth: true, legend: true,
    },
  };
}

// ── Lecture de la feuille de données ────────────────────────────────────────

function usedBounds(sh) {
  let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1;
  for (const key of Object.keys(sh.cells || {})) {
    const p = parseKey(key);
    if (!p) continue;
    r0 = Math.min(r0, p.r); r1 = Math.max(r1, p.r);
    c0 = Math.min(c0, p.c); c1 = Math.max(c1, p.c);
  }
  return r1 < 0 ? null : { r0, r1, c0, c1 };
}

/**
 * Lit la feuille source en lignes-objets : { fields, rows, warnings }.
 * Les valeurs passent par l'évaluateur de formules de cette feuille — un
 * graphique sur une colonne de =SOMME() voit les résultats, pas les formules.
 */
export function readSourceRows(doc, cfg) {
  const sh = (doc.sheets || []).find((s) => s.name === cfg.source && !isChartSheet(s));
  if (!sh) return { fields: [], rows: [], warnings: [tt("Feuille source introuvable :") + " " + (cfg.source || "—")] };
  const b = cfg.range || usedBounds(sh);
  if (!b) return { fields: [], rows: [], warnings: [tt("La feuille source est vide.")] };
  const evalr = createEvaluator((key) => sh.cells[key] ?? "");
  const cell = (r, c) => { const v = evalr.valueOf(cellKey(r, c)); return isFormulaError(v) ? null : (v === "" ? null : v); };
  const fields = [];
  for (let c = b.c0; c <= b.c1; c += 1) {
    const head = cfg.header ? toText(cell(b.r0, c) ?? "").trim() : "";
    fields.push(head || colName(c));
  }
  // Doublons d'en-tête : « Total » et « Total » deviendraient un seul champ.
  const seen = new Map();
  for (let i = 0; i < fields.length; i += 1) {
    const n = seen.get(fields[i]) || 0;
    seen.set(fields[i], n + 1);
    if (n) fields[i] = `${fields[i]} (${n + 1})`;
  }
  const rows = [];
  for (let r = cfg.header ? b.r0 + 1 : b.r0; r <= b.r1; r += 1) {
    const row = {};
    let empty = true;
    for (let c = b.c0; c <= b.c1; c += 1) {
      const v = cell(r, c);
      if (v !== null && v !== "") empty = false;
      row[fields[c - b.c0]] = v;
    }
    if (!empty) rows.push(row);
  }
  const warnings = [];
  // Champs calculés : évalués ligne par ligne, disponibles ensuite comme les autres.
  for (const cf of cfg.computed || []) {
    if (!cf.name || !cf.expression) continue;
    let failed = 0;
    for (const row of rows) {
      try { row[cf.name] = evalExpression(cf.expression, row); } catch { row[cf.name] = null; failed += 1; }
    }
    if (!fields.includes(cf.name)) fields.push(cf.name);
    if (failed === rows.length && rows.length) warnings.push(`${tt("Champ calculé illisible :")} ${cf.name}`);
  }
  return { fields, rows, warnings };
}

// ── Préparation des séries ──────────────────────────────────────────────────

/**
 * Transforme les lignes en { categories, series: [{ name, values }] } selon la
 * configuration : regroupement par catégorie et agrégation, ou valeurs brutes.
 */
export function buildChartData(doc, cfg) {
  const { fields, rows, warnings } = readSourceRows(doc, cfg);
  const series = (cfg.series || []).filter((s) => s.field && fields.includes(s.field));
  if (!rows.length) return { categories: [], series: [], warnings, fields };
  const catField = cfg.category && fields.includes(cfg.category) ? cfg.category : null;
  let categories, out;

  if (cfg.groupBy && catField) {
    const groups = new Map();
    for (const row of rows) {
      const key = isBlank(row[catField]) ? tt("(vide)") : toText(row[catField]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    categories = [...groups.keys()];
    out = series.map((s) => {
      const agg = AGGREGATES[s.agg] || AGGREGATES.sum;
      return {
        name: s.label || `${agg.label} ${tt("de")} ${s.field}`,
        values: categories.map((k) => { const v = agg.run(groups.get(k).map((r) => r[s.field])); const n = num(v); return Number.isFinite(n) ? n : null; }),
      };
    });
  } else {
    categories = rows.map((r, i) => (catField ? toText(r[catField] ?? "") : String(i + 1)));
    out = series.map((s) => ({
      name: s.label || s.field,
      values: rows.map((r) => { const n = num(r[s.field]); return Number.isFinite(n) ? n : null; }),
    }));
  }

  // Tri et top N, sur la première série : c'est celle qu'on lit en premier.
  if ((cfg.sort === "asc" || cfg.sort === "desc") && out.length) {
    const idx = categories.map((_, i) => i).sort((a, b) => ((out[0].values[a] ?? -Infinity) - (out[0].values[b] ?? -Infinity)) * (cfg.sort === "asc" ? 1 : -1));
    categories = idx.map((i) => categories[i]);
    out = out.map((s) => ({ ...s, values: idx.map((i) => s.values[i]) }));
  }
  if (Number(cfg.topN) > 0 && categories.length > Number(cfg.topN)) {
    const n = Number(cfg.topN);
    categories = categories.slice(0, n);
    out = out.map((s) => ({ ...s, values: s.values.slice(0, n) }));
  }
  if (!series.length) warnings.push(tt("Ajoutez au moins une série."));
  return { categories, series: out, warnings, fields };
}

// ── Option ECharts ──────────────────────────────────────────────────────────

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#0a84ff";

/**
 * Palette des séries. Les jetons --chart-1…5 du thème sont des GRIS (la
 * palette neutre de shadcn) : bons pour un tableau de bord monochrome, illisibles
 * pour distinguer quatre séries. On part donc de couleurs franches ; la couleur
 * d'accent du thème passe en tête quand elle est colorée, pour que le
 * graphique reste dans le ton de Lumen sans devenir gris sur gris.
 */
const BASE_PALETTE = ["#0a84ff", "#16b8a6", "#e88438", "#6b6ff0", "#d75c92", "#30d158", "#ff9f0a", "#5e5ce6"];
function seriesPalette() {
  const probe = document.createElement("span");
  probe.style.color = "var(--primary)";
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.map(Number) || [];
  probe.remove();
  const chromatic = rgb.length >= 3 && Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]) > 28;
  return chromatic ? [cssVar("--primary"), ...BASE_PALETTE.filter((c) => c !== "#0a84ff")] : BASE_PALETTE;
}

export function chartOption(data, cfg) {
  const muted = cssVar("--muted-foreground");
  const palette = seriesPalette();
  const type = cfg.type || "bar";
  const isPie = type === "pie" || type === "donut";
  const base = {
    color: palette,
    title: cfg.title ? { text: cfg.title, left: "center", top: 6, textStyle: { fontSize: 15, fontWeight: 600, color: cssVar("--foreground") } } : undefined,
    tooltip: { trigger: isPie || type === "scatter" ? "item" : "axis" },
    legend: cfg.legend !== false ? { bottom: 4, textStyle: { color: muted } } : undefined,
    grid: { left: 56, right: 24, top: cfg.title ? 48 : 24, bottom: cfg.legend !== false ? 46 : 28, containLabel: false },
  };
  if (isPie) {
    const s = data.series[0];
    return {
      ...base,
      series: s ? [{
        name: s.name, type: "pie", radius: type === "donut" ? ["42%", "70%"] : "70%",
        data: data.categories.map((c, i) => ({ name: c, value: s.values[i] ?? 0 })),
        // Le pourcentage est toujours écrit : c'est ce qu'on lit sur un camembert.
        // « Afficher les valeurs » ajoute le libellé, à l'extérieur.
        label: cfg.labels
          ? { show: true, position: "outside", formatter: "{b}\n{d} %", color: cssVar("--foreground") }
          : { show: true, position: "inside", formatter: "{d} %", color: "#fff", fontSize: 11 },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,.2)" } },
      }] : [],
    };
  }
  const horizontal = type === "hbar";
  const catAxis = { type: "category", data: data.categories, axisLabel: { color: muted, interval: 0, rotate: !horizontal && data.categories.length > 8 ? 30 : 0 } };
  const valAxis = { type: "value", axisLabel: { color: muted }, splitLine: { lineStyle: { color: cssVar("--border") } } };
  return {
    ...base,
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal ? catAxis : valAxis,
    series: data.series.map((s) => ({
      name: s.name,
      type: type === "scatter" ? "scatter" : (type === "line" || type === "area") ? "line" : "bar",
      data: s.values,
      smooth: cfg.smooth !== false,
      areaStyle: type === "area" ? { opacity: 0.18 } : undefined,
      stack: cfg.stacked ? "total" : undefined,
      label: cfg.labels ? { show: true, position: horizontal ? "right" : "top", color: muted, fontSize: 10 } : undefined,
      barMaxWidth: 46,
      symbolSize: type === "scatter" ? 9 : 6,
    })),
  };
}

// ── Rendu de la feuille ─────────────────────────────────────────────────────

/** Dessine la feuille graphique dans `host` (la zone de grille de Calc). */
export async function renderChartSheet(st, sh, host) {
  const cfg = sh.chart;
  const data = buildChartData(st.doc, cfg);
  // La zone est reconstruite à chaque rendu : l'instance précédente et son
  // observateur de taille sont libérés, sinon ils s'empilent à chaque réglage.
  st.chartInstance?.dispose();
  st.chartResize?.disconnect();
  st.chartInstance = null;
  host.innerHTML = `<div class="sh-chartsheet">
    <div class="sh-chartsheet-canvas"></div>
    ${data.warnings.length ? `<div class="sh-chartsheet-warn">${data.warnings.map(escapeHtml).join("<br>")}</div>` : ""}
    ${!data.series.length && !data.warnings.length ? `<div class="sh-chartsheet-empty">${escapeHtml(tt("Choisissez un champ de catégorie et des séries dans le volet Graphique."))}</div>` : ""}
  </div>`;
  const box = host.querySelector(".sh-chartsheet-canvas");
  try {
    const echarts = await import("../lib/echarts.esm.min.js");
    const chart = echarts.init(box, null, { renderer: "canvas" });
    chart.setOption(chartOption(data, cfg), true);
    // La zone de grille change de taille avec la fenêtre : le graphique suit.
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(box);
    st.chartInstance = chart;
    st.chartResize = ro;
  } catch (e) {
    box.innerHTML = `<div class="sh-chartsheet-warn">${escapeHtml(tt("Échec :") + " " + (e?.message || e))}</div>`;
  }
}

/** Image PNG du graphique affiché (pour l'export), ou null. */
export function chartPng(st) {
  const c = st.chartInstance;
  if (!c) return null;
  return c.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: cssVar("--background") });
}

// ── Volet de configuration ──────────────────────────────────────────────────

const ICN = new Proxy({}, { get: (_, n) => lumenIcon(String(n)) });
const opts = (list, cur) => list.map(([v, l]) => `<option value="${escapeHtml(v)}" ${String(v) === String(cur ?? "") ? "selected" : ""}>${escapeHtml(tt(l))}</option>`).join("");
const fieldOpts = (fields, cur, none = "") => (none ? `<option value="">${escapeHtml(none)}</option>` : "") + fields.map((f) => `<option value="${escapeHtml(f)}" ${f === cur ? "selected" : ""}>${escapeHtml(f)}</option>`).join("");

/**
 * Le volet « Graphique » quand la feuille active EST un graphique : sa
 * configuration complète. Chaque changement redessine la feuille.
 */
export function renderChartConfig(st, sh, side, { onChange, onExport }) {
  const cfg = sh.chart;
  const dataSheets = st.doc.sheets.filter((s) => !isChartSheet(s)).map((s) => [s.name, s.name]);
  const { fields } = readSourceRows(st.doc, cfg);
  const rangeLabel = cfg.range ? `${cellKey(cfg.range.r0, cfg.range.c0)}:${cellKey(cfg.range.r1, cfg.range.c1)}` : tt("toute la feuille");

  side.innerHTML = `
    <div class="sh-sect"><div class="sh-sect-t">${escapeHtml(tt("Source"))}</div>
      <label class="sh-lbl">${escapeHtml(tt("Feuille de données"))}</label>
      <select class="sh-base" data-k="source">${opts(dataSheets, cfg.source)}</select>
      <div class="sh-cfg-row"><span class="sh-hint">${escapeHtml(tt("Plage :"))} <b>${escapeHtml(rangeLabel)}</b></span>
        <button class="sh-mini" data-c="range-all" title="${escapeHtml(tt("Utiliser toute la feuille"))}">${ICN.maximize || "⤢"}</button></div>
      <label class="sh-check"><input type="checkbox" data-k="header" ${cfg.header ? "checked" : ""}><span>${escapeHtml(tt("La 1re ligne est un en-tête"))}</span></label>
    </div>

    <div class="sh-sect"><div class="sh-sect-t">${escapeHtml(tt("Graphique"))}</div>
      <input class="sh-question" data-k="title" placeholder="${escapeHtml(tt("Titre du graphique"))}" value="${escapeHtml(cfg.title || "")}">
      <select class="sh-charttype" data-k="type">${opts(CHART_TYPES, cfg.type)}</select>
      <label class="sh-lbl">${escapeHtml(tt("Catégorie (axe X / libellés)"))}</label>
      <select class="sh-base" data-k="category">${fieldOpts(fields, cfg.category, tt("— numéro de ligne —"))}</select>
      <label class="sh-check"><input type="checkbox" data-k="groupBy" ${cfg.groupBy ? "checked" : ""}><span>${escapeHtml(tt("Regrouper par catégorie (agrégation)"))}</span></label>
    </div>

    <div class="sh-sect"><div class="sh-sect-t">${escapeHtml(tt("Séries"))}</div>
      <p class="sh-hint">${escapeHtml(tt("Un champ et une agrégation par série. Sans regroupement, l'agrégation est ignorée."))}</p>
      <div class="sh-series">
        ${(cfg.series || []).map((s, i) => `
          <div class="sh-serie" data-i="${i}">
            <select data-s="field">${fieldOpts(fields, s.field)}</select>
            <select data-s="agg">${opts(AGG_OPTIONS, s.agg || "sum")}</select>
            <input data-s="label" placeholder="${escapeHtml(tt("Libellé (facultatif)"))}" value="${escapeHtml(s.label || "")}">
            <button class="sh-mini sh-serie-rm" data-c="serie-rm" data-i="${i}" title="${escapeHtml(tt("Retirer"))}">${ICN.x || "×"}</button>
          </div>`).join("")}
      </div>
      <button class="sh-wide" data-c="serie-add">${ICN.add}<span>${escapeHtml(tt("Ajouter une série"))}</span></button>
    </div>

    <div class="sh-sect"><div class="sh-sect-t">${escapeHtml(tt("Champs calculés"))}</div>
      <p class="sh-hint">${escapeHtml(tt("Une formule par ligne : [Prix] * [Quantité], if([Total] > 100, \"gros\", \"petit\")… Le champ devient utilisable comme les autres."))}</p>
      <div class="sh-computed">
        ${(cfg.computed || []).map((c, i) => `
          <div class="sh-serie sh-computed-row" data-i="${i}">
            <input data-x="name" placeholder="${escapeHtml(tt("Nom"))}" value="${escapeHtml(c.name || "")}">
            <input data-x="expression" placeholder="[A] * [B]" value="${escapeHtml(c.expression || "")}" title="${escapeHtml(EXPRESSION_HELP)}">
            <button class="sh-mini sh-serie-rm" data-c="computed-rm" data-i="${i}" title="${escapeHtml(tt("Retirer"))}">${ICN.x || "×"}</button>
          </div>`).join("")}
      </div>
      <button class="sh-wide" data-c="computed-add">${ICN.add}<span>${escapeHtml(tt("Ajouter un champ calculé"))}</span></button>
    </div>

    <div class="sh-sect"><div class="sh-sect-t">${escapeHtml(tt("Options"))}</div>
      <div class="sh-cfg-grid">
        <label class="sh-lbl">${escapeHtml(tt("Tri"))}</label>
        <select class="sh-base" data-k="sort">${opts([["none", "ordre de la feuille"], ["desc", "valeurs décroissantes"], ["asc", "valeurs croissantes"]], cfg.sort)}</select>
        <label class="sh-lbl">${escapeHtml(tt("Garder les N premiers (0 = tous)"))}</label>
        <input class="sh-question" type="number" min="0" data-k="topN" value="${Number(cfg.topN) || 0}">
      </div>
      <label class="sh-check"><input type="checkbox" data-k="stacked" ${cfg.stacked ? "checked" : ""}><span>${escapeHtml(tt("Empiler les séries"))}</span></label>
      <label class="sh-check"><input type="checkbox" data-k="labels" ${cfg.labels ? "checked" : ""}><span>${escapeHtml(tt("Afficher les valeurs"))}</span></label>
      <label class="sh-check"><input type="checkbox" data-k="smooth" ${cfg.smooth !== false ? "checked" : ""}><span>${escapeHtml(tt("Courbes lissées"))}</span></label>
      <label class="sh-check"><input type="checkbox" data-k="legend" ${cfg.legend !== false ? "checked" : ""}><span>${escapeHtml(tt("Légende"))}</span></label>
    </div>

    <div class="sh-sect">
      <button class="sh-wide" data-c="export-png">${ICN.image || ICN.download}<span>${escapeHtml(tt("Enregistrer en PNG dans la sandbox"))}</span></button>
    </div>`;

  const commit = (rebuildPanel = false) => onChange(rebuildPanel);

  side.querySelectorAll("[data-k]").forEach((el) => {
    const apply = () => {
      const k = el.dataset.k;
      const v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) || 0 : el.value;
      cfg[k] = v;
      // Changer de source ou d'en-tête change la liste des champs : le volet se redessine.
      commit(k === "source" || k === "header" || k === "category" || k === "type");
    };
    el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", apply);
  });
  side.querySelectorAll(".sh-serie:not(.sh-computed-row)").forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelectorAll("[data-s]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      cfg.series[i][el.dataset.s] = el.value;
      commit(false);
    }));
  });
  side.querySelectorAll(".sh-computed-row").forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelectorAll("[data-x]").forEach((el) => el.addEventListener("change", () => {
      cfg.computed[i][el.dataset.x] = el.value.trim();
      commit(true);
    }));
  });
  side.querySelector('[data-c="serie-add"]').addEventListener("click", () => {
    // Premier champ numérique non encore tracé, sinon le premier champ.
    const used = new Set((cfg.series || []).map((s) => s.field));
    const { rows } = readSourceRows(st.doc, cfg);
    const numeric = fields.filter((f) => f !== cfg.category && rows.some((r) => Number.isFinite(num(r[f]))));
    const field = numeric.find((f) => !used.has(f)) || numeric[0] || fields[0] || "";
    (cfg.series ||= []).push({ field, agg: "sum", label: "" });
    commit(true);
  });
  side.querySelectorAll('[data-c="serie-rm"]').forEach((b) => b.addEventListener("click", () => { cfg.series.splice(Number(b.dataset.i), 1); commit(true); }));
  side.querySelector('[data-c="computed-add"]').addEventListener("click", () => { (cfg.computed ||= []).push({ name: `${tt("calc")}${(cfg.computed?.length || 0) + 1}`, expression: "" }); commit(true); });
  side.querySelectorAll('[data-c="computed-rm"]').forEach((b) => b.addEventListener("click", () => { cfg.computed.splice(Number(b.dataset.i), 1); commit(true); }));
  side.querySelector('[data-c="range-all"]').addEventListener("click", () => { cfg.range = null; commit(true); });
  side.querySelector('[data-c="export-png"]').addEventListener("click", () => onExport());
}

/**
 * Le volet « Graphique » sur une feuille de DONNÉES : proposer d'en créer un.
 * La sélection courante devient la plage ; une cellule seule = toute la feuille.
 */
export function renderChartCreate(st, side, { onCreate }) {
  side.innerHTML = `<div class="sh-sect"><div class="sh-sect-t">${escapeHtml(tt("Graphique"))}</div>
    <p class="sh-hint">${escapeHtml(tt("Un graphique est une feuille à part entière du classeur : il se recalcule à partir de cette feuille de données. Sélectionnez une plage (1re ligne = en-têtes) ou laissez une cellule seule pour prendre toute la feuille."))}</p>
    <select class="sh-charttype">${opts(CHART_TYPES, "bar")}</select>
    <button class="sh-wide primary" data-c="create">${ICN.chart || ""}<span>${escapeHtml(tt("Créer une feuille graphique"))}</span></button>
    ${st.doc.sheets.some(isChartSheet) ? `<p class="sh-hint">${escapeHtml(tt("Feuilles graphiques existantes :"))} ${st.doc.sheets.filter(isChartSheet).map((s) => escapeHtml(s.name)).join(", ")}</p>` : ""}
  </div>`;
  side.querySelector('[data-c="create"]').addEventListener("click", () => onCreate(side.querySelector(".sh-charttype").value));
}

/**
 * Configuration initiale déduite de la plage : la 1re colonne texte devient la
 * catégorie, chaque colonne numérique une série en somme. On peut tout
 * changer ensuite, mais un graphique qui apparaît déjà rempli vaut mieux
 * qu'un formulaire vide.
 */
export function autoConfigure(doc, cfg) {
  const { fields, rows } = readSourceRows(doc, cfg);
  if (!fields.length) return cfg;
  const isNum = (f) => rows.length && rows.filter((r) => !isBlank(r[f])).every((r) => Number.isFinite(num(r[f])));
  const numeric = fields.filter(isNum);
  const textual = fields.filter((f) => !isNum(f));
  cfg.category = textual[0] || "";
  cfg.groupBy = !!textual[0] && new Set(rows.map((r) => toText(r[textual[0]]))).size < rows.length;
  cfg.series = numeric.slice(0, (cfg.type === "pie" || cfg.type === "donut") ? 1 : 4).map((f) => ({ field: f, agg: "sum", label: "" }));
  return cfg;
}
