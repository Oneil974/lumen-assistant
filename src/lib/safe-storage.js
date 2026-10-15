// Écriture localStorage qui n'interrompt jamais l'interface.
//
// Le stockage d'une webview est plafonné pour TOUTE l'origine (~5 à 10 Mo,
// apps du bureau comprises). Une fois saturé — par exemple par un moodboard
// dont les images étaient encodées en base64 — le moindre `setItem` lève une
// QuotaExceededError. Or ces écritures sont presque toujours des PRÉFÉRENCES
// posées au milieu d'une action : l'exception remontait et interrompait
// l'action elle-même. Changer de discussion dans l'assistant s'arrêtait ainsi
// avant l'affichage, sans un mot à l'écran.
//
// Règle : une préférence n'est jamais assez importante pour casser un geste.
// On écrit au mieux, on renvoie le verdict, et on prévient l'utilisateur UNE
// fois, en nommant ce qui occupe la place.

let notifier = null;
let warned = false;

/** Branche l'affichage d'alerte de l'app hôte (toast, bandeau…). */
export function onStorageFull(fn) { notifier = fn; }

/** Écrit sans jamais lever. Renvoie true si la valeur est bien enregistrée. */
export function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn("[storage] écriture refusée :", key, e);
    warnOnce();
    return false;
  }
}

/** Les plus gros postes du stockage, du plus lourd au plus léger. */
export function storageHogs(limit = 5) {
  const rows = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    rows.push({ key: k, bytes: (localStorage.getItem(k) || "").length });
  }
  return rows.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

function warnOnce() {
  if (warned) return;
  warned = true;
  const hogs = storageHogs(3);
  console.warn("[storage] postes les plus lourds :", hogs);
  const top = hogs[0];
  notifier?.(
    "Stockage local saturé : les préférences ne sont plus enregistrées."
    + (top ? ` Le plus lourd : ${top.key} (${Math.round(top.bytes / 1024)} Ko).` : "")
  );
}
