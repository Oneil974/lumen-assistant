import { autoTranslate, tt } from "../apps-i18n.js";
// Diagnostic : onglets Traces (llmlog), Réponses orchestrées (localStorage
// `orchestratorTraces`, écrit par lib/orchestrator-host.js) et Profiler.
// Les iframes ne sont chargées qu'à la première ouverture de leur onglet : le
// Profiler interroge les modèles en continu, inutile de le lancer pour rien.
const tabs = [...document.querySelectorAll("[role=tab]")];
const panes = [...document.querySelectorAll("[data-pane]")];

function show(view) {
  for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.view === view));
  for (const p of panes) {
    const on = p.dataset.pane === view;
    p.hidden = !on;
    if (on && p.tagName === "IFRAME" && !p.src) p.src = p.dataset.src;
  }
  if (view === "orchestrator") renderTraces();
  try { history.replaceState(null, "", `#${view}`); } catch { /* sans importance */ }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function traces() {
  try { return JSON.parse(localStorage.getItem("orchestratorTraces") || "[]"); } catch { return []; }
}
function renderTraces() {
  const list = document.getElementById("orch-list");
  const items = traces().slice().reverse();
  if (!items.length) { list.innerHTML = `<p class="hint">${tt("Aucune réponse orchestrée pour l'instant.")}</p>`; return; }
  list.innerHTML = items.map((t) => {
    const last = (t.trace || []).at(-1);
    const tools = (t.tools || []).map((x) => x.name).join(", ") || "aucun outil";
    return `<div class="trace"><div class="q">${esc(t.query)}</div>
      <div class="meta">${esc(new Date(t.at).toLocaleString())} · ${esc(t.model || "modèle ?")} · ${esc(tools)} · ${last?.ms != null ? `${(last.ms / 1000).toFixed(1)} s` : ""}</div>
      <details><summary>Étapes</summary><pre>${esc(JSON.stringify(t.trace || [], null, 1))}</pre></details></div>`;
  }).join("");
}

document.getElementById("copy-traces").addEventListener("click", () => {
  navigator.clipboard?.writeText(JSON.stringify(traces(), null, 2)).catch(() => {});
});
for (const t of tabs) t.addEventListener("click", () => show(t.dataset.view));
autoTranslate({ observe: true });
const initial = location.hash.slice(1);
show(tabs.some((t) => t.dataset.view === initial) ? initial : "traces");

// ---- Nettoyage des journaux ----
const __T = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || null;
const invoke = __T?.core?.invoke;
const human = (n) => (n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(0)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);
const dialog = document.getElementById("clean-dialog");
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
}
document.getElementById("btn-clean").addEventListener("click", async () => {
  const sizes = invoke ? await invoke("diagnostic_logs_size").catch(() => ({})) : {};
  for (const el of dialog.querySelectorAll("[data-size]")) {
    const k = el.dataset.size;
    el.textContent = k === "orch" ? `${traces().length}` : sizes[k] != null ? human(sizes[k]) : "";
  }
  dialog.showModal();
});
dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "ok") return;
  const f = dialog.querySelector("form");
  const on = (n) => f.elements[n].checked;
  const targets = ["llm", "window", "servers"].filter(on);
  let freed = 0;
  try {
    if (targets.length && invoke) freed = await invoke("diagnostic_logs_clear", { targets });
    if (on("orch")) localStorage.removeItem("orchestratorTraces");
    if (on("usage")) Object.keys(localStorage).filter((k) => k.startsWith("ollamaDailyUsage")).forEach((k) => localStorage.removeItem(k));
    toast(`${tt("Journaux effacés")}${freed ? ` · ${human(freed)} ${tt("libérés")}` : ""}.`);
  } catch (e) { toast(`${tt("Échec :")} ${e?.message || e}`); }
  // Recharge l'onglet ouvert pour refléter le nettoyage.
  const view = document.querySelector("[role=tab][aria-selected=true]")?.dataset.view;
  if (view === "orchestrator") renderTraces();
  else { const fr = document.querySelector(`iframe[data-pane="${view}"]`); if (fr?.src) fr.src = fr.dataset.src; }
});
