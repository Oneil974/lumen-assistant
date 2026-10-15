// Moteur de transformation de l'app Flux de données (ETL).
//
// # Pourquoi un moteur à part, et pas Fluxo
//
// Fluxo orchestre des ACTIONS dans le temps : lancer, attendre, notifier,
// brancher. Un ETL transforme une TABLE : filtrer, dériver, regrouper,
// joindre — des opérations qui n'ont pas d'ordonnancement, seulement un ordre.
// Les plier en blocs Fluxo aurait donné des workflows illisibles pour dire
// « garde les lignes où le montant dépasse 1000 ».
//
// # Fonctions pures, catalogue déclaratif
//
// Chaque étape prend { columns, rows } et rend { columns, rows }, sans rien
// toucher d'autre. C'est ce qui rend l'aperçu instantané (on rejoue le graphe
// sur 200 lignes) et le moteur testable sans interface.
//
// Chaque étape DÉCLARE aussi ses champs (`fields`) : l'inspecteur du canevas
// engendre son formulaire à partir de là, et l'assistant lit la même liste
// pour savoir quoi remplir. Ajouter une opération, c'est ajouter UNE entrée
// dans STEPS — jamais un écran de plus.
//
// Le catalogue couvre les opérations d'un ETL visuel classique (amphi-etl) :
// colonnes, lignes, texte, nombres, dates, structure (pivot, dépivot,
// éclater…), combinaison (jointure, union, recherche), qualité et une étape
// d'enrichissement par le modèle.

/** Un jeu de données : des colonnes nommées, des lignes-objets. */
export const emptyTable = () => ({ columns: [], rows: [] });

/** Déduit les colonnes d'une liste d'objets, dans l'ordre de première apparition. */
export function inferColumns(rows) {
  const seen = [];
  for (const row of rows || []) {
    for (const key of Object.keys(row || {})) {
      if (!seen.includes(key)) seen.push(key);
    }
  }
  return seen;
}

export function tableFrom(rows) {
  return { columns: inferColumns(rows), rows: (rows || []).map((r) => ({ ...r })) };
}

/** Recopie une table en ne gardant que `keep` (dans cet ordre). */
const project = (table, keep) => ({
  columns: keep,
  rows: table.rows.map((r) => Object.fromEntries(keep.map((c) => [c, r[c] ?? null]))),
});

/** Ajoute une colonne (ou la remplace si elle existe) à partir d'une fonction ligne → valeur. */
const withColumn = (table, name, fn) => ({
  columns: table.columns.includes(name) ? table.columns : [...table.columns, name],
  rows: table.rows.map((r, i) => ({ ...r, [name]: fn(r, i) })),
});

/** Transforme une colonne en place. */
const mapColumn = (table, column, fn) => ({
  columns: table.columns,
  rows: table.rows.map((r) => ({ ...r, [column]: fn(r[column], r) })),
});

const asList = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

// ===================== Valeurs =====================

export const isBlank = (v) => v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));

/** Nombre si c'en est un, sinon NaN. Les virgules décimales sont acceptées :
 *  un CSV français en est plein, et refuser « 12,50 » n'aiderait personne. */
export function num(value) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (isBlank(value)) return NaN;
  const s = String(value).trim().replace(/[\s\u00a0]/g, "").replace(/[€$£%]/g, "");
  // « 1.234,56 » (fr) vs « 1,234.56 » (en) : le dernier séparateur est la décimale.
  if (s.includes(",") && s.includes(".")) {
    return s.lastIndexOf(",") > s.lastIndexOf(".") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s.replace(/,/g, ""));
  }
  return Number(s.replace(",", "."));
}

const cmp = (a, b) => {
  const ab = isBlank(a), bb = isBlank(b);
  if (ab && bb) return 0;
  if (ab) return 1;   // les vides à la fin, dans les deux sens
  if (bb) return -1;
  const na = num(a), nb = num(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const da = parseDate(a), db = parseDate(b);
  if (da && db) return da - db;
  return String(a ?? "").localeCompare(String(b ?? ""), "fr", { numeric: true, sensitivity: "base" });
};

const toBool = (v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  if (["true", "vrai", "oui", "yes", "1", "x", "on"].includes(s)) return true;
  if (["false", "faux", "non", "no", "0", "", "off"].includes(s)) return false;
  return null;
};

const stripAccents = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// ===================== Dates =====================
//
// Un analyseur de dates volontairement borné : ISO, formats français et
// américains courants, ou un format explicite (yyyy, MM, dd, HH, mm, ss).
// Une date illisible rend null — jamais « Invalid Date » dans une cellule.

const pad2 = (n) => String(n).padStart(2, "0");

export function parseDate(value, format) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (isBlank(value)) return null;
  const s = String(value).trim();
  if (format) {
    const tokens = [];
    const re = format.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (t) => {
      tokens.push(t);
      return t === "yyyy" ? "(\\d{4})" : "(\\d{1,2})";
    });
    const m = new RegExp(`^${re}$`).exec(s);
    if (!m) return null;
    const p = { yyyy: 1970, MM: 1, dd: 1, HH: 0, mm: 0, ss: 0 };
    tokens.forEach((t, i) => { p[t === "yy" ? "yyyy" : t] = Number(m[i + 1]) + (t === "yy" ? 2000 : 0); });
    const d = new Date(p.yyyy, p.MM - 1, p.dd, p.HH, p.mm, p.ss);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Nombre pur : un timestamp (secondes ou millisecondes) — mais pas une année.
  if (/^\d{10,13}$/.test(s)) return new Date(s.length === 10 ? Number(s) * 1000 : Number(s));
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = /^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(d, format = "yyyy-MM-dd") {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  return format.replace(/yyyy|yy|MMMM|MM|dddd|dd|HH|mm|ss/g, (t) => ({
    yyyy: String(d.getFullYear()), yy: String(d.getFullYear()).slice(-2),
    MMMM: MONTHS[d.getMonth()], MM: pad2(d.getMonth() + 1),
    dddd: DAYS[d.getDay()], dd: pad2(d.getDate()),
    HH: pad2(d.getHours()), mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()),
  }[t]));
}

const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
};

// ===================== Filtres =====================

/** Opérateurs de filtre. Fermés et nommés : le modèle choisit dedans. */
export const OPERATORS = {
  eq: { label: "égal à", test: (v, t) => (Number.isFinite(num(v)) && Number.isFinite(num(t)) ? num(v) === num(t) : String(v ?? "").toLowerCase() === String(t).toLowerCase()) },
  ne: { label: "différent de", test: (v, t) => !OPERATORS.eq.test(v, t) },
  contains: { label: "contient", test: (v, t) => String(v ?? "").toLowerCase().includes(String(t).toLowerCase()) },
  ncontains: { label: "ne contient pas", test: (v, t) => !String(v ?? "").toLowerCase().includes(String(t).toLowerCase()) },
  starts: { label: "commence par", test: (v, t) => String(v ?? "").toLowerCase().startsWith(String(t).toLowerCase()) },
  ends: { label: "finit par", test: (v, t) => String(v ?? "").toLowerCase().endsWith(String(t).toLowerCase()) },
  regex: { label: "correspond à (regex)", test: (v, t) => { try { return new RegExp(t, "i").test(String(v ?? "")); } catch { return false; } } },
  gt: { label: "supérieur à", test: (v, t) => cmp(v, t) > 0 && !isBlank(v) },
  gte: { label: "supérieur ou égal", test: (v, t) => cmp(v, t) >= 0 && !isBlank(v) },
  lt: { label: "inférieur à", test: (v, t) => cmp(v, t) < 0 && !isBlank(v) },
  lte: { label: "inférieur ou égal", test: (v, t) => cmp(v, t) <= 0 && !isBlank(v) },
  between: { label: "entre (a;b)", test: (v, t) => { const [a, b] = String(t).split(/[;,]/).map((x) => x.trim()); return !isBlank(v) && cmp(v, a) >= 0 && cmp(v, b) <= 0; } },
  in: { label: "parmi (a;b;c)", test: (v, t) => String(t).split(/[;,]/).map((x) => x.trim().toLowerCase()).includes(String(v ?? "").trim().toLowerCase()) },
  empty: { label: "est vide", test: (v) => isBlank(v), unary: true },
  filled: { label: "est renseigné", test: (v) => !isBlank(v), unary: true },
  isnum: { label: "est un nombre", test: (v) => Number.isFinite(num(v)), unary: true },
  isdate: { label: "est une date", test: (v) => !!parseDate(v), unary: true },
};

/** Évalue la liste de conditions d'un filtre (ou l'ancienne forme à une condition). */
function matchConditions(row, s) {
  const conds = (s.conditions && s.conditions.length) ? s.conditions : (s.column ? [{ column: s.column, op: s.op, value: s.value }] : []);
  if (!conds.length) return true;
  const test = (c) => {
    const op = OPERATORS[c.op];
    if (!op) throw new Error(`Opérateur inconnu : ${c.op}`);
    // La valeur peut référencer une autre colonne : [prix_min].
    const target = /^\[.+\]$/.test(String(c.value ?? "")) ? row[String(c.value).slice(1, -1)] : c.value;
    return op.test(row[c.column], target ?? "");
  };
  return s.match === "any" ? conds.some(test) : conds.every(test);
}

// ===================== Agrégations =====================

export const AGGREGATES = {
  count: { label: "nombre", run: (values) => values.length },
  count_distinct: { label: "nombre distinct", run: (values) => new Set(values.filter((v) => !isBlank(v)).map((v) => String(v))).size },
  sum: { label: "somme", run: (values) => values.map(num).filter(Number.isFinite).reduce((a, b) => a + b, 0) },
  avg: {
    label: "moyenne",
    run: (values) => {
      const n = values.map(num).filter(Number.isFinite);
      return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
    },
  },
  median: { label: "médiane", run: (values) => median(values.map(num).filter(Number.isFinite)) },
  std: { label: "écart-type", run: (values) => stddev(values.map(num).filter(Number.isFinite)) },
  min: { label: "minimum", run: (values) => values.filter((v) => !isBlank(v)).sort(cmp)[0] ?? null },
  max: { label: "maximum", run: (values) => values.filter((v) => !isBlank(v)).sort(cmp).pop() ?? null },
  first: { label: "première valeur", run: (values) => values.find((v) => !isBlank(v)) ?? null },
  last: { label: "dernière valeur", run: (values) => [...values].reverse().find((v) => !isBlank(v)) ?? null },
  concat: { label: "liste", run: (values) => values.filter((v) => !isBlank(v)).join(", ") },
  concat_distinct: { label: "liste distincte", run: (values) => [...new Set(values.filter((v) => !isBlank(v)).map(String))].join(", ") },
};

function median(n) {
  if (!n.length) return null;
  const s = [...n].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stddev(n) {
  if (n.length < 2) return null;
  const mean = n.reduce((a, b) => a + b, 0) / n.length;
  return Math.sqrt(n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length - 1));
}

// ===================== Expressions dérivées =====================

/**
 * Évalue une expression de colonne dérivée.
 *
 * **Pas de eval, pas de Function.** L'expression peut venir d'un flux partagé
 * ou d'un modèle : lui donner accès au contexte de la page reviendrait à lui
 * donner la page. On interprète donc un langage minuscule — colonnes, nombres,
 * chaînes, les quatre opérations, comparaisons, et une poignée de fonctions —
 * et tout le reste est refusé.
 *
 * Les colonnes s'écrivent entre crochets : [prix] * [quantité].
 * Fonctions : upper, lower, trim, len, round(x, n), abs, min, max, concat,
 * if(cond, a, b), coalesce(a, b…), contains(s, t), year/month/day(date),
 * num(x), text(x). Comparaisons : = <> < > <= >= ; logique : and, or, not.
 */
