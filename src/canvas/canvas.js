import { autoTranslate, tt } from "../apps-i18n.js";
import { delegateExternalLinks } from "../lib/open-external.js";
// Canvas génératif — canevas infini à filiation, persisté en PROJETS sur le
// système de fichiers sandbox (voir store.js).
//
// Interaction : on saisit la POIGNÉE DE SORTIE d'un node, on tire un lien, on le
// dépose dans le vide → boîte de prompt (Image / Texte) → le résultat apparaît
// comme node ENFANT rattaché, en héritant du contexte du parent. Double-clic sur
// le vide = node racine. La génération passe par generate.js (local puis cloud).
// Chaque projet vit dans son dossier ; les images sont des fichiers, le JSON ne
// contient que le texte (prompts, contenus, positions, métadonnées).

import { generateText, generateImage, generateCharte, generateMockup, generateJingle, generateMusicSpec, generateVision, backendsStatus, resetProbes } from "./generate.js";

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const invoke = __TAURI.core?.invoke;
import * as store from "./store.js";
import * as fonts from "./fonts.js";
import { normalizeMusicSpec, playMusic, stopMusic, estimateJingleSeconds } from "./music.js";
import { mountCreativeBar } from "../lib/creative-kit.js";
import { imageProvider, imageModel, imageModelKey, imageModelsFor, imageSizesFor, nearestImageSize, listOllamaImageModels, refreshPlaygroundOption } from "../lib/image-provider.js";
import { mountBackendSwitches, refreshBackendStatus } from "./backends.js";

// Charge une famille Google Fonts à la demande (CSP non restrictive ; l'app en
// charge déjà). Idempotent : un seul <link> par famille.
const loadedFonts = new Set();
function loadGoogleFont(family) {
  if (!family || loadedFonts.has(family)) return;
  loadedFonts.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}
// Guillemets SIMPLES : la valeur est injectée dans un attribut style="…" en
// guillemets doubles ; un guillemet double ici fermerait l'attribut.
const cssFamily = (f) => `'${String(f).replace(/'/g, "")}', sans-serif`;

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------------------
//  État
// ---------------------------------------------------------------------------
let project = null;                 // { slug, title, view, nodes:[…] }
let pending = null;                 // { parentId, x, y } en attente de prompt
let popType = "image";
const imgCache = new Map();         // nodeId → data URL (images rechargées du disque)
const nodeRects = new Map();        // nodeId → { w, h } mesurés (ancrage des liens)
let saveTimer = null;
let platformFlavor = "";

const NODE_W = 240, NODE_H = 200;
const world = $("#world");
const links = $("#links");
const stage = $("#stage");

function nodes() { return project ? project.nodes : []; }
function view() { return project ? project.view : { x: 60, y: 60, scale: 1 }; }

// ---------------------------------------------------------------------------
//  Persistance (sauvegarde différée du project.json)
// ---------------------------------------------------------------------------
function queueSave() {
  if (!project) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { store.saveProject(project).catch((e) => toast("Sauvegarde : " + (e.message || e))); }, 400);
}

// ---------------------------------------------------------------------------
//  Utilitaires
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
// Modale maison promisifiée — prompt()/confirm() sont inopérants en WKWebView.
function modal({ title, input = null, message = null, ok = "OK", noCancel = false, copyText = null }) {
  return new Promise((resolve) => {
    const m = $("#modal"), inp = $("#modal-input"), msg = $("#modal-msg"), copy = $("#modal-copy");
    $("#modal-title").textContent = title;
    $("#modal-cancel").hidden = noCancel;
    inp.hidden = input === null; msg.hidden = message === null;
    if (input !== null) { inp.value = input; }
    if (message !== null) { msg.textContent = message; }
    copy.hidden = !copyText;
    copy.textContent = "Copier";
    $("#modal-ok").textContent = ok;
    m.hidden = false;
    if (input !== null) { inp.focus(); inp.select(); }
    const done = (val) => {
      m.hidden = true;
      $("#modal-ok").onclick = $("#modal-cancel").onclick = copy.onclick = inp.onkeydown = null;
      resolve(val);
    };
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(copyText);
        copy.textContent = "Copié";
        toast("Prompt copié.");
      } catch {
        toast("Copie impossible.");
      }
    };
    $("#modal-ok").onclick = () => done(input !== null ? inp.value.trim() : true);
    $("#modal-cancel").onclick = () => done(input !== null ? null : false);
    inp.onkeydown = (e) => { if (e.key === "Enter") done(inp.value.trim()); if (e.key === "Escape") done(null); };
  });
}
const askText = (title, value = "", ok = "OK") => modal({ title, input: value, ok });
const askConfirm = (title, message, ok = "Confirmer") => modal({ title, message, ok });

const nid = () => `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const eid = () => `el-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
function nodeById(id) { return nodes().find((n) => n.id === id) || null; }

function isMacPlatform() {
  return platformFlavor === "macos" || /Mac/i.test(navigator.platform || navigator.userAgent || "");
}

function canvasImageSize() {
  // La taille est validée contre le moteur ET son modèle : une résolution
  // Bonsai n'est pas acceptée par DALL·E, et inversement.
  const provider = localStorage.getItem("canvasImageBackend") || imageProvider();
  const value = nearestImageSize(provider, imageModel(provider), localStorage.getItem("canvasImageSize") || "");
  const [width, height] = value.split("x").map((n) => parseInt(n, 10));
  return { width: width || 512, height: height || 512, label: value };
}

function toWorld(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  const v = view();
  return { x: (clientX - r.left - v.x) / v.scale, y: (clientY - r.top - v.y) / v.scale };
}

// Remonte le graphe (DAG, multi-parents) en largeur depuis les parents directs ;
// dédoublonne, plus proches d'abord.
function collectAncestors(node) {
  const seen = new Set(), order = [], stack = [...(node.parentIds || [])];
  let guard = 0;
  while (stack.length && guard++ < 60) {
    const id = stack.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = nodeById(id);
    if (!n) continue;
    order.push(n);
    for (const pid of n.parentIds || []) if (!seen.has(pid)) stack.push(pid);
  }
  return order;
}

function contextFromNodes(list) {
  const parts = [];
  for (const cur of list) {
    if (cur.content) parts.push(cur.content); // texte, jingle, analyse vision
    else if (cur.charte) {
      const c = cur.charte;
      parts.push(`[charte « ${c.name} »] polices ${c.fonts.heading}/${c.fonts.body} ; couleurs ${c.palette.map((p) => p.hex).join(", ")}`);
    } else if (cur.mockup) parts.push(`[visuel « ${cur.mockup.copy?.title || ""} »] ${cur.mockup.copy?.subtitle || ""}`);
    else if (cur.text3d) parts.push(`[ancien texte décoratif] ${cur.text3d.text}`);
    else if (cur.prompt) parts.push(`[image] ${cur.prompt}`);
  }
  return parts.join("\n\n");
}

// Vrai si `ancestorId` est déjà un ancêtre de `node` (sert à éviter les cycles).
function isAncestor(ancestorId, node) {
  return node ? collectAncestors(node).some((n) => n.id === ancestorId) : false;
}

