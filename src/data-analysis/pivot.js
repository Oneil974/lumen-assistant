// Reporting — tableaux croisés dynamiques.
//
// Un bloc « croisé » prend le résultat d'une source (colonnes + lignes) et le
// replie : des champs en LIGNES (un ou plusieurs niveaux), des champs en
// COLONNES (idem), et des MESURES (champ + agrégat + format). Tout le reste
// est du réglage : filtres, regroupement des dates par mois/trimestre/année,
// sous-totaux par niveau, totaux, tri, top N, affichage en part du total,
// variation vs période précédente, mise en couleur.
//
// Le calcul est une fonction pure (`buildPivot`) : le rendu HTML et l'export
// Markdown lisent la même structure, et le moteur se teste sans interface.

import { AGGREGATES, aggregate, formatValue, toNumber } from "./charts.js";

export const PIVOT_AGGREGATES = {
  ...AGGREGATES,
  count_distinct: "Compte distinct",
  median: "Médiane",
};

export const DATE_BUCKETS = {
  none: "Valeur telle quelle", year: "Année", quarter: "Trimestre", month: "Mois", week: "Semaine ISO", day: "Jour", weekday: "Jour de semaine",
};

export const PIVOT_OPERATORS = {
  eq: "égal à", ne: "différent de", contains: "contient", ncontains: "ne contient pas",
  gt: "supérieur à", lt: "inférieur à", empty: "est vide", filled: "est renseigné",
};

export const SHOW_AS = { value: "Valeur", pct_total: "% du total", pct_row: "% de la ligne", pct_col: "% de la colonne" };

const EMPTY = "(vide)";
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** Un bloc croisé neuf, prêt à configurer. */
export function blankPivot(sourceId) {
  return {
    sourceId, rows: [], cols: [], values: [], filters: [], buckets: {},
    subtotals: true, rowTotals: true, colTotals: true, sort: "label", sortDir: "asc", topN: 0,
    showAs: "value", compare: false, heatmap: false, emptyAs: "—",
  };
}

// ── Dates ──────────────────────────────────────────────────────────────────

function parseDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  if (/^\d{10,13}$/.test(s)) return new Date(s.length === 10 ? Number(s) * 1000 : Number(s));
  return null;
}

const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
};

/** Libellé du groupe d'un champ, selon son mode de regroupement. Le préfixe
 *  numérique (`01·`) garde l'ordre chronologique au tri alphabétique ; il est
 *  retiré à l'affichage. */
