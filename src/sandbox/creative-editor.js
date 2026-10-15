import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { imageGenerationConfig, imageErrorMessage, imageProviderLabel } from "../lib/image-provider.js";
// Éditeur créatif par objets — moteur d'édition visuelle pour
// les apps Documents (.lumenpages) et Présentations (.lumenkey) de la sandbox.
//
// Modèle d'objets : un document = une liste de pages, chaque page contient des
// éléments positionnés librement (texte, image, forme). Chaque élément est
// sélectionnable, déplaçable, redimensionnable, pivotable, ordonnable en calques
// et éditable manuellement (inspecteur) ou par l'IA (Ollama, diff ou direct).
//
// Découplé de desktop.js par injection de dépendances (setCreativeContext) pour
// rester isolé et ne pas déstabiliser le shell bureau. La (dé)sérialisation reste
// rétro-compatible avec l'ancien format { kind, title, html } : à l'ouverture on
// importe le HTML legacy en éléments, et à l'enregistrement on réécrit `html`
// (rendu statique) en plus du modèle `doc` riche.

const { invoke } = window.__TAURI__.core;
import { escapeHtml, fileExt } from "./render.js";
import { applyDiff, countChanges, diffLines } from "./diff.js";
import { tt } from "../apps-i18n.js";
import { recordImageGeneration, recordOllamaUsage } from "../ollama-usage.js";
import { llmChat } from "../llm.js";
import { PROMPTS as SANDBOX_PROMPTS } from "./prompts.js";
import { recallPromptBlock } from "../memory-bridge.js";
import { readSandboxBytes, writeSandboxBytes } from "../lib/office/ooxml.js";

import { icon as lumenIcon } from "../lib/icons.js";
import { mountCreativeBar } from "../lib/creative-kit.js";
import { listAgents, matchAgentMention, delegateToAgent, openLivingDialog, listLiving, onLivingUpdated, runLiving, rhythmLabel, ensureLivingStyles } from "../lib/living-docs.js";
import { agentAvatarHTML } from "../lib/agent-avatar.js";
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };

// ── Contexte injecté par desktop.js ─────────────────────────────────────────
let ctx = {
  createWindow: () => null,
  closeWindow: () => {},
  getCurrent: () => null,
  listSandboxes: async () => [],
  requestSandboxRefresh: () => {},
  listSandboxImages: async () => [],
  requestChatEdit: null, // ({ label, onSubmit }) => void  — fourni par le shell bureau
};
export function setCreativeContext(next) { ctx = { ...ctx, ...next }; }

// ── Dimensions de page (px logiques) ────────────────────────────────────────
const PAGE_SIZES = {
  document: { w: 794, h: 1123 },   // A4 @96dpi portrait
  presentation: { w: 1280, h: 720 }, // 16:9
};

let uidSeq = 0;
const uid = () => `el-${Date.now().toString(36)}-${(uidSeq++).toString(36)}`;

// ── Modèles par défaut ───────────────────────────────────────────────────────
function blankPage(kind) {
  const { w, h } = PAGE_SIZES[kind] || PAGE_SIZES.document;
  return { w, h, background: kind === "presentation" ? "#0b1020" : "#ffffff", elements: [] };
}

function starterDoc(kind) {
  const page = blankPage(kind);
  if (kind === "presentation") {
    page.elements.push(
      textEl({ x: 120, y: 240, w: 1040, h: 150, html: "Grande idée", fontSize: 88, weight: 800, color: "#ffffff", align: "left" }),
      textEl({ x: 120, y: 410, w: 900, h: 80, html: "Une narration claire, visuelle, prête à être raffinée avec l'IA.", fontSize: 30, color: "#aab2d5", align: "left" }),
    );
  } else {
    page.elements.push(
      textEl({ x: 90, y: 90, w: 614, h: 40, html: "DOCUMENT", fontSize: 14, weight: 800, color: "#007aff", letterSpacing: 2 }),
      textEl({ x: 90, y: 130, w: 614, h: 120, html: "Titre du document", fontSize: 52, weight: 800, color: "#1d1d1f" }),
      textEl({ x: 90, y: 270, w: 614, h: 400, html: "Un texte élégant, structuré, avec une mise en page calme. Sélectionnez n'importe quel bloc pour l'éditer, ou demandez à l'IA de le transformer.", fontSize: 18, color: "#3a3a3c", lineHeight: 1.6 }),
    );
  }
  return { kind, title: kind === "presentation" ? "Présentation" : "Document", pages: [page] };
}

function textEl(o = {}) {
  return {
    id: uid(), type: "text", x: o.x ?? 60, y: o.y ?? 60, w: o.w ?? 360, h: o.h ?? 80, rotation: o.rotation ?? 0,
    html: o.html ?? "Texte", fontSize: o.fontSize ?? 24, fontFamily: o.fontFamily ?? "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
    color: o.color ?? "#1d1d1f", align: o.align ?? "left", weight: o.weight ?? 400, lineHeight: o.lineHeight ?? 1.35,
    letterSpacing: o.letterSpacing ?? 0, bg: o.bg ?? "transparent", opacity: o.opacity ?? 1, padding: o.padding ?? 4,
    style: o.style ?? "",   // style de paragraphe appliqué (cf. PARA_STYLES)
  };
}
// Styles de paragraphe, façon suite bureautique : un document reste cohérent
// parce que ses titres partagent les mêmes réglages, pas parce que l'auteur a
// retapé la même taille cinq fois. `style` est mémorisé sur l'élément, ce qui
// permettra plus tard de re-appliquer une charte à tout le document.
export const PARA_STYLES = {
  h1: { label: "Titre 1", fontSize: 46, weight: 800, lineHeight: 1.15, letterSpacing: -0.5 },
  h2: { label: "Titre 2", fontSize: 32, weight: 700, lineHeight: 1.2, letterSpacing: -0.3 },
  h3: { label: "Titre 3", fontSize: 23, weight: 700, lineHeight: 1.25, letterSpacing: 0 },
  body: { label: "Corps de texte", fontSize: 17, weight: 400, lineHeight: 1.6, letterSpacing: 0 },
  lead: { label: "Chapô", fontSize: 21, weight: 500, lineHeight: 1.5, letterSpacing: 0 },
  quote: { label: "Citation", fontSize: 19, weight: 400, lineHeight: 1.55, letterSpacing: 0, fontFamily: "ui-serif, Georgia, 'Times New Roman', serif" },
  code: { label: "Code", fontSize: 14, weight: 400, lineHeight: 1.5, letterSpacing: 0, fontFamily: "'SF Mono', ui-monospace, Menlo, monospace" },
  caption: { label: "Légende", fontSize: 12.5, weight: 600, lineHeight: 1.4, letterSpacing: 0.4 },
};

// Tableau : lignes × colonnes de HTML riche, avec une ligne d'en-tête
// optionnelle. Stocké en matrice (et non en HTML) pour rester manipulable
// (ajout de ligne, tri futur, export Markdown fidèle).
function tableEl(o = {}) {
  const cols = o.cols ?? 3, rowCount = o.rowCount ?? 4;
  const rows = o.rows || Array.from({ length: rowCount }, (_, r) =>
    Array.from({ length: cols }, (_, c) => (r === 0 ? `${tt("Colonne")} ${c + 1}` : "")));
  return {
    id: uid(), type: "table", x: o.x ?? 80, y: o.y ?? 80, w: o.w ?? 520, h: o.h ?? 30 * rows.length + 12, rotation: o.rotation ?? 0,
    rows, header: o.header ?? true, opacity: o.opacity ?? 1,
    fontSize: o.fontSize ?? 14, color: o.color ?? "#1d1d1f", headerBg: o.headerBg ?? "#f2f2f7",
    borderColor: o.borderColor ?? "#d1d1d6", zebra: o.zebra ?? true, align: o.align ?? "left",
  };
}

function imageEl(o = {}) {
  return {
    id: uid(), type: "image", x: o.x ?? 80, y: o.y ?? 80, w: o.w ?? 360, h: o.h ?? 240, rotation: o.rotation ?? 0,
    src: o.src ?? "", sandboxPath: o.sandboxPath ?? "", sandboxId: o.sandboxId ?? "",
    fit: o.fit ?? "cover", radius: o.radius ?? 12, opacity: o.opacity ?? 1, alt: o.alt ?? "",
  };
}

/**
 * Document d'une page portant une seule image : la cible du bus « Envoyer
 * vers… » pour un objet `image` (Photos, menu contextuel des outils
 * d'écriture…). L'image est posée pleine largeur, dans le ratio de la page ;
 * `src` (data: URL) prime, sinon elle sera lue dans SA sandbox à l'ouverture
 * (cf. hydrateImages) — pas dans la sandbox active, qui peut être une autre.
 */
export function creativeDocFromImage({ title = "", src = "", sandboxPath = "", sandboxId = "", alt = "" } = {}, kind = "document") {
  const page = blankPage(kind);
  const margin = kind === "presentation" ? 80 : 90;
  const w = page.w - margin * 2;
  const h = Math.min(page.h - margin * 2, Math.round(w * 0.75));
  page.elements.push(imageEl({ x: margin, y: margin, w, h, src, sandboxPath, sandboxId, alt: alt || title, fit: "contain" }));
  return { kind, title: title || tt("Image"), pages: [page] };
}
function shapeEl(o = {}) {
  return {
    id: uid(), type: "shape", shape: o.shape ?? "rect", x: o.x ?? 80, y: o.y ?? 80, w: o.w ?? 220, h: o.h ?? 160, rotation: o.rotation ?? 0,
    fill: o.fill ?? "#0a84ff", stroke: o.stroke ?? "transparent", strokeWidth: o.strokeWidth ?? 0, radius: o.radius ?? 16, opacity: o.opacity ?? 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// État d'une instance d'éditeur (par fenêtre).
// ─────────────────────────────────────────────────────────────────────────────
function createState(doc, kind, meta) {
  return {
    kind, doc, pageIndex: 0, selection: null, zoom: 1,
    path: meta?.path || "", format: meta?.format || "lumen", sandboxId: meta?.sandboxId || "",
    aiMode: "diff", // 'diff' | 'direct'
    undo: [], redo: [],
    refs: {},
  };
}
function curPage(st) { return st.doc.pages[st.pageIndex]; }
function curEl(st) { return curPage(st).elements.find((e) => e.id === st.selection) || null; }

function snapshot(st) {
  st.undo.push(JSON.stringify(st.doc));
  if (st.undo.length > 80) st.undo.shift();
  st.redo.length = 0;
}
function doUndo(st) {
  if (!st.undo.length) return;
  st.redo.push(JSON.stringify(st.doc));
  st.doc = JSON.parse(st.undo.pop());
  if (st.pageIndex >= st.doc.pages.length) st.pageIndex = st.doc.pages.length - 1;
  st.selection = null;
}
function doRedo(st) {
  if (!st.redo.length) return;
  st.undo.push(JSON.stringify(st.doc));
  st.doc = JSON.parse(st.redo.pop());
  if (st.pageIndex >= st.doc.pages.length) st.pageIndex = st.doc.pages.length - 1;
  st.selection = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Icônes inline (légères, cohérentes avec le reste du bureau).
// ─────────────────────────────────────────────────────────────────────────────
// Icônes : jeu unique et vendorisé (cf. lib/icons.js). Opus utilisait son
// propre helper avec des graisses de 1,3 à 2 — d'où des barres d'outils qui
// n'avaient pas le même poids que le reste de Lumen.
const ICN = new Proxy({}, { get: (_, name) => lumenIcon(String(name)) });


// ─────────────────────────────────────────────────────────────────────────────
// Ouverture / rendu
// ─────────────────────────────────────────────────────────────────────────────
// Deux applications sur le même moteur : **Documents** (pages A4) et
// **Présentations** (diapositives 16:9). Chacune a sa fenêtre, son titre, ses
// réglages persistés (zoom, mode IA…) — on peut les ouvrir côte à côte, et un
// document se CONVERTIT vers l'autre app plutôt que de changer de format sur
// place (cf. switchKind).
const APPS = {
  document: { id: "documents", title: "Documents", w: 1240, h: 780, x: 60, y: 40 },
  presentation: { id: "presentations", title: "Présentations", w: 1280, h: 800, x: 80, y: 52 },
};
const appOf = (kind) => APPS[kind === "presentation" ? "presentation" : "document"];
const appTitle = (kind) => tt(appOf(kind).title);
const lastOpusKind = () => (localStorage.getItem("opusKind") === "presentation" ? "presentation" : "document");

/** Réglages persistés PAR APP : ce que Documents règle ne touche pas Présentations. */
const PREFS_KEY = (kind) => `opus.prefs.${kind === "presentation" ? "presentation" : "document"}`;
const DEFAULT_PREFS = { zoom: 1, aiMode: "diff", showNotes: true, panels: { pages: true, inspector: true } };
function readPrefs(kind) {
  try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY(kind)) || "{}")) }; } catch { return { ...DEFAULT_PREFS }; }
}
function savePref(st, patch) {
  const next = { ...readPrefs(st.kind), ...patch };
  try { localStorage.setItem(PREFS_KEY(st.kind), JSON.stringify(next)); } catch {}
}

export function openCreativeApp(kind, initial = null) {
  if (!kind) kind = lastOpusKind();
  const app = appOf(kind);
  if (initial && ctx.getCurrent) ctx.closeWindow(app.id);
  try { localStorage.setItem("opusKind", kind); } catch {}
  const win = ctx.createWindow({ id: app.id, title: appTitle(kind), w: app.w, h: app.h, x: app.x, y: app.y });
  if (!win) return;

  const doc = initial?.doc || (initial?.html ? importLegacyHtml(initial.html, kind, initial.title) : starterDoc(kind));
  doc.kind = kind;
  if (initial?.title) doc.title = initial.title;
  const st = createState(doc, kind, initial);
  const prefs = readPrefs(kind);
  st.zoom = prefs.zoom || 1;
  st.aiMode = prefs.aiMode || "diff";
  st.panels = { ...DEFAULT_PREFS.panels, ...(prefs.panels || {}) };

  win.body.innerHTML = shell(st);
  wire(win, st);
  hydrateImages(st).then(() => renderCanvas(st));
}

// Formats Office : ouverts par conversion (lib/office), et réenregistrés dans
// LEUR format — un .docx ouvert puis enregistré reste un .docx.
const OFFICE_KIND = { docx: "document", pptx: "presentation" };

async function openOfficeFile(path, sandboxId) {
  const ext = fileExt(path);
  try {
    const bytes = await readSandboxBytes(invoke, sandboxId, path);
    const doc = ext === "docx"
      ? await (await import("../lib/office/docx.js")).docxToCreative(bytes, { uid, title: base(path) })
      : await (await import("../lib/office/pptx.js")).pptxToCreative(bytes, { uid, title: base(path) });
    if (!doc.title || doc.title === "Document" || doc.title === "Présentation") doc.title = base(path);
    for (const p of doc.pages) for (const el of p.elements) el.id ||= uid();
    openCreativeApp(OFFICE_KIND[ext], { doc, path, title: doc.title, format: ext, sandboxId });
  } catch (e) {
    ctx.toast?.(`${tt("Impossible d'ouvrir ce fichier Office")} : ${e?.message || e}`);
    console.error("[office]", e);
  }
}

/// Octets .docx / .pptx du document courant (images relues dans leur sandbox).
async function officeBytes(st, format) {
  await hydrateImages(st);
  const loadImage = async (el) => el.src || "";
  if (format === "docx") return (await import("../lib/office/docx.js")).creativeToDocx(st.doc, { loadImage });
  return (await import("../lib/office/pptx.js")).creativeToPptx(st.doc, { loadImage });
}

/// Enregistre au format Office : `asCopy` écrit « Titre.docx » à côté, sinon
/// le fichier Office d'origine est réécrit.
async function saveOffice(st, format, asCopy) {
  const sb = st.sandboxId ? { id: st.sandboxId } : ctx.getCurrent();
  const status = st.refs.status;
  if (!sb) { status.textContent = tt("Aucune sandbox active"); return; }
  const rawTitle = (st.doc.title || "").trim() || "Document";
  const safe = rawTitle.replace(/[^\p{L}\p{N}_ -]+/gu, "").trim().replace(/\s+/g, "_") || "Document";
  const path = !asCopy && st.path && fileExt(st.path) === format ? st.path : `${safe}.${format}`;
  status.textContent = tt("Conversion…");
  try {
    const bytes = await officeBytes(st, format);
    await writeSandboxBytes(invoke, sb.id, path, bytes);
    status.textContent = `${tt(asCopy ? "Exporté" : "Enregistré ✓")} : ${path}`;
    ctx.requestSandboxRefresh();
  } catch (e) { status.textContent = tt("Échec :") + " " + (e?.message || e); }
}

export async function openCreativeFile(path, preferredKind = "", sandboxId = "") {
  const sb = sandboxId ? { id: sandboxId } : ctx.getCurrent();
  if (!sb || !path) return;
  if (OFFICE_KIND[fileExt(path)]) return openOfficeFile(path, sb.id);
  let file = await invoke("sandbox_read_file", { id: sb.id, path });
  if (file?.truncated) {
    const b64 = await invoke("sandbox_read_b64", { id: sb.id, path });
    file = { content: decodeBase64Utf8(b64), binary: false, truncated: false };
  }
  if (!file || file.binary) return;
  const parsed = parseCreativeFile(path, file.content || "", preferredKind);
  if (!parsed) return;
  parsed.sandboxId = sb.id;
  openCreativeApp(parsed.kind, parsed);
}

// La barre d'outils est organisée en groupes NOMMÉS (comme une suite
// bureautique) : les icônes seules ne disaient pas ce qu'elles faisaient et la
// moitié des fonctions passaient inaperçues. Chaque groupe porte son intitulé,
// les boutons gardent leur infobulle, et rien n'est masqué derrière un menu.
function grp(label, inner) {
  return `<div class="ce-grp"><div class="ce-grp-body">${inner}</div><div class="ce-grp-lbl">${label}</div></div>`;
}
function tool(attr, value, icon, title, cls = "") {
  return `<button class="ce-tool ${cls}" ${attr}="${value}" title="${escapeHtml(title)}">${icon}</button>`;
}