// Ajoute un bloc source comme PARENT supplémentaire d'une cible (fusion d'infos).
function addParent(target, sourceId) {
  if (!target || target.id === sourceId) return;
  if (isAncestor(target.id, nodeById(sourceId))) { toast("Lien circulaire évité."); return; }
  target.parentIds = target.parentIds || [];
  if (target.parentIds.includes(sourceId)) { toast("Déjà relié."); return; }
  target.parentIds.push(sourceId);
  queueSave(); render();
  toast("Bloc relié — régénère (↻) pour fusionner les infos.");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Mini-rendu Markdown → HTML. Le HTML brut du modèle est d'abord ÉCHAPPÉ (anti-XSS
// dans la WebView Tauri où `invoke` est exposé), puis on ré-introduit nous-mêmes un
// jeu de balises sûres (titres, gras, italique, code, listes, liens http[s]).
function mdToHtml(src) {
  const lines = escapeHtml(src).split(/\r?\n/);
  const inline = (t) => t
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  let html = "", list = null, inCode = false, code = "";
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  // Tableaux GFM : ligne d'en-tête `| a | b |` suivie d'un séparateur `| :--- | ---: |`.
  const isSep = (l) => { const s = (l || "").trim(); return /-/.test(s) && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(s); };
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const alignOf = (s) => { const l = s.startsWith(":"), r = s.endsWith(":"); return l && r ? "center" : r ? "right" : l ? "left" : ""; };
  const td = (tag, txt, a) => `<${tag}${a ? ` style="text-align:${a}"` : ""}>${inline(txt)}</${tag}>`;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "```") {
      if (inCode) { html += `<pre><code>${code}</code></pre>`; code = ""; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code += raw + "\n"; continue; }
    // Tableau (regarde la ligne suivante pour le séparateur)
    if (line.includes("|") && isSep(lines[i + 1])) {
      closeList();
      const heads = cells(line);
      const aligns = cells(lines[i + 1]).map(alignOf);
      let t = "<table><thead><tr>" + heads.map((h, j) => td("th", h, aligns[j])).join("") + "</tr></thead><tbody>";
      i += 2;
      for (; i < lines.length && lines[i].includes("|") && lines[i].trim() !== ""; i++) {
        const cs = cells(lines[i].replace(/\s+$/, ""));
        t += "<tr>" + heads.map((_, j) => td("td", cs[j] || "", aligns[j])).join("") + "</tr>";
      }
      i--; // compense l'incrément de la boucle
      html += t + "</tbody></table>";
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) { closeList(); const lvl = Math.min(4, m[1].length + 1); html += `<h${lvl}>${inline(m[2])}</h${lvl}>`; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== "ul") { closeList(); list = "ul"; html += "<ul>"; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { if (list !== "ol") { closeList(); list = "ol"; html += "<ol>"; } html += `<li>${inline(m[1])}</li>`; }
    else if (line.trim() === "") { closeList(); }
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  if (inCode) html += `<pre><code>${code}</code></pre>`;
  closeList();
  return html;
}

function safeName(s) {
  return String(s || "Visuel").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9 _-]+/g, "").trim().replace(/\s+/g, "_").slice(0, 54) || "Visuel";
}

// --- Rendu d'une charte graphique ----------------------------------------
function chartePreview(c) {
  if (!c) return "";
  loadGoogleFont(c.fonts.heading); loadGoogleFont(c.fonts.body);
  const swatches = c.palette.map((p) => `<span class="sw" style="background:${p.hex}" title="${escapeHtml(p.name)} ${p.hex}"></span>`).join("");
  return `<div class="charte">
    <div class="charte-h1" style="font-family:${cssFamily(c.fonts.heading)};font-weight:${c.headings.h1.weight}">${escapeHtml(c.name)}</div>
    <div class="charte-body" style="font-family:${cssFamily(c.fonts.body)}">${escapeHtml(c.mood || "")}</div>
    <div class="charte-sw">${swatches}</div>
    <div class="charte-fonts">${escapeHtml(c.fonts.heading)} · ${escapeHtml(c.fonts.body)}</div>
  </div>`;
}

function charteFull(c) {
  if (!c) return "";
  loadGoogleFont(c.fonts.heading); loadGoogleFont(c.fonts.body);
  const fh = cssFamily(c.fonts.heading), fb = cssFamily(c.fonts.body);
  const h = (tag, txt) => `<div style="font-family:${fh};font-size:${c.headings[tag].size}px;font-weight:${c.headings[tag].weight};line-height:1.15;margin:2px 0">${escapeHtml(txt)}</div>`;
  const swatches = c.palette.map((p) => `<div class="sw-card">
      <div class="sw-chip" style="background:${p.hex}"></div>
      <div class="sw-meta"><strong>${escapeHtml(p.name)}</strong><code>${p.hex}</code>${p.role ? `<span class="sw-role">${escapeHtml(p.role)}</span>` : ""}</div>
    </div>`).join("");
  return `<div class="charte-full">
    <h2 style="font-family:${fh}">${escapeHtml(c.name)}</h2>
    <p class="charte-mood" style="font-family:${fb}">${escapeHtml(c.mood || "")}</p>
    <div class="charte-section">Typographie</div>
    <div class="type-spec">Titres : <strong>${escapeHtml(c.fonts.heading)}</strong> · Texte : <strong>${escapeHtml(c.fonts.body)}</strong></div>
    ${h("h1", "Heading 1")}${h("h2", "Heading 2")}${h("h3", "Heading 3")}
    <p style="font-family:${fb};color:var(--text-muted);margin:6px 0 0">Le vif renard brun saute par-dessus le chien paresseux — exemple de texte courant.</p>
    <div class="charte-section">Palette</div>
    <div class="sw-grid">${swatches}</div>
  </div>`;
}

// --- Rendu d'un mockup (visuel de marque appliquant une charte) ----------
function hexLum(h) { const x = String(h).replace("#", ""); const [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) || 0); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
function readableOn(bg) { return hexLum(bg) > 0.6 ? "#181818" : "#ffffff"; }
function lightestHex(pal) { return pal && pal.length ? pal.slice().sort((a, b) => hexLum(b.hex) - hexLum(a.hex))[0].hex : "#f4f1ea"; }
function clampText(s, n) { return String(s || "").trim().replace(/\s+/g, " ").slice(0, n); }
function svgTextLines(s, maxChars, maxLines) {
  const words = clampText(s, maxChars * maxLines + 12).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) { lines.push(line); line = word; }
    else line = next;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.length && lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[,.!?;:]?$/, "") + "...";
  }
  return lines;
}
function svgMultiline(text, { x, y, maxChars, maxLines, lineHeight, family, size, weight = 400, fill, opacity = 1 }) {
  const lines = svgTextLines(text, maxChars, maxLines);
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" opacity="${opacity}">${lines.map((line, i) => `<tspan x="${x}" dy="${i ? lineHeight : 0}">${escapeHtml(line)}</tspan>`).join("")}</text>`;
}

// `imageUrl` (optionnel) : photo produit héritée d'un bloc image parent, intégrée au visuel.
function mockupSVG(m, imageUrl) {
  if (!m) return "";
  loadGoogleFont(m.fonts.heading); loadGoogleFont(m.fonts.body);
  const pal = m.palette || [];
  const role = (r) => (pal.find((p) => p.role === r) || {}).hex;
  const bg = role("background") || lightestHex(pal);
  const accent = role("primary") || (pal[0] && pal[0].hex) || "#ff6a3d";
  const secondary = role("secondary") || (pal[2] && pal[2].hex) || accent;
  const neutral = role("neutral") || (pal[1] && pal[1].hex) || "#1f2430";
  const ink = readableOn(bg);
  const fh = cssFamily(m.fonts.heading), fb = cssFamily(m.fonts.body);
  const c = m.copy || {};
  const hasImg = !!imageUrl;
  const n = Math.max(1, pal.length), w = 336 / n;
  const strip = pal.map((p, i) => `<rect x="${(32 + i * w).toFixed(1)}" y="720" width="${w.toFixed(1)}" height="14" fill="${p.hex}"/>`).join("");
  const cid = "mc" + Math.random().toString(36).slice(2, 7);
  const benefits = (Array.isArray(c.benefits) && c.benefits.length ? c.benefits : [c.footer || "Fraicheur immediate", "Format nomade"]).slice(0, 2);
  const title = svgMultiline(c.title || "", { x: 32, y: 126, maxChars: 19, maxLines: 2, lineHeight: 33, family: fh, size: 28, weight: 700, fill: ink });
  const subtitle = svgMultiline(c.subtitle || "", { x: 32, y: 214, maxChars: 34, maxLines: 2, lineHeight: 19, family: fb, size: 13, fill: ink, opacity: .82 });
  const bullets = benefits.map((b, i) => {
    const x = 32 + i * 168;
    return `<circle cx="${x + 4}" cy="646" r="4" fill="${i ? secondary : accent}"/>${svgMultiline(b, { x: x + 14, y: 650, maxChars: 20, maxLines: 2, lineHeight: 14, family: fb, size: 12, fill: ink, opacity: .86 })}`;
  }).join("");
  const img = hasImg ? `<clipPath id="${cid}"><rect x="32" y="314" width="336" height="226" rx="16"/></clipPath><rect x="32" y="314" width="336" height="226" rx="16" fill="rgba(255,255,255,.78)"/><image href="${escapeHtml(imageUrl)}" x="50" y="328" width="300" height="198" preserveAspectRatio="xMidYMid meet" clip-path="url(#${cid})"/>` : "";
  const ctaText = clampText(c.cta || "", 26);
  const cta = ctaText ? `<rect x="32" y="568" width="250" height="44" rx="22" fill="${accent}"/><text x="157" y="596" text-anchor="middle" font-family="${fb}" font-size="14" font-weight="700" fill="${readableOn(accent)}">${escapeHtml(ctaText)}</text>` : "";
  const footerText = clampText(c.footer || "", 42);
  const footer = footerText ? `<text x="368" y="690" text-anchor="end" font-family="${fb}" font-size="11" fill="${ink}" opacity=".62">${escapeHtml(footerText)}</text>` : "";
  return `<svg viewBox="0 0 400 760" xmlns="http://www.w3.org/2000/svg" class="mockup-svg" preserveAspectRatio="xMidYMid meet">
    <rect width="400" height="760" fill="${bg}"/>
    <rect x="0" y="0" width="400" height="12" fill="${accent}"/>
    <circle cx="346" cy="80" r="34" fill="${secondary}" opacity=".2"/>
    <rect x="32" y="40" width="126" height="27" rx="13.5" fill="${accent}" opacity=".14"/>
    <text x="48" y="58" font-family="${fb}" font-size="11" font-weight="700" fill="${accent}">${escapeHtml(c.eyebrow || "Edition urbaine")}</text>
    ${title}${subtitle}
    ${img}${cta}${footer}${bullets}
    <line x1="32" y1="704" x2="368" y2="704" stroke="${neutral}" stroke-opacity=".14"/>
    ${strip}
  </svg>`;
}

