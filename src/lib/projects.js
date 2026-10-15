// Projets de l'assistant : un dossier de discussions + une base de connaissances.
//
// Un projet EST un dossier de conversations (cf. conversation-folders.js : même
// identifiant, même taxonomie partagée avec la barre) auquel on ajoute ce qui
// fait un vrai espace de travail : des instructions, des documents et des
// images. Les discussions s'y rangent par leur champ `folder`, comme avant ;
// ce module ne stocke que la connaissance du projet.
//
// Les fichiers eux-mêmes ne vivent pas ici : les documents sont indexés dans
// la base RAG (source `project:<id>`) et recopiés dans la sandbox « Projets »
// (`<id>/<nom>`), les images y sont rangées et décrites par le modèle vision
// pour que leur contenu soit cherchable. Le présent magasin ne garde que les
// métadonnées (identifiant d'index, taille, vignette), pour rester léger dans
// localStorage.

import { createFolder, deleteFolder, getFolder, listFolders, renameFolder } from "./conversation-folders.js";

const KEY = "lumen_projects";
export const PROJECT_SANDBOX = "Projets";

/**
 * @typedef {{ docId: string, name: string, kind: "doc"|"image", chars: number, chunks: number,
 *             size: number, path: string, sandboxId: string, added: number,
 *             text?: string, thumb?: string, description?: string }} ProjectFile
 * @typedef {{ id: string, name: string, color: string, created: number,
 *             instructions: string, files: ProjectFile[], updated: number }} Project
 */

function readMeta() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeMeta(meta) {
  localStorage.setItem(KEY, JSON.stringify(meta));
}

function withMeta(folder, meta) {
  const m = meta[folder.id] || {};
  return {
    ...folder,
    instructions: typeof m.instructions === "string" ? m.instructions : "",
    files: Array.isArray(m.files) ? m.files : [],
    updated: Number(m.updated || folder.created || 0),
  };
}

/** Source RAG des documents d'un projet : retirer le projet retire son index. */
export function projectSource(id) { return `project:${id}`; }

/** @returns {Project[]} */
export function listProjects() {
  const meta = readMeta();
  return listFolders().map((f) => withMeta(f, meta));
}

/** @returns {Project|null} */
export function getProject(id) {
  const folder = getFolder(id);
  return folder ? withMeta(folder, readMeta()) : null;
}

/** Crée un projet (= un dossier). Un nom déjà pris renvoie l'existant. */
export function createProject(name, color = "") {
  const folder = createFolder(name, color);
  const meta = readMeta();
  if (!meta[folder.id]) {
    meta[folder.id] = { instructions: "", files: [], updated: Date.now() };
    writeMeta(meta);
  }
  return withMeta(folder, meta);
}

export function renameProject(id, name) { renameFolder(id, name); touch(id); }

function touch(id, patch = {}) {
  const meta = readMeta();
  meta[id] = { instructions: "", files: [], ...(meta[id] || {}), ...patch, updated: Date.now() };
  writeMeta(meta);
  return meta[id];
}

export function setProjectInstructions(id, instructions) {
  touch(id, { instructions: String(instructions || "").slice(0, 8000) });
}

/** Ajoute (ou remplace, à nom égal) un fichier dans la connaissance du projet. */
export function addProjectFile(id, file) {
  const meta = readMeta();
  const cur = meta[id] || { instructions: "", files: [] };
  const files = (cur.files || []).filter((f) => f.name !== file.name);
  files.push({ ...file, added: file.added || Date.now() });
  touch(id, { files });
}

export function removeProjectFile(id, name) {
  const meta = readMeta();
  const files = (meta[id]?.files || []).filter((f) => f.name !== name);
  touch(id, { files });
}

/**
 * Supprime le projet : le dossier disparaît (les discussions redeviennent non
 * classées, elles ne sont JAMAIS effacées) et les métadonnées de connaissance
 * sont retirées. Les documents de l'index et les fichiers de la sandbox sont
 * à retirer par l'appelant (il a accès aux commandes Tauri, pas ce module).
 * @returns {ProjectFile[]} les fichiers qui étaient rattachés
 */
export function deleteProject(id) {
  const meta = readMeta();
  const files = meta[id]?.files || [];
  delete meta[id];
  writeMeta(meta);
  deleteFolder(id);
  return files;
}

/** Résumé chiffré d'un projet pour les listes. */
export function projectStats(project) {
  const docs = project.files.filter((f) => f.kind !== "image").length;
  const images = project.files.filter((f) => f.kind === "image").length;
  const chars = project.files.reduce((n, f) => n + (Number(f.chars) || 0), 0);
  const chunks = project.files.reduce((n, f) => n + (Number(f.chunks) || 0), 0);
  return { docs, images, chars, chunks };
}

/** Identifiants d'index (RAG) des fichiers d'un projet. */
export function projectDocIds(project) {
  return project.files.map((f) => f.docId).filter(Boolean);
}

// Volume de texte en deçà duquel la connaissance du projet part ENTIÈRE dans le
// contexte plutôt que par recherche : pour un petit corpus, la fidélité prime.
export const PROJECT_FULL_CHARS = 12000;

/**
 * Bloc de contexte système du projet : instructions + inventaire de la
 * connaissance (+ le texte intégral quand le corpus est petit).
 */
export function projectSystemBlock(project, lang = "fr") {
  if (!project) return "";
  const en = lang === "en";
  const parts = [];
  parts.push((en ? `[Project « ${project.name} »]` : `[Projet « ${project.name} »]`));
  const instr = String(project.instructions || "").trim();
  if (instr) parts.push((en ? "Instructions for this project:\n" : "Instructions du projet :\n") + instr);
  if (project.files.length) {
    const inventory = project.files.map((f) => {
      const kind = f.kind === "image" ? "image" : "document";
      const extra = f.kind === "image" && f.description ? ` — ${String(f.description).slice(0, 160)}` : "";
      return `- ${f.name} (${kind}${f.chars ? `, ${f.chars} ${en ? "chars" : "caractères"}` : ""})${extra}`;
    }).join("\n");
    parts.push((en ? "Project knowledge base:\n" : "Base de connaissances du projet :\n") + inventory);
    if (projectServedInFull(project)) {
      // Petit corpus : tout part dans le contexte, descriptions d'images comprises
      // (aucune recherche n'aura lieu pour ce projet).
      const body = project.files
        .map((f) => (f.kind === "image" ? (f.description ? `--- ${f.name} (image) ---\n${f.description}` : "") : `--- ${f.name} ---\n${f.text}`))
        .filter(Boolean);
      parts.push((en ? "Full content of the project documents:\n\n" : "Contenu intégral des documents du projet :\n\n") + body.join("\n\n"));
    } else {
      parts.push(en
        ? "Relevant excerpts from these documents are provided with each question when they match. Rely on them and cite them as (Source n)."
        : "Des extraits pertinents de ces documents accompagnent chaque question quand ils s'y rapportent. Appuie-toi dessus et cite-les sous la forme (Source n).");
    }
  }
  return parts.join("\n\n");
}

/** Le corpus est-il servi en entier (pas de recherche nécessaire) ? */
export function projectServedInFull(project) {
  if (!project?.files.length) return false;
  const docs = project.files.filter((f) => f.kind !== "image");
  const chars = docs.reduce((n, f) => n + (Number(f.chars) || 0), 0);
  return docs.length > 0 && chars <= PROJECT_FULL_CHARS && docs.every((f) => typeof f.text === "string" && f.text.length > 0);
}
