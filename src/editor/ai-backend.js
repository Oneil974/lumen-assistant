// Backend et modèle POUR LE CODE, propres à l'Éditeur : on peut écrire du code
// avec un gros modèle (API cloud, Qwen Coder sur Ollama…) pendant que le reste
// de Lumen discute avec un petit modèle local. Choix vide = suivre Lumen.
//
// Persisté dans le localStorage de l'éditeur (`editorAiBackend`). Tous les
// appels IA de l'éditeur passent `backend: codeBackend()` à llmChat.

import {
  llmBackend, backendForSource, isApiLike, listApiProfiles, ollamaGetJson,
  lumenServerBackendState, appleFmBackendState, APPLEFM_MODELS, APPLEFM_DEFAULT_MODEL, recallModelFor,
} from "../llm.js";
import { suggestedModels, prioritiseModels } from "../lib/api-model-catalog.js";

const KEY = "editorAiBackend";
const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const invoke = __TAURI.core?.invoke;

export const SOURCE_LABELS = {
  ollama: "Ollama",
  llama: "llama.cpp",
  api: "API cloud",
  lumen: "Lumen Server",
  applefm: "Apple Intelligence",
};

/** Choix enregistré : { source, model } ; source vide = suivre Lumen. */
export function codeChoice() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { source: String(v.source || ""), model: String(v.model || "") };
  } catch { return { source: "", model: "" }; }
}

export function setCodeChoice(choice) {
  try {
    if (!choice?.source) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ source: choice.source, model: choice.model || "" }));
  } catch { /* stockage indisponible : le choix vaut pour la session */ }
  listeners.forEach((fn) => { try { fn(); } catch {} });
}

const listeners = new Set();
export function onCodeChoiceChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Backend à passer à llmChat pour toute demande de code. */
export function codeBackend() {
  const c = codeChoice();
  if (!c.source) return llmBackend();
  return backendForSource(c.source, c.model);
}

/** Libellé court : { source, model, override }. */
export function codeBackendLabel() {
  const c = codeChoice();
  const b = codeBackend();
  const source = c.source || b.source || "ollama";
  return {
    source: SOURCE_LABELS[source] || source,
    model: b.model || (source === "applefm" ? APPLEFM_DEFAULT_MODEL : ""),
    override: !!c.source,
  };
}

/** Backends proposés (ceux qui sont réellement utilisables ici). */
export async function availableSources() {
  const out = ["ollama", "llama"];
  const [profiles, lumen, apple] = await Promise.all([
    listApiProfiles().catch(() => ({ profiles: [] })),
    lumenServerBackendState().catch(() => ({ available: false })),
    appleFmBackendState().catch(() => ({ available: false })),
  ]);
  if ((profiles.profiles || []).some((p) => p.configured) || localStorage.getItem("aiSource") === "api") out.push("api");
  if (lumen.available) out.push("lumen");
  if (apple.available) out.push("applefm");
  return out;
}

/** Modèles connus pour une source ({ list, hint }). */
export async function modelsFor(source) {
  try {
    if (source === "ollama") {
      const url = localStorage.getItem("ollamaUrl") || "http://localhost:11434";
      const d = await ollamaGetJson("api/tags", url);
      return { list: (d.models || []).map((m) => m.name).filter(Boolean) };
    }
    if (source === "llama") {
      const models = await invoke("llama_list_models");
      return {
        list: (Array.isArray(models) ? models : []).map((m) => m.filename).filter(Boolean),
        hint: "Un seul modèle llama.cpp tourne à la fois : en choisir un autre redémarre llama-server pour tout Lumen.",
      };
    }
    if (source === "api") {
      const base = localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1";
      try {
        const loaded = await invoke("llm_cloud_models");
        if (loaded?.length) return { list: prioritiseModels(loaded, base), hint: "Profil API actif des Réglages." };
      } catch { /* repli : suggestions du fournisseur */ }
      return { list: suggestedModels(base), hint: "Suggestions du fournisseur (liste en direct indisponible)." };
    }
    if (source === "applefm") return { list: APPLEFM_MODELS.map((m) => m.id) };
  } catch { /* backend injoignable */ }
  return { list: [] };
}

/** Modèle par défaut d'une source (celui que Lumen y avait laissé). */
export function defaultModelFor(source) {
  if (source === "api") return localStorage.getItem("apiModel") || "";
  if (source === "lumen") return localStorage.getItem("lumenModel") || "";
  if (source === "applefm") return localStorage.getItem("applefmModel") || APPLEFM_DEFAULT_MODEL;
  return recallModelFor(source) || "";
}

/**
 * llama.cpp ne sert qu'UN modèle : s'il n'est pas déjà chargé, on le démarre.
 * Renvoie un message à afficher, ou "".
 */
export async function ensureLlamaModel(model) {
  if (!model || !invoke) return "";
  try {
    const st = await invoke("llama_status");
    if (st?.running && st.model === model) return "";
    await invoke("llama_start", { filename: model, ctxSize: Number(localStorage.getItem("llamaNumCtx") || 8192) });
    return `llama-server redémarré sur ${model}.`;
  } catch (e) {
    return `Démarrage de llama-server impossible : ${e?.message || e}`;
  }
}

export { isApiLike };
