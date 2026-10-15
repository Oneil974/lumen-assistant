// Médias — bibliothèque, lecteur et bascule vers le montage (editor.js).
//
// Les fichiers ne transitent jamais par l'IPC : la balise <video>/<audio> lit
// directement `lumenmedia://localhost/<sandbox>/<chemin>` (flux avec Range,
// cf. src-tauri/src/media.rs). Les formats que le moteur ne sait pas lire
// (MKV, AVI…) sont signalés, et convertis en MP4 si ffmpeg est installé.

import { autoTranslate, registerTranslations, tt } from "../apps-i18n.js";
import { createStore } from "../lib/app-state.js";
import { icon } from "../lib/icons.js";
import { receive } from "../lib/interop.js";
import { MEDIA_EN } from "./i18n.js";
import { mountEditor } from "./editor.js";
import { ensureSessionUnlocked, invokeUnlocked, isSessionUnlocked } from "../lib/session-unlock.js";

registerTranslations(MEDIA_EN);

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = createStore("media");

export const EXT = {
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi"],
  audio: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus"],
  image: ["png", "jpg", "jpeg", "webp", "gif"],
};
// Ce que le moteur de la WebView lit sans conversion (WebKit / WebView2).
const PLAYABLE = new Set(["mp4", "m4v", "mov", "webm", "mp3", "m4a", "aac", "wav", "flac", "png", "jpg", "jpeg", "webp", "gif"]);
const extOf = (p) => String(p).split(".").pop().toLowerCase();
export const kindOf = (p) => Object.keys(EXT).find((k) => EXT[k].includes(extOf(p))) || "";

/// Adresse de lecture d'un fichier de sandbox (flux lumenmedia://).
export function mediaUrl(f) {
  const enc = f.path.split("/").map(encodeURIComponent).join("/");
  const win = /Windows/i.test(navigator.userAgent);
  if (window.__previewMediaUrl) return window.__previewMediaUrl(f);
  return win ? `http://lumenmedia.localhost/${f.sandboxId}/${enc}` : `lumenmedia://localhost/${f.sandboxId}/${enc}`;
}

const state = { files: [], filter: "all", query: "", queue: [], index: -1, ffmpeg: false, locked: false };

export function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3000); }
function paintIcons(root = document) { root.querySelectorAll("[data-ic]").forEach((n) => { n.innerHTML = icon(n.dataset.ic) || ""; }); }

