import { autoTranslate, tt } from "../apps-i18n.js";
import { CALENDAR_TOOLS, runCalendarTool, calendarContext } from "./ai.js";
import { mountAiPrompt } from "../lib/ai-prompt.js?v=5";
import { registerTranslations } from "../apps-i18n.js";
import { CALENDAR_EN } from "./i18n.js";
import * as ext from "./sync.js";

registerTranslations(CALENDAR_EN);
// Calendrier de Lumen — logique front. Charge les rappels (reminders_load),
// les édite (reminders_save : blob complet) et les affiche sur une grille
// mensuelle + une colonne « à venir / jour sélectionné ». Les rappels créés ici
// sont déclenchés par le ticker backend (reminders.rs) qui notifie l'utilisateur
// à l'échéance. Se rafraîchit sur l'évènement `reminders-updated`.

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const { listen } = __TAURI.event || {};

const $ = (id) => document.getElementById(id);
const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const RECUR_LABEL = { daily: "quotidien", weekly: "hebdo", monthly: "mensuel" };
const CAT_LABEL = { reunion: "réunion", tache: "tâche", jalon: "jalon", perso: "perso", focus: "focus", cours: "cours", examen: "examen", revision: "révision" };

let reminders = [];
let agentTasks = []; // todos programmées des agents (lecture seule)
let workflowSchedules = []; // workflows CRON (lecture seule, issus d'Automations)
let view = new Date(); // mois affiché
let selectedKey = null; // jour sélectionné (yyyy-mm-dd) ou null = « à venir »
let editingId = null;

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const keyOfMs = (ms) => dayKey(new Date(ms));
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

async function load() {
  try {
    const raw = await invoke("reminders_load");
    reminders = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(reminders)) reminders = [];
  } catch { reminders = []; }
  await loadAgentTasks();
  await loadWorkflowSchedules();
  render();
  // Emplois du temps distants : affichés depuis le cache tout de suite,
  // rafraîchis en arrière-plan (30 min au plus entre deux téléchargements).
  ext.syncAll().then((changed) => { if (changed) render(); }).catch(() => {});
}

async function loadWorkflowSchedules() {
  try { workflowSchedules = await invoke("list_workflow_schedules") || []; }
  catch { workflowSchedules = []; }
}

// Todos programmées des agents (champ `due`, en secondes epoch). Lecture seule :
// elles s'affichent dans le calendrier mais s'éditent dans l'app Agents.
async function loadAgentTasks() {
  agentTasks = [];
  try {
    const agents = await invoke("agent_list");
    for (const a of agents || []) {
      for (const t of a.tasks || []) {
        if (t.due == null) continue;
        agentTasks.push({
          id: `agent:${a.id}:${t.id}`,
          title: t.text || "(tâche)",
          due_at: t.due * 1000,
          done: !!t.done,
          agent: a.name || "Agent",
          kind: "agent",
        });
      }
    }
  } catch { /* app agents indisponible : on ignore */ }
}

// Liste unifiée rappels + tâches d'agents pour l'affichage.
function events() {
  const rem = reminders.map((r) => ({ ...r, kind: "reminder" }));
  return rem.concat(agentTasks, scheduledWorkflowEvents(), ext.externalEvents());
}

// Affiche les CRON quotidiens (ou plus fréquents) sur chaque journée du mois.
// Les expressions CRON restent exécutées par le backend ; ceci est uniquement
// leur représentation de calendrier, non éditable depuis cette vue.
function scheduledWorkflowEvents() {
  const year = view.getFullYear(), month = view.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const out = [];
  for (const schedule of workflowSchedules) {
    const fields = String(schedule.expr || "").trim().split(/\s+/);
    if (fields.length !== 6) continue;
    const [sec, min, hour, day, mon, weekDay] = fields;
    if (![day, mon, weekDay].every(v => v === "*")) continue; // vue calendrier : fréquence quotidienne
    const minute = /^\d+$/.test(min) ? Number(min) : 0;
    const hours = /^\d+$/.test(hour) ? [Number(hour)] : [9];
    for (let d = 1; d <= days; d++) for (const h of hours) {
      const due = new Date(year, month, d, h, minute, /^\d+$/.test(sec) ? Number(sec) : 0).getTime();
      out.push({ id: `workflow:${schedule.name}:${d}:${h}`, title: schedule.name, due_at: due, done: false, kind: "workflow", cron: schedule.expr });
    }
  }
  return out;
}

