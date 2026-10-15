import { autoTranslate, tt } from "../apps-i18n.js";
import { confirmSheet } from "../lib/confirm.js";
// App « Stockage » — logique front.
//
// Trois choses, dans cet ordre d'importance : ce que Lumen occupe et où
// (storage_report), ce qu'on peut récupérer sans rien perdre (storage_clear
// sur les catégories retéléchargeables), et ce qu'on emporte dans une
// sauvegarde (backup_export_selection). Aucune taille n'est estimée ici :
// tout vient du backend, qui mesure les fichiers réels.

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};

const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; };

// Une teinte par catégorie, tenue entre la jauge, la légende et la liste : une
// catégorie se reconnaît à sa couleur, comme dans le panneau de macOS.
const COLORS = {
  sandboxes: "#0a84ff",
  models: "#5e5ce6",
  voices: "#bf5af2",
  images: "#ff375f",
  knowledge: "#ff9f0a",
  memory: "#c86bd8",
  tables: "#30d158",
  agents: "#16b8a6",
  appstate: "#64d2ff",
  apps: "#ffd60a",
  logs: "#8e8e93",
  other: "#6e7781",
};

let report = null;
let picks = new Set();

function fmt(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} o`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} Ko`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

async function refresh() {
  if (!invoke) { $("usage-total").textContent = "Backend indisponible"; return; }
  try {
    report = await invoke("storage_report");
  } catch (e) {
    toast("Lecture impossible : " + (e?.message || e));
    return;
  }
  $("root-path").textContent = report.root || "";
  $("usage-total").textContent = fmt(report.total);
  const free = Number(report.disk_free) || 0;
  const disk = Number(report.disk_total) || 0;
  $("usage-disk").innerHTML = disk
    ? `<span class="disk-free">${esc(fmt(free))}</span><span class="disk-label">disponibles sur ${esc(fmt(disk))}</span>`
    : "";
  renderBar();
  renderCats();
  renderPicks();
}

// Barre segmentée : les catégories vides sont ignorées, et une catégorie qui
// pèse moins de 0,5 % garde une largeur minimale pour rester cliquable.
function renderBar() {
  const bar = $("bar");
  const legend = $("legend");
  bar.innerHTML = "";
  legend.innerHTML = "";
  const cats = (report.categories || []).filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const total = cats.reduce((a, c) => a + c.bytes, 0) || 1;
  for (const c of cats) {
    const seg = document.createElement("span");
    seg.className = "seg";
    seg.style.width = Math.max(0.6, (c.bytes / total) * 100) + "%";
    seg.style.background = COLORS[c.id] || COLORS.other;
    seg.title = `${tt(c.label)} — ${fmt(c.bytes)}`;
    bar.appendChild(seg);

    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML = `<span class="dot" style="background:${COLORS[c.id] || COLORS.other}"></span>`
      + `<span class="legend-label">${esc(tt(c.label))}</span><span class="legend-size">${esc(fmt(c.bytes))}</span>`;
    legend.appendChild(item);
  }
  if (!cats.length) bar.innerHTML = `<span class="seg empty" style="width:100%"></span>`;
}

function renderCats() {
  const host = $("cats");
  host.innerHTML = "";
  const cats = (report.categories || []).slice().sort((a, b) => b.bytes - a.bytes);
  $("cats-empty").hidden = cats.some((c) => c.bytes > 0);
  for (const c of cats) {
    if (!c.bytes) continue;
    const row = document.createElement("div");
    row.className = "cat";
    const detail = Array.isArray(c.items) && c.items.length
      ? `<div class="cat-detail">${c.items.slice(0, 6).map((i) => `${esc(i.name)} — ${esc(fmt(i.bytes))}`).join("<br>")}</div>`
      : "";
    row.innerHTML = `
      <span class="cat-dot" style="background:${COLORS[c.id] || COLORS.other}"></span>
      <div class="cat-main">
        <div class="cat-name">${esc(tt(c.label))}</div>
        <div class="cat-meta">${esc(fmt(c.bytes))}${c.backupable ? "" : " · hors sauvegarde"}</div>
        ${detail}
      </div>`;
    if (c.clearable) {
      const btn = document.createElement("button");
      btn.className = "btn-soft danger";
      btn.textContent = tt("Vider");
      btn.title = tt("Supprime des données qui se retéléchargent ou se régénèrent.");
      btn.addEventListener("click", () => clearCategory(c));
      row.appendChild(btn);
    }
    host.appendChild(row);
  }
}

