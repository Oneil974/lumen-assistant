// Visuels de rapport → documents et présentations Opus (.lumenpages / .lumenkey).
//
// Un visuel devient un élément de l'éditeur créatif :
//   • graphique, carte, jauge → image PNG (fichier rangé dans la sandbox du
//     rapport + data: URL pour l'affichage immédiat) ;
//   • table, matrice → tableau natif (modifiable, exporté tel quel en PDF/PPTX) ;
//   • zone de texte, analyse IA → zone de texte.
// Chaque élément garde `dataRef` (rapport, page, visuel) : Opus sait ainsi le
// régénérer avec des données à jour (« Actualiser les données »).

import { renderVisual, disposeVisual, visualImage, isChart, formatValue, visualDef } from "./viz.js";
import { renderMarkdown } from "../sandbox/render.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const VISUAL_DIR = "Rapports/visuels";

/** Hauteur/largeur en px d'un visuel du canevas (grille 12 colonnes × 40 px). */
export function visualPixelSize(v, width = 1100) {
  return { w: Math.max(260, Math.round((v.w / 12) * width)), h: Math.max(140, v.h * 40) };
}

/**
 * Capture d'un visuel, hors écran. ctx = { T, P, theme, slicerState }.
 * → { kind: "image", png, w, h } | { kind: "table", rows, header } | { kind: "text", text } | null
 */
