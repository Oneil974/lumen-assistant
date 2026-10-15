// Éditeur de code — un mini Visual Studio Code (habillage shadcn/ui) pour les
// fichiers des sandboxes. Barre d'activité (Explorateur, Recherche, Versions,
// Assistant), onglets, fil d'Ariane, ligne courante, barre d'état, palette de
// commandes (⌘⇧P), ouverture rapide (⌘P), recherche dans les fichiers (⌘⇧F).
// Coloration via highlight.js (calque <pre> sous le <textarea>). L'IA (sélection,
// dossier, assistant) passe par un backend et un modèle PROPRES au code
// (ai-backend.js), modifiables sans toucher au reste de Lumen.

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};

import { translatePage, tt, observeTranslations } from "../apps-i18n.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { llmChat } from "../llm.js";
import { streamTarget } from "../lib/stream-view.js";
import { markdownToHtml } from "../lib/markdown.js";
import { applyDiff, countChanges, diffLines } from "../sandbox/diff.js";
import { bundleApp } from "../sandbox/app-runner.js";
import { highlight, langFromName } from "./highlight.js";
import { PROMPTS } from "./prompts.js";
import { runCodeHarness, inlineApp } from "./code-harness.js";
import { replyLang } from "../lib/prompt-lang.js";
import {
  codeBackend, codeBackendLabel, codeChoice, setCodeChoice, onCodeChoiceChange,
  availableSources, modelsFor, defaultModelFor, ensureLlamaModel, SOURCE_LABELS,
} from "./ai-backend.js";

let sandboxId = null;
let openPath = null;        // fichier de l'onglet actif (miroir de `active.path`)
let original = "";          // contenu disque de l'onglet actif (état « modifié »)
let lang = "text";
let truncated = false;      // fichier tronqué à la lecture → lecture seule
let activeDir = "";         // dossier courant (cible des « nouveau fichier » / import)
const expandedDirs = new Set(); // dossiers déployés (persisté entre rafraîchissements)

// Onglets : un tampon par fichier ouvert. L'onglet actif vit dans le <textarea>,
// les autres gardent leur contenu, leur défilement et leur sélection ici.
const tabs = [];            // [{ path, content, original, lang, truncated, scrollTop, scrollLeft, selStart, selEnd }]
let active = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const MOD = IS_MAC ? "⌘" : "Ctrl+";

// Options communes de toute demande IA de l'éditeur (backend propre au code).
const aiOpts = (extra = {}) => ({ backend: codeBackend(), rawSystem: true, ...extra });

// ===== Icônes SVG (tracés Lucide, jamais d'émoji) =====
const EDIC = {
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 14l.7 1.8 1.8.7-1.8.7L18 19l-.7-1.8-1.8-.7 1.8-.7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
  folderPlus: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.7 1.8H19.5A1.5 1.5 0 0 1 21 9.3v8.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 11v5M9.5 13.5h5"/>',
  filePlus: '<path d="M14 3v5h5"/><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M12 12v4M10 14h4"/>',
  upload: '<path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4"/><path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4"/><polyline points="21 3 21 7 17 7"/><polyline points="3 21 3 17 7 17"/>',
  file: '<path d="M14 3v5h5"/><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>',
  files: '<path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M15 2v6h6"/><path d="M5 7H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.7 1.8H19.5A1.5 1.5 0 0 1 21 9.3v8.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  folderOpen: '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  insert: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  replace: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M4 10v10h10"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};
function edSvg(inner, w = 16) { return `<svg class="mi" width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`; }
function icon(name, w) { return edSvg(EDIC[name] || "", w); }

// Pastille de type de fichier (façon icônes de VS Code), par extension.
const FILE_BADGES = {
  html: ["<>", "#e34c26"], htm: ["<>", "#e34c26"], css: ["#", "#2965f1"], scss: ["#", "#cd6799"],
  js: ["JS", "#d4a400"], mjs: ["JS", "#d4a400"], cjs: ["JS", "#d4a400"], jsx: ["JS", "#0ea5e9"],
  ts: ["TS", "#3178c6"], tsx: ["TS", "#3178c6"], json: ["{}", "#a16207"], md: ["M↓", "#64748b"],
  py: ["PY", "#3776ab"], svg: ["SV", "#f59e0b"], txt: ["≡", "#64748b"], xml: ["<>", "#0d9488"],
  rs: ["RS", "#ce422b"], sh: ["$", "#16a34a"], yml: ["YM", "#cb171e"], yaml: ["YM", "#cb171e"],
  png: ["IM", "#a855f7"], jpg: ["IM", "#a855f7"], jpeg: ["IM", "#a855f7"], gif: ["IM", "#a855f7"], webp: ["IM", "#a855f7"],
};
function fileBadge(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  const [txt, color] = FILE_BADGES[ext] || ["", ""];
  if (!txt) return `<span class="fi" style="color:var(--muted-foreground)">${icon("file", 14)}</span>`;
  return `<span class="fi" style="color:${color}">${escapeHtml(txt)}</span>`;
}
const LANG_LABELS = { html: "HTML", css: "CSS", js: "JavaScript", json: "JSON", python: "Python", md: "Markdown", text: "Texte brut" };

const ta = $("code");
const hl = $("highlight").querySelector("code");
const gutter = $("gutter");

// ===== Démarrage =====
async function init() {
  translatePage();
  observeTranslations();
  decorateIcons();
  syncCodeTheme();
  await loadSandboxes();
  bind();
  renderModelLabels();
  onCodeChoiceChange(renderModelLabels);
  restoreLayout();
  updateStatus();
}

// La zone de code suit le thème de Lumen (data-theme) ; le bouton bascule
// localement (classe mk-dark, conservée pour les feuilles historiques).
function syncCodeTheme() {
  const dark = document.documentElement.dataset.theme === "dark"
    || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("mk-dark", dark);
}
function toggleTheme() {
  const html = document.documentElement;
  const dark = !(html.dataset.theme === "dark");
  html.dataset.theme = dark ? "dark" : "light";
  html.dataset.dtTheme = html.dataset.theme;
  syncCodeTheme();
}

// Injecte les icônes SVG dans les boutons (aucun émoji).
function decorateIcons() {
  const set = {
    "btn-ai-folder": "sparkles", "btn-preview": "play", "btn-theme": "theme", "btn-toggle-chat": "panel",
    "btn-new-file": "filePlus", "btn-new-folder": "folderPlus", "btn-import": "upload", "btn-refresh-tree": "refresh",
    "history-close": "close", "chat-clear": "plus", "chat-close": "close",
  };
  for (const [id, name] of Object.entries(set)) {
    const b = $(id); if (b) b.insertAdjacentHTML("afterbegin", icon(name));
  }
  $("brand-ic").innerHTML = icon("code", 15);
  $("cmd-search-ic").innerHTML = icon("search", 14);
  $("welcome-ic").innerHTML = icon("code", 26);
  const acts = { explorer: "files", search: "search", history: "history", ai: "bot" };
  document.querySelectorAll(".act[data-view]").forEach((b) => { b.innerHTML = icon(acts[b.dataset.view], 20); });
  $("btn-palette").innerHTML = icon("command", 20);
  document.querySelectorAll("#ctx-menu button[data-ic]").forEach((b) => {
    b.innerHTML = icon(b.dataset.ic) + `<span>${b.textContent}</span>`;
  });
  $("cmd-search-txt").nextElementSibling.textContent = `${MOD}P`;
}

async function loadSandboxes() {
  let boxes = [];
  try { boxes = await invoke("sandbox_list"); } catch {}
  const sel = $("sandbox-select");
  sel.innerHTML = "";
  for (const b of boxes) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.name || b.id; sel.appendChild(o); }
  const saved = lsGet("editorSandbox");
  const pick = boxes.find((b) => b.id === saved) || boxes[0];
  if (pick) { sandboxId = pick.id; sel.value = pick.id; await loadTree(); }
  updateStatus();
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function sandboxName() { return $("sandbox-select").selectedOptions[0]?.textContent || ""; }

// ===== Arborescence (récursive) =====
async function loadTree() {
  const root = $("files");
  root.textContent = "";
  fileIndex = null;
  await renderDir("", root, 0);
  if (!root.childElementCount) root.innerHTML = `<div class="search-state" style="padding:10px 8px">Sandbox vide.</div>`;
}
async function renderDir(path, container, depth) {
  let entries = [];
  try { entries = await invoke("sandbox_read_dir", { id: sandboxId, path }); } catch { return; }
  // Dossiers d'abord, puis fichiers, chacun par ordre alphabétique (comme VS Code).
  entries.sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));
  for (const e of entries) {
    const item = document.createElement("div");
    item.className = "file-item" + (e.is_dir ? " dir" : "");
    item.style.paddingLeft = 6 + depth * 12 + "px";
    item.dataset.path = e.path;
    item.title = e.path;
    if (e.is_dir) item.dataset.dir = "1";
    if (openPath === e.path) item.classList.add("active");
    if (activeDir === e.path) item.classList.add("dir-active");
    const guides = Array.from({ length: depth }, (_, i) => `<span class="guide" style="left:${12 + i * 12}px"></span>`).join("");
    item.addEventListener("contextmenu", (ev) => { ev.preventDefault(); openTreeMenu(ev, e); });
    if (e.is_dir) {
      const open = expandedDirs.has(e.path);
      const paint = (o) => {
        item.innerHTML = `${guides}<span class="chev${o ? " open" : ""}">${icon("chevron", 12)}</span><span class="fi folder">${icon(o ? "folderOpen" : "folder", 14)}</span><span class="name">${escapeHtml(e.name)}</span>`;
      };
      paint(open);
      const kids = document.createElement("div");
      container.appendChild(item);
      container.appendChild(kids);
      item.addEventListener("click", async () => {
        const nowOpen = !expandedDirs.has(e.path);
        if (nowOpen) { expandedDirs.add(e.path); if (!kids.childElementCount) await renderDir(e.path, kids, depth + 1); }
        else expandedDirs.delete(e.path);
        paint(nowOpen);
        kids.hidden = !nowOpen;
        setActiveDir(e.path);
      });
      if (open) { await renderDir(e.path, kids, depth + 1); kids.hidden = false; }
      else kids.hidden = true;
    } else {
      item.innerHTML = `${guides}<span class="chev"></span>${fileBadge(e.name)}<span class="name">${escapeHtml(e.name)}</span>`;
      item.addEventListener("click", () => openFile(e.path, item));
      container.appendChild(item);
    }
  }
}
// Marque le dossier cible des créations / imports (surlignage léger).
function setActiveDir(path) {
  activeDir = path || "";
  document.querySelectorAll(".file-item.dir-active").forEach((x) => x.classList.remove("dir-active"));
  if (path) document.querySelector(`.file-item.dir[data-path="${cssEsc(path)}"]`)?.classList.add("dir-active");
}
function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

// Déplie les dossiers parents d'un fichier et le révèle dans l'arborescence.
async function revealInTree(path) {
  const parts = path.split("/");
  let changed = false;
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    if (!expandedDirs.has(dir)) { expandedDirs.add(dir); changed = true; }
  }
  if (changed) await loadTree();
  const el = document.querySelector(`.file-item[data-path="${cssEsc(path)}"]`);
  document.querySelectorAll(".file-item").forEach((x) => x.classList.toggle("active", x === el));
  el?.scrollIntoView({ block: "nearest" });
}

