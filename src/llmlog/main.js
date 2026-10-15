// Journal LLM — vue globale des agissements des modèles. Données via llmlog.rs
// (llm_log_list), mise à jour en direct via l'événement `llm-log`.
// Fallback sur la fenêtre parente (intégration en iframe dans le bureau).
const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const { listen } = __TAURI.event || {};
import { autoTranslate, tt } from "../apps-i18n.js";
autoTranslate({ observe: true });

const $ = (s) => document.querySelector(s);

let entries = [];
let kindFilter = "";

// Libellé + classe couleur par type d'entrée.
const KINDS = {
  call: { label: "Appel", cls: "k-call" },
  tool: { label: "Outil", cls: "k-tool" },
  delegation: { label: "Délégation", cls: "k-deleg" },
  skill: { label: "Skill", cls: "k-skill" },
  compaction: { label: "Compaction", cls: "k-compact" },
  escalation: { label: "Escalade", cls: "k-esc" },
};

window.addEventListener("DOMContentLoaded", async () => {
  $("#btn-clear").addEventListener("click", clearLog);
  $("#filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    kindFilter = chip.dataset.kind || "";
    document.querySelectorAll("#filters .chip").forEach((c) => c.classList.toggle("active", c === chip));
    render();
  });
  await reload();
  if (listen) {
    // Ajout en direct : on insère en tête sans recharger tout le fichier.
    listen("llm-log", (e) => { if (e.payload) { entries.unshift(e.payload); render(); } });
    listen("llm-log-cleared", () => { entries = []; render(); });
  }
});

async function reload() {
  try { entries = (await invoke("llm_log_list", { kind: null })) || []; }
  catch (e) { entries = []; }
  render();
}

async function clearLog() {
  try { await invoke("llm_log_clear"); entries = []; render(); }
  catch (e) { /* best-effort */ }
}

function render() {
  renderTotals();
  const list = $("#list");
  const shown = kindFilter ? entries.filter((e) => e.kind === kindFilter) : entries;
  if (!shown.length) {
    list.innerHTML = `<div class="empty">${tt("Aucune entrée. Les agissements des modèles (agents, chat, skills) apparaîtront ici.")}</div>`;
    return;
  }
  list.innerHTML = "";
  for (const e of shown.slice(0, 400)) list.appendChild(row(e));
}

function renderTotals() {
  const calls = entries.filter((e) => e.kind === "call");
  const prompt = calls.reduce((s, e) => s + (e.prompt_tokens || 0), 0);
  const gen = calls.reduce((s, e) => s + (e.gen_tokens || 0), 0);
  const esc = entries.filter((e) => e.kind === "escalation").length;
  $("#totals").innerHTML =
    `<span><b>${calls.length}</b> ${tt("appels")}</span>` +
    `<span><b>${fmtNum(prompt)}</b> ${tt("prompt")}</span>` +
    `<span><b>${fmtNum(gen)}</b> ${tt("générés")}</span>` +
    (esc ? `<span class="warn"><b>${esc}</b> ${tt("escalades")}</span>` : "");
}

function row(e) {
  const k = KINDS[e.kind] || { label: e.kind || "?", cls: "" };
  const el = document.createElement("div");
  el.className = "row" + (e.success === false ? " fail" : "");
  const when = new Date((e.ts || 0) * 1000).toLocaleString();
  const tokens = (e.prompt_tokens || e.gen_tokens)
    ? `<span class="tok">${fmtNum(e.prompt_tokens || 0)} → ${fmtNum(e.gen_tokens || 0)} tok</span>`
    : "";
  el.innerHTML =
    `<div class="row-head">` +
    `<span class="badge ${k.cls}">${tt(k.label)}</span>` +
    `<span class="src">${escapeHtml(e.source || "?")}</span>` +
    (e.model ? `<span class="model">${escapeHtml(e.model)}</span>` : "") +
    tokens +
    `<span class="when">${when}</span>` +
    `</div>` +
    `<div class="detail">${escapeHtml(e.detail || "")}</div>`;
  return el;
}

function fmtNum(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
