import { canOverrideModel } from "./agent-policy.js";
// Réglages et journal communs aux hôtes de la réponse orchestrée (barre et
// bureau) — voir lib/orchestrator.js.

const TRACE_KEY = "orchestratorTraces";
const TRACE_MAX = 30;

/// Modèle rapide pour les étapes de décision (analyse, routage, choix d'outil,
/// reprise sur le modèle principal en cas d’échec) : clé `orchestratorFastModel` (Réglages). Même backend que la
/// discussion, autre modèle — p. ex. LFM2.5-350M pour décider, un 8B pour écrire.
export function fastBackendFor(backend, store = globalThis.localStorage) {
  let model = "";
  try { model = store?.getItem("orchestratorFastModel")?.trim() || ""; } catch { /* rien */ }
  if (!model || !canOverrideModel(backend) || model === backend.model) return null;
  return { ...backend, model };
}

/// Instantané du backend PRINCIPAL pour l'orchestrateur : modèle, source et
/// fenêtre de contexte réelle quand on la connaît (llama.cpp : réglage
/// « contexte » ; Ollama : num_ctx s'il est forcé). Les deux hôtes (barre et
/// bureau) passent par ici : le profil Apple (4 096 jetons) ou celui d'un petit
/// modèle ne dépend plus de l'endroit d'où part la question.
export function mainBackendSnapshot(backend, store = globalThis.localStorage) {
  const get = (k) => { try { return store?.getItem(k) || ""; } catch { return ""; } };
  const source = backend?.applefm ? "applefm"
    : backend?.llama ? "llama"
    : backend?.lumen ? "lumen"
    : backend?.litert ? "litert"
    : backend?.api ? "api"
    : "ollama";
  let contextTokens = 0;
  if (source === "llama") contextTokens = Number(get("llamaNumCtx")) || 8192;
  else if (source === "ollama") contextTokens = Number(get("ollamaNumCtx")) || 0;
  else if (source === "applefm") contextTokens = 4096;
  return { model: backend?.model || "", source, contextTokens };
}

/// Garde la trace (30 dernières, pour rejouer une réponse ratée dans le banc
/// d'évaluation : scripts/orch-eval.mjs --replay) et l'inscrit au Journal LLM.
export function recordOrchestration(invoke, query, out, model = "") {
  const entry = { at: new Date().toISOString(), query, model, text: out.text, sources: out.sources || [], tools: (out.toolNotes || []).map((n) => ({ name: n.name, args: n.args })), trace: out.trace || [] };
  try {
    const list = JSON.parse(localStorage.getItem(TRACE_KEY) || "[]");
    list.push(entry);
    localStorage.setItem(TRACE_KEY, JSON.stringify(list.slice(-TRACE_MAX)));
  } catch { /* stockage plein : la trace n'est qu'un bonus */ }
  const last = (out.trace || []).at(-1);
  const detail = `${query.slice(0, 90)} — ${entry.tools.length} outil(s)${entry.tools.length ? ` (${entry.tools.map((t) => t.name).join(", ")})` : ""}, ${last?.secs ?? "?"} s, ${entry.sources.length} source(s)`;
  invoke?.("llm_log_push", { kind: "orchestration", source: "Réponse orchestrée", sourceId: "orchestrator", model, detail, success: out.success ?? !!out.text }).catch?.(() => {});
}

/// Traces gardées, pour la console ou l'export (`copy(lumenTraces())`).
export function orchestrationTraces() {
  try { return JSON.parse(localStorage.getItem(TRACE_KEY) || "[]"); } catch { return []; }
}
if (typeof window !== "undefined") window.lumenTraces = orchestrationTraces;

// Escalation is opt-in and stays on the same provider/endpoint. Single-model
// engines (Apple FM, llama.cpp, LiteRT) cannot switch by changing a model name.
export const modelProviderKey = (backend) => `${backend?.api ? "api" : "ollama"}:${backend?.base || ""}`;

export function strongBackendFor(backend, store = globalThis.localStorage) {
  let model = "";
  try {
    if (store?.getItem("orchestratorStrongProvider") !== modelProviderKey(backend)) return null;
    model = store?.getItem("orchestratorStrongModel")?.trim() || "";
  } catch {}
  return model && canOverrideModel(backend) && model !== backend.model ? { ...backend, model } : null;
}

/** Capture once at turn start: settings changes cannot mix engines within a turn. */
export function orchestrationBackends(backend, store = globalThis.localStorage) {
  const snapshot = backend ? { ...backend } : {};
  return {
    backend: snapshot,
    mainBackend: mainBackendSnapshot(snapshot, store),
    fastBackend: fastBackendFor(snapshot, store),
    strongBackend: strongBackendFor(snapshot, store),
  };
}
