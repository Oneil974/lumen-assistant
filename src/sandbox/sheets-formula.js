// Moteur de formules du tableur Lumen (app « Calc »).
//
// Isolé du rendu : il ne connaît que des cellules brutes, ce qui le rend
// testable et réutilisable (les blocs Fluxo pourront s'en servir plus tard).
//
// Grammaire reconnue — proche de LibreOffice Calc :
//   =A1+B2*3        opérateurs + - * / ^ % et parenthèses
//   =A1&" "&B1      concaténation
//   =SI(A1>10;"ok";"ko")   comparaisons = <> < <= > >=
//   =SOMME(A1:A9)   plages, listes d'arguments, imbrications
// Le séparateur d'arguments accepté est « ; » OU « , » (les deux usages
// cohabitent selon les tableurs d'origine ; refuser l'un des deux ne ferait que
// produire des #ERREUR incompréhensibles).

// ── Références de cellules ──────────────────────────────────────────────────
export function colName(i) {
  let s = "";
  i = Number(i);
  do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
  return s;
}
export function colIndex(name) {
  let n = 0;
  for (const ch of String(name).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const cellKey = (r, c) => `${colName(c)}${r + 1}`;
export function parseKey(key) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(String(key).toUpperCase());
  if (!m) return null;
  return { r: parseInt(m[2], 10) - 1, c: colIndex(m[1]) };
}

// ── Valeurs ─────────────────────────────────────────────────────────────────
// Une valeur calculée est un nombre, une chaîne, un booléen ou une erreur
// (`{ err: "#DIV/0!" }`). Les erreurs se propagent sans lever d'exception :
// une seule cellule fautive ne doit pas vider toute la feuille.
const err = (code) => ({ err: code });
const isErr = (v) => v && typeof v === "object" && "err" in v;

export function toNumber(v) {
  if (isErr(v)) return v;
  if (v === "" || v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v).trim().replace(/\s/g, "").replace(/^([-+]?\d+),(\d+)$/, "$1.$2");
  const n = Number(s.replace(/%$/, ""));
  if (!Number.isFinite(n)) return err("#VALEUR!");
  return /%$/.test(s) ? n / 100 : n;
}
export function toText(v) {
  if (isErr(v)) return v.err;
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "VRAI" : "FAUX";
  return String(v);
}
/** Une saisie brute est-elle un nombre ? (utilisé pour l'alignement et les formats) */
export function rawNumber(raw) {
  if (typeof raw === "number") return raw;
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const norm = s.replace(/\s/g, "").replace(/^([-+]?\d+),(\d+)$/, "$1.$2");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)%?$/.test(norm)) return null;
  const n = Number(norm.replace(/%$/, ""));
  if (!Number.isFinite(n)) return null;
  return /%$/.test(norm) ? n / 100 : n;
}

// ── Analyse lexicale ────────────────────────────────────────────────────────
function tokenize(src) {
  const out = [];
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '"') {
      let j = i + 1, buf = "";
      while (j < s.length) {
        if (s[j] === '"' && s[j + 1] === '"') { buf += '"'; j += 2; continue; }
        if (s[j] === '"') break;
        buf += s[j]; j += 1;
      }
      out.push({ t: "str", v: buf }); i = j + 1; continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(s[i + 1] || ""))) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
      out.push({ t: "num", v: Number(s.slice(i, j)) }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_.$]/.test(s[j])) j += 1;
      const word = s.slice(i, j);
      // Une plage (A1:B9) est lexée d'un bloc : sinon « : » serait ambigu.
      if (s[j] === ":" && /^\$?[A-Za-z]+\$?\d+$/.test(word)) {
        let k = j + 1;
        while (k < s.length && /[A-Za-z0-9_$]/.test(s[k])) k += 1;
        const end = s.slice(j + 1, k);
        if (/^\$?[A-Za-z]+\$?\d+$/.test(end)) { out.push({ t: "range", v: [word, end] }); i = k; continue; }
      }
      if (s[j] === "(") { out.push({ t: "func", v: word.toUpperCase() }); i = j; continue; }
      if (/^\$?[A-Za-z]+\$?\d+$/.test(word)) { out.push({ t: "ref", v: word }); i = j; continue; }
      out.push({ t: "name", v: word.toUpperCase() }); i = j; continue;
    }
    const two = s.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/^&%(),;=<>:".includes(ch)) { out.push({ t: "op", v: ch }); i += 1; continue; }
    return null; // caractère inattendu → formule invalide
  }
  return out;
}

