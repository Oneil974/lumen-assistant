import { imageGenerationConfig, imageErrorMessage } from "../lib/image-provider.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { createStore } from "../lib/app-state.js";
import { autoTranslate, tt } from "../apps-i18n.js";
// Moodboard premium — chaque objet est ajoutable manuellement OU par l'IA, objet
// par objet ou en tableau complet. Texte : backend LLM partagé. Images : moteur
// image partagé (Bonsai local ou OpenAI) via la commande Rust unifiée.
// Persistance localStorage. Fallback parent pour l'usage embarqué (workspace).
const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
import { recordImageGeneration, recordOllamaUsage } from "../ollama-usage.js";
import { llmChat, ollamaGetJson } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";

import { receive, toText } from "../lib/interop.js";
import { mountCreativeBar } from "../lib/creative-kit.js";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
// État sur DISQUE (app-state/moodboard.json) et non dans localStorage : les
// projets illustrés pesaient plusieurs mégaoctets et saturaient le stockage
// partagé par toutes les fenêtres de Lumen.
const store = createStore("moodboard");
const LIB_KEY = "moodboardLibrary";       // { order: [id], current: id }
const PROJ_PREFIX = "moodboardProject:";  // un projet par clé

function currentInvoke() {
  return invoke || window.__TAURI__?.core?.invoke || window.parent?.__TAURI__?.core?.invoke;
}
function hasTauriInvoke() {
  return typeof currentInvoke() === "function";
}
function tauriInvoke(command, args) {
  const fn = currentInvoke();
  if (!fn) throw new Error("Commande Lumen indisponible.");
  return fn(command, args);
}

const DEFAULT_ICONS = [
  { type: "svg", value: '<path d="M12 2 9.2 8.6 2 9.3l5.5 4.8L5.8 21 12 17.3 18.2 21l-1.7-6.9L22 9.3l-7.2-.7z"/>' },
  { type: "svg", value: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>' },
  { type: "svg", value: '<path d="M3 12c3-4 6-4 9 0s6 4 9 0M3 17c3-4 6-4 9 0s6 4 9 0"/>' },
  { type: "svg", value: '<path d="M12 3v18M3 12h18" transform="rotate(45 12 12)"/><circle cx="12" cy="12" r="3"/>' },
];

const DEFAULT = {
  theme: "",
  title: "Campagne été 2025",
  tags: "Lancement · Inspiration · Sérénité",
  brief:
    "Créer une campagne qui évoque l'évasion, la lumière et la simplicité. " +
    "Ton : inspirant, premium, naturel. Cible : voyageurs urbains 25–40 ans. Support : digital & print.",
  quote: "Respirer.\nExplorer.\nS'émerveiller.",
  hero: [],          // jusqu'à 2 images
  images: [],        // galerie moodboard
  layouts: [],       // mises en page
  icons: structuredClone(DEFAULT_ICONS), // {type:'svg'|'img', value}
  logos: [],         // {type:'img', value}
  palette: ["#6B5CFF", "#FFB084", "#FFE6C7", "#EDEBFF", "#F77B7B"],
  font: "Satoshi",
};

let project = structuredClone(DEFAULT);
let library = { order: [], current: null };
const imageRefCache = new Map();

// ---------- Bibliothèque de projets ----------
function newId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function projKey(id) { return PROJ_PREFIX + id; }
function isRef(v) { return v && v.type === "ref" && typeof v.path === "string"; }
function isImg(v) { return typeof v === "string" ? v.startsWith("data:") || /^https?:/.test(v) : v && (v.type === "img" || isRef(v)); }
function isHeavyImg(v) {
  if (typeof v === "string") return v.startsWith("data:");
  return v && v.type === "img" && typeof v.value === "string" && v.value.startsWith("data:");
}
function compactAsset(v) {
  if (!isRef(v)) return v;
  return { type: "ref", sandboxId: v.sandboxId || "", path: v.path, name: v.name || "", mime: v.mime || "image/png" };
}
function compactAssets(arr) { return arr.map(compactAsset); }

function slimProject(p) {
  return {
    ...p,
    hero: compactAssets(p.hero.slice(0, 2)), images: compactAssets(p.images.slice(0, 10)),
    layouts: compactAssets(p.layouts.slice(0, 8)), icons: compactAssets(p.icons.slice(0, 8)), logos: compactAssets(p.logos.slice(0, 6)),
  };
}
// Retire seulement une image encodée en base64 pour repasser sous le quota.
// Les références sandbox sont légères : les supprimer rendait les nouveaux projets
// impossibles à illustrer quand un ancien moodboard contenait déjà beaucoup d'images.
function pruneOneImage(p) {
  const order = ["images", "layouts", "logos", "icons", "hero"];
  const k = order.find((key) => p[key].some((v) => isHeavyImg(v)));
  if (!k) return null;
  const idx = [...p[k]].reverse().findIndex((v) => isHeavyImg(v));
  return { ...p, [k]: p[k].filter((_, i) => i !== p[k].length - 1 - idx) };
}
function readProject(id) {
  try {
    const p = JSON.parse(store.get(projKey(id)) || "null");
    return p && typeof p === "object" ? Object.assign(structuredClone(DEFAULT), p) : null;
  } catch { return null; }
}
function writeProject(id, proj) {
  let attempt = slimProject(proj);
  for (;;) {
    try { store.set(projKey(id), JSON.stringify(attempt)); return attempt; }
    catch { const next = pruneOneImage(attempt); if (!next) return attempt; attempt = next; }
  }
}
function writeLibrary() {
  try { store.set(LIB_KEY, JSON.stringify({ order: library.order, current: library.current })); } catch {}
}

// Sauvegarde du projet courant (auto-save à chaque modification).
function save() {
  project = writeProject(library.current, project);
  scheduleOffload();
}

// ===== Décharge des images vers la sandbox =====
//
// Une image encodée en base64 dans le projet pèse des mégaoctets, et
// localStorage est plafonné pour TOUTE l'origine (~10 Mo, apps du bureau
// comprises) : un seul moodboard illustré saturait le stockage et faisait
// échouer les écritures de toutes les autres apps — y compris le changement de
// discussion de l'assistant. Les images partent donc dans la sandbox et le
// projet ne garde qu'une référence (quelques octets), sans rien perdre.
const OFFLOAD_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const ASSET_KEYS = ["hero", "images", "layouts", "icons", "logos"];
let offloadTimer = null;
let offloading = false;

function scheduleOffload() {
  clearTimeout(offloadTimer);
  offloadTimer = setTimeout(() => { offloadHeavyImages().catch(() => {}); }, 800);
}

async function offloadSandboxId() {
  const known = targetSandboxId();
  if (known) return known;
  try {
    const list = await tauriInvoke("sandbox_list");
    return Array.isArray(list) && list.length ? list[0].id : null;
  } catch { return null; }
}

/// Déplace les images base64 d'UN projet vers la sandbox. Renvoie le nombre
/// d'images déplacées (le projet est modifié sur place).
async function offloadProjectImages(proj, projId, sandboxId) {
  let moved = 0;
  for (const key of ASSET_KEYS) {
    const arr = proj[key] || [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!isHeavyImg(v)) continue;
      const dataUrl = typeof v === "string" ? v : v.value;
      const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ""));
      if (!m) continue;
      const mime = m[1];
      const ext = OFFLOAD_EXT[mime] || "png";
      const name = `${key}-${Date.now().toString(36)}${i}.${ext}`;
      const path = `moodboard/${projId || "projet"}/${name}`;
      try { await tauriInvoke("sandbox_import_file", { id: sandboxId, path, dataB64: m[2] }); }
      catch { continue; }
      // La vignette reste affichable sans relecture disque.
      imageRefCache.set(`${sandboxId}:${path}`, dataUrl);
      arr[i] = { type: "ref", sandboxId, path, name, mime };
      moved += 1;
    }
  }
  return moved;
}