// La confirmation dit ce qui part ET ce que ça libère : « vider » sans chiffre
// n'aide personne à décider.
//
// Elle passe par la modale maison (lib/confirm.js) : `window.confirm()` ne
// s'affiche pas dans la webview Tauri et renvoie `false` en silence — le bouton
// « Vider » semblait alors sans effet.
async function clearCategory(cat) {
  const ok = await confirmSheet({
    title: `${tt("Vider")} « ${tt(cat.label)} » ?`,
    body: `${fmt(cat.bytes)} ${tt("seront libérés. Ces données se retéléchargent ou se régénèrent à l'usage.")}`,
    confirm: tt("Vider"),
    cancel: tt("Annuler"),
    danger: true,
  });
  if (!ok) return;
  // Supprimer plus d'un gigaoctet prend quelques secondes : on le dit, plutôt
  // que de laisser un bouton muet.
  const btn = [...document.querySelectorAll(".cat .btn-soft.danger")]
    .find((b) => b.closest(".cat")?.querySelector(".cat-name")?.textContent === tt(cat.label));
  if (btn) { btn.disabled = true; btn.textContent = tt("Suppression…"); }
  toast(`${tt("Suppression de")} « ${tt(cat.label)} »…`);
  try {
    const freed = await invoke("storage_clear", { category: cat.id });
    toast(`${fmt(freed)} ${tt("libérés.")}`);
    await refresh();
  } catch (e) {
    toast(tt("Échec :") + " " + (e?.message || e));
    if (btn) { btn.disabled = false; btn.textContent = tt("Vider"); }
  }
}

// ===== Sauvegarde à la carte =====
function renderPicks() {
  const host = $("picks");
  host.innerHTML = "";
  const cats = (report.categories || []).filter((c) => c.backupable);
  // Premier affichage : tout ce qui contient quelque chose est coché.
  if (!picks.size) for (const c of cats) if (c.bytes > 0) picks.add(c.id);
  for (const c of cats) {
    const label = document.createElement("label");
    label.className = "pick" + (c.bytes ? "" : " muted");
    label.innerHTML = `<input type="checkbox" ${picks.has(c.id) ? "checked" : ""} />`
      + `<span class="pick-dot" style="background:${COLORS[c.id] || COLORS.other}"></span>`
      + `<span class="pick-name">${esc(tt(c.label))}</span>`
      + `<span class="pick-size">${esc(fmt(c.bytes))}</span>`;
    label.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) picks.add(c.id); else picks.delete(c.id);
      estimate();
    });
    host.appendChild(label);
  }
  estimate();
}

let estimateSeq = 0;
async function estimate() {
  const mine = ++estimateSeq;
  $("estimate").textContent = tt("Calcul…");
  try {
    const res = await invoke("backup_estimate_selection", { categories: [...picks] });
    if (mine !== estimateSeq) return; // une sélection plus récente a pris la main
    $("estimate").textContent = picks.size
      ? `${res.files} ${tt("fichiers")} · ${fmt(res.bytes)} ${tt("avant compression")}`
      : tt("Rien de sélectionné.");
  } catch (e) {
    if (mine === estimateSeq) $("estimate").textContent = "";
  }
}

async function createBackup() {
  if (!picks.size) { toast(tt("Cochez au moins une catégorie.")); return; }
  const btn = $("btn-backup");
  btn.disabled = true;
  btn.textContent = tt("Sauvegarde…");
  try {
    const res = await invoke("backup_export_selection", { destDir: "", categories: [...picks] });
    const box = $("backup-result");
    box.hidden = false;
    box.innerHTML = `<div class="result-main">✓ ${esc(res.path.split("/").pop())}</div>`
      + `<div class="result-sub">${res.files} ${tt("fichiers")} · ${esc(fmt(res.archive_bytes))} ${tt("sur le disque")}</div>`;
    const open = document.createElement("button");
    open.className = "btn-soft";
    open.textContent = tt("Afficher dans le dossier");
    open.addEventListener("click", () => invoke("backup_reveal", { path: res.path }).catch(() => {}));
    box.appendChild(open);
    await refresh();
  } catch (e) {
    toast(tt("Échec :") + " " + (e?.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = tt("Créer la sauvegarde");
  }
}

function wire() {
  $("btn-refresh").addEventListener("click", refresh);
  $("btn-backup").addEventListener("click", createBackup);
  $("btn-all").addEventListener("click", () => {
    for (const c of (report?.categories || [])) if (c.backupable) picks.add(c.id);
    renderPicks();
  });
  $("btn-none").addEventListener("click", () => { picks.clear(); renderPicks(); });
}

wire();
refresh();

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
