// Agendas externes de l'Agenda : abonnements iCal (ENT, Moodle, ADE,
// Pronote, Google « adresse secrète », Outlook), fichiers .ics importés, et
// Google Agenda connecté (lecture + envoi des évènements Lumen).
//
// Tout est gardé dans le magasin de l'app (app-state « calendar ») :
//   ext.sources  = [{ id, kind: "ical"|"file"|"google", name, url?, calendarId?,
//                     color, lastSync, error? }]
//   ext.events.<sourceId> = [{ uid, title, start, end, allDay, location, description }]
//   gcal.target  = identifiant de l'agenda Google qui reçoit les évènements Lumen
//   gcal.map     = { idRappelLumen: idÉvènementGoogle } (pas de doublon au renvoi)
// Ces évènements sont en LECTURE SEULE dans Lumen : leur source fait foi.

import { createStore } from "../lib/app-state.js";
import { parseICS, calendarName, toICS } from "./ical.js";
import { tt } from "../apps-i18n.js";

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const store = createStore("calendar");
const PALETTE = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#16b8a6", "#ffd60a", "#5e5ce6"];
const SYNC_EVERY_MS = 30 * 60 * 1000;
const WINDOW = () => ({ from: Date.now() - 120 * 86400000, to: Date.now() + 400 * 86400000 });

export async function ready() { await store.ready(); }
export const sources = () => store.getJSON("ext.sources", []) || [];
const saveSources = (list) => store.set("ext.sources", list);
const eventsOf = (id) => store.getJSON(`ext.events.${id}`, []) || [];

/** Évènements de toutes les sources, au format d'affichage de l'Agenda. */
export function externalEvents() {
  const out = [];
  for (const s of sources()) {
    if (s.hidden) continue;
    for (const e of eventsOf(s.id)) {
      out.push({
        id: `ext:${s.id}:${e.uid}`, title: e.title, due_at: e.start, end_at: e.end,
        allDay: e.allDay, location: e.location, note: e.description,
        kind: "ext", source: s.name, color: s.color, done: false,
      });
    }
  }
  return out;
}

