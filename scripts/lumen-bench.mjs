#!/usr/bin/env node
// Banc d'essai IA de Lumen : vérifie, avec un VRAI modèle, que chaque usage de
// l'IA dans Lumen répond correctement. Un seul lancement, un rapport.
//
//   npm run bench                         # toutes les suites, modèle servi sur 11435
//   npm run bench -- --suites writing,apps
//   npm run bench -- --quick              # 1 cas par usage (≈ 5 min)
//   npm run bench:gate                    # garde-fou de version : échoue si un
//                                         # usage régresse par rapport au dernier
//                                         # rapport du MÊME modèle
//   LUMEN_EVAL_URL=http://127.0.0.1:11440/v1 LUMEN_EVAL_MODEL=… npm run bench
//   LUMEN_EVAL_URL=https://api.openai.com/v1 LUMEN_EVAL_KEY=… LUMEN_EVAL_MODEL=gpt-4o-mini npm run bench
//
// Suites :
//   coverage      tout appel LLM du code passe par un module de prompts (sans modèle)
//   prompts       les ~100 prompts du catalogue (src/lib/prompts-index.js) :
//                 apps, outils d'écriture, @mail/@doc, résumés, OCR, vision…
//                 (--only kanban,writing.proofread pour en cibler)
//   routers       routeurs JSON (LFM, commande vocale) + prompt global de Lumen
//   orchestrator  réponse orchestrée (banc historique, cases.json)
//   stress        9 niveaux de difficulté (stress.json)
//   long          conversations longues (long.json)
//   decisions     décisions typées de Tev1 (src/lib/decisions.js) — servir le
//                 GGUF Tev1 seul sur 11439 (LUMEN_DECISION_URL)
//   agents        agents réels de Lumen, via 127.0.0.1:8765/agent/run (Lumen ouvert)
//   living        délégation « @Agent » des documents, via /bench/delegate (Lumen ouvert)
//
// Les prompts ne sont JAMAIS recopiés ici : le banc importe les modules
// `prompts.js` des apps et construit les messages avec le même code qu'elles.
// Rapport : scripts/bench/reports/.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : dflt);
const flag = (name) => args.includes(`--${name}`);

const URL_ = (process.env.LUMEN_EVAL_URL || "http://127.0.0.1:11435/v1").replace(/\/$/, "");
const KEY = process.env.LUMEN_EVAL_KEY || "";
const LUMEN = opt("lumen", "http://127.0.0.1:8765");
const QUICK = flag("quick");
const ALL = ["coverage", "prompts", "routers", "orchestrator", "stress", "long", "decisions", "agents", "living"];
const SUITES = (opt("suites", ALL.join(","))).split(",").filter(Boolean);

