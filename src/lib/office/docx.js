// Word (.docx) ⇄ document Opus (.lumenpages).
//
// Opus place des BLOCS sur des pages ; Word fait COULER du texte. La
// conversion traduit l'un dans l'autre :
//   - import : chaque paragraphe Word devient du HTML riche (gras, italique,
//     souligné, couleur, taille, police, surlignage, liens, listes,
//     alignement) ; les titres ont leur propre bloc (styles h1/h2/h3 d'Opus),
//     le corps est regroupé en blocs, et les pages sont remplies à la hauteur
//     estimée du texte. Tableaux et images deviennent des éléments Opus. Un
//     saut de page Word ouvre une nouvelle page.
//   - export : les blocs de chaque page sont lus de haut en bas et de gauche à
//     droite ; texte → paragraphes et runs, tableau → w:tbl, image → dessin en
//     ligne ; une page Opus = un saut de page Word. Styles « Titre 1/2/3 »
//     réels (le plan de navigation de Word fonctionne).

import {
  unzip, zip, readRels, kid, kids, find, findAll, attr, relId, xmlEsc, hex6,
  bytesToDataUrl, dataUrlToBytes, imageSize, pxToHalfPt, halfPtToPx, pxToEmu, emuToPx, twipToPx,
  CORE_XML, APP_XML,
} from "./ooxml.js";
import { htmlToParagraphs, paragraphsToHtml, paraText } from "./richtext.js";

const PAGE = { w: 794, h: 1123, margin: 90 };
const HEADING_SIZE = { 1: 32, 2: 24, 3: 19 };

// =========================================================================
// Import
// =========================================================================

/** Styles de titre (Heading1, Titre1…) et tailles par défaut du document. */
function readStyles(pkg) {
  const doc = pkg.xml("word/styles.xml");
  const headings = {};
  let defaultSize = 11 * 2; // demi-points
  let defaultFont = "";
  if (!doc) return { headings, defaultSize, defaultFont, styleRun: {} };
  const defRpr = find(find(doc.documentElement, "rPrDefault"), "rPr");
  const sz = attr(kid(defRpr, "sz"), "val"); if (sz) defaultSize = Number(sz);
  defaultFont = attr(kid(defRpr, "rFonts"), "ascii") || "";
  const styleRun = {};
  for (const s of kids(doc.documentElement, "style")) {
    const id = attr(s, "styleId");
    const name = String(attr(kid(s, "name"), "val") || "").toLowerCase();
    const m = name.match(/^(?:heading|titre)\s*(\d)$/) || String(id || "").toLowerCase().match(/^(?:heading|titre)(\d)$/);
    if (m) headings[id] = Number(m[1]);
    if (name === "title" || name === "titre") headings[id] = 1;
    const rpr = kid(s, "rPr");
    if (rpr) styleRun[id] = readRunProps(rpr, {});
  }
  return { headings, defaultSize, defaultFont, styleRun };
}

/** Listes numérotées ou à puces : numId → niveau → ordonnée ? */
function readNumbering(pkg) {
  const doc = pkg.xml("word/numbering.xml");
  const out = {};
  if (!doc) return out;
  const abstract = {};
  for (const a of kids(doc.documentElement, "abstractNum")) {
    const lv = {};
    for (const l of kids(a, "lvl")) lv[attr(l, "ilvl")] = attr(kid(l, "numFmt"), "val") !== "bullet";
    abstract[attr(a, "abstractNumId")] = lv;
  }
  for (const n of kids(doc.documentElement, "num")) {
    out[attr(n, "numId")] = abstract[attr(kid(n, "abstractNumId"), "val")] || {};
  }
  return out;
}

