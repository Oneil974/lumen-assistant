// Service d'embeddings partagé (fenêtre principale) : répond aux demandes du
// backend (bloc Fluxo « Prédire (ML) » sur un modèle texte) via l'événement
// `ml-embed-request` → calcul dans le worker (src/lib/embeddings-worker.js) →
// commande `ml_embed_result`. Les poids sont dans le Cache API (partagé entre
// fenêtres) : si l'Atelier ML a déjà téléchargé le modèle, aucune connexion.
import { loadTransformers } from "./transformers-loader.js";

let worker = null, workerDead = false, seq = 0;
const pending = new Map();
let mainMod = null;
const mainPipes = new Map(); // repli thread principal : pipeline par modèle

function getWorker() {
  if (workerDead) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./embeddings-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (ev) => {
        const { id, type, payload } = ev.data || {};
        const p = pending.get(id);
        if (!p || type === "progress") return;
        pending.delete(id);
        if (type === "error") p.reject(new Error(payload));
        else p.resolve(payload);
      };
      worker.onerror = () => {
        workerDead = true;
        for (const p of pending.values()) p.reject(new Error("worker indisponible"));
        pending.clear();
        worker.terminate(); worker = null;
      };
    } catch { workerDead = true; worker = null; }
  }
  return worker;
}
function call(type, payload) {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("worker indisponible"));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload });
  });
}

/// Embedding d'un texte (déjà préfixé le cas échéant) avec le modèle donné.
export async function embedText(modelId, text) {
  try {
    await call("load", { modelId });
    const { data } = await call("embed", { text });
    return data;
  } catch (e) {
    if (!workerDead) throw e;
    // Repli thread principal (peut geler l'UI brièvement — cas dégradé).
    if (!mainMod) mainMod = await loadTransformers();
    let fe = mainPipes.get(modelId);
    if (!fe) { fe = await mainMod.pipeline("feature-extraction", modelId, { dtype: "q8" }); mainPipes.set(modelId, fe); }
    const out = await fe(text, { pooling: "mean", normalize: true });
    return Array.from(out.data);
  }
}

/// Branche le répondeur aux demandes d'embeddings du backend.
export function installEmbedResponder() {
  const evt = window.__TAURI__?.event, invoke = window.__TAURI__?.core?.invoke;
  if (!evt || !invoke) return;
  evt.listen("ml-embed-request", async (e) => {
    const { id, model, text } = e.payload || {};
    if (id == null) return;
    try {
      const embedding = await embedText(String(model || ""), String(text || ""));
      await invoke("ml_embed_result", { id, embedding });
    } catch (err) {
      await invoke("ml_embed_result", { id, error: String(err?.message || err) }).catch(() => {});
    }
  });
}
