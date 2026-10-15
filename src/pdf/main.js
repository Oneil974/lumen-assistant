// PDF — lecteur et annotateur.
//
// Modèle d'annotation (coordonnées en POINTS PDF, origine en haut à gauche de
// la page non tournée, donc indépendantes du zoom) :
//   { id, page, type: "highlight"|"note"|"text"|"ink"|"sign", color,
//     x, y, w, h, text?, points?: [[x,y]…], image?: dataURL }
// Elles sont gardées dans le magasin de l'app, par fichier, à chaque geste ;
// « Enregistrer » écrit une COPIE annotée via pdf-lib :
//   - surlignage, trait, texte et signature sont dessinés dans la page ;
//   - une note devient une vraie annotation PDF (/Text) — l'icône « bulle »
//     que tout lecteur sait ouvrir.

import { autoTranslate, registerTranslations, tt } from "../apps-i18n.js";
import { createStore } from "../lib/app-state.js";
import { icon } from "../lib/icons.js";
import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { streamTarget } from "../lib/stream-view.js";
import { makeObject, receive, handoff } from "../lib/interop.js";
import { readSandboxBytes, writeSandboxBytes } from "../lib/office/ooxml.js";
import { PDF_EN } from "./i18n.js";
import { promptSheet } from "../lib/confirm.js";

registerTranslations(PDF_EN);

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = createStore("pdf");
const uid = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const state = {
  files: [], query: "",
  doc: null, file: null, bytes: null,
  scale: 1.2, tool: "select", color: "#ffd60a",
  annots: [], undo: [],
  pages: [],          // [{ el, canvas, layer, vp: {w,h}, rendered }]
  current: 1,
  signature: null,
};

function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); }
function paintIcons(root = document) { root.querySelectorAll("[data-ic]").forEach((n) => { n.innerHTML = icon(n.dataset.ic) || ""; }); }

let pdfjs = null;
async function lib() {
  if (pdfjs) return pdfjs;
  pdfjs = await import("../lib/vendor/pdfjs/pdf.min.js");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("../lib/vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;
  return pdfjs;
}

// ===== Bibliothèque ========================================================
async function listPdfs() {
  if (!invoke) return [];
  let sandboxes = [];
  try { sandboxes = (await invoke("sandbox_list")) || []; } catch { return []; }
  const out = [];
  const walk = async (sb, path, depth) => {
    let entries = [];
    try { entries = (await invoke("sandbox_read_dir", { id: sb.id, path })) || []; } catch { return; }
    for (const e of entries) {
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.is_dir) { if (depth < 5 && !e.name.startsWith(".")) await walk(sb, p, depth + 1); }
      else if (/\.pdf$/i.test(e.name) && !e.name.startsWith("._")) out.push({ sandboxId: sb.id, sandbox: sb.name, path: p, name: e.name, size: e.size || 0 });
    }
  };
  for (const sb of sandboxes) await walk(sb, "", 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function renderLib() {
  const q = state.query.toLowerCase();
  const items = state.files.filter((f) => !q || f.name.toLowerCase().includes(q) || f.sandbox.toLowerCase().includes(q));
  const lib = $("lib");
  if (!items.length) { lib.innerHTML = `<div class="muted pad">${esc(tt(state.files.length ? "Aucun résultat." : "Aucun PDF dans vos sandboxes."))}</div>`; return; }
  lib.innerHTML = items.map((f, i) => {
    const on = state.file && state.file.sandboxId === f.sandboxId && state.file.path === f.path;
    const n = (store.getJSON(annotKey(f), []) || []).length;
    return `<button class="lib-item${on ? " is-on" : ""}" data-i="${state.files.indexOf(f)}">
      <span class="lib-ic">${icon("pdf")}</span>
      <span class="lib-tx"><b>${esc(f.name)}</b><small>${esc(f.sandbox)}${n ? ` · ${esc(tt("{n} annotation(s)", { n }))}` : ""}</small></span></button>`;
  }).join("");
}

const annotKey = (f) => `annots:${f.sandboxId}|${f.path}`;

// ===== Ouverture ===========================================================
async function openFile(f) {
  try {
    const bytes = await readSandboxBytes(invoke, f.sandboxId, f.path);
    await openBytes(bytes, f);
  } catch (e) {
    toast(`${tt("Impossible d'ouvrir ce PDF")} : ${e?.message || e}`);
  }
}

async function openBytes(bytes, f) {
  const { getDocument } = await lib();
  state.bytes = bytes;
  state.file = f;
  // pdf.js prend possession du tampon : on lui passe une copie.
  state.doc = await getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
  state.annots = store.getJSON(annotKey(f), []) || [];
  state.undo = [];
  $("doc-title").textContent = f.name;
  $("empty").hidden = true;
  $("panel").hidden = false;
  await buildPages();
  renderLib();
  renderAnnotList();
}

async function buildPages() {
  const host = $("pages");
  host.innerHTML = "";
  state.pages = [];
  for (let n = 1; n <= state.doc.numPages; n++) {
    const page = await state.doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.page = String(n);
    el.innerHTML = `<canvas></canvas><div class="layer"></div><span class="page-no">${n}</span>`;
    host.appendChild(el);
    state.pages.push({ n, page, el, canvas: el.querySelector("canvas"), layer: el.querySelector(".layer"), vp: { w: base.width, h: base.height }, rendered: 0 });
  }
  sizePages();
  observePages();
}

function sizePages() {
  for (const p of state.pages) {
    p.el.style.width = `${p.vp.w * state.scale}px`;
    p.el.style.height = `${p.vp.h * state.scale}px`;
    p.rendered = 0;
    drawLayer(p);
  }
  $("zoom").textContent = `${Math.round(state.scale / 1.2 * 100)} %`;
  // Réobserver relance le rendu des pages visibles à la nouvelle échelle.
  if (io) observePages();
}

let io = null;
function observePages() {
  io?.disconnect();
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = state.pages[Number(e.target.dataset.page) - 1];
      if (e.isIntersecting) { renderPage(p); if (e.intersectionRatio > 0.4) state.current = p.n; }
    }
  }, { root: $("viewer"), rootMargin: "400px 0px", threshold: [0, 0.4] });
  state.pages.forEach((p) => io.observe(p.el));
}

