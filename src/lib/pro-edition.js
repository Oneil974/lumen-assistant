// Applications métier (Relia, Réunion, DB Studio, Reporting…).
//
// IL N'Y A PLUS D'ÉDITION PRO : ces applications sont ouvertes à tous, sans
// licence. `pro_enabled` ne dit plus que « le binaire les embarque » (feature
// Cargo `pro`, activée par défaut). La seule licence restante concerne Lumen
// Server (cf. src-tauri/src/license.rs) et se lit avec `serverLicensed()`.
// Les habillages métal restent des thèmes au choix, sans lien avec une édition.
//
// Ancien fonctionnement, pour mémoire :
//
// Le binaire dit lui-même s'il est Pro : la commande Rust `pro_enabled` renvoie
// vrai quand la feature `pro` est compilée (c'est le défaut depuis la 0.2) ET
// qu'une clé de licence valide est installée sur le poste (Paramètres →
// Applications et licence). Rien ici ne se déverrouille depuis l'interface, un
// localStorage ou un fichier — sinon « Pro » ne serait qu'un décor.
//
// Règle de repli : en cas de doute (IPC pas encore prête, commande absente d'un
// build plus ancien, erreur), on répond **non**. Une app Pro affichée par erreur
// dans une édition standard ouvrirait une fenêtre vide ; l'inverse ne coûte
// qu'un rafraîchissement du menu, que `whenProResolved` déclenche.

const localStorage_edition = () => {
  try { return localStorage.getItem("lumenEdition"); } catch { return null; }
};

const call = () => (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;

// `null` = pas encore su. On ne met en cache QUE la réponse d'une commande qui a
// répondu : un échec au démarrage ne doit pas condamner la session.
let cached = null;
let pending = null;
const listeners = new Set();

/** Vrai si ce build est une édition Pro. Asynchrone, mise en cache. */
export async function proEnabled() {
  if (cached !== null) return cached;
  if (pending) return pending;
  pending = (async () => {
    let on = false;
    let answered = false;
    try {
      const invoke = call();
      if (invoke) { on = !!(await invoke("pro_enabled")); answered = true; }
    } catch { on = false; }
    if (on) cached = true;
    else if (answered) cached = false; // l'IPC a répondu « non » : c'est un fait.
    if (answered) applyEditionSkin(on);
    pending = null;
    for (const fn of listeners) { try { fn(on); } catch {} }
    return on;
  })();
  return pending;
}

/**
 * Pose (ou retire) le trait d'habillage de l'édition sur la racine du document,
 * et mémorise la réponse pour la fenêtre suivante.
 *
 * Le trait `data-skin="metal"` est ce qui déclenche lib/pro-skin.css et la
 * palette assortie de l'orbe. Il suit l'HABILLAGE choisi (proFlavor), pas
 * l'édition ; lib/theme-init.js l'avait déjà posé depuis le cache, avant le
 * rendu, pour éviter le clignotement.
 */
/** Saveurs d'habillage de l'édition Pro. `gold` est le défaut, sans attribut.
 *
 * `standard` n'est pas un métal : c'est l'apparence ORDINAIRE de Lumen, offerte
 * aussi aux éditions Pro. Sans elle, l'habillage Pro s'imposait à tous les
 * thèmes — on pouvait choisir son métal, jamais s'en passer. Elle ne retire
 * aucune fonctionnalité Pro : seul l'habillage change. */
// Habillages métal retirés le 09/10/2026 : seul le standard reste.
export const PRO_FLAVORS = ["standard"];

/**
 * Habillage enregistré. Sans choix : « standard » (la grammaire shadcn de
 * Lumen), quelle que soit l'édition. Les métaux sont des thèmes ouverts à
 * tous, à choisir explicitement dans Réglages → Apparence.
 */
export function proFlavor() {
  return "standard";
}

/**
 * Change la saveur et la repeint immédiatement, dans cette fenêtre.
 *
 * Les autres fenêtres suivent par l'évènement `storage` (cf. plus bas) : sans
 * cela, changer d'habillage depuis les réglages laissait le bureau et la
 * capsule dans l'ancienne teinte jusqu'au redémarrage.
 */
export function setProFlavor(flavor) {
  const next = PRO_FLAVORS.includes(flavor) ? flavor : "standard";
  const had = document.documentElement.dataset.skin === "metal";
  try { localStorage.setItem("proFlavor", next); } catch {}
  applyFlavor();
  // Passer à « standard » (ou en revenir) allume ou éteint l'habillage : les
  // surfaces peintes en JS (orbe WebGL) doivent le réapprendre.
  const now = document.documentElement.dataset.skin === "metal";
  if (had !== now) {
    window.dispatchEvent(new CustomEvent("lumen-edition", { detail: { pro: now } }));
  }
  return next;
}

/** Vrai si l'habillage métal (or, rouge, premium) est actif dans cette fenêtre. */
export function metalSkinActive() {
  return document.documentElement.dataset.skin === "metal";
}

function applyFlavor() {
  const root = document.documentElement;
  // `data-skin="metal"` est le seul sélecteur que connaissent pro-skin.css et
  // la palette de l'orbe. Il ne dépend PLUS de l'édition : les apps Pro, elles,
  // dépendent de `proEnabled()`, pas de cet attribut.
  const flavor = proFlavor();
  if (flavor === "standard") {
    root.removeAttribute("data-skin");
    root.removeAttribute("data-skin-flavor");
    return;
  }
  root.setAttribute("data-skin", "metal");
  // « gold » est le défaut du fichier de style : pas d'attribut à poser.
  if (flavor === "gold") root.removeAttribute("data-skin-flavor");
  else root.setAttribute("data-skin-flavor", flavor);
}

// Une fenêtre qui n'a pas changé la saveur doit quand même la refléter.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e && e.key === "proFlavor") applyFlavor();
  });
}

