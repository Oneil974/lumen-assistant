// Worker dédié à la transcription Whisper (dictée locale).
//
// Le backend ONNX WASM est SYNCHRONE : une transcription exécutée sur le thread
// principal gèle la fenêtre entière pendant toute sa durée — quelques centaines
// de millisecondes sur un Mac, plusieurs secondes sous Windows, où WebView2 ne
// dispose ni de SIMD ni de threads dans notre configuration (numThreads: 1).
// C'est ce gel que l'on voyait à chaque dictée. Ici, le thread UI reste libre :
// le vu-mètre continue d'animer, la barre répond, l'orbe tourne.
//
// Même technique de chargement que transformers-loader.js et
// embeddings-worker.js : fetch CDN → Cache API → import blob (la CSP autorise
// connect-src https: et script-src blob:, pas script-src https:).
const TJS_VERSION = "3.4.0";
const TJS_CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TJS_VERSION}/dist/`;
const TJS_ENTRY = TJS_CDN + "transformers.min.js";

let mod = null;
let asr = null;
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
    // Plusieurs threads WASM exigent SharedArrayBuffer (page isolée) ; sinon 1.
    m.env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator?.hardwareConcurrency || 1) : 1;
    m.env.backends.onnx.wasm.proxy = false; // déjà dans un worker
  }
  return m;
}

async function ensurePipeline(id, reply) {
  if (!mod) mod = await loadLib();
  if (!asr || modelId !== id) {
    // Changement de modèle : libérer l'ancien AVANT de charger le nouveau,
    // sinon les deux restent en mémoire (base + small ≈ 350 Mo de plus).
    if (asr) { try { await asr.dispose?.(); } catch {} asr = null; modelId = ""; }
    asr = await mod.pipeline("automatic-speech-recognition", id, {
      dtype: "q8",
      progress_callback: (p) => reply("progress", {
        status: p.status, file: p.file, loaded: p.loaded, total: p.total,
      }),
    });
    modelId = id;
  }
}

// File d'attente : onmessage est asynchrone, deux messages (transcription
// partielle du casque + finale) s'exécutaient EN MÊME TEMPS — double
// chargement du modèle au premier appel, deux inférences concurrentes ensuite.
let queue = Promise.resolve();
self.onmessage = (ev) => { queue = queue.then(() => handle(ev)); };

async function handle(ev) {
  const { id, type, payload } = ev.data || {};
  const reply = (t, p) => self.postMessage({ id, type: t, payload: p });
  try {
    if (type === "load") {
      await ensurePipeline(payload.modelId, reply);
      reply("done");
    } else if (type === "transcribe") {
      await ensurePipeline(payload.modelId, reply);
      const out = await asr(payload.audio, { task: "transcribe", language: payload.language });
      reply("done", { text: String(out?.text || "") });
    } else {
      throw new Error("Message inconnu : " + type);
    }
  } catch (e) {
    reply("error", String(e?.message || e));
  }
}