async function offloadHeavyImages() {
  if (offloading || !hasTauriInvoke()) return;
  // TOUS les projets de la bibliothèque, pas seulement celui affiché : c'est un
  // ancien moodboard laissé de côté qui saturait le stockage.
  const ids = library.order.length ? library.order : [library.current].filter(Boolean);
  const targets = ids.map((id) => (id === library.current ? { id, proj: project } : { id, proj: readProject(id) }))
    .filter((t) => t.proj && ASSET_KEYS.some((k) => (t.proj[k] || []).some(isHeavyImg)));
  if (!targets.length) return;
  const sandboxId = await offloadSandboxId();
  if (!sandboxId) return; // pas de sandbox : on garde le comportement d'avant (élagage au besoin)
  offloading = true;
  let moved = 0;
  try {
    for (const t of targets) {
      const n = await offloadProjectImages(t.proj, t.id, sandboxId);
      if (!n) continue;
      moved += n;
      if (t.id === library.current) project = writeProject(t.id, t.proj);
      else writeProject(t.id, t.proj);
    }
  } finally {
    offloading = false;
  }
  if (moved) {
    renderAll();
    toast(`${moved} image(s) déplacée(s) dans la sandbox`);
  }
}

function loadLibrary() {
  try { const l = JSON.parse(store.get(LIB_KEY) || "null"); if (l && Array.isArray(l.order)) library = { order: l.order, current: l.current }; }
  catch { /* défaut */ }
  // Migration depuis l'ancien stockage mono-projet.
  if (!library.order.length) {
    let legacy = null;
    try { legacy = JSON.parse(store.get("moodboardProject") || "null"); } catch {}
    const id = newId();
    const proj = legacy && typeof legacy === "object" ? Object.assign(structuredClone(DEFAULT), legacy) : structuredClone(DEFAULT);
    library = { order: [id], current: id };
    writeProject(id, proj);
    writeLibrary();
    store.remove("moodboardProject");
  }
  if (!library.current || !library.order.includes(library.current)) library.current = library.order[0];
  project = readProject(library.current) || structuredClone(DEFAULT);
}

function openProject(id) {
  if (id === library.current) return;
  save();
  library.current = id;
  project = readProject(id) || structuredClone(DEFAULT);
  writeLibrary();
  renderAll();
}
function newProject() {
  save();
  const id = newId();
  project = structuredClone(DEFAULT);
  project.title = "Nouveau moodboard"; project.tags = "";
  project.hero = []; project.images = []; project.layouts = []; project.logos = [];
  library.order.push(id);
  library.current = id;
  writeProject(id, project);
  writeLibrary();
  renderAll();
  toast("Nouveau projet créé");
}
function deleteProject(id) {
  library.order = library.order.filter((x) => x !== id);
  store.remove(projKey(id));
  if (library.current === id) {
    if (!library.order.length) { writeLibrary(); newProject(); return; }
    library.current = library.order[0];
    project = readProject(library.current) || structuredClone(DEFAULT);
  }
  writeLibrary();
  renderAll();
}
function renameProject(id, name) {
  const clean = (name || "").trim() || "Sans titre";
  if (id === library.current) { project.title = clean; save(); $("#proj-title").value = clean; }
  else { const p = readProject(id); if (p) { p.title = clean; writeProject(id, p); } }
  renderProjects();
}

// Rendu de la liste de projets dans la sidebar.
function renderProjects() {
  const list = $("#project-list");
  if (!list) return;
  list.innerHTML = "";
  const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  for (const id of library.order) {
    const meta = id === library.current ? project : (readProject(id) || { title: "Sans titre" });
    const item = document.createElement("div");
    item.className = "proj-item" + (id === library.current ? " active" : "");
    item.innerHTML = `<span class="nav-ic">${FOLDER}</span><span class="pi-name">${escapeHtml(meta.title || "Sans titre")}</span><button class="pi-x" title="Supprimer">✕</button>`;
    item.addEventListener("click", () => openProject(id));
    item.querySelector(".pi-x").addEventListener("click", (e) => {
      e.stopPropagation();
      // confirm() est inopérant sous WKWebView : suppression directe + toast.
      deleteProject(id);
      toast(`« ${meta.title} » supprimé`);
    });
    // Double-clic : renommage inline.
    item.querySelector(".pi-name").addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const span = e.currentTarget;
      span.innerHTML = `<input value="${escapeHtml(meta.title || "")}" />`;
      const inp = span.querySelector("input");
      inp.focus(); inp.select();
      const commit = () => renameProject(id, inp.value);
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") inp.blur(); if (ev.key === "Escape") renderProjects(); });
    });
    list.appendChild(item);
  }
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- Import depuis la sandbox ----------
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif" };
let sbState = null;

