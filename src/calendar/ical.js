// iCalendar (RFC 5545) : lecture des emplois du temps (ENT, Moodle, ADE,
// Pronote, Google, Outlook) et export de l'agenda Lumen.
//
// Ce qui est pris en charge à la lecture : lignes repliées, échappements,
// DTSTART/DTEND/DURATION (UTC « Z », heure locale, TZID, journée entière),
// RRULE (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY), EXDATE,
// et les modifications d'une occurrence (RECURRENCE-ID). Un TZID est lu comme
// l'heure locale de l'appareil : c'est juste pour un emploi du temps publié
// dans le fuseau de l'étudiant, qui est le cas courant.

function unfold(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescape(v) {
  return String(v || "").replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** « 20260923T081500Z », « 20260923T081500 », « 20260923 » → { ms, allDay }. */
export function parseDate(value, params = {}) {
  const v = String(value || "").trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h == null || params.VALUE === "DATE") return { ms: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)), allDay: false };
  return { ms: new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)).getTime(), allDay: false };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || "").trim());
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (((+m[2] || 0) * 7 + (+m[3] || 0)) * 86400000 + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000);
}

function parseLine(line) {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rest] = head.split(";");
  const params = {};
  for (const p of rest) {
    const [k, ...v] = p.split("=");
    params[k.toUpperCase()] = v.join("=").replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Occurrences d'une règle RRULE entre `from` et `to` (ms). */
function expand(ev, rrule, from, to, exdates) {
  const rule = Object.fromEntries(rrule.split(";").map((p) => p.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = Number(rule.COUNT) || 0;
  const until = rule.UNTIL ? parseDate(rule.UNTIL)?.ms ?? Infinity : Infinity;
  const byDay = rule.BYDAY ? rule.BYDAY.split(",").map((d) => DAY_CODES.indexOf(d.slice(-2))).filter((d) => d >= 0) : null;
  const duration = ev.end - ev.start;
  const start = new Date(ev.start);
  const out = [];
  let n = 0;
  const push = (t) => {
    n += 1;
    if (t > until) return false;
    if (t + duration >= from && t <= to && !exdates.has(t)) out.push({ ...ev, start: t, end: t + duration, uid: `${ev.uid}#${t}` });
    return !(count && n >= count) && t <= to;
  };
  const MAX = 2000;
  if (freq === "WEEKLY") {
    // Semaine par semaine, en respectant BYDAY (sinon le jour de DTSTART).
    const days = byDay?.length ? byDay : [start.getDay()];
    const weekStart = new Date(start); weekStart.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    for (let w = 0; w < MAX; w += interval) {
      for (const d of [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) {
        const t = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + w * 7 + ((d + 6) % 7), start.getHours(), start.getMinutes(), start.getSeconds()).getTime();
        if (t < ev.start) continue;
        if (!push(t)) return out;
      }
    }
    return out;
  }
  for (let i = 0; i < MAX; i++) {
    const d = new Date(start);
    if (freq === "DAILY") d.setDate(start.getDate() + i * interval);
    else if (freq === "MONTHLY") d.setMonth(start.getMonth() + i * interval);
    else if (freq === "YEARLY") d.setFullYear(start.getFullYear() + i * interval);
    else { push(ev.start); return out; }
    if (byDay && freq === "DAILY" && !byDay.includes(d.getDay())) continue;
    if (!push(d.getTime())) return out;
  }
  return out;
}

/**
 * Texte .ics → évènements { uid, title, start, end, allDay, location, description }
 * dans la fenêtre [from, to] (récurrences dépliées).
 */
export function parseICS(text, { from = Date.now() - 90 * 86400000, to = Date.now() + 400 * 86400000 } = {}) {
  const lines = unfold(text).split("\n");
  const raw = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: new Set() }; continue; }
    if (line === "END:VEVENT") { if (cur) raw.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case "UID": cur.uid = p.value; break;
      case "SUMMARY": cur.title = unescape(p.value); break;
      case "LOCATION": cur.location = unescape(p.value); break;
      case "DESCRIPTION": cur.description = unescape(p.value); break;
      case "DTSTART": { const d = parseDate(p.value, p.params); if (d) { cur.start = d.ms; cur.allDay = d.allDay; } break; }
      case "DTEND": { const d = parseDate(p.value, p.params); if (d) cur.end = d.ms; break; }
      case "DURATION": cur.duration = parseDuration(p.value); break;
      case "RRULE": cur.rrule = p.value; break;
      case "EXDATE": for (const v of p.value.split(",")) { const d = parseDate(v, p.params); if (d) cur.exdates.add(d.ms); } break;
      case "RECURRENCE-ID": { const d = parseDate(p.value, p.params); if (d) cur.recurrenceId = d.ms; break; }
      case "STATUS": cur.status = p.value.toUpperCase(); break;
      default: break;
    }
  }
  // Occurrences modifiées : elles remplacent l'occurrence d'origine.
  const overrides = new Map();
  for (const e of raw) if (e.recurrenceId != null && e.uid) overrides.set(`${e.uid}#${e.recurrenceId}`, e);
  const out = [];
  for (const e of raw) {
    if (e.start == null || e.recurrenceId != null || e.status === "CANCELLED") continue;
    const ev = {
      uid: e.uid || `${e.start}-${e.title}`,
      title: e.title || "(sans titre)",
      start: e.start,
      end: e.end ?? (e.start + (e.duration || (e.allDay ? 86400000 : 3600000))),
      allDay: Boolean(e.allDay),
      location: e.location || "",
      description: e.description || "",
    };
    const occurrences = e.rrule ? expand(ev, e.rrule, from, to, e.exdates) : (ev.end >= from && ev.start <= to ? [ev] : []);
    for (const o of occurrences) {
      const ov = overrides.get(`${ev.uid}#${o.start}`);
      if (ov) {
        if (ov.status === "CANCELLED") continue;
        out.push({ ...o, title: ov.title || o.title, start: ov.start ?? o.start, end: ov.end ?? o.end, location: ov.location ?? o.location, description: ov.description ?? o.description });
      } else out.push(o);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Nom de l'agenda (X-WR-CALNAME), pour pré-remplir un abonnement. */
export function calendarName(text) {
  const m = /^X-WR-CALNAME:(.+)$/m.exec(unfold(text));
  return m ? unescape(m[1].trim()) : "";
}

// ---- Export ------------------------------------------------------------------

const esc = (v) => String(v || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const fold = (line) => {
  const out = [];
  let s = line;
  while (s.length > 74) { out.push(s.slice(0, 74)); s = ` ${s.slice(74)}`; }
  out.push(s);
  return out.join("\r\n");
};

/** Rappels Lumen → texte .ics (importable dans Google, Outlook, Apple). */
export function toICS(items, name = "Lumen") {
  const RR = { daily: "FREQ=DAILY", weekly: "FREQ=WEEKLY", monthly: "FREQ=MONTHLY" };
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lumen//Agenda//FR", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(name)}`];
  for (const r of items) {
    const start = r.due_at;
    const end = start + (Number(r.duration_min) || 30) * 60000;
    lines.push("BEGIN:VEVENT", `UID:${esc(r.id)}@lumen`, `DTSTAMP:${utc(Date.now())}`, `DTSTART:${utc(start)}`, `DTEND:${utc(end)}`, `SUMMARY:${esc(r.title)}`);
    if (r.note) lines.push(`DESCRIPTION:${esc(r.note)}`);
    if (r.location) lines.push(`LOCATION:${esc(r.location)}`);
    if (RR[r.recur]) lines.push(`RRULE:${RR[r.recur]}`);
    if (r.category) lines.push(`CATEGORIES:${esc(r.category)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