// ===== Onglets =====
function stashActive() {
  if (!active) return;
  active.content = ta.value;
  active.scrollTop = ta.scrollTop;
  active.scrollLeft = ta.scrollLeft;
  active.selStart = ta.selectionStart;
  active.selEnd = ta.selectionEnd;
}
function tabDirty(t) { return !!t && t.content !== t.original; }

function activateTab(tab) {
  if (active && active !== tab) stashActive();
  active = tab;
  openPath = tab?.path || null;
  original = tab?.original || "";
  lang = tab?.lang || "text";
  truncated = !!tab?.truncated;
  ta.value = tab?.content || "";
  ta.readOnly = truncated;
  $("welcome").hidden = !!tab;
  $("diff-view").hidden = true;
  $("editor").hidden = !tab;
  if (tab) {
    setActiveDir(tab.path.includes("/") ? tab.path.slice(0, tab.path.lastIndexOf("/")) : "");
    refresh();
    ta.scrollTop = tab.scrollTop || 0;
    ta.scrollLeft = tab.scrollLeft || 0;
    try { ta.setSelectionRange(tab.selStart || 0, tab.selEnd || 0); } catch {}
    syncScroll();
    ta.focus({ preventScroll: true });
  }
  document.querySelectorAll(".file-item").forEach((x) => x.classList.toggle("active", !!tab && x.dataset.path === tab.path));
  renderTabs();
  renderBreadcrumbs();
  markDirty();
  updateCursor();
  if (!$("history").hidden) loadHistory();
}

function renderTabs() {
  const bar = $("tabs");
  bar.textContent = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t === active ? " active" : "") + (tabDirty(t) ? " dirty" : "");
    el.title = t.path + (t.truncated ? " (lecture seule)" : "");
    const name = t.path.split("/").pop();
    // Deux onglets du même nom : on ajoute le dossier pour les distinguer.
    const twin = tabs.some((o) => o !== t && o.path.split("/").pop() === name);
    const dir = twin && t.path.includes("/") ? ` <span class="oe-dir">${escapeHtml(t.path.split("/").slice(-2, -1)[0])}</span>` : "";
    el.innerHTML = `${fileBadge(name)}<span class="name">${escapeHtml(name)}${dir}</span><button class="tab-close" title="Fermer (${MOD}W)">${icon("close", 13)}</button>`;
    el.addEventListener("mousedown", (ev) => {
      if (ev.button === 1) { ev.preventDefault(); closeTab(t); return; }
      if (ev.target.closest(".tab-close")) return;
      if (t !== active) activateTab(t);
    });
    el.querySelector(".tab-close").addEventListener("click", (ev) => { ev.stopPropagation(); closeTab(t); });
    bar.appendChild(el);
    if (t === active) requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  renderOpenEditors();
}

function renderOpenEditors() {
  const box = $("open-editors");
  box.textContent = "";
  for (const t of tabs) {
    const name = t.path.split("/").pop();
    const dir = t.path.includes("/") ? t.path.slice(0, t.path.lastIndexOf("/")) : "";
    const el = document.createElement("div");
    el.className = "oe-item" + (t === active ? " active" : "") + (tabDirty(t) ? " dirty" : "");
    el.innerHTML = `${fileBadge(name)}<span class="name">${escapeHtml(name)}</span><span class="oe-dir">${escapeHtml(dir)}</span>
      <button class="icon-btn oe-close" title="Fermer">${tabDirty(t) ? '<span style="width:8px;height:8px;border-radius:50%;background:currentColor;display:block"></span>' : icon("close", 13)}</button>`;
    el.addEventListener("click", (ev) => { if (ev.target.closest(".oe-close")) { closeTab(t); return; } activateTab(t); });
    box.appendChild(el);
  }
}

async function closeTab(tab) {
  if (!tab) return;
  if (tab === active) stashActive();
  if (tabDirty(tab)) {
    const ok = await confirmModal(`« ${tab.path.split("/").pop()} » contient des modifications non enregistrées. Fermer quand même ?`);
    if (!ok) return;
  }
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  if (tab === active) {
    active = null;
    activateTab(tabs[Math.min(i, tabs.length - 1)] || null);
  } else renderTabs();
}

async function closeAllTabs() {
  stashActive();
  const dirty = tabs.filter(tabDirty);
  if (dirty.length && !(await confirmModal(`${dirty.length} fichier(s) non enregistré(s). Tout fermer quand même ?`))) return false;
  tabs.length = 0;
  active = null;
  activateTab(null);
  return true;
}

function renderBreadcrumbs() {
  const el = $("open-path");
  if (!openPath) { el.innerHTML = ""; return; }
  const parts = [sandboxName(), ...openPath.split("/")].filter(Boolean);
  el.innerHTML = parts.map((p, i) => i === parts.length - 1
    ? `${fileBadge(p)}<span class="crumb-last">${escapeHtml(p)}</span>${truncated ? ' <span class="crumb-sep">— tronqué, lecture seule</span>' : ""}`
    : `<span>${escapeHtml(p)}</span><span class="crumb-sep">${icon("chevron", 12)}</span>`).join("");
}

// ===== Ouverture / édition =====
async function openFile(path, item, { line = 0, col = 0, len = 0 } = {}) {
  let tab = tabs.find((t) => t.path === path);
  if (!tab) {
    try {
      const fc = await invoke("sandbox_read_file", { id: sandboxId, path });
      if (fc.binary) { toast("Fichier binaire non éditable."); return; }
      // Sécurité : un fichier tronqué à la lecture ne doit JAMAIS être réécrit
      // (sinon on perdrait la fin du fichier). On l'ouvre en lecture seule.
      tab = { path, content: fc.content, original: fc.content, lang: langFromName(path), truncated: !!fc.truncated, scrollTop: 0, scrollLeft: 0, selStart: 0, selEnd: 0 };
      if (tab.truncated) toast("Fichier trop volumineux : ouvert en lecture seule pour éviter toute perte de données.");
      const at = active ? tabs.indexOf(active) + 1 : tabs.length;
      tabs.splice(at, 0, tab);
    } catch (e) { toast("Ouverture impossible : " + (e.message || e)); return; }
  }
  activateTab(tab);
  if (line > 0) goToLine(line, col, len);
  if (!item) revealInTree(path);
}

function goToLine(line, col = 0, len = 0) {
  const lines = ta.value.split("\n");
  const ln = Math.max(1, Math.min(line, lines.length));
  let pos = 0;
  for (let i = 0; i < ln - 1; i++) pos += lines[i].length + 1;
  pos += Math.max(0, Math.min(col, lines[ln - 1].length));
  ta.focus();
  ta.setSelectionRange(pos, pos + len);
  // Centre la ligne visée dans la vue.
  ta.scrollTop = Math.max(0, (ln - 1) * lineHeight() - ta.clientHeight / 2);
  syncScroll();
  updateCursor();
}

let gutterLines = -1;
function refresh() {
  hl.innerHTML = highlight(ta.value, lang) + "\n";
  gutterLines = -1;
  syncCodeSize();
  updateCursor();
  syncScroll();
}
function renderGutter(curLine) {
  const n = ta.value.split("\n").length;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) rows[i] = i + 1 === curLine ? `<span class="ln-cur">${i + 1}</span>` : String(i + 1);
  gutter.innerHTML = rows.join("\n");
  gutterLines = n;
}
function syncCodeSize() {
  const wrap = ta.parentElement;
  const longest = ta.value.split("\n").reduce((max, line) => Math.max(max, line.replace(/\t/g, "  ").length), 0);
  const contentWidth = Math.ceil(longest * charWidth() + 40);
  const width = Math.max(wrap.clientWidth, contentWidth);
  ta.style.width = width + "px";
  $("highlight").style.width = width + "px";
  const height = Math.max(wrap.clientHeight, ta.scrollHeight);
  $("highlight").style.height = height + "px";
  gutter.style.height = height + "px";
}
let cachedCharWidth = 0;
function charWidth() {
  if (cachedCharWidth) return cachedCharWidth;
  const probe = document.createElement("span");
  probe.textContent = "mmmmmmmmmm";
  const cs = getComputedStyle(ta);
  probe.style.cssText = `position:absolute;visibility:hidden;font:${cs.fontSize} ${cs.fontFamily};white-space:pre;`;
  document.body.appendChild(probe);
  cachedCharWidth = probe.getBoundingClientRect().width / 10 || 7.6;
  probe.remove();
  return cachedCharWidth;
}
let cachedLineHeight = 0;
function lineHeight() {
  if (!cachedLineHeight) cachedLineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  return cachedLineHeight;
}
function syncScroll() {
  $("highlight").style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
  positionCurLine();
}

// Ligne / colonne du curseur, surbrillance de la ligne courante, barre d'état.
let curLine = 1;
function updateCursor() {
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - before.lastIndexOf("\n");
  const selLen = Math.abs(ta.selectionEnd - ta.selectionStart);
  if (line !== curLine || gutterLines !== ta.value.split("\n").length) { curLine = line; renderGutter(line); }
  positionCurLine();
  $("sb-pos").textContent = openPath ? `Ln ${line}, Col ${col}${selLen ? ` (${selLen} sélectionné${selLen > 1 ? "s" : ""})` : ""}` : "";
}
function positionCurLine() {
  const el = $("cur-line");
  if (!openPath || ta.selectionStart !== ta.selectionEnd) { el.hidden = true; return; }
  el.hidden = false;
  el.style.top = 10 + (curLine - 1) * lineHeight() - ta.scrollTop + "px";
  el.style.height = lineHeight() + "px";
}

function isDirty() { return openPath && ta.value !== original; }
function markDirty() {
  if (active) active.content = ta.value;
  $("dirty").hidden = !isDirty();
  const el = $("tabs").querySelector(".tab.active");
  if (el) el.classList.toggle("dirty", !!isDirty());
  renderOpenEditors();
  updateStatus();
}

function updateStatus() {
  $("sb-sandbox").innerHTML = `${icon("box", 13)}<span>${escapeHtml(sandboxName() || "Aucune sandbox")}</span>`;
  $("sb-lang").textContent = openPath ? (LANG_LABELS[lang] || lang) : "";
  const nDirty = tabs.filter(tabDirty).length;
  $("sb-dirty").textContent = nDirty ? `${nDirty} non enregistré${nDirty > 1 ? "s" : ""}` : "";
}

async function save() {
  if (!openPath) return;
  if (truncated) { toast("Fichier tronqué : enregistrement bloqué pour éviter une perte de données."); return; }
  const syntaxErr = jsSyntaxError(openPath, ta.value);
  if (syntaxErr) { toast("Syntaxe invalide, enregistrement bloqué : " + syntaxErr); return; }
  try {
    await invoke("sandbox_write_file", { id: sandboxId, path: openPath, content: ta.value });
    original = ta.value;
    if (active) active.original = ta.value;
    markDirty(); renderTabs();
    toast("Enregistré.");
  } catch (e) { toast("Échec : " + (e.message || e)); }
}

async function saveAll() {
  stashActive();
  let n = 0;
  for (const t of tabs) {
    if (!tabDirty(t) || t.truncated) continue;
    const err = jsSyntaxError(t.path, t.content);
    if (err) { toast(`${t.path} : syntaxe invalide, ignoré.`); continue; }
    try { await invoke("sandbox_write_file", { id: sandboxId, path: t.path, content: t.content }); t.original = t.content; n++; }
    catch (e) { toast(`${t.path} : ` + (e.message || e)); }
  }
  if (active) original = active.original;
  markDirty(); renderTabs();
  toast(n ? `${n} fichier(s) enregistré(s).` : "Rien à enregistrer.");
}

