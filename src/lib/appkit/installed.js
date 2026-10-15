import { appOrigin } from "../platform-capabilities.js";
/**
 * Applications installées, vues du bureau.
 *
 * Le menu démarrer, le dock, la recherche globale et la boîte à outils lisaient jusqu'ici
 * une liste écrite en dur dans desktop.js. Depuis la 0.2 cette liste n'a plus
 * qu'un noyau : tout le reste s'installe et se désinstalle, et ce module est ce
 * qui fait la jonction — il transforme un paquet installé en entrée de menu de
 * la même forme que les entrées natives, pour que rien en aval n'ait à savoir
 * d'où vient l'app.
 *
 * Le cache est délibérément simple : on relit la liste au démarrage et à chaque
 * `lumen-apps-changed`. Une app installée doit apparaître sans redémarrer —
 * c'est la moindre des choses pour un store — mais interroger le disque à
 * chaque peinture du menu ne servirait à rien.
 */
import { mountAppHost } from "./host.js";
import { resolvedTheme, readAppearance, onAppearanceChange } from "../theme.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;

let installed = [];
const listeners = new Set();

/** Liste connue, sans attendre. Vide tant que `refresh()` n'a pas répondu. */
export function installedApps() {
  return installed;
}

/** Relit le registre. Rend la liste, et prévient les abonnés si elle a changé. */
export async function refreshInstalled() {
  try {
    const next = (await invoke("app_list")) || [];
    const changed = JSON.stringify(next.map((a) => `${a.id}@${a.version}`)) !==
      JSON.stringify(installed.map((a) => `${a.id}@${a.version}`));
    installed = next;
    if (changed) for (const fn of listeners) { try { fn(installed); } catch {} }
  } catch {
    // Un registre illisible ne doit pas vider le menu de quelqu'un : on garde
    // la dernière liste connue.
  }
  return installed;
}

/** S'abonne aux changements du registre. Rend la fonction de désabonnement. */
export function onInstalledChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (window.__TAURI__?.event) {
  window.__TAURI__.event.listen("lumen-apps-changed", () => refreshInstalled());
}

/**
 * URL de la page d'entrée d'une app installée, sur son origine propre.
 *
 * L'onglet initial passe par le FRAGMENT, pas par le stockage : l'app vit sur
 * une autre origine, son `localStorage` n'est donc pas celui du bureau. Écrire
 * la préférence côté bureau n'aurait simplement aucun effet — en silence.
 */
/** Clés localStorage de Lumen que les apps packagées doivent voir. */
const SETTINGS_KEYS = [
  "orbTheme", "orbColors", "orbGlassType", "orbCoreScale", "orbPulse", "orbHeartbeat",
  "orbHeartColor", "orbPulseStrength", "orbPulseSpeed", "orbMouth", "orbAvatarMode", "orbAvatarUrl", "orbSize", "orbMoods", "avatarGlbAmbientLight",
  "aiSource", "selectedModel", "ollamaUrl", "apiBaseUrl", "apiModel", "lumenModel", "applefmModel",
  "lang", "systemPrompt", "ollamaNumCtx", "llamaNumCtx", "ollamaThink", "ollamaNumPredict", "ollamaKeepAlive",
  "selectedModel:ollama", "selectedModel:llama",
  // Moteur d'image et son modèle par moteur (lib/image-provider.js) : sans ce
  // relais, le Studio ou le Canvas packagés retombaient sur Bonsai/ternary
  // quels que soient les Réglages.
  "imageProvider", "imageBonsaiModel", "imageOllamaModel", "imageOpenaiModel", "imagePlaygroundStyle",
  "bonsaiUrl", "canvasBonsaiKind",
];

/** Relais des réglages vers chaque app ouverte (cf. openInstalledApp). */
const settingsPushers = new Set();

/**
 * Pousse les réglages courants (source d'IA, modèle, moteur d'image…) à toutes
 * les apps packagées ouvertes. À appeler après toute écriture locale d'une clé
 * de `SETTINGS_KEYS` faite PAR le bureau : l'événement `storage` ne couvre que
 * les écritures venues d'une autre fenêtre.
 */
export function broadcastSettings() {
  for (const push of settingsPushers) { try { push(); } catch { /* app en cours de fermeture */ } }
}

/**
 * Racine du schéma `lumenapp` selon la plateforme. WebView2 (Windows) et
 * Android ne servent pas un schéma personnalisé sous son nom : Tauri l'expose
 * en `http://lumenapp.localhost/…`, et l'identifiant d'app devient le premier
 * segment du chemin (cf. `split_target` dans appserve.rs). Une iframe pointée
 * sur `lumenapp://` y reste blanche.
 */