export const EXPRESSION_HELP = "Colonnes entre crochets ([prix] * [quantité]), textes entre guillemets, + - * / et parenthèses, comparaisons (= <> < > <= >=), and / or / not, fonctions : upper, lower, trim, len, round, abs, min, max, concat, if(cond, a, b), coalesce, contains, year, month, day, num, text.";

const FUNCS = {
  upper: (a) => String(a ?? "").toUpperCase(),
  lower: (a) => String(a ?? "").toLowerCase(),
  trim: (a) => String(a ?? "").trim(),
  len: (a) => String(a ?? "").length,
  round: (a, n = 0) => { const p = 10 ** (num(n) || 0); const v = num(a); return Number.isFinite(v) ? Math.round(v * p) / p : null; },
  abs: (a) => { const v = num(a); return Number.isFinite(v) ? Math.abs(v) : null; },
  min: (...xs) => { const n = xs.map(num).filter(Number.isFinite); return n.length ? Math.min(...n) : null; },
  max: (...xs) => { const n = xs.map(num).filter(Number.isFinite); return n.length ? Math.max(...n) : null; },
  concat: (...xs) => xs.map((x) => (x ?? "")).join(""),
  if: (c, a, b) => (truthy(c) ? a : b),
  coalesce: (...xs) => xs.find((x) => !isBlank(x)) ?? null,
  contains: (s, t) => String(s ?? "").toLowerCase().includes(String(t ?? "").toLowerCase()),
  year: (d) => parseDate(d)?.getFullYear() ?? null,
  month: (d) => { const x = parseDate(d); return x ? x.getMonth() + 1 : null; },
  day: (d) => parseDate(d)?.getDate() ?? null,
  num: (a) => { const v = num(a); return Number.isFinite(v) ? v : null; },
  text: (a) => (a === null || a === undefined ? "" : String(a)),
  isblank: (a) => isBlank(a),
};
const truthy = (v) => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : !isBlank(v) && toBool(v) !== false);

// Référence de colonne tolérante : un nom de colonne importé traîne souvent une
// espace, une majuscule ou un accent de plus que ce que l'utilisateur tape
// ([COM_NOM] pour « COM_NOM  ») — et la valeur sortait vide sans un mot.
// Correspondance exacte d'abord, puis sans espaces/casse/accents.
const foldKey = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s\u00a0_-]+/g, "").toLowerCase();
const columnCache = new WeakMap();
function columnValue(row, name) {
  if (!row || typeof row !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name] ?? null;
  let map = columnCache.get(row);
  if (!map) { map = new Map(Object.keys(row).map((k) => [foldKey(k), k])); columnCache.set(row, map); }
  const real = map.get(foldKey(name));
  return real === undefined ? null : (row[real] ?? null);
}

/** Vérifie la syntaxe d'une expression (sans données) ; lève l'erreur sinon. */
export function validateExpression(expr) {
  const tokens = tokenize(String(expr ?? ""));
  const { rest } = parseOr(tokens, {});
  if (rest.length) throw new Error(`Expression incomprise à « ${rest[0].raw} »`);
}