function shell(st) {
  const isDeck = st.kind === "presentation";
  // Disposition : la barre de titre et le ruban occupent TOUTE la largeur (une
  // rangée en haut), les panneaux latéraux (pages, inspecteur) vivent en
  // dessous, de part et d'autre de la scène, et chacun se replie (bouton dans
  // son en-tête ou dans la barre) — état mémorisé par app (readPrefs).
  const hidden = (name) => (st.panels && st.panels[name] === false ? " ce-hide-" + name : "");
  return `
  <div class="ce-app ${isDeck ? "ce-deck" : "ce-doc"}${hidden("pages")}${hidden("inspector")}">
    <div class="ce-top">
      <div class="ce-toolbar">
        <span class="ce-appbadge" title="${tt(isDeck ? "Présentations" : "Documents")}">${isDeck ? ICN.deck : ICN.file}</span>
        <input class="ce-title" value="${escapeHtml(st.doc.title || "")}" />
        <span class="ce-spacer"></span>
        <!-- Actions PRINCIPALES en icônes seules (infobulle au survol) : ce sont
             les gestes de tous les jours, ils doivent se voir d'un coup d'œil
             sans concurrencer le ruban qui, lui, porte des intitulés. -->
        <div class="ce-actions ce-actions-icons">
          <button class="ce-ibtn" data-act="new-doc" title="${tt("Nouveau")}">${ICN.file}</button>
          <button class="ce-ibtn" data-act="open-doc" title="${tt("Ouvrir")}">${ICN.folderOpen}</button>
          <span class="ce-vsep"></span>
          <button class="ce-ibtn" data-act="undo" title="${tt("Annuler")} (⌘Z)">${ICN.undo}</button>
          <button class="ce-ibtn" data-act="redo" title="${tt("Rétablir")} (⇧⌘Z)">${ICN.redo}</button>
          <span class="ce-vsep"></span>
          <div class="ce-zoom"><button data-zoom="-" title="${tt("Dézoomer")}">–</button><span class="ce-zoom-val">100%</span><button data-zoom="+" title="${tt("Zoomer")}">+</button><button data-zoom="fit" title="${tt("Ajuster à la fenêtre")}">${ICN.fullscreen || "⤢"}</button></div>
          <span class="ce-vsep"></span>
          <button class="ce-ibtn ce-panel-toggle" data-panel="pages" title="${tt(isDeck ? "Afficher/masquer les diapositives" : "Afficher/masquer les pages")}">${ICN["panel-left"]}</button>
          <button class="ce-ibtn ce-panel-toggle" data-panel="inspector" title="${tt("Afficher/masquer l'inspecteur")}">${ICN["panel-right"]}</button>
          <span class="ce-vsep"></span>
          <button class="ce-ibtn" data-act="pdf" title="${tt("Exporter en PDF")}">${ICN.pdf}</button>
          <button class="ce-ibtn ce-office" data-act="office" title="${tt(isDeck ? "Exporter en PowerPoint (.pptx)" : "Exporter en Word (.docx)")}">${isDeck ? "PPTX" : "DOCX"}</button>
          <button class="ce-ibtn" data-act="present" title="${tt("Lancer le mode présentation (Échap pour sortir)")}">${ICN.play}</button>
          <button class="ce-ibtn primary ce-save" data-act="save" title="${tt("Enregistrer")} (⌘S)">${ICN.save}</button>
        </div>
      </div>

      <div class="ce-ribbon">
        ${grp(tt("Fichier"), `
          ${tool("data-act", "new-doc", ICN.file, tt("Nouveau"))}
          ${tool("data-act", "templates", ICN.library || ICN.grid, tt("Modèles"))}
          ${tool("data-act", "open-doc", ICN.folderOpen, tt("Ouvrir"))}
          ${tool("data-act", "history", ICN.history, tt("Historique des versions"))}
          ${tool("data-act", "convert", isDeck ? ICN.file : ICN.deck, tt(isDeck ? "Convertir en document (ouvre Documents)" : "Convertir en présentation (ouvre Présentations)"))}
        `)}
        ${grp(tt("Exporter"), `
          ${tool("data-act", "pdf", ICN.pdf, tt("PDF"))}
          ${tool("data-act", "export", ICN.code, tt("HTML"))}
          ${tool("data-act", "md", ICN.doc || ICN.file, tt("Markdown"))}
        `)}
        ${grp(tt("Annuler"), `
          ${tool("data-act", "undo", ICN.undo, tt("Annuler"))}
          ${tool("data-act", "redo", ICN.redo, tt("Rétablir"))}
        `)}
        ${grp(tt("Insérer"), `
          ${tool("data-ins", "text", ICN.text, tt("Zone de texte"))}
          ${tool("data-ins", "image", ICN.image, tt("Image"))}
          ${tool("data-ins", "table", ICN.table, tt("Tableau"))}
          ${tool("data-ins", "dataviz", ICN["chart-column"], tt("Visuel de données"))}
          ${tool("data-act", "dataviz-refresh", ICN["refresh-cw"], tt("Actualiser les données"))}
          ${tool("data-ins", "rect", ICN.rect, tt("Rectangle"))}
          ${tool("data-ins", "ellipse", ICN.ellipse, tt("Ellipse"))}
          ${tool("data-ins", "triangle", ICN.triangle, tt("Triangle"))}
          ${tool("data-ins", "line", ICN.line, tt("Ligne"))}
        `)}
        ${grp(tt("Style de texte"), `
          <select class="ce-parastyle" title="${tt("Style de paragraphe")}">
            <option value="">${tt("Style…")}</option>
            ${Object.entries(PARA_STYLES).map(([id, s]) => `<option value="${id}">${tt(s.label)}</option>`).join("")}
          </select>
          ${tool("data-rich", "bold", "<b>G</b>", tt("Gras (⌘B)"))}
          ${tool("data-rich", "italic", "<i>I</i>", tt("Italique (⌘I)"))}
          ${tool("data-rich", "underline", "<u>S</u>", tt("Souligné (⌘U)"))}
          ${tool("data-rich", "strikeThrough", "<s>B</s>", tt("Barré"))}
          ${tool("data-rich", "superscript", "x²", tt("Exposant"))}
          ${tool("data-rich", "subscript", "x₂", tt("Indice"))}
        `)}
        ${grp(tt("Paragraphe"), `
          ${tool("data-rich", "insertUnorderedList", "•—", tt("Liste à puces"))}
          ${tool("data-rich", "insertOrderedList", "1—", tt("Liste numérotée"))}
          ${tool("data-rich", "createLink", ICN.link || "🔗", tt("Lien hypertexte"))}
          ${tool("data-rich", "removeFormat", "⌫", tt("Effacer la mise en forme"))}
        `)}
        ${grp(tt("Outils"), `
          ${tool("data-act", "find", ICN.search, tt("Rechercher et remplacer (⌘F)"))}
          ${tool("data-act", "stats", ICN.info || ICN.list, tt("Statistiques du document"))}
        `)}
      </div>
    </div>
    <aside class="ce-pages">
      <div class="ce-pages-head"><span>${tt(isDeck ? "Diapositives" : "Pages")}</span>
        <span class="ce-head-btns">
          <button class="ce-icnbtn" data-act="add-page" title="${tt("Ajouter")}">${ICN.add}</button>
          <button class="ce-icnbtn" data-panel="pages" title="${tt("Réduire le panneau")}">${ICN["chevron-left"]}</button>
        </span>
      </div>
      <div class="ce-thumbs"></div>
      <div class="ce-notes-wrap">
        <label class="ce-notes-lbl">${tt(isDeck ? "Notes de l'intervenant" : "Notes de page")}</label>
        <textarea class="ce-notes" placeholder="${tt("Visibles en mode présentation, jamais à l'export.")}"></textarea>
      </div>
    </aside>
    <main class="ce-main">
      <div class="ce-stage"><div class="ce-stage-inner"></div></div>
      <div class="ce-statusbar">
        <span class="ce-sb-page"></span>
        <span class="ce-sb-sep"></span>
        <span class="ce-sb-count"></span>
        <span class="ce-spacer"></span>
        <span class="ce-sb-path"></span>
      </div>
    </main>
    <aside class="ce-inspector">
      <div class="ce-pages-head ce-insp-head"><span>${tt("Inspecteur")}</span>
        <button class="ce-icnbtn" data-panel="inspector" title="${tt("Réduire le panneau")}">${ICN["chevron-right"]}</button>
      </div>
      <div class="ce-insp-body"><div class="ce-insp-empty">${tt("Sélectionnez un élément pour l'éditer.")}</div></div>
      <div class="ce-ai">
        <div class="ce-ai-head">${ICN.ai}<span>${tt("Assistant IA")}</span>
          <div class="ce-ai-toggle" title="${tt("Mode d'application")}">
            <button data-aimode="diff" class="active">${tt("Diff")}</button>
            <button data-aimode="direct">${tt("Direct")}</button>
          </div>
        </div>
        <textarea class="ce-ai-prompt" placeholder="${tt("Décris la modification (élément sélectionné, ou la page entière)…")}"></textarea>
        <div class="ce-ai-actions">
          <button class="ce-btn primary" data-ai="element">${tt("Modifier l'élément")}</button>
          <button class="ce-btn" data-ai="page">${tt("Générer la page")}</button>
        </div>
        <div class="ce-status"></div>
        <div class="ce-diff" hidden></div>
      </div>
    </aside>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Câblage
// ─────────────────────────────────────────────────────────────────────────────
function wire(win, st) {
  const body = win.body;
  ensureLivingStyles();
  watchLiving(st);
  st.refs = {
    win, body,
    stage: body.querySelector(".ce-stage"),
    inner: body.querySelector(".ce-stage-inner"),
    thumbs: body.querySelector(".ce-thumbs"),
    insp: body.querySelector(".ce-insp-body"),
    title: body.querySelector(".ce-title"),
    status: body.querySelector(".ce-status"),
    diff: body.querySelector(".ce-diff"),
    zoomVal: body.querySelector(".ce-zoom-val"),
    notes: body.querySelector(".ce-notes"),
    sbPage: body.querySelector(".ce-sb-page"),
    sbCount: body.querySelector(".ce-sb-count"),
    sbPath: body.querySelector(".ce-sb-path"),
    paraStyle: body.querySelector(".ce-parastyle"),
  };

  st.refs.title.addEventListener("input", () => { st.doc.title = st.refs.title.value; win.setTitle?.(st.doc.title ? `${appTitle(st.kind)} — ${st.doc.title}` : appTitle(st.kind)); });

  body.querySelectorAll('[data-act="convert"]').forEach((b) => b.addEventListener("click", () => switchKind(st, st.kind === "presentation" ? "document" : "presentation")));

  // Panneaux repliables : la classe sur .ce-app pilote la grille (CSS), les
  // boutons de la barre reflètent l'état, le choix est mémorisé par app.
  const app = body.querySelector(".ce-app");
  const syncPanels = () => {
    for (const name of ["pages", "inspector"]) {
      app.classList.toggle("ce-hide-" + name, st.panels[name] === false);
      body.querySelectorAll(`.ce-panel-toggle[data-panel="${name}"]`).forEach((b) => b.classList.toggle("active", st.panels[name] !== false));
    }
  };
  body.querySelectorAll("[data-panel]").forEach((b) => b.addEventListener("click", () => {
    const name = b.dataset.panel;
    st.panels[name] = st.panels[name] === false;
    savePref(st, { panels: { ...st.panels } });
    syncPanels();
  }));
  syncPanels();

  body.querySelectorAll(".ce-tool[data-ins]").forEach((b) => b.addEventListener("click", () => insertElement(st, b.dataset.ins)));
  body.querySelector('[data-act="add-page"]').addEventListener("click", () => { snapshot(st); st.doc.pages.push(blankPage(st.kind)); st.pageIndex = st.doc.pages.length - 1; st.selection = null; renderCanvas(st); });
  body.querySelector('[data-act="undo"]').addEventListener("click", () => { doUndo(st); renderCanvas(st); });
  body.querySelector('[data-act="redo"]').addEventListener("click", () => { doRedo(st); renderCanvas(st); });
  body.querySelector('[data-act="history"]').addEventListener("click", () => openHistory(st));
  body.querySelector('[data-act="new-doc"]').addEventListener("click", () => newCreative(st));
  body.querySelector('[data-act="open-doc"]').addEventListener("click", () => openCreativePicker(st));
  body.querySelector('[data-act="save"]').addEventListener("click", () => saveCreative(st, false));
  body.querySelector('[data-act="pdf"]').addEventListener("click", () => exportPdf(st));
  body.querySelector('[data-act="office"]')?.addEventListener("click", () => saveOffice(st, st.kind === "presentation" ? "pptx" : "docx", true));
  body.querySelector('[data-act="export"]').addEventListener("click", () => saveCreative(st, true));
  body.querySelector('[data-act="md"]').addEventListener("click", () => exportMarkdown(st));
  body.querySelector('[data-act="dataviz-refresh"]')?.addEventListener("click", () => refreshDataVisuals(st));
  // Espace Création : rattacher le document à un projet commun (Notes, cartes,
  // planches…), versions et exports partagés. Opus garde son historique fin.
  const ckHost = document.createElement("span");
  body.querySelector(".ce-toolbar .ce-spacer")?.after(ckHost);
  mountCreativeBar(ckHost, {
    app: "opus",
    current: () => {
      if (!st.path) { st.refs.status.textContent = tt("Enregistrez d'abord le document"); return null; }
      const sb = st.sandboxId || ctx.getCurrent()?.id || "";
      return { ref: `${sb}:${st.path}`, title: st.doc.title || "" };
    },
    serialize: () => JSON.stringify(st.doc),
    restore: () => {},
    openVersions: () => openHistory(st),
    exportDoc: () => ({ title: st.doc.title || "Document", markdown: docToMarkdown(st), html: renderStaticHtml(st) }),
    formats: ["md", "html", "txt"],
    toast: (m) => { st.refs.status.textContent = m; },
  });
  body.querySelector('[data-act="templates"]').addEventListener("click", () => openTemplateGallery(st));
  body.querySelector('[data-act="present"]').addEventListener("click", () => startPresentation(st));
  body.querySelector('[data-act="find"]').addEventListener("click", () => openFindReplace(st));
  body.querySelector('[data-act="stats"]').addEventListener("click", () => showStats(st));

  // Mise en forme riche : sur la sélection en cours d'édition, sinon sur tout
  // le texte de l'élément sélectionné (sans quoi le bouton ne ferait rien).
  body.querySelectorAll("[data-rich]").forEach((b) => b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    applyRichCommand(st, b.dataset.rich);
  }));
  st.refs.paraStyle?.addEventListener("change", () => {
    applyParagraphStyle(st, st.refs.paraStyle.value);
    st.refs.paraStyle.value = "";
  });
  st.refs.notes?.addEventListener("input", () => { curPage(st).notes = st.refs.notes.value; });

  body.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.zoom === "fit") st.zoom = fitZoom(st);
    else st.zoom = Math.max(0.25, Math.min(2, st.zoom + (b.dataset.zoom === "+" ? 0.1 : -0.1)));
    applyZoom(st);
    savePref(st, { zoom: st.zoom });
  }));

  body.querySelectorAll("[data-aimode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.aimode === st.aiMode);
    b.addEventListener("click", () => {
      st.aiMode = b.dataset.aimode;
      body.querySelectorAll("[data-aimode]").forEach((x) => x.classList.toggle("active", x === b));
      savePref(st, { aiMode: st.aiMode });
    });
  });
  body.querySelector('[data-ai="element"]').addEventListener("click", () => runAI(st, "element"));
  body.querySelector('[data-ai="page"]').addEventListener("click", () => runAI(st, "page"));

  // Clic sur le fond de la scène = désélection.
  st.refs.inner.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("ce-page")) { st.selection = null; renderSelection(st); renderInspector(st); }
  });

  // Raccourcis clavier (au niveau de la fenêtre, sans gêner la frappe de texte).
  body.addEventListener("keydown", (e) => {
    const editing = document.activeElement && (document.activeElement.isContentEditable || /INPUT|TEXTAREA/.test(document.activeElement.tagName));
    if (editing) return;
    const el = curEl(st);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo(st) : doUndo(st); renderCanvas(st); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(st); renderCanvas(st); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); openFindReplace(st); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveCreative(st, false); return; }
    if (e.key === "PageDown" && st.pageIndex < st.doc.pages.length - 1) { e.preventDefault(); st.pageIndex += 1; st.selection = null; renderCanvas(st); return; }
    if (e.key === "PageUp" && st.pageIndex > 0) { e.preventDefault(); st.pageIndex -= 1; st.selection = null; renderCanvas(st); return; }
    if (!el) return;
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteEl(st, el.id); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateEl(st, el.id); return; }
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") { snapshotThrottled(st); el.x -= step; renderCanvas(st); e.preventDefault(); }
    if (e.key === "ArrowRight") { snapshotThrottled(st); el.x += step; renderCanvas(st); e.preventDefault(); }
    if (e.key === "ArrowUp") { snapshotThrottled(st); el.y -= step; renderCanvas(st); e.preventDefault(); }
    if (e.key === "ArrowDown") { snapshotThrottled(st); el.y += step; renderCanvas(st); e.preventDefault(); }
  });
  body.setAttribute("tabindex", "0");

  applyZoom(st);
}

// Convertit le document courant vers l'AUTRE app (Document ⇄ Présentation)
// sans repartir de zéro : les pages passent au gabarit cible et les éléments
// sont remis à l'échelle proportionnellement, puis la copie s'ouvre dans la
// fenêtre de l'app cible. L'original reste tel quel dans sa fenêtre — une
// conversion ne doit pas faire disparaître le document de départ.
function switchKind(st, kind) {
  if (kind !== "document" && kind !== "presentation") return;
  if (kind === st.kind) return;
  const target = PAGE_SIZES[kind];
  const prevDefaultBg = st.kind === "presentation" ? "#0b1020" : "#ffffff";
  const nextDefaultBg = kind === "presentation" ? "#0b1020" : "#ffffff";
  const doc = JSON.parse(JSON.stringify(st.doc));
  for (const page of doc.pages) {
    const rx = target.w / (page.w || target.w);
    const ry = target.h / (page.h || target.h);
    const rf = Math.min(rx, ry);
    for (const el of page.elements) {
      el.x = Math.round(el.x * rx); el.w = Math.round(el.w * rx);
      el.y = Math.round(el.y * ry); el.h = Math.round(el.h * ry);
      if (typeof el.fontSize === "number") el.fontSize = Math.max(8, Math.round(el.fontSize * rf));
    }
    if (page.background === prevDefaultBg) page.background = nextDefaultBg;
    page.w = target.w; page.h = target.h;
  }
  doc.kind = kind;
  // Nouveau chemin : l'extension change (.lumenpages ⇄ .lumenkey).
  openCreativeApp(kind, { doc, title: doc.title, path: "", format: "lumen" });
  st.refs.status.textContent = tt(kind === "presentation" ? "Copie ouverte dans Présentations" : "Copie ouverte dans Documents");
}

let snapTimer = 0;
function snapshotThrottled(st) {
  if (Date.now() - snapTimer > 600) { snapshot(st); snapTimer = Date.now(); }
}

function applyZoom(st) {
  const page = curPage(st);
  st.refs.zoomVal.textContent = Math.round(st.zoom * 100) + "%";
  st.refs.inner.style.width = page.w * st.zoom + "px";
  st.refs.inner.style.height = page.h * st.zoom + "px";
  renderCanvas(st);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendu du canevas + sélection
// ─────────────────────────────────────────────────────────────────────────────
function renderCanvas(st, keepInspector = false) {
  // Un re-rendu écrase le DOM : ce qui est en cours de frappe doit d'abord
  // rejoindre le document, sinon il disparaît (cf. beginTextEdit).
  commitTextEdit(st);
  const page = curPage(st);
  const inner = st.refs.inner;
  inner.style.width = page.w * st.zoom + "px";
  inner.style.height = page.h * st.zoom + "px";
  inner.innerHTML = `<div class="ce-page" style="width:${page.w}px;height:${page.h}px;background:${page.background};transform:scale(${st.zoom});transform-origin:top left;"></div>`;
  const pageEl = inner.querySelector(".ce-page");
  page.elements.forEach((el) => pageEl.appendChild(renderElement(st, el)));
  renderSelection(st);
  renderThumbs(st);
  renderStatusBar(st);
  paintLiveBadges(st).catch(() => {});
  if (st.refs.notes && st.refs.notes.value !== (page.notes || "")) st.refs.notes.value = page.notes || "";
  if (!keepInspector) renderInspector(st);
}

// Barre d'état : où l'on est, ce que pèse le document, où il est enregistré.
// Ces trois informations manquaient complètement.
function renderStatusBar(st) {
  const { words, chars } = docStats(st);
  const isDeck = st.kind === "presentation";
  if (st.refs.sbPage) st.refs.sbPage.textContent = `${tt(isDeck ? "Diapo" : "Page")} ${st.pageIndex + 1}/${st.doc.pages.length}`;
  if (st.refs.sbCount) st.refs.sbCount.textContent = `${words} ${tt("mots")} · ${chars} ${tt("caractères")}`;
  if (st.refs.sbPath) st.refs.sbPath.textContent = st.path || tt("Non enregistré");
}

function plainText(html) {
  const box = document.createElement("div");
  box.innerHTML = String(html || "").replace(/<(br|\/p|\/div|\/li|\/h[1-6])>/gi, " $& ");
  return (box.textContent || "").replace(/\s+/g, " ").trim();
}
function docStats(st) {
  let words = 0, chars = 0, images = 0, tables = 0;
  for (const page of st.doc.pages) {
    for (const el of page.elements) {
      if (el.type === "image") { images += 1; continue; }
      if (el.type === "table") {
        tables += 1;
        for (const row of el.rows || []) for (const cell of row) { const t = plainText(cell); chars += t.length; words += t ? t.split(/\s+/).length : 0; }
        continue;
      }
      if (el.type !== "text") continue;
      const t = plainText(el.html);
      chars += t.length;
      words += t ? t.split(/\s+/).length : 0;
    }
  }
  return { words, chars, images, tables, pages: st.doc.pages.length };
}

function fitZoom(st) {
  const page = curPage(st);
  const stage = st.refs.stage;
  if (!stage) return 1;
  const z = Math.min((stage.clientWidth - 72) / page.w, (stage.clientHeight - 72) / page.h);
  return Math.max(0.15, Math.min(2, Math.round(z * 100) / 100));
}

function elInnerHtml(el, pageBg) {
  if (el.type === "text") {
    const color = ensureTextColor(el.color, el.bg && el.bg !== "transparent" ? el.bg : pageBg);
    return `<div class="ce-text-inner" style="text-align:${el.align};font-size:${el.fontSize}px;font-family:${el.fontFamily};color:${color};font-weight:${el.weight};line-height:${el.lineHeight};letter-spacing:${el.letterSpacing}px;">${el.html}</div>`;
  }
  if (el.type === "image") {
    return el.src
      ? `<img src="${el.src}" draggable="false" alt="${escapeHtml(el.alt || "")}" style="width:100%;height:100%;object-fit:${el.fit};border-radius:${el.radius}px;display:block;">`
      : `<div class="ce-img-ph">
          <button type="button" class="ce-img-ph-btn" data-img-act="library" title="${tt("Ajouter depuis la bibliothèque")}">${ICN["folder-open"]}<span>${tt("Bibliothèque")}</span></button>
          <button type="button" class="ce-img-ph-btn" data-img-act="generate" title="${tt("Générer via l'IA")}">${ICN.ai}<span>${tt("Générer via l'IA")}</span></button>
        </div>`;
  }
  if (el.type === "shape") return shapeSvg(el);
  if (el.type === "table") return tableHtml(el, pageBg);
  return "";
}

function tableHtml(el, pageBg) {
  const color = ensureTextColor(el.color, pageBg);
  const cell = (html, r, c) => {
    const head = el.header && r === 0;
    const bg = head ? el.headerBg : (el.zebra && r % 2 === 0 ? "rgba(0,0,0,0.025)" : "transparent");
    return `<${head ? "th" : "td"} data-r="${r}" data-c="${c}" style="border:1px solid ${el.borderColor};padding:6px 9px;text-align:${el.align};background:${bg};font-weight:${head ? 700 : 400};vertical-align:top;">${html || "&nbsp;"}</${head ? "th" : "td"}>`;
  };
  const body = (el.rows || []).map((row, r) => `<tr>${row.map((v, c) => cell(v, r, c)).join("")}</tr>`).join("");
  return `<table class="ce-table" style="width:100%;border-collapse:collapse;font-size:${el.fontSize}px;color:${color};table-layout:fixed;">${body}</table>`;
}

// ── Mise en forme riche ─────────────────────────────────────────────────────
// Les boutons agissent sur la sélection en cours d'édition ; sans édition en
// cours, on ouvre l'élément, on sélectionne tout, on applique, on referme —
// autrement le bouton semblait cassé (execCommand sans sélection = sans effet).
function activeEditable(st) {
  const node = document.activeElement;
  if (node && node.isContentEditable && st.refs.inner.contains(node)) return node;
  return null;
}
function applyRichCommand(st, cmd) {
  const el = curEl(st);
  if (!el || el.type !== "text") { st.refs.status.textContent = tt("Sélectionne d'abord une zone de texte."); return; }
  let node = activeEditable(st);
  const opened = !node;
  if (!node) {
    node = st.refs.inner.querySelector(`.ce-el[data-id="${el.id}"] .ce-text-inner`);
    if (!node) return;
    snapshot(st);
    node.setAttribute("contenteditable", "true");
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  }
  if (cmd === "createLink") {
    // La saisie prend le focus : on garde la sélection pour la rétablir ensuite.
    const sel0 = window.getSelection();
    const saved = sel0.rangeCount ? sel0.getRangeAt(0).cloneRange() : null;
    promptSheet({ title: tt("Adresse du lien"), value: "https://", confirm: tt("Valider"), cancel: tt("Annuler") }).then((url) => {
      if (!url) return;
      if (saved) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(saved); }
      document.execCommand("createLink", false, url);
    });
  } else {
    document.execCommand(cmd, false, null);
  }
  el.html = node.innerHTML;
  if (opened) {
    node.removeAttribute("contenteditable");
    renderCanvas(st, true);
  }
}

function applyParagraphStyle(st, id) {
  const preset = PARA_STYLES[id];
  if (!preset) return;
  const el = curEl(st);
  if (!el || el.type !== "text") { st.refs.status.textContent = tt("Sélectionne d'abord une zone de texte."); return; }
  snapshot(st);
  el.style = id;
  el.fontSize = preset.fontSize;
  el.weight = preset.weight;
  el.lineHeight = preset.lineHeight;
  el.letterSpacing = preset.letterSpacing;
  if (preset.fontFamily) el.fontFamily = preset.fontFamily;
  renderCanvas(st);
  st.refs.status.textContent = `${tt("Style appliqué")} : ${tt(preset.label)}`;
}

function shapeSvg(el) {
  const sw = el.strokeWidth || 0;
  const common = `fill="${el.fill}" stroke="${el.stroke}" stroke-width="${sw}"`;
  let inner = "";
  if (el.shape === "rect") inner = `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, el.w - sw)}" height="${Math.max(0, el.h - sw)}" rx="${el.radius}" ${common}/>`;
  else if (el.shape === "ellipse") inner = `<ellipse cx="${el.w / 2}" cy="${el.h / 2}" rx="${Math.max(0, el.w / 2 - sw / 2)}" ry="${Math.max(0, el.h / 2 - sw / 2)}" ${common}/>`;
  else if (el.shape === "triangle") inner = `<polygon points="${el.w / 2},${sw / 2} ${el.w - sw / 2},${el.h - sw / 2} ${sw / 2},${el.h - sw / 2}" ${common}/>`;
  else if (el.shape === "line") inner = `<line x1="0" y1="${el.h / 2}" x2="${el.w}" y2="${el.h / 2}" stroke="${el.fill}" stroke-width="${Math.max(2, sw || 4)}" stroke-linecap="round"/>`;
  return `<svg width="100%" height="100%" viewBox="0 0 ${el.w} ${el.h}" preserveAspectRatio="none" style="overflow:visible;display:block;">${inner}</svg>`;
}