// Met à jour un onglet ouvert après une écriture externe (IA dossier…).
function updateTabContent(path, content) {
  const t = tabs.find((x) => x.path === path);
  if (!t) return;
  t.content = content; t.original = content;
  if (t === active) { ta.value = content; original = content; refresh(); }
  markDirty(); renderTabs();
}

// ===== Aperçu (apps HTML autonomes ET multi-fichiers) =====
// Reconstruit l'app via bundleApp (inline app.js/styles.css liés + pont console),
// pour qu'un projet index.html + app.js + styles.css s'exécute réellement. Le
// fichier en cours d'édition est injecté NON SAUVEGARDÉ via les overrides.
async function preview() {
  if (!openPath) return;
  // Résout le point d'entrée HTML : le fichier ouvert s'il est en HTML, sinon
  // index.html du même dossier (pour prévisualiser en éditant app.js/styles.css).
  let entry = openPath;
  if (lang !== "html") {
    const dir = openPath.includes("/") ? openPath.slice(0, openPath.lastIndexOf("/")) : "";
    let sibs = [];
    try { sibs = await invoke("sandbox_read_dir", { id: sandboxId, path: dir }); } catch {}
    const html = sibs.filter((e) => !e.is_dir && /\.html?$/i.test(e.name));
    const idx = html.find((e) => /^index\.html?$/i.test(e.name)) || html[0];
    if (!idx) { toast("Aucun index.html dans ce dossier pour l'aperçu."); return; }
    entry = idx.path;
  }

  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="review-modal" style="width:min(900px,94vw);height:80vh;display:flex;flex-direction:column">
    <div class="mini-actions" style="margin:0 0 8px"><h3 style="margin:0">Aperçu — ${entry}</h3><span class="spacer"></span>
      <button class="btn-soft ic-btn" data-act="console">${icon("terminal")}<span class="lbl">Console</span></button>
      <button class="btn-soft" data-act="close">Fermer</button></div>
    <iframe style="flex:1;border:1px solid var(--border);border-radius:10px;background:#fff"></iframe>
    <div class="ed-console" hidden style="flex:0 0 160px;margin-top:8px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:6px 0;font:12px/1.5 ui-monospace,Menlo,monospace"></div></div>`;
  const frame = ov.querySelector("iframe");
  const consoleEl = ov.querySelector(".ed-console");
  const onMsg = (e) => {
    const d = e.data;
    // WKWebView peut fournir `event.source === null` pour une iframe sandboxée.
    // Le marqueur __sbConsole vient de notre bundle, donc on garde seulement le
    // filtre de source quand WebKit nous donne effectivement une source.
    if (!d || !d.__sbConsole) return;
    if (e.source && e.source !== frame.contentWindow) return;
    consoleEl.hidden = false;
    const line = document.createElement("div");
    line.style.padding = "3px 12px";
    line.style.whiteSpace = "pre-wrap";
    line.style.borderBottom = "1px solid var(--border)";
    line.style.color = d.level === "error" ? "#ff3b30" : d.level === "warn" ? "#b8860b" : "";
    const where = d.source ? ` ${d.source}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ""}` : ""}` : "";
    line.textContent = `[${d.level || "log"}] ${d.text || ""}${where}`;
    if (d.stack) {
      const stack = document.createElement("div");
      stack.style.marginTop = "3px";
      stack.style.opacity = "0.75";
      stack.textContent = d.stack;
      line.appendChild(stack);
    }
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  };
  window.addEventListener("message", onMsg);
  ov.querySelector('[data-act="close"]').addEventListener("click", () => { window.removeEventListener("message", onMsg); ov.remove(); });
  ov.querySelector('[data-act="console"]').addEventListener("click", () => { consoleEl.hidden = !consoleEl.hidden; });
  // Confinement : sandbox SANS allow-same-origin (origine opaque). Les scripts
  // inline s'exécutent grâce à dangerousDisableAssetCspModification (la CSP du
  // parent garde son 'unsafe-inline', sans nonce, donc héritée telle quelle par srcdoc).
  frame.setAttribute("sandbox", "allow-scripts allow-modals allow-forms allow-pointer-lock");
  frame.setAttribute("referrerpolicy", "no-referrer");
  document.body.appendChild(ov);
  try {
    frame.srcdoc = await bundleApp(sandboxId, entry, { [openPath]: ta.value });
  } catch (e) {
    toast("Aperçu impossible : " + (e?.message || e));
  }
}

// ===== Historique + diff =====
async function openVersion(ts) {
  try {
    const content = await invoke("sandbox_snapshot_get", { id: sandboxId, path: openPath, ts });
    renderDiff($("diff-view"), content, ta.value, () => {
      // restaure cette version dans l'éditeur (sauvegarde manuelle ensuite)
      ta.value = content; showDiff(false); refresh(); markDirty();
      toast("Version chargée — enregistrez pour la conserver.");
    });
    showDiff(true);
  } catch (e) { toast("Lecture impossible : " + (e.message || e)); }
}

function renderDiff(container, oldText, newText, onRestore) {
  const blocks = diffLines(oldText, newText);
  container.textContent = "";
  if (onRestore) {
    const bar = document.createElement("div");
    bar.className = "mini-actions"; bar.style.padding = "0 12px 8px";
    bar.innerHTML = `<span class="ai-state">Ancienne version → actuelle</span><span class="spacer"></span>`;
    const back = document.createElement("button"); back.className = "btn-soft"; back.textContent = "Revenir à l'éditeur";
    back.addEventListener("click", () => showDiff(false));
    const rest = document.createElement("button"); rest.className = "btn-soft primary"; rest.textContent = "Restaurer cette version";
    rest.addEventListener("click", onRestore);
    bar.append(back, rest); container.appendChild(bar);
  }
  for (const b of blocks) {
    if (b.type === "eq") {
      for (const l of b.lines.slice(0, 200)) container.appendChild(diffLine(" ", l, ""));
    } else {
      for (const l of b.del) container.appendChild(diffLine("-", l, "del"));
      for (const l of b.ins) container.appendChild(diffLine("+", l, "add"));
    }
  }
}
function diffLine(sign, text, cls) {
  const d = document.createElement("div");
  d.className = "diff-line " + cls;
  const s = document.createElement("span"); s.className = "sign"; s.textContent = sign;
  d.appendChild(s); d.appendChild(document.createTextNode(text));
  return d;
}

// ===== Menu contextuel + IA =====
function selection() {
  return { start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) };
}
function showCtx(x, y) {
  const m = $("ctx-menu");
  const margin = 8;
  m.hidden = false;
  m.style.left = "0px";
  m.style.top = "0px";
  const rect = m.getBoundingClientRect();
  const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
  m.style.left = left + "px";
  m.style.top = top + "px";
}
let pendingSel = null;
let pendingAiMode = "modify";

async function aiAsk() {
  pendingSel = selection();
  if (!pendingSel.text.trim()) { toast("Sélectionnez d'abord du code."); return; }
  pendingAiMode = "ask";
  $("ai-title").textContent = "Demander à l'IA";
  $("ai-sel").textContent = pendingSel.text;
  $("ai-instr").value = ""; $("ai-state").textContent = "";
  $("ai-instr").placeholder = "Ex. : explique ce bloc, trouve un bug potentiel, propose une amélioration…";
  $("ai-run").textContent = "Demander";
  $("ai-overlay").hidden = false; $("ai-instr").focus();
}
async function aiModify() {
  pendingSel = selection();
  if (!pendingSel.text.trim()) { toast("Sélectionnez d'abord du code."); return; }
  pendingAiMode = "modify";
  $("ai-title").textContent = "Modifier la sélection avec l'IA";
  $("ai-sel").textContent = pendingSel.text;
  $("ai-instr").value = ""; $("ai-state").textContent = "";
  $("ai-instr").placeholder = "Ex. : ajoute la gestion des erreurs, renomme en camelCase, traduis les commentaires…";
  $("ai-run").textContent = "Proposer";
  $("ai-overlay").hidden = false; $("ai-instr").focus();
}
async function runAiModify() {
  const instr = $("ai-instr").value.trim();
  if (!instr) { toast(pendingAiMode === "ask" ? "Écrivez votre demande." : "Décrivez la modification."); return; }
  $("ai-state").textContent = "Génération…";
  try {
    if (pendingAiMode === "ask") {
      // La fenêtre de réponse s'ouvre tout de suite et se remplit en flux.
      $("ai-overlay").hidden = true;
      const live = showInfo("Réponse de l'IA", "", { live: true });
      const { messages } = PROMPTS["app.editor.chat"].build({ request: instr, code: pendingSel.text, language: lang, lang: replyLang() });
      const { content, data } = await llmChat(messages, aiOpts({ onUpdate: live.onUpdate }));
      recordOllamaUsage(data, "editor");
      live.done(escText(content.trim()));
      return;
    }
    const { messages } = PROMPTS["app.editor.modify"].build({ instruction: instr, code: pendingSel.text, language: lang });
    // Progression visible pendant la génération du code (nombre de lignes).
    const { content, data } = await llmChat(messages, aiOpts({
      onDelta: (txt) => { $("ai-state").textContent = `Génération… ${txt.split("\n").length} ligne(s)`; },
    }));
    recordOllamaUsage(data, "editor");
    const proposed = stripFences(content);
    $("ai-overlay").hidden = true;
    reviewReplacement(pendingSel, proposed);
  } catch (e) { $("ai-state").textContent = ""; toast("Échec IA : " + (e.message || e)); }
}
function stripFences(s) {
  return s.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}