function readRunProps(rpr, base) {
  const f = { ...base };
  if (!rpr) return f;
  const on = (el) => el && attr(el, "val") !== "0" && attr(el, "val") !== "false";
  if (kid(rpr, "b")) f.b = on(kid(rpr, "b"));
  if (kid(rpr, "i")) f.i = on(kid(rpr, "i"));
  const u = kid(rpr, "u"); if (u) f.u = attr(u, "val") !== "none";
  if (kid(rpr, "strike")) f.s = on(kid(rpr, "strike"));
  const color = attr(kid(rpr, "color"), "val"); if (color && color !== "auto") f.color = color.toUpperCase();
  const sz = attr(kid(rpr, "sz"), "val"); if (sz) f.sizePx = halfPtToPx(sz);
  const font = attr(kid(rpr, "rFonts"), "ascii") || attr(kid(rpr, "rFonts"), "hAnsi"); if (font) f.font = font;
  const hl = attr(kid(rpr, "highlight"), "val");
  const HL = { yellow: "FFFF00", green: "00FF00", cyan: "00FFFF", magenta: "FF00FF", blue: "0000FF", red: "FF0000", lightGray: "D3D3D3", darkGray: "A9A9A9" };
  if (hl && HL[hl]) f.highlight = HL[hl];
  const shd = attr(kid(rpr, "shd"), "fill"); if (shd && shd !== "auto") f.highlight = shd.toUpperCase();
  const va = attr(kid(rpr, "vertAlign"), "val");
  if (va === "superscript") f.sup = true;
  if (va === "subscript") f.sub = true;
  return f;
}

function readParagraph(p, ctx) {
  const ppr = kid(p, "pPr");
  const styleId = attr(kid(ppr, "pStyle"), "val") || "";
  const heading = ctx.styles.headings[styleId] || 0;
  const jc = attr(kid(ppr, "jc"), "val") || "left";
  const align = { both: "justify", center: "center", right: "right", end: "right", distribute: "justify" }[jc] || "left";
  const numPr = kid(ppr, "numPr");
  let list = null;
  if (numPr) {
    const numId = attr(kid(numPr, "numId"), "val");
    const level = Number(attr(kid(numPr, "ilvl"), "val") || 0);
    if (numId && numId !== "0") list = { ordered: Boolean(ctx.numbering[numId]?.[level]), level };
  }
  const base = readRunProps(null, { ...(ctx.styles.styleRun[styleId] || {}) });
  const para = { align, heading, list, runs: [], images: [], pageBreakBefore: Boolean(kid(ppr, "pageBreakBefore")) };

  const readRun = (r, href) => {
    const f = readRunProps(kid(r, "rPr"), base);
    if (href) f.href = href;
    for (const c of r.children) {
      const n = c.localName;
      if (n === "t") para.runs.push({ ...f, text: c.textContent });
      else if (n === "tab") para.runs.push({ ...f, text: "\t" });
      else if (n === "br") {
        if (attr(c, "type") === "page") para.pageBreakAfter = true;
        else para.runs.push({ ...f, br: true, text: "" });
      } else if (n === "drawing" || n === "pict") {
        const blip = find(c, "blip");
        const id = attr(blip, "embed") || attr(find(c, "imagedata"), "id");
        const rel = id && ctx.rels[id];
        const ext = find(c, "extent");
        if (rel && ctx.pkg.bytes(rel.target)) {
          para.images.push({
            src: bytesToDataUrl(ctx.pkg.bytes(rel.target), rel.target),
            w: ext ? emuToPx(attr(ext, "cx")) : 320,
            h: ext ? emuToPx(attr(ext, "cy")) : 220,
          });
        }
      }
    }
  };
  for (const c of p.children) {
    if (c.localName === "r") readRun(c);
    else if (c.localName === "hyperlink") {
      const rel = ctx.rels[relId(c)];
      for (const r of kids(c, "r")) readRun(r, rel?.target || "");
    } else if (c.localName === "ins" || c.localName === "smartTag" || c.localName === "sdt") {
      for (const r of findAll(c, "r")) readRun(r);
    }
  }
  return para;
}

