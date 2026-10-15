// CRON côté interface : le backend (tokio-cron-scheduler, crate `cron`) reste le
// seul à EXÉCUTER ; ici on ne fait que prévoir et expliquer. Format à 6 champs
// « sec min heure jour mois jour-sem », 7e champ « année » accepté (c'est ce
// qu'utilise une tâche ponctuelle : une date complète ne se reproduit pas).

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DOW_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const DOW_FR_SHORT = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];

/** Un champ CRON → ensemble de valeurs autorisées (null = « * »). */
function parseField(field, min, max, names = null) {
  const f = String(field || "*").trim().toLowerCase();
  if (f === "*" || f === "?") return null;
  const set = new Set();
  const value = (tok) => {
    const t = tok.trim();
    if (names) { const i = names.indexOf(t.slice(0, 3)); if (i >= 0) return names === DOWS ? i : i + 1; }
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`Champ CRON illisible : « ${tok} »`);
    return n;
  };
  for (const part of f.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!(step >= 1)) throw new Error(`Pas CRON invalide : « ${part} »`);
    let lo = min, hi = max;
    if (range !== "*" && range !== "") {
      const [a, b] = range.split("-");
      lo = value(a); hi = b != null ? value(b) : (stepStr ? max : lo);
    }
    // Jour de semaine : 7 = dimanche, comme la plupart des cron.
    if (names === DOWS) { if (lo === 7) lo = 0; if (hi === 7) hi = 0; if (hi < lo) hi = lo; }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

/** @returns {{sec,min,hour,dom,mon,dow,year}|null} sets (null = any) */
export function parseCron(expr) {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length < 6 || fields.length > 7) throw new Error("Une expression CRON a 6 champs (secondes comprises), 7 avec l'année.");
  const [sec, min, hour, dom, mon, dow, year] = fields;
  return {
    sec: parseField(sec, 0, 59), min: parseField(min, 0, 59), hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31), mon: parseField(mon, 1, 12, MONTHS), dow: parseField(dow, 0, 7, DOWS),
    year: year != null ? parseField(year, 1970, 2200) : null,
    fields,
  };
}

const ok = (set, v) => !set || set.has(v);
const firstOf = (set, min, max, from) => { for (let v = from; v <= max; v++) if (ok(set, v)) return v; return -1; };

/** Prochaine occurrence STRICTEMENT après `after` (ms), ou null (borne : 2 ans). */
export function nextRun(expr, after = Date.now()) {
  let c;
  try { c = typeof expr === "string" ? parseCron(expr) : expr; } catch { return null; }
  const start = new Date(after + 1000);
  start.setMilliseconds(0);
  const limitDays = 366 * 2;
  for (let d = 0; d < limitDays; d++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
    if (!ok(c.year, day.getFullYear()) || !ok(c.mon, day.getMonth() + 1) || !ok(c.dom, day.getDate()) || !ok(c.dow, day.getDay())) continue;
    const sameDay = d === 0;
    let h = sameDay ? start.getHours() : 0;
    for (; h <= 23; h++) {
      if (!ok(c.hour, h)) continue;
      let m = sameDay && h === start.getHours() ? start.getMinutes() : 0;
      for (; m <= 59; m++) {
        if (!ok(c.min, m)) continue;
        const sFrom = sameDay && h === start.getHours() && m === start.getMinutes() ? start.getSeconds() : 0;
        const s = firstOf(c.sec, 0, 59, sFrom);
        if (s < 0) continue;
        return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, s).getTime();
      }
    }
  }
  return null;
}

