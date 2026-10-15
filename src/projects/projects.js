// Vue « Projets » de l'espace Création (cf. lib/creative-kit.js).
import { listProjects, createProject, renameProject, deleteProject, detachFromProject } from "../lib/creative-kit.js";
import { openLumenApp } from "../lib/open-app.js";

const APP_LABEL = { notes: "Notes", mindmap: "Cartes mentales", moodboard: "Planches", canvas: "Canevas", opus: "Documents Opus" };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let projects = [];
let currentId = "";

async function refresh() {
  projects = await listProjects();
  if (!projects.some((p) => p.id === currentId)) currentId = projects[0]?.id || "";
  $("list").innerHTML = projects.map((p) => `<li data-id="${esc(p.id)}" class="${p.id === currentId ? "on" : ""}"><span>${esc(p.name)}</span><small>${p.items.length}</small></li>`).join("");
  $("list").querySelectorAll("li").forEach((li) => li.addEventListener("click", () => { currentId = li.dataset.id; refresh(); }));
  renderProject();
}

/** Ouvre un document dans son éditeur (le bureau sait cibler le bon élément). */
function openItem(it) {
  let host = null;
  try { host = window.top?.LumenOpenProjectItem ? window.top : null; } catch { host = null; }
  if (host) host.LumenOpenProjectItem(it);
  else openLumenApp(it.app === "opus" ? "documents" : it.app);
}

function renderProject() {
  const p = projects.find((x) => x.id === currentId);
  if (!p) return;
  const groups = {};
  for (const it of p.items) (groups[it.app] ||= []).push(it);
  $("main").innerHTML = `<h1>${esc(p.name)}</h1>
    <div class="hint">${p.items.length} document(s) · modifié le ${new Date(p.updatedAt || p.createdAt).toLocaleString()}</div>
    <div class="bar"><button class="soft" data-a="rename">Renommer</button><button class="soft danger" data-a="delete">Supprimer le projet</button></div>
    ${Object.keys(groups).length ? Object.entries(groups).map(([app, items]) => `<div class="group"><h3>${esc(APP_LABEL[app] || app)}</h3>
      ${items.map((it, i) => `<div class="item" data-app="${esc(app)}" data-i="${i}"><span>${esc(it.title || "(sans titre)")}</span><small>${new Date(it.addedAt).toLocaleDateString()}</small><button title="Retirer du projet" data-rm>✕</button></div>`).join("")}</div>`).join("")
      : '<p class="hint">Projet vide : ouvrez un document dans un éditeur et utilisez son bouton « Projet ».</p>'}`;
  $("main").querySelectorAll(".item").forEach((el) => {
    const it = groups[el.dataset.app][Number(el.dataset.i)];
    el.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rm]")) { await detachFromProject(p.id, it.app, it.ref); refresh(); return; }
      openItem(it);
    });
  });
  // confirm()/prompt() ne s'affichent pas dans la WebView de Tauri : saisie
  // en place et confirmation en deux clics.
  $("main").querySelector('[data-a="rename"]').addEventListener("click", () => {
    const h1 = $("main").querySelector("h1");
    const input = inlineInput(p.name, async (name) => { await renameProject(p.id, name); refresh(); });
    h1.replaceWith(input);
    input.focus();
    input.select();
  });
  const del = $("main").querySelector('[data-a="delete"]');
  del.addEventListener("click", async () => {
    if (!del.dataset.armed) {
      del.dataset.armed = "1";
      del.textContent = "Confirmer la suppression (les documents sont conservés)";
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "Supprimer le projet"; } }, 4000);
      return;
    }
    await deleteProject(p.id); refresh();
  });
}

function inlineInput(value, onDone) {
  const input = document.createElement("input");
  input.value = value;
  input.style.cssText = "font:inherit;font-size:16px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:transparent;color:inherit;width:100%;box-sizing:border-box";
  let done = false;
  const finish = (ok) => { if (done) return; done = true; const v = input.value.trim(); if (ok && v) onDone(v); else refresh(); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
  return input;
}

$("new").addEventListener("click", () => {
  const li = document.createElement("li");
  li.appendChild(inlineInput("Nouveau projet", async (name) => { currentId = (await createProject(name)).id; refresh(); }));
  $("list").prepend(li);
  li.firstChild.focus();
  li.firstChild.select();
});
window.addEventListener("focus", refresh);
refresh();
