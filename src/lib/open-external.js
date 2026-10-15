// Ouvrir un lien dans le navigateur du système.
//
// Dans la WebView de Tauri, un `<a target="_blank">` ne fait RIEN : il n'y a pas
// d'onglet à ouvrir, et aucune erreur n'est remontée — le clic semble mort.
// Tout lien sortant doit donc passer par le système.
//
// Trois chemins, du plus portable au plus spécifique :
//   1. le plugin `opener` (déclaré dans les capacités, `opener:default` autorise
//      http/https/mailto/tel) — c'est le chemin normal, sur les trois OS ;
//   2. la commande maison `open_external` (macOS, `open`) — repli historique ;
//   3. `window.open`, utile hors application (page servie dans un navigateur).

const tauri = () => window.__TAURI__ || window.parent?.__TAURI__;

/**
 * Ouvre `url` hors de l'application. Renvoie `true` si un chemin a abouti.
 * N'ouvre que http(s) : le reste viendrait forcément d'un contenu distant.
 */
export async function openExternal(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return false;
  const invoke = tauri()?.core?.invoke;
  if (invoke) {
    try {
      await invoke("plugin:opener|open_url", { url: target });
      return true;
    } catch (error) {
      try {
        await invoke("open_external", { url: target });
        return true;
      } catch (fallbackError) { /* dernier recours ci-dessous */ }
    }
  }
  return Boolean(window.open(target, "_blank", "noopener"));
}

/**
 * Rend un `<a>` fonctionnel dans la WebView : le href reste (survol, menu
 * contextuel, accessibilité), mais le clic part vers le navigateur système.
 */
export function bindExternalLink(anchor) {
  if (!anchor) return anchor;
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(anchor.href);
  });
  return anchor;
}

/**
 * Prend en charge TOUS les liens sortants d'un conteneur, y compris ceux
 * générés plus tard (rendu markdown, cartes recomposées). Un seul écouteur.
 */
export function delegateExternalLinks(root = document) {
  root.addEventListener("click", (event) => {
    const anchor = event.target?.closest?.('a[href^="http"]');
    if (!anchor || anchor.dataset.internal === "1") return;
    event.preventDefault();
    openExternal(anchor.href);
  });
  return root;
}
