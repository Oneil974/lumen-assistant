import { imageGenerationConfig, imageProvider, imageModel, imageModelsFor, imageSizesFor, nearestImageSize, bonsaiBackendId, ensureBonsaiKind, listOllamaImageModels, imageErrorMessage } from "../lib/image-provider.js";
// Explorateur de sandboxes. Toute opération fichier passe par les commandes Rust
// confinées (sandbox.rs) ; l'UI ne manipule jamais de chemin absolu.
const { invoke } = window.__TAURI__.core;
import { renderMarkdown, highlightCode, fileKind, fileExt } from "./render.js";
import { bundleApp } from "./app-runner.js";
import { diffLines, applyDiff, countChanges } from "./diff.js";
import { mountCsv, mountJson } from "./viewers.js";
// ?v= : bump avec explorer.html à chaque modif de desktop.js (cache WKWebView).
import { initDesktop, enterDesktop, enterDesktopAfterUnlock, requireSessionUnlock, exitDesktop, isDesktopActive, openCreativeFile, openSheetsFile } from "./desktop.js?v=35";
import { autoTranslate, translatePage, tt, appLang } from "../apps-i18n.js";
import { recordImageGeneration, recordOllamaUsage } from "../ollama-usage.js";
import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";
autoTranslate({ observe: true });

const activeProfileId = await invoke("session_active_profile_id").catch(() => "default");
const profileStoragePrefix = `profile:${activeProfileId || "default"}:`;
window.__LUMEN_PROFILE_STORAGE_PREFIX__ = profileStoragePrefix;
window.__LUMEN_PROFILE_ID__ = activeProfileId || "default";
// Trace de diagnostic (window-diagnostics.log via frontend_log).
const dtTrace = (m) => { try { invoke("frontend_log", { level: "sandbox", message: m }); } catch {} };
dtTrace(`boot profile=${activeProfileId} url=${location.href}`);
const wsKey = (key) => `${profileStoragePrefix}${key}`;

// ===== État =====
let sandboxes = [];
let current = null;      // SandboxMeta active
// Exposé pour les apps embarquées du bureau (ex. Studio d'images) qui veulent
// écrire dans la sandbox active plutôt que dans leur sandbox dédiée.
window.LumenCurrentSandbox = () => (current ? current.id : null);
let cwd = "";            // chemin relatif courant (depuis la racine)
let entries = [];        // contenu du dossier courant
let selected = null;     // entrée sélectionnée (dernier clic)
let selectedPaths = new Set(); // sélection multiple (Cmd/Ctrl+clic) pour l'analyse IA
let previewPath = null;  // fichier affiché dans le volet
let multiFiles = [];     // fichiers du volet d'analyse multi-fichiers
let multiDiffs = [];     // propositions multi-fichiers en attente de validation
let viewMode = localStorage.getItem(wsKey("sbView")) || "grid";  // grid | list
let sortKey = localStorage.getItem(wsKey("sbSort")) || "name";   // name | type | size | modified | created
// Sens du tri, comme dans un explorateur. Le défaut dépend de la clé : A→Z pour
// un nom, mais « le plus récent d'abord » pour une date et « le plus gros
// d'abord » pour une taille — c'est ce qu'on attend en cliquant dessus.
let sortDir = localStorage.getItem(wsKey("sbSortDir")) || "";     // asc | desc | "" = défaut de la clé
let searchQuery = "";    // requête de recherche fichier (vide = navigation normale)

// ===== Petites icônes SVG (suffisantes pour l'explorateur) =====
function svg(inner, { fill = "none", w = 24 } = {}) {
  return `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
function folderGlyph(color) {
  return `<svg width="48" height="48" viewBox="0 0 24 24" fill="${color}" stroke="${color}" stroke-width="2"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.7 1.8H19.5A1.5 1.5 0 0 1 21 9.3v8.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>`;
}
function fileGlyph() {
  return svg('<path d="M14 3v5h5"/><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>', { w: 48 });
}
const IC = {
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H4a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  folderPlus: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.7 1.8H19.5A1.5 1.5 0 0 1 21 9.3v8.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 11v5M9.5 13.5h5"/>',
  filePlus: '<path d="M14 3v5h5"/><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M12 12v4M10 14h4"/>',
  upload: '<path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 4v12M8 12l4 4 4-4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4"/><path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4"/><polyline points="21 3 21 7 17 7"/><polyline points="3 21 3 17 7 17"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sortAsc: '<path d="M7 20V5M4 8l3-3 3 3"/><path d="M13 7h8M13 12h6M13 17h4"/>',
  sortDesc: '<path d="M7 5v15M4 17l3 3 3-3"/><path d="M13 7h4M13 12h6M13 17h8"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 14l.7 1.8 1.8.7-1.8.7L18 19l-.7-1.8-1.8-.7 1.8-.7z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.7 1.8H19.5A1.5 1.5 0 0 1 21 9.3v8.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/>',
};
function ic(name) { return svg(IC[name] || "", { w: 18 }); }

// ===== Icônes typées par extension (couleur + libellé) =====
const EXT_META = {
  js: ["#f1e05a", "JS"], mjs: ["#f1e05a", "JS"], cjs: ["#f1e05a", "JS"], jsx: ["#f1e05a", "JSX"],
  ts: ["#3178c6", "TS"], tsx: ["#3178c6", "TSX"], json: ["#cbcb41", "JSON"],
  py: ["#3572A5", "PY"], rs: ["#dea584", "RS"], go: ["#00ADD8", "GO"], rb: ["#701516", "RB"],
  java: ["#b07219", "JAVA"], c: ["#555555", "C"], cpp: ["#f34b7d", "C++"], cs: ["#178600", "C#"],
  php: ["#4F5D95", "PHP"], swift: ["#F05138", "SWIFT"], sh: ["#89e051", "SH"], bash: ["#89e051", "SH"],
  html: ["#e34c26", "HTML"], htm: ["#e34c26", "HTML"], css: ["#563d7c", "CSS"], scss: ["#c6538c", "SCSS"],
  md: ["#4b9fd5", "MD"], markdown: ["#4b9fd5", "MD"], txt: ["#8e8e93", "TXT"], log: ["#8e8e93", "LOG"],
  csv: ["#1a7f37", "CSV"], tsv: ["#1a7f37", "TSV"], yaml: ["#cb171e", "YAML"], yml: ["#cb171e", "YAML"],
  toml: ["#9c4221", "TOML"], xml: ["#e37933", "XML"], sql: ["#e38c00", "SQL"], pdf: ["#ff3b30", "PDF"],
  zip: ["#a6794c", "ZIP"], png: ["#a371f7", "PNG"], jpg: ["#a371f7", "JPG"], jpeg: ["#a371f7", "JPG"],
  gif: ["#a371f7", "GIF"], webp: ["#a371f7", "WEBP"], svg: ["#ff9500", "SVG"], ico: ["#a371f7", "ICO"],
  mp3: ["#34c759", "MP3"], wav: ["#34c759", "WAV"], mp4: ["#5ac8fa", "MP4"], webm: ["#5ac8fa", "WEBM"],
  // Formats natifs de Lumen. Sans entrée ici, les trois retombaient sur le gris
  // par défaut ET sur le même libellé tronqué (« LUME ») : impossible de
  // distinguer un classeur d'une présentation dans la grille de fichiers.
  // Le vert du tableur est celui des formats tabulaires (CSV, TSV).
  lumensheet: ["#1a7f37", "CALC"], lumenpages: ["#5ac8fa", "DOC"], lumenkey: ["#ff9f0a", "DECK"],
};
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp"]);
function extMeta(name) {
  const e = fileExt(name);
  return EXT_META[e] || ["#8e8e93", (e || "—").toUpperCase().slice(0, 4)];
}
// Glyphe de fichier teinté + ruban d'extension.
function typedFileGlyph(name) {
  const [color, label] = extMeta(name);
  return `<svg width="48" height="48" viewBox="0 0 48 48" fill="none">
    <path d="M11 4h17l9 9v27a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z" fill="${color}22" stroke="${color}" stroke-width="2"/>
    <path d="M28 4v9h9" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <rect x="6" y="27" width="30" height="13" rx="2.5" fill="${color}"/>
    <text x="21" y="36.4" font-size="8.4" font-weight="700" fill="#fff" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif">${escapeHtml(label)}</text>
  </svg>`;
}

// ===== Helpers DOM =====
const $ = (s) => document.querySelector(s);

// ===== Démarrage =====
// ATTENTION : ce module a des `await` top-level (profil actif) — sous
// WKWebView, DOMContentLoaded peut partir PENDANT ces await, avant que
// l'écouteur soit posé. On teste donc readyState au lieu de se fier à
// l'événement seul, sinon la page reste morte (ni liste, ni login).
async function initExplorer() {
  dtTrace("DOMContentLoaded start");
  applyCustomization();
  wireToolbar();
  wireModals();
  wirePreview();
  wireMulti();
  wireRunner();
  $("#btn-customize").innerHTML = ic("gear");
  $("#preview-close").innerHTML = ic("close");
  $("#multi-close").innerHTML = ic("close");
  $("#btn-new-folder").innerHTML = ic("folderPlus") + " " + tt("Dossier");
  $("#btn-new-file").innerHTML = ic("filePlus") + " " + tt("Fichier");
  $("#btn-upload").innerHTML = ic("upload") + " " + tt("Importer");
  $("#quicklook-close").innerHTML = ic("close");
  $("#preview-history").innerHTML = ic("clock");
  $("#history-close").innerHTML = ic("close");
  $("#btn-refresh").innerHTML = ic("refresh");
  $("#btn-view").innerHTML = ic(viewMode === "list" ? "grid" : "list");
  $("#sort-select").value = sortKey;
  renderSortDir();
  wireQuickLook();
  wireLaunchpad();
  wireHistory();
  initDesktop({ getCurrent: () => current });
  // Accès rapide « Bureau » depuis le HUB (commande Rust → eval).
  // Ne PAS exiger `current` ici : si le backend est verrouillé, la liste des
  // sandboxes est vide — le login s'affiche d'abord, puis on recharge la liste.
  window.__enterDesktop = () => {
    if (isDesktopActive()) return;
    enterDesktopAfterUnlock(() => loadSandboxes({ autoEnterDesktop: false }));
  };
  window.__launchSandboxApp = async (path) => {
    if (!current || !path) return;
    await refresh();
    const name = String(path).split("/").pop();
    launchApp(path, name);
  };
  document.addEventListener("click", () => hideCtxMenu());
  window.addEventListener("sandbox-refresh-needed", () => loadSandboxes().catch(() => refresh()));
  window.__TAURI__?.event?.listen?.("sandbox-refresh-needed", () => {
    loadSandboxes().catch(() => refresh());
  });
  window.addEventListener("sandbox-open-path", async (e) => {
    const path = String(e.detail?.path || "");
    if (!path || !current) return;
    await openPathFromWorkspace(path);
  });
  document.addEventListener("keydown", onGlobalKey);
  dtTrace("DOMContentLoaded tail reached");
  const wantsDesktop = new URLSearchParams(location.search).get("desktop") === "1";
  dtTrace(`wantsDesktop=${wantsDesktop} unlocked=${await invoke("session_is_unlocked").catch((e) => `err:${e}`)}`);
  if (wantsDesktop) {
    await enterDesktopAfterUnlock(() => loadSandboxes({ autoEnterDesktop: false }));
  } else if (!(await invoke("session_is_unlocked").catch(() => true))) {
    // Backend verrouillé (profil à mot de passe) : les commandes sandbox
    // échoueraient → ouverture de session d'abord, sans monter le bureau.
    await requireSessionUnlock(() => loadSandboxes());
  } else {
    await loadSandboxes();
  }
}
// Le lancement d'initExplorer est fait TOUT EN BAS du module : les const
// top-level (ex. PREVIEW_WIDTH_KEY) doivent être initialisées avant (TDZ).

async function loadSandboxes({ autoEnterDesktop = true } = {}) {
  sandboxes = await invoke("sandbox_list").catch(() => []);
  const sel = $("#sandbox-select");
  sel.innerHTML = "";
  if (!sandboxes.length) {
    current = null;
    const el = $("#empty");
    $("#files").hidden = true;
    el.hidden = false;
    el.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:14px"><div>Aucune sandbox pour l'instant.</div><button class="btn-soft primary" id="empty-create">+ Créer une sandbox</button></div>`;
    el.querySelector("#empty-create").addEventListener("click", createSandbox);
    updateUsage();
    return;
  }
  for (const s of sandboxes) {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  }
  // Sandbox demandée via la query string (ouverture depuis un agent) au 1er chargement.
  const wantedId = new URLSearchParams(location.search).get("id");
  const wanted = wantedId && sandboxes.find((s) => s.id === wantedId);
  if (wanted) current = wanted;
  else if (!current || !sandboxes.find((s) => s.id === current.id)) current = sandboxes[0];
  sel.value = current.id;
  cwd = "";
  await refresh();
  // Ouverture demandée directement en mode bureau (?desktop=1 depuis le HUB).
  if (autoEnterDesktop && new URLSearchParams(location.search).get("desktop") === "1" && current && !isDesktopActive()) enterDesktop();
}

// Sélectionne une sandbox par id (appelé depuis le backend quand la fenêtre est
// déjà ouverte et qu'un agent demande « Ouvrir la sandbox »).
window.__selectSandbox = async (id) => {
  const target = sandboxes.find((s) => s.id === id);
  if (!target) return;
  current = target;
  $("#sandbox-select").value = id;
  clearSearch(); cwd = ""; closePreview(); await refresh();
};

function wireToolbar() {
  $("#sandbox-select").addEventListener("change", async (e) => {
    current = sandboxes.find((s) => s.id === e.target.value);
    clearSearch(); cwd = ""; closePreview(); await refresh();
  });
  $("#btn-new-sandbox").addEventListener("click", createSandbox);
  $("#btn-sandbox-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!current) return;
    const r = e.currentTarget.getBoundingClientRect();
    showSandboxMenu(r.left, r.bottom + 4);
  });
  // Clic droit sur le sélecteur : même menu, là où on regarde déjà.
  $("#sandbox-select").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (current) showSandboxMenu(e.clientX, e.clientY);
  });
  $("#btn-new-folder").addEventListener("click", () => createEntry(true));
  $("#btn-new-file").addEventListener("click", () => createEntry(false));
  $("#btn-upload").addEventListener("click", () => { if (current) $("#file-input").click(); });
  $("#file-input").addEventListener("change", onUploadFiles);
  $("#btn-resize").addEventListener("click", resizeSandbox);
  $("#btn-customize").addEventListener("click", openCustomize);
  $("#btn-refresh").addEventListener("click", refresh);
  $("#btn-view").addEventListener("click", () => setViewMode(viewMode === "grid" ? "list" : "grid"));
  $("#sort-select").addEventListener("change", (e) => setSortKey(e.target.value));
  $("#btn-sort-dir").addEventListener("click", () => setSortDir(effectiveSortDir() === "asc" ? "desc" : "asc"));
  $("#btn-launchpad").addEventListener("click", openLaunchpad);
  // Recherche fichier : récursive dans la sandbox active, débauchée à 180 ms.
  let searchTimer = null;
  $("#file-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchQuery = q; refresh(); }, 180);
  });
  $("#file-search").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.target.value = ""; searchQuery = ""; refresh(); } });
  $("#files").addEventListener("contextmenu", (e) => {
    if (e.target.closest(".item")) return; // géré par l'item
    e.preventDefault();
    if (current) showBackgroundMenu(e.clientX, e.clientY);
  });
  installClipboardShortcuts();
}

