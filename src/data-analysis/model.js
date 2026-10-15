// Modèle de données d'Analyse de données : tables chargées depuis les
// sandboxes (CSV/TSV), le catalogue (Bases locales, connexions) ou une requête
// SQL paramétrée, puis interrogées par les visuels (regroupements, mesures,
// filtres, période). Pur JS, sans DOM : testable et partagé par le canevas,
// l'export et l'assistant IA.
//
// Une table chargée : { id, name, columns: [noms], types: {nom: type},
// rows: [[...]] } — des tableaux de valeurs, comme `table_query`.

import * as db from "../tables/client.js";
import { readDatasetCsv } from "../lib/data-catalog.js";
import { applyParams, previousPeriod } from "./run.js";

// ---- Valeurs ------------------------------------------------------------------
export function toNum(v) {
  if (typeof v === "number") return v;
  if (v === null || v === undefined || v === "") return NaN;
  let s = String(v).trim().replace(/[\s  €$%]/g, "");
  // « 1.234,56 » ou « 1234,5 » (français) → point décimal.
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,(?=\d{3}\b)/g, "");
  return Number(s);
}

export function parseDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  if (/^\d{10,13}$/.test(s)) return new Date(s.length === 10 ? Number(s) * 1000 : Number(s));
  return null;
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

export const DATE_BUCKETS = { none: "Valeur exacte", year: "Année", quarter: "Trimestre", month: "Mois", week: "Semaine", day: "Jour", weekday: "Jour de semaine" };

/** Clé de regroupement triable + libellé affiché. */
export function bucketOf(v, mode) {
  if (!mode || mode === "none") {
    const s = v === null || v === undefined || String(v).trim() === "" ? "(vide)" : String(v);
    return { key: s, label: s };
  }
  const d = parseDate(v);
  if (!d) return { key: "~", label: "(vide)" };
  const y = d.getFullYear(), mo = d.getMonth();
  switch (mode) {
    case "year": return { key: String(y), label: String(y) };
    case "quarter": return { key: `${y}-Q${Math.floor(mo / 3) + 1}`, label: `T${Math.floor(mo / 3) + 1} ${y}` };
    case "month": return { key: `${y}-${String(mo + 1).padStart(2, "0")}`, label: `${MONTHS[mo]} ${y}` };
    case "week": {
      const t = new Date(Date.UTC(y, mo, d.getDate()));
      const day = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - day);
      const w = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
      return { key: `${t.getUTCFullYear()}-W${String(w).padStart(2, "0")}`, label: `S${w} ${t.getUTCFullYear()}` };
    }
    case "day": return { key: iso(d), label: d.toLocaleDateString("fr-FR") };
    case "weekday": return { key: String(d.getDay() || 7), label: DAYS[d.getDay()] };
    default: return { key: String(v), label: String(v) };
  }
}

// ---- CSV ------------------------------------------------------------------
function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 8).join("\n");
  let best = ",", score = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const n = sample.split(d).length - 1;
    if (n > score) { best = d; score = n; }
  }
  return best;
}

export function parseCsv(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const delimiter = detectDelimiter(src);
  const out = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  row.push(field); out.push(row);
  const clean = out.filter((r) => r.some((v) => String(v || "").trim() !== ""));
  if (clean.length < 1) throw new Error("Fichier vide.");
  const seen = new Map();
  const columns = clean[0].map((h, i) => {
    let n = String(h || "").trim() || `col_${i + 1}`;
    const k = seen.get(n) || 0;
    seen.set(n, k + 1);
    if (k) n = `${n}_${k + 1}`;
    return n;
  });
  const rows = clean.slice(1).map((cells) => columns.map((_, i) => String(cells[i] ?? "").trim()));
  return { columns, rows, delimiter };
}

/** Table → CSV (export, envoi). */
export function toCsv(columns, rows) {
  const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
}

// ---- Types et profil ---------------------------------------------------------
export function detectType(values) {
  const ne = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  if (!ne.length) return "text";
  const sample = ne.length > 2000 ? ne.filter((_, i) => i % Math.ceil(ne.length / 2000) === 0) : ne;
  const nums = sample.filter((v) => Number.isFinite(toNum(v))).length;
  if (nums / sample.length >= 0.9) return "number";
  const dates = sample.filter((v) => parseDate(v)).length;
  if (dates / sample.length >= 0.85) return "date";
  const uniq = new Set(sample.map(String)).size;
  if (uniq <= Math.max(16, sample.length * 0.25)) return "category";
  return "text";
}

