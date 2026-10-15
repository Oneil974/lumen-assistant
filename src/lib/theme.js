/**
 * Apparence de Lumen — l'API, côté modules.
 *
 * `lib/theme-init.js` pose l'habillage avant le rendu ; ce module-ci le LIT et
 * le MODIFIE. Les deux partagent exactement les mêmes clés, et c'est le seul
 * endroit d'où l'on écrit : un réglage posé ailleurs finirait par diverger de
 * ce que l'amorçage relit au démarrage suivant.
 *
 * Un seul clair/sombre pour tout Lumen. Il y en avait deux — « Barre de chat »
 * (`themePreference`) et « Interface » (`dtTheme`) — deux réglages pour une
 * question que personne ne se pose en ces termes, et deux occasions de se
 * retrouver avec une barre claire au-dessus d'un bureau sombre. La bascule est
 * désormais unique ; les anciennes clés ne sont plus que des sources de
 * migration, relues une fois puis remplacées.
 */

const KEY = "lumenTheme";
const UI_KEYS = { base: "uiBase", accent: "uiAccent", radius: "uiRadius", icons: "uiIcons" };

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => {
  try {
    if (value === null || value === undefined || value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch { /* stockage indisponible : le réglage ne survit pas à la session */ }
};

/** Préférence choisie : `light`, `dark` ou `auto`. */
export function themePreference() {
  const v = read(KEY);
  return v === "light" || v === "dark" || v === "auto" ? v : migrated();
}

/**
 * Ce que valaient les anciens réglages, quand la clé unifiée n'existe pas
 * encore. On ne l'écrit pas au passage : la migration se fait à la première
 * ÉCRITURE délibérée, pour qu'une simple lecture ne fige pas un choix que
 * l'utilisateur n'a jamais fait.
 */
function migrated() {
  const ui = read("dtTheme");
  if (ui === "auto" || ui === "light" || ui === "dark") return ui;
  const bar = read("themePreference");
  if (bar === "light" || bar === "dark") return bar;
  return "auto";
}

/** Le clair/sombre effectif, « auto » résolu contre le système. */
export function resolvedTheme() {
  const pref = themePreference();
  if (pref === "light" || pref === "dark") return pref;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * Change le clair/sombre, partout et tout de suite.
 *
 * Les anciennes clés sont écrites AUSSI, tant que des surfaces les lisent
 * encore (la barre de chat, la capsule, le bureau par profil). Les laisser
 * derrière donnerait une fenêtre qui suit et une autre qui ne suit pas — le
 * défaut exact qu'on corrige ici.
 */
export function setTheme(preference) {
  const next = ["light", "dark", "auto"].includes(preference) ? preference : "auto";
  write(KEY, next);
  write("dtTheme", next);
  // `themePreference` ne connaît pas « auto » : on lui donne la valeur résolue,
  // sinon la barre retomberait sur son défaut sombre.
  write("themePreference", next === "auto" ? resolvedTheme() : next);
  applyTheme();
  return next;
}

/** Habillage : teinte de fond, couleur d'action, arrondi, style d'icônes. */
export function readAppearance() {
  return {
    base: read(UI_KEYS.base) || "neutral",
    accent: read(UI_KEYS.accent) || "",
    radius: read(UI_KEYS.radius) || "10",
    icons: read(UI_KEYS.icons) || "",
  };
}

/** Modifie l'habillage et le repeint immédiatement. */
export function setAppearance(patch) {
  const next = { ...readAppearance(), ...patch };
  write(UI_KEYS.base, next.base || "neutral");
  write(UI_KEYS.accent, next.accent);
  write(UI_KEYS.radius, String(Number(next.radius) || 10));
  write(UI_KEYS.icons, next.icons);
  applyTheme();
  return next;
}

/**
 * Repose tout l'habillage sur `<html>`.
 *
 * Délègue à l'amorçage quand il est là : une seule implémentation, donc pas de
 * risque que la version « au démarrage » et la version « au changement » se
 * mettent à diverger. Le repli couvre les contextes sans amorçage (une fenêtre
 * montée entièrement en JS, un test).
 */
export function applyTheme() {
  if (typeof window.__lumenApplyTheme === "function") {
    window.__lumenApplyTheme();
    notify();
    return;
  }
  const root = document.documentElement;
  const theme = resolvedTheme();
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-dt-theme", theme);
  const ui = readAppearance();
  root.setAttribute("data-ui-base", ui.base);
  if (ui.accent) root.setAttribute("data-ui-accent", ui.accent);
  else root.removeAttribute("data-ui-accent");
  if (ui.icons) root.setAttribute("data-ui-icons", ui.icons);
  else root.removeAttribute("data-ui-icons");
  root.style.setProperty("--radius", `${Number(ui.radius) || 10}px`);
  notify();
}

const listeners = new Set();
function notify() {
  const detail = { theme: resolvedTheme(), preference: themePreference(), ...readAppearance() };
  for (const fn of listeners) { try { fn(detail); } catch { /* un abonné cassé n'en empêche pas un autre */ } }
  try { window.dispatchEvent(new CustomEvent("lumen-appearance", { detail })); } catch {}
}

/** S'abonne aux changements d'apparence. Rend la fonction de désabonnement. */
export function onAppearanceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Un changement venu d'une autre fenêtre passe par `storage` : l'amorçage a
// déjà reposé les attributs, il reste à prévenir les abonnés de CETTE fenêtre.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e?.key) return;
    if (e.key === KEY || e.key.endsWith("dtTheme") || e.key === "themePreference" ||
        Object.values(UI_KEYS).includes(e.key)) notify();
  });
}
