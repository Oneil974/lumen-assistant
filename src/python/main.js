// Python — éditeur + interpréteur cloisonné.
//
// La coque (arborescence, éditeur Monokai, modales) reprend celle de
// l'Éditeur de code. L'interpréteur est piloté par runtime.js : un worker
// Pyodide qui ne voit que /project, rempli depuis la sandbox avant chaque
// exécution (`collectProject`) et relu après (`writeBack`). Rien ici ne
// touche au disque hors de la sandbox — c'est ce qui rend l'app inoffensive.

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};

import { translatePage, tt, observeTranslations } from "../apps-i18n.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { llmChat } from "../llm.js";
import { streamTarget } from "../lib/stream-view.js";
import { diffLines } from "../sandbox/diff.js";
import { highlight } from "../editor/highlight.js";
import { PROMPTS } from "./prompts.js";
import { PythonRuntime } from "./runtime.js";
import { replyLang } from "../lib/prompt-lang.js";

let sandboxId = null;
let openPath = null;
let original = "";
let truncated = false;
let activeDir = "";
const expandedDirs = new Set();
let running = false;

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Fichiers recopiés dans /project avant l'exécution : texte tel quel, le reste
// en base64. Bornes volontaires — une sandbox peut contenir des vidéos.
const TEXT_EXT = new Set(["py", "txt", "md", "csv", "tsv", "json", "yaml", "yml", "toml", "ini", "cfg", "xml", "html", "htm", "css", "js", "svg", "sql", "log", "rst", "tex"]);
const SKIP_DIRS = new Set(["__pycache__", "node_modules", ".git", ".venv", "venv"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

const DEFAULT_SCRIPT = `# Bienvenue dans Python de Lumen.
# Ce script tourne dans un interpréteur isolé : seuls les fichiers de la
# sandbox lui sont visibles. ⌘↩ pour exécuter.

import math

def carre(x):
    return x * x

for i in range(1, 6):
    print(f"{i}² = {carre(i)}   √{i} = {math.sqrt(i):.3f}")
`;

// ===== Icônes SVG (mêmes tracés que l'Éditeur de code) =====
const IC = {
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 14l.7 1.8 1.8.7-1.8.7L18 19l-.7-1.8-1.8-.7 1.8-.7z"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
  folderPlus: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.7 1.8H19.5A1.5 1.5 0 0 1 21 9.3v8.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 11v5M9.5 13.5h5"/>',
  filePlus: '<path d="M14 3v5h5"/><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M12 12v4M10 14h4"/>',
  upload: '<path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4"/><path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4"/><polyline points="21 3 21 7 17 7"/><polyline points="3 21 3 17 7 17"/>',
  file: '<path d="M14 3v5h5"/><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  package: '<path d="M16.5 9.4 7.5 4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
};
function svg(inner, w = 16) { return `<svg class="mi" width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`; }
const icon = (name, w) => svg(IC[name] || "", w);

const ta = $("code");
const hl = $("highlight").querySelector("code");
const gutter = $("gutter");
const out = $("console-out");

// ===== Interpréteur =====
const py = new PythonRuntime({
  onStatus: ({ state, version, detail }) => {
    const el = $("py-status");
    el.dataset.state = running ? "running" : state;
    const lbl = el.querySelector(".lbl");
    if (running) lbl.textContent = tt("Exécution…");
    else if (state === "ready") lbl.textContent = "Python " + (version || "") + " · " + tt("prêt");
    else if (state === "loading") lbl.textContent = tt("Chargement de l'interpréteur…");
    else if (state === "error") lbl.textContent = tt("Interpréteur en erreur") + (detail ? " — " + detail : "");
    else lbl.textContent = tt("Interpréteur arrêté");
    $("btn-stop").hidden = !running;
    $("btn-run").disabled = running;
  },
  onOutput: ({ kind, text }) => appendLine(text, text.startsWith("[paquets]") ? "c-files" : kind === "stderr" ? "c-stderr" : ""),
});

// ===== Démarrage =====
async function init() {
  translatePage();
  observeTranslations();
  decorateIcons();
  if (matchMedia("(prefers-color-scheme: dark)").matches) document.body.classList.add("mk-dark");
  ta.value = DEFAULT_SCRIPT;
  refresh();
  await loadSandboxes();
  bind();
  registerIntents();
  // On chauffe l'interpréteur tout de suite : 2 à 4 s qu'on ne fait pas
  // attendre au premier ⌘↩.
  py.start().catch((e) => appendLine(tt("Impossible de démarrer Python : ") + (e.message || e) + "\n", "c-error"));
}

function decorateIcons() {
  const set = {
    "btn-ai": "sparkles", "btn-packages": "package", "btn-theme": "theme", "btn-save": "save", "btn-run": "play", "btn-stop": "stop",
    "btn-new-file": "filePlus", "btn-new-folder": "folderPlus", "btn-import": "upload", "btn-refresh-tree": "refresh",
    "btn-stdin": "keyboard", "btn-restart": "power", "btn-clear": "eraser",
  };
  for (const [id, name] of Object.entries(set)) $(id)?.insertAdjacentHTML("afterbegin", icon(name));
  document.querySelectorAll("#ctx-menu button[data-ic]").forEach((b) => { b.innerHTML = icon(b.dataset.ic) + `<span>${b.textContent}</span>`; });
}

async function loadSandboxes() {
  let boxes = [];
  try { if (invoke) boxes = await invoke("sandbox_list"); } catch {}
  const sel = $("sandbox-select");
  sel.innerHTML = "";
  for (const b of boxes) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.name || b.id; sel.appendChild(o); }
  if (boxes.length) {
    const remembered = localStorage.getItem("pySandbox");
    sandboxId = boxes.some((b) => b.id === remembered) ? remembered : boxes[0].id;
    sel.value = sandboxId;
    await loadTree();
    await openLastOrFirst();
  } else {
    sel.hidden = true;
    $("open-path").textContent = tt("brouillon (aucune sandbox)");
  }
}

// Rouvre le dernier script, sinon le premier .py à la racine.
async function openLastOrFirst() {
  const last = localStorage.getItem("pyLast:" + sandboxId);
  if (last) { try { await openFile(last); return; } catch {} }
  let entries = [];
  try { entries = await invoke("sandbox_read_dir", { id: sandboxId, path: "" }); } catch {}
  const first = entries.find((e) => !e.is_dir && /\.py$/i.test(e.name));
  if (first) await openFile(first.path);
}

// ===== Arborescence =====
async function loadTree() {
  const root = $("files");
  root.textContent = "";
  await renderDir("", root, 0);
}
async function renderDir(path, container, depth) {
  let entries = [];
  try { entries = await invoke("sandbox_read_dir", { id: sandboxId, path }); } catch { return; }
  for (const e of entries) {
    const item = document.createElement("div");
    item.className = "file-item" + (e.is_dir ? " dir" : "") + (/\.py$/i.test(e.name) ? " py" : "");
    item.style.paddingLeft = 8 + depth * 12 + "px";
    item.dataset.path = e.path;
    if (openPath === e.path) item.classList.add("active");
    if (activeDir === e.path) item.classList.add("dir-active");
    item.addEventListener("contextmenu", (ev) => { ev.preventDefault(); openTreeMenu(ev, e); });
    if (e.is_dir) {
      const open = expandedDirs.has(e.path);
      item.textContent = (open ? "▾ " : "▸ ") + e.name;
      const kids = document.createElement("div");
      container.appendChild(item); container.appendChild(kids);
      item.addEventListener("click", async () => {
        const nowOpen = !expandedDirs.has(e.path);
        if (nowOpen) { expandedDirs.add(e.path); if (!kids.childElementCount) await renderDir(e.path, kids, depth + 1); }
        else expandedDirs.delete(e.path);
        item.textContent = (nowOpen ? "▾ " : "▸ ") + e.name;
        kids.hidden = !nowOpen;
        setActiveDir(e.path);
      });
      if (open) { await renderDir(e.path, kids, depth + 1); kids.hidden = false; }
      else kids.hidden = true;
    } else {
      item.textContent = e.name;
      item.addEventListener("click", () => openFile(e.path, item));
      container.appendChild(item);
    }
  }
}
function setActiveDir(path) {
  activeDir = path || "";
  document.querySelectorAll(".file-item.dir-active").forEach((x) => x.classList.remove("dir-active"));
  if (path) document.querySelector(`.file-item.dir[data-path="${cssEsc(path)}"]`)?.classList.add("dir-active");
}
function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

// ===== Ouverture / édition =====
async function openFile(path, item) {
  if (isDirty() && !(await confirmModal(tt("Abandonner les modifications non enregistrées ?")))) return;
  const fc = await invoke("sandbox_read_file", { id: sandboxId, path });
  if (fc.binary) { toast(tt("Fichier binaire non éditable.")); return; }
  truncated = !!fc.truncated;
  openPath = path; original = fc.content;
  ta.value = fc.content; ta.readOnly = truncated;
  $("open-path").textContent = path + (truncated ? " " + tt("(tronqué — lecture seule)") : "");
  const el = item || document.querySelector(`.file-item[data-path="${cssEsc(path)}"]`);
  document.querySelectorAll(".file-item").forEach((x) => x.classList.toggle("active", x === el));
  setActiveDir(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  localStorage.setItem("pyLast:" + sandboxId, path);
  refresh(); markDirty();
}
function refresh() {
  hl.innerHTML = highlight(ta.value, "python") + "\n";
  const lines = ta.value.split("\n").length;
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  const longest = ta.value.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  ta.style.width = Math.max(ta.parentElement.clientWidth, longest * 7.6 + 40) + "px";
  syncScroll();
}
function syncScroll() {
  $("highlight").style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
}
function isDirty() { return openPath ? ta.value !== original : false; }
function markDirty() { $("dirty").hidden = !isDirty(); }

async function save() {
  if (!sandboxId) { toast(tt("Aucune sandbox : le brouillon reste en mémoire.")); return; }
  if (!openPath) {
    const name = await promptModal(tt("Enregistrer sous"), "main.py", "main.py");
    if (!name) return;
    openPath = (activeDir ? activeDir + "/" : "") + name.split("/").pop().trim();
  }
  if (truncated) { toast(tt("Fichier tronqué : enregistrement bloqué pour éviter une perte de données.")); return; }
  try {
    await invoke("sandbox_write_file", { id: sandboxId, path: openPath, content: ta.value });
    original = ta.value; markDirty();
    $("open-path").textContent = openPath;
    localStorage.setItem("pyLast:" + sandboxId, openPath);
    toast(tt("Enregistré."));
    await loadTree();
  } catch (e) { toast(tt("Échec : ") + (e.message || e)); }
}

// ===== Projet ↔ /project =====
// Lit la sandbox entière (bornée) pour la donner au script. Le fichier ouvert
// est pris depuis l'éditeur, non sauvegardé : on exécute ce qu'on voit.
async function collectProject() {
  const files = {};
  if (!sandboxId) return files;
  let count = 0, total = 0, skipped = 0;
  const walk = async (dir) => {
    let entries = [];
    try { entries = await invoke("sandbox_read_dir", { id: sandboxId, path: dir }); } catch { return; }
    for (const e of entries) {
      if (count >= MAX_FILES || total >= MAX_TOTAL_BYTES) { skipped++; continue; }
      if (e.is_dir) { if (!SKIP_DIRS.has(e.name)) await walk(e.path); continue; }
      if (e.path === openPath) { files[e.path] = { text: ta.value }; count++; total += ta.value.length; continue; }
      if ((e.size || 0) > MAX_FILE_BYTES) { skipped++; continue; }
      const ext = (e.name.split(".").pop() || "").toLowerCase();
      try {
        if (TEXT_EXT.has(ext)) {
          const fc = await invoke("sandbox_read_file", { id: sandboxId, path: e.path });
          if (fc.binary || fc.truncated) files[e.path] = { b64: await invoke("sandbox_read_b64", { id: sandboxId, path: e.path }) };
          else files[e.path] = { text: fc.content };
        } else {
          files[e.path] = { b64: await invoke("sandbox_read_b64", { id: sandboxId, path: e.path }) };
        }
        count++; total += e.size || 0;
      } catch { skipped++; }
    }
  };
  await walk("");
  if (openPath && !files[openPath]) files[openPath] = { text: ta.value };
  if (skipped) appendLine(tt("{n} fichier(s) non transmis au script (trop volumineux ou hors limite).", { n: skipped }) + "\n", "c-files");
  return files;
}

// Réécrit dans la sandbox ce que le script a créé ou modifié.
async function writeBack(files) {
  const names = Object.keys(files || {});
  if (!names.length || !sandboxId) return;
  let n = 0;
  for (const rel of names) {
    const f = files[rel];
    try {
      if (typeof f.text === "string") await invoke("sandbox_write_file", { id: sandboxId, path: rel, content: f.text });
      else if (f.b64) await invoke("sandbox_import_file", { id: sandboxId, path: rel, dataB64: f.b64 });
      n++;
      if (rel === openPath && !isDirty()) { original = f.text; ta.value = f.text; refresh(); }
    } catch (e) { appendLine(tt("Écriture refusée pour {file} : {err}", { file: rel, err: e.message || e }) + "\n", "c-stderr"); }
  }
  if (n) { appendLine(tt("{n} fichier(s) écrit(s) dans la sandbox : {list}", { n, list: names.join(", ") }) + "\n", "c-files"); await loadTree(); }
}

// ===== Exécution =====
async function run(codeOverride) {
  if (running) return;
  const code = codeOverride != null ? codeOverride : ta.value;
  if (!code.trim()) return;
  running = true;
  py.setState(py.state);
  $("console-hint")?.remove();
  appendLine(tt("Exécution de {file}", { file: openPath || tt("brouillon") }) + "\n", "c-meta");
  const files = await collectProject();
  const res = await py.run(code, { files, stdin: $("stdin").value, file: openPath || "main.py", fresh: true });
  running = false;
  py.setState(py.state);
  finish(res);
  await writeBack(res.files);
  return res;
}

function finish(res) {
  if (res.interrupted) { appendLine(res.error + "\n", "c-meta ko"); return; }
  if (res.result != null) appendLine(res.result + "\n", "c-result");
  for (const b64 of res.figures || []) {
    const img = document.createElement("img");
    img.className = "c-figure"; img.src = "data:image/png;base64," + b64;
    out.appendChild(img);
  }
  if (!res.ok) {
    appendLine(res.error + "\n", "c-error");
    // Chemin Windows dans un script POSIX : `'CSV\\fichier.csv'` — en plus
    // d'utiliser le mauvais séparateur, `\r`, `\n` ou `\t` y deviennent des
    // caractères de contrôle. C'est l'erreur la plus fréquente derrière un
    // « fichier introuvable » alors que le fichier est bien dans la sandbox.
    if (/FileNotFoundError|No such file/.test(res.error) && /['"][^'"\n]*\\[^'"\n]*['"]/.test(ta.value)) {
      appendLine(tt("Astuce : les chemins s'écrivent avec des « / » (ex. CSV/fichier.csv), pas des « \\ » — le script tourne dans un système de fichiers POSIX, à la racine de la sandbox.") + "\n", "c-files");
    }
    offerFix(res.error);
  }
  appendLine((res.ok ? tt("Terminé") : tt("Échec")) + " · " + fmtMs(res.ms) + "\n", "c-meta " + (res.ok ? "ok" : "ko"));
  $("console-meta").textContent = fmtMs(res.ms);
  out.scrollTop = out.scrollHeight;
}
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + " s" : ms + " ms");

function stop() {
  if (!running) return;
  py.stop(tt("Interrompu."));
  running = false;
  py.start().catch(() => {});
}

async function repl(line) {
  if (!line.trim()) return;
  $("console-hint")?.remove();
  appendLine(line + "\n", "c-echo");
  const res = await py.repl(line);
  if (res.result != null) appendLine(res.result + "\n", "c-result");
  for (const b64 of res.figures || []) { const img = document.createElement("img"); img.className = "c-figure"; img.src = "data:image/png;base64," + b64; out.appendChild(img); }
  if (!res.ok) appendLine(res.error + "\n", "c-error");
  out.scrollTop = out.scrollHeight;
}

function appendLine(text, cls = "") {
  const d = document.createElement("div");
  d.className = "c-line " + cls;
  d.textContent = text.replace(/\n$/, "");
  out.appendChild(d);
  out.scrollTop = out.scrollHeight;
}

// ===== IA =====
let pendingSel = null;
let aiMode = "write";

function offerFix(error) {
  const wrap = document.createElement("div");
  wrap.className = "c-fix";
  const b = document.createElement("button");
  b.className = "btn-soft ic-btn"; b.innerHTML = icon("sparkles") + `<span>${escapeHtml(tt("Corriger avec l'IA"))}</span>`;
  b.addEventListener("click", () => aiFix(error));
  wrap.appendChild(b); out.appendChild(wrap);
}

function openAi(mode) {
  aiMode = mode;
  pendingSel = mode === "modify" ? selection() : null;
  if (mode === "modify" && !pendingSel.text.trim()) { toast(tt("Sélectionnez d'abord du code.")); return; }
  $("ai-title").textContent = mode === "modify" ? tt("Modifier la sélection avec l'IA") : tt("Écrire avec l'IA");
  $("ai-sel").hidden = mode !== "modify";
  if (pendingSel) $("ai-sel").textContent = pendingSel.text;
  $("ai-instr").value = ""; $("ai-state").textContent = "";
  $("ai-overlay").hidden = false; $("ai-instr").focus();
}

async function runAi() {
  const instr = $("ai-instr").value.trim();
  if (!instr) { toast(tt("Décrivez ce que vous voulez.")); return; }
  $("ai-state").textContent = tt("Génération…");
  try {
    const { messages } = aiMode === "modify"
      ? PROMPTS["app.python.modify"].build({ instruction: instr, code: pendingSel.text })
      : PROMPTS["app.python.write"].build({ request: instr, script: ta.value.trim() ? ta.value : "" });
    const { content, data } = await llmChat(messages, {
      rawSystem: true,
      onDelta: (txt) => { $("ai-state").textContent = `${tt("Génération…")} ${txt.split("\n").length} ${tt("ligne(s)")}`; },
    });
    recordOllamaUsage(data, "python");
    $("ai-overlay").hidden = true;
    const proposed = stripFences(content);
    if (aiMode === "modify") review(pendingSel.text, proposed, (p) => { ta.value = ta.value.slice(0, pendingSel.start) + p + ta.value.slice(pendingSel.end); });
    else review(ta.value, proposed, (p) => { ta.value = p; });
  } catch (e) { $("ai-state").textContent = ""; toast(tt("Échec IA : ") + (e.message || e)); }
}

async function aiFix(error) {
  toast(tt("Analyse de l'erreur…"));
  try {
    const { content, data } = await llmChat(PROMPTS["app.python.fix"].build({ script: ta.value, error }).messages, { rawSystem: true });
    recordOllamaUsage(data, "python");
    review(ta.value, stripFences(content), (p) => { ta.value = p; });
  } catch (e) { toast(tt("Échec IA : ") + (e.message || e)); }
}

async function aiExplain() {
  const sel = selection();
  if (!sel.text.trim()) { toast(tt("Sélectionnez d'abord du code.")); return; }
  const live = showInfo(tt("Explication"), "", { live: true });
  try {
    const { content, data } = await llmChat(PROMPTS["app.python.explain"].build({ code: sel.text, lang: replyLang() }).messages, { rawSystem: true, onUpdate: live.onUpdate });
    recordOllamaUsage(data, "python");
    live.done(escText(content.trim()));
  } catch (e) { toast(tt("Échec IA : ") + (e.message || e)); }
}

function stripFences(s) { return s.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "").trim(); }

function review(oldText, proposed, apply) {
  const c = $("review-diff");
  c.textContent = "";
  for (const b of diffLines(oldText, proposed)) {
    if (b.type === "eq") for (const l of b.lines.slice(0, 200)) c.appendChild(diffLine(" ", l, ""));
    else { for (const l of b.del) c.appendChild(diffLine("-", l, "del")); for (const l of b.ins) c.appendChild(diffLine("+", l, "add")); }
  }
  $("review-overlay").hidden = false;
  $("review-accept").onclick = () => { apply(proposed); $("review-overlay").hidden = true; refresh(); markDirty(); toast(tt("Modification appliquée.")); };
  $("review-reject").onclick = () => ($("review-overlay").hidden = true);
}
function diffLine(sign, text, cls) {
  const d = document.createElement("div");
  d.className = "diff-line " + cls;
  const s = document.createElement("span"); s.className = "sign"; s.textContent = sign;
  d.appendChild(s); d.appendChild(document.createTextNode(text));
  return d;
}
function selection() { return { start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) }; }
function showCtx(x, y) {
  const m = $("ctx-menu"); m.hidden = false; m.style.left = "0px"; m.style.top = "0px";
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
}
const escText = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// `live` : la fenêtre s'ouvre vide et renvoie une cible de flux (streamTarget).
function showInfo(title, text, { live = false } = {}) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="mini-modal"><h3></h3><div class="info-body" style="white-space:pre-wrap;line-height:1.5;max-height:50vh;overflow:auto"></div><div class="mini-actions"><span class="spacer"></span><button class="btn-soft primary">Fermer</button></div></div>`;
  ov.querySelector("h3").textContent = title; ov.querySelector(".info-body").textContent = text;
  ov.querySelector("button").addEventListener("click", () => ov.remove());
  document.body.appendChild(ov);
  if (live) {
    const body = ov.querySelector(".info-body");
    body.textContent = "…";
    return streamTarget(body, escText, { onRender: () => { body.scrollTop = body.scrollHeight; } });
  }
}

// ===== Paquets =====
async function installPackages() {
  const names = $("pkg-input").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;
  $("pkg-state").textContent = tt("Installation…");
  $("console-hint")?.remove();
  const res = await py.install(names);
  $("pkg-state").textContent = "";
  if (res.ok) { toast(tt("Paquet(s) installé(s).")); $("pkg-overlay").hidden = true; $("pkg-input").value = ""; }
  else appendLine(res.error + "\n", "c-error");
}

// ===== App Intents (l'assistant exécute du Python, app ouverte ou non) =====
function registerIntents() {
  const api = window.lumen?.intents;
  if (!api) return;
  api.on("run_python", async ({ code, stdin }) => {
    if (!code) throw new Error("code manquant");
    const marker = out.childElementCount;
    if (stdin) $("stdin").value = String(stdin);
    ta.value = String(code); refresh(); markDirty();
    const res = await run(String(code));
    const lines = Array.from(out.children).slice(marker)
      .filter((n) => n.classList.contains("c-line") && !n.classList.contains("c-meta") && !n.classList.contains("c-files"))
      .map((n) => n.textContent).join("\n");
    const figs = (res.figures || []).length;
    return (res.ok ? "OK" : "Erreur") + ` (${fmtMs(res.ms)})` + (lines ? "\n" + lines.slice(0, 6000) : "") +
      (figs ? `\n[${figs} figure(s) affichée(s) dans l'app Python]` : "") +
      (Object.keys(res.files || {}).length ? `\n[fichiers écrits : ${Object.keys(res.files).join(", ")}]` : "");
  }).catch(() => {});
}