// Wordmark « 3D » : couches décalées (extrusion) dans une ombre + face en accent.
function text3dSVG(t) {
  if (!t) return "";
  loadGoogleFont(t.fonts.heading);
  const pal = t.palette || [];
  const role = (r) => (pal.find((p) => p.role === r) || {}).hex;
  const accent = role("primary") || (pal[0] && pal[0].hex) || "#ff6a3d";
  const shadow = role("neutral") || pal.slice().sort((a, b) => hexLum(a.hex) - hexLum(b.hex))[0]?.hex || "#222";
  const txt = escapeHtml(t.text || "");
  const W = Math.max(360, (t.text || "").length * 34), H = 170, cx = W / 2, cy = 104;
  const fh = cssFamily(t.fonts.heading);
  const depth = 9;
  let layers = "";
  for (let i = depth; i >= 1; i--) layers += `<text x="${cx + i * 1.6}" y="${cy + i * 1.6}" text-anchor="middle" font-family="${fh}" font-weight="700" font-size="78" fill="${shadow}">${txt}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="text3d-svg" preserveAspectRatio="xMidYMid meet">
    ${layers}
    <text x="${cx}" y="${cy}" text-anchor="middle" font-family="${fh}" font-weight="700" font-size="78" fill="${accent}" stroke="${shadow}" stroke-width="2">${txt}</text>
  </svg>`;
}

function creativeText(o) {
  return {
    id: eid(), type: "text", x: o.x, y: o.y, w: o.w, h: o.h, rotation: 0,
    html: o.html || "", fontSize: o.fontSize || 24, fontFamily: o.fontFamily || "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
    color: o.color || "#1d1d1f", align: o.align || "left", weight: o.weight || 400, lineHeight: o.lineHeight || 1.25,
    letterSpacing: o.letterSpacing || 0, bg: o.bg || "transparent", opacity: o.opacity ?? 1, padding: o.padding ?? 4,
  };
}

function creativeShape(o) {
  return {
    id: eid(), type: "shape", shape: o.shape || "rect", x: o.x, y: o.y, w: o.w, h: o.h, rotation: 0,
    fill: o.fill || "#0a84ff", stroke: o.stroke || "transparent", strokeWidth: o.strokeWidth || 0,
    radius: o.radius || 0, opacity: o.opacity ?? 1,
  };
}

function creativeImage(o) {
  return {
    id: eid(), type: "image", x: o.x, y: o.y, w: o.w, h: o.h, rotation: 0,
    src: o.src || "", sandboxPath: o.sandboxPath || "", fit: "contain", radius: o.radius || 18, opacity: 1, alt: o.alt || "",
  };
}

