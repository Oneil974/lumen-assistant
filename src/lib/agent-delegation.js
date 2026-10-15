// Délégation à un agent depuis une barre de chat : « @agent_redacteur écris… ».
//
// Chaque agent de l'atelier devient un outil `agent_<nom>` du catalogue « @ ».
// L'appel crée une VRAIE tâche dans sa todo (`agent_delegate` → `run_prompt`
// côté Rust : journal, compte rendu, escalade possible) et attend la fin du
// run. Pendant ce temps, la bulle du chat affiche une carte vivante alimentée
// par les évènements `agent-step` : chaque étape en langage courant, avec son
// icône, son résultat dépliable et le chrono du run. La capsule Halo, elle,
// reçoit les mêmes évènements et en montre la version courte.
//
// Partagé par la barre principale (main.js) et le bureau (sandbox/desktop.js).

import { icon } from "./icons.js";
import { humanStep, stepStatus } from "./agent-steps.js";
import { agentToolNames } from "./tool-publishing.js";
import { agentAvatarHTML, setAvatarState, preloadAvatar } from "./agent-avatar.js";

import { noteAgentVoice } from "./agent-voice.js";

export const AGENT_TOOL_PREFIX = "agent_";

const L = {
  fr: {
    working: "au travail",
    done: "Tâche terminée",
    failed: "Tâche en échec",
    escalated: "Décision attendue",
    waiting: "Prise en main de la tâche…",
    steps: "{n} étapes",
    step1: "1 étape",
    report: "Compte rendu",
    details: "Détails",
    open: "Ouvrir l'agent",
    desc: "Confie une tâche à l'agent « {name} »{desc}. Il travaille avec ses propres compétences, sa sandbox et ses outils, puis rend un compte rendu. Passe la demande COMPLÈTE de l'utilisateur dans task, sans la résumer.",
    task: "La tâche à confier à l'agent, formulée comme une consigne complète.",
    sub: "Agent · {desc}",
    result: "L'agent « {name} » a terminé{ok}. Son compte rendu (déjà affiché à l'utilisateur dans une carte, ne le recopie pas en entier ; résume-le en une ou deux phrases) :\n\n{report}",
    fail_suffix: " SANS réussir",
  },
  en: {
    working: "working",
    done: "Task done",
    failed: "Task failed",
    escalated: "Decision needed",
    waiting: "Picking up the task…",
    steps: "{n} steps",
    step1: "1 step",
    report: "Report",
    details: "Details",
    open: "Open the agent",
    desc: "Hands a task to the agent “{name}”{desc}. It works with its own skills, sandbox and tools, then returns a report. Pass the user's COMPLETE request in task, without summarizing it.",
    task: "The task to hand to the agent, phrased as a complete instruction.",
    sub: "Agent · {desc}",
    result: "Agent “{name}” finished{ok}. Its report (already shown to the user in a card; do not copy it in full, summarize it in one or two sentences):\n\n{report}",
    fail_suffix: " WITHOUT succeeding",
  },
};
const lang = (l) => (String(l || "fr").startsWith("en") ? "en" : "fr");
const fmt = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => v?.[k] ?? "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/// Agents connus lors du dernier `buildAgentTools` : nom de fonction → agent.
let agentToolMap = {};

export function isAgentTool(name) {
  return Object.prototype.hasOwnProperty.call(agentToolMap, String(name || ""));
}

/// Un outil par agent. Un agent désactivé reste délégable : c'est une demande
/// explicite, pas le planificateur.
export async function buildAgentTools(invoke, uiLang) {
  const s = L[lang(uiLang)];
  let list = [];
  try { list = (await invoke("agent_list")) || []; } catch { return []; }
  agentToolMap = {};
  const tools = [];
  for (const { fn, agent: a } of agentToolNames(list)) {
    // `voice` : sans elle, la réponse d'un agent doté d'une voix était lue avec celle de Lumen.
    agentToolMap[fn] = { id: a.id, name: a.name, avatar: a.avatar || null, description: a.description || "", voice: a.voice || "" };
    const desc = a.description ? ` (${String(a.description).slice(0, 160)})` : "";
    tools.push({
      type: "function",
      function: {
        name: fn,
        description: fmt(s.desc, { name: a.name, desc }),
        parameters: {
          type: "object",
          properties: { task: { type: "string", description: s.task } },
          required: ["task"],
        },
      },
    });
  }
  return tools;
}

