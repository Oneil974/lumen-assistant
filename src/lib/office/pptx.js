// PowerPoint (.pptx) ⇄ présentation Opus (.lumenkey).
//
// Les deux modèles se ressemblent : des diapositives où chaque objet a une
// position et une taille. La conversion est donc presque 1:1 :
//   zone de texte ⇄ p:sp (texte riche en runs a:r), forme ⇄ p:sp (géométrie
//   prédéfinie + remplissage), image ⇄ p:pic, tableau ⇄ a:tbl, fond ⇄ p:bg.
// À l'import, un espace réservé (titre, corps) sans position propre hérite de
// celle de sa disposition, puis de son masque — sinon il tomberait en (0,0).
// Les tailles sont ramenées au format 1280×720 d'Opus.

import {
  unzip, zip, readRels, kid, kids, find, findAll, attr, relId, xmlEsc, hex6,
  bytesToDataUrl, dataUrlToBytes, pxToEmu, CORE_XML, APP_XML,
} from "./ooxml.js";
import { htmlToParagraphs, paragraphsToHtml, runsToHtml } from "./richtext.js";

const W = 1280, H = 720;
const SLD_CX = 12192000, SLD_CY = 6858000; // 16:9 exact = 1280×720 px

// =========================================================================
// Import
// =========================================================================

function colorOf(el, theme) {
  const s = find(el, "srgbClr");
  if (s) return attr(s, "val");
  const sc = find(el, "schemeClr");
  if (sc) return theme[attr(sc, "val")] || "";
  return "";
}

function readTheme(pkg) {
  const out = {};
  const t = pkg.list().find((p) => /^ppt\/theme\/theme\d+\.xml$/.test(p));
  const doc = t && pkg.xml(t);
  const scheme = doc && find(doc.documentElement, "clrScheme");
  for (const c of scheme?.children || []) {
    const v = attr(find(c, "srgbClr"), "val") || attr(find(c, "sysClr"), "lastClr");
    if (v) out[c.localName] = v;
  }
  out.tx1 = out.tx1 || out.dk1 || "000000"; out.bg1 = out.bg1 || out.lt1 || "FFFFFF";
  out.tx2 = out.tx2 || out.dk2; out.bg2 = out.bg2 || out.lt2;
  return out;
}

function xfrmOf(sp, scale) {
  const x = find(sp, "xfrm");
  const off = kid(x, "off"), ext = kid(x, "ext");
  if (!off || !ext) return null;
  return {
    x: Number(attr(off, "x")) * scale.x, y: Number(attr(off, "y")) * scale.y,
    w: Number(attr(ext, "cx")) * scale.x, h: Number(attr(ext, "cy")) * scale.y,
    rotation: Number(attr(x, "rot") || 0) / 60000,
  };
}

/// Espaces réservés de la disposition et du masque : type/idx → position.
function placeholderMap(pkg, partPath, scale) {
  const map = {};
  const doc = pkg.xml(partPath);
  if (!doc) return map;
  for (const sp of findAll(doc.documentElement, "sp")) {
    const ph = find(sp, "ph");
    if (!ph) continue;
    const box = xfrmOf(sp, scale);
    if (!box) continue;
    const key = attr(ph, "type") || "body";
    map[key] ||= box;
    if (attr(ph, "idx")) map[`idx:${attr(ph, "idx")}`] ||= box;
  }
  return map;
}