// ------------------------------------------------------------ Environnement
// Modules de Lumen écrits pour la WebView : un décor minimal suffit à les importer.
const noop = () => {};
globalThis.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
globalThis.window ??= globalThis;
globalThis.addEventListener ??= noop;
globalThis.document ??= {
  addEventListener: noop, querySelector: () => null, head: { appendChild: noop }, body: { appendChild: noop },
  createElement: () => ({ style: {}, classList: { add: noop }, appendChild: noop, setAttribute: noop }),
};
const { stripThink } = await import("../src/lib/llm-stream.js");
const { matchesSchema } = await import("../src/lib/robust.js");
const parseLoose = (t) => { try { return JSON.parse(String(t).replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { const m = String(t).match(/[[{][\s\S]*[\]}]/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } } };
const { lfmSampling, isLfmModel, isLfmThinkingModel } = await import("../src/lib/lfm.js");

let MODEL = process.env.LUMEN_EVAL_MODEL || "";
async function detectModel() {
  if (MODEL) return MODEL;
  try {
    const r = await fetch(`${URL_}/models`, { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {} });
    const j = await r.json();
    MODEL = j.data?.[0]?.id || j.models?.[0]?.name || "";
  } catch { /* serveur absent : l'erreur viendra au premier appel */ }
  return MODEL;
}

/**
 * Un appel au modèle, avec les MÊMES réglages que l'app (src/llm.js) :
 * échantillonnage officiel des LFM, plafond des tâches courtes sur un modèle
 * « Thinking », délai de 3 minutes. Raisonnement retiré de la réponse.
 */
const THINKING_SHORT_TASK_TOKENS = 3072;
async function llm(messages, o = {}) {
  const body = { model: MODEL || undefined, messages, stream: false, ...(lfmSampling(MODEL) || { temperature: 0.1 }) };
  if (o.schema) body.response_format = { type: "json_schema", json_schema: { name: o.schemaName || "out", schema: o.schema, strict: false } };
  else if (o.json) body.response_format = { type: "json_object" };
  if (o.maxTokens) body.max_tokens = o.maxTokens;
  else if (isLfmThinkingModel(MODEL)) body.max_tokens = THINKING_SHORT_TASK_TOKENS;
  if (!isLfmModel(MODEL) && o.think === false) body.chat_template_kwargs = { enable_thinking: false };
  const t0 = performance.now();
  const r = await fetch(`${URL_}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const raw = d.choices?.[0]?.message?.content || "";
  const cut = d.choices?.[0]?.finish_reason === "length";
  return { text: stripThink(raw).trim(), raw, cut, ms: Math.round(performance.now() - t0), tokens: (d.usage?.prompt_tokens || 0) + (d.usage?.completion_tokens || 0) };
}

// ------------------------------------------------------------ Vérifications
const FR = /\b(le|la|les|des|est|et|une|pour|dans|avec|qui|que|sur|pas)\b/gi;
const EN = /\b(the|is|and|of|to|with|for|that|this|are|on|not|it)\b/gi;
const langOf = (t) => ((t.match(FR) || []).length >= (t.match(EN) || []).length ? "fr" : "en");

function verify(text, e = {}, extra = {}) {
  const checks = [];
  const c = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail });
  c("réponse non vide", text.trim().length > 0);
  // « m » : ^ et $ valent pour chaque ligne (une liste après une phrase d'intro).
  for (const re of e.re || []) c(`~ /${re}/`, new RegExp(re, "im").test(text), text.slice(0, 140));
  for (const re of e.not || []) c(`sans /${re}/`, !new RegExp(re, "im").test(text), text.slice(0, 140));
  if (e.lang) c(`langue ${e.lang}`, langOf(text) === e.lang, langOf(text));
  if (e.maxChars) c(`≤ ${e.maxChars} car.`, text.length <= e.maxChars, `${text.length}`);
  if (e.shorterThan) c("plus court que l'entrée", text.length < e.shorterThan, `${text.length} / ${e.shorterThan}`);
  if (e.json) {
    let j = null;
    try { j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { /* vérifié ci-dessous */ }
    c("JSON valide", j !== null, text.slice(0, 140));
    for (const k of e.keys || []) c(`clé « ${k} »`, j && k in j, j ? Object.keys(j).join(", ") : "");
    if (e.jsonCheck && j) for (const [name, fn] of Object.entries(e.jsonCheck)) c(name, fn(j), JSON.stringify(j).slice(0, 140));
  }
  for (const [name, ok] of Object.entries(extra)) c(name, ok);
  return checks;
}

// ------------------------------------------------------------ Suites
const results = [];
const skipped = [];
const abstentions = [];
function record(suite, id, usage, r) {
  const pass = r.checks.every((x) => x.ok);
  results.push({ suite, id, usage, kind: r.kind || "", pass, ms: r.ms || 0, tokens: r.tokens || 0, answer: (r.answer || "").slice(0, 1500), checks: r.checks, error: r.error || "" });
  const failed = r.checks.filter((x) => !x.ok).map((x) => x.name).join(" ; ");
  console.log(`${pass ? "✓" : "✗"} ${suite.padEnd(12)} ${id.padEnd(28)} ${String(r.ms || 0).padStart(6)} ms  ${failed}`);
  if (!pass && r.answer) console.log(`      ↳ ${String(r.answer).replace(/\s+/g, " ").slice(0, 160)}`);
}
async function probe(suite, id, usage, messages, expect, o = {}) {
  try {
    const r = await llm(messages, o);
    const checks = verify(r.text, expect);
    r.kind = o.kind;
    if (r.cut) checks.unshift({ name: "réponse complète (pas coupée par le plafond)", ok: !!r.text.trim(), detail: "raisonnement trop long" });
    record(suite, id, usage, { ...r, answer: r.text, checks });
  } catch (e) {
    record(suite, id, usage, { checks: [{ name: "appel au modèle", ok: false, detail: String(e.message || e) }], error: String(e.message || e) });
  }
}

// --- Réponse orchestrée : le banc existant, lancé par jeu de cas.
function orchSuite(suite, file) {
  const extra = QUICK ? ["--only", JSON.parse(fs.readFileSync(path.join(here, "orch-eval", file), "utf8")).slice(0, 3).map((c) => c.id).join(",")] : [];
  const out = spawnSync(process.execPath, [path.join(here, "orch-eval.mjs"), "--live", "--cases", file, ...extra], {
    encoding: "utf8", env: { ...process.env, LUMEN_EVAL_URL: URL_, LUMEN_EVAL_MODEL: MODEL }, maxBuffer: 1 << 26,
  });
  const reportPath = (out.stdout.match(/Rapport : (\S+)/) || [])[1];
  if (!reportPath) {
    record(suite, file, "orchestrateur", { checks: [{ name: "banc lancé", ok: false, detail: (out.stderr || out.stdout).slice(-300) }] });
    return;
  }
  const rep = JSON.parse(fs.readFileSync(path.resolve(root, reportPath), "utf8"));
  for (const c of rep.cases) {
    record(suite, c.id, "Réponse orchestrée", { ms: c.ms, tokens: (c.tokens?.prompt || 0) + (c.tokens?.gen || 0), answer: c.answer, checks: c.checks });
  }
}

// --- Prompts du catalogue : chaque usage IA des apps (src/lib/prompts-index.js).
// Les messages sont construits par le MÊME code que l'app (build), puis envoyés
// au modèle ; les cas de test vivent à côté du prompt (bench).
const VISION = process.env.LUMEN_EVAL_VISION ? process.env.LUMEN_EVAL_VISION === "1" : null;
const RED_SQUARE = fs.readFileSync(path.join(here, "bench", "red-square.b64"), "utf8").trim();
async function promptsSuite() {
  const { PROMPT_MODULES } = await import("../src/lib/prompts-index.js");
  const only = (opt("only", "") || "").split(",").filter(Boolean);
  const vision = VISION ?? /vl|vision|llava|gemma|gpt-4o|gpt-4\.1|gpt-5|claude|qwen.*vl|pixtral|minicpm/i.test(MODEL);
  for (const [mod, load] of Object.entries(PROMPT_MODULES)) {
    let PROMPTS;
    try { ({ PROMPTS } = await load()); } catch (e) {
      record("prompts", mod, "module", { checks: [{ name: "module importable", ok: false, detail: String(e.message || e).slice(0, 200) }] });
      continue;
    }
    for (const [id, p] of Object.entries(PROMPTS)) {
      if (only.length && !only.some((o) => id.includes(o) || mod === o)) continue;
      if (!p.bench?.length) { record("prompts", id, p.label, { checks: [{ name: "a au moins un cas de test", ok: false }] }); continue; }
      for (const [i, c] of (QUICK ? p.bench.slice(0, 1) : p.bench).entries()) {
        const name = p.bench.length > 1 ? `${id}#${i + 1}` : id;
        if (c.vision && !vision) { skipped.push(`${name} (vision)`); continue; }
        const vars = { ...c.vars };
        if (vars.image === "@red-square") vars.image = RED_SQUARE;
        const { messages, opts: o0 = {} } = p.build(vars);
        // Comme llmChat : le schéma déduit de l'exemple est imposé au serveur
        // (LUMEN_EVAL_NO_SCHEMA=1 pour mesurer l'ancien comportement).
        const enforce = o0.json && !o0.schema && messages.schema?.type && !process.env.LUMEN_EVAL_NO_SCHEMA;
        const opts = enforce ? { ...o0, schema: messages.schema } : o0;
        await probe("prompts", name, p.label, messages, c.expect, { ...opts, kind: p.kind });
      }
    }
  }
}