// ===== Bibliothèque =========================================================
async function scan() {
  if (!invoke) return [];
  // Session verrouillée (mode barre / application) : rien n'est lisible tant
  // que l'utilisateur n'a pas déverrouillé — on le lui dit, au lieu d'afficher
  // une bibliothèque vide et un export qui échoue en silence.
  state.locked = !(await isSessionUnlocked(invoke));
  $("lock-banner").hidden = !state.locked;
  if (state.locked) return [];
  let sandboxes = [];
  try { sandboxes = (await invoke("sandbox_list")) || []; } catch { return []; }
  const out = [];
  const walk = async (sb, path, depth) => {
    let entries = [];
    try { entries = (await invoke("sandbox_read_dir", { id: sb.id, path })) || []; } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.is_dir) { if (depth < 6) await walk(sb, p, depth + 1); continue; }
      const kind = kindOf(e.name);
      if (kind) out.push({ sandboxId: sb.id, sandbox: sb.name, path: p, name: e.name, size: e.size || 0, kind, playable: PLAYABLE.has(extOf(e.name)) });
    }
  };
  for (const sb of sandboxes) await walk(sb, "", 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const libraryFiles = () => state.files;

function renderLib() {
  const q = state.query.toLowerCase();
  const items = state.files.filter((f) => (state.filter === "all" || f.kind === state.filter) && (!q || f.name.toLowerCase().includes(q)));
  const ICON = { video: "play", audio: "music", image: "image" };
  if (state.locked) { $("lib").innerHTML = `<div class="muted pad">${esc(tt("Bibliothèque verrouillée."))}</div>`; return; }
  $("lib").innerHTML = items.length ? items.map((f) => `
    <div class="lib-item${f.playable ? "" : " unplayable"}" role="button" tabindex="0" draggable="true" data-i="${state.files.indexOf(f)}" title="${esc(f.sandbox)} · ${esc(f.path)}">
      <span class="lib-ic">${icon(ICON[f.kind])}</span>
      <span class="lib-tx"><b>${esc(f.name)}</b><small>${esc(f.sandbox)}${f.playable ? "" : ` · ${esc(tt("à convertir"))}`}</small></span>
      <span class="lib-add" data-add-i="${state.files.indexOf(f)}" title="${esc(tt(f.kind === "audio" ? "Ajouter en musique" : "Ajouter au montage"))}">${icon("plus")}</span>
    </div>`).join("") : `<div class="muted pad">${esc(tt(state.files.length ? "Aucun résultat." : "Aucun média dans vos sandboxes. Importez des vidéos ou de la musique."))}</div>`;
}

// ===== Lecteur ==============================================================
async function play(f) {
  if (!f.playable) {
    if (!state.ffmpeg) { toast(tt("Ce format n'est pas lu par le moteur. Installez ffmpeg pour le convertir en MP4.")); return; }
    toast(tt("Conversion en MP4…"));
    try {
      const path = await invoke("media_convert", { sandboxId: f.sandboxId, path: f.path, audioOnly: f.kind === "audio" });
      state.files = await scan(); renderLib();
      const conv = state.files.find((x) => x.sandboxId === f.sandboxId && x.path === path);
      if (conv) return play(conv);
    } catch (e) { toast(String(e?.message || e)); }
    return;
  }
  if (f.kind === "image") { toast(tt("Les images servent au montage : glissez-la sur la timeline.")); return; }
  if (!(await ensureSessionUnlocked({ invoke, reason: tt("Lire ce média") }))) return;
  $("player-empty").hidden = true;
  const video = $("video"), audio = $("audio");
  video.pause(); audio.pause();
  if (f.kind === "video") {
    audio.parentElement.hidden = true;
    video.hidden = false;
    video.src = mediaUrl(f);
    video.playbackRate = Number($("p-rate").value);
    video.play().catch(() => {});
  } else {
    video.hidden = true;
    $("audio-card").hidden = false;
    $("audio-title").textContent = f.name.replace(/\.[^.]+$/, "");
    audio.src = mediaUrl(f);
    audio.playbackRate = Number($("p-rate").value);
    audio.play().catch(() => {});
  }
  if (!state.queue.includes(f)) { state.queue.push(f); }
  state.index = state.queue.indexOf(f);
  store.set("last", { sandboxId: f.sandboxId, path: f.path });
  renderQueue();
}

function renderQueue() {
  $("queue").innerHTML = state.queue.length ? state.queue.map((f, i) => `
    <div class="q-item${i === state.index ? " is-on" : ""}" data-q="${i}">
      <span>${i === state.index ? "▶" : i + 1}</span><b>${esc(f.name)}</b>
      <button class="btn-ico" data-qdel="${i}" title="${esc(tt("Retirer"))}">✕</button>
    </div>`).join("") : `<div class="muted pad">${esc(tt("File d'attente vide."))}</div>`;
}

function step(dir) {
  if (!state.queue.length) return;
  let i = state.index + dir;
  if ($("p-shuffle").checked && state.queue.length > 1) {
    do { i = Math.floor(Math.random() * state.queue.length); } while (i === state.index);
  }
  if (i < 0 || i >= state.queue.length) { if (!$("p-loop").checked) return; i = (i + state.queue.length) % state.queue.length; }
  play(state.queue[i]);
}

function onEnded(el) {
  if ($("p-loop").checked && state.queue.length <= 1) { el.currentTime = 0; el.play(); return; }
  step(1);
}

// ===== Import ===============================================================
async function importFiles(files) {
  let sandboxes = [];
  try { sandboxes = (await invokeUnlocked(invoke, "sandbox_list", {}, tt("Importer des fichiers"))) || []; } catch {}
  const sb = sandboxes.find((s) => /m[ée]dia|vid[ée]o|musique/i.test(s.name)) || sandboxes[0];
  if (!sb) { toast(tt("Créez d'abord une sandbox dans Fichiers.")); return; }
  for (const file of files) {
    const kind = kindOf(file.name);
    if (!kind) continue;
    const folder = kind === "audio" ? "Musique" : kind === "image" ? "Images" : "Vidéos";
    const path = `${folder}/${file.name}`;
    toast(tt("Import de « {n} »…", { n: file.name }));
    // Par tranches : une vidéo de plusieurs centaines de Mo ne tient pas dans un message.
    const CH = 3 * 1024 * 1024;
    for (let off = 0; off < file.size || off === 0; off += CH) {
      const buf = new Uint8Array(await file.slice(off, off + CH).arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      await invokeUnlocked(invoke, "media_append_b64", { sandboxId: sb.id, path, dataB64: btoa(bin), reset: off === 0 });
      if (file.size === 0) break;
    }
  }
  state.files = await scan();
  renderLib();
  toast(tt("Import terminé."));
}

// ===== Démarrage ============================================================
let editor = null;
function setTab(tab) {
  document.querySelectorAll(".seg-btn[data-tab]").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === tab));
  $("app").dataset.tab = tab;
  $("view-player").hidden = tab !== "player";
  $("view-editor").hidden = tab !== "editor";
  // Une seule bibliothèque : elle vit dans la colonne du lecteur, ou dans le
  // panneau « Médias » du montage.
  (tab === "editor" ? $("lib-host-editor") : $("lib-host-player")).appendChild($("libbox"));
  if (tab === "editor") { $("video").pause(); $("audio").pause(); requestAnimationFrame(() => editor?.resize()); }
  else editor?.pause();
  store.set("tab", tab);
}

async function rescan() { state.files = await scan(); renderLib(); }