function readParas(txBody, theme, defaults) {
  const paras = [];
  for (const p of kids(txBody, "p")) {
    const ppr = kid(p, "pPr");
    const algn = attr(ppr, "algn");
    const para = {
      align: { ctr: "center", r: "right", just: "justify" }[algn] || "left",
      list: kid(ppr, "buChar") ? { ordered: false, level: Number(attr(ppr, "lvl") || 0) }
        : kid(ppr, "buAutoNum") ? { ordered: true, level: Number(attr(ppr, "lvl") || 0) } : null,
      heading: 0, runs: [],
    };
    for (const r of p.children) {
      if (r.localName === "br") { para.runs.push({ br: true, text: "" }); continue; }
      if (r.localName !== "r" && r.localName !== "fld") continue;
      const rpr = kid(r, "rPr");
      const f = { ...defaults };
      if (rpr) {
        if (attr(rpr, "b") === "1") f.b = true; else if (attr(rpr, "b") === "0") f.b = false;
        if (attr(rpr, "i") === "1") f.i = true;
        if (attr(rpr, "u") && attr(rpr, "u") !== "none") f.u = true;
        if (attr(rpr, "strike") && attr(rpr, "strike") !== "noStrike") f.s = true;
        if (attr(rpr, "sz")) f.sizePx = Number(attr(rpr, "sz")) / 100 / 0.75;
        const fill = kid(rpr, "solidFill"); if (fill) f.color = colorOf(fill, theme);
        const latin = attr(kid(rpr, "latin"), "typeface"); if (latin && !latin.startsWith("+")) f.font = latin;
        const base = Number(attr(rpr, "baseline") || 0); if (base > 0) f.sup = true; if (base < 0) f.sub = true;
      }
      para.runs.push({ ...f, text: kid(r, "t")?.textContent || "" });
    }
    paras.push(para);
  }
  return paras;
}