/// ⌘/Ctrl + C, X, V sur la vue des fichiers.
///
/// On refuse d'intercepter dès qu'un champ a le focus : couper du texte dans
/// la zone de l'agent ou dans l'éditeur d'aperçu doit rester couper du texte.
/// Même chose quand une modale est ouverte.
function installClipboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (!current) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (document.querySelector(".modal-overlay:not([hidden])")) return;
    const key = e.key.toLowerCase();
    if (key === "c" || key === "x") {
      const targets = actionTargets(null);
      if (!targets.length) return;
      e.preventDefault();
      setClipboard(key === "x" ? "cut" : "copy", targets);
    } else if (key === "v") {
      if (!clipboard) return;
      e.preventDefault();
      pasteInto(cwd);
    }
  });
}

// ===== Rendu =====
async function refresh() {
  if (!current) return;
  selected = null;
  selectedPaths.clear();
  updateSelBar();
  return refreshInner();
}
// Rafraîchit la vue courante sans réinitialiser la sélection (réutilisable).
window.LumenRefreshSandbox = (id) => {
  if (!current || (id && id !== current.id)) loadSandboxes().catch(() => {});
  else refresh().catch(() => {});
};
async function refreshInner() {
  if (!current) return;
  selectedPaths.clear();
  updateSelBar();
  if (searchQuery) {
    // Recherche : on parcourt toute la sandbox et on filtre par nom.
    entries = (await walkSandbox(current.id)).filter((e) => e.name.toLowerCase().includes(searchQuery));
  } else {
    try {
      entries = await invoke("sandbox_read_dir", { id: current.id, path: cwd });
    } catch (e) { entries = []; }
  }
  renderBreadcrumb();
  renderFiles();
  updateUsage();
  translatePage();  // traduit l'UI statique + messages (si langue anglaise)
  // L'écran de chargement de session attend ce signal : tant qu'il n'est pas
  // émis, le bureau afficherait une sandbox vide.
  window.dispatchEvent(new CustomEvent("sandbox-rendered"));
}

// Parcours récursif (toute la sandbox) pour la recherche. Renvoie une liste à
// plat d'entrées { name, path, is_dir, size }, dossiers compris.
async function walkSandbox(id) {
  const out = [];
  async function walk(path) {
    let list;
    try { list = await invoke("sandbox_read_dir", { id, path }); } catch { return; }
    for (const e of list) {
      out.push(e);
      if (e.is_dir) await walk(e.path);
    }
  }
  await walk("");
  return out;
}

function renderEmpty(msg) {
  $("#files").innerHTML = "";
  $("#files").hidden = true;
  const el = $("#empty"); el.hidden = false; el.textContent = msg;
}

function renderBreadcrumb() {
  const bc = $("#breadcrumb");
  bc.innerHTML = "";
  const parts = cwd ? cwd.split("/") : [];
  const root = document.createElement("span");
  root.className = "crumb" + (parts.length ? "" : " current");
  root.textContent = current ? current.name : "—";
  root.addEventListener("click", () => { clearSearch(); cwd = ""; refresh(); });
  makeCrumbDropTarget(root, "");
  bc.appendChild(root);
  let acc = "";
  parts.forEach((p, i) => {
    const sep = document.createElement("span"); sep.className = "crumb-sep"; sep.textContent = "›"; bc.appendChild(sep);
    acc = acc ? `${acc}/${p}` : p;
    const c = document.createElement("span");
    c.className = "crumb" + (i === parts.length - 1 ? " current" : "");
    c.textContent = p;
    const target = acc;
    if (i < parts.length - 1) c.addEventListener("click", () => { clearSearch(); cwd = target; refresh(); });
    if (i < parts.length - 1) makeCrumbDropTarget(c, target);
    bc.appendChild(c);
  });
}

/// Un cran du fil d'Ariane accepte un dépôt : c'est ainsi qu'on remonte un
/// fichier d'un dossier. Le glisser-déposer ne savait aller que vers le bas.
function makeCrumbDropTarget(el, dir) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("dropzone");
  });
  el.addEventListener("dragleave", () => el.classList.remove("dropzone"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("dropzone");
    const src = e.dataTransfer.getData("text/plain");
    if (!src) return;
    const parent = src.includes("/") ? src.slice(0, src.lastIndexOf("/")) : "";
    if (parent === dir) return;   // déjà là
    moveInto(src, dir);
  });
}

// Sens naturel d'une clé quand l'utilisateur n'a rien imposé : croissant pour
// les noms et les types, décroissant pour les tailles et les dates.
const SORT_DEFAULT_DIR = { name: "asc", type: "asc", size: "desc", modified: "desc", created: "desc" };
function effectiveSortDir() {
  return sortDir || SORT_DEFAULT_DIR[sortKey] || "asc";
}

// Clé de date affichée dans la vue liste : celle sur laquelle on trie si c'est
// une date, la date de modification sinon.
function dateField() {
  return sortKey === "created" ? "created" : "modified";
}

// Tri : dossiers d'abord (comme tout explorateur), puis selon la clé et le sens.
function sortedEntries() {
  const arr = entries.slice();
  const dir = effectiveSortDir() === "desc" ? -1 : 1;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  arr.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp = 0;
    if (sortKey === "size") cmp = (a.size || 0) - (b.size || 0);
    else if (sortKey === "modified" || sortKey === "created") cmp = (a[sortKey] || 0) - (b[sortKey] || 0);
    else if (sortKey === "type") cmp = fileExt(a.name).localeCompare(fileExt(b.name));
    else cmp = byName(a, b);
    // À valeur égale (même taille, même type, même seconde), on départage par
    // le nom, dans le sens courant : sans ça l'ordre sautait d'un rendu à l'autre.
    return (cmp || byName(a, b)) * dir;
  });
  return arr;
}

function renderFiles() {
  const grid = $("#files");
  $("#empty").hidden = true; grid.hidden = false;
  grid.className = "files " + (viewMode === "list" ? "view-list" : "view-grid");
  grid.innerHTML = "";
  if (!entries.length) {
    renderEmpty(searchQuery ? `Aucun fichier ne correspond à « ${searchQuery} ».` : "Dossier vide. Clic droit pour créer un dossier ou un fichier.");
    return;
  }
  const colors = folderColors();
  for (const en of sortedEntries()) {
    const item = document.createElement("div");
    item.className = "item";
    item.dataset.path = en.path;   // lu par le presse-papiers (entrées coupées)
    const glyph = en.is_dir ? folderGlyph(colors[en.path] || cssVar("--folder")) : typedFileGlyph(en.name);
    // Vue liste : date puis taille, comme les colonnes d'un explorateur. La
    // date affichée suit le critère de tri (création si on trie dessus).
    const meta =
      viewMode === "list"
        ? `<div class="row-date" title="${escapeHtml(formatDateFull(en[dateField()]))}">${escapeHtml(formatDate(en[dateField()]))}</div>` +
          (en.is_dir ? `<div class="row-size"></div>` : `<div class="row-size">${formatSize(en.size || 0)}</div>`)
        : "";
    // En recherche, on affiche le dossier parent (le résultat peut venir de n'importe où).
    const dir = en.path.includes("/") ? en.path.slice(0, en.path.lastIndexOf("/")) : "";
    const pathRow = searchQuery ? `<div class="row-path">${escapeHtml(dir || current.name)}</div>` : "";
    item.innerHTML = `<div class="glyph">${glyph}</div><div class="label">${escapeHtml(en.name)}</div>${pathRow}${meta}`;
    // Infobulle : en grille il n'y a pas de colonnes, c'est le seul endroit où
    // lire les dates et la taille d'une entrée.
    item.title = [
      en.name,
      en.is_dir ? null : formatSize(en.size || 0),
      `${tt("Créé")} : ${formatDateFull(en.created)}`,
      `${tt("Modifié")} : ${formatDateFull(en.modified)}`,
    ].filter(Boolean).join("\n");
    // Vignette d'image : remplace le glyphe par l'aperçu réel (asynchrone).
    if (!en.is_dir && IMG_EXT.has(fileExt(en.name))) loadThumb(item, en);
    if (selectedPaths.has(en.path)) item.classList.add("selected");
    item.addEventListener("click", (e) => { e.stopPropagation(); selectItem(item, en, e); });
    item.addEventListener("dblclick", () => openEntry(en));
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      selectItem(item, en);
      showItemMenu(e.clientX, e.clientY, en);
    });
    // Drag&drop : déplacer une entrée dans un dossier.
    item.draggable = true;
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", en.path);
    });
    if (en.is_dir) {
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        item.classList.add("dragover");
      });
      item.addEventListener("dragleave", () => item.classList.remove("dragover"));
      item.addEventListener("drop", (e) => {
        e.preventDefault(); item.classList.remove("dragover");
        const src = e.dataTransfer.getData("text/plain");
        if (src && src !== en.path) moveInto(src, en.path);
      });
    }
    grid.appendChild(item);
  }
  // Un rendu remplace toutes les tuiles : l'estompage des entrées coupées doit
  // être reposé, sinon le presse-papiers « disparaît » au premier rafraîchissement.
  refreshClipboardUi();
}

const THUMB_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  ico: "image/x-icon", bmp: "image/bmp", svg: "image/svg+xml",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v",
  pdf: "application/pdf",
};
// Médias binaires lus via data: (l'aperçu texte ne s'applique pas).
const MEDIA_KIND = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac"],
  video: ["mp4", "webm", "mov", "m4v"],
};
function mediaKind(name) {
  const e = fileExt(name);
  for (const k in MEDIA_KIND) if (MEDIA_KIND[k].includes(e)) return k;
  return null;
}
async function readDataUrl(path) {
  const b64 = await invoke("sandbox_read_b64", { id: current.id, path }).catch(() => null);
  if (b64 == null) return null;
  return `data:${THUMB_MIME[fileExt(path)] || "application/octet-stream"};base64,${b64}`;
}

// Au-delà de cette taille, `sandbox_read_b64` refuse le fichier (plafond de
// 8 Mo côté Rust) : une photo « originale » de 12 Mo ne rendait alors NI
// vignette ni aperçu, en silence. On passe pour elles par le redimensionnement
// backend, qui décode et ré-encode une version légère.
const RAW_READ_MAX_BYTES = 7 * 1024 * 1024;

/// Data-URL d'une image, quelle que soit sa taille.
/// En dessous du plafond : lecture brute (format et animation préservés).
/// Au-dessus : version redimensionnée (`maxPx` sur le plus grand côté).
async function readImageDataUrl(en, maxPx) {
  const size = Number(en?.size || 0);
  if (size && size <= RAW_READ_MAX_BYTES) {
    const raw = await readDataUrl(en.path);
    if (raw) return raw;
  }
  // Gros fichier, taille inconnue, ou lecture brute refusée : version réduite.
  const scaled = await invoke("sandbox_read_image_b64", { id: current.id, path: en.path, maxPx })
    .catch(() => null);
  if (scaled) return scaled;
  // Dernier recours : la lecture brute (formats que le décodeur ne connaît pas,
  // comme certains .ico).
  return readDataUrl(en.path);
}

// Remplace le glyphe d'une image par sa vignette réelle.
async function loadThumb(item, en) {
  const url = await readImageDataUrl(en, 256);
  if (!url) return;
  const g = item.querySelector(".glyph");
  if (g) g.innerHTML = `<img class="thumb" src="${url}" alt="" />`;
}

function setViewMode(m) { viewMode = m; localStorage.setItem(wsKey("sbView"), m); $("#btn-view").innerHTML = ic(m === "list" ? "grid" : "list"); renderFiles(); }
function setSortKey(k) {
  sortKey = k;
  // Changer de critère remet le sens à celui qu'on attend pour ce critère.
  sortDir = "";
  localStorage.setItem(wsKey("sbSort"), k);
  localStorage.removeItem(wsKey("sbSortDir"));
  $("#sort-select").value = k;
  renderSortDir();
  renderFiles();
}
function setSortDir(d) {
  sortDir = d;
  localStorage.setItem(wsKey("sbSortDir"), d);
  renderSortDir();
  renderFiles();
}
// Libellé parlant : le sens n'a pas le même sens selon la clé.
const SORT_DIR_LABEL = {
  name: ["A → Z", "Z → A"],
  type: ["A → Z", "Z → A"],
  size: ["Du plus petit", "Du plus grand"],
  modified: ["Du plus ancien", "Du plus récent"],
  created: ["Du plus ancien", "Du plus récent"],
};
function renderSortDir() {
  const btn = $("#btn-sort-dir");
  if (!btn) return;
  const asc = effectiveSortDir() === "asc";
  btn.innerHTML = ic(asc ? "sortAsc" : "sortDesc");
  btn.title = tt((SORT_DIR_LABEL[sortKey] || SORT_DIR_LABEL.name)[asc ? 0 : 1]);
}

function selectItem(el, en, e) {
  selected = en;
  // Cmd/Ctrl+clic : (dé)sélection multiple pour l'analyse IA.
  if (e && (e.metaKey || e.ctrlKey)) {
    if (selectedPaths.has(en.path)) { selectedPaths.delete(en.path); el.classList.remove("selected"); }
    else { selectedPaths.add(en.path); el.classList.add("selected"); }
    updateSelBar();
    return;
  }
  // Clic simple : sélection unique, on repart à zéro.
  selectedPaths.clear();
  document.querySelectorAll(".item.selected").forEach((i) => i.classList.remove("selected"));
  el.classList.add("selected");
  selectedPaths.add(en.path);
  updateSelBar();
}

function clearSelection() {
  selectedPaths.clear();
  document.querySelectorAll(".item.selected").forEach((i) => i.classList.remove("selected"));
  updateSelBar();
}