function renderElement(st, el) {
  const node = document.createElement("div");
  node.className = "ce-el ce-el-" + el.type;
  node.dataset.id = el.id;
  node.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;transform:rotate(${el.rotation}deg);opacity:${el.opacity};`;
  if (el.type === "text" && el.bg && el.bg !== "transparent") node.style.background = el.bg;
  node.innerHTML = elInnerHtml(el, curPage(st).background);

  node.addEventListener("pointerdown", (e) => {
    if (e.target.isContentEditable) return;
    e.stopPropagation();
    st.selection = el.id;
    renderSelection(st);
    renderInspector(st);
    // Les boutons du cadre d'image vide sont des actions, pas une poignée.
    if (e.target.closest(".ce-img-ph-btn")) return;
    startDrag(st, el, e);
  });
  if (el.type === "image" && !el.src) {
    node.querySelector('[data-img-act="library"]')?.addEventListener("click", (e) => { e.stopPropagation(); pickImage(st, el); });
    node.querySelector('[data-img-act="generate"]')?.addEventListener("click", (e) => { e.stopPropagation(); aiGenerateImageViaChat(st, el); });
  }

  if (el.type === "text") {
    node.addEventListener("dblclick", (e) => { e.stopPropagation(); beginTextEdit(st, el, node); });
  }
  if (el.type === "table") {
    // Double-clic sur une cellule = édition en place ; Tab passe à la suivante,
    // comme dans n'importe quel tableur ou traitement de texte.
    node.addEventListener("dblclick", (e) => {
      const cell = e.target.closest("td,th");
      if (!cell) return;
      e.stopPropagation();
      beginCellEdit(st, el, cell);
    });
  }
  node.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    st.selection = el.id; renderSelection(st); renderInspector(st);
    showContextMenu(st, el, e.clientX, e.clientY);
  });
  return node;
}

function beginTextEdit(st, el, node) {
  const inner = node.querySelector(".ce-text-inner");
  if (!inner) return;
  commitTextEdit(st);
  snapshot(st);
  inner.setAttribute("contenteditable", "true");
  inner.classList.add("editing");
  node.classList.add("ce-editing");
  inner.focus();
  const range = document.createRange();
  range.selectNodeContents(inner);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  // Coller depuis le chat (ou n'importe où) apporte un HTML étranger : divs,
  // classes, couleurs de bulle… On ne garde que l'inline et les sauts de
  // ligne, sinon le bloc hérite d'une mise en forme qui n'est pas la sienne.
  const onPaste = (e) => {
    e.preventDefault();
    const dt = e.clipboardData;
    const html = dt?.getData("text/html");
    const text = dt?.getData("text/plain") || "";
    document.execCommand("insertHTML", false, html ? sanitizePastedHtml(html) : escapeHtml(text).replace(/\n/g, "<br>"));
  };
  const finish = () => {
    inner.removeEventListener("keydown", onKey);
    inner.removeEventListener("blur", finish);
    inner.removeEventListener("paste", onPaste);
    if (st.editing?.inner === inner) st.editing = null;
    inner.removeAttribute("contenteditable");
    inner.classList.remove("editing");
    node.classList.remove("ce-editing");
    el.html = inner.innerHTML;
  };
  // « @Agent demande » + Entrée : l'agent écrit la suite à cet endroit.
  const onKey = (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const text = window.getSelection()?.anchorNode?.textContent || "";
    if (!text.includes("@")) return;
    e.preventDefault();
    maybeDelegateLine(st, el, inner, e).then((done) => { if (!done) document.execCommand("insertParagraph"); });
  };
  inner.addEventListener("keydown", onKey);
  inner.addEventListener("paste", onPaste);
  inner.addEventListener("blur", finish);
  // Une édition en cours DOIT pouvoir être validée d'ailleurs : un `pointerdown`
  // sur une poignée appelle `preventDefault()`, donc le `blur` n'arrive jamais
  // et le re-rendu qui suit repartait de l'ancien `el.html` — la frappe (ou le
  // collage) était perdue. `commitTextEdit` ferme ce trou.
  st.editing = { inner, finish };
}

/** Valide l'édition de texte en cours, s'il y en a une. Idempotent. */
function commitTextEdit(st) {
  const cur = st?.editing;
  if (!cur) return;
  st.editing = null;
  try { cur.finish(); } catch {}
}

// Collage : on conserve le texte et le balisage inline, rien d'autre. Les
// blocs (p, div, li…) deviennent des sauts de ligne — un élément de page est
// un bloc de texte, pas un document imbriqué.
const PASTE_INLINE = new Set(["B", "STRONG", "I", "EM", "U", "S", "SUP", "SUB", "CODE", "BR", "A", "SPAN"]);
const PASTE_BLOCK = new Set(["P", "DIV", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"]);
function sanitizePastedHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html || "");
  const walk = (node) => {
    let out = "";
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) { out += escapeHtml(child.nodeValue); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName;
      if (tag === "BR") { out += "<br>"; continue; }
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG") continue;
      const inner = walk(child);
      if (PASTE_INLINE.has(tag)) {
        if (tag === "SPAN") { out += inner; continue; }
        if (tag === "A") {
          const href = child.getAttribute("href") || "";
          out += /^https?:/i.test(href) ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
          continue;
        }
        out += `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
        continue;
      }
      out += inner;
      if (PASTE_BLOCK.has(tag) && inner.trim()) out += "<br>";
    }
    return out;
  };
  return walk(tpl.content).replace(/(<br>\s*)+$/, "");
}