function nextColor() {
  const used = new Set(sources().map((s) => s.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[sources().length % PALETTE.length];
}

// ---- iCal --------------------------------------------------------------------

export async function addIcalSource(url, name = "") {
  const text = await invoke("ical_fetch", { url });
  const id = `s${Date.now().toString(36)}`;
  const src = { id, kind: "ical", url: url.trim(), name: name.trim() || calendarName(text) || tt("Agenda"), color: nextColor(), lastSync: Date.now() };
  store.set(`ext.events.${id}`, parseICS(text, WINDOW()));
  saveSources([...sources(), src]);
  return src;
}

export function importIcsText(text, name) {
  const id = `s${Date.now().toString(36)}`;
  const events = parseICS(text, { from: 0, to: Date.now() + 3 * 365 * 86400000 });
  const src = { id, kind: "file", name: name || calendarName(text) || tt("Fichier importé"), color: nextColor(), lastSync: Date.now() };
  store.set(`ext.events.${id}`, events);
  saveSources([...sources(), src]);
  return { src, count: events.length };
}

export function removeSource(id) {
  saveSources(sources().filter((s) => s.id !== id));
  store.remove(`ext.events.${id}`);
}

export function toggleSource(id) {
  saveSources(sources().map((s) => (s.id === id ? { ...s, hidden: !s.hidden } : s)));
}

async function syncOne(s) {
  if (s.kind === "ical") {
    const text = await invoke("ical_fetch", { url: s.url });
    store.set(`ext.events.${s.id}`, parseICS(text, WINDOW()));
  } else if (s.kind === "google") {
    const { from, to } = WINDOW();
    const items = await invoke("gcal_events", { calendarId: s.calendarId, timeMin: from, timeMax: to });
    store.set(`ext.events.${s.id}`, items.map((e) => ({
      uid: e.uid, title: e.title, location: e.location, description: e.description, allDay: e.allDay,
      start: e.allDay ? new Date(`${e.start}T00:00:00`).getTime() : Date.parse(e.start),
      end: e.allDay ? new Date(`${e.end}T00:00:00`).getTime() : Date.parse(e.end),
    })));
  }
}

/** Resynchronise les sources distantes. `force` ignore le délai de 30 min. */
export async function syncAll({ force = false } = {}) {
  const list = sources();
  let changed = false;
  for (const s of list) {
    if (s.kind === "file") continue;
    if (!force && s.lastSync && Date.now() - s.lastSync < SYNC_EVERY_MS) continue;
    try { await syncOne(s); s.lastSync = Date.now(); delete s.error; }
    catch (e) { s.error = String(e?.message || e); }
    changed = true;
  }
  if (changed) saveSources(list);
  return changed;
}

// ---- Google ------------------------------------------------------------------

export const gcalStatus = () => invoke("gcal_status");
export const gcalConfigure = (clientId, clientSecret) => invoke("gcal_configure", { clientId, clientSecret });
export const gcalConnect = () => invoke("gcal_connect");
export async function gcalDisconnect() {
  await invoke("gcal_disconnect");
  saveSources(sources().filter((s) => s.kind !== "google"));
  store.remove("gcal.target");
  store.remove("gcal.map");
}
export const gcalCalendars = () => invoke("gcal_calendars");

/** Abonne l'Agenda aux agendas Google cochés (et désabonne les autres). */
export async function setGoogleCalendars(chosen) {
  const keep = sources().filter((s) => s.kind !== "google" || chosen.some((c) => c.id === s.calendarId));
  for (const c of chosen) {
    if (keep.some((s) => s.kind === "google" && s.calendarId === c.id)) continue;
    const src = { id: `g${Date.now().toString(36)}${keep.length}`, kind: "google", calendarId: c.id, name: `Google · ${c.name}`, color: c.color || nextColor(), lastSync: 0 };
    keep.push(src);
  }
  for (const s of sources()) if (!keep.includes(s)) store.remove(`ext.events.${s.id}`);
  saveSources(keep);
  await syncAll({ force: true });
}

export const googleTarget = () => store.get("gcal.target", "");
export const setGoogleTarget = (id) => store.set("gcal.target", id);

/**
 * Envoie les rappels Lumen à venir (examens, révisions, rendez-vous) vers
 * l'agenda Google choisi. Un rappel déjà envoyé est MIS À JOUR, pas dupliqué.
 */
export async function pushToGoogle(reminders) {
  const target = googleTarget();
  if (!target) throw new Error(tt("Choisissez d'abord l'agenda Google qui recevra vos évènements."));
  const map = store.getJSON("gcal.map", {}) || {};
  let sent = 0;
  const since = Date.now() - 86400000;
  for (const r of reminders) {
    if (r.done || r.due_at < since) continue;
    const id = await invoke("gcal_upsert", {
      calendarId: target,
      event: {
        title: r.title, start: r.due_at, end: r.due_at + (Number(r.duration_min) || 30) * 60000,
        description: [r.note, tt("Créé depuis Lumen")].filter(Boolean).join("\n\n"),
        location: r.location || "", google_id: map[r.id] || "", all_day: false,
      },
    });
    map[r.id] = id;
    sent += 1;
  }
  store.set("gcal.map", map);
  return sent;
}

// ---- Export ------------------------------------------------------------------

/** Écrit l'agenda Lumen en .ics dans la première sandbox ; renvoie le chemin. */
export async function exportIcs(reminders) {
  const text = toICS(reminders.filter((r) => !r.done), "Lumen");
  const list = (await invoke("sandbox_list")) || [];
  const sb = list[0];
  if (!sb) throw new Error(tt("Créez d'abord une sandbox dans Fichiers."));
  const path = `Agenda/lumen-${new Date().toISOString().slice(0, 10)}.ics`;
  await invoke("sandbox_write_file", { id: sb.id, path, content: text });
  return `${sb.name}/${path}`;
}