function bucketValue(raw, mode) {
  if (!mode || mode === "none") return raw === null || raw === undefined || String(raw).trim() === "" ? EMPTY : String(raw);
  const d = parseDate(raw);
  if (!d) return EMPTY;
  const y = d.getFullYear();
  switch (mode) {
    case "year": return String(y);
    case "quarter": return `${y} T${Math.floor(d.getMonth() / 3) + 1}`;
    case "month": return `${y}-${String(d.getMonth() + 1).padStart(2, "0")}·${MONTHS[d.getMonth()]} ${y}`;
    case "week": return `${y}-S${String(isoWeek(d)).padStart(2, "0")}`;
    case "day": return `${y}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    case "weekday": return `${d.getDay() || 7}·${DAYS[d.getDay()]}`;
    default: return String(raw);
  }
}
const displayKey = (k) => (k.includes("·") ? k.slice(k.indexOf("·") + 1) : k);

// ── Filtres ────────────────────────────────────────────────────────────────

function passes(row, idx, filters) {
  for (const f of filters || []) {
    const i = idx[f.column];
    if (i === undefined || !f.op) continue;
    const v = row[i];
    const s = String(v ?? "").toLowerCase();
    const t = String(f.value ?? "").toLowerCase();
    const n = toNumber(v), tn = toNumber(f.value);
    const ok = {
      eq: () => (Number.isFinite(n) && Number.isFinite(tn) ? n === tn : s === t),
      ne: () => (Number.isFinite(n) && Number.isFinite(tn) ? n !== tn : s !== t),
      contains: () => s.includes(t),
      ncontains: () => !s.includes(t),
      gt: () => n > tn,
      lt: () => n < tn,
      empty: () => v === null || v === undefined || String(v).trim() === "",
      filled: () => !(v === null || v === undefined || String(v).trim() === ""),
    }[f.op];
    if (ok && !ok()) return false;
  }
  return true;
}

function measure(values, agg) {
  if (agg === "count_distinct") return new Set(values.map((v) => String(v ?? ""))).size;
  if (agg === "median") {
    const n = values.map(toNumber).filter(Number.isFinite).sort((a, b) => a - b);
    if (!n.length) return 0;
    const m = Math.floor(n.length / 2);
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
  }
  return aggregate(values, agg);
}

// ── Calcul ─────────────────────────────────────────────────────────────────

/**
 * Construit le croisé.
 *
 * Rend { rowKeys: [[…]], colKeys: [[…]], values: [{…}], cell(rowKey, colKey, m),
 * rowTotal, colTotal, grand, subtotal(prefix, colKey, m) } où chaque mesure est
 * un nombre (ou null si aucune ligne). `previous` (même forme que `data`) sert
 * à la variation vs période précédente : `prev(rowKey, colKey, m)`.
 */
export function buildPivot(data, cfg, previous = null) {
  const columns = data?.columns || [];
  const idx = Object.fromEntries(columns.map((c, i) => [c, i]));
  const rowFields = (cfg.rows || []).filter((c) => c in idx);
  const colFields = (cfg.cols || []).filter((c) => c in idx);
  const values = (cfg.values || []).filter((v) => v.agg === "count" || v.field in idx);
  const buckets = cfg.buckets || {};
  const keyOf = (row, fields) => fields.map((f) => bucketValue(row[idx[f]], buckets[f]));

  const collect = (rows) => {
    const groups = new Map(); // "rowcol" → { rowKey, colKey, rows: [] }
    const rowSet = new Map(), colSet = new Map();
    for (const row of rows || []) {
      if (!passes(row, idx, cfg.filters)) continue;
      const rk = keyOf(row, rowFields), ck = keyOf(row, colFields);
      const rs = rk.join(""), cs = ck.join("");
      if (!rowSet.has(rs)) rowSet.set(rs, rk);
      if (!colSet.has(cs)) colSet.set(cs, ck);
      const g = `${rs}${cs}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(row);
    }
    return { groups, rowSet, colSet };
  };

  const cur = collect(data?.rows);
  const prev = previous && !previous.error ? collect(previous.rows) : null;

  const agg = (rows, m) => (!rows || !rows.length ? null : measure(m.agg === "count" ? rows : rows.map((r) => r[idx[m.field]]), m.agg));
  const cache = new Map();
  const cellOf = (src, rs, cs, m, mi) => {
    const k = `${src === cur ? "c" : "p"}|${rs}|${cs}|${mi}`;
    if (cache.has(k)) return cache.get(k);
    const v = agg(src.groups.get(`${rs}${cs}`), m);
    cache.set(k, v);
    return v;
  };
  // Totaux : recalculés sur l'union des lignes brutes (une moyenne de moyennes
  // serait fausse), à partir des groupes qui commencent par le préfixe.
  const rowsMatching = (src, rowPrefix, colPrefix) => {
    const out = [];
    for (const [g, rows] of src.groups) {
      const [rs, cs] = g.split("");
      if (rowPrefix !== null && !(rs === rowPrefix || rs.startsWith(rowPrefix + "") || rowPrefix === "")) continue;
      if (colPrefix !== null && !(cs === colPrefix || cs.startsWith(colPrefix + "") || colPrefix === "")) continue;
      out.push(...rows);
    }
    return out;
  };
  const totalOf = (src, rowPrefix, colPrefix, m, mi) => {
    const k = `${src === cur ? "c" : "p"}|T|${rowPrefix}|${colPrefix}|${mi}`;
    if (cache.has(k)) return cache.get(k);
    const v = agg(rowsMatching(src, rowPrefix, colPrefix), m);
    cache.set(k, v);
    return v;
  };

  // Clés triées. Le tri par valeur porte sur la première mesure, total de ligne.
  let rowKeys = [...cur.rowSet.values()];
  let colKeys = [...cur.colSet.values()];
  const byLabel = (a, b) => { for (let i = 0; i < a.length; i++) { const c = a[i].localeCompare(b[i], "fr", { numeric: true }); if (c) return c; } return 0; };
  colKeys.sort(byLabel);
  if (cfg.sort === "value" && values.length) {
    const m = values[0];
    const dir = cfg.sortDir === "asc" ? 1 : -1;
    rowKeys.sort((a, b) => {
      // Tri à l'intérieur de chaque niveau : on compare d'abord les parents.
      for (let d = 1; d <= Math.max(a.length, b.length); d++) {
        const pa = a.slice(0, d).join(""), pb = b.slice(0, d).join("");
        if (pa === pb) continue;
        const va = totalOf(cur, pa, "", m, 0) ?? -Infinity, vb = totalOf(cur, pb, "", m, 0) ?? -Infinity;
        if (va !== vb) return (va - vb) * dir;
        return byLabel(a.slice(0, d), b.slice(0, d));
      }
      return 0;
    });
  } else {
    rowKeys.sort(byLabel);
    if (cfg.sortDir === "desc") rowKeys.reverse();
  }
  if (Number(cfg.topN) > 0 && rowFields.length) {
    // Top N sur le PREMIER niveau : on garde les N premiers parents et tous leurs enfants.
    const keep = new Set();
    for (const rk of rowKeys) { if (keep.size < Number(cfg.topN) || keep.has(rk[0])) keep.add(rk[0]); }
    rowKeys = rowKeys.filter((rk) => keep.has(rk[0]));
  }

  const rs = (k) => k.join("");
  return {
    rowFields, colFields, values, rowKeys, colKeys,
    cell: (rk, ck, mi) => cellOf(cur, rs(rk), rs(ck), values[mi], mi),
    prev: prev ? (rk, ck, mi) => cellOf(prev, rs(rk), rs(ck), values[mi], mi) : null,
    rowTotal: (rk, mi) => totalOf(cur, rs(rk), "", values[mi], mi),
    colTotal: (ck, mi) => totalOf(cur, "", rs(ck), values[mi], mi),
    subtotal: (prefix, ck, mi) => totalOf(cur, prefix.join(""), ck === null ? "" : rs(ck), values[mi], mi),
    prevRowTotal: prev ? (rk, mi) => totalOf(prev, rs(rk), "", values[mi], mi) : null,
    grand: (mi) => totalOf(cur, "", "", values[mi], mi),
    empty: !rowKeys.length && !colKeys.length,
  };
}

