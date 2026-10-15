// Tâches planifiées — logique front.
//
// Trois sources, une seule liste :
//   - les workflows Fluxo à déclencheur CRON (`list_workflow_schedules`), dont
//     ceux que CETTE app fabrique (created_by = "scheduler") : une demande à
//     l'IA (llm_infer → notify_center), un workflow ou un agent à lancer ;
//   - les agents planifiés (`agent_list`, champ `cron`) et leurs tâches datées ;
//   - les rappels du calendrier (`reminders_load`).
// Le backend exécute et journalise (`list_workflow_runs`) ; ici on prévoit
// (cron.js), on affiche, on crée et on modifie. Mettre une tâche de l'app en
// pause = repasser son déclencheur en manuel, l'expression étant gardée dans le
// magasin de l'app pour la reprise.

import { autoTranslate, tt } from "../apps-i18n.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { createStore } from "../lib/app-state.js";
import { nextRun, occurrencesBetween, describeCron, scheduleToCron, DOW_LABELS } from "./cron.js";
import { inLang } from "../lib/prompt-lang.js";

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const { listen } = __TAURI.event || {};
const $ = (id) => document.getElementById(id);

const store = createStore("scheduler");
const META_KEY = "scheduler.meta";
function readMeta() { try { return JSON.parse(store.get(META_KEY) || "{}") || {}; } catch { return {}; } }
function writeMeta(m) { store.set(META_KEY, JSON.stringify(m)); }
/** Expressions CRON des tâches de l'app mises en pause : { [nom]: expr }. */
function pausedMap() { return readMeta().paused || {}; }
function setPaused(name, expr) { const m = readMeta(); m.paused ||= {}; if (expr) m.paused[name] = expr; else delete m.paused[name]; writeMeta(m); }

const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PREFIX = "⏰ ";
const KIND_LABEL = { ai: "IA", workflow: "Fluxo", agent: "Agent", reminder: "Rappel", task: "Tâche d'agent" };

let state = { view: "upcoming", filter: "all", schedules: [], workflowNames: [], agents: [], reminders: [], runs: [] };
let editing = null; // { name } quand on modifie une tâche de l'app

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

// ===== Chargement =====
async function load() {
  if (!invoke) { $("status").textContent = tt("Hors de Lumen : aucune donnée."); return; }
  const [schedules, names, agents, remRaw, runs] = await Promise.all([
    invoke("list_workflow_schedules").catch(() => []),
    invoke("list_workflows").catch(() => []),
    invoke("agent_list").catch(() => []),
    invoke("reminders_load").catch(() => "[]"),
    invoke("list_workflow_runs").catch(() => []),
  ]);
  state.schedules = Array.isArray(schedules) ? schedules : [];
  state.workflowNames = (Array.isArray(names) ? names : []).map((w) => (typeof w === "string" ? { name: w, locked: false } : w));
  state.agents = Array.isArray(agents) ? agents : [];
  try { state.reminders = JSON.parse(remRaw || "[]"); if (!Array.isArray(state.reminders)) state.reminders = []; } catch { state.reminders = []; }
  state.runs = Array.isArray(runs) ? runs : [];
  // Tâches de l'app en pause : elles n'ont plus de CRON côté backend, on les
  // relit pour les montrer quand même (et oublier celles qui ont disparu).
  const paused = pausedMap();
  state.pausedTasks = [];
  for (const [name, expr] of Object.entries(paused)) {
    try {
      const wf = await invoke("load_workflow", { name });
      state.pausedTasks.push({ name, expr, description: wf.description || "", actions: (wf.steps || []).map((s) => s.action), created_by: wf.created_by, paused: true });
    } catch { setPaused(name, ""); }
  }
  render();
}

// ===== Modèle unifié =====
function kindOfWorkflow(w) {
  if (w.created_by !== "scheduler") return "workflow";
  const a = w.actions || [];
  if (a.includes("llm_infer")) return "ai";
  if (a.includes("run_agent")) return "agent";
  return "workflow";
}
function lastRunOf(name) { return state.runs.find((r) => r.workflow === name) || null; }