async function renderPage(p) {
  if (p.rendered === state.scale) return;
  p.rendered = state.scale;
  const dpr = window.devicePixelRatio || 1;
  const vp = p.page.getViewport({ scale: state.scale * dpr });
  p.canvas.width = vp.width; p.canvas.height = vp.height;
  p.canvas.style.width = `${vp.width / dpr}px`; p.canvas.style.height = `${vp.height / dpr}px`;
  try { await p.page.render({ canvasContext: p.canvas.getContext("2d"), viewport: vp }).promise; } catch {}
}

// ===== Calque d'annotations ================================================
function drawLayer(p) {
  const s = state.scale;
  const items = state.annots.filter((a) => a.page === p.n);
  p.layer.innerHTML = items.map((a) => {
    const box = `left:${a.x * s}px;top:${a.y * s}px;width:${(a.w || 0) * s}px;height:${(a.h || 0) * s}px`;
    if (a.type === "highlight") return `<div class="an an-hl" data-id="${a.id}" style="${box};background:${a.color}"></div>`;
    if (a.type === "note") return `<button class="an an-note" data-id="${a.id}" style="left:${a.x * s}px;top:${a.y * s}px;--c:${a.color}" title="${esc(a.text)}">${icon("sticky-note")}</button>`;
    if (a.type === "text") return `<div class="an an-text" data-id="${a.id}" style="left:${a.x * s}px;top:${a.y * s}px;font-size:${(a.size || 12) * s}px;color:${a.color === "#ffd60a" ? "#1d1d1f" : a.color}">${esc(a.text)}</div>`;
    if (a.type === "sign") return `<img class="an an-sign" data-id="${a.id}" src="${a.image}" style="${box}" alt="" />`;
    if (a.type === "ink") {
      const d = a.points.map((pt, i) => `${i ? "L" : "M"}${pt[0] * s} ${pt[1] * s}`).join(" ");
      return `<svg class="an an-ink" data-id="${a.id}" style="left:0;top:0;width:${p.vp.w * s}px;height:${p.vp.h * s}px"><path d="${d}" stroke="${a.color}" stroke-width="${2 * s}" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    return "";
  }).join("");
}

function persist() {
  if (!state.file) return;
  store.set(annotKey(state.file), state.annots);
  renderAnnotList();
}

function commit(mutator) {
  state.undo.push(JSON.stringify(state.annots));
  if (state.undo.length > 60) state.undo.shift();
  mutator();
  persist();
}

function redrawPage(n) { const p = state.pages[n - 1]; if (p) drawLayer(p); }

function renderAnnotList() {
  const list = $("annot-list");
  $("annot-count").textContent = state.annots.length ? String(state.annots.length) : "";
  if (!state.annots.length) { list.innerHTML = `<div class="muted pad">${esc(tt("Aucune annotation pour l'instant."))}</div>`; return; }
  const LABEL = { highlight: "Surlignage", note: "Note", text: "Texte", ink: "Trait", sign: "Signature" };
  list.innerHTML = [...state.annots].sort((a, b) => a.page - b.page || a.y - b.y).map((a) => `
    <button class="annot" data-id="${a.id}">
      <span class="dot" style="background:${a.color || "#999"}"></span>
      <span class="annot-tx"><b>${esc(tt(LABEL[a.type] || a.type))} · p. ${a.page}</b>${a.text ? `<small>${esc(a.text.slice(0, 90))}</small>` : ""}</span>
    </button>`).join("");
}

// ===== Outils ==============================================================
function pagePoint(p, e) {
  const r = p.el.getBoundingClientRect();
  return [(e.clientX - r.left) / state.scale, (e.clientY - r.top) / state.scale];
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("is-on", b.dataset.tool === tool));
  $("pages").dataset.tool = tool;
  if (tool === "sign" && !state.signature) openSignPad();
}

function wirePages() {
  const host = $("pages");
  let drag = null;
  host.addEventListener("pointerdown", async (e) => {
    const pageEl = e.target.closest(".page");
    if (!pageEl || !state.doc) return;
    const p = state.pages[Number(pageEl.dataset.page) - 1];
    const [x, y] = pagePoint(p, e);
    const hit = e.target.closest(".an");
    // Sans cela, le focus par défaut du clic arrive APRÈS l'ouverture de la
    // boîte de saisie et lui retire le curseur.
    if (state.tool !== "select") e.preventDefault();
    if (state.tool === "erase" && hit) {
      commit(() => { state.annots = state.annots.filter((a) => a.id !== hit.dataset.id); });
      redrawPage(p.n);
      return;
    }
    if (state.tool === "select") {
      if (hit?.classList.contains("an-note")) editNote(hit.dataset.id);
      return;
    }
    if (state.tool === "note") {
      const text = await promptSheet({ title: tt("Nouvelle note"), placeholder: tt("Texte de la note :"), value: "", multiline: true });
      if (!text) return;
      commit(() => state.annots.push({ id: uid(), page: p.n, type: "note", color: state.color, x, y, w: 20, h: 20, text }));
      redrawPage(p.n);
      return;
    }
    if (state.tool === "text") {
      const text = await promptSheet({ title: tt("Texte à ajouter sur la page :"), value: "" });
      if (!text) return;
      commit(() => state.annots.push({ id: uid(), page: p.n, type: "text", color: state.color, x, y, w: 0, h: 0, size: 12, text }));
      redrawPage(p.n);
      return;
    }
    if (state.tool === "sign") {
      if (!state.signature) { openSignPad(); return; }
      const w = 160, h = w * state.signature.ratio;
      commit(() => state.annots.push({ id: uid(), page: p.n, type: "sign", color: "#000000", x: x - w / 2, y: y - h / 2, w, h, image: state.signature.dataUrl }));
      redrawPage(p.n);
      return;
    }
    if (state.tool === "highlight" || state.tool === "ink") {
      e.preventDefault();
      host.setPointerCapture(e.pointerId);
      drag = { p, x0: x, y0: y, points: [[x, y]], ghost: document.createElement("div") };
      drag.ghost.className = state.tool === "highlight" ? "an an-hl ghost" : "ghost-ink";
      if (state.tool === "highlight") drag.ghost.style.background = state.color;
      p.layer.appendChild(drag.ghost);
    }
  });
  host.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = pagePoint(drag.p, e);
    const s = state.scale;
    if (state.tool === "highlight") {
      Object.assign(drag.ghost.style, {
        left: `${Math.min(x, drag.x0) * s}px`, top: `${Math.min(y, drag.y0) * s}px`,
        width: `${Math.abs(x - drag.x0) * s}px`, height: `${Math.abs(y - drag.y0) * s}px`,
      });
    } else {
      drag.points.push([x, y]);
      const d = drag.points.map((pt, i) => `${i ? "L" : "M"}${pt[0] * s} ${pt[1] * s}`).join(" ");
      drag.ghost.innerHTML = `<svg style="position:absolute;left:0;top:0;width:${drag.p.vp.w * s}px;height:${drag.p.vp.h * s}px"><path d="${d}" stroke="${state.color}" stroke-width="${2 * s}" fill="none" stroke-linecap="round"/></svg>`;
    }
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.ghost.remove();
    const [x, y] = pagePoint(d.p, e);
    if (state.tool === "highlight") {
      const w = Math.abs(x - d.x0), h = Math.abs(y - d.y0);
      if (w < 3 || h < 3) return;
      commit(() => state.annots.push({ id: uid(), page: d.p.n, type: "highlight", color: state.color, x: Math.min(x, d.x0), y: Math.min(y, d.y0), w, h }));
    } else if (d.points.length > 2) {
      commit(() => state.annots.push({ id: uid(), page: d.p.n, type: "ink", color: state.color, x: 0, y: 0, w: 0, h: 0, points: d.points.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]) }));
    }
    redrawPage(d.p.n);
  };
  host.addEventListener("pointerup", end);
  host.addEventListener("pointercancel", end);
}

async function editNote(id) {
  const a = state.annots.find((x) => x.id === id);
  if (!a) return;
  const text = await promptSheet({ title: tt("Note"), value: a.text || "", multiline: true, confirm: tt("Enregistrer") });
  if (text == null) return;
  commit(() => { if (text) a.text = text; else state.annots = state.annots.filter((x) => x.id !== id); });
  redrawPage(a.page);
}

// ===== Signature ===========================================================
function openSignPad() {
  const modal = $("sign-modal");
  const pad = $("sign-pad");
  const ctx = pad.getContext("2d");
  ctx.clearRect(0, 0, pad.width, pad.height);
  ctx.lineWidth = 2.6; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0b1a3a";
  modal.hidden = false;
  let down = false, last = null, drawn = false;
  const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
  pad.onpointerdown = (e) => { down = true; last = pos(e); pad.setPointerCapture(e.pointerId); };
  pad.onpointermove = (e) => { if (!down) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke(); last = p; drawn = true; };
  pad.onpointerup = () => { down = false; };
  $("sign-clear").onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };
  $("sign-cancel").onclick = () => { modal.hidden = true; if (!state.signature) setTool("select"); };
  $("sign-ok").onclick = () => {
    if (!drawn) { toast(tt("Signez d'abord dans le cadre.")); return; }
    // Recadrage sur le tracé : une signature ne doit pas traîner de marges.
    const img = ctx.getImageData(0, 0, pad.width, pad.height).data;
    let x0 = pad.width, y0 = pad.height, x1 = 0, y1 = 0;
    for (let y = 0; y < pad.height; y++) for (let x = 0; x < pad.width; x++) {
      if (img[(y * pad.width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    const c = document.createElement("canvas");
    c.width = Math.max(1, x1 - x0 + 8); c.height = Math.max(1, y1 - y0 + 8);
    c.getContext("2d").drawImage(pad, x0 - 4, y0 - 4, c.width, c.height, 0, 0, c.width, c.height);
    state.signature = { dataUrl: c.toDataURL("image/png"), ratio: c.height / c.width };
    store.set("signature", state.signature);
    modal.hidden = true;
    toast(tt("Signature prête : cliquez sur la page pour la poser."));
  };
}

// ===== Enregistrement (copie annotée) ======================================
function hexRgb(hex, lib) {
  const h = String(hex || "#000000").replace("#", "");
  return lib.rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}
/// Helvetica (WinAnsi) ne sait pas tout écrire : on remplace ce qu'elle ignore
/// plutôt que de faire échouer tout l'enregistrement.
const winAnsi = (s) => String(s).replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[^\x20-\x7e\xa0-\xff\n]/g, "?");

async function saveAnnotated() {
  if (!state.file || !state.bytes) return;
  const PL = await import("../lib/vendor/pdf-lib.js");
  toast(tt("Enregistrement…"));
  try {
    const doc = await PL.PDFDocument.load(state.bytes.slice(0), { ignoreEncryption: true });
    const font = await doc.embedFont(PL.StandardFonts.Helvetica);
    const pages = doc.getPages();
    const images = new Map();
    for (const a of state.annots) {
      const page = pages[a.page - 1];
      if (!page) continue;
      const { height: H } = page.getSize();
      // pdf.js place l'origine en haut à gauche ; PDF en bas à gauche.
      const Y = (y) => H - y;
      if (a.type === "highlight") {
        page.drawRectangle({ x: a.x, y: Y(a.y + a.h), width: a.w, height: a.h, color: hexRgb(a.color, PL), opacity: 0.35, blendMode: PL.BlendMode.Multiply });
      } else if (a.type === "ink") {
        for (let i = 1; i < a.points.length; i++) {
          page.drawLine({ start: { x: a.points[i - 1][0], y: Y(a.points[i - 1][1]) }, end: { x: a.points[i][0], y: Y(a.points[i][1]) }, thickness: 2, color: hexRgb(a.color, PL), lineCap: PL.LineCapStyle.Round });
        }
      } else if (a.type === "text") {
        const color = a.color === "#ffd60a" ? "#1d1d1f" : a.color;
        winAnsi(a.text).split("\n").forEach((line, i) => page.drawText(line, { x: a.x, y: Y(a.y + (a.size || 12) * (i + 1)), size: a.size || 12, font, color: hexRgb(color, PL) }));
      } else if (a.type === "sign") {
        if (!images.has(a.image)) images.set(a.image, await doc.embedPng(a.image));
        page.drawImage(images.get(a.image), { x: a.x, y: Y(a.y + a.h), width: a.w, height: a.h });
      } else if (a.type === "note") {
        // Vraie note PDF (/Text) : icône bulle, texte dans la fenêtre du lecteur.
        const ctx = doc.context;
        const c = String(a.color).replace("#", "");
        const annot = ctx.obj({
          Type: "Annot", Subtype: "Text", Name: "Comment", Open: false,
          Rect: [a.x, Y(a.y + 20), a.x + 20, Y(a.y)],
          Contents: PL.PDFHexString.fromText(a.text || ""),
          T: PL.PDFHexString.fromText("Lumen"),
          C: [parseInt(c.slice(0, 2), 16) / 255, parseInt(c.slice(2, 4), 16) / 255, parseInt(c.slice(4, 6), 16) / 255],
          M: PL.PDFString.fromDate(new Date()),
        });
        const ref = ctx.register(annot);
        const annots = page.node.lookup(PL.PDFName.of("Annots"));
        if (annots instanceof PL.PDFArray) annots.push(ref);
        else page.node.set(PL.PDFName.of("Annots"), ctx.obj([ref]));
      }
    }
    const out = await doc.save();
    const path = state.file.path.replace(/(\.pdf)?$/i, "").replace(/ \(annoté\)$/, "") + ` (${tt("annoté")}).pdf`;
    await writeSandboxBytes(invoke, state.file.sandboxId, path, out);
    toast(`${tt("Copie annotée enregistrée")} : ${path.split("/").pop()}`);
    state.files = await listPdfs();
    renderLib();
  } catch (e) {
    toast(`${tt("Échec de l'enregistrement")} : ${e?.message || e}`);
    console.error("[pdf]", e);
  }
}

// ===== Assistant ===========================================================
async function pageText(n) {
  const page = await state.doc.getPage(n);
  const tc = await page.getTextContent();
  return tc.items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " ").trim();
}

async function docText(limit = 24000) {
  let text = "";
  for (let n = 1; n <= state.doc.numPages && text.length < limit; n++) text += `\n\n[Page ${n}]\n${await pageText(n)}`;
  return text.slice(0, limit);
}

async function runAi(kind) {
  if (!state.doc) return;
  const out = $("ai-out");
  out.innerHTML = `<div class="muted">${esc(tt("Réflexion…"))}</div>`;
  const en = tt("Résumer") !== "Résumer";
  try {
    if (kind === "cards") {
      const text = await docText(30000);
      // Les fiches vivent dans l'app Études : on lui passe le cours tel quel,
      // c'est elle qui génère, répète et interroge.
      await handoff("studies", makeObject("text", { title: state.file.name.replace(/\.pdf$/i, ""), text, source: { sandboxId: state.file.sandboxId, path: state.file.path } }, { app: "pdf", name: "PDF" }));
      out.innerHTML = `<div class="muted">${esc(tt("Cours envoyé à Études : les fiches s'y génèrent."))}</div>`;
      return;
    }
    const text = kind === "page" ? await pageText(state.current) : await docText();
    if (!text.trim()) { out.innerHTML = `<div class="muted">${esc(tt("Ce PDF ne contient pas de texte lisible (document scanné ?)."))}</div>`; return; }
    // Document long : résumé PAR PARTIES puis synthèse. Envoyé d'un bloc
    // (24 000 caractères ≈ 7 000 tokens), il débordait la fenêtre d'un petit
    // modèle local (4 096) : le serveur tronquait, la consigne disparaissait
    // et le modèle répondait n'importe quoi (« Compris. Je m'adapte. »).
    let source = text;
    const CHUNK = 6000;
    if (kind !== "page" && text.length > CHUNK + 1000) {
      const parts = [];
      for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
      const notes = [];
      for (let k = 0; k < parts.length; k++) {
        out.innerHTML = `<div class="muted">${esc(en ? `Reading part ${k + 1} / ${parts.length}…` : `Lecture de la partie ${k + 1} / ${parts.length}…`)}</div>`;
        const { messages: m } = PROMPTS["app.pdf.part"].build({ text: parts[k], lang: en ? "en" : "fr" });
        const { content: c } = await llmChat(m, { rawSystem: true, think: false, maxTokens: 500 });
        if (String(c || "").trim()) notes.push(String(c).trim());
      }
      source = notes.join("\n\n");
    }
    const { messages } = PROMPTS[kind === "page" ? "app.pdf.page" : "app.pdf.summary"].build({ text: source, lang: en ? "en" : "fr" });
    const { markdownToHtml } = await import("../lib/markdown.js");
    const live = streamTarget(out, markdownToHtml);
    const { content } = await llmChat(messages, { rawSystem: true, onUpdate: live.onUpdate });
    live.done(markdownToHtml(String(content || "")));
  } catch (e) {
    out.innerHTML = `<div class="muted">${esc(String(e?.message || e))}</div>`;
  }
}

// ===== Import depuis l'ordinateur ==========================================
async function importFromDisk(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let sandboxes = [];
  try { sandboxes = (await invoke("sandbox_list")) || []; } catch {}
  const sb = sandboxes.find((s) => /cours|études|etudes|documents/i.test(s.name)) || sandboxes[0];
  if (!sb) { toast(tt("Créez d'abord une sandbox dans Fichiers.")); return; }
  const path = `PDF/${file.name}`;
  await writeSandboxBytes(invoke, sb.id, path, bytes);
  state.files = await listPdfs();
  const f = state.files.find((x) => x.sandboxId === sb.id && x.path === path) || { sandboxId: sb.id, sandbox: sb.name, path, name: file.name };
  await openBytes(bytes, f);
}

// ===== Démarrage ===========================================================
async function init() {
  paintIcons();
  await store.ready();
  state.signature = store.getJSON("signature", null);
  document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => {
    state.color = b.dataset.color;
    document.querySelectorAll("[data-color]").forEach((x) => x.classList.toggle("is-on", x === b));
  }));
  $("zoom-in").onclick = () => { state.scale = Math.min(4, state.scale * 1.2); sizePages(); };
  $("zoom-out").onclick = () => { state.scale = Math.max(0.4, state.scale / 1.2); sizePages(); };
  $("btn-undo").onclick = undo;
  $("btn-save").onclick = saveAnnotated;
  $("btn-ai").onclick = () => { $("panel").hidden = !$("panel").hidden || !state.doc; };
  $("btn-import").onclick = () => $("file-input").click();
  $("file-input").onchange = (e) => { const f = e.target.files?.[0]; if (f) importFromDisk(f); e.target.value = ""; };
  $("search").oninput = (e) => { state.query = e.target.value; renderLib(); };
  $("lib").onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) openFile(state.files[Number(b.dataset.i)]); };
  $("annot-list").onclick = (e) => {
    const b = e.target.closest("[data-id]");
    const a = b && state.annots.find((x) => x.id === b.dataset.id);
    if (!a) return;
    state.pages[a.page - 1]?.el.scrollIntoView({ behavior: "smooth", block: "start" });
    if (a.type === "note") setTimeout(() => editNote(a.id), 300);
  };
  document.querySelectorAll("[data-ai]").forEach((b) => b.addEventListener("click", () => runAi(b.dataset.ai)));
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveAnnotated(); return; }
    const map = { v: "select", h: "highlight", n: "note", t: "text", p: "ink", s: "sign", e: "erase" };
    if (!e.metaKey && !e.ctrlKey && map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
  });
  wirePages();
  state.files = await listPdfs();
  renderLib();
  // Un PDF envoyé depuis l'explorateur (« Envoyer vers… › PDF »).
  receive("pdf", (obj) => {
    if (obj?.kind === "file" && /\.pdf$/i.test(obj.path || "")) {
      openFile({ sandboxId: obj.sandboxId, path: obj.path, name: obj.path.split("/").pop(), sandbox: "" });
    }
  });
  autoTranslate({ observe: true });
}

function undo() {
  const prev = state.undo.pop();
  if (prev == null) return;
  state.annots = JSON.parse(prev);
  persist();
  state.pages.forEach(drawLayer);
}

init();