// ── Rendu ──────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Valeur affichée selon le mode « afficher comme ». */
function shown(p, cfg, v, rk, ck, mi) {
  if (v === null || v === undefined) return null;
  const mode = cfg.showAs || "value";
  if (mode === "value") return v;
  const base = mode === "pct_total" ? p.grand(mi) : mode === "pct_row" ? p.rowTotal(rk, mi) : p.colTotal(ck, mi);
  return base ? (v / base) * 100 : null;
}

function fmt(v, m, cfg) {
  if (v === null || v === undefined || Number.isNaN(v)) return cfg.emptyAs ?? "—";
  if ((cfg.showAs || "value") !== "value") return formatValue(v, { format: "percent", decimals: 1 });
  return formatValue(v, { format: m.format || "auto", decimals: m.decimals });
}

function delta(cur, before) {
  if (cur === null || before === null || before === undefined || before === 0) return "";
  const d = ((cur - before) / Math.abs(before)) * 100;
  const cls = d > 0.5 ? "up" : d < -0.5 ? "down" : "flat";
  return `<span class="pv-delta ${cls}">${d > 0 ? "▲" : d < 0 ? "▼" : "="} ${Math.abs(d).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %</span>`;
}

/** Table HTML du croisé, en-têtes de colonnes multi-niveaux compris. */
export function renderPivotHtml(p, cfg) {
  if (!p.values.length) return `<div class="empty">Ajoutez au moins une mesure (un champ et un agrégat).</div>`;
  if (p.empty) return `<div class="empty">Aucune ligne après filtrage.</div>`;
  const nv = p.values.length;
  const colGroups = p.colKeys.length ? p.colKeys : [[]];
  const withTotals = cfg.rowTotals !== false && p.colFields.length > 0;
  const cmp = cfg.compare && p.prev;
  // Colonnes de données = (groupes de colonnes [+ total]) × mesures.
  const dataCols = [...colGroups.map((ck) => ({ ck, total: false })), ...(withTotals ? [{ ck: null, total: true }] : [])];

  // Étendue min/max par mesure pour la mise en couleur.
  const ranges = p.values.map((_, mi) => {
    let min = Infinity, max = -Infinity;
    for (const rk of p.rowKeys) for (const ck of colGroups) { const v = shown(p, cfg, p.cell(rk, ck, mi), rk, ck, mi); if (v !== null) { min = Math.min(min, v); max = Math.max(max, v); } }
    return { min, max };
  });
  const heat = (v, mi) => {
    if (!cfg.heatmap || v === null) return "";
    const { min, max } = ranges[mi];
    if (!Number.isFinite(min) || max === min) return "";
    const t = (v - min) / (max - min);
    return ` style="background:color-mix(in oklab, var(--accent) ${Math.round(8 + t * 42)}%, transparent)"`;
  };

  // En-têtes : une rangée par niveau de colonne, puis une rangée de mesures si
  // plusieurs ; les libellés de champs de ligne à gauche.
  let thead = "";
  const rowHeadCells = p.rowFields.length ? p.rowFields : ["Total"];
  const levels = p.colFields.length;
  for (let lvl = 0; lvl < levels; lvl++) {
    let cells = lvl === 0 ? rowHeadCells.map((f) => `<th rowspan="${levels + (nv > 1 ? 1 : 0)}" class="pv-rowhead">${esc(f)}</th>`).join("") : "";
    let i = 0;
    while (i < colGroups.length) {
      const key = colGroups[i].slice(0, lvl + 1).join("");
      let span = 1;
      while (i + span < colGroups.length && colGroups[i + span].slice(0, lvl + 1).join("") === key) span++;
      cells += `<th colspan="${span * nv}" class="pv-colhead">${esc(displayKey(colGroups[i][lvl]))}</th>`;
      i += span;
    }
    if (withTotals && lvl === 0) cells += `<th colspan="${nv}" rowspan="${levels}" class="pv-total-head">Total</th>`;
    thead += `<tr>${cells}</tr>`;
  }
  if (nv > 1 || levels === 0) {
    let cells = levels === 0 ? rowHeadCells.map((f) => `<th class="pv-rowhead">${esc(f)}</th>`).join("") : "";
    for (const dc of dataCols) for (const m of p.values) cells += `<th class="num${dc.total ? " pv-total-head" : ""}">${esc(m.label || `${PIVOT_AGGREGATES[m.agg] || m.agg}${m.field && m.agg !== "count" ? ` · ${m.field}` : ""}`)}${cmp ? `<small>vs préc.</small>` : ""}</th>`;
    thead += `<tr>${cells}</tr>`;
  }

  // Corps : lignes triées, avec sous-totaux à chaque changement de parent.
  let tbody = "";
  const cellsFor = (rk, totalRowPrefix = null) => {
    let out = "";
    for (const dc of dataCols) {
      for (let mi = 0; mi < nv; mi++) {
        let v, before = null;
        if (totalRowPrefix !== null) v = dc.total ? p.subtotal(totalRowPrefix, null, mi) : p.subtotal(totalRowPrefix, dc.ck, mi);
        else if (dc.total) { v = p.rowTotal(rk, mi); before = cmp ? p.prevRowTotal(rk, mi) : null; }
        else { v = p.cell(rk, dc.ck, mi); before = cmp ? p.prev(rk, dc.ck, mi) : null; }
        const sv = totalRowPrefix !== null || dc.total ? v : shown(p, cfg, v, rk, dc.ck, mi);
        out += `<td class="num${dc.total ? " pv-total" : ""}"${dc.total || totalRowPrefix !== null ? "" : heat(sv, mi)}>${esc(fmt(sv, p.values[mi], { ...cfg, showAs: dc.total || totalRowPrefix !== null ? "value" : cfg.showAs }))}${before !== null && cmp ? delta(v, before) : ""}</td>`;
      }
    }
    return out;
  };
  const depth = p.rowFields.length;
  const rows = p.rowKeys;
  for (let i = 0; i < rows.length; i++) {
    const rk = rows[i];
    const prevKey = rows[i - 1] || [];
    // Cellules de tête : on n'écrit un niveau que s'il change par rapport à la ligne d'avant.
    let head = "";
    for (let d = 0; d < depth; d++) {
      const same = i > 0 && rk.slice(0, d + 1).join("") === prevKey.slice(0, d + 1).join("");
      head += `<td class="pv-rowlabel lvl-${d}">${same ? "" : esc(displayKey(rk[d]))}</td>`;
    }
    if (!depth) head = `<td class="pv-rowlabel">Total</td>`;
    tbody += `<tr>${head}${cellsFor(rk)}</tr>`;
    // Sous-total : quand le prochain élément change de parent (à chaque niveau sauf le dernier).
    if (cfg.subtotals !== false && depth > 1) {
      const next = rows[i + 1] || [];
      for (let d = depth - 2; d >= 0; d--) {
        const prefix = rk.slice(0, d + 1);
        if (next.slice(0, d + 1).join("") !== prefix.join("")) {
          const label = `Total ${displayKey(prefix[d])}`;
          tbody += `<tr class="pv-subtotal lvl-${d}"><td class="pv-rowlabel" colspan="${depth}">${esc(label)}</td>${cellsFor(null, prefix)}</tr>`;
        }
      }
    }
  }
  let tfoot = "";
  if (cfg.colTotals !== false && depth > 0) {
    let cells = "";
    for (const dc of dataCols) for (let mi = 0; mi < nv; mi++) {
      const v = dc.total ? p.grand(mi) : p.colTotal(dc.ck, mi);
      cells += `<td class="num pv-total">${esc(fmt(v, p.values[mi], { ...cfg, showAs: "value" }))}</td>`;
    }
    tfoot = `<tfoot><tr><td class="pv-rowlabel" colspan="${depth}">Total général</td>${cells}</tr></tfoot>`;
  }
  return `<div class="table-card pv-wrap"><table class="grid pivot"><thead>${thead}</thead><tbody>${tbody}</tbody>${tfoot}</table></div>`;
}