// Ouvre le navigateur de sandbox et résout avec un tableau d'assets choisis.
function pickImages() {
  if (!hasTauriInvoke()) { toast("Import depuis la sandbox dispo uniquement dans l'app Lumen."); return Promise.resolve([]); }
  return new Promise(async (resolve) => {
    let sandboxes = [];
    try { sandboxes = await tauriInvoke("sandbox_list"); } catch {}
    if (!sandboxes.length) { toast("Aucune sandbox disponible."); resolve([]); return; }
    const cur = targetSandboxId();
    const id = sandboxes.find((s) => s.id === cur)?.id || sandboxes[0].id;
    sbState = { id, cwd: "", resolve, selected: new Map() };
    const sel = $("#sb-select");
    sel.innerHTML = "";
    sandboxes.forEach((s) => sel.appendChild(new Option(s.name, s.id)));
    sel.value = id;
    $("#sb-modal").hidden = false;
    sbBrowse();
  });
}
function sbFinish(urls) {
  $("#sb-modal").hidden = true;
  const r = sbState && sbState.resolve;
  sbState = null;
  r && r(urls);
}
function renderCrumbs() {
  const wrap = $("#sb-crumbs");
  const parts = sbState.cwd ? sbState.cwd.split("/") : [];
  wrap.innerHTML = "";
  const root = document.createElement("button"); root.textContent = "racine";
  root.addEventListener("click", () => { sbState.cwd = ""; sbBrowse(); });
  wrap.appendChild(root);
  let acc = "";
  parts.forEach((p) => {
    acc = acc ? `${acc}/${p}` : p;
    const path = acc;
    wrap.insertAdjacentHTML("beforeend", `<span class="sep">/</span>`);
    const b = document.createElement("button"); b.textContent = p;
    b.addEventListener("click", () => { sbState.cwd = path; sbBrowse(); });
    wrap.appendChild(b);
  });
}
async function sbBrowse() {
  const grid = $("#sb-grid"); grid.innerHTML = "";
  renderCrumbs();
  let entries = [];
  try { entries = await tauriInvoke("sandbox_read_dir", { id: sbState.id, path: sbState.cwd }); } catch {}
  const dirs = entries.filter((e) => e.is_dir);
  const imgs = entries.filter((e) => !e.is_dir && IMG_EXT.test(e.name));
  $("#sb-empty").hidden = dirs.length + imgs.length > 0;
  const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  for (const d of dirs) {
    const cell = document.createElement("div"); cell.className = "sb-cell dir";
    cell.innerHTML = `${FOLDER}<span class="sb-label">${escapeHtml(d.name)}</span>`;
    cell.addEventListener("click", () => { sbState.cwd = d.path; sbBrowse(); });
    grid.appendChild(cell);
  }
  for (const f of imgs) {
    const cell = document.createElement("div"); cell.className = "sb-cell file";
    cell.innerHTML = `<div class="sb-check">✓</div>`;
    grid.appendChild(cell);
    if (sbState.selected.has(f.path)) cell.classList.add("sel");
    loadSandboxImage(cell, f);
    cell.addEventListener("click", async () => {
      const asset = await loadSandboxImage(cell, f);
      if (!asset || !sbState) return;
      if (sbState.selected.has(f.path)) {
        sbState.selected.delete(f.path);
        cell.classList.remove("sel");
      } else {
        sbState.selected.set(f.path, asset);
        cell.classList.add("sel");
      }
      updateSandboxCount();
    });
  }
  updateSandboxCount();
}

function updateSandboxCount() {
  $("#sb-count").textContent = sbState?.selected.size ? `${sbState.selected.size} sélectionnée(s)` : "";
}

async function loadSandboxImage(cell, file) {
  if (cell._asset) return cell._asset;
  if (!cell._loading) {
    cell.classList.add("loading");
    cell._loading = readSandboxImageAsset(file).then((asset) => {
      cell._asset = asset;
      if (!cell.querySelector("img")) {
        const img = document.createElement("img");
        img.src = asset.value;
        cell.insertBefore(img, cell.firstChild);
      }
      return asset;
    }).catch(() => "").finally(() => {
      cell.classList.remove("loading");
    });
  }
  return cell._loading;
}

async function readSandboxImageAsset(file) {
  const b64 = await tauriInvoke("sandbox_read_b64", { id: sbState.id, path: file.path });
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const mime = MIME[ext] || "image/png";
  return { type: "ref", sandboxId: sbState.id, path: file.path, name: file.name, mime, value: `data:${mime};base64,${b64}` };
}

function refKey(asset) { return `${asset.sandboxId || targetSandboxId() || ""}:${asset.path}`; }
function imageValue(asset) {
  if (typeof asset === "string") return asset;
  if (asset && asset.type === "img") return asset.value;
  if (isRef(asset)) return asset.value || imageRefCache.get(refKey(asset)) || "";
  return "";
}
async function resolveImageSrc(asset) {
  const current = imageValue(asset);
  if (current) return current;
  if (!isRef(asset) || !hasTauriInvoke()) return "";
  const id = asset.sandboxId || targetSandboxId();
  if (!id) return "";
  const b64 = await tauriInvoke("sandbox_read_b64", { id, path: asset.path });
  const url = `data:${asset.mime || "image/png"};base64,${b64}`;
  imageRefCache.set(refKey(asset), url);
  return url;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "moodboard";
}

// =====================================================================
//  Moteur IA — Texte (Ollama) & Image (Bonsai)
// =====================================================================
const ollamaUrl = () => localStorage.getItem("ollamaUrl") || "http://localhost:11434";
const ollamaModel = () => localStorage.getItem("selectedModel") || "";

async function aiChat({ messages, opts }) {
  // Backend unifié : Ollama natif OU API cloud (OpenAI) selon la config.
  const { content, data } = await llmChat(messages, { ...(opts || {}), rawSystem: true });
  recordOllamaUsage(data, "moodboard");
  return (content || "").trim();
}

