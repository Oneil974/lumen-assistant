import { autoTranslate, tt } from "../apps-i18n.js";
// Studio de voix — logique front. Parle au backend TTS (tts.rs) via les commandes
// tts_catalog / tts_download_voice / tts_delete_voice / tts_set_voice / tts_speak /
// tts_export_wav / tts_stop. Aucune dépendance réseau : tout est local.

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  search: document.getElementById("search"),
  fLang: document.getElementById("f-lang"),
  fEngine: document.getElementById("f-engine"),
  fInstalled: document.getElementById("f-installed"),
  text: document.getElementById("text"),
  activeVoice: document.getElementById("active-voice"),
  btnPlay: document.getElementById("btn-play"),
  btnStop: document.getElementById("btn-stop"),
  btnExport: document.getElementById("btn-export"),
};

let catalog = [];
let activeVoice = "";
let selected = ""; // voix choisie pour le dock de test (id)
let sandboxId = null; // pour l'export WAV
const busy = new Set(); // ids en cours de téléchargement

function voiceCountLabel(n, installed) {
  return tt("{n} voix au catalogue · {installed} installée(s)", { n, installed });
}

function setStatus(msg) { els.status.textContent = tt(msg); }

async function loadCatalog() {
  if (!invoke) { setStatus("Backend indisponible (hors application)."); return; }
  try {
    const [cat, active, sandboxes] = await Promise.all([
      invoke("tts_catalog"),
      invoke("tts_active_voice").catch(() => ""),
      invoke("sandbox_list").catch(() => []),
    ]);
    catalog = Array.isArray(cat) ? cat : [];
    activeVoice = active || "";
    selected = activeVoice || (catalog.find((v) => v.installed)?.id ?? catalog[0]?.id ?? "");
    if (Array.isArray(sandboxes) && sandboxes.length) {
      sandboxId = sandboxes[0].id;
      els.btnExport.hidden = false;
    }
    buildLangFilter();
    render();
    const n = catalog.length, installed = catalog.filter((v) => v.installed).length;
    setStatus(voiceCountLabel(n, installed));
  } catch (e) {
    setStatus(tt("Erreur :") + " " + (e?.message || e));
  }
}

function buildLangFilter() {
  const langs = [...new Set(catalog.map((v) => v.lang).filter(Boolean))].sort();
  for (const l of langs) {
    const o = document.createElement("option");
    o.value = l; o.textContent = l;
    els.fLang.appendChild(o);
  }
}

function filtered() {
  const q = els.search.value.trim().toLowerCase();
  const lang = els.fLang.value, eng = els.fEngine.value, onlyInst = els.fInstalled.checked;
  return catalog.filter((v) => {
    if (lang && v.lang !== lang) return false;
    if (eng && v.engine !== eng) return false;
    if (onlyInst && !v.installed) return false;
    if (q && !(`${v.label} ${v.id} ${v.lang}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function render() {
  const list = filtered();
  els.activeVoice.textContent = labelOf(selected) || "—";
  els.grid.innerHTML = "";
  if (!list.length) {
    els.grid.innerHTML = `<div class="empty">${tt("Aucune voix ne correspond à ce filtre.")}</div>`;
    return;
  }
  for (const v of list) els.grid.appendChild(card(v));
}

function labelOf(id) {
  const v = catalog.find((x) => x.id === id);
  return v ? v.label : id;
}

function card(v) {
  const el = document.createElement("div");
  el.className = "card" + (v.id === selected ? " active" : "");
  const downloading = busy.has(v.id);
  el.innerHTML = `
    <div class="card-top">
      <div class="card-name">${esc(v.label)}</div>
      <span class="tag ${v.engine}">${v.engine}</span>
    </div>
    <div class="card-meta">
      <span>${esc(v.lang || "—")}</span>
      ${v.quality ? `<span>· ${esc(v.quality)}</span>` : ""}
      ${v.size_mb ? `<span>· ${v.size_mb} Mo</span>` : ""}
    </div>
    <div class="card-actions"></div>`;
  const actions = el.querySelector(".card-actions");
  if (downloading) {
    actions.innerHTML = `<span class="dl-state">${tt("Téléchargement…")}</span>`;
  } else if (v.installed) {
    actions.appendChild(btn("Définir comme test", "primary tiny", () => { selected = v.id; render(); }));
    actions.appendChild(btn("Activer partout", "tiny", () => setActive(v.id)));
    actions.appendChild(btn("Supprimer", "tiny ghost danger", () => del(v.id)));
  } else {
    actions.appendChild(btn("Télécharger", "primary tiny", () => download(v.id)));
  }
  return el;
}

function btn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = "btn " + cls; b.textContent = tt(label);
  b.addEventListener("click", onClick);
  return b;
}

async function download(id) {
  busy.add(id); render();
  try {
    await invoke("tts_download_voice", { id });
    const v = catalog.find((x) => x.id === id); if (v) v.installed = true;
    selected = id;
  } catch (e) {
    alert(tt("Téléchargement impossible :") + " " + (e?.message || e));
  } finally {
    busy.delete(id); render();
    setStatus(tt("{n} voix installées", { n: catalog.filter((v) => v.installed).length }));
  }
}

async function del(id) {
  try {
    await invoke("tts_delete_voice", { id });
    const v = catalog.find((x) => x.id === id); if (v) v.installed = false;
    if (selected === id) selected = catalog.find((x) => x.installed)?.id ?? "";
    render();
  } catch (e) { alert(tt("Suppression impossible :") + " " + (e?.message || e)); }
}

async function setActive(id) {
  try {
    await invoke("tts_set_voice", { voice: id });
    activeVoice = id; selected = id;
    setStatus(tt("Voix active : {name}", { name: labelOf(id) }));
    render();
  } catch (e) { alert(tt("Impossible de définir la voix :") + " " + (e?.message || e)); }
}

async function preview() {
  const text = els.text.value.trim();
  if (!text) { els.text.focus(); return; }
  if (!selected) { setStatus("Choisissez d'abord une voix installée."); return; }
  els.btnPlay.disabled = true;
  setStatus(tt("Lecture avec {name}…", { name: labelOf(selected) }));
  try {
    await invoke("tts_speak", { text, voice: selected });
    setStatus("Lecture terminée.");
  } catch (e) {
    setStatus(tt("Lecture impossible :") + " " + (e?.message || e));
  } finally {
    els.btnPlay.disabled = false;
  }
}

async function stop() {
  try { await invoke("tts_stop"); setStatus("Arrêté."); } catch {}
}

async function exportWav() {
  const text = els.text.value.trim();
  if (!text || !selected || !sandboxId) return;
  els.btnExport.disabled = true;
  setStatus("Export WAV…");
  try {
    const path = await invoke("tts_export_wav", { text, voice: selected, sandboxId });
    let sent = false;
    if (window.OrbBridge?.connected && window.OrbBridge.pushWav) {
      sent = await window.OrbBridge.pushWav(path);
    }
    setStatus((sent ? "WAV envoyé à l'orbe · " : tt("Exporté dans la sandbox : ")) + path);
  } catch (e) {
    setStatus(tt("Export impossible :") + " " + (e?.message || e));
  } finally {
    els.btnExport.disabled = false;
  }
}

els.search.addEventListener("input", render);
els.fLang.addEventListener("change", render);
els.fEngine.addEventListener("change", render);
els.fInstalled.addEventListener("change", render);
els.btnPlay.addEventListener("click", preview);
els.btnStop.addEventListener("click", stop);
els.btnExport.addEventListener("click", exportWav);

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

loadCatalog();

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
