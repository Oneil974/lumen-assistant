// Chargeur partagé de transformers.js — la bibliothèque n'est PAS incluse dans
// le build : elle est téléchargée depuis le CDN au premier usage puis mise en
// cache (Cache API) pour fonctionner hors-ligne ensuite.
//
// La CSP de Lumen n'autorise pas `script-src https:` mais autorise
// `connect-src https:` + `script-src blob:` : on télécharge donc le fichier
// (fetch) puis on l'importe en module blob. Le bundle calcule normalement ses
// assets ONNX depuis import.meta.url ; comme celui-ci devient `blob:`, on
// réécrit cette base vers le CDN avant import. Les poids des modèles sont mis
// en cache par transformers.js lui-même.
//
// Utilisé par l'Atelier ML (embeddings texte) et la dictée Whisper.

export const TJS_VERSION = "3.4.0";
export const TJS_CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TJS_VERSION}/dist/`;
const TJS_ENTRY = TJS_CDN + "transformers.min.js";

let modPromise = null;

// Récupère la lib : Cache API d'abord (offline), sinon réseau (puis mise en cache).
async function fetchLib() {
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
    // Cache API indisponible (contexte non sécurisé) : fetch direct.
    resp = await fetch(TJS_ENTRY);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
  }
  const source = await resp.text();
  const patchedSource = source.replaceAll("import.meta.url", JSON.stringify(TJS_ENTRY));
  const blob = new Blob([patchedSource], { type: "text/javascript" });
  return import(/* @vite-ignore */ URL.createObjectURL(blob));
}

/// Charge (une seule fois par fenêtre) et configure transformers.js.
export async function loadTransformers() {
  if (!modPromise) {
    modPromise = fetchLib().then((mod) => {
      mod.env.allowLocalModels = false;
      if (mod.env?.backends?.onnx?.wasm) {
        mod.env.backends.onnx.wasm.wasmPaths = TJS_CDN;
        mod.env.backends.onnx.wasm.numThreads = 1;
        mod.env.backends.onnx.wasm.proxy = false;
      }
      return mod;
    }).catch((e) => { modPromise = null; throw e; });
  }
  return modPromise;
}