// ===== Gestion de fichiers =====
async function newEntry(isDir) {
  if (!sandboxId) { toast(tt("Sélectionnez d'abord une sandbox.")); return; }
  const name = await promptModal(isDir ? tt("Nouveau dossier") : tt("Nouveau fichier"), isDir ? "data" : "script.py");
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
  } catch (e) { toast(tt("Échec : ") + (e.message || e)); }
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
      const path = activeDir ? `${activeDir}/${f.name}` : f.name;
      await invoke("sandbox_import_file", { id: sandboxId, path, dataB64: await fileToBase64(f) });
      ok++;
    } catch (e) { toast(`« ${f.name} » : ` + (e?.message || e)); }
  }
  if (activeDir) expandedDirs.add(activeDir);
  if (ok) toast(tt("{n} fichier(s) importé(s).", { n: ok }));
  await loadTree();
}
function openTreeMenu(ev, entry) {
  const menu = $("tree-menu");
  menu.innerHTML = "";
  const add = (ic, label, fn) => { const b = document.createElement("button"); b.innerHTML = icon(ic) + `<span>${escapeHtml(label)}</span>`; b.addEventListener("click", () => { menu.hidden = true; fn(); }); menu.appendChild(b); };
  const dir = entry.is_dir ? entry.path : (entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "");
  if (entry.is_dir) {
    setActiveDir(entry.path);
    add("filePlus", tt("Nouveau fichier"), () => newEntry(false));
    add("folderPlus", tt("Nouveau dossier"), () => newEntry(true));
    add("upload", tt("Importer ici…"), () => $("py-file-input").click());
  } else {
    setActiveDir(dir);
    add("file", tt("Ouvrir"), () => openFile(entry.path));
    if (/\.py$/i.test(entry.name)) add("play", tt("Exécuter"), async () => { await openFile(entry.path); run(); });
  }
  add("pencil", tt("Renommer…"), () => renameEntry(entry));
  add("trash", tt("Supprimer"), () => deleteEntry(entry));
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(ev.clientX, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(ev.clientY, window.innerHeight - r.height - 8) + "px";
}
async function renameEntry(entry) {
  const name = await promptModal(tt("Renommer"), entry.name, entry.name);
  if (!name || name === entry.name) return;
  const newName = name.split("/").pop().trim();
  if (!newName) return;
  try {
    await invoke("sandbox_rename", { id: sandboxId, path: entry.path, newName });
    const newPath = (entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) : "") + newName;
    if (openPath === entry.path) { openPath = newPath; $("open-path").textContent = newPath; }
    await loadTree();
  } catch (e) { toast(tt("Échec : ") + (e.message || e)); }
}
async function deleteEntry(entry) {
  const ok = await confirmModal(tt("Supprimer « {name} » ?", { name: entry.name }) + (entry.is_dir ? " " + tt("(dossier et contenu)") : ""));
  if (!ok) return;
  try {
    await invoke("sandbox_delete_path", { id: sandboxId, path: entry.path });
    if (openPath === entry.path || (entry.is_dir && openPath && openPath.startsWith(entry.path + "/"))) {
      openPath = null; original = ""; ta.value = ""; $("open-path").textContent = ""; refresh(); markDirty();
    }
    expandedDirs.delete(entry.path);
    await loadTree();
  } catch (e) { toast(tt("Échec : ") + (e.message || e)); }
}
function promptModal(title, placeholder = "", value = "") {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `<div class="mini-modal" style="width:min(440px,92vw)"><h3></h3>
      <input class="ta" style="width:100%;box-sizing:border-box" spellcheck="false" />
      <div class="mini-actions"><span class="spacer"></span>
        <button class="btn-soft" data-a="c">${escapeHtml(tt("Annuler"))}</button>
        <button class="btn-soft primary" data-a="ok">${escapeHtml(tt("Valider"))}</button></div></div>`;
    ov.querySelector("h3").textContent = title;
    const input = ov.querySelector("input");
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
        <button class="btn-soft" data-a="c">${escapeHtml(tt("Annuler"))}</button>
        <button class="btn-soft primary" data-a="ok">${escapeHtml(tt("Confirmer"))}</button></div></div>`;
    ov.querySelector("h3").textContent = message;
    const done = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('[data-a="c"]').addEventListener("click", () => done(false));
    ov.querySelector('[data-a="ok"]').addEventListener("click", () => done(true));
    document.body.appendChild(ov);
  });
}

// ===== Câblage =====
function bind() {
  ta.addEventListener("input", () => { refresh(); markDirty(); });
  ta.addEventListener("scroll", syncScroll);
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
    else if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 4; refresh(); markDirty();
    } else if (e.key === "Enter" && !e.shiftKey) {
      // Indentation automatique : on garde celle de la ligne, +4 après « : ».
      const s = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
      const line = ta.value.slice(lineStart, s);
      const indent = (line.match(/^[ \t]*/) || [""])[0] + (/:\s*$/.test(line) ? "    " : "");
      if (indent) {
        e.preventDefault();
        ta.value = ta.value.slice(0, s) + "\n" + indent + ta.value.slice(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = s + 1 + indent.length; refresh(); markDirty();
      }
    }
  });
  ta.addEventListener("contextmenu", (e) => {
    if (!selection().text.trim()) return;
    e.preventDefault(); showCtx(e.clientX, e.clientY);
  });
  document.addEventListener("click", () => { $("ctx-menu").hidden = true; $("tree-menu").hidden = true; });
  $("ctx-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    const act = e.target.closest("button[data-act]")?.dataset.act;
    $("ctx-menu").hidden = true;
    if (act === "run-sel") run(selection().text);
    else if (act === "ai") openAi("modify");
    else if (act === "explain") aiExplain();
    else if (act === "copy") navigator.clipboard?.writeText(selection().text).then(() => toast(tt("Copié.")));
  });
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && document.activeElement !== ta) { e.preventDefault(); run(); }
    if (e.key === "Escape" && running) stop();
  });

  $("sandbox-select").addEventListener("change", async (e) => {
    sandboxId = e.target.value; localStorage.setItem("pySandbox", sandboxId);
    activeDir = ""; expandedDirs.clear(); openPath = null; original = ""; ta.value = ""; refresh(); markDirty();
    await loadTree(); await openLastOrFirst();
  });
  $("btn-save").addEventListener("click", save);
  $("btn-run").addEventListener("click", () => run());
  $("btn-stop").addEventListener("click", stop);
  $("btn-theme").addEventListener("click", () => document.body.classList.toggle("mk-dark"));
  $("btn-ai").addEventListener("click", () => openAi("write"));
  $("ai-cancel").addEventListener("click", () => ($("ai-overlay").hidden = true));
  $("ai-run").addEventListener("click", runAi);
  $("btn-packages").addEventListener("click", () => { $("pkg-overlay").hidden = false; $("pkg-input").focus(); });
  $("pkg-cancel").addEventListener("click", () => ($("pkg-overlay").hidden = true));
  $("pkg-install").addEventListener("click", installPackages);
  $("pkg-input").addEventListener("keydown", (e) => { if (e.key === "Enter") installPackages(); });
  $("btn-clear").addEventListener("click", () => { out.textContent = ""; $("console-meta").textContent = ""; });
  $("btn-restart").addEventListener("click", async () => { if (running) stop(); else { await py.restart(); toast(tt("Interpréteur redémarré.")); } });
  $("btn-stdin").addEventListener("click", () => { const w = $("stdin-wrap"); w.hidden = !w.hidden; $("btn-stdin").classList.toggle("on", !w.hidden); if (!w.hidden) $("stdin").focus(); });
  const replHistory = []; let replIdx = 0;
  $("repl").addEventListener("keydown", async (e) => {
    const input = e.target;
    if (e.key === "Enter") {
      const line = input.value; input.value = "";
      if (line.trim()) { replHistory.push(line); replIdx = replHistory.length; }
      await repl(line);
    } else if (e.key === "ArrowUp" && replHistory.length) { e.preventDefault(); replIdx = Math.max(0, replIdx - 1); input.value = replHistory[replIdx] || ""; }
    else if (e.key === "ArrowDown") { e.preventDefault(); replIdx = Math.min(replHistory.length, replIdx + 1); input.value = replHistory[replIdx] || ""; }
  });
  window.addEventListener("resize", refresh);

  $("btn-new-file").addEventListener("click", () => newEntry(false));
  $("btn-new-folder").addEventListener("click", () => newEntry(true));
  $("btn-import").addEventListener("click", () => { if (sandboxId) $("py-file-input").click(); });
  $("py-file-input").addEventListener("change", (e) => { importFiles(e.target.files); e.target.value = ""; });
  $("btn-refresh-tree").addEventListener("click", () => loadTree());

  // Console redimensionnable par son bord gauche (largeur mémorisée).
  const consoleEl = $("console");
  const saved = parseInt(localStorage.getItem("pyConsoleWidth") || "", 10);
  if (saved) consoleEl.style.width = saved + "px";
  $("console-resizer").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = consoleEl.getBoundingClientRect().width;
    const move = (ev) => { consoleEl.style.width = Math.max(220, Math.min(window.innerWidth * 0.6, startW - (ev.clientX - startX))) + "px"; };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); localStorage.setItem("pyConsoleWidth", String(Math.round(consoleEl.getBoundingClientRect().width))); refresh(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  });
}

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

init();