export async function captureVisual(v, ctx, { width = 1100 } = {}) {
  if (v.type === "slicer") return null;
  if (v.type === "text" || v.type === "ai") {
    const md = v.type === "text" ? v.text || "" : v.answer || "";
    return md.trim() ? { kind: "text", text: md, html: renderMarkdown(md) } : null;
  }
  const { w, h } = visualPixelSize(v, width);
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-${w + 400}px;top:0;width:${w}px;height:${h}px;opacity:0;pointer-events:none;background:${v.opts?.bg || "#ffffff"};color:${v.opts?.textColor || "#18181b"};`;
  host.className = "vis-body export";
  document.body.appendChild(host);
  const id = `cap-${v.id}-${Date.now().toString(36)}`;
  try {
    const res = renderVisual(host, { ...v, id }, { ...ctx, selection: null, static: true });
    if (!res) return null;
    if (isChart(v.type)) {
      await wait(120); // laisse ECharts peindre (animation coupée)
      const png = visualImage(id, v.opts?.bg || "#ffffff");
      return png ? { kind: "image", png, w, h } : null;
    }
    if (v.type === "card" || v.type === "multicard") return { kind: "image", png: drawCards(v, res, w, h), w, h };
    if (v.type === "table" || v.type === "matrix") {
      const rows = [...host.querySelectorAll("table tr")].map((tr) => [...tr.children].map((c) => c.textContent.replace(/\s+/g, " ").trim()));
      return rows.length ? { kind: "table", rows: rows.slice(0, 40), header: true } : null;
    }
    return null;
  } finally {
    disposeVisual(id);
    host.remove();
  }
}

// Cartes d'indicateurs dessinées au canvas : valeur, libellé, variation.
function drawCards(v, res, w, h) {
  const o = v.opts || {};
  const scale = 2;
  const c = document.createElement("canvas");
  c.width = w * scale; c.height = h * scale;
  const g = c.getContext("2d");
  g.scale(scale, scale);
  g.fillStyle = o.bg || "#ffffff";
  g.fillRect(0, 0, w, h);
  const items = v.type === "card" ? [{ value: res.value, label: res.label, prev: res.prev }] : res.items || [];
  const n = Math.max(1, items.length);
  const cols = v.type === "card" ? 1 : Math.min(n, Math.max(1, Math.floor(w / 180)));
  const rows = Math.ceil(n / cols);
  const cw = w / cols, ch = h / rows;
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  items.forEach((it, i) => {
    const x = (i % cols) * cw + 18, y = Math.floor(i / cols) * ch;
    const big = Math.max(18, Math.min(ch * 0.36, cw / 6, 54));
    g.fillStyle = o.color || o.textColor || "#18181b";
    g.font = `700 ${big}px ${font}`;
    g.textBaseline = "alphabetic";
    g.fillText(formatValue(it.value, o), x, y + ch / 2 + big * 0.2, cw - 30);
    g.fillStyle = o.textColor || "#71717a";
    g.font = `500 ${Math.max(11, big * 0.32)}px ${font}`;
    g.fillText(String(it.label || ""), x, y + ch / 2 + big * 0.2 + Math.max(16, big * 0.55), cw - 30);
    if (o.compare !== false && Number.isFinite(it.prev) && it.prev) {
      const d = ((it.value - it.prev) / Math.abs(it.prev)) * 100;
      const good = o.invert ? d < 0 : d >= 0;
      g.fillStyle = good ? "#16a34a" : "#dc2626";
      g.font = `600 ${Math.max(11, big * 0.28)}px ${font}`;
      g.fillText(`${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`, x, y + ch / 2 + big * 0.2 + Math.max(32, big * 1.05), cw - 30);
    }
  });
  return c.toDataURL("image/png");
}

const dataUrlBytes = (u) => { const b = atob(String(u).split(",")[1] || ""); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };

/** Range le PNG d'une capture dans la sandbox du rapport ; renvoie son chemin. */
export async function storeCapture(invoke, sandboxId, reportSlug, v, png) {
  const path = `${VISUAL_DIR}/${reportSlug}-${v.id}.png`;
  let bin = "";
  const bytes = dataUrlBytes(png);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  await invoke("sandbox_import_file", { id: sandboxId, path, dataB64: btoa(bin) });
  return path;
}

// ---- Éléments de l'éditeur créatif ------------------------------------------------
let seq = 0;
const eid = () => `el-${Date.now().toString(36)}-v${(seq++).toString(36)}`;
const PAGE = { document: { w: 794, h: 1123 }, presentation: { w: 1280, h: 720 } };
const luminance = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "")); if (!m) return 1; const n = parseInt(m[1], 16); return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
const SYS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Éléments Opus pour une capture posée dans la boîte (x, y, w, h). */
export function elementsFor(cap, box, { title = "", dataRef = null, sandboxId = "", sandboxPath = "", ink = "#1d1d1f" } = {}) {
  const els = [];
  let { x, y, w, h } = box;
  if (title) {
    els.push({ id: eid(), type: "text", x, y, w, h: 30, rotation: 0, html: esc(title), fontSize: 18, weight: 650, color: ink, align: "left", lineHeight: 1.3, fontFamily: SYS, letterSpacing: 0, padding: 4, opacity: 1, bg: "transparent", dataRef: dataRef ? { ...dataRef, part: "title" } : undefined });
    y += 36; h -= 36;
  }
  if (cap.kind === "image") {
    const ratio = cap.h / cap.w;
    const ih = Math.min(h, Math.round(w * ratio));
    els.push({ id: eid(), type: "image", x, y, w, h: ih, rotation: 0, src: cap.png, sandboxPath, sandboxId, fit: "contain", radius: 8, opacity: 1, alt: title, dataRef });
  } else if (cap.kind === "table") {
    const rh = 28;
    const rows = cap.rows.slice(0, Math.max(2, Math.floor(h / rh)));
    els.push({ id: eid(), type: "table", x, y, w, h: rows.length * rh + 4, rotation: 0, rows: rows.map((r) => r.map(esc)), header: true, opacity: 1, fontSize: 13, color: "#1d1d1f", headerBg: "#f2f2f7", borderColor: "#d1d1d6", zebra: true, align: "left", dataRef });
  } else if (cap.kind === "text") {
    els.push({ id: eid(), type: "text", x, y, w, h: Math.min(h, 60 + cap.text.length / 2), rotation: 0, html: cap.html, fontSize: 16, weight: 400, color: ink, align: "left", lineHeight: 1.45, fontFamily: SYS, letterSpacing: 0, padding: 4, opacity: 1, bg: "transparent", dataRef });
  }
  return els;
}

/** Hauteur occupée par une liste d'éléments (bas de l'élément le plus bas). */
const bottomOf = (els) => els.reduce((m, e) => Math.max(m, (e.y || 0) + (e.h || 0)), 0);

/**
 * Pose des captures dans un document créatif (objet `doc` du fichier) :
 *   • présentation → une diapositive par visuel, ou une seule diapositive
 *     reproduisant la grille du rapport (`asPage`) ;
 *   • document → à la suite du contenu, avec saut de page si nécessaire.
 * items = [{ cap, title, dataRef, sandboxId, sandboxPath, v }]
 */
export function placeInDoc(doc, kind, items, { asPage = false, pageTitle = "" } = {}) {
  const size = PAGE[kind] || PAGE.document;
  doc.pages ||= [];
  const newPage = (bg) => { const p = { w: size.w, h: size.h, background: bg || "#ffffff", elements: [], notes: "" }; doc.pages.push(p); return p; };
  const refBg = doc.pages.at(-1)?.background || "#ffffff";
  const ink = luminance(refBg) < 0.45 ? "#f5f5f7" : "#1d1d1f";
  if (kind === "presentation") {
    const margin = 64;
    if (asPage) {
      const page = newPage(refBg);
      let top = margin;
      if (pageTitle) { page.elements.push({ id: eid(), type: "text", x: margin, y: margin - 16, w: size.w - margin * 2, h: 56, rotation: 0, html: esc(pageTitle), fontSize: 36, weight: 750, color: ink, align: "left", lineHeight: 1.2, fontFamily: SYS, letterSpacing: 0, padding: 4, opacity: 1, bg: "transparent" }); top += 56; }
      const maxY = Math.max(1, ...items.map((it) => it.v.y + it.v.h));
      const sx = (size.w - margin * 2) / 12, sy = (size.h - top - margin / 2) / maxY;
      for (const it of items) {
        const box = { x: margin + it.v.x * sx + 6, y: top + it.v.y * sy + 6, w: it.v.w * sx - 12, h: it.v.h * sy - 12 };
        page.elements.push(...elementsFor(it.cap, box, { ...it, title: it.cap.kind === "text" ? "" : it.title, ink }));
      }
      return doc.pages.length - 1;
    }
    let first = -1;
    for (const it of items) {
      const page = newPage(refBg);
      if (first < 0) first = doc.pages.length - 1;
      page.elements.push({ id: eid(), type: "text", x: margin, y: margin - 16, w: size.w - margin * 2, h: 56, rotation: 0, html: esc(it.title || pageTitle), fontSize: 36, weight: 750, color: ink, align: "left", lineHeight: 1.2, fontFamily: SYS, letterSpacing: 0, padding: 4, opacity: 1, bg: "transparent" });
      page.elements.push(...elementsFor(it.cap, { x: margin, y: margin + 60, w: size.w - margin * 2, h: size.h - margin * 2 - 60 }, { ...it, title: "", ink }));
    }
    return first;
  }
  // Document : flux vertical sous le contenu existant.
  const margin = 72, gap = 24;
  let page = doc.pages.at(-1) || newPage("#ffffff");
  let firstIdx = doc.pages.indexOf(page);
  let y = page.elements.length ? bottomOf(page.elements) + gap : margin;
  for (const it of items) {
    const w = size.w - margin * 2;
    const h = it.cap.kind === "image" ? Math.round(w * (it.cap.h / it.cap.w)) + (it.title ? 36 : 0) : it.cap.kind === "table" ? Math.min(40, it.cap.rows.length) * 28 + 40 : 120;
    if (y + h > size.h - margin) { page = newPage(page.background); y = margin; if (firstIdx < 0) firstIdx = doc.pages.length - 1; }
    const els = elementsFor(it.cap, { x: margin, y, w, h: Math.min(h, size.h - margin - y) }, { ...it, ink: luminance(page.background) < 0.45 ? "#f5f5f7" : "#1d1d1f" });
    page.elements.push(...els);
    y = bottomOf(els) + gap;
  }
  return firstIdx;
}

/** Titre lisible d'un visuel. */
export const visualTitle = (v, fallback) => v.title || fallback || visualDef(v.type).label;
