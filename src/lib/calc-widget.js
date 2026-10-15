// Calculatrice scientifique montable n'importe où : app Calculatrice (plein
// cadre) et panneau d'appoint d'Études. Le calcul lui-même est dans
// calc-engine.js, partagé avec l'outil `calculate` de l'IA : l'app et le
// modèle donnent toujours le même résultat.
import { evaluate, formatNumber, statistics, convertUnit, UNIT_FAMILIES } from "./calc-engine.js";

const T = {
  fr: { sci: "Scientifique", stats: "Statistiques", conv: "Conversions", hist: "Historique", clear: "Effacer", empty: "Aucun calcul pour l'instant.",
    values: "Valeurs (séparées par des espaces, virgules ou points-virgules)", compute: "Calculer", family: "Grandeur", from: "De", to: "Vers", value: "Valeur",
    count: "Effectif", sum: "Somme", mean: "Moyenne", median: "Médiane", min: "Minimum", max: "Maximum", range: "Étendue", q1: "1er quartile", q3: "3e quartile",
    variance_population: "Variance (population)", variance_sample: "Variance (échantillon)", std_population: "Écart-type (population)", std_sample: "Écart-type (échantillon)", mode: "Mode",
    copy: "Copier", insert: "Réutiliser", err: "Erreur",
    fam: { length: "Longueur", mass: "Masse", time: "Durée", area: "Aire", volume: "Volume", speed: "Vitesse", energy: "Énergie", power: "Puissance", pressure: "Pression", data: "Données", angle: "Angle", temperature: "Température" } },
  en: { sci: "Scientific", stats: "Statistics", conv: "Conversions", hist: "History", clear: "Clear", empty: "No calculations yet.",
    values: "Values (separated by spaces, commas or semicolons)", compute: "Compute", family: "Quantity", from: "From", to: "To", value: "Value",
    count: "Count", sum: "Sum", mean: "Mean", median: "Median", min: "Minimum", max: "Maximum", range: "Range", q1: "1st quartile", q3: "3rd quartile",
    variance_population: "Variance (population)", variance_sample: "Variance (sample)", std_population: "Std. dev. (population)", std_sample: "Std. dev. (sample)", mode: "Mode",
    copy: "Copy", insert: "Reuse", err: "Error",
    fam: { length: "Length", mass: "Mass", time: "Time", area: "Area", volume: "Volume", speed: "Speed", energy: "Energy", power: "Power", pressure: "Pressure", data: "Data", angle: "Angle", temperature: "Temperature" } },
};