function staticCreativeHtml(title, doc, isDeck) {
  const shapeSvg = (el) => {
    const common = `fill="${el.fill}" stroke="${el.stroke || "transparent"}" stroke-width="${el.strokeWidth || 0}" opacity="${el.opacity ?? 1}"`;
    if (el.shape === "ellipse") return `<svg width="100%" height="100%" viewBox="0 0 ${el.w} ${el.h}"><ellipse cx="${el.w / 2}" cy="${el.h / 2}" rx="${el.w / 2}" ry="${el.h / 2}" ${common}/></svg>`;
    return `<svg width="100%" height="100%" viewBox="0 0 ${el.w} ${el.h}"><rect width="${el.w}" height="${el.h}" rx="${el.radius || 0}" ${common}/></svg>`;
  };
  const pages = doc.pages.map((page) => {
    const els = page.elements.map((el) => {
      const base = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;transform:rotate(${el.rotation || 0}deg);opacity:${el.opacity ?? 1};`;
      if (el.type === "text") return `<div style="${base}text-align:${el.align};font-size:${el.fontSize}px;font-family:${el.fontFamily};color:${el.color};font-weight:${el.weight};line-height:${el.lineHeight};letter-spacing:${el.letterSpacing || 0}px;${el.bg && el.bg !== "transparent" ? "background:" + el.bg + ";" : ""}">${el.html}</div>`;
      if (el.type === "image") return el.src ? `<img src="${el.src}" style="${base}object-fit:${el.fit};border-radius:${el.radius}px;">` : `<div style="${base}"></div>`;
      if (el.type === "shape") return `<div style="${base}">${shapeSvg(el)}</div>`;
      return "";
    }).join("\n");
    return `<div class="ce-static-page" style="width:${page.w}px;height:${page.h}px;background:${page.background};position:relative;overflow:hidden;margin:0 auto 28px;box-shadow:0 20px 60px rgba(0,0,0,.12);border-radius:${isDeck ? 18 : 6}px;">${els}</div>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f2f2f7;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif}</style></head><body>${pages}</body></html>`;
}

function creativeDocFromMockup(node, kind, imageUrl = "") {
  const m = node.mockup, c = m.copy || {}, pal = m.palette || DEFAULT_PALETTE;
  const role = (r) => (pal.find((p) => p.role === r) || {}).hex;
  const bg = role("background") || lightestHex(pal);
  const accent = role("primary") || pal[0]?.hex || "#ff6a3d";
  const secondary = role("secondary") || pal[2]?.hex || accent;
  const ink = readableOn(bg);
  const fonts = m.fonts || DEFAULT_FONTS;
  const fh = `'${String(fonts.heading || "Poppins").replace(/'/g, "")}', sans-serif`;
  const fb = `'${String(fonts.body || "Inter").replace(/'/g, "")}', sans-serif`;
  const imgNode = m.imageNodeId ? nodeById(m.imageNodeId) : null;
  const imgPath = imgNode?.image?.file ? `canevas/${project.slug}/${imgNode.image.file}` : "";
  const benefits = (Array.isArray(c.benefits) && c.benefits.length ? c.benefits : [c.footer || "Fraicheur immediate", "Format nomade"]).slice(0, 2);
  const title = c.title || node.prompt || "Visuel";

  if (kind === "presentation") {
    const page = { w: 1280, h: 720, background: bg, elements: [] };
    page.elements.push(
      creativeShape({ x: 0, y: 0, w: 1280, h: 18, fill: accent }),
      creativeShape({ x: 1030, y: 72, w: 140, h: 140, shape: "ellipse", fill: secondary, opacity: 0.2 }),
      creativeText({ x: 92, y: 74, w: 360, h: 34, html: escapeHtml(c.eyebrow || "Edition urbaine"), fontSize: 18, weight: 800, color: accent, fontFamily: fb }),
      creativeText({ x: 92, y: 138, w: 540, h: 190, html: escapeHtml(title), fontSize: 70, weight: 800, color: ink, fontFamily: fh, lineHeight: 1.02 }),
      creativeText({ x: 96, y: 346, w: 500, h: 86, html: escapeHtml(c.subtitle || ""), fontSize: 27, color: ink, fontFamily: fb, lineHeight: 1.28, opacity: 0.78 }),
      creativeShape({ x: 96, y: 494, w: 290, h: 58, fill: accent, radius: 29 }),
      creativeText({ x: 126, y: 508, w: 230, h: 35, html: escapeHtml(c.cta || "Decouvrir"), fontSize: 24, weight: 800, color: readableOn(accent), fontFamily: fb }),
      creativeText({ x: 96, y: 594, w: 520, h: 34, html: escapeHtml(benefits.join("   |   ")), fontSize: 18, color: ink, fontFamily: fb, opacity: 0.72 }),
    );
    if (imgPath || imageUrl) page.elements.push(creativeImage({ x: 680, y: 112, w: 458, h: 430, src: imageUrl, sandboxPath: imgPath, alt: title, radius: 24 }));
    pal.slice(0, 5).forEach((p, i) => page.elements.push(creativeShape({ x: 92 + i * 72, y: 648, w: 72, h: 18, fill: p.hex })));
    return { kind, title, doc: { kind, title, pages: [page] } };
  }

  const page = { w: 794, h: 1123, background: bg, elements: [] };
  page.elements.push(
    creativeShape({ x: 0, y: 0, w: 794, h: 18, fill: accent }),
    creativeText({ x: 84, y: 82, w: 300, h: 34, html: escapeHtml(c.eyebrow || "Edition urbaine"), fontSize: 17, weight: 800, color: accent, fontFamily: fb }),
    creativeText({ x: 84, y: 150, w: 560, h: 150, html: escapeHtml(title), fontSize: 58, weight: 800, color: ink, fontFamily: fh, lineHeight: 1.02 }),
    creativeText({ x: 88, y: 318, w: 520, h: 78, html: escapeHtml(c.subtitle || ""), fontSize: 24, color: ink, fontFamily: fb, lineHeight: 1.3, opacity: 0.78 }),
  );
  if (imgPath || imageUrl) page.elements.push(creativeImage({ x: 102, y: 435, w: 590, h: 330, src: imageUrl, sandboxPath: imgPath, alt: title, radius: 24 }));
  page.elements.push(
    creativeShape({ x: 102, y: 805, w: 280, h: 56, fill: accent, radius: 28 }),
    creativeText({ x: 132, y: 818, w: 220, h: 34, html: escapeHtml(c.cta || "Decouvrir"), fontSize: 23, weight: 800, color: readableOn(accent), fontFamily: fb }),
    creativeText({ x: 102, y: 904, w: 280, h: 52, html: escapeHtml(benefits[0] || ""), fontSize: 18, color: ink, fontFamily: fb, lineHeight: 1.3, opacity: 0.82 }),
    creativeText({ x: 414, y: 904, w: 280, h: 52, html: escapeHtml(benefits[1] || ""), fontSize: 18, color: ink, fontFamily: fb, lineHeight: 1.3, opacity: 0.82 }),
  );
  pal.slice(0, 5).forEach((p, i) => page.elements.push(creativeShape({ x: 102 + i * 92, y: 1018, w: 92, h: 18, fill: p.hex })));
  return { kind, title, doc: { kind, title, pages: [page] } };
}

const DEFAULT_PALETTE = [
  { name: "Encre", hex: "#1f2430", role: "neutral" }, { name: "Accent", hex: "#ff6a3d", role: "primary" },
  { name: "Doux", hex: "#ffb37a", role: "secondary" }, { name: "Crème", hex: "#f5f1e8", role: "background" },
];
const DEFAULT_FONTS = { heading: "Poppins", body: "Inter" };

// --- Visionneuse (modale d'agrandissement) -------------------------------
function openViewer(n) {
  const v = $("#viewer");
  $("#viewer-title").textContent = n.type === "charte" ? (n.charte?.name || "Charte") : (n.prompt || (n.type === "image" ? "Image" : "Texte"));
  const body = $("#viewer-body");
  if (n.type === "image") body.innerHTML = `<img class="viewer-img" src="${imgCache.get(n.id) || ""}" alt="">`;
  else if (n.type === "charte") body.innerHTML = charteFull(n.charte);
  else if (n.type === "mockup") body.innerHTML = `<div class="viewer-mockup">${mockupSVG(n.mockup, n.mockup && n.mockup.imageNodeId ? imgCache.get(n.mockup.imageNodeId) : null)}</div>`;
  else if (n.type === "text3d") body.innerHTML = `<div class="viewer-mockup">${text3dSVG(n.text3d)}</div>`;
  else if (n.type === "jingle") {
    body.innerHTML = `<div class="viewer-jingle"><div class="viewer-jingle-text">${mdToHtml(n.content || "")}</div>${jingleMusicCard(n)}${jingleControls()}</div>`;
    attachJingleControls(body, n);
  }
  else body.innerHTML = mdToHtml(n.content || "");
  v.hidden = false;
}
function closeViewer() { $("#viewer").hidden = true; }

// ---------------------------------------------------------------------------
//  Rendu
// ---------------------------------------------------------------------------
function applyView() {
  const v = view();
  const t = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  world.style.transform = t; links.style.transform = t;
}

function render() {
  world.innerHTML = "";
  for (const n of nodes()) world.appendChild(renderNode(n));
  measureNodes();
  renderLinks();
  $("#hint").hidden = nodes().length > 0;
  applyView();
}

// Mémorise la taille rendue de chaque carte (le texte a une hauteur variable) pour
// ancrer les liens — et la poignée de sortie — sur le vrai centre vertical.
function measureNodes() {
  for (const el of world.children) {
    nodeRects.set(el.dataset.id, { w: el.offsetWidth, h: el.offsetHeight });
  }
}

function renderNode(n) {
  const el = document.createElement("article");
  el.className = `node node-${n.type}${n.pending ? " is-pending" : ""}`;
  el.style.left = `${n.x}px`; el.style.top = `${n.y}px`;
  el.dataset.id = n.id;

  const hasContent = !!(n.content || n.charte || n.image || n.mockup || n.text3d);
  const isDraft = !n.pending && !hasContent; // créé mais pas encore généré
  if (isDraft) el.classList.add("is-draft");

  const KINDS = { image: "Image", charte: "Charte", mockup: "Visuel", jingle: "Jingle", vision: "Analyse" };
  const kind = KINDS[n.type] || "Texte";
  const badge = n.backend ? `<span class="badge badge-${n.backend}">${n.backend === "local" ? "local" : "cloud"}</span>`
    : isDraft ? `<span class="badge badge-draft">brouillon</span>` : "";
  const total = (n.history || []).length;
  const histNav = total > 1 ? `<span class="hist-nav"><button class="hist-prev" title="Version précédente">‹</button><span class="hist-pos">${(n.histIndex ?? 0) + 1}/${total}</span><button class="hist-next" title="Version suivante">›</button></span>` : "";
  const infoBtn = (!n.pending && n.prompt) ? `<button class="node-info" title="Voir le prompt" aria-label="Voir le prompt">i</button>` : "";
  const regenBtn = (!n.pending && hasContent && n.prompt) ? `<button class="node-regen" title="Régénérer (nouvelle version)" aria-label="Régénérer">↻</button>` : "";
  const expandBtn = (!n.pending && hasContent) ? `<button class="node-expand" title="Agrandir" aria-label="Agrandir">⤢</button>` : "";
  const exportBtns = (!n.pending && n.type === "mockup" && n.mockup) ? `<span class="mockup-export"><button class="node-export" data-export="document" title="Exporter vers Lumen Page">Page</button><button class="node-export" data-export="presentation" title="Exporter vers Lumen Présentation">Deck</button></span>` : "";
  const delBtn = !n.pending ? `<button class="node-del" title="Supprimer le bloc" aria-label="Supprimer">✕</button>` : "";
  const head = `<div class="node-head"><span class="node-kind">${kind}</span>${badge}<span class="node-actions">${histNav}${exportBtns}${infoBtn}${regenBtn}${expandBtn}${delBtn}</span></div>`;

  let body;
  if (n.pending) body = `<div class="node-body skeleton"><span class="spin"></span></div>`;
  else if (isDraft) body = `<div class="node-body draft"><p class="draft-prompt">${escapeHtml(n.prompt || "")}</p><button class="draft-go">Générer</button><span class="draft-hint">Relie d'autres blocs avant de générer.</span></div>`;
  else if (n.type === "image") {
    const url = imgCache.get(n.id) || "";
    body = `<div class="node-body"><img src="${url}" alt="" draggable="false"/></div>`;
  } else if (n.type === "charte") body = `<div class="node-body">${chartePreview(n.charte)}</div>`;
  else if (n.type === "mockup") body = `<div class="node-body mockup-body">${mockupSVG(n.mockup, n.mockup && n.mockup.imageNodeId ? imgCache.get(n.mockup.imageNodeId) : null)}</div>`;
  else if (n.type === "text3d") body = `<div class="node-body text3d-body">${text3dSVG(n.text3d)}</div>`;
  else if (n.type === "jingle") body = `<div class="node-body node-text jingle-body"><div class="jingle-scroll">${mdToHtml(n.content || "")}${jingleMusicCard(n)}</div>${jingleControls()}</div>`;
  else body = `<div class="node-body node-text">${mdToHtml(n.content || "")}</div>`;

  const foot = (!isDraft && n.prompt) ? `<div class="node-foot" title="${escapeHtml(n.prompt)}">${escapeHtml(n.prompt)}</div>` : "";
  // Pastille d'entrée (gauche, visuelle, cible de dépôt) + pastille de sortie (droite).
  const inHandle = `<span class="in-handle" aria-hidden="true"></span>`;
  el.innerHTML = head + body + foot + inHandle + `<button class="out-handle" title="Tirer pour générer une suite" aria-label="Générer une suite"></button>`;

  el.addEventListener("pointerdown", (e) => { if (e.target.closest(".out-handle") || e.target.closest("button")) return; startNodeDrag(e, n, el); });
  el.querySelector(".out-handle").addEventListener("pointerdown", (e) => startLinkDrag(e, n));
  const ex = el.querySelector(".node-expand");
  if (ex) ex.addEventListener("click", (e) => { e.stopPropagation(); openViewer(n); });
  const info = el.querySelector(".node-info");
  if (info) info.addEventListener("click", (e) => { e.stopPropagation(); modal({ title: "Prompt utilisé", message: n.prompt, ok: "Fermer", noCancel: true, copyText: n.prompt }); });
  const regen = el.querySelector(".node-regen");
  if (regen) regen.addEventListener("click", (e) => { e.stopPropagation(); regenerate(n); });
  const go = el.querySelector(".draft-go");
  if (go) go.addEventListener("click", (e) => { e.stopPropagation(); regenerate(n); });
  const prev = el.querySelector(".hist-prev");
  if (prev) prev.addEventListener("click", (e) => { e.stopPropagation(); setHistIndex(n, (n.histIndex ?? 0) - 1); });
  const next = el.querySelector(".hist-next");
  if (next) next.addEventListener("click", (e) => { e.stopPropagation(); setHistIndex(n, (n.histIndex ?? 0) + 1); });
  const del = el.querySelector(".node-del");
  if (del) del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (await askConfirm("Supprimer le bloc", "Ce bloc et ses liens seront supprimés. Action irréversible.", "Supprimer")) removeNode(n.id);
  });
  el.querySelectorAll(".node-export").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    exportMockup(n, b.dataset.export);
  }));
  attachJingleControls(el, n);
  return el;
}