function readTable(tbl, ctx) {
  const rows = [];
  let headerBg = "";
  for (const tr of kids(tbl, "tr")) {
    const row = [];
    for (const tc of kids(tr, "tc")) {
      const shd = attr(find(kid(tc, "tcPr"), "shd"), "fill");
      if (!rows.length && shd && shd !== "auto") headerBg = `#${shd}`;
      const paras = kids(tc, "p").map((p) => readParagraph(p, ctx));
      const cellColor = paras[0]?.runs[0]?.color;
      row.push(paragraphsToHtml(paras, { sizePx: paras[0]?.runs[0]?.sizePx, color: cellColor }).replace(/^<p>|<\/p>$/g, "").replace(/<\/p><p>/g, "<br>"));
    }
    rows.push(row);
  }
  const cols = Math.max(1, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < cols) r.push("");
  return { rows, headerBg };
}

/// Hauteur estimée d'un bloc de texte (px) pour remplir les pages.
function estimateHeight(paras, width, sizePx, lineHeight) {
  let lines = 0;
  for (const p of paras) {
    const size = Math.max(sizePx, ...p.runs.map((r) => r.sizePx || 0));
    const perLine = Math.max(10, Math.floor(width / (size * 0.5)));
    const text = paraText(p);
    lines += text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0) * (size / sizePx);
    lines += 0.45; // espace entre paragraphes
  }
  return Math.ceil(lines * sizePx * lineHeight) + 12;
}

/**
 * .docx → document Opus { kind:"document", title, pages }.
 * @param {Uint8Array} bytes
 * @param {{ uid: () => string, title?: string }} opts
 */