// Estimation grossière du nombre de tokens (~4 octets par token).
function estimateTokens(bytes) { return Math.ceil(bytes / 4); }
function formatTokens(tok) {
  if (tok >= 1000) return `${(tok / 1000).toFixed(1)} k tokens`;
  return `${tok} tokens`;
}
// Conseil court selon la taille du contexte estimé.
function ctxAdvice(tok) {
  if (tok > 24000) return "Volumineux : risque de dépasser la fenêtre de contexte de la plupart des modèles locaux.";
  if (tok > 8000) return "Pensez à augmenter la taille du contexte (num_ctx) du modèle dans Lumen.";
  return "Tient dans la fenêtre de contexte usuelle.";
}

// Barre flottante : nombre de fichiers sélectionnés + estimation du contexte.
function updateSelBar() {
  const bar = $("#sel-bar");
  const picked = entries.filter((e) => selectedPaths.has(e.path));
  if (!picked.length) { bar.hidden = true; return; }
  const files = picked.filter((e) => !e.is_dir);
  const dirs = picked.filter((e) => e.is_dir);
  if (files.length < 2 && dirs.length === 0) { bar.hidden = true; return; }
  const bytes = files.reduce((a, e) => a + (e.size || 0), 0);
  const tok = estimateTokens(bytes);
  $("#sel-info").textContent = dirs.length ? `${files.length} fichier(s), ${dirs.length} dossier(s)` : `${files.length} fichiers sélectionnés`;
  const ctx = $("#sel-ctx");
  ctx.textContent = `~${formatTokens(tok)} de contexte`;
  ctx.classList.toggle("warn", tok > 8000);
  bar.hidden = false;
}

function openEntry(en) {
  if (en.is_dir) { clearSearch(); cwd = en.path; closePreview(); refresh(); }
  else {
    const creative = creativeOpenTarget(en.name);
    if (["lumensheet", "xlsx"].includes(fileExt(en.name))) openSheetsFile(en.path);
    else if (creative) openCreativeFile(en.path, creative.kind);
    else openPreview(en);
  }
}

async function openPathFromWorkspace(path) {
  const folder = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
  if (cwd !== folder) {
    clearSearch();
    cwd = folder;
    await refresh();
  }
  let en = entries.find((x) => x.path === path);
  if (!en) {
    const name = path.split("/").pop();
    en = { name, path, is_dir: false, size: 0 };
  }
  openEntry(en);
}

// Réinitialise la recherche (navigation hors résultats).
function clearSearch() {
  if (!searchQuery) return;
  searchQuery = "";
  const inp = $("#file-search"); if (inp) inp.value = "";
}

// ===== Aperçu + agent =====
let previewRaw = "";        // contenu brut du fichier affiché (pour l'édition)
let previewBinary = false;
let previewTruncated = false;
let previewName = "";

async function openPreview(en) {
  previewPath = en.path;
  previewName = en.name;
  $("#preview").hidden = false;
  $("#preview-title").textContent = en.name;
  $("#agent-answer").hidden = true; $("#agent-answer").textContent = ""; $("#agent-answer").className = "agent-answer";
  $("#agent-apply").hidden = true;
  $("#agent-prompt").value = "";

  const mk = mediaKind(en.name);
  if (fileExt(en.name) === "pdf") {
    // PDF : aperçu rendu par la WebView (au lieu de « fichier binaire »).
    previewBinary = true; previewTruncated = false; previewRaw = "";
    await renderPdfViewer(en);
    $("#agent-box").hidden = true;
  } else if (mk) {
    // Média binaire (image / audio / vidéo) : lecteur dédié, pas d'édition.
    previewBinary = true; previewTruncated = false; previewRaw = "";
    await renderMediaViewer(mk, en);
    $("#agent-box").hidden = true;
  } else {
    const res = await invoke("sandbox_read_file", { id: current.id, path: en.path }).catch(() => ({ content: "", binary: true, size: 0 }));
    previewBinary = !!res.binary;
    previewTruncated = !!res.truncated;
    previewRaw = res.binary ? "" : (res.content || "");
    if (res.binary) $("#preview-body").textContent = `(Fichier binaire — ${formatSize(res.size)})`;
    else renderPreviewBody();
    $("#agent-box").hidden = res.binary;
  }
  setEditMode(false);
  $("#preview-launch").hidden = !(isLaunchable(en.name) && !previewBinary);
  $("#preview-history").hidden = previewBinary;
}

// Une mini-app launchable = un point d'entrée HTML.
function isLaunchable(name) { return /\.html?$/i.test(name); }
// Formats convertibles en PDF (doit rester aligné avec sandbox::sandbox_pdf_formats).
function isPdfExportable(name) { return /\.(md|markdown|mdown|txt|text|log|csv|tsv|json|html?|htm)$/i.test(name); }

// Aperçu PDF : on lit le binaire en base64, on construit un Blob et on l'affiche
// dans une iframe (la WebView rend les PDF nativement). Blob plutôt que data: URL
// pour éviter les limites de taille des URLs sur les gros documents.
let pdfBlobUrl = null;
async function renderPdfViewer(en) {
  const body = $("#preview-body");
  body.className = "preview-body pdf-view";
  body.innerHTML = "<div class='quicklook-loading'>…</div>";
  if (pdfBlobUrl) { URL.revokeObjectURL(pdfBlobUrl); pdfBlobUrl = null; }
  try {
    const b64 = await invoke("sandbox_read_b64", { id: current.id, path: en.path });
    if (!b64) { body.textContent = "Aperçu PDF indisponible."; return; }
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    pdfBlobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    body.innerHTML = `<iframe class="pdf-frame" src="${pdfBlobUrl}" title="Aperçu PDF"></iframe>`;
  } catch (e) { body.textContent = "Aperçu PDF indisponible."; }
}

async function renderMediaViewer(kind, en) {
  const body = $("#preview-body");
  body.className = "preview-body media-view";
  body.innerHTML = "<div class='quicklook-loading'>…</div>";
  if (kind === "image") {
    const url = await readImageDataUrl(en, 2048);
    if (!url) { body.textContent = "Aperçu indisponible."; return; }
    body.innerHTML = `<img class="media-img" src="${url}" alt="">`;
    return;
  }
  // Audio / vidéo : lus EN FLUX (lumenmedia://, requêtes Range) — la lecture
  // base64 plafonne à 8 Mo, et un montage exporté de quelques minutes la
  // dépasse : la vidéo générée n'avait alors aucun aperçu.
  const tag = kind === "audio" ? "audio" : "video";
  body.innerHTML = kind === "audio"
    ? `<div class="media-audio"><audio controls preload="metadata"></audio></div>`
    : `<video class="media-video" controls playsinline preload="metadata"></video>`;
  const el = body.querySelector(tag);
  let fellBack = false;
  el.addEventListener("error", async () => {
    // Repli : petit fichier lu d'un bloc (ancien moteur sans schéma média).
    if (fellBack) { body.textContent = "Aperçu indisponible (format non lu par le moteur)."; return; }
    fellBack = true;
    const url = Number(en.size || 0) <= RAW_READ_MAX_BYTES ? await readDataUrl(en.path) : null;
    if (url) el.src = url;
    else body.textContent = "Aperçu indisponible (format non lu par le moteur).";
  });
  el.src = streamUrl(current.id, en.path);
}

/// Adresse de lecture en flux d'un fichier de sandbox (src-tauri/src/media.rs).
function streamUrl(sandboxId, path) {
  const enc = String(path).split("/").map(encodeURIComponent).join("/");
  return /Windows/i.test(navigator.userAgent)
    ? `http://lumenmedia.localhost/${sandboxId}/${enc}`
    : `lumenmedia://localhost/${sandboxId}/${enc}`;
}

// Rendu de l'aperçu (mode lecture) selon l'extension : viewers dédiés
// (svg / csv / json), markdown rendu, code coloré (Monokai), ou texte brut.
function renderPreviewBody() {
  const body = $("#preview-body");
  const ext = fileExt(previewName);
  const suffix = previewTruncated ? "\n\n… (aperçu tronqué)" : "";
  body.className = "preview-body";
  if (ext === "svg") {
    body.classList.add("media-view");
    body.innerHTML = `<img class="media-img" src="data:image/svg+xml;utf8,${encodeURIComponent(previewRaw)}" alt="">`;
    return;
  }
  if (ext === "csv" || ext === "tsv") { body.classList.add("table-view"); mountCsv(body, previewRaw, ext === "tsv" ? "\t" : null); return; }
  if (ext === "json") { body.classList.add("json-view"); mountJson(body, previewRaw); return; }
  const kind = fileKind(previewName);
  if (kind === "markdown") {
    body.classList.add("md-body");
    body.innerHTML = renderMarkdown(previewRaw + suffix);
  } else if (kind === "code") {
    body.classList.add("code-view", "monokai");
    body.innerHTML = `<pre class="code-block"><code>${highlightCode(previewRaw + suffix, ext)}</code></pre>`;
  } else {
    body.textContent = previewRaw + suffix;
  }
}

// Bascule lecture / édition. L'édition est interdite pour les fichiers binaires
// ou tronqués (on n'écrirait qu'un fragment). Pour un fichier de code, l'éditeur
// affiche la coloration Monokai en direct via un calque sous la zone de saisie.
function setEditMode(on) {
  const editable = !previewBinary && !previewTruncated;
  const body = $("#preview-body"), wrap = $("#editor-wrap"), ta = $("#preview-editor");
  $("#preview-edit").hidden = !editable || on;
  $("#preview-save").hidden = !on;
  $("#preview-cancel").hidden = !on;
  $("#preview-launch").hidden = on || !(isLaunchable(previewName) && !previewBinary);
  body.hidden = on;
  wrap.hidden = !on;
  $("#agent-box").hidden = on || previewBinary;
  if (on) {
    const isCode = fileKind(previewName) === "code";
    wrap.classList.toggle("plain", !isCode); // sans coloration : texte visible directement
    ta.value = previewRaw;
    syncEditorHighlight();
    setTimeout(() => ta.focus(), 0);
  }
}

// Met à jour le calque colorisé pour qu'il reflète le texte saisi.
function syncEditorHighlight() {
  const ta = $("#preview-editor"), hl = $("#editor-highlight").firstElementChild;
  if ($("#editor-wrap").classList.contains("plain")) { hl.textContent = ""; return; }
  // Un saut de ligne final n'est pas rendu par <pre> ; on ajoute un espace pour
  // garder le calque aligné avec la dernière ligne vide de la textarea.
  hl.innerHTML = highlightCode(ta.value + "​", fileExt(previewName));
}
function syncEditorScroll() {
  const ta = $("#preview-editor"), pre = $("#editor-highlight");
  pre.scrollTop = ta.scrollTop;
  pre.scrollLeft = ta.scrollLeft;
}

async function savePreviewEdit() {
  if (!previewPath) return;
  const content = $("#preview-editor").value;
  try {
    await invoke("sandbox_write_file", { id: current.id, path: previewPath, content });
    previewRaw = content;
    renderPreviewBody();
    setEditMode(false);
    await refresh();
    toast("Fichier enregistré.", false);
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}

function closePreview() {
  $("#preview").hidden = true; previewPath = null; setEditMode(false);
  if (pdfBlobUrl) { URL.revokeObjectURL(pdfBlobUrl); pdfBlobUrl = null; }
}

// Largeur partagée des volets latéraux, redimensionnable par le bord gauche.
const PREVIEW_WIDTH_KEY = wsKey("sbPreviewWidth");
function clampPanelWidth(w) { return Math.max(320, Math.min(w, Math.round(window.innerWidth * 0.92))); }
function makeResizable(panel) {
  const savedW = parseInt(localStorage.getItem(PREVIEW_WIDTH_KEY) || "", 10);
  if (savedW) panel.style.width = clampPanelWidth(savedW) + "px";
  const handle = document.createElement("div");
  handle.className = "preview-resizer";
  panel.appendChild(handle);
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-col");
    const move = (ev) => { panel.style.width = clampPanelWidth(window.innerWidth - ev.clientX) + "px"; };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col");
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(parseInt(panel.style.width, 10) || 380));
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
}

function wirePreview() {
  makeResizable($("#preview"));
  $("#preview-close").addEventListener("click", closePreview);
  $("#preview-edit").addEventListener("click", () => setEditMode(true));
  $("#preview-history").addEventListener("click", openHistory);
  $("#preview-cancel").addEventListener("click", () => setEditMode(false));
  $("#preview-save").addEventListener("click", savePreviewEdit);
  const ta = $("#preview-editor");
  ta.addEventListener("input", () => { syncEditorHighlight(); syncEditorScroll(); });
  ta.addEventListener("scroll", syncEditorScroll);
  // Tab insère une indentation au lieu de changer de focus.
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 2;
      syncEditorHighlight();
    }
    // Cmd/Ctrl+S enregistre.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); savePreviewEdit(); }
  });
  // Clic droit sur une sélection dans l'éditeur → actions IA limitées au texte sélectionné.
  ta.addEventListener("contextmenu", (e) => {
    if (ta.selectionStart === ta.selectionEnd) return; // pas de sélection : menu natif
    e.preventDefault();
    showSelectionMenu(e.clientX, e.clientY, ta);
  });
  $("#agent-ask").addEventListener("click", askAgent);
  $("#agent-apply").addEventListener("click", applyAgent);
}

// Menu contextuel des actions IA sur la sélection de l'éditeur. Chaque action
// n'envoie que le texte sélectionné à l'IA, puis remplace la sélection par la réponse.
function showSelectionMenu(x, y, ta) {
  const run = (instruction) => aiOnSelection(ta, instruction);
  buildMenu([
    { label: "Reformuler", icon: "sparkles", onClick: () => run("Reformule ce texte de façon claire et naturelle, sans changer le sens. Réponds uniquement avec le texte réécrit, sans explication.") },
    { label: "Corriger l'orthographe", onClick: () => run("Corrige l'orthographe, la grammaire et la ponctuation de ce texte. Réponds uniquement avec le texte corrigé, sans explication.") },
    { label: "Raccourcir", onClick: () => run("Rends ce texte plus concis sans perdre l'information essentielle. Réponds uniquement avec le texte raccourci, sans explication.") },
    { label: "Traduire en anglais", onClick: () => run("Traduis ce texte en anglais. Réponds uniquement avec la traduction, sans explication.") },
    { label: "Traduire en français", onClick: () => run("Traduis ce texte en français. Réponds uniquement avec la traduction, sans explication.") },
    { sep: true },
    { label: "Demander à l'IA…", icon: "sparkles", onClick: async () => {
      const instr = await promptModal("Demander à l'IA", { placeholder: "Ex. : transforme en liste à puces, ajoute des commentaires…", msg: "L'IA ne traitera que le texte sélectionné." });
      if (instr) run(`${instr}\n\nApplique cette consigne au texte ci-dessous et réponds uniquement avec le résultat, sans explication.`);
    } },
  ]);
  placeMenu(x, y);
}

