// Éditeur de récurrence CRON : constructeur visuel + saisie manuelle + aperçu
// des prochaines exécutions.
//
// Jusqu'ici la planification d'un agent se choisissait dans une liste de trois
// presets. Tout le reste — « le lundi et le jeudi à 7 h », « le 1er et le 15 »,
// « le dernier jour du mois » — était hors d'atteinte alors que le planificateur
// (tokio-cron-scheduler / croner) le sait faire depuis toujours.
//
// ## Le format exact
//
// SIX champs, secondes comprises : `sec min heure jour-du-mois mois jour-semaine`.
// `Job::new_async` est appelé avec `with_seconds_required()`, donc une expression
// à 5 champs est refusée par le backend (l'agent est alors simplement ignoré au
// démarrage du planificateur, silencieusement — d'où l'importance de valider ici).
//
// ## Deux pièges que cet éditeur rend visibles
//
//  1. **Le planificateur tourne en UTC** (`Job::new_async`, pas `new_async_tz`).
//     « 9 h » dans une expression, c'est 9 h UTC. L'aperçu affiche donc l'heure
//     locale correspondante : c'est la seule façon de ne pas se tromper d'un
//     décalage horaire entier sans s'en apercevoir.
//  2. **Jour du mois ET jour de semaine.** croner est configuré avec
//     `with_dom_and_dow()` : quand les DEUX champs sont restreints, il faut que
//     les deux correspondent (ailleurs, le cron classique fait un OU). Le
//     constructeur ne produit jamais cette combinaison ; l'aperçu la calcule
//     comme le backend, et un avertissement s'affiche.

import { appLang } from "../apps-i18n.js";

const FIELDS = [
  { key: "sec", min: 0, max: 59 },
  { key: "min", min: 0, max: 59 },
  { key: "hour", min: 0, max: 23 },
  { key: "dom", min: 1, max: 31 },
  { key: "mon", min: 1, max: 12 },
  { key: "dow", min: 0, max: 6 },
];

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const L = {
  fr: {
    manual: "Manuel", minutes: "Minutes", hours: "Heures", daily: "Chaque jour",
    weekly: "Semaine", monthly: "Mois", custom: "Expression",
    never: "Jamais automatique — l'agent ne part qu'au bouton « Lancer maintenant ».",
    every: "toutes les", min_unit: "minutes", hour_unit: "heures", at: "à",
    atMinute: "à la minute", days: "Jours", lastDay: "Dernier jour", lastDayPhrase: "le dernier jour du mois",
    expr: "Expression CRON (6 champs : sec min heure jour mois jour-semaine)",
    next: "Prochaines exécutions",
    noPreview: "Expression valide, mais l'aperçu ne gère pas les motifs « # » (n-ième du mois) et « L » sur le jour de semaine.",
    none: "Aucune exécution dans les 4 prochaines années.",
    utcNote: "Le planificateur tourne en UTC : les heures ci-dessus sont converties dans ton fuseau.",
    domDowWarn: "Jour du mois ET jour de semaine sont tous deux restreints : le planificateur exige que les deux correspondent. Préfère restreindre l'un ou l'autre.",
    dowNames: ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"],
    dowFull: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    everySec: "chaque seconde", everyMin: "chaque minute", everyHour: "chaque heure",
    everyDay: "chaque jour", andSep: " et ", listSep: ", ",
    onDays: "le", inMonths: "en", monthNames: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    errFields: "Il faut exactement 6 champs (sec min heure jour mois jour-semaine), séparés par des espaces.",
    errField: (name, tok) => `Champ « ${name} » invalide : « ${tok} ».`,
  },
  en: {
    manual: "Manual", minutes: "Minutes", hours: "Hours", daily: "Daily",
    weekly: "Weekly", monthly: "Monthly", custom: "Expression",
    never: "Never automatic — the agent only starts from “Run now”.",
    every: "every", min_unit: "minutes", hour_unit: "hours", at: "at",
    atMinute: "at minute", days: "Days", lastDay: "Last day", lastDayPhrase: "on the last day of the month",
    expr: "CRON expression (6 fields: sec min hour day month weekday)",
    next: "Next runs",
    noPreview: "Valid expression, but the preview does not handle “#” (nth of month) or “L” on the weekday field.",
    none: "No run in the next 4 years.",
    utcNote: "The scheduler runs in UTC: the times above are converted to your timezone.",
    domDowWarn: "Day-of-month AND weekday are both restricted: the scheduler requires both to match. Prefer restricting one or the other.",
    dowNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    dowFull: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    everySec: "every second", everyMin: "every minute", everyHour: "every hour",
    everyDay: "every day", andSep: " and ", listSep: ", ",
    onDays: "on the", inMonths: "in", monthNames: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    errFields: "Exactly 6 fields are required (sec min hour day month weekday), space separated.",
    errField: (name, tok) => `Invalid “${name}” field: “${tok}”.`,
  },
};