export function appUrl(manifest, tab = "") {
  const entry = String(manifest.entry || "index.html").replace(/^\/+/, "");
  const fragment = tab ? `#tab=${encodeURIComponent(tab)}` : "";
  return `${appOrigin(manifest.id)}/${entry}${fragment}`;
}

/**
 * Ouvre une app installée dans une fenêtre du bureau.
 *
 * @param {object} manifest  Manifeste rendu par `app_list`.
 * @param {object} shell     Ce que le bureau prête : `createWindow`, `focusWindow`,
 *                           `openWindows`, `applyFrameTheme`, `framePermissions`.
 * @param {string} [tab]     Onglet à ouvrir d'emblée, pour les paquets-hubs.
 */
export function openInstalledApp(manifest, shell, tab = "") {
  const { createWindow, focusWindow, openWindows, applyFrameTheme, framePermissions } = shell;
  if (openWindows?.get(manifest.id)) return focusWindow(manifest.id);

  const win = createWindow({
    id: manifest.id,
    title: manifest.name,
    w: manifest.width || 1120,
    h: manifest.height || 780,
    x: 90 + Math.round(Math.random() * 40),
    y: 52 + Math.round(Math.random() * 30),
  });
  win.body.style.padding = "0";

  const frame = document.createElement("iframe");
  frame.className = "dt-appframe";
  if (framePermissions) frame.allow = framePermissions;
  frame.src = appUrl(manifest, tab);

  // L'app vit sur une AUTRE origine : on ne peut plus lui poser le thème en
  // touchant son document. On le lui envoie par le pont, et le SDK le pose.
  const host = mountAppHost({
    frame,
    app: manifest,
    onTitle: (title) => { if (title) win.setTitle?.(title); },
    appNameOf: (id) => installed.find((a) => a.id === id)?.name || id,
  });

  // Une app packagée vit sur une AUTRE origine : on ne peut pas lui poser le
  // thème en touchant son document. On le lui ENVOIE, au chargement puis à
  // chaque changement — sans quoi basculer Lumen en sombre laissait les apps
  // installées en clair jusqu'à leur réouverture.
  const pushTheme = () => host.emit("theme", {
    theme: resolvedTheme(),
    // `accent` est l'IDENTIFIANT d'accent (posé en `data-ui-accent`), `primary`
    // la couleur calculée. Les confondre ferait poser un `#rrggbb` là où le CSS
    // attend un nom de palette, et l'app perdrait sa couleur d'action.
    ...readAppearance(),
    primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
  });
  const stopWatching = onAppearanceChange(pushTheme);

  // Réglages de Lumen (source d'IA, modèle, langue…) : l'app les reçoit en
  // instantané au chargement (injecté par appserve.rs) puis en direct ici —
  // un changement dans la fenêtre Réglages arrive par l'événement `storage`.
  const pushSettings = () => host.emit("settings", Object.fromEntries(
    SETTINGS_KEYS.map((k) => [k, localStorage.getItem(k) ?? ""]),
  ));
  const onStorage = (e) => { if (!e.key || SETTINGS_KEYS.includes(e.key)) pushSettings(); };
  window.addEventListener("storage", onStorage);
  // `storage` ne se déclenche JAMAIS dans la fenêtre qui écrit : un changement
  // de source d'IA fait depuis la barre du bureau lui-même ne parvenait pas aux
  // apps ouvertes, qui continuaient d'appeler l'ancien backend (« clé API
  // manquante » après un passage Apple → llama.cpp). Le bureau appelle donc
  // `broadcastSettings()` après ses propres écritures.
  settingsPushers.add(pushSettings);

  frame.addEventListener("load", () => {
    pushTheme();
    pushSettings();
    // Les apps first-party sont du même code qu'avant : celles qui savent lire
    // le thème par le DOM continuent de le faire quand elles le peuvent.
    try { applyFrameTheme?.(frame.contentDocument.documentElement); } catch { /* autre origine */ }
  });

  // Fermer la fenêtre doit couper le pont : sinon les outils publiés par l'app
  // restent au catalogue des agents, sans personne pour y répondre.
  win.onClose?.(() => { stopWatching(); window.removeEventListener("storage", onStorage); settingsPushers.delete(pushSettings); host.dispose(); });

  // Le bureau retrouve le pont depuis l'iframe (« Résumer cette fenêtre »).
  frame.__lumenHost = host;
  win.body.appendChild(frame);
  return win;
}

/** Entrée de menu démarrer pour une app installée. */
export function toMenuEntry(manifest, shell, icons) {
  return {
    id: manifest.id,
    cat: manifest.category || "create",
    name: manifest.name,
    desc: manifest.description || "",
    grad: manifest.gradient?.length >= 2 ? manifest.gradient : ["#0a84ff", "#5e5ce6"],
    icon: icons(manifest.icon || "grid"),
    pro: !!manifest.pro,
    installed: true,
    action: () => openInstalledApp(manifest, shell),
  };
}
