// Moteur de calcul scientifique partagé : outil `calculate` de l'IA et app
// Calculatrice. Aucun eval() : analyse syntaxique maison (descente récursive),
// donc rien d'autre que des maths ne peut s'exécuter.
//
// Syntaxe : + - * / ^ (ou **) % (modulo), ! (factorielle), parenthèses,
// multiplication implicite (2pi, 3(4+1)), virgule décimale acceptée (3,5),
// constantes pi π e tau phi, fonctions listées dans FUNCS. `ans` = dernier
// résultat (fourni par l'appelant).

const FACT_MAX = 170;
function factorial(n) {
  if (!Number.isInteger(n) || n < 0) {
    if (n > 0 && n <= FACT_MAX) return gamma(n + 1);
    throw new Error("factorielle : entier positif attendu");
  }
  if (n > FACT_MAX) return Infinity;
  let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}
// Approximation de Lanczos.
function gamma(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  z -= 1; let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * t ** (z + 0.5) * Math.exp(-t) * x;
}
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };

export const CONSTS = { pi: Math.PI, "π": Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, inf: Infinity };

// Fonctions trigonométriques : l'angle suit le mode (deg/rad) de l'appelant.
function makeFuncs(angle) {
  const toRad = (x) => (angle === "deg" ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (angle === "deg" ? (x * 180) / Math.PI : x);
  return {
    sin: (x) => Math.sin(toRad(x)), cos: (x) => Math.cos(toRad(x)), tan: (x) => Math.tan(toRad(x)),
    asin: (x) => fromRad(Math.asin(x)), acos: (x) => fromRad(Math.acos(x)), atan: (x) => fromRad(Math.atan(x)),
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
    sqrt: Math.sqrt, cbrt: Math.cbrt, root: (x, n) => (x < 0 && n % 2 === 1 ? -((-x) ** (1 / n)) : x ** (1 / n)),
    exp: Math.exp, ln: Math.log, log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
    log10: Math.log10, log2: Math.log2,
    abs: Math.abs, sign: Math.sign, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc,
    round: (x, d = 0) => { const k = 10 ** d; return Math.round(x * k) / k; },
    min: Math.min, max: Math.max, hypot: Math.hypot,
    fact: factorial, gamma,
    nCr: (n, k) => factorial(n) / (factorial(k) * factorial(n - k)),
    nPr: (n, k) => factorial(n) / factorial(n - k),
    gcd: (...a) => a.reduce(gcd), lcm: (...a) => a.reduce((x, y) => Math.abs(x * y) / gcd(x, y)),
    mod: (a, b) => ((a % b) + b) % b,
    deg: (x) => (x * 180) / Math.PI, rad: (x) => (x * Math.PI) / 180,
    mean: (...a) => a.reduce((s, v) => s + v, 0) / a.length,
    sum: (...a) => a.reduce((s, v) => s + v, 0),
    pct: (x, p) => (x * p) / 100,
  };
}
export const FUNC_NAMES = Object.keys(makeFuncs("rad"));

function tokenize(src) {
  let s = String(src);
  // Virgule décimale française (« 3,5 ») seulement hors appel de fonction :
  // dans max(1,2) la virgule sépare les arguments.
  if (!/[a-zA-Z_]\s*\(/.test(s)) s = s.replace(/(\d),(\d)/g, "$1.$2");
  s = s
    .replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/√/g, "sqrt")
    .replace(/\*\*/g, "^");
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) { out.push({ t: "num", v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = /^[a-zA-Zπ_][a-zA-Z0-9_]*/.exec(s.slice(i));
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    if ("+-*/^%!(),;".includes(c)) { out.push({ t: c === ";" ? "," : c }); i++; continue; }
    throw new Error(`caractère inattendu « ${c} »`);
  }
  return out;
}

/// Évalue une expression. `opts.angle` : "rad" (défaut) ou "deg" ; `opts.ans`.
export function evaluate(expr, opts = {}) {
  const funcs = makeFuncs(opts.angle === "deg" ? "deg" : "rad");
  const vars = { ...CONSTS, ans: Number(opts.ans) || 0, ...(opts.vars || {}) };
  const toks = tokenize(expr);
  if (!toks.length) throw new Error("expression vide");
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => { if (toks[p]?.t !== t) throw new Error(`« ${t} » attendu`); p++; };
  // Priorités : somme < produit < unaire < puissance (associative à droite) < postfixe.
  function sum() {
    let v = product();
    while (peek() && (peek().t === "+" || peek().t === "-")) { const op = toks[p++].t; const r = product(); v = op === "+" ? v + r : v - r; }
    return v;
  }
  const startsFactor = (tk) => tk && (tk.t === "num" || tk.t === "id" || tk.t === "(");
  function product() {
    let v = unary();
    for (;;) {
      const tk = peek();
      if (tk && (tk.t === "*" || tk.t === "/" || tk.t === "%")) {
        p++; const r = unary();
        v = tk.t === "*" ? v * r : tk.t === "/" ? v / r : v % r;
      } else if (startsFactor(tk)) v *= unary(); // multiplication implicite
      else return v;
    }
  }
  function unary() {
    if (peek()?.t === "-") { p++; return -unary(); }
    if (peek()?.t === "+") { p++; return unary(); }
    return power();
  }
  function power() {
    const b = postfix();
    if (peek()?.t === "^") { p++; return b ** unary(); }
    return b;
  }
  function postfix() {
    let v = atom();
    while (peek()?.t === "!") { p++; v = factorial(v); }
    return v;
  }
  function atom() {
    const tk = toks[p++];
    if (!tk) throw new Error("expression incomplète");
    if (tk.t === "num") return tk.v;
    if (tk.t === "(") { const v = sum(); eat(")"); return v; }
    if (tk.t === "id") {
      const name = tk.v;
      const fn = funcs[name] || funcs[name.toLowerCase()];
      if (fn && peek()?.t === "(") {
        p++;
        const args = [];
        if (peek()?.t !== ")") { args.push(sum()); while (peek()?.t === ",") { p++; args.push(sum()); } }
        eat(")");
        return fn(...args);
      }
      if (fn && startsFactor(peek())) return fn(power()); // « sin 30 », « sqrt 2 »
      const k = name in vars ? name : name.toLowerCase();
      if (k in vars) return vars[k];
      throw new Error(`inconnu : « ${name} »`);
    }
    throw new Error(`« ${tk.t} » inattendu`);
  }
  const v = sum();
  if (p < toks.length) throw new Error(`« ${toks[p].v ?? toks[p].t} » inattendu`);
  return v;
}

/// Affichage lisible : arrondi des erreurs flottantes (0.1+0.2 → 0.3).
export function formatNumber(v, digits = 12) {
  if (typeof v !== "number") return String(v);
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "-∞";
  if (v !== 0 && (Math.abs(v) >= 1e15 || Math.abs(v) < 1e-9)) return v.toExponential(digits - 3).replace(/\.?0+e/, "e");
  return String(parseFloat(v.toPrecision(digits)));
}

// ---- Statistiques descriptives ----
export function statistics(values) {
  const xs = (Array.isArray(values) ? values : String(values).split(/[\s;,]+/))
    .map((x) => (typeof x === "number" ? x : parseFloat(String(x).replace(",", ".")))).filter((x) => Number.isFinite(x));
  if (!xs.length) throw new Error("aucune valeur numérique");
  const n = xs.length, sorted = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((s, v) => s + v, 0), mean = sum / n;
  const q = (f) => { const i = (n - 1) * f, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
  const varP = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const varS = n > 1 ? (varP * n) / (n - 1) : 0;
  const counts = new Map(); xs.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  const top = Math.max(...counts.values());
  return {
    count: n, sum, mean, median: q(0.5), min: sorted[0], max: sorted[n - 1], range: sorted[n - 1] - sorted[0],
    q1: q(0.25), q3: q(0.75), variance_population: varP, variance_sample: varS,
    std_population: Math.sqrt(varP), std_sample: Math.sqrt(varS),
    mode: top > 1 ? [...counts].filter(([, c]) => c === top).map(([v]) => v) : [],
  };
}

// ---- Conversion d'unités (facteurs vers l'unité de base de chaque famille) ----
const UNITS = {
  length: { m: 1, km: 1e3, cm: 0.01, mm: 1e-3, um: 1e-6, nm: 1e-9, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852, au: 1.495978707e11, ly: 9.4607e15 },
  mass: { kg: 1, g: 1e-3, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.028349523125, st: 6.35029318 },
  time: { s: 1, ms: 1e-3, min: 60, h: 3600, d: 86400, wk: 604800, yr: 31557600 },
  area: { m2: 1, km2: 1e6, cm2: 1e-4, ha: 1e4, a: 100, ft2: 0.09290304, in2: 6.4516e-4, acre: 4046.8564224, mi2: 2589988.110336 },
  volume: { l: 1e-3, ml: 1e-6, cl: 1e-5, dl: 1e-4, m3: 1, cm3: 1e-6, gal: 3.785411784e-3, qt: 9.46352946e-4, pt: 4.73176473e-4, floz: 2.95735295625e-5, cup: 2.365882365e-4 },
  speed: { "m/s": 1, "km/h": 1 / 3.6, mph: 0.44704, kn: 0.514444, "ft/s": 0.3048 },
  energy: { j: 1, kj: 1e3, cal: 4.184, kcal: 4184, wh: 3600, kwh: 3.6e6, ev: 1.602176634e-19, btu: 1055.05585 },
  power: { w: 1, kw: 1e3, mw: 1e6, hp: 745.699872, ch: 735.49875 },
  pressure: { pa: 1, hpa: 100, kpa: 1e3, bar: 1e5, mbar: 100, atm: 101325, psi: 6894.757293, mmhg: 133.322387 },
  data: { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776, bit: 0.125 },
  angle: { rad: 1, deg: Math.PI / 180, grad: Math.PI / 200, turn: 2 * Math.PI },
};
const ALIASES = { "°": "deg", degre: "deg", "degré": "deg", "degrés": "deg", metre: "m", "mètre": "m", "mètres": "m", litre: "l", litres: "l", kilo: "kg", kilos: "kg", gramme: "g", grammes: "g", heure: "h", heures: "h", jour: "d", jours: "d", "m²": "m2", "km²": "km2", "m³": "m3", "kmh": "km/h", "km/heure": "km/h", "°c": "c", "°f": "f", celsius: "c", fahrenheit: "f", kelvin: "k", mile: "mi", miles: "mi", pied: "ft", pieds: "ft", pouce: "in", pouces: "in", livre: "lb", livres: "lb", once: "oz", octet: "b", octets: "b", ko: "kb", mo: "mb", go: "gb", to: "tb" };
const norm = (u) => { const k = String(u || "").trim().toLowerCase(); return ALIASES[k] || k; };
const TEMPS = { c: [(x) => x, (x) => x], f: [(x) => ((x - 32) * 5) / 9, (x) => (x * 9) / 5 + 32], k: [(x) => x - 273.15, (x) => x + 273.15] };

export function convertUnit(value, from, to) {
  const v = Number(String(value).replace(",", "."));
  if (!Number.isFinite(v)) throw new Error("valeur numérique attendue");
  const a = norm(from), b = norm(to);
  if (TEMPS[a] && TEMPS[b]) return { value: TEMPS[b][1](TEMPS[a][0](v)), family: "temperature" };
  for (const [family, tbl] of Object.entries(UNITS)) {
    if (a in tbl && b in tbl) return { value: (v * tbl[a]) / tbl[b], family };
  }
  throw new Error(`conversion impossible de « ${from} » vers « ${to} »`);
}
export const UNIT_FAMILIES = { ...Object.fromEntries(Object.entries(UNITS).map(([k, v]) => [k, Object.keys(v)])), temperature: ["c", "f", "k"] };

// ---- Outils exposés à l'IA ----
const fn_ = (name, description, properties, required = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
export const CALC_TOOL_NAMES = new Set(["calculate", "statistics", "convert_units"]);
export function buildCalcTools() {
  return [
    fn_("calculate", "Calculatrice scientifique exacte : à utiliser pour TOUT calcul (ne jamais calculer de tête). Opérateurs + - * / ^ % !, parenthèses, fonctions sin cos tan asin acos atan sinh cosh tanh sqrt cbrt root(x,n) exp ln log(x[,base]) log2 abs round(x,décimales) floor ceil fact nCr(n,k) nPr(n,k) gcd lcm min max hypot mean sum pct(x,p), constantes pi e tau phi. Plusieurs expressions séparées par « | ».", {
      expression: { type: "string", description: "Expression, ex. « sqrt(2)*sin(45) » ou « 1250*(1+0.035)^10 »" },
      angle: { type: "string", enum: ["deg", "rad"], description: "Unité des angles pour la trigonométrie (deg par défaut)" },
    }, ["expression"]),
    fn_("statistics", "Statistiques descriptives exactes d'une série de nombres : effectif, somme, moyenne, médiane, quartiles, min/max, étendue, variance et écart-type (population et échantillon), mode.", {
      values: { type: "string", description: "Nombres séparés par des espaces, virgules ou points-virgules" },
    }, ["values"]),
    fn_("convert_units", "Convertit une valeur entre unités : longueur, masse, temps, aire, volume, vitesse, énergie, puissance, pression, données (Ko/Mo/Go…), angles, températures (c, f, k).", {
      value: { type: "number" }, from: { type: "string", description: "Unité source (km, lb, °f, kwh, mph…)" }, to: { type: "string", description: "Unité cible" },
    }, ["value", "from", "to"]),
  ];
}
export function callCalcTool(name, args = {}) {
  try {
    if (name === "calculate") {
      const angle = args.angle === "rad" ? "rad" : "deg";
      return String(args.expression || "").split("|").map((e) => e.trim()).filter(Boolean)
        .map((e) => `${e} = ${formatNumber(evaluate(e, { angle }))}`).join("\n") || "Erreur : expression vide";
    }
    if (name === "statistics") {
      const st = statistics(args.values);
      return Object.entries(st).map(([k, v]) => `${k}: ${Array.isArray(v) ? (v.length ? v.map((x) => formatNumber(x)).join(", ") : "—") : formatNumber(v)}`).join("\n");
    }
    if (name === "convert_units") {
      const r = convertUnit(args.value, args.from, args.to);
      return `${args.value} ${args.from} = ${formatNumber(r.value, 10)} ${args.to}`;
    }
  } catch (e) { return `Erreur : ${e?.message || e}`; }
  return `Erreur : outil inconnu ${name}`;
}