/** Le croisé en tableau Markdown (pipe table) pour l'export PDF/HTML. */
export function renderPivotMarkdown(p, cfg) {
  if (!p.values.length || p.empty) return "_Croisé vide._";
  const nv = p.values.length;
  const colGroups = p.colKeys.length ? p.colKeys : [[]];
  const withTotals = cfg.rowTotals !== false && p.colFields.length > 0;
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const mLabel = (m) => m.label || `${PIVOT_AGGREGATES[m.agg] || m.agg}${m.field && m.agg !== "count" ? ` ${m.field}` : ""}`;
  const head = [...(p.rowFields.length ? p.rowFields : ["Total"])];
  for (const ck of colGroups) for (const m of p.values) head.push(`${ck.map(displayKey).join(" / ")}${ck.length && nv > 1 ? " · " : ""}${ck.length && nv === 1 ? "" : mLabel(m)}`.trim());
  if (withTotals) for (const m of p.values) head.push(`Total${nv > 1 ? ` · ${mLabel(m)}` : ""}`);
  const lines = [`| ${head.map(cell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const rk of p.rowKeys) {
    const row = [...(p.rowFields.length ? rk.map(displayKey) : ["Total"])];
    for (const ck of colGroups) for (let mi = 0; mi < nv; mi++) row.push(fmt(shown(p, cfg, p.cell(rk, ck, mi), rk, ck, mi), p.values[mi], cfg));
    if (withTotals) for (let mi = 0; mi < nv; mi++) row.push(fmt(p.rowTotal(rk, mi), p.values[mi], { ...cfg, showAs: "value" }));
    lines.push(`| ${row.map(cell).join(" | ")} |`);
  }
  if (cfg.colTotals !== false && p.rowFields.length) {
    const row = ["Total général", ...Array(Math.max(0, p.rowFields.length - 1)).fill("")];
    for (const ck of colGroups) for (let mi = 0; mi < nv; mi++) row.push(fmt(p.colTotal(ck, mi), p.values[mi], { ...cfg, showAs: "value" }));
    if (withTotals) for (let mi = 0; mi < nv; mi++) row.push(fmt(p.grand(mi), p.values[mi], { ...cfg, showAs: "value" }));
    lines.push(`| ${row.map(cell).join(" | ")} |`);
  }
  return lines.join("\n");
}