const lang = () => (appLang() === "en" ? L.en : L.fr);

// ===== Analyse ============================================================

/**
 * Décompose une expression en ensembles de valeurs.
 * Renvoie `{ ok, error, sets, star, special }` :
 *  - `sets[key]` : tableau trié des valeurs autorisées ;
 *  - `star[key]` : le champ est `*` ou `?` (non restreint) — décisif pour la
 *    règle jour-du-mois / jour-de-semaine ;
 *  - `special` : le champ contient `L` ou `#`, que l'aperçu ne sait pas dérouler.
 */
export function parseCron(expr) {
  const tokens = String(expr || "").trim().split(/\s+/).filter(Boolean);
  const t = lang();
  if (tokens.length !== 6) return { ok: false, error: t.errFields };
  const sets = {};
  const star = {};
  let special = false;
  let lastDayOfMonth = false;

  for (let i = 0; i < 6; i += 1) {
    const f = FIELDS[i];
    let tok = tokens[i].toUpperCase();
    star[f.key] = tok === "*" || tok === "?";

    // `L` seul sur le jour du mois = dernier jour : l'aperçu sait le faire.
    if (f.key === "dom" && tok === "L") {
      lastDayOfMonth = true;
      sets[f.key] = [];
      continue;
    }
    // Les motifs « n-ième du mois » restent valides pour le backend, mais on
    // ne prétend pas les dérouler : mieux vaut pas d'aperçu qu'un faux aperçu.
    if (tok.includes("#") || (f.key === "dow" && tok.includes("L"))) {
      special = true;
      sets[f.key] = null;
      continue;
    }
    if (f.key === "mon") tok = replaceNames(tok, MONTH_NAMES, 1);
    if (f.key === "dow") tok = replaceNames(tok, DOW_NAMES, 0);

    const values = expandField(tok, f);
    if (!values) return { ok: false, error: t.errField(f.key, tokens[i]) };
    sets[f.key] = values;
  }
  return { ok: true, sets, star, special, lastDayOfMonth, tokens };
}

function replaceNames(tok, names, offset) {
  let out = tok;
  names.forEach((n, i) => {
    out = out.split(n).join(String(i + offset));
  });
  return out;
}