// --- Couverture : tout fichier qui appelle le LLM passe par un module de prompts.
// Exceptions motivées : le moteur lui-même et les conversations libres (le
// prompt y est celui de l'utilisateur ; couvertes par les suites orchestrator,
// stress et long).
const COVERAGE_EXEMPT = {
  "src/llm.js": "moteur d'appel",
  "src/lib/llm-stream.js": "moteur de flux",
  "src/lib/orchestrator.js": "suites orchestrator / stress / long",
  "src/lib/lfm.js": "suite routers",
  "src/lib/ai-sheet.js": "conversation libre (feuille IA)",
  "src/lib/ai-prompt.js": "conversation libre avec les outils de l'app",
  "src/lib/stream-view.js": "exemple en commentaire",
  "src/onboarding/main.js": "test de connexion au modèle",
  "src/onboarding/express.js": "test de connexion au modèle",
};
function coverageCheck() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name.startsWith("._") || ["vendor", "node_modules"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && !e.name.startsWith("__preview")) files.push(p);
    }
  };
  walk(path.join(root, "src"));
  const uses = /llmChat\(|"llm_api_request"|ollamaPostJson\(\s*"api\/chat"/;
  const covered = /from\s+"[^"]*(?:prompts|prompt-kit|core-prompts|doc-prompts|sheets-prompts)\.js"/;
  const missing = [];
  for (const f of files) {
    const rel = path.relative(root, f);
    const src = fs.readFileSync(f, "utf8");
    if (!uses.test(src) || covered.test(src) || COVERAGE_EXEMPT[rel]) continue;
    missing.push(rel);
  }
  record("coverage", "prompts-catalogue", "Couverture des usages IA", {
    answer: missing.join("\n"),
    checks: [{ name: "tous les appels LLM passent par un module de prompts", ok: !missing.length, detail: missing.join(", ") }],
  });
}