function beginCellEdit(st, el, cell) {
  const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
  snapshot(st);
  cell.setAttribute("contenteditable", "true");
  cell.classList.add("ce-cell-editing");
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  const finish = (next) => {
    cell.removeAttribute("contenteditable");
    cell.classList.remove("ce-cell-editing");
    cell.removeEventListener("blur", onBlur);
    cell.removeEventListener("keydown", onKey);
    el.rows[r][c] = cell.innerHTML;
    if (next) {
      const table = cell.closest("table");
      const flat = [...table.querySelectorAll("td,th")];
      const target = flat[flat.indexOf(cell) + next];
      if (target) { beginCellEdit(st, el, target); return; }
    }
    renderCanvas(st, true);
  };
  const onBlur = () => finish(0);
  const onKey = (e) => {
    if (e.key === "Tab") { e.preventDefault(); finish(e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") { e.preventDefault(); finish(0); }
  };
  cell.addEventListener("blur", onBlur);
  cell.addEventListener("keydown", onKey);
}

// ── Menu contextuel (clic droit) ─────────────────────────────────────────────
function showContextMenu(st, el, x, y) {
  document.querySelectorAll(".ce-context-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "ce-context-menu";
  const aiItem = el.type === "image"
    ? { label: tt("Générer image avec l'IA"), icon: ICN.ai, act: () => aiGenerateImageViaChat(st, el) }
    : { label: tt("Éditer avec l'IA"), icon: ICN.ai, act: () => aiEditViaChat(st, el) };
  const items = [
    aiItem,
    { sep: true },
    ...(el.type === "text" ? [{ label: el.live?.id ? tt("Régler le texte vivant") : tt("Rendre vivant (tenu à jour par un agent)"), icon: ICN["refresh-cw"], act: () => openLiveText(st, el) }] : []),
    { label: tt("Dupliquer"), icon: ICN.dup, act: () => duplicateEl(st, el.id) },
    { label: tt("Premier plan"), icon: ICN.front, act: () => reorder(st, el.id, "front") },
    { label: tt("Arrière-plan"), icon: ICN.back, act: () => reorder(st, el.id, "back") },
    { sep: true },
    { label: tt("Supprimer"), icon: ICN.trash, act: () => deleteEl(st, el.id) },
  ];
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement("div"); s.className = "ce-cm-sep"; menu.appendChild(s); return; }
    const b = document.createElement("button");
    b.innerHTML = `${it.icon}<span>${it.label}</span>`;
    b.addEventListener("click", () => { menu.remove(); it.act(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
  setTimeout(() => document.addEventListener("pointerdown", function h(ev) {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("pointerdown", h); }
  }));
}

// Bascule la barre de chat du workspace en mode « édition » : le prochain prompt
// envoyé modifie l'élément sélectionné via l'IA (appliqué directement, annulable).
function aiEditViaChat(st, el) {
  const label = el.type === "text" ? tt("Édition IA · texte") : el.type === "image" ? tt("Édition IA · image") : tt("Édition IA · forme");
  if (typeof ctx.requestChatEdit === "function") {
    ctx.requestChatEdit({
      label,
      onSubmit: (prompt) => aiEditElementDirect(st, el, prompt),
    });
  } else {
    // Repli : on remplit le panneau IA latéral.
    st.refs.body.querySelector(".ce-ai-prompt").value = "";
    st.refs.body.querySelector(".ce-ai-prompt").focus();
  }
}

function aiGenerateImageViaChat(st, el) {
  const imageConfig = imageGenerationConfig();
  const label = `${tt("Génération image IA")} · ${imageProviderLabel(imageConfig.provider)}`;
  if (typeof ctx.requestChatEdit === "function") {
    ctx.requestChatEdit({
      label,
      onSubmit: (prompt) => generateBonsaiForImageElement(st, el, prompt),
    });
  } else {
    st.refs.body.querySelector(".ce-ai-prompt").value = "";
    st.refs.body.querySelector(".ce-ai-prompt").placeholder = tt("Décris l'image à générer…");
    st.refs.body.querySelector(".ce-ai-prompt").focus();
    st.refs.status.textContent = tt("Décris l'image dans le panneau IA.");
  }
}

function promptForSelectedImage(st, el) {
  const promptBox = st.refs.body.querySelector(".ce-ai-prompt");
  const prompt = promptBox?.value?.trim() || "";
  if (!prompt) {
    promptBox.placeholder = tt("Décris l'image à générer…");
    promptBox.focus();
    st.refs.status.textContent = tt("Décris l'image à générer…");
    return;
  }
  generateBonsaiForImageElement(st, el, prompt);
}

function bonsaiSizeForElement(el) {
  const ratio = Math.max(0.2, Math.min(5, (el.w || 1) / Math.max(1, el.h || 1)));
  if (ratio > 1.25) return { width: 768, height: 512 };
  if (ratio < 0.8) return { width: 512, height: 768 };
  return { width: 512, height: 512 };
}


// Idem : l'erreur du moteur est traduite avant d'atteindre la barre d'état.
async function invokeImage(imageConfig, args) {
  try { return await invoke("bonsai_generate_to_sandbox_url", args); }
  catch (e) { throw new Error(imageErrorMessage(e, imageConfig.provider)); }
}

async function generateBonsaiForImageElement(st, el, prompt) {
  const status = st.refs.status;
  const sb = ctx.getCurrent();
  if (!sb) { status.textContent = tt("Aucune sandbox active"); return; }
  if (!prompt || !prompt.trim()) return;
  if (!st.doc.pages.some((p) => p.elements.includes(el))) { status.textContent = tt("Élément introuvable."); return; }
  const imageConfig = imageGenerationConfig();
  status.textContent = `${tt("Génération")} ${imageProviderLabel(imageConfig.provider)}…`;
  try {
    snapshot(st);
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const base = (st.doc.title || "document").replace(/[^\p{L}\p{N}_ -]+/gu, "").trim().replace(/\s+/g, "_").slice(0, 42) || "document";
    const size = bonsaiSizeForElement(el);
    const res = await invokeImage(imageConfig, {
      id: sb.id,
      path: `creative/${base}_${stamp}.png`,
      prompt: prompt.trim(),
      width: size.width,
      height: size.height,
      seed: null,
      steps: 4,
      backend: imageConfig.backend,
      provider: imageConfig.provider,
      apiBase: imageConfig.apiBase,
      apiKey: imageConfig.apiKey,
      apiModel: imageConfig.apiModel,
    });
    el.src = res.data_url;
    el.sandboxPath = res.path || `creative/${base}_${stamp}.png`;
    el.alt = prompt.trim().slice(0, 120);
    recordImageGeneration(1, imageConfig.provider);
    renderCanvas(st);
    ctx.requestSandboxRefresh();
    try { window.parent && window.parent.LumenRefreshSandbox && window.parent.LumenRefreshSandbox(res.sandbox_id || sb.id); } catch {}
    status.textContent = tt("Image générée ✓");
  } catch (e) {
    status.textContent = tt("Échec :") + " " + (e?.message || e);
    throw e;
  }
}

async function aiEditElementDirect(st, el, prompt) {
  const status = st.refs.status;
  if (!prompt || !prompt.trim()) return;
  // L'élément existe-t-il toujours (page courante) ?
  if (!st.doc.pages.some((p) => p.elements.includes(el))) { status.textContent = tt("Élément introuvable."); return; }
  status.textContent = tt("Réflexion…");
  try {
    const raw = await ollama(elementMessages(st, el, prompt, await creativeMemory(st, prompt)));
    const patch = parseJsonObject(raw);
    if (!patch) { status.textContent = tt("Réponse IA illisible."); return; }
    applyPatch(st, el, patch);
    status.textContent = tt("Appliqué ✓");
  } catch (e) {
    status.textContent = tt("Échec :") + " " + (e?.message || e);
  }
}

// ── Sélection : cadre + poignées (overlay non scalé) ─────────────────────────
function renderSelection(st) {
  st.refs.inner.querySelectorAll(".ce-handles").forEach((h) => h.remove());
  st.refs.inner.querySelectorAll(".ce-el.selected").forEach((n) => n.classList.remove("selected"));
  const el = curEl(st);
  if (!el) return;
  const node = st.refs.inner.querySelector(`.ce-el[data-id="${el.id}"]`);
  if (node) node.classList.add("selected");

  const z = st.zoom;
  const box = document.createElement("div");
  box.className = "ce-handles";
  box.style.cssText = `left:${el.x * z}px;top:${el.y * z}px;width:${el.w * z}px;height:${el.h * z}px;transform:rotate(${el.rotation}deg);`;
  const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  box.innerHTML = handles.map((h) => `<span class="ce-h ce-h-${h}" data-h="${h}"></span>`).join("") + `<span class="ce-rot" data-h="rot"></span>`;
  box.querySelectorAll("[data-h]").forEach((h) => h.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); e.preventDefault();
    if (h.dataset.h === "rot") startRotate(st, el, e);
    else startResize(st, el, e, h.dataset.h);
  }));
  st.refs.inner.appendChild(box);
}

// ── Déplacement avec guides d'alignement ─────────────────────────────────────
function startDrag(st, el, e) {
  commitTextEdit(st);
  e.preventDefault();
  const z = st.zoom;
  const sx = e.clientX, sy = e.clientY;
  const ox = el.x, oy = el.y;
  let moved = false;
  const page = curPage(st);
  try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {}
  const onMove = (ev) => {
    // Seuil avant de considérer un vrai déplacement : un clic simple ne doit pas
    // déclencher de re-rendu (sinon le double-clic d'édition de texte casse).
    if (!moved && Math.abs(ev.clientX - sx) < 3 && Math.abs(ev.clientY - sy) < 3) return;
    if (!moved) { snapshot(st); moved = true; }
    let nx = ox + (ev.clientX - sx) / z;
    let ny = oy + (ev.clientY - sy) / z;
    const snapped = applySnap(st, el, nx, ny, page);
    el.x = snapped.x; el.y = snapped.y;
    fastUpdate(st, el);
  };
  const onUp = (ev) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    try { e.currentTarget?.releasePointerCapture?.(ev.pointerId); } catch {}
    clearGuides(st);
    if (moved) renderCanvas(st); // pas de re-rendu sur clic simple
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function applySnap(st, el, nx, ny, page) {
  const tol = 6 / st.zoom;
  const guides = [];
  const cx = nx + el.w / 2, cy = ny + el.h / 2;
  // centres et bords de page
  const targetsX = [{ v: page.w / 2, kind: "cx" }, { v: 0, kind: "l" }, { v: page.w, kind: "r" }];
  const targetsY = [{ v: page.h / 2, kind: "cy" }, { v: 0, kind: "t" }, { v: page.h, kind: "b" }];
  for (const t of targetsX) {
    if (Math.abs(cx - t.v) < tol) { nx = t.v - el.w / 2; guides.push({ x: t.v }); }
    else if (Math.abs(nx - t.v) < tol) { nx = t.v; guides.push({ x: t.v }); }
    else if (Math.abs(nx + el.w - t.v) < tol) { nx = t.v - el.w; guides.push({ x: t.v }); }
  }
  for (const t of targetsY) {
    if (Math.abs(cy - t.v) < tol) { ny = t.v - el.h / 2; guides.push({ y: t.v }); }
    else if (Math.abs(ny - t.v) < tol) { ny = t.v; guides.push({ y: t.v }); }
    else if (Math.abs(ny + el.h - t.v) < tol) { ny = t.v - el.h; guides.push({ y: t.v }); }
  }
  drawGuides(st, guides, page);
  return { x: Math.round(nx), y: Math.round(ny) };
}

function drawGuides(st, guides, page) {
  clearGuides(st);
  const pageEl = st.refs.inner.querySelector(".ce-page");
  if (!pageEl) return;
  guides.forEach((g) => {
    const line = document.createElement("div");
    line.className = "ce-guide";
    if (g.x != null) line.style.cssText = `left:${g.x}px;top:0;width:0;height:${page.h}px;`;
    else line.style.cssText = `top:${g.y}px;left:0;height:0;width:${page.w}px;`;
    pageEl.appendChild(line);
  });
}
function clearGuides(st) { st.refs.inner.querySelectorAll(".ce-guide").forEach((g) => g.remove()); }

function fastUpdate(st, el) {
  const z = st.zoom;
  const node = st.refs.inner.querySelector(`.ce-el[data-id="${el.id}"]`);
  if (node) {
    node.style.left = el.x + "px";
    node.style.top = el.y + "px";
    node.style.width = el.w + "px";
    node.style.height = el.h + "px";
    node.style.transform = `rotate(${el.rotation}deg)`;
  }
  const box = st.refs.inner.querySelector(".ce-handles");
  if (box) { box.style.left = el.x * z + "px"; box.style.top = el.y * z + "px"; box.style.width = el.w * z + "px"; box.style.height = el.h * z + "px"; box.style.transform = `rotate(${el.rotation}deg)`; }
  if (el.type === "shape" && node) node.innerHTML = shapeSvg(el);
}

function startResize(st, el, e, dir) {
  commitTextEdit(st);
  const z = st.zoom;
  const sx = e.clientX, sy = e.clientY;
  const o = { x: el.x, y: el.y, w: el.w, h: el.h };
  let started = false;
  const onMove = (ev) => {
    if (!started) { snapshot(st); started = true; }
    const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
    let { x, y, w, h } = o;
    if (dir.includes("e")) w = Math.max(16, o.w + dx);
    if (dir.includes("s")) h = Math.max(16, o.h + dy);
    if (dir.includes("w")) { w = Math.max(16, o.w - dx); x = o.x + (o.w - w); }
    if (dir.includes("n")) { h = Math.max(16, o.h - dy); y = o.y + (o.h - h); }
    el.x = Math.round(x); el.y = Math.round(y); el.w = Math.round(w); el.h = Math.round(h);
    if (el.type === "text" && (dir === "e" || dir === "w")) {} // largeur libre, hauteur auto possible
    fastUpdate(st, el);
  };
  const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); renderCanvas(st); };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startRotate(st, el, e) {
  commitTextEdit(st);
  const node = st.refs.inner.querySelector(`.ce-el[data-id="${el.id}"]`);
  const r = node.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let started = false;
  const onMove = (ev) => {
    if (!started) { snapshot(st); started = true; }
    let deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    el.rotation = Math.round(deg);
    fastUpdate(st, el);
  };
  const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); renderCanvas(st); };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// ─────────────────────────────────────────────────────────────────────────────
// Insertion / opérations sur éléments
// ─────────────────────────────────────────────────────────────────────────────
function insertElement(st, kind) {
  if (kind === "dataviz") { pickDataVisual(st); return; }
  const page = curPage(st);
  const cx = page.w / 2, cy = page.h / 2;
  let el;
  snapshot(st);
  // Une image s'insère VIDE : le cadre porte deux gestes — bibliothèque de la
  // sandbox ou génération par l'IA (moteur des Réglages). Avant, le sélecteur
  // s'ouvrait d'office et obligeait à choisir un fichier même pour générer.
  if (kind === "image") el = imageEl({ x: cx - 180, y: cy - 120 });
  else if (kind === "text") el = textEl({ x: cx - 180, y: cy - 40, w: 360, h: 80, html: tt("Nouveau texte"), color: page.background && isDark(page.background) ? "#ffffff" : "#1d1d1f" });
  else if (kind === "table") {
    const dark = isDark(page.background);
    el = tableEl({
      x: cx - 260, y: cy - 70, w: 520,
      color: dark ? "#ffffff" : "#1d1d1f",
      headerBg: dark ? "rgba(255,255,255,0.12)" : "#f2f2f7",
      borderColor: dark ? "rgba(255,255,255,0.28)" : "#d1d1d6",
    });
  }
  else if (kind === "line") el = shapeEl({ shape: "line", x: cx - 150, y: cy, w: 300, h: 20, fill: "#1d1d1f" });
  else el = shapeEl({ shape: kind, x: cx - 110, y: cy - 80 });
  page.elements.push(el);
  st.selection = el.id;
  renderCanvas(st);
}

function deleteEl(st, id) { snapshot(st); const p = curPage(st); p.elements = p.elements.filter((e) => e.id !== id); if (st.selection === id) st.selection = null; renderCanvas(st); }
function duplicateEl(st, id) {
  snapshot(st);
  const p = curPage(st);
  const src = p.elements.find((e) => e.id === id);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid(); copy.x += 24; copy.y += 24;
  p.elements.push(copy); st.selection = copy.id; renderCanvas(st);
}
function reorder(st, id, where) {
  snapshot(st);
  const p = curPage(st);
  const i = p.elements.findIndex((e) => e.id === id);
  if (i < 0) return;
  const [el] = p.elements.splice(i, 1);
  if (where === "front") p.elements.push(el);
  else if (where === "back") p.elements.unshift(el);
  else if (where === "up") p.elements.splice(Math.min(p.elements.length, i + 1), 0, el);
  else if (where === "down") p.elements.splice(Math.max(0, i - 1), 0, el);
  renderCanvas(st);
}

function newCreative(st) {
  const fresh = starterDoc(st.kind);
  st.doc = fresh;
  st.pageIndex = 0;
  st.selection = null;
  st.path = "";
  st.undo.length = 0;
  st.redo.length = 0;
  st.refs.title.value = fresh.title;
  st.refs.win.setTitle?.(fresh.title);
  st.refs.status.textContent = tt(st.kind === "presentation" ? "Nouvelle présentation" : "Nouveau document");
  renderCanvas(st);
}