function attachJingleControls(root, n) {
  const play = root.querySelector(".jingle-play");
  if (play) play.addEventListener("click", (e) => { e.stopPropagation(); speakJingleAuto(n); });
  const sound = root.querySelector(".jingle-sound");
  if (sound) sound.addEventListener("change", (e) => {
    e.stopPropagation();
    n.music = normalizeMusicSpec({ ...(n.music || {}), synth: { ...(n.music?.synth || {}), osc: sound.value } }, n.prompt);
    const cur = n.history?.[n.histIndex ?? n.history.length - 1];
    if (cur) cur.music = n.music;
    queueSave();
    render();
  });
  const music = root.querySelector(".jingle-music");
  if (music) music.addEventListener("click", (e) => { e.stopPropagation(); playJingleMusic(n); });
  const mix = root.querySelector(".jingle-voice-mix");
  if (mix) mix.addEventListener("click", (e) => { e.stopPropagation(); playJingleMix(n); });
  const stop = root.querySelector(".jingle-stop");
  if (stop) stop.addEventListener("click", (e) => { e.stopPropagation(); stopJingle(); });
  const mac = root.querySelector(".jingle-mac");
  if (mac) mac.addEventListener("click", (e) => { e.stopPropagation(); speakJingleMac(n); });
  const wav = root.querySelector(".jingle-wav");
  if (wav) wav.addEventListener("click", (e) => { e.stopPropagation(); exportJingleWav(n); });
}

function jingleControls() {
  const macOnly = isMacPlatform() ? "" : " hidden";
  return `<div class="jingle-actions">
    <button class="jingle-play">▶ Écouter</button>
    <button class="jingle-music">Musique</button>
    <button class="jingle-voice-mix">Voix + son</button>
    <button class="jingle-stop">Stop</button>
    <button class="jingle-mac"${macOnly}>Mac</button>
    <button class="jingle-wav">WAV</button>
  </div>`;
}

function jingleMusicCard(node) {
  const m = normalizeMusicSpec(node.music || {}, node.prompt);
  node.music = m;
  const dur = m.durationSec ? ` · ~${m.durationSec.toFixed(1)}s` : "";
  return `<div class="music-card">
    <div class="music-head"><span>Text-to-Music</span><strong>${m.tempo} BPM · ${escapeHtml(m.key)} ${escapeHtml(m.scale)}${dur}</strong></div>
    <p class="music-prompt">${escapeHtml(m.musicPrompt || m.synthPrompt)}</p>
    ${m.instruments && m.instruments.length ? `<p class="music-instruments">🎹 ${m.instruments.map((i) => escapeHtml(i)).join(" · ")}</p>` : ""}
    <div class="music-row">
      <label>Osc
        <select class="jingle-sound">
          <option value="square"${m.synth.osc === "square" ? " selected" : ""}>Square</option>
          <option value="sawtooth"${m.synth.osc === "sawtooth" ? " selected" : ""}>Saw</option>
          <option value="triangle"${m.synth.osc === "triangle" ? " selected" : ""}>Triangle</option>
          <option value="sine"${m.synth.osc === "sine" ? " selected" : ""}>Sine</option>
        </select>
      </label>
      <span>${m.melody.length} notes · ${m.bass.length} basses · ${m.chords.length} accords</span>
    </div>
  </div>`;
}

function rectOf(n) { return nodeRects.get(n.id) || { w: NODE_W, h: NODE_H }; }
function anchorOut(n) { const r = rectOf(n); return { x: n.x + r.w, y: n.y + r.h / 2 }; }
function anchorIn(n) { const r = rectOf(n); return { x: n.x, y: n.y + r.h / 2 }; }

function renderLinks(extra) {
  // Un segment par lien (visible) + un tracé « hit » épais transparent au-dessus,
  // cliquable pour supprimer le lien.
  let html = "";
  for (const n of nodes()) {
    for (const pid of n.parentIds || []) {
      const p = nodeById(pid);
      if (!p) continue;
      const d = bezier(anchorOut(p), anchorIn(n));
      html += `<path class="link" d="${d}"/><path class="link-hit" d="${d}" data-child="${n.id}" data-parent="${pid}"><title>Cliquer pour supprimer le lien</title></path>`;
    }
  }
  if (extra) html += `<path class="link link-live" d="${bezier(extra.from, extra.to)}"/>`;
  links.innerHTML = html;
}

// Supprime un bloc et tous les liens qui le référencent.
function removeNode(id) {
  project.nodes = nodes().filter((n) => n.id !== id);
  for (const n of nodes()) if (n.parentIds) n.parentIds = n.parentIds.filter((p) => p !== id);
  for (const n of nodes()) if (n.mockup?.imageNodeId === id) n.mockup.imageNodeId = null;
  imgCache.delete(id);
  queueSave(); render();
  toast("Bloc supprimé.");
}