/** Développe un champ (`*`, `a`, `a-b`, `a-b/n`, `*​/n`, listes) ou `null`. */
function expandField(tok, f) {
  const out = new Set();
  for (const part of tok.split(",")) {
    if (!part) return null;
    const [rangePart, stepPart] = part.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = parseInt(stepPart, 10);
      if (!Number.isFinite(step) || step < 1) return null;
    }
    let lo;
    let hi;
    if (rangePart === "*" || rangePart === "?") {
      lo = f.min;
      hi = f.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(rangePart, 10);
      // `5/10` signifie « à partir de 5, tous les 10 » : la borne haute est
      // celle du champ, pas la valeur elle-même.
      hi = stepPart !== undefined ? f.max : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return null;
    // Dimanche accepté en 7 comme en 0.
    if (f.key === "dow" && hi === 7) hi = 6;
    if (f.key === "dow" && lo === 7) lo = 0;
    if (lo < f.min || hi > f.max) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

// ===== Description lisible ================================================

/** Phrase en français/anglais décrivant l'expression, ou "" si invalide. */
export function describeCron(expr) {
  const t = lang();
  if (!String(expr || "").trim()) return t.never;
  const parsed = parseCron(expr);
  if (!parsed.ok) return "";
  const { sets, star, tokens, lastDayOfMonth } = parsed;
  const parts = [];

  // Fréquence intra-journalière.
  if (star.sec && star.min && star.hour) parts.push(t.everySec);
  else if (isStep(tokens[1]) && star.hour) parts.push(`${t.every} ${stepOf(tokens[1])} ${t.min_unit}`);
  else if (isStep(tokens[2])) parts.push(`${t.every} ${stepOf(tokens[2])} ${t.hour_unit} (${t.atMinute} ${listOf(sets.min, t)})`);
  else if (star.hour && star.min) parts.push(t.everyMin);
  else if (star.hour) parts.push(`${t.everyHour} ${t.atMinute} ${listOf(sets.min, t)}`);
  else parts.push(`${t.at} ${timeList(sets.hour, sets.min, t)}`);

  // Jours.
  // `sets` vaut `null` pour un champ « n-ième du mois » : on décrit alors le
  // motif brut plutôt que d'inventer une phrase.
  if (lastDayOfMonth) parts.push(t.lastDayPhrase);
  else if (!star.dom) parts.push(sets.dom ? `${t.onDays} ${listOf(sets.dom, t)}` : tokens[3]);
  if (!star.dow) parts.push(sets.dow ? sets.dow.map((d) => t.dowFull[d]).join(t.listSep) : tokens[5]);
  if (star.dom && star.dow && !lastDayOfMonth) parts.push(t.everyDay);
  if (!star.mon && sets.mon) parts.push(`${t.inMonths} ${sets.mon.map((m) => t.monthNames[m - 1]).join(t.listSep)}`);

  return capitalize(parts.filter(Boolean).join(", "));
}

const isStep = (tok) => /^\*\/\d+$/.test(tok);
const stepOf = (tok) => tok.split("/")[1];
const pad = (n) => String(n).padStart(2, "0");
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function listOf(values, t) {
  if (!values || !values.length) return "";
  if (values.length > 8) return `${values.length}×`;
  return values.map((v) => String(v)).join(t.listSep);
}

function timeList(hours, minutes, t) {
  const times = [];
  for (const h of hours) for (const m of minutes) times.push(`${pad(h)}:${pad(m)}`);
  if (times.length > 6) return `${times.length}×`;
  return times.join(t.listSep) + " UTC";
}

// ===== Prochaines exécutions =============================================

/**
 * Occurrences suivantes, calculées EXACTEMENT comme le backend : en UTC, et
 * avec la règle « jour du mois ET jour de semaine » quand les deux champs sont
 * restreints (`with_dom_and_dow()` côté croner).
 */
export function nextRuns(expr, count = 5, from = new Date()) {
  const parsed = parseCron(expr);
  if (!parsed.ok || parsed.special) return [];
  const { sets, star, lastDayOfMonth } = parsed;
  const out = [];
  const cursor = new Date(from.getTime() + 1000);
  cursor.setUTCMilliseconds(0);

  const bothRestricted = !star.dom && !star.dow;
  let day = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()));

  for (let i = 0; i < 366 * 4 && out.length < count; i += 1) {
    const month = day.getUTCMonth() + 1;
    if (sets.mon.includes(month)) {
      const domOk = lastDayOfMonth
        ? day.getUTCDate() === lastDayOf(day.getUTCFullYear(), day.getUTCMonth())
        : sets.dom.includes(day.getUTCDate());
      const dowOk = sets.dow.includes(day.getUTCDay());
      // `with_dom_and_dow()` : les deux doivent correspondre quand les deux
      // champs sont restreints ; sinon seul le champ restreint compte.
      let dayOk = true;
      if (bothRestricted) dayOk = domOk && dowOk;
      else if (!star.dom) dayOk = domOk;
      else if (!star.dow) dayOk = dowOk;
      if (dayOk) {
        for (const h of sets.hour) {
          for (const m of sets.min) {
            for (const s of sets.sec) {
              const when = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, s));
              if (when >= cursor) {
                out.push(when);
                if (out.length >= count) break;
              }
            }
            if (out.length >= count) break;
          }
          if (out.length >= count) break;
        }
      }
    }
    day = new Date(day.getTime() + 86400000);
  }
  return out;
}

