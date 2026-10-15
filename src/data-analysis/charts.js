// Reporting — fabrication des graphiques (Apache ECharts, vendorisé dans lib/).
//
// Le module ne connaît QUE des résultats de requête : `{ columns, rows }`, où
// `rows` est un tableau de tableaux, comme le renvoie `table_query`. Il ignore
// tout des rapports, des sources et de l'app — ce qui le rend testable et
// réutilisable pour n'importe quel bloc.
//
// Le thème n'est jamais peint en dur : les couleurs se lisent sur les jetons
// CSS du document, donc un rapport suit le thème clair/sombre et l'accent de
// l'orbe sans une ligne de plus.

import * as echarts from "../lib/echarts.esm.min.js";

export const CHART_TYPES = {
  bar: "Barres", hbar: "Barres horizontales", line: "Courbe", area: "Aire",
  pie: "Secteurs", donut: "Anneau", scatter: "Nuage de points", gauge: "Jauge",
};

export const AGGREGATES = {
  sum: "Somme", avg: "Moyenne", count: "Compte", min: "Minimum", max: "Maximum",
  first: "Première valeur", last: "Dernière valeur",
};

// Palette : l'accent du bureau en tête, puis des teintes qui s'en distinguent
// sans jurer avec lui.
const FALLBACK = ["#0a84ff", "#0f9b8e", "#ff9f0a", "#ff375f", "#bf5af2", "#32d74b", "#64d2ff", "#ffd60a"];

export function themeVars(root = document.documentElement) {
  const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  const accent = css("--accent") || FALLBACK[0];
  return {
    text: css("--text") || "#1c1c1e",
    muted: css("--text-muted") || css("--muted") || "rgba(60,60,67,.62)",
    border: css("--border") || "rgba(0,0,0,.08)",
    accent,
    palette: [accent, ...FALLBACK.filter((c) => c.toLowerCase() !== accent.toLowerCase())],
  };
}

export const toNumber = (v) => {
  if (typeof v === "number") return v;
  if (v === null || v === undefined || v === "") return NaN;
  // Les nombres arrivent parfois formatés à la française (« 1 234,56 »).
  return Number(String(v).replace(/\s/g, "").replace(",", "."));
};

export function aggregate(values, agg) {
  const nums = values.map(toNumber).filter(Number.isFinite);
  switch (agg) {
    case "count": return values.length;
    case "avg": return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case "min": return nums.length ? Math.min(...nums) : 0;
    case "max": return nums.length ? Math.max(...nums) : 0;
    case "first": return nums.length ? nums[0] : 0;
    case "last": return nums.length ? nums[nums.length - 1] : 0;
    default: return nums.reduce((a, b) => a + b, 0);
  }
}

const indexOf = (data, name) => (data?.columns || []).indexOf(name);

/** Regroupe un résultat par la colonne X et agrège la colonne Y. */
export function groupRows(data, { x, y, agg = "sum", limit = 24, sort = "value" }) {
  const xi = indexOf(data, x);
  const yi = indexOf(data, y);
  if (xi < 0) return [];
  const groups = new Map();
  for (const row of data.rows || []) {
    const key = String(row[xi] ?? "").trim() || "(vide)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(yi >= 0 ? row[yi] : 1);
  }
  let out = [...groups.entries()].map(([label, vals]) => ({
    label, value: yi >= 0 ? aggregate(vals, agg) : vals.length,
  }));
  if (sort === "label") out.sort((a, b) => a.label.localeCompare(b.label, "fr"));
  else if (sort === "asc") out.sort((a, b) => a.value - b.value);
  else out.sort((a, b) => b.value - a.value);
  return out.slice(0, Math.max(1, Number(limit) || 24));
}

/** Valeur d'un indicateur : une agrégation sur une colonne du résultat. */
export function kpiValue(data, { y, agg = "sum" }) {
  const yi = indexOf(data, y);
  if (yi < 0) return (data?.rows || []).length;
  return aggregate((data.rows || []).map((r) => r[yi]), agg);
}

export function formatValue(value, { format = "auto", prefix = "", suffix = "", decimals } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "—");
  const opts = decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  if (format === "money") return `${prefix}${n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", ...opts })}${suffix}`;
  if (format === "percent") return `${prefix}${n.toLocaleString("fr-FR", { maximumFractionDigits: decimals ?? 1 })} %${suffix}`;
  if (format === "integer") return `${prefix}${Math.round(n).toLocaleString("fr-FR")}${suffix}`;
  return `${prefix}${n.toLocaleString("fr-FR", { maximumFractionDigits: decimals ?? 2 })}${suffix}`;
}