async function unlock() {
  if (!(await ensureSessionUnlocked({ invoke }))) return;
  await rescan();
  await editor?.unlocked();
}

async function init() {
  paintIcons();
  await store.ready();
  document.querySelectorAll(".seg-btn[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  document.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => {
    state.filter = b.dataset.kind;
    document.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("is-on", x === b));
    renderLib();
  }));
  $("search").oninput = (e) => { state.query = e.target.value; renderLib(); };
  $("lib").addEventListener("click", (e) => {
    const plus = e.target.closest("[data-add-i]");
    if (plus) {
      const f = state.files[Number(plus.dataset.addI)];
      if ($("view-editor").hidden) setTab("editor");
      editor.api.add(f, f.kind === "audio" ? { track: "audio", audioKind: "music" } : {});
      return;
    }
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const f = state.files[Number(b.dataset.i)];
    if (!$("view-editor").hidden) editor.api.add(f, f.kind === "audio" ? { track: "audio", audioKind: "music" } : {});
    else play(f);
  });
  $("lib").addEventListener("dblclick", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b || !$("view-editor").hidden) return;
    const f = state.files[Number(b.dataset.i)];
    if (!state.queue.includes(f)) state.queue.push(f);
    renderQueue();
    toast(tt("Ajouté à la file d'attente."));
  });
  $("lib").addEventListener("dragstart", (e) => {
    const b = e.target.closest("[data-i]");
    if (b) e.dataTransfer.setData("text/lumen-media", b.dataset.i);
  });
  $("queue").addEventListener("click", (e) => {
    const del = e.target.closest("[data-qdel]");
    if (del) { const i = Number(del.dataset.qdel); state.queue.splice(i, 1); if (i < state.index) state.index--; renderQueue(); return; }
    const q = e.target.closest("[data-q]");
    if (q) play(state.queue[Number(q.dataset.q)]);
  });
  $("p-prev").onclick = () => step(-1);
  $("p-next").onclick = () => step(1);
  $("p-rate").onchange = (e) => { $("video").playbackRate = $("audio").playbackRate = Number(e.target.value); };
  $("video").addEventListener("ended", () => onEnded($("video")));
  $("audio").addEventListener("ended", () => onEnded($("audio")));
  $("p-to-editor").onclick = () => {
    const f = state.queue[state.index];
    if (!f) { toast(tt("Lisez d'abord un fichier.")); return; }
    editor.add(f); setTab("editor");
  };
  $("btn-import").onclick = () => $("file-input").click();
  $("btn-unlock").onclick = unlock;
  window.addEventListener("lumen-session-unlocked", () => { rescan(); editor?.unlocked(); });
  // La session a pu être ouverte ailleurs (bureau, compagnon) : on revérifie
  // quand la fenêtre revient au premier plan.
  window.addEventListener("focus", async () => { if (state.locked && (await isSessionUnlocked(invoke))) { await rescan(); editor?.unlocked(); } });
  $("file-input").onchange = (e) => { const fs = [...(e.target.files || [])]; e.target.value = ""; if (fs.length) importFiles(fs); };
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (!$("view-player").hidden && e.code === "Space") {
      e.preventDefault();
      const el = !$("video").hidden ? $("video") : $("audio");
      if (el.src) (el.paused ? el.play() : el.pause());
    }
  });

  try { state.ffmpeg = (await invoke("media_ffmpeg_status"))?.available; } catch {}
  $("ffmpeg-state").textContent = state.ffmpeg ? tt("ffmpeg détecté : export MP4 et conversions disponibles.") : tt("Sans ffmpeg : export au format natif du moteur.");
  editor = mountEditor({
    store, toast, mediaUrl, invoke,
    files: () => state.files,
    ffmpeg: () => state.ffmpeg,
    rescan,
    // Lecture d'une vidéo exportée : retour au lecteur, sur le fichier.
    playFile: async ({ sandboxId, path }) => {
      await rescan();
      const f = state.files.find((x) => x.sandboxId === sandboxId && x.path === path)
        || { sandboxId, sandbox: "", path, name: path.split("/").pop(), kind: kindOf(path), playable: PLAYABLE.has(extOf(path)) };
      setTab("player");
      play(f);
    },
  });
  state.files = await scan();
  renderLib();
  renderQueue();
  setTab(store.get("tab", "player") === "editor" ? "editor" : "player");
  // Un fichier envoyé depuis l'explorateur (« Envoyer vers… › Médias »).
  receive("media", (obj) => {
    if (obj?.kind !== "file" || !obj.path) return;
    const f = state.files.find((x) => x.sandboxId === obj.sandboxId && x.path === obj.path)
      || { sandboxId: obj.sandboxId, sandbox: "", path: obj.path, name: obj.path.split("/").pop(), kind: kindOf(obj.path), playable: PLAYABLE.has(extOf(obj.path)) };
    if (f.kind) { setTab("player"); play(f); }
  });
  autoTranslate({ observe: true });
}

init();