export async function pptxToCreative(bytes, opts = {}) {
  const pkg = await unzip(bytes);
  const pres = pkg.xml("ppt/presentation.xml");
  if (!pres) throw new Error("Fichier PowerPoint invalide (ppt/presentation.xml absent).");
  const uid = opts.uid || (() => `el-${Math.random().toString(36).slice(2)}`);
  const sz = find(pres.documentElement, "sldSz");
  const cx = Number(attr(sz, "cx") || SLD_CX), cy = Number(attr(sz, "cy") || SLD_CY);
  const scale = { x: W / cx, y: H / cy };
  const theme = readTheme(pkg);
  const presRels = readRels(pkg, "ppt/presentation.xml");
  const slidePaths = findAll(pres.documentElement, "sldId").map((s) => presRels[relId(s)]?.target).filter(Boolean);

  const pages = [];
  for (const path of slidePaths) {
    const doc = pkg.xml(path);
    if (!doc) continue;
    const rels = readRels(pkg, path);
    const layoutPath = Object.values(rels).find((r) => /slideLayout/.test(r.type))?.target;
    const layoutPh = layoutPath ? placeholderMap(pkg, layoutPath, scale) : {};
    const masterPath = layoutPath ? Object.values(readRels(pkg, layoutPath)).find((r) => /slideMaster/.test(r.type))?.target : null;
    const masterPh = masterPath ? placeholderMap(pkg, masterPath, scale) : {};
    const page = { w: W, h: H, background: "#ffffff", elements: [], notes: "" };

    const bgFill = find(find(doc.documentElement, "bg"), "solidFill");
    const bgColor = bgFill ? colorOf(bgFill, theme) : "";
    if (bgColor) page.background = `#${bgColor}`;
    const bgBlip = find(find(doc.documentElement, "bg"), "blip");
    if (bgBlip && rels[attr(bgBlip, "embed")]) {
      const t = rels[attr(bgBlip, "embed")].target;
      if (pkg.bytes(t)) page.elements.push({ id: uid(), type: "image", x: 0, y: 0, w: W, h: H, rotation: 0, src: bytesToDataUrl(pkg.bytes(t), t), sandboxPath: "", sandboxId: "", fit: "cover", radius: 0, opacity: 1, alt: "" });
    }
    const bgHex = page.background.replace("#", "");
    const darkBg = bgHex.length === 6
      && (0.299 * parseInt(bgHex.slice(0, 2), 16) + 0.587 * parseInt(bgHex.slice(2, 4), 16) + 0.114 * parseInt(bgHex.slice(4, 6), 16)) < 110;

    const tree = find(doc.documentElement, "spTree");
    const shapes = tree ? [...tree.children] : [];
    const visit = (nodes) => {
      for (const node of nodes) {
        const n = node.localName;
        if (n === "grpSp") { visit([...node.children]); continue; }
        if (n === "sp") {
          const ph = find(node, "ph");
          const box = xfrmOf(node, scale)
            || (ph && (layoutPh[`idx:${attr(ph, "idx")}`] || layoutPh[attr(ph, "type") || "body"] || masterPh[attr(ph, "type") || "body"]))
            || { x: 80, y: 80, w: 1120, h: 120, rotation: 0 };
          const phType = ph ? attr(ph, "type") || "body" : "";
          const spPr = kid(node, "spPr");
          const fill = kid(spPr, "solidFill");
          const fillColor = fill ? colorOf(fill, theme) : "";
          const geom = attr(kid(spPr, "prstGeom"), "prst") || "rect";
          const txBody = kid(node, "txBody");
          const isTitle = phType === "title" || phType === "ctrTitle";
          // Tailles par défaut du masque Lumen/Office : titre 44 pt, corps 24 pt → px.
          const defaults = { sizePx: isTitle ? 44 / 0.75 : 24 / 0.75, color: darkBg ? "FFFFFF" : (theme.tx1 || "1D1D1F") };
          const paras = txBody ? readParas(txBody, theme, defaults) : [];
          const hasText = paras.some((p) => p.runs.some((r) => r.text.trim()));
          if (fillColor && (geom !== "rect" || !hasText)) {
            page.elements.push({ id: uid(), type: "shape", shape: geom === "ellipse" ? "ellipse" : "rect", x: box.x, y: box.y, w: box.w, h: box.h, rotation: box.rotation, fill: `#${fillColor}`, stroke: "transparent", strokeWidth: 0, radius: geom === "roundRect" ? 16 : 0, opacity: 1 });
          }
          if (hasText) {
            const maxSize = Math.max(...paras.flatMap((p) => p.runs.map((r) => r.sizePx || defaults.sizePx)));
            const color = `#${paras[0]?.runs.find((r) => r.color)?.color || defaults.color}`;
            page.elements.push({
              id: uid(), type: "text", x: box.x, y: box.y, w: box.w, h: box.h, rotation: box.rotation,
              html: paragraphsToHtml(paras, { sizePx: maxSize, color: color.slice(1) }),
              fontSize: Math.round(maxSize), fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
              color, align: paras[0]?.align || "left", weight: isTitle || paras[0]?.runs[0]?.b ? 700 : 400,
              lineHeight: 1.2, letterSpacing: 0, bg: fillColor && geom === "rect" ? `#${fillColor}` : "transparent", opacity: 1, padding: 6,
              style: isTitle ? "h1" : "",
            });
          }
        } else if (n === "pic") {
          const box = xfrmOf(node, scale);
          const blip = find(node, "blip");
          const rel = rels[attr(blip, "embed")];
          if (box && rel && pkg.bytes(rel.target)) {
            page.elements.push({ id: uid(), type: "image", x: box.x, y: box.y, w: box.w, h: box.h, rotation: box.rotation, src: bytesToDataUrl(pkg.bytes(rel.target), rel.target), sandboxPath: "", sandboxId: "", fit: "cover", radius: 0, opacity: 1, alt: attr(find(node, "cNvPr"), "descr") || "" });
          }
        } else if (n === "graphicFrame") {
          const tbl = find(node, "tbl");
          const off = find(node, "off"), ext = find(node, "ext");
          if (tbl && off && ext) {
            const rows = kids(tbl, "tr").map((tr) => kids(tr, "tc").map((tc) => {
              const paras = readParas(kid(tc, "txBody"), theme, {});
              return paras.map((p) => runsToHtml(p.runs)).join("<br>");
            }));
            page.elements.push({
              id: uid(), type: "table", x: Number(attr(off, "x")) * scale.x, y: Number(attr(off, "y")) * scale.y,
              w: Number(attr(ext, "cx")) * scale.x, h: Number(attr(ext, "cy")) * scale.y, rotation: 0,
              rows, header: true, opacity: 1, fontSize: 18, color: darkBg ? "#ffffff" : "#1d1d1f",
              headerBg: darkBg ? "#1c2540" : "#f2f2f7", borderColor: "#d1d1d6", zebra: false, align: "left",
            });
          }
        }
      }
    };
    visit(shapes);

    // Notes de l'orateur.
    const notesPath = Object.values(rels).find((r) => /notesSlide/.test(r.type))?.target;
    const notes = notesPath && pkg.xml(notesPath);
    if (notes) {
      const body = findAll(notes.documentElement, "sp").find((sp) => attr(find(sp, "ph"), "type") === "body");
      page.notes = body ? findAll(body, "p").map((p) => findAll(p, "t").map((t) => t.textContent).join("")).join("\n").trim() : "";
    }
    pages.push(page);
  }
  const core = pkg.xml("docProps/core.xml");
  const title = (core && find(core.documentElement, "title")?.textContent) || opts.title || "Présentation";
  return { kind: "presentation", title, pages: pages.length ? pages : [{ w: W, h: H, background: "#ffffff", elements: [] }] };
}

