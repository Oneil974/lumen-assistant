// Worker de traduction LOCALE (Opus-MT, Helsinki-NLP, via transformers.js).
//
// Petits modèles de traduction spécialisés (≈ 107 Mo par paire de langues en
// q8), téléchargés une fois puis gardés en cache par le navigateur. Utilisé par
// Lumen XR pour « traduis ça » sans charger le Mac. Deux modèles au plus en
// mémoire (le second sert de relais par l'anglais : es → en → fr).
//
// Même chargement que whisper-worker.js : fetch CDN → Cache API → import blob.
const TJS_VERSION = "3.4.0";
const TJS_CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TJS_VERSION}/dist/`;
const TJS_ENTRY = TJS_CDN + "transformers.min.js";

let mod = null;
const loaded = new Map(); // modelId → pipeline (ordre = récence)

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
  const patched = source.replaceAll("import.meta.url", JSON.stringify(TJS_ENTRY));
  const m = await import(/* @vite-ignore */ URL.createObjectURL(new Blob([patched], { type: "text/javascript" })));
  m.env.allowLocalModels = false;
  if (m.env?.backends?.onnx?.wasm) {
    m.env.backends.onnx.wasm.wasmPaths = TJS_CDN;
    m.env.backends.onnx.wasm.numThreads = 1;
    m.env.backends.onnx.wasm.proxy = false;
  }
  return m;
}

async function pipelineFor(id, reply) {
  if (!mod) mod = await loadLib();
  if (loaded.has(id)) {
    const p = loaded.get(id);
    loaded.delete(id); loaded.set(id, p); // plus récent
    return p;
  }
  // Au plus deux modèles : le plus ancien est libéré avant d'en charger un autre.
  while (loaded.size >= 2) {
    const [oldId, old] = loaded.entries().next().value;
    loaded.delete(oldId);
    try { await old.dispose?.(); } catch {}
  }
  const p = await mod.pipeline("translation", id, {
    dtype: "q8",
    progress_callback: (e) => reply("progress", { status: e.status, file: e.file, loaded: e.loaded, total: e.total }),
  });
  loaded.set(id, p);
  return p;
}

// File : une opération à la fois (même raison que pour Whisper).
let queue = Promise.resolve();
self.onmessage = (ev) => { queue = queue.then(() => handle(ev)); };

async function handle(ev) {
  const { id, type, payload } = ev.data || {};
  const reply = (t, p) => self.postMessage({ id, type: t, payload: p });
  try {
    if (type === "load") {
      for (const m of payload.models || []) await pipelineFor(m, reply);
      reply("done");
    } else if (type === "translate") {
      // Chaîne de modèles : ["Xenova/opus-mt-es-en", "Xenova/opus-mt-en-fr"].
      let lines = payload.lines || [];
      for (const m of payload.chain || []) {
        const p = await pipelineFor(m, reply);
        const keep = lines.map((l) => /\p{L}/u.test(l)); // lignes sans lettres (prix seuls) : recopiées
        const todo = lines.filter((_, i) => keep[i]);
        const out = todo.length ? await p(todo, { max_new_tokens: 200 }) : [];
        let k = 0;
        lines = lines.map((l, i) => (keep[i] ? String(out[k++]?.translation_text ?? l) : l));
      }
      reply("done", { lines });
    } else throw new Error("Message inconnu : " + type);
  } catch (e) {
    reply("error", String(e?.message || e));
  }
}