async function persist() {
  try { await invoke("reminders_save", { data: JSON.stringify(reminders) }); }
  catch (e) { toast("Échec de l'enregistrement"); console.error(e); }
}

// ===== Rendu de la grille mensuelle =====
function render() {
  $("month-label").textContent = view.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const wd = $("weekdays");
  wd.innerHTML = WEEKDAYS.map((d) => `<span>${d}</span>`).join("");

  const year = view.getFullYear(), month = view.getMonth();
  const first = new Date(year, month, 1);
  // Lundi = 0 … Dimanche = 6
  const lead = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - lead);
  const todayKey = dayKey(new Date());

  // Regroupe rappels + tâches d'agents par jour.
  const byDay = {};
  for (const r of events()) {
    const k = keyOfMs(r.due_at);
    (byDay[k] = byDay[k] || []).push(r);
  }

  const grid = $("grid");
  grid.innerHTML = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const k = dayKey(d);
    const cell = document.createElement("div");
    cell.className = "cell"
      + (d.getMonth() !== month ? " dim" : "")
      + (k === todayKey ? " today" : "")
      + (k === selectedKey ? " selected" : "");
    cell.innerHTML = `<span class="cell-num">${d.getDate()}</span>`;
    const items = (byDay[k] || []).sort((a, b) => a.due_at - b.due_at);
    items.slice(0, 3).forEach((r) => {
      const chip = document.createElement("div");
      chip.className = "chip" + (r.done ? " done" : "") + (r.kind === "agent" ? " agent" : "")
        + (r.kind === "ext" ? " ext" : "") + (r.category ? " cat-" + r.category : "");
      if (r.kind === "ext") chip.style.setProperty("--src", r.color);
      chip.textContent = r.kind === "agent"
        ? `👤 ${r.title}`
        : r.allDay ? r.title
        : `${new Date(r.due_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} ${r.title}`;
      cell.appendChild(chip);
    });
    if (items.length > 3) {
      const more = document.createElement("div");
      more.className = "chip more";
      more.textContent = `+${items.length - 3} autre${items.length - 3 > 1 ? "s" : ""}`;
      cell.appendChild(more);
    }
    cell.addEventListener("click", () => {
      selectedKey = (selectedKey === k) ? null : k;
      render();
    });
    cell.addEventListener("dblclick", () => openModal(null, k));
    grid.appendChild(cell);
  }

  renderSide();
}