// --- Routeurs JSON : LFM (barre) et commande vocale.
async function routersSuite() {
  // Prompt système global de Lumen (barre, compagnon, bureau).
  const { buildLumenSystemPrompt } = await import("../src/lib/system-prompt.js");
  const core = String(buildLumenSystemPrompt({}) || "");
  await probe("routers", "core.identite", "Prompt global de Lumen", [{ role: "system", content: core }, { role: "user", content: "Qui es-tu, en une phrase ?" }], { re: ["Lumen"], lang: "fr" });
  await probe("routers", "core.anglais", "Prompt global de Lumen", [{ role: "system", content: core }, { role: "user", content: "What can you help me with? Two sentences." }], { lang: "en" });
  const { LFM_ROUTER_SYSTEM, LFM_ROUTER_SCHEMA, parseJsonDecision } = await import("../src/lib/lfm.js");
  const tools = "Outils : weather_now(place), create_reminder(text, when), web_search(query), mail_search(query).";
  const cases = [
    ["meteo", "Quel temps fait-il à Brest ?", (d) => d.execution === "tool" && /weather/.test(d.tool || "")],
    ["rappel", "Rappelle-moi d'arroser les plantes ce soir à 19h", (d) => d.execution === "tool" && /reminder/.test(d.tool || "")],
    ["bavardage", "Merci, bonne soirée !", (d) => d.execution !== "tool"],
    ["ambigu", "Fais-le.", (d) => d.execution === "clarify" || d.needs_clarification === true],
  ];
  for (const [id, q, ok] of QUICK ? cases.slice(0, 2) : cases) {
    try {
      const r = await llm([{ role: "system", content: `${LFM_ROUTER_SYSTEM}\n${tools}` }, { role: "user", content: q }], { schema: LFM_ROUTER_SCHEMA });
      let d = null;
      try { d = parseJsonDecision ? parseJsonDecision(r.text) : JSON.parse(r.text); } catch { /* vérifié ci-dessous */ }
      record("routers", `lfm.${id}`, "Routeur LFM", { ...r, answer: r.text, checks: [{ name: "JSON valide", ok: !!d, detail: r.text.slice(0, 140) }, { name: "bonne décision", ok: !!d && ok(d), detail: r.text.slice(0, 140) }] });
    } catch (e) {
      record("routers", `lfm.${id}`, "Routeur LFM", { checks: [{ name: "appel au modèle", ok: false, detail: e.message }] });
    }
  }
  const vc = await import("../src/lib/voice-commands.js");
  if (vc.VOICE_ROUTER_SCHEMA) {
    const actions = (vc.VOICE_ROUTER_ACTIONS || []).map((a) => (typeof a === "string" ? a : a.id || a.name)).filter(Boolean);
    const sys = `Tu convertis une phrase dite à voix haute en commande Lumen. Actions possibles : ${actions.join(", ")}. Réponds en JSON conforme au schéma.`;
    try {
      const r = await llm([{ role: "system", content: sys }, { role: "user", content: "ouvre l'application notes" }], { schema: vc.VOICE_ROUTER_SCHEMA });
      record("routers", "voix.ouvrir-notes", "Routeur vocal", { ...r, answer: r.text, checks: verify(r.text, { json: true, re: ["notes"] }) });
    } catch (e) {
      record("routers", "voix.ouvrir-notes", "Routeur vocal", { checks: [{ name: "appel au modèle", ok: false, detail: e.message }] });
    }
  }
}

