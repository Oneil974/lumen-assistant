// Atelier ML › Vision (YOLO) : étiqueter des images et détecter des objets.
//
// - Images : celles d'une sandbox (`sandbox_list_images`), filtrées par dossier ;
//   « Importer » les copie dans `Vision/images/`.
// - Étiquetage : boîtes tracées à la souris sur un calque SVG en coordonnées
//   NORMALISÉES [0..1] (viewBox 0 0 1 1) — indépendantes de la taille affichée
//   et directement celles du format YOLO.
// - Annotations : un seul fichier par sandbox, `Vision/annotations.json`
//   ({ classes, images: { chemin: [{ c, x1, y1, x2, y2 }] } }), qui voyage avec
//   les images.
// - Détection : modèles libres exécutés localement dans un worker
//   (lib/detection-worker.js) ; leurs boîtes arrivent en suggestions, qu'on
//   accepte d'un clic (la classe est créée si besoin).
// - Export : dataset YOLO (images/ et labels/ en train/val, data.yaml, train.py).
//   Les images sont réencodées en JPEG ≤ 2560 px : exactement l'image annotée.

import { tt, registerTranslations } from "../apps-i18n.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SVGNS = "http://www.w3.org/2000/svg";
const ANN_PATH = "Vision/annotations.json";
const IMPORT_DIR = "Vision/images";
const MIN_SIZE = 0.004;

// Modèles VÉRIFIÉS avec transformers.js 3.4 (D-FINE et YOLOv9/GELAN échouent ou
// demandent un post-traitement à part). Licence = celle des poids d'origine.
const MODELS = [
  { id: "onnx-community/yolov10n", kind: "yolov10", label: "YOLOv10n — rapide", license: "AGPL-3.0" },
  { id: "onnx-community/yolov10s", kind: "yolov10", label: "YOLOv10s — plus précis", license: "AGPL-3.0" },
  { id: "onnx-community/yolov10m", kind: "yolov10", label: "YOLOv10m — précis, plus lourd", license: "AGPL-3.0" },
  { id: "onnx-community/rtdetr_r18vd", kind: "pipeline", label: "RT-DETR R18", license: "Apache-2.0" },
  { id: "onnx-community/rtdetr_r50vd", kind: "pipeline", label: "RT-DETR R50", license: "Apache-2.0" },
  { id: "Xenova/yolos-tiny", kind: "pipeline", label: "YOLOS tiny — lent", license: "Apache-2.0" },
  { id: "Xenova/detr-resnet-50", kind: "pipeline", label: "DETR ResNet-50 — lent", license: "Apache-2.0" },
  { id: "custom", kind: "", label: "Autre modèle (Hugging Face)…", license: "" },
];
const PALETTE = ["#ff453a", "#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#64d2ff", "#ffd60a", "#ff375f", "#5e5ce6", "#ac8e68"];

const S = {
  sandbox: "", images: [], folder: "", idx: -1,
  ann: { classes: [], images: {} },
  current: 0,               // index de la classe active
  sel: -1,                  // boîte sélectionnée
  suggestions: [],          // détections du modèle pour l'image affichée
  imgBlob: null,
  saveTimer: null,
};