async function openCreativePicker(st) {
  const isDeck = st.kind === "presentation";
  const ext = isDeck ? ["lumenkey", "pptx"] : ["lumenpages", "docx"];
  const title = tt(isDeck ? "Ouvrir une présentation" : "Ouvrir un document");
  const sandboxes = await ctx.listSandboxes();
  const current = ctx.getCurrent();
  if (!sandboxes.length) { st.refs.status.textContent = tt("Aucune sandbox active"); return; }
  const initialId = current?.id && sandboxes.some((s) => s.id === current.id) ? current.id : sandboxes[0].id;
  const win = ctx.createWindow({ id: "ce-open-picker", title, w: 600, h: 520, x: 240, y: 120 });
  if (!win) return;
  win.body.innerHTML = `
    <div class="ce-open-shell">
      <label class="ce-open-sandbox"><span>${tt("Sandbox")}</span><select></select></label>
      <div class="ce-picker"><div class="ce-picker-empty">${tt("Chargement…")}</div></div>
    </div>`;
  const select = win.body.querySelector(".ce-open-sandbox select");
  const list = win.body.querySelector(".ce-picker");
  select.innerHTML = sandboxes.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === initialId ? " selected" : ""}>${escapeHtml(s.name || s.id)}</option>`).join("");
  const render = async () => {
    const sandboxId = select.value;
    list.innerHTML = `<div class="ce-picker-empty">${tt("Chargement…")}</div>`;
    const files = await listCreativeFiles(sandboxId, ext);
    if (!files.length) {
      list.innerHTML = `<div class="ce-picker-empty">${tt(isDeck ? "Aucune présentation dans cette sandbox." : "Aucun document dans cette sandbox.")}</div>`;
      return;
    }
    list.innerHTML = "";
    for (const file of files) {
      const row = document.createElement("button");
      row.className = "ce-doc-row";
      row.innerHTML = `
        <span class="ce-doc-row-ic">${ICN.file}</span>
        <span class="ce-doc-row-main"><b>${escapeHtml(file.name)}</b><small>${escapeHtml(file.path)}</small></span>`;
      row.addEventListener("click", async () => {
        ctx.closeWindow("ce-open-picker");
        await openCreativeFile(file.path, st.kind, sandboxId);
      });
      list.appendChild(row);
    }
  };
  select.addEventListener("change", render);
  await render();
}

async function listCreativeFiles(sandboxId, ext) {
  const out = [];
  async function walk(path, depth) {
    let list;
    try { list = await invoke("sandbox_read_dir", { id: sandboxId, path }); }
    catch { return; }
    for (const e of list) {
      if (e.is_dir) {
        if (depth < 5) await walk(e.path, depth + 1);
      } else if ([].concat(ext).includes(fileExt(e.name))) {
        out.push(e);
      }
    }
  }
  await walk("", 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function isDark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
}
function parseHex(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function relLum({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(a, b) {
  const ca = parseHex(a), cb = parseHex(b);
  if (!ca || !cb) return 21;
  const la = relLum(ca), lb = relLum(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function readableOn(bg) { return isDark(bg) ? "#ffffff" : "#1d1d1f"; }
// Garantit un texte lisible : couleur absente ou contraste trop faible avec le
// fond (bug fréquent après génération IA ou sur fond sombre) → bascule noir/blanc.
function ensureTextColor(color, bg) {
  const base = bg && bg !== "transparent" ? bg : "#ffffff";
  if (!color) return readableOn(base);
  if (contrastRatio(color, base) < 1.8) return readableOn(base);
  return color;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vignettes de pages
// ─────────────────────────────────────────────────────────────────────────────
function renderThumbs(st) {
  const wrap = st.refs.thumbs;
  wrap.innerHTML = "";
  // Largeur disponible réelle de la colonne (padding + cadre de la vignette
  // déduits) pour que les vignettes ne débordent jamais du panneau de gauche.
  const thumbW = Math.max(60, Math.min(150, (wrap.clientWidth || 182) - 32));
  st.doc.pages.forEach((page, i) => {
    const scale = thumbW / page.w;
    const t = document.createElement("div");
    t.className = "ce-thumb" + (i === st.pageIndex ? " active" : "");
    t.innerHTML = `
      <div class="ce-thumb-num">${i + 1}</div>
      <div class="ce-thumb-page" style="width:${thumbW}px;height:${page.h * scale}px;background:${page.background};"></div>
      <div class="ce-thumb-tools">
        <button data-tt="dup" title="${tt("Dupliquer")}">${ICN.dup}</button>
        <button data-tt="del" title="${tt("Supprimer")}">${ICN.trash}</button>
      </div>`;
    const mini = t.querySelector(".ce-thumb-page");
    page.elements.forEach((el) => {
      const m = document.createElement("div");
      m.style.cssText = `position:absolute;left:${el.x * scale}px;top:${el.y * scale}px;width:${el.w * scale}px;height:${el.h * scale}px;transform:rotate(${el.rotation}deg);overflow:hidden;`;
      if (el.type === "shape") m.innerHTML = shapeSvg(el);
      else if (el.type === "table") { m.style.fontSize = Math.max(2, el.fontSize * scale) + "px"; m.innerHTML = tableHtml(el, page.background); }
      else if (el.type === "image" && el.src) m.innerHTML = `<img src="${el.src}" style="width:100%;height:100%;object-fit:${el.fit};">`;
      else if (el.type === "text") { m.style.fontSize = Math.max(2, el.fontSize * scale) + "px"; m.style.color = ensureTextColor(el.color, el.bg && el.bg !== "transparent" ? el.bg : page.background); m.style.fontWeight = el.weight; m.style.lineHeight = el.lineHeight; m.style.textAlign = el.align; m.innerHTML = el.html; }
      mini.appendChild(m);
    });
    t.addEventListener("click", () => { st.pageIndex = i; st.selection = null; renderCanvas(st); });
    t.querySelector('[data-tt="dup"]').addEventListener("click", (e) => { e.stopPropagation(); snapshot(st); st.doc.pages.splice(i + 1, 0, JSON.parse(JSON.stringify(page))); st.pageIndex = i + 1; renderCanvas(st); });
    t.querySelector('[data-tt="del"]').addEventListener("click", (e) => { e.stopPropagation(); if (st.doc.pages.length <= 1) return; snapshot(st); st.doc.pages.splice(i, 1); st.pageIndex = Math.max(0, st.pageIndex - (i <= st.pageIndex ? 1 : 0)); st.selection = null; renderCanvas(st); });
    wrap.appendChild(t);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspecteur de propriétés
// ─────────────────────────────────────────────────────────────────────────────
function renderInspector(st) {
  const insp = st.refs.insp;
  const el = curEl(st);
  if (!el) {
    const page = curPage(st);
    insp.innerHTML = `
      <div class="ce-insp-sect"><div class="ce-insp-t">${tt(st.kind === "presentation" ? "Diapositive" : "Page")}</div>
        ${rowColor(tt("Fond"), "page-bg", page.background)}
        <label class="ce-frow"><span>${tt("Numéroter les pages")}</span><input type="checkbox" data-doc="pageNumbers"${st.doc.pageNumbers === false ? "" : " checked"}></label>
        <div class="ce-frow"><span>${tt("Taille")}</span><b>${page.w} × ${page.h} px</b></div>
      </div>
      <div class="ce-insp-empty">${tt("Sélectionnez un élément pour l'éditer.")}</div>`;
    insp.querySelector('[data-prop="page-bg"]').addEventListener("input", (e) => { snapshotThrottled(st); page.background = e.target.value; renderCanvas(st, true); });
    insp.querySelector('[data-doc="pageNumbers"]').addEventListener("change", (e) => { st.doc.pageNumbers = e.target.checked; });
    return;
  }
  let html = `<div class="ce-insp-sect"><div class="ce-insp-t">${tt("Disposition")}</div>
    <div class="ce-grid2">
      ${rowNum("X", "x", el.x)}${rowNum("Y", "y", el.y)}
      ${rowNum("L", "w", el.w)}${rowNum("H", "h", el.h)}
      ${rowNum("∠", "rotation", el.rotation)}${rowNum(tt("Opac%"), "opacity", Math.round(el.opacity * 100))}
    </div>
    <div class="ce-layer-row">
      <button data-layer="back" title="${tt("Arrière-plan")}">${ICN.back}</button>
      <button data-layer="down">↓</button>
      <button data-layer="up">↑</button>
      <button data-layer="front" title="${tt("Premier plan")}">${ICN.front}</button>
      <span class="ce-sep"></span>
      <button data-layer="dup" title="${tt("Dupliquer")}">${ICN.dup}</button>
      <button data-layer="del" title="${tt("Supprimer")}">${ICN.trash}</button>
    </div>
  </div>`;

  if (el.type === "text") {
    html += `<div class="ce-insp-sect"><div class="ce-insp-t">${tt("Texte")}</div>
      <div class="ce-fmt"><button data-fmt="bold"><b>B</b></button><button data-fmt="italic"><i>I</i></button><button data-fmt="underline"><u>U</u></button></div>
      <div class="ce-grid2">${rowNum(tt("Taille"), "fontSize", el.fontSize)}${rowNum(tt("Inter."), "lineHeight", el.lineHeight, 0.1)}</div>
      <label class="ce-frow"><span>${tt("Police")}</span><select data-prop="fontFamily">
        <option value="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif">SF Pro</option>
        <option value="ui-serif, Georgia, 'Times New Roman', serif">Serif</option>
        <option value="'SF Mono', ui-monospace, Menlo, monospace">Mono</option>
        <option value="'Helvetica Neue', Arial, sans-serif">Helvetica</option>
        <option value="Georgia, serif">Georgia</option>
      </select></label>
      <label class="ce-frow"><span>${tt("Graisse")}</span><select data-prop="weight">
        <option value="300">Light</option><option value="400">Regular</option><option value="600">Semibold</option><option value="700">Bold</option><option value="800">Heavy</option>
      </select></label>
      <div class="ce-align"><button data-align="left">⬅</button><button data-align="center">↔</button><button data-align="right">➡</button><button data-align="justify">≣</button></div>
      ${rowColor(tt("Couleur"), "color", el.color)}
      ${rowColor(tt("Fond"), "bg", el.bg === "transparent" ? "#ffffff" : el.bg)}
    </div>`;
  } else if (el.type === "image") {
    html += `<div class="ce-insp-sect"><div class="ce-insp-t">${tt("Image")}</div>
      <button class="ce-btn" data-act="replace-img">${tt("Remplacer…")}</button>
      <button class="ce-btn primary" data-act="generate-img">${ICN.ai}${tt("Générer image IA")}</button>
      <label class="ce-frow"><span>${tt("Cadrage")}</span><select data-prop="fit"><option value="cover">Cover</option><option value="contain">Contain</option><option value="fill">Fill</option></select></label>
      ${rowNum(tt("Coins"), "radius", el.radius)}
    </div>`;
  } else if (el.type === "table") {
    html += `<div class="ce-insp-sect"><div class="ce-insp-t">${tt("Tableau")}</div>
      <div class="ce-layer-row">
        <button data-tbl="row-add" title="${tt("Ajouter une ligne")}">+↔</button>
        <button data-tbl="row-del" title="${tt("Supprimer la dernière ligne")}">−↔</button>
        <button data-tbl="col-add" title="${tt("Ajouter une colonne")}">+↕</button>
        <button data-tbl="col-del" title="${tt("Supprimer la dernière colonne")}">−↕</button>
      </div>
      <label class="ce-frow"><span>${tt("Ligne d'en-tête")}</span><input type="checkbox" data-prop="header"${el.header ? " checked" : ""}></label>
      <label class="ce-frow"><span>${tt("Lignes alternées")}</span><input type="checkbox" data-prop="zebra"${el.zebra ? " checked" : ""}></label>
      <div class="ce-grid2">${rowNum(tt("Taille"), "fontSize", el.fontSize)}</div>
      ${rowColor(tt("Texte"), "color", el.color)}
      ${rowColor(tt("Bordures"), "borderColor", /^#/.test(el.borderColor) ? el.borderColor : "#d1d1d6")}
      ${rowColor(tt("Fond d'en-tête"), "headerBg", /^#/.test(el.headerBg) ? el.headerBg : "#f2f2f7")}
      <div class="ce-align"><button data-align="left">⬅</button><button data-align="center">↔</button><button data-align="right">➡</button></div>
    </div>`;
  } else if (el.type === "shape") {
    html += `<div class="ce-insp-sect"><div class="ce-insp-t">${tt("Forme")}</div>
      ${rowColor(tt("Remplissage"), "fill", el.fill)}
      ${rowColor(tt("Contour"), "stroke", el.stroke === "transparent" ? "#000000" : el.stroke)}
      ${rowNum(tt("Épais."), "strokeWidth", el.strokeWidth)}
      ${el.shape === "rect" ? rowNum(tt("Coins"), "radius", el.radius) : ""}
    </div>`;
  }
  insp.innerHTML = html;
  wireInspector(st, el);
}

function rowNum(label, prop, val, step = 1) {
  return `<label class="ce-num"><span>${label}</span><input type="number" step="${step}" data-prop="${prop}" value="${val}"></label>`;
}
function rowColor(label, prop, val) {
  return `<label class="ce-frow"><span>${label}</span><input type="color" data-prop="${prop}" value="${val}"></label>`;
}

function wireInspector(st, el) {
  const insp = st.refs.insp;
  insp.querySelectorAll("[data-prop]").forEach((inp) => {
    inp.addEventListener("input", () => {
      snapshotThrottled(st);
      const prop = inp.dataset.prop;
      let v = inp.value;
      if (inp.type === "number") v = parseFloat(v) || 0;
      if (inp.type === "checkbox") v = inp.checked;
      if (prop === "opacity") el.opacity = Math.max(0, Math.min(1, v / 100));
      else if (prop === "bg") el.bg = v;
      else el[prop] = v;
      renderCanvas(st, true);
    });
  });
  insp.querySelector('[data-prop="fontFamily"]') && (insp.querySelector('[data-prop="fontFamily"]').value = el.fontFamily);
  insp.querySelector('[data-prop="weight"]') && (insp.querySelector('[data-prop="weight"]').value = String(el.weight));
  insp.querySelector('[data-prop="fit"]') && (insp.querySelector('[data-prop="fit"]').value = el.fit);

  insp.querySelectorAll("[data-align]").forEach((b) => b.addEventListener("click", () => { snapshot(st); el.align = b.dataset.align; renderCanvas(st); }));
  insp.querySelectorAll("[data-fmt]").forEach((b) => b.addEventListener("click", () => {
    // Mise en forme inline : nécessite l'édition de texte active.
    const node = st.refs.inner.querySelector(`.ce-el[data-id="${el.id}"] .ce-text-inner`);
    if (!node) return;
    node.setAttribute("contenteditable", "true"); node.focus();
    document.execCommand(b.dataset.fmt, false, null);
    el.html = node.innerHTML;
  }));
  insp.querySelectorAll("[data-layer]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.layer;
    if (a === "del") deleteEl(st, el.id);
    else if (a === "dup") duplicateEl(st, el.id);
    else reorder(st, el.id, a);
  }));
  insp.querySelectorAll("[data-tbl]").forEach((b) => b.addEventListener("click", () => {
    snapshot(st);
    const cols = el.rows[0]?.length || 1;
    switch (b.dataset.tbl) {
      case "row-add": el.rows.push(Array.from({ length: cols }, () => "")); el.h += 30; break;
      case "row-del": if (el.rows.length > 1) { el.rows.pop(); el.h = Math.max(40, el.h - 30); } break;
      case "col-add": el.rows.forEach((row, r) => row.push(r === 0 && el.header ? `${tt("Colonne")} ${cols + 1}` : "")); break;
      case "col-del": if (cols > 1) el.rows.forEach((row) => row.pop()); break;
      default: break;
    }
    renderCanvas(st);
  }));
  insp.querySelector('[data-act="replace-img"]')?.addEventListener("click", () => pickImage(st, el));
  insp.querySelector('[data-act="generate-img"]')?.addEventListener("click", () => promptForSelectedImage(st, el));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sélecteur d'images sandbox
// ─────────────────────────────────────────────────────────────────────────────
// Le sélecteur d'image liste les images de N'IMPORTE quelle sandbox, pas
// seulement de l'active : un document rassemble souvent des visuels produits
// dans plusieurs projets. La sandbox retenue est mémorisée sur l'élément pour
// que l'image se recharge du bon endroit à la réouverture.
async function pickImage(st, el) {
  const sandboxes = await ctx.listSandboxes();
  const current = ctx.getCurrent();
  if (!sandboxes.length && !current) return;
  const initialId = el.sandboxId && sandboxes.some((s) => s.id === el.sandboxId) ? el.sandboxId
    : current?.id && sandboxes.some((s) => s.id === current.id) ? current.id
    : (sandboxes[0]?.id || current?.id);
  const win = ctx.createWindow({ id: "ce-image-picker", title: tt("Insérer une image"), w: 720, h: 560, x: 220, y: 120 });
  if (!win) return;
  win.body.innerHTML = `
    <div class="ce-open-shell">
      <label class="ce-open-sandbox"><span>${tt("Sandbox")}</span><select></select></label>
      <div class="ce-picker ce-image-picker-grid"><div class="ce-picker-empty">${tt("Chargement…")}</div></div>
    </div>`;
  const select = win.body.querySelector(".ce-open-sandbox select");
  const list = win.body.querySelector(".ce-picker");
  const options = sandboxes.length ? sandboxes : [current];
  select.innerHTML = options.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === initialId ? " selected" : ""}>${escapeHtml(s.name || s.id)}</option>`).join("");
  const render = async () => {
    const sandboxId = select.value;
    list.innerHTML = `<div class="ce-picker-empty">${tt("Chargement…")}</div>`;
    const imgs = await ctx.listSandboxImages(sandboxId);
    if (select.value !== sandboxId) return; // l'utilisateur a déjà changé de sandbox
    if (!imgs.length) { list.innerHTML = `<div class="ce-picker-empty">${tt("Aucune image dans cette sandbox.")}</div>`; return; }
    list.innerHTML = "";
    for (const img of imgs) {
      const b = document.createElement("button");
      b.className = "ce-picker-row";
      b.innerHTML = `
        <span class="ce-picker-thumb"><span class="ce-picker-loading">${ICN.image}</span></span>
        <span class="ce-picker-name">${escapeHtml(img.name || img.path)}</span>`;
      const thumb = b.querySelector(".ce-picker-thumb");
      readSandboxImageDataUrl(sandboxId, img).then((src) => {
        thumb.innerHTML = `<img src="${src}" alt="">`;
      }).catch(() => {
        thumb.innerHTML = `<span class="ce-picker-loading">${ICN.image}</span>`;
      });
      b.addEventListener("click", async () => {
        const src = await readSandboxImageDataUrl(sandboxId, img);
        snapshot(st);
        el.src = src;
        el.sandboxPath = img.path; el.sandboxId = sandboxId; el.alt = img.name;
        ctx.closeWindow("ce-image-picker");
        if (!curPage(st).elements.includes(el)) curPage(st).elements.push(el);
        st.selection = el.id;
        renderCanvas(st);
      });
      list.appendChild(b);
    }
  };
  select.addEventListener("change", render);
  await render();
}

// ─────────────────────────────────────────────────────────────────────────────
// Visuels de données liés (rapports de l'app Analyse de données)
// ─────────────────────────────────────────────────────────────────────────────
// Un élément issu d'un rapport porte `dataRef` { sandboxId, path, pageId,
// visualId } : la capture est refaite par l'app, hors écran, avec les données
// du moment (« Actualiser les données »).
const VIZ_LABELS = { card: "Carte", multicard: "Cartes multiples", gauge: "Jauge", bar: "Histogramme", barstacked: "Histogramme empilé", hbar: "Barres", hbarstacked: "Barres empilées", line: "Courbes", area: "Aires", combo: "Barres + courbe", pie: "Secteurs", donut: "Anneau", treemap: "Compartimentage", funnel: "Entonnoir", waterfall: "Cascade", scatter: "Nuage de points", radar: "Radar", table: "Table", matrix: "Matrice", text: "Zone de texte", ai: "Analyse IA" };

async function listDataReports() {
  const out = [];
  for (const sb of await ctx.listSandboxes()) {
    let entries = [];
    try { entries = (await invoke("sandbox_read_dir", { id: sb.id, path: "Rapports" })) || []; } catch { continue; }
    for (const e of entries) {
      if (e.is_dir || !/\.json$/i.test(e.name) || e.name.startsWith("._")) continue;
      try {
        const raw = await invoke("sandbox_read_file", { id: sb.id, path: `Rapports/${e.name}` });
        const spec = JSON.parse(typeof raw === "string" ? raw : raw?.content || "null");
        if (spec?.kind === "lumen-report") out.push({ sb, path: `Rapports/${e.name}`, spec });
      } catch {}
    }
  }
  return out.sort((a, b) => (b.spec.updatedAt || 0) - (a.spec.updatedAt || 0));
}

function vizLabel(v) {
  const m = v.values?.[0];
  const what = v.title || (m?.col ? `${m.col}${v.axis?.col ? ` ${tt("par")} ${v.axis.col}` : ""}` : v.axis?.col || "");
  return what || tt(VIZ_LABELS[v.type] || v.type);
}

async function pickDataVisual(st) {
  if (!ctx.captureReportVisuals) { st.refs.status.textContent = tt("Indisponible ici : ouvrez Opus depuis le bureau."); return; }
  const win = ctx.createWindow({ id: "ce-dataviz-picker", title: tt("Insérer un visuel de données"), w: 640, h: 560, x: 240, y: 110 });
  if (!win) return;
  win.body.innerHTML = `<div class="ce-open-shell"><div class="ce-picker ce-dataviz-list"><div class="ce-picker-empty">${tt("Recherche des rapports…")}</div></div></div>`;
  const list = win.body.querySelector(".ce-picker");
  const reports = await listDataReports();
  if (!reports.length) { list.innerHTML = `<div class="ce-picker-empty">${tt("Aucun rapport. Créez-en un dans l'app Analyse de données.")}</div>`; return; }
  list.innerHTML = reports.map((r, ri) => `<div class="ce-dv-report"><div class="ce-dv-head"><b>${escapeHtml(r.spec.name || r.path)}</b><small>${escapeHtml(r.sb.name || "")}</small></div>
    ${(r.spec.pages || []).map((p) => `<div class="ce-dv-page"><div class="ce-dv-pagehead"><span>${escapeHtml(p.name || "")}</span>${(p.visuals || []).length > 1 ? `<button class="ce-dv-all" data-r="${ri}" data-page="${escapeHtml(p.id)}">${tt("Toute la page")}</button>` : ""}</div>
      ${(p.visuals || []).filter((v) => v.type !== "slicer").map((v) => `<button class="ce-picker-row ce-dv-row" data-r="${ri}" data-page="${escapeHtml(p.id)}" data-v="${escapeHtml(v.id)}"><span class="ce-dv-type">${escapeHtml(tt(VIZ_LABELS[v.type] || v.type))}</span><span class="ce-picker-name">${escapeHtml(vizLabel(v))}</span></button>`).join("")}</div>`).join("")}</div>`).join("");
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-r]");
    if (!b) return;
    const r = reports[Number(b.dataset.r)];
    const page = (r.spec.pages || []).find((p) => p.id === b.dataset.page);
    const visuals = b.dataset.v ? page.visuals.filter((v) => v.id === b.dataset.v) : page.visuals.filter((v) => v.type !== "slicer");
    list.innerHTML = `<div class="ce-picker-empty">${tt("Calcul et capture du visuel…")}</div>`;
    try {
      const res = await ctx.captureReportVisuals({ sandboxId: r.sb.id, path: r.path, items: visuals.map((v) => ({ pageId: page.id, visualId: v.id })) });
      const ok = (res.items || []).filter((x) => x.cap);
      if (!ok.length) throw new Error(res.items?.[0]?.error || tt("Rien à insérer."));
      snapshot(st);
      placeDataVisuals(st, ok, b.dataset.v ? null : visuals);
      ctx.closeWindow("ce-dataviz-picker");
      st.refs.status.textContent = tt("{n} visuel(s) inséré(s) — liés au rapport « {r} ».", { n: ok.length, r: res.report || r.spec.name });
    } catch (err) {
      list.innerHTML = `<div class="ce-picker-empty">${escapeHtml(String(err?.message || err))}</div>`;
    }
  });
}

/** Éléments d'une capture dans la boîte donnée (titre + image / tableau / texte). */
function dataVisualElements(st, it, box, page) {
  const dark = isDark(page.background);
  const ink = dark ? "#f5f5f7" : "#1d1d1f";
  const els = [];
  let { x, y, w, h } = box;
  if (it.title && it.cap.kind !== "text") {
    els.push(textEl({ x, y, w, h: 30, html: escapeHtml(it.title), fontSize: 18, weight: 650, color: ink }));
    els.at(-1).dataRef = { ...it.dataRef, part: "title" };
    y += 36; h -= 36;
  }
  let el;
  if (it.cap.kind === "image") {
    const ih = Math.max(60, Math.min(h, Math.round(w * (it.cap.h / it.cap.w))));
    el = imageEl({ x, y, w, h: ih, src: it.cap.png, sandboxPath: it.sandboxPath || "", sandboxId: it.sandboxId || "", fit: "contain", radius: 8, alt: it.title });
  } else if (it.cap.kind === "table") {
    const rows = it.cap.rows.slice(0, Math.max(2, Math.floor(h / 28))).map((r) => r.map((c) => escapeHtml(c)));
    el = tableEl({ x, y, w, rows, h: rows.length * 28 + 4, fontSize: 13, color: ink, headerBg: dark ? "rgba(255,255,255,0.12)" : "#f2f2f7", borderColor: dark ? "rgba(255,255,255,0.28)" : "#d1d1d6" });
  } else {
    el = textEl({ x, y, w, h: Math.min(h, 80 + it.cap.text.length / 2), html: it.cap.html, fontSize: 16, color: ink, lineHeight: 1.45 });
  }
  el.dataRef = it.dataRef;
  els.push(el);
  return els;
}

function placeDataVisuals(st, items, gridVisuals) {
  const page = curPage(st);
  const m = st.kind === "presentation" ? 64 : 72;
  const added = [];
  if (gridVisuals && items.length > 1) {
    // Page entière : on reproduit la grille 12 colonnes du rapport.
    const byId = new Map(gridVisuals.map((v) => [v.id, v]));
    const maxY = Math.max(1, ...gridVisuals.map((v) => v.y + v.h));
    const top = st.kind === "presentation" ? m : Math.max(m, ...page.elements.map((e) => e.y + e.h + 20));
    const sx = (page.w - m * 2) / 12, sy = Math.min((page.h - top - m / 2) / maxY, 40);
    for (const it of items) {
      const v = byId.get(it.visualId);
      if (!v) continue;
      added.push(...dataVisualElements(st, it, { x: m + v.x * sx + 6, y: top + v.y * sy + 6, w: v.w * sx - 12, h: v.h * sy - 12 }, page));
    }
  } else {
    const w = Math.min(page.w - m * 2, st.kind === "presentation" ? 900 : page.w - m * 2);
    let y = st.kind === "presentation" ? Math.max(m, (page.h - w * 0.55) / 2) : Math.max(m, ...page.elements.map((e) => e.y + e.h + 24));
    for (const it of items) {
      const h = it.cap.kind === "image" ? Math.round(w * (it.cap.h / it.cap.w)) + 36 : 260;
      const els = dataVisualElements(st, it, { x: (page.w - w) / 2, y: Math.min(y, page.h - m - Math.min(h, page.h - m * 2)), w, h: Math.min(h, page.h - m * 2) }, page);
      added.push(...els);
      y = Math.max(...els.map((e) => e.y + e.h)) + 24;
    }
  }
  page.elements.push(...added);
  st.selection = added.at(-1)?.id || null;
  renderCanvas(st);
}

