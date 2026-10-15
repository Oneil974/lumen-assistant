// Visuels du rapport, à la manière de Power BI : un catalogue de types, le
// calcul de chaque visuel à partir d'une table filtrée (model.js), les options
// ECharts des graphiques et le HTML des visuels « non graphiques » (carte,
// table, matrice, segment, texte, analyse IA).
//
// Rien ici ne connaît le DOM du canevas : `renderVisual(el, v, ctx)` peint un
// visuel dans l'élément qu'on lui donne — le canevas, l'export et l'aperçu
// d'envoi utilisent le même code.

import * as echarts from "../lib/echarts.esm.min.js";
import { AGGS, DATE_BUCKETS, aggregate, distinctValues, groupBy, measureValue, minMax, toNum } from "./model.js";
import { buildPivot, renderPivotHtml } from "./pivot.js";
import { renderMarkdown } from "../sandbox/render.js";

export const VISUALS = [
  { id: "card", label: "Carte", icon: "▣", wells: ["values"], group: "kpi" },
  { id: "multicard", label: "Cartes multiples", icon: "▤", wells: ["values"], group: "kpi" },
  { id: "gauge", label: "Jauge", icon: "◔", wells: ["values"], group: "kpi" },
  { id: "bar", label: "Histogramme", icon: "▥", wells: ["axis", "legend", "values"], group: "chart" },
  { id: "barstacked", label: "Histogramme empilé", icon: "▥", wells: ["axis", "legend", "values"], group: "chart" },
  { id: "hbar", label: "Barres", icon: "☰", wells: ["axis", "legend", "values"], group: "chart" },
  { id: "hbarstacked", label: "Barres empilées", icon: "☰", wells: ["axis", "legend", "values"], group: "chart" },
  { id: "line", label: "Courbes", icon: "⟋", wells: ["axis", "legend", "values"], group: "chart" },
  { id: "area", label: "Aires", icon: "◭", wells: ["axis", "legend", "values"], group: "chart" },
  { id: "combo", label: "Barres + courbe", icon: "⫼", wells: ["axis", "values"], group: "chart" },
  { id: "pie", label: "Secteurs", icon: "◕", wells: ["axis", "values"], group: "chart" },
  { id: "donut", label: "Anneau", icon: "◎", wells: ["axis", "values"], group: "chart" },
  { id: "treemap", label: "Compartimentage", icon: "▦", wells: ["axis", "values"], group: "chart" },
  { id: "funnel", label: "Entonnoir", icon: "⏷", wells: ["axis", "values"], group: "chart" },
  { id: "waterfall", label: "Cascade", icon: "⧗", wells: ["axis", "values"], group: "chart" },
  { id: "scatter", label: "Nuage de points", icon: "⁘", wells: ["axis", "values"], group: "chart" },
  { id: "radar", label: "Radar", icon: "✶", wells: ["axis", "legend", "values"], group: "chart" },
  { id: "table", label: "Table", icon: "▦", wells: ["columns", "values"], group: "table" },
  { id: "matrix", label: "Matrice", icon: "⊞", wells: ["rows", "cols", "values"], group: "table" },
  { id: "slicer", label: "Segment", icon: "⧉", wells: ["field"], group: "filter" },
  { id: "text", label: "Zone de texte", icon: "¶", wells: [], group: "other" },
  { id: "ai", label: "Analyse IA", icon: "✦", wells: [], group: "other" },
];
// Pictogrammes des types de visuels (24×24, trait `currentColor`, aplats en
// `--viz-fill`) : les glyphes Unicode d'avant manquaient dans certaines polices
// (l'histogramme n'apparaissait pas).
const SV = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const F = 'fill="var(--viz-fill, currentColor)" stroke="none"';
export const VIZ_ICONS = {
  card: SV(`<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 14.5h4M7 10h7" stroke-width="2.4"/>`),
  multicard: SV(`<rect x="3" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="4" width="8" height="7" rx="1.5"/><rect x="3" y="13" width="8" height="7" rx="1.5"/><rect x="13" y="13" width="8" height="7" rx="1.5"/>`),
  gauge: SV(`<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/><circle cx="12" cy="17" r="1.3" ${F}/>`),
  bar: SV(`<path d="M3 21h18"/><rect x="5" y="11" width="3.4" height="8" rx=".8" ${F}/><rect x="10.3" y="5" width="3.4" height="14" rx=".8" ${F}/><rect x="15.6" y="8" width="3.4" height="11" rx=".8" ${F}/>`),
  barstacked: SV(`<path d="M3 21h18"/><rect x="5" y="9" width="3.4" height="10" rx=".8"/><rect x="5" y="14" width="3.4" height="5" rx=".8" ${F}/><rect x="10.3" y="4" width="3.4" height="15" rx=".8"/><rect x="10.3" y="11" width="3.4" height="8" rx=".8" ${F}/><rect x="15.6" y="7" width="3.4" height="12" rx=".8"/><rect x="15.6" y="13" width="3.4" height="6" rx=".8" ${F}/>`),
  hbar: SV(`<path d="M3 3v18"/><rect x="5" y="5" width="9" height="3.4" rx=".8" ${F}/><rect x="5" y="10.3" width="15" height="3.4" rx=".8" ${F}/><rect x="5" y="15.6" width="11" height="3.4" rx=".8" ${F}/>`),
  hbarstacked: SV(`<path d="M3 3v18"/><rect x="5" y="5" width="12" height="3.4" rx=".8"/><rect x="5" y="5" width="6" height="3.4" rx=".8" ${F}/><rect x="5" y="10.3" width="15" height="3.4" rx=".8"/><rect x="5" y="10.3" width="8" height="3.4" rx=".8" ${F}/><rect x="5" y="15.6" width="10" height="3.4" rx=".8"/><rect x="5" y="15.6" width="4" height="3.4" rx=".8" ${F}/>`),
  line: SV(`<path d="M3 21h18"/><path d="M4 16l5-6 4 4 7-8" stroke-width="2.2"/>`),
  area: SV(`<path d="M3 21h18"/><path d="M4 19v-4l5-6 4 4 7-7v13z" ${F} opacity=".45"/><path d="M4 15l5-6 4 4 7-7" stroke-width="2"/>`),
  combo: SV(`<path d="M3 21h18"/><rect x="5" y="12" width="3.4" height="7" rx=".8" ${F} opacity=".6"/><rect x="10.3" y="9" width="3.4" height="10" rx=".8" ${F} opacity=".6"/><rect x="15.6" y="13" width="3.4" height="6" rx=".8" ${F} opacity=".6"/><path d="M4 9l6-4 5 3 6-4" stroke-width="2"/>`),
  pie: SV(`<circle cx="12" cy="12" r="9"/><path d="M12 3v9h9a9 9 0 0 0-9-9z" ${F}/>`),
  donut: SV(`<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 4a8 8 0 0 1 8 8h-4.5A3.5 3.5 0 0 0 12 8.5z" ${F}/>`),
  treemap: SV(`<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="3" y="3" width="10" height="11" rx="2" ${F}/><path d="M13 3v18M13 12h8M3 14h10"/>`),
  funnel: SV(`<path d="M3 5h18M6 10h12M9 15h6M11 20h2" stroke-width="3"/>`),
  waterfall: SV(`<path d="M3 21h18"/><rect x="4" y="11" width="3.2" height="8" rx=".6" ${F}/><rect x="8.6" y="6" width="3.2" height="5" rx=".6" ${F}/><rect x="13.2" y="6" width="3.2" height="4"/><rect x="17.8" y="10" width="3.2" height="9" rx=".6" ${F}/>`),
  scatter: SV(`<path d="M3 3v18h18"/><circle cx="8" cy="15" r="1.6" ${F}/><circle cx="11" cy="10" r="1.6" ${F}/><circle cx="15" cy="13" r="1.6" ${F}/><circle cx="18" cy="6" r="1.6" ${F}/><circle cx="14" cy="7" r="1.6" ${F}/>`),
  radar: SV(`<path d="M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z"/><path d="M12 7l5 4-2 5H9.5L7.5 11z" ${F} opacity=".55"/>`),
  table: SV(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14.5h18M10 9v11"/><rect x="3" y="4" width="18" height="5" rx="2" ${F} opacity=".35"/>`),
  matrix: SV(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/><rect x="9" y="9" width="6" height="6" ${F} opacity=".55"/><rect x="15" y="15" width="6" height="6" ${F}/>`),
  slicer: SV(`<path d="M4 5h16l-6 7v6l-4 2v-8z"/>`),
  text: SV(`<path d="M5 6V4h14v2M12 4v16M9 20h6"/>`),
  ai: SV(`<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" ${F}/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" ${F}/>`),
};
export const vizIcon = (type) => VIZ_ICONS[type] || VIZ_ICONS.bar;
export const visualDef = (type) => VISUALS.find((v) => v.id === type) || VISUALS[0];
export const isChart = (type) => visualDef(type).group === "chart" || type === "gauge";

export const PALETTES = {
  lumen: null, // accent du poste en tête
  ocean: ["#0ea5e9", "#2563eb", "#14b8a6", "#6366f1", "#06b6d4", "#3b82f6", "#22c55e", "#a855f7"],
  sunset: ["#f97316", "#ef4444", "#eab308", "#ec4899", "#f59e0b", "#e11d48", "#fb7185", "#facc15"],
  forest: ["#16a34a", "#65a30d", "#0d9488", "#ca8a04", "#15803d", "#4d7c0f", "#047857", "#a16207"],
  corporate: ["#1e3a8a", "#475569", "#0369a1", "#64748b", "#1d4ed8", "#94a3b8", "#0f766e", "#334155"],
  mono: ["#18181b", "#3f3f46", "#52525b", "#71717a", "#a1a1aa", "#d4d4d8", "#27272a", "#e4e4e7"],
};
export const PALETTE_LABELS = { lumen: "Lumen (accent)", ocean: "Océan", sunset: "Couchant", forest: "Forêt", corporate: "Entreprise", mono: "Monochrome", custom: "Personnalisée" };
const BASE = ["#0a84ff", "#0f9b8e", "#ff9f0a", "#ff375f", "#bf5af2", "#32d74b", "#64d2ff", "#ffd60a", "#5e5ce6", "#ac8e68"];

export function theme(paletteId = "lumen", root = document.documentElement, custom = null) {
  const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  // L'accent CHOISI par l'utilisateur (Réglages › Habillage) ; sans accent,
  // `--primary` est le gris presque noir de la base : on prend alors la
  // palette par défaut plutôt que des graphiques noirs.
  const accent = css("--chart-accent") || css("--accent-primary") || BASE[0];
  const palette = paletteId === "custom" && custom?.length ? custom : PALETTES[paletteId] || [accent, ...BASE.filter((c) => c.toLowerCase() !== accent.toLowerCase())];
  return { text: css("--foreground") || "#18181b", muted: css("--muted-foreground") || "#71717a", border: css("--border") || "#e4e4e7", card: css("--card") || "#fff", palette };
}

/** Thème d'un rapport (palette choisie, ou palette personnalisée). */
export const reportTheme = (report, root) => theme(report?.palette || "lumen", root, report?.customPalette);

/** Variables CSS d'un visuel (fond, texte, titre, couleur principale). */
export function visualStyle(v) {
  const o = v.opts || {};
  const safe = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || "")) ? c : "");
  return [["--vis-bg", safe(o.bg)], ["--vis-fg", safe(o.textColor)], ["--vis-title", safe(o.titleColor)], ["--v-accent", safe(o.color)]].filter(([, c]) => c).map(([k, c]) => `${k}:${c}`).join(";");
}

export function formatValue(value, o = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "—");
  const dec = o.decimals === "" || o.decimals == null ? undefined : Number(o.decimals);
  const opt = dec === undefined ? {} : { minimumFractionDigits: dec, maximumFractionDigits: dec };
  const pre = o.prefix || "", suf = o.suffix || "";
  switch (o.format) {
    case "money": return `${pre}${n.toLocaleString("fr-FR", { style: "currency", currency: o.currency || "EUR", ...opt })}${suf}`;
    case "percent": return `${pre}${n.toLocaleString("fr-FR", { maximumFractionDigits: dec ?? 1 })} %${suf}`;
    case "integer": return `${pre}${Math.round(n).toLocaleString("fr-FR")}${suf}`;
    case "compact": return `${pre}${new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(n)}${suf}`;
    default: return `${pre}${n.toLocaleString("fr-FR", { maximumFractionDigits: dec ?? 2, ...opt })}${suf}`;
  }
}
export const FORMATS = { auto: "Automatique", integer: "Entier", compact: "Compact (1,2 k)", money: "Monétaire (€)", percent: "Pourcentage" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const measureLabel = (m) => (m?.col ? `${AGGS[m.agg] || m.agg} de ${m.col}` : "Nombre de lignes");

// ---- Options ECharts ---------------------------------------------------------------
function baseOption(t, o = {}) {
  return {
    color: t.palette,
    textStyle: { color: t.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif" },
    tooltip: { trigger: "axis", confine: true, backgroundColor: "rgba(24,24,27,.92)", borderWidth: 0, textStyle: { color: "#fafafa", fontSize: 12 }, extraCssText: "border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);" },
    grid: { left: 8, right: 14, top: o.legend ? 34 : 18, bottom: 6, containLabel: true },
    legend: o.legend ? { top: 0, type: "scroll", textStyle: { color: t.muted, fontSize: 11 }, icon: "circle", itemWidth: 8, itemHeight: 8 } : undefined,
    animationDuration: 350,
  };
}
const axisStyle = (t) => ({ axisLine: { lineStyle: { color: t.border } }, axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true }, splitLine: { lineStyle: { color: t.border, type: "dashed" } }, axisTick: { show: false } });

/** Option ECharts d'un visuel graphique à partir de son résultat. */
export function chartOption(v, res, t) {
  const o = v.opts || {};
  if (o.color) t = { ...t, palette: [o.color, ...t.palette.filter((c) => c !== o.color)] };
  if (o.textColor) t = { ...t, text: o.textColor, muted: o.textColor };
  if (o.bg) t = { ...t, card: o.bg };
  return applyColors(baseChartOption(v, res, t), v, res);
}

/** Couleurs choisies par l'utilisateur : par série (nom) ou par catégorie (libellé). */
export function applyColors(opt, v, res) {
  const map = v.opts?.colors || {};
  if (!Object.keys(map).length) return opt;
  const byKey = new Map((res.categories || []).map((c) => [c.key, c.label]));
  for (const s of opt.series || []) {
    const c = map[s.name];
    if (c) { s.itemStyle = { ...(s.itemStyle || {}), color: c }; if (s.type === "line") s.lineStyle = { ...(s.lineStyle || {}), color: c }; }
    if (!Array.isArray(s.data)) continue;
    const single = (opt.series || []).filter((x) => x.type !== "bar" || x.itemStyle?.color !== "transparent").length === 1;
    for (const d of s.data) {
      if (!d || typeof d !== "object") continue;
      const label = d.name ?? (single ? byKey.get(d.key) : undefined);
      if (label != null && map[label]) d.itemStyle = { ...(d.itemStyle || {}), color: map[label] };
    }
  }
  return opt;
}

/** Noms coloriables d'un visuel : séries, ou catégories quand il n'y en a qu'une. */
export function colorTargets(v, res) {
  if (!res || !isChart(v.type) || v.type === "gauge") return [];
  if (v.type === "waterfall") return ["Hausse", "Baisse"];
  const perCat = ["pie", "donut", "treemap", "funnel"].includes(v.type) || (res.series?.length === 1 && !["line", "area", "radar", "scatter", "combo"].includes(v.type));
  if (perCat) return (res.categories || []).slice(0, 24).map((c) => c.label);
  return (res.series || []).map((s) => s.name);
}

function baseChartOption(v, res, t) {
  const o = v.opts || {};
  const fmt = (x) => formatValue(x, o);
  const labels = o.labels ? { show: true, color: t.muted, fontSize: 10, formatter: (p) => fmt(Array.isArray(p.value) ? p.value[1] : p.value) } : { show: false };
  const cats = res.categories.map((c) => c.label);
  const hi = res.highlight; // clé mise en avant (filtre croisé)
  const dim = (k) => (hi != null && k !== hi ? 0.28 : 1);
  if (v.type === "gauge") {
    const value = res.value;
    const max = Number(o.target) || Math.max(1, Math.ceil(value * 1.25));
    return { ...baseOption(t), tooltip: { show: false }, series: [{ type: "gauge", min: 0, max, startAngle: 210, endAngle: -30, progress: { show: true, roundCap: true, width: 14, itemStyle: { color: t.palette[0] } }, axisLine: { roundCap: true, lineStyle: { width: 14, color: [[1, t.border]] } }, pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, anchor: { show: false }, title: { show: true, offsetCenter: [0, "38%"], color: t.muted, fontSize: 11 }, detail: { valueAnimation: true, fontSize: 24, fontWeight: 700, color: t.text, offsetCenter: [0, 0], formatter: (x) => fmt(x) }, data: [{ value, name: o.target ? `Objectif ${fmt(o.target)}` : "" }] }] };
  }
  if (v.type === "pie" || v.type === "donut") {
    const s = res.series[0] || { values: [] };
    return { ...baseOption(t, { legend: true }), tooltip: { trigger: "item", confine: true, valueFormatter: fmt }, series: [{ type: "pie", radius: v.type === "donut" ? ["50%", "76%"] : "74%", center: ["50%", "56%"], itemStyle: { borderRadius: 5, borderColor: t.card, borderWidth: 2 }, label: o.labels ? { show: true, color: t.muted, fontSize: 10, formatter: "{b} · {d} %" } : { show: false }, data: res.categories.map((c, i) => ({ name: c.label, key: c.key, value: s.values[i], itemStyle: { opacity: dim(c.key) } })) }] };
  }
  if (v.type === "treemap") {
    const s = res.series[0] || { values: [] };
    return { ...baseOption(t), tooltip: { trigger: "item", valueFormatter: fmt }, series: [{ type: "treemap", roam: false, nodeClick: false, breadcrumb: { show: false }, width: "100%", height: "100%", label: { show: true, color: "#fff", fontSize: 11, formatter: (p) => `${p.name}\n${fmt(p.value)}` }, itemStyle: { borderColor: t.card, borderWidth: 2, gapWidth: 2 }, levels: [{ colorSaturation: [0.35, 0.6] }], data: res.categories.map((c, i) => ({ name: c.label, key: c.key, value: s.values[i], itemStyle: { color: t.palette[i % t.palette.length], opacity: dim(c.key) } })) }] };
  }
  if (v.type === "funnel") {
    const s = res.series[0] || { values: [] };
    return { ...baseOption(t, { legend: false }), tooltip: { trigger: "item", valueFormatter: fmt }, series: [{ type: "funnel", left: "8%", width: "84%", top: 10, bottom: 10, sort: "descending", gap: 2, label: { show: true, position: "inside", color: "#fff", fontSize: 11, formatter: (p) => `${p.name} · ${fmt(p.value)}` }, itemStyle: { borderColor: t.card, borderWidth: 1 }, data: res.categories.map((c, i) => ({ name: c.label, key: c.key, value: s.values[i], itemStyle: { opacity: dim(c.key) } })) }] };
  }
  if (v.type === "scatter") {
    return { ...baseOption(t, { legend: false }), tooltip: { trigger: "item", formatter: (p) => `${esc(p.name || "")}<br>${fmt(p.value[0])} · ${fmt(p.value[1])}` }, xAxis: { type: "value", name: res.xName, nameTextStyle: { color: t.muted }, ...axisStyle(t) }, yAxis: { type: "value", name: res.yName, nameTextStyle: { color: t.muted }, ...axisStyle(t) }, series: [{ type: "scatter", symbolSize: (d) => (res.sized ? Math.max(6, Math.min(40, d[2] || 8)) : 9), data: res.points.map((p) => ({ name: p.name, key: p.key, value: [p.x, p.y, p.size], itemStyle: { opacity: 0.75 * dim(p.key) } })) }] };
  }
  if (v.type === "radar") {
    const max = Math.max(1, ...res.series.flatMap((s) => s.values));
    return { ...baseOption(t, { legend: res.series.length > 1 }), tooltip: { trigger: "item" }, radar: { indicator: cats.map((c) => ({ name: c, max })), axisName: { color: t.muted, fontSize: 10 }, splitLine: { lineStyle: { color: t.border } }, splitArea: { show: false }, axisLine: { lineStyle: { color: t.border } } }, series: [{ type: "radar", data: res.series.map((s) => ({ name: s.name, value: s.values, areaStyle: { opacity: 0.15 } })) }] };
  }
  const horizontal = v.type === "hbar" || v.type === "hbarstacked";
  const stacked = v.type === "barstacked" || v.type === "hbarstacked" || (v.type === "area" && o.stacked);
  const catAxis = { type: "category", data: horizontal ? cats.slice().reverse() : cats, ...axisStyle(t), splitLine: { show: false } };
  const valAxis = { type: "value", ...axisStyle(t), axisLabel: { ...axisStyle(t).axisLabel, formatter: (x) => formatValue(x, { ...o, format: o.format === "money" ? "compact" : o.format === "percent" ? "percent" : "compact" }) } };
  const ord = (arr) => (horizontal ? arr.slice().reverse() : arr);
  const keys = ord(res.categories.map((c) => c.key));
  const legend = res.series.length > 1;
  if (v.type === "waterfall") {
    const vals = res.series[0]?.values || [];
    let acc = 0;
    const base = [], pos = [], neg = [];
    vals.forEach((x) => { const start = acc; acc += x; base.push(Math.min(start, acc)); pos.push(x >= 0 ? x : "-"); neg.push(x < 0 ? -x : "-"); });
    return { ...baseOption(t, { legend: false }), tooltip: { trigger: "axis", valueFormatter: fmt }, xAxis: { ...catAxis, data: cats }, yAxis: valAxis, series: [
      { type: "bar", stack: "w", itemStyle: { color: "transparent" }, emphasis: { disabled: true }, data: base, tooltip: { show: false } },
      { type: "bar", stack: "w", name: "Hausse", itemStyle: { color: "#16a34a", borderRadius: [4, 4, 0, 0] }, label: labels, data: pos },
      { type: "bar", stack: "w", name: "Baisse", itemStyle: { color: "#dc2626", borderRadius: [4, 4, 0, 0] }, label: labels, data: neg },
    ] };
  }
  if (v.type === "combo") {
    const [a, b] = res.series;
    return { ...baseOption(t, { legend: true }), tooltip: { trigger: "axis", valueFormatter: fmt }, xAxis: catAxis, yAxis: [valAxis, { ...valAxis, splitLine: { show: false } }], series: [
      a && { type: "bar", name: a.name, data: a.values, barMaxWidth: 34, itemStyle: { borderRadius: [5, 5, 0, 0] }, label: labels },
      b && { type: "line", name: b.name, yAxisIndex: 1, data: b.values, smooth: true, symbolSize: 6, lineStyle: { width: 2.5 } },
    ].filter(Boolean) };
  }
  const series = res.series.map((s) => {
    const data = ord(s.values).map((val, i) => ({ value: val, key: keys[i], itemStyle: { opacity: dim(keys[i]) } }));
    if (v.type === "line" || v.type === "area") return { type: "line", name: s.name, data, smooth: o.smooth !== false, symbolSize: 5, lineStyle: { width: 2.4 }, stack: stacked ? "s" : undefined, areaStyle: v.type === "area" ? { opacity: stacked ? 0.5 : 0.16 } : undefined, label: labels };
    return { type: "bar", name: s.name, data, stack: stacked ? "s" : undefined, barMaxWidth: 36, itemStyle: { borderRadius: stacked ? 0 : horizontal ? [0, 5, 5, 0] : [5, 5, 0, 0] }, label: { ...labels, position: stacked ? "inside" : horizontal ? "right" : "top" } };
  });
  return { ...baseOption(t, { legend }), tooltip: { trigger: "axis", confine: true, valueFormatter: fmt, backgroundColor: "rgba(24,24,27,.92)", borderWidth: 0, textStyle: { color: "#fafafa", fontSize: 12 } }, xAxis: horizontal ? valAxis : catAxis, yAxis: horizontal ? catAxis : valAxis, series };
}

// ---- Calcul d'un visuel ------------------------------------------------------------
/**
 * Résultat d'un visuel sur sa table filtrée `T` (et `P`, la période
 * précédente, quand la comparaison est demandée).
 */
export function compute(v, T, P = null) {
  const o = v.opts || {};
  const values = (v.values || []).filter((m) => m.agg === "count" || T.columns.includes(m.col));
  switch (v.type) {
    case "card":
    case "gauge": {
      const m = values[0];
      const value = measureValue(T, m);
      const prev = P ? measureValue(P, m) : null;
      let spark = null;
      if (v.type === "card" && v.axis?.col && T.columns.includes(v.axis.col)) spark = groupBy(T, { axis: v.axis, measures: [m || { agg: "count" }], sort: "label" }).series[0]?.values || null;
      return { value, prev, label: o.label || measureLabel(m), spark };
    }
    case "multicard":
      return { items: (values.length ? values : [{ agg: "count" }]).map((m) => ({ label: measureLabel(m), value: measureValue(T, m), prev: P ? measureValue(P, m) : null })) };
    case "scatter": {
      const [mx, my, ms] = values;
      if (!mx || !my) return { points: [], xName: "", yName: "" };
      if (v.axis?.col && T.columns.includes(v.axis.col)) {
        const g = groupBy(T, { axis: v.axis, measures: [mx, my, ...(ms ? [ms] : [])], sort: "value", limit: 500 });
        const smax = ms ? Math.max(1, ...g.series[2].values) : 1;
        return { xName: measureLabel(mx), yName: measureLabel(my), sized: !!ms, points: g.categories.map((c, i) => ({ name: c.label, key: c.key, x: g.series[0].values[i], y: g.series[1].values[i], size: ms ? (g.series[2].values[i] / smax) * 40 : 0 })) };
      }
      const xi = T.columns.indexOf(mx.col), yi = T.columns.indexOf(my.col);
      return { xName: mx.col, yName: my.col, points: T.rows.slice(0, 3000).map((r) => ({ name: "", key: null, x: toNum(r[xi]), y: toNum(r[yi]) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) };
    }
    case "table": {
      const cols = (v.columns || []).filter((c) => T.columns.includes(c));
      if (values.length && cols.length) {
        // Table agrégée : regroupement par la première colonne choisie.
        const g = groupBy(T, { axis: { col: cols[0], bucket: v.axis?.bucket || "" }, measures: values, sort: o.sort || "value", limit: o.limit || 0 });
        return { head: [cols[0], ...g.series.map((s) => s.name)], numeric: [false, ...g.series.map(() => true)], rows: g.categories.map((c, i) => [c.label, ...g.series.map((s) => s.values[i])]), keys: g.categories.map((c) => c.key), keyCol: cols[0], totals: ["Total", ...g.series.map((s) => s.values.reduce((a, b) => a + b, 0))] };
      }
      const show = cols.length ? cols : T.columns.slice(0, 8);
      const idx = show.map((c) => T.columns.indexOf(c));
      let rows = T.rows.map((r) => idx.map((i) => r[i]));
      if (o.sortCol != null && show[o.sortCol] != null) {
        const k = o.sortCol, dir = o.sortDir === "desc" ? -1 : 1, num = T.types[show[k]] === "number";
        rows = rows.slice().sort((a, b) => (num ? (toNum(a[k]) - toNum(b[k])) : String(a[k]).localeCompare(String(b[k]), "fr", { numeric: true })) * dir);
      }
      return { head: show, numeric: show.map((c) => T.types[c] === "number"), rows: rows.slice(0, Number(o.limit) || 500), total: T.rows.length };
    }
    case "matrix": {
      const cfg = { rows: [], cols: [], values: [], filters: [], buckets: {}, subtotals: true, rowTotals: true, colTotals: true, sort: "label", sortDir: "asc", topN: 0, showAs: "value", compare: false, heatmap: false, emptyAs: "—", ...(v.pivot || {}) };
      const data = { columns: T.columns, rows: T.rows };
      const prev = P && cfg.compare ? { columns: P.columns, rows: P.rows } : null;
      return { html: renderPivotHtml(buildPivot(data, cfg, prev), cfg), cfg };
    }
    case "slicer": {
      const col = v.slicer?.col;
      if (!col || !T.columns.includes(col)) return { values: [], col };
      const type = T.types[col];
      const mode = v.slicer.mode || (type === "date" ? "date" : type === "number" ? "range" : "list");
      return { col, mode, type, values: mode === "list" || mode === "dropdown" || mode === "tiles" ? distinctValues(T, col, v.slicer.bucket || "").slice(0, 300) : [], range: minMax(T, col) };
    }
    case "text":
    case "ai":
      return {};
    default: {
      if (!v.axis?.col) return { categories: [{ key: "Total", label: "Total" }], series: (values.length ? values : [{ agg: "count" }]).map((m) => ({ name: measureLabel(m), values: [measureValue(T, m)] })) };
      const useLegend = ["bar", "barstacked", "hbar", "hbarstacked", "line", "area", "radar"].includes(v.type) && v.legend?.col;
      return groupBy(T, { axis: v.axis, legend: useLegend ? v.legend : null, measures: v.type === "combo" ? values.slice(0, 2) : useLegend ? values.slice(0, 1) : values, sort: o.sort, limit: o.limit || (["pie", "donut", "funnel"].includes(v.type) ? 10 : 0) });
    }
  }
}

// ---- Rendu -------------------------------------------------------------------------------
const charts = new Map(); // id → instance ECharts

export function disposeVisual(id) {
  const c = charts.get(id);
  if (c) { c.dispose(); charts.delete(id); }
}
export function disposeAllVisuals() { charts.forEach((c) => c.dispose()); charts.clear(); }
export function resizeVisuals() { charts.forEach((c) => c.resize()); }
export function visualImage(id, background = "#ffffff") {
  const c = charts.get(id);
  return c ? c.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: background }) : null;
}

function delta(value, prev, o) {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return "";
  const d = ((value - prev) / Math.abs(prev)) * 100;
  const good = o.invert ? d < 0 : d >= 0;
  return `<span class="v-delta ${good ? "up" : "down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %</span><span class="v-prev">vs ${formatValue(prev, o)}</span>`;
}
function sparkSvg(vals) {
  if (!vals || vals.length < 2) return "";
  const min = Math.min(...vals), max = Math.max(...vals), w = 120, h = 30;
  const pts = vals.map((x, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - ((x - min) / (max - min || 1)) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return `<svg class="v-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/**
 * Peint un visuel. ctx = { T, P, theme, onSelect(key, col, bucket), selection, onSlicer(filter), slicerState, onSort, aiAnswer }
 */
export function renderVisual(body, v, ctx) {
  disposeVisual(v.id);
  body.onclick = null;
  const o = v.opts || {};
  let res;
  try { res = ctx.T ? compute(v, ctx.T, ctx.P) : null; } catch (e) { body.innerHTML = `<div class="v-empty">${esc(e?.message || e)}</div>`; return null; }
  if (!ctx.T && !["text", "ai"].includes(v.type)) { body.innerHTML = `<div class="v-empty">Choisissez une table et des champs.</div>`; return null; }
  switch (v.type) {
    case "card":
      body.innerHTML = `<div class="v-card"><div class="v-card-value">${esc(formatValue(res.value, o))}</div><div class="v-card-label">${esc(res.label)}</div><div class="v-card-foot">${o.compare !== false ? delta(res.value, res.prev, o) : ""}</div>${res.spark ? sparkSvg(res.spark) : ""}</div>`;
      return res;
    case "multicard":
      body.innerHTML = `<div class="v-multi">${res.items.map((it) => `<div class="v-multi-item"><div class="v-card-value sm">${esc(formatValue(it.value, o))}</div><div class="v-card-label">${esc(it.label)}</div>${o.compare !== false ? `<div class="v-card-foot">${delta(it.value, it.prev, o)}</div>` : ""}</div>`).join("")}</div>`;
      return res;
    case "table": {
      const sortIcon = (i) => (o.sortCol === i ? (o.sortDir === "desc" ? " ↓" : " ↑") : "");
      body.innerHTML = `<div class="v-table-wrap"><table class="v-table"><thead><tr>${res.head.map((h, i) => `<th data-sort="${i}" class="${res.numeric[i] ? "num" : ""}">${esc(h)}${sortIcon(i)}</th>`).join("")}</tr></thead><tbody>${res.rows.map((r, ri) => `<tr${res.keys ? ` data-key="${esc(res.keys[ri])}" class="${ctx.selection?.key === res.keys[ri] ? "is-sel" : ""}"` : ""}>${r.map((c, i) => `<td class="${res.numeric[i] ? "num" : ""}">${esc(res.numeric[i] ? formatValue(c, o) : c)}</td>`).join("")}</tr>`).join("")}</tbody>${res.totals ? `<tfoot><tr>${res.totals.map((c, i) => `<td class="${i ? "num" : ""}">${esc(i ? formatValue(c, o) : c)}</td>`).join("")}</tr></tfoot>` : ""}</table>${res.total > res.rows.length ? `<div class="v-more">${res.rows.length} / ${res.total} lignes</div>` : ""}</div>`;
      body.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => ctx.onSort?.(Number(th.dataset.sort))));
      if (res.keys) body.querySelectorAll("tr[data-key]").forEach((tr) => tr.addEventListener("click", () => ctx.onSelect?.(tr.dataset.key, res.keyCol, v.axis?.bucket || "")));
      return res;
    }
    case "matrix":
      body.innerHTML = `<div class="v-table-wrap v-matrix">${res.html || '<div class="v-empty">Choisissez des lignes et des valeurs.</div>'}</div>`;
      return res;
    case "slicer": {
      const st = ctx.slicerState || {};
      const col = res.col;
      if (!col) { body.innerHTML = `<div class="v-empty">Choisissez le champ à segmenter.</div>`; return res; }
      if (res.mode === "date" || res.mode === "range") {
        const isDate = res.mode === "date";
        body.innerHTML = `<div class="v-slicer-range"><label>De<input class="input" type="${isDate ? "date" : "number"}" data-r="from" value="${esc(st.value ?? "")}" placeholder="${esc(res.range?.min ?? "")}" /></label><label>À<input class="input" type="${isDate ? "date" : "number"}" data-r="to" value="${esc(st.value2 ?? "")}" placeholder="${esc(res.range?.max ?? "")}" /></label>${res.range ? `<small class="muted">${esc(String(res.range.min))} → ${esc(String(res.range.max))}</small>` : ""}</div>`;
        body.querySelectorAll("[data-r]").forEach((inp) => inp.addEventListener("change", () => {
          const a = body.querySelector('[data-r="from"]').value, b = body.querySelector('[data-r="to"]').value;
          ctx.onSlicer?.(a || b ? { col, op: "between", value: a, value2: b } : null);
        }));
        return res;
      }
      const sel = new Set(st.values || []);
      if (res.mode === "dropdown") {
        body.innerHTML = `<select class="select v-slicer-dd"><option value="">Tout</option>${res.values.map((x) => `<option value="${esc(x.key)}"${sel.has(x.key) ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select>`;
        body.querySelector("select").addEventListener("change", (e) => ctx.onSlicer?.(e.target.value ? { col, op: "in", values: [e.target.value], bucket: v.slicer.bucket || "" } : null));
        return res;
      }
      if (res.mode === "tiles") {
        body.innerHTML = `<div class="v-tiles">${res.values.map((x) => `<button class="v-tile${sel.has(x.key) ? " is-on" : ""}" data-k="${esc(x.key)}">${esc(x.label)}</button>`).join("")}</div>`;
      } else {
        body.innerHTML = `<div class="v-slicer"><input class="input v-slicer-q" placeholder="Rechercher" /><div class="v-slicer-list">${res.values.map((x) => `<label class="v-check" data-label="${esc(String(x.label).toLowerCase())}"><input type="checkbox" data-k="${esc(x.key)}"${sel.has(x.key) ? " checked" : ""}/><span>${esc(x.label)}</span><small>${x.count}</small></label>`).join("")}</div></div>`;
        body.querySelector(".v-slicer-q").addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); body.querySelectorAll(".v-check").forEach((l) => { l.hidden = q && !l.dataset.label.includes(q); }); });
      }
      body.onclick = (e) => {
        const k = e.target.closest("[data-k]");
        if (!k) return;
        const key = k.dataset.k;
        if (sel.has(key)) sel.delete(key); else sel.add(key);
        ctx.onSlicer?.(sel.size ? { col, op: "in", values: [...sel], bucket: v.slicer.bucket || "" } : null);
      };
      return res;
    }
    case "text":
      body.innerHTML = `<div class="v-text md">${renderMarkdown(v.text || "*Double-cliquez pour écrire…*")}</div>`;
      return res;
    case "ai":
      body.innerHTML = `<div class="v-text md">${v.answer ? renderMarkdown(v.answer) : `<p class="muted">${esc(v.question || "Analyse rédigée par l'IA à partir des données de la page.")}</p><p class="muted small">Cliquez sur « Générer » dans le volet Format.</p>`}</div>`;
      return res;
    default: {
      const empty = v.type === "scatter" ? !res.points?.length : !res.categories?.length;
      if (empty) { body.innerHTML = `<div class="v-empty">Aucune donnée pour ces champs et filtres.</div>`; return res; }
      body.innerHTML = "";
      const chart = echarts.init(body, null, { renderer: "canvas" });
      res.highlight = ctx.selection && ctx.selection.col === v.axis?.col ? ctx.selection.key : null;
      const opt = chartOption(v, res, ctx.theme || theme());
      // Capture (export, insertion dans un document) : pas d'animation, sinon
      // l'image est prise avant que les barres aient poussé.
      if (ctx.static) opt.animation = false;
      chart.setOption(opt, { notMerge: true });
      chart.on("click", (p) => {
        const key = p.data?.key ?? res.categories?.[p.dataIndex]?.key;
        if (key != null && v.axis?.col) ctx.onSelect?.(key, v.axis.col, v.axis.bucket || "");
      });
      charts.set(v.id, chart);
      return res;
    }
  }
}

/** Version texte d'un visuel (export Markdown/PDF, contexte IA). */
export function visualMarkdown(v, res) {
  const o = v.opts || {};
  const title = v.title || visualDef(v.type).label;
  if (!res) return `### ${title}\n\n_(pas de données)_`;
  switch (v.type) {
    case "card": case "gauge": return `### ${title}\n\n**${formatValue(res.value, o)}** ${res.label ? `— ${res.label}` : ""}${res.prev != null && res.prev ? ` (période précédente : ${formatValue(res.prev, o)})` : ""}`;
    case "multicard": return `### ${title}\n\n${res.items.map((i) => `- ${i.label} : **${formatValue(i.value, o)}**`).join("\n")}`;
    case "table": return `### ${title}\n\n| ${res.head.join(" | ")} |\n| ${res.head.map(() => "---").join(" | ")} |\n${res.rows.slice(0, 40).map((r) => `| ${r.map((c, i) => (res.numeric[i] ? formatValue(c, o) : String(c ?? "").replace(/\|/g, "/"))).join(" | ")} |`).join("\n")}`;
    case "text": return v.text || "";
    case "ai": return `### ${title}\n\n${v.answer || ""}`;
    case "slicer": case "matrix": return "";
    default:
      if (!res.categories) return `### ${title}`;
      return `### ${title}\n\n| ${v.axis?.col || ""} | ${res.series.map((s) => s.name).join(" | ")} |\n| --- | ${res.series.map(() => "---").join(" | ")} |\n${res.categories.slice(0, 30).map((c, i) => `| ${c.label} | ${res.series.map((s) => formatValue(s.values[i], o)).join(" | ")} |`).join("\n")}`;
  }
}

export { AGGS, DATE_BUCKETS, aggregate };