export async function docxToCreative(bytes, opts = {}) {
  const pkg = await unzip(bytes);
  const main = pkg.xml("word/document.xml");
  if (!main) throw new Error("Fichier Word invalide (word/document.xml absent).");
  const ctx = { pkg, styles: readStyles(pkg), numbering: readNumbering(pkg), rels: readRels(pkg, "word/document.xml") };
  const uid = opts.uid || (() => `el-${Math.random().toString(36).slice(2)}`);
  const bodySize = halfPtToPx(ctx.styles.defaultSize);
  const bodyFont = ctx.styles.defaultFont;

  // Marges et format réels du document (w:sectPr final).
  const sect = find(main.documentElement, "sectPr");
  const pgSz = kid(sect, "pgSz"); const pgMar = kid(sect, "pgMar");
  const page = { w: PAGE.w, h: PAGE.h, margin: PAGE.margin };
  if (pgSz) {
    const w = twipToPx(attr(pgSz, "w")), h = twipToPx(attr(pgSz, "h"));
    if (w > 200 && h > 200) { page.w = Math.round(w); page.h = Math.round(h); }
  }
  if (pgMar) page.margin = Math.max(30, Math.round(twipToPx(attr(pgMar, "left")) || PAGE.margin));
  const contentW = page.w - page.margin * 2;

  const pages = [];
  let pg = null, y = 0;
  const newPage = () => { pg = { w: page.w, h: page.h, background: "#ffffff", elements: [] }; pages.push(pg); y = page.margin; };
  newPage();
  const place = (h) => { if (y + h > page.h - page.margin && pg.elements.length) newPage(); const at = y; y += h; return at; };

  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    // Un bloc trop haut pour une page est coupé en plusieurs blocs.
    let chunk = [];
    const emit = () => {
      if (!chunk.length) return;
      // Taille et couleur dominantes du bloc : elles deviennent celles de
      // l'élément, et seules les exceptions gardent un style en ligne.
      const tally = (pick) => {
        const n = new Map();
        for (const p of chunk) for (const r of p.runs) { const k = pick(r); if (k) n.set(k, (n.get(k) || 0) + (r.text || "").length); }
        return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      };
      const size = Number(tally((r) => r.sizePx && String(Math.round(r.sizePx * 10) / 10))) || bodySize;
      const color = tally((r) => r.color) || "1D1D1F";
      const font = tally((r) => r.font) || bodyFont;
      const h = estimateHeight(chunk, contentW, size, 1.5);
      pg.elements.push({
        id: uid(), type: "text", x: page.margin, y: place(h), w: contentW, h, rotation: 0,
        html: paragraphsToHtml(chunk, { sizePx: size, font, color }),
        fontSize: size, fontFamily: font ? `'${font}', -apple-system, sans-serif` : "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        color: `#${color}`, align: "left", weight: 400, lineHeight: 1.5, letterSpacing: 0, bg: "transparent", opacity: 1, padding: 4, style: "body",
      });
      chunk = [];
    };
    for (const p of pending) {
      chunk.push(p);
      if (estimateHeight(chunk, contentW, bodySize, 1.5) > page.h - page.margin - y) {
        chunk.pop(); emit(); if (pg.elements.length && y > page.margin) newPage(); chunk.push(p);
      }
    }
    emit();
    pending = [];
  };

  const body = find(main.documentElement, "body");
  for (const node of body.children) {
    if (node.localName === "p") {
      const para = readParagraph(node, ctx);
      if (para.pageBreakBefore) { flush(); newPage(); }
      if (para.heading) {
        flush();
        const size = HEADING_SIZE[Math.min(3, para.heading)] ;
        const lvl = Math.min(3, para.heading);
        const sizePx = Math.max(size, ...para.runs.map((r) => r.sizePx || 0));
        const h = estimateHeight([para], contentW, sizePx, 1.25);
        pg.elements.push({
          id: uid(), type: "text", x: page.margin, y: place(h + 6), w: contentW, h, rotation: 0,
          html: paragraphsToHtml([{ ...para, heading: 0 }], { sizePx, b: true, color: para.runs.find((r) => r.color)?.color }).replace(/^<p([^>]*)>|<\/p>$/g, ""),
          fontSize: sizePx, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
          color: `#${para.runs.find((r) => r.color)?.color || "1D1D1F"}`, align: para.align, weight: 700,
          lineHeight: 1.25, letterSpacing: 0, bg: "transparent", opacity: 1, padding: 4, style: `h${lvl}`,
        });
      } else if (paraText(para).trim() || para.runs.some((r) => r.br)) {
        pending.push(para);
      } else if (!para.images.length && pending.length) {
        pending.push(para); // ligne vide au fil du texte : conservée comme espacement
      }
      for (const im of para.images) {
        flush();
        const w = Math.min(contentW, im.w), h = im.h * (w / im.w);
        pg.elements.push({ id: uid(), type: "image", x: page.margin + (para.align === "center" ? (contentW - w) / 2 : 0), y: place(h + 8), w, h, rotation: 0, src: im.src, sandboxPath: "", sandboxId: "", fit: "contain", radius: 0, opacity: 1, alt: "" });
      }
      if (para.pageBreakAfter) { flush(); newPage(); }
    } else if (node.localName === "tbl") {
      flush();
      const { rows, headerBg } = readTable(node, ctx);
      const h = 30 * rows.length + 12;
      pg.elements.push({
        id: uid(), type: "table", x: page.margin, y: place(h + 10), w: contentW, h, rotation: 0,
        rows, header: true, opacity: 1, fontSize: Math.round(bodySize), color: "#1d1d1f",
        headerBg: headerBg || "#f2f2f7", borderColor: "#d1d1d6", zebra: false, align: "left",
      });
    } else if (node.localName === "sectPr") {
      // réglages de section : déjà lus
    }
  }
  flush();
  // Pas de page vide en fin de document.
  while (pages.length > 1 && !pages[pages.length - 1].elements.length) pages.pop();

  const titleEl = pkg.xml("docProps/core.xml");
  const title = (titleEl && find(titleEl.documentElement, "title")?.textContent) || opts.title || "Document";
  return { kind: "document", title, pages };
}