/// Avatar (HTML) d'un outil d'agent pour le menu « @ » (null sinon).
export function agentToolAvatar(name, size = 22) {
  const a = agentToolMap[name];
  return a ? agentAvatarHTML(a, { size, hands: false, animate: false }) : null;
}

/// Sous-titre du menu « @ » pour un outil d'agent (null sinon).
export function agentToolHint(name, uiLang) {
  const a = agentToolMap[name];
  if (!a) return null;
  const s = L[lang(uiLang)];
  return fmt(s.sub, { desc: a.description || a.name });
}

// ===== Carte vivante =======================================================
export function ensureRunStyles() {
  if (document.getElementById("agent-run-css")) return;
  const st = document.createElement("style");
  st.id = "agent-run-css";
  st.textContent = `
.agent-run{--ar-accent:var(--primary,#7c6cf0);--ar-ok:oklch(.70 .16 150);--ar-bad:oklch(.62 .21 25);
  margin:10px 0 4px;border:1px solid var(--border,rgba(127,127,127,.25));border-radius:16px;
  background:color-mix(in oklab,var(--card,transparent) 92%,var(--ar-accent) 8%);overflow:hidden;
  font-size:13px;animation:ar-in .35s cubic-bezier(.2,.8,.2,1)}
@keyframes ar-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
.agent-run-head{display:flex;align-items:center;gap:10px;padding:10px 12px}
.agent-run-av{position:relative;width:46px;height:46px;flex:none;border-radius:15px;display:grid;place-items:center;
  background:color-mix(in oklab,var(--ar-accent) 13%,transparent)}
.agent-run[data-state="ok"] .agent-run-av{background:color-mix(in oklab,var(--ar-ok) 16%,transparent)}
.agent-run[data-state="fail"] .agent-run-av{background:color-mix(in oklab,var(--ar-bad) 14%,transparent)}
@keyframes ar-spin{to{transform:rotate(360deg)}}
.agent-run-id{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.agent-run-id b{font-weight:650}
.agent-run-id span{color:var(--muted-foreground,#888);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-run-meta{display:flex;align-items:center;gap:8px;color:var(--muted-foreground,#888);font-size:11.5px;font-variant-numeric:tabular-nums}
.agent-run-pill{padding:2px 8px;border-radius:999px;background:color-mix(in oklab,var(--ar-accent) 14%,transparent);color:var(--ar-accent);font-weight:600}
.agent-run[data-state="ok"] .agent-run-pill{background:color-mix(in oklab,var(--ar-ok) 16%,transparent);color:var(--ar-ok)}
.agent-run[data-state="fail"] .agent-run-pill{background:color-mix(in oklab,var(--ar-bad) 16%,transparent);color:var(--ar-bad)}
.agent-run-bar{height:2px;background:color-mix(in oklab,var(--ar-accent) 12%,transparent);overflow:hidden}
.agent-run-bar i{display:block;height:100%;width:35%;background:var(--ar-accent);border-radius:2px;animation:ar-bar 1.4s ease-in-out infinite}
.agent-run:not([data-state="run"]) .agent-run-bar{display:none}
@keyframes ar-bar{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
.agent-run-steps{list-style:none;margin:0;padding:6px 12px 10px 12px;display:flex;flex-direction:column;position:relative}
.agent-run-step{position:relative;display:grid;grid-template-columns:22px 1fr auto;gap:8px;align-items:start;padding:5px 0;animation:ar-step .32s cubic-bezier(.2,.8,.2,1)}
@keyframes ar-step{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}
.agent-run-step:not(:last-child)::before{content:"";position:absolute;left:10.5px;top:26px;bottom:-5px;width:1px;background:var(--border,rgba(127,127,127,.3))}
.agent-run-ic{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;color:var(--ar-accent);
  background:color-mix(in oklab,var(--ar-accent) 12%,transparent)}
.agent-run-ic svg{width:12px;height:12px}
.agent-run-step[data-tone="think"] .agent-run-ic{color:var(--muted-foreground,#888);background:color-mix(in oklab,currentColor 10%,transparent)}
.agent-run-step[data-tone="fail"] .agent-run-ic{color:var(--ar-bad);background:color-mix(in oklab,var(--ar-bad) 14%,transparent);animation:ar-shake .4s}
.agent-run-step[data-tone="retry"] .agent-run-ic{color:oklch(.72 .15 70);background:color-mix(in oklab,oklch(.72 .15 70) 14%,transparent)}
@keyframes ar-shake{25%{transform:translateX(-2px)}75%{transform:translateX(2px)}}
.agent-run-tx{min-width:0;display:flex;flex-direction:column;gap:2px}
.agent-run-tx b{font-weight:560}
.agent-run-step[data-tone="think"] .agent-run-tx b{font-weight:450;color:var(--muted-foreground,#888)}
.agent-run-tx details summary{cursor:pointer;color:var(--muted-foreground,#888);font-size:11.5px;list-style:none}
.agent-run-tx details summary::-webkit-details-marker{display:none}
.agent-run-tx details pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font:11.5px/1.45 ui-monospace,monospace;
  max-height:160px;overflow:auto;padding:6px 8px;border-radius:8px;background:color-mix(in oklab,var(--foreground,#000) 5%,transparent)}
.agent-run-ok{width:16px;height:16px;margin-top:3px;color:var(--ar-ok)}
.agent-run-ok svg{width:16px;height:16px}
.agent-run-ok path,.agent-run-ok polyline{stroke-dasharray:24;stroke-dashoffset:24;animation:ar-draw .45s .05s ease-out forwards}
@keyframes ar-draw{to{stroke-dashoffset:0}}
.agent-run-step[data-tone="fail"] .agent-run-ok{color:var(--ar-bad)}
.agent-run-step.is-live .agent-run-ok{border-radius:50%;border:2px solid color-mix(in oklab,var(--ar-accent) 25%,transparent);
  border-top-color:var(--ar-accent);animation:ar-spin .8s linear infinite;width:12px;height:12px}
.agent-run-waiting{color:var(--muted-foreground,#888);font-style:italic;padding:2px 0}
.agent-run-report{margin:0 12px 12px;padding:10px 12px;border-radius:12px;background:color-mix(in oklab,var(--foreground,#000) 4%,transparent);
  white-space:pre-wrap;line-height:1.5;animation:ar-in .35s}
.agent-run-report::before{content:attr(data-label);display:block;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-foreground,#888);margin-bottom:4px}
.agent-run-burst{position:absolute;inset:-6px;border-radius:18px;border:2px solid var(--ar-ok);animation:ar-burst .7s ease-out forwards;pointer-events:none}
@keyframes ar-burst{from{opacity:.9;transform:scale(.6)}to{opacity:0;transform:scale(1.5)}}
.doc-run-note{color:var(--muted-foreground,#888);font-size:11.5px}
.doc-run-body{padding:0 12px 12px;display:flex;flex-direction:column;gap:8px;animation:ar-in .35s}
.doc-run-src{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11.5px}
.doc-run-src>span{color:var(--muted-foreground,#888);font-weight:600;margin-right:2px}
.doc-run-src i{font-style:normal;display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;
  background:color-mix(in oklab,var(--ar-accent) 10%,transparent)}
.doc-run-src i svg{width:11px;height:11px}
.doc-run-src.is-empty{color:var(--muted-foreground,#888);font-style:italic}
.doc-run-file{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:12px;border:1px solid var(--border,rgba(127,127,127,.25))}
.doc-run-file>svg{width:16px;height:16px;color:var(--ar-accent)}
.doc-run-file i{font-style:normal;color:var(--muted-foreground,#888);font-size:11.5px;flex:1}
.doc-run-file button,.doc-run-more{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;
  border:1px solid var(--border,rgba(127,127,127,.3));background:transparent;color:inherit;cursor:pointer}
.doc-run-file button:hover,.doc-run-more:hover{background:color-mix(in oklab,var(--ar-accent) 10%,transparent)}
.doc-run-file button svg{width:12px;height:12px}
.doc-run-preview{padding:12px 14px;border-radius:12px;background:color-mix(in oklab,var(--foreground,#000) 3%,transparent);line-height:1.55;overflow:hidden}
.doc-run-preview.is-clamped{max-height:220px;-webkit-mask-image:linear-gradient(#000 70%,transparent);mask-image:linear-gradient(#000 70%,transparent)}
.doc-run-preview h1{font-size:1.15em;margin:.2em 0 .5em}.doc-run-preview h2{font-size:1.02em;margin:.9em 0 .3em}
.doc-run-preview table{border-collapse:collapse;font-size:12px}.doc-run-preview td,.doc-run-preview th{border:1px solid var(--border,rgba(127,127,127,.3));padding:3px 6px}
.doc-run-more{align-self:center}
@media (prefers-reduced-motion:reduce){.agent-run *,.agent-run{animation:none!important}}
`;
  document.head.appendChild(st);
}

