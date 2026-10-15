// Affichage harmonisé d'une réponse en flux, partagé par toutes les surfaces
// (barre, fenêtre Assistant du bureau, apps, compagnon) :
//   • le RAISONNEMENT n'est jamais déroulé dans la réponse : il vit dans un
//     bloc repliable « Réflexion… » → « A réfléchi pendant 4 s » ;
//   • chaque APPEL D'OUTIL est un bloc repliable (nom + état), dont le détail
//     (arguments, résultat) s'ouvre au clic ;
//   • seul le TEXTE de la réponse s'écrit au fil de l'eau.
// Le rendu est cadencé sur requestAnimationFrame : un flux de 50 jetons/s ne
// reconstruit pas le Markdown 50 fois par seconde.

import { icon } from "./icons.js";
import { toolHint } from "./tool-publishing.js";

const CSS_ID = "lm-stream-css";

function ensureCss(doc = document) {
  if (doc.getElementById(CSS_ID)) return;
  const link = doc.createElement("link");
  link.id = CSS_ID;
  link.rel = "stylesheet";
  link.href = new URL("./stream-view.css", import.meta.url).href;
  doc.head.appendChild(link);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function lang() {
  try { return (localStorage.getItem("lang") || document.documentElement.lang || "fr").startsWith("en") ? "en" : "fr"; }
  catch { return "fr"; }
}
const L = {
  fr: { thinking: "Réflexion…", thought: (s) => `A réfléchi pendant ${s} s`, thoughtShort: "Raisonnement", running: "en cours", done: "terminé", args: "Paramètres", result: "Résultat", loading: "Chargement du modèle…", copy: "Copier", copied: "Copié", failed: "échec" },
  en: { thinking: "Thinking…", thought: (s) => `Thought for ${s}s`, thoughtShort: "Reasoning", running: "running", done: "done", args: "Parameters", result: "Result", loading: "Loading model…", copy: "Copy", copied: "Copied", failed: "failed" },
};
const tr = () => L[lang()];

const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>';

function prettyArgs(args) {
  if (args == null || args === "") return "";
  if (typeof args === "object") return JSON.stringify(args, null, 2);
  try { return JSON.stringify(JSON.parse(args), null, 2); } catch { return String(args); }
}

/** Bloc repliable du raisonnement. `live` = le modèle réfléchit encore. */
export function thinkBlock(doc = document) {
  ensureCss(doc);
  const el = doc.createElement("details");
  el.className = "lm-think";
  el.innerHTML = `<summary><span class="lm-ic">${SPARK}</span><span class="lm-label"></span></summary><div class="lm-body"></div>`;
  const label = el.querySelector(".lm-label");
  const body = el.querySelector(".lm-body");
  let last = "";
  return {
    el,
    set(text, { live = false, seconds = 0 } = {}) {
      el.classList.toggle("live", live);
      label.textContent = live ? tr().thinking : seconds ? tr().thought(seconds) : tr().thoughtShort;
      if (text !== last) { body.textContent = text; last = text; }
      if (live && el.open) body.scrollTop = body.scrollHeight;
    },
  };
}

// Icône par outil (jeu Lumen, lib/icons.js) : d'abord le nom exact, puis le
// préfixe. Un outil inconnu (workflow Fluxo, MCP, intention d'app) garde la clé.
const TOOL_ICON = {
  skills_list: "book-open", skill_read: "book-open", skill_file: "file-text",
  calculate: "calculator", statistics: "chart-column", convert_units: "ruler",
  weather_now: "cloud-sun", air_quality: "wind", sport_score: "trophy", market_quote: "chart-line",
  exchange_rate: "coins", news_headlines: "newspaper", time_now: "clock", generate_image: "image",
  web_search: "search", web_read_page: "globe", web_fetch: "globe", ask_user: "circle-help",
  create_reminder: "bell", day_overview: "sunrise", lumen_search: "search", search_lumen_docs: "book-open",
  search_documents: "library", rag_search: "library", query_tables: "database", export_pdf: "file-text",
  run_python: "terminal", search_personal_data: "scan-eye",
};
const TOOL_ICON_PREFIX = [
  ["mail_", "mail"], ["memory_", "brain"], ["sandbox_", "folder"], ["notes_", "notebook-pen"],
  ["tables_", "database"], ["data_", "database"], ["vault_", "database"], ["domotique_", "house"],
  ["doc_", "file-text"], ["project_", "messages-square"], ["agent", "bot"], ["calendar", "calendar"],
  ["agenda", "calendar"], ["kanban", "kanban"], ["apps_", "layout-grid"], ["app_", "layout-grid"],
  ["fluxo", "workflow"], ["web_", "globe"],
];
function toolIconName(name) {
  const n = String(name || "");
  if (TOOL_ICON[n]) return TOOL_ICON[n];
  const hit = TOOL_ICON_PREFIX.find(([p]) => n.startsWith(p));
  return hit ? hit[1] : "wrench";
}
/** Libellé lisible : catalogue des outils, sinon le nom « détaché ». */
function toolLabel(name) {
  const n = String(name || "");
  if (!n) return "…";
  try { const h = toolHint(n, lang()); if (h?.label) return h.label; } catch { /* catalogue absent */ }
  if (n === "ask_user") return lang() === "en" ? "Question for you" : "Question pour vous";
  const s = n.replace(/^mcp__/, "").replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const fmtDuration = (ms) => {
  if (!(ms >= 0)) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  const s = ms / 1000;
  return lang() === "en" ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${s.toFixed(s < 10 ? 1 : 0).replace(".", ",")} s`;
};
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5h.01"/></svg>';

/** Paramètres d'un appel en paires clé → valeur (JSON brut si imbriqué). */
function argPairs(args) {
  let o = args;
  if (typeof o === "string") { try { o = JSON.parse(o || "{}"); } catch { return null; } }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const pairs = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (pairs.some(([, v]) => typeof v === "object" && !Array.isArray(v))) return null;
  return pairs.map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]);
}

/** Bloc repliable d'un appel d'outil. `setResult` le marque terminé. */
export function toolBlock({ name = "", args = "", result, doc = document } = {}) {
  ensureCss(doc);
  const el = doc.createElement("details");
  el.className = "lm-tool running";
  el.innerHTML = `<summary><span class="lm-tile"><span class="lm-ic"></span><span class="lm-badge"></span></span><span class="lm-title"><strong class="lm-name"></strong><span class="lm-hint"></span></span><span class="lm-state"></span></summary>
    <div class="lm-body"><div class="lm-sec lm-args"><div class="lm-cap"><span>${esc(tr().args)}</span><code class="lm-raw"></code></div><dl class="lm-kv"></dl><pre hidden></pre></div><div class="lm-sec lm-res" hidden><div class="lm-cap"><span>${esc(tr().result)}</span><button type="button" class="lm-copy">${esc(tr().copy)}</button></div><dl class="lm-kv" hidden></dl><pre></pre></div></div>`;
  const nameEl = el.querySelector(".lm-name");
  const hintEl = el.querySelector(".lm-hint");
  const stateEl = el.querySelector(".lm-state");
  const icEl = el.querySelector(".lm-ic");
  const badgeEl = el.querySelector(".lm-badge");
  const rawEl = el.querySelector(".lm-raw");
  const kv = el.querySelector(".lm-kv");
  const argsPre = el.querySelector(".lm-args pre");
  const resSec = el.querySelector(".lm-res");
  const t0 = performance.now();
  let lastName = null;
  el.querySelector(".lm-copy").addEventListener("click", (e) => {
    e.preventDefault();
    const b = e.currentTarget;
    navigator.clipboard?.writeText(resSec.querySelector("pre").textContent).then(() => {
      b.textContent = tr().copied;
      setTimeout(() => { b.textContent = tr().copy; }, 1200);
    }).catch(() => {});
  });
  const api = {
    el,
    set(n, a) {
      if (n !== lastName) {
        lastName = n;
        nameEl.textContent = toolLabel(n);
        rawEl.textContent = n || "";
        el.dataset.tool = n || "";
        icEl.innerHTML = icon(toolIconName(n)) || GEAR;
      }
      const pairs = argPairs(a);
      // Le JSON reste toujours dans <pre> (même masqué) : l'historique des
      // conversations le relit pour restaurer le bloc.
      argsPre.textContent = prettyArgs(a);
      if (pairs) {
        kv.innerHTML = pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v.length > 400 ? `${v.slice(0, 400)}…` : v)}</dd>`).join("");
        kv.hidden = !pairs.length;
        argsPre.hidden = true;
      } else {
        argsPre.hidden = !argsPre.textContent;
        kv.hidden = true;
      }
      el.querySelector(".lm-args").hidden = kv.hidden && argsPre.hidden;
      // Aperçu d'une ligne dans l'en-tête : la valeur la plus parlante.
      let hint = "";
      try {
        const o = typeof a === "object" ? a : JSON.parse(a || "{}");
        const v = o && (o.question ?? o.query ?? o.location ?? o.city ?? o.place ?? o.input ?? o.text ?? o.url ?? o.task ?? o.title ?? Object.values(o).find((x) => typeof x === "string"));
        hint = typeof v === "string" ? v : "";
      } catch { /* arguments encore incomplets */ }
      hintEl.textContent = hint.slice(0, 120);
      hintEl.hidden = !hint;
      if (el.classList.contains("running")) stateEl.innerHTML = '<span class="lm-dots"><i></i><i></i><i></i></span>';
    },
    setResult(text) {
      el.classList.remove("running");
      el.classList.add("done");
      // Échec ou appel refusé : même bloc, teinté en avertissement.
      const err = /^(Erreur|Error)\b/i.test(String(text ?? "").trim());
      el.classList.toggle("err", err);
      badgeEl.innerHTML = err ? WARN : CHECK;
      stateEl.textContent = err ? tr().failed : fmtDuration(performance.now() - t0);
      resSec.hidden = false;
      const s = String(text ?? "");
      let shown = s;
      let pairs = null;
      try {
        const j = JSON.parse(s);
        if (j && typeof j === "object") { shown = JSON.stringify(j, null, 2); pairs = argPairs(j); }
      } catch { /* texte */ }
      // Objet plat et court (météo, cours…) : lu en clé → valeur.
      const resKv = resSec.querySelector(".lm-kv");
      const pre = resSec.querySelector("pre");
      pre.textContent = shown.length > 6000 ? `${shown.slice(0, 6000)}…` : shown;
      const asKv = pairs && pairs.length && pairs.length <= 14;
      resKv.hidden = !asKv;
      pre.hidden = !!asKv;
      if (asKv) resKv.innerHTML = pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v.length > 300 ? `${v.slice(0, 300)}…` : v)}</dd>`).join("");
    },
  };
  api.set(name, args);
  if (result !== undefined) api.setResult(result);
  return api;
}

/**
 * Vue de flux attachée à une bulle.
 * @param {object} o
 * @param {HTMLElement} o.answerEl   élément où s'écrit la réponse (Markdown rendu)
 * @param {HTMLElement} [o.blocksEl] conteneur des blocs repliables (défaut : juste avant answerEl)
 * @param {(md:string)=>string} o.render   Markdown → HTML sûr
 * @param {()=>void} [o.onRender]  appelé après chaque rendu (défilement…)
 */
export function createStreamView({ answerEl, blocksEl, render, onRender }) {
  const doc = answerEl.ownerDocument;
  ensureCss(doc);
  let blocks = blocksEl;
  if (!blocks) {
    blocks = doc.createElement("div");
    blocks.className = "lm-blocks";
    answerEl.parentNode.insertBefore(blocks, answerEl);
  }
  let think = null;
  const tools = [];
  let state = null;
  let raf = 0;
  let lastAnswer = null;
  let waitingEl = null;

  const paint = () => {
    raf = 0;
    if (!state) return;
    if (state.waiting && !waitingEl) {
      waitingEl = doc.createElement("div");
      waitingEl.className = "lm-wait";
      waitingEl.textContent = tr().loading;
      blocks.appendChild(waitingEl);
    } else if (!state.waiting && waitingEl) { waitingEl.remove(); waitingEl = null; }
    const reasoning = state.reasoning;
    if (reasoning || state.thinking) {
      if (!think) {
        // Le panneau d'étapes (réponse orchestrée) reste toujours en tête.
        think = thinkBlock(doc);
        const plan = blocks.querySelector(":scope > .lm-plan");
        blocks.insertBefore(think.el, plan ? plan.nextSibling : blocks.firstChild);
      }
      think.set(reasoning, { live: state.thinking, seconds: state.reasoningSeconds });
    }
    state.tools.forEach((tl, i) => {
      if (!tl) return;
      if (!tools[i]) { tools[i] = toolBlock({ name: tl.name, args: tl.args, doc }); blocks.appendChild(tools[i].el); }
      else tools[i].set(tl.name, tl.args);
    });
    // Appels d'outils au format LFM écrits en texte : jamais montrés tels quels.
    const answer = String(state.answer || "").replace(/<\|tool_call_start\|>[\s\S]*?(?:<\|tool_call_end\|>|$)/g, "").trim();
    if (answer !== lastAnswer) {
      lastAnswer = answer;
      answerEl.innerHTML = answer ? render(answer) : "";
      answerEl.classList.toggle("lm-streaming", true);
    }
    onRender?.();
  };

  return {
    /** À brancher sur `onUpdate` de streamInvoke. */
    update(s) { state = s; if (!raf) raf = requestAnimationFrame(paint); },
    /** Rendu immédiat (fin de flux). */
    flush() { if (raf) cancelAnimationFrame(raf); paint(); },
    /** Résultat d'un outil streamé (par index), ou nouveau bloc s'il n'existe pas. */
    toolResult(i, name, args, result) {
      if (!tools[i]) { tools[i] = toolBlock({ name, args, doc }); blocks.appendChild(tools[i].el); }
      tools[i].set(name, args);
      tools[i].setResult(result);
    },
    /** Nouveau tour de la boucle d'outils : les index repartent de zéro. */
    nextTurn() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (state) paint();
      tools.length = 0; think = null; state = null; lastAnswer = null;
      if (waitingEl) { waitingEl.remove(); waitingEl = null; }
    },
    finish() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (state) paint();
      if (think) think.set(state?.reasoning || "", { live: false, seconds: state?.reasoningSeconds || 0 });
      if (waitingEl) { waitingEl.remove(); waitingEl = null; }
      answerEl.classList.remove("lm-streaming");
      if (!blocks.childElementCount && !blocksEl) blocks.remove();
    },
    blocksEl: blocks,
  };
}

/**
 * Raccourci pour les apps : fait d'un élément de sortie la cible d'un flux.
 *   const out = streamTarget(el, renderMarkdown);
 *   const { content } = await llmChat(msgs, { onUpdate: out.onUpdate });
 *   out.done(renderMarkdown(content));
 * Le raisonnement éventuel reste replié au-dessus de la réponse finale.
 */
export function streamTarget(el, render, { onRender } = {}) {
  let view = null;
  let ans = null;
  return {
    onUpdate(st) {
      if (!view) {
        el.innerHTML = "";
        ans = el.ownerDocument.createElement("div");
        ans.className = "lm-answer";
        el.appendChild(ans);
        view = createStreamView({ answerEl: ans, render, onRender });
      }
      view.update(st);
    },
    /** Pose le rendu final (HTML) sans effacer les blocs repliables. */
    done(html) {
      view?.finish();
      if (html === undefined) return;
      if (ans) ans.innerHTML = html;
      else el.innerHTML = html;
    },
    get started() { return !!view; },
  };
}

/* ------------------------------------------------------------------ Plan
 * Panneau d'étapes du mode « Réponse orchestrée » (lib/orchestrator.js).
 * Ouvert pendant le travail — chaque étape avec son état, son détail, les
 * outils et données utilisés, et un petit message qui change toutes les
 * quelques secondes pour que l'attente ne paraisse pas figée — puis replié
 * sur une ligne de synthèse une fois la réponse écrite.
 */
const PLAN_ICON = {
  running: '<span class="lm-spin"></span>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
};
const PLAN_ORCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5 11 16M16 7.5 13 16M8.5 6h7"/></svg>';

export function planBlock({ title = "", doc = document, snapshot = null } = {}) {
  ensureCss(doc);
  const el = doc.createElement("details");
  el.className = "lm-plan live";
  el.open = true;
  el.innerHTML = `<summary><span class="lm-ic">${PLAN_ORCH}</span><strong class="lm-name"></strong><span class="lm-hint"></span></summary>
    <div class="lm-body"><ol class="lm-steps"></ol><div class="lm-plan-tools" hidden></div></div>`;
  const nameEl = el.querySelector(".lm-name");
  const hintEl = el.querySelector(".lm-hint");
  const list = el.querySelector(".lm-steps");
  const toolsEl = el.querySelector(".lm-plan-tools");
  nameEl.textContent = title;
  const steps = new Map(); // id → { li, status, label, detail, items, notes }
  const tools = [];
  let waitTimer = 0;
  let current = null;
  let finished = "";
  let held = false; // attente de l'utilisateur : pas de rotation des messages

  const render = (s) => {
    s.li.className = `lm-step ${s.status}`;
    s.li.innerHTML = `<span class="lm-step-ic">${PLAN_ICON[s.status] || ""}</span>
      <div class="lm-step-main"><div class="lm-step-label"></div><div class="lm-step-detail"></div><div class="lm-step-wait"></div><ul class="lm-step-items"></ul></div>`;
    s.li.querySelector(".lm-step-label").textContent = s.label;
    const d = s.li.querySelector(".lm-step-detail");
    d.textContent = s.detail || "";
    d.hidden = !s.detail;
    const w = s.li.querySelector(".lm-step-wait");
    w.textContent = s.status === "running" ? (s.waitText || "") : "";
    w.hidden = s.status !== "running";
    const ul = s.li.querySelector(".lm-step-items");
    const items = [...(s.items || []), ...(s.notes || [])];
    ul.hidden = !items.length;
    for (const it of items) { const li = doc.createElement("li"); li.textContent = it; ul.appendChild(li); }
  };
  const ensure = (id, label) => {
    let s = steps.get(id);
    if (!s) {
      s = { li: doc.createElement("li"), status: "running", label, detail: "", items: [], notes: [] };
      steps.set(id, s);
      list.appendChild(s.li);
    }
    if (label) s.label = label;
    return s;
  };
  const stopWait = () => { if (waitTimer) { clearInterval(waitTimer); waitTimer = 0; } };
  const header = () => {
    if (finished) { hintEl.textContent = ` · ${finished}`; return; }
    const s = current && steps.get(current);
    hintEl.textContent = s ? ` · ${s.label}` : "";
  };
  const renderTools = () => {
    toolsEl.hidden = !tools.length;
    toolsEl.innerHTML = tools.map((t) => `<span class="lm-chip" title="${esc(t.cat)}"><span class="lm-ic">${GEAR}</span>${esc(t.name)}</span>`).join("");
  };

  const api = {
    el,
    start(id, label, waits = []) {
      stopWait();
      const s = ensure(id, label);
      s.status = "running";
      current = id;
      let i = 0;
      s.waitText = waits[0] || "";
      render(s);
      header();
      if (waits.length > 1) {
        waitTimer = setInterval(() => {
          if (held) return;
          i = (i + 1) % waits.length;
          s.waitText = waits[i];
          const w = s.li.querySelector(".lm-step-wait");
          if (w && s.status === "running") w.textContent = s.waitText;
        }, 2600);
      }
    },
    wait(id, text) {
      const s = steps.get(id);
      if (!s) return;
      s.waitText = text;
      const w = s.li.querySelector(".lm-step-wait");
      if (w) w.textContent = text;
    },
    /** Fige le message d'attente (ex. « En attente de ta réponse… »). */
    hold(id, text) {
      held = true;
      el.classList.add("waiting-user");
      api.wait(id, text);
    },
    release() { held = false; el.classList.remove("waiting-user"); },
    note(id, text) { const s = steps.get(id); if (s) { s.notes.push(text); render(s); } },
    done(id, status, detail = "", items = [], label) {
      const s = ensure(id, label);
      if (current === id) stopWait();
      s.status = status || "ok";
      s.detail = detail;
      s.items = items || [];
      render(s);
      header();
    },
    skip(id, label, detail = "") { api.done(id, "skip", detail, [], label); },
    tool(name, cat) { tools.push({ name, cat }); renderTools(); },
    count() { return [...steps.values()].filter((s) => s.status !== "skip").length; },
    finish(summary) {
      stopWait();
      finished = summary || "";
      current = null;
      el.classList.remove("live");
      el.open = false;
      header();
    },
    fail(message) {
      stopWait();
      const s = current && steps.get(current);
      if (s) { s.status = "warn"; s.detail = message; render(s); }
      api.finish(message);
    },
    /** État sérialisable (historique, compagnon, Lumen XR). */
    snapshot() {
      return {
        title: nameEl.textContent,
        live: el.classList.contains("live"),
        summary: finished,
        tools: tools.slice(),
        steps: [...steps.entries()].map(([id, s]) => ({ id, label: s.label, status: s.status, detail: s.detail, items: [...(s.items || []), ...(s.notes || [])], wait: s.status === "running" ? s.waitText || "" : "" })),
      };
    },
  };

  if (snapshot) {
    nameEl.textContent = snapshot.title || title;
    for (const st of snapshot.steps || []) {
      const s = ensure(st.id, st.label);
      Object.assign(s, { status: st.status, detail: st.detail, items: st.items || [], notes: [], waitText: st.wait || "" });
      render(s);
      if (st.status === "running") current = st.id;
    }
    (snapshot.tools || []).forEach((t) => tools.push(t));
    renderTools();
    if (snapshot.live) { header(); }
    else { finished = snapshot.summary || ""; el.classList.remove("live"); el.open = false; header(); }
  }
  return api;
}