// Envoie uniquement la sélection à l'IA et remplace le texte sélectionné par sa réponse.
// Rien n'est écrit sur le disque tant que l'utilisateur n'enregistre pas (mode édition).
async function aiOnSelection(ta, instruction) {
  const start = ta.selectionStart, end = ta.selectionEnd;
  const selected = ta.value.slice(start, end);
  if (!selected.trim()) return;
  toast("L'IA traite la sélection…", false);
  try {
    const out = stripFences(await ollama(PROMPTS["app.files.selection"].build({ instruction, text: selected }).messages));
    ta.setRangeText(out, start, end, "select");
    ta.focus();
    syncEditorHighlight();
    syncEditorScroll();
    toast("Sélection remplacée (enregistrez pour conserver).", false);
  } catch (e) {
    toast("Échec : " + (e?.message || e));
  }
}

// ===== Lanceur de mini-app confinée =====
let runnerPath = null;
let runnerFrame = null; // iframe en cours (pour filtrer ses messages de console)
function wireRunner() {
  $("#preview-launch").addEventListener("click", () => { if (previewPath) launchApp(previewPath, previewName); });
  $("#app-runner-close").addEventListener("click", closeRunner);
  $("#app-runner-reload").addEventListener("click", () => { if (runnerPath) launchApp(runnerPath.path, runnerPath.name); });
  $("#app-runner-kiosk").addEventListener("click", () => toggleKiosk(true));
  $("#app-runner-exit").addEventListener("click", () => toggleKiosk(false));
  $("#app-runner-console-btn").addEventListener("click", toggleConsole);
  $("#app-runner-dbwrite-btn").addEventListener("click", toggleDbWrite);
  $("#app-runner-console-clear").addEventListener("click", () => { $("#app-runner-console-log").innerHTML = ""; });
  // Reçoit les logs/erreurs relayés par l'app isolée (cf. CONSOLE_BRIDGE), ainsi
  // que les appels RPC « Bases de données » (cf. TABLES_BRIDGE).
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || !runnerFrame) return;
    if (e.source && e.source !== runnerFrame.contentWindow) return;
    if (d.__sbConsole) { appendConsole(d.level || "log", d); return; }
    if (d.__lumenRpc) { handleAppRpc(d); return; }
  });
}

// Méthodes Tauri exposées aux mini-apps via window.lumen.tables. Les méthodes de
// LECTURE sont toujours permises ; les méthodes d'ÉCRITURE exigent que l'app ait
// l'accès écriture (toggle du runner, défaut OFF) — défense en plus de la garde
// lecture seule de `table_query` côté Rust.
const APP_RPC_READ = new Set([
  "table_base_list", "table_list", "table_schema", "table_base_schema",
  "table_rows", "table_query", "table_export_csv",
]);
const APP_RPC_WRITE = new Set([
  "table_base_create", "table_create", "table_column_add",
  "table_row_insert", "table_row_update", "table_row_delete",
]);
let appDbWriteAccess = false;

async function handleAppRpc(d) {
  const reply = (ok, payload) => {
    try {
      runnerFrame?.contentWindow?.postMessage(
        ok ? { __lumenRpcReply: 1, id: d.id, ok: true, data: payload }
           : { __lumenRpcReply: 1, id: d.id, ok: false, error: String(payload) },
        "*"
      );
    } catch {}
  };
  const method = String(d.method || "");
  // Interop : traité ici et non par `invoke` — ce ne sont pas des commandes
  // Tauri mais des appels au bus du bureau. `lumen_share` n'écrit nulle part
  // par lui-même : il ouvre le sélecteur et c'est l'utilisateur qui tranche,
  // d'où l'absence de garde d'écriture.
  if (method === "lumen_share") {
    try {
      const make = window.parent?.LumenMakeObject || window.LumenMakeObject;
      const doShare = window.parent?.LumenShare || window.LumenShare;
      if (!make || !doShare) throw new Error("Bus d'interop indisponible hors du bureau.");
      const obj = make(d.params?.kind, d.params?.payload || {}, { app: "miniapp" });
      reply(true, await doShare(obj));
    } catch (err) {
      reply(false, err?.message || err);
    }
    return;
  }
  if (method === "lumen_shelf") {
    try {
      const shelf = (window.parent?.LumenShelf || window.LumenShelf)?.() || [];
      reply(true, shelf);
    } catch (err) {
      reply(false, err?.message || err);
    }
    return;
  }
  if (!APP_RPC_READ.has(method) && !APP_RPC_WRITE.has(method)) {
    reply(false, "Méthode non autorisée : " + method);
    return;
  }
  if (APP_RPC_WRITE.has(method) && !appDbWriteAccess) {
    reply(false, "Accès en écriture refusé : activez « Accès écriture » dans la barre de l'app.");
    return;
  }
  try {
    reply(true, await invoke(method, d.params || {}));
  } catch (err) {
    reply(false, err?.message || err);
  }
}

function setDbWriteUi() {
  const btn = $("#app-runner-dbwrite-btn");
  if (!btn) return;
  btn.textContent = appDbWriteAccess ? "🗄 Écriture BDD : ON" : "🗄 Écriture BDD : off";
  btn.classList.toggle("active", appDbWriteAccess);
}
function toggleDbWrite() {
  appDbWriteAccess = !appDbWriteAccess;
  setDbWriteUi();
}
function toggleConsole() {
  const c = $("#app-runner-console");
  c.hidden = !c.hidden;
  $("#app-runner-console-btn").classList.toggle("active", !c.hidden);
}
function appendConsole(level, data) {
  const log = $("#app-runner-console-log");
  if (!log) return;
  const payload = typeof data === "string" ? { text: data } : (data || {});
  const text = payload.text || "";
  const line = document.createElement("div");
  line.className = "ar-console-line ar-console-" + (["log", "info", "warn", "error", "debug"].includes(level) ? level : "log");
  const t = new Date().toLocaleTimeString();
  const where = payload.source ? ` ${payload.source}${payload.line ? `:${payload.line}${payload.column ? `:${payload.column}` : ""}` : ""}` : "";
  line.innerHTML = `<span class="ar-console-time">${t}</span><span class="ar-console-main"><span class="ar-console-text"></span><span class="ar-console-where"></span><span class="ar-console-stack"></span></span>`;
  line.querySelector(".ar-console-text").textContent = text;
  line.querySelector(".ar-console-where").textContent = where;
  const stackEl = line.querySelector(".ar-console-stack");
  stackEl.textContent = payload.stack || "";
  stackEl.hidden = !payload.stack;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  // Si une erreur survient alors que la console est masquée, on la révèle.
  if (level === "error" && $("#app-runner-console").hidden) toggleConsole();
}
function toggleKiosk(on) {
  const r = $("#app-runner");
  r.classList.toggle("kiosk", on);
  $("#app-runner-exit").hidden = !on;
  try {
    if (on && r.requestFullscreen) r.requestFullscreen().catch(() => {});
    else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } catch (e) { /* l'overlay couvre déjà toute la fenêtre */ }
}
function closeRunner() {
  toggleKiosk(false);
  $("#app-runner").hidden = true;
  $("#app-runner-stage").innerHTML = ""; // détruit l'iframe (stoppe scripts/timers)
  runnerPath = null;
  runnerFrame = null;
}
async function launchApp(path, name) {
  // Tolère qu'on lance un DOSSIER : on résout son point d'entrée HTML (index.html
  // de préférence) — une app = un dossier index.html + style.css + app.js.
  const resolved = await resolveAppEntry(path);
  if (!resolved) {
    $("#app-runner").hidden = false;
    $("#app-runner-stage").innerHTML = `<div class="app-runner-loading">Aucun point d'entrée HTML (index.html) trouvé.</div>`;
    return;
  }
  path = resolved.path; name = resolved.name;
  runnerPath = { path, name };
  // Sécurité : chaque lancement repart en lecture seule pour les bases de données.
  appDbWriteAccess = false; setDbWriteUi();
  $("#app-runner").hidden = false;
  $("#app-runner-title").textContent = name;
  $("#app-runner-console-log").innerHTML = ""; // repart propre à chaque lancement
  appendConsole("info", `Préparation : ${name}`);
  const stage = $("#app-runner-stage");
  stage.innerHTML = `<div class="app-runner-loading">Préparation de l'app…</div>`;
  try {
    const srcdoc = await bundleApp(current.id, path);
    const frame = document.createElement("iframe");
    frame.className = "app-frame";
    // Confinement : origine opaque (pas de allow-same-origin → l'app ne peut pas
    // atteindre __TAURI__/parent). Les scripts inline s'exécutent car la CSP n'a
    // plus de nonce (dangerousDisableAssetCspModification) → 'unsafe-inline' honoré.
    frame.setAttribute("sandbox", "allow-scripts allow-modals allow-forms allow-pointer-lock");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc = srcdoc;
    stage.innerHTML = "";
    stage.appendChild(frame);
    runnerFrame = frame;
  } catch (e) {
    stage.innerHTML = `<div class="app-runner-loading">Échec : ${escapeHtml(e?.message || e)}</div>`;
  }
}

// Résout le point d'entrée d'une app : si `path` est déjà un .html on le garde ;
// si c'est un dossier (ou un chemin sans .html), on cherche index.html dedans,
// à défaut le premier .html du dossier. Renvoie { path, name } ou null.
async function resolveAppEntry(path) {
  if (/\.html?$/i.test(path)) return { path, name: String(path).split("/").pop() };
  const dir = String(path).replace(/\/+$/, "");
  const listing = await invoke("sandbox_read_dir", { id: current.id, path: dir }).catch(() => null);
  const files = (listing || []).filter((e) => !e.is_dir && /\.html?$/i.test(e.name));
  if (!files.length) return null;
  const idx = files.find((e) => /^index\.html?$/i.test(e.name)) || files[0];
  return { path: idx.path, name: dir.split("/").pop() + "/" + idx.name };
}

// ===== Clavier global : Échap (overlays) + Espace (Quick Look) =====
function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
}
function onGlobalKey(e) {
  if (e.key === " " && !isTyping()) {
    if (!$("#quicklook").hidden) { e.preventDefault(); closeQuickLook(); return; }
    if ($("#app-runner").hidden && $("#launchpad").hidden && selected && !selected.is_dir) {
      e.preventDefault(); openQuickLook(selected); return;
    }
  }
  if (e.key === "Escape") {
    hideCtxMenu();
    if (!$("#app-runner").hidden) { if ($("#app-runner").classList.contains("kiosk")) toggleKiosk(false); else closeRunner(); return; }
    if (!$("#launchpad").hidden) { closeLaunchpad(); return; }
    if (!$("#history").hidden) { closeHistory(); return; }
    if (!$("#quicklook").hidden) { closeQuickLook(); return; }
    closePreview(); closeMulti();
  }
}

// ===== Quick Look (aperçu rapide à la barre espace) =====
function wireQuickLook() {
  $("#quicklook-close").addEventListener("click", closeQuickLook);
  $("#quicklook").addEventListener("click", (e) => { if (e.target.id === "quicklook") closeQuickLook(); });
}
function closeQuickLook() { $("#quicklook").hidden = true; $("#quicklook-body").innerHTML = ""; }
async function openQuickLook(en) {
  $("#quicklook").hidden = false;
  $("#quicklook-title").textContent = en.name;
  const body = $("#quicklook-body");
  body.className = "quicklook-body";
  body.innerHTML = "<div class='quicklook-loading'>…</div>";
  const ext = fileExt(en.name);
  if (IMG_EXT.has(ext) || ext === "svg") {
    // Le SVG n'est pas décodé côté Rust : lecture brute (c'est du texte, léger).
    const url = ext === "svg" ? await readDataUrl(en.path) : await readImageDataUrl(en, 2048);
    body.innerHTML = url ? `<img class="ql-img" src="${url}" alt="">` : "Aperçu indisponible.";
    return;
  }
  const res = await invoke("sandbox_read_file", { id: current.id, path: en.path }).catch(() => ({ binary: true }));
  if (res.binary) { body.textContent = `Fichier binaire — ${formatSize(res.size || 0)}`; return; }
  const kind = fileKind(en.name);
  if (kind === "markdown") { body.classList.add("md-body"); body.innerHTML = renderMarkdown(res.content); }
  else if (kind === "code") { body.classList.add("code-view", "monokai"); body.innerHTML = `<pre class="code-block"><code>${highlightCode(res.content, ext)}</code></pre>`; }
  else { body.innerHTML = `<pre class="ql-text">${escapeHtml(res.content)}</pre>`; }
}

// ===== Launchpad (écran d'accueil des mini-apps) =====
function wireLaunchpad() {
  $("#launchpad-close").addEventListener("click", closeLaunchpad);
  $("#launchpad").addEventListener("click", (e) => { if (e.target.id === "launchpad") closeLaunchpad(); });
}
function closeLaunchpad() { $("#launchpad").hidden = true; $("#launchpad-grid").innerHTML = ""; }
// Parcours superficiel de la sandbox pour trouver les points d'entrée HTML.
async function findApps(maxDepth = 3, cap = 40) {
  const out = [];
  async function walk(dir, depth) {
    if (out.length >= cap || depth > maxDepth) return;
    let list = [];
    try { list = await invoke("sandbox_read_dir", { id: current.id, path: dir }); } catch { return; }
    for (const en of list) {
      if (out.length >= cap) break;
      if (en.is_dir) await walk(en.path, depth + 1);
      else if (/\.html?$/i.test(en.name)) out.push({ name: en.name, path: en.path, dir: en.path.includes("/") ? en.path.slice(0, en.path.lastIndexOf("/")) : "" });
    }
  }
  await walk("", 0);
  return out;
}
async function openLaunchpad() {
  if (!current) return;
  $("#launchpad").hidden = false;
  const grid = $("#launchpad-grid");
  $("#launchpad-sub").textContent = "";
  grid.innerHTML = "<div class='launchpad-empty'>Recherche des apps…</div>";
  const apps = await findApps();
  grid.innerHTML = "";
  if (!apps.length) {
    grid.innerHTML = "<div class='launchpad-empty'>Aucune app HTML dans cette sandbox.<br>Crée un fichier <code>.html</code> (ou demande à l'agent) puis reviens ici.</div>";
    return;
  }
  $("#launchpad-sub").textContent = `${apps.length} app${apps.length > 1 ? "s" : ""} · ${current.name}`;
  for (const app of apps) {
    const tile = document.createElement("div");
    tile.className = "app-tile";
    tile.innerHTML = `<div class="app-tile-thumb"></div>` +
      `<div class="app-tile-label">${escapeHtml(app.name)}</div>` +
      `<div class="app-tile-path">${escapeHtml(app.dir || "/")}</div>`;
    tile.addEventListener("click", () => { closeLaunchpad(); launchApp(app.path, app.name); });
    grid.appendChild(tile);
    renderAppThumb(tile.querySelector(".app-tile-thumb"), app.path);
  }
}
// Vignette = iframe live réduite (non interactive), même bundling confiné.
async function renderAppThumb(host, path) {
  try {
    const srcdoc = await bundleApp(current.id, path);
    const frame = document.createElement("iframe");
    frame.className = "app-tile-frame";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("scrolling", "no");
    frame.setAttribute("tabindex", "-1");
    host.appendChild(frame);
    frame.srcdoc = srcdoc;
  } catch (e) { host.textContent = "▦"; }
}