/** Toutes les tâches récurrentes (hors tâches datées d'agents et rappels ponctuels). */
function tasks() {
  const out = [];
  for (const w of [...state.schedules, ...(state.pausedTasks || [])]) {
    const kind = kindOfWorkflow(w);
    const once = String(w.description || "").includes("[once]");
    out.push({
      key: `wf:${w.name}`, kind, source: "fluxo", name: w.name, title: w.name.replace(PREFIX, ""), cron: w.expr,
      paused: !!w.paused, once, locked: !!w.locked, mine: w.created_by === "scheduler",
      schedule: once ? tt("Une fois, le {d}", { d: fmtWhen(nextRun(w.expr) || Date.now()) }) : describeCron(w.expr),
      next: w.paused ? null : nextRun(w.expr), last: lastRunOf(w.name),
    });
  }
  for (const a of state.agents) {
    if (!String(a.cron || "").trim()) continue;
    out.push({
      key: `agent:${a.id}`, kind: "agent", source: "agent", agent: a, name: a.name, title: `${a.icon ? a.icon + " " : ""}${a.name}`, cron: a.cron,
      paused: !a.enabled, once: false, locked: false, mine: false,
      schedule: describeCron(a.cron), next: a.enabled ? nextRun(a.cron) : null, last: null,
      detail: (a.tasks || []).filter((t) => !t.done).length ? tt("{n} tâche(s) en attente dans sa liste", { n: (a.tasks || []).filter((t) => !t.done).length }) : tt("Liste de tâches vide"),
    });
  }
  for (const r of state.reminders) {
    if (r.done || !r.recur || r.recur === "none") continue;
    out.push({
      key: `rem:${r.id}`, kind: "reminder", source: "reminder", reminder: r, name: r.title, title: r.title, cron: "",
      paused: false, once: false, locked: false, mine: false,
      schedule: { daily: tt("Tous les jours"), weekly: tt("Toutes les semaines"), monthly: tt("Tous les mois") }[r.recur] + ` à ${hhmm(r.due_at)}`,
      next: r.due_at, last: null, detail: r.note || "",
    });
  }
  return out.sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
}

/** Occurrences des 7 prochains jours : tâches récurrentes + rappels et tâches d'agents datés. */
function upcoming() {
  const now = Date.now(), end = now + 7 * DAY_MS;
  const out = [];
  for (const t of tasks()) {
    if (t.paused) continue;
    if (t.cron) for (const at of occurrencesBetween(t.cron, now, end, 40)) out.push({ at, task: t });
    else if (t.next != null && t.next <= end) out.push({ at: t.next, task: t });
  }
  for (const r of state.reminders) {
    if (r.done || (r.recur && r.recur !== "none") || r.due_at > end || r.due_at < now - DAY_MS) continue;
    out.push({ at: r.due_at, task: { key: `rem:${r.id}`, kind: "reminder", title: r.title, detail: r.note || "", reminder: r, source: "reminder" } });
  }
  for (const a of state.agents) for (const t of a.tasks || []) {
    if (t.done || t.due == null) continue;
    const at = t.due * 1000;
    if (at > end || at < now - DAY_MS) continue;
    out.push({ at, task: { key: `task:${a.id}:${t.id}`, kind: "task", title: t.text || "(tâche)", detail: tt("Agent {a}", { a: a.name }), agent: a, source: "agent-task" } });
  }
  return out.sort((x, y) => x.at - y.at);
}