// ===== Traductions ===========================================================
registerTranslations({
  "Vision (YOLO)": "Vision (YOLO)", "1 · Images": "1 · Images", "2 · Classes": "2 · Classes",
  "3 · Détection (modèles libres)": "3 · Detection (open models)", "4 · Exporter pour l'entraînement": "4 · Export for training",
  "Importer des images…": "Import images…", "Recharger": "Reload", "Image précédente (←)": "Previous image (←)", "Image suivante (→)": "Next image (→)",
  "Tout effacer": "Clear all", "Effacer toutes les boîtes de l'image": "Clear all boxes of this image",
  "Choisissez une sandbox contenant des images, ou importez-en.": "Choose a sandbox that contains images, or import some.",
  "Glissez sur l'image pour tracer une zone. Clic : sélectionner · glisser : déplacer · coins : redimensionner · Suppr : effacer · 1-9 : classe de la boîte sélectionnée et des suivantes · Échap : désélectionner · ← → : image.": "Drag on the image to draw a box. Click: select · drag: move · corners: resize · Delete: remove · 1-9: class of the selected box and the next ones · Esc: deselect · ← →: image.",
  "Nouvelle classe (ex. voiture)": "New class (e.g. car)", "Ajouter": "Add",
  "Identifiant Hugging Face (ONNX)": "Hugging Face identifier (ONNX)", "Famille DETR / RT-DETR / YOLOS": "DETR / RT-DETR / YOLOS family", "Famille YOLOv10": "YOLOv10 family",
  "Seuil de confiance": "Confidence threshold", "Détecter": "Detect", "Accepter les suggestions": "Accept suggestions",
  "Pré-annoter toutes les images sans boîte": "Pre-annotate every image without boxes",
  "Part de validation": "Validation share", "Inclure les images sans objet (exemples négatifs)": "Include images without objects (negative examples)",
  "Exporter au format YOLO": "Export in YOLO format",
  "Tous les dossiers": "All folders", "(racine)": "(root)", "Aucune sandbox": "No sandbox",
  "{n} images · {a} annotées · {b} boîtes": "{n} images · {a} annotated · {b} boxes",
  "Aucune image dans ce dossier.": "No image in this folder.",
  "Aucune classe : ajoutez-en une, ou acceptez des suggestions du modèle.": "No class: add one, or accept the model's suggestions.",
  "Supprimer la classe « {c} » et ses {n} boîtes ?": "Delete class “{c}” and its {n} boxes?",
  "Chargement du modèle…": "Loading the model…", "Téléchargement {f} : {p} %": "Downloading {f}: {p}%",
  "Modèle prêt : {m}": "Model ready: {m}", "Détection…": "Detecting…",
  "{n} objet(s) détecté(s) — cliquez une suggestion pour l'accepter.": "{n} object(s) detected — click a suggestion to accept it.",
  "Aucun objet au-dessus du seuil.": "No object above the threshold.",
  "Pré-annotation : {i}/{n}…": "Pre-annotating: {i}/{n}…", "Pré-annotation terminée : {b} boîtes sur {n} images.": "Pre-annotation done: {b} boxes on {n} images.",
  "Licence : {l}": "Licence: {l}", "Premier chargement : téléchargement du modèle (quelques Mo), puis hors ligne.": "First use: the model is downloaded (a few MB), then works offline.",
  "Rien à exporter : annotez au moins une image.": "Nothing to export: annotate at least one image.",
  "Export : {i}/{n} images…": "Export: {i}/{n} images…",
  "Dataset exporté dans {s} › {d} ({t} entraînement, {v} validation). Lancez train.py là où Python et ultralytics sont installés.": "Dataset exported to {s} › {d} ({t} training, {v} validation). Run train.py wherever Python and ultralytics are installed.",
  "Supprimer": "Delete", "Annuler": "Cancel", "Importées : {n}": "Imported: {n}",
  "YOLOv10n — rapide": "YOLOv10n — fast", "YOLOv10s — plus précis": "YOLOv10s — more accurate", "YOLOv10m — précis, plus lourd": "YOLOv10m — accurate, heavier",
  "RT-DETR R18": "RT-DETR R18", "RT-DETR R50": "RT-DETR R50", "YOLOS tiny — lent": "YOLOS tiny — slow", "DETR ResNet-50 — lent": "DETR ResNet-50 — slow",
  "Autre modèle (Hugging Face)…": "Other model (Hugging Face)…",
});

// ===== Utilitaires ===========================================================
const ROOT = ".";   // valeur du filtre « (racine) »
const color = (i) => PALETTE[i % PALETTE.length];
const visible = () => S.images.filter((im) => !S.folder || im.folder === S.folder || (S.folder === ROOT && !im.folder));
const boxesOf = (path) => (S.ann.images[path] ||= []);
const currentImage = () => visible()[S.idx];
function status(id, text) { const el = $(id); if (el) el.textContent = text || ""; }

function nextFrame() { return new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); }); }

async function confirmBox(message) {
  // confirm() est inopérant dans la webview : petite feuille maison.
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "v-confirm";
    el.innerHTML = `<div class="v-confirm-card"><p>${esc(message)}</p><div class="row gap"><button class="btn" data-a="0">${esc(tt("Annuler"))}</button><button class="btn primary" data-a="1">${esc(tt("Supprimer"))}</button></div></div>`;
    el.addEventListener("click", (e) => { const a = e.target.closest("[data-a]"); if (!a && e.target !== el) return; el.remove(); resolve(a?.dataset.a === "1"); });
    document.body.appendChild(el);
  });
}

// ===== Annotations (fichier de la sandbox) ===================================
async function loadAnnotations() {
  S.ann = { classes: [], images: {} };
  try {
    const f = await invoke("sandbox_read_file", { id: S.sandbox, path: ANN_PATH });
    const data = JSON.parse(f?.content || "{}");
    if (Array.isArray(data.classes)) S.ann.classes = data.classes.map(String);
    if (data.images && typeof data.images === "object") S.ann.images = data.images;
  } catch { /* pas encore d'annotations */ }
}