// Lit un jingle à voix haute via la TTS du système (Piper/Kokoro).
async function speakJingle(node) {
  if (!invoke) { toast("Lecture audio dispo uniquement dans l'app Lumen."); return; }
  const text = node.content || "";
  if (!text.trim()) return;
  try { await invoke("tts_speak", { text, voice: null }); }
  catch (e) { toast("Voix : " + ((e && e.message) || e) + " (installe une voix dans les Réglages)", 4500); }
}

async function speakJingleAuto(node) {
  if (isMacPlatform()) return speakJingleMac(node);
  return speakJingle(node);
}

async function playJingleMusic(node) {
  try {
    const r = await playMusic(node.music || {}, { voiceDelay: 0 });
    toast(r.usedMagenta ? "Musique lue via Magenta.js." : "Musique lue via WebAudio.");
  } catch (e) {
    toast("Musique : " + ((e && e.message) || e), 4500);
  }
}

// Énonce le jingle et RÉSOUT à la fin réelle de l'audio (event « tts-ended »
// émis par le backend), pour pouvoir arrêter la musique pile quand la voix se tait.
async function speakJingleAwait(node) {
  const text = (node.content || "").trim();
  if (!invoke || !text) return;
  const cmd = isMacPlatform() ? "tts_speak_macos" : "tts_speak";
  const evt = __TAURI.event;
  let un = null, resolveEnded;
  const ended = new Promise((r) => { resolveEnded = r; });
  // Écoute attachée AVANT l'invoke (une synthèse rapide pourrait finir avant).
  if (evt?.listen) un = await evt.listen("tts-ended", () => resolveEnded());
  else resolveEnded();
  try {
    await invoke(cmd, { text, voice: null });
    // Garde-fou : ne jamais boucler indéfiniment si l'event se perd.
    await Promise.race([ended, new Promise((r) => setTimeout(r, 180000))]);
  } finally { if (un) un(); }
}

// Stop global du bloc jingle : coupe la musique ET la voix en cours.
function stopJingle() {
  stopMusic();
  if (invoke) invoke("tts_stop").catch(() => {});
}

async function playJingleMix(node) {
  try {
    // Musique en BOUCLE : elle tourne tant qu'on ne l'arrête pas.
    await playMusic(node.music || {}, { voiceDelay: 0, loop: true });
    await new Promise((r) => setTimeout(r, 350)); // courte intro avant la voix
    toast("Voix sur la musique (boucle jusqu'à la fin de l'énonciation).");
    await speakJingleAwait(node); // résout quand la voix se tait
  } catch (e) {
    toast("Mix jingle : " + ((e && e.message) || e), 4500);
  } finally {
    stopMusic(); // la musique s'arrête pile à la fin de la voix
  }
}

async function speakJingleMac(node) {
  if (!invoke) { toast("Lecture macOS dispo uniquement dans l'app Lumen."); return; }
  const text = node.content || "";
  if (!text.trim()) return;
  try { await invoke("tts_speak_macos", { text, voice: null }); }
  catch (e) { toast("Voix macOS : " + ((e && e.message) || e), 4500); }
}

async function exportJingleWav(node) {
  if (!invoke) { toast("Export WAV disponible uniquement dans l'app Lumen."); return; }
  const text = node.content || "";
  if (!text.trim()) return;
  try {
    const sid = await store.ensureSandbox();
    const name = safeName(node.prompt || "jingle").toLowerCase() || "jingle";
    const path = `canevas/${project.slug}/jingles/${name}-${node.id}.wav`;
    const out = await invoke("tts_export_wav", { text, voice: null, sandboxId: sid, path });
    toast(`WAV créé : ${out}`, 4500);
  } catch (e) {
    toast("Export WAV : " + ((e && e.message) || e), 5000);
  }
}

async function exportMockup(node, kind) {
  if (!node?.mockup || !project) return;
  try {
    const imageUrl = node.mockup.imageNodeId ? imgCache.get(node.mockup.imageNodeId) || "" : "";
    const built = creativeDocFromMockup(node, kind === "presentation" ? "presentation" : "document", imageUrl);
    const ext = built.kind === "presentation" ? "lumenkey" : "lumenpages";
    const file = `${safeName(built.title)}_${built.kind === "presentation" ? "presentation" : "page"}.${ext}`;
    const docForSave = JSON.parse(JSON.stringify(built.doc));
    for (const page of docForSave.pages) for (const el of page.elements) if (el.type === "image" && el.sandboxPath) delete el.src;
    const html = staticCreativeHtml(built.title, built.doc, built.kind === "presentation");
    await store.writeFile(`canevas/${project.slug}/exports/${file}`, JSON.stringify({ kind: built.kind, title: built.title, doc: docForSave, html, updatedAt: Date.now() }, null, 2));
    toast(`Export ${built.kind === "presentation" ? "Présentation" : "Page"} créé : exports/${file}`, 4500);
  } catch (e) {
    toast("Export : " + ((e && e.message) || e), 4500);
  }
}

// Supprime un lien (retire `parentId` des entrées de l'enfant).
function removeLink(childId, parentId) {
  const c = nodeById(childId);
  if (!c) return;
  c.parentIds = (c.parentIds || []).filter((x) => x !== parentId);
  queueSave(); render();
  toast("Lien supprimé.");
}

function bezier(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y} `;
}

// ---------------------------------------------------------------------------
//  Déplacement de node
// ---------------------------------------------------------------------------
function startNodeDrag(e, n, el) {
  e.preventDefault();
  const start = toWorld(e.clientX, e.clientY);
  const ox = start.x - n.x, oy = start.y - n.y;
  const move = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY);
    n.x = Math.round(w.x - ox); n.y = Math.round(w.y - oy);
    el.style.left = `${n.x}px`; el.style.top = `${n.y}px`;
    renderLinks();
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); queueSave(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------------------
//  Tirage du lien → boîte de prompt
// ---------------------------------------------------------------------------
function startLinkDrag(e, parent) {
  e.preventDefault(); e.stopPropagation();
  const from = anchorOut(parent);
  let hover = null; // bloc cible actuellement survolé (pour la surbrillance)
  const setHover = (el) => {
    if (el === hover) return;
    if (hover) hover.classList.remove("drop-target");
    hover = el; if (hover) hover.classList.add("drop-target");
  };
  // Cible reliable sous le curseur (bloc différent, sans créer de cycle).
  const targetUnder = (cx, cy) => {
    const el = document.elementFromPoint(cx, cy)?.closest?.(".node");
    if (!el || el.dataset.id === parent.id) return null;
    if (isAncestor(el.dataset.id, parent)) return null; // relier ferait un cycle
    return el;
  };
  const move = (ev) => {
    renderLinks({ from, to: toWorld(ev.clientX, ev.clientY) });
    setHover(targetUnder(ev.clientX, ev.clientY));
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    setHover(null);
    renderLinks();
    // Déposé SUR un bloc existant → on l'ajoute comme parent (fusion d'infos).
    const overEl = targetUnder(ev.clientX, ev.clientY);
    if (overEl) {
      addParent(nodeById(overEl.dataset.id), parent.id);
      return;
    }
    // Déposé dans le vide → boîte de prompt pour créer un bloc enfant.
    const w = toWorld(ev.clientX, ev.clientY);
    openPrompt({ parentId: parent.id, x: Math.round(w.x), y: Math.round(w.y) }, ev.clientX, ev.clientY);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------------------
//  Boîte de prompt
// ---------------------------------------------------------------------------
function openPrompt(p, screenX, screenY) {
  pending = p;
  const pop = $("#prompt-pop");
  pop.hidden = false;
  pop.style.left = "12px";
  pop.style.top = "12px";
  const pw = pop.offsetWidth || 360;
  const ph = pop.offsetHeight || 240;
  pop.style.left = `${Math.min(Math.max(12, screenX), Math.max(12, window.innerWidth - pw - 12))}px`;
  pop.style.top = `${Math.min(Math.max(12, screenY), Math.max(12, window.innerHeight - ph - 12))}px`;
  $("#pp-ctx").hidden = !p.parentId;
  $("#pp-input").value = "";
  $("#pp-input").focus();
}
function closePrompt() { $("#prompt-pop").hidden = true; pending = null; }

function clampPromptPop() {
  const pop = $("#prompt-pop");
  if (pop.hidden) return;
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - r.width - 12))}px`;
  pop.style.top = `${Math.min(Math.max(12, r.top), Math.max(12, window.innerHeight - r.height - 12))}px`;
}