// =========================================================================
// Export
// =========================================================================

function runXml(r, base) {
  if (r.br) return `<w:r><w:br/></w:r>`;
  const props = [];
  const font = r.font || base.font;
  if (font) props.push(`<w:rFonts w:ascii="${xmlEsc(font)}" w:hAnsi="${xmlEsc(font)}" w:cs="${xmlEsc(font)}"/>`);
  if (r.b ?? base.b) props.push("<w:b/>");
  if (r.i) props.push("<w:i/>");
  if (r.s) props.push("<w:strike/>");
  const color = hex6(r.color) || hex6(base.color);
  if (color) props.push(`<w:color w:val="${color}"/>`);
  const size = r.sizePx || base.sizePx;
  if (size) props.push(`<w:sz w:val="${pxToHalfPt(size)}"/><w:szCs w:val="${pxToHalfPt(size)}"/>`);
  const hl = hex6(r.highlight);
  if (hl) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hl}"/>`);
  if (r.u || r.href) props.push(`<w:u w:val="single"/>`);
  if (r.sup) props.push(`<w:vertAlign w:val="superscript"/>`);
  if (r.sub) props.push(`<w:vertAlign w:val="subscript"/>`);
  const parts = String(r.text).split("\t").map((t) => `<w:t xml:space="preserve">${xmlEsc(t)}</w:t>`).join("<w:tab/>");
  return `<w:r>${props.length ? `<w:rPr>${props.join("")}</w:rPr>` : ""}${parts}</w:r>`;
}

function paragraphXml(p, base, ctx, extra = "") {
  const ppr = [];
  if (p.heading) ppr.push(`<w:pStyle w:val="Heading${Math.min(3, p.heading)}"/>`);
  else if (p.quote) ppr.push(`<w:pStyle w:val="Quote"/>`);
  if (p.list) ppr.push(`<w:numPr><w:ilvl w:val="${Math.min(8, p.list.level || 0)}"/><w:numId w:val="${p.list.ordered ? 2 : 1}"/></w:numPr>`);
  const jc = { center: "center", right: "right", justify: "both", end: "right" }[p.align];
  if (jc) ppr.push(`<w:jc w:val="${jc}"/>`);
  if (base.lineHeight) ppr.push(`<w:spacing w:after="120" w:line="${Math.round(240 * Math.min(3, Math.max(1, base.lineHeight)))}" w:lineRule="auto"/>`);
  let runs = "";
  for (const r of p.runs) {
    if (r.href && !r.br) {
      const id = ctx.link(r.href);
      runs += `<w:hyperlink r:id="${id}">${runXml({ ...r, color: r.color || "0563C1" }, base)}</w:hyperlink>`;
    } else runs += runXml(r, base);
  }
  return `<w:p>${ppr.length ? `<w:pPr>${ppr.join("")}</w:pPr>` : ""}${extra}${runs}</w:p>`;
}