function reviewReplacement(sel, proposed) {
  renderDiff($("review-diff"), sel.text, proposed, null);
  $("review-overlay").hidden = false;
  $("review-accept").disabled = false;
  $("review-accept").textContent = "Appliquer";
  $("review-accept").onclick = () => {
    ta.value = ta.value.slice(0, sel.start) + proposed + ta.value.slice(sel.end);
    $("review-overlay").hidden = true; refresh(); markDirty();
    toast("Modification appliquée.");
  };
  $("review-reject").onclick = () => ($("review-overlay").hidden = true);
}
async function aiExplain() {
  const sel = selection();
  if (!sel.text.trim()) { toast("Sélectionnez d'abord du code."); return; }
  const live = showInfo("Explication", "", { live: true });
  try {
    const { content, data } = await llmChat(PROMPTS["app.editor.explain"].build({ code: sel.text, lang: replyLang() }).messages, aiOpts({ onUpdate: live.onUpdate }));
    recordOllamaUsage(data, "editor");
    live.done(escText(content.trim()));
  } catch (e) { toast("Échec IA : " + (e.message || e)); }
}
const escText = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// `live` : la fenêtre s'ouvre vide et renvoie une cible de flux (streamTarget).
function showInfo(title, text, { live = false } = {}) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="mini-modal"><h3></h3><div class="info-body" style="white-space:pre-wrap;line-height:1.5;max-height:50vh;overflow:auto"></div><div class="mini-actions"><span class="spacer"></span><button class="btn-soft primary">Fermer</button></div></div>`;
  ov.querySelector("h3").textContent = title;
  ov.querySelector(".info-body").textContent = text;
  ov.querySelector("button").addEventListener("click", () => ov.remove());
  document.body.appendChild(ov);
  if (live) {
    const body = ov.querySelector(".info-body");
    body.textContent = "…";
    return streamTarget(body, escText, { onRender: () => { body.scrollTop = body.scrollHeight; } });
  }
}

// ===== Gestion de fichiers (création / import / menu arbre) =====
// Petite modale de saisie (confirm/prompt natifs peu fiables dans WKWebView).
function promptModal(title, placeholder = "", value = "") {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `<div class="mini-modal" style="width:min(440px,92vw)"><h3></h3>
      <input class="ta" id="pm-input" style="width:100%;box-sizing:border-box" spellcheck="false" />
      <div class="mini-actions"><span class="spacer"></span>
        <button class="btn-soft" data-a="c">Annuler</button>
        <button class="btn-soft primary" data-a="ok">Valider</button></div></div>`;
    ov.querySelector("h3").textContent = title;
    const input = ov.querySelector("#pm-input");
    input.placeholder = placeholder; input.value = value;
    const done = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('[data-a="c"]').addEventListener("click", () => done(null));
    ov.querySelector('[data-a="ok"]').addEventListener("click", () => done(input.value.trim() || null));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(input.value.trim() || null); } else if (e.key === "Escape") done(null); });
    document.body.appendChild(ov);
    input.focus(); input.select();
  });
}
function confirmModal(message) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `<div class="mini-modal" style="width:min(440px,92vw)"><h3></h3>
      <div class="mini-actions"><span class="spacer"></span>
        <button class="btn-soft" data-a="c">Annuler</button>
        <button class="btn-soft primary" data-a="ok">Confirmer</button></div></div>`;
    ov.querySelector("h3").textContent = message;
    const done = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('[data-a="c"]').addEventListener("click", () => done(false));
    ov.querySelector('[data-a="ok"]').addEventListener("click", () => done(true));
    document.body.appendChild(ov);
  });
}

async function newEntry(isDir) {
  if (!sandboxId) { toast("Sélectionnez d'abord une sandbox."); return; }
  const name = await promptModal(isDir ? "Nouveau dossier" : "Nouveau fichier", isDir ? "components" : "script.js");
  if (!name) return;
  const clean = name.split("/").pop().trim();
  if (!clean) return;
  const path = activeDir ? `${activeDir}/${clean}` : clean;
  try {
    await invoke(isDir ? "sandbox_create_dir" : "sandbox_create_file", { id: sandboxId, path });
    if (activeDir) expandedDirs.add(activeDir);
    if (isDir) expandedDirs.add(path);
    await loadTree();
    if (!isDir) await openFile(path);
  } catch (e) { toast("Échec : " + (e.message || e)); }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ""); const c = s.indexOf(","); resolve(c >= 0 ? s.slice(c + 1) : s); };
    r.onerror = () => reject(new Error("lecture impossible"));
    r.readAsDataURL(file);
  });
}
async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!sandboxId || !files.length) return;
  let ok = 0;
  for (const f of files) {
    try {
      const b64 = await fileToBase64(f);
      const path = activeDir ? `${activeDir}/${f.name}` : f.name;
      await invoke("sandbox_import_file", { id: sandboxId, path, dataB64: b64 });
      ok++;
    } catch (e) { toast(`« ${f.name} » : ` + (e?.message || e)); }
  }
  if (activeDir) expandedDirs.add(activeDir);
  if (ok) toast(`${ok} fichier(s) importé(s) dans ${activeDir || "la racine"}.`);
  await loadTree();
}

function openTreeMenu(ev, entry) {
  const menu = $("tree-menu");
  menu.innerHTML = "";
  const add = (ic, label, fn) => { const b = document.createElement("button"); b.innerHTML = icon(ic) + `<span>${escapeHtml(label)}</span>`; b.addEventListener("click", () => { menu.hidden = true; fn(); }); menu.appendChild(b); };
  const dir = entry.is_dir ? entry.path : (entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "");
  if (entry.is_dir) {
    setActiveDir(entry.path);
    add("filePlus", "Nouveau fichier", () => newEntry(false));
    add("folderPlus", "Nouveau dossier", () => newEntry(true));
    add("upload", "Importer ici…", () => $("ed-file-input").click());
  } else {
    setActiveDir(dir);
    add("file", "Ouvrir", () => openFile(entry.path));
  }
  add("sparkles", "Modifier ce dossier avec l'IA…", () => openFolderAi(dir));
  add("pencil", "Renommer…", () => renameEntry(entry));
  add("trash", "Supprimer", () => deleteEntry(entry));
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(ev.clientX, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(ev.clientY, window.innerHeight - r.height - 8) + "px";
}
async function renameEntry(entry) {
  const name = await promptModal("Renommer", entry.name, entry.name);
  if (!name || name === entry.name) return;
  const newName = name.split("/").pop().trim();
  if (!newName) return;
  try {
    await invoke("sandbox_rename", { id: sandboxId, path: entry.path, newName });
    const newPath = (entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) : "") + newName;
    // Onglets ouverts sur ce chemin (ou dans ce dossier) : on suit le renommage.
    for (const t of tabs) {
      if (t.path === entry.path || t.path.startsWith(entry.path + "/")) {
        t.path = newPath + t.path.slice(entry.path.length);
        t.lang = langFromName(t.path);
      }
    }
    if (active) { openPath = active.path; lang = active.lang; refresh(); renderTabs(); renderBreadcrumbs(); updateStatus(); }
    await loadTree();
  } catch (e) { toast("Échec : " + (e.message || e)); }
}
async function deleteEntry(entry) {
  const ok = await confirmModal(`Supprimer « ${entry.name} » ?` + (entry.is_dir ? " (dossier et contenu)" : ""));
  if (!ok) return;
  try {
    await invoke("sandbox_delete_path", { id: sandboxId, path: entry.path });
    // Ferme sans question les onglets du fichier (ou du dossier) supprimé.
    const gone = tabs.filter((t) => t.path === entry.path || (entry.is_dir && t.path.startsWith(entry.path + "/")));
    for (const t of gone) { if (t === active) stashActive(); t.original = t.content; await closeTab(t); }
    expandedDirs.delete(entry.path);
    await loadTree();
  } catch (e) { toast("Échec : " + (e.message || e)); }
}

// ===== IA sur tout un dossier (contexte multi-fichiers HTML/CSS/JS) =====
const TEXT_EXT = new Set(["html", "htm", "css", "js", "mjs", "cjs", "json", "txt", "md", "svg", "xml", "ts", "jsx", "tsx"]);
let faiFolder = "";
let faiProposal = null; // { folder, originals, files:[{ rel, full, blocks, ext }] }

function openFolderAi(folder) {
  if (!sandboxId) { toast("Sélectionnez d'abord une sandbox."); return; }
  faiFolder = folder || activeDir || "";
  $("fai-folder").textContent = "Dossier : " + (faiFolder || "(racine de la sandbox)");
  $("fai-instr").value = ""; $("fai-state").textContent = "";
  $("fai-result").hidden = true; $("fai-result").innerHTML = "";
  $("fai-log").hidden = true; $("fai-log").innerHTML = "";
  faiProposal = null; updateFolderAiApplyState();
  $("folder-ai-overlay").hidden = false; $("fai-instr").focus();
}

// Collecte récursive des fichiers texte du dossier (chemins RELATIFS au dossier).
async function collectFolderFiles(folder) {
  const acc = {};
  const walk = async (dir) => {
    let entries = [];
    try { entries = await invoke("sandbox_read_dir", { id: sandboxId, path: dir }); } catch { return; }
    for (const e of entries) {
      if (Object.keys(acc).length >= 30) return;
      if (e.is_dir) { await walk(e.path); continue; }
      const ext = e.name.split(".").pop().toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      try {
        const fc = await invoke("sandbox_read_file", { id: sandboxId, path: e.path });
        if (fc && !fc.binary) {
          const rel = folder ? e.path.slice(folder.length + 1) : e.path;
          acc[rel] = String(fc.content || "").slice(0, 48000);
        }
      } catch {}
    }
  };
  await walk(folder);
  // Le fichier ouvert peut avoir des modifs non sauvegardées : on prend le buffer.
  if (openPath && (folder ? openPath.startsWith(folder + "/") : true)) {
    const rel = folder ? openPath.slice(folder.length + 1) : openPath;
    if (rel in acc) acc[rel] = ta.value;
  }
  return acc;
}

function parseFolderStep(content) {
  let raw = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch {} } }
  if (!obj || typeof obj !== "object") return { summary: "", files: [] };
  const files = Array.isArray(obj.files) ? obj.files.map((f) => ({
    path: f.path,
    action: f.action || (Array.isArray(f.hunks) ? "edit" : "rewrite"),
    content: typeof f.content === "string" ? f.content : undefined,
    hunks: Array.isArray(f.hunks) ? f.hunks : undefined,
  })) : [];
  return { summary: typeof obj.summary === "string" ? obj.summary : "", files };
}
function applyHunks(content, hunks) {
  let out = content, applied = 0, missed = 0, ambiguous = 0, skipped = 0;
  for (const h of hunks) {
    const search = String(h?.search ?? ""), replace = String(h?.replace ?? "");
    if (!search) { missed++; continue; }
    const idx = out.indexOf(search);
    if (idx === -1) {
      // Idempotence : si le remplacement est déjà en place, ce n'est pas une erreur
      // (cas typique d'une ré-application en mode agent : on évite le doublon).
      if (replace && out.includes(replace)) skipped++;
      else missed++;
      continue;
    }
    // Unicité : un `search` ambigu (≥2 occurrences) éditerait au hasard la première
    // et laisserait l'autre en place → doublon. On refuse plutôt que de deviner.
    if (out.indexOf(search, idx + search.length) !== -1) { ambiguous++; continue; }
    out = out.slice(0, idx) + replace + out.slice(idx + search.length); applied++;
  }
  return { content: out, applied, missed, ambiguous, skipped };
}
// Garde de syntaxe pour les scripts : compile le code sans l'exécuter (new Function)
// afin d'attraper AVANT écriture les erreurs « top-level return », accolades
// orphelines, etc. — typiquement issues d'un hunk dupliqué. Ignore les modules
// (import/export) que new Function ne sait pas compiler. Renvoie un message
// d'erreur lisible, ou null si la syntaxe est valide / non vérifiable.
function jsSyntaxError(name, code) {
  if (!/\.(c|m)?jsx?$/i.test(String(name || ""))) return null;
  if (/^\s*(import|export)\s/m.test(code || "")) return null; // module : non vérifiable ici
  try { new Function(code || ""); return null; }
  catch (e) { return (e && e.message) || String(e); }
}

function normalizeRel(p) {
  return String(p || "").split("/").filter((s) => s && s !== "." && s !== "..").join("/");
}
async function runFolderAi() {
  const instr = $("fai-instr").value.trim();
  if (!instr) { toast("Décrivez la modification."); return; }
  const runBtn = $("fai-run"); runBtn.disabled = true;
  faiProposal = null; updateFolderAiApplyState(); resetFolderAiLog();
  $("fai-result").hidden = true; $("fai-result").innerHTML = "";
  $("fai-state").textContent = "Lecture des fichiers…";
  try {
    const originals = await collectFolderFiles(faiFolder);
    if (!Object.keys(originals).length) { $("fai-state").textContent = ""; toast("Aucun fichier texte dans ce dossier."); return; }
    const mode = $("fai-mode").value || "edit";
    if (mode === "agent") {
      // Harnais de code : boucle lire → modifier → vérifier (syntaxe, liens,
      // exécution) sur une copie en mémoire ; l'utilisateur valide les diffs.
      const maxSteps = Math.max(2, Math.min(30, parseInt($("fai-iters").value, 10) || 12));
      logFolderAi("read", "Lecture", `${Object.keys(originals).length} fichier(s) texte chargés.`);
      const res = await runCodeHarness({
        instruction: instr,
        files: originals,
        maxSteps,
        llm: async (messages) => {
          const { content, data } = await llmChat(messages, aiOpts({ json: true }));
          recordOllamaUsage(data, "editor-agent");
          return content;
        },
        runtimeCheck: runAppForErrors,
        onEvent: (ev) => {
          logFolderAi(ev.kind === "ok" ? "read" : ev.kind, ev.title, ev.body || "");
          if (ev.kind === "think" && /^Étape/.test(ev.title)) $("fai-state").textContent = ev.title + "…";
        },
      });
      const tail = res.status === "done" ? "" : res.status === "budget" ? " (budget d'étapes atteint)" : " (agent arrêté)";
      const warn = res.problems.length ? ` — ${res.problems.length} problème(s) restant(s)` : "";
      buildFolderProposal(originals, res.files, (res.summary || "Proposition de l'agent.") + tail + warn);
      $("fai-state").textContent = faiProposal?.files?.length ? "Diffs prêts à valider." : "";
      renderFolderProposal();
      return;
    }
    const maxIters = mode === "agent" ? Math.max(1, Math.min(5, parseInt($("fai-iters").value, 10) || 3)) : 1;
    let working = { ...originals };
    let lastSummary = "";
    logFolderAi("read", "Lecture", `${Object.keys(originals).length} fichier(s) texte chargés.`);
    for (let iter = 1; iter <= maxIters; iter++) {
      $("fai-state").textContent = mode === "agent" ? `Itération ${iter}/${maxIters}…` : "Génération…";
      logFolderAi("think", mode === "agent" ? `Itération ${iter}` : "Modification", "Demande envoyée à l'IA.");
      const { messages, opts } = PROMPTS["app.editor.folder"].build({ instruction: instr, files: working, agentic: mode === "agent", iter, maxIters });
      const { content, data } = await llmChat(messages, aiOpts({ ...opts }));
      recordOllamaUsage(data, "editor-folder");
      const step = parseFolderStep(content);
      lastSummary = step.summary || lastSummary;
      if (!step.files.length) { logFolderAi("warn", "Aucun patch", "L'IA n'a renvoyé aucune modification structurée."); break; }
      let changed = 0;
      for (const op of step.files) {
        const rel = normalizeRel(op.path);
        if (!rel) continue;
        const existing = working[rel] ?? "";
        let next;
        if (op.action === "edit" && Array.isArray(op.hunks) && rel in working) {
          const res = applyHunks(existing, op.hunks);
          next = res.content;
          logFolderAi("diff", rel, `${res.applied}/${op.hunks.length} édition(s)`
            + (res.missed ? `, ${res.missed} introuvable(s)` : "")
            + (res.ambiguous ? `, ${res.ambiguous} ambigu(s)` : "")
            + (res.skipped ? `, ${res.skipped} déjà appliqué(s)` : ""));
        } else if (typeof op.content === "string") {
          next = op.content;
          logFolderAi("diff", rel, rel in working ? "Réécriture proposée" : "Création proposée");
        } else continue;
        if (next !== working[rel]) { working[rel] = next; changed++; }
      }
      if (!changed) break;
      if (mode !== "agent") break;
    }
    buildFolderProposal(originals, working, lastSummary);
    $("fai-state").textContent = faiProposal?.files?.length ? "Diffs prêts à valider." : "";
    renderFolderProposal();
  } catch (e) { $("fai-state").textContent = ""; toast("Échec IA : " + (e.message || e)); }
  finally { runBtn.disabled = false; }
}

// Exécute l'app (index.html + CSS/JS inlinés) dans une iframe isolée et
// renvoie les erreurs JS remontées pendant ~1,5 s (chargement + premiers timers).
function runAppForErrors(files) {
  const entry = Object.keys(files).filter((p) => /(^|\/)index\.html?$/i.test(p)).sort((a, b) => a.length - b.length)[0];
  if (!entry) return Promise.resolve([]);
  return new Promise((resolve) => {
    const token = "lh" + Math.random().toString(36).slice(2);
    const errors = [];
    const probe = `<script>(function(){var t=${JSON.stringify(token)};function s(m){try{parent.postMessage({lumenHarness:t,msg:String(m)},"*")}catch(e){}}`
      + `window.addEventListener("error",function(e){s((e.message||"Erreur")+(e.lineno?" (ligne "+e.lineno+")":""))});`
      + `window.addEventListener("unhandledrejection",function(e){s("Promesse rejetée : "+((e.reason&&e.reason.message)||e.reason))});`
      + `var ce=console.error;console.error=function(){s("console.error : "+[].map.call(arguments,String).join(" "));return ce.apply(console,arguments)};})();<\/script>`;
    let html = inlineApp(files, entry);
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + probe) : probe + html;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;visibility:hidden";
    const onMsg = (e) => { if (e.data && e.data.lumenHarness === token && errors.length < 20) errors.push(e.data.msg); };
    window.addEventListener("message", onMsg);
    frame.srcdoc = html;
    document.body.appendChild(frame);
    setTimeout(() => {
      window.removeEventListener("message", onMsg);
      frame.remove();
      resolve([...new Set(errors)].map((m) => `exécution : ${m}`));
    }, 1500);
  });
}

function buildFolderProposal(originals, working, summary) {
  const files = [];
  for (const rel of Object.keys(working).sort()) {
    const before = originals[rel] ?? "";
    const after = working[rel] ?? "";
    if (before === after) continue;
    const blocks = diffLines(before, after);
    if (countChanges(blocks) === 0) continue;
    files.push({
      rel,
      full: faiFolder ? `${faiFolder}/${rel}` : rel,
      ext: rel.split(".").pop().toLowerCase(),
      blocks,
      created: !(rel in originals),
    });
  }
  faiProposal = { folder: faiFolder, summary: summary || "Proposition prête à valider.", files };
}

function renderFolderProposal() {
  const result = $("fai-result");
  result.hidden = false;
  result.innerHTML = "";
  if (!faiProposal || !faiProposal.files.length) {
    result.innerHTML = `<div class="fai-empty">Aucune modification proposée.</div>`;
    updateFolderAiApplyState();
    return;
  }
  const head = document.createElement("div");
  head.className = "fai-sum";
  head.textContent = faiProposal.summary;
  result.appendChild(head);
  for (const f of faiProposal.files) {
    const section = document.createElement("section");
    section.className = "fai-file";
    const title = document.createElement("div");
    title.className = "fai-file-head";
    title.innerHTML = `<b>${escapeHtml(f.rel)}</b><span>${f.created ? "nouveau" : `${countChanges(f.blocks)} bloc(s)`}</span>`;
    section.appendChild(title);
    const diff = document.createElement("div");
    diff.className = "fai-diff diff-view";
    renderAcceptableDiff(diff, f.blocks, () => renderFolderProposal());
    section.appendChild(diff);
    result.appendChild(section);
  }
  updateFolderAiApplyState();
}

function renderAcceptableDiff(container, blocks, onChange) {
  container.textContent = "";
  const bar = document.createElement("div");
  bar.className = "diff-actions";
  const acceptAll = document.createElement("button");
  acceptAll.className = "btn-soft";
  acceptAll.textContent = "Tout accepter";
  const rejectAll = document.createElement("button");
  rejectAll.className = "btn-soft";
  rejectAll.textContent = "Tout refuser";
  acceptAll.addEventListener("click", () => { blocks.forEach((b) => { if (b.type === "change") b.accepted = true; }); onChange(); });
  rejectAll.addEventListener("click", () => { blocks.forEach((b) => { if (b.type === "change") b.accepted = false; }); onChange(); });
  bar.append(acceptAll, rejectAll);
  container.appendChild(bar);
  for (const b of blocks) {
    if (b.type === "eq") {
      const lines = b.lines.length > 8 ? [...b.lines.slice(0, 4), `… ${b.lines.length - 8} lignes inchangées …`, ...b.lines.slice(-4)] : b.lines;
      for (const l of lines) container.appendChild(diffLine(" ", l, ""));
    } else {
      const hunk = document.createElement("div");
      hunk.className = "diff-hunk" + (b.accepted === false ? " rejected" : "");
      const h = document.createElement("div");
      h.className = "diff-hunk-head";
      const label = document.createElement("span");
      label.textContent = b.accepted === false ? "Refusé : garde l'original" : "Accepté : applique la proposition";
      const toggle = document.createElement("button");
      toggle.className = "btn-soft";
      toggle.textContent = b.accepted === false ? "Accepter" : "Refuser";
      toggle.addEventListener("click", () => { b.accepted = b.accepted === false; onChange(); });
      h.append(label, toggle);
      hunk.appendChild(h);
      for (const l of b.del) hunk.appendChild(diffLine("-", l, "del"));
      for (const l of b.ins) hunk.appendChild(diffLine("+", l, "add"));
      container.appendChild(hunk);
    }
  }
}

function acceptedFolderChangeCount() {
  if (!faiProposal) return 0;
  return faiProposal.files.reduce((n, f) => n + f.blocks.filter((b) => b.type === "change" && b.accepted !== false).length, 0);
}

function updateFolderAiApplyState() {
  const btn = $("fai-apply");
  if (!btn) return;
  const n = acceptedFolderChangeCount();
  btn.hidden = !faiProposal || !faiProposal.files.length;
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? "Aucun changement accepté" : `Appliquer ${n} changement(s) accepté(s)`;
}

async function applyFolderAiProposal() {
  if (!faiProposal || !faiProposal.files.length) return;
  const btn = $("fai-apply");
  btn.disabled = true;
  $("fai-state").textContent = "Écriture des fichiers…";
  try {
    for (const f of faiProposal.files) {
      if (!f.blocks.some((b) => b.type === "change" && b.accepted !== false)) continue;
      const content = applyDiff(f.blocks);
      const syntaxErr = jsSyntaxError(f.full, content);
      if (syntaxErr) { logFolderAi("warn", "Écriture annulée : " + f.full, "Syntaxe invalide : " + syntaxErr); continue; }
      await invoke("sandbox_write_file", { id: sandboxId, path: f.full, content });
      logFolderAi("write", "Écrit", f.full);
      updateTabContent(f.full, content);
    }
    if (faiFolder) expandedDirs.add(faiFolder);
    await loadTree();
    $("fai-state").textContent = "Changements appliqués.";
    faiProposal = null; updateFolderAiApplyState();
    toast("Changements validés et écrits.");
  } catch (e) {
    $("fai-state").textContent = "";
    toast("Échec écriture : " + (e.message || e));
    updateFolderAiApplyState();
  }
}

function resetFolderAiLog() {
  const log = $("fai-log");
  log.hidden = false;
  log.innerHTML = "";
}

function logFolderAi(kind, title, body = "") {
  const log = $("fai-log");
  log.hidden = false;
  const row = document.createElement("div");
  row.className = "fai-log-row fai-log-" + kind;
  row.innerHTML = `<span class="fai-log-dot"></span><span class="fai-log-main"><b>${escapeHtml(title)}</b>${body ? `<small>${escapeHtml(body)}</small>` : ""}</span>`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function updateFolderAiMode() {
  const mode = $("fai-mode")?.value || "edit";
  $("fai-iter-wrap").hidden = mode !== "agent";
  $("fai-run").textContent = mode === "agent" ? "Lancer l'agent" : "Préparer les diffs";
}


// ===== Vues de la barre latérale =====
let currentView = "explorer";
function showView(view) {
  if (view === "ai") { toggleChat(); return; }
  const sb = $("sidebar");
  // Re-cliquer l'icône de la vue ouverte replie la barre (comme VS Code).
  if (view === currentView && !sb.classList.contains("collapsed")) { sb.classList.add("collapsed"); syncActivity(); saveLayout(); return; }
  sb.classList.remove("collapsed");
  currentView = view;
  document.querySelectorAll(".side-view").forEach((v) => { v.hidden = v.dataset.view !== view; });
  syncActivity();
  if (view === "search") setTimeout(() => $("search-input").focus(), 0);
  if (view === "history") loadHistory();
  saveLayout();
  requestAnimationFrame(() => openPath && syncCodeSize());
}
function syncActivity() {
  const collapsed = $("sidebar").classList.contains("collapsed");
  document.querySelectorAll(".act[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === "ai" ? !$("chat").hidden : (!collapsed && b.dataset.view === currentView));
  });
}
function toggleSidebar() {
  $("sidebar").classList.toggle("collapsed");
  syncActivity(); saveLayout();
  requestAnimationFrame(() => openPath && syncCodeSize());
}
function toggleChat(force) {
  const chat = $("chat");
  chat.hidden = force === undefined ? !chat.hidden : !force;
  syncActivity(); saveLayout();
  if (!chat.hidden) { renderChatCtx(); setTimeout(() => $("chat-input").focus(), 0); }
  requestAnimationFrame(() => openPath && syncCodeSize());
}
function saveLayout() {
  lsSet("editorLayout", JSON.stringify({
    view: currentView, collapsed: $("sidebar").classList.contains("collapsed"), chat: !$("chat").hidden,
    side: parseInt(getComputedStyle(document.documentElement).getPropertyValue("--side-w"), 10) || 260,
  }));
}
function restoreLayout() {
  let l = {};
  try { l = JSON.parse(lsGet("editorLayout") || "{}"); } catch {}
  if (l.side) document.documentElement.style.setProperty("--side-w", Math.max(180, Math.min(520, l.side)) + "px");
  currentView = ["explorer", "search"].includes(l.view) ? l.view : "explorer";
  document.querySelectorAll(".side-view").forEach((v) => { v.hidden = v.dataset.view !== currentView; });
  $("sidebar").classList.toggle("collapsed", !!l.collapsed);
  $("chat").hidden = !l.chat;
  syncActivity();
}
function bindResizer() {
  const r = $("sidebar-resizer");
  r.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    r.classList.add("drag");
    const left = $("sidebar").getBoundingClientRect().left;
    const move = (ev) => {
      const w = Math.max(180, Math.min(520, ev.clientX - left));
      document.documentElement.style.setProperty("--side-w", w + "px");
    };
    const up = () => {
      r.classList.remove("drag");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveLayout();
      if (openPath) syncCodeSize();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

// ===== Versions (snapshots de sandbox) =====
async function toggleHistory() { showView("history"); }
async function loadHistory() {
  const list = $("history-list");
  list.textContent = "";
  if (!openPath) { list.innerHTML = `<div class="history-item"><div class="when">Ouvrez un fichier pour voir ses versions.</div></div>`; return; }
  let snaps = [];
  try { snaps = await invoke("sandbox_snapshot_list", { id: sandboxId, path: openPath }); } catch {}
  if (!snaps.length) { list.innerHTML = `<div class="history-item">Aucune version antérieure.<div class="when">Les versions sont créées à chaque enregistrement.</div></div>`; return; }
  snaps.sort((a, b) => b.ts - a.ts);
  for (const s of snaps) {
    const it = document.createElement("div");
    it.className = "history-item";
    it.innerHTML = `<div>${escapeHtml(openPath.split("/").pop())}</div><div class="when">${new Date(s.ts * 1000).toLocaleString()} · ${s.size} o</div>`;
    it.addEventListener("click", () => openVersion(s.ts));
    list.appendChild(it);
  }
}
function showDiff(on) {
  $("diff-view").hidden = !on;
  $("editor").hidden = on || !openPath;
  $("welcome").hidden = on || !!openPath;
}

// ===== Recherche dans les fichiers =====
const TEXT_SEARCH_EXT = /\.(html?|css|scss|m?js|cjs|jsx|tsx?|json|md|txt|svg|xml|py|rs|sh|ya?ml|toml|csv|ini|conf)$/i;
let searchTimer = null;
let searchSeq = 0;
async function walkFiles(filter = () => true, max = 600) {
  const out = [];
  const walk = async (dir, depth) => {
    if (out.length >= max || depth > 8) return;
    let entries = [];
    try { entries = await invoke("sandbox_read_dir", { id: sandboxId, path: dir }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.is_dir) { if (!/^(node_modules|\.git|dist|build|target|__pycache__)$/.test(e.name)) await walk(e.path, depth + 1); }
      else if (filter(e)) out.push(e);
    }
  };
  await walk("", 0);
  return out;
}
async function runSearch() {
  const q = $("search-input").value;
  const seq = ++searchSeq;
  const res = $("search-results");
  const state = $("search-state");
  res.textContent = "";
  if (!q.trim() || !sandboxId) { state.textContent = ""; return; }
  let re;
  const cs = $("search-case").classList.contains("on");
  try {
    re = $("search-regex").classList.contains("on")
      ? new RegExp(q, cs ? "g" : "gi")
      : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), cs ? "g" : "gi");
  } catch (e) { state.textContent = "Expression invalide : " + e.message; return; }
  state.textContent = "Recherche…";
  const files = await walkFiles((e) => TEXT_SEARCH_EXT.test(e.name), 400);
  let total = 0, nFiles = 0;
  for (const f of files) {
    if (seq !== searchSeq) return;
    if (total >= 1000) break;
    // Onglet ouvert : on cherche dans le tampon (modifs non enregistrées comprises).
    const tab = tabs.find((t) => t.path === f.path);
    let text = tab ? (tab === active ? ta.value : tab.content) : null;
    if (text == null) {
      try { const fc = await invoke("sandbox_read_file", { id: sandboxId, path: f.path }); if (fc.binary) continue; text = fc.content || ""; } catch { continue; }
    }
    const hits = [];
    text.split("\n").forEach((line, i) => {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m && hits.length < 60) hits.push({ line: i + 1, col: m.index, len: m[0].length || 1, text: line });
    });
    if (!hits.length) continue;
    nFiles++; total += hits.length;
    const head = document.createElement("div");
    head.className = "sr-file";
    head.innerHTML = `${fileBadge(f.name)}<span class="name">${escapeHtml(f.name)}</span><span class="oe-dir" style="color:var(--muted-foreground);font-size:11px">${escapeHtml(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "")}</span><span class="sr-count">${hits.length}</span>`;
    const box = document.createElement("div");
    head.addEventListener("click", () => { box.hidden = !box.hidden; });
    for (const h of hits) {
      const row = document.createElement("span");
      row.className = "sr-line";
      const start = Math.max(0, h.col - 30);
      const pre = h.text.slice(start, h.col).replace(/^\s+/, "");
      row.innerHTML = `${start > 0 ? "…" : ""}${escapeHtml(pre)}<mark>${escapeHtml(h.text.slice(h.col, h.col + h.len))}</mark>${escapeHtml(h.text.slice(h.col + h.len, h.col + h.len + 80))}`;
      row.title = `${f.path}:${h.line}`;
      row.addEventListener("click", () => openFile(f.path, null, { line: h.line, col: h.col, len: h.len }));
      box.appendChild(row);
    }
    res.append(head, box);
  }
  if (seq === searchSeq) state.textContent = total ? `${total} résultat${total > 1 ? "s" : ""} dans ${nFiles} fichier${nFiles > 1 ? "s" : ""}` : "Aucun résultat.";
}

// ===== Palette de commandes / ouverture rapide =====
let fileIndex = null;
async function getFileIndex() {
  if (!fileIndex) fileIndex = await walkFiles(() => true, 2000);
  return fileIndex;
}
// Correspondance floue (sous-séquence) : score plus haut = meilleur.
function fuzzy(needle, hay) {
  needle = needle.toLowerCase(); hay = hay.toLowerCase();
  if (!needle) return 1;
  let s = 0, j = 0, run = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) { j++; run++; s += 1 + run * 2 + (i === 0 || "/._-".includes(hay[i - 1]) ? 5 : 0); }
    else run = 0;
  }
  return j === needle.length ? s - hay.length * 0.05 : -1;
}

function commands() {
  const sel = selection().text.trim();
  return [
    { label: "Fichier : Enregistrer", key: `${MOD}S`, run: save, when: () => !!openPath },
    { label: "Fichier : Tout enregistrer", key: `${MOD}⌥S`, run: saveAll },
    { label: "Fichier : Nouveau fichier", run: () => newEntry(false) },
    { label: "Fichier : Nouveau dossier", run: () => newEntry(true) },
    { label: "Fichier : Importer des fichiers…", run: () => $("ed-file-input").click() },
    { label: "Fichier : Fermer l'onglet", key: `${MOD}W`, run: () => closeTab(active), when: () => !!active },
    { label: "Fichier : Fermer tous les onglets", run: closeAllTabs, when: () => tabs.length > 0 },
    { label: "Atteindre la ligne…", key: `${MOD}G`, run: () => openPalette(":"), when: () => !!openPath },
    { label: "Affichage : Explorateur", key: `${MOD}⇧E`, run: () => showView("explorer") },
    { label: "Affichage : Rechercher dans les fichiers", key: `${MOD}⇧F`, run: () => showView("search") },
    { label: "Affichage : Versions du fichier", run: () => showView("history"), when: () => !!openPath },
    { label: "Affichage : Afficher/masquer la barre latérale", key: `${MOD}B`, run: toggleSidebar },
    { label: "Affichage : Assistant de code", key: `${MOD}I`, run: () => toggleChat() },
    { label: "Affichage : Thème clair/sombre", run: toggleTheme },
    { label: "Exécuter : Aperçu de l'app", key: `${MOD}↵`, run: preview, when: () => !!openPath },
    { label: "IA : Changer de backend / modèle pour le code…", run: () => openModelPop($("sb-model")) },
    { label: "IA : Suivre le backend de Lumen", run: () => { setCodeChoice(null); toast("L'éditeur suit de nouveau le backend de Lumen."); }, when: () => !!codeChoice().source },
    { label: "IA : Modifier la sélection…", run: aiModify, when: () => !!sel },
    { label: "IA : Expliquer la sélection", run: aiExplain, when: () => !!sel },
    { label: "IA : Modifier le dossier…", run: () => openFolderAi(activeDir) },
  ].filter((c) => !c.when || c.when());
}

let palItems = [];
let palSel = 0;
function openPalette(prefix = "") {
  const ov = $("palette");
  ov.hidden = false;
  const input = $("palette-input");
  input.value = prefix;
  input.focus();
  renderPalette();
}
function closePalette() { $("palette").hidden = true; if (openPath) ta.focus({ preventScroll: true }); }
async function renderPalette() {
  const input = $("palette-input");
  const raw = input.value;
  const list = $("palette-list");
  palSel = 0;
  if (raw.startsWith(">")) {
    input.placeholder = "Tapez une commande";
    const q = raw.slice(1).trim();
    palItems = commands().map((c) => ({ ...c, score: fuzzy(q, c.label) })).filter((c) => c.score >= 0).sort((a, b) => b.score - a.score);
  } else if (raw.startsWith(":")) {
    const n = parseInt(raw.slice(1), 10);
    const total = ta.value.split("\n").length;
    palItems = [{ label: n ? `Atteindre la ligne ${n}` : `Tapez un numéro de ligne (1 à ${total})`, run: () => n && goToLine(n) }];
  } else {
    input.placeholder = "Rechercher un fichier par nom (> commandes, : ligne)";
    const files = await getFileIndex();
    if ($("palette-input").value !== raw) return;
    const q = raw.trim();
    const recent = tabs.map((t) => t.path);
    palItems = files
      .map((f) => ({ f, score: q ? Math.max(fuzzy(q, f.name) * 2, fuzzy(q, f.path)) : (recent.includes(f.path) ? 100 - recent.indexOf(f.path) : 0) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map(({ f }) => ({ label: f.name, sub: f.path, badge: fileBadge(f.name), run: () => openFile(f.path) }));
  }
  list.innerHTML = palItems.length ? "" : `<div class="pal-empty">Aucun résultat.</div>`;
  palItems.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "pal-item" + (i === palSel ? " sel" : "");
    el.innerHTML = `${it.badge || ""}<span>${escapeHtml(it.label)}</span>${it.sub ? `<span class="pal-sub">${escapeHtml(it.sub)}</span>` : ""}${it.key ? `<kbd>${escapeHtml(it.key)}</kbd>` : ""}`;
    el.addEventListener("pointerenter", () => { palSel = i; highlightPalette(); });
    el.addEventListener("mousedown", (e) => { e.preventDefault(); closePalette(); it.run(); });
    list.appendChild(el);
  });
}
function highlightPalette() {
  $("palette-list").querySelectorAll(".pal-item").forEach((el, i) => {
    el.classList.toggle("sel", i === palSel);
    if (i === palSel) el.scrollIntoView({ block: "nearest" });
  });
}

// ===== Backend et modèle pour le code =====
function renderModelLabels() {
  const l = codeBackendLabel();
  const model = l.model || "modèle par défaut";
  $("sb-model").className = "sb-item sb-ai" + (l.override ? " override" : "");
  $("sb-model").innerHTML = `<span class="dot"></span>${icon("cpu", 13)}<span>${escapeHtml(l.source)} · ${escapeHtml(model)}</span>`;
  $("sb-model").title = l.override ? "Backend propre à l'éditeur — cliquer pour changer" : "Suit le backend de Lumen — cliquer pour choisir un backend dédié au code";
  $("chat-model").innerHTML = `${icon("cpu", 14)}<span class="mp-src">${escapeHtml(l.source)}</span><span class="mp-name">${escapeHtml(model)}</span>${l.override ? '<span class="mp-badge">code</span>' : '<span class="mp-badge" style="background:var(--muted);color:var(--muted-foreground)">Lumen</span>'}`;
  $("fai-model").innerHTML = `${icon("cpu", 13)}<span>${escapeHtml(l.source)} · ${escapeHtml(model)}</span>`;
}

let mpModels = [];
async function openModelPop(anchor) {
  const pop = $("model-pop");
  if (!pop.hidden) { pop.hidden = true; return; }
  const choice = codeChoice();
  const cur = codeBackendLabel();
  const sources = await availableSources();
  const src = $("mp-source");
  src.innerHTML = sources.map((s) => `<option value="${s}">${escapeHtml(SOURCE_LABELS[s] || s)}</option>`).join("");
  const curSource = choice.source || codeBackend().source || "ollama";
  src.value = sources.includes(curSource) ? curSource : sources[0];
  $("mp-model").value = choice.source ? choice.model : (src.value === curSource ? cur.model : defaultModelFor(src.value));
  pop.hidden = false;
  placePop(pop, anchor);
  await loadModelList();
}
function placePop(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - pr.width, window.innerWidth - pr.width - 8));
  const above = r.top > window.innerHeight / 2;
  pop.style.left = left + "px";
  pop.style.top = (above ? Math.max(8, r.top - pr.height - 6) : r.bottom + 6) + "px";
}
async function loadModelList() {
  const source = $("mp-source").value;
  const list = $("mp-list");
  list.innerHTML = `<div class="pop-hint">Chargement des modèles…</div>`;
  $("mp-model-label").textContent = source === "llama" ? "Modèle (fichier GGUF)" : "Modèle";
  const { list: models, hint } = await modelsFor(source);
  if ($("mp-source").value !== source) return;
  mpModels = models;
  if (!$("mp-model").value) $("mp-model").value = defaultModelFor(source) || models[0] || "";
  $("mp-models").innerHTML = models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("");
  $("mp-hint").textContent = hint || (models.length ? "" : source === "lumen" ? "Saisissez le modèle servi par Lumen Server." : "Aucun modèle listé : saisissez son nom.");
  renderModelItems();
  placePop($("model-pop"), $("model-pop").dataset.anchor === "chat" ? $("chat-model") : $("sb-model"));
}
function renderModelItems() {
  const list = $("mp-list");
  const cur = $("mp-model").value.trim();
  // Nom exact (modèle actuel, ou clic dans la liste) : on montre tout ; sinon
  // la saisie filtre.
  const q = mpModels.includes(cur) ? "" : cur.toLowerCase();
  const shown = mpModels.filter((m) => !q || m.toLowerCase().includes(q)).slice(0, 80);
  list.innerHTML = "";
  for (const m of (shown.length ? shown : mpModels.slice(0, 80))) {
    const el = document.createElement("div");
    el.className = "mp-item" + (m === cur ? " active" : "");
    el.innerHTML = `<span>${escapeHtml(m)}</span>${m === cur ? `<span class="mp-check">${icon("check", 14)}</span>` : ""}`;
    el.addEventListener("click", () => { $("mp-model").value = m; renderModelItems(); });
    list.appendChild(el);
  }
}
async function applyModelPop() {
  const source = $("mp-source").value;
  const model = $("mp-model").value.trim();
  setCodeChoice({ source, model });
  $("model-pop").hidden = true;
  let note = "";
  if (source === "llama" && model) note = await ensureLlamaModel(model);
  toast(`Code : ${SOURCE_LABELS[source] || source}${model ? ` · ${model}` : ""}${note ? ` — ${note}` : ""}`);
}

// ===== Assistant de code (panneau de discussion) =====
const chatMsgs = [];          // historique { role, content } SANS le contexte joint
let chatAbort = null;
let chatSelection = null;     // sélection mémorisée à l'envoi (pour « Remplacer la sélection »)

function renderChatCtx() {
  const box = $("chat-ctx");
  const withFile = $("chat-with-file").checked;
  const sel = selection();
  if (!withFile || !openPath) { box.innerHTML = ""; return; }
  box.innerHTML = sel.text.trim()
    ? `<span class="ctx-chip">${icon("code", 12)}${escapeHtml(openPath.split("/").pop())} · ${sel.text.split("\n").length} ligne(s) sélectionnée(s)</span>`
    : `<span class="ctx-chip">${fileBadge(openPath)}${escapeHtml(openPath.split("/").pop())}</span>`;
}

function chatSystem() {
  const lng = replyLang();
  return [
    `Tu es l'assistant de code intégré à l'éditeur de Lumen (façon Copilot dans VS Code).`,
    `Réponds en ${lng === "en" ? "anglais" : "français"}, de façon concise et précise.`,
    `Quand tu proposes du code, mets-le dans des blocs \`\`\` avec le langage ; pour une modification, donne le bloc complet à insérer (pas de « … »).`,
    `Ne réécris pas tout le fichier sauf si on te le demande.`,
  ].join("\n");
}

