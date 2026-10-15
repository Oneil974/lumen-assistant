// Assistant IA du Calendrier — boîte de prompt adossée à une boucle d'appels
// d'outils (mêmes conventions que la barre : `tool_calls` OpenAI/Ollama, cf.
// sandbox/desktop.js). L'IA ne rédige jamais le JSON des rappels « en creux » :
// elle appelle des fonctions réelles (create_event, find_free_slots,
// plan_project…) qui manipulent la liste de rappels de l'app, laquelle est
// ensuite persistée par `reminders_save`.
//
// Le magasin (`store`) est fourni par main.js pour éviter tout import circulaire :
// { list, add, update, remove, persist, render, agentEvents }.



const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoMin = (d) => `${iso(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// --- Aides temps -----------------------------------------------------------

// Accepte « 2026-09-04 », « 2026-09-04 14:30 », « 2026-09-04T14:30 ».
function parseWhen(date, time) {
  const d = String(date || "").trim();
  if (!d) return NaN;
  const t = String(time || "").trim() || (d.includes(" ") || d.includes("T") ? "" : "09:00");
  const base = t ? `${d.slice(0, 10)}T${t.length === 5 ? t : t.slice(0, 5)}` : d.replace(" ", "T");
  const ms = Date.parse(base);
  return Number.isNaN(ms) ? NaN : ms;
}

function rangeMs(from, to) {
  const start = from ? parseWhen(from, "00:00") : Date.now();
  const end = to ? parseWhen(to, "23:59") : start + 14 * DAY_MS;
  return [Number.isNaN(start) ? Date.now() : start, Number.isNaN(end) ? start + 14 * DAY_MS : end];
}

const durationOf = (e) => Math.max(5, Number(e.duration_min) || 30);
const endOf = (e) => e.due_at + durationOf(e) * 60_000;

function describe(e) {
  const bits = [`${e.id} · ${isoMin(new Date(e.due_at))} (${durationOf(e)} min) · ${e.title}`];
  if (e.category) bits.push(`[${e.category}]`);
  if (e.project) bits.push(`projet:${e.project}`);
  if (Array.isArray(e.participants) && e.participants.length) bits.push(`avec ${e.participants.join(", ")}`);
  if (e.recur && e.recur !== "none") bits.push(`récurrence:${e.recur}`);
  if (e.done) bits.push("fait");
  if (e.note) bits.push(`— ${e.note}`);
  return bits.join(" ");
}

// --- Définition des outils exposés au modèle -------------------------------

import { tool as fn } from "../lib/ai-prompt.js?v=5";

const P = {
  date: { type: "string", description: "Date au format AAAA-MM-JJ" },
  time: { type: "string", description: "Heure au format HH:MM (24 h)" },
  duration: { type: "integer", description: "Durée en minutes (défaut 30)" },
  from: { type: "string", description: "Début de la période, AAAA-MM-JJ" },
  to: { type: "string", description: "Fin de la période (incluse), AAAA-MM-JJ" },
  participants: { type: "array", items: { type: "string" }, description: "Noms des participants" },
  category: { type: "string", enum: ["reunion", "tache", "jalon", "perso", "focus"], description: "Type d'entrée" },
  recur: { type: "string", enum: ["none", "daily", "weekly", "monthly"] },
};

export const CALENDAR_TOOLS = [
  fn("list_events", "Liste les entrées du calendrier sur une période. À appeler AVANT toute modification pour connaître l'existant et les identifiants.",
    { from: P.from, to: P.to, project: { type: "string", description: "Filtrer sur un projet" } }),
  fn("create_event", "Crée une entrée (rendez-vous, tâche, jalon) dans le calendrier.",
    { title: { type: "string" }, date: P.date, time: P.time, duration_min: P.duration, note: { type: "string" },
      category: P.category, participants: P.participants, project: { type: "string" }, recur: P.recur },
    ["title", "date"]),
  fn("update_event", "Modifie une entrée existante (décalage, durée, titre, note, statut).",
    { id: { type: "string" }, title: { type: "string" }, date: P.date, time: P.time, duration_min: P.duration,
      note: { type: "string" }, category: P.category, participants: P.participants, project: { type: "string" },
      recur: P.recur, done: { type: "boolean" } },
    ["id"]),
  fn("delete_event", "Supprime une entrée du calendrier par son identifiant.", { id: { type: "string" } }, ["id"]),
  fn("find_free_slots", "Cherche les créneaux libres d'une durée donnée, en respectant les horaires de travail et les entrées existantes.",
    { from: P.from, to: P.to, duration_min: P.duration, day_start: { type: "string", description: "Début de journée HH:MM (défaut 09:00)" },
      day_end: { type: "string", description: "Fin de journée HH:MM (défaut 18:00)" }, skip_weekend: { type: "boolean" } },
    ["duration_min"]),
  fn("schedule_meeting", "Organise une réunion : trouve le premier créneau libre dans la fenêtre indiquée et crée l'entrée. À préférer à create_event quand l'heure n'est pas imposée.",
    { title: { type: "string" }, duration_min: P.duration, from: P.from, to: P.to, participants: P.participants,
      note: { type: "string" }, day_start: { type: "string" }, day_end: { type: "string" } },
    ["title", "duration_min"]),
  fn("plan_project", "Planifie un projet : crée les jalons datés d'ici l'échéance. Chaque jalon devient une entrée liée au projet.",
    { name: { type: "string" }, deadline: P.date,
      milestones: { type: "array", description: "Jalons dans l'ordre chronologique",
        items: { type: "object", properties: { title: { type: "string" }, date: P.date, time: P.time, duration_min: P.duration, note: { type: "string" } }, required: ["title"] } },
      kickoff: P.date },
    ["name", "milestones"]),
  fn("project_status", "État d'avancement d'un projet (ou de tous) : jalons faits, à venir, en retard.", { name: { type: "string" } }),
  fn("analyze_workload", "Charge de travail par jour sur une période : nombre d'entrées et minutes occupées, jours surchargés.",
    { from: P.from, to: P.to, max_minutes: { type: "integer", description: "Seuil de surcharge en minutes (défaut 360)" } }),
  fn("reschedule_conflicts", "Détecte les chevauchements sur une période et décale les entrées en conflit vers le prochain créneau libre.",
    { from: P.from, to: P.to, apply: { type: "boolean", description: "false = simple diagnostic (défaut), true = applique les décalages" } }),
];

// --- Exécution des outils --------------------------------------------------

function slotsFor(store, opts) {
  const dur = Math.max(5, Number(opts.duration_min) || 30);
  const [start, end] = rangeMs(opts.from, opts.to);
  const [sh, sm] = String(opts.day_start || "09:00").split(":").map(Number);
  const [eh, em] = String(opts.day_end || "18:00").split(":").map(Number);
  const busy = store.list().concat(store.agentEvents())
    .filter((e) => !e.done && endOf(e) > start && e.due_at < end)
    .sort((a, b) => a.due_at - b.due_at);
  const out = [];
  const now = Date.now();
  for (let d = new Date(start); d.getTime() <= end && out.length < 12; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (opts.skip_weekend !== false && (d.getDay() === 0 || d.getDay() === 6)) continue;
    let cursor = Math.max(new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh || 9, sm || 0).getTime(), now);
    const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh || 18, em || 0).getTime();
    const dayBusy = busy.filter((e) => endOf(e) > cursor && e.due_at < dayEnd);
    for (const e of dayBusy) {
      if (e.due_at - cursor >= dur * 60_000) out.push([cursor, cursor + dur * 60_000]);
      cursor = Math.max(cursor, endOf(e));
    }
    if (dayEnd - cursor >= dur * 60_000) out.push([cursor, cursor + dur * 60_000]);
  }
  return out;
}

function projectsOf(store) {
  const map = new Map();
  for (const e of store.list()) {
    if (!e.project) continue;
    const p = map.get(e.project) || { name: e.project, items: [] };
    p.items.push(e);
    map.set(e.project, p);
  }
  return [...map.values()];
}

// Renvoie une chaîne : c'est le contenu du message `tool` renvoyé au modèle.
export async function runCalendarTool(store, name, args = {}) {
  const a = args || {};
  switch (name) {
    case "list_events": {
      const [start, end] = rangeMs(a.from, a.to);
      const items = store.list().concat(store.agentEvents())
        .filter((e) => e.due_at >= start && e.due_at <= end && (!a.project || e.project === a.project))
        .sort((x, y) => x.due_at - y.due_at);
      if (!items.length) return "Aucune entrée sur cette période.";
      return items.slice(0, 60).map(describe).join("\n");
    }
    case "create_event": {
      const due = parseWhen(a.date, a.time);
      if (Number.isNaN(due)) return "Erreur : date invalide (attendu AAAA-MM-JJ).";
      const e = store.add({
        title: String(a.title || "").trim() || "(sans titre)",
        note: String(a.note || ""), due_at: due, recur: a.recur || "none",
        duration_min: Math.max(5, Number(a.duration_min) || 30),
        category: a.category || "tache",
        participants: Array.isArray(a.participants) ? a.participants : undefined,
        project: a.project || undefined,
      });
      return `Créé : ${describe(e)}`;
    }
    case "update_event": {
      const e = store.list().find((x) => x.id === a.id);
      if (!e) return `Erreur : aucune entrée ${a.id}. Appelle list_events pour les identifiants.`;
      const patch = {};
      if (a.title != null) patch.title = String(a.title);
      if (a.note != null) patch.note = String(a.note);
      if (a.date || a.time) {
        const due = parseWhen(a.date || iso(new Date(e.due_at)), a.time || `${pad(new Date(e.due_at).getHours())}:${pad(new Date(e.due_at).getMinutes())}`);
        if (Number.isNaN(due)) return "Erreur : date invalide.";
        patch.due_at = due; patch.fired = false;
      }
      for (const k of ["duration_min", "category", "project", "recur", "participants", "done"]) if (a[k] != null) patch[k] = a[k];
      store.update(a.id, patch);
      return `Mis à jour : ${describe(store.list().find((x) => x.id === a.id))}`;
    }
    case "delete_event": {
      const e = store.list().find((x) => x.id === a.id);
      if (!e) return `Erreur : aucune entrée ${a.id}.`;
      store.remove(a.id);
      return `Supprimé : ${e.title}`;
    }
    case "find_free_slots": {
      const slots = slotsFor(store, a);
      if (!slots.length) return "Aucun créneau libre sur cette fenêtre.";
      return slots.map(([s, e]) => `${isoMin(new Date(s))} → ${pad(new Date(e).getHours())}:${pad(new Date(e).getMinutes())}`).join("\n");
    }
    case "schedule_meeting": {
      const slots = slotsFor(store, a);
      if (!slots.length) return "Aucun créneau libre : élargis la fenêtre (from/to) ou raccourcis la durée.";
      const [start] = slots[0];
      const e = store.add({
        title: String(a.title || "Réunion"), note: String(a.note || ""), due_at: start, recur: "none",
        duration_min: Math.max(5, Number(a.duration_min) || 30), category: "reunion",
        participants: Array.isArray(a.participants) ? a.participants : undefined,
      });
      return `Réunion planifiée : ${describe(e)}`;
    }
    case "plan_project": {
      const name2 = String(a.name || "Projet").trim();
      const list = Array.isArray(a.milestones) ? a.milestones : [];
      if (!list.length) return "Erreur : fournis au moins un jalon (milestones).";
      // Jalons sans date : réparties régulièrement entre le kickoff et l'échéance.
      const startMs = parseWhen(a.kickoff || iso(new Date()), "09:00");
      const endMs = a.deadline ? parseWhen(a.deadline, "17:00") : startMs + list.length * 7 * DAY_MS;
      const span = Math.max(DAY_MS, endMs - startMs);
      const created = list.map((m, i) => {
        const auto = startMs + Math.round((span * (i + 1)) / list.length);
        const due = m.date ? parseWhen(m.date, m.time) : auto;
        return store.add({
          title: String(m.title || `Jalon ${i + 1}`), note: String(m.note || ""),
          due_at: Number.isNaN(due) ? auto : due, recur: "none",
          duration_min: Math.max(5, Number(m.duration_min) || 60),
          category: "jalon", project: name2,
        });
      });
      return `Projet « ${name2} » planifié (${created.length} jalons) :\n` + created.map(describe).join("\n");
    }
    case "project_status": {
      const projects = projectsOf(store).filter((p) => !a.name || p.name === a.name);
      if (!projects.length) return "Aucun projet planifié pour l'instant.";
      const now = Date.now();
      return projects.map((p) => {
        const done = p.items.filter((e) => e.done).length;
        const late = p.items.filter((e) => !e.done && e.due_at < now);
        const next = p.items.filter((e) => !e.done && e.due_at >= now).sort((x, y) => x.due_at - y.due_at)[0];
        return `${p.name} : ${done}/${p.items.length} jalons faits`
          + (late.length ? ` · ${late.length} en retard (${late.map((e) => e.title).join(", ")})` : "")
          + (next ? ` · prochain : ${next.title} le ${isoMin(new Date(next.due_at))}` : " · terminé");
      }).join("\n");
    }
    case "analyze_workload": {
      const [start, end] = rangeMs(a.from, a.to);
      const cap = Number(a.max_minutes) || 360;
      const byDay = new Map();
      for (const e of store.list().concat(store.agentEvents())) {
        if (e.done || e.due_at < start || e.due_at > end) continue;
        const k = iso(new Date(e.due_at));
        const d = byDay.get(k) || { n: 0, min: 0 };
        d.n += 1; d.min += durationOf(e);
        byDay.set(k, d);
      }
      if (!byDay.size) return "Aucune charge sur cette période.";
      return [...byDay.entries()].sort().map(([k, d]) =>
        `${k} : ${d.n} entrée(s), ${d.min} min${d.min > cap ? " ⚠ surchargé" : ""}`).join("\n");
    }
    case "reschedule_conflicts": {
      const [start, end] = rangeMs(a.from, a.to);
      const items = store.list().filter((e) => !e.done && e.due_at >= start && e.due_at <= end)
        .sort((x, y) => x.due_at - y.due_at);
      const conflicts = [];
      for (let i = 1; i < items.length; i++) {
        if (items[i].due_at < endOf(items[i - 1])) conflicts.push([items[i - 1], items[i]]);
      }
      if (!conflicts.length) return "Aucun chevauchement sur cette période.";
      if (!a.apply) {
        return "Chevauchements :\n" + conflicts.map(([x, y]) => `${x.title} (${isoMin(new Date(x.due_at))}) ↔ ${y.title} (${isoMin(new Date(y.due_at))})`).join("\n")
          + "\nRappelle reschedule_conflicts avec apply=true pour les décaler.";
      }
      const moved = [];
      for (const [, y] of conflicts) {
        const slots = slotsFor(store, { duration_min: durationOf(y), from: iso(new Date(y.due_at)), to: iso(new Date(end)) });
        if (!slots.length) continue;
        store.update(y.id, { due_at: slots[0][0], fired: false });
        moved.push(`${y.title} → ${isoMin(new Date(slots[0][0]))}`);
      }
      return moved.length ? "Décalé :\n" + moved.join("\n") : "Aucun créneau libre pour décaler les conflits.";
    }
    default:
      return `Outil inconnu : ${name}`;
  }
}

// --- Contexte injecté dans le prompt système (lib/ai-prompt.js) ------------

export function calendarContext(store) {
  const upcoming = store.list().filter((e) => !e.done && e.due_at >= Date.now())
    .sort((a, b) => a.due_at - b.due_at).slice(0, 12).map(describe).join("\n") || "(agenda vide)";
  return `Aujourd'hui = ${iso(new Date())}. Agenda à venir :\n${upcoming}`;
}