/** Les occurrences comprises dans [from, to], au plus `max`. */
export function occurrencesBetween(expr, from, to, max = 50) {
  const out = [];
  let t = nextRun(expr, from - 1000);
  while (t != null && t <= to && out.length < max) { out.push(t); t = nextRun(expr, t); }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (h, m) => `${pad(h)}:${pad(m)}`;

/** Description en français d'une expression CRON (repli : l'expression). */
export function describeCron(expr) {
  let c;
  try { c = parseCron(expr); } catch { return String(expr || ""); }
  const [sec, min, hour, dom, mon, dow, year] = c.fields;
  const one = (set) => set && set.size === 1 ? [...set][0] : null;
  const list = (set) => set ? [...set].sort((a, b) => a - b) : null;
  const time = () => {
    const hs = list(c.hour), ms = list(c.min);
    if (hs && ms && ms.length === 1) return hs.map((h) => hhmm(h, ms[0])).join(", ");
    return null;
  };
  const stepOf = (f) => /^\*\/(\d+)$/.exec(f)?.[1];
  // Fréquences courtes.
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*" && !year) {
    if (min === "*") return sec === "*" ? "Chaque seconde" : `Toutes les minutes`;
    const st = stepOf(min);
    if (st) return `Toutes les ${st} min`;
    if (one(c.min) != null) return `Toutes les heures à la minute ${one(c.min)}`;
  }
  if (dom === "*" && mon === "*" && dow === "*" && !year) {
    const st = stepOf(hour);
    if (st) return `Toutes les ${st} h${one(c.min) ? ` (à la minute ${one(c.min)})` : ""}`;
    const t = time();
    if (t) return `Tous les jours à ${t}`;
  }
  if (dom === "*" && mon === "*" && dow !== "*" && !year) {
    const days = list(c.dow) || [];
    const t = time();
    const label = days.length === 5 && days.join() === "1,2,3,4,5" ? "du lundi au vendredi"
      : days.length === 2 && days.join() === "0,6" ? "le week-end"
      : "le " + days.map((d) => DOW_FR[d]).join(", ");
    return `${label[0].toUpperCase()}${label.slice(1)}${t ? ` à ${t}` : ""}`;
  }
  if (dow === "*" && mon === "*" && dom !== "*" && !year) {
    const t = time();
    return `Le ${list(c.dom).join(", ")} de chaque mois${t ? ` à ${t}` : ""}`;
  }
  if (dow === "*" && one(c.mon) != null && one(c.dom) != null) {
    const t = time();
    return `Le ${pad(one(c.dom))}/${pad(one(c.mon))}${year ? `/${one(c.year) ?? year}` : " de chaque année"}${t ? ` à ${t}` : ""}`;
  }
  return String(expr);
}

/**
 * « Quand » simplifié → expression CRON.
 * @param {{ every: "once"|"minutes"|"hours"|"day"|"week"|"month"|"cron", time?: string,
 *           days?: number[], date?: string, n?: number, dom?: number, cron?: string }} when
 */
export function scheduleToCron(when) {
  const w = when || {};
  const [hh, mm] = String(w.time || "09:00").split(":").map((x) => Number(x) || 0);
  switch (w.every) {
    case "cron": {
      parseCron(w.cron); // valide, sinon lève
      return String(w.cron).trim();
    }
    case "minutes": { const n = Math.max(1, Math.min(59, Number(w.n) || 15)); return `0 */${n} * * * *`; }
    case "hours": { const n = Math.max(1, Math.min(23, Number(w.n) || 1)); return `0 ${mm} */${n} * * *`; }
    case "day": return `0 ${mm} ${hh} * * *`;
    case "week": {
      const days = (Array.isArray(w.days) && w.days.length ? w.days : [1]).map((d) => Number(d)).filter((d) => d >= 0 && d <= 7);
      return `0 ${mm} ${hh} * * ${[...new Set(days.map((d) => (d === 7 ? 0 : d)))].sort().join(",")}`;
    }
    case "month": return `0 ${mm} ${hh} ${Math.max(1, Math.min(31, Number(w.dom) || 1)) } * *`;
    case "once": {
      // Pas de champ année dans croner (backend) : la date complète se
      // reproduirait chaque année. L'app marque la tâche « [once] » et le
      // backend retire le workflow après sa première exécution.
      const d = new Date(`${String(w.date || "").slice(0, 10)}T${pad(hh)}:${pad(mm)}:00`);
      if (Number.isNaN(d.getTime())) throw new Error("Date invalide (AAAA-MM-JJ attendu).");
      return `0 ${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
    }
    default: throw new Error(`Fréquence inconnue : ${w.every}`);
  }
}


export const DOW_LABELS = DOW_FR_SHORT;