// --- Décisions (Tev1, « système 1 ») : chaque décision du catalogue
// src/lib/decisions.js sur ses cas de test. Le GGUF Tev1 doit être servi seul
// (llama-server --port 11439) : un modèle à la fois sur une machine de 8 Go.
const DECISION_URL = process.env.LUMEN_DECISION_URL || "http://127.0.0.1:11439";
async function decisionsSuite() {
  const { DECISIONS, createDecider, httpTransport } = await import("../src/lib/decisions.js");
  const { TOOL_SPECS } = await import("./orch-eval/tools.mjs");
  const tools = TOOL_SPECS.filter((t) => t.function.name !== "ask_user").map((t) => ({ name: t.function.name, description: t.function.description }));
  try { await fetch(`${DECISION_URL}/health`, { signal: AbortSignal.timeout(3000) }); } catch {
    record("decisions", "moteur", "Tev1", { checks: [{ name: `Tev1 servi sur ${DECISION_URL}`, ok: false }] });
    return;
  }
  // Seuils de l'app : une abstention (confiance trop basse) est SÛRE — l'app
  // garde alors son comportement d'avant ; seule une réponse fausse ET assurée
  // est une erreur.
  const decider = createDecider(httpTransport(DECISION_URL));
  for (const [name, d] of Object.entries(DECISIONS)) {
    for (const [i, c] of (d.bench || []).entries()) {
      const vars = { ...c.vars };
      if (vars.tools === "@tools") vars.tools = tools;
      const t0 = performance.now();
      const r = await decider.decide(name, vars);
      const got = r?.value;
      const want = Array.isArray(c.expect) ? c.expect : [c.expect];
      const abstained = r == null;
      const ok = abstained || want.some((w) => String(w) === String(got));
      if (abstained) abstentions.push(`${name}#${i + 1}`);
      record("decisions", `${name}#${i + 1}`, d.label, {
        ms: Math.round(performance.now() - t0),
        answer: abstained ? "abstention (confiance trop basse)" : `${String(got)} (confiance ${r?.confidence == null ? "?" : r.confidence.toFixed(2)})`,
        checks: [{ name: `attendu ${want.join(" ou ")}`, ok, detail: abstained ? "abstention" : String(got) }],
      });
    }
  }
}