const CSS = `
.lc{--lc-gap:6px;display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;font:14px/1.4 var(--font-sans,system-ui);color:var(--foreground)}
.lc-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);padding-bottom:6px}
.lc-tabs button{border:0;background:none;color:var(--muted-foreground);padding:6px 10px;border-radius:8px;cursor:pointer;font:inherit}
.lc-tabs button.on{background:var(--muted);color:var(--foreground);font-weight:600}
.lc-pane{display:none;flex:1;min-height:0;gap:12px}
.lc-pane.on{display:flex}
.lc-sci{flex-direction:row}
.lc-main{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0}
.lc-screen{background:var(--muted);border:1px solid var(--border);border-radius:12px;padding:10px 14px;text-align:right}
.lc-screen input{width:100%;border:0;background:none;color:var(--muted-foreground);font:15px ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right;outline:none}
.lc-result{font:600 30px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto;white-space:nowrap;min-height:40px}
.lc-result.err{color:var(--destructive,#e5484d);font-size:15px}
.lc-flags{display:flex;gap:6px;justify-content:space-between;align-items:center}
.lc-flags button{border:1px solid var(--border);background:var(--background);color:var(--foreground);border-radius:999px;padding:3px 10px;font:12px inherit;cursor:pointer}
.lc-flags button.on{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
.lc-keys{display:grid;grid-template-columns:repeat(7,1fr);gap:var(--lc-gap);flex:1}
.lc-keys button{border:1px solid var(--border);background:var(--background);color:var(--foreground);border-radius:10px;font:15px inherit;min-height:38px;cursor:pointer}
.lc-keys button:hover{background:var(--muted)}
.lc-keys button.fn{color:var(--muted-foreground);font-size:13px}
.lc-keys button.op{background:var(--muted)}
.lc-keys button.wide{grid-column:span 4}
.lc-keys button.eq{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
.lc-hist{width:220px;display:flex;flex-direction:column;border-left:1px solid var(--border);padding-left:12px;min-height:0}
.lc-hist header{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px}
.lc-hist header button{border:0;background:none;color:var(--muted-foreground);cursor:pointer;font:12px inherit}
.lc-hist ol{list-style:none;margin:0;padding:0;overflow-y:auto;flex:1}
.lc-hist li{padding:6px 4px;border-bottom:1px solid var(--border);cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;text-align:right}
.lc-hist li:hover{background:var(--muted)}
.lc-hist li b{display:block;font-size:14px}
.lc-hist .lc-empty{color:var(--muted-foreground);font:12.5px inherit;text-align:left;cursor:default}
.lc-form{flex-direction:column;overflow-y:auto}
.lc-form label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted-foreground)}
.lc-form textarea,.lc-form input,.lc-form select{font:14px inherit;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--background);color:var(--foreground)}
.lc-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.lc-go{align-self:flex-start;border:0;background:var(--primary);color:var(--primary-foreground);border-radius:8px;padding:8px 16px;font:600 14px inherit;cursor:pointer}
.lc-table{width:100%;border-collapse:collapse;font-size:13.5px}
.lc-table td{padding:5px 8px;border-bottom:1px solid var(--border)}
.lc-table td:last-child{text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.lc-big{font:600 24px ui-monospace,SFMono-Regular,Menlo,monospace}
.lc.compact .lc-sci{flex-direction:column}
.lc.compact .lc-hist{width:auto;border-left:0;padding-left:0;max-height:140px}
.lc.compact .lc-keys button{min-height:32px;font-size:13.5px}
@media (max-width:640px){.lc-sci{flex-direction:column}.lc-hist{width:auto;border-left:0;padding-left:0;max-height:160px}}
`;

// [libellé, insertion, classe] — `null` en insertion = action spéciale.
const KEYS = [
  ["2nd", "@2nd", "fn"], ["(", "(", "fn"], [")", ")", "fn"], [",", ",", "fn"], ["%", "%", "fn"], ["AC", "@ac", "op"], ["⌫", "@back", "op"],
  ["sin", "sin(", "fn", "asin("], ["cos", "cos(", "fn", "acos("], ["tan", "tan(", "fn", "atan("], ["7", "7"], ["8", "8"], ["9", "9"], ["÷", "/", "op"],
  ["x²", "^2", "fn", "^3"], ["xʸ", "^", "fn", "root("], ["√", "sqrt(", "fn", "cbrt("], ["4", "4"], ["5", "5"], ["6", "6"], ["×", "*", "op"],
  ["ln", "ln(", "fn", "exp("], ["log", "log(", "fn", "10^"], ["n!", "!", "fn", "nCr("], ["1", "1"], ["2", "2"], ["3", "3"], ["−", "-", "op"],
  ["π", "pi", "fn", "tau"], ["e", "e", "fn", "phi"], ["1/x", "1/(", "fn"], ["±", "@neg", "fn"], ["0", "0"], [".", "."], ["+", "+", "op"],
  ["|x|", "abs(", "fn", "round("], ["EE", "E", "fn"], ["ans", "ans", "fn"], ["=", "@eq", "eq wide"],
];