const lastDayOf = (year, monthIdx) => new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();

// ===== Composant ==========================================================

/**
 * Monte l'éditeur dans `container`. `onChange(expr)` reçoit l'expression (chaîne
 * vide = pas de planification). Renvoie `{ setValue }` pour recharger la valeur
 * quand on change d'agent.
 */
export function mountCronEditor(container, { value = "", onChange } = {}) {
  const t = lang();
  let expr = String(value || "");
  let mode = detectMode(expr);
  // État du constructeur, reconstruit depuis l'expression quand elle s'y prête.
  let state = stateFromExpr(expr, mode);

  container.classList.add("cron-editor");
  container.innerHTML = `
    <div class="cron-modes" role="tablist"></div>
    <div class="cron-body"></div>
    <div class="cron-expr-row">
      <input type="text" class="input cron-expr" spellcheck="false" />
    </div>
    <p class="cron-desc"></p>
    <p class="cron-error hint" hidden></p>
    <div class="cron-preview"></div>`;

  const modesEl = container.querySelector(".cron-modes");
  const bodyEl = container.querySelector(".cron-body");
  const exprEl = container.querySelector(".cron-expr");
  const descEl = container.querySelector(".cron-desc");
  const errEl = container.querySelector(".cron-error");
  const prevEl = container.querySelector(".cron-preview");

  const MODES = ["manual", "minutes", "hours", "daily", "weekly", "monthly", "custom"];
  for (const m of MODES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cron-mode";
    b.dataset.mode = m;
    b.textContent = t[m];
    b.addEventListener("click", () => {
      mode = m;
      // On repart de l'expression courante : changer de mode ne doit pas
      // effacer l'heure qu'on vient de régler.
      if (m !== "custom" && m !== "manual") state = stateFromExpr(expr, m);
      if (m === "manual") expr = "";
      else if (m !== "custom") expr = buildExpr(m, state);
      render();
      emit();
    });
    modesEl.appendChild(b);
  }

  exprEl.addEventListener("input", () => {
    expr = exprEl.value.trim();
    mode = "custom";
    paintModes();
    refreshFeedback();
    emit();
  });

  function emit() {
    if (typeof onChange === "function") onChange(expr);
  }

  function paintModes() {
    modesEl.querySelectorAll(".cron-mode").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === mode);
    });
  }

  function render() {
    paintModes();
    bodyEl.innerHTML = "";
    exprEl.value = expr;
    exprEl.readOnly = mode !== "custom";
    exprEl.hidden = mode === "manual";
    exprEl.placeholder = t.expr;

    if (mode === "minutes" || mode === "hours") {
      bodyEl.appendChild(numberRow(t.every, state.step, 1, mode === "minutes" ? 59 : 23,
        mode === "minutes" ? t.min_unit : t.hour_unit, (v) => { state.step = v; regen(); }));
      if (mode === "hours") {
        bodyEl.appendChild(numberRow(t.atMinute, state.minute, 0, 59, "", (v) => { state.minute = v; regen(); }));
      }
    }
    if (mode === "daily" || mode === "weekly" || mode === "monthly") {
      bodyEl.appendChild(timeRow(state, regen, t));
    }
    if (mode === "weekly") bodyEl.appendChild(weekdayGrid(state, regen, t));
    if (mode === "monthly") bodyEl.appendChild(monthdayGrid(state, regen, t));

    refreshFeedback();
  }

  function regen() {
    expr = buildExpr(mode, state);
    exprEl.value = expr;
    refreshFeedback();
    emit();
  }

  function refreshFeedback() {
    const parsed = expr ? parseCron(expr) : { ok: true };
    descEl.textContent = describeCron(expr);
    errEl.hidden = parsed.ok;
    errEl.textContent = parsed.ok ? "" : parsed.error;
    prevEl.innerHTML = "";
    if (!expr || !parsed.ok) return;

    if (!parsed.star.dom && !parsed.star.dow) {
      const warn = document.createElement("p");
      warn.className = "hint cron-warn";
      warn.textContent = t.domDowWarn;
      prevEl.appendChild(warn);
    }
    if (parsed.special) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = t.noPreview;
      prevEl.appendChild(p);
      return;
    }
    const runs = nextRuns(expr, 5);
    const head = document.createElement("p");
    head.className = "hint cron-preview-head";
    head.textContent = t.next;
    prevEl.appendChild(head);
    if (!runs.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = t.none;
      prevEl.appendChild(p);
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "cron-runs";
    for (const r of runs) {
      const li = document.createElement("li");
      li.textContent = r.toLocaleString(appLang() === "en" ? "en-GB" : "fr-FR", {
        weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      });
      ul.appendChild(li);
    }
    prevEl.appendChild(ul);
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = t.utcNote;
    prevEl.appendChild(note);
  }

  render();

  return {
    setValue(v) {
      expr = String(v || "");
      mode = detectMode(expr);
      state = stateFromExpr(expr, mode);
      render();
    },
  };
}