function saveSoon() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(async () => {
    // On ne garde que les images qui ont des boîtes : le fichier reste lisible.
    const images = Object.fromEntries(Object.entries(S.ann.images).filter(([, b]) => b.length));
    try {
      await invoke("sandbox_write_file", { id: S.sandbox, path: ANN_PATH, content: JSON.stringify({ version: 1, classes: S.ann.classes, images }, null, 1) });
    } catch (e) { console.warn("[vision] enregistrement", e); }
  }, 500);
  renderStats();
}

// ===== Images ================================================================
async function loadSandboxes() {
  const sel = $("v-sandbox");
  let list = [];
  try { list = (await invoke("sandbox_list")) || []; } catch {}
  sel.innerHTML = list.length ? list.map((sb) => `<option value="${esc(sb.id)}">${esc(sb.name || sb.id)}</option>`).join("") : `<option value="">${esc(tt("Aucune sandbox"))}</option>`;
  const saved = localStorage.getItem("mlVisionSandbox");
  S.sandbox = list.some((s) => s.id === saved) ? saved : (list[0]?.id || "");
  sel.value = S.sandbox;
  if (S.sandbox) await openSandbox();
}

async function openSandbox() {
  localStorage.setItem("mlVisionSandbox", S.sandbox);
  await loadAnnotations();
  await refreshImages();
}

async function refreshImages() {
  try { S.images = (await invoke("sandbox_list_images", { id: S.sandbox })) || []; } catch { S.images = []; }
  S.images.sort((a, b) => a.path.localeCompare(b.path));
  const folders = [...new Set(S.images.map((im) => im.folder))].sort();
  $("v-folder").innerHTML = `<option value="">${esc(tt("Tous les dossiers"))}</option>`
    + folders.map((f) => `<option value="${f ? esc(f) : ROOT}">${esc(f || tt("(racine)"))}</option>`).join("");
  if (S.folder && !folders.includes(S.folder === ROOT ? "" : S.folder)) S.folder = "";
  $("v-folder").value = S.folder;
  renderList();
  select(visible().length ? Math.max(0, Math.min(S.idx, visible().length - 1)) : -1);
}

function renderStats() {
  const imgs = visible();
  const annotated = imgs.filter((im) => (S.ann.images[im.path] || []).length).length;
  const boxes = imgs.reduce((n, im) => n + (S.ann.images[im.path] || []).length, 0);
  status("v-stats", tt("{n} images · {a} annotées · {b} boîtes", { n: imgs.length, a: annotated, b: boxes }));
  document.querySelectorAll("#v-list .v-item").forEach((el) => {
    const n = (S.ann.images[el.dataset.path] || []).length;
    el.querySelector(".v-count").textContent = n ? String(n) : "";
  });
}

const thumbs = new Map();
function renderList() {
  const box = $("v-list");
  const imgs = visible();
  if (!imgs.length) { box.innerHTML = `<div class="muted">${esc(tt("Aucune image dans ce dossier."))}</div>`; renderStats(); return; }
  box.innerHTML = imgs.map((im, i) => `<button class="v-item${i === S.idx ? " on" : ""}" data-i="${i}" data-path="${esc(im.path)}"><img alt="" /><span class="v-item-name">${esc(im.name)}</span><span class="v-count"></span></button>`).join("");
  box.querySelectorAll(".v-item").forEach((el) => el.addEventListener("click", () => select(Number(el.dataset.i))));
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      const path = en.target.dataset.path;
      const img = en.target.querySelector("img");
      if (thumbs.has(path)) { img.src = thumbs.get(path); continue; }
      invoke("sandbox_image_thumb", { id: S.sandbox, path, maxPx: 160 }).then((d) => { thumbs.set(path, d); img.src = d; }).catch(() => {});
    }
  }, { root: box });
  box.querySelectorAll(".v-item").forEach((el) => io.observe(el));
  renderStats();
}