// ===== Analyse multi-fichiers =====
function wireMulti() {
  makeResizable($("#multi"));
  $("#sel-clear").addEventListener("click", clearSelection);
  $("#sel-ask").addEventListener("click", openMultiPanel);
  $("#multi-close").addEventListener("click", closeMulti);
  $("#multi-ask").addEventListener("click", askMultiAgent);
  $("#multi-apply").addEventListener("click", applyMultiAgent);
  $("#multi-mode").addEventListener("change", updateMultiMode);
}
function closeMulti() { $("#multi").hidden = true; multiFiles = []; multiDiffs = []; }

async function openMultiPanel() {
  const picked = entries.filter((e) => selectedPaths.has(e.path));
  const files = await expandMultiSelection(picked);
  if (files.length < 1) { toast("Aucun fichier texte exploitable dans la sélection."); return; }
  multiFiles = files;
  closePreview();
  $("#multi").hidden = false;
  $("#multi-title").textContent = `IA sur ${files.length} fichiers`;
  const list = $("#multi-files"); list.innerHTML = "";
  for (const f of files) {
    const chip = document.createElement("span");
    chip.className = "multi-chip";
    chip.textContent = f.name;
    chip.title = `${f.path} — ${formatSize(f.size || 0)}`;
    list.appendChild(chip);
  }
  const bytes = files.reduce((a, e) => a + (e.size || 0), 0);
  const tok = estimateTokens(bytes);
  const note = $("#multi-ctx-note");
  note.textContent = `Contexte estimé : ~${formatTokens(tok)} (${formatSize(bytes)}). ${ctxAdvice(tok)}`;
  note.classList.toggle("warn", tok > 8000);
  $("#multi-answer").hidden = true; $("#multi-answer").textContent = ""; $("#multi-answer").className = "agent-answer";
  $("#multi-log").hidden = true; $("#multi-log").innerHTML = "";
  multiDiffs = []; updateMultiApplyState();
  $("#multi-prompt").value = "";
  updateMultiMode();
  setTimeout(() => $("#multi-prompt").focus(), 0);
}

async function askMultiAgent() {
  const prompt = $("#multi-prompt").value.trim();
  if (!prompt || !multiFiles.length) return;
  const ans = $("#multi-answer");
  ans.hidden = false; ans.textContent = "";
  ans.className = "agent-answer";
  multiDiffs = []; updateMultiApplyState();
  const mode = $("#multi-mode").value || "ask";
  const maxIterations = mode === "agent" ? Math.max(1, Math.min(5, parseInt($("#multi-iters").value, 10) || 3)) : 1;
  resetMultiLog();
  try {
    logMulti("read", "Lecture", `${multiFiles.length} fichier(s) chargés dans le contexte.`);
    const docs = await readMultiFiles(multiFiles);
    if (mode === "ask") {
      logMulti("think", "Analyse", "Demande envoyée à l'IA.");
      ans.textContent = await ollama(PROMPTS["app.files.multi-ask"].build({ request: prompt, files: docs, lang: replyLang() }).messages, (txt) => { if (txt) ans.textContent = txt; });
      logMulti("done", "Terminé", "Réponse d'analyse reçue.");
      return;
    }
    ans.textContent = "Préparation des diffs…";
    let working = docs.map((d) => ({ ...d }));
    for (let iter = 1; iter <= maxIterations; iter++) {
      logMulti("think", mode === "agent" ? `Itération ${iter}` : "Modification", "Analyse et proposition de changements.");
      const { messages: editMsgs, opts: editOpts } = PROMPTS["app.files.multi-edit"].build({ request: prompt, files: working, iter, maxIterations, agentic: mode === "agent" });
      const out = await ollama(editMsgs, null, editOpts);
      const proposals = parseMultiEditResponse(out);
      if (!proposals.length) {
        logMulti("warn", "Aucun patch", "L'IA n'a pas renvoyé de modifications structurées.");
        if (iter === 1) ans.textContent = out;
        break;
      }
      const accepted = [];
      for (const p of proposals) {
        const doc = working.find((d) => d.path === p.path);
        if (!doc || doc.binary) continue;
        const next = typeof p.content === "string" ? p.content : doc.content;
        const blocks = diffLines(doc.content, next);
        if (countChanges(blocks) === 0) continue;
        accepted.push({ path: doc.path, name: doc.name, original: doc.content, proposed: next, blocks, ext: fileExt(doc.name) });
        doc.content = next;
      }
      logMulti("diff", `Diff ${iter}`, `${accepted.length} fichier(s) avec modifications.`);
      if (!accepted.length || mode !== "agent") { multiDiffs = accepted; break; }
      multiDiffs = accepted;
    }
    renderMultiDiffs(ans);
    updateMultiApplyState();
  } catch (e) {
    ans.textContent = "Erreur : " + (e?.message || e);
    logMulti("error", "Erreur", e?.message || String(e));
  }
}

async function expandMultiSelection(items) {
  const out = [];
  const seen = new Set();
  const visit = async (en) => {
    if (!en) return;
    if (!en.is_dir) {
      if (!seen.has(en.path) && isAiTextFile(en.name, en.size || 0)) { seen.add(en.path); out.push(en); }
      return;
    }
    const children = await invoke("sandbox_read_dir", { id: current.id, path: en.path }).catch(() => []);
    for (const child of children) {
      if (out.length >= 60) break;
      await visit(child);
    }
  };
  for (const en of items) {
    if (out.length >= 60) break;
    await visit(en);
  }
  return out;
}

function isAiTextFile(name, size = 0) {
  if (size > 450_000) return false;
  const ext = fileExt(name);
  return new Set(["html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md", "markdown", "txt", "csv", "tsv", "xml", "yml", "yaml", "toml", "rs", "py", "sh", "sql"]).has(ext);
}

async function readMultiFiles(files) {
  const docs = [];
  for (const f of files) {
    const file = await invoke("sandbox_read_file", { id: current.id, path: f.path }).catch(() => null);
    if (!file || file.binary) {
      docs.push({ path: f.path, name: f.name, content: "", binary: true, truncated: false });
    } else {
      docs.push({ path: f.path, name: f.name, content: file.content || "", binary: false, truncated: !!file.truncated });
    }
  }
  return docs.filter((d) => !d.binary);
}

function parseMultiEditResponse(out) {
  const raw = stripFences(out);
  const candidates = [raw];
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) candidates.push(raw.slice(s, e + 1));
  for (const c of candidates) {
    try {
      const data = JSON.parse(c);
      if (Array.isArray(data?.files)) {
        return data.files
          .filter((f) => typeof f?.path === "string" && typeof f?.content === "string")
          .map((f) => ({ path: f.path.replace(/^\/+/, ""), content: f.content }));
      }
    } catch {}
  }
  return [];
}

function resetMultiLog() {
  const log = $("#multi-log");
  log.hidden = false;
  log.innerHTML = "";
}