// =========================================================================
// Export
// =========================================================================

function solid(hex) { return hex ? `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>` : ""; }

function runPr(r, base) {
  const size = r.sizePx || base.sizePx || 24;
  const attrs = [`lang="fr-FR"`, `sz="${Math.round(size * 0.75 * 100)}"`];
  if (r.b ?? base.b) attrs.push(`b="1"`);
  if (r.i) attrs.push(`i="1"`);
  if (r.u || r.href) attrs.push(`u="sng"`);
  if (r.s) attrs.push(`strike="sngStrike"`);
  if (r.sup) attrs.push(`baseline="30000"`);
  if (r.sub) attrs.push(`baseline="-25000"`);
  const color = hex6(r.color) || hex6(base.color);
  const font = r.font || base.font;
  return `<a:rPr ${attrs.join(" ")} dirty="0">${solid(color)}${font ? `<a:latin typeface="${xmlEsc(font)}"/>` : ""}</a:rPr>`;
}

function txBodyXml(paras, base, anchor = "t") {
  const body = paras.map((p) => {
    const algn = { center: "ctr", right: "r", justify: "just" }[p.align] || "l";
    const bullet = p.list ? (p.list.ordered ? `<a:buAutoNum type="arabicPeriod"/>` : `<a:buChar char="•"/>`) : `<a:buNone/>`;
    const indent = p.list ? ` marL="${342900 * (p.list.level + 1)}" indent="-285750"` : "";
    const runs = p.runs.map((r) => (r.br ? `<a:br>${runPr(r, base)}</a:br>` : r.text ? `<a:r>${runPr(r, base)}<a:t>${xmlEsc(r.text)}</a:t></a:r>` : "")).join("");
    return `<a:p><a:pPr algn="${algn}"${indent}>${bullet}</a:pPr>${runs}<a:endParaRPr lang="fr-FR" sz="${Math.round((base.sizePx || 24) * 75)}" dirty="0"/></a:p>`;
  }).join("");
  return `<p:txBody><a:bodyPr wrap="square" lIns="45720" tIns="45720" rIns="45720" bIns="45720" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody>`;
}

function xfrm(el) {
  const rot = el.rotation ? ` rot="${Math.round(el.rotation * 60000)}"` : "";
  return `<a:xfrm${rot}><a:off x="${pxToEmu(el.x)}" y="${pxToEmu(el.y)}"/><a:ext cx="${pxToEmu(Math.max(1, el.w))}" cy="${pxToEmu(Math.max(1, el.h))}"/></a:xfrm>`;
}