export function evalExpression(expr, row) {
  const tokens = tokenize(String(expr ?? ""));
  const { value, rest } = parseOr(tokens, row);
  if (rest.length) throw new Error(`Expression incomprise à « ${rest[0].raw} »`);
  return value;
}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new Error("Crochet de colonne non refermé");
      out.push({ type: "col", value: src.slice(i + 1, end), raw: src.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error("Guillemet non refermé");
      out.push({ type: "str", value: src.slice(i + 1, end), raw: src.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      out.push({ type: "num", value: Number(m[0]), raw: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
      const word = m[0].toLowerCase();
      if (["and", "or", "not"].includes(word)) out.push({ type: "op", value: word, raw: m[0] });
      else if (word === "true" || word === "false") out.push({ type: "bool", value: word === "true", raw: m[0] });
      else if (word === "null") out.push({ type: "null", value: null, raw: m[0] });
      else out.push({ type: "fn", value: word, raw: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "=="].includes(two)) { out.push({ type: "op", value: two === "!=" ? "<>" : two === "==" ? "=" : two, raw: two }); i += 2; continue; }
    if ("+-*/()=<>,".includes(c)) { out.push({ type: "op", value: c, raw: c }); i++; continue; }
    throw new Error(`Caractère refusé dans une expression : « ${c} »`);
  }
  return out;
}

const isOp = (t, ...vals) => t?.type === "op" && vals.includes(t.value);

function parseOr(tokens, row) {
  let { value, rest } = parseAnd(tokens, row);
  while (isOp(rest[0], "or")) {
    const right = parseAnd(rest.slice(1), row);
    value = truthy(value) || truthy(right.value);
    rest = right.rest;
  }
  return { value, rest };
}
function parseAnd(tokens, row) {
  let { value, rest } = parseNot(tokens, row);
  while (isOp(rest[0], "and")) {
    const right = parseNot(rest.slice(1), row);
    value = truthy(value) && truthy(right.value);
    rest = right.rest;
  }
  return { value, rest };
}
function parseNot(tokens, row) {
  if (isOp(tokens[0], "not")) {
    const inner = parseNot(tokens.slice(1), row);
    return { value: !truthy(inner.value), rest: inner.rest };
  }
  return parseCompare(tokens, row);
}
function parseCompare(tokens, row) {
  let { value, rest } = parseSum(tokens, row);
  while (isOp(rest[0], "=", "<>", "<", ">", "<=", ">=")) {
    const op = rest[0].value;
    const right = parseSum(rest.slice(1), row);
    const c = cmp(value, right.value);
    const eq = OPERATORS.eq.test(value, right.value);
    value = op === "=" ? eq : op === "<>" ? !eq : op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
    rest = right.rest;
  }
  return { value, rest };
}
function parseSum(tokens, row) {
  let { value, rest } = parseProduct(tokens, row);
  while (isOp(rest[0], "+", "-")) {
    const op = rest[0].value;
    const right = parseProduct(rest.slice(1), row);
    // « + » sur du texte concatène : c'est ce qu'attend quelqu'un qui compose
    // un libellé, et cela évite d'inventer un second opérateur.
    if (op === "+" && (typeof value === "string" || typeof right.value === "string") && !(Number.isFinite(num(value)) && Number.isFinite(num(right.value)))) {
      value = `${value ?? ""}${right.value ?? ""}`;
    } else {
      value = op === "+" ? num(value) + num(right.value) : num(value) - num(right.value);
      if (Number.isNaN(value)) value = null;
    }
    rest = right.rest;
  }
  return { value, rest };
}
function parseProduct(tokens, row) {
  let { value, rest } = parseAtom(tokens, row);
  while (isOp(rest[0], "*", "/")) {
    const op = rest[0].value;
    const right = parseAtom(rest.slice(1), row);
    const d = num(right.value);
    value = op === "*" ? num(value) * d : (d === 0 ? null : num(value) / d);
    if (Number.isNaN(value)) value = null;
    rest = right.rest;
  }
  return { value, rest };
}
function parseAtom(tokens, row) {
  const t = tokens[0];
  if (!t) throw new Error("Expression incomplète");
  if (t.type === "num" || t.type === "str" || t.type === "bool" || t.type === "null") return { value: t.value, rest: tokens.slice(1) };
  if (t.type === "col") return { value: columnValue(row, t.value), rest: tokens.slice(1) };
  if (t.type === "fn") {
    const fn = FUNCS[t.value];
    if (!fn) throw new Error(`Fonction inconnue : ${t.raw}`);
    if (!isOp(tokens[1], "(")) throw new Error(`Parenthèse attendue après ${t.raw}`);
    const args = [];
    let rest = tokens.slice(2);
    if (isOp(rest[0], ")")) return { value: fn(), rest: rest.slice(1) };
    for (;;) {
      const a = parseOr(rest, row);
      args.push(a.value);
      rest = a.rest;
      if (isOp(rest[0], ",")) { rest = rest.slice(1); continue; }
      if (isOp(rest[0], ")")) return { value: fn(...args), rest: rest.slice(1) };
      throw new Error(`Parenthèse non refermée dans ${t.raw}()`);
    }
  }
  if (isOp(t, "(")) {
    const inner = parseOr(tokens.slice(1), row);
    if (!isOp(inner.rest[0], ")")) throw new Error("Parenthèse non refermée");
    return { value: inner.value, rest: inner.rest.slice(1) };
  }
  if (isOp(t, "-")) {
    const inner = parseAtom(tokens.slice(1), row);
    return { value: -num(inner.value), rest: inner.rest };
  }
  throw new Error(`Expression incomprise à « ${t.raw} »`);
}

// ===================== Conversion de types =====================

export const CAST_TYPES = {
  text: { label: "texte", cast: (v) => (isBlank(v) ? null : String(v)) },
  number: { label: "nombre", cast: (v) => { const n = num(v); return Number.isFinite(n) ? n : null; } },
  integer: { label: "entier", cast: (v) => { const n = num(v); return Number.isFinite(n) ? Math.trunc(n) : null; } },
  bool: { label: "booléen", cast: (v) => toBool(v) },
  date: { label: "date (ISO)", cast: (v) => formatDate(parseDate(v), "yyyy-MM-dd") },
  datetime: { label: "date et heure (ISO)", cast: (v) => formatDate(parseDate(v), "yyyy-MM-dd HH:mm:ss") },
};

/** Devine le type dominant d'une colonne sur un échantillon. */
export function inferType(values) {
  const vals = values.filter((v) => !isBlank(v)).slice(0, 500);
  if (!vals.length) return "text";
  const score = (ok) => vals.filter(ok).length / vals.length;
  if (score((v) => typeof v === "boolean" || toBool(v) !== null && ["true", "false", "vrai", "faux", "oui", "non", "yes", "no"].includes(String(v).toLowerCase())) > 0.9) return "bool";
  if (score((v) => Number.isFinite(num(v))) > 0.9) return vals.every((v) => Number.isInteger(num(v))) ? "integer" : "number";
  if (score((v) => !!parseDate(v) && !/^\d{1,4}$/.test(String(v))) > 0.9) return "date";
  return "text";
}

// ===================== Champs (formulaires déclaratifs) =====================
//
// Chaque étape déclare ses champs ; l'inspecteur du canevas les dessine.
//   column   — une colonne de l'entrée (from: "right" pour la 2e entrée)
//   columns  — plusieurs colonnes
//   text / number / bool / textarea / expression
//   select   — options fixes { value, label } ou liste de chaînes
//   list     — texte « a, b, c » → tableau
//   repeat   — une liste de sous-formulaires (fields) : conditions, mappings…

const F = {
  column: (key, label, opts = {}) => ({ key, label, kind: "column", ...opts }),
  columns: (key, label, opts = {}) => ({ key, label, kind: "columns", ...opts }),
  text: (key, label, opts = {}) => ({ key, label, kind: "text", ...opts }),
  number: (key, label, opts = {}) => ({ key, label, kind: "number", ...opts }),
  bool: (key, label, opts = {}) => ({ key, label, kind: "bool", ...opts }),
  textarea: (key, label, opts = {}) => ({ key, label, kind: "textarea", ...opts }),
  expression: (key, label, opts = {}) => ({ key, label, kind: "expression", hint: EXPRESSION_HELP, ...opts }),
  select: (key, label, options, opts = {}) => ({ key, label, kind: "select", options, ...opts }),
  list: (key, label, opts = {}) => ({ key, label, kind: "list", ...opts }),
  repeat: (key, label, fields, opts = {}) => ({ key, label, kind: "repeat", fields, ...opts }),
};
const opOptions = () => Object.entries(OPERATORS).map(([value, o]) => ({ value, label: o.label }));
const aggOptions = () => Object.entries(AGGREGATES).map(([value, a]) => ({ value, label: a.label }));
const castOptions = () => Object.entries(CAST_TYPES).map(([value, c]) => ({ value, label: c.label }));

export const CATEGORIES = ["Colonnes", "Lignes", "Texte", "Nombres", "Dates", "Structure", "Combiner", "Qualité", "IA"];

// ===================== Étapes =====================

const joinDesc = (s) => `${s.rightName || "jeu de droite"} sur ${s.leftKey} = ${s.rightKey}`;

/** Résout la table de droite d'une étape à deux entrées. */
function rightTable(s, ctx) {
  const right = ctx.inputs?.[1] || ctx.datasets?.[s.rightId];
  if (!right) throw new Error("Reliez un second jeu à l'entrée « Droite » de ce bloc.");
  return right;
}

export const STEPS = {
  // ---------- Colonnes ----------
  select: {
    label: "Garder des colonnes", category: "Colonnes", hint: "Ne conserver que les colonnes choisies, dans cet ordre.",
    fields: [F.columns("columns", "Colonnes à garder")],
    describe: (s) => `Garder ${(s.columns || []).join(", ") || "—"}`,
    run: (table, s) => project(table, (s.columns || []).filter((c) => table.columns.includes(c))),
  },
  drop: {
    label: "Retirer des colonnes", category: "Colonnes", hint: "Supprimer les colonnes choisies.",
    fields: [F.columns("columns", "Colonnes à retirer")],
    describe: (s) => `Retirer ${(s.columns || []).join(", ") || "—"}`,
    run: (table, s) => { const drop = new Set(s.columns || []); return project(table, table.columns.filter((c) => !drop.has(c))); },
  },
  rename: {
    label: "Renommer des colonnes", category: "Colonnes", hint: "Donner un nouveau nom à une ou plusieurs colonnes.",
    fields: [F.repeat("mappings", "Renommages", [F.column("column", "Colonne"), F.text("to", "Nouveau nom")])],
    describe: (s) => (s.mappings?.length ? s.mappings.map((m) => `${m.column} → ${m.to}`).join(", ") : `${s.column} → ${s.to}`),
    run: (table, s) => {
      const maps = s.mappings?.length ? s.mappings : [{ column: s.column, to: s.to }];
      const ren = Object.fromEntries(maps.filter((m) => m.column && m.to).map((m) => [m.column, m.to]));
      return {
        columns: table.columns.map((c) => ren[c] || c),
        rows: table.rows.map((r) => { const out = {}; for (const [k, v] of Object.entries(r)) out[ren[k] || k] = v; return out; }),
      };
    },
  },
  reorder: {
    label: "Réordonner les colonnes", category: "Colonnes", hint: "Placer les colonnes choisies en premier ; les autres suivent.",
    fields: [F.columns("columns", "Colonnes en tête, dans l'ordre")],
    describe: (s) => `D'abord ${(s.columns || []).join(", ") || "—"}`,
    run: (table, s) => { const first = (s.columns || []).filter((c) => table.columns.includes(c)); return project(table, [...first, ...table.columns.filter((c) => !first.includes(c))]); },
  },
  cast: {
    label: "Convertir les types", category: "Colonnes", hint: "Texte → nombre, date, booléen… Les valeurs illisibles deviennent vides.",
    fields: [F.repeat("casts", "Conversions", [F.column("column", "Colonne"), F.select("type", "Vers", castOptions())])],
    describe: (s) => (s.casts || []).map((c) => `${c.column} → ${CAST_TYPES[c.type]?.label || c.type}`).join(", ") || "—",
    run: (table, s) => {
      let out = table;
      for (const c of s.casts || []) {
        const t = CAST_TYPES[c.type];
        if (!t || !c.column) continue;
        out = mapColumn(out, c.column, t.cast);
      }
      return out;
    },
  },
  auto_types: {
    label: "Détecter les types", category: "Colonnes", hint: "Devine le type de chaque colonne (nombre, date, booléen) et convertit.",
    fields: [],
    describe: () => "Types devinés et convertis",
    run: (table) => {
      let out = table;
      for (const c of table.columns) {
        const t = inferType(table.rows.map((r) => r[c]));
        if (t !== "text") out = mapColumn(out, c, CAST_TYPES[t].cast);
      }
      return out;
    },
  },
  split: {
    label: "Scinder une colonne", category: "Colonnes", hint: "Découper « a;b;c » en plusieurs colonnes.",
    fields: [F.column("column", "Colonne"), F.text("separator", "Séparateur", { placeholder: ";" }), F.number("parts", "Nombre de morceaux (0 = auto)"), F.text("prefix", "Préfixe des nouvelles colonnes", { placeholder: "vide = nom de la colonne" }), F.bool("keep", "Garder la colonne d'origine")],
    describe: (s) => `Scinder ${s.column} sur « ${s.separator ?? ";"} »`,
    run: (table, s) => {
      const sep = s.separator || ";";
      const pieces = table.rows.map((r) => (isBlank(r[s.column]) ? [] : String(r[s.column]).split(sep).map((x) => x.trim())));
      const n = Number(s.parts) > 0 ? Number(s.parts) : Math.max(1, ...pieces.map((p) => p.length));
      const prefix = s.prefix || s.column;
      const names = Array.from({ length: n }, (_, i) => `${prefix}_${i + 1}`);
      const base = s.keep === false ? table.columns.filter((c) => c !== s.column) : table.columns;
      return {
        columns: [...base, ...names.filter((c) => !base.includes(c))],
        rows: table.rows.map((r, i) => { const out = s.keep === false ? { ...r } : { ...r }; if (s.keep === false) delete out[s.column]; names.forEach((nm, j) => { out[nm] = pieces[i][j] ?? null; }); return out; }),
      };
    },
  },
  merge: {
    label: "Fusionner des colonnes", category: "Colonnes", hint: "Concaténer plusieurs colonnes en une seule, avec un séparateur.",
    fields: [F.columns("columns", "Colonnes à fusionner"), F.text("separator", "Séparateur", { placeholder: " " }), F.text("to", "Nom de la colonne résultat"), F.bool("dropSources", "Retirer les colonnes d'origine")],
    describe: (s) => `${s.to || "fusion"} = ${(s.columns || []).join(` + `)}`,
    run: (table, s) => {
      const cols = s.columns || [];
      let out = withColumn(table, s.to || "fusion", (r) => cols.map((c) => r[c]).filter((v) => !isBlank(v)).join(s.separator ?? " "));
      if (s.dropSources) out = project(out, out.columns.filter((c) => !cols.includes(c) || c === s.to));
      return out;
    },
  },
  derive: {
    label: "Colonne calculée", category: "Colonnes", hint: "Une nouvelle colonne à partir d'une formule.",
    fields: [F.text("to", "Nom de la colonne", { placeholder: "total" }), F.expression("expression", "Expression", { placeholder: "[prix] * [quantité]" })],
    describe: (s) => `${s.to} = ${s.expression}`,
    run: (table, s) => {
      if (!String(s.expression ?? "").trim()) throw new Error("Écrivez une expression.");
      // Une erreur de SYNTAXE vaut pour toutes les lignes : on la dit tout de
      // suite plutôt que de livrer une colonne vide sans explication.
      validateExpression(s.expression);
      // Colonnes citées mais absentes de l'entrée : dit clairement, avec les
      // colonnes disponibles — c'est LA cause habituelle d'une colonne vide.
      const cited = [...String(s.expression).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
      const missing = cited.filter((c) => !table.columns.some((k) => k === c || foldKey(k) === foldKey(c)));
      if (missing.length) throw new Error(`Colonne introuvable : ${missing.map((c) => `[${c}]`).join(", ")}. Colonnes d'entrée : ${table.columns.join(", ")}`);
      return withColumn(table, s.to, (r) => {
        // Une expression qui échoue sur UNE ligne (division, date…) ne fait pas
        // tomber tout le flux : la cellule reste vide, et la ligne passe.
        try { return evalExpression(s.expression, r); } catch { return null; }
      });
    },
  },
  constant: {
    label: "Colonne constante", category: "Colonnes", hint: "Ajouter une colonne avec la même valeur partout (source, date d'import…).",
    fields: [F.text("to", "Nom de la colonne"), F.text("value", "Valeur", { placeholder: "ex. 2026 ou {{today}}" })],
    describe: (s) => `${s.to} = « ${s.value ?? ""} »`,
    run: (table, s) => {
      const v = String(s.value ?? "").replace(/\{\{\s*today\s*\}\}/g, formatDate(new Date())).replace(/\{\{\s*now\s*\}\}/g, formatDate(new Date(), "yyyy-MM-dd HH:mm:ss"));
      return withColumn(table, s.to || "constante", () => v);
    },
  },
  generate_id: {
    label: "Identifiant de ligne", category: "Colonnes", hint: "Numéro de ligne, identifiant unique ou empreinte de la ligne.",
    fields: [F.text("to", "Nom de la colonne", { placeholder: "id" }), F.select("mode", "Type", [{ value: "row", label: "numéro de ligne" }, { value: "uuid", label: "identifiant unique (UUID)" }, { value: "hash", label: "empreinte de la ligne" }]), F.number("start", "Premier numéro")],
    describe: (s) => `${s.to || "id"} : ${{ row: "numéro", uuid: "UUID", hash: "empreinte" }[s.mode] || "numéro"}`,
    run: (table, s) => {
      const start = Number(s.start) || 1;
      const name = s.to || "id";
      const fn = s.mode === "uuid" ? () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
        : s.mode === "hash" ? (r) => hash(table.columns.filter((c) => c !== name).map((c) => r[c] ?? "").join("\u0001"))
        : (_, i) => start + i;
      return { columns: [name, ...table.columns.filter((c) => c !== name)], rows: table.rows.map((r, i) => ({ [name]: fn(r, i), ...r })) };
    },
  },
  extract: {
    label: "Extraire (regex)", category: "Colonnes", hint: "Extraire un motif d'une colonne (le premier groupe capturé, sinon le motif entier).",
    fields: [F.column("column", "Colonne"), F.text("pattern", "Expression régulière", { placeholder: "(\\d{5})" }), F.text("to", "Nouvelle colonne")],
    describe: (s) => `${s.to || "extrait"} = /${s.pattern}/ sur ${s.column}`,
    run: (table, s) => {
      let re;
      try { re = new RegExp(s.pattern || ""); } catch (e) { throw new Error(`Regex invalide : ${e.message}`); }
      return withColumn(table, s.to || `${s.column}_extrait`, (r) => { const m = re.exec(String(r[s.column] ?? "")); return m ? (m[1] ?? m[0]) : null; });
    },
  },
  standardize_names: {
    label: "Normaliser les noms de colonnes", category: "Colonnes", hint: "Minuscules, sans accents ni espaces : « Nom du Client » → nom_du_client.",
    fields: [F.select("style", "Style", [{ value: "snake", label: "snake_case" }, { value: "camel", label: "camelCase" }, { value: "lower", label: "minuscules" }])],
    describe: (s) => `Noms en ${s.style || "snake"}_case`,
    run: (table, s) => {
      const norm = (c) => {
        const base = stripAccents(c).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (s.style === "camel") return base.split(" ").map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("");
        if (s.style === "lower") return base.replace(/ /g, "");
        return base.replace(/ /g, "_");
      };
      const seen = new Set();
      const ren = {};
      for (const c of table.columns) { let n = norm(c) || "col"; while (seen.has(n)) n += "_2"; seen.add(n); ren[c] = n; }
      return { columns: table.columns.map((c) => ren[c]), rows: table.rows.map((r) => Object.fromEntries(table.columns.map((c) => [ren[c], r[c] ?? null]))) };
    },
  },
  copy: {
    label: "Dupliquer une colonne", category: "Colonnes", hint: "Copier une colonne sous un autre nom.",
    fields: [F.column("column", "Colonne"), F.text("to", "Nom de la copie")],
    describe: (s) => `${s.to} = copie de ${s.column}`,
    run: (table, s) => withColumn(table, s.to || `${s.column}_copie`, (r) => r[s.column] ?? null),
  },

  // ---------- Lignes ----------
  filter: {
    label: "Filtrer les lignes", category: "Lignes", hint: "Garder les lignes qui vérifient une ou plusieurs conditions.",
    fields: [
      F.select("match", "Garder si", [{ value: "all", label: "toutes les conditions sont vraies" }, { value: "any", label: "au moins une condition est vraie" }]),
      F.repeat("conditions", "Conditions", [F.column("column", "Colonne"), F.select("op", "Condition", opOptions()), F.text("value", "Valeur", { placeholder: "ou [autre_colonne]" })]),
    ],
    describe: (s) => {
      const conds = s.conditions?.length ? s.conditions : (s.column ? [{ column: s.column, op: s.op, value: s.value }] : []);
      return `Garder si ${conds.map((c) => `${c.column} ${OPERATORS[c.op]?.label || c.op}${OPERATORS[c.op]?.unary ? "" : ` « ${c.value ?? ""} »`}`).join(s.match === "any" ? " ou " : " et ") || "—"}`;
    },
    run: (table, s) => ({ columns: table.columns, rows: table.rows.filter((r) => matchConditions(r, s)) }),
  },
  dedupe: {
    label: "Dédoublonner", category: "Lignes", hint: "Une seule ligne par valeur des colonnes choisies (vide = ligne entière).",
    fields: [F.columns("columns", "Colonnes de comparaison (vide = ligne entière)"), F.select("keep", "Garder", [{ value: "first", label: "la première" }, { value: "last", label: "la dernière" }])],
    describe: (s) => `Une ligne par ${(s.columns || []).join(", ") || "ligne entière"}`,
    run: (table, s) => {
      const keys = (s.columns || []).length ? s.columns : table.columns;
      const seen = new Map();
      const src = s.keep === "last" ? [...table.rows].reverse() : table.rows;
      const rows = [];
      for (const r of src) {
        const key = keys.map((c) => String(r[c] ?? "")).join("\u0001");
        if (seen.has(key)) continue;
        seen.set(key, true);
        rows.push(r);
      }
      return { columns: table.columns, rows: s.keep === "last" ? rows.reverse() : rows };
    },
  },
  sort: {
    label: "Trier", category: "Lignes", hint: "Trier par une ou plusieurs colonnes.",
    fields: [F.repeat("keys", "Clés de tri", [F.column("column", "Colonne"), F.bool("desc", "Décroissant")])],
    describe: (s) => `Trier par ${(s.keys?.length ? s.keys : [{ column: s.column, desc: s.desc }]).map((k) => `${k.column}${k.desc ? " ↓" : " ↑"}`).join(", ")}`,
    run: (table, s) => {
      const keys = s.keys?.length ? s.keys : [{ column: s.column, desc: s.desc }];
      return { columns: table.columns, rows: [...table.rows].sort((a, b) => { for (const k of keys) { const c = (k.desc ? -1 : 1) * cmp(a[k.column], b[k.column]); if (c) return c; } return 0; }) };
    },
  },
  limit: {
    label: "Limiter", category: "Lignes", hint: "Ne garder que les N premières lignes.",
    fields: [F.number("count", "Nombre de lignes")],
    describe: (s) => `Garder les ${s.count} premières lignes`,
    run: (table, s) => ({ columns: table.columns, rows: table.rows.slice(0, Math.max(0, s.count | 0)) }),
  },
  skip: {
    label: "Sauter des lignes", category: "Lignes", hint: "Ignorer les N premières lignes (en-têtes répétés, lignes de titre…).",
    fields: [F.number("count", "Lignes à sauter")],
    describe: (s) => `Sauter ${s.count} ligne(s)`,
    run: (table, s) => ({ columns: table.columns, rows: table.rows.slice(Math.max(0, s.count | 0)) }),
  },
  sample: {
    label: "Échantillonner", category: "Lignes", hint: "Un échantillon aléatoire reproductible (N lignes ou un pourcentage).",
    fields: [F.number("count", "Nombre de lignes (0 = pourcentage)"), F.number("percent", "Pourcentage"), F.number("seed", "Graine (même graine = même tirage)")],
    describe: (s) => (Number(s.count) > 0 ? `${s.count} lignes au hasard` : `${s.percent || 10} % des lignes`),
    run: (table, s) => {
      let seed = (Number(s.seed) || 42) >>> 0;
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const rows = table.rows.map((r) => ({ r, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.r);
      const n = Number(s.count) > 0 ? Number(s.count) : Math.round(rows.length * (Number(s.percent) || 10) / 100);
      return { columns: table.columns, rows: rows.slice(0, n) };
    },
  },
  drop_empty: {
    label: "Retirer les lignes vides", category: "Lignes", hint: "Écarter les lignes dont les colonnes choisies sont vides.",
    fields: [F.columns("columns", "Colonnes (vide = toutes)"), F.select("mode", "Retirer si", [{ value: "any", label: "au moins une est vide" }, { value: "all", label: "toutes sont vides" }])],
    describe: (s) => `Sans vide dans ${(s.columns || []).join(", ") || "toutes les colonnes"}`,
    run: (table, s) => {
      const cols = (s.columns || []).length ? s.columns : table.columns;
      const bad = s.mode === "all" ? (r) => cols.every((c) => isBlank(r[c])) : (r) => cols.some((c) => isBlank(r[c]));
      return { columns: table.columns, rows: table.rows.filter((r) => !bad(r)) };
    },
  },
  distinct: {
    label: "Valeurs distinctes", category: "Lignes", hint: "La liste des valeurs uniques d'une colonne, avec leur fréquence.",
    fields: [F.column("column", "Colonne"), F.bool("count", "Compter les occurrences")],
    describe: (s) => `Valeurs distinctes de ${s.column}`,
    run: (table, s) => {
      const counts = new Map();
      for (const r of table.rows) { const k = r[s.column] ?? null; counts.set(k, (counts.get(k) || 0) + 1); }
      const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => (s.count === false ? { [s.column]: v } : { [s.column]: v, nombre: n }));
      return { columns: s.count === false ? [s.column] : [s.column, "nombre"], rows };
    },
  },

  // ---------- Texte ----------
  case: {
    label: "Changer la casse", category: "Texte", hint: "MAJUSCULES, minuscules, Première Lettre…",
    fields: [F.columns("columns", "Colonnes"), F.select("mode", "Casse", [{ value: "upper", label: "MAJUSCULES" }, { value: "lower", label: "minuscules" }, { value: "title", label: "Chaque Mot En Capitale" }, { value: "sentence", label: "Première lettre en capitale" }])],
    describe: (s) => `${s.mode || "upper"} sur ${(s.columns || []).join(", ")}`,
    run: (table, s) => {
      const fn = { upper: (v) => v.toUpperCase(), lower: (v) => v.toLowerCase(), title: (v) => v.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()), sentence: (v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() }[s.mode || "upper"];
      let out = table;
      for (const c of s.columns || []) out = mapColumn(out, c, (v) => (isBlank(v) ? v : fn(String(v))));
      return out;
    },
  },
  trim: {
    label: "Nettoyer les espaces", category: "Texte", hint: "Retirer les espaces de début/fin et les doublons d'espaces.",
    fields: [F.columns("columns", "Colonnes (vide = toutes)")],
    describe: (s) => `Espaces nettoyés (${(s.columns || []).join(", ") || "toutes"})`,
    run: (table, s) => {
      let out = table;
      for (const c of (s.columns || []).length ? s.columns : table.columns) out = mapColumn(out, c, (v) => (typeof v === "string" ? v.replace(/[\s\u00a0]+/g, " ").trim() : v));
      return out;
    },
  },
  replace: {
    label: "Remplacer", category: "Texte", hint: "Remplacer un texte (ou un motif regex) par un autre.",
    fields: [F.columns("columns", "Colonnes"), F.text("find", "Chercher"), F.text("with", "Remplacer par"), F.bool("regex", "Expression régulière"), F.bool("whole", "Valeur entière seulement")],
    describe: (s) => `« ${s.find ?? ""} » → « ${s.with ?? ""} » dans ${(s.columns || []).join(", ")}`,
    run: (table, s) => {
      let re = null;
      if (s.regex) { try { re = new RegExp(s.find || "", "g"); } catch (e) { throw new Error(`Regex invalide : ${e.message}`); } }
      const find = String(s.find ?? ""), rep = String(s.with ?? "");
      const fn = (v) => {
        if (isBlank(v)) return find === "" ? rep : v;
        const str = String(v);
        if (s.whole) return str === find ? rep : v;
        if (re) return str.replace(re, rep);
        return str.split(find).join(rep);
      };
      let out = table;
      for (const c of s.columns || []) out = mapColumn(out, c, fn);
      return out;
    },
  },
  substring: {
    label: "Sous-chaîne", category: "Texte", hint: "Garder une portion du texte (position de départ, longueur).",
    fields: [F.column("column", "Colonne"), F.number("start", "Départ (1 = premier caractère, négatif = depuis la fin)"), F.number("length", "Longueur (0 = jusqu'à la fin)"), F.text("to", "Nouvelle colonne (vide = en place)")],
    describe: (s) => `${s.to || s.column} = ${s.column}[${s.start || 1}, ${s.length || "fin"}]`,
    run: (table, s) => {
      const start = Number(s.start) || 1, len = Number(s.length) || 0;
      const fn = (v) => { if (isBlank(v)) return v; const str = String(v); const from = start > 0 ? start - 1 : Math.max(0, str.length + start); return len > 0 ? str.substr(from, len) : str.slice(from); };
      return s.to ? withColumn(table, s.to, (r) => fn(r[s.column])) : mapColumn(table, s.column, fn);
    },
  },
  pad: {
    label: "Compléter (zéros, espaces)", category: "Texte", hint: "Amener une valeur à une longueur fixe : 42 → 00042.",
    fields: [F.columns("columns", "Colonnes"), F.number("length", "Longueur"), F.text("char", "Caractère", { placeholder: "0" }), F.select("side", "Côté", [{ value: "left", label: "à gauche" }, { value: "right", label: "à droite" }])],
    describe: (s) => `Compléter à ${s.length} avec « ${s.char || "0"} »`,
    run: (table, s) => {
      let out = table;
      const n = Number(s.length) || 0, ch = (s.char || "0")[0];
      for (const c of s.columns || []) out = mapColumn(out, c, (v) => (isBlank(v) ? v : s.side === "right" ? String(v).padEnd(n, ch) : String(v).padStart(n, ch)));
      return out;
    },
  },
  remove_accents: {
    label: "Retirer les accents", category: "Texte", hint: "« Élodie » → « Elodie ». Utile avant une jointure.",
    fields: [F.columns("columns", "Colonnes (vide = toutes)")],
    describe: (s) => `Sans accents (${(s.columns || []).join(", ") || "toutes"})`,
    run: (table, s) => {
      let out = table;
      for (const c of (s.columns || []).length ? s.columns : table.columns) out = mapColumn(out, c, (v) => (typeof v === "string" ? stripAccents(v) : v));
      return out;
    },
  },
  clean: {
    label: "Nettoyer le texte", category: "Texte", hint: "Retirer ponctuation, chiffres, balises HTML ou caractères spéciaux.",
    fields: [F.columns("columns", "Colonnes"), F.bool("html", "Retirer les balises HTML"), F.bool("punct", "Retirer la ponctuation"), F.bool("digits", "Retirer les chiffres"), F.bool("special", "Ne garder que lettres, chiffres et espaces")],
    describe: (s) => `Nettoyer ${(s.columns || []).join(", ")}`,
    run: (table, s) => {
      const fn = (v) => {
        if (typeof v !== "string") return v;
        let x = v;
        if (s.html) x = x.replace(/<[^>]+>/g, " ");
        if (s.punct) x = x.replace(/[\p{P}$+<=>^`|~]/gu, " ");
        if (s.digits) x = x.replace(/\d+/g, "");
        if (s.special) x = x.replace(/[^\p{L}\p{N}\s]/gu, " ");
        return x.replace(/\s+/g, " ").trim();
      };
      let out = table;
      for (const c of s.columns || []) out = mapColumn(out, c, fn);
      return out;
    },
  },

  // ---------- Nombres ----------
  round: {
    label: "Arrondir", category: "Nombres", hint: "Arrondir à N décimales (ou à l'entier, au-dessus, en-dessous).",
    fields: [F.columns("columns", "Colonnes"), F.number("decimals", "Décimales"), F.select("mode", "Mode", [{ value: "round", label: "au plus proche" }, { value: "floor", label: "en dessous" }, { value: "ceil", label: "au-dessus" }])],
    describe: (s) => `Arrondir ${(s.columns || []).join(", ")} à ${s.decimals ?? 0} décimale(s)`,
    run: (table, s) => {
      const p = 10 ** (Number(s.decimals) || 0);
      const f = Math[s.mode || "round"] || Math.round;
      let out = table;
      for (const c of s.columns || []) out = mapColumn(out, c, (v) => { const n = num(v); return Number.isFinite(n) ? f(n * p) / p : v; });
      return out;
    },
  },
  fill_missing: {
    label: "Remplir les valeurs manquantes", category: "Nombres", hint: "Constante, moyenne, médiane, valeur précédente ou suivante.",
    fields: [F.columns("columns", "Colonnes"), F.select("mode", "Remplir avec", [{ value: "constant", label: "une constante" }, { value: "mean", label: "la moyenne" }, { value: "median", label: "la médiane" }, { value: "mode", label: "la valeur la plus fréquente" }, { value: "ffill", label: "la valeur précédente" }, { value: "bfill", label: "la valeur suivante" }, { value: "zero", label: "zéro" }]), F.text("value", "Constante")],
    describe: (s) => `Vides de ${(s.columns || []).join(", ")} ← ${s.mode || "constant"}${s.mode === "constant" || !s.mode ? ` « ${s.value ?? ""} »` : ""}`,
    run: (table, s) => {
      let out = table;
      for (const c of s.columns || []) {
        const vals = out.rows.map((r) => r[c]);
        const nums = vals.map(num).filter(Number.isFinite);
        let fill = null;
        if (s.mode === "mean") fill = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        else if (s.mode === "median") fill = median(nums);
        else if (s.mode === "zero") fill = 0;
        else if (s.mode === "mode") { const m = new Map(); for (const v of vals) if (!isBlank(v)) m.set(v, (m.get(v) || 0) + 1); fill = [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; }
        else if (s.mode === "ffill" || s.mode === "bfill") {
          const rows = out.rows.map((r) => ({ ...r }));
          const order = s.mode === "ffill" ? rows : [...rows].reverse();
          let last = null;
          for (const r of order) { if (isBlank(r[c])) r[c] = last; else last = r[c]; }
          out = { columns: out.columns, rows };
          continue;
        } else fill = s.value ?? "";
        out = mapColumn(out, c, (v) => (isBlank(v) ? fill : v));
      }
      return out;
    },
  },
  bin: {
    label: "Tranches (binning)", category: "Nombres", hint: "Classer une valeur numérique en tranches : « 0-100 », « 100-500 »…",
    fields: [F.column("column", "Colonne"), F.text("edges", "Bornes (séparées par ;)", { placeholder: "0;100;500;1000" }), F.text("labels", "Libellés (facultatif, séparés par ;)"), F.text("to", "Nouvelle colonne")],
    describe: (s) => `${s.to || `${s.column}_tranche`} = tranches de ${s.column}`,
    run: (table, s) => {
      const edges = String(s.edges || "").split(/[;,]/).map((x) => num(x)).filter(Number.isFinite).sort((a, b) => a - b);
      const labels = String(s.labels || "").split(";").map((x) => x.trim()).filter(Boolean);
      if (edges.length < 2) throw new Error("Donnez au moins deux bornes.");
      return withColumn(table, s.to || `${s.column}_tranche`, (r) => {
        const v = num(r[s.column]);
        if (!Number.isFinite(v)) return null;
        if (v < edges[0]) return labels[0] ? `< ${labels[0]}` : `< ${edges[0]}`;
        for (let i = 0; i < edges.length - 1; i++) if (v >= edges[i] && v < edges[i + 1]) return labels[i] || `${edges[i]}–${edges[i + 1]}`;
        return labels[edges.length - 1] || `≥ ${edges[edges.length - 1]}`;
      });
    },
  },
  scale: {
    label: "Normaliser", category: "Nombres", hint: "Ramener entre 0 et 1 (min-max) ou centrer-réduire (z-score).",
    fields: [F.columns("columns", "Colonnes"), F.select("mode", "Méthode", [{ value: "minmax", label: "min-max (0 à 1)" }, { value: "zscore", label: "z-score" }]), F.bool("inplace", "Remplacer la colonne (sinon suffixe _norm)")],
    describe: (s) => `${s.mode || "minmax"} sur ${(s.columns || []).join(", ")}`,
    run: (table, s) => {
      let out = table;
      for (const c of s.columns || []) {
        const nums = out.rows.map((r) => num(r[c])).filter(Number.isFinite);
        const min = Math.min(...nums), max = Math.max(...nums);
        const mean = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        const sd = stddev(nums) || 1;
        const fn = (v) => { const n = num(v); if (!Number.isFinite(n)) return null; return s.mode === "zscore" ? (n - mean) / sd : max === min ? 0 : (n - min) / (max - min); };
        out = s.inplace ? mapColumn(out, c, fn) : withColumn(out, `${c}_norm`, (r) => fn(r[c]));
      }
      return out;
    },
  },
  cumulative: {
    label: "Cumul", category: "Nombres", hint: "Somme cumulée d'une colonne, dans l'ordre courant (optionnellement par groupe).",
    fields: [F.column("column", "Colonne"), F.columns("by", "Réinitialiser à chaque changement de (facultatif)"), F.text("to", "Nouvelle colonne")],
    describe: (s) => `${s.to || `${s.column}_cumul`} = cumul de ${s.column}`,
    run: (table, s) => {
      const totals = new Map();
      return withColumn(table, s.to || `${s.column}_cumul`, (r) => {
        const key = (s.by || []).map((c) => String(r[c] ?? "")).join("\u0001");
        const n = num(r[s.column]);
        const t = (totals.get(key) || 0) + (Number.isFinite(n) ? n : 0);
        totals.set(key, t);
        return t;
      });
    },
  },
  rank: {
    label: "Rang", category: "Nombres", hint: "Classement des lignes selon une colonne (1 = la plus grande), par groupe si besoin.",
    fields: [F.column("column", "Colonne"), F.bool("asc", "Croissant (1 = la plus petite)"), F.columns("by", "Par groupe (facultatif)"), F.text("to", "Nouvelle colonne")],
    describe: (s) => `${s.to || "rang"} = rang selon ${s.column}`,
    run: (table, s) => {
      const groups = new Map();
      table.rows.forEach((r, i) => { const k = (s.by || []).map((c) => String(r[c] ?? "")).join("\u0001"); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
      const ranks = new Array(table.rows.length).fill(null);
      for (const idx of groups.values()) {
        const sorted = [...idx].sort((a, b) => (s.asc ? 1 : -1) * cmp(table.rows[a][s.column], table.rows[b][s.column]));
        let rank = 0, prev = null;
        sorted.forEach((i, pos) => { const v = table.rows[i][s.column]; if (prev === null || cmp(v, prev) !== 0) rank = pos + 1; ranks[i] = isBlank(v) ? null : rank; prev = v; });
      }
      return withColumn(table, s.to || "rang", (_, i) => ranks[i]);
    },
  },
  percent_total: {
    label: "Part du total", category: "Nombres", hint: "Chaque valeur en pourcentage de la somme de la colonne (par groupe si besoin).",
    fields: [F.column("column", "Colonne"), F.columns("by", "Par groupe (facultatif)"), F.text("to", "Nouvelle colonne")],
    describe: (s) => `${s.to || `${s.column}_pct`} = ${s.column} / total`,
    run: (table, s) => {
      const totals = new Map();
      for (const r of table.rows) { const k = (s.by || []).map((c) => String(r[c] ?? "")).join("\u0001"); const n = num(r[s.column]); totals.set(k, (totals.get(k) || 0) + (Number.isFinite(n) ? n : 0)); }
      return withColumn(table, s.to || `${s.column}_pct`, (r) => { const k = (s.by || []).map((c) => String(r[c] ?? "")).join("\u0001"); const n = num(r[s.column]); const t = totals.get(k); return Number.isFinite(n) && t ? Math.round(n / t * 10000) / 100 : null; });
    },
  },

  // ---------- Dates ----------
  parse_date: {
    label: "Interpréter une date", category: "Dates", hint: "Lire une date écrite en texte (« 31/12/2025 ») et l'écrire en ISO.",
    fields: [F.column("column", "Colonne"), F.text("format", "Format d'entrée (vide = automatique)", { placeholder: "dd/MM/yyyy" }), F.text("to", "Nouvelle colonne (vide = en place)")],
    describe: (s) => `${s.to || s.column} = date(${s.column}${s.format ? `, ${s.format}` : ""})`,
    run: (table, s) => {
      const fn = (v) => formatDate(parseDate(v, s.format || undefined), /HH|mm/.test(s.format || "") ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd");
      return s.to ? withColumn(table, s.to, (r) => fn(r[s.column])) : mapColumn(table, s.column, fn);
    },
  },
  format_date: {
    label: "Formater une date", category: "Dates", hint: "Écrire une date dans le format voulu : dd/MM/yyyy, MMMM yyyy, dddd…",
    fields: [F.column("column", "Colonne"), F.text("format", "Format de sortie", { placeholder: "dd/MM/yyyy" }), F.text("to", "Nouvelle colonne (vide = en place)")],
    describe: (s) => `${s.to || s.column} au format ${s.format || "yyyy-MM-dd"}`,
    run: (table, s) => {
      const fn = (v) => formatDate(parseDate(v), s.format || "yyyy-MM-dd");
      return s.to ? withColumn(table, s.to, (r) => fn(r[s.column])) : mapColumn(table, s.column, fn);
    },
  },
  date_part: {
    label: "Extraire d'une date", category: "Dates", hint: "Année, trimestre, mois, semaine, jour, jour de semaine, heure.",
    fields: [F.column("column", "Colonne"), F.select("part", "Partie", [{ value: "year", label: "année" }, { value: "quarter", label: "trimestre" }, { value: "month", label: "mois (numéro)" }, { value: "month_name", label: "mois (nom)" }, { value: "week", label: "semaine ISO" }, { value: "day", label: "jour" }, { value: "weekday", label: "jour de semaine (nom)" }, { value: "weekday_num", label: "jour de semaine (1 = lundi)" }, { value: "hour", label: "heure" }, { value: "yearmonth", label: "année-mois (yyyy-MM)" }]), F.text("to", "Nouvelle colonne")],
    describe: (s) => `${s.to || `${s.column}_${s.part}`} = ${s.part} de ${s.column}`,
    run: (table, s) => withColumn(table, s.to || `${s.column}_${s.part || "year"}`, (r) => {
      const d = parseDate(r[s.column]);
      if (!d) return null;
      switch (s.part || "year") {
        case "year": return d.getFullYear();
        case "quarter": return Math.floor(d.getMonth() / 3) + 1;
        case "month": return d.getMonth() + 1;
        case "month_name": return formatDate(d, "MMMM");
        case "week": return isoWeek(d);
        case "day": return d.getDate();
        case "weekday": return formatDate(d, "dddd");
        case "weekday_num": return d.getDay() || 7;
        case "hour": return d.getHours();
        case "yearmonth": return formatDate(d, "yyyy-MM");
        default: return null;
      }
    }),
  },
  date_diff: {
    label: "Écart entre deux dates", category: "Dates", hint: "Jours, semaines, mois ou années entre deux colonnes (ou avec aujourd'hui).",
    fields: [F.column("column", "Date de fin"), F.column("from", "Date de début (vide = aujourd'hui)", { optional: true }), F.select("unit", "Unité", [{ value: "days", label: "jours" }, { value: "weeks", label: "semaines" }, { value: "months", label: "mois" }, { value: "years", label: "années" }, { value: "hours", label: "heures" }]), F.text("to", "Nouvelle colonne")],
    describe: (s) => `${s.to || "ecart"} = ${s.column} − ${s.from || "aujourd'hui"} (${s.unit || "days"})`,
    run: (table, s) => withColumn(table, s.to || "ecart", (r) => {
      const a = parseDate(r[s.column]), b = s.from ? parseDate(r[s.from]) : new Date();
      if (!a || !b) return null;
      const ms = a - b;
      switch (s.unit || "days") {
        case "hours": return Math.round(ms / 36e5);
        case "weeks": return Math.round(ms / 6048e5 * 100) / 100;
        case "months": return (a.getFullYear() - b.getFullYear()) * 12 + a.getMonth() - b.getMonth();
        case "years": return a.getFullYear() - b.getFullYear() - (a.getMonth() < b.getMonth() || (a.getMonth() === b.getMonth() && a.getDate() < b.getDate()) ? 1 : 0);
        default: return Math.round(ms / 864e5);
      }
    }),
  },
  date_add: {
    label: "Décaler une date", category: "Dates", hint: "Ajouter ou retirer des jours, mois ou années.",
    fields: [F.column("column", "Colonne"), F.number("amount", "Quantité (négatif pour reculer)"), F.select("unit", "Unité", [{ value: "days", label: "jours" }, { value: "months", label: "mois" }, { value: "years", label: "années" }, { value: "hours", label: "heures" }]), F.text("to", "Nouvelle colonne (vide = en place)")],
    describe: (s) => `${s.to || s.column} = ${s.column} ${Number(s.amount) >= 0 ? "+" : "−"} ${Math.abs(Number(s.amount) || 0)} ${s.unit || "days"}`,
    run: (table, s) => {
      const n = Number(s.amount) || 0;
      const fn = (v) => {
        const d = parseDate(v);
        if (!d) return null;
        const x = new Date(d);
        if (s.unit === "months") x.setMonth(x.getMonth() + n);
        else if (s.unit === "years") x.setFullYear(x.getFullYear() + n);
        else if (s.unit === "hours") x.setHours(x.getHours() + n);
        else x.setDate(x.getDate() + n);
        return formatDate(x, s.unit === "hours" ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd");
      };
      return s.to ? withColumn(table, s.to, (r) => fn(r[s.column])) : mapColumn(table, s.column, fn);
    },
  },

  // ---------- Structure ----------
  group: {
    label: "Regrouper et agréger", category: "Structure", hint: "Une ligne par groupe, avec sommes, moyennes, comptes…",
    fields: [F.columns("by", "Regrouper par"), F.repeat("aggregates", "Agrégations", [F.select("fn", "Fonction", aggOptions()), F.column("column", "Colonne"), F.text("to", "Nom du résultat")])],
    describe: (s) => `Par ${(s.by || []).join(", ") || "(tout)"} · ${(s.aggregates || []).map((a) => `${AGGREGATES[a.fn]?.label || a.fn}(${a.column})`).join(", ")}`,
    run: (table, s) => {
      const by = s.by || [];
      const aggs = (s.aggregates || []).filter((a) => a.fn);
      const groups = new Map();
      for (const r of table.rows) {
        const key = by.map((c) => String(r[c] ?? "")).join("\u0001");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const name = (a) => a.to || `${a.fn}_${a.column || "lignes"}`;
      const columns = [...by, ...aggs.map(name)];
      const rows = [...groups.values()].map((members) => {
        const out = {};
        for (const c of by) out[c] = members[0][c] ?? null;
        for (const a of aggs) { const fn = AGGREGATES[a.fn]; out[name(a)] = fn ? fn.run(members.map((m) => (a.column ? m[a.column] : 1))) : null; }
        return out;
      });
      return { columns, rows };
    },
  },
  pivot: {
    label: "Pivoter", category: "Structure", hint: "Les valeurs d'une colonne deviennent des colonnes (tableau croisé).",
    fields: [F.columns("index", "Lignes (index)"), F.column("column", "Colonne à étaler en colonnes"), F.column("value", "Valeurs"), F.select("fn", "Agrégation", aggOptions())],
    describe: (s) => `Croiser ${(s.index || []).join(", ")} × ${s.column} (${AGGREGATES[s.fn]?.label || "somme"} de ${s.value})`,
    run: (table, s) => {
      const fn = AGGREGATES[s.fn || "sum"] || AGGREGATES.sum;
      const index = s.index || [];
      const headers = [];
      const groups = new Map();
      for (const r of table.rows) {
        const key = index.map((c) => String(r[c] ?? "")).join("\u0001");
        const col = String(r[s.column] ?? "(vide)");
        if (!headers.includes(col)) headers.push(col);
        if (!groups.has(key)) groups.set(key, { base: Object.fromEntries(index.map((c) => [c, r[c] ?? null])), cells: new Map() });
        const g = groups.get(key);
        if (!g.cells.has(col)) g.cells.set(col, []);
        g.cells.get(col).push(r[s.value]);
      }
      headers.sort((a, b) => cmp(a, b));
      return {
        columns: [...index, ...headers],
        rows: [...groups.values()].map((g) => ({ ...g.base, ...Object.fromEntries(headers.map((h) => [h, g.cells.has(h) ? fn.run(g.cells.get(h)) : null])) })),
      };
    },
  },
  unpivot: {
    label: "Dépivoter", category: "Structure", hint: "Des colonnes deviennent des lignes (variable / valeur).",
    fields: [F.columns("columns", "Colonnes à empiler"), F.text("name", "Nom de la colonne « variable »", { placeholder: "variable" }), F.text("value", "Nom de la colonne « valeur »", { placeholder: "valeur" })],
    describe: (s) => `Empiler ${(s.columns || []).join(", ")}`,
    run: (table, s) => {
      const cols = (s.columns || []).filter((c) => table.columns.includes(c));
      const keep = table.columns.filter((c) => !cols.includes(c));
      const nameCol = s.name || "variable", valueCol = s.value || "valeur";
      const rows = [];
      for (const r of table.rows) for (const c of cols) rows.push({ ...Object.fromEntries(keep.map((k) => [k, r[k] ?? null])), [nameCol]: c, [valueCol]: r[c] ?? null });
      return { columns: [...keep, nameCol, valueCol], rows };
    },
  },
  transpose: {
    label: "Transposer", category: "Structure", hint: "Lignes ↔ colonnes. La première colonne devient l'en-tête.",
    fields: [F.column("header", "Colonne qui donne les nouveaux en-têtes (vide = numéros)", { optional: true })],
    describe: () => "Transposer",
    run: (table, s) => {
      const heads = table.rows.map((r, i) => (s.header ? String(r[s.header] ?? `col_${i + 1}`) : `col_${i + 1}`));
      const seen = new Set();
      const uniq = heads.map((h) => { let n = h; while (seen.has(n)) n += "_2"; seen.add(n); return n; });
      const fields = table.columns.filter((c) => c !== s.header);
      return { columns: ["colonne", ...uniq], rows: fields.map((f) => ({ colonne: f, ...Object.fromEntries(uniq.map((h, i) => [h, table.rows[i][f] ?? null])) })) };
    },
  },
  explode: {
    label: "Éclater une liste", category: "Structure", hint: "« a;b;c » dans une cellule → trois lignes.",
    fields: [F.column("column", "Colonne"), F.text("separator", "Séparateur (vide = JSON ou ;)", { placeholder: ";" })],
    describe: (s) => `Une ligne par élément de ${s.column}`,
    run: (table, s) => {
      const rows = [];
      for (const r of table.rows) {
        const v = r[s.column];
        let items;
        if (Array.isArray(v)) items = v;
        else if (isBlank(v)) items = [null];
        else if (!s.separator && /^\s*\[/.test(String(v))) { try { items = JSON.parse(v); } catch { items = [v]; } }
        else items = String(v).split(s.separator || ";").map((x) => x.trim());
        if (!items.length) items = [null];
        for (const it of items) rows.push({ ...r, [s.column]: it });
      }
      return { columns: table.columns, rows };
    },
  },
  flatten_json: {
    label: "Aplatir un JSON", category: "Structure", hint: "Une colonne contenant un objet JSON → une colonne par clé (a.b.c).",
    fields: [F.column("column", "Colonne"), F.text("prefix", "Préfixe (vide = nom de la colonne)"), F.bool("keep", "Garder la colonne d'origine")],
    describe: (s) => `Aplatir ${s.column}`,
    run: (table, s) => {
      const prefix = s.prefix ?? s.column;
      const flat = (obj, path, out) => {
        if (obj && typeof obj === "object" && !Array.isArray(obj)) { for (const [k, v] of Object.entries(obj)) flat(v, path ? `${path}.${k}` : k, out); }
        else out[path] = Array.isArray(obj) ? JSON.stringify(obj) : obj;
        return out;
      };
      const parsed = table.rows.map((r) => {
        let v = r[s.column];
        if (typeof v === "string") { try { v = JSON.parse(v); } catch { return {}; } }
        return v && typeof v === "object" ? flat(v, "", {}) : {};
      });
      const newCols = [];
      for (const p of parsed) for (const k of Object.keys(p)) { const n = prefix ? `${prefix}.${k}` : k; if (!newCols.includes(n)) newCols.push(n); }
      const base = s.keep === false ? table.columns.filter((c) => c !== s.column) : table.columns;
      return {
        columns: [...base, ...newCols.filter((c) => !base.includes(c))],
        rows: table.rows.map((r, i) => { const out = { ...r }; if (s.keep === false) delete out[s.column]; for (const [k, v] of Object.entries(parsed[i])) out[prefix ? `${prefix}.${k}` : k] = v; return out; }),
      };
    },
  },

  // ---------- Combiner ----------
  join: {
    label: "Jointure", category: "Combiner", hint: "Enrichir chaque ligne avec les colonnes d'un second jeu (clé commune).", inputs: ["Gauche", "Droite"],
    fields: [F.column("leftKey", "Clé à gauche"), F.column("rightKey", "Clé à droite", { from: "right" }), F.select("mode", "Type", [{ value: "left", label: "gauche — toutes les lignes de gauche" }, { value: "inner", label: "interne — seulement les correspondances" }, { value: "right", label: "droite — toutes les lignes de droite" }, { value: "full", label: "complète — toutes les lignes des deux côtés" }, { value: "anti", label: "anti — lignes de gauche SANS correspondance" }]), F.bool("insensitive", "Ignorer la casse et les accents"), F.text("suffix", "Suffixe des colonnes en doublon", { placeholder: "_droite" })],
    describe: (s) => `Jointure ${s.mode || (s.inner ? "inner" : "left")} ${joinDesc(s)}`,
    run: (table, s, ctx = {}) => {
      const right = rightTable(s, ctx);
      const mode = s.mode || (s.inner ? "inner" : "left");
      const norm = (v) => (s.insensitive ? stripAccents(String(v ?? "")).toLowerCase().trim() : String(v ?? ""));
      const index = new Map();
      for (const r of right.rows) { const k = norm(r[s.rightKey]); if (!index.has(k)) index.set(k, []); index.get(k).push(r); }
      const suffix = s.suffix || "_droite";
      const extraNames = right.columns.filter((c) => c !== s.rightKey).map((c) => [c, table.columns.includes(c) ? `${c}${suffix}` : c]);
      const columns = [...table.columns, ...extraNames.map(([, n]) => n)];
      const merge = (l, r) => ({ ...(l || Object.fromEntries(table.columns.map((c) => [c, null]))), ...Object.fromEntries(extraNames.map(([c, n]) => [n, r?.[c] ?? null])) });
      const rows = [];
      const matchedRight = new Set();
      for (const l of table.rows) {
        const matches = index.get(norm(l[s.leftKey])) || [];
        if (mode === "anti") { if (!matches.length) rows.push({ ...l }); continue; }
        if (!matches.length) { if (mode !== "inner" && mode !== "right") rows.push(merge(l, null)); continue; }
        for (const r of matches) { matchedRight.add(r); rows.push(merge(l, r)); }
      }
      if (mode === "right" || mode === "full") {
        for (const r of right.rows) if (!matchedRight.has(r)) rows.push({ ...merge(null, r), [s.leftKey]: r[s.rightKey] ?? null });
      }
      return { columns: mode === "anti" ? table.columns : columns, rows };
    },
  },
  lookup: {
    label: "Recherche (lookup)", category: "Combiner", hint: "Rapporter UNE colonne d'un second jeu par clé, comme RECHERCHEV.", inputs: ["Gauche", "Droite"],
    fields: [F.column("leftKey", "Clé à gauche"), F.column("rightKey", "Clé à droite", { from: "right" }), F.column("value", "Colonne à rapporter", { from: "right" }), F.text("to", "Nom de la colonne (vide = nom d'origine)"), F.text("default", "Valeur si introuvable")],
    describe: (s) => `${s.to || s.value} ← recherche de ${s.leftKey} dans ${s.rightName || "jeu de droite"}`,
    run: (table, s, ctx = {}) => {
      const right = rightTable(s, ctx);
      const index = new Map();
      for (const r of right.rows) { const k = String(r[s.rightKey] ?? ""); if (!index.has(k)) index.set(k, r[s.value] ?? null); }
      return withColumn(table, s.to || s.value || "recherche", (r) => index.has(String(r[s.leftKey] ?? "")) ? index.get(String(r[s.leftKey] ?? "")) : (s.default ?? null));
    },
  },
  union: {
    label: "Empiler (union)", category: "Combiner", hint: "Mettre bout à bout plusieurs jeux ayant des colonnes communes.", inputs: "multi",
    fields: [F.select("columns", "Colonnes", [{ value: "union", label: "toutes (vides si absentes)" }, { value: "common", label: "seulement les colonnes communes" }, { value: "first", label: "celles du premier jeu" }]), F.bool("tag", "Ajouter une colonne « origine »")],
    describe: (s) => `Empiler les entrées (${{ common: "colonnes communes", first: "colonnes du premier" }[s.columns] || "toutes les colonnes"})`,
    run: (table, s, ctx = {}) => {
      const inputs = (ctx.inputs || [table]).filter(Boolean);
      let columns;
      if (s.columns === "common") columns = inputs[0].columns.filter((c) => inputs.every((t) => t.columns.includes(c)));
      else if (s.columns === "first") columns = [...inputs[0].columns];
      else { columns = []; for (const t of inputs) for (const c of t.columns) if (!columns.includes(c)) columns.push(c); }
      if (s.tag) columns = [...columns, "origine"];
      const rows = [];
      inputs.forEach((t, i) => { for (const r of t.rows) rows.push({ ...Object.fromEntries(columns.map((c) => [c, r[c] ?? null])), ...(s.tag ? { origine: ctx.inputNames?.[i] || `entrée ${i + 1}` } : {}) }); });
      return { columns, rows };
    },
  },
  diff: {
    label: "Comparer deux jeux", category: "Combiner", hint: "Lignes présentes à gauche et absentes à droite (ou l'inverse), par clé.", inputs: ["Gauche", "Droite"],
    fields: [F.column("leftKey", "Clé à gauche"), F.column("rightKey", "Clé à droite", { from: "right" }), F.select("mode", "Garder", [{ value: "missing", label: "lignes de gauche absentes à droite" }, { value: "new", label: "lignes de droite absentes à gauche" }, { value: "both", label: "les deux, avec une colonne « statut »" }])],
    describe: (s) => `Différence ${s.leftKey} / ${s.rightKey} (${s.mode || "missing"})`,
    run: (table, s, ctx = {}) => {
      const right = rightTable(s, ctx);
      const rk = new Set(right.rows.map((r) => String(r[s.rightKey] ?? "")));
      const lk = new Set(table.rows.map((r) => String(r[s.leftKey] ?? "")));
      const missing = table.rows.filter((r) => !rk.has(String(r[s.leftKey] ?? "")));
      const added = right.rows.filter((r) => !lk.has(String(r[s.rightKey] ?? "")));
      if (s.mode === "new") return { columns: right.columns, rows: added };
      if (s.mode === "both") {
        const cols = [...table.columns, ...right.columns.filter((c) => !table.columns.includes(c)), "statut"];
        return { columns: cols, rows: [...missing.map((r) => ({ ...r, statut: "absent à droite" })), ...added.map((r) => ({ ...r, statut: "absent à gauche" }))] };
      }
      return { columns: table.columns, rows: missing };
    },
  },

  // ---------- Qualité ----------
  validate: {
    label: "Contrôle qualité", category: "Qualité", hint: "Vérifier des règles ; les lignes fautives sont marquées ou écartées.",
    fields: [
      F.repeat("rules", "Règles (une ligne est valide si toutes sont vraies)", [F.column("column", "Colonne"), F.select("op", "Doit être", opOptions()), F.text("value", "Valeur")]),
      F.select("action", "En cas d'échec", [{ value: "flag", label: "ajouter une colonne « erreurs »" }, { value: "drop", label: "écarter la ligne" }, { value: "only", label: "ne garder QUE les lignes en erreur" }]),
    ],
    describe: (s) => `${(s.rules || []).length} règle(s) · ${{ drop: "écarter", only: "isoler" }[s.action] || "marquer"}`,
    run: (table, s) => {
      const rules = (s.rules || []).filter((r) => r.column && r.op);
      const errorsOf = (r) => rules.filter((c) => { const op = OPERATORS[c.op]; return op && !op.test(r[c.column], c.value ?? ""); }).map((c) => `${c.column} ${OPERATORS[c.op].label}${OPERATORS[c.op].unary ? "" : ` ${c.value ?? ""}`}`);
      if (s.action === "drop") return { columns: table.columns, rows: table.rows.filter((r) => !errorsOf(r).length) };
      if (s.action === "only") return withColumn({ columns: table.columns, rows: table.rows.filter((r) => errorsOf(r).length) }, "erreurs", (r) => errorsOf(r).join(" ; "));
      return withColumn(table, "erreurs", (r) => errorsOf(r).join(" ; ") || null);
    },
  },
  profile: {
    label: "Profil des données", category: "Qualité", hint: "Un résumé par colonne : type, vides, distincts, min, max, moyenne.",
    fields: [],
    describe: () => "Résumé statistique par colonne",
    run: (table) => ({
      columns: ["colonne", "type", "lignes", "vides", "distincts", "min", "max", "moyenne", "exemple"],
      rows: table.columns.map((c) => {
        const vals = table.rows.map((r) => r[c]);
        const filled = vals.filter((v) => !isBlank(v));
        const type = inferType(vals);
        const nums = ["number", "integer"].includes(type) ? filled.map(num).filter(Number.isFinite) : [];
        const sorted = [...filled].sort(cmp);
        return {
          colonne: c, type, lignes: vals.length, vides: vals.length - filled.length,
          distincts: new Set(filled.map(String)).size,
          min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null,
          moyenne: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100 : null,
          exemple: filled[0] ?? null,
        };
      }),
    }),
  },
  mask: {
    label: "Anonymiser", category: "Qualité", hint: "Masquer, hacher ou tronquer des données personnelles.",
    fields: [F.columns("columns", "Colonnes"), F.select("mode", "Méthode", [{ value: "hash", label: "empreinte (irréversible, stable)" }, { value: "mask", label: "masquer : Jean → J***" }, { value: "email", label: "e-mail : j***@domaine.fr" }, { value: "last4", label: "ne garder que les 4 derniers caractères" }, { value: "blank", label: "vider" }])],
    describe: (s) => `${s.mode || "hash"} sur ${(s.columns || []).join(", ")}`,
    run: (table, s) => {
      const fn = {
        hash: (v) => hash(String(v)),
        mask: (v) => { const str = String(v); return str.length <= 1 ? "*" : str[0] + "*".repeat(Math.min(6, str.length - 1)); },
        email: (v) => { const [u, d] = String(v).split("@"); return d ? `${u[0] || ""}***@${d}` : "***"; },
        last4: (v) => `${"*".repeat(Math.max(0, String(v).length - 4))}${String(v).slice(-4)}`,
        blank: () => null,
      }[s.mode || "hash"];
      let out = table;
      for (const c of s.columns || []) out = mapColumn(out, c, (v) => (isBlank(v) ? v : fn(v)));
      return out;
    },
  },
  count_rows: {
    label: "Compter", category: "Qualité", hint: "Une seule ligne : le nombre de lignes et de colonnes à ce stade.",
    fields: [],
    describe: () => "Nombre de lignes",
    run: (table) => ({ columns: ["lignes", "colonnes"], rows: [{ lignes: table.rows.length, colonnes: table.columns.length }] }),
  },

  // ---------- IA ----------
  ai_column: {
    label: "Colonne générée par l'IA", category: "IA", hint: "Le modèle lit chaque ligne et écrit une valeur : catégorie, résumé, sentiment, traduction…",
    fields: [F.text("to", "Nom de la colonne", { placeholder: "categorie" }), F.textarea("prompt", "Consigne (colonnes entre crochets)", { placeholder: "Classe ce produit en une catégorie parmi : alimentaire, hygiène, maison. Produit : [nom] — [description]. Réponds par le mot seul." }), F.number("max", "Lignes maximum (le reste reste vide)"), F.bool("cache", "Mémoriser les réponses identiques")],
    describe: (s) => `${s.to || "ia"} ← IA : ${String(s.prompt || "").slice(0, 50)}…`,
    run: async (table, s, ctx = {}) => {
      if (!ctx.llm) throw new Error("Le modèle n'est pas disponible dans ce contexte.");
      const max = Number(s.max) > 0 ? Number(s.max) : 50;
      const cache = new Map();
      const rows = [];
      let done = 0;
      for (const r of table.rows) {
        let value = null;
        if (done < max) {
          const prompt = String(s.prompt || "").replace(/\[([^\]]+)\]/g, (_, c) => String(r[c] ?? ""));
          if (s.cache !== false && cache.has(prompt)) value = cache.get(prompt);
          else {
            try { value = String(await ctx.llm(prompt)).trim(); } catch (e) { value = null; }
            cache.set(prompt, value);
          }
          done++;
          ctx.onProgress?.(done, Math.min(max, table.rows.length));
        }
        rows.push({ ...r, [s.to || "ia"]: value });
      }
      return { columns: table.columns.includes(s.to || "ia") ? table.columns : [...table.columns, s.to || "ia"], rows };
    },
  },
};

/** Empreinte courte et stable (FNV-1a), pour les identifiants et l'anonymisation. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let h2 = 0x811c9dc5 ^ str.length;
  for (let i = str.length - 1; i >= 0; i--) { h2 ^= str.charCodeAt(i); h2 = Math.imul(h2, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Nombre d'entrées d'une étape : 1, 2 (gauche/droite) ou « multi ». */
export const stepInputs = (type) => STEPS[type]?.inputs || ["Entrée"];

/**
 * Exécute un flux LINÉAIRE (source → étapes). Conservé pour les flux
 * enregistrés avant le canevas, et pour les tests du moteur.
 * Rend le résultat ET la trace : combien de lignes après chaque étape, et ce
 * qui a échoué — sans elle, on ne sait jamais quelle étape a mangé les lignes.
 */
export async function runPipeline(source, steps, ctx = {}) {
  let table = { columns: [...source.columns], rows: source.rows.map((r) => ({ ...r })) };
  const trace = [{ step: "source", label: "Source", rows: table.rows.length, columns: table.columns.length }];
  for (const step of steps || []) {
    const def = STEPS[step.type];
    if (step.disabled) {
      trace.push({ step: step.id, label: `${def?.label || step.type} (désactivée)`, rows: table.rows.length, columns: table.columns.length, skipped: true });
      continue;
    }
    if (!def) {
      trace.push({ step: step.id, label: step.type, rows: table.rows.length, columns: table.columns.length, error: `Étape inconnue : ${step.type}` });
      continue;
    }
    try {
      table = await def.run(table, step, { ...ctx, inputs: [table, ctx.datasets?.[step.rightId]].filter(Boolean) });
      trace.push({ step: step.id, label: def.describe(step), rows: table.rows.length, columns: table.columns.length });
    } catch (e) {
      // Une étape qui échoue arrête le flux : continuer donnerait un résultat
      // qui ressemble à un succès.
      trace.push({ step: step.id, label: def.label, rows: table.rows.length, columns: table.columns.length, error: String(e?.message || e) });
      return { table, trace, failed: true };
    }
  }
  return { table, trace, failed: false };
}

/**
 * Exécute un GRAPHE : { nodes: [{ id, type, kind, params }], edges: [{ from, to, port }] }.
 *
 *   kind = "source"      → `ctx.readSource(node)` fournit la table ;
 *   kind = "transform"   → STEPS[node.type].run(entrée(s)) ;
 *   kind = "destination" → la table passe telle quelle (l'écriture est le
 *                          travail de l'appelant, qui sait s'il exécute ou aperçoit).
 *
 * Rend { results: { nodeId → { table, error, ms, skipped } }, order, failed }.
 * Un nœud dont une entrée a échoué est marqué `skipped` : on ne calcule pas
 * sur du vide en faisant comme si de rien n'était.
 */
export async function runGraph(graph, ctx = {}) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const incoming = Object.fromEntries(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (incoming[e.to] && byId[e.from]) incoming[e.to].push(e);

  // Ordre topologique (Kahn). Un cycle laisse des nœuds non visités : ils
  // sortent en erreur plutôt que de boucler.
  const degree = Object.fromEntries(nodes.map((n) => [n.id, incoming[n.id].length]));
  const queue = nodes.filter((n) => !degree[n.id]).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of edges) if (e.from === id && degree[e.to] !== undefined && !--degree[e.to]) queue.push(e.to);
  }

  const results = {};
  let failed = false;
  for (const id of order) {
    const node = byId[id];
    const t0 = Date.now();
    try {
      const ins = incoming[id];
      const inputTables = [];
      const inputNames = [];
      const ports = stepInputs(node.type);
      if (node.kind === "transform" && ports !== "multi") {
        // Chaque port reçoit AU PLUS une entrée ; le port par défaut est le premier.
        for (let p = 0; p < ports.length; p++) {
          const e = ins.find((x) => (x.port || 0) === p);
          if (!e) { if (p === 0) throw new Error("Reliez une entrée à ce bloc."); inputTables.push(null); continue; }
          const src = results[e.from];
          if (!src || src.error || src.skipped) throw Object.assign(new Error("Entrée en erreur."), { skipped: true });
          inputTables.push(src.table);
          inputNames.push(byId[e.from]?.label || byId[e.from]?.type || e.from);
        }
      } else if (node.kind !== "source") {
        if (!ins.length) throw new Error("Reliez une entrée à ce bloc.");
        for (const e of ins) {
          const src = results[e.from];
          if (!src || src.error || src.skipped) throw Object.assign(new Error("Entrée en erreur."), { skipped: true });
          inputTables.push(src.table);
          inputNames.push(byId[e.from]?.label || byId[e.from]?.type || e.from);
        }
      }
      let table;
      if (node.kind === "source") {
        if (!ctx.readSource) throw new Error("Aucun lecteur de source.");
        table = await ctx.readSource(node);
      } else if (node.kind === "transform") {
        const def = STEPS[node.type];
        if (!def) throw new Error(`Étape inconnue : ${node.type}`);
        if (node.disabled) table = inputTables[0];
        else table = await def.run(inputTables[0], node.params || {}, { ...ctx, inputs: inputTables, inputNames, node });
      } else {
        table = inputTables[0];
        if (ctx.writeDestination) await ctx.writeDestination(node, table);
      }
      if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw new Error("Le bloc n'a pas produit de table.");
      results[id] = { table, ms: Date.now() - t0 };
    } catch (e) {
      failed = failed || !e?.skipped;
      results[id] = { table: emptyTable(), error: e?.skipped ? null : String(e?.message || e), skipped: !!e?.skipped, ms: Date.now() - t0 };
    }
  }
  for (const n of nodes) if (!results[n.id]) { results[n.id] = { table: emptyTable(), error: "Ce bloc fait partie d'une boucle.", ms: 0 }; failed = true; }
  return { results, order, failed };
}

/** Sérialise en CSV. Séparateurs, guillemets et retours à la ligne échappés. */
export function toCsv(table, delimiter = ",") {
  const needsQuotes = (s) => s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(delimiter);
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return needsQuotes(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = table.columns.map(esc).join(delimiter);
  const body = table.rows.map((r) => table.columns.map((c) => esc(r[c])).join(delimiter));
  return [head, ...body].join("\n");
}

/** Analyseur CSV : guillemets, séparateur deviné (ou imposé), rien de plus. */
export function parseCsv(text, limit, delimiter) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const lines = [];
  // Découpe en lignes en respectant les guillemets : une cellule peut
  // contenir un retour à la ligne.
  let cur = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') { quoted = !quoted; cur += c; }
    else if ((c === "\n" || c === "\r") && !quoted) { if (c === "\r" && src[i + 1] === "\n") i++; if (cur.length) lines.push(cur); cur = ""; }
    else cur += c;
  }
  if (cur.length) lines.push(cur);
  if (!lines.length) return { columns: [], rows: [] };
  // Le séparateur se devine sur l'en-tête : un CSV français est souvent en
  // point-virgule, et demander à l'utilisateur serait une question de trop.
  const head = lines[0];
  const delim = delimiter || [";", "\t", ",", "|"].sort((a, b) => head.split(b).length - head.split(a).length)[0];
  const split = (line) => {
    const out = [];
    let cell = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { out.push(cell); cell = ""; }
      else cell += c;
    }
    out.push(cell);
    return out;
  };
  const columns = split(head).map((c, i) => c.trim() || `col_${i + 1}`);
  const rows = lines.slice(1, (limit || 100000) + 1).map((line) => {
    const cells = split(line);
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] === "" ? null : (cells[i] ?? null)]));
  });
  return { columns, rows };
}

/** JSON (tableau d'objets, ou objet contenant un tableau) ou JSON Lines → table. */
export function parseJsonTable(text, limit, rowsPath) {
  const src = String(text ?? "").trim();
  if (!src) return { columns: [], rows: [] };
  let data;
  try { data = JSON.parse(src); }
  catch {
    // JSON Lines : un objet par ligne.
    data = src.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  if (rowsPath) for (const k of String(rowsPath).split(".").filter(Boolean)) data = data?.[k];
  if (!Array.isArray(data)) {
    // Un objet dont une des clés porte le tableau : on prend la première.
    const arr = data && typeof data === "object" ? Object.values(data).find(Array.isArray) : null;
    data = arr || (data && typeof data === "object" ? [data] : []);
  }
  const rows = data.slice(0, limit || 100000).map((r) => {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      const out = {};
      for (const [k, v] of Object.entries(r)) out[k] = v && typeof v === "object" ? JSON.stringify(v) : v;
      return out;
    }
    return { valeur: Array.isArray(r) ? JSON.stringify(r) : r };
  });
  return tableFrom(rows);
}
