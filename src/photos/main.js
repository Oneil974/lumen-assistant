// Photos — logique front. Modèle : { sandboxes: [{id,name}], images: [...] } où
// chaque image = { key, sandboxId, sandbox, path, name, folder, size, created,
// modified, width, height }. Les vignettes sont demandées paresseusement
// (IntersectionObserver → sandbox_image_thumb, 4 requêtes en vol) et gardées en
// mémoire ; les favoris vivent dans le magasin de l'app (clé « sandbox|path »).

import { autoTranslate, tt } from "../apps-i18n.js";
import { createStore } from "../lib/app-state.js";
import { makeObject } from "../lib/interop.js";
import { share } from "../lib/share-menu.js";

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const { listen } = __TAURI.event || {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const store = createStore("photos");
const FAV_KEY = "photos.favorites";
let favorites = new Set();
const DAY = 86_400_000;

const state = { sandboxes: [], images: [], view: "all", sandbox: null, folder: "", query: "", sort: "date", selecting: false, selected: new Set() };
const thumbs = new Map();       // key → data URL
const pendingThumb = new Map(); // key → Promise
let viewerList = [];            // images visibles au moment de l'ouverture
let viewerIndex = -1;

const fmtSize = (n) => n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(0)} Ko` : `${(n / 1048576).toFixed(1)} Mo`;
const fmtDate = (s) => new Date(s * 1000).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const monthKey = (s) => { const d = new Date(s * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const monthLabel = (k) => new Date(Number(k.slice(0, 4)), Number(k.slice(5)) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const PALETTE = ["#7867d8", "#2aa876", "#ff9f0a", "#ff5e8a", "#3b9cff", "#d8a31f", "#c75cff", "#20b2aa"];
const colorOf = (id) => PALETTE[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2400); }

// ===== Chargement =====
async function load() {
  if (!invoke) { $("count").textContent = tt("Hors de Lumen : aucune donnée."); renderNav(); renderGrid(); return; }
  let list = [];
  try { list = await invoke("sandbox_list"); } catch (e) { toast(String(e?.message || e)); }
  state.sandboxes = (Array.isArray(list) ? list : []).map((s) => ({ id: s.id, name: s.name }));
  const images = [];
  await Promise.all(state.sandboxes.map(async (sb) => {
    let entries = [];
    try { entries = await invoke("sandbox_list_images", { id: sb.id }); } catch { entries = []; }
    for (const e of entries || []) images.push({ ...e, key: `${sb.id}|${e.path}`, sandboxId: sb.id, sandbox: sb.name });
  }));
  state.images = images;
  if (state.view === "sandbox" && !state.sandboxes.some((s) => s.id === state.sandbox)) { state.view = "all"; state.sandbox = null; }
  renderNav(); renderGrid();
}

// ===== Sélection courante =====
function visible() {
  const q = state.query.trim().toLowerCase();
  const now = Date.now() / 1000;
  let list = state.images.filter((im) => {
    if (state.view === "sandbox" && im.sandboxId !== state.sandbox) return false;
    if (state.view === "sandbox" && state.folder && im.folder !== state.folder && !im.folder.startsWith(state.folder + "/")) return false;
    if (state.view === "recent" && now - im.created > 7 * 86400) return false;
    if (state.view === "favorites" && !favorites.has(im.key)) return false;
    if (q && !im.name.toLowerCase().includes(q) && !im.path.toLowerCase().includes(q) && !im.sandbox.toLowerCase().includes(q)) return false;
    return true;
  });
  const cmp = { date: (a, b) => b.created - a.created, "date-asc": (a, b) => a.created - b.created, name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => b.size - a.size }[state.sort];
  return list.sort(cmp);
}

// ===== Rendu : navigation =====
const ICON = {
  all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L6 21"/></svg>',
  recent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  fav: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A4.5 4.5 0 0 0 12 6a4.5 4.5 0 0 0-10 2.5C2 10.8 3.5 12.5 5 14l7 7z"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L6 21"/></svg>',
};
function navItem(host, { id, label, icon, dot, n, on, onClick }) {
  const b = document.createElement("button");
  b.className = "nav-item" + (on ? " on" : "");
  b.innerHTML = `${dot ? `<span class="nav-dot" style="--dot:${dot}"></span>` : icon}<span class="lbl"></span><span class="n">${n ?? ""}</span>`;
  b.querySelector(".lbl").textContent = label;
  b.addEventListener("click", onClick);
  host.appendChild(b);
}
function renderNav() {
  const lib = $("nav-library"); lib.innerHTML = "";
  const now = Date.now() / 1000;
  navItem(lib, { label: tt("Toutes les images"), icon: ICON.all, n: state.images.length, on: state.view === "all", onClick: () => setView("all") });
  navItem(lib, { label: tt("Récentes"), icon: ICON.recent, n: state.images.filter((im) => now - im.created <= 7 * 86400).length, on: state.view === "recent", onClick: () => setView("recent") });
  navItem(lib, { label: tt("Favoris"), icon: ICON.fav, n: state.images.filter((im) => favorites.has(im.key)).length, on: state.view === "favorites", onClick: () => setView("favorites") });
  const sb = $("nav-sandboxes"); sb.innerHTML = "";
  if (!state.sandboxes.length) sb.innerHTML = `<div class="side-foot">${esc(tt("Aucune sandbox."))}</div>`;
  for (const s of state.sandboxes) {
    navItem(sb, { label: s.name, dot: colorOf(s.id), n: state.images.filter((im) => im.sandboxId === s.id).length, on: state.view === "sandbox" && state.sandbox === s.id, onClick: () => setView("sandbox", s.id) });
  }
  const total = state.images.reduce((a, im) => a + im.size, 0);
  $("side-foot").textContent = tt("{n} image(s) · {s}", { n: state.images.length, s: fmtSize(total) });
}
function setView(view, sandbox = null) {
  state.view = view; state.sandbox = sandbox; state.folder = "";
  $("grid").scrollTop = 0;
  renderNav(); renderGrid();
}

// ===== Rendu : grille =====
function renderGrid() {
  const host = $("grid");
  host.innerHTML = "";
  host.classList.toggle("selecting", state.selecting);
  const sbName = state.view === "sandbox" ? state.sandboxes.find((s) => s.id === state.sandbox)?.name || "" : "";
  $("title").textContent = { all: tt("Toutes les images"), recent: tt("Récentes"), favorites: tt("Favoris"), sandbox: sbName }[state.view];
  // Sous-dossiers de la sandbox : pastilles de filtrage.
  const folders = $("folders"); folders.innerHTML = "";
  if (state.view === "sandbox") {
    const set = new Set(state.images.filter((im) => im.sandboxId === state.sandbox && im.folder).map((im) => im.folder.split("/")[0]));
    if (set.size) {
      for (const f of ["", ...[...set].sort()]) {
        const c = document.createElement("button"); c.className = "chip" + (state.folder === f ? " on" : ""); c.textContent = f || tt("Tout");
        c.addEventListener("click", () => { state.folder = f; renderGrid(); });
        folders.appendChild(c);
      }
    }
  }
  const list = visible();
  $("count").textContent = list.length ? tt("{n} image(s)", { n: list.length }) : "";
  if (!list.length) {
    host.innerHTML = `<div class="empty">${ICON.image}<b>${esc(state.images.length ? tt("Aucune image ici.") : tt("Aucune image dans vos sandboxes."))}</b><span>${esc(state.images.length ? tt("Change de vue ou de filtre.") : tt("Les images générées par le Studio, importées ou produites par vos agents apparaîtront ici, rangées par sandbox."))}</span></div>`;
    return;
  }
  const byMonth = new Map();
  const grouped = state.sort === "date" || state.sort === "date-asc";
  for (const im of list) { const k = grouped ? monthKey(im.created) : "all"; if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(im); }
  for (const [k, items] of byMonth) {
    const sec = document.createElement("section"); sec.className = "month";
    if (grouped) sec.innerHTML = `<div class="month-head"><b>${esc(monthLabel(k))}</b><span>${items.length}</span></div>`;
    const tiles = document.createElement("div"); tiles.className = "tiles";
    for (const im of items) tiles.appendChild(tile(im));
    sec.appendChild(tiles); host.appendChild(sec);
  }
}

const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); loadThumb(e.target); }
}, { root: null, rootMargin: "300px" }) : null;

function tile(im) {
  const el = document.createElement("div");
  el.className = "tile" + (state.selected.has(im.key) ? " selected" : "");
  el.dataset.key = im.key;
  el.innerHTML = `<div class="ph">${ICON.image}</div><img alt="" loading="lazy" /><span class="check">✓</span><button class="heart${favorites.has(im.key) ? " on" : ""}" title="${esc(tt("Favori"))}">${favorites.has(im.key) ? "♥" : "♡"}</button><span class="cap"></span>`;
  el.querySelector(".cap").textContent = state.view === "sandbox" ? im.name : `${im.sandbox} · ${im.name}`;
  el.querySelector(".heart").addEventListener("click", (e) => { e.stopPropagation(); toggleFav(im); });
  el.addEventListener("click", () => {
    if (state.selecting) { toggleSelect(im.key); return; }
    openViewer(im);
  });
  el._im = im;
  if (thumbs.has(im.key)) setThumb(el, thumbs.get(im.key)); else if (observer) observer.observe(el); else loadThumb(el);
  return el;
}
function setThumb(el, url) { const img = el.querySelector("img"); img.src = url; img.onload = () => img.classList.add("ready"); el.querySelector(".ph")?.remove(); }

// File d'attente : 4 vignettes en vol, sinon 300 requêtes partent d'un coup.
const queue = []; let inflight = 0;
function loadThumb(el) { queue.push(el); pump(); }
function pump() {
  while (inflight < 4 && queue.length) {
    const el = queue.shift(); const im = el._im;
    if (!im || !el.isConnected) continue;
    inflight++;
    thumbOf(im).then((url) => { if (url && el.isConnected) setThumb(el, url); }).finally(() => { inflight--; pump(); });
  }
}
function thumbOf(im) {
  if (thumbs.has(im.key)) return Promise.resolve(thumbs.get(im.key));
  if (pendingThumb.has(im.key)) return pendingThumb.get(im.key);
  const p = (invoke ? invoke("sandbox_image_thumb", { id: im.sandboxId, path: im.path, maxPx: 360 }) : Promise.resolve(""))
    .then((url) => { thumbs.set(im.key, url); return url; })
    .catch(() => "")
    .finally(() => pendingThumb.delete(im.key));
  pendingThumb.set(im.key, p);
  return p;
}

// ===== Favoris & sélection =====
function loadFavs() { try { favorites = new Set(JSON.parse(store.get(FAV_KEY) || "[]")); } catch { favorites = new Set(); } }
function saveFavs() { store.set(FAV_KEY, JSON.stringify([...favorites])); }
function toggleFav(im, force = null) {
  const on = force == null ? !favorites.has(im.key) : force;
  if (on) favorites.add(im.key); else favorites.delete(im.key);
  saveFavs();
  document.querySelectorAll(`.tile[data-key="${CSS.escape(im.key)}"] .heart`).forEach((h) => { h.classList.toggle("on", on); h.textContent = on ? "♥" : "♡"; });
  if (state.view === "favorites") renderGrid(); else renderNav();
  if (viewerIndex >= 0 && viewerList[viewerIndex]?.key === im.key) { $("v-fav").classList.toggle("on", on); $("v-fav").textContent = on ? "♥" : "♡"; }
}
function setSelecting(on) {
  state.selecting = on; if (!on) state.selected.clear();
  $("btn-select").classList.toggle("on", on); $("bulk").hidden = !on;
  renderGrid(); updateBulk();
}
function toggleSelect(key) {
  if (state.selected.has(key)) state.selected.delete(key); else state.selected.add(key);
  document.querySelector(`.tile[data-key="${CSS.escape(key)}"]`)?.classList.toggle("selected", state.selected.has(key));
  updateBulk();
}
function updateBulk() { $("bulk-count").textContent = tt("{n} sélectionnée(s)", { n: state.selected.size }); }
const selectedImages = () => state.images.filter((im) => state.selected.has(im.key));

// ===== Actions =====
function confirmDialog(title, text) {
  return new Promise((resolve) => {
    $("c-title").textContent = title; $("c-text").textContent = text; $("confirm").hidden = false;
    const done = (v) => { $("confirm").hidden = true; $("c-yes").onclick = $("c-no").onclick = null; resolve(v); };
    $("c-yes").onclick = () => done(true); $("c-no").onclick = () => done(false);
  });
}
async function exportImages(list) {
  let n = 0;
  for (const im of list) { try { await invoke("sandbox_export_file", { id: im.sandboxId, path: im.path }); n++; } catch (e) { toast(String(e?.message || e)); } }
  if (n) toast(tt("{n} image(s) copiée(s) dans Téléchargements.", { n }));
}
async function deleteImages(list) {
  if (!list.length) return false;
  const ok = await confirmDialog(tt("Supprimer {n} image(s) ?", { n: list.length }), tt("Le fichier est retiré de sa sandbox. Cette action ne peut pas être annulée."));
  if (!ok) return false;
  for (const im of list) {
    try { await invoke("sandbox_delete_path", { id: im.sandboxId, path: im.path }); favorites.delete(im.key); thumbs.delete(im.key); }
    catch (e) { toast(String(e?.message || e)); }
  }
  saveFavs();
  await load();
  return true;
}
async function shareImage(im) {
  const url = thumbs.get(im.key) || await thumbOf(im);
  try { await share(makeObject("image", { title: im.name, path: im.path, sandboxId: im.sandboxId, dataUrl: url }, { app: "photos", title: "Photos" })); }
  catch (e) { toast(String(e?.message || e)); }
}

// ===== Visionneuse =====
function openViewer(im) {
  viewerList = visible();
  viewerIndex = Math.max(0, viewerList.findIndex((x) => x.key === im.key));
  $("viewer").hidden = false;
  showViewer();
}
async function showViewer() {
  const im = viewerList[viewerIndex]; if (!im) return closeViewer();
  $("v-name").textContent = `${im.name}  ·  ${viewerIndex + 1}/${viewerList.length}`;
  $("v-fav").classList.toggle("on", favorites.has(im.key)); $("v-fav").textContent = favorites.has(im.key) ? "♥" : "♡";
  const img = $("v-img");
  img.src = thumbs.get(im.key) || ""; // aperçu immédiat, l'image pleine suit
  $("v-loading").hidden = false; $("v-loading").textContent = tt("Chargement…");
  const wanted = im.key;
  try {
    const full = await invoke("sandbox_read_image_b64", { id: im.sandboxId, path: im.path, maxPx: 2560 });
    if (viewerList[viewerIndex]?.key === wanted) img.src = full;
  } catch (e) { if (!img.src) $("v-loading").textContent = String(e?.message || e); }
  finally { if (viewerList[viewerIndex]?.key === wanted) $("v-loading").hidden = true; }
  renderViewerSide(im);
  renderStrip();
}
function renderViewerSide(im) {
  const side = $("v-side");
  side.innerHTML = `<b>${esc(tt("Informations"))}</b><dl>
    <dt>${esc(tt("Nom"))}</dt><dd></dd><dt>${esc(tt("Sandbox"))}</dt><dd></dd><dt>${esc(tt("Dossier"))}</dt><dd></dd>
    <dt>${esc(tt("Dimensions"))}</dt><dd>${im.width && im.height ? `${im.width} × ${im.height}` : "—"}</dd>
    <dt>${esc(tt("Poids"))}</dt><dd>${esc(fmtSize(im.size))}</dd><dt>${esc(tt("Créée"))}</dt><dd>${esc(fmtDate(im.created))}</dd><dt>${esc(tt("Modifiée"))}</dt><dd>${esc(fmtDate(im.modified))}</dd></dl>`;
  const dds = side.querySelectorAll("dd");
  dds[0].textContent = im.name; dds[1].textContent = im.sandbox; dds[2].textContent = im.folder || "/";
}
function renderStrip() {
  const strip = $("v-strip"); strip.innerHTML = "";
  const from = Math.max(0, viewerIndex - 8), to = Math.min(viewerList.length, viewerIndex + 9);
  for (let i = from; i < to; i++) {
    const im = viewerList[i]; const img = document.createElement("img");
    img.className = i === viewerIndex ? "on" : ""; img.alt = "";
    thumbOf(im).then((u) => { if (u) img.src = u; });
    img.addEventListener("click", () => { viewerIndex = i; showViewer(); });
    strip.appendChild(img);
  }
}
function closeViewer() { $("viewer").hidden = true; viewerIndex = -1; $("v-img").src = ""; }
function stepViewer(d) { if (!viewerList.length) return; viewerIndex = (viewerIndex + d + viewerList.length) % viewerList.length; showViewer(); }

// ===== Câblage =====
function wire() {
  $("search").addEventListener("input", (e) => { state.query = e.target.value; renderGrid(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
  $("zoom").addEventListener("input", (e) => { $("grid").style.setProperty("--tile", `${e.target.value}px`); try { localStorage.setItem("photos.tile", e.target.value); } catch {} });
  try { const z = localStorage.getItem("photos.tile"); if (z) { $("zoom").value = z; $("grid").style.setProperty("--tile", `${z}px`); } } catch {}
  $("btn-select").addEventListener("click", () => setSelecting(!state.selecting));
  $("btn-refresh").addEventListener("click", () => load());
  $("bulk").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-bulk]")?.dataset.bulk; if (!act) return;
    const list = selectedImages();
    if (act === "cancel") return setSelecting(false);
    if (!list.length) return toast(tt("Aucune image sélectionnée."));
    if (act === "fav") { const on = !list.every((im) => favorites.has(im.key)); for (const im of list) toggleFav(im, on); }
    if (act === "export") await exportImages(list);
    if (act === "delete") { if (await deleteImages(list)) setSelecting(false); }
  });
  $("v-close").addEventListener("click", closeViewer);
  $("v-prev").addEventListener("click", () => stepViewer(-1));
  $("v-next").addEventListener("click", () => stepViewer(1));
  $("v-fav").addEventListener("click", () => { const im = viewerList[viewerIndex]; if (im) toggleFav(im); });
  $("v-info").addEventListener("click", () => { $("v-side").hidden = !$("v-side").hidden; $("v-info").classList.toggle("on", !$("v-side").hidden); });
  $("v-share").addEventListener("click", () => { const im = viewerList[viewerIndex]; if (im) shareImage(im); });
  $("v-export").addEventListener("click", () => { const im = viewerList[viewerIndex]; if (im) exportImages([im]); });
  $("v-delete").addEventListener("click", async () => { const im = viewerList[viewerIndex]; if (!im) return; if (await deleteImages([im])) { viewerList.splice(viewerIndex, 1); if (!viewerList.length) closeViewer(); else { viewerIndex = Math.min(viewerIndex, viewerList.length - 1); showViewer(); } } });
  $("viewer").addEventListener("click", (e) => { if (e.target === $("v-stage")) closeViewer(); });
  document.addEventListener("keydown", (e) => {
    if ($("viewer").hidden) { if (e.key === "Escape" && state.selecting) setSelecting(false); return; }
    if (e.key === "Escape") closeViewer();
    if (e.key === "ArrowLeft") stepViewer(-1);
    if (e.key === "ArrowRight") stepViewer(1);
    if (e.key === "i") $("v-info").click();
    if (e.key === "f") $("v-fav").click();
  });
  // Pas d'évènement « sandbox modifiée » côté backend : on relit au retour
  // sur la fenêtre (le Studio vient de générer une image, un agent a écrit…).
  let lastLoad = Date.now();
  window.addEventListener("focus", () => { if (Date.now() - lastLoad > 15_000) { lastLoad = Date.now(); load(); } });
  void listen;
}

autoTranslate({ observe: true });
wire();
Promise.resolve(store.ready?.()).catch(() => {}).then(() => { loadFavs(); load(); });
