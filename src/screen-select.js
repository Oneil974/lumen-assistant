// Surface de sélection de « Comprendre cette zone ».
//
// Elle ne capture rien : le backend a déjà pris l'écran (cf. screen.rs) et nous
// en donne un aperçu. On ne fait que tracer un rectangle et renvoyer ses
// coordonnées NORMALISÉES par rapport à l'image affichée — pas à la fenêtre,
// qui la letterboxe.

const { invoke } = window.__TAURI__?.core || { invoke: async () => {} };

const shot = document.getElementById("shot");
const veil = document.getElementById("veil");
const box = document.getElementById("box");
const sizeTag = document.getElementById("size");
const hint = document.getElementById("hint");

const LANG = (localStorage.getItem("lang") || navigator.language || "fr").startsWith("en") ? "en" : "fr";
hint.textContent = LANG === "en"
  ? "Drag to select an area · Esc to cancel"
  : "Trace la zone à analyser · Échap pour annuler";

let start = null;
let rect = null;

/** Rectangle de l'image RÉELLEMENT affichée, letterboxage compris. */
function imageBox() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const ratio = (shot.naturalWidth || w) / (shot.naturalHeight || h);
  const winRatio = w / h;
  if (ratio > winRatio) {
    const drawn = w / ratio;
    return { x: 0, y: (h - drawn) / 2, w, h: drawn };
  }
  const drawn = h * ratio;
  return { x: (w - drawn) / 2, y: 0, w: drawn, h };
}

function draw() {
  if (!rect) {
    box.style.display = "none";
    veil.style.clipPath = "";
    return;
  }
  box.style.display = "block";
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.w}px`;
  box.style.height = `${rect.h}px`;
  sizeTag.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
  // Trou dans le voile : le contenu sélectionné doit rester lisible pendant le
  // tracé, sinon on vise à l'aveugle.
  const { x, y, w, h } = rect;
  veil.style.clipPath =
    `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x}px ${y}px, ${x}px ${y + h}px, ${x + w}px ${y + h}px, ${x + w}px ${y}px, ${x}px ${y}px)`;
}

function normalize(r) {
  const img = imageBox();
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const left = clamp(r.x, img.x, img.x + img.w);
  const top = clamp(r.y, img.y, img.y + img.h);
  const right = clamp(r.x + r.w, img.x, img.x + img.w);
  const bottom = clamp(r.y + r.h, img.y, img.y + img.h);
  return {
    x: (left - img.x) / img.w,
    y: (top - img.y) / img.h,
    width: (right - left) / img.w,
    height: (bottom - top) / img.h,
  };
}

async function cancel() {
  try { await invoke("screen_select_cancel"); } catch {}
}

document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) { cancel(); return; }
  start = { x: e.clientX, y: e.clientY };
  rect = { x: start.x, y: start.y, w: 0, h: 0 };
  hint.style.display = "none";
  draw();
});

document.addEventListener("pointermove", (e) => {
  if (!start) return;
  rect = {
    x: Math.min(start.x, e.clientX),
    y: Math.min(start.y, e.clientY),
    w: Math.abs(e.clientX - start.x),
    h: Math.abs(e.clientY - start.y),
  };
  draw();
});

document.addEventListener("pointerup", async () => {
  if (!start || !rect) return;
  const selection = rect;
  start = null;
  // Un simple clic n'est pas une sélection : le backend refuserait de toute
  // façon, autant ne pas fermer la surface sur une fausse manœuvre.
  if (selection.w < 8 || selection.h < 8) {
    rect = null;
    hint.style.display = "";
    draw();
    return;
  }
  try {
    await invoke("screen_select_finish", normalize(selection));
  } catch (error) {
    hint.style.display = "";
    hint.textContent = String(error?.message || error);
    rect = null;
    draw();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancel();
});

(async () => {
  try {
    const preview = await invoke("screen_select_preview");
    shot.src = `data:${preview.mime || "image/jpeg"};base64,${preview.image}`;
  } catch (error) {
    hint.textContent = String(error?.message || error);
  }
})();
