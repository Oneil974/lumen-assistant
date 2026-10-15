// Store des projets Canvas, persistés sur le SYSTÈME DE FICHIERS sandbox (et non
// plus en localStorage). Arborescence, dans une sandbox dédiée « Canevas » :
//
//   canevas/
//     <slug-projet>/
//       project.json   ← textes résultants, prompts, positions, métadonnées
//       images/        ← PNG générés (un fichier par node image)
//       fonts/         ← polices du projet (réservé)
//
// Le JSON ne contient que du texte (léger, versionnable par les snapshots
// sandbox) ; les binaires (images, fonts) vivent à côté, référencés par chemin
// relatif au dossier du projet.

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const invoke = __TAURI.core?.invoke;

const SBKEY = "canvasSandboxId";   // id de la sandbox dédiée (cache localStorage)
const ROOT = "canevas";            // dossier racine des projets dans la sandbox
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export function hasBackend() { return !!invoke; }

// --- Sandbox dédiée -------------------------------------------------------
let sandboxId = null;

export async function ensureSandbox() {
  if (sandboxId) return sandboxId;
  if (!invoke) throw new Error("Stockage disponible uniquement dans l'app Lumen.");
  const cached = localStorage.getItem(SBKEY);
  if (cached) {
    try {
      const list = await invoke("sandbox_list");
      if (Array.isArray(list) && list.some((s) => s.id === cached)) { sandboxId = cached; return sandboxId; }
    } catch {}
  }
  // Canevas créatif et Studio Nodal partagent la même sandbox « Canevas » :
  // chaque app a son propre localStorage, on la retrouve donc par son nom.
  try {
    const list = await invoke("sandbox_list");
    const same = (list || []).find((s) => s.name === "Canevas");
    if (same) { sandboxId = same.id; localStorage.setItem(SBKEY, sandboxId); return sandboxId; }
  } catch {}
  const meta = await invoke("sandbox_create", { name: "Canevas", maxMb: 512 });
  sandboxId = meta.id;
  localStorage.setItem(SBKEY, sandboxId);
  return sandboxId;
}

export function currentSandboxId() { return sandboxId; }

// Liste des sandboxes disponibles (pour le sélecteur de la fenêtre Canvas).
export async function listSandboxes() {
  if (!invoke) return [];
  try { return (await invoke("sandbox_list")) || []; } catch { return []; }
}

// Choisit explicitement la sandbox où vivent les projets canevas. Persiste le choix.
export function setSandbox(id) {
  sandboxId = id || null;
  if (id) localStorage.setItem(SBKEY, id); else localStorage.removeItem(SBKEY);
  return sandboxId;
}

// --- Helpers chemins ------------------------------------------------------
export function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "projet";
}
const projDir = (slug) => `${ROOT}/${slug}`;
const projFile = (slug) => `${projDir(slug)}/project.json`;
// Chemin relatif au projet d'une image de node (versionné `v` pour conserver
// l'historique des générations ; sans `v` = ancien schéma non versionné).
export const imageRel = (nodeId, v) => `images/${nodeId}${v != null ? "-" + v : ""}.png`;
export const imageFullPath = (slug, nodeId, v) => `${projDir(slug)}/${imageRel(nodeId, v)}`;

// --- CRUD projets ---------------------------------------------------------
/**
 * Projets du dossier, filtrés par app : `canvas` (filiation) ou `nodal`
 * (graphe de nœuds, `app: "nodal"` — ou ancien projet passé en mode Nœuds
 * sans arbre de filiation).
 */
export const projectKind = (meta) => (meta.app === "nodal" || (meta.mode === "graph" && !(meta.nodes || []).length) ? "nodal" : "canvas");

