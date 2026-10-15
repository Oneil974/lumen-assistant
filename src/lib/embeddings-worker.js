// Worker dédié aux embeddings texte (Atelier ML). transformers.js + ONNX WASM
// tournent ICI, hors du thread UI : le backend WASM est synchrone, donc chaque
// inférence exécutée sur le thread principal gèle toute la fenêtre (freeze
// complet pendant « Entraîner localement »). Même technique de chargement que
// transformers-loader.js : fetch CDN → Cache API → import blob (la CSP autorise
// connect-src https: et script-src blob:).
const TJS_VERSION = "3.4.0";
const TJS_CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TJS_VERSION}/dist/`;
const TJS_ENTRY = TJS_CDN + "transformers.min.js";

let mod = null;
let fe = null;
let modelId = "";

async function loadLib() {
  let resp = null;
  try {
    const cache = await caches.open("lumen-ml-transformers");
    resp = await cache.match(TJS_ENTRY);
    if (!resp) {
      resp = await fetch(TJS_ENTRY);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      await cache.put(TJS_ENTRY, resp.clone());
    }
  } catch {
    resp = await fetch(TJS_ENTRY);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
  }
  const source = await resp.text();
  // Le bundle résout ses assets ONNX depuis import.meta.url ; en module blob
  // cette base devient `blob:` → on la réécrit vers le CDN avant import.
  const patched = source.replaceAll("import.meta.url", JSON.stringify(TJS_ENTRY));
  const m = await import(/* @vite-ignore */ URL.createObjectURL(new Blob([patched], { type: "text/javascript" })));
  m.env.allowLocalModels = false;
  if (m.env?.backends?.onnx?.wasm) {
    m.env.backends.onnx.wasm.wasmPaths = TJS_CDN;
    m.env.backends.onnx.wasm.numThreads = 1;
    m.env.backends.onnx.wasm.proxy = false; // déjà dans un worker
  }
  return m;
}

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data || {};
  const reply = (t, p) => self.postMessage({ id, type: t, payload: p });
  try {
    if (type === "load") {
      if (!mod) mod = await loadLib();
      if (!fe || modelId !== payload.modelId) {
        fe = await mod.pipeline("feature-extraction", payload.modelId, {
          dtype: "q8",
          progress_callback: (p) => reply("progress", {
            status: p.status, file: p.file, loaded: p.loaded, total: p.total,
          }),
        });
        modelId = payload.modelId;
      }
      reply("done");
    } else if (type === "embed") {
      if (!fe) throw new Error("Moteur non chargé");
      const out = await fe(payload.text, { pooling: "mean", normalize: true });
      reply("done", { data: Array.from(out.data) });
    } else {
      throw new Error("Message inconnu : " + type);
    }
  } catch (e) {
    reply("error", String(e?.message || e));
  }
};