// Extrait le premier objet/tableau JSON d'une réponse LLM.
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start], close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < body.length; i += 1) {
    if (body[i] === open) depth += 1;
    else if (body[i] === close) { depth -= 1; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function context() {
  return [project.theme, project.title, project.brief].filter(Boolean).join(" — ") || "moodboard créatif premium";
}

// Cible sandbox : sandbox active du workspace si embarqué, sinon sandbox dédiée.
function targetSandboxId() {
  try { return (window.parent && window.parent.LumenCurrentSandbox && window.parent.LumenCurrentSandbox()) || null; }
  catch { return null; }
}


// Appel du moteur d'image avec traduction de l'erreur : sans elle, le toast
// affichait un statut HTTP brut.
async function imageInvoke(imageConfig, args) {
  try { return await tauriInvoke("bonsai_generate_to_sandbox_url", args); }
  catch (e) { throw new Error(imageErrorMessage(e, imageConfig.provider)); }
}

async function aiImage(prompt, { w = 512, h = 512, steps = 4, key = "moodboard" } = {}) {
  if (!hasTauriInvoke()) throw new Error("Génération d'image dispo uniquement dans l'app Lumen.");
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const imageConfig = imageGenerationConfig();
  const res = await imageInvoke(imageConfig, {
    id: targetSandboxId(),
    path: `moodboard/${key}_${slugify(prompt)}_${stamp}.png`,
    prompt, width: w, height: h, seed: null, steps, backend: imageConfig.backend,
    provider: imageConfig.provider,
    apiBase: imageConfig.apiBase,
    apiKey: imageConfig.apiKey,
    apiModel: imageConfig.apiModel,
  });
  recordImageGeneration(1, imageConfig.provider);
  try { window.parent && window.parent.LumenRefreshSandbox && window.parent.LumenRefreshSandbox(res.sandbox_id); } catch {}
  return {
    type: "ref",
    sandboxId: res.sandbox_id || targetSandboxId() || "",
    path: res.path || `moodboard/${key}_${slugify(prompt)}_${stamp}.png`,
    name: (res.path || "").split("/").pop() || `${key}_${stamp}.png`,
    mime: "image/png",
    value: res.data_url,
  };
}

// Bouton IA avec spinner pendant l'exécution d'une tâche async.
async function withBtn(btn, task) {
  if (btn) btn.classList.add("busy");
  try { return await task(); }
  catch (e) { toast("IA : " + ((e && e.message) || e), 4200); return undefined; }
  finally { if (btn) btn.classList.remove("busy"); }
}

// =====================================================================
//  Rendu
// =====================================================================
const ICON_ADD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;

function makeAssetImage(asset) {
  const img = document.createElement("img");
  img.alt = "";
  const src = imageValue(asset);
  if (src) img.src = src;
  else {
    img.className = "img-loading";
    resolveImageSrc(asset).then((url) => {
      if (url) img.src = url;
    }).finally(() => img.classList.remove("img-loading"));
  }
  return img;
}

function imgTile(asset, onRemove, cls = "tile") {
  const t = document.createElement("div");
  t.className = cls;
  t.appendChild(makeAssetImage(asset));
  t.insertAdjacentHTML("beforeend", `<button class="tile-x" title="Retirer">✕</button>`);
  t.querySelector(".tile-x").addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
  t.addEventListener("click", async () => {
    const url = await resolveImageSrc(asset);
    if (url) openPreview(url);
  });
  return t;
}

// Lightbox d'aperçu.
function openPreview(url) { $("#lb-img").src = url; $("#lightbox").hidden = false; }
function closePreview() { $("#lightbox").hidden = true; $("#lb-img").src = ""; }

// Couleurs dérivées de la palette : les deux teintes les plus sombres servent à
// teinter la carte « accroche » (haut-droite) et la pastille du projet.
function paletteAccent() {
  const lum = (h) => { const m = h.replace("#", ""); return 0.299 * parseInt(m.slice(0, 2), 16) + 0.587 * parseInt(m.slice(2, 4), 16) + 0.114 * parseInt(m.slice(4, 6), 16); };
  const sorted = project.palette.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).sort((a, b) => lum(a) - lum(b));
  return sorted.length ? [sorted[0], sorted[1] || sorted[0]] : ["#6b6ff0", "#8a73f2"];
}
function applyPaletteColors() {
  const [a, b] = paletteAccent();
  const grad = `linear-gradient(150deg, ${a}, ${b})`;
  document.querySelector(".proj-logo") && (document.querySelector(".proj-logo").style.background = grad);
  document.querySelector(".tile.quote") && (document.querySelector(".tile.quote").style.background = grad);
}
function genTile(label = "Génération…", cls = "tile") {
  const t = document.createElement("div");
  t.className = `${cls} gen`;
  t.innerHTML = `<div class="shimmer"></div><span class="gen-tag">${label}</span>`;
  return t;
}
function addTile(onClick, cls = "tile") {
  const t = document.createElement("div");
  t.className = `${cls} add`;
  t.innerHTML = ICON_ADD;
  t.addEventListener("click", onClick);
  return t;
}

// Menu contextuel « Importer / Générer (IA) ».
function showAddMenu(ev, { onImport, onAI }) {
  document.querySelector(".add-menu")?.remove();
  const m = document.createElement("div");
  m.className = "add-menu";
  m.innerHTML =
    `<button data-a="import">📂 Importer une image</button>` +
    `<button data-a="ai" class="am-ai">✦ Générer avec l'IA</button>`;
  document.body.appendChild(m);
  const x = Math.min(ev.clientX, window.innerWidth - 190);
  const y = Math.min(ev.clientY, window.innerHeight - 100);
  m.style.left = x + "px"; m.style.top = y + "px";
  const close = () => { m.remove(); document.removeEventListener("pointerdown", outside, true); };
  const outside = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  m.querySelector('[data-a="import"]').addEventListener("click", () => { close(); onImport(); });
  m.querySelector('[data-a="ai"]').addEventListener("click", () => { close(); onAI(); });
}

function renderHero() {
  const grid = $("#hero-grid");
  grid.innerHTML = "";
  for (let i = 0; i < 2; i += 1) {
    const asset = project.hero[i];
    if (asset) grid.appendChild(imgTile(asset, () => { project.hero.splice(i, 1); save(); renderHero(); }));
    else grid.appendChild(addTile((ev) => addToCollection("hero", { ev, slot: i, w: 768, h: 512 })));
  }
  const quote = document.createElement("div");
  quote.className = "tile quote";
  quote.innerHTML =
    `<button class="ai-btn quote-ai" title="Générer une accroche">✦</button>` +
    `<textarea placeholder="Une accroche évocatrice…">${escapeHtml(project.quote)}</textarea>`;
  const ta = quote.querySelector("textarea");
  ta.addEventListener("input", () => { project.quote = ta.value; save(); });
  quote.querySelector(".quote-ai").addEventListener("click", (e) => { e.stopPropagation(); genQuote(e.currentTarget); });
  grid.appendChild(quote);
  applyPaletteColors();
}

function renderGrid(key, gridEl, { cls = "tile", w = 512, h = 512, min = 1 } = {}) {
  gridEl.innerHTML = "";
  project[key].forEach((asset, i) => {
    gridEl.appendChild(imgTile(asset, () => { project[key].splice(i, 1); save(); renderGrid(key, gridEl, { cls, w, h, min }); }, cls));
  });
  gridEl.appendChild(addTile((ev) => addToCollection(key, { ev, w, h }), cls));
  // Conserve une hauteur minimale visuelle pour les mises en page vides.
  while (key === "layouts" && gridEl.children.length < Math.max(min + 1, 4)) {
    const ph = document.createElement("div");
    ph.className = "layout-card"; ph.innerHTML = `<div class="lc-empty">${ICON_ADD}<br>Vide</div>`;
    ph.addEventListener("click", (ev) => addToCollection("layouts", { ev, w: 512, h: 768 }));
    gridEl.appendChild(ph);
  }
}

function renderIcons() {
  const grid = $("#icons-grid");
  grid.innerHTML = "";
  project.icons.forEach((it, i) => {
    const cell = document.createElement("div");
    cell.className = "icon-cell";
    if (it.type === "img" || isRef(it)) {
      cell.appendChild(makeAssetImage(it));
      cell.addEventListener("click", async () => {
        const url = await resolveImageSrc(it);
        if (url) openPreview(url);
      });
    } else cell.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.value}</svg>`;
    cell.insertAdjacentHTML("beforeend", `<button class="cell-x" title="Retirer">✕</button>`);
    cell.querySelector(".cell-x").addEventListener("click", (e) => { e.stopPropagation(); project.icons.splice(i, 1); save(); renderIcons(); });
    grid.appendChild(cell);
  });
}

function renderLogos() {
  const grid = $("#logos-grid");
  grid.innerHTML = "";
  if (!project.logos.length) {
    const ph = document.createElement("div");
    ph.className = "logo-cell"; ph.style.fontWeight = "700"; ph.style.letterSpacing = ".18em";
    ph.textContent = "ORION";
    grid.appendChild(ph);
  }
  project.logos.forEach((it, i) => {
    const cell = document.createElement("div");
    cell.className = "logo-cell";
    cell.appendChild(makeAssetImage(it));
    cell.insertAdjacentHTML("beforeend", `<button class="cell-x" title="Retirer">✕</button>`);
    cell.querySelector(".cell-x").addEventListener("click", (e) => { e.stopPropagation(); project.logos.splice(i, 1); save(); renderLogos(); });
    cell.addEventListener("click", async () => {
      const url = await resolveImageSrc(it);
      if (url) openPreview(url);
    });
    grid.appendChild(cell);
  });
}

function renderPalette() {
  const wrap = $("#swatches");
  wrap.innerHTML = "";
  project.palette.forEach((hex, i) => {
    const sw = document.createElement("div");
    sw.className = "swatch";
    sw.style.background = hex;
    sw.innerHTML = `<input type="color" value="${toHex(hex)}" /><span class="hex">${hex.toUpperCase()}</span><button class="sw-x" title="Retirer">✕</button>`;
    const input = sw.querySelector("input");
    input.addEventListener("input", () => { project.palette[i] = input.value; sw.style.background = input.value; sw.querySelector(".hex").textContent = input.value.toUpperCase(); save(); });
    sw.querySelector(".sw-x").addEventListener("click", (e) => { e.stopPropagation(); project.palette.splice(i, 1); save(); renderPalette(); });
    sw.addEventListener("click", (e) => { if (e.target === sw || e.target.classList.contains("hex")) navigator.clipboard?.writeText(hex).then(() => toast(`Copié ${hex.toUpperCase()}`), () => {}); });
    wrap.appendChild(sw);
  });
  applyPaletteColors();
}
function toHex(c) { return /^#[0-9a-f]{6}$/i.test(c) ? c : "#888888"; }

function renderType() {
  $("#font-name").value = project.font;
  const fam = `"${project.font}", -apple-system, sans-serif`;
  $("#type-aa").style.fontFamily = fam;
  $("#type-aa2").style.fontFamily = fam;
}

function renderAll() {
  $("#proj-title").value = project.title;
  $("#proj-tags").value = project.tags;
  $("#brief").value = project.brief;
  renderHero();
  renderGrid("images", $("#mb-grid"), { cls: "tile", w: 512, h: 512 });
  renderGrid("layouts", $("#layouts-grid"), { cls: "layout-card", w: 512, h: 768 });
  renderIcons();
  renderLogos();
  renderPalette();
  renderType();
  renderProjects();
  applyPaletteColors();
}

// =====================================================================
//  Ajout (manuel ou IA) d'éléments dans une collection
// =====================================================================
const GRID_OF = { images: () => $("#mb-grid"), layouts: () => $("#layouts-grid") };
const DIMS_OF = { hero: { w: 768, h: 512 }, images: { w: 512, h: 512 }, layouts: { w: 512, h: 768 }, icons: { w: 512, h: 512 }, logos: { w: 768, h: 512 } };
const IMPORT_MAX_OF = { hero: { w: 1100, h: 760 }, images: { w: 860, h: 860 }, layouts: { w: 760, h: 1100 }, icons: { w: 640, h: 640 }, logos: { w: 1100, h: 760 } };

function pushToCollection(key, asset, slot) {
  if (key === "hero") { if (slot != null) project.hero[slot] = asset; else project.hero.push(asset); }
  else if (key === "icons") project.icons.push(isRef(asset) ? asset : { type: "img", value: asset });
  else if (key === "logos") project.logos.push(isRef(asset) ? asset : { type: "img", value: asset });
  else project[key].unshift(asset);
}
async function importUrlsIntoCollection(key, assets, slot) {
  const prepared = [];
  if (assets.length > 1) toast("Préparation des images…", 1600);
  for (const asset of assets) prepared.push(await prepareImportAsset(asset, key));
  if (key === "hero" && slot != null) project.hero[slot] = prepared[0];
  else prepared.forEach((u) => pushToCollection(key, u, slot));
  save();
  rerender(key);
  toast(`${prepared.length} image${prepared.length > 1 ? "s" : ""} importée${prepared.length > 1 ? "s" : ""}`);
}
async function prepareImportAsset(asset, key) {
  if (isRef(asset)) return compactAsset(asset);
  return prepareImportUrl(asset, key);
}
async function prepareImportUrl(url, key) {
  if (!/^data:image\//i.test(url) || /^data:image\/(svg\+xml|gif)/i.test(url)) return url;
  const max = IMPORT_MAX_OF[key] || { w: 900, h: 900 };
  try { return await resizeDataUrl(url, max.w, max.h); }
  catch { return url; }
}
function resizeDataUrl(url, maxW, maxH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = Math.max(1, Math.round(img.naturalWidth * ratio));
      const h = Math.max(1, Math.round(img.naturalHeight * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const webp = canvas.toDataURL("image/webp", 0.84);
      resolve(webp && webp !== "data:," ? webp : canvas.toDataURL("image/jpeg", 0.86));
    };
    img.onerror = reject;
    img.src = url;
  });
}
function rerender(key) {
  if (key === "hero") renderHero();
  else if (key === "icons") renderIcons();
  else if (key === "logos") renderLogos();
  else renderGrid(key, GRID_OF[key](), { cls: key === "layouts" ? "layout-card" : "tile", ...DIMS_OF[key] });
}

// Affiche le menu Importer/IA puis exécute le choix.
function addToCollection(key, { ev, slot, w, h } = {}) {
  const dims = { ...(DIMS_OF[key] || {}), ...(w ? { w } : {}), ...(h ? { h } : {}) };
  showAddMenu(ev || { clientX: window.innerWidth / 2, clientY: 160 }, {
    onImport: async () => {
      const urls = await pickImages();
      if (!urls.length) return;
      await importUrlsIntoCollection(key, key === "hero" && slot != null ? urls.slice(0, 1) : urls, slot);
    },
    onAI: () => openImageModal(key, slot, dims),
  });
}

// =====================================================================
//  Modale image IA
// =====================================================================
let imgModalCtx = null;
function openImageModal(key, slot, dims) {
  imgModalCtx = { key, slot, dims };
  $("#img-modal-title").textContent = `Image IA — ${labelOf(key)}`;
  $("#img-prompt").value = suggestImagePrompt(key);
  $("#img-format").value = `${dims.w}x${dims.h}`;
  $("#img-steps").value = "4";
  $("#img-modal").hidden = false;
  $("#img-prompt").focus();
}
function closeImageModal() { $("#img-modal").hidden = true; imgModalCtx = null; }
function labelOf(key) { return ({ hero: "image principale", images: "moodboard", layouts: "mise en page", icons: "élément", logos: "logo" })[key] || key; }
function suggestImagePrompt(key) {
  const base = project.theme || project.title || "moodboard";
  const tail = ({
    layouts: ", page layout, editorial composition, clean",
    icons: ", minimalist icon, simple shape, flat",
    logos: ", logo mark, emblem, minimalist",
  })[key] || ", cinematic, soft natural light, premium";
  return `${base}${tail}`;
}
async function runImageModal() {
  if (!imgModalCtx) return;
  const { key, slot } = imgModalCtx;
  const prompt = $("#img-prompt").value.trim();
  if (!prompt) { toast("Décris l'image."); return; }
  const [w, h] = $("#img-format").value.split("x").map(Number);
  const steps = Math.min(64, Math.max(1, parseInt($("#img-steps").value, 10) || 4));
  closeImageModal();
  // Placeholder de génération dans la bonne grille.
  const ph = insertPlaceholder(key, slot);
  try {
    const asset = await aiImage(prompt, { w, h, steps, key });
    pushToCollection(key, asset, slot);
    save();
  } catch { /* toast déjà affiché */ }
  ph?.remove();
  rerender(key);
}
function insertPlaceholder(key) {
  const map = { hero: $("#hero-grid"), images: $("#mb-grid"), layouts: $("#layouts-grid"), icons: $("#icons-grid"), logos: $("#logos-grid") };
  const grid = map[key]; if (!grid) return null;
  const cls = key === "layouts" ? "layout-card" : key === "icons" ? "icon-cell" : key === "logos" ? "logo-cell" : "tile";
  const ph = genTile("IA…", cls);
  grid.prepend(ph);
  return ph;
}

// =====================================================================
//  IA — objets texte
// =====================================================================
async function genBrief(btn) {
  await withBtn(btn, async () => {
    const out = await aiChat(PROMPTS["app.moodboard.brief"].build({ topic: context(), lang: replyLang() }));
    if (out) { project.brief = out; $("#brief").value = out; save(); toast("Brief généré ✓"); }
  });
}
async function genQuote(btn) {
  await withBtn(btn, async () => {
    const out = await aiChat(PROMPTS["app.moodboard.quote"].build({ topic: context(), lang: replyLang() }));
    const clean = out.replace(/^["'«»\s]+|["'«»\s]+$/g, "");
    if (clean) { project.quote = clean; save(); renderHero(); toast("Accroche générée ✓"); }
  });
}
async function genPalette(btn) {
  await withBtn(btn, async () => {
    const out = await aiChat(PROMPTS["app.moodboard.palette"].build({ topic: context() }));
    const parsed = extractJson(out);
    const arr = Array.isArray(parsed) ? parsed : parsed?.palette;
    const hexes = Array.isArray(arr) ? arr.filter((s) => /^#?[0-9a-f]{6}$/i.test(String(s).trim())).map((s) => (s[0] === "#" ? s : "#" + s)).slice(0, 5) : [];
    if (hexes.length) { project.palette = hexes; save(); renderPalette(); toast("Palette générée ✓"); }
    else toast("Réponse palette non exploitable.");
  });
}
async function genType(btn) {
  await withBtn(btn, async () => {
    const out = await aiChat(PROMPTS["app.moodboard.font"].build({ topic: context() }));
    const name = out.split(/[\n.,(]/)[0].replace(/["'«»]/g, "").trim();
    if (name) { project.font = name.slice(0, 40); save(); renderType(); $("#type-note").textContent = "Suggéré par l'IA"; toast(`Typo : ${project.font}`); }
  });
}

// =====================================================================
//  IA — tableau complet
// =====================================================================
async function composeBoard() {
  const theme = $("#compose-theme").value.trim();
  if (!theme) { toast("Décris d'abord le thème."); return; }
  const doText = $("#ck-text").checked;
  const doImages = $("#ck-images").checked;
  const count = Math.min(6, Math.max(0, parseInt($("#compose-count").value, 10) || 0));
  project.theme = theme;

  const go = $("#compose-go");
  go.classList.add("busy"); go.disabled = true;
  const prog = $("#compose-progress"); prog.hidden = false;
  const setProg = (p, label) => { $("#cp-fill").style.width = `${Math.round(p * 100)}%`; $("#cp-label").textContent = label; };

  let imagePrompts = [];
  try {
    if (doText) {
      setProg(0.1, "Direction artistique (texte)…");
      const out = await aiChat(PROMPTS["app.moodboard.board"].build({ topic: theme, count: count || 4 }));
      const data = extractJson(out) || {};
      if (data.title) project.title = String(data.title).slice(0, 80);
      if (data.tags) project.tags = String(data.tags).slice(0, 120);
      if (data.brief) project.brief = String(data.brief);
      if (data.quote) project.quote = String(data.quote);
      if (data.font) project.font = String(data.font).slice(0, 40);
      if (Array.isArray(data.palette)) {
        const hexes = data.palette.filter((s) => /^#?[0-9a-f]{6}$/i.test(String(s).trim())).map((s) => (s[0] === "#" ? s : "#" + s)).slice(0, 5);
        if (hexes.length) project.palette = hexes;
      }
      if (Array.isArray(data.imagePrompts)) imagePrompts = data.imagePrompts.map(String);
      save(); renderAll();
    }

    if (doImages && count > 0) {
      if (!hasTauriInvoke()) { toast("Images IA dispo uniquement dans l'app Lumen."); }
      else {
        // Repli : si l'IA texte n'a pas fourni de prompts, on en fabrique depuis le thème.
        while (imagePrompts.length < count) imagePrompts.push(`${theme}, cinematic, soft natural light, premium mood`);
        imagePrompts = imagePrompts.slice(0, count);
        // Vide les images existantes pour repartir d'un tableau cohérent.
        project.hero = []; project.images = [];
        renderHero(); renderGrid("images", $("#mb-grid"), { cls: "tile", w: 512, h: 512 });
        for (let i = 0; i < imagePrompts.length; i += 1) {
          setProg(0.3 + 0.65 * (i / imagePrompts.length), `Image ${i + 1}/${imagePrompts.length} (Bonsai)…`);
          // 2 premières en hero (paysage), le reste dans la galerie (carré).
          const toHero = i < 2;
          const ph = insertPlaceholder(toHero ? "hero" : "images");
          try {
            const asset = await aiImage(imagePrompts[i], toHero ? { w: 768, h: 512, key: "hero" } : { w: 512, h: 512, key: "moodboard" });
            if (toHero) project.hero.push(asset); else project.images.unshift(asset);
            save();
          } catch { /* toast déjà affiché ; on continue */ }
          ph?.remove();
          if (toHero) renderHero(); else renderGrid("images", $("#mb-grid"), { cls: "tile", w: 512, h: 512 });
        }
      }
    }
    setProg(1, "Terminé ✓");
    toast("Moodboard composé ✓");
    setTimeout(closeCompose, 700);
  } catch (e) {
    toast("Composition : " + ((e && e.message) || e), 4200);
  } finally {
    go.classList.remove("busy"); go.disabled = false;
  }
}
function openCompose() {
  $("#compose-theme").value = project.theme || "";
  $("#compose-progress").hidden = true;
  $("#cp-fill").style.width = "0%"; $("#cp-label").textContent = "";
  $("#compose-modal").hidden = false;
  $("#compose-theme").focus();
}
function closeCompose() { $("#compose-modal").hidden = true; }

// =====================================================================
//  Extraction palette depuis images (canvas)
// =====================================================================
function extractPalette() {
  const sources = [...project.hero, ...project.images];
  if (!sources.length) { toast("Ajoute d'abord des images au moodboard."); return; }
  const buckets = new Map();
  let pending = sources.length;
  const finish = () => {
    if (--pending > 0) return;
    const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => {
      const [r, g, b] = k.split(",").map(Number);
      return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    });
    if (top.length) { project.palette = top; save(); renderPalette(); toast("Palette extraite ✓"); }
  };
  sources.forEach(async (src) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        const w = (c.width = 48), h = (c.height = 48);
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          const key = [data[i], data[i + 1], data[i + 2]].map((v) => Math.round(v / 48) * 48).join(",");
          buckets.set(key, (buckets.get(key) || 0) + 1);
        }
      } catch { /* cross-origin : ignorée */ }
      finish();
    };
    img.onerror = finish;
    const url = await resolveImageSrc(src).catch(() => "");
    if (url) img.src = url;
    else finish();
  });
}

// =====================================================================
//  Export / partage / statut
// =====================================================================
function exportProject() {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slugify(project.title)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Moodboard exporté (JSON)");
}
function shareSummary() {
  const txt = [
    `Moodboard — ${project.title}`, project.tags, "", "Brief :", project.brief, "",
    "Palette : " + project.palette.join("  "), `Typographie : ${project.font}`,
  ].join("\n");
  navigator.clipboard?.writeText(txt).then(() => toast("Résumé copié"), () => toast("Copie impossible"));
}

async function refreshStatus() {
  // Texte (Ollama).
  const text = $("#chip-text");
  try {
    await ollamaGetJson("api/tags", ollamaUrl());
    text.className = "ai-chip " + (ollamaModel() ? "ok" : "off");
    text.title = ollamaModel() ? `Modèle : ${ollamaModel()}` : "Choisis un modèle dans Lumen";
  } catch { text.className = "ai-chip off"; text.title = "Ollama injoignable"; }
  // Image (Bonsai).
  const img = $("#chip-image");
  if (!hasTauriInvoke()) { img.className = "ai-chip off"; img.title = "Hors application"; return; }
  try {
    const s = await tauriInvoke("bonsai_status");
    img.className = "ai-chip " + (s.running ? "ok" : "off");
    img.title = s.running ? "API Bonsai active" : "Bonsai arrêté (Réglages)";
  } catch { img.className = "ai-chip off"; img.title = "Bonsai indisponible"; }
}

// =====================================================================
//  Assistant IA (boîte de prompt partagée)
// =====================================================================
// La direction artistique au prompt : rédiger le brief, poser une palette,
// générer des visuels, changer de projet. Les images passent par le moteur
// d'image configuré (Bonsai / Ollama / API) via aiImage.
const MOODBOARD_TOOLS = [
  tool("describe_project", "État du projet courant : titre, tags, brief, accroche, police, palette, nombre d'images.", {}),
  tool("set_direction", "Écrit la direction artistique : titre, tags, brief, accroche, police. Ne passe que ce que tu veux changer.",
    { title: T.str(""), tags: T.str("3 mots séparés par ' · '"), brief: T.str("3 à 5 phrases"),
      quote: T.str("Accroche de 2 à 4 mots"), font: T.str("Nom de police") }),
  tool("set_palette", "Pose la palette de couleurs (5 codes hexadécimaux).", { colors: T.list("Codes #rrggbb") }, ["colors"]),
  tool("generate_images", "Génère des visuels à partir de prompts en anglais et les place dans le moodboard.",
    { prompts: T.list("Prompts d'image, en anglais, style cohérent"), hero: T.bool("Placer les deux premiers en bandeau (défaut : oui)") },
    ["prompts"]),
  tool("clear_images", "Vide les images du moodboard (bandeau et galerie).", {}),
  tool("list_projects", "Liste les moodboards existants.", {}),
  tool("new_project", "Crée un nouveau moodboard vierge et l'ouvre.", { title: T.str("Titre") }),
  tool("open_project", "Ouvre un moodboard existant.", { project: T.str("Titre ou identifiant") }, ["project"]),
];

async function runMoodboardTool(name, a) {
  switch (name) {
    case "describe_project":
      return `Titre : ${project.title}\nTags : ${project.tags}\nPolice : ${project.font}\nPalette : ${project.palette.join(", ")}\n`
        + `Accroche : ${String(project.quote || "").replace(/\n/g, " / ")}\nBrief : ${project.brief}\n`
        + `Images : ${project.hero.length} bandeau + ${project.images.length} galerie`;
    case "set_direction": {
      const changed = [];
      for (const k of ["title", "tags", "brief", "quote", "font"]) {
        if (a[k] != null && String(a[k]).trim()) { project[k] = String(a[k]); changed.push(k); }
      }
      if (!changed.length) throw new Error("aucun champ fourni.");
      return `Direction mise à jour : ${changed.join(", ")}.`;
    }
    case "set_palette": {
      const hexes = (a.colors || []).map((c) => String(c).trim())
        .map((c) => (c[0] === "#" ? c : "#" + c)).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 5);
      if (!hexes.length) throw new Error("aucune couleur valide (format #rrggbb).");
      project.palette = hexes;
      return `Palette : ${hexes.join(", ")}`;
    }
    case "generate_images": {
      if (!hasTauriInvoke()) return "Génération d'images indisponible hors de l'app Lumen.";
      const prompts = (a.prompts || []).map(String).slice(0, 8);
      if (!prompts.length) throw new Error("fournis au moins un prompt.");
      const useHero = a.hero !== false;
      const done = [];
      for (let i = 0; i < prompts.length; i += 1) {
        const toHero = useHero && i < 2 && project.hero.length < 2;
        try {
          const asset = await aiImage(prompts[i], toHero ? { w: 768, h: 512, key: "hero" } : { w: 512, h: 512, key: "moodboard" });
          if (toHero) project.hero.push(asset); else project.images.unshift(asset);
          done.push(prompts[i].slice(0, 40));
          save();
          renderAll();
        } catch (e) { done.push(`échec (${e?.message || e})`); }
      }
      return `${done.length} visuel(s) : ${done.join(" · ")}`;
    }
    case "clear_images": { project.hero = []; project.images = []; return "Images retirées."; }
    case "list_projects":
      return library.order.map((id) => `${id}${id === library.current ? " (courant)" : ""} · ${(readProject(id)?.title) || "Sans titre"}`).join("\n") || "Aucun projet.";
    case "new_project": {
      newProject();
      if (a.title) project.title = String(a.title);
      return `Nouveau moodboard « ${project.title} » créé.`;
    }
    case "open_project": {
      const ref = String(a.project || "").toLowerCase();
      const id = library.order.find((x) => x === a.project)
        || library.order.find((x) => String(readProject(x)?.title || "").toLowerCase().includes(ref));
      if (!id) throw new Error("moodboard introuvable ; appelle list_projects.");
      openProject(id);
      return `Ouvert : « ${project.title} »`;
    }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountMoodboardAI() {
  mountAiPrompt(null, {
    app: "Moodboard",
    intro: "Tu es le directeur artistique : brief, palette, typographie, visuels.",
    rules: "- Écris toi-même les textes (brief, accroche) et passe-les dans set_direction.\n- Les prompts d'image sont en anglais, descriptifs, et partagent un style cohérent.\n- Pose la palette AVANT de générer les visuels, pour qu'ils s'y accordent.",
    placeholder: "Ex. : compose un moodboard « escapade nordique minimaliste »…",
    suggestions: [
      { label: "Composer", prompt: "Compose un moodboard complet sur un thème que je vais te donner : direction, palette, puis 4 visuels." },
      { label: "Rédiger le brief", prompt: "Rédige un brief créatif convaincant à partir du titre et des tags actuels." },
      { label: "Palette", prompt: "Propose et pose une palette de 5 couleurs cohérente avec le brief." },
      { label: "Plus de visuels", prompt: "Génère 3 visuels supplémentaires dans le style déjà posé." },
    ],
    tools: MOODBOARD_TOOLS,
    context: () => `Projet « ${project.title} » — tags : ${project.tags} — palette : ${project.palette.join(", ")} — `
      + `${project.hero.length + project.images.length} image(s).\nBrief : ${String(project.brief || "").slice(0, 400)}`,
    execute: runMoodboardTool,
    onApplied: () => { save(); renderAll(); },
  });
}

// =====================================================================
//  Init
// =====================================================================
async function init() {
  // Reprend les anciennes clés localStorage du moodboard, puis les efface.
  await store.ready({ migrate: (k) => k === LIB_KEY || k === "moodboardProject" || k.startsWith(PROJ_PREFIX) });
  loadLibrary();
  renderAll();
  // Projet existant chargé d'une version antérieure : ses images base64 partent
  // dans la sandbox dès l'ouverture, ce qui rend au stockage la place qu'elles
  // occupaient (et que les autres apps ne pouvaient plus utiliser).
  scheduleOffload();
  mountMoodboardAI();
  // « Envoyer vers Planche » : une image rejoint la galerie, un texte le brief.
  receive("moodboard", async (obj) => {
    if (obj.kind === "image") {
      // Photos envoie une vignette (dataUrl) ; d'autres n'envoient que le
      // chemin. Sans cette lecture, l'image était silencieusement ignorée.
      let src = obj.dataUrl || "";
      if (!src && obj.path && obj.sandboxId) {
        try {
          const b64 = await tauriInvoke("sandbox_read_b64", { id: obj.sandboxId, path: obj.path });
          const ext = (obj.path.split(".").pop() || "png").toLowerCase();
          const mime = { jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }[ext] || "image/png";
          src = `data:${mime};base64,${b64}`;
        } catch (e) { console.warn("[planche] image illisible", e); }
      }
      if (!src) return;
      project.images.unshift(src);
      save();
      renderGrid("images", $("#mb-grid"), { cls: "tile", w: 512, h: 512 });
      return;
    }
    const text = toText(obj).trim();
    if (!text) return;
    project.brief = (project.brief ? project.brief + "\n\n" : "") + text;
    $("#brief").value = project.brief;
    save();
  });
  refreshStatus();
  setInterval(refreshStatus, 15000);

  // Navigation latérale.
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => {
    $$(".nav-item").forEach((n) => n.classList.remove("active"));
    item.classList.add("active");
    document.getElementById(item.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  // Champs éditables.
  $("#proj-title").addEventListener("input", (e) => { project.title = e.target.value; save(); renderProjects(); });
  $("#proj-tags").addEventListener("input", (e) => { project.tags = e.target.value; save(); });
  $("#brief").addEventListener("input", (e) => { project.brief = e.target.value; save(); });
  $("#font-name").addEventListener("input", (e) => { project.font = e.target.value || "Satoshi"; renderType(); save(); });

  // IA par objet.
  $("#ai-brief").addEventListener("click", (e) => genBrief(e.currentTarget));
  $("#ai-palette").addEventListener("click", (e) => genPalette(e.currentTarget));
  $("#ai-type").addEventListener("click", (e) => genType(e.currentTarget));

  // Collections : import & IA via en-têtes.
  $$("[data-import]").forEach((b) => b.addEventListener("click", async () => {
    const key = b.dataset.import;
    const urls = await pickImages();
    if (!urls.length) return;
    await importUrlsIntoCollection(key, urls);
  }));
  $$("[data-ai-image]").forEach((b) => b.addEventListener("click", () => openImageModal(b.dataset.aiImage, null, DIMS_OF[b.dataset.aiImage])));

  // Palette manuelle.
  $("#btn-extract").addEventListener("click", extractPalette);
  $("#btn-add-swatch").addEventListener("click", () => { project.palette.push("#888888"); save(); renderPalette(); });

  // Projets.
  $("#btn-new-project").addEventListener("click", newProject);

  // Topbar.
  $("#btn-compose").addEventListener("click", openCompose);
  $("#btn-export").addEventListener("click", exportProject);
  // Espace Création : projets, versions et exports communs aux éditeurs.
  mountCreativeBar($("#creative-bar"), {
    app: "moodboard",
    current: () => (library.current ? { ref: library.current, title: project.title || "Planche" } : null),
    serialize: () => JSON.stringify(project),
    restore: (content) => { project = { ...structuredClone(DEFAULT), ...JSON.parse(content) }; save(); renderAll(); },
    exportDoc: () => ({
      title: project.title || "Planche",
      markdown: [project.tags && `*${project.tags}*`, project.brief, project.quote && `> ${String(project.quote).replace(/\n/g, " ")}`,
        (project.palette || []).length ? `## Palette\n${project.palette.map((c) => `- ${c}`).join("\n")}` : "",
        project.font ? `## Typographie\n- ${project.font}` : ""].filter(Boolean).join("\n\n"),
      json: project,
    }),
    formats: ["md", "html", "pdf", "json"],
    toast,
  });
  $("#btn-share").addEventListener("click", shareSummary);
  // Lightbox.
  $("#lb-close").addEventListener("click", closePreview);
  $("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closePreview(); });

  // Modale import sandbox.
  $("#sb-close").addEventListener("click", () => sbFinish([]));
  $("#sb-cancel").addEventListener("click", () => sbFinish([]));
  $("#sb-import").addEventListener("click", () => sbFinish([...(sbState ? sbState.selected.values() : [])]));
  $("#sb-modal").addEventListener("click", (e) => { if (e.target.id === "sb-modal") sbFinish([]); });
  $("#sb-select").addEventListener("change", (e) => { if (sbState) { sbState.id = e.target.value; sbState.cwd = ""; sbState.selected.clear(); sbBrowse(); } });

  // Modale compose.
  $("#compose-go").addEventListener("click", composeBoard);
  $("#compose-cancel").addEventListener("click", closeCompose);
  $("#compose-close").addEventListener("click", closeCompose);
  $("#compose-modal").addEventListener("click", (e) => { if (e.target.id === "compose-modal") closeCompose(); });

  // Modale image.
  $("#img-go").addEventListener("click", runImageModal);
  $("#img-cancel").addEventListener("click", closeImageModal);
  $("#img-close").addEventListener("click", closeImageModal);
  $("#img-modal").addEventListener("click", (e) => { if (e.target.id === "img-modal") closeImageModal(); });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeCompose(); closeImageModal(); closePreview(); if (sbState) sbFinish([]); } });
}

document.addEventListener("DOMContentLoaded", init);

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