/** Recalcule les visuels liés : l'élément sélectionné s'il est lié, sinon tout le document. */
async function refreshDataVisuals(st) {
  const status = st.refs.status;
  if (!ctx.captureReportVisuals) { status.textContent = tt("Indisponible ici : ouvrez Opus depuis le bureau."); return; }
  const sel = curEl(st);
  const all = st.doc.pages.flatMap((p) => p.elements.filter((e) => e.dataRef?.visualId));
  const targets = sel?.dataRef?.visualId ? all.filter((e) => e.dataRef.visualId === sel.dataRef.visualId) : all;
  if (!targets.length) { status.textContent = tt("Aucun visuel lié à un rapport dans ce document."); return; }
  const groups = new Map();
  for (const e of targets) {
    const k = `${e.dataRef.sandboxId}\n${e.dataRef.path}`;
    if (!groups.has(k)) groups.set(k, { sandboxId: e.dataRef.sandboxId, path: e.dataRef.path, items: new Map() });
    groups.get(k).items.set(e.dataRef.visualId, { pageId: e.dataRef.pageId, visualId: e.dataRef.visualId });
  }
  status.textContent = tt("Actualisation des données…");
  let n = 0;
  const errors = [];
  snapshot(st);
  for (const g of groups.values()) {
    try {
      const res = await ctx.captureReportVisuals({ sandboxId: g.sandboxId, path: g.path, items: [...g.items.values()] });
      for (const it of res.items || []) {
        if (!it.cap) { if (it.error) errors.push(it.error); continue; }
        for (const e of targets.filter((x) => x.dataRef.visualId === it.visualId && x.dataRef.path === g.path)) {
          if (e.dataRef.part === "title") { if (it.title) e.html = escapeHtml(it.title); continue; }
          if (e.type === "image" && it.cap.kind === "image") { e.src = it.cap.png; if (it.sandboxPath) { e.sandboxPath = it.sandboxPath; e.sandboxId = it.sandboxId; } }
          else if (e.type === "table" && it.cap.kind === "table") { const rows = it.cap.rows.slice(0, 40).map((r) => r.map((c) => escapeHtml(c))); e.h = Math.round((e.h / Math.max(1, e.rows.length)) * rows.length); e.rows = rows; }
          else if (e.type === "text" && it.cap.kind === "text") e.html = it.cap.html;
          e.dataRef = { ...e.dataRef, at: Date.now() };
          n++;
        }
      }
    } catch (err) { errors.push(String(err?.message || err)); }
  }
  renderCanvas(st);
  status.textContent = errors.length ? `${tt("{n} élément(s) actualisé(s)", { n })} — ${errors[0]}` : tt("{n} élément(s) actualisé(s) ✓", { n });
}

const pickerImageCache = new Map();
async function readSandboxImageDataUrl(sandboxId, img) {
  const key = `${sandboxId}:${img.path}`;
  if (pickerImageCache.has(key)) return pickerImageCache.get(key);
  const b64 = await invoke("sandbox_read_b64", { id: sandboxId, path: img.path });
  const src = `data:${IMG_MIME[fileExt(img.name || img.path)] || "image/png"};base64,${b64}`;
  pickerImageCache.set(key, src);
  return src;
}