function logMulti(kind, title, body = "") {
  const log = $("#multi-log");
  if (!log) return;
  log.hidden = false;
  const row = document.createElement("div");
  row.className = "agent-log-row agent-log-" + kind;
  row.innerHTML = `<span class="agent-log-dot"></span><span class="agent-log-main"><b>${escapeHtml(title)}</b>${body ? `<small>${escapeHtml(body)}</small>` : ""}</span>`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function updateMultiMode() {
  const mode = $("#multi-mode")?.value || "ask";
  $("#multi-iter-wrap").hidden = mode !== "agent";
  $("#multi-ask").textContent = mode === "ask" ? "Demander" : mode === "agent" ? "Lancer l'agent" : "Préparer les diffs";
}

function updateMultiApplyState() {
  const btn = $("#multi-apply");
  if (!btn) return;
  const files = multiDiffs.filter((d) => countChanges(d.blocks) > 0);
  const accepted = files.reduce((n, d) => n + d.blocks.filter((b) => b.type === "change" && b.accepted !== false).length, 0);
  btn.hidden = files.length === 0;
  btn.disabled = accepted === 0;
  btn.textContent = accepted === 0 ? "Aucun changement accepté" : `Appliquer ${accepted} changement(s) accepté(s)`;
}

function renderMultiDiffs(container) {
  container.innerHTML = "";
  container.className = "agent-answer multi-diff-wrap";
  container.hidden = false;
  if (!multiDiffs.length) {
    container.textContent = "Aucune modification proposée.";
    updateMultiApplyState();
    return;
  }
  for (const diff of multiDiffs) {
    const section = document.createElement("section");
    section.className = "multi-diff-file";
    const head = document.createElement("div");
    head.className = "multi-diff-head";
    head.innerHTML = `<b>${escapeHtml(diff.path)}</b><span>${countChanges(diff.blocks)} bloc(s)</span>`;
    section.appendChild(head);
    const body = document.createElement("div");
    renderAgentDiff(body, diff.blocks, diff.ext, false, () => { renderMultiDiffs(container); updateMultiApplyState(); });
    section.appendChild(body);
    container.appendChild(section);
  }
  updateMultiApplyState();
}

async function applyMultiAgent() {
  const changes = multiDiffs.filter((d) => countChanges(d.blocks) > 0);
  if (!changes.length) return;
  $("#multi-apply").disabled = true;
  try {
    for (const d of changes) {
      const content = applyDiff(d.blocks);
      await invoke("sandbox_write_file", { id: current.id, path: d.path, content });
      logMulti("write", "Écrit", d.path);
    }
    multiDiffs = [];
    updateMultiApplyState();
    $("#multi-answer").hidden = true;
    await refresh();
    toast("Changements multi-fichiers appliqués.", false);
  } catch (e) {
    logMulti("error", "Échec écriture", e?.message || String(e));
    toast("Échec : " + (e?.message || e));
    updateMultiApplyState();
  }
}

let agentDiffBlocks = null; // blocs de diff en attente de validation
async function askAgent() {
  const prompt = $("#agent-prompt").value.trim();
  if (!prompt || !previewPath) return;
  const ans = $("#agent-answer");
  ans.className = "agent-answer"; ans.hidden = false; ans.textContent = "Réflexion…";
  $("#agent-apply").hidden = true; agentDiffBlocks = null;
  try {
    const file = await invoke("sandbox_read_file", { id: current.id, path: previewPath });
    // Demande de modification → vue diff (accepter/refuser par bloc). Sinon, texte.
    const isEdit = /corrig|modif|réécri|reecri|remplace|ajoute|traduis|refactor|format|réécris|change/i.test(prompt);
    const out = await ollama(PROMPTS[isEdit ? "app.files.edit" : "app.files.ask"].build({ request: prompt, path: previewPath, content: file.content, lang: replyLang() }).messages,
      isEdit ? (txt) => { ans.textContent = `Génération… ${txt.split("\n").length} ligne(s)`; } : (txt) => { if (txt) ans.textContent = txt; });
    if (isEdit) {
      const proposal = stripFences(out);
      agentDiffBlocks = diffLines(file.content, proposal);
      renderSingleAgentDiff(ans);
    } else {
      ans.textContent = out;
    }
  } catch (e) {
    ans.textContent = "Erreur : " + (e?.message || e);
  }
}

function renderSingleAgentDiff(container) {
  renderAgentDiff(container, agentDiffBlocks, fileExt(previewName), false, () => renderSingleAgentDiff(container));
  updateAgentApplyState();
}

function updateAgentApplyState() {
  const btn = $("#agent-apply");
  if (!btn) return;
  const changes = agentDiffBlocks ? countChanges(agentDiffBlocks) : 0;
  const accepted = agentDiffBlocks ? agentDiffBlocks.filter((b) => b.type === "change" && b.accepted !== false).length : 0;
  btn.hidden = changes === 0;
  btn.disabled = accepted === 0;
  btn.textContent = accepted === 0 ? "Aucun changement accepté" : `Appliquer ${accepted} changement(s) accepté(s)`;
}

// Rend la vue diff (palette Monokai). `readOnly` masque les contrôles (comparaison
// d'historique) ; sinon un bouton Accepter/Refuser par bloc.
function renderAgentDiff(container, blocks, ext = fileExt(previewName), readOnly = false, onChange = null) {
  container.innerHTML = "";
  container.classList.add("diff-view", "monokai");
  if (countChanges(blocks) === 0) { container.textContent = readOnly ? "Identique à la version actuelle." : "Aucune modification proposée."; return; }

  if (!readOnly) {
    const bar = document.createElement("div");
    bar.className = "diff-toolbar";
    const accAll = document.createElement("button"); accAll.className = "diff-mini"; accAll.textContent = "Tout accepter";
    const rejAll = document.createElement("button"); rejAll.className = "diff-mini"; rejAll.textContent = "Tout refuser";
    accAll.addEventListener("click", () => { blocks.forEach((b) => { if (b.type === "change") b.accepted = true; }); onChange ? onChange() : renderAgentDiff(container, blocks, ext); });
    rejAll.addEventListener("click", () => { blocks.forEach((b) => { if (b.type === "change") b.accepted = false; }); onChange ? onChange() : renderAgentDiff(container, blocks, ext); });
    bar.append(accAll, rejAll);
    container.appendChild(bar);
  }

  const line = (txt, cls, gutter) => {
    const row = document.createElement("div");
    row.className = "diff-line " + cls;
    row.innerHTML = `<span class="diff-gutter">${gutter}</span><code>${highlightCode(txt, ext) || "&nbsp;"}</code>`;
    return row;
  };
  for (const b of blocks) {
    if (b.type === "eq") {
      // Replie les longs blocs de contexte.
      const L = b.lines;
      const show = (arr, off) => arr.forEach((t) => container.appendChild(line(t, "diff-ctx", " ")));
      if (L.length > 6) {
        show(L.slice(0, 3));
        const fold = document.createElement("div");
        fold.className = "diff-fold"; fold.textContent = `⋯ ${L.length - 6} lignes inchangées ⋯`;
        container.appendChild(fold);
        show(L.slice(-3));
      } else show(L);
    } else {
      const hunk = document.createElement("div");
      hunk.className = "diff-hunk" + (b.accepted === false ? " rejected" : "");
      if (!readOnly) {
        const head = document.createElement("div");
        head.className = "diff-hunk-head";
        const tag = document.createElement("span");
        tag.className = "diff-tag";
        tag.textContent = b.accepted === false ? "Refusé (garde l'original)" : "Accepté (applique la proposition)";
        const toggle = document.createElement("button");
        toggle.className = "diff-mini";
        toggle.textContent = b.accepted === false ? "Accepter" : "Refuser";
        toggle.addEventListener("click", () => { b.accepted = b.accepted === false; onChange ? onChange() : renderAgentDiff(container, blocks, ext); });
        head.append(tag, toggle);
        hunk.appendChild(head);
      }
      b.del.forEach((t) => hunk.appendChild(line(t, "diff-del", "−")));
      b.ins.forEach((t) => hunk.appendChild(line(t, "diff-ins", "+")));
      container.appendChild(hunk);
    }
  }
}

async function applyAgent() {
  if (!agentDiffBlocks || !previewPath) return;
  const content = applyDiff(agentDiffBlocks);
  try {
    await invoke("sandbox_write_file", { id: current.id, path: previewPath, content });
    // Rend l'aperçu directement à partir du contenu déjà en mémoire (pas de
    // relecture asynchrone → pas de risque d'aperçu vide par course avec l'écriture).
    previewRaw = content;
    previewTruncated = false;
    agentDiffBlocks = null;
    const ans = $("#agent-answer");
    ans.hidden = true; ans.textContent = ""; ans.className = "agent-answer"; // purge le style diff
    $("#agent-apply").hidden = true;
    $("#agent-prompt").value = "";
    renderPreviewBody();
    await refresh(); // rafraîchit la grille/jauge (n'altère pas l'aperçu)
    toast("Modifications appliquées.", false);
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}

// ===== Historique des versions (snapshots) =====
function wireHistory() {
  $("#history-close").addEventListener("click", closeHistory);
  $("#history").addEventListener("click", (e) => { if (e.target.id === "history") closeHistory(); });
}
function closeHistory() {
  $("#history").hidden = true;
  $("#history-list").innerHTML = "";
  $("#history-detail").hidden = true; $("#history-detail").innerHTML = "";
}
async function openHistory() {
  if (!previewPath || previewBinary) return;
  $("#history").hidden = false;
  $("#history-title").textContent = "Historique — " + previewName;
  const list = $("#history-list"), detail = $("#history-detail");
  detail.hidden = true; detail.innerHTML = "";
  list.innerHTML = "<div class='history-empty'>Chargement…</div>";
  let snaps = await invoke("sandbox_snapshot_list", { id: current.id, path: previewPath }).catch(() => []);
  snaps = snaps.slice().reverse(); // plus récent d'abord
  list.innerHTML = "";
  if (!snaps.length) {
    list.innerHTML = "<div class='history-empty'>Aucune version antérieure.<br>Une version est conservée à chaque enregistrement.</div>";
    return;
  }
  snaps.forEach((s, i) => {
    const row = document.createElement("div"); row.className = "history-row";
    row.innerHTML = `<span class="history-when">${i === 0 ? "● " : ""}${fmtWhen(s.ts)}</span><span class="history-size">${formatSize(s.size)}</span>`;
    const acts = document.createElement("span"); acts.className = "history-acts";
    const bCmp = document.createElement("button"); bCmp.className = "diff-mini"; bCmp.textContent = "Comparer";
    const bRes = document.createElement("button"); bRes.className = "diff-mini"; bRes.textContent = "Restaurer";
    bCmp.addEventListener("click", () => compareSnapshot(s.ts));
    bRes.addEventListener("click", () => restoreSnapshot(s.ts));
    acts.append(bCmp, bRes); row.appendChild(acts);
    list.appendChild(row);
  });
}
async function compareSnapshot(ts) {
  const content = await invoke("sandbox_snapshot_get", { id: current.id, path: previewPath, ts }).catch(() => null);
  if (content == null) { toast("Version introuvable"); return; }
  const detail = $("#history-detail");
  detail.hidden = false; detail.className = "history-detail";
  // Diff version → actuel : suppressions = ce qui a disparu, ajouts = ce qui est arrivé depuis.
  renderAgentDiff(detail, diffLines(content, previewRaw), fileExt(previewName), true);
}
async function restoreSnapshot(ts) {
  const content = await invoke("sandbox_snapshot_get", { id: current.id, path: previewPath, ts }).catch(() => null);
  if (content == null) { toast("Version introuvable"); return; }
  const ok = await confirmModal("Restaurer cette version ?", "Le contenu actuel sera remplacé. Il est lui-même versionné, donc l'opération reste annulable.");
  if (!ok) return;
  try {
    await invoke("sandbox_write_file", { id: current.id, path: previewPath, content });
    previewRaw = content; previewTruncated = false;
    renderPreviewBody();
    closeHistory();
    await refresh();
    toast("Version restaurée.", false);
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}
function fmtWhen(ms) {
  try { return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
  catch { return new Date(ms).toLocaleString(); }
}

// Appel LLM unifié (Ollama natif OU API cloud OpenAI, config partagée avec la barre).
// `onDelta(texte)` facultatif : réponse en flux (réponses affichées en texte).
async function ollama(messages, onDelta, opts = {}) {
  const { content: out, data } = await llmChat(messages, { ...opts, rawSystem: true, ...(onDelta ? { onDelta } : {}) });
  recordOllamaUsage(data, "sandbox");
  return out || "(réponse vide)";
}
function stripFences(s) {
  const m = s.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return m ? m[1].trimEnd() : s.trim();
}

// ===== Menu contextuel =====
function ctx() { return $("#ctx-menu"); }
function hideCtxMenu() { ctx().hidden = true; }
function buildMenu(items) {
  const m = ctx(); m.innerHTML = "";
  for (const it of items) {
    if (it.sep) { const s = document.createElement("div"); s.className = "ctx-sep"; m.appendChild(s); continue; }
    if (it.swatches) {
      const wrap = document.createElement("div"); wrap.className = "ctx-swatches";
      for (const c of it.swatches) {
        const sw = document.createElement("div"); sw.className = "ctx-swatch"; sw.style.background = c;
        sw.addEventListener("click", (e) => { e.stopPropagation(); it.onPick(c); hideCtxMenu(); });
        wrap.appendChild(sw);
      }
      m.appendChild(wrap); continue;
    }
    const el = document.createElement("div");
    el.className = "ctx-item" + (it.danger ? " danger" : "");
    el.innerHTML = (it.icon ? ic(it.icon) : "") + `<span>${it.label}</span>`;
    el.addEventListener("click", (e) => { e.stopPropagation(); hideCtxMenu(); it.onClick(); });
    m.appendChild(el);
  }
}
function placeMenu(x, y) {
  const m = ctx(); m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 8) + "px";
  m.style.top = Math.min(y, window.innerHeight - h - 8) + "px";
}
function showItemMenu(x, y, en) {
  const items = [
    { label: en.is_dir ? "Ouvrir" : "Aperçu", onClick: () => openEntry(en) },
    { label: "Renommer", onClick: () => renameEntry(en) },
  ];
  if (!en.is_dir) {
    items.push({ sep: true });
    const creative = creativeOpenTarget(en.name);
    if (creative) items.push({ label: creative.label, icon: creative.icon, onClick: () => openCreativeFile(en.path, creative.kind) });
    if (["lumensheet", "csv", "tsv", "xlsx"].includes(fileExt(en.name))) items.push({ label: tt("Ouvrir dans Calc"), icon: "tables", onClick: () => openSheetsFile(en.path) });
    if (isLaunchable(en.name)) items.push({ label: "▶ Lancer l'app", onClick: () => launchApp(en.path, en.name) });
    if (isPdfExportable(en.name)) items.push({ label: "Générer un PDF", icon: "filePlus", onClick: () => exportPdf(en) });
    items.push({ label: "Télécharger", icon: "download", onClick: () => downloadEntry(en) });
    items.push({ label: "Demander à l'agent…", onClick: () => { openPreview(en).then(() => $("#agent-prompt").focus()); } });
  }
  if (en.is_dir) {
    items.push({ sep: true });
    // Un dossier peut être une app (index.html + style.css + app.js) : on le lance
    // directement, le point d'entrée HTML est résolu par resolveAppEntry().
    items.push({ label: "▶ Lancer l'app", onClick: () => launchApp(en.path, en.name) });
    items.push({ label: "Générer une image…", icon: "sparkles", onClick: () => generateBonsaiImage(en.path) });
    items.push({ label: "Couleur du dossier", onClick: () => {} });
    items.push({ swatches: ["#54a0ff", "#5ac8fa", "#34c759", "#ffcc00", "#ff9500", "#ff3b30", "#af52de", "#8e8e93"], onPick: (c) => setFolderColor(en.path, c) });
  }
  // ----- Presse-papiers -----
  const targets = actionTargets(en);
  const many = targets.length > 1 ? ` (${targets.length})` : "";
  items.push({ sep: true });
  items.push({ label: tt("Copier") + many, icon: "copy", onClick: () => setClipboard("copy", targets) });
  items.push({ label: tt("Couper") + many, icon: "scissors", onClick: () => setClipboard("cut", targets) });
  // Coller DANS un dossier sans avoir à l'ouvrir d'abord.
  if (en.is_dir && clipboard) items.push({ label: pasteLabel(), icon: "clipboard", onClick: () => pasteInto(en.path) });
  items.push({ label: tt("Déplacer vers une sandbox…") + many, icon: "folder", onClick: () => sendToSandbox(targets, "cut") });
  items.push({ label: tt("Copier vers une sandbox…") + many, icon: "copy", onClick: () => sendToSandbox(targets, "copy") });

  items.push({ sep: true });
  items.push({ label: "Supprimer" + many, danger: true, onClick: () => deleteEntry(en) });
  buildMenu(items); placeMenu(x, y);
}
function creativeOpenTarget(name) {
  const ext = fileExt(name);
  if (ext === "lumenpages") return { kind: "document", label: tt("Ouvrir dans Documents"), icon: "filePlus" };
  // (.docx / .pptx : convertis à l'ouverture, réenregistrés dans leur format.)
  if (ext === "lumenkey" || ext === "pptx") return { kind: "presentation", label: tt("Ouvrir dans Présentations"), icon: "filePlus" };
  if (ext === "docx") return { kind: "document", label: tt("Ouvrir dans Documents"), icon: "filePlus" };
  if (ext === "html" || ext === "htm") return { kind: "", label: tt("Ouvrir comme document design"), icon: "filePlus" };
  return null;
}
/// Actions qui portent sur la SANDBOX elle-même, pas sur son contenu.
function showSandboxMenu(x, y) {
  buildMenu([
    { label: tt("Modifier la taille maximale"), onClick: () => resizeSandbox() },
    { label: tt("Nouvelle sandbox"), icon: "folderPlus", onClick: () => createSandbox() },
    { sep: true },
    { label: tt("Supprimer la sandbox…"), icon: "trash", danger: true, onClick: () => deleteSandbox() },
  ]);
  placeMenu(x, y);
}

function showBackgroundMenu(x, y) {
  const items = [
    { label: "Nouveau dossier", icon: "folderPlus", onClick: () => createEntry(true) },
    { label: "Nouveau fichier", icon: "filePlus", onClick: () => createEntry(false) },
    { label: "Générer une image…", icon: "sparkles", onClick: () => generateBonsaiImage(cwd) },
  ];
  if (clipboard) {
    items.push({ sep: true });
    items.push({ label: pasteLabel(), icon: "clipboard", onClick: () => pasteInto(cwd) });
  }
  items.push({ sep: true });
  items.push({ label: "Actualiser", onClick: () => refresh() });
  buildMenu(items);
  placeMenu(x, y);
}

// ===== Opérations =====
async function createSandbox() {
  const name = await promptModal("Nouvelle sandbox", { placeholder: "Nom de la sandbox" });
  if (!name) return;
  const mb = await promptModal("Taille maximale", { number: true, value: 100, msg: "Limite de la sandbox en mégaoctets (plafond de sécurité)." });
  if (mb === null) return;
  try {
    const meta = await invoke("sandbox_create", { name, maxMb: parseInt(mb, 10) || 100 });
    current = meta; cwd = "";
    await loadSandboxes();
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}
async function createEntry(isDir) {
  if (!current) return;
  const name = await promptModal(isDir ? "Nouveau dossier" : "Nouveau fichier", { placeholder: isDir ? "Nom du dossier" : "nom.txt" });
  if (!name) return;
  const path = cwd ? `${cwd}/${name}` : name;
  try {
    await invoke(isDir ? "sandbox_create_dir" : "sandbox_create_file", { id: current.id, path });
    await refresh();
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}
function bonsaiSlug(prompt) {
  return prompt.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42) || "image";
}
function setBonsaiProgress(done, total, label, active = false) {
  const progress = $("#bonsai-progress");
  const fill = $("#bonsai-progress-fill");
  const bar = fill?.parentElement;
  const text = $("#bonsai-progress-label");
  if (!progress || !fill || !text) return;
  progress.hidden = false;
  bar?.classList.toggle("active", active);
  fill.style.width = `${Math.max(0, Math.min(100, Math.round((done / Math.max(1, total)) * 100)))}%`;
  text.textContent = label;
}
function readBonsaiOptions() {
  const prompt = ($("#bonsai-prompt")?.value || "").trim();
  const [widthRaw, heightRaw] = ($("#bonsai-resolution")?.value || "512x512").split("x");
  const seedRaw = ($("#bonsai-seed")?.value || "").trim();
  const stepsRaw = parseInt($("#bonsai-steps")?.value || "4", 10);
  const batchRaw = parseInt($("#bonsai-batch")?.value || "1", 10);
  return {
    prompt,
    width: parseInt(widthRaw, 10) || 512,
    height: parseInt(heightRaw, 10) || 512,
    seed: seedRaw === "" ? null : Math.max(0, parseInt(seedRaw, 10) || 0),
    steps: Math.max(1, Math.min(64, Number.isFinite(stepsRaw) ? stepsRaw : 4)),
    batch: batchRaw === 4 ? 4 : 1,
    backend: $("#bonsai-backend")?.value || null,
  };
}
// Peuple « Modèle » et « Résolution » de la modale selon le moteur d'image
// courant. Pour Ollama/OpenAI le sélecteur porte des modèles : le choix est
// mémorisé là où `imageGenerationConfig()` le relira.
let bonsaiModalOllamaNames = null;
async function fillBonsaiModalChoices() {
  const provider = imageProvider();
  if (provider === "bonsai") await ensureBonsaiKind(invoke);
  const modelSel = $("#bonsai-backend");
  const resSel = $("#bonsai-resolution");
  if (modelSel) {
    if (provider === "ollama" && bonsaiModalOllamaNames === null) {
      bonsaiModalOllamaNames = await listOllamaImageModels(invoke);
    }
    const models = imageModelsFor(provider, bonsaiModalOllamaNames || []);
    const current = imageModel(provider);
    modelSel.innerHTML = "";
    for (const m of models) {
      // Bonsai : la valeur envoyée est l'identifiant de backend complet.
      const value = provider === "bonsai" ? bonsaiBackendId(m.id) : m.id;
      modelSel.appendChild(new Option(m.missing ? `${m.label} — à installer` : m.label, value));
    }
    modelSel.value = provider === "bonsai" ? bonsaiBackendId(current) : current;
    modelSel.onchange = () => {
      if (provider === "bonsai") return;   // rien à mémoriser : c'est le backend
      localStorage.setItem(provider === "ollama" ? "imageOllamaModel" : "imageOpenaiModel", modelSel.value);
      fillBonsaiModalChoices();
    };
  }
  if (resSel) {
    const model = provider === "bonsai" ? "" : (modelSel?.value || imageModel(provider));
    const sizes = imageSizesFor(provider, model);
    const wanted = nearestImageSize(provider, model, resSel.value || "");
    resSel.innerHTML = "";
    for (const s of sizes) resSel.appendChild(new Option(s.label, s.value));
    resSel.value = wanted;
  }
}

function setBonsaiBusy(busy) {
  const modal = $("#bonsai-modal");
  if (!modal) return;
  modal.querySelectorAll("textarea, input, select, button").forEach((el) => {
    el.disabled = busy;
  });
}
async function generateBonsaiImage(dir = "") {
  if (!current) return;
  const modal = $("#bonsai-modal");
  const promptEl = $("#bonsai-prompt");
  const generateBtn = $("#bonsai-generate");
  const cancelBtn = $("#bonsai-cancel");
  const randomBtn = $("#bonsai-random-seed");
  if (!modal || !promptEl || !generateBtn || !cancelBtn || !randomBtn) return;
  let closed = false;
  const cleanup = () => {
    closed = true;
    modal.hidden = true;
    setBonsaiBusy(false);
    $("#bonsai-progress").hidden = true;
    $("#bonsai-progress-fill").style.width = "0%";
    $("#bonsai-progress-fill").parentElement?.classList.remove("active");
    generateBtn.removeEventListener("click", run);
    cancelBtn.removeEventListener("click", close);
    randomBtn.removeEventListener("click", randomizeSeed);
    modal.querySelectorAll("#bonsai-chips button").forEach((btn) => btn.removeEventListener("click", useChip));
  };
  const close = () => cleanup();
  const randomizeSeed = () => { $("#bonsai-seed").value = String(Math.floor(Math.random() * 2147483647)); };
  const useChip = (ev) => {
    promptEl.value = ev.currentTarget.textContent.trim();
    promptEl.focus();
  };
  const run = async () => {
    const opts = readBonsaiOptions();
    if (!opts.prompt) {
      toast(tt("Décris l'image à créer…"));
      promptEl.focus();
      return;
    }
    setBonsaiBusy(true);
    setBonsaiProgress(0, opts.batch, tt("Préparation…"), true);
    const imageConfig = imageGenerationConfig();
    toast(imageConfig.provider === "openai" ? "Génération OpenAI en cours…" : tt("Génération Bonsai en cours…"), false);
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const base = bonsaiSlug(opts.prompt);
    const created = [];
    try {
      for (let i = 0; i < opts.batch; i += 1) {
        if (closed) return;
        const suffix = opts.batch > 1 ? `_${String(i + 1).padStart(2, "0")}` : "";
        const rel = `${dir ? dir + "/" : ""}${base}_${stamp}${suffix}.png`;
        setBonsaiProgress(i, opts.batch, tt("Image {n}/{total}…", { n: i + 1, total: opts.batch }), true);
        await invoke("bonsai_generate_to_sandbox", {
          id: current.id,
          prompt: opts.prompt,
          path: rel,
          width: opts.width,
          height: opts.height,
          seed: opts.seed === null ? null : opts.seed + i,
          steps: opts.steps,
          backend: opts.backend || imageConfig.backend,
          provider: imageConfig.provider,
          apiBase: imageConfig.apiBase,
          apiKey: imageConfig.apiKey,
          apiModel: imageConfig.apiModel,
        });
        created.push(rel);
        setBonsaiProgress(i + 1, opts.batch, tt("Image {n}/{total}…", { n: i + 1, total: opts.batch }));
      }
      clearSearch();
      if (dir) cwd = dir;
      await refresh();
      recordImageGeneration(created.length, imageConfig.provider);
      setBonsaiProgress(opts.batch, opts.batch, tt("Terminé"));
      toast(created.length === 1 ? `${tt("Image créée")} : ${created[0]}` : tt("{count} images créées", { count: created.length }), false);
      cleanup();
    } catch (e) {
      setBonsaiBusy(false);
      setBonsaiProgress(0, opts.batch, tt("Échec"));
      $("#bonsai-progress-fill").parentElement?.classList.remove("active");
      toast("Échec génération image : " + imageErrorMessage(e));
    }
  };
  promptEl.value = "";
  // Modèles et résolutions du moteur choisi dans les Réglages : la liste figée
  // du HTML ne valait que pour Bonsai.
  fillBonsaiModalChoices();
  $("#bonsai-seed").value = "42";
  $("#bonsai-steps").value = "4";
  $("#bonsai-batch").value = "1";
  $("#bonsai-progress").hidden = true;
  $("#bonsai-progress-fill").style.width = "0%";
  $("#bonsai-progress-fill").parentElement?.classList.remove("active");
  setBonsaiBusy(false);
  modal.hidden = false;
  promptEl.focus();
  generateBtn.addEventListener("click", run);
  cancelBtn.addEventListener("click", close);
  randomBtn.addEventListener("click", randomizeSeed);
  modal.querySelectorAll("#bonsai-chips button").forEach((btn) => btn.addEventListener("click", useChip));
}
async function renameEntry(en) {
  const name = await promptModal("Renommer", { placeholder: "Nouveau nom", value: en.name });
  if (!name || name === en.name) return;
  try {
    await invoke("sandbox_rename", { id: current.id, path: en.path, newName: name });
    moveFolderColor(en.path, parentJoin(en.path, name));
    await refresh();
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}
async function deleteEntry(en) {
  const ok = await confirmModal(`Supprimer « ${en.name} » ?`, en.is_dir ? "Le dossier et tout son contenu seront supprimés. Action irréversible." : "Le fichier sera supprimé. Action irréversible.");
  if (!ok) return;
  try {
    await invoke("sandbox_delete_path", { id: current.id, path: en.path });
    if (previewPath === en.path) closePreview();
    await refresh();
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}
async function moveInto(srcPath, destDir) {
  try {
    await invoke("sandbox_move_path", { id: current.id, path: srcPath, destDir });
    await refresh();
  } catch (e) {
    toast("Déplacement impossible : " + (e?.message || e));
  }
}

// ===== Presse-papiers de l'explorateur =====
//
// Couper/copier/coller manquait, et avec lui la seule façon simple de remonter
// un fichier d'un cran : le glisser-déposer ne savait aller que VERS le bas,
// dans un sous-dossier visible à l'écran. Le presse-papiers règle les deux
// sens, et traverse les sandboxes — le cloisonnement reste entier côté
// backend, qui résout chaque chemin dans SA racine et vérifie le quota de la
// destination avant d'écrire.
//
// Il ne touche PAS au presse-papiers du système : copier un fichier ici ne
// remplace pas le texte qu'on y avait mis.
let clipboard = null;  // { op: "copy" | "cut", sandboxId, sandboxName, entries: [{path, name, is_dir}] }

/// Ce sur quoi une action porte : la sélection multiple si l'entrée visée en
/// fait partie, l'entrée seule sinon. C'est la règle de tous les explorateurs,
/// et celle à laquelle on s'attend après un Cmd+clic.
function actionTargets(en) {
  if (en && selectedPaths.has(en.path) && selectedPaths.size > 1) {
    return entries.filter((e) => selectedPaths.has(e.path));
  }
  if (en) return [en];
  return entries.filter((e) => selectedPaths.has(e.path));
}

function setClipboard(op, targets) {
  if (!current || !targets.length) return;
  clipboard = {
    op,
    sandboxId: current.id,
    sandboxName: current.name,
    entries: targets.map((e) => ({ path: e.path, name: e.name, is_dir: e.is_dir })),
  };
  const what = targets.length === 1 ? `« ${targets[0].name} »` : tt("{n} éléments", { n: targets.length });
  toast(op === "cut" ? `${what} ${tt("coupé(s).")}` : `${what} ${tt("copié(s).")}`, false);
  refreshClipboardUi();
}

/// Libellé du « Coller » : il dit CE QU'ON COLLE et d'où ça vient. Un menu qui
/// affiche juste « Coller » oblige à se souvenir de ce qu'on a copié il y a
/// trois dossiers de cela.
function pasteLabel() {
  if (!clipboard) return "";
  const n = clipboard.entries.length;
  const what = n === 1 ? `« ${clipboard.entries[0].name} »` : tt("{n} éléments", { n });
  const from = clipboard.sandboxId === current?.id ? "" : ` (${clipboard.sandboxName})`;
  return `${tt("Coller")} ${what}${from}`;
}

function refreshClipboardUi() {
  // Les entrées coupées s'estompent : on voit ce qui va partir.
  const cutPaths = clipboard?.op === "cut" && clipboard.sandboxId === current?.id
    ? new Set(clipboard.entries.map((e) => e.path))
    : new Set();
  $("#files")?.querySelectorAll(".item").forEach((el) => {
    el.classList.toggle("cut", cutPaths.has(el.dataset.path));
  });
}

async function pasteInto(destDir = cwd) {
  if (!clipboard || !current) return;
  const { op, sandboxId, entries: items } = clipboard;
  // Coller au même endroit ce qu'on vient de couper n'a aucun effet utile, et
  // le backend refuserait le renommage sur lui-même.
  if (op === "cut" && sandboxId === current.id) {
    const sameDir = items.every((e) => (e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "") === destDir);
    if (sameDir) { clipboard = null; refreshClipboardUi(); return; }
  }
  const cmd = op === "cut" ? "sandbox_transfer_path" : "sandbox_copy_path";
  let ok = 0;
  const failures = [];
  for (const item of items) {
    try {
      await invoke(cmd, { id: sandboxId, path: item.path, destId: current.id, destDir });
      ok += 1;
    } catch (e) {
      failures.push(`${item.name} : ${e?.message || e}`);
    }
  }
  if (op === "cut" && !failures.length) clipboard = null;
  refreshClipboardUi();
  await refresh();
  if (failures.length) toast(failures[0]);
  else toast(`${ok} ${tt("élément(s) collé(s).")}`, false);
}

/// Déplacement (ou copie) vers une AUTRE sandbox, par la modale de choix.
async function sendToSandbox(targets, op) {
  if (!current || !targets.length) return;
  const others = sandboxes.filter((s) => s.id !== current.id);
  if (!others.length) { toast(tt("Il n'y a pas d'autre sandbox où envoyer ces fichiers.")); return; }
  const what = targets.length === 1 ? `« ${targets[0].name} »` : tt("{n} éléments", { n: targets.length });
  const choice = await sandboxPickModal({
    title: op === "cut" ? tt("Déplacer vers une sandbox") : tt("Copier vers une sandbox"),
    msg: `${what} ${tt("quittera cette sandbox pour celle que vous choisissez.")}`,
    okLabel: op === "cut" ? tt("Déplacer") : tt("Copier"),
    exclude: current.id,
  });
  if (!choice) return;
  const cmd = op === "cut" ? "sandbox_transfer_path" : "sandbox_copy_path";
  const failures = [];
  for (const t of targets) {
    try {
      await invoke(cmd, { id: current.id, path: t.path, destId: choice.id, destDir: choice.dir });
    } catch (e) { failures.push(`${t.name} : ${e?.message || e}`); }
  }
  await refresh();
  if (failures.length) toast(failures[0]);
  else toast(`${what} → ${choice.name}`, false);
}

/// Modale « vers quelle sandbox ? ». Renvoie { id, name, dir } ou null.
function sandboxPickModal({ title, msg, okLabel, exclude = "" }) {
  return new Promise((resolve) => {
    const modal = $("#sbpick-modal");
    const sel = $("#sbpick-select");
    const dir = $("#sbpick-dir");
    $("#sbpick-title").textContent = title;
    $("#sbpick-msg").textContent = msg || "";
    $("#sbpick-ok").textContent = okLabel || tt("Déplacer");
    sel.innerHTML = "";
    for (const s of sandboxes.filter((x) => x.id !== exclude)) {
      sel.appendChild(new Option(s.name, s.id));
    }
    dir.value = "";
    const quota = $("#sbpick-quota");
    const showQuota = async () => {
      quota.textContent = "";
      try {
        const u = await invoke("sandbox_usage", { id: sel.value });
        const free = Math.max(0, (u.max_bytes || 0) - (u.used_bytes || 0));
        quota.textContent = `${tt("Espace disponible")} : ${formatBytes(free)}`;
      } catch { /* quota indisponible : on n'affiche rien plutôt qu'un faux chiffre */ }
    };
    showQuota();
    modal.hidden = false;
    setTimeout(() => sel.focus(), 0);
    const done = (value) => { cleanup(); resolve(value); };
    const onOk = () => {
      const s = sandboxes.find((x) => x.id === sel.value);
      if (!s) return done(null);
      done({ id: s.id, name: s.name, dir: dir.value.trim().replace(/^\/+|\/+$/g, "") });
    };
    const onCancel = () => done(null);
    const onKey = (e) => { if (e.key === "Escape") onCancel(); else if (e.key === "Enter") onOk(); };
    function cleanup() {
      modal.hidden = true;
      $("#sbpick-ok").removeEventListener("click", onOk);
      $("#sbpick-cancel").removeEventListener("click", onCancel);
      sel.removeEventListener("change", showQuota);
      modal.removeEventListener("keydown", onKey);
    }
    $("#sbpick-ok").addEventListener("click", onOk);
    $("#sbpick-cancel").addEventListener("click", onCancel);
    sel.addEventListener("change", showQuota);
    modal.addEventListener("keydown", onKey);
  });
}

function formatBytes(b) {
  const n = Number(b) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " Go";
  if (n >= 1048576) return (n / 1048576).toFixed(0) + " Mo";
  return (n / 1024).toFixed(0) + " Ko";
}

// ===== Suppression d'une sandbox =====
//
// Une sandbox contient parfois des mois de travail, et `sandbox_delete` efface
// son dossier entier sans corbeille. Deux garde-fous, donc : le mot SUPPRIMER
// à taper (on ne supprime pas par inadvertance en cliquant deux fois), et une
// sortie de secours — déplacer le contenu ailleurs plutôt que le perdre.
const DELETE_WORD = { fr: "SUPPRIMER", en: "DELETE" };

async function deleteSandbox(target = current) {
  if (!target) return;
  const others = sandboxes.filter((s) => s.id !== target.id);
  const word = DELETE_WORD[appLang()] || DELETE_WORD.fr;

  let usage = null;
  try { usage = await invoke("sandbox_usage", { id: target.id }); } catch {}
  let count = 0;
  try { count = (await invoke("sandbox_read_dir", { id: target.id, path: "" }))?.length || 0; } catch {}

  const modal = $("#sbdel-modal");
  $("#sbdel-title").textContent = `${tt("Supprimer la sandbox")} « ${target.name} »`;
  $("#sbdel-summary").textContent = count
    ? tt("{n} élément(s) à la racine, {size} occupés. Cette sandbox et ses métadonnées seront retirées de Lumen.",
        { n: count, size: formatBytes(usage?.used_bytes || 0) })
    : tt("Cette sandbox est vide. Elle sera retirée de Lumen.");

  const modeMove = $("#sbdel-mode-move");
  const modeErase = $("#sbdel-mode-erase");
  const targetSel = $("#sbdel-target");
  const targetRow = targetSel.closest(".sbdel-target");
  targetSel.innerHTML = "";
  for (const s of others) targetSel.appendChild(new Option(s.name, s.id));
  // Sans autre sandbox où aller, l'option de déplacement n'existe pas : la
  // proposer pour la griser ensuite ne ferait qu'ajouter une question morte.
  modeMove.disabled = !others.length || !count;
  modeMove.closest(".sbdel-choice").hidden = modeMove.disabled;
  modeErase.checked = true;

  const word$ = $("#sbdel-word");
  word$.value = "";
  word$.placeholder = word;
  $("#sbdel-word-label").textContent = tt("Tapez {word} pour confirmer", { word });
  const status = $("#sbdel-status");
  status.textContent = ""; status.className = "modal-hint";
  const okBtn = $("#sbdel-ok");
  okBtn.disabled = true;

  const syncMode = () => { targetRow.hidden = !modeMove.checked; };
  const syncWord = () => { okBtn.disabled = word$.value.trim().toUpperCase() !== word; };
  syncMode(); syncWord();

  modal.hidden = false;
  setTimeout(() => word$.focus(), 0);

  const cleanup = () => {
    modal.hidden = true;
    okBtn.removeEventListener("click", onOk);
    $("#sbdel-cancel").removeEventListener("click", onCancel);
    word$.removeEventListener("input", syncWord);
    modeMove.removeEventListener("change", syncMode);
    modeErase.removeEventListener("change", syncMode);
    modal.removeEventListener("keydown", onKey);
  };
  const onCancel = () => cleanup();
  const onKey = (e) => { if (e.key === "Escape") onCancel(); };
  const onOk = async () => {
    okBtn.disabled = true;
    status.className = "modal-hint";
    try {
      if (modeMove.checked) {
        status.textContent = tt("Déplacement du contenu…");
        const moved = await invoke("sandbox_move_all", {
          id: target.id, destId: targetSel.value, destDir: target.name,
        });
        status.textContent = tt("{n} élément(s) déplacé(s).", { n: moved });
      }
      await invoke("sandbox_delete", { id: target.id });
      cleanup();
      if (current?.id === target.id) current = null;
      await loadSandboxes({ autoEnterDesktop: false });
      toast(`${tt("Sandbox supprimée")} : ${target.name}`, false);
    } catch (e) {
      status.textContent = String(e?.message || e);
      status.className = "modal-hint err";
      okBtn.disabled = false;
    }
  };

  okBtn.addEventListener("click", onOk);
  $("#sbdel-cancel").addEventListener("click", onCancel);
  word$.addEventListener("input", syncWord);
  modeMove.addEventListener("change", syncMode);
  modeErase.addEventListener("change", syncMode);
  modal.addEventListener("keydown", onKey);
}

// ===== Import / Export =====
// Lit chaque fichier choisi en base64 et l'écrit dans la sandbox (quota vérifié).
async function onUploadFiles(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = ""; // permet de re-sélectionner le même fichier
  if (!current || !files.length) return;
  let ok = 0;
  for (const f of files) {
    try {
      const b64 = await fileToBase64(f);
      const path = cwd ? `${cwd}/${f.name}` : f.name;
      await invoke("sandbox_import_file", { id: current.id, path, dataB64: b64 });
      ok++;
    } catch (err) {
      toast(`« ${f.name} » : ` + (err?.message || err));
    }
  }
  if (ok) toast(`${ok} fichier(s) importé(s).`, false);
  await refresh();
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result || "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res); // retire le préfixe data:...;base64,
    };
    r.onerror = () => reject(new Error("lecture impossible"));
    r.readAsDataURL(file);
  });
}
// Exporte un fichier vers le dossier Téléchargements de l'hôte.
async function downloadEntry(en) {
  if (!current || en.is_dir) return;
  try {
    const dest = await invoke("sandbox_export_file", { id: current.id, path: en.path });
    toast(`Exporté vers ${dest}`, false);
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}

// Génère un PDF (dans la sandbox, à côté de la source) depuis un .md, .txt, .csv…
async function exportPdf(en) {
  if (!current || en.is_dir) return;
  toast("Génération du PDF…", false);
  try {
    const rel = await invoke("sandbox_export_pdf", { id: current.id, path: en.path });
    await refresh();
    toast(`PDF créé : ${rel}`, false);
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}

// ===== Taille de la sandbox =====
async function resizeSandbox() {
  if (!current) return;
  const currentMb = Math.round((current.max_bytes || 0) / (1024 * 1024));
  const mb = await promptModal("Taille maximale", {
    number: true,
    value: currentMb || 100,
    msg: "Nouvelle limite de la sandbox en mégaoctets. Doit couvrir l'occupation actuelle.",
  });
  if (mb === null) return;
  try {
    const meta = await invoke("sandbox_set_size", { id: current.id, maxMb: parseInt(mb, 10) || 1 });
    current = meta;
    sandboxes = sandboxes.map((s) => (s.id === meta.id ? meta : s));
    await refresh();
    toast("Taille mise à jour.", false);
  } catch (e) { toast("Échec : " + (e?.message || e)); }
}

// ===== Jauge d'occupation =====
async function updateUsage() {
  const fill = $("#usage-fill"), label = $("#usage-label");
  if (!current) { fill.style.width = "0%"; label.textContent = "—"; return; }
  try {
    const u = await invoke("sandbox_usage", { id: current.id });
    const pct = u.max_bytes ? Math.min(100, (u.used_bytes / u.max_bytes) * 100) : 0;
    fill.style.width = pct + "%";
    fill.style.background = pct > 90 ? "#ff3b30" : "var(--accent)";
    label.textContent = `${formatSize(u.used_bytes)} / ${formatSize(u.max_bytes)}`;
  } catch (e) { label.textContent = "—"; }
}

// ===== Personnalisation =====
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function custKey() { return wsKey("sbCustomize"); }
function getCust() { try { return JSON.parse(localStorage.getItem(custKey())) || {}; } catch { return {}; } }
function setCust(c) { localStorage.setItem(custKey(), JSON.stringify(c)); applyCustomization(); }
function applyCustomization() {
  const c = getCust();
  const root = document.documentElement;
  if (c.theme && c.theme !== "auto") root.setAttribute("data-theme", c.theme); else root.removeAttribute("data-theme");
  if (c.bg) root.style.setProperty("--bg", c.bg); else root.style.removeProperty("--bg");
  if (c.accent) root.style.setProperty("--accent", c.accent); else root.style.removeProperty("--accent");
  if (c.folder) root.style.setProperty("--folder", c.folder); else root.style.removeProperty("--folder");
}
function openCustomize() {
  const c = getCust();
  $("#cust-bg").value = c.bg || currentColor("--bg", "#f2f2f7");
  $("#cust-accent").value = c.accent || currentColor("--accent", "#0a84ff");
  $("#cust-folder").value = c.folder || currentColor("--folder", "#54a0ff");
  $("#cust-theme").value = c.theme || "auto";
  $("#customize").hidden = false;
}
// Valeur courante d'une variable CSS en hex valide pour <input type="color">.
function currentColor(varName, fallback) {
  const v = cssVar(varName);
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  return rgbToHex(v) || fallback;
}
// Couleurs de dossier, par sandbox, persistées localement.
function folderColorsKey() { return wsKey(`sbFolders:${current ? current.id : ""}`); }
function folderColors() { try { return JSON.parse(localStorage.getItem(folderColorsKey())) || {}; } catch { return {}; } }
function setFolderColor(path, color) {
  const m = folderColors(); m[path] = color; localStorage.setItem(folderColorsKey(), JSON.stringify(m)); renderFiles();
}
function moveFolderColor(oldPath, newPath) {
  const m = folderColors(); if (m[oldPath]) { m[newPath] = m[oldPath]; delete m[oldPath]; localStorage.setItem(folderColorsKey(), JSON.stringify(m)); }
}

// ===== Modales =====
function wireModals() {
  // Personnalisation
  $("#cust-bg").addEventListener("input", (e) => setCust({ ...getCust(), bg: e.target.value }));
  $("#cust-accent").addEventListener("input", (e) => setCust({ ...getCust(), accent: e.target.value }));
  $("#cust-folder").addEventListener("input", (e) => { setCust({ ...getCust(), folder: e.target.value }); renderFiles(); });
  $("#cust-theme").addEventListener("change", (e) => setCust({ ...getCust(), theme: e.target.value }));
  $("#cust-reset").addEventListener("click", () => { localStorage.removeItem(custKey()); applyCustomization(); openCustomize(); renderFiles(); });
  $("#cust-close").addEventListener("click", () => { $("#customize").hidden = true; });
  $("#customize").addEventListener("click", (e) => { if (e.target.id === "customize") $("#customize").hidden = true; });
}

// Modale générique de saisie. Renvoie la valeur (string) ou null si annulé.
function promptModal(title, { placeholder = "", value = "", number = false, msg = "" } = {}) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    $("#modal-title").textContent = title;
    const msgEl = $("#modal-msg"); msgEl.hidden = !msg; msgEl.textContent = msg;
    const text = $("#modal-input"), num = $("#modal-number");
    text.hidden = number; num.hidden = !number;
    const field = number ? num : text;
    field.value = value; modal.hidden = false; setTimeout(() => field.focus(), 0);
    const done = (val) => { cleanup(); resolve(val); };
    const onOk = () => done(field.value.trim() === "" ? null : field.value.trim());
    const onCancel = () => done(null);
    const onKey = (e) => { if (e.key === "Enter") onOk(); else if (e.key === "Escape") onCancel(); };
    function cleanup() {
      modal.hidden = true;
      $("#modal-ok").removeEventListener("click", onOk);
      $("#modal-cancel").removeEventListener("click", onCancel);
      field.removeEventListener("keydown", onKey);
    }
    $("#modal-ok").addEventListener("click", onOk);
    $("#modal-cancel").addEventListener("click", onCancel);
    field.addEventListener("keydown", onKey);
  });
}
// Modale de confirmation. Renvoie un booléen.
function confirmModal(title, msg) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    $("#modal-title").textContent = title;
    const msgEl = $("#modal-msg"); msgEl.hidden = false; msgEl.textContent = msg;
    $("#modal-input").hidden = true; $("#modal-number").hidden = true;
    modal.hidden = false;
    const done = (v) => { cleanup(); resolve(v); };
    const onOk = () => done(true), onCancel = () => done(false);
    function cleanup() {
      modal.hidden = true;
      $("#modal-ok").removeEventListener("click", onOk);
      $("#modal-cancel").removeEventListener("click", onCancel);
    }
    $("#modal-ok").addEventListener("click", onOk);
    $("#modal-cancel").addEventListener("click", onCancel);
  });
}