async function slideXml(page, ctx) {
  let id = 2;
  let shapes = "";
  const scaleX = W / (page.w || W), scaleY = H / (page.h || H);
  for (const raw of page.elements) {
    const el = { ...raw, x: raw.x * scaleX, y: raw.y * scaleY, w: raw.w * scaleX, h: raw.h * scaleY };
    const n = id++;
    const alpha = el.opacity != null && el.opacity < 1 ? `<a:alpha val="${Math.round(el.opacity * 100000)}"/>` : "";
    if (el.type === "text") {
      const base = { sizePx: el.fontSize, color: el.color, b: (el.weight || 400) >= 600, font: String(el.fontFamily || "").split(",")[0].replace(/["']/g, "").trim().replace(/^(-apple-system|system-ui|BlinkMacSystemFont)$/, "") };
      const paras = htmlToParagraphs(el.html, { ...base, align: el.align });
      const bg = hex6(el.bg);
      shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${n}" name="Texte ${n}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${bg ? solid(bg) : "<a:noFill/>"}</p:spPr>${txBodyXml(paras.map((p) => ({ ...p, align: p.align || el.align })), base)}</p:sp>`;
    } else if (el.type === "shape") {
      const prst = el.shape === "ellipse" || el.shape === "circle" ? "ellipse" : el.radius > 0 ? "roundRect" : "rect";
      const stroke = hex6(el.stroke);
      shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${n}" name="Forme ${n}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${hex6(el.fill) ? `<a:solidFill><a:srgbClr val="${hex6(el.fill)}">${alpha}</a:srgbClr></a:solidFill>` : "<a:noFill/>"}${stroke && el.strokeWidth ? `<a:ln w="${pxToEmu(el.strokeWidth)}">${solid(stroke)}</a:ln>` : "<a:ln><a:noFill/></a:ln>"}</p:spPr></p:sp>`;
    } else if (el.type === "image") {
      const src = await ctx.loadImage(raw);
      const img = src && dataUrlToBytes(src);
      if (!img) continue;
      const rid = ctx.media(img);
      shapes += `<p:pic><p:nvPicPr><p:cNvPr id="${n}" name="Image ${n}" descr="${xmlEsc(el.alt || "")}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    } else if (el.type === "table") {
      const cols = Math.max(1, ...el.rows.map((r) => r.length));
      const colW = pxToEmu(el.w / cols), rowH = pxToEmu(el.h / Math.max(1, el.rows.length));
      const border = hex6(el.borderColor) || "D1D1D6";
      const ln = (s) => `<a:${s} w="9525"><a:solidFill><a:srgbClr val="${border}"/></a:solidFill></a:${s}>`;
      const rowsXml = el.rows.map((row, ri) => `<a:tr h="${rowH}">${Array.from({ length: cols }, (_, c) => {
        const head = el.header && ri === 0;
        const base = { sizePx: el.fontSize, color: el.color, b: head };
        const paras = htmlToParagraphs(row[c] || "", base);
        const inner = txBodyXml(paras, base).replace(/^<p:txBody>/, "<a:txBody>").replace(/<\/p:txBody>$/, "</a:txBody>");
        return `<a:tc>${inner}<a:tcPr>${ln("lnL")}${ln("lnR")}${ln("lnT")}${ln("lnB")}${head && hex6(el.headerBg) ? solid(hex6(el.headerBg)) : ""}</a:tcPr></a:tc>`;
      }).join("")}</a:tr>`).join("");
      shapes += `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${n}" name="Tableau ${n}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${pxToEmu(el.x)}" y="${pxToEmu(el.y)}"/><a:ext cx="${pxToEmu(el.w)}" cy="${pxToEmu(el.h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join("")}</a:tblGrid>${rowsXml}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    }
  }
  const bg = hex6(page.background);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${bg ? `<p:bg><p:bgPr>${solid(bg)}<a:effectLst/></p:bgPr></p:bg>` : ""}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Lumen"><a:themeElements><a:clrScheme name="Lumen"><a:dk1><a:srgbClr val="1D1D1F"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0B1020"/></a:dk2><a:lt2><a:srgbClr val="F2F2F7"/></a:lt2><a:accent1><a:srgbClr val="0A84FF"/></a:accent1><a:accent2><a:srgbClr val="5E5CE6"/></a:accent2><a:accent3><a:srgbClr val="30D158"/></a:accent3><a:accent4><a:srgbClr val="FF9F0A"/></a:accent4><a:accent5><a:srgbClr val="FF375F"/></a:accent5><a:accent6><a:srgbClr val="16B8A6"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Lumen"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Lumen"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const EMPTY_TREE = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>`;
const NSDECL = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;

function notesXml(text) {
  const paras = String(text).split("\n").map((l) => `<a:p><a:r><a:rPr lang="fr-FR" dirty="0"/><a:t>${xmlEsc(l)}</a:t></a:r></a:p>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes ${NSDECL}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
}

/**
 * Présentation Opus → octets .pptx.
 * @param {object} doc { title, pages }
 * @param {{ loadImage?: (el) => Promise<string> }} opts
 */
export async function creativeToPptx(doc, opts = {}) {
  const parts = {};
  const mediaExt = new Set();
  let mediaSeq = 1;
  const pages = doc.pages?.length ? doc.pages : [{ w: W, h: H, background: "#ffffff", elements: [] }];
  const hasNotes = pages.some((p) => String(p.notes || "").trim());

  for (let i = 0; i < pages.length; i++) {
    const rels = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
    let relSeq = 2;
    const ctx = {
      loadImage: opts.loadImage || (async (el) => el.src || ""),
      media(img) {
        const name = `image${mediaSeq++}.${img.ext}`;
        parts[`ppt/media/${name}`] = img.bytes;
        mediaExt.add(img.ext);
        const id = `rId${relSeq++}`;
        rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`);
        return id;
      },
    };
    parts[`ppt/slides/slide${i + 1}.xml`] = await slideXml(pages[i], ctx);
    if (String(pages[i].notes || "").trim()) {
      rels.push(`<Relationship Id="rId${relSeq++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`);
      parts[`ppt/notesSlides/notesSlide${i + 1}.xml`] = notesXml(pages[i].notes);
      parts[`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${i + 1}.xml"/></Relationships>`;
    }
    parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  }

  const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp" };
  const slideOverrides = pages.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const notesOverrides = pages.map((p, i) => (String(p.notes || "").trim() ? `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>` : "")).join("");

  parts["[Content_Types].xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...mediaExt].map((e) => `<Default Extension="${e}" ContentType="${MIME[e] || "image/png"}"/>`).join("")}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${hasNotes ? `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` : ""}${slideOverrides}${notesOverrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  parts["_rels/.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const slideRels = pages.map((_, i) => `<Relationship Id="rId${i + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("");
  parts["ppt/_rels/presentation.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>${hasNotes ? `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>` : ""}${slideRels}</Relationships>`;
  parts["ppt/presentation.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NSDECL} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId3"/></p:notesMasterIdLst>` : ""}<p:sldIdLst>${pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${SLD_CX}" cy="${SLD_CY}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="fr-FR"/></a:defPPr></p:defaultTextStyle></p:presentation>`;
  parts["ppt/slideMasters/slideMaster1.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NSDECL}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
  parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`;
  parts["ppt/slideLayouts/slideLayout1.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NSDECL} type="blank" preserve="1"><p:cSld name="Vide">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  parts["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  parts["ppt/theme/theme1.xml"] = THEME_XML;
  if (hasNotes) {
    parts["ppt/theme/theme2.xml"] = THEME_XML;
    parts["ppt/notesMasters/notesMaster1.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster ${NSDECL}><p:cSld>${EMPTY_TREE}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>`;
    parts["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme2.xml"/></Relationships>`;
  }
  parts["docProps/core.xml"] = CORE_XML(doc.title || "Présentation");
  parts["docProps/app.xml"] = APP_XML;
  return zip(parts);
}
