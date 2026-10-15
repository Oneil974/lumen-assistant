// Mise à jour automatique (plugin Tauri `updater`).
//
// On parle aux commandes du plugin directement via `invoke` plutôt que par son
// paquet npm : Lumen sert `src/` tel quel, sans bundler, donc un `import
// "@tauri-apps/plugin-updater"` ne serait pas résolu à l'exécution.
//
// Cycle : check() → Update|null ; puis install(update, onProgress) télécharge,
// installe et redémarre. Tant que `pubkey` est vide dans tauri.conf.json,
// check() rejette avec un message explicite (cf. scripts/setup-updater.mjs).

// Même repli que les autres modules : en iframe (workspace), WebKitGTK n'injecte
// pas toujours `window.__TAURI__` dans les sous-frames — on emprunte celui du
// parent, qui est de même origine.
let TAURI = window.__TAURI__;
try { if (!TAURI && window.parent !== window) TAURI = window.parent.__TAURI__; } catch {}
const invoke = TAURI?.core?.invoke || (async () => { throw new Error("Tauri indisponible"); });
const Channel = TAURI?.core?.Channel;

const LAST_CHECK_KEY = "updater:lastCheck";
const SKIPPED_KEY = "updater:skippedVersion";
const AUTO_KEY = "updater:auto";
// Une vérification par jour suffit largement pour une app de bureau.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** La vérification automatique au démarrage est-elle active ? (défaut : oui) */
export function autoCheckEnabled() {
  return localStorage.getItem(AUTO_KEY) !== "0";
}

export function setAutoCheck(on) {
  localStorage.setItem(AUTO_KEY, on ? "1" : "0");
}

/**
 * Interroge l'endpoint de mise à jour.
 * @returns {Promise<null | {version:string, currentVersion:string, date?:string, body?:string, rid:number}>}
 */
export async function check() {
  const meta = await invoke("plugin:updater|check", {});
  localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  if (!meta || !meta.available) return null;
  return meta;
}

/**
 * Télécharge et installe une mise à jour, puis redémarre Lumen.
 * @param {object} update l'objet renvoyé par check()
 * @param {(p:{stage:string, downloaded:number, total:number|null}) => void} [onProgress]
 */
export async function install(update, onProgress) {
  if (!Channel) throw new Error("Tauri indisponible");
  let total = null;
  let downloaded = 0;
  const onEvent = new Channel();
  onEvent.onmessage = (msg) => {
    if (msg.event === "Started") {
      total = msg.data?.contentLength ?? null;
      onProgress?.({ stage: "download", downloaded: 0, total });
    } else if (msg.event === "Progress") {
      downloaded += msg.data?.chunkLength ?? 0;
      onProgress?.({ stage: "download", downloaded, total });
    } else if (msg.event === "Finished") {
      onProgress?.({ stage: "install", downloaded, total });
    }
  };
  await invoke("plugin:updater|download_and_install", { onEvent, rid: update.rid });
  onProgress?.({ stage: "restart", downloaded, total });
  await invoke("plugin:process|restart");
}

/** Marque une version comme « ignorée » : plus de notification pour celle-ci. */
export function skip(version) {
  localStorage.setItem(SKIPPED_KEY, version);
}

export function isSkipped(version) {
  return localStorage.getItem(SKIPPED_KEY) === version;
}

/**
 * Vérification discrète au démarrage : respecte le réglage auto, ne
 * re-vérifie pas plus d'une fois par jour, ignore les versions écartées et
 * n'échoue jamais bruyamment (pas de réseau, pas de clé configurée, endpoint
 * absent → on ne dit rien).
 * @returns {Promise<null | object>} la mise à jour à proposer, ou null.
 */
export async function checkQuietly() {
  if (!autoCheckEnabled()) return null;
  const last = Number(localStorage.getItem(LAST_CHECK_KEY) || 0);
  if (Date.now() - last < CHECK_INTERVAL_MS) return null;
  try {
    const update = await check();
    if (!update || isSkipped(update.version)) return null;
    return update;
  } catch {
    return null;
  }
}

/** Formate un nombre d'octets pour l'affichage de la progression. */
export function formatBytes(n) {
  if (!n && n !== 0) return "—";
  const units = ["o", "ko", "Mo", "Go"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