/** Option ECharts d'un bloc graphique. */
export function chartOption(block, data, t = themeVars()) {
  const type = block.chart || "bar";
  const color = t.palette[0];
  const base = {
    color: t.palette,
    textStyle: { color: t.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif" },
    tooltip: {
      trigger: ["pie", "donut", "gauge", "scatter"].includes(type) ? "item" : "axis",
      backgroundColor: "rgba(28,28,30,.88)", borderWidth: 0,
      textStyle: { color: "#f5f5f7", fontSize: 12 },
      extraCssText: "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);",
    },
    grid: { left: 8, right: 16, top: 26, bottom: 8, containLabel: true },
    animationDuration: 380,
  };
  const axis = {
    axisLine: { lineStyle: { color: t.border } },
    axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    splitLine: { lineStyle: { color: t.border } },
    axisTick: { show: false },
  };

  if (type === "scatter") {
    const xi = indexOf(data, block.x), yi = indexOf(data, block.y);
    const points = (data.rows || [])
      .map((r) => [toNumber(r[xi]), toNumber(r[yi])])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .slice(0, 3000);
    return { ...base,
      xAxis: { type: "value", name: block.x, ...axis },
      yAxis: { type: "value", name: block.y, ...axis },
      series: [{ type: "scatter", data: points, symbolSize: 7, itemStyle: { color, opacity: .72 } }] };
  }

  if (type === "gauge") {
    const value = kpiValue(data, block);
    const max = Number(block.max) || Math.max(1, Math.ceil(value * 1.25));
    return { ...base,
      series: [{ type: "gauge", min: Number(block.min) || 0, max,
        progress: { show: true, roundCap: true, width: 12, itemStyle: { color } },
        axisLine: { lineStyle: { width: 12, color: [[1, t.border]] } },
        pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { show: false }, anchor: { show: false },
        title: { show: false },
        detail: { valueAnimation: true, fontSize: 24, color: t.text, offsetCenter: [0, 0],
          formatter: (v) => formatValue(v, block) },
        data: [{ value }] }] };
  }

  const rows = groupRows(data, block);
  if (type === "pie" || type === "donut") {
    return { ...base,
      legend: { bottom: 0, textStyle: { color: t.muted, fontSize: 11 }, icon: "circle", itemWidth: 9, itemHeight: 9 },
      series: [{ type: "pie", radius: type === "donut" ? ["52%", "76%"] : "72%", center: ["50%", "46%"],
        itemStyle: { borderRadius: 6, borderColor: "transparent", borderWidth: 2 },
        label: { show: false },
        data: rows.map((d) => ({ name: d.label, value: d.value })) }] };
  }

  const horizontal = type === "hbar";
  const ordered = horizontal ? rows.slice().reverse() : rows;
  const catAxis = { type: "category", data: ordered.map((d) => d.label), ...axis };
  const valAxis = { type: "value", ...axis };
  const values = ordered.map((d) => d.value);
  const series = type === "line" || type === "area"
    ? { type: "line", data: values, smooth: true, symbolSize: 5,
        lineStyle: { width: 2.4, color }, itemStyle: { color },
        ...(type === "area" ? { areaStyle: { opacity: .16, color } } : {}) }
    : { type: "bar", data: values, barMaxWidth: 38,
        itemStyle: { color, borderRadius: horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0] } };
  return { ...base,
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal ? catAxis : valAxis,
    series: [series] };
}

// Instances vivantes, pour les redimensionner et les libérer proprement.
const charts = new Map();

export function drawChart(el, block, data) {
  disposeChart(el.dataset.block);
  const chart = echarts.init(el, null, { renderer: "canvas" });
  chart.setOption(chartOption(block, data), { notMerge: true });
  charts.set(el.dataset.block, chart);
  return chart;
}

export function disposeChart(id) {
  const chart = charts.get(id);
  if (chart) { chart.dispose(); charts.delete(id); }
}

export function disposeAll() {
  charts.forEach((c) => c.dispose());
  charts.clear();
}

export function resizeAll() {
  charts.forEach((c) => c.resize());
}

/** Image PNG (data URL) du graphique d'un bloc, ou null s'il n'est pas peint. */
export function chartImage(id, background = "#ffffff") {
  const chart = charts.get(id);
  return chart ? chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: background }) : null;
}
