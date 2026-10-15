// Briques communes aux formats Office Open XML (.docx, .pptx, .xlsx).
//
// Un fichier Office est une archive ZIP de parties XML reliées par des
// « relations » (.rels). Ce module ne connaît que ça : ouvrir/fermer l'archive,
// lire une partie en DOM, résoudre une relation, échapper du texte, et
// convertir les unités (EMU, demi-points, pixels). Le sens métier (paragraphes,
// diapositives, cellules) vit dans docx.js / pptx.js / xlsx.js.

const FFLATE = () => import("../vendor/fflate.js");

export const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
};

// 1 px CSS (96 dpi) = 9525 EMU ; 1 pt = 12700 EMU ; 1 px = 0,75 pt.
export const PX_EMU = 9525;
export const pxToEmu = (px) => Math.round(Number(px || 0) * PX_EMU);
export const emuToPx = (emu) => Number(emu || 0) / PX_EMU;
export const pxToHalfPt = (px) => Math.max(2, Math.round(Number(px || 0) * 0.75 * 2));
export const halfPtToPx = (hp) => Number(hp || 0) / 2 / 0.75;
export const pxToTwip = (px) => Math.round(Number(px || 0) * 15);
export const twipToPx = (tw) => Number(tw || 0) / 15;

export function xmlEsc(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/// "#1D1D1F" / "rgb(29,29,31)" / "red" → "1D1D1F" (sans #), ou "" si illisible.
export function hex6(color) {
  const c = String(color || "").trim();
  if (!c || c === "transparent" || c === "none") return "";
  let m = c.match(/^#?([0-9a-f]{6})$/i);
  if (m) return m[1].toUpperCase();
  m = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return `${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toUpperCase();
  m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?/i);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return "";
    return [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  const named = { black: "000000", white: "FFFFFF", red: "FF0000", blue: "0000FF", green: "008000", gray: "808080", grey: "808080", yellow: "FFFF00", orange: "FFA500" };
  return named[c.toLowerCase()] || "";
}

export async function unzip(bytes) {
  const { unzipSync } = await FFLATE();
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const dec = new TextDecoder();
  return {
    files,
    has: (p) => Boolean(files[p]),
    text: (p) => (files[p] ? dec.decode(files[p]) : ""),
    bytes: (p) => files[p] || null,
    xml: (p) => (files[p] ? new DOMParser().parseFromString(dec.decode(files[p]), "application/xml") : null),
    list: () => Object.keys(files),
  };
}

/// Archive → octets. `parts` : { chemin: string | Uint8Array }.
export async function zip(parts) {
  const { zipSync, strToU8 } = await FFLATE();
  const input = {};
  for (const [path, v] of Object.entries(parts)) input[path] = typeof v === "string" ? strToU8(v) : v;
  return zipSync(input, { level: 6 });
}

/// Relations d'une partie : { rId: { target, type } } (cible résolue en chemin
/// absolu dans l'archive).
export function readRels(pkg, partPath) {
  const dir = partPath.includes("/") ? partPath.slice(0, partPath.lastIndexOf("/")) : "";
  const relPath = `${dir ? dir + "/" : ""}_rels/${partPath.split("/").pop()}.rels`;
  const doc = pkg.xml(relPath);
  const out = {};
  if (!doc) return out;
  for (const r of doc.getElementsByTagName("Relationship")) {
    const target = r.getAttribute("Target") || "";
    const external = r.getAttribute("TargetMode") === "External";
    out[r.getAttribute("Id")] = {
      type: r.getAttribute("Type") || "",
      target: external ? target : resolvePath(dir, target),
      external,
    };
  }
  return out;
}

function resolvePath(dir, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (dir ? dir.split("/") : []);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/// Enfants directs d'un élément, par nom local (insensible au préfixe).
export function kids(el, local) {
  const out = [];
  for (const c of el?.children || []) if (c.localName === local) out.push(c);
  return out;
}
export function kid(el, local) {
  for (const c of el?.children || []) if (c.localName === local) return c;
  return null;
}
/// Premier descendant de nom local donné.
export function find(el, local) {
  if (!el) return null;
  const all = el.getElementsByTagNameNS("*", local);
  return all.length ? all[0] : null;
}
export function findAll(el, local) {
  return el ? [...el.getElementsByTagNameNS("*", local)] : [];
}
/// Attribut par nom local (w:val, r:embed…), quel que soit le préfixe.
export function attr(el, local) {
  if (!el) return null;
  for (const a of el.attributes) if (a.localName === local) return a.value;
  return null;
}

/// Attribut r:id (relation) : distinct d'un éventuel attribut `id` nu sur le
/// même élément (p:sldId porte les deux).
export function relId(el) {
  return el?.getAttributeNS(NS.r, "id") || null;
}

export function bytesToDataUrl(bytes, path) {
  const ext = String(path).split(".").pop().toLowerCase();
  const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", emf: "image/emf", wmf: "image/wmf" }[ext] || "application/octet-stream";
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

export function dataUrlToBytes(url) {
  const m = String(url || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  let bytes;
  if (m[2]) {
    const bin = atob(m[3]);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
  }
  const ext = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "png", "image/svg+xml": "svg", "image/bmp": "bmp" }[mime] || "png";
  return { bytes, mime, ext };
}

/// Dimensions naturelles d'une image (pour conserver son ratio à l'export).
export function imageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/// Les formats vectoriels Windows (EMF/WMF) et le WebP ne sont pas acceptés
/// partout : on les convertit en PNG via un canvas quand le moteur sait les lire.
export async function toPngIfNeeded(dataUrl) {
  if (!/^data:image\/(webp)/.test(dataUrl)) return dataUrl;
  const size = await imageSize(dataUrl);
  if (!size) return dataUrl;
  const c = document.createElement("canvas");
  c.width = size.w; c.height = size.h;
  const img = new Image();
  await new Promise((r) => { img.onload = r; img.onerror = r; img.src = dataUrl; });
  c.getContext("2d").drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}

export const CORE_XML = (title) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(title)}</dc:title><dc:creator>Lumen</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:modified></cp:coreProperties>`;

export const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Lumen</Application></Properties>`;

// ---- Fichiers de la sandbox en octets --------------------------------------
export async function readSandboxBytes(invoke, id, path) {
  const b64 = await invoke("sandbox_read_b64", { id, path });
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function writeSandboxBytes(invoke, id, path, bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  await invoke("sandbox_import_file", { id, path, dataB64: btoa(bin) });
}