// ── Analyse syntaxique (descente récursive) ─────────────────────────────────
function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const eat = (v) => { if (tokens[p] && tokens[p].v === v) { p += 1; return true; } return false; };

  function parseCompare() {
    let left = parseConcat();
    while (peek() && peek().t === "op" && ["=", "<>", "<", "<=", ">", ">="].includes(peek().v)) {
      const op = tokens[p++].v;
      left = { k: "bin", op, a: left, b: parseConcat() };
    }
    return left;
  }
  function parseConcat() {
    let left = parseAdd();
    while (peek() && peek().v === "&") { p += 1; left = { k: "bin", op: "&", a: left, b: parseAdd() }; }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek() && (peek().v === "+" || peek().v === "-")) {
      const op = tokens[p++].v;
      left = { k: "bin", op, a: left, b: parseMul() };
    }
    return left;
  }
  function parseMul() {
    let left = parsePow();
    while (peek() && (peek().v === "*" || peek().v === "/")) {
      const op = tokens[p++].v;
      left = { k: "bin", op, a: left, b: parsePow() };
    }
    return left;
  }
  function parsePow() {
    const left = parseUnary();
    if (peek() && peek().v === "^") { p += 1; return { k: "bin", op: "^", a: left, b: parsePow() }; }
    return left;
  }
  function parseUnary() {
    if (peek() && (peek().v === "-" || peek().v === "+")) {
      const op = tokens[p++].v;
      return { k: "un", op, a: parseUnary() };
    }
    return parsePostfix();
  }
  function parsePostfix() {
    let node = parseAtom();
    while (peek() && peek().v === "%") { p += 1; node = { k: "pct", a: node }; }
    return node;
  }
  function parseAtom() {
    const tk = tokens[p];
    if (!tk) return { k: "err", code: "#SYNTAXE!" };
    if (tk.t === "num") { p += 1; return { k: "num", v: tk.v }; }
    if (tk.t === "str") { p += 1; return { k: "str", v: tk.v }; }
    if (tk.t === "ref") { p += 1; return { k: "ref", v: tk.v }; }
    if (tk.t === "range") { p += 1; return { k: "range", a: tk.v[0], b: tk.v[1] }; }
    if (tk.t === "name") {
      p += 1;
      if (tk.v === "VRAI" || tk.v === "TRUE") return { k: "bool", v: true };
      if (tk.v === "FAUX" || tk.v === "FALSE") return { k: "bool", v: false };
      return { k: "err", code: "#NOM?" };
    }
    if (tk.t === "func") {
      const name = tk.v; p += 1;
      if (!eat("(")) return { k: "err", code: "#SYNTAXE!" };
      const args = [];
      if (!eat(")")) {
        for (;;) {
          args.push(parseCompare());
          if (eat(";") || eat(",")) continue;
          if (eat(")")) break;
          return { k: "err", code: "#SYNTAXE!" };
        }
      }
      return { k: "call", name, args };
    }
    if (tk.v === "(") { p += 1; const e = parseCompare(); if (!eat(")")) return { k: "err", code: "#SYNTAXE!" }; return e; }
    return { k: "err", code: "#SYNTAXE!" };
  }

  const ast = parseCompare();
  if (p < tokens.length) return { k: "err", code: "#SYNTAXE!" };
  return ast;
}

