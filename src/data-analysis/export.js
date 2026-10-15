// Export d'un rapport : toutes ses pages rendues hors écran (les graphiques
// ECharts ont besoin d'un conteneur mesurable), puis
//   • Markdown avec images embarquées → PDF par `sandbox_write_pdf` ;
//   • HTML autonome (une seule page, styles et images inclus) ;
//   • corps d'email (HTML simple, compatible messageries) + pièce jointe.

import { renderVisual, visualDef, visualImage, visualMarkdown, formatValue, isChart, reportTheme, visualStyle, disposeVisual } from "./viz.js";
import { buildPivot, renderPivotMarkdown } from "./pivot.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rend toutes les pages et collecte, par visuel, son résultat, son image (si
 * graphique) et son HTML. `ctxFor(v, page)` fournit { T, P, slicerState }.
 */
export async function snapshot(report, ctxFor, { width = 1100 } = {}) {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-${width + 200}px;top:0;width:${width}px;opacity:0;pointer-events:none;`;
  document.body.appendChild(host);
  const t = reportTheme(report);
  const pages = [];
  try {
    for (const page of report.pages) {
      const items = [];
      const ordered = page.visuals.slice().sort((a, b) => a.y - b.y || a.x - b.x);
      for (const v of ordered) {
        if (v.type === "slicer") continue;
        const box = document.createElement("div");
        box.className = "vis-body export";
        box.style.cssText = `width:${Math.max(240, (v.w / 12) * width)}px;height:${Math.max(120, v.h * 40)}px;`;
        host.appendChild(box);
        const ctx = { ...ctxFor(v, page), theme: t, selection: null, static: true };
        const exportId = `exp-${v.id}`;
        const vv = { ...v, id: exportId };
        let res = null;
        try { res = renderVisual(box, vv, ctx); } catch { res = null; }
        items.push({ v, res, box, exportId, ctx });
      }
      // Les graphiques se peignent après l'insertion : courte attente.
      await wait(450);
      for (const it of items) {
        it.img = isChart(it.v.type) ? visualImage(it.exportId, it.v.opts?.bg || "#ffffff") : null;
        it.html = it.img ? "" : it.box.innerHTML;
        if (it.v.type === "matrix" && it.res?.cfg && it.ctx.T) {
          try { it.md = renderPivotMarkdown(buildPivot({ columns: it.ctx.T.columns, rows: it.ctx.T.rows }, it.res.cfg), it.res.cfg); } catch { it.md = ""; }
        }
        disposeVisual(it.exportId);
        it.box.remove();
      }
      pages.push({ page, items });
    }
  } finally {
    host.remove();
  }
  return pages;
}

export function periodText(report) {
  const p = report.period || {};
  if (!p.enabled || !p.from) return "";
  const f = (d) => new Date(d).toLocaleDateString("fr-FR");
  return `Période du ${f(p.from)} au ${f(p.to)}`;
}

/** Markdown du rapport (PDF, contexte IA). */
export function toMarkdown(report, pages) {
  const out = [`# ${report.name}`, ""];
  const per = periodText(report);
  out.push(`_${[per, `Généré le ${new Date().toLocaleString("fr-FR")}`].filter(Boolean).join(" · ")}_`, "");
  for (const { page, items } of pages) {
    if (pages.length > 1) out.push(`## ${page.name}`, "");
    for (const it of items) {
      const title = it.v.title || visualDef(it.v.type).label;
      if (it.img) out.push(`### ${title}`, "", `![${title}](${it.img})`, "");
      else if (it.md) out.push(`### ${title}`, "", it.md, "");
      else {
        const md = visualMarkdown(it.v, it.res);
        if (md) out.push(md, "");
      }
    }
  }
  return out.join("\n");
}

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#f4f4f5;color:#18181b;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{padding:32px 40px 12px;max-width:1180px;margin:0 auto}h1{margin:0;font-size:28px;letter-spacing:-.02em}header p{margin:6px 0 0;color:#71717a}
section{max-width:1180px;margin:0 auto;padding:12px 40px 28px}h2{font-size:18px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
.vis{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:14px 16px;box-shadow:0 1px 2px rgba(0,0,0,.04);overflow:hidden}
.vis h3{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--vis-title,#3f3f46)}.vis img{width:100%;height:auto;display:block}
.v-card-value{color:var(--v-accent,inherit);font-size:30px;font-weight:700;letter-spacing:-.02em}.v-card-label{color:#71717a;font-size:12px}
.v-delta.up{color:#16a34a}.v-delta.down{color:#dc2626}.v-prev{color:#a1a1aa;font-size:11px;margin-left:6px}.v-spark{display:none}
.v-multi{display:flex;flex-wrap:wrap;gap:18px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:6px 8px;border-bottom:1px solid #f4f4f5;text-align:left}th{color:#71717a;font-weight:600}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}tfoot td{font-weight:700}
.md p{margin:.4em 0}.muted{color:#71717a}footer{text-align:center;color:#a1a1aa;font-size:11px;padding:20px}
@media print{body{background:#fff}.vis{break-inside:avoid}}`;

/** HTML autonome du rapport. */
export function toHtml(report, pages) {
  const per = periodText(report);
  const body = pages.map(({ page, items }) => `<section>${pages.length > 1 ? `<h2>${esc(page.name)}</h2>` : ""}<div class="grid">${items.map((it) => {
    const title = it.v.title || (it.v.type === "text" ? "" : visualDef(it.v.type).label);
    const span = Math.max(3, Math.min(12, it.v.w || 6));
    const o = it.v.opts || {};
    const look = [visualStyle(it.v), o.bg ? `background:${o.bg}` : "", o.textColor ? `color:${o.textColor}` : ""].filter(Boolean).join(";");
    return `<div class="vis" style="grid-column:span ${span}${look ? `;${look}` : ""}">${title && it.v.opts?.showTitle !== false ? `<h3>${esc(title)}</h3>` : ""}${it.img ? `<img src="${it.img}" alt="${esc(title)}"/>` : it.html}</div>`;
  }).join("")}</div></section>`).join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(report.name)}</title><style>${CSS}</style></head><body><header><h1>${esc(report.name)}</h1><p>${esc([per, `Généré le ${new Date().toLocaleString("fr-FR")} par Lumen`].filter(Boolean).join(" · "))}</p></header>${body}<footer>Rapport généré par Lumen — Analyse de données</footer></body></html>`;
}

/** Corps d'email : indicateurs clés + message ; le rapport complet est joint. */
export function emailBody(report, pages, message = "") {
  const cards = [];
  for (const { items } of pages) for (const it of items) {
    if ((it.v.type === "card" || it.v.type === "gauge") && it.res) cards.push({ label: it.v.title || it.res.label, value: formatValue(it.res.value, it.v.opts || {}), prev: it.res.prev });
    if (it.v.type === "multicard" && it.res) for (const x of it.res.items) cards.push({ label: x.label, value: formatValue(x.value, it.v.opts || {}), prev: x.prev });
  }
  const per = periodText(report);
  const text = [`${report.name}`, per, "", message, "", ...cards.map((c) => `• ${c.label} : ${c.value}`), "", "Le rapport complet est en pièce jointe."].filter((l, i, a) => l || a[i - 1]).join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#18181b;max-width:640px">
    <h2 style="margin:0 0 4px;font-size:20px">${esc(report.name)}</h2>${per ? `<p style="margin:0 0 14px;color:#71717a">${esc(per)}</p>` : ""}
    ${message ? `<p style="margin:0 0 16px">${esc(message).replace(/\n/g, "<br>")}</p>` : ""}
    ${cards.length ? `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0 8px">${cards.slice(0, 8).map((c) => `<tr><td style="padding:12px 14px;border:1px solid #e4e4e7;border-radius:10px"><div style="color:#71717a;font-size:12px">${esc(c.label)}</div><div style="font-size:22px;font-weight:700">${esc(c.value)}</div></td></tr>`).join("")}</table>` : ""}
    <p style="color:#71717a;font-size:12px;margin-top:18px">Le rapport complet est en pièce jointe. — Envoyé par Lumen</p></div>`;
  return { text, html };
}

const b64utf8 = (s) => { const u = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(bin); };
export { b64utf8 };
