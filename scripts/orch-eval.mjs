#!/usr/bin/env node
// Banc d'évaluation de la réponse orchestrée (src/lib/orchestrator.js).
//
// Rejoue une série de questions types contre le VRAI moteur d'orchestration,
// avec des outils simulés, et mesure pour chacune : outils appelés (attendus /
// interdits), contenu de la réponse, sources citées, durée, jetons.
//
//   node scripts/orch-eval.mjs                     # modèle scripté (logique du harnais, déterministe)
//   node scripts/orch-eval.mjs --live              # vrai modèle, API OpenAI-compatible
//        LUMEN_EVAL_URL=http://127.0.0.1:11435/v1  (llama-server de Lumen, défaut)
//        LUMEN_EVAL_MODEL=LFM2.5-1.2B-Instruct     LUMEN_EVAL_KEY=… (API cloud)
//        LUMEN_EVAL_FAST_MODEL=…                   (modèle rapide des décisions)
//   node scripts/orch-eval.mjs --only meteo,agenda # quelques cas seulement
//   node scripts/orch-eval.mjs --live --replay traces.json
//        # rejoue des réponses réelles exportées depuis Lumen : copy(lumenTraces())
//
// Rapport JSON : scripts/orch-eval/report-<date>.json (comparer deux modèles,
// ou avant/après une modification du harnais).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOrchestrated, clearToolCache } from "../src/lib/orchestrator.js";
import { TOOL_SPECS } from "./orch-eval/tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const live = args.includes("--live");
const only = (args[args.indexOf("--only") + 1] || "").split(",").filter((x) => args.includes("--only") && x);
const replayFile = args.includes("--replay") ? args[args.indexOf("--replay") + 1] : null;
// Autre jeu de cas (ex. --cases stress.json : épreuve multi-niveaux, mode --live).
const casesFile = args.includes("--cases") ? args[args.indexOf("--cases") + 1] : "cases.json";

// ---------------------------------------------------------------- Outils simulés
const _data_search_default = (query) => `• Sommeil de la dernière nuit\n  mesure (santé, compteur…) · iphone  [id coffre:sante/sommeil_h]\n  8.3 h · avant : 6.9 h (ven. 25/09/2026 07:10)\n(recherche : ${query || ""})`;
const DEFAULT_RESULTS = {
  weather_now: ({ place }) => `Météo à ${place || "Paris"} : 17 °C, averses l'après-midi, vent 20 km/h. Demain : 21 °C, ensoleillé.`,
  app_data: ({ app }) => app === "kanban"
    ? "Kanban « Projet Lumen » : En cours : « Notarisation macOS » (échéance demain), « App iOS ». À faire : « Traduction XR »."
    : "Agenda : 10:00 Réunion équipe (visio) ; 14:30 Dentiste ; 18:00 Sport.",
  day_overview: () => "Aujourd'hui : 10:00 Réunion équipe ; 14:30 Dentiste. Rappels en retard : appeler la banque. 3 mails non lus dont 1 de Claire.",
  sandbox_search: ({ query }) => `2 fichiers trouvés pour « ${query} » : Documents/CV_2026.pdf (compétences : Rust, Swift, IA locale), Documents/Lettre_motivation.docx.`,
  search_documents: () => "Erreur : index du Corpus indisponible (timeout)",
  search_personal_data: ({ query }) => `Données personnelles pour « ${query} » : CV_2026.pdf mentionne Rust, Swift et IA embarquée.`,
  web_search: ({ query }) => `Résultats web pour « ${query} » : 1) Apple publie macOS 27 le 15 septembre 2026. 2) Nouveautés : Foundation Models étendus.`,
  mail_search: () => "Mail de Claire (hier) : « On décale la réunion à jeudi 10 h ? »",
  memory_remember: () => "Mémorisé.",
  create_reminder: ({ text, when }) => `Rappel créé : « ${text} » (${when || "dans 1 h"}).`,
  ask_user: () => "L'utilisateur répond : le plus récent.",
  data_search: ({ query, type }) => type === "image" || /photo|image/.test(query || "")
    ? "• salon.jpg\n  image · fichiers · tags : Maison, Photos, jpg  [id fichiers:sb1:Photos/salon.jpg]\n  fichier JPG de 2.1 Mo dans la sandbox « Maison »\n  lien : ![salon.jpg](lumenmedia://localhost/sb1/Photos/salon.jpg)"
    : /devis|pdf/.test(query || "") ? "• Devis_cuisine.pdf\n  document · fichiers  [id fichiers:sb1:Docs/Devis_cuisine.pdf]\n  Devis n° 42 — cuisine équipée, total 8 450 € TTC…\n  lien : [Devis_cuisine.pdf](lumenmedia://localhost/sb1/Docs/Devis_cuisine.pdf)"
    : _data_search_default(query),
  long_report: () => Array.from({ length: 400 }, (_, i) => i === 257 ? "Ligne 258 : le budget validé du projet Orion est de 48 500 €." : `Ligne ${i + 1} : paragraphe de remplissage sans rapport avec la question, répété pour grossir le document.`).join("\n"),
  data_get: () => "• salon.jpg\n  image · fichiers · tags : Maison  [id fichiers:sb1:Photos/salon.jpg]\n  lien : ![salon.jpg](lumenmedia://localhost/sb1/Photos/salon.jpg)",
  data_metrics: () => "• Sommeil de la dernière nuit\n  mesure (santé, compteur…) · iphone  [id coffre:sante/sommeil_h]\n  8.3 h · avant : 6.9 h (ven. 25/09/2026 07:10)\n• Pas aujourd'hui\n  mesure · iphone  [id coffre:sante/pas]\n  3922 pas\n(dernière mise à jour : sam. 26/09/2026 18:42)",
  data_agenda: () => "Planning sam. 26/09/2026 → ven. 02/10/2026\n• Anniversaire de Magalie — jeu. 01/10/2026\n  évènement · iphone · tags : Anniversaires, journée entière  [id coffre:agenda/iphone:0]\n• Dentiste — lun. 28/09/2026 14:30\n  évènement · agenda  [id agenda:x1]",
  vault_list: () => "- sante/sommeil_h = 8.3\n- agenda/iphone : liste de 1 éléments (détail : data_search / data_agenda)",
};