export async function listProjects({ kind = "" } = {}) {
  const id = await ensureSandbox();
  let entries = [];
  try { entries = await invoke("sandbox_read_dir", { id, path: ROOT }); }
  catch { return []; } // dossier canevas pas encore créé
  const dirs = (entries || []).filter((e) => e.is_dir);
  const out = [];
  for (const d of dirs) {
    let title = d.name, updatedAt = d.modified * 1000, pk = "canvas";
    try {
      const f = await invoke("sandbox_read_file", { id, path: `${ROOT}/${d.name}/project.json` });
      const meta = JSON.parse(f.content || "{}");
      title = meta.title || title;
      updatedAt = meta.updatedAt || updatedAt;
      pk = projectKind(meta);
    } catch {}
    if (kind && pk !== kind) continue;
    out.push({ slug: d.name, title, updatedAt, kind: pk });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

function emptyProject(title) {
  return { version: 1, title, slug: slugify(title), createdAt: Date.now(), updatedAt: Date.now(),
    view: { x: 60, y: 60, scale: 1 }, nodes: [] };
}

// Crée un projet avec un slug unique (suffixe -2, -3… si collision).
export async function createProject(title = "Sans titre") {
  const id = await ensureSandbox();
  const existing = new Set((await listProjects()).map((p) => p.slug));
  let slug = slugify(title), n = 2;
  while (existing.has(slug)) slug = `${slugify(title)}-${n++}`;
  const proj = { ...emptyProject(title), slug };
  await invoke("sandbox_write_file", { id, path: projFile(slug), content: JSON.stringify(proj, null, 2) });
  return proj;
}

export async function loadProject(slug) {
  const id = await ensureSandbox();
  const f = await invoke("sandbox_read_file", { id, path: projFile(slug) });
  const proj = JSON.parse(f.content || "{}");
  proj.slug = slug;
  if (!Array.isArray(proj.nodes)) proj.nodes = [];
  if (!proj.view) proj.view = { x: 60, y: 60, scale: 1 };
  return proj;
}

export async function saveProject(proj) {
  const id = await ensureSandbox();
  proj.updatedAt = Date.now();
  await invoke("sandbox_write_file", { id, path: projFile(proj.slug), content: JSON.stringify(proj, null, 2) });
}

export async function writeFile(path, content) {
  const id = await ensureSandbox();
  await invoke("sandbox_write_file", { id, path, content });
  return { id, path };
}

export async function deleteProject(slug) {
  const id = await ensureSandbox();
  await invoke("sandbox_delete_path", { id, path: projDir(slug) });
}

export async function renameProject(proj, title) {
  proj.title = title;
  await saveProject(proj); // le slug (= dossier) reste stable, seul le titre change
}

// --- Binaires (polices, etc.) --------------------------------------------
// Écrit un fichier binaire (base64) à un chemin relatif au dossier du projet.
export async function importBinary(slug, rel, b64) {
  const id = await ensureSandbox();
  await invoke("sandbox_import_file", { id, path: `${projDir(slug)}/${rel}`, dataB64: b64 });
}
export async function readBinaryB64(slug, rel) {
  const id = await ensureSandbox();
  return invoke("sandbox_read_b64", { id, path: `${projDir(slug)}/${rel}` });
}

// Base64 BRUT d'une image de node (pour l'analyse vision multimodale).
export async function imageB64(slug, nodeId, file) {
  const id = await ensureSandbox();
  const path = file ? `${projDir(slug)}/${file}` : `${projDir(slug)}/${imageRel(nodeId)}`;
  return invoke("sandbox_read_b64", { id, path });
}

// --- Images ---------------------------------------------------------------
// Recharge une image de node depuis le disque en data URL (pour l'affichage).
export async function readImage(slug, nodeId, file) {
  const id = await ensureSandbox();
  const path = file ? `${projDir(slug)}/${file}` : `${projDir(slug)}/${imageRel(nodeId)}`;
  const ext = (path.split(".").pop() || "png").toLowerCase();
  const b64 = await invoke("sandbox_read_b64", { id, path });
  return `data:${MIME[ext] || "image/png"};base64,${b64}`;
}