function textElementXml(el, ctx) {
  const heading = /^h([1-3])$/.exec(el.style || "")?.[1];
  const base = {
    sizePx: el.fontSize, color: el.color, b: (el.weight || 400) >= 600,
    font: String(el.fontFamily || "").split(",")[0].replace(/["']/g, "").trim().replace(/^-apple-system$|^system-ui$|^BlinkMacSystemFont$/, ""),
    align: el.align, lineHeight: el.lineHeight,
  };
  const paras = htmlToParagraphs(el.html, base);
  return paras.map((p) => paragraphXml({ ...p, heading: heading ? Number(heading) : p.heading, align: p.align || el.align }, base, ctx)).join("");
}

function tableXml(el, ctx) {
  const cols = Math.max(1, ...el.rows.map((r) => r.length));
  const colW = Math.floor(9000 / cols);
  const border = hex6(el.borderColor) || "D1D1D6";
  const b = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${border}"/>`;
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(b).join("")}</w:tblBorders><w:tblLayout w:type="autofit"/></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colW}"/>`).join("")}</w:tblGrid>`;
  el.rows.forEach((row, ri) => {
    const isHead = el.header && ri === 0;
    xml += `<w:tr>${isHead ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}`;
    for (let c = 0; c < cols; c++) {
      const shade = isHead ? hex6(el.headerBg) : "";
      const base = { sizePx: el.fontSize, color: el.color, b: isHead };
      const paras = htmlToParagraphs(row[c] || "", base);
      xml += `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}</w:tcPr>${paras.map((p) => paragraphXml({ ...p, align: el.align }, base, ctx)).join("")}</w:tc>`;
    }
    xml += "</w:tr>";
  });
  return xml + "</w:tbl><w:p/>";
}

async function imageXml(el, ctx) {
  const src = await ctx.loadImage(el);
  const img = src && dataUrlToBytes(src);
  if (!img) return "";
  const rid = ctx.media(img);
  const cx = pxToEmu(el.w), cy = pxToEmu(el.h);
  const n = ctx.nextId();
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Image ${n}" descr="${xmlEsc(el.alt || "")}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="Image ${n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;

function numberingXml() {
  const lvls = (ordered) => Array.from({ length: 9 }, (_, i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? (["decimal", "lowerLetter", "lowerRoman"][i % 3]) : "bullet"}"/><w:lvlText w:val="${ordered ? `%${i + 1}.` : ["•", "◦", "▪"][i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0">${lvls(false)}</w:abstractNum><w:abstractNum w:abstractNumId="1">${lvls(true)}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
}

/**
 * Document Opus → octets .docx.
 * @param {object} doc { title, pages }
 * @param {{ loadImage?: (el) => Promise<string> }} opts renvoie un data: URL
 */
export async function creativeToDocx(doc, opts = {}) {
  const rels = [];
  const media = {};
  let relSeq = 10, drawSeq = 1;
  const ctx = {
    link(href) { const id = `rId${relSeq++}`; rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(href)}" TargetMode="External"/>`); return id; },
    media(img) { const id = `rId${relSeq++}`; const name = `image${Object.keys(media).length + 1}.${img.ext}`; media[`word/media/${name}`] = img.bytes; rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`); return id; },
    nextId: () => drawSeq++,
    loadImage: opts.loadImage || (async (el) => el.src || ""),
  };
  const first = doc.pages?.[0] || { w: PAGE.w, h: PAGE.h };
  let body = "";
  for (let pi = 0; pi < (doc.pages || []).length; pi++) {
    const page = doc.pages[pi];
    if (pi > 0) body += `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    const els = [...page.elements].sort((a, b) => (Math.abs(a.y - b.y) < 8 ? a.x - b.x : a.y - b.y));
    for (const el of els) {
      if (el.type === "text") body += textElementXml(el, ctx);
      else if (el.type === "table") body += tableXml(el, ctx);
      else if (el.type === "image") body += await imageXml(el, ctx);
    }
  }
  const twW = Math.round((first.w || PAGE.w) * 15), twH = Math.round((first.h || PAGE.h) * 15);
  body += `<w:sectPr><w:pgSz w:w="${twW}" w:h="${twH}"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`;

  const exts = new Set(Object.keys(media).map((p) => p.split(".").pop()));
  const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp" };
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...exts].map((e) => `<Default Extension="${e}" ContentType="${MIME[e] || "image/png"}"/>`).join("")}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels.join("")}</Relationships>`,
    "word/document.xml": documentXml,
    "word/styles.xml": STYLES_XML,
    "word/numbering.xml": numberingXml(),
    "docProps/core.xml": CORE_XML(doc.title || "Document"),
    "docProps/app.xml": APP_XML,
    ...media,
  });
}
