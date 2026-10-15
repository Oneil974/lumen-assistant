// Bibliothèque d'assets du Village — wrapper partagé (Village + éditeur d'agents)
// au-dessus des commandes Rust (village_assets_*). Les images sont des dataURL ;
// on les convertit en objets Image mis en cache pour le rendu canvas.

export const ASSET_KINDS = [
  { key: "avatar", label: "Avatar" },
  { key: "spritesheet", label: "Feuille de sprites" },
  { key: "house", label: "Maison" },
  { key: "decor", label: "Décor" },
  { key: "tile", label: "Sol" },
  { key: "prop", label: "Objet" },
];

let _assets = [];        // assets importés par l'utilisateur (dataURL, persistés)
let _builtin = null;     // assets bundlés (packs découpés), chargés une fois
const _imgCache = new Map();

// Packs livrés avec l'app : manifeste généré par scripts/slice-packs.mjs. Chaque
// entrée a un `src` (chemin servi) plutôt qu'une dataURL ; le champ `data` pointe
// donc sur ce chemin, directement utilisable par <img> et new Image().
async function loadBuiltin() {
  if (_builtin) return _builtin;
  try {
    const res = await fetch("/village/assets/packs/manifest.json");
    const list = res.ok ? await res.json() : [];
    _builtin = list.map((a) => ({ id: a.id, name: a.name, kind: a.kind, data: a.src, w: a.w, h: a.h, category: a.category, pack: a.pack, builtin: true }));
  } catch { _builtin = []; }
  return _builtin;
}

export async function loadAssets(invoke) {
  const builtin = await loadBuiltin();
  let user = [];
  if (invoke) { try { user = (await invoke("village_assets_list")) || []; } catch { user = []; } }
  // Les assets utilisateur priment (mêmes ids possibles après ré-import).
  const userIds = new Set(user.map((a) => a.id));
  _assets = [...user, ...builtin.filter((a) => !userIds.has(a.id))];
  // Purge le cache d'images des assets disparus
  for (const id of [..._imgCache.keys()]) if (!_assets.find((a) => a.id === id)) _imgCache.delete(id);
  return _assets;
}

export function listAssets(kind) { return kind ? _assets.filter((a) => a.kind === kind) : _assets.slice(); }
export function getAsset(id) { return _assets.find((a) => a.id === id) || null; }

// Renvoie un objet Image (peut être encore en chargement ; le rendu rAF le
// redessinera une fois prêt). Renvoie null si l'asset est introuvable.
export function imageFor(id) {
  if (!id) return null;
  if (_imgCache.has(id)) return _imgCache.get(id);
  const a = getAsset(id);
  if (!a) { _imgCache.set(id, null); return null; }
  const img = new Image();
  img.src = a.data;
  _imgCache.set(id, img);
  return img;
}
export function isReady(img) { return !!img && img.complete && img.naturalWidth > 0; }

export function fileToDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function imgDims(src) {
  return new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res({ w: 0, h: 0 }); i.src = src; });
}

export async function importAsset(invoke, { name, kind, file }) {
  const data = await fileToDataUrl(file);
  const d = await imgDims(data);
  return invoke("village_asset_import", { name: name || file.name, kind, data, w: d.w, h: d.h });
}
export async function deleteAsset(invoke, id) { return invoke("village_asset_delete", { id }); }

// Asset de décor déterministe pour une tuile (si l'utilisateur a importé des décors).
export function decorAssetFor(gx, gy) {
  const decors = listAssets("decor");
  if (!decors.length) return null;
  const h = ((gx * 73856093) ^ (gy * 19349663)) >>> 0;
  return decors[h % decors.length];
}