// --- Lumen en marche : agents et documents vivants.
async function lumenUp() {
  try { await fetch(`${LUMEN}/agent/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); return true; } catch { return false; }
}
async function lumenPost(route, payload) {
  const t0 = performance.now();
  const r = await fetch(`${LUMEN}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { status: r.status, text: stripThink(await r.text()).trim(), ms: Math.round(performance.now() - t0) };
}
function benchAgents() {
  // --agents id1,id2 ; sinon tous les agents du profil (lecture seule).
  const wanted = (opt("agents", "") || "").split(",").filter(Boolean);
  if (wanted.length) return wanted;
  try {
    const home = process.env.HOME;
    const file = path.join(home, "Library/Application Support/com.lumen.app/agents.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).map((a) => a.id);
  } catch { return []; }
}
async function agentsSuite() {
  if (!(await lumenUp())) { record("agents", "lumen", "Agents", { checks: [{ name: "Lumen ouvert (127.0.0.1:8765)", ok: false }] }); return; }
  const ids = benchAgents().slice(0, QUICK ? 1 : 3);
  const tasks = [
    ["calcul", "Combien font 12 × 15 ? Réponds juste avec le résultat. Ne crée ni ne modifie aucun fichier.", { re: ["180"], not: ["<think>", "Okay, let", "^\\{"] }],
    ["redaction", "Écris une phrase sur l'automne. Ne crée ni ne modifie aucun fichier.", { lang: "fr", not: ["<think>", "Okay, let", "^\\{"] }],
  ];
  for (const id of ids) {
    for (const [tid, prompt, expect] of QUICK ? tasks.slice(0, 1) : tasks) {
      const r = await lumenPost("/agent/run", { agent: id, prompt });
      record("agents", `${id.replace(/-\d+$/, "")}.${tid}`, "Agent (tâche)", { ...r, answer: r.text, checks: [{ name: "HTTP 200", ok: r.status === 200, detail: `${r.status} ${r.text.slice(0, 120)}` }, ...verify(r.text, expect)] });
    }
  }
  // Deux agents en même temps : aucune tâche ne doit se perdre.
  if (ids.length >= 2 && !QUICK) {
    const [a, b] = await Promise.all(ids.slice(0, 2).map((id) => lumenPost("/agent/run", { agent: id, prompt: "Réponds seulement OK. Ne crée aucun fichier." })));
    record("agents", "parallele", "Deux agents simultanés", { ms: Math.max(a.ms, b.ms), answer: `${a.status} ${a.text.slice(0, 80)} | ${b.status} ${b.text.slice(0, 80)}`, checks: [{ name: "1er agent HTTP 200", ok: a.status === 200, detail: a.text.slice(0, 120) }, { name: "2e agent HTTP 200", ok: b.status === 200, detail: b.text.slice(0, 120) }] });
  }
}
async function livingSuite() {
  if (!(await lumenUp())) { record("living", "lumen", "Documents vivants", { checks: [{ name: "Lumen ouvert (127.0.0.1:8765)", ok: false }] }); return; }
  const agent = opt("doc-agent", benchAgents()[0]);
  // Comme dans Notes : le document grandit à chaque délégation, la réponse va à ⟦ICI⟧.
  let doc = "Dates : du 12 au 16 octobre.\nBudget : 900 €.\n\n";
  const steps = [
    ["liste", "Fais une liste de 5 choses à visiter à Lisbonne.", { re: ["^\\s*([-*•]|\\d+[.)])"] }],
    ["budget", "Ajoute un budget par jour sous forme de tableau.", { re: ["\\|"] }],
    ["resume", "Résume tout ce qui précède en 3 lignes.", { lang: "fr", re: ["900|Lisbonne|octobre"] }],
    ["suite", "Ajoute 2 conseils pratiques.", { lang: "fr" }],
  ];
  for (const [id, request, expect] of QUICK ? steps.slice(0, 2) : steps) {
    const r = await lumenPost("/bench/delegate", { agent, request, title: "Voyage à Lisbonne", context: `${doc}⟦ICI⟧`, format: id === "budget" ? "text" : "text" });
    if (r.status === 404) { record("living", id, "Délégation @Agent", { checks: [{ name: "route /bench/delegate (recompiler Lumen)", ok: false }] }); return; }
    record("living", `${agent.replace(/-\d+$/, "")}.${id}`, "Délégation @Agent", { ...r, answer: r.text, checks: [{ name: "HTTP 200", ok: r.status === 200, detail: `${r.status} ${r.text.slice(0, 160)}` }, ...verify(r.status === 200 ? r.text : "", { ...expect, not: [...(expect.not || []), "^:::", "<think>", "⟦ICI⟧"] })] });
    if (r.status === 200) doc += `:::agent Bench\n${r.text}\n:::\n\n`;
  }
}

// ------------------------------------------------------------ Lancement
await detectModel();
console.log(`Banc IA de Lumen — modèle « ${MODEL || "?"} » @ ${URL_}${QUICK ? " — rapide" : ""}\nSuites : ${SUITES.join(", ")}\n`);
const t0 = Date.now();
for (const s of SUITES) {
  if (s === "orchestrator") orchSuite(s, "cases.json");
  else if (s === "stress") orchSuite(s, "stress.json");
  else if (s === "long") orchSuite(s, "long.json");
  else if (s === "coverage") coverageCheck();
  else if (s === "prompts") await promptsSuite();
  else if (s === "decisions") await decisionsSuite();
  else if (s === "routers") await routersSuite();
  else if (s === "agents") await agentsSuite();
  else if (s === "living") await livingSuite();
  else console.log(`Suite inconnue : ${s}`);
}

// ------------------------------------------------------------ Rapport
const dir = path.join(here, "bench", "reports");
fs.mkdirSync(dir, { recursive: true });
// Référence : le dernier rapport du MÊME modèle (comparer un 1.2B à un 3B ne
// dit rien d'une régression de prompt).
const readReport = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
const previous = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse()
  .find((f) => readReport(f)?.model === MODEL) || null;
const prev = previous ? readReport(previous) : null;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const bySuite = {};
for (const r of results) {
  bySuite[r.suite] ??= { pass: 0, total: 0 };
  bySuite[r.suite].total++;
  if (r.pass) bySuite[r.suite].pass++;
}
// Score par TYPE D'USAGE (transform, json, summary…) : une baisse localisée
// se voit même quand le total bouge peu.
const byKind = {};
for (const r of results) {
  const k = r.kind || r.suite;
  byKind[k] ??= { pass: 0, total: 0 };
  byKind[k].total++;
  if (r.pass) byKind[k].pass++;
}
const regressions = prev ? results.filter((r) => !r.pass && prev.results.some((p) => p.suite === r.suite && p.id === r.id && p.pass)).map((r) => `${r.suite}/${r.id}`) : [];
const report = { date: new Date().toISOString(), model: MODEL, url: URL_, quick: QUICK, secs: Math.round((Date.now() - t0) / 1000), bySuite, byKind, regressions, previous, results };
const jsonPath = path.join(dir, `bench-${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(dir, `bench-${stamp}.html`), htmlReport(report));

const total = results.filter((r) => r.pass).length;
console.log(`\n${total}/${results.length} réussis en ${report.secs} s`);
for (const [s, v] of Object.entries(bySuite)) console.log(`  ${s.padEnd(13)} ${v.pass}/${v.total}`);
if (abstentions.length) console.log(`\nAbstentions (sûres : l'app garde son comportement d'avant) : ${abstentions.join(", ")}`);
if (skipped.length) console.log(`\nIgnorés (modèle sans vision ; LUMEN_EVAL_VISION=1 pour forcer) : ${skipped.join(", ")}`);
if (regressions.length) console.log(`\nRégressions depuis ${previous} : ${regressions.join(", ")}`);
// Baisse de score par type d'usage (cas communs aux deux rapports seulement).
const kindDrops = [];
if (prev?.byKind) for (const [k, v] of Object.entries(byKind)) {
  const p = prev.byKind[k];
  if (p && p.total === v.total && v.pass < p.pass) kindDrops.push(`${k} ${p.pass}→${v.pass}/${v.total}`);
}
if (kindDrops.length) console.log(`Baisse par type d'usage : ${kindDrops.join(", ")}`);
if (flag("gate")) {
  const ok = !regressions.length && !kindDrops.length;
  console.log(ok ? `\nGarde-fou : OK${prev ? ` (référence ${previous})` : " (premier rapport de ce modèle : il devient la référence)"}` : "\nGarde-fou : ÉCHEC — corriger avant de publier.");
}
console.log(`\nRapport : ${path.relative(root, jsonPath)} (+ .html)`);
process.exitCode = flag("gate") ? (regressions.length || kindDrops.length ? 1 : 0) : total === results.length ? 0 : 1;

function htmlReport(rep) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = rep.results.map((r) => `<tr class="${r.pass ? "ok" : "ko"}"><td>${r.pass ? "✓" : "✗"}</td><td>${esc(r.suite)}</td><td>${esc(r.id)}</td><td>${esc(r.usage)}</td><td>${r.ms}</td><td>${r.checks.filter((c) => !c.ok).map((c) => `<div>${esc(c.name)} <small>${esc(c.detail)}</small></div>`).join("")}</td><td><details><summary>réponse</summary><pre>${esc(r.answer)}</pre></details></td></tr>`).join("");
  const suites = Object.entries(rep.bySuite).map(([s, v]) => `<li><b>${esc(s)}</b> ${v.pass}/${v.total}</li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Banc IA Lumen</title><style>body{font:14px system-ui;margin:24px;color:#222}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:6px;vertical-align:top}tr.ko td:first-child{color:#c00}tr.ok td:first-child{color:#080}pre{white-space:pre-wrap;max-width:520px}small{color:#777}ul{display:flex;gap:18px;list-style:none;padding:0}</style>
<h1>Banc IA de Lumen</h1><p>${esc(rep.date)} — modèle <b>${esc(rep.model)}</b> — ${rep.secs} s${rep.regressions.length ? ` — <b style="color:#c00">régressions : ${esc(rep.regressions.join(", "))}</b>` : ""}</p><ul>${suites}</ul>
<table><tr><th></th><th>Suite</th><th>Cas</th><th>Usage</th><th>ms</th><th>Échecs</th><th></th></tr>${rows}</table>`;
}