// ----- Contrôles ---------------------------------------------------------

function numberRow(label, value, min, max, unit, onInput) {
  const row = document.createElement("div");
  row.className = "cron-row";
  row.innerHTML = `<span>${label}</span>`;
  const input = document.createElement("input");
  input.type = "number";
  input.className = "input cron-num";
  input.min = min; input.max = max; input.value = value;
  input.addEventListener("input", () => {
    const v = Math.min(max, Math.max(min, parseInt(input.value, 10) || min));
    onInput(v);
  });
  row.appendChild(input);
  if (unit) {
    const u = document.createElement("span");
    u.textContent = unit;
    row.appendChild(u);
  }
  return row;
}

function timeRow(state, regen, t) {
  const row = document.createElement("div");
  row.className = "cron-row";
  row.innerHTML = `<span>${t.at}</span>`;
  const input = document.createElement("input");
  input.type = "time";
  input.className = "input cron-time";
  input.value = `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}`;
  input.addEventListener("input", () => {
    const [h, m] = input.value.split(":").map((n) => parseInt(n, 10));
    if (Number.isFinite(h)) state.hour = h;
    if (Number.isFinite(m)) state.minute = m;
    regen();
  });
  row.appendChild(input);
  const utc = document.createElement("span");
  utc.className = "hint";
  utc.textContent = "UTC";
  row.appendChild(utc);
  return row;
}

function weekdayGrid(state, regen, t) {
  const wrap = document.createElement("div");
  wrap.className = "cron-grid cron-dow";
  // Semaine affichée du lundi au dimanche (usage FR), valeurs cron 0 = dimanche.
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cron-cell" + (state.dow.includes(d) ? " on" : "");
    b.textContent = t.dowNames[d];
    b.addEventListener("click", () => {
      state.dow = state.dow.includes(d) ? state.dow.filter((x) => x !== d) : [...state.dow, d].sort();
      if (!state.dow.length) state.dow = [d];
      regen();
      wrap.replaceWith(weekdayGrid(state, regen, t));
    });
    wrap.appendChild(b);
  }
  return wrap;
}

