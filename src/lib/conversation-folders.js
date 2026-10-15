import { PROMPTS as CORE_PROMPTS, transcriptOf } from "./core-prompts.js";
// Dossiers, épinglage et résumés des conversations.
//
// Trois surfaces manipulent les mêmes discussions : la barre Lumen, le bureau
// Lumen Desktop et (en lecture) le compagnon distant. Le classement ne pouvait donc
// pas vivre dans l'une d'elles — un dossier créé depuis la barre doit exister
// pour le bureau, qui est la vue consolidée.
//
// Les conversations, elles, restent dans DEUX magasins distincts
// (`saved_conversations` nu pour la barre, préfixé par le profil pour le
// bureau, cf. desktop.js). Ce module ne touche pas à cette répartition : il
// n'écrit que des champs (`folder`, `pinned`, `summary`) dans les entrées, là
// où elles se trouvent déjà. Les dossiers eux-mêmes, en revanche, sont une
// taxonomie unique et partagée, sans quoi une discussion de la barre ne pourrait
// jamais être rangée depuis le bureau.

const FOLDERS_KEY = "conversation_folders";

/** @typedef {{id: string, name: string, color: string, created: number}} Folder */

// Palette reprise des accents de l'orbe : les pastilles de dossier doivent
// avoir l'air d'appartenir à Lumen, pas à un gestionnaire de fichiers.
export const FOLDER_COLORS = [
  "#7c9cff", "#68d3a7", "#ffb26b", "#ff8fa3", "#c39bff", "#6fd3e0", "#e0c86f",
];

function read(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** @returns {Folder[]} */
export function listFolders() {
  return read(FOLDERS_KEY)
    .filter((f) => f && f.id && f.name)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function getFolder(id) {
  return id ? listFolders().find((f) => f.id === id) || null : null;
}

function writeFolders(list) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(list));
}

/**
 * Crée un dossier. Un nom déjà pris renvoie le dossier existant plutôt qu'un
 * doublon : deux « Travail » côte à côte ne rangent rien.
 * @returns {Folder}
 */
export function createFolder(name, color = "") {
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) throw new Error("Le dossier doit avoir un nom.");
  const existing = listFolders().find((f) => f.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const list = read(FOLDERS_KEY);
  const folder = {
    id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: clean,
    color: color || FOLDER_COLORS[list.length % FOLDER_COLORS.length],
    created: Date.now(),
  };
  list.push(folder);
  writeFolders(list);
  return folder;
}

export function renameFolder(id, name) {
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) return;
  writeFolders(read(FOLDERS_KEY).map((f) => (f.id === id ? { ...f, name: clean } : f)));
}

/**
 * Supprime un dossier SANS toucher aux discussions qu'il contenait : ranger
 * puis vider un dossier ne doit pas être un moyen détourné d'effacer un
 * historique. Les discussions concernées redeviennent simplement non classées
 * (`resolveFolder` renvoie `null` pour un identifiant inconnu).
 */
export function deleteFolder(id) {
  writeFolders(read(FOLDERS_KEY).filter((f) => f.id !== id));
}

/** Dossier d'une conversation, ou `null` si non classée / dossier supprimé. */
export function resolveFolder(conv) {
  return getFolder(conv?.folder || "");
}

export function isPinned(conv) {
  return Boolean(conv?.pinned);
}

/**
 * Extrait de la discussion, pour la vignette du tableau d'épinglés.
 *
 * Le résumé IA prime quand il existe ; à défaut on montre la première réponse
 * de l'assistant, qui dit bien mieux de quoi parlait la discussion que la
 * question qui l'a ouverte (déjà reprise dans le titre).
 */
export function conversationExcerpt(conv, max = 240) {
  const summary = String(conv?.summary || "").trim();
  const source = summary
    || String((conv?.history || []).find((m) => m?.role === "assistant" && typeof m.content === "string")?.content || "").trim();
  const flat = source.replace(/```[\s\S]*?```/g, " ").replace(/[#*_>`]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Messages du résumé d'une conversation (4 phrases), ou de sa note de mémoire
 * pour la compaction (`forContext`, en fondant la note précédente).
 */
export function summaryMessages(conv, lang = "fr", { forContext = false, previous = "" } = {}) {
  const transcript = transcriptOf(conv?.history || []);
  const code = lang === "en" ? "en" : "fr";
  return forContext
    ? CORE_PROMPTS["core.conversation.memo"].build({ transcript, previous: String(previous || "").trim(), lang: code }).messages
    : CORE_PROMPTS["core.conversation.summary"].build({ transcript, lang: code }).messages;
}