async function hydrateImages(st) {
  const current = ctx.getCurrent();
  for (const page of st.doc.pages) {
    for (const el of page.elements) {
      if (el.type === "image" && !el.src && el.sandboxPath) {
        // L'image vient de la sandbox mémorisée sur l'élément (choisie dans le
        // sélecteur ou reçue via le bus) ; la sandbox active n'est qu'un repli
        // pour les documents antérieurs qui ne la notaient pas.
        const id = el.sandboxId || current?.id;
        if (!id) continue;
        try {
          const b64 = await invoke("sandbox_read_b64", { id, path: el.sandboxPath });
          el.src = `data:${IMG_MIME[fileExt(el.sandboxPath)] || "image/png"};base64,${b64}`;
        } catch {}
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IA (Ollama) — par élément ou page entière
// ─────────────────────────────────────────────────────────────────────────────
async function runAI(st, scope) {
  const prompt = st.refs.body.querySelector(".ce-ai-prompt").value.trim();
  const status = st.refs.status;
  if (!prompt) { status.textContent = tt("Décris d'abord la modification."); return; }
  status.textContent = tt("Réflexion…");
  try {
    if (scope === "element") {
      const el = curEl(st);
      if (!el) { status.textContent = tt("Sélectionne un élément."); return; }
      if (el.type === "image") {
        promptForSelectedImage(st, el);
        return;
      }
      const raw = await ollama(elementMessages(st, el, prompt, await creativeMemory(st, prompt)));
      const patch = parseJsonObject(raw);
      if (!patch) { status.textContent = tt("Réponse IA illisible."); return; }
      if (st.aiMode === "direct") { applyPatch(st, el, patch); status.textContent = tt("Appliqué ✓"); }
      else showElementDiff(st, el, patch);
    } else {
      const raw = await ollama(pageMessages(st, prompt, await creativeMemory(st, prompt)));
      const arr = parseJsonArray(raw);
      if (!arr) { status.textContent = tt("Réponse IA illisible."); return; }
      if (st.aiMode === "direct") { snapshot(st); curPage(st).elements = normalizeEls(arr, curPage(st).background); st.selection = null; renderCanvas(st); status.textContent = tt("Page régénérée ✓"); }
      else showPageDiff(st, arr);
    }
  } catch (e) {
    status.textContent = tt("Échec :") + " " + (e?.message || e);
  }
}

// Souvenirs utiles (mémoire cognitive) pour cette demande : une DONNÉE du prompt.
async function creativeMemory(st, userPrompt) {
  const app = st.kind === "presentation" ? "présentation" : "document";
  return (await recallPromptBlock(invoke, `${app} ${userPrompt}`, { context: "bar", limit: 4, title: `Souvenirs utiles pour ce ${app}` })) || "";
}
// Champs modifiables d'un élément, selon son type.
function elementFields(el) {
  return el.type === "text" ? `html (texte, peut contenir <b><i><br>), color (hex), bg (hex ou "transparent"), fontSize (nombre), weight (300-800), align (left|center|right|justify), lineHeight`
    : el.type === "shape" ? `fill (hex), stroke (hex ou "transparent"), strokeWidth (nombre), radius (nombre)`
      : `fit (cover|contain|fill), radius (nombre)`;
}
function elementMessages(st, el, prompt, memory) {
  return SANDBOX_PROMPTS["app.creative.element"].build({ element: stripEl(el), fields: elementFields(el), request: prompt, memory, kind: st.kind }).messages;
}
function pageMessages(st, prompt, memory) {
  const page = curPage(st);
  return SANDBOX_PROMPTS["app.creative.page"].build({ request: prompt, kind: st.kind, background: page.background, dark: isDark(page.background), memory }).messages;
}
function stripEl(el) { const { id, ...rest } = el; if (rest.src) rest.src = "(image)"; return rest; }

function applyPatch(st, el, patch) {
  snapshot(st);
  const allow = el.type === "text" ? ["html", "color", "bg", "fontSize", "weight", "align", "lineHeight", "fontFamily", "letterSpacing"]
    : el.type === "shape" ? ["fill", "stroke", "strokeWidth", "radius"]
    : ["fit", "radius", "alt"];
  for (const k of allow) if (patch[k] != null) el[k] = patch[k];
  if (el.type === "text") el.color = ensureTextColor(el.color, el.bg && el.bg !== "transparent" ? el.bg : curPage(st).background);
  renderCanvas(st);
}

function normalizeEls(arr, pageBg) {
  return arr.map((o) => {
    if (o.type === "image") return imageEl(o);
    if (o.type === "shape") return shapeEl(o);
    const el = textEl(o);
    // Couleur lisible garantie : l'IA omet souvent `color` ou propose une teinte
    // proche du fond → texte invisible. On corrige dès la création.
    el.color = ensureTextColor(o.color, el.bg && el.bg !== "transparent" ? el.bg : pageBg);
    return el;
  });
}

function showElementDiff(st, el, patch) {
  const before = JSON.stringify(stripEl(el), null, 2);
  const merged = { ...el };
  const allow = el.type === "text" ? ["html", "color", "bg", "fontSize", "weight", "align", "lineHeight"] : el.type === "shape" ? ["fill", "stroke", "strokeWidth", "radius"] : ["fit", "radius", "alt"];
  for (const k of allow) if (patch[k] != null) merged[k] = patch[k];
  const after = JSON.stringify(stripEl(merged), null, 2);
  showDiffPanel(st, before, after, () => applyPatch(st, el, patch));
}
function showPageDiff(st, arr) {
  const before = JSON.stringify(curPage(st).elements.map(stripEl), null, 2);
  const after = JSON.stringify(normalizeEls(arr, curPage(st).background).map(stripEl), null, 2);
  showDiffPanel(st, before, after, () => { snapshot(st); curPage(st).elements = normalizeEls(arr, curPage(st).background); st.selection = null; renderCanvas(st); });
}

function showDiffPanel(st, before, after, apply) {
  const diff = st.refs.diff;
  const blocks = diffLines(before, after);
  diff.hidden = false; diff.innerHTML = "";
  if (countChanges(blocks) === 0) { diff.textContent = tt("Aucune modification proposée."); return; }
  const bar = document.createElement("div");
  bar.className = "diff-toolbar";
  const ok = document.createElement("button"); ok.className = "diff-mini"; ok.textContent = tt("Appliquer");
  const no = document.createElement("button"); no.className = "diff-mini"; no.textContent = tt("Refuser");
  ok.addEventListener("click", () => { apply(); diff.hidden = true; diff.innerHTML = ""; st.refs.status.textContent = tt("Appliqué ✓"); });
  no.addEventListener("click", () => { diff.hidden = true; diff.innerHTML = ""; st.refs.status.textContent = tt("Refusé"); });
  bar.append(ok, no); diff.appendChild(bar);
  const view = document.createElement("div"); view.className = "diff-view monokai";
  for (const b of blocks) {
    if (b.type === "eq") b.lines.slice(0, 4).forEach((t) => view.appendChild(diffRow(t, "diff-ctx", " ")));
    else { b.del.forEach((t) => view.appendChild(diffRow(t, "diff-del", "−"))); b.ins.forEach((t) => view.appendChild(diffRow(t, "diff-ins", "+"))); }
  }
  diff.appendChild(view);
}
function diffRow(txt, cls, g) { const r = document.createElement("div"); r.className = "diff-line " + cls; r.innerHTML = `<span class="diff-gutter">${g}</span><code>${escapeHtml(txt) || "&nbsp;"}</code>`; return r; }

function parseJsonObject(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function parseJsonArray(raw) {
  const m = String(raw).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function ollama(messages) {
  // Backend unifié : Ollama natif OU API cloud (OpenAI) selon la config.
  const { content: out, data } = await llmChat(messages, { json: true, rawSystem: true });
  recordOllamaUsage(data, "creative");
  return out || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Enregistrement / export / historique
// ─────────────────────────────────────────────────────────────────────────────
function rmDataUris(doc) {
  // On ne stocke pas les data: dans le JSON (poids) quand l'image a un fichier
  // de sandbox d'où se recharger. Une image reçue en data: seule (menu
  // contextuel, presse-papier) n'a pas d'autre source : on la garde, sinon
  // elle disparaîtrait à la réouverture.
  const clone = JSON.parse(JSON.stringify(doc));
  for (const p of clone.pages) for (const el of p.elements) if (el.type === "image" && el.sandboxPath) delete el.src;
  return clone;
}

async function saveCreative(st, exported) {
  // Document venu d'un fichier Office : on le réécrit dans son format.
  if (!exported && (st.format === "docx" || st.format === "pptx")) return saveOffice(st, st.format, false);
  const sb = st.sandboxId ? { id: st.sandboxId } : ctx.getCurrent();
  const status = st.refs.status;
  if (!sb) { status.textContent = tt("Aucune sandbox active"); return; }
  const rawTitle = (st.doc.title || "").trim() || (st.kind === "presentation" ? "Presentation" : "Document");
  const safe = rawTitle.replace(/[^\p{L}\p{N}_ -]+/gu, "").trim().replace(/\s+/g, "_") || "Document";
  const ext = exported ? "html" : (st.kind === "presentation" ? "lumenkey" : "lumenpages");
  const targetPath = !exported && st.path ? st.path : `${safe}.${ext}`;
  const staticHtml = renderStaticHtml(st);
  const content = exported
    ? staticHtml
    : JSON.stringify({ kind: st.kind, title: rawTitle, doc: rmDataUris(st.doc), html: staticHtml, updatedAt: Date.now() }, null, 2);
  try {
    await invoke("sandbox_write_file", { id: sb.id, path: exported ? `${safe}.${ext}` : targetPath, content });
    if (!exported) { st.path = targetPath; st.sandboxId = sb.id; }
    status.textContent = exported ? tt("Exporté") : tt("Enregistré ✓");
    ctx.requestSandboxRefresh();
  } catch (e) { status.textContent = tt("Échec :") + " " + (e?.message || e); }
}

// Modèle objet préparé pour l'export PDF fidèle (Rust) : couleur de texte
// garantie lisible (comme à l'écran), et images allégées — on garde sandboxPath
// pour le chargement disque, en ne conservant le data: que faute de chemin.
function docForPdf(st, sandboxId = "") {
  const clone = JSON.parse(JSON.stringify(st.doc));
  for (const p of clone.pages) {
    for (const el of p.elements) {
      if (el.type === "text") el.color = ensureTextColor(el.color, el.bg && el.bg !== "transparent" ? el.bg : p.background);
      if (el.type !== "image") continue;
      // Rust lit `sandboxPath` dans la sandbox de l'EXPORT : une image rangée
      // dans une autre sandbox (visuel d'un rapport, photo d'un autre espace)
      // part donc avec ses octets déjà chargés.
      const local = !el.sandboxId || el.sandboxId === sandboxId;
      if (el.sandboxPath && local) delete el.src;
      else if (String(el.src || "").startsWith("data:")) el.sandboxPath = "";
    }
  }
  return JSON.stringify(clone);
}

async function exportPdf(st) {
  const sb = st.sandboxId ? { id: st.sandboxId } : ctx.getCurrent();
  const status = st.refs.status;
  if (!sb) { status.textContent = tt("Aucune sandbox active"); return; }
  const rawTitle = (st.doc.title || "").trim() || "Document";
  const safe = rawTitle.replace(/[^\p{L}\p{N}_ -]+/gu, "").trim().replace(/\s+/g, "_") || "Document";
  const htmlPath = `${safe}.html`;
  status.textContent = tt("Export PDF…");
  try {
    await invoke("sandbox_write_file", { id: sb.id, path: htmlPath, content: renderStaticHtml(st) });
    const pdfPath = await invoke("sandbox_export_creative_pdf", { id: sb.id, path: htmlPath, title: rawTitle, doc: docForPdf(st, sb.id) });
    status.textContent = `${tt("PDF exporté")} : ${pdfPath}`;
    ctx.requestSandboxRefresh();
  } catch (e) { status.textContent = tt("Échec :") + " " + (e?.message || e); }
}

// Rendu statique = pages absolument positionnées (fidèle au canevas), idéal
// pour export HTML/PDF et rétro-compat (champ `html`).
function renderStaticHtml(st) {
  const isDeck = st.kind === "presentation";
  const pages = st.doc.pages.map((page, index) => {
    const els = page.elements.map((el) => {
      const base = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;transform:rotate(${el.rotation}deg);opacity:${el.opacity};`;
      if (el.type === "text") { const c = ensureTextColor(el.color, el.bg && el.bg !== "transparent" ? el.bg : page.background); return `<div style="${base}text-align:${el.align};font-size:${el.fontSize}px;font-family:${el.fontFamily};color:${c};font-weight:${el.weight};line-height:${el.lineHeight};letter-spacing:${el.letterSpacing}px;${el.bg && el.bg !== "transparent" ? "background:" + el.bg + ";" : ""}">${el.html}</div>`; }
      if (el.type === "image") return el.src ? `<img src="${el.src}" style="${base}object-fit:${el.fit};border-radius:${el.radius}px;">` : `<div style="${base}"></div>`;
      if (el.type === "shape") return `<div style="${base}">${shapeSvg(el)}</div>`;
      if (el.type === "table") return `<div style="${base}">${tableHtml(el, page.background)}</div>`;
      return "";
    }).join("\n");
    // Numéro de page/diapo : attendu de toute suite bureautique, et le PDF
    // exporté était jusqu'ici impaginable.
    const folio = st.doc.pageNumbers === false ? "" :
      `<div style="position:absolute;left:0;right:0;bottom:${isDeck ? 26 : 38}px;text-align:center;font-size:${isDeck ? 14 : 11}px;color:${isDark(page.background) ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.42)"};">${index + 1}</div>`;
    return `<div class="ce-static-page" style="width:${page.w}px;height:${page.h}px;background:${page.background};position:relative;overflow:hidden;margin:0 auto 28px;box-shadow:0 20px 60px rgba(0,0,0,.12);border-radius:${isDeck ? 18 : 6}px;">${els}${folio}</div>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(st.doc.title || "")}</title>
<style>@page{size:${isDeck ? "1280px 720px" : "A4"};margin:0}body{margin:0;background:#e9e9ec;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif}.wrap{padding:30px 0}.ce-static-page{page-break-after:always}p{margin:0 0 .5em}</style></head>
<body><div class="wrap">${pages}</div></body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown — export du contenu (pas de la mise en page)
// ─────────────────────────────────────────────────────────────────────────────
// Utile pour reprendre un document ailleurs, l'indexer dans Corpus, ou le
// donner à un agent : le HTML absolu de l'export est fidèle mais illisible.
function docToMarkdown(st) {
  const out = [`# ${st.doc.title || (st.kind === "presentation" ? "Présentation" : "Document")}`, ""];
  st.doc.pages.forEach((page, i) => {
    if (st.doc.pages.length > 1) out.push(`---`, "", `<!-- ${st.kind === "presentation" ? "Diapositive" : "Page"} ${i + 1} -->`, "");
    // Ordre de lecture : de haut en bas, puis de gauche à droite — l'ordre du
    // modèle est celui des calques, qui n'a rien à voir avec la lecture.
    const els = [...page.elements].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    for (const el of els) {
      if (el.type === "text") {
        const text = plainText(el.html);
        if (!text) continue;
        const level = el.style && /^h[123]$/.test(el.style) ? Number(el.style[1]) + 1 : (el.fontSize >= 40 ? 2 : el.fontSize >= 28 ? 3 : 0);
        out.push(level ? `${"#".repeat(Math.min(6, level))} ${text}` : (el.style === "quote" ? `> ${text}` : el.style === "code" ? `\`\`\`\n${text}\n\`\`\`` : text), "");
      } else if (el.type === "image") {
        out.push(`![${el.alt || ""}](${el.sandboxPath || ""})`, "");
      } else if (el.type === "table") {
        const rows = el.rows.map((row) => row.map((c) => plainText(c).replace(/\|/g, "\\|")));
        if (!rows.length) continue;
        out.push(`| ${rows[0].join(" | ")} |`);
        out.push(`| ${rows[0].map(() => "---").join(" | ")} |`);
        rows.slice(1).forEach((row) => out.push(`| ${row.join(" | ")} |`));
        out.push("");
      }
    }
    if (page.notes) out.push(`> **${tt("Notes")}** — ${page.notes}`, "");
  });
  return out.join("\n");
}

async function exportMarkdown(st) {
  const sb = ctx.getCurrent();
  const status = st.refs.status;
  if (!sb) { status.textContent = tt("Aucune sandbox active"); return; }
  const safe = (st.doc.title || "Document").replace(/[^\p{L}\p{N}_ -]+/gu, "").trim().replace(/\s+/g, "_") || "Document";
  try {
    await invoke("sandbox_write_file", { id: sb.id, path: `${safe}.md`, content: docToMarkdown(st) });
    status.textContent = `${tt("Markdown exporté")} : ${safe}.md`;
    ctx.requestSandboxRefresh();
  } catch (e) { status.textContent = tt("Échec :") + " " + (e?.message || e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rechercher / remplacer (tout le document)
// ─────────────────────────────────────────────────────────────────────────────
function openFindReplace(st) {
  const win = ctx.createWindow({ id: "ce-find", title: tt("Rechercher et remplacer"), w: 420, h: 260, x: 300, y: 140 });
  if (!win) return;
  win.body.innerHTML = `
    <div class="ce-find">
      <label class="ce-find-row"><span>${tt("Rechercher")}</span><input class="ce-find-q" autofocus></label>
      <label class="ce-find-row"><span>${tt("Remplacer par")}</span><input class="ce-find-r"></label>
      <label class="ce-find-opt"><input type="checkbox" class="ce-find-case"> ${tt("Respecter la casse")}</label>
      <div class="ce-find-actions">
        <button class="ce-btn" data-f="next">${tt("Suivant")}</button>
        <button class="ce-btn" data-f="all">${tt("Tout remplacer")}</button>
      </div>
      <div class="ce-find-status"></div>
    </div>`;
  const q = () => win.body.querySelector(".ce-find-q").value;
  const r = () => win.body.querySelector(".ce-find-r").value;
  const cs = () => win.body.querySelector(".ce-find-case").checked;
  const out = win.body.querySelector(".ce-find-status");

  const textsOf = (el) => (el.type === "text" ? [el.html] : el.type === "table" ? el.rows.flat() : []);
  win.body.querySelector('[data-f="next"]').addEventListener("click", () => {
    const needle = q();
    if (!needle) return;
    const hay = (s) => (cs() ? s : s.toLowerCase());
    const n = hay(needle);
    // On repart de la page courante pour parcourir le document en boucle.
    for (let i = 0; i < st.doc.pages.length; i += 1) {
      const idx = (st.pageIndex + i) % st.doc.pages.length;
      const page = st.doc.pages[idx];
      const hit = page.elements.find((el) => textsOf(el).some((t) => hay(plainText(t)).includes(n)));
      if (hit && !(i === 0 && st.selection === hit.id)) {
        st.pageIndex = idx; st.selection = hit.id;
        renderCanvas(st);
        out.textContent = `${tt("Trouvé")} — ${tt(st.kind === "presentation" ? "diapo" : "page")} ${idx + 1}`;
        return;
      }
    }
    out.textContent = tt("Aucune occurrence.");
  });
  win.body.querySelector('[data-f="all"]').addEventListener("click", () => {
    const needle = q();
    if (!needle) return;
    snapshot(st);
    const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), cs() ? "g" : "gi");
    let count = 0;
    const swap = (s) => s.replace(rx, () => { count += 1; return r(); });
    for (const page of st.doc.pages) {
      for (const el of page.elements) {
        if (el.type === "text") el.html = swap(el.html);
        else if (el.type === "table") el.rows = el.rows.map((row) => row.map(swap));
      }
    }
    renderCanvas(st);
    out.textContent = `${count} ${tt("remplacement(s)")}`;
  });
}

function showStats(st) {
  const s = docStats(st);
  const win = ctx.createWindow({ id: "ce-stats", title: tt("Statistiques"), w: 320, h: 260, x: 340, y: 160 });
  if (!win) return;
  const row = (k, v) => `<div class="ce-history-row"><span>${k}</span><b>${v}</b></div>`;
  win.body.innerHTML = `<div class="ce-picker">
    ${row(tt(st.kind === "presentation" ? "Diapositives" : "Pages"), s.pages)}
    ${row(tt("Mots"), s.words.toLocaleString())}
    ${row(tt("Caractères"), s.chars.toLocaleString())}
    ${row(tt("Images"), s.images)}
    ${row(tt("Tableaux"), s.tables)}
    ${row(tt("Temps de lecture"), `≈ ${Math.max(1, Math.round(s.words / 200))} min`)}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Modèles de départ
// ─────────────────────────────────────────────────────────────────────────────

// Raccourcis de mise en page partagés par les modèles. Ils ne font qu'une
// chose : poser les marges A4 (90 px, 614 px utiles) et les styles de
// paragraphe une seule fois, pour que les gabarits ci-dessous se lisent comme
// un plan et non comme une liste de coordonnées.
//
// Tout le TEXTE passe par `tt()` : les modèles existent en français et en
// anglais, et c'est la langue de l'app au moment de la création qui tranche.
// Les traductions vivent dans apps-i18n.js, comme le reste.
const docPage = (els) => { const p = blankPage("document"); p.elements.push(...els); return p; };
const slidePage = (bg, els) => { const p = blankPage("presentation"); p.background = bg; p.elements.push(...els); return p; };
const dEyebrow = (y, txt) => textEl({ x: 90, y, w: 614, h: 24, html: tt(txt), fontSize: 12.5, weight: 800, color: "#0a84ff", letterSpacing: 2, style: "caption" });
const dH1 = (y, txt, h = 100) => textEl({ x: 90, y, w: 614, h, html: tt(txt), fontSize: 46, weight: 800, color: "#1d1d1f", lineHeight: 1.15, style: "h1" });
const dH2 = (y, txt) => textEl({ x: 90, y, w: 614, h: 60, html: tt(txt), fontSize: 32, weight: 700, color: "#1d1d1f", style: "h2" });
const dH3 = (y, txt) => textEl({ x: 90, y, w: 614, h: 36, html: tt(txt), fontSize: 23, weight: 700, color: "#1d1d1f", style: "h3" });
const dLead = (y, txt, h = 74) => textEl({ x: 90, y, w: 614, h, html: tt(txt), fontSize: 21, weight: 500, color: "#3a3a3c", lineHeight: 1.5, style: "lead" });
const dBody = (y, txt, h = 120) => textEl({ x: 90, y, w: 614, h, html: tt(txt), fontSize: 17, color: "#3a3a3c", lineHeight: 1.6, style: "body" });
const dSmall = (y, txt, h = 90, x = 90, w = 614, align = "left") => textEl({ x, y, w, h, html: tt(txt), fontSize: 14, color: "#3a3a3c", lineHeight: 1.55, align, style: "body" });
const dTable = (y, rows, w = 614) => tableEl({ x: 90, y, w, rows: rows.map((r) => r.map((cell) => (cell ? tt(cell) : ""))) });
// Diapositives : mêmes marges (120 px) et même hiérarchie sur tout un deck.
const sTitle = (txt) => textEl({ x: 120, y: 250, w: 1040, h: 150, html: tt(txt), fontSize: 80, weight: 800, color: "#ffffff", style: "h1" });
const sSub = (txt) => textEl({ x: 124, y: 415, w: 940, h: 70, html: tt(txt), fontSize: 28, color: "#aab2d5", style: "lead" });
const sHead = (txt, color = "#ffffff") => textEl({ x: 120, y: 110, w: 1040, h: 90, html: tt(txt), fontSize: 52, weight: 800, color, style: "h2" });
const sBody = (y, txt, color = "#c7cdea", h = 320) => textEl({ x: 120, y, w: 1000, h, html: tt(txt), fontSize: 26, color, lineHeight: 1.6, style: "body" });
const sTable = (y, rows) => tableEl({
  x: 120, y, w: 1040, fontSize: 20, color: "#ffffff",
  headerBg: "rgba(255,255,255,0.12)", borderColor: "rgba(255,255,255,0.28)",
  rows: rows.map((r) => r.map((cell) => (cell ? tt(cell) : ""))),
});
// Deux fonds : nuit (decks de présentation) et jour (supports lus de près).
const NIGHT = "#0b1020";
const NIGHT_ALT = "#101a2e";

const TEMPLATES = {
  document: [
    {
      id: "report", name: "Rapport", desc: "Titre, chapô, corps structuré et tableau de synthèse.",
      build: () => ({
        kind: "document", title: tt("Rapport"),
        pages: [docPage([
          dEyebrow(86, "RAPPORT"),
          dH1(116, "Titre du rapport", 110),
          dLead(236, "Le résumé en deux phrases : ce qui a été observé, et ce qu'il faut en faire."),
          dH3(330, "Contexte"),
          dBody(376, "Développez ici.", 150),
          dTable(548, [["Indicateur", "Valeur", "Évolution"], ["", "", ""], ["", "", ""]]),
        ])],
      }),
    },
    {
      id: "letter", name: "Courrier", desc: "En-tête expéditeur, objet, corps et signature.",
      build: () => ({
        kind: "document", title: tt("Courrier"),
        pages: [docPage([
          dSmall(90, "Votre nom<br>Adresse<br>Ville", 90, 90, 300),
          dSmall(90, "Destinataire<br>Adresse<br>Ville", 90, 404, 300, "right"),
          textEl({ x: 90, y: 232, w: 614, h: 34, html: tt("<b>Objet :</b> …"), fontSize: 16, color: "#1d1d1f", style: "body" }),
          textEl({ x: 90, y: 292, w: 614, h: 420, html: tt("Madame, Monsieur,<br><br>…<br><br>Je vous prie d'agréer mes salutations distinguées."), fontSize: 16, color: "#3a3a3c", lineHeight: 1.7, style: "body" }),
        ])],
      }),
    },
    {
      id: "notes", name: "Compte rendu", desc: "Participants, décisions, actions à mener.",
      build: () => ({
        kind: "document", title: tt("Compte rendu"),
        pages: [docPage([
          dH2(90, "Compte rendu de réunion"),
          textEl({ x: 90, y: 168, w: 614, h: 30, html: tt("Date · Participants"), fontSize: 13, weight: 600, color: "#6e6e73", letterSpacing: 0.4, style: "caption" }),
          dH3(214, "Décisions"),
          dBody(258, "<ul><li>…</li><li>…</li></ul>", 120),
          dH3(396, "Actions"),
          dTable(442, [["Action", "Responsable", "Échéance"], ["", "", ""], ["", "", ""], ["", "", ""]]),
        ])],
      }),
    },
    {
      id: "actionplan", name: "Plan d'action", desc: "Objectif, jalons, actions par responsable et échéance.",
      build: () => ({
        kind: "document", title: tt("Plan d'action"),
        pages: [docPage([
          dEyebrow(86, "PLAN D'ACTION"),
          dH1(116, "Ce que nous allons faire"),
          dLead(232, "L'objectif en une phrase, et la date à laquelle il doit être atteint."),
          dH3(330, "Objectif"),
          dBody(370, "Formulé de façon vérifiable : on doit pouvoir dire, à la date prévue, si c'est atteint ou non.", 80),
          dH3(468, "Actions"),
          dTable(506, [
            ["Action", "Responsable", "Échéance", "État"],
            ["", "", "", "À faire"],
            ["", "", "", "À faire"],
            ["", "", "", "À faire"],
            ["", "", "", "À faire"],
          ]),
          dH3(700, "Points de vigilance"),
          dBody(738, "<ul><li>Ce qui peut bloquer</li><li>Ce dont nous dépendons</li></ul>", 130),
        ])],
      }),
    },
    {
      id: "projectcharter", name: "Gestion de projet", desc: "Note de cadrage : périmètre, parties prenantes, planning, risques.",
      build: () => ({
        kind: "document", title: tt("Note de cadrage"),
        pages: [
          docPage([
            dEyebrow(86, "PROJET"),
            dH1(116, "Nom du projet"),
            dLead(232, "Pourquoi ce projet existe, et ce qui change une fois qu'il est fait."),
            dH3(330, "Périmètre"),
            dTable(368, [
              ["Inclus", "Exclu"],
              ["", ""],
              ["", ""],
            ]),
            dH3(520, "Parties prenantes"),
            dTable(558, [
              ["Rôle", "Personne", "Attente"],
              ["Commanditaire", "", ""],
              ["Responsable", "", ""],
              ["Contributeurs", "", ""],
            ]),
            dH3(742, "Budget et moyens"),
            dBody(780, "Temps, dépenses et compétences nécessaires.", 90),
          ]),
          docPage([
            dH2(90, "Planning"),
            dTable(160, [
              ["Jalon", "Livrable", "Date"],
              ["", "", ""],
              ["", "", ""],
              ["", "", ""],
            ]),
            dH3(340, "Risques"),
            dTable(378, [
              ["Risque", "Probabilité", "Impact", "Parade"],
              ["", "", "", ""],
              ["", "", "", ""],
            ]),
            dH3(530, "Critères de réussite"),
            dBody(568, "<ul><li>…</li><li>…</li></ul>", 130),
            dH3(720, "Décisions à prendre"),
            dBody(758, "<ol><li>…</li><li>…</li></ol>", 130),
          ]),
        ],
      }),
    },
    {
      id: "cv", name: "CV", desc: "En-tête, profil, expériences, formation et compétences.",
      build: () => ({
        kind: "document", title: tt("CV"),
        pages: [docPage([
          textEl({ x: 90, y: 86, w: 420, h: 70, html: tt("Prénom Nom"), fontSize: 40, weight: 800, color: "#1d1d1f", style: "h1" }),
          textEl({ x: 90, y: 152, w: 420, h: 34, html: tt("Intitulé du poste recherché"), fontSize: 18, weight: 600, color: "#0a84ff", style: "lead" }),
          dSmall(90, "Ville · Téléphone<br>Adresse e-mail<br>Profil en ligne", 90, 514, 190, "right"),
          textEl({ x: 90, y: 214, w: 614, h: 2, html: "", bg: "#d1d1d6" }),
          dH3(240, "Profil"),
          dBody(278, "Trois lignes : ce que vous faites, pour qui, et ce que vous cherchez maintenant.", 80),
          dH3(376, "Expérience"),
          dSmall(414, "<b>Poste — Entreprise</b> · Ville · 20XX – 20XX<br>Ce dont vous étiez responsable, puis un résultat chiffré.", 84),
          dSmall(508, "<b>Poste — Entreprise</b> · Ville · 20XX – 20XX<br>Ce dont vous étiez responsable, puis un résultat chiffré.", 84),
          dSmall(602, "<b>Poste — Entreprise</b> · Ville · 20XX – 20XX<br>Ce dont vous étiez responsable, puis un résultat chiffré.", 84),
          dH3(706, "Formation"),
          dSmall(744, "<b>Diplôme</b> — Établissement · 20XX", 50),
          dH3(812, "Compétences et langues"),
          dSmall(850, "Compétences · Outils · Langues (niveau)", 60),
        ])],
      }),
    },
    {
      id: "spec", name: "Cahier des charges", desc: "Besoin, exigences numérotées, contraintes et recette.",
      build: () => ({
        kind: "document", title: tt("Cahier des charges"),
        pages: [docPage([
          dEyebrow(86, "CAHIER DES CHARGES"),
          dH1(116, "Objet de la demande"),
          dLead(232, "Le besoin en une phrase, du point de vue de celui qui l'exprime."),
          dH3(330, "Contexte"),
          dBody(368, "Ce qui existe aujourd'hui et pourquoi cela ne suffit plus.", 90),
          dH3(476, "Exigences"),
          dTable(514, [
            ["N°", "Exigence", "Priorité"],
            ["1", "", "Indispensable"],
            ["2", "", "Souhaitable"],
            ["3", "", "Optionnelle"],
          ]),
          dH3(700, "Contraintes"),
          dBody(738, "<ul><li>Délai</li><li>Budget</li><li>Technique et réglementaire</li></ul>", 130),
          dH3(890, "Recette"),
          dBody(928, "Comment nous vérifierons que la demande est satisfaite.", 90),
        ])],
      }),
    },
  ],
  presentation: [
    {
      id: "pitch", name: "Pitch", desc: "Couverture, problème, solution, chiffres.",
      build: () => ({
        kind: "presentation", title: tt("Pitch"),
        pages: [
          slidePage(NIGHT, [sTitle("Le nom du projet"), sSub("La promesse en une phrase.")]),
          slidePage(NIGHT, [sHead("Le problème"), sBody(250, "<ul><li>…</li><li>…</li><li>…</li></ul>", "#c7cdea", 260)]),
          slidePage(NIGHT_ALT, [sHead("Les chiffres"), sTable(250, [["Indicateur", "Aujourd'hui", "Cible"], ["", "", ""], ["", "", ""]])]),
        ],
      }),
    },
    {
      id: "lesson", name: "Cours", desc: "Titre de séance, plan, contenu, à retenir.",
      build: () => ({
        kind: "presentation", title: tt("Cours"),
        pages: [
          slidePage("#ffffff", [
            textEl({ x: 110, y: 260, w: 1060, h: 130, html: tt("Titre de la séance"), fontSize: 72, weight: 800, color: "#1d1d1f", style: "h1" }),
            textEl({ x: 114, y: 410, w: 900, h: 60, html: tt("Objectifs pédagogiques"), fontSize: 26, color: "#6e6e73", style: "lead" }),
          ]),
          slidePage("#ffffff", [
            sHead("Plan", "#1d1d1f"),
            sBody(230, "<ol><li>…</li><li>…</li><li>…</li></ol>", "#3a3a3c", 300),
          ]),
        ],
      }),
    },
    {
      id: "projectdeck", name: "Présentation de projet", desc: "Contexte, objectifs, planning, équipe, risques, prochaines étapes.",
      build: () => ({
        kind: "presentation", title: tt("Présentation de projet"),
        pages: [
          slidePage(NIGHT, [sTitle("Nom du projet"), sSub("Où nous en sommes, et ce que nous demandons.")]),
          slidePage(NIGHT, [sHead("Contexte"), sBody(240, "<ul><li>La situation de départ</li><li>Ce qui a déclenché le projet</li></ul>")]),
          slidePage(NIGHT, [sHead("Objectifs"), sBody(240, "<ol><li>…</li><li>…</li><li>…</li></ol>")]),
          slidePage(NIGHT_ALT, [sHead("Planning"), sTable(250, [
            ["Jalon", "Livrable", "Date"],
            ["", "", ""],
            ["", "", ""],
            ["", "", ""],
          ])]),
          slidePage(NIGHT, [sHead("Équipe"), sBody(240, "<ul><li>Commanditaire</li><li>Responsable</li><li>Contributeurs</li></ul>")]),
          slidePage(NIGHT_ALT, [sHead("Risques"), sTable(250, [
            ["Risque", "Impact", "Parade"],
            ["", "", ""],
            ["", "", ""],
          ])]),
          slidePage(NIGHT, [sHead("Prochaines étapes"), sBody(240, "<ol><li>…</li><li>…</li></ol>")]),
        ],
      }),
    },
    {
      id: "productdeck", name: "Présentation de produit", desc: "Promesse, problème, fonctionnalités, démonstration, tarifs.",
      build: () => ({
        kind: "presentation", title: tt("Présentation de produit"),
        pages: [
          slidePage(NIGHT, [sTitle("Nom du produit"), sSub("La promesse en une phrase.")]),
          slidePage(NIGHT, [sHead("Le problème"), sBody(240, "<ul><li>Ce que les gens font aujourd'hui</li><li>Ce que cela leur coûte</li></ul>")]),
          slidePage(NIGHT, [sHead("La réponse"), sBody(240, "Ce que le produit fait, en une phrase, puis ce qu'il ne fait pas.")]),
          slidePage(NIGHT_ALT, [sHead("Ce qu'il sait faire"), sTable(250, [
            ["Fonction", "Pour qui", "Bénéfice"],
            ["", "", ""],
            ["", "", ""],
            ["", "", ""],
          ])]),
          slidePage(NIGHT, [sHead("Démonstration"), sBody(240, "Le parcours montré en direct, étape par étape.")]),
          slidePage(NIGHT_ALT, [sHead("Tarifs"), sTable(250, [
            ["Offre", "Inclus", "Prix"],
            ["", "", ""],
            ["", "", ""],
          ])]),
          slidePage(NIGHT, [sHead("Et maintenant ?"), sBody(240, "Ce que nous attendons de vous après cette présentation.")]),
        ],
      }),
    },
    {
      id: "techcommittee", name: "Comité technique", desc: "Ordre du jour, avancement, indicateurs, décisions demandées.",
      build: () => ({
        kind: "presentation", title: tt("Comité technique"),
        pages: [
          slidePage(NIGHT, [sTitle("Comité technique"), sSub("Date · Participants")]),
          slidePage(NIGHT, [sHead("Ordre du jour"), sBody(240, "<ol><li>Avancement</li><li>Indicateurs</li><li>Risques et dette</li><li>Décisions demandées</li></ol>")]),
          slidePage(NIGHT_ALT, [sHead("Avancement"), sTable(250, [
            ["Chantier", "État", "Reste à faire", "Échéance"],
            ["", "En cours", "", ""],
            ["", "Terminé", "", ""],
            ["", "Bloqué", "", ""],
          ])]),
          slidePage(NIGHT_ALT, [sHead("Indicateurs"), sTable(250, [
            ["Indicateur", "Précédent", "Actuel", "Cible"],
            ["", "", "", ""],
            ["", "", "", ""],
          ])]),
          slidePage(NIGHT_ALT, [sHead("Risques et dette technique"), sTable(250, [
            ["Sujet", "Impact", "Proposition"],
            ["", "", ""],
            ["", "", ""],
          ])]),
          slidePage(NIGHT, [sHead("Décisions demandées"), sBody(240, "<ol><li>Décision · option retenue · qui tranche</li><li>…</li></ol>", "#ffd479")]),
        ],
      }),
    },
    {
      id: "statusdeck", name: "Point d'avancement", desc: "Fait, en cours, bloqué, et ce qui arrive ensuite.",
      build: () => ({
        kind: "presentation", title: tt("Point d'avancement"),
        pages: [
          slidePage(NIGHT, [sTitle("Point d'avancement"), sSub("Période · Équipe")]),
          slidePage(NIGHT, [sHead("Fait"), sBody(240, "<ul><li>…</li><li>…</li></ul>", "#7ee8a2")]),
          slidePage(NIGHT, [sHead("En cours"), sBody(240, "<ul><li>…</li><li>…</li></ul>")]),
          slidePage(NIGHT, [sHead("Bloqué"), sBody(240, "<ul><li>Ce qui bloque · ce dont nous avons besoin</li></ul>", "#ff9f9f")]),
          slidePage(NIGHT_ALT, [sHead("Ensuite"), sTable(250, [
            ["Sujet", "Responsable", "Échéance"],
            ["", "", ""],
            ["", "", ""],
          ])]),
        ],
      }),
    },
  ],
};

function openTemplateGallery(st) {
  const list = TEMPLATES[st.kind] || [];
  // La liste compte désormais sept documents et six présentations : une
  // fenêtre plus haute évite de faire défiler dès l'ouverture.
  const win = ctx.createWindow({ id: "ce-templates", title: tt("Modèles"), w: 500, h: 560, x: 280, y: 90 });
  if (!win) return;
  win.body.innerHTML = `<div class="ce-picker"></div>`;
  const box = win.body.querySelector(".ce-picker");
  list.forEach((tpl) => {
    const row = document.createElement("button");
    row.className = "ce-doc-row";
    row.innerHTML = `<span class="ce-doc-row-ic">${ICN.library || ICN.file}</span>
      <span class="ce-doc-row-main"><b>${escapeHtml(tt(tpl.name))}</b><small>${escapeHtml(tt(tpl.desc))}</small></span>`;
    row.addEventListener("click", () => {
      snapshot(st);
      const doc = tpl.build();
      st.doc = doc; st.pageIndex = 0; st.selection = null; st.path = "";
      st.refs.title.value = doc.title;
      ctx.closeWindow("ce-templates");
      renderCanvas(st);
      st.refs.status.textContent = `${tt("Modèle appliqué")} : ${tt(tpl.name)}`;
    });
    box.appendChild(row);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode présentation (plein écran, notes, minuteur)
// ─────────────────────────────────────────────────────────────────────────────
function startPresentation(st) {
  const pages = st.doc.pages;
  if (!pages.length) return;
  let i = st.pageIndex;
  let notesOn = false;
  const started = Date.now();

  const ov = document.createElement("div");
  ov.className = "ce-present";
  ov.tabIndex = 0;
  ov.innerHTML = `
    <div class="ce-present-stage"><div class="ce-present-page"></div></div>
    <div class="ce-present-notes" hidden></div>
    <div class="ce-present-bar">
      <button data-p="prev" title="${tt("Précédent")}">${ICN["chevron-left"] || "‹"}</button>
      <span class="ce-present-idx"></span>
      <button data-p="next" title="${tt("Suivant")}">${ICN["chevron-right"] || "›"}</button>
      <span class="ce-present-timer"></span>
      <button data-p="notes" title="${tt("Afficher les notes (N)")}">${ICN.notes || "N"}</button>
      <button data-p="quit" title="${tt("Quitter (Échap)")}">${ICN.x || "✕"}</button>
    </div>`;
  document.body.appendChild(ov);

  const stage = ov.querySelector(".ce-present-stage");
  const pageBox = ov.querySelector(".ce-present-page");
  const notesBox = ov.querySelector(".ce-present-notes");

  const draw = () => {
    const page = pages[i];
    const scale = Math.min(stage.clientWidth / page.w, stage.clientHeight / page.h);
    pageBox.style.cssText = `width:${page.w}px;height:${page.h}px;background:${page.background};transform:scale(${scale});`;
    pageBox.innerHTML = page.elements.map((el) => {
      const base = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;transform:rotate(${el.rotation}deg);opacity:${el.opacity};`;
      if (el.type === "text") return `<div style="${base}text-align:${el.align};font-size:${el.fontSize}px;font-family:${el.fontFamily};color:${ensureTextColor(el.color, el.bg && el.bg !== "transparent" ? el.bg : page.background)};font-weight:${el.weight};line-height:${el.lineHeight};letter-spacing:${el.letterSpacing}px;">${el.html}</div>`;
      if (el.type === "image") return el.src ? `<img src="${el.src}" style="${base}object-fit:${el.fit};border-radius:${el.radius}px;">` : "";
      if (el.type === "shape") return `<div style="${base}">${shapeSvg(el)}</div>`;
      if (el.type === "table") return `<div style="${base}">${tableHtml(el, page.background)}</div>`;
      return "";
    }).join("");
    ov.querySelector(".ce-present-idx").textContent = `${i + 1} / ${pages.length}`;
    notesBox.textContent = page.notes || tt("Aucune note pour cette diapositive.");
  };
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    ov.querySelector(".ce-present-timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
  const go = (d) => { i = Math.max(0, Math.min(pages.length - 1, i + d)); draw(); };
  const quit = () => {
    clearInterval(tick);
    window.removeEventListener("resize", draw);
    ov.remove();
    // On rend la main sur la page affichée à l'écran : sortir de la
    // présentation sur la diapo 7 pour revenir sur la 1 est déroutant.
    st.pageIndex = i; st.selection = null; renderCanvas(st);
  };
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); quit(); }
    if (["ArrowRight", "ArrowDown", " ", "PageDown", "Enter"].includes(e.key)) { e.preventDefault(); go(1); }
    if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); go(-1); }
    if (e.key.toLowerCase() === "n") { notesOn = !notesOn; notesBox.hidden = !notesOn; draw(); }
  });
  ov.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.p;
    if (a === "prev") go(-1);
    else if (a === "next") go(1);
    else if (a === "quit") quit();
    else { notesOn = !notesOn; notesBox.hidden = !notesOn; draw(); }
  }));
  ov.addEventListener("click", (e) => { if (e.target === stage) go(1); });
  window.addEventListener("resize", draw);
  ov.focus();
  draw();
}