async function select(i) {
  const imgs = visible();
  S.idx = i; S.sel = -1; S.suggestions = []; S.imgBlob = null;
  $("v-accept").disabled = true;
  document.querySelectorAll("#v-list .v-item").forEach((el) => el.classList.toggle("on", Number(el.dataset.i) === i));
  const im = imgs[i];
  $("v-empty").hidden = !!im;
  $("v-canvas").hidden = true;
  $("v-name").textContent = im ? im.path : "—";
  if (!im) return;
  document.querySelector(`#v-list .v-item[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  try {
    const dataUrl = await invoke("sandbox_read_image_b64", { id: S.sandbox, path: im.path, maxPx: 2560 });
    if (S.idx !== i) return;
    $("v-img").src = dataUrl;
    await $("v-img").decode().catch(() => {});
    if (S.idx !== i) return;
    $("v-canvas").hidden = false;
    fitCanvas();
    S.imgBlob = await (await fetch(dataUrl)).blob();
  } catch (e) {
    $("v-name").textContent = `${im.path} — ${e?.message || e}`;
  }
  draw();
}

// La zone de dessin épouse l'image affichée (contain) : le SVG a la même boîte.
function fitCanvas() {
  const img = $("v-img"), stage = $("v-stage"), canvas = $("v-canvas");
  if (!img.naturalWidth) return;
  const r = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
  canvas.style.width = `${Math.floor(img.naturalWidth * r)}px`;
  canvas.style.height = `${Math.floor(img.naturalHeight * r)}px`;
}

async function importFiles(files) {
  let n = 0;
  for (const f of files) {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });
    const safe = f.name.replace(/[^\w.\- ]+/g, "_");
    try { await invoke("sandbox_import_file", { id: S.sandbox, path: `${IMPORT_DIR}/${safe}`, dataB64: b64 }); n++; } catch (e) { console.warn("[vision] import", e); }
  }
  status("v-model-status", tt("Importées : {n}", { n }));
  await refreshImages();
}

// ===== Classes ===============================================================
function ensureClass(name) {
  const clean = String(name || "").trim();
  if (!clean) return -1;
  let i = S.ann.classes.findIndex((c) => c.toLowerCase() === clean.toLowerCase());
  if (i < 0) { S.ann.classes.push(clean); i = S.ann.classes.length - 1; renderClasses(); }
  return i;
}

function renderClasses() {
  const box = $("v-classes");
  if (!S.ann.classes.length) { box.innerHTML = `<div class="muted">${esc(tt("Aucune classe : ajoutez-en une, ou acceptez des suggestions du modèle."))}</div>`; return; }
  const counts = S.ann.classes.map(() => 0);
  for (const bs of Object.values(S.ann.images)) for (const b of bs) counts[b.c] = (counts[b.c] || 0) + 1;
  box.innerHTML = S.ann.classes.map((c, i) => `<div class="v-class${i === S.current ? " on" : ""}" data-i="${i}">
      <span class="v-dot" style="background:${color(i)}"></span><span class="v-key">${i < 9 ? i + 1 : ""}</span>
      <span class="v-cname">${esc(c)}</span><span class="v-ccount">${counts[i] || 0}</span>
      <button class="v-x" data-del="${i}" title="${esc(tt("Supprimer"))}">✕</button></div>`).join("");
  box.querySelectorAll(".v-class").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("[data-del]")) return;
    setClass(Number(el.dataset.i));
  }));
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    const i = Number(b.dataset.del);
    if (!(await confirmBox(tt("Supprimer la classe « {c} » et ses {n} boîtes ?", { c: S.ann.classes[i], n: counts[i] || 0 })))) return;
    S.ann.classes.splice(i, 1);
    for (const [p, bs] of Object.entries(S.ann.images)) {
      S.ann.images[p] = bs.filter((x) => x.c !== i).map((x) => (x.c > i ? { ...x, c: x.c - 1 } : x));
    }
    S.current = Math.min(S.current, Math.max(0, S.ann.classes.length - 1));
    renderClasses(); draw(); saveSoon();
  }));
}

function setClass(i) {
  if (i < 0 || i >= S.ann.classes.length) return;
  S.current = i;
  // Changer de classe avec une boîte sélectionnée la reclasse.
  const im = currentImage();
  if (im && S.sel >= 0) { boxesOf(im.path)[S.sel].c = i; saveSoon(); }
  renderClasses(); draw();
}

// ===== Dessin ================================================================
function el(tag, attrs, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

function draw() {
  const svg = $("v-svg");
  const labels = $("v-labels");
  svg.innerHTML = "";
  labels.innerHTML = "";
  const im = currentImage();
  if (!im) return;
  const W = $("v-canvas").clientWidth || 1, H = $("v-canvas").clientHeight || 1;
  const px = 1 / W, py = 1 / H;   // un pixel écran en unités normalisées
  // Étiquettes en HTML (positions en %) : du texte SVG dans un viewBox 0..1
  // étiré serait déformé.
  const tag = (x, y, text, cls, style = "") => {
    const d = document.createElement("span");
    d.className = `v-tag ${cls}`;
    d.style.cssText = `left:${x * 100}%;top:${y * 100}%;${style}`;
    d.textContent = text;
    labels.appendChild(d);
  };
  S.suggestions.forEach((s, i) => {
    const g = el("g", { class: "v-sug", "data-sug": i }, svg);
    el("rect", { x: s.box[0], y: s.box[1], width: s.box[2] - s.box[0], height: s.box[3] - s.box[1], "vector-effect": "non-scaling-stroke" }, g);
    tag(s.box[0], s.box[1], `${s.label} ${Math.round(s.score * 100)} %`, "sug");
  });
  boxesOf(im.path).forEach((b, i) => {
    const g = el("g", { class: `v-box${i === S.sel ? " sel" : ""}`, "data-box": i, style: `--c:${color(b.c)}` }, svg);
    el("rect", { x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1, "vector-effect": "non-scaling-stroke" }, g);
    tag(b.x1, b.y1, S.ann.classes[b.c] ?? "?", "", `background:${color(b.c)}`);
    if (i === S.sel) {
      for (const [hx, hy, h] of [[b.x1, b.y1, "nw"], [b.x2, b.y1, "ne"], [b.x1, b.y2, "sw"], [b.x2, b.y2, "se"]]) {
        el("rect", { class: "v-handle", "data-h": h, x: hx - 5 * px, y: hy - 5 * py, width: 10 * px, height: 10 * py }, g);
      }
    }
  });
}

function pointer(e) {
  const r = $("v-svg").getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
}

function initDrawing() {
  const svg = $("v-svg");
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    const im = currentImage();
    // Pas d'image affichée (chargement en cours, erreur) : rien à annoter.
    if (!im || e.button !== 0 || !$("v-img").naturalWidth || !svg.getBoundingClientRect().width) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const p = pointer(e);
    const sug = e.target.closest("[data-sug]");
    if (sug) { acceptSuggestion(Number(sug.dataset.sug)); return; }
    const handle = e.target.closest("[data-h]");
    const boxEl = e.target.closest("[data-box]");
    const boxes = boxesOf(im.path);
    if (handle && S.sel >= 0) {
      drag = { mode: "resize", h: handle.dataset.h, orig: { ...boxes[S.sel] } };
    } else if (boxEl) {
      S.sel = Number(boxEl.dataset.box);
      S.current = boxes[S.sel].c;
      renderClasses();
      drag = { mode: "move", start: p, orig: { ...boxes[S.sel] } };
    } else {
      if (!S.ann.classes.length) ensureClass("objet");
      S.sel = -1;
      drag = { mode: "new", start: p, box: { c: S.current, x1: p.x, y1: p.y, x2: p.x, y2: p.y } };
      boxes.push(drag.box);
      S.sel = boxes.length - 1;
    }
    draw();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const im = currentImage();
    const b = boxesOf(im.path)[S.sel];
    if (!b) return;
    const p = pointer(e);
    if (drag.mode === "new") {
      b.x1 = Math.min(drag.start.x, p.x); b.x2 = Math.max(drag.start.x, p.x);
      b.y1 = Math.min(drag.start.y, p.y); b.y2 = Math.max(drag.start.y, p.y);
    } else if (drag.mode === "move") {
      const o = drag.orig, w = o.x2 - o.x1, h = o.y2 - o.y1;
      const x1 = Math.max(0, Math.min(1 - w, o.x1 + p.x - drag.start.x));
      const y1 = Math.max(0, Math.min(1 - h, o.y1 + p.y - drag.start.y));
      Object.assign(b, { x1, y1, x2: x1 + w, y2: y1 + h });
    } else if (drag.mode === "resize") {
      const o = drag.orig;
      const xs = drag.h.includes("w") ? [p.x, o.x2] : [o.x1, p.x];
      const ys = drag.h.includes("n") ? [p.y, o.y2] : [o.y1, p.y];
      Object.assign(b, { x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) });
    }
    draw();
  });
  const end = () => {
    if (!drag) return;
    const im = currentImage();
    const boxes = boxesOf(im.path);
    const b = boxes[S.sel];
    // Un simple clic sans tracé ne crée pas de boîte fantôme.
    if (drag.mode === "new" && b && (b.x2 - b.x1 < MIN_SIZE || b.y2 - b.y1 < MIN_SIZE)) { boxes.splice(S.sel, 1); S.sel = -1; }
    drag = null;
    draw(); renderClasses(); saveSoon();
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);

  document.addEventListener("keydown", (e) => {
    if ($("tab-vision").hidden || e.target?.closest?.("input, textarea, select")) return;
    const im = currentImage();
    if ((e.key === "Delete" || e.key === "Backspace") && im && S.sel >= 0) {
      boxesOf(im.path).splice(S.sel, 1); S.sel = -1; draw(); renderClasses(); saveSoon(); e.preventDefault();
    } else if (e.key === "ArrowRight") { if (S.idx < visible().length - 1) select(S.idx + 1); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { if (S.idx > 0) select(S.idx - 1); e.preventDefault(); }
    else if (/^[1-9]$/.test(e.key)) setClass(Number(e.key) - 1);
    else if (e.key === "Escape") { S.sel = -1; draw(); }
  });
  new ResizeObserver(() => { fitCanvas(); draw(); }).observe($("v-stage"));
}

// ===== Détection =============================================================
let worker = null;
let seq = 0;
const pending = new Map();
let loaded = "";

function call(type, payload, onProgress) {
  if (!worker) {
    worker = new Worker(new URL("../lib/detection-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const { id, type: t, payload: p } = e.data || {};
      const job = pending.get(id);
      if (!job) return;
      if (t === "progress") { job.onProgress?.(p); return; }
      pending.delete(id);
      t === "error" ? job.reject(new Error(p)) : job.resolve(p);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, payload });
  });
}

function chosenModel() {
  const id = $("v-model").value;
  if (id !== "custom") return MODELS.find((m) => m.id === id);
  return { id: $("v-custom-id").value.trim(), kind: $("v-custom-kind").value, license: "" };
}

async function ensureModel() {
  const m = chosenModel();
  if (!m?.id) throw new Error(tt("Identifiant Hugging Face (ONNX)"));
  if (loaded === m.id) return m;
  status("v-model-status", tt("Chargement du modèle…"));
  await call("load", { modelId: m.id, kind: m.kind }, (p) => {
    if (p.status === "progress" && p.total) status("v-model-status", tt("Téléchargement {f} : {p} %", { f: (p.file || "").split("/").pop(), p: Math.round((p.loaded / p.total) * 100) }));
  });
  loaded = m.id;
  status("v-model-status", tt("Modèle prêt : {m}", { m: m.label || m.id }));
  return m;
}

const threshold = () => Number($("v-thr").value) / 100;

async function detectCurrent() {
  if (!S.imgBlob) return;
  $("v-detect").disabled = true;
  try {
    await ensureModel();
    status("v-model-status", tt("Détection…"));
    S.suggestions = await call("detect", { blob: S.imgBlob, threshold: threshold() });
    $("v-accept").disabled = !S.suggestions.length;
    status("v-model-status", S.suggestions.length ? tt("{n} objet(s) détecté(s) — cliquez une suggestion pour l'accepter.", { n: S.suggestions.length }) : tt("Aucun objet au-dessus du seuil."));
    draw();
  } catch (e) {
    status("v-model-status", String(e?.message || e));
  } finally {
    $("v-detect").disabled = false;
  }
}

function toBox(s) { return { c: ensureClass(s.label), x1: s.box[0], y1: s.box[1], x2: s.box[2], y2: s.box[3] }; }

function acceptSuggestion(i) {
  const im = currentImage();
  const s = S.suggestions[i];
  if (!im || !s) return;
  boxesOf(im.path).push(toBox(s));
  S.suggestions.splice(i, 1);
  $("v-accept").disabled = !S.suggestions.length;
  renderClasses(); draw(); saveSoon();
}

function acceptAll() {
  const im = currentImage();
  if (!im) return;
  for (const s of S.suggestions) boxesOf(im.path).push(toBox(s));
  S.suggestions = [];
  $("v-accept").disabled = true;
  renderClasses(); draw(); saveSoon();
}

async function autoAnnotate() {
  const todo = visible().filter((im) => !(S.ann.images[im.path] || []).length);
  if (!todo.length) return;
  $("v-auto").disabled = true;
  let boxes = 0;
  try {
    await ensureModel();
    for (let i = 0; i < todo.length; i++) {
      status("v-model-status", tt("Pré-annotation : {i}/{n}…", { i: i + 1, n: todo.length }));
      const dataUrl = await invoke("sandbox_read_image_b64", { id: S.sandbox, path: todo[i].path, maxPx: 2560 });
      const blob = await (await fetch(dataUrl)).blob();
      const found = await call("detect", { blob, threshold: threshold() });
      if (found.length) { S.ann.images[todo[i].path] = found.map(toBox); boxes += found.length; }
      await nextFrame();
    }
    status("v-model-status", tt("Pré-annotation terminée : {b} boîtes sur {n} images.", { b: boxes, n: todo.length }));
  } catch (e) {
    status("v-model-status", String(e?.message || e));
  } finally {
    $("v-auto").disabled = false;
    renderClasses(); draw(); saveSoon();
  }
}

// ===== Export YOLO ===========================================================
// Répartition stable train/val : un hachage du chemin, pas un tirage au sort —
// réexporter ne fait pas passer une image d'un côté à l'autre.
function hash01(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }

async function exportYolo() {
  const name = ($("v-ds-name").value.trim() || "dataset").replace(/[^\w.-]+/g, "_");
  const valShare = Number($("v-val").value) / 100;
  const withNeg = $("v-negatives").checked;
  const items = visible().filter((im) => (S.ann.images[im.path] || []).length || withNeg);
  if (!items.some((im) => (S.ann.images[im.path] || []).length)) { status("v-export-status", tt("Rien à exporter : annotez au moins une image.")); return; }
  $("v-export").disabled = true;
  const root = `datasets/${name}`;
  let nTrain = 0, nVal = 0;
  try {
    for (let i = 0; i < items.length; i++) {
      status("v-export-status", tt("Export : {i}/{n} images…", { i: i + 1, n: items.length }));
      const im = items[i];
      const split = hash01(im.path) < valShare ? "val" : "train";
      split === "val" ? nVal++ : nTrain++;
      const stem = im.path.replace(/\.[^.]+$/, "").replace(/[\\/]+/g, "__").replace(/[^\w.-]+/g, "_");
      const dataUrl = await invoke("sandbox_read_image_b64", { id: S.sandbox, path: im.path, maxPx: 2560 });
      await invoke("sandbox_import_file", { id: S.sandbox, path: `${root}/images/${split}/${stem}.jpg`, dataB64: dataUrl.split(",")[1] });
      const lines = (S.ann.images[im.path] || []).map((b) => {
        const f = (v) => v.toFixed(6);
        return `${b.c} ${f((b.x1 + b.x2) / 2)} ${f((b.y1 + b.y2) / 2)} ${f(b.x2 - b.x1)} ${f(b.y2 - b.y1)}`;
      });
      await invoke("sandbox_write_file", { id: S.sandbox, path: `${root}/labels/${split}/${stem}.txt`, content: lines.join("\n") + (lines.length ? "\n" : "") });
      await nextFrame();
    }
    // Sans image de validation, YOLO refuse de s'entraîner : on réutilise train.
    const valDir = nVal ? "images/val" : "images/train";
    const names = S.ann.classes.map((c, i) => `  ${i}: ${JSON.stringify(c)}`).join("\n");
    await invoke("sandbox_write_file", { id: S.sandbox, path: `${root}/data.yaml`, content: `# Dataset exporté par l'Atelier ML de Lumen (chemins relatifs à ce dossier)\ntrain: images/train\nval: ${valDir}\nnames:\n${names}\n` });
    await invoke("sandbox_write_file", { id: S.sandbox, path: `${root}/train.py`, content: TRAIN_PY });
    await invoke("sandbox_write_file", { id: S.sandbox, path: `${root}/README.md`, content: readme(name) });
    const sbName = $("v-sandbox").selectedOptions[0]?.textContent || S.sandbox;
    status("v-export-status", tt("Dataset exporté dans {s} › {d} ({t} entraînement, {v} validation). Lancez train.py là où Python et ultralytics sont installés.", { s: sbName, d: root, t: nTrain, v: nVal }));
  } catch (e) {
    status("v-export-status", String(e?.message || e));
  } finally {
    $("v-export").disabled = false;
  }
}

