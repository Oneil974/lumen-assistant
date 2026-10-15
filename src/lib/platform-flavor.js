import { platformCapabilities } from "./platform-capabilities.js";
// Saveur de plateforme, résolue sans jamais se tromper de repli.
//
// `platform_flavor` (Rust) renvoie "rpi", "linux-standard", "windows" ou
// "default". Le piège est dans ce dernier : « default » ne veut pas dire
// « inconnu », il veut dire **macOS**. Or chaque appelant prenait justement
// "default" comme valeur de repli quand la commande ne répondait pas — un
// `invoke` qui échoue (IPC pas encore prête au chargement du module, commande
// absente d'un build plus ancien) faisait donc passer un PC Windows ou un
// Raspberry Pi pour un Mac. L'assistant de démarrage y affichait « Modèle
// Apple » en voie détectée et recommandée, sur des machines où les Raccourcis
// macOS ne peuvent pas exister.
//
// On croise donc deux sources : la réponse du Rust, et ce que le navigateur
// dit de lui-même — toujours disponible, sans IPC. Elles concordent sur une
// machine saine ; en cas de désaccord ou de silence, on ne conclut jamais
// « Mac » par défaut.

const { invoke } = globalThis.window?.__TAURI__?.core || {};

/// Vrai si la WebView tourne réellement sur un Mac. Détection identique à celle
/// déjà utilisée par le bureau Lumen Desktop (`IS_MAC`, desktop.js).
export const IS_MAC = /Mac/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || "");

const KNOWN = ["rpi", "linux-standard", "windows", "default"];
const NO_APPLE = ["rpi", "linux-standard", "windows"];

let cached = null;

/**
 * Saveur de plateforme. Renvoie "" tant qu'elle n'a pas pu être établie —
 * jamais "default", qui serait une affirmation ("c'est un Mac") et non un aveu
 * d'ignorance.
 * @returns {Promise<string>}
 */
export async function platformFlavor() {
  if (cached !== null) return cached;
  let value = "";
  try {
    // `invoke` peut manquer si le module est évalué avant l'injection de
    // `window.__TAURI__` : on relit le global à chaque appel plutôt que de
    // figer un no-op à l'import.
    const call = invoke || window.__TAURI__?.core?.invoke;
    if (call) {
      const answer = await call("platform_flavor");
      if (typeof answer === "string" && KNOWN.includes(answer)) value = answer;
    }
  } catch { value = ""; }
  // Une saveur établie n'est mise en cache que si elle est exploitable : sinon
  // un échec au démarrage condamnerait la session entière à l'ignorance.
  if (value) cached = value;
  return value;
}

/**
 * Vrai si la voie « Modèle Apple » (Raccourcis macOS) peut fonctionner ici.
 *
 * Exige les DEUX accords : le Rust ne doit pas nommer une plateforme non-Apple,
 * et la WebView doit bien être sur un Mac. Sans réponse du Rust, c'est le
 * navigateur qui tranche — il ne se trompe pas sur ce point.
 * @returns {Promise<boolean>}
 */
export async function appleShortcutsAvailable() {
  const flavor = await platformFlavor();
  if (flavor && NO_APPLE.includes(flavor)) return false;
  if (flavor && !IS_MAC) {
    // Désaccord franc : le Rust dit « macOS », le navigateur dit le contraire.
    // On tranche pour le navigateur et on laisse une trace, sinon ce cas est
    // indétectable depuis une machine d'utilisateur.
    console.warn(`[platform] saveur « ${flavor} » mais la WebView n'est pas un Mac : voie Apple écartée.`);
  }
  return platformCapabilities({ flavor, platform: globalThis.navigator?.platform, userAgent: globalThis.navigator?.userAgent }).appleIntegration;
}

let gpuCached = null;

/**
 * Saveur GPU. "nvidia" quand Linux tourne sur le pilote propriétaire — dont
 * l'import DMABUF cassé donne à WebKitGTK de la rémanence, des ombres peintes
 * en noir et un rendu qui rame. "" partout ailleurs, y compris si la commande
 * n'a pas pu répondre : on ne dégrade jamais l'UI sur un doute.
 * @returns {Promise<string>}
 */
export async function gpuFlavor() {
  if (gpuCached !== null) return gpuCached;
  let value = "";
  try {
    const call = invoke || window.__TAURI__?.core?.invoke;
    if (call) {
      const answer = await call("gpu_flavor");
      if (answer === "nvidia") value = answer;
    }
  } catch { value = ""; }
  if (value) gpuCached = value;
  return value;
}