// ===== Util =====
function parentJoin(path, name) { const p = path.split("/"); p.pop(); p.push(name); return p.join("/"); }
function escapeHtml(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
// Dates de fichier : court pour la colonne (aujourd'hui = heure, cette année =
// jour + mois, sinon année), complet en infobulle.
function formatDate(secs) {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString([], { day: "2-digit", month: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" });
}
function formatDateFull(secs) {
  if (!secs) return "";
  return new Date(secs * 1000).toLocaleString([], {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function formatSize(b) {
  if (b < 1024) return `${b} o`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} Ko`;
  return `${(b / (1024 * 1024)).toFixed(1)} Mo`;
}
function rgbToHex(rgb) {
  // Ne traite que les formes rgb()/rgba() ; un hex en entrée n'est PAS du RGB.
  if (!/^rgba?\(/i.test((rgb || "").trim())) return null;
  const m = rgb.match(/\d+/g); if (!m || m.length < 3) return null;
  return "#" + m.slice(0, 3).map((n) => parseInt(n).toString(16).padStart(2, "0")).join("");
}

// Toast in-app (alert() est inopérant dans WKWebView Tauri).
function toast(msg, isError = true) {
  let host = document.querySelector("#toast");
  if (!host) { host = document.createElement("div"); host.id = "toast"; document.body.appendChild(host); }
  host.textContent = msg;
  host.className = "show" + (isError ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { host.className = ""; }, 4000);
}

// ===== Lancement (fin de module : tout est initialisé) =====
// Ce module a des `await` top-level : sous WKWebView, DOMContentLoaded peut
// partir PENDANT ces await — un simple addEventListener posé trop tard ne se
// déclencherait jamais (page morte : ni liste, ni login). On teste readyState.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => { initExplorer(); });
} else {
  initExplorer();
}