const TRAIN_PY = `# Entraînement YOLO sur ce dataset (exporté par l'Atelier ML de Lumen).
#   pip install ultralytics          # AGPL-3.0
#   python train.py                  # ou : python train.py yolo11n.pt 100
# Le meilleur modèle arrive dans runs/detect/train*/weights/best.pt,
# puis est exporté en ONNX à côté.
import os, sys
import yaml
from ultralytics import YOLO

here = os.path.dirname(os.path.abspath(__file__))
weights = sys.argv[1] if len(sys.argv) > 1 else "yolov10n.pt"
epochs = int(sys.argv[2]) if len(sys.argv) > 2 else 50

# ultralytics résout un chemin relatif depuis SON dossier de datasets, pas
# depuis data.yaml : on fixe le chemin absolu de ce dossier.
with open(os.path.join(here, "data.yaml"), encoding="utf-8") as f:
    cfg = yaml.safe_load(f)
cfg["path"] = here
data = os.path.join(here, "data.local.yaml")
with open(data, "w", encoding="utf-8") as f:
    yaml.safe_dump(cfg, f, allow_unicode=True)

model = YOLO(weights)
model.train(data=data, epochs=epochs, imgsz=640, project=os.path.join(here, "runs"))
model.export(format="onnx")
`;

const readme = (name) => `# ${name}

Dataset de détection d'objets au format YOLO, exporté par l'Atelier ML de Lumen.

- \`images/train\`, \`images/val\` : images (JPEG, 2560 px max)
- \`labels/train\`, \`labels/val\` : une ligne par objet — \`classe cx cy largeur hauteur\` (valeurs 0 à 1)
- \`data.yaml\` : chemins et noms des classes
- \`train.py\` : entraînement avec ultralytics (\`pip install ultralytics\`), sur un ordinateur ou un Raspberry Pi 5

Le modèle entraîné (\`best.pt\` ou \`.onnx\`) s'utilise ensuite dans Robot Studio avec le bloc « ml local yolo ».
`;