function applyEditionSkin(on) {
  const root = document.documentElement;
  const had = root.dataset.skin === "metal";
  // L'édition ne pilote plus l'habillage : elle ne sert qu'à choisir le défaut
  // (or pour une Pro qui n'a rien choisi) — cf. proFlavor().
  // Plus d'édition distincte : aucune apparence « Pro » imposée par défaut.
  void on;
  try { localStorage.setItem("lumenEdition", "std"); } catch { /* stockage indisponible */ }
  applyFlavor();
  // Les surfaces déjà peintes (orbe WebGL, palettes calculées en JS) ne relisent
  // pas le CSS : on les prévient, une seule fois, et seulement si ça a changé.
  const skin = root.dataset.skin === "metal";
  if (had !== skin) {
    window.dispatchEvent(new CustomEvent("lumen-edition", { detail: { pro: skin } }));
  }
}

/** Réponse déjà connue, sans attendre. `false` tant qu'on ne sait pas. */
export const proEnabledSync = () => cached === true;

/**
 * Rappelle `fn(on)` dès que l'édition est connue — immédiatement si elle l'est
 * déjà. Sert aux surfaces peintes avant la réponse (menu démarrer, dock).
 */
export function whenProResolved(fn) {
  if (cached !== null) { fn(cached); return; }
  listeners.add(fn);
  proEnabled();
}

/**
 * Nom du produit porté par le bundle : « Lumen » ou « Lumen Pro ». Sert aux
 * surfaces qui affichent le nom de l'application (réglages, à propos), pour
 * qu'elles ne le réécrivent pas en dur.
 * @returns {Promise<string>}
 */
export async function productName() {
  try {
    const invoke = call();
    if (invoke) {
      const name = await invoke("product_name");
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  } catch { /* on retombe sur le nom de base */ }
  return "Lumen";
}

/**
 * Licence Lumen Server active sur ce poste ? (La seule licence qui existe
 * encore : elle conditionne la liaison et l'exécution d'agents sur un serveur.)
 */
export async function serverLicensed() {
  try {
    const st = await call()?.("license_status");
    return !!st?.active;
  } catch { return false; }
}

/**
 * Garde d'entrée des pages Pro : une app Pro ouverte dans une édition standard
 * (URL forcée, favori, ancien raccourci) doit le dire au lieu d'afficher une
 * coquille vide.
 * @returns {Promise<boolean>} vrai si la page peut continuer à se monter.
 */
export async function requireProPage({ appName = "Cette application" } = {}) {
  // Plus de licence d'application : seule une build compilée sans la feature
  // `pro` (sans les commandes Rust de ces apps) arrive encore ici.
  if (await proEnabled()) return true;
  document.body.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;padding:32px;font:14px/1.6 system-ui,sans-serif;color:#666;text-align:center">
    <div><div style="font-size:15px;font-weight:600;color:#222;margin-bottom:6px">${appName} n'est pas incluse dans ce build</div>
    <div>Cette version de Lumen a été compilée sans les applications métier (feature « pro »).</div></div></div>`;
  return false;
}