function chatContext() {
  if (!$("chat-with-file").checked || !openPath) return "";
  const sel = selection();
  const MAX = 16000;
  if (sel.text.trim()) {
    const before = ta.value.slice(0, sel.start).split("\n").length;
    return `Fichier : ${openPath} (${LANG_LABELS[lang] || lang}), lignes ${before}–${before + sel.text.split("\n").length - 1} sélectionnées :\n\`\`\`${lang}\n${sel.text.slice(0, MAX)}\n\`\`\`\n\n`;
  }
  const body = ta.value.length > MAX ? ta.value.slice(0, MAX) + "\n… (tronqué)" : ta.value;
  return `Fichier ouvert : ${openPath} (${LANG_LABELS[lang] || lang}), curseur ligne ${curLine} :\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
}

function addChatMsg(role, html) {
  $("chat-empty")?.remove();
  const el = document.createElement("div");
  el.className = "msg " + role;
  const who = role === "user" ? `${icon("user", 14)}Vous` : `${icon("bot", 14)}Assistant <span style="font-weight:400">· ${escapeHtml(codeBackendLabel().model || codeBackendLabel().source)}</span>`;
  el.innerHTML = `<div class="msg-who">${who}</div><div class="msg-body"></div>`;
  el.querySelector(".msg-body").innerHTML = html;
  $("chat-log").appendChild(el);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  return el.querySelector(".msg-body");
}

// Rendu Markdown + barre d'actions sur chaque bloc de code.
function renderAnswer(body, text, final) {
  body.innerHTML = markdownToHtml(text || "…");
  body.querySelectorAll("pre").forEach((pre) => {
    const codeText = pre.textContent;
    const blockLang = pre.dataset.lang || "";
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-block-head";
    head.innerHTML = `<span>${escapeHtml(blockLang || "code")}</span><span class="spacer"></span>`;
    pre.replaceWith(wrap);
    const code = pre.querySelector("code") || pre;
    code.innerHTML = highlight(codeText, blockLang ? langFromName("x." + blockLang) : lang);
    wrap.append(head, pre);
    if (!final) return;
    const btn = (ic, label, fn) => {
      const b = document.createElement("button");
      b.className = "btn-soft";
      b.innerHTML = `${icon(ic, 12)}${escapeHtml(label)}`;
      b.addEventListener("click", fn);
      head.appendChild(b);
    };
    btn("copy", "Copier", () => navigator.clipboard?.writeText(codeText).then(() => toast("Copié.")));
    if (openPath && !truncated) {
      btn("insert", "Insérer", () => insertAtCursor(codeText));
      if (chatSelection?.text && chatSelection.path === openPath) btn("replace", "Remplacer la sélection", () => reviewReplacement(chatSelection, codeText));
      else btn("replace", "Appliquer au fichier", () => reviewReplacement({ start: 0, end: ta.value.length, text: ta.value }, codeText));
    }
  });
}

function insertAtCursor(text) {
  if (!openPath) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  refresh(); markDirty(); ta.focus();
  toast("Code inséré.");
}

async function sendChat() {
  const input = $("chat-input");
  const q = input.value.trim();
  if (!q || chatAbort) return;
  const ctx = chatContext();
  const sel = selection();
  chatSelection = sel.text.trim() ? { ...sel, path: openPath } : null;
  input.value = "";
  addChatMsg("user", escapeHtml(q) + (ctx ? `<div class="msg-ctx">${icon("file", 11)} ${escapeHtml(openPath)}${chatSelection ? " (sélection)" : ""}</div>` : ""));
  const body = addChatMsg("assistant", `<span class="ai-state">Réflexion…</span>`);
  const messages = [
    { role: "system", content: chatSystem() },
    ...chatMsgs.slice(-12),
    { role: "user", content: ctx + q },
  ];
  chatAbort = new AbortController();
  $("chat-send").hidden = true; $("chat-stop").hidden = false;
  let pending = 0;
  try {
    const { content, data } = await llmChat(messages, aiOpts({
      signal: chatAbort.signal,
      onDelta: (txt) => {
        if (pending) return;
        pending = requestAnimationFrame(() => {
          pending = 0;
          renderAnswer(body, txt, false);
          $("chat-log").scrollTop = $("chat-log").scrollHeight;
        });
      },
    }));
    cancelAnimationFrame(pending); pending = 0;
    recordOllamaUsage(data, "editor-chat");
    renderAnswer(body, content.trim(), true);
    chatMsgs.push({ role: "user", content: q }, { role: "assistant", content: content.trim() });
  } catch (e) {
    cancelAnimationFrame(pending);
    if (chatAbort?.signal.aborted) body.insertAdjacentHTML("beforeend", `<div class="ai-state">Arrêté.</div>`);
    else body.innerHTML = `<span style="color:var(--destructive)">Échec : ${escapeHtml(e?.message || e)}</span><div class="ai-state">Changez de backend ou de modèle avec le sélecteur ci-dessus.</div>`;
  } finally {
    chatAbort = null;
    $("chat-send").hidden = false; $("chat-stop").hidden = true;
    $("chat-log").scrollTop = $("chat-log").scrollHeight;
  }
}

function clearChat() {
  chatMsgs.length = 0;
  $("chat-log").innerHTML = `<div class="chat-empty" id="chat-empty"><b>Posez une question sur votre code.</b><span>Le fichier ouvert (ou la sélection) est joint automatiquement. Les blocs de code proposés s'insèrent en un clic.</span></div>`;
}