// -------------------------------------------------------------------- Cas
function loadCases() {
  if (replayFile) {
    // Traces exportées depuis Lumen (lib/orchestrator-host.js) : la question,
    // et les outils réellement utilisés comme attendus.
    const traces = JSON.parse(fs.readFileSync(replayFile, "utf8"));
    return traces.map((t, i) => ({ id: `replay-${i + 1}`, query: t.query, expect: { tools: [...new Set(t.tools.map((x) => x.name))] } }));
  }
  const cases = JSON.parse(fs.readFileSync(path.join(here, "orch-eval", casesFile), "utf8"));
  return only.length ? cases.filter((c) => only.includes(c.id)) : cases;
}

// ------------------------------------------------------ Modèle scripté
// Joue un scénario écrit dans le cas (`script`) : teste la LOGIQUE du harnais
// (routage, parallélisme, cache, reprise, citations) indépendamment du modèle.
function scriptedChat(c) {
  let toolRound = 0;
  return async (messages, opts = {}) => {
    const step = (opts.schemaName || "").replace("lumen_", "");
    const s = c.script || {};
    let content = "";
    let message = {};
    if (step === "analyze") content = JSON.stringify(s.analyze || { intent: c.query, needs_tools: !!(s.calls || []).length, needs_data: !!(s.calls || []).length, complexity: "moderate", subquestions: [] });
    else if (step === "route") content = JSON.stringify({ categories: s.categories || [], reason: "scénario" });
    else if (step === "pick") content = JSON.stringify(s.pick || {});
    else if (step === "fill") content = JSON.stringify(s.fill || {});
    else if (step === "split") content = JSON.stringify({ subquestions: s.split || [] });
    else if (/sous-question|sub-question/.test(messages[0]?.content || "")) content = s.step || "Étape résolue.";
    else if (step === "verify") content = JSON.stringify(s.verify || { grounded: true, complete: true, issues: [] });
    else if (/^Condense/.test(messages[0]?.content || "")) content = s.compact || "Faits condensés.";
    else if (opts.tools) {
      const round = (s.calls || [])[toolRound++];
      message = round ? { role: "assistant", content: "", tool_calls: round.map((call, i) => ({ id: `c${toolRound}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args || {}) } })) } : { role: "assistant", content: "PRÊT" };
      content = message.content;
    } else content = s.answer || "Réponse.";
    const usage = { prompt_tokens: JSON.stringify(messages).length / 4 | 0, completion_tokens: content.length / 4 | 0 };
    opts.onUpdate?.({ answer: opts.tools || opts.json ? "" : content, tools: [], reasoning: "" });
    return { content, data: { choices: [{ message: { ...message, content } }], usage } };
  };
}

// ------------------------------------------------------ Vrai modèle
const URL_ = (process.env.LUMEN_EVAL_URL || "http://127.0.0.1:11435/v1").replace(/\/$/, "");
const MODEL = process.env.LUMEN_EVAL_MODEL || "";
function liveChat() {
  return async (messages, opts = {}) => {
    const body = {
      model: opts.backend?.model || MODEL,
      messages: messages.map((m) => ({ role: m.role, content: m.content ?? "", ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}), ...(m.name && m.role === "tool" ? { name: m.name } : {}) })),
      stream: false,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.tools) { body.tools = opts.tools; if (opts.tool_choice) body.tool_choice = opts.tool_choice; }
    if (opts.schema) body.response_format = { type: "json_schema", json_schema: { name: opts.schemaName || "out", schema: opts.schema, strict: false } };
    else if (opts.json) body.response_format = { type: "json_object" };
    const res = await fetch(`${URL_}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.LUMEN_EVAL_KEY ? { Authorization: `Bearer ${process.env.LUMEN_EVAL_KEY}` } : {}) },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    opts.onUpdate?.({ answer: opts.tools || opts.json ? "" : msg.content || "", tools: msg.tool_calls || [], reasoning: msg.reasoning_content || "" });
    return { content: msg.content || "", data };
  };
}

// ------------------------------------------------- Système 1 (Tev1)
// Cas avec `decider` : décisions SIMULÉES (nom → valeur), pour tester le
// câblage de l'orchestrateur sans charger un 2e modèle. Avec
// LUMEN_DECISION_URL (et --live), les vraies décisions de Tev1 sont prises.
const { createDecider, httpTransport } = await import("../src/lib/decisions.js");
const LIVE_DECIDER = live && process.env.LUMEN_DECISION_URL ? createDecider(httpTransport(process.env.LUMEN_DECISION_URL)) : null;
function deciderFor(c) {
  if (LIVE_DECIDER) return LIVE_DECIDER;
  if (!c.decider) return null;
  const LEVELS = { trivial: 0, simple: 1, moderate: 2, complex: 3, low: 0, normal: 1, medium: 1, high: 2, urgent: 2 };
  return {
    async decide(name) {
      if (!(name in c.decider)) return null;
      const value = c.decider[name];
      return { value, confidence: 0.9, ...(typeof value === "string" && value in LEVELS ? { level: LEVELS[value] } : {}) };
    },
  };
}

// ------------------------------------------------------ Hôte factice
function stubView() {
  return { update() {}, toolResult() {}, nextTurn() {}, finish() {} };
}
function stubPlan() {
  const steps = [];
  const api = {
    start(id, label) { steps.push({ id, label, status: "running", notes: [] }); },
    done(id, status, detail, notes) { const s = steps.findLast((x) => x.id === id); if (s) Object.assign(s, { status, detail, notes: [...s.notes, ...(notes || [])] }); },
    skip(id, label, why) { steps.push({ id, label, status: "skipped", detail: why }); },
    note(id, text) { steps.findLast((x) => x.id === id)?.notes.push(text); },
    wait() {}, tool() {}, hold() {}, release() {}, finish() {}, fail(t) { steps.push({ id: "fail", detail: t }); },
    count() { return steps.length; },
    snapshot() { return { steps }; },
  };
  return api;
}

// ------------------------------------------------------ Exécution d'un cas
async function runCase(c) {
  clearToolCache();
  const results = { ...DEFAULT_RESULTS, ...Object.fromEntries(Object.entries(c.tools || {}).map(([k, v]) => [k, () => v])) };
  const calls = [];
  const tokens = { prompt: 0, gen: 0 };
  const t0 = performance.now();
  let out, error = null;
  // Taille du plus gros prompt envoyé (messages + schémas d'outils), en jetons estimés.
  let maxPrompt = 0;
  const baseChat = live ? liveChat() : scriptedChat(c);
  const chat = (messages, opts = {}) => {
    maxPrompt = Math.max(maxPrompt, Math.ceil(JSON.stringify([messages, opts.tools || []]).length / 3.2));
    return baseChat(messages, opts);
  };
  const plan = stubPlan();
  try {
    out = await runOrchestrated({
      answerCache: false, // chaque cas doit faire tout le parcours
      query: c.query, history: c.history || [], tools: TOOL_SPECS, lang: c.lang || "fr",
      chat,
      model: c.model || "",
      backend: live ? { model: MODEL } : undefined,
      fastBackend: live && process.env.LUMEN_EVAL_FAST_MODEL ? { model: process.env.LUMEN_EVAL_FAST_MODEL } : null,
      execTool: async (name, a) => {
        calls.push({ name, args: a, at: Math.round(performance.now() - t0) });
        if (c.slowTools?.[name]) await new Promise((r) => setTimeout(r, c.slowTools[name]));
        return (results[name] || (() => `Erreur : outil inconnu ${name}`))(a || {});
      },
      view: stubView(), plan,
      decider: deciderFor(c),
      onUsage: (data) => { tokens.prompt += data?.usage?.prompt_tokens || 0; tokens.gen += data?.usage?.completion_tokens || 0; },
      limits: live ? { ...(c.limits || {}) } : { heartbeatMs: 1e9, ...(c.limits || {}) },
    });
  } catch (e) { error = String(e?.message || e); }
  const ms = Math.round(performance.now() - t0);
  const called = [...new Set(calls.map((x) => x.name))];
  const e = c.expect || {};
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok, detail });
  check("sans erreur", !error, error || "");
  for (const t of e.tools || []) check(`appelle ${t}`, called.includes(t), called.join(", "));
  for (const t of e.notTools || []) check(`n'appelle pas ${t}`, !called.includes(t));
  if (e.noTools) check("aucun outil", !called.length, called.join(", "));
  for (const re of e.answer || []) check(`réponse ~ /${re}/`, new RegExp(re, "i").test(out?.text || ""), (out?.text || "").slice(0, 120));
  for (const re of e.answerNot || []) check(`réponse sans /${re}/`, !new RegExp(re, "i").test(out?.text || ""), (out?.text || "").slice(0, 120));
  if (e.cites) check("cite ses sources", (out?.sources || []).length > 0);
  for (const k of e.trace || []) check(`trace ${k}`, (out?.trace || []).some((t) => t.kind === k), (out?.trace || []).map((t) => t.kind).join(", "));
  for (const re of e.notes || []) check(`note ~ /${re}/`, plan.snapshot().steps.some((x) => (x.notes || []).some((n) => new RegExp(re, "i").test(n))), plan.snapshot().steps.flatMap((x) => x.notes || []).join(" | ").slice(0, 200));
  for (const id of e.steps || []) check(`étape ${id}`, plan.snapshot().steps.some((x) => x.id === id && x.status !== "skipped"), plan.snapshot().steps.map((x) => x.id).join(", "));
  for (const id of e.notSteps || []) check(`pas d'étape ${id}`, !plan.snapshot().steps.some((x) => x.id === id && x.status !== "skipped"), plan.snapshot().steps.map((x) => x.id).join(", "));
  if (e.maxPromptTokens) check(`prompt ≤ ${e.maxPromptTokens} jetons`, maxPrompt <= e.maxPromptTokens, `${maxPrompt}`);
  if (e.parallel) {
    // Deux lectures du même tour démarrées quasi ensemble.
    const firsts = calls.slice(0, 2);
    check("outils en parallèle", firsts.length === 2 && Math.abs(firsts[0].at - firsts[1].at) < 50, firsts.map((x) => x.at).join(" / "));
  }
  if (e.maxMs && live) check(`< ${e.maxMs} ms`, ms < e.maxMs, `${ms} ms`);
  return { id: c.id, query: c.query, ms, tokens, called, sources: out?.sources?.length || 0, answer: out?.text || "", checks, pass: checks.every((x) => x.ok), trace: out?.trace };
}

// ------------------------------------------------------ Main
const cases = loadCases();
console.log(`Banc d'orchestration — ${cases.length} cas — ${live ? `modèle ${MODEL || "(par défaut)"} @ ${URL_}` : "modèle scripté"}\n`);
const report = [];
for (const c of cases) {
  const r = await runCase(c);
  report.push(r);
  const mark = r.pass ? "✓" : "✗";
  console.log(`${mark} ${c.id.padEnd(22)} ${String(r.ms).padStart(6)} ms  ${String(r.tokens.prompt + r.tokens.gen).padStart(6)} jetons  outils: ${r.called.join(", ") || "—"}`);
  for (const k of r.checks.filter((x) => !x.ok)) console.log(`    ✗ ${k.name}${k.detail ? ` (${k.detail})` : ""}`);
}
const passed = report.filter((r) => r.pass).length;
const totalMs = report.reduce((a, r) => a + r.ms, 0);
const totalTok = report.reduce((a, r) => a + r.tokens.prompt + r.tokens.gen, 0);
console.log(`\n${passed}/${report.length} réussis · ${(totalMs / 1000).toFixed(1)} s · ${totalTok} jetons`);
const dir = path.join(here, "orch-eval");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `report-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}${live ? "-live" : ""}.json`);
fs.writeFileSync(file, JSON.stringify({ live, model: MODEL, url: live ? URL_ : null, passed, total: report.length, totalMs, totalTok, cases: report }, null, 2));
console.log(`Rapport : ${path.relative(process.cwd(), file)}`);
process.exit(passed === report.length ? 0 : 1);