// Construit un node depuis l'état `pending` (commun à génération et brouillon).
function nodeFromPending(p, prompt, pending = false) {
  return {
    id: nid(), parentIds: p.parentId ? [p.parentId] : [], type: popType,
    prompt, content: "", image: null, charte: null, backend: null,
    x: p.x, y: p.y - NODE_H / 2, pending,
  };
}

// Crée le bloc SANS générer : on peut y relier d'autres blocs, puis « Générer ».
function createDraft() {
  if (!pending || !project) return;
  const prompt = $("#pp-input").value.trim();
  if (!prompt && popType !== "vision") { toast("Saisis une consigne."); return; }
  const p = pending; closePrompt();
  nodes().push(nodeFromPending(p, prompt || "Analyser l'image", false));
  render(); queueSave();
}

async function runGeneration() {
  if (!pending || !project) return;
  const prompt = $("#pp-input").value.trim();
  if (!prompt && popType !== "vision") { toast("Saisis une consigne."); return; }
  const p = pending;
  closePrompt();

  const node = nodeFromPending(p, prompt || "Analyser l'image", true);
  nodes().push(node);
  render();
  try {
    await produce(node);
    render(); queueSave(); refreshStatus();
  } catch (e) {
    project.nodes = nodes().filter((x) => x.id !== node.id); // génération initiale ratée → on retire le bloc
    render();
    toast((e && e.message) || String(e), 4500);
  }
}

// Applique une entrée d'historique comme état COURANT du node (ses champs
// content/charte/image/backend reflètent toujours la version sélectionnée, qui
// sert de contexte aux blocs enfants).
function applyHistEntry(node, e) {
  node.content = e.content || "";
  node.charte = e.charte || null;
  node.image = e.image || null;
  node.mockup = e.mockup || null;
  node.text3d = e.text3d || null;
  node.music = e.music || null;
  node.backend = e.backend || null;
}

// Charte la plus proche dans la filiation (pour les visuels dérivés).
function ancestorCharte(node) { return collectAncestors(node).find((a) => a.type === "charte" && a.charte)?.charte || null; }

// Cœur de génération partagé (création / régénération / brouillon). Fusionne le
// contexte de TOUS les parents, puis EMPILE le résultat dans l'historique du node.
async function produce(node) {
  const ancestors = collectAncestors(node);
  const context = contextFromNodes(ancestors);
  const v = (node.history || []).length; // version (index) de cette génération
  let entry;
  if (node.type === "text") {
    const { content, backend } = await generateText(node.prompt, context);
    entry = { content, backend, at: Date.now() };
  } else if (node.type === "charte") {
    const { charte, backend } = await generateCharte(node.prompt, context);
    try { await fonts.ensureProjectFonts(project, [charte.fonts.heading, charte.fonts.body]); } catch {}
    entry = { charte, backend, at: Date.now() };
  } else if (node.type === "mockup") {
    // Charte parente (sinon défauts) pour palette + typo ; image parente intégrée si présente.
    const ch = ancestorCharte(node);
    const palette = ch ? ch.palette : DEFAULT_PALETTE;
    const fts = ch ? ch.fonts : DEFAULT_FONTS;
    const imgAnc = ancestors.find((a) => a.type === "image" && a.image);
    const { copy, backend } = await generateMockup(node.prompt, context);
    try { await fonts.ensureProjectFonts(project, [fts.heading, fts.body]); } catch {}
    if (imgAnc && !imgCache.has(imgAnc.id)) {
      try { imgCache.set(imgAnc.id, await store.readImage(project.slug, imgAnc.id, imgAnc.image.file)); } catch {}
    }
    entry = { mockup: { template: "keyvisual", copy, palette, fonts: fts, imageNodeId: imgAnc ? imgAnc.id : null }, backend, at: Date.now() };
  } else if (node.type === "jingle") {
    const { content, backend } = await generateJingle(node.prompt, context);
    let music = null;
    // Cale la musique sur la durée approximative de la voix off du jingle.
    const durationSec = estimateJingleSeconds(content);
    try { music = (await generateMusicSpec(node.prompt, content, context, { durationSec })).music; } catch {}
    entry = { content, music, backend, at: Date.now() };
  } else if (node.type === "vision") {
    const imgAnc = ancestors.find((a) => a.type === "image" && a.image);
    if (!imgAnc) throw new Error("Relie un bloc image à analyser.");
    const b64 = await store.imageB64(project.slug, imgAnc.id, imgAnc.image.file);
    const { content, backend } = await generateVision(node.prompt, b64, context);
    entry = { content, backend, at: Date.now() };
  } else {
    const sid = await store.ensureSandbox();
    const size = canvasImageSize();
    const res = await generateImage({ prompt: node.prompt, context, width: size.width, height: size.height, steps: 4, sandboxId: sid, path: store.imageFullPath(project.slug, node.id, v) });
    entry = { image: { file: store.imageRel(node.id, v), width: size.width, height: size.height }, backend: res.backend, at: Date.now() };
    imgCache.set(node.id, res.url);
  }
  node.history = node.history || [];
  node.history.push(entry);
  node.histIndex = node.history.length - 1;
  applyHistEntry(node, entry);
  node.pending = false;
}

// Sélectionne une version de l'historique (devient la version retenue/courante).
async function setHistIndex(node, i) {
  if (!node.history || i < 0 || i >= node.history.length || i === node.histIndex) return;
  node.histIndex = i;
  const e = node.history[i];
  applyHistEntry(node, e);
  if (node.type === "image" && e.image) {
    try { imgCache.set(node.id, await store.readImage(project.slug, node.id, e.image.file)); } catch {}
  }
  render(); queueSave();
}

// Régénère un bloc existant (nouveau contenu, le LLM/diffusion variant à chaque fois).
async function regenerate(node) {
  if (!node || node.pending) return;
  node.pending = true; render();
  try {
    await produce(node);
    render(); queueSave(); refreshStatus();
  } catch (e) {
    node.pending = false; render();
    toast((e && e.message) || String(e), 4500);
  }
}

// ---------------------------------------------------------------------------
//  Pan & zoom
// ---------------------------------------------------------------------------
function setupPanZoom() {
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".node") || e.target.closest(".prompt-pop") || e.target.closest(".link-hit")) return;
    const v = view();
    const sx = e.clientX, sy = e.clientY, ox = v.x, oy = v.y;
    const move = (ev) => { v.x = ox + (ev.clientX - sx); v.y = oy + (ev.clientY - sy); applyView(); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); queueSave(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const v = view();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const ns = Math.min(2.5, Math.max(0.3, v.scale * factor));
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    v.x = mx - (mx - v.x) * (ns / v.scale);
    v.y = my - (my - v.y) * (ns / v.scale);
    v.scale = ns; applyView(); queueSave();
  }, { passive: false });
  stage.addEventListener("dblclick", (e) => {
    if (e.target.closest(".node")) return;
    const w = toWorld(e.clientX, e.clientY);
    openPrompt({ parentId: null, x: Math.round(w.x), y: Math.round(w.y) }, e.clientX, e.clientY);
  });
}

// ---------------------------------------------------------------------------
//  Statut des backends
// ---------------------------------------------------------------------------
function refreshStatus() { return refreshBackendStatus($("#status-text")); }
function setupBackendSwitches() { mountBackendSwitches(document, { invoke }); }

// ---------------------------------------------------------------------------
//  Gestion des projets
// ---------------------------------------------------------------------------
// Peuple le sélecteur de sandbox et garantit qu'une sandbox est choisie.
async function refreshSandboxList() {
  const sel = $("#sandbox-select");
  const list = await store.listSandboxes();
  sel.innerHTML = "";
  for (const s of list) sel.appendChild(new Option(s.name, s.id));
  const id = await store.ensureSandbox(); // crée « Canevas » si rien n'est choisi
  if (!list.some((s) => s.id === id)) { sel.appendChild(new Option("Canevas", id)); }
  sel.value = id;
}

async function refreshProjectList(selectSlug) {
  const sel = $("#project-select");
  let list = [];
  try { list = await store.listProjects({ kind: "canvas" }); } catch {}
  sel.innerHTML = "";
  for (const p of list) sel.appendChild(new Option(p.title, p.slug));
  if (selectSlug) sel.value = selectSlug;
  return list;
}