// ===== Colonne latérale =====
function renderSide() {
  const list = $("rem-list");
  list.innerHTML = "";
  let items, headLabel;

  if (selectedKey) {
    const d = new Date(selectedKey + "T00:00:00");
    headLabel = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    items = events().filter((r) => keyOfMs(r.due_at) === selectedKey).sort((a, b) => a.due_at - b.due_at);
  } else {
    headLabel = "À venir";
    const today0 = startOfDay(new Date());
    items = events()
      // Un cours passé n'est pas « à venir » ; un rappel en retard, si.
      .filter((r) => !r.done && !(r.kind === "ext" && (r.end_at || r.due_at) < today0))
      .sort((a, b) => a.due_at - b.due_at)
      .slice(0, 60);
  }
  $("side-head").textContent = headLabel.charAt(0).toUpperCase() + headLabel.slice(1);
  $("rem-empty").hidden = items.length > 0;

  const now = Date.now();
  for (const r of items) {
    const isAgent = r.kind === "agent", isWorkflow = r.kind === "workflow", isExt = r.kind === "ext";
    const el = document.createElement("div");
    el.className = "rem" + (r.done ? " done" : "") + (!r.done && r.due_at < now ? " rem-overdue" : "") + (isAgent ? " rem-agent" : "") + (isWorkflow ? " rem-agent" : "");
    const check = document.createElement("div");
    check.className = "rem-check";
    check.innerHTML = r.done ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : "";
    if (isExt) {
      check.classList.add("ext-dot");
      check.style.background = r.color;
      check.title = tt("Évènement de « {s} » (lecture seule)", { s: r.source });
    } else if (isAgent || isWorkflow) {
      check.title = "Tâche d'agent (gérée dans l'app Agents)";
    } else {
      check.title = r.done ? "Marquer à faire" : "Marquer fait";
      check.addEventListener("click", (e) => { e.stopPropagation(); toggleDone(r.id); });
    }
    const main = document.createElement("div");
    main.className = "rem-main";
    if (isExt) {
      const when = r.allDay
        ? new Date(r.due_at).toLocaleDateString(undefined, { day: "2-digit", month: "short" })
        : `${new Date(r.due_at).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}–${new Date(r.end_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
      main.innerHTML = `<div class="rem-title">${esc(r.title)}</div><div class="rem-meta">${esc(when)}${r.location ? ` · 📍 ${esc(r.location)}` : ""}<span class="rem-badge" style="border-color:${esc(r.color)}">${esc(r.source)}</span></div>`;
    } else if (isAgent) {
      const when = new Date(r.due_at).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
      main.innerHTML = `<div class="rem-title">${esc(r.title)}</div><div class="rem-meta">${esc(when)}<span class="rem-badge">👤 ${esc(r.agent)}</span></div>`;
    } else if (isWorkflow) {
      const when = new Date(r.due_at).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      main.innerHTML = `<div class="rem-title">${esc(r.title)}</div><div class="rem-meta">${esc(when)}<span class="rem-badge">⚡ CRON</span></div>`;
    } else {
      const when = new Date(r.due_at).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      const recur = r.recur && r.recur !== "none" ? `<span class="rem-badge">${RECUR_LABEL[r.recur] || r.recur}</span>` : "";
      const src = r.source === "ai" ? '<span class="rem-badge">IA</span>' : (r.source === "agent" ? '<span class="rem-badge">agent</span>' : "");
      const cat = r.category ? `<span class="rem-badge cat-${esc(r.category)}">${esc(CAT_LABEL[r.category] || r.category)}</span>` : "";
      const proj = r.project ? `<span class="rem-badge">▣ ${esc(r.project)}</span>` : "";
      const dur = r.duration_min ? ` · ${esc(r.duration_min)} min` : "";
      const who = Array.isArray(r.participants) && r.participants.length
        ? `<div class="rem-meta">👥 ${esc(r.participants.join(", "))}</div>` : "";
      main.innerHTML = `<div class="rem-title">${esc(r.title)}</div><div class="rem-meta">${esc(when)}${dur}${cat}${proj}${recur}${src}${r.note ? " · " + esc(r.note) : ""}</div>${who}`;
      main.addEventListener("click", () => openModal(r.id));
    }
    el.append(check, main);
    list.appendChild(el);
  }
}

function esc(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }

// ===== Mutations =====
async function toggleDone(id) {
  const r = reminders.find((x) => x.id === id);
  if (!r) return;
  r.done = !r.done;
  if (!r.done) r.fired = false; // re-déclenchera s'il est de nouveau échu
  await persist();
  render();
}

// ===== Modal création / édition =====
function openModal(id, dateKey) {
  editingId = id || null;
  const r = id ? reminders.find((x) => x.id === id) : null;
  $("modal-title").textContent = r ? "Modifier le rappel" : "Nouveau rappel";
  $("f-delete").hidden = !r;
  $("f-title").value = r ? r.title : "";
  $("f-note").value = r ? (r.note || "") : "";
  $("f-recur").value = r ? (r.recur || "none") : "none";
  $("f-duration").value = r ? (r.duration_min || 30) : 30;
  $("f-category").value = r ? (r.category || "tache") : "tache";
  $("f-project").value = r ? (r.project || "") : "";
  $("f-participants").value = r && Array.isArray(r.participants) ? r.participants.join(", ") : "";
  const base = r ? new Date(r.due_at) : defaultWhen(dateKey);
  $("f-date").value = dayKey(base);
  $("f-time").value = `${pad(base.getHours())}:${pad(base.getMinutes())}`;
  $("overlay").hidden = false;
  $("f-title").focus();
}

function defaultWhen(dateKey) {
  if (dateKey) { const d = new Date(dateKey + "T09:00:00"); return d; }
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function closeModal() { $("overlay").hidden = true; editingId = null; }

async function saveModal() {
  const title = $("f-title").value.trim();
  if (!title) { toast("Donnez un intitulé"); return; }
  const date = $("f-date").value;
  const time = $("f-time").value || "09:00";
  const due = Date.parse(`${date}T${time}`);
  if (Number.isNaN(due)) { toast("Date/heure invalide"); return; }
  const recur = $("f-recur").value;
  const note = $("f-note").value.trim();
  const duration_min = Math.max(5, parseInt($("f-duration").value, 10) || 30);
  const category = $("f-category").value;
  const project = $("f-project").value.trim();
  const participants = $("f-participants").value.split(",").map((s) => s.trim()).filter(Boolean);
  const extra = { duration_min, category, project: project || undefined, participants: participants.length ? participants : undefined };

  if (editingId) {
    const r = reminders.find((x) => x.id === editingId);
    if (r) {
      Object.assign(r, { title, note, due_at: due, recur, fired: false }, extra);
      if (!project) delete r.project;
      if (!participants.length) delete r.participants;
    }
  } else {
    reminders.unshift({
      id: "rem-" + Date.now(), title, note, due_at: due, recur,
      done: false, fired: false, source: "user", created_at: Date.now(),
      ...extra,
    });
  }
  await persist();
  selectedKey = keyOfMs(due);
  view = new Date(due);
  closeModal();
  render();
}

async function deleteEditing() {
  if (!editingId) return;
  reminders = reminders.filter((x) => x.id !== editingId);
  await persist();
  closeModal();
  render();
}

// ===== Magasin exposé à l'assistant IA (ai.js) =====
// Les outils du modèle passent tous par ici : une seule source de vérité pour
// la liste, et un `persist()`/`render()` déclenchés par la boucle agentique.
const store = {
  list: () => reminders,
  agentEvents: () => agentTasks.concat(scheduledWorkflowEvents()),
  add(ev) {
    const r = {
      id: "rem-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      title: ev.title, note: ev.note || "", due_at: ev.due_at,
      recur: ev.recur || "none", done: false, fired: false,
      source: "ai", created_at: Date.now(),
      duration_min: ev.duration_min || 30,
      ...(ev.category ? { category: ev.category } : {}),
      ...(ev.project ? { project: ev.project } : {}),
      ...(ev.participants && ev.participants.length ? { participants: ev.participants } : {}),
    };
    reminders.unshift(r);
    return r;
  },
  update(id, patch) {
    const r = reminders.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
    return r;
  },
  remove(id) { reminders = reminders.filter((x) => x.id !== id); },
  persist,
  render,
};

// ===== Panneau IA (composant partagé lib/ai-prompt.js) =====
function mountAI() {
  mountAiPrompt(null, {
    app: "Calendrier",
    title: "Assistant",
    intro: "Tu gères l'agenda : rendez-vous, réunions, jalons de projet, charge de travail.",
    rules: "- Pour une réunion sans heure imposée, utilise schedule_meeting (il choisit un créneau libre) plutôt que create_event.\n- Pour un projet, décompose en jalons chronologiques et appelle plan_project une seule fois.\n- Résous les dates relatives (« demain », « lundi prochain ») toi-même, en AAAA-MM-JJ.",
    placeholder: "Ex. : cale un point projet de 45 min avec Léa jeudi matin…",
    suggestions: [
      { label: "Caler une réunion", prompt: "Organise une réunion d'équipe d'une heure cette semaine sur un créneau libre." },
      { label: "Planifier un projet", prompt: "Planifie un projet en jalons hebdomadaires jusqu'à sa livraison. Demande-moi le nom et l'échéance si besoin." },
      { label: "Suivi de projet", prompt: "Fais le point sur mes projets en cours et ce qui est en retard." },
      { label: "Ma charge", prompt: "Analyse ma charge des 14 prochains jours et signale les jours surchargés." },
      { label: "Résoudre les conflits", prompt: "Détecte les chevauchements des 14 prochains jours et décale ce qui est en conflit." },
    ],
    tools: CALENDAR_TOOLS,
    context: () => calendarContext(store),
    execute: (name, args) => runCalendarTool(store, name, args),
    onApplied: async () => { await persist(); render(); },
  });
}

// ===== Évènements UI =====
function wire() {
  $("prev-month").addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); render(); });
  $("next-month").addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); render(); });
  $("btn-today").addEventListener("click", () => { view = new Date(); selectedKey = dayKey(new Date()); render(); });
  $("btn-new").addEventListener("click", () => openModal(null, selectedKey));
  $("f-cancel").addEventListener("click", closeModal);
  $("f-save").addEventListener("click", saveModal);
  $("f-delete").addEventListener("click", deleteEditing);
  $("overlay").addEventListener("click", (e) => { if (e.target === $("overlay")) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("overlay").hidden) closeModal();
    if (e.key === "Enter" && !$("overlay").hidden && document.activeElement?.id !== "f-note") saveModal();
  });

  if (listen) {
    listen("reminders-updated", () => load());
    listen("reminder-fired", (e) => { const t = e?.payload?.title; if (t) toast(`⏰ ${t}`); load(); });
    listen("agents-updated", () => load());
  }
}

// ===== Agendas externes =====
async function renderSources() {
  const list = ext.sources();
  $("src-list").innerHTML = list.length ? list.map((s) => `
    <div class="src-item${s.hidden ? " off" : ""}">
      <span class="src-dot" style="background:${esc(s.color)}"></span>
      <span class="src-tx"><b>${esc(s.name)}</b><small>${esc(s.kind === "file" ? tt("fichier importé") : s.kind === "google" ? "Google Agenda" : (s.url || "").replace(/(\?|\/private\/|token=).*/, "$1…"))}${s.lastSync ? ` · ${esc(tt("mis à jour"))} ${new Date(s.lastSync).toLocaleString()}` : ""}${s.error ? ` · ⚠️ ${esc(s.error)}` : ""}</small></span>
      <button class="btn-ico" data-toggle="${s.id}" title="${esc(tt(s.hidden ? "Afficher" : "Masquer"))}">${s.hidden ? "◌" : "●"}</button>
      <button class="btn-ico" data-remove="${s.id}" title="${esc(tt("Retirer"))}">✕</button>
    </div>`).join("") : `<p class="muted">${esc(tt("Aucun agenda externe pour l'instant."))}</p>`;
  await renderGoogle();
}

async function renderGoogle() {
  const box = $("gcal-body");
  let st;
  try { st = await ext.gcalStatus(); } catch { box.innerHTML = `<p class="muted">${esc(tt("Disponible dans l'application Lumen."))}</p>`; return; }
  if (!st.configured || !st.connected) {
    box.innerHTML = `
      <ol class="muted steps">
        <li>${esc(tt("Ouvrez console.cloud.google.com, créez un projet et activez « Google Calendar API »."))}</li>
        <li>${esc(tt("Écran de consentement : type « Externe », ajoutez votre adresse comme utilisateur test."))}</li>
        <li>${esc(tt("Identifiants › Créer › ID client OAuth › type « Application de bureau »."))}</li>
        <li>${esc(tt("Collez l'ID client et le code secret ci-dessous, puis « Connecter ». Ils restent sur cet appareil."))}</li>
      </ol>
      <div class="src-row">
        <input class="input grow" id="gcal-id" placeholder="…apps.googleusercontent.com" value="${st.configured ? esc(st.client_id_hint) + "…" : ""}" />
        <input class="input" id="gcal-secret" type="password" placeholder="${esc(tt("Code secret du client"))}" style="max-width:200px" />
        <button class="btn-soft primary" id="gcal-connect">${esc(tt("Connecter"))}</button>
      </div>`;
    $("gcal-connect").onclick = async () => {
      const id = $("gcal-id").value.trim();
      try {
        if (!id.endsWith("…")) await ext.gcalConfigure(id, $("gcal-secret").value);
        toast(tt("Validez l'accès dans le navigateur…"));
        const email = await ext.gcalConnect();
        toast(tt("Google Agenda connecté : {e}", { e: email || "OK" }));
        renderGoogle();
      } catch (e) { toast(String(e?.message || e)); }
    };
    return;
  }
  box.innerHTML = `<p>${esc(tt("Connecté en tant que {e}.", { e: st.email || "Google" }))}</p><div id="gcal-cals" class="muted">${esc(tt("Chargement…"))}</div>`;
  let cals = [];
  try { cals = await ext.gcalCalendars(); } catch (e) { $("gcal-cals").textContent = String(e?.message || e); return; }
  const shown = new Set(ext.sources().filter((s) => s.kind === "google").map((s) => s.calendarId));
  const target = ext.googleTarget();
  $("gcal-cals").innerHTML = `
    <div class="gcal-grid">${cals.map((c) => `<label class="chk"><input type="checkbox" data-gcal="${esc(c.id)}" ${shown.has(c.id) ? "checked" : ""}/> <span class="src-dot" style="background:${esc(c.color || "#999")}"></span> ${esc(c.name)}</label>`).join("")}</div>
    <div class="src-row">
      <button class="btn-soft" id="gcal-apply">${esc(tt("Afficher les agendas cochés"))}</button>
    </div>
    <div class="src-row">
      <label class="muted">${esc(tt("Envoyer mes rappels Lumen vers"))}</label>
      <select class="select" id="gcal-target">${[`<option value="">—</option>`, ...cals.filter((c) => c.writable).map((c) => `<option value="${esc(c.id)}" ${c.id === target ? "selected" : ""}>${esc(c.name)}</option>`)].join("")}</select>
      <button class="btn-soft primary" id="gcal-push">${esc(tt("Envoyer"))}</button>
      <span class="spacer"></span>
      <button class="btn-soft danger" id="gcal-off">${esc(tt("Déconnecter"))}</button>
    </div>`;
  $("gcal-apply").onclick = async () => {
    const chosen = cals.filter((c) => $("gcal-cals").querySelector(`[data-gcal="${CSS.escape(c.id)}"]`)?.checked);
    await ext.setGoogleCalendars(chosen);
    toast(tt("Agendas Google mis à jour."));
    render(); renderSources();
  };
  $("gcal-target").onchange = (e) => ext.setGoogleTarget(e.target.value);
  $("gcal-push").onclick = async () => {
    try { const n = await ext.pushToGoogle(reminders); toast(tt("{n} évènement(s) envoyé(s) vers Google.", { n })); }
    catch (e) { toast(String(e?.message || e)); }
  };
  $("gcal-off").onclick = async () => { await ext.gcalDisconnect(); toast(tt("Google Agenda déconnecté.")); render(); renderSources(); };
}

function wireSources() {
  $("btn-sources").addEventListener("click", async () => { await ext.ready(); $("src-overlay").hidden = false; renderSources(); });
  $("src-close").addEventListener("click", () => ($("src-overlay").hidden = true));
  $("src-add").addEventListener("click", async () => {
    const url = $("src-url").value.trim();
    if (!url) return;
    $("src-state").textContent = tt("Téléchargement…");
    try {
      const s = await ext.addIcalSource(url, $("src-name").value);
      $("src-url").value = ""; $("src-name").value = "";
      toast(tt("Abonné à « {n} ».", { n: s.name }));
      render(); renderSources();
    } catch (e) { toast(String(e?.message || e)); }
    $("src-state").textContent = "";
  });
  $("src-sync").addEventListener("click", async () => {
    $("src-state").textContent = tt("Synchronisation…");
    await ext.syncAll({ force: true });
    $("src-state").textContent = "";
    render(); renderSources();
  });
  $("src-import").addEventListener("click", () => $("src-file").click());
  $("src-file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const { src, count } = ext.importIcsText(await f.text(), f.name.replace(/\.ics$/i, ""));
    toast(tt("{n} évènement(s) importé(s) dans « {s} ».", { n: count, s: src.name }));
    render(); renderSources();
  });
  $("src-export").addEventListener("click", async () => {
    try { toast(`${tt("Exporté")} : ${await ext.exportIcs(reminders)}`); } catch (e) { toast(String(e?.message || e)); }
  });
  $("src-list").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.toggle) ext.toggleSource(b.dataset.toggle);
    if (b.dataset.remove) ext.removeSource(b.dataset.remove);
    render(); renderSources();
  });
}

wire();
wireSources();
mountAI();
ext.ready().then(load);
// Resynchronisation périodique tant que l'Agenda est ouvert.
setInterval(() => ext.syncAll().then((c) => c && render()).catch(() => {}), 10 * 60 * 1000);

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
