// Associations badge RFID -> action Lumen.
//
// Le contrôleur ne connaît que l'UID du badge, et la table vit CÔTÉ BACKEND
// (src-tauri/src/rfid_store.rs), au même titre que la clé API : fichier 0600
// dans le dossier de données, et l'UID n'est jamais renvoyé à une webview.
// L'interface ne manipule qu'une forme masquée et un identifiant opaque.
//
// Pour ajouter une action :
//   1. une entrée dans RFID_ACTIONS (identifiant, libellé, forme du paramètre) ;
//   2. un cas dans le `switch` de runRfidBinding() (src/main.js).
// Le menu des Réglages se construit à partir de RFID_ACTIONS, il n'y a donc
// rien à modifier dans l'interface.

// `window.__TAURI__` n'est pas injecté dans les iframes même-origine du
// bureau : on résout avec le repli parent, comme les autres modules.
const invoke = (() => {
  let tauri = null;
  try { tauri = window.__TAURI__ || window.parent?.__TAURI__ || null; } catch (e) { /* cross-origin */ }
  return tauri?.core?.invoke || null;
})();

// `param` décrit ce que le menu doit demander à l'utilisateur :
//   "model"     -> liste des modèles disponibles, avec leur backend
//   "chat_mode" -> liste fixe des modes de discussion
//   "voice"     -> voix de synthèse installées
//   null        -> aucun paramètre
export const RFID_ACTIONS = {
  model: { labelKey: "rfid_action_model", param: "model" },
  chat_mode: { labelKey: "rfid_action_chat_mode", param: "chat_mode" },
  voice: { labelKey: "rfid_action_voice", param: "voice" },
};

export const RFID_CHAT_MODES = ["chat", "router", "tools", "docs"];

const LEGACY_KEY = "rfidBindings";

// Un UID est comparé en majuscules sans séparateur : les lecteurs et les
// utilitaires les écrivent tantôt "04a2b3c4", tantôt "04:A2:B3:C4".
export function normalizeUid(uid) {
  return String(uid || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

/** Associations existantes, sous forme masquée (`••••B3C4`). */
export async function loadBindings() {
  if (!invoke) return [];
  try {
    const list = await invoke("rfid_bindings_list");
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

/** Associe (ou remplace) l'action d'un badge. Un badge = une action. */
export async function upsertBinding({ uid, label, action, params }) {
  if (!invoke) return [];
  return invoke("rfid_bind", {
    uid: normalizeUid(uid),
    label: String(label || ""),
    action: String(action || ""),
    params: params && typeof params === "object" ? params : null,
  });
}

/** Retire une association à partir de son identifiant opaque. */
export async function removeBinding(id) {
  if (!invoke) return [];
  return invoke("rfid_unbind", { id: String(id) });
}

/** Action associée à un badge, ou null. L'UID ne fait qu'entrer. */
export async function findBinding(uid) {
  if (!invoke) return null;
  try {
    return (await invoke("rfid_resolve", { uid: normalizeUid(uid) })) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Reprend les associations créées avant le passage au stockage backend, où
 * elles vivaient en localStorage avec l'UID en clair. La copie locale est
 * effacée une fois transmise, y compris si tout était déjà repris.
 */
export async function migrateLegacyBindings() {
  if (!invoke) return 0;
  let legacy;
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
  } catch (e) {
    legacy = null;
  }
  if (!Array.isArray(legacy)) return 0;
  try {
    const added = await invoke("rfid_import_legacy", { bindings: legacy });
    localStorage.removeItem(LEGACY_KEY);
    return added || 0;
  } catch (e) {
    return 0;
  }
}