function clockOf(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Carte de suivi d'un run d'agent, montée dans `bubble`.
 * @returns {{step(p:object):void, finish(ok:boolean|"escalated", report:string):void}}
 */
export function mountAgentRunCard(bubble, agent, task, uiLang) {
  ensureRunStyles();
  const s = L[lang(uiLang)];
  const card = document.createElement("div");
  card.className = "agent-run";
  card.dataset.state = "run";
  // L'avatar de l'agent (personnage Kenney) incarne la carte : il « travaille »
  // pendant le run, saute de joie à la réussite, secoue la tête à l'échec.
  preloadAvatar(agent);
  const accent = agentAvatarHTML(agent, { size: 40, state: "work", title: agent.name });
  card.innerHTML = `
    <div class="agent-run-head">
      <span class="agent-run-av">${accent}</span>
      <span class="agent-run-id"><b>${esc(agent.name)}</b><span title="${esc(task)}">${esc(task)}</span></span>
      <span class="agent-run-meta"><span class="agent-run-count"></span><span class="agent-run-clock">0s</span><span class="agent-run-pill">${esc(s.working)}</span></span>
    </div>
    <div class="agent-run-bar"><i></i></div>
    <ol class="agent-run-steps"><li class="agent-run-waiting">${esc(s.waiting)}</li></ol>`;
  // La couleur de l'avatar teinte toute la carte.
  const tint = card.querySelector(".ka")?.style.getPropertyValue("--ka-c");
  if (tint) card.style.setProperty("--ar-accent", tint);
  bubble.appendChild(card);
  const list = card.querySelector(".agent-run-steps");
  const clockEl = card.querySelector(".agent-run-clock");
  const countEl = card.querySelector(".agent-run-count");
  const pill = card.querySelector(".agent-run-pill");
  const t0 = Date.now();
  let n = 0;
  const tick = setInterval(() => { clockEl.textContent = clockOf(Date.now() - t0); }, 1000);
  const scroll = () => bubble.closest(".messages, #messages, .chat-messages")?.scrollTo?.({ top: 1e9, behavior: "smooth" });

  return {
    step(p) {
      const h = humanStep(p, uiLang);
      list.querySelector(".agent-run-waiting")?.remove();
      // Un raisonnement « en cours » précède l'outil qu'il annonce : l'étape
      // précédente perd son indicateur vivant dès qu'une nouvelle arrive.
      list.querySelectorAll(".is-live").forEach((li) => li.classList.remove("is-live"));
      const li = document.createElement("li");
      li.className = "agent-run-step";
      li.dataset.tone = h.tone;
      if (h.tone === "think") li.classList.add("is-live");
      const detail = h.detail
        ? `<details><summary>${esc(s.details)} · ${esc(h.raw)}</summary><pre>${esc(h.detail.slice(0, 2000))}</pre></details>`
        : "";
      const mark = h.tone === "think" ? "" : icon(h.tone === "fail" ? "x" : "check");
      li.innerHTML = `<span class="agent-run-ic">${icon(h.icon) || icon("bolt")}</span>
        <span class="agent-run-tx"><b>${esc(h.text)}</b>${detail}</span>
        <span class="agent-run-ok" title="${esc(h.tone === "think" ? "" : stepStatus(h.tone !== "fail", uiLang))}">${mark}</span>`;
      list.appendChild(li);
      // Déroulé borné : au-delà, les plus anciennes étapes s'effacent de la
      // carte (elles restent dans l'app Agents › Activité).
      const rows = list.querySelectorAll(".agent-run-step");
      if (rows.length > 14) rows[0].remove();
      if (h.tone !== "think") n += 1;
      countEl.textContent = n ? (n === 1 ? s.step1 : fmt(s.steps, { n })) : "";
      scroll();
    },
    finish(ok, report) {
      clearInterval(tick);
      clockEl.textContent = clockOf(Date.now() - t0);
      list.querySelectorAll(".is-live").forEach((li) => li.classList.remove("is-live"));
      list.querySelector(".agent-run-waiting")?.remove();
      const state = ok === true ? "ok" : "fail";
      card.dataset.state = state;
      pill.textContent = ok === "escalated" ? s.escalated : ok ? s.done : s.failed;
      const av = card.querySelector(".agent-run-av");
      setAvatarState(av, ok === true ? "done" : ok === "escalated" ? "idle" : "fail");
      if (ok === true) {
        const burst = document.createElement("span");
        burst.className = "agent-run-burst";
        av.appendChild(burst);
        setTimeout(() => burst.remove(), 800);
      }
      if (report) {
        const r = document.createElement("div");
        r.className = "agent-run-report";
        r.dataset.label = s.report;
        r.textContent = report;
        card.appendChild(r);
      }
      scroll();
    },
  };
}

/**
 * Exécute un outil `agent_*` : carte vivante dans `bubble`, résultat texte
 * pour le modèle.
 */
export async function callAgentTool(invoke, name, args, { bubble, lang: uiLang } = {}) {
  const agent = agentToolMap[name];
  if (!agent) return `Agent inconnu : ${name}`;
  const s = L[lang(uiLang)];
  const task = String(args?.task ?? args?.input ?? args?.prompt ?? args?.text ?? "").trim();
  if (!task) return "Échec : la tâche à confier est vide.";
  const card = bubble ? mountAgentRunCard(bubble, agent, task, uiLang) : null;
  const listen = window.__TAURI__?.event?.listen;
  const unlisten = [];
  let escalated = false;
  let success = null;   // posé par `agent-progress` (fin de run, succès vérifié)
  if (listen) {
    unlisten.push(await listen("agent-step", (e) => {
      if (e.payload?.agent_id === agent.id) card?.step(e.payload);
    }));
    unlisten.push(await listen("agent-progress", (e) => {
      if (e.payload?.agent_id === agent.id) success = e.payload?.success !== false;
    }));
    unlisten.push(await listen("agent-escalated", (e) => {
      if (e.payload?.agent_id === agent.id) escalated = true;
    }));
  }
  try {
    const report = String(await invoke("agent_delegate", { agent: agent.id, task }) || "");
    // `run_prompt` renvoie le texte du compte rendu ; le verdict vérifié vient
    // des évènements `agent-progress` / `agent-escalated` émis juste avant.
    const failed = escalated || success === false || (success == null && /^(Escalade|Erreur|Échec)/i.test(report));
    card?.finish(escalated ? "escalated" : !failed, report);
    // Sa voix pour la lecture de la réponse (auto ou bouton 🔊 de la bulle).
    if (agent.voice) {
      noteAgentVoice(agent.voice);
      if (bubble) bubble.dataset.agentVoice = agent.voice;
      // Lumen XR lit lui-même la réponse : il doit savoir quelle voix prendre.
      window.dispatchEvent(new CustomEvent("lumen-agent-voice", { detail: { voice: agent.voice, name: agent.name } }));
    }
    return fmt(s.result, { name: agent.name, ok: failed ? s.fail_suffix : "", report: report.slice(0, 4000) });
  } catch (e) {
    const msg = String(e?.message || e);
    card?.finish(false, msg);
    return `Échec de la délégation à « ${agent.name} » : ${msg}`;
  } finally {
    for (const u of unlisten) { try { u(); } catch {} }
  }
}