let styled = false;
export function mountCalculator(host, { lang = "fr", compact = false, storageKey = "lumenCalc" } = {}) {
  const s = T[lang === "en" ? "en" : "fr"];
  if (!styled) { const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st); styled = true; }
  const load = () => { try { return JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { return {}; } };
  const saved = load();
  const state = { angle: saved.angle || "deg", history: Array.isArray(saved.history) ? saved.history.slice(0, 100) : [], ans: saved.ans || 0, second: false };
  const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify({ angle: state.angle, history: state.history, ans: state.ans })); } catch {} };
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  host.innerHTML = `<div class="lc${compact ? " compact" : ""}">
    <nav class="lc-tabs"><button class="on" data-tab="sci">${s.sci}</button><button data-tab="stats">${s.stats}</button><button data-tab="conv">${s.conv}</button></nav>
    <section class="lc-pane lc-sci on" data-pane="sci">
      <div class="lc-main">
        <div class="lc-screen"><input class="lc-expr" spellcheck="false" autocomplete="off" aria-label="Expression" /><div class="lc-result" aria-live="polite">0</div></div>
        <div class="lc-flags"><span><button data-angle="deg">DEG</button> <button data-angle="rad">RAD</button></span></div>
        <div class="lc-keys">${KEYS.map(([l, v, c = "", alt]) => `<button type="button" class="${c}" data-k="${esc(v)}"${alt ? ` data-alt="${esc(alt)}"` : ""} data-l="${esc(l)}">${esc(l)}</button>`).join("")}</div>
      </div>
      <aside class="lc-hist"><header><span>${s.hist}</span><button type="button" class="lc-hclear">${s.clear}</button></header><ol></ol></aside>
    </section>
    <section class="lc-pane lc-form" data-pane="stats">
      <label>${s.values}<textarea class="lc-sv" rows="4" placeholder="12 15 9 21 15 18"></textarea></label>
      <button type="button" class="lc-go lc-sgo">${s.compute}</button>
      <table class="lc-table lc-sout"></table>
    </section>
    <section class="lc-pane lc-form" data-pane="conv">
      <div class="lc-row">
        <label>${s.family}<select class="lc-cf">${Object.keys(UNIT_FAMILIES).map((f) => `<option value="${f}">${esc(s.fam[f] || f)}</option>`).join("")}</select></label>
        <label>${s.value}<input class="lc-cv" type="text" inputmode="decimal" value="1" /></label>
        <label>${s.from}<select class="lc-cfrom"></select></label>
        <label>${s.to}<select class="lc-cto"></select></label>
      </div>
      <div class="lc-big lc-cout"></div>
    </section>
  </div>`;
  const root = host.firstElementChild;
  const $ = (sel) => root.querySelector(sel);
  const expr = $(".lc-expr"), out = $(".lc-result"), hist = $(".lc-hist ol");

  // ---- Scientifique ----
  const preview = () => {
    const src = expr.value.trim();
    if (!src) { out.textContent = "0"; out.classList.remove("err"); return; }
    try { out.textContent = formatNumber(evaluate(src, { angle: state.angle, ans: state.ans })); out.classList.remove("err"); }
    catch { /* expression en cours de frappe : on garde le dernier aperçu */ }
  };
  const renderHist = () => {
    hist.innerHTML = state.history.length
      ? state.history.map((h, i) => `<li data-i="${i}" title="${s.insert}">${esc(h.expr)}<b>= ${esc(h.result)}</b></li>`).join("")
      : `<li class="lc-empty">${s.empty}</li>`;
  };
  const commit = () => {
    const src = expr.value.trim();
    if (!src) return;
    try {
      const v = evaluate(src, { angle: state.angle, ans: state.ans });
      const r = formatNumber(v);
      state.ans = v;
      state.history.unshift({ expr: src, result: r });
      state.history.length = Math.min(state.history.length, 100);
      out.textContent = r; out.classList.remove("err");
      expr.value = "";
      persist(); renderHist();
    } catch (e) { out.textContent = `${s.err} : ${e.message}`; out.classList.add("err"); }
  };
  const insert = (txt) => {
    const a = expr.selectionStart ?? expr.value.length, b = expr.selectionEnd ?? a;
    // Opérateur en tête d'une saisie vide : on enchaîne sur le dernier résultat.
    if (!expr.value && /^[\^+*/%!-]/.test(txt) && state.history.length) txt = "ans" + txt;
    expr.value = expr.value.slice(0, a) + txt + expr.value.slice(b);
    const pos = a + txt.length;
    expr.setSelectionRange(pos, pos);
    preview();
  };
  const setAngle = (a) => { state.angle = a; root.querySelectorAll("[data-angle]").forEach((b) => b.classList.toggle("on", b.dataset.angle === a)); persist(); preview(); };
  const setSecond = (on) => {
    state.second = on;
    root.querySelectorAll(".lc-keys button").forEach((b) => {
      if (b.dataset.k === "@2nd") b.classList.toggle("eq", on);
      else if (b.dataset.alt) b.textContent = on ? b.dataset.alt.replace(/\($/, "") : b.dataset.l;
    });
  };
  root.querySelector(".lc-keys").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const k = state.second && b.dataset.alt ? b.dataset.alt : b.dataset.k;
    if (k === "@2nd") return setSecond(!state.second);
    if (k === "@ac") { expr.value = ""; preview(); }
    else if (k === "@back") { expr.value = expr.value.slice(0, -1); preview(); }
    else if (k === "@eq") commit();
    else if (k === "@neg") { expr.value = expr.value ? `-(${expr.value})` : "-"; preview(); }
    else insert(k);
    if (state.second && b.dataset.alt) setSecond(false);
    if (!compact) expr.focus();
  });
  expr.addEventListener("input", preview);
  expr.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "=") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { expr.value = ""; preview(); }
    else if (e.key === "ArrowUp" && !expr.value && state.history[0]) { e.preventDefault(); expr.value = state.history[0].expr; preview(); }
  });
  root.querySelectorAll("[data-angle]").forEach((b) => b.addEventListener("click", () => setAngle(b.dataset.angle)));
  hist.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]"); if (!li) return;
    insert(state.history[+li.dataset.i].result.replace("∞", "inf"));
  });
  $(".lc-hclear").addEventListener("click", () => { state.history = []; persist(); renderHist(); });

  // ---- Statistiques ----
  $(".lc-sgo").addEventListener("click", () => {
    const tbl = $(".lc-sout");
    try {
      const st = statistics($(".lc-sv").value);
      tbl.innerHTML = Object.entries(st).map(([k, v]) => `<tr><td>${esc(s[k] || k)}</td><td>${esc(Array.isArray(v) ? (v.length ? v.map((x) => formatNumber(x)).join(", ") : "—") : formatNumber(v))}</td></tr>`).join("");
    } catch (e) { tbl.innerHTML = `<tr><td>${s.err}</td><td>${esc(e.message)}</td></tr>`; }
  });

  // ---- Conversions ----
  const cf = $(".lc-cf"), cfrom = $(".lc-cfrom"), cto = $(".lc-cto"), cv = $(".lc-cv"), cout = $(".lc-cout");
  const fillUnits = () => {
    const units = UNIT_FAMILIES[cf.value] || [];
    const opts = units.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join("");
    cfrom.innerHTML = opts; cto.innerHTML = opts;
    cto.selectedIndex = Math.min(1, units.length - 1);
    convert();
  };
  const convert = () => {
    try { const r = convertUnit(cv.value, cfrom.value, cto.value); cout.textContent = `${cv.value} ${cfrom.value} = ${formatNumber(r.value, 10)} ${cto.value}`; }
    catch (e) { cout.textContent = `${s.err} : ${e.message}`; }
  };
  cf.addEventListener("change", fillUnits);
  [cfrom, cto].forEach((el) => el.addEventListener("change", convert));
  cv.addEventListener("input", convert);

  root.querySelector(".lc-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]"); if (!b) return;
    root.querySelectorAll(".lc-tabs button").forEach((x) => x.classList.toggle("on", x === b));
    root.querySelectorAll(".lc-pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === b.dataset.tab));
  });

  setAngle(state.angle);
  renderHist();
  fillUnits();
  return { root, focus: () => expr.focus(), insert };
}