// ===== Initialisation ========================================================
function init() {
  if (!invoke || !$("tab-vision")) return;
  $("v-model").innerHTML = MODELS.map((m) => `<option value="${esc(m.id)}">${esc(tt(m.label))}${m.license ? ` · ${esc(m.license)}` : ""}</option>`).join("");
  $("v-model").value = localStorage.getItem("mlVisionModel") || MODELS[0].id;
  const showLicense = () => {
    const m = chosenModel();
    $("v-custom").hidden = $("v-model").value !== "custom";
    status("v-model-status", loaded === m?.id ? tt("Modèle prêt : {m}", { m: m.label || m.id }) : `${m?.license ? tt("Licence : {l}", { l: m.license }) + " · " : ""}${tt("Premier chargement : téléchargement du modèle (quelques Mo), puis hors ligne.")}`);
  };
  $("v-model").addEventListener("change", () => { localStorage.setItem("mlVisionModel", $("v-model").value); showLicense(); });
  showLicense();
  $("v-thr").addEventListener("input", () => { $("v-thr-val").textContent = `${$("v-thr").value} %`; });
  $("v-val").addEventListener("input", () => { $("v-val-val").textContent = `${$("v-val").value} %`; });
  $("v-sandbox").addEventListener("change", (e) => { S.sandbox = e.target.value; S.idx = 0; openSandbox(); });
  $("v-folder").addEventListener("change", (e) => { S.folder = e.target.value; S.idx = 0; renderList(); select(visible().length ? 0 : -1); });
  $("v-refresh").addEventListener("click", refreshImages);
  $("v-import").addEventListener("click", () => $("v-file").click());
  $("v-file").addEventListener("change", (e) => { const files = [...e.target.files]; e.target.value = ""; if (files.length) importFiles(files); });
  $("v-prev").addEventListener("click", () => S.idx > 0 && select(S.idx - 1));
  $("v-next").addEventListener("click", () => S.idx < visible().length - 1 && select(S.idx + 1));
  $("v-clear").addEventListener("click", () => { const im = currentImage(); if (!im) return; S.ann.images[im.path] = []; S.sel = -1; draw(); renderClasses(); saveSoon(); });
  const addClass = () => { const i = ensureClass($("v-new-class").value); if (i >= 0) { $("v-new-class").value = ""; setClass(i); saveSoon(); } };
  $("v-add-class").addEventListener("click", addClass);
  $("v-new-class").addEventListener("keydown", (e) => { if (e.key === "Enter") addClass(); });
  $("v-detect").addEventListener("click", detectCurrent);
  $("v-accept").addEventListener("click", acceptAll);
  $("v-auto").addEventListener("click", autoAnnotate);
  $("v-export").addEventListener("click", exportYolo);
  initDrawing();
  // L'onglet est chargé à la première ouverture seulement.
  let started = false;
  document.querySelector('.tab[data-tab="tab-vision"]')?.addEventListener("click", () => {
    if (!started) { started = true; loadSandboxes().then(renderClasses); }
    requestAnimationFrame(() => { fitCanvas(); draw(); });
  });
}

init();
