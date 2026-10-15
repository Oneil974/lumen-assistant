// Choix du mode de Lumen au lancement : barre flottante, application, bureau.
//
// La fenêtre principale démarre CACHÉE (tauri.conf.json). Au chargement,
// main.js appelle `bootShell()` qui :
//   - laisse passer l'assistant de premier démarrage (l'écran de choix suit sa
//     fermeture) ;
//   - applique le mode mémorisé (« Toujours ouvrir ce mode ») ;
//   - sinon ouvre l'écran de choix (launcher/launcher.html), qui répond par
//     `apply_shell_choice` → évènement `shell-mode` vers cette fenêtre.
//
// Clés localStorage (partagées par toutes les fenêtres) :
//   shellMode      "bar" | "app" | "desktop"  — dernier choix
//   shellRemember  "true" → plus d'écran de choix au lancement
// sessionStorage `shellNext` : mode à appliquer après un rechargement (sortir
// du mode application recharge la page plutôt que de défaire la mise en page).

const MODES = ["bar", "app", "desktop"];
let current = null;

export function shellMode() { return current; }
export function isAppShell() { return current === "app"; }

function store(k, v) { try { localStorage.setItem(k, v); } catch {} }
function read(k) { try { return localStorage.getItem(k); } catch { return null; } }

/**
 * @param {object} o
 *   invoke, listen          API Tauri
 *   onboardingDone()        bool
 *   openOnboarding()        ouvre l'assistant de premier démarrage
 *   applyApp()              monte la mise en page « application » (lib/app-shell.js)
 *   applyBar()              réglages normaux de la barre (taille, premier plan…)
 *   onBarShown(firstTime)   ex. mini-visite de la barre
 */
export async function bootShell(o) {
  const { invoke, listen } = o;

  // Ancien réglage « ouvrir Lumen Desktop au démarrage » → mode mémorisé.
  if (read("startupLumenOS") === "true" && !read("shellMode")) {
    store("shellMode", "desktop");
    store("shellRemember", "true");
  }

  // Les écouteurs DOIVENT être enregistrés avant d'ouvrir l'écran de choix :
  // `listen()` est asynchrone et Rust peut répondre aussitôt (LUMEN_SHELL,
  // choix très rapide) — l'évènement serait perdu et la fenêtre resterait
  // cachée jusqu'au filet de sécurité.
  const ready = [];
  ready.push(listen?.("shell-mode", (e) => {
    const p = e?.payload || {};
    // Bureau déjà ouvert côté Rust : on note seulement le mode courant.
    if (p.mode === "desktop" && p.handled) { current = "desktop"; store("shellMode", "desktop"); return; }
    applyMode(o, p.mode);
  }));
  // Le bureau se ferme alors qu'on était en mode bureau : la barre est cachée,
  // il ne resterait rien à l'écran → on repropose le choix.
  ready.push(listen?.("desktop-mode", (e) => {
    if (e?.payload?.active === false && current === "desktop") openPicker(invoke, o);
  }));
  ready.push(listen?.("onboarding-finished", () => {
    try { sessionStorage.setItem("shellFirstRun", "1"); } catch {}
    openPicker(invoke, o);
  }));
  await Promise.all(ready.map((p) => Promise.resolve(p).catch(() => {})));

  let next = null;
  try { next = sessionStorage.getItem("shellNext"); sessionStorage.removeItem("shellNext"); } catch {}
  if (MODES.includes(next)) return applyMode(o, next);

  if (!o.onboardingDone()) {
    // L'assistant s'ouvre dans sa propre fenêtre ; s'il échoue, il retombe sur
    // le panneau intégré de la barre → la barre doit alors être visible.
    o.openOnboarding();
    return;
  }
  const saved = read("shellMode");
  if (read("shellRemember") === "true" && MODES.includes(saved)) return applyMode(o, saved);
  openPicker(invoke, o);
}

async function openPicker(invoke, o) {
  try { await invoke("open_mode_picker"); }
  catch (e) {
    console.error("Écran de choix indisponible :", e);
    applyMode(o, read("shellMode") || "bar");
  }
}

/** Applique un mode (appelé au boot ou par l'évènement `shell-mode`). */
export async function applyMode(o, mode) {
  if (!MODES.includes(mode)) mode = "bar";
  const { invoke } = o;
  store("shellMode", mode);
  if (mode === "desktop") {
    current = "desktop";
    // apply_shell_choice cache la barre et ouvre le bureau.
    try { await invoke("apply_shell_choice", { mode: "desktop" }); } catch (e) { console.error(e); applyMode(o, "bar"); }
    return;
  }
  // Quitter le mode application : on recharge (la mise en page déplace des
  // nœuds ; les remettre un à un serait fragile).
  if (mode === "bar" && document.documentElement.classList.contains("shell-app")) {
    try { sessionStorage.setItem("shellNext", "bar"); } catch {}
    await invoke("set_shell_mode", { mode: "bar" }).catch(() => {});
    location.reload();
    return;
  }
  current = mode;
  if (mode === "app") {
    o.applyApp();
    await invoke("set_shell_mode", { mode: "app" }).catch((e) => console.error(e));
    return;
  }
  await invoke("set_shell_mode", { mode: "bar" }).catch(() => {});
  o.applyBar?.();
  let first = false;
  try { first = sessionStorage.getItem("shellFirstRun") === "1"; sessionStorage.removeItem("shellFirstRun"); } catch {}
  o.onBarShown?.(first);
}

/** « Changer de mode » (app, réglages…) : rouvre l'écran de choix. */
export function changeMode(invoke) {
  return invoke("open_mode_picker");
}
