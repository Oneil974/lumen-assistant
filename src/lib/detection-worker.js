// Worker de détection d'objets (Atelier ML › Vision). transformers.js + ONNX
// WASM tournent ICI, hors du thread UI (le backend WASM est synchrone : sur le
// thread principal, chaque image gèlerait la fenêtre). Même chargement que
// embeddings-worker.js : fetch CDN → Cache API → import blob.
//
// Deux familles de modèles :
//   - « pipeline » : YOLOS, DETR, RT-DETR, D-FINE — sortie DETR (logits +
//     boîtes), post-traitée par le pipeline `object-detection` ;
//   - « yolov10 » : sortie brute [1, 300, 6] = (x1, y1, x2, y2, score, classe)
//     dans le repère de l'image redimensionnée, sans NMS à faire (YOLOv10 est
//     « NMS-free »). On la ramène au repère de l'image d'origine.
// Boîtes renvoyées en coordonnées NORMALISÉES [0..1] : l'UI et l'export YOLO
// n'ont pas à connaître la taille de l'image traitée.
const TJS_VERSION = "3.4.0";
const TJS_CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TJS_VERSION}/dist/`;
const TJS_ENTRY = TJS_CDN + "transformers.min.js";

let mod = null;
let current = { id: "", kind: "", pipe: null, model: null, processor: null };

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
  const patched = (await resp.text()).replaceAll("import.meta.url", JSON.stringify(TJS_ENTRY));
  const m = await import(/* @vite-ignore */ URL.createObjectURL(new Blob([patched], { type: "text/javascript" })));
  m.env.allowLocalModels = false;
  if (m.env?.backends?.onnx?.wasm) {
    m.env.backends.onnx.wasm.wasmPaths = TJS_CDN;
    m.env.backends.onnx.wasm.numThreads = 1;
    m.env.backends.onnx.wasm.proxy = false;
  }
  return m;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

async function load({ modelId, kind, dtype }, progress) {
  if (!mod) mod = await loadLib();
  if (current.id === modelId) return;
  const opts = { dtype: dtype || "q8", progress_callback: progress };
  if (kind === "yolov10") {
    const [model, processor] = await Promise.all([
      mod.AutoModel.from_pretrained(modelId, opts),
      mod.AutoProcessor.from_pretrained(modelId),
    ]);
    current = { id: modelId, kind, pipe: null, model, processor };
  } else {
    const pipe = await mod.pipeline("object-detection", modelId, opts);
    current = { id: modelId, kind: "pipeline", pipe, model: null, processor: null };
  }
}

async function detect({ blob, threshold }) {
  if (!current.id) throw new Error("Aucun modèle chargé");
  const image = await mod.RawImage.fromBlob(blob);
  const W = image.width, H = image.height;
  const out = [];
  if (current.kind === "yolov10") {
    const inputs = await current.processor(image);
    const { output0 } = await current.model({ images: inputs.pixel_values });
    const [newH, newW] = inputs.reshaped_input_sizes[0];
    const labels = current.model.config.id2label || {};
    for (const [x1, y1, x2, y2, score, cls] of output0.tolist()[0]) {
      if (score < threshold) continue;
      out.push({
        label: labels[Math.round(cls)] || String(Math.round(cls)),
        score,
        box: [clamp01(x1 / newW), clamp01(y1 / newH), clamp01(x2 / newW), clamp01(y2 / newH)],
      });
    }
  } else {
    const res = await current.pipe(image, { threshold, percentage: false });
    for (const r of res) {
      const b = r.box;
      out.push({ label: r.label, score: r.score, box: [clamp01(b.xmin / W), clamp01(b.ymin / H), clamp01(b.xmax / W), clamp01(b.ymax / H)] });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data || {};
  const reply = (t, p) => self.postMessage({ id, type: t, payload: p });
  try {
    if (type === "load") {
      await load(payload, (p) => reply("progress", { status: p.status, file: p.file, loaded: p.loaded, total: p.total }));
      reply("done", { labels: Object.values((current.model || current.pipe?.model)?.config?.id2label || {}) });
    } else if (type === "detect") {
      reply("done", await detect(payload));
    } else {
      throw new Error("Message inconnu : " + type);
    }
  } catch (e) {
    reply("error", String(e?.message || e));
  }
};
