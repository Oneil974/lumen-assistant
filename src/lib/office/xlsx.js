// Excel (.xlsx) ⇄ classeur Calc (.lumensheet), via ExcelJS (vendorisé).
//
// Ce qui passe dans les deux sens : valeurs, FORMULES (texte de la formule,
// résultat mis en cache pour Excel), gras / italique / souligné, couleur du
// texte, fond, alignement, formats nombre (monétaire, pourcentage, date,
// décimales), largeur des colonnes, cellules fusionnées (à l'import, la valeur
// reste sur la cellule d'angle), plusieurs feuilles. Les feuilles graphiques
// de Calc n'ont pas d'équivalent direct : elles ne sont pas exportées.

import { cellKey, parseKey, colName } from "../../sandbox/sheets-formula.js";

const EXCELJS = () => import("../vendor/exceljs.js").then((m) => m.default);

const argbToHex = (argb) => {
  const v = String(argb || "");
  if (v.length === 8) return v.slice(2).toLowerCase() === "000000" && v.startsWith("00") ? "" : `#${v.slice(2)}`;
  if (v.length === 6) return `#${v}`;
  return "";
};
const hexToArgb = (hex) => {
  const h = String(hex || "").replace("#", "");
  return /^[0-9a-f]{6}$/i.test(h) ? `FF${h.toUpperCase()}` : null;
};

function fmtFromNumFmt(numFmt) {
  const f = String(numFmt || "");
  if (!f || f === "General") return null;
  const dec = ((f.split(".")[1] || "").match(/^[0#]+/) || [""])[0].length;
  if (/%/.test(f)) return { t: "percent", d: dec };
  if (/[€$£¥]|\[\$/.test(f)) return { t: "currency", d: dec };
  if (/[dmy]{1,4}/i.test(f) && !/0/.test(f)) return { t: "date" };
  if (/[0#]/.test(f)) return { d: dec };
  return null;
}

function numFmtFromFmt(f) {
  if (!f) return null;
  const dec = f.d ?? (f.t === "percent" ? 1 : f.t === "currency" ? 2 : null);
  const frac = dec ? `.${"0".repeat(dec)}` : "";
  if (f.t === "percent") return `0${frac}%`;
  if (f.t === "currency") return `#,##0${frac} [$€-40C]`;
  if (f.t === "date") return "dd/mm/yyyy";
  if (dec != null) return `#,##0${frac}`;
  return null;
}

/**
 * .xlsx → classeur Calc { title, sheets, active }.
 * @param {ArrayBuffer|Uint8Array} bytes
 */
export async function xlsxToSheets(bytes, title = "Classeur") {
  const ExcelJS = await EXCELJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
  const sheets = [];
  wb.eachSheet((ws) => {
    const sh = { name: ws.name, cells: {}, fmt: {}, widths: {}, cols: 26, rows: 100, source: null };
    let maxR = 0, maxC = 0;
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      row.eachCell({ includeEmpty: false }, (cell, cn) => {
        if (cell.isMerged && cell.master !== cell) return;
        const r = rn - 1, c = cn - 1;
        const key = cellKey(r, c);
        const v = cell.value;
        let raw = "";
        if (v && typeof v === "object") {
          if (v.formula || v.sharedFormula) raw = `=${v.formula || cell.formula || ""}`;
          else if (v.richText) raw = v.richText.map((t) => t.text).join("");
          else if (v.text != null) raw = String(v.text);
          else if (v instanceof Date) raw = v.toISOString().slice(0, 10);
          else if (v.error) raw = String(v.error);
          else if (v.result != null) raw = String(v.result);
        } else if (v != null) raw = String(v);
        if (raw === "=") raw = cell.result != null ? String(cell.result) : "";
        if (raw !== "") sh.cells[key] = raw;
        const f = {};
        const font = cell.font || {};
        if (font.bold) f.b = true;
        if (font.italic) f.i = true;
        if (font.underline) f.u = true;
        const fg = argbToHex(font.color?.argb);
        if (fg && fg.toLowerCase() !== "#000000") f.fg = fg;
        const fill = cell.fill;
        if (fill?.type === "pattern" && fill.pattern === "solid") {
          const bg = argbToHex(fill.fgColor?.argb);
          if (bg && bg.toLowerCase() !== "#ffffff") f.bg = bg;
        }
        const h = cell.alignment?.horizontal;
        if (h === "center" || h === "right" || h === "left") f.a = h;
        Object.assign(f, fmtFromNumFmt(cell.numFmt) || {});
        if (v instanceof Date) f.t = "date";
        if (Object.keys(f).length) sh.fmt[key] = f;
        maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
      });
    });
    ws.columns?.forEach((col, i) => {
      if (col?.width) sh.widths[i] = Math.round(col.width * 7 + 5);
    });
    sh.rows = Math.max(100, maxR + 20);
    sh.cols = Math.max(26, maxC + 5);
    sheets.push(sh);
  });
  return { title, sheets: sheets.length ? sheets : [{ name: "Feuille 1", cells: {}, fmt: {}, widths: {}, cols: 26, rows: 100, source: null }], active: 0 };
}

/**
 * Classeur Calc → octets .xlsx.
 * @param {object} doc { title, sheets }
 * @param {(sheetIndex:number, key:string) => any} [valueOf] résultat calculé d'une
 *   formule (mis en cache dans le fichier : Excel l'affiche avant de recalculer)
 */
export async function sheetsToXlsx(doc, valueOf) {
  const ExcelJS = await EXCELJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = "Lumen";
  wb.created = new Date();
  (doc.sheets || []).forEach((sh, si) => {
    if (sh.kind === "chart") return;
    const ws = wb.addWorksheet(String(sh.name || `Feuille ${si + 1}`).slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
    for (const [c, w] of Object.entries(sh.widths || {})) ws.getColumn(Number(c) + 1).width = Math.max(4, (Number(w) - 5) / 7);
    const keys = new Set([...Object.keys(sh.cells || {}), ...Object.keys(sh.fmt || {})]);
    for (const key of keys) {
      const pos = parseKey(key);
      if (!pos) continue;
      const cell = ws.getCell(`${colName(pos.c)}${pos.r + 1}`);
      const raw = sh.cells?.[key];
      if (raw != null && raw !== "") {
        const s = String(raw);
        if (s.startsWith("=")) {
          let result;
          try { result = valueOf?.(si, key); } catch { result = undefined; }
          if (result && typeof result === "object") result = undefined;
          cell.value = { formula: s.slice(1), result };
        } else if (/^-?\d+(?:[.,]\d+)?$/.test(s.trim())) {
          cell.value = Number(s.trim().replace(",", "."));
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) {
          cell.value = new Date(`${s.trim()}T00:00:00Z`);
        } else {
          cell.value = s;
        }
      }
      const f = sh.fmt?.[key];
      if (f) {
        const font = {};
        if (f.b) font.bold = true;
        if (f.i) font.italic = true;
        if (f.u) font.underline = true;
        if (hexToArgb(f.fg)) font.color = { argb: hexToArgb(f.fg) };
        if (Object.keys(font).length) cell.font = font;
        if (hexToArgb(f.bg)) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: hexToArgb(f.bg) } };
        if (f.a) cell.alignment = { horizontal: f.a };
        const nf = numFmtFromFmt(f);
        if (nf) cell.numFmt = nf;
      }
    }
  });
  if (!wb.worksheets.length) wb.addWorksheet("Feuille 1");
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf);
}