export function typesOf(columns, rows) {
  const out = {};
  columns.forEach((c, i) => { out[c] = detectType(rows.map((r) => r[i])); });
  return out;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
export function profileTable(t) {
  const cols = t.columns.map((name, i) => {
    const values = t.rows.map((r) => r[i]);
    const ne = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
    const counts = new Map();
    ne.forEach((v) => counts.set(String(v), (counts.get(String(v)) || 0) + 1));
    const p = { name, type: t.types[name], missing: values.length - ne.length, missing_rate: values.length ? (values.length - ne.length) / values.length : 0, unique: counts.size, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([value, count]) => ({ value, count })), examples: [...counts.keys()].slice(0, 4) };
    if (p.type === "number") {
      const nums = ne.map(toNum).filter(Number.isFinite).sort((a, b) => a - b);
      if (nums.length) {
        const m = mean(nums);
        Object.assign(p, { min: nums[0], max: nums[nums.length - 1], sum: nums.reduce((a, b) => a + b, 0), mean: m, median: nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2, stddev: Math.sqrt(mean(nums.map((v) => (v - m) ** 2))) });
      }
    }
    if (p.type === "date") {
      const ds = ne.map(parseDate).filter(Boolean).sort((a, b) => a - b);
      if (ds.length) { p.min_date = iso(ds[0]); p.max_date = iso(ds[ds.length - 1]); }
    }
    return p;
  });
  const numeric = cols.filter((c) => c.type === "number").map((c) => c.name);
  const correlations = [];
  for (let a = 0; a < numeric.length; a++) for (let b = a + 1; b < numeric.length; b++) {
    const ia = t.columns.indexOf(numeric[a]), ib = t.columns.indexOf(numeric[b]);
    const pairs = t.rows.map((r) => [toNum(r[ia]), toNum(r[ib])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (pairs.length < 3) continue;
    const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
    let n = 0, dx = 0, dy = 0;
    for (const [x, y] of pairs) { n += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2; }
    const corr = n / Math.sqrt(dx * dy);
    if (Number.isFinite(corr)) correlations.push({ x: numeric[a], y: numeric[b], corr, n: pairs.length });
  }
  correlations.sort((x, y) => Math.abs(y.corr) - Math.abs(x.corr));
  return { rows: t.rows.length, columns: cols, correlations: correlations.slice(0, 10) };
}

// ---- Chargement ----------------------------------------------------------------
/**
 * Charge une source du modèle.
 * src = { id, name, kind: "file"|"dataset"|"sql", sandboxId, path, item, baseId, sql, dateColumn }
 * period = { from, to } (requêtes :debut/:fin ; pas de filtre de date ici).
 */
export async function loadSource(src, { invoke, period }) {
  let columns = [], rows = [];
  if (src.kind === "file") {
    const res = await invoke("sandbox_read_file", { id: src.sandboxId, path: src.path });
    const text = typeof res === "string" ? res : res?.content || "";
    if (res?.truncated) console.warn(`[analyse] ${src.path} tronqué à la lecture`);
    ({ columns, rows } = parseCsv(text));
  } else if (src.kind === "dataset") {
    ({ columns, rows } = parseCsv(await readDatasetCsv(src.item)));
  } else if (src.kind === "sql") {
    const res = await db.query(src.baseId, applyParams(src.sql, period || {}));
    columns = res?.columns || [];
    rows = (res?.rows || []).map((r) => (Array.isArray(r) ? r : columns.map((c) => r?.[c])));
  } else if (src.kind === "inline") {
    columns = src.columns || []; rows = src.rows || [];
  }
  return { id: src.id, name: src.name, columns, rows, types: typesOf(columns, rows) };
}

/** La même source sur la période précédente (comparaisons). */
export async function loadPrevious(src, ctx) {
  if (src.kind !== "sql" || !ctx.period?.from) return null;
  try { return await loadSource(src, { ...ctx, period: previousPeriod(ctx.period) }); } catch { return null; }
}

// ---- Filtres -------------------------------------------------------------------
/**
 * Filtre = { col, op, values?, value?, value2? }
 *   op : in | notin | eq | ne | contains | gt | gte | lt | lte | between | empty | filled | top
 */
export function rowPredicate(t, filters) {
  const tests = [];
  for (const f of filters || []) {
    const i = t.columns.indexOf(f.col);
    if (i < 0 || !f.op) continue;
    const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";
    const set = new Set((f.values || []).map(String));
    const num = toNum(f.value), num2 = toNum(f.value2);
    const date = parseDate(f.value), date2 = parseDate(f.value2);
    const cmp = (v) => {
      if (t.types[f.col] === "date") { const d = parseDate(v); return d ? d.getTime() : NaN; }
      return toNum(v);
    };
    const a = t.types[f.col] === "date" ? (date ? date.getTime() : NaN) : num;
    const b = t.types[f.col] === "date" ? (date2 ? date2.getTime() + 86399999 : NaN) : num2;
    const bucket = f.bucket || "";
    const keyOf = (v) => (bucket ? bucketOf(v, bucket).key : String(v ?? ""));
    switch (f.op) {
      case "in": if (set.size) tests.push((r) => set.has(keyOf(r[i]))); break;
      case "notin": if (set.size) tests.push((r) => !set.has(keyOf(r[i]))); break;
      case "eq": tests.push((r) => (Number.isFinite(num) && Number.isFinite(toNum(r[i])) ? toNum(r[i]) === num : String(r[i] ?? "").toLowerCase() === String(f.value ?? "").toLowerCase())); break;
      case "ne": tests.push((r) => String(r[i] ?? "").toLowerCase() !== String(f.value ?? "").toLowerCase()); break;
      case "contains": tests.push((r) => String(r[i] ?? "").toLowerCase().includes(String(f.value ?? "").toLowerCase())); break;
      case "gt": tests.push((r) => cmp(r[i]) > a); break;
      case "gte": tests.push((r) => cmp(r[i]) >= a); break;
      case "lt": tests.push((r) => cmp(r[i]) < a); break;
      case "lte": tests.push((r) => cmp(r[i]) <= (t.types[f.col] === "date" ? b || a + 86399999 : a)); break;
      case "between":
        if (Number.isFinite(a) || Number.isFinite(b)) tests.push((r) => { const x = cmp(r[i]); return (!Number.isFinite(a) || x >= a) && (!Number.isFinite(b) || x <= b); });
        break;
      case "empty": tests.push((r) => isEmpty(r[i])); break;
      case "filled": tests.push((r) => !isEmpty(r[i])); break;
      default: break;
    }
  }
  return tests.length ? (r) => tests.every((fn) => fn(r)) : () => true;
}

export function filterTable(t, filters) {
  if (!filters?.length) return t;
  const ok = rowPredicate(t, filters);
  return { ...t, rows: t.rows.filter(ok) };
}

/** Filtre de période sur la colonne date d'une table (fichiers, catalogue). */
export function periodFilters(t, period, dateColumn) {
  if (!period?.from || !dateColumn || !t.columns.includes(dateColumn)) return [];
  return [{ col: dateColumn, op: "between", value: period.from, value2: period.to }];
}

// ---- Agrégations ---------------------------------------------------------------
export const AGGS = { sum: "Somme", avg: "Moyenne", count: "Nombre", distinct: "Nombre distinct", min: "Minimum", max: "Maximum", median: "Médiane" };

export function aggregate(values, agg) {
  if (agg === "count") return values.filter((v) => v !== null && v !== undefined && String(v) !== "").length;
  if (agg === "distinct") return new Set(values.map((v) => String(v ?? ""))).size;
  const nums = values.map(toNum).filter(Number.isFinite);
  if (!nums.length) return 0;
  switch (agg) {
    case "avg": return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min": return Math.min(...nums);
    case "max": return Math.max(...nums);
    case "median": { const s = nums.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
    default: return nums.reduce((a, b) => a + b, 0);
  }
}

/** Mesure par défaut d'une colonne selon son type. */
export const defaultAgg = (type) => (type === "number" ? "sum" : "count");

/**
 * Regroupe et agrège.
 * spec = { axis: { col, bucket }, legend: { col, bucket }?, measures: [{ col, agg }],
 *          sort: "value"|"label"|"asc", limit }
 * Rend { categories: [{key,label}], series: [{ name, values: [] }] }
 * — une série par mesure, ou par valeur de légende (une seule mesure alors).
 */
export function groupBy(t, spec) {
  const ai = t.columns.indexOf(spec.axis?.col);
  const li = spec.legend?.col ? t.columns.indexOf(spec.legend.col) : -1;
  const measures = (spec.measures || []).filter((m) => m.agg === "count" || t.columns.includes(m.col));
  const ms = measures.length ? measures : [{ col: "", agg: "count" }];
  const mIdx = ms.map((m) => t.columns.indexOf(m.col));
  const cats = new Map();   // key → { label, cells: Map(legendKey → values[][]) }
  const legends = new Map();
  for (const r of t.rows) {
    const c = ai >= 0 ? bucketOf(r[ai], spec.axis.bucket) : { key: "Total", label: "Total" };
    const l = li >= 0 ? bucketOf(r[li], spec.legend.bucket) : { key: "", label: "" };
    if (!cats.has(c.key)) cats.set(c.key, { label: c.label, cells: new Map() });
    if (li >= 0 && !legends.has(l.key)) legends.set(l.key, l.label);
    const cell = cats.get(c.key).cells;
    if (!cell.has(l.key)) cell.set(l.key, ms.map(() => []));
    const arr = cell.get(l.key);
    ms.forEach((m, k) => arr[k].push(mIdx[k] >= 0 ? r[mIdx[k]] : 1));
  }
  let categories = [...cats.entries()].map(([key, v]) => ({ key, label: v.label, cell: v.cells }));
  const valueOf = (cat, lk, k) => { const a = cat.cell.get(lk); return a ? aggregate(a[k], ms[k].agg) : 0; };
  // Valeur de tri : première mesure, toutes légendes confondues.
  const total = (cat) => (li >= 0 ? [...legends.keys()].reduce((s, lk) => s + valueOf(cat, lk, 0), 0) : valueOf(cat, "", 0));
  const isDate = spec.axis?.bucket && spec.axis.bucket !== "none";
  const sort = spec.sort || (isDate ? "label" : "value");
  if (sort === "label") categories.sort((a, b) => a.key.localeCompare(b.key, "fr", { numeric: true }));
  else if (sort === "asc") categories.sort((a, b) => total(a) - total(b));
  else categories.sort((a, b) => total(b) - total(a));
  const limit = Number(spec.limit) || 0;
  if (limit > 0 && categories.length > limit) categories = categories.slice(0, limit);
  let series;
  if (li >= 0) {
    const lks = [...legends.keys()].sort((a, b) => a.localeCompare(b, "fr", { numeric: true })).slice(0, 12);
    series = lks.map((lk) => ({ name: legends.get(lk), key: lk, values: categories.map((c) => valueOf(c, lk, 0)) }));
  } else {
    series = ms.map((m, k) => ({ name: m.col ? `${AGGS[m.agg] || m.agg} de ${m.col}` : "Nombre de lignes", key: `${m.agg}:${m.col}`, values: categories.map((c) => valueOf(c, "", k)) }));
  }
  return { categories: categories.map(({ key, label }) => ({ key, label })), series };
}

/** Valeur d'une mesure sur toute la table filtrée. */
export function measureValue(t, m) {
  if (!m) return t.rows.length;
  const i = t.columns.indexOf(m.col);
  if (i < 0) return m.agg === "count" ? t.rows.length : 0;
  return aggregate(t.rows.map((r) => r[i]), m.agg || "sum");
}

/** Valeurs distinctes d'une colonne (segments), avec effectifs. */
export function distinctValues(t, col, bucket = "") {
  const i = t.columns.indexOf(col);
  if (i < 0) return [];
  const m = new Map();
  for (const r of t.rows) {
    const b = bucketOf(r[i], bucket);
    const e = m.get(b.key) || { key: b.key, label: b.label, count: 0 };
    e.count++;
    m.set(b.key, e);
  }
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key, "fr", { numeric: true }));
}

export function minMax(t, col) {
  const i = t.columns.indexOf(col);
  if (i < 0) return null;
  if (t.types[col] === "date") {
    const ds = t.rows.map((r) => parseDate(r[i])).filter(Boolean).sort((a, b) => a - b);
    return ds.length ? { min: iso(ds[0]), max: iso(ds[ds.length - 1]) } : null;
  }
  const ns = t.rows.map((r) => toNum(r[i])).filter(Number.isFinite);
  return ns.length ? { min: Math.min(...ns), max: Math.max(...ns) } : null;
}

/** Résumé compact pour l'IA (schéma + quelques lignes). */
export function digest(t, rows = 8) {
  const p = profileTable(t);
  return {
    table: t.name, rows: t.rows.length,
    columns: p.columns.map((c) => ({ name: c.name, type: c.type, missing: c.missing, unique: c.unique, ...(c.type === "number" ? { min: c.min, max: c.max, mean: Math.round((c.mean || 0) * 100) / 100, sum: c.sum } : {}), ...(c.type === "date" ? { from: c.min_date, to: c.max_date } : {}), ...(c.type === "category" ? { values: c.top.map((x) => x.value).slice(0, 6) } : {}) })),
    sample: t.rows.slice(0, rows),
  };
}