// ── Fonctions ───────────────────────────────────────────────────────────────
// Les noms français et anglais pointent sur la même implémentation : un fichier
// importé d'un autre tableur reste calculable sans réécriture.
const num = (v) => toNumber(v);
function flat(vals) {
  const out = [];
  for (const v of vals) { if (Array.isArray(v)) out.push(...flat(v)); else out.push(v); }
  return out;
}
function nums(vals) {
  const out = [];
  for (const v of flat(vals)) {
    if (isErr(v)) return v;
    if (v === "" || v == null || typeof v === "string") { const n = rawNumber(v); if (n != null) out.push(n); continue; }
    if (typeof v === "boolean") continue;
    out.push(v);
  }
  return out;
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
function stdev(a, pop) {
  if (a.length < (pop ? 1 : 2)) return err("#DIV/0!");
  const m = sum(a) / a.length;
  const v = sum(a.map((x) => (x - m) ** 2)) / (a.length - (pop ? 0 : 1));
  return Math.sqrt(v);
}
// Critère façon Calc : nombre, "texte", ">10", "<>x"…
function matchCriteria(value, crit) {
  const c = toText(crit).trim();
  const m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(c);
  const op = m ? m[1] : "=";
  const target = m ? m[2].trim() : c;
  const tn = rawNumber(target), vn = rawNumber(value);
  if (tn != null && vn != null) {
    switch (op) {
      case "=": return vn === tn; case "<>": return vn !== tn;
      case "<": return vn < tn; case "<=": return vn <= tn;
      case ">": return vn > tn; default: return vn >= tn;
    }
  }
  const vs = toText(value).toLowerCase(), ts = target.toLowerCase();
  return op === "<>" ? vs !== ts : vs === ts;
}
const dateOnly = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const FUNCS = {
  SOMME: (a) => { const n = nums(a); return isErr(n) ? n : sum(n); },
  MOYENNE: (a) => { const n = nums(a); if (isErr(n)) return n; return n.length ? sum(n) / n.length : err("#DIV/0!"); },
  MIN: (a) => { const n = nums(a); if (isErr(n)) return n; return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = nums(a); if (isErr(n)) return n; return n.length ? Math.max(...n) : 0; },
  NB: (a) => nums(a).length ?? 0,
  NBVAL: (a) => flat(a).filter((v) => v !== "" && v != null).length,
  MEDIANE: (a) => {
    const n = nums(a); if (isErr(n)) return n;
    if (!n.length) return err("#DIV/0!");
    const s = [...n].sort((x, y) => x - y), h = Math.floor(s.length / 2);
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  },
  ECARTYPE: (a) => { const n = nums(a); return isErr(n) ? n : stdev(n, false); },
  ECARTYPEP: (a) => { const n = nums(a); return isErr(n) ? n : stdev(n, true); },
  SI: (a) => {
    const cond = a[0];
    if (isErr(cond)) return cond;
    const truthy = typeof cond === "boolean" ? cond : num(cond) !== 0;
    const branch = truthy ? a[1] : a[2];
    return branch === undefined ? truthy : (Array.isArray(branch) ? branch[0] : branch);
  },
  SIERREUR: (a) => (isErr(a[0]) ? (a[1] === undefined ? "" : a[1]) : a[0]),
  ET: (a) => flat(a).every((v) => (typeof v === "boolean" ? v : num(v) !== 0)),
  OU: (a) => flat(a).some((v) => (typeof v === "boolean" ? v : num(v) !== 0)),
  NON: (a) => !(typeof a[0] === "boolean" ? a[0] : num(a[0]) !== 0),
  ARRONDI: (a) => { const n = num(a[0]); if (isErr(n)) return n; const d = a[1] === undefined ? 0 : num(a[1]); const f = 10 ** d; return Math.round(n * f) / f; },
  ABS: (a) => { const n = num(a[0]); return isErr(n) ? n : Math.abs(n); },
  RACINE: (a) => { const n = num(a[0]); if (isErr(n)) return n; return n < 0 ? err("#NOMBRE!") : Math.sqrt(n); },
  PUISSANCE: (a) => { const x = num(a[0]), y = num(a[1]); return isErr(x) ? x : isErr(y) ? y : x ** y; },
  MOD: (a) => { const x = num(a[0]), y = num(a[1]); if (isErr(x)) return x; if (isErr(y)) return y; return y === 0 ? err("#DIV/0!") : x % y; },
  ENT: (a) => { const n = num(a[0]); return isErr(n) ? n : Math.floor(n); },
  ALEA: () => Math.random(),
  PI: () => Math.PI,
  CONCATENER: (a) => flat(a).map(toText).join(""),
  NBCAR: (a) => toText(a[0]).length,
  MAJUSCULE: (a) => toText(a[0]).toUpperCase(),
  MINUSCULE: (a) => toText(a[0]).toLowerCase(),
  SUPPRESPACE: (a) => toText(a[0]).trim(),
  GAUCHE: (a) => toText(a[0]).slice(0, a[1] === undefined ? 1 : num(a[1])),
  DROITE: (a) => { const t = toText(a[0]); const n = a[1] === undefined ? 1 : num(a[1]); return n <= 0 ? "" : t.slice(-n); },
  STXT: (a) => { const start = Math.max(1, num(a[1])); return toText(a[0]).substr(start - 1, num(a[2])); },
  AUJOURDHUI: () => dateOnly(new Date()),
  MAINTENANT: () => new Date().toLocaleString(),
  ANNEE: (a) => new Date(toText(a[0])).getFullYear() || err("#VALEUR!"),
  MOIS: (a) => new Date(toText(a[0])).getMonth() + 1 || err("#VALEUR!"),
  JOUR: (a) => new Date(toText(a[0])).getDate() || err("#VALEUR!"),
  "SOMME.SI": (a) => {
    const range = Array.isArray(a[0]) ? a[0] : [a[0]];
    const target = a[2] !== undefined ? (Array.isArray(a[2]) ? a[2] : [a[2]]) : range;
    let total = 0;
    range.forEach((v, i) => { if (matchCriteria(v, a[1])) { const n = rawNumber(target[i]); if (n != null) total += n; } });
    return total;
  },
  "NB.SI": (a) => {
    const range = Array.isArray(a[0]) ? a[0] : [a[0]];
    return range.filter((v) => matchCriteria(v, a[1])).length;
  },
  "MOYENNE.SI": (a) => {
    const range = Array.isArray(a[0]) ? a[0] : [a[0]];
    const target = a[2] !== undefined ? (Array.isArray(a[2]) ? a[2] : [a[2]]) : range;
    const kept = [];
    range.forEach((v, i) => { if (matchCriteria(v, a[1])) { const n = rawNumber(target[i]); if (n != null) kept.push(n); } });
    return kept.length ? sum(kept) / kept.length : err("#DIV/0!");
  },
  RECHERCHEV: (a, meta) => {
    const grid = meta.grid || [];
    const col = num(a[2]);
    if (isErr(col)) return col;
    for (const row of grid) {
      if (matchCriteria(row[0], a[0])) return row[col - 1] === undefined ? err("#N/A") : row[col - 1];
    }
    return err("#N/A");
  },
  INDEX: (a, meta) => {
    const grid = meta.grid || [];
    const r = num(a[1]), c = a[2] === undefined ? 1 : num(a[2]);
    const row = grid[r - 1];
    if (!row || row[c - 1] === undefined) return err("#REF!");
    return row[c - 1];
  },
  EQUIV: (a) => {
    const range = Array.isArray(a[1]) ? a[1] : [a[1]];
    const i = range.findIndex((v) => matchCriteria(v, a[0]));
    return i < 0 ? err("#N/A") : i + 1;
  },
};
// Alias anglais (et variantes courantes) → même fonction.
const ALIASES = {
  SUM: "SOMME", AVERAGE: "MOYENNE", COUNT: "NB", COUNTA: "NBVAL", MEDIAN: "MEDIANE",
  STDEV: "ECARTYPE", STDEVP: "ECARTYPEP", IF: "SI", IFERROR: "SIERREUR", AND: "ET", OR: "OU", NOT: "NON",
  ROUND: "ARRONDI", SQRT: "RACINE", POWER: "PUISSANCE", INT: "ENT", RAND: "ALEA",
  CONCAT: "CONCATENER", CONCATENATE: "CONCATENER", LEN: "NBCAR", UPPER: "MAJUSCULE", LOWER: "MINUSCULE",
  TRIM: "SUPPRESPACE", LEFT: "GAUCHE", RIGHT: "DROITE", MID: "STXT",
  TODAY: "AUJOURDHUI", NOW: "MAINTENANT", YEAR: "ANNEE", MONTH: "MOIS", DAY: "JOUR",
  SUMIF: "SOMME.SI", COUNTIF: "NB.SI", AVERAGEIF: "MOYENNE.SI", VLOOKUP: "RECHERCHEV", MATCH: "EQUIV",
};
export const FUNCTION_NAMES = [...new Set([...Object.keys(FUNCS), ...Object.keys(ALIASES)])].sort();

// ── Évaluation ──────────────────────────────────────────────────────────────
// `getRaw(key)` renvoie la saisie brute d'une cellule ; le cache et la pile
// `visiting` détectent les références circulaires (sinon : pile saturée).
export function createEvaluator(getRaw) {
  const cache = new Map();
  const visiting = new Set();

  function valueOf(key) {
    if (cache.has(key)) return cache.get(key);
    if (visiting.has(key)) return err("#CIRC!");
    visiting.add(key);
    let out;
    const raw = getRaw(key);
    if (raw == null || raw === "") out = "";
    // Apostrophe de tête : force le texte (convention Calc/Excel), ce qui permet
    // d'importer un CSV contenant « =… » sans le transformer en formule.
    else if (typeof raw === "string" && raw.startsWith("'")) out = raw.slice(1);
    else if (typeof raw === "string" && raw.trim().startsWith("=")) out = evalFormula(raw.trim().slice(1));
    else { const n = rawNumber(raw); out = n == null ? raw : n; }
    visiting.delete(key);
    cache.set(key, out);
    return out;
  }

  function rangeCells(a, b) {
    const A = parseKey(a), B = parseKey(b);
    if (!A || !B) return { flatVals: err("#REF!"), grid: [] };
    const r0 = Math.min(A.r, B.r), r1 = Math.max(A.r, B.r);
    const c0 = Math.min(A.c, B.c), c1 = Math.max(A.c, B.c);
    const grid = [], flatVals = [];
    for (let r = r0; r <= r1; r += 1) {
      const row = [];
      for (let c = c0; c <= c1; c += 1) { const v = valueOf(cellKey(r, c)); row.push(v); flatVals.push(v); }
      grid.push(row);
    }
    return { flatVals, grid };
  }

  function evalNode(node) {
    switch (node.k) {
      case "num": case "str": case "bool": return node.v;
      case "err": return err(node.code);
      case "ref": return valueOf(String(node.v).replace(/\$/g, "").toUpperCase());
      case "range": return rangeCells(node.a, node.b).flatVals;
      case "pct": { const v = toNumber(evalNode(node.a)); return isErr(v) ? v : v / 100; }
      case "un": {
        const v = toNumber(evalNode(node.a));
        if (isErr(v)) return v;
        return node.op === "-" ? -v : v;
      }
      case "bin": {
        const a = evalNode(node.a), b = evalNode(node.b);
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        if (node.op === "&") return toText(a) + toText(b);
        if (["=", "<>", "<", "<=", ">", ">="].includes(node.op)) {
          const an = rawNumber(a) ?? (typeof a === "number" ? a : null);
          const bn = rawNumber(b) ?? (typeof b === "number" ? b : null);
          const [x, y] = an != null && bn != null ? [an, bn] : [toText(a).toLowerCase(), toText(b).toLowerCase()];
          switch (node.op) {
            case "=": return x === y; case "<>": return x !== y;
            case "<": return x < y; case "<=": return x <= y;
            case ">": return x > y; default: return x >= y;
          }
        }
        const x = toNumber(a), y = toNumber(b);
        if (isErr(x)) return x;
        if (isErr(y)) return y;
        switch (node.op) {
          case "+": return x + y; case "-": return x - y; case "*": return x * y;
          case "/": return y === 0 ? err("#DIV/0!") : x / y;
          case "^": return x ** y;
          default: return err("#SYNTAXE!");
        }
      }
      case "call": {
        const name = ALIASES[node.name] || node.name;
        const fn = FUNCS[name];
        if (!fn) return err("#NOM?");
        // Les fonctions matricielles (RECHERCHEV, INDEX) ont besoin de la forme
        // 2D de leur plage, que l'aplatissement perdrait.
        let grid = [];
        const args = node.args.map((arg) => {
          if (arg.k === "range") { const rc = rangeCells(arg.a, arg.b); if (!grid.length) grid = rc.grid; return rc.flatVals; }
          return evalNode(arg);
        });
        try { return fn(args, { grid }); } catch { return err("#ERREUR!"); }
      }
      default: return err("#SYNTAXE!");
    }
  }

  function evalFormula(src) {
    const tokens = tokenize(src);
    if (!tokens || !tokens.length) return err("#SYNTAXE!");
    return evalNode(parse(tokens));
  }

  return { valueOf, evalFormula, isError: isErr, invalidate: () => { cache.clear(); visiting.clear(); } };
}

export { isErr as isFormulaError };