// ===== Câblage =====
function bind() {
  ta.addEventListener("input", () => { refresh(); markDirty(); });
  ta.addEventListener("scroll", syncScroll);
  for (const ev of ["keyup", "mouseup", "select", "focus"]) ta.addEventListener(ev, () => { updateCursor(); if (!$("chat").hidden) renderChatCtx(); });
  document.addEventListener("selectionchange", () => { if (document.activeElement === ta) updateCursor(); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      const v = ta.value;
      // Bloc sélectionné : (dés)indente chaque ligne, comme VS Code.
      if (v.slice(s, en).includes("\n")) {
        const ls = v.lastIndexOf("\n", s - 1) + 1;
        const block = v.slice(ls, en);
        const out = e.shiftKey ? block.replace(/^( {1,2}|\t)/gm, "") : block.replace(/^/gm, "  ");
        ta.value = v.slice(0, ls) + out + v.slice(en);
        ta.setSelectionRange(ls, ls + out.length);
      } else if (e.shiftKey) {
        const ls = v.lastIndexOf("\n", s - 1) + 1;
        const m = v.slice(ls).match(/^( {1,2}|\t)/);
        if (m) { ta.value = v.slice(0, ls) + v.slice(ls + m[0].length); ta.selectionStart = ta.selectionEnd = Math.max(ls, s - m[0].length); }
      } else {
        ta.value = v.slice(0, s) + "  " + v.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
      }
      refresh(); markDirty();
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      // Conserve l'indentation de la ligne courante (+ un cran après { [ ( :).
      e.preventDefault();
      const s = ta.selectionStart, v = ta.value;
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      const indent = v.slice(ls, s).match(/^[ \t]*/)[0];
      const extra = /[{[(:]\s*$/.test(v.slice(ls, s)) ? "  " : "";
      const ins = "\n" + indent + extra;
      ta.value = v.slice(0, s) + ins + v.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + ins.length;
      refresh(); markDirty();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "/") {
      e.preventDefault(); toggleComment();
    }
  });
  ta.addEventListener("contextmenu", (e) => {
    if (!selection().text.trim()) return; // menu natif si pas de sélection
    e.preventDefault(); showCtx(e.clientX, e.clientY);
  });
  document.addEventListener("click", () => ($("ctx-menu").hidden = true));
  $("ctx-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = e.target.closest("button[data-act]");
    const act = btn?.dataset.act;
    $("ctx-menu").hidden = true;
    if (act === "ask") aiAsk();
    else if (act === "ai") aiModify();
    else if (act === "explain") aiExplain();
    else if (act === "chat") { toggleChat(true); renderChatCtx(); }
    else if (act === "copy") navigator.clipboard?.writeText(selection().text).then(() => toast("Copié."));
  });

  $("sandbox-select").addEventListener("change", async (e) => {
    const prev = sandboxId;
    if (tabs.length && !(await closeAllTabs())) { e.target.value = prev; return; }
    sandboxId = e.target.value; activeDir = ""; expandedDirs.clear();
    lsSet("editorSandbox", sandboxId);
    await loadTree(); updateStatus(); renderBreadcrumbs();
  });
  $("btn-save").addEventListener("click", save);
  $("btn-preview").addEventListener("click", preview);
  $("history-close").addEventListener("click", () => showView("explorer"));
  $("btn-theme").addEventListener("click", toggleTheme);
  $("btn-toggle-chat").addEventListener("click", () => toggleChat());
  $("ai-cancel").addEventListener("click", () => ($("ai-overlay").hidden = true));
  $("ai-run").addEventListener("click", runAiModify);
  window.addEventListener("resize", () => openPath && syncCodeSize());
  new MutationObserver(syncCodeTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Barre d'activité, palette, ouverture rapide.
  document.querySelectorAll(".act[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $("btn-palette").addEventListener("click", () => openPalette(">"));
  $("btn-quick-open").addEventListener("click", () => openPalette(""));
  $("palette").addEventListener("mousedown", (e) => { if (e.target === $("palette")) closePalette(); });
  $("palette-input").addEventListener("input", renderPalette);
  $("palette-input").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closePalette(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); highlightPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); highlightPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); const it = palItems[palSel]; closePalette(); it?.run(); }
  });
  bindResizer();

  // Recherche.
  $("search-input").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
  $("search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(searchTimer); runSearch(); } });
  for (const id of ["search-case", "search-regex"]) $(id).addEventListener("click", () => { $(id).classList.toggle("on"); runSearch(); });

  // Backend / modèle pour le code.
  $("sb-model").addEventListener("click", (e) => { e.stopPropagation(); $("model-pop").dataset.anchor = "sb"; openModelPop($("sb-model")); });
  $("chat-model").addEventListener("click", (e) => { e.stopPropagation(); $("model-pop").dataset.anchor = "chat"; openModelPop($("chat-model")); });
  $("mp-source").addEventListener("change", () => { $("mp-model").value = defaultModelFor($("mp-source").value); loadModelList(); });
  $("mp-model").addEventListener("input", renderModelItems);
  $("mp-model").addEventListener("keydown", (e) => { if (e.key === "Enter") applyModelPop(); });
  $("mp-apply").addEventListener("click", applyModelPop);
  $("mp-reset").addEventListener("click", () => { setCodeChoice(null); $("model-pop").hidden = true; toast("L'éditeur suit de nouveau le backend de Lumen."); });
  $("model-pop").addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("mousedown", () => { $("model-pop").hidden = true; });
  $("sb-sandbox").addEventListener("click", () => { showView("explorer"); $("sandbox-select").focus(); });

  // Assistant.
  $("chat-send").addEventListener("click", sendChat);
  $("chat-stop").addEventListener("click", () => chatAbort?.abort());
  $("chat-clear").addEventListener("click", clearChat);
  $("chat-close").addEventListener("click", () => toggleChat(false));
  $("chat-with-file").addEventListener("change", renderChatCtx);
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  });

  // Raccourcis globaux (façon VS Code).
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) { if (e.key === "Escape") { $("model-pop").hidden = true; } return; }
    const k = e.key.toLowerCase();
    if (k === "s" && e.altKey) { e.preventDefault(); saveAll(); }
    else if (k === "s") { e.preventDefault(); save(); }
    else if (k === "p" && e.shiftKey) { e.preventDefault(); openPalette(">"); }
    else if (k === "p") { e.preventDefault(); openPalette(""); }
    else if (k === "f" && e.shiftKey) { e.preventDefault(); showView("search"); const s = selection().text; if (s && !s.includes("\n")) { $("search-input").value = s; runSearch(); } }
    else if (k === "e" && e.shiftKey) { e.preventDefault(); showView("explorer"); }
    else if (k === "b") { e.preventDefault(); toggleSidebar(); }
    else if (k === "i") { e.preventDefault(); toggleChat(); }
    else if (k === "w") { if (active) { e.preventDefault(); closeTab(active); } }
    else if (k === "g") { if (openPath) { e.preventDefault(); openPalette(":"); } }
    else if (k === "enter") { if (openPath) { e.preventDefault(); preview(); } }
    else if (e.key === "Tab" && e.ctrlKey && tabs.length > 1) {
      e.preventDefault();
      const i = tabs.indexOf(active);
      activateTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
    }
  });
  window.addEventListener("beforeunload", (e) => { stashActive(); if (tabs.some(tabDirty)) { e.preventDefault(); e.returnValue = ""; } });

  // Gestion de fichiers (mini-IDE) : créer, importer, rafraîchir, menu arbre.
  $("btn-new-file").addEventListener("click", () => newEntry(false));
  $("btn-new-folder").addEventListener("click", () => newEntry(true));
  $("btn-import").addEventListener("click", () => { if (sandboxId) $("ed-file-input").click(); });
  $("ed-file-input").addEventListener("change", (e) => { importFiles(e.target.files); e.target.value = ""; });
  $("btn-refresh-tree").addEventListener("click", () => loadTree());
  document.addEventListener("click", () => ($("tree-menu").hidden = true));

  // IA sur tout un dossier.
  $("btn-ai-folder").addEventListener("click", () => openFolderAi(activeDir));
  $("fai-cancel").addEventListener("click", () => ($("folder-ai-overlay").hidden = true));
  $("fai-run").addEventListener("click", runFolderAi);
  $("fai-apply").addEventListener("click", applyFolderAiProposal);
  $("fai-mode").addEventListener("change", updateFolderAiMode);
  updateFolderAiMode();
}

// ⌘/ : (dé)commente les lignes sélectionnées selon le langage.
function toggleComment() {
  if (!openPath || truncated) return;
  const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
  const ls = v.lastIndexOf("\n", s - 1) + 1;
  let le = v.indexOf("\n", en - (en > s && v[en - 1] === "\n" ? 1 : 0));
  if (le < 0) le = v.length;
  const lines = v.slice(ls, le).split("\n");
  const [open, close] = lang === "html" ? ["<!-- ", " -->"] : lang === "css" ? ["/* ", " */"] : lang === "python" ? ["# ", ""] : ["// ", ""];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(\\s*)${esc(open.trim())}\\s?(.*?)${close ? `\\s?${esc(close.trim())}` : ""}$`);
  const all = lines.filter((l) => l.trim()).every((l) => re.test(l));
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    if (all) return l.replace(re, "$1$2");
    const ind = l.match(/^\s*/)[0];
    return ind + open + l.slice(ind.length) + close;
  }).join("\n");
  ta.value = v.slice(0, ls) + out + v.slice(le);
  ta.setSelectionRange(ls, ls + out.length);
  refresh(); markDirty();
}

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2800);
}

init();