function monthdayGrid(state, regen, t) {
  const wrap = document.createElement("div");
  wrap.className = "cron-grid cron-dom";
  const repaint = () => wrap.replaceWith(monthdayGrid(state, regen, t));
  for (let d = 1; d <= 31; d += 1) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cron-cell" + (!state.lastDay && state.dom.includes(d) ? " on" : "");
    b.textContent = String(d);
    b.addEventListener("click", () => {
      state.lastDay = false;
      state.dom = state.dom.includes(d) ? state.dom.filter((x) => x !== d) : [...state.dom, d].sort((a, b2) => a - b2);
      if (!state.dom.length) state.dom = [d];
      regen();
      repaint();
    });
    wrap.appendChild(b);
  }
  // « Dernier jour » : le seul cas que la grille 1–31 ne peut pas exprimer
  // (30, 31 ou 28/29 selon le mois). croner le connaît sous la forme `L`.
  const last = document.createElement("button");
  last.type = "button";
  last.className = "cron-cell cron-cell-wide" + (state.lastDay ? " on" : "");
  last.textContent = t.lastDay;
  last.addEventListener("click", () => {
    state.lastDay = !state.lastDay;
    regen();
    repaint();
  });
  wrap.appendChild(last);
  return wrap;
}

// ----- Construction / rétro-analyse --------------------------------------

function buildExpr(mode, s) {
  switch (mode) {
    case "manual": return "";
    case "minutes": return `0 */${s.step} * * * *`;
    case "hours": return `0 ${s.minute} */${s.step} * * *`;
    case "daily": return `0 ${s.minute} ${s.hour} * * *`;
    case "weekly": return `0 ${s.minute} ${s.hour} * * ${[...s.dow].sort().join(",")}`;
    case "monthly": return `0 ${s.minute} ${s.hour} ${s.lastDay ? "L" : [...s.dom].sort((a, b) => a - b).join(",")} * *`;
    default: return "";
  }
}

/** Mode correspondant à une expression existante, `custom` si elle sort du cadre. */
function detectMode(expr) {
  const e = String(expr || "").trim();
  if (!e) return "manual";
  const p = e.split(/\s+/);
  if (p.length !== 6 || p[0] !== "0") return "custom";
  const [, min, hour, dom, mon, dow] = p;
  if (mon !== "*") return "custom";
  if (/^\*\/\d+$/.test(min) && hour === "*" && dom === "*" && dow === "*") return "minutes";
  if (/^\d+$/.test(min) && /^\*\/\d+$/.test(hour) && dom === "*" && dow === "*") return "hours";
  // Ancien preset « toutes les heures » : `*` est un pas de 1.
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && dow === "*") return "hours";
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return "custom";
  if (dom === "*" && dow === "*") return "daily";
  if (dom === "*" && /^\d+(,\d+)*$/.test(dow)) return "weekly";
  if (dow === "*" && (dom === "L" || /^\d+(,\d+)*$/.test(dom))) return "monthly";
  return "custom";
}

function stateFromExpr(expr, mode) {
  const base = { step: mode === "hours" ? 2 : 10, minute: 0, hour: 9, dow: [1], dom: [1], lastDay: false };
  const p = String(expr || "").trim().split(/\s+/);
  if (p.length !== 6) return base;
  const num = (v, fallback) => (/^\d+$/.test(v) ? parseInt(v, 10) : fallback);
  if (/^\*\/\d+$/.test(p[1])) base.step = parseInt(p[1].split("/")[1], 10);
  if (/^\*\/\d+$/.test(p[2])) base.step = parseInt(p[2].split("/")[1], 10);
  if (mode === "hours" && p[2] === "*") base.step = 1;
  base.minute = num(p[1], base.minute);
  base.hour = num(p[2], base.hour);
  if (p[3] === "L") base.lastDay = true;
  else if (/^\d+(,\d+)*$/.test(p[3])) base.dom = p[3].split(",").map(Number);
  if (/^\d+(,\d+)*$/.test(p[5])) base.dow = p[5].split(",").map(Number);
  return base;
}