// Recharge les images du projet courant (data URL) puis re-rend.
async function hydrateImages() {
  const wanted = new Set(nodes().filter((n) => n.type === "image" && n.image).map((n) => n.id));
  for (const n of nodes()) if (n.mockup?.imageNodeId) wanted.add(n.mockup.imageNodeId);
  const jobs = nodes().filter((n) => wanted.has(n.id) && n.type === "image" && n.image && !imgCache.has(n.id))
    .map(async (n) => { try { imgCache.set(n.id, await store.readImage(project.slug, n.id, n.image.file)); } catch {} });
  if (jobs.length) { await Promise.all(jobs); render(); }
}

async function openProject(slug) {
  imgCache.clear();
  project = await store.loadProject(slug);
  // Compat : ancien schéma → parentIds tableau + historique à partir de l'état courant.
  for (const n of project.nodes) {
    if (!Array.isArray(n.parentIds)) n.parentIds = n.parentId ? [n.parentId] : [];
    delete n.parentId;
    if (!Array.isArray(n.history)) {
      const hasContent = n.content || n.charte || n.image || n.mockup || n.text3d;
      n.history = hasContent ? [{
        content: n.content || "",
        charte: n.charte || null,
        image: n.image || null,
        mockup: n.mockup || null,
        text3d: n.text3d || null,
        backend: n.backend || null,
        at: n.at || Date.now(),
      }] : [];
      n.histIndex = n.history.length ? 0 : undefined;
    } else if (n.history.length) {
      const i = Math.min(Math.max(n.histIndex ?? n.history.length - 1, 0), n.history.length - 1);
      n.histIndex = i;
      applyHistEntry(n, n.history[i]);
    }
  }
  $("#project-select").value = slug;
  render();
  hydrateImages();
  // Ré-injecte les polices enregistrées (hors-ligne), puis re-rend pour les appliquer.
  fonts.injectProjectFonts(project).then(() => render()).catch(() => {});
}

async function newProject() {
  const title = await askText("Nouveau projet", "Sans titre", "Créer");
  if (title === null) return;
  const p = await store.createProject(title || "Sans titre");
  await store.saveProject(p);
  await refreshProjectList(p.slug);
  imgCache.clear(); project = p; render();
}

// ---------------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------------
function setupPrompt() {
  const pop = $("#prompt-pop");
  pop.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, textarea, input, select")) return;
    e.preventDefault();
    const r = pop.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top;
    const move = (ev) => {
      const w = pop.offsetWidth || r.width, h = pop.offsetHeight || r.height;
      pop.style.left = `${Math.min(Math.max(12, ox + ev.clientX - sx), Math.max(12, window.innerWidth - w - 12))}px`;
      pop.style.top = `${Math.min(Math.max(12, oy + ev.clientY - sy), Math.max(12, window.innerHeight - h - 12))}px`;
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  pop.querySelectorAll(".pp-type").forEach((b) => {
    b.addEventListener("click", () => {
      popType = b.dataset.type;
      $("#prompt-pop").querySelectorAll(".pp-type").forEach((x) => x.classList.toggle("active", x === b));
      const PH = {
        image: "Décris l'image à générer…",
        charte: "Décris l'ambiance / la marque (ex. « soda fruité, coucher de soleil »)…",
        mockup: "Brief du visuel (relie une charte + une image pour les intégrer)…",
        jingle: "Sujet du jingle (relie une charte/un brief pour le ton)…",
        vision: "Que veux-tu extraire ? (relie une image) — vide = description + direction artistique",
        text: "Que veux-tu écrire/explorer ?",
      };
      $("#pp-input").placeholder = PH[popType] || PH.text;
      requestAnimationFrame(clampPromptPop);
    });
  });
  $("#pp-go").addEventListener("click", runGeneration);
  $("#pp-draft").addEventListener("click", createDraft);
  $("#pp-cancel").addEventListener("click", closePrompt);
  $("#pp-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runGeneration();
    if (e.key === "Escape") closePrompt();
  });
}

async function init() {
  setupPanZoom();
  setupPrompt();
  setupBackendSwitches();
  if (invoke) { try { platformFlavor = await invoke("platform_flavor"); } catch {} }

  $("#sandbox-select").addEventListener("change", async (e) => {
    store.setSandbox(e.target.value);
    imgCache.clear();
    const list = await refreshProjectList();
    if (list[0]) await openProject(list[0].slug);
    else { project = await store.createProject("Mon premier canevas"); await refreshProjectList(project.slug); render(); }
  });
  links.addEventListener("click", (e) => { const h = e.target.closest?.(".link-hit"); if (h) removeLink(h.dataset.child, h.dataset.parent); });
  $("#viewer-close").addEventListener("click", closeViewer);
  $("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer") closeViewer(); });
  $("#project-select").addEventListener("change", (e) => openProject(e.target.value));
  $("#btn-new-project").addEventListener("click", newProject);
  $("#btn-rename").addEventListener("click", async () => {
    if (!project) return;
    const t = await askText("Renommer le projet", project.title, "Renommer");
    if (!t) return;
    await store.renameProject(project, t);
    refreshProjectList(project.slug);
  });
  // Espace Création : projets, versions et exports communs aux éditeurs.
  mountCreativeBar($("#creative-bar"), {
    app: "canvas",
    current: () => (project ? { ref: project.slug, title: project.title || "Canevas" } : null),
    serialize: () => JSON.stringify(project),
    restore: (content) => {
      const next = JSON.parse(content);
      if (!next || !Array.isArray(next.nodes)) return;
      project = { ...next, slug: project.slug };
      queueSave();
      render();
    },
    exportDoc: () => ({
      title: project?.title || "Canevas",
      // Les blocs dans l'ordre de création : texte tel quel, le reste par son prompt.
      markdown: (project?.nodes || []).map((n) => {
        const head = `## ${n.type === "text" ? "Texte" : n.type === "image" ? "Image" : n.type === "charte" ? "Charte" : n.type || "Bloc"}`;
        const body = n.content ? n.content : n.charte ? `${n.charte.name || ""}\n${(n.charte.palette || []).map((c) => `- ${c}`).join("\n")}` : "";
        return [head, n.prompt && `*${n.prompt}*`, body].filter(Boolean).join("\n\n");
      }).join("\n\n"),
      json: project,
    }),
    formats: ["md", "html", "pdf", "json"],
    toast,
  });
  $("#btn-delete").addEventListener("click", async () => {
    if (!project) return;
    const ok = await askConfirm("Supprimer le projet", `« ${project.title} » et tout son dossier (images, polices) seront supprimés. Cette action est irréversible.`, "Supprimer");
    if (!ok) return;
    await store.deleteProject(project.slug);
    const list = await refreshProjectList();
    if (list[0]) openProject(list[0].slug); else newProject();
  });
  $("#btn-seed").addEventListener("click", () => {
    const r = stage.getBoundingClientRect();
    const v = view();
    openPrompt({ parentId: null, x: Math.round((r.width / 2 - v.x) / v.scale), y: Math.round((r.height / 2 - v.y) / v.scale) },
      r.left + r.width / 2, r.top + r.height / 2);
  });
  window.addEventListener("storage", (e) => {
    if (!e) return;
    if (["aiSource", "imageProvider", "canvasTextBackend", "canvasImageBackend"].includes(e.key)) {
      resetProbes();
      refreshStatus();
    }
  });

  refreshStatus();
  if (!store.hasBackend()) { $("#hint-sub").textContent = "Disponible uniquement dans l'app Lumen (stockage sandbox)."; return; }
  try {
    await refreshSandboxList();
    const list = await refreshProjectList();
    if (list[0]) await openProject(list[0].slug);
    else { project = await store.createProject("Mon premier canevas"); await store.saveProject(project); await refreshProjectList(project.slug); render(); }
  } catch (e) { toast("Initialisation : " + (e.message || e), 5000); }
}

window.__canvasInject = (p) => { project = p; render(); };
window.__rmNode = (id) => removeNode(id);
init();

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });

// Les liens sortants (fiches, docs des connecteurs, markdown) ouvrent le
// navigateur du système : `target="_blank"` est inerte dans la WebView.
delegateExternalLinks(document);