// ===== Rendu =====
function render() {
  document.querySelectorAll("#views button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  for (const v of ["upcoming", "tasks", "journal"]) $(`view-${v}`).hidden = v !== state.view;
  const all = tasks();
  const counts = { all: all.length };
  for (const t of all) counts[t.kind] = (counts[t.kind] || 0) + 1;
  $("status").textContent = all.length ? tt("{n} tâche(s) planifiée(s)", { n: all.length }) : "";
  renderFilters($("filters-upcoming"), counts); renderFilters($("filters-tasks"), counts);
  if (state.view === "upcoming") renderUpcoming();
  else if (state.view === "tasks") renderTasks(all);
  else renderJournal();
}

function renderFilters(host, counts) {
  host.innerHTML = "";
  for (const [id, label] of [["all", tt("Toutes")], ["ai", tt("IA")], ["workflow", tt("Fluxo")], ["agent", tt("Agents")], ["reminder", tt("Rappels")]]) {
    const b = document.createElement("button");
    b.className = "chip" + (state.filter === id ? " on" : "");
    b.innerHTML = `${esc(label)}<span class="n">${counts[id] || 0}</span>`;
    b.addEventListener("click", () => { state.filter = id; render(); });
    host.appendChild(b);
  }
}
const passes = (t) => state.filter === "all" || t.kind === state.filter || (state.filter === "agent" && t.kind === "task");

function renderUpcoming() {
  const host = $("timeline"); host.innerHTML = "";
  const items = upcoming().filter((x) => passes(x.task));
  if (!items.length) { host.innerHTML = `<div class="empty"><b>${esc(tt("Rien de prévu ces 7 prochains jours."))}</b>${esc(tt("Crée une tâche : une demande à l'IA à heure fixe, un workflow, un agent ou un rappel."))}</div>`; return; }
  const today = dayKey(Date.now());
  let curDay = null, dayEl = null;
  for (const it of items) {
    const k = dayKey(it.at);
    if (k !== curDay) {
      curDay = k;
      dayEl = document.createElement("section"); dayEl.className = "day";
      dayEl.innerHTML = `<div class="day-head${k === today ? " today" : ""}">${esc(k === today ? tt("Aujourd'hui") : fmtDate(it.at))}</div>`;
      host.appendChild(dayEl);
    }
    const el = document.createElement("div");
    el.className = "slot" + (it.at < Date.now() ? " past" : "");
    el.innerHTML = `<div class="slot-time">${hhmm(it.at)}</div>
      <div class="slot-main"><div class="slot-title"><span class="kind ${it.task.kind === "task" ? "other" : it.task.kind}">${esc(KIND_LABEL[it.task.kind])}</span><span></span></div><div class="slot-sub"></div></div>
      <div class="slot-actions"></div>`;
    el.querySelector(".slot-title span:last-child").textContent = it.task.title;
    el.querySelector(".slot-sub").textContent = it.task.schedule || it.task.detail || "";
    const acts = el.querySelector(".slot-actions");
    if (it.task.kind !== "task" && it.task.kind !== "reminder") acts.appendChild(iconBtn("▶", tt("Lancer maintenant"), () => runNow(it.task)));
    dayEl.appendChild(el);
  }
}

function iconBtn(txt, title, onClick, cls = "") {
  const b = document.createElement("button"); b.className = "ico " + cls; b.textContent = txt; b.title = title;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function renderTasks(all) {
  const host = $("task-list"); host.innerHTML = "";
  const list = all.filter(passes);
  if (!list.length) { host.innerHTML = `<div class="empty"><b>${esc(tt("Aucune tâche planifiée."))}</b>${esc(tt("« Nouvelle tâche » pour en créer une, ou demande-le à l'assistant."))}</div>`; return; }
  for (const t of list) {
    const el = document.createElement("article");
    el.className = "task" + (t.paused ? " paused" : "");
    const last = t.last ? `<span class="${t.last.success ? "ok" : "ko"}">${esc(t.last.success ? tt("Dernière exécution réussie") : tt("Dernière exécution en échec"))} · ${fmtWhen(t.last.at)}</span>` : "";
    el.innerHTML = `<div class="task-main">
        <div class="task-title"><span class="kind ${t.kind}">${esc(KIND_LABEL[t.kind])}</span><span class="t"></span>${t.paused ? `<span class="kind other">${esc(tt("en pause"))}</span>` : ""}${t.locked ? `<span class="kind other">${esc(tt("verrouillé"))}</span>` : ""}</div>
        <div class="task-sched"></div>
        <div class="task-meta"><span class="next"></span>${last}</div>
        ${t.detail ? `<div class="task-detail"></div>` : ""}
      </div><div class="task-actions"></div>`;
    el.querySelector(".t").textContent = t.title;
    el.querySelector(".task-sched").textContent = t.schedule + (t.cron && !t.once ? `  ·  ${t.cron}` : "");
    el.querySelector(".next").textContent = t.paused ? tt("Ne s'exécutera pas tant qu'elle est en pause") : t.next ? tt("Prochaine : {d}", { d: fmtWhen(t.next) }) : tt("Aucune occurrence à venir");
    if (t.detail) el.querySelector(".task-detail").textContent = t.detail;
    const acts = el.querySelector(".task-actions");
    if (t.kind !== "reminder") acts.appendChild(iconBtn("▶", tt("Lancer maintenant"), () => runNow(t)));
    if (t.source === "fluxo" && t.mine || t.source === "agent") acts.appendChild(iconBtn(t.paused ? "▶︎" : "⏸", t.paused ? tt("Reprendre") : tt("Mettre en pause"), () => togglePause(t)));
    if (t.source === "fluxo" && t.mine) acts.appendChild(iconBtn("✎", tt("Modifier"), () => openModal(t)));
    if (t.source === "fluxo" && !t.locked || t.source === "reminder") acts.appendChild(iconBtn("🗑", tt("Supprimer"), () => removeTask(t), "danger"));
    host.appendChild(el);
  }
}

function renderJournal() {
  const host = $("journal"); host.innerHTML = "";
  if (!state.runs.length) { host.innerHTML = `<div class="empty"><b>${esc(tt("Aucune exécution journalisée."))}</b>${esc(tt("Chaque passage d'une tâche planifiée (ou lancé d'ici) apparaîtra ici avec sa sortie."))}</div>`; return; }
  for (const r of state.runs.slice(0, 200)) {
    const el = document.createElement("div");
    el.className = "run" + (r.success ? "" : " ko");
    el.innerHTML = `<span class="run-dot"></span><span class="run-when">${esc(fmtWhen(r.at))}</span>
      <div><span class="run-name"></span><span class="run-trigger">${esc(r.trigger === "manual" ? tt("manuel") : "cron")}</span><div class="run-out"></div></div>`;
    el.querySelector(".run-name").textContent = String(r.workflow || "").replace(PREFIX, "");
    el.querySelector(".run-out").textContent = r.output || "";
    el.addEventListener("click", () => el.classList.toggle("open"));
    host.appendChild(el);
  }
}

// ===== Actions =====
async function runNow(t) {
  try {
    if (t.source === "agent") { await invoke("agent_run_now", { id: t.agent.id }); toast(tt("Agent lancé.")); }
    else if (t.source === "fluxo") {
      toast(tt("Exécution…"));
      const res = await invoke("run_scheduled_workflow", { name: t.name });
      toast(res?.success ? tt("Terminé : ") + String(res.output || "").slice(0, 80) : tt("Échec : ") + String(res?.output || "").slice(0, 80));
      await load();
    }
  } catch (e) { toast(tt("Échec : ") + String(e?.message || e)); }
}

async function togglePause(t) {
  try {
    if (t.source === "agent") {
      await invoke("agent_save", { agent: { ...t.agent, enabled: !!t.paused } });
    } else if (t.source === "fluxo" && t.mine) {
      const wf = await invoke("load_workflow", { name: t.name });
      if (t.paused) { wf.trigger = { type: "cron", expr: pausedMap()[t.name] || t.cron }; setPaused(t.name, ""); }
      else { setPaused(t.name, t.cron); wf.trigger = { type: "manual" }; }
      await invoke("save_workflow", { workflow: wf });
      await invoke("reload_triggers");
    }
    await load();
  } catch (e) { toast(tt("Échec : ") + String(e?.message || e)); }
}

async function removeTask(t) {
  try {
    if (t.source === "reminder") await invoke("reminder_delete", { id: t.reminder.id });
    else if (t.source === "fluxo") { await invoke("delete_workflow", { name: t.name }); setPaused(t.name, ""); await invoke("reload_triggers"); }
    toast(tt("Tâche supprimée."));
    await load();
  } catch (e) { toast(tt("Échec : ") + String(e?.message || e)); }
}

// ===== Fabrique de workflows (tâches de l'app) =====
const txt = (value) => ({ type: "text", value: String(value ?? "") });

/**
 * @param {{ kind: "ai"|"workflow"|"agent", title: string, prompt?: string, speak?: boolean,
 *           workflow?: string, agent?: string, agentPrompt?: string, cron: string, once?: boolean }} spec
 */
function buildWorkflow(spec) {
  const title = String(spec.title || "").trim();
  const name = title.startsWith(PREFIX) ? title : PREFIX + title;
  const steps = [];
  if (spec.kind === "ai") {
    steps.push({ id: "answer", action: "llm_infer", name: "Demande à l'assistant", params: {
      prompt: txt(spec.prompt), backend: txt("auto"),
      system: txt(`Tu es l'assistant Lumen. Cette demande est exécutée automatiquement à heure fixe, sans interlocuteur : réponds directement, ${inLang()}, de façon concise et utile, sans poser de question. Texte simple, sans Markdown (pas d'astérisques, de titres ni de listes à tirets) : la réponse s'affiche dans une notification.`),
    } });
  } else if (spec.kind === "workflow") {
    steps.push({ id: "answer", action: "run_workflow", name: "Lancer le workflow", params: { workflow: txt(spec.workflow) } });
  } else if (spec.kind === "agent") {
    steps.push({ id: "answer", action: "run_agent", name: "Lancer l'agent", params: { agent: txt(spec.agent), prompt: txt(spec.agentPrompt || "") } });
  }
  steps.push({ id: "notify", action: "notify_center", name: "Prévenir", params: { title: txt(title), body: txt("{{answer}}") } });
  if (spec.kind === "ai" && spec.speak) steps.push({ id: "say", action: "speak", name: "Lire à voix haute", params: { text: txt("{{answer}}"), backend: txt("system"), voice: txt("") } });
  return {
    name, steps, trigger: { type: "cron", expr: spec.cron }, locked: false, available_as_tool: false,
    description: `Tâche planifiée${spec.once ? " [once]" : ""} · ${KIND_LABEL[spec.kind]}`, version: 0, created_by: "scheduler",
  };
}

async function saveTask(spec, previousName = null) {
  if (spec.kind === "reminder") {
    const at = nextRun(spec.cron);
    if (!at) throw new Error(tt("Aucune date à venir pour ce rappel."));
    const recur = spec.once ? "none" : spec.when?.every === "day" ? "daily" : spec.when?.every === "week" ? "weekly" : spec.when?.every === "month" ? "monthly" : "none";
    await invoke("reminder_add", { title: spec.title, note: spec.note || "", dueAt: at, recur, source: "user" });
    return;
  }
  const wf = buildWorkflow(spec);
  if (previousName && previousName !== wf.name) { await invoke("delete_workflow", { name: previousName }); setPaused(previousName, ""); }
  await invoke("save_workflow", { workflow: wf });
  setPaused(wf.name, "");
  await invoke("reload_triggers");
}

// ===== Modale =====
const whenState = { every: "day", days: new Set([1, 2, 3, 4, 5]) };
function kindSel() { return document.querySelector("#kinds button.on")?.dataset.kind || "ai"; }
function readWhen() {
  const w = { every: whenState.every, time: $("f-time").value || "09:00", days: [...whenState.days], date: $("f-date").value, n: Number($("f-n").value) || 1, dom: Number($("f-dom").value) || 1, cron: $("f-cron").value };
  return w;
}
function refreshModal() {
  const kind = kindSel();
  document.querySelectorAll("#kinds button").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
  document.querySelectorAll("[data-for]").forEach((el) => { el.hidden = el.dataset.for !== kind; });
  document.querySelectorAll("#whens button").forEach((b) => b.classList.toggle("on", b.dataset.when === whenState.every));
  document.querySelectorAll("[data-when-for]").forEach((el) => { el.hidden = !el.dataset.whenFor.split(" ").includes(whenState.every); });
  // Un rappel n'a que les fréquences que reminders.rs connaît.
  document.querySelectorAll("#whens button").forEach((b) => { b.hidden = kind === "reminder" && !["once", "day", "week", "month"].includes(b.dataset.when); });
  if (kind === "reminder" && !["once", "day", "week", "month"].includes(whenState.every)) { whenState.every = "day"; return refreshModal(); }
  $("f-n-unit").textContent = whenState.every === "hours" ? "h" : "min";
  $("f-n").max = whenState.every === "hours" ? 23 : 59;
  const days = $("f-days");
  if (!days.children.length) for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = DOW_LABELS[d]; b.dataset.d = d;
    b.addEventListener("click", () => { whenState.days.has(d) ? whenState.days.delete(d) : whenState.days.add(d); refreshModal(); });
    days.appendChild(b);
  }
  days.querySelectorAll("button").forEach((b) => b.classList.toggle("on", whenState.days.has(Number(b.dataset.d))));
  const prev = $("f-preview");
  try {
    const cron = scheduleToCron(readWhen());
    const next = nextRun(cron);
    prev.classList.remove("err");
    prev.textContent = `${describeCron(cron)} — ${next ? tt("prochaine : {d}", { d: fmtWhen(next) }) : tt("aucune occurrence à venir")}${kind === "reminder" && whenState.every === "week" && whenState.days.size > 1 ? " · " + tt("un rappel hebdomadaire ne retient que le premier jour") : ""}`;
  } catch (e) { prev.classList.add("err"); prev.textContent = String(e?.message || e); }
}

function fillSelects() {
  const ws = $("f-workflow"); ws.innerHTML = "";
  for (const w of state.workflowNames) { if (w.name.startsWith(PREFIX)) continue; const o = document.createElement("option"); o.value = w.name; o.textContent = w.name; ws.appendChild(o); }
  const as = $("f-agent"); as.innerHTML = "";
  for (const a of state.agents) { const o = document.createElement("option"); o.value = a.name; o.textContent = `${a.icon ? a.icon + " " : ""}${a.name}`; as.appendChild(o); }
}

async function openModal(task = null) {
  editing = null;
  fillSelects();
  $("f-err").textContent = "";
  $("f-title").value = ""; $("f-prompt").value = ""; $("f-speak").checked = false; $("f-agent-prompt").value = ""; $("f-note").value = "";
  $("f-date").value = dayKey(Date.now() + DAY_MS); $("f-time").value = "09:00"; $("f-cron").value = ""; $("f-n").value = 15; $("f-dom").value = 1;
  whenState.every = "day"; whenState.days = new Set([1, 2, 3, 4, 5]);
  document.querySelector("#kinds button.on")?.classList.remove("on");
  document.querySelector('#kinds button[data-kind="ai"]').classList.add("on");
  $("modal-title").textContent = tt("Nouvelle tâche planifiée");
  $("f-save").textContent = tt("Planifier");
  if (task) {
    // Modification : on relit le workflow pour retrouver la demande, le
    // workflow ou l'agent, et on présente l'expression telle quelle (CRON).
    try {
      const wf = await invoke("load_workflow", { name: task.name });
      editing = { name: task.name, paused: task.paused };
      const first = (wf.steps || [])[0] || {};
      const p = (k) => first.params?.[k]?.value ?? "";
      document.querySelector("#kinds button.on")?.classList.remove("on");
      document.querySelector(`#kinds button[data-kind="${task.kind}"]`).classList.add("on");
      $("f-title").value = task.title;
      $("f-prompt").value = p("prompt"); $("f-speak").checked = (wf.steps || []).some((s) => s.action === "speak");
      $("f-workflow").value = p("workflow"); $("f-agent").value = p("agent"); $("f-agent-prompt").value = p("prompt");
      whenState.every = "cron"; $("f-cron").value = task.cron;
      if (task.once) { const at = nextRun(task.cron); if (at) { whenState.every = "once"; $("f-date").value = dayKey(at); $("f-time").value = hhmm(at); } }
      $("modal-title").textContent = tt("Modifier la tâche");
      $("f-save").textContent = tt("Enregistrer");
    } catch (e) { toast(String(e?.message || e)); return; }
  }
  refreshModal();
  $("modal").hidden = false;
  $("f-title").focus();
}

async function submitModal() {
  const kind = kindSel();
  const title = $("f-title").value.trim();
  const err = (m) => { $("f-err").textContent = m; };
  if (!title) return err(tt("Un titre est nécessaire."));
  let cron;
  try { cron = scheduleToCron(readWhen()); } catch (e) { return err(String(e?.message || e)); }
  const when = readWhen();
  const spec = { kind, title, cron, once: when.every === "once", when,
    prompt: $("f-prompt").value.trim(), speak: $("f-speak").checked, workflow: $("f-workflow").value, agent: $("f-agent").value,
    agentPrompt: $("f-agent-prompt").value.trim(), note: $("f-note").value.trim() };
  if (kind === "ai" && !spec.prompt) return err(tt("Écris la demande à exécuter."));
  if (kind === "workflow" && !spec.workflow) return err(tt("Aucun workflow disponible."));
  if (kind === "agent" && !spec.agent) return err(tt("Aucun agent disponible."));
  $("f-save").disabled = true;
  try {
    await saveTask(spec, editing?.name || null);
    $("modal").hidden = true;
    toast(editing ? tt("Tâche modifiée.") : tt("Tâche planifiée."));
    await load();
  } catch (e) { err(String(e?.message || e)); }
  finally { $("f-save").disabled = false; }
}

// ===== Assistant IA intégré (mêmes outils que la modale, en langage naturel) =====
const WHEN_PARAMS = {
  every: T.enum(["once", "day", "week", "minutes", "hours", "month", "cron"], "Fréquence : once (une date), day, week (jours choisis), minutes/hours (toutes les N), month, cron (expression)"),
  time: T.str("Heure HH:MM (24 h), pour once/day/week/hours/month"),
  date: T.str("Date AAAA-MM-JJ, pour once"),
  days: T.list("Jours de semaine pour week : 0=dimanche … 6=samedi", { type: "integer" }),
  n: T.int("Intervalle N pour minutes/hours"),
  dom: T.int("Jour du mois (1-31) pour month"),
  cron: T.str("Expression CRON à 6 champs (sec min heure jour mois jour-sem), pour cron"),
};
const AI_TOOLS = [
  tool("list_scheduled_tasks", "Liste toutes les tâches planifiées (IA, workflows Fluxo, agents, rappels récurrents) avec leur fréquence, leur prochaine exécution et leur état.", {}, []),
  tool("list_upcoming", "Liste ce qui va s'exécuter dans les prochains jours, dans l'ordre chronologique.", { days: T.int("Horizon en jours (défaut 7)") }, []),
  tool("schedule_ai_task", "Crée une tâche planifiée qui pose une demande à l'assistant IA à la fréquence voulue et notifie la réponse.", {
    title: T.str("Titre court de la tâche"), prompt: T.str("La demande complète, telle que le modèle devra la traiter seul"),
    speak: T.bool("Lire la réponse à voix haute"), ...WHEN_PARAMS }, ["title", "prompt", "every"]),
  tool("schedule_workflow", "Planifie l'exécution d'un workflow Fluxo existant (voir list_workflows).", { title: T.str("Titre de la tâche"), workflow: T.str("Nom exact du workflow"), ...WHEN_PARAMS }, ["title", "workflow", "every"]),
  tool("schedule_agent", "Planifie le lancement d'un agent, avec une demande optionnelle.", { title: T.str("Titre de la tâche"), agent: T.str("Nom exact de l'agent"), prompt: T.str("Demande à lui confier (optionnel)"), ...WHEN_PARAMS }, ["title", "agent", "every"]),
  tool("create_reminder", "Crée un rappel daté (notification à l'échéance).", { title: T.str("Titre"), note: T.str("Note optionnelle"), every: T.enum(["once", "day", "week", "month"], "once = une seule fois"), time: T.str("Heure HH:MM"), date: T.str("Date AAAA-MM-JJ (once)"), days: T.list("Jour de semaine (week)", { type: "integer" }) }, ["title", "every"]),
  tool("list_workflows", "Liste les workflows Fluxo et les agents disponibles pour une planification.", {}, []),
  tool("pause_task", "Met en pause (ou reprend) une tâche : elle reste listée mais ne s'exécute plus.", { task: T.str("Titre exact de la tâche"), paused: T.bool("true = pause, false = reprise") }, ["task", "paused"]),
  tool("delete_task", "Supprime une tâche planifiée créée par cette app, ou un rappel.", { task: T.str("Titre exact") }, ["task"]),
  tool("run_task_now", "Exécute immédiatement une tâche planifiée (workflow ou agent).", { task: T.str("Titre exact") }, ["task"]),
  tool("last_runs", "Donne les dernières exécutions journalisées et leur sortie.", { task: T.str("Titre pour filtrer (optionnel)"), limit: T.int("Nombre max (défaut 5)") }, []),
];

function findTask(ref) {
  const q = String(ref || "").trim().toLowerCase().replace(PREFIX.trim(), "").trim();
  const all = tasks();
  return all.find((t) => t.title.toLowerCase() === q) || all.find((t) => t.name.toLowerCase() === q) || all.find((t) => t.title.toLowerCase().includes(q)) || null;
}
const describeTask = (t) => `- ${t.title} [${KIND_LABEL[t.kind]}]${t.paused ? " (en pause)" : ""} · ${t.schedule}${t.next ? ` · prochaine ${fmtWhen(t.next)}` : ""}${t.last ? ` · dernière ${t.last.success ? "OK" : "échec"} ${fmtWhen(t.last.at)}` : ""}`;

async function runAiTool(name, a = {}) {
  const whenOf = () => ({ every: a.every, time: a.time, date: a.date, days: a.days, n: a.n, dom: a.dom, cron: a.cron });
  switch (name) {
    case "list_scheduled_tasks": { const all = tasks(); return all.length ? all.map(describeTask).join("\n") : "Aucune tâche planifiée."; }
    case "list_upcoming": {
      const end = Date.now() + Math.max(1, Number(a.days) || 7) * DAY_MS;
      const items = upcoming().filter((x) => x.at <= end);
      return items.length ? items.map((x) => `- ${fmtWhen(x.at)} · ${x.task.title} [${KIND_LABEL[x.task.kind]}]`).join("\n") : "Rien de prévu sur cette période.";
    }
    case "list_workflows":
      return `Workflows : ${state.workflowNames.filter((w) => !w.name.startsWith(PREFIX)).map((w) => w.name).join(", ") || "(aucun)"}\nAgents : ${state.agents.map((x) => x.name).join(", ") || "(aucun)"}`;
    case "schedule_ai_task": case "schedule_workflow": case "schedule_agent": case "create_reminder": {
      const when = whenOf();
      const cron = scheduleToCron(when);
      const kind = { schedule_ai_task: "ai", schedule_workflow: "workflow", schedule_agent: "agent", create_reminder: "reminder" }[name];
      if (kind === "workflow" && !state.workflowNames.some((w) => w.name === a.workflow)) return `Erreur : workflow « ${a.workflow} » inconnu. Workflows : ${state.workflowNames.map((w) => w.name).join(", ")}`;
      if (kind === "agent" && !state.agents.some((x) => x.name === a.agent)) return `Erreur : agent « ${a.agent} » inconnu. Agents : ${state.agents.map((x) => x.name).join(", ")}`;
      await saveTask({ kind, title: String(a.title || "").trim(), cron, once: when.every === "once", when, prompt: a.prompt, speak: !!a.speak, workflow: a.workflow, agent: a.agent, agentPrompt: a.prompt, note: a.note });
      await load();
      const next = nextRun(cron);
      return `Tâche « ${a.title} » planifiée : ${describeCron(cron)}${next ? `, prochaine exécution ${fmtWhen(next)}` : ""}.`;
    }
    case "pause_task": { const t = findTask(a.task); if (!t) return `Tâche « ${a.task} » introuvable.`; if (!(t.source === "agent" || t.mine)) return "Cette tâche ne peut pas être mise en pause d'ici (workflow Fluxo externe ou rappel)."; if (!!t.paused !== !!a.paused) await togglePause(t); return `« ${t.title} » ${a.paused ? "mise en pause" : "reprise"}.`; }
    case "delete_task": { const t = findTask(a.task); if (!t) return `Tâche « ${a.task} » introuvable.`; if (t.source === "agent") return "Un agent se supprime depuis l'app Équipage ; ici on peut seulement le mettre en pause."; await removeTask(t); return `« ${t.title} » supprimée.`; }
    case "run_task_now": { const t = findTask(a.task); if (!t) return `Tâche « ${a.task} » introuvable.`; if (t.kind === "reminder") return "Un rappel ne s'exécute pas."; await runNow(t); return `« ${t.title} » lancée.`; }
    case "last_runs": {
      const q = String(a.task || "").toLowerCase();
      const runs = state.runs.filter((r) => !q || String(r.workflow).toLowerCase().includes(q)).slice(0, Math.max(1, Number(a.limit) || 5));
      return runs.length ? runs.map((r) => `- ${fmtWhen(r.at)} · ${String(r.workflow).replace(PREFIX, "")} · ${r.success ? "OK" : "ÉCHEC"} · ${String(r.output || "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n") : "Aucune exécution journalisée.";
    }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountAssistant() {
  mountAiPrompt(null, {
    app: "Tâches planifiées", title: "Assistant",
    intro: "Tu planifies des tâches : demandes à l'IA à heure fixe, workflows Fluxo, agents, rappels.",
    rules: "- Résous toi-même les dates et heures relatives (« demain matin » → date AAAA-MM-JJ + 09:00).\n- Pour « tous les matins », every=day ; pour « en semaine », every=week avec days=[1,2,3,4,5].\n- Avant de planifier un workflow ou un agent, vérifie son nom exact avec list_workflows.",
    placeholder: "Ex. : chaque matin à 8 h, résume-moi l'actualité tech en 5 points…",
    suggestions: [
      { label: "Tâche IA quotidienne", prompt: "Planifie tous les jours à 08:00 une demande à l'IA : « Donne-moi une citation inspirante et une idée d'action pour la journée ». Titre : Bonjour." },
      { label: "Ce qui arrive", prompt: "Qu'est-ce qui est prévu dans les 3 prochains jours ?" },
      { label: "Dernières exécutions", prompt: "Montre-moi les dernières exécutions et signale celles en échec." },
    ],
    tools: AI_TOOLS,
    context: () => { const all = tasks(); return `Aujourd'hui = ${dayKey(Date.now())} ${hhmm(Date.now())}.\nTâches :\n${all.length ? all.map(describeTask).join("\n") : "(aucune)"}`; },
    execute: (name, args) => runAiTool(name, args || {}),
    onApplied: () => render(),
  });
}

// ===== App Intents (mêmes outils, exposés à l'assistant de Lumen) =====
function registerIntents() {
  const api = window.lumen?.intents;
  if (!api) return;
  for (const id of ["create_scheduled_task", "list_scheduled_tasks", "run_scheduled_task"]) {
    api.on(id, async (args) => {
      const a = args || {};
      if (id === "list_scheduled_tasks") return runAiTool("list_scheduled_tasks");
      if (id === "run_scheduled_task") return runAiTool("run_task_now", a);
      const kind = { ai: "schedule_ai_task", workflow: "schedule_workflow", agent: "schedule_agent", reminder: "create_reminder" }[a.kind || "ai"] || "schedule_ai_task";
      return runAiTool(kind, a);
    }).catch(() => {});
  }
}

// ===== Câblage =====
function wire() {
  document.querySelectorAll("#views button").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.view; render(); }));
  $("btn-new").addEventListener("click", () => openModal());
  $("btn-refresh").addEventListener("click", () => load());
  $("f-cancel").addEventListener("click", () => { $("modal").hidden = true; });
  $("f-save").addEventListener("click", submitModal);
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").hidden) $("modal").hidden = true; });
  document.querySelectorAll("#kinds button").forEach((b) => b.addEventListener("click", () => { document.querySelector("#kinds button.on")?.classList.remove("on"); b.classList.add("on"); refreshModal(); }));
  document.querySelectorAll("#whens button").forEach((b) => b.addEventListener("click", () => { whenState.every = b.dataset.when; refreshModal(); }));
  for (const id of ["f-time", "f-date", "f-n", "f-dom", "f-cron"]) $(id).addEventListener("input", refreshModal);
  if (listen) {
    for (const ev of ["workflow-triggered", "workflows-changed", "reminders-updated", "agents-updated"]) {
      listen(ev, () => { clearTimeout(wire._t); wire._t = setTimeout(load, 400); }).catch(() => {});
    }
  }
  // La prochaine occurrence bouge avec l'heure : rafraîchir la frise chaque minute.
  setInterval(() => { if (!document.hidden && $("modal").hidden) render(); }, 60_000);
}

autoTranslate({ observe: true });
wire();
mountAssistant();
registerIntents();
// Le magasin lit son fichier de façon asynchrone : la liste des tâches en
// pause n'est connue qu'ensuite.
Promise.resolve(store.ready?.()).catch(() => {}).then(load);