async function openHistory(st) {
  const sb = ctx.getCurrent();
  const status = st.refs.status;
  if (!sb || !st.path) { status.textContent = tt("Enregistrez d'abord ce document."); return; }
  const win = ctx.createWindow({ id: "ce-history", title: tt("Historique des versions"), w: 520, h: 480, x: 240, y: 110 });
  if (!win) return;
  win.body.innerHTML = `<div class="ce-picker"></div>`;
  const list = win.body.querySelector(".ce-picker");
  let snaps = await invoke("sandbox_snapshot_list", { id: sb.id, path: st.path }).catch(() => []);
  snaps = snaps.slice().reverse();
  if (!snaps.length) { list.innerHTML = `<div class="ce-picker-empty">${tt("Aucune version antérieure.")}</div>`; return; }
  list.innerHTML = "";
  snaps.forEach((snap, i) => {
    const row = document.createElement("div");
    row.className = "ce-history-row";
    row.innerHTML = `<span>${i === 0 ? "● " : ""}${new Date(snap.ts).toLocaleString()}</span>`;
    const res = document.createElement("button"); res.className = "diff-mini"; res.textContent = tt("Restaurer");
    res.addEventListener("click", async () => {
      const content = await invoke("sandbox_snapshot_get", { id: sb.id, path: st.path, ts: snap.ts }).catch(() => null);
      if (content == null) return;
      const parsed = parseCreativeFile(st.path, content, st.kind);
      if (!parsed) return;
      snapshot(st);
      st.doc = parsed.doc || importLegacyHtml(parsed.html, st.kind, parsed.title);
      st.doc.title = parsed.title || st.doc.title;
      st.pageIndex = 0; st.selection = null;
      st.refs.title.value = st.doc.title;
      await hydrateImages(st);
      renderCanvas(st);
      ctx.closeWindow("ce-history");
      status.textContent = tt("Version restaurée.");
    });
    row.append(res);
    list.appendChild(row);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// (Dé)sérialisation
// ─────────────────────────────────────────────────────────────────────────────
function parseCreativeFile(path, content, preferredKind = "") {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".lumenpages") || lower.endsWith(".lumenkey")) {
    try {
      const data = JSON.parse(content);
      const kind = lower.endsWith(".lumenkey") ? "presentation" : "document";
      return { kind, path, format: "lumen", title: data.title || base(path), doc: data.doc || null, html: data.html || "" };
    } catch { return null; }
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    const body = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || content;
    const title = (content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || base(path)).replace(/<[^>]+>/g, "");
    const isDeck = preferredKind === "presentation" || /ck-slide|1280px 720px/.test(body);
    return { kind: isDeck ? "presentation" : "document", path, format: "html", title, doc: null, html: body };
  }
  return null;
}
function base(p) { return String(p).split("/").pop().replace(/\.[^.]+$/, ""); }

// Import « best effort » d'anciens documents HTML libres en éléments : on place
// chaque bloc de premier niveau dans une zone de texte empilée verticalement.
/**
 * Enveloppe dans des <p> les suites de nœuds inline (texte nu, <b>, <a>…) au
 * premier niveau, en coupant sur les <br> doublés. Les blocs déjà présents
 * (<h1>, <ul>, <img>…) sont conservés tels quels et dans l'ordre.
 */
function wrapLooseText(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const BLOCK = /^(P|DIV|H[1-6]|UL|OL|LI|TABLE|BLOCKQUOTE|PRE|IMG|FIGURE|SECTION|ARTICLE|HR)$/;
  const out = [];
  let buf = [];
  const flush = () => {
    const chunk = buf.join("").trim();
    buf = [];
    if (!chunk) return;
    // Un paragraphe par ligne vide (deux <br> de suite) : le Markdown rendu
    // sépare ses paragraphes ainsi.
    for (const part of chunk.split(/(?:<br\s*\/?>\s*){2,}/i)) {
      if (part.trim()) out.push(`<p>${part.trim()}</p>`);
    }
  };
  for (const node of [...tpl.content.childNodes]) {
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK.test(node.tagName)) { flush(); out.push(node.outerHTML); continue; }
    if (node.nodeType === Node.TEXT_NODE) { buf.push(escapeHtml(node.nodeValue)); continue; }
    if (node.nodeType === Node.ELEMENT_NODE) { buf.push(node.outerHTML); continue; }
  }
  flush();
  return out.join("");
}

function importLegacyHtml(html, kind, title) {
  const doc = starterDoc(kind);
  doc.title = title || doc.title;
  const page = doc.pages[0];
  page.elements = [];
  const tpl = document.createElement("template");
  // `renderMarkdown` d'un texte simple ne renvoie AUCUN élément (« Bonjour »
  // reste un nœud texte, « a<br>b » n'a que des <br>) : sans cette mise en
  // paragraphes, le parcours par `children` ne trouvait rien et produisait un
  // document vide. C'est ce qui arrivait à tout « Envoyer vers Opus » d'un
  // texte non structuré (sélection du chat, note, extrait de page).
  tpl.innerHTML = wrapLooseText(String(html || ""));
  // Si l'ancien HTML utilisait .ck-slide / .ck-page, chaque conteneur devient une page.
  const containers = [...tpl.content.querySelectorAll(".ck-slide, .ck-page")];
  const blocks = containers.length ? containers : [tpl.content];
  doc.pages = [];
  blocks.forEach((container) => {
    const p = blankPage(kind);
    const dark = isDark(p.background);
    let y = kind === "presentation" ? 80 : 90;
    const margin = kind === "presentation" ? 90 : 90;
    const maxW = p.w - margin * 2;
    [...container.children].forEach((node) => {
      const tag = node.tagName?.toLowerCase() || "p";
      const text = node.innerHTML.trim();
      if (!text) return;
      const img = node.tagName === "IMG" ? node : node.querySelector?.("img");
      if (img) {
        const src = img.getAttribute("src") || "";
        const inline = /^(data:|blob:|https?:)/i.test(src) ? src : "";
        const sandboxPath = img.getAttribute("data-sandbox-image") || (inline ? "" : src.replace(/^sandbox:/, ""));
        p.elements.push(imageEl({ x: margin, y, w: maxW, h: 280, src: inline, sandboxPath, sandboxId: img.getAttribute("data-sandbox-id") || "", alt: img.getAttribute("alt") || "" }));
        y += 300; return;
      }
      const size = tag === "h1" ? 44 : tag === "h2" ? 30 : tag === "h3" ? 24 : 18;
      const weight = /h[1-3]/.test(tag) ? 800 : 400;
      const isKicker = node.classList?.contains("ck-kicker");
      const h = Math.max(40, Math.ceil(text.replace(/<[^>]+>/g, "").length / 60) * size * 1.4 + size);
      p.elements.push(textEl({
        x: margin, y, w: maxW, h,
        html: text, fontSize: isKicker ? 13 : size, weight: isKicker ? 800 : weight,
        color: isKicker ? "#007aff" : (dark ? "#ffffff" : "#1d1d1f"),
        letterSpacing: isKicker ? 2 : 0,
      }));
      y += h + 16;
    });
    if (!p.elements.length) p.elements.push(textEl({ x: margin, y: 90, w: maxW, h: 80, html: tt("Document vide"), color: dark ? "#fff" : "#1d1d1f" }));
    doc.pages.push(p);
  });
  if (!doc.pages.length) doc.pages = [blankPage(kind)];
  return doc;
}

function decodeBase64Utf8(b64) {
  const bin = atob(String(b64 || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ── Zones de texte vivantes & @agents ──────────────────────────────────────
// Une zone de texte peut être tenue à jour par un agent (src-tauri/src/
// living.rs réécrit l'élément dans le fichier, Opus fermé ou non). Pendant
// l'édition, une ligne « @Agent demande » + Entrée confie la suite à l'agent,
// dont la réponse remplace la ligne.
const docSandbox = (st) => st.sandboxId || ctx.getCurrent()?.id || "";

async function openLiveText(st, el) {
  if (el.type !== "text") return;
  if (st.format === "docx" || st.format === "pptx") { st.refs.status.textContent = tt("Enregistrez d'abord au format Opus pour rendre une zone vivante."); return; }
  commitTextEdit(st);
  if (!st.path) await saveCreative(st, false);
  if (!st.path) return;
  const base = { kind: "doc", sandbox_id: docSandbox(st), path: st.path, target: el.id, title: plainText(el.html || "").slice(0, 40) || tt("Zone de texte") };
  const existing = el.live?.id ? (await listLiving()).find((b) => b.id === el.live.id) : null;
  let block;
  try { block = await openLivingDialog(base, existing); } catch (e) { st.refs.status.textContent = String(e?.message || e); return; }
  if (!block) return;
  if (block.deleted) delete el.live; else el.live = { id: block.id };
  await saveCreative(st, false);
  renderCanvas(st, true);
  if (block.runNow) runLiving(block.id).catch((e) => { st.refs.status.textContent = String(e?.message || e); });
}

// Pastille « vivant » posée sur l'élément : avatar de l'agent qui le tient.
async function paintLiveBadges(st) {
  const els = curPage(st).elements.filter((e) => e.live?.id);
  if (!els.length) return;
  const [blocks, agents] = await Promise.all([listLiving(), listAgents()]);
  for (const el of els) {
    const node = st.refs.inner?.querySelector(`.ce-el[data-id="${el.id}"]`);
    if (!node || node.querySelector(".ce-live-badge")) continue;
    const b = blocks.find((x) => x.id === el.live.id);
    const agent = agents.find((a) => a.id === b?.agent_id);
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "ce-live-badge" + (b?.status === "running" ? " is-running" : "");
    badge.title = b ? `${tt("Tenu à jour par")} ${agent?.name || "Lumen"} · ${rhythmLabel(b.cron)}` : tt("Bloc vivant introuvable");
    badge.innerHTML = `${agent ? agentAvatarHTML(agent, { size: 18, hands: false, state: b?.status === "running" ? "work" : "idle" }) : ICN["refresh-cw"]}<span>${escapeHtml(agent?.name || "Lumen")}</span>`;
    badge.addEventListener("pointerdown", (e) => e.stopPropagation());
    badge.addEventListener("click", (e) => { e.stopPropagation(); openLiveText(st, el); });
    node.appendChild(badge);
  }
}

function watchLiving(st) {
  const off = onLivingUpdated(async (p) => {
    if (!st.refs.body?.isConnected) { off(); return; }
    if (!(p.path && p.path === st.path && p.ok) || st.editing) {
      if (curPage(st).elements.some((e) => e.live?.id === p.id)) renderCanvas(st, true);
      return;
    }
    const file = await invoke("sandbox_read_file", { id: docSandbox(st), path: st.path }).catch(() => null);
    const parsed = file && !file.binary ? parseCreativeFile(st.path, file.content || "", st.kind) : null;
    if (!parsed?.doc) return;
    st.doc = parsed.doc;
    st.pageIndex = Math.min(st.pageIndex, st.doc.pages.length - 1);
    await hydrateImages(st);
    renderCanvas(st, true);
    st.refs.status.textContent = tt("Texte mis à jour par l'agent ✓");
  });
}

// Entrée sur une ligne « @Agent demande » pendant l'édition d'un texte.
async function maybeDelegateLine(st, el, inner, e) {
  const sel = window.getSelection();
  let block = sel?.anchorNode;
  while (block && block !== inner && !(block.nodeType === 1 && /^(P|DIV|LI|H[1-6])$/.test(block.tagName))) block = block.parentNode;
  if (!block) return false;
  const line = block === inner ? (inner.innerText.split("\n").find((l) => l.trim().startsWith("@")) || "") : block.innerText;
  if (!line.trim().startsWith("@")) return false;
  const hit = matchAgentMention(line, await listAgents());
  if (!hit) return false;
  e.preventDefault();
  const marker = `⏳ ${hit.agent.name}…`;
  const context = inner.innerText.replace(line, "⟦ICI⟧");
  const target = block === inner ? null : block;
  if (target) target.textContent = marker;
  st.refs.status.textContent = tt("{name} écrit la suite…", { name: hit.agent.name });
  try {
    const out = await delegateToAgent({ agent: hit.agent, request: hit.request, title: st.doc.title || "", context: `${docToMarkdown(st)}\n\n— ${tt("Zone en cours")} —\n${context}` });
    const html = await invoke("living_markdown_html", { markdown: out });
    if (target) { const box = document.createElement("div"); box.innerHTML = html; target.replaceWith(...box.childNodes); }
    else inner.innerHTML = inner.innerHTML.replace(escapeHtml(line), html);
    st.refs.status.textContent = tt("{name} a répondu ✓", { name: hit.agent.name });
  } catch (err) {
    if (target) target.textContent = line;
    st.refs.status.textContent = `${hit.agent.name} : ${err?.message || err}`;
  }
  el.html = inner.innerHTML;
  return true;
}
