/*
 * Apparence de Lumen — LE script d'amorçage, exécuté avant le premier rendu.
 *
 * Il remplace quatre fichiers qui faisaient chacun un morceau du travail, dans
 * un ordre différent selon les pages : `dt-theme-init.js`, son quasi-jumeau
 * `dt-theme-accent-init.js` (58 lignes identiques à une purge près),
 * `ui-theme-init.js` et la partie thème de `pro-edition-init.js`. Une page en
 * chargeait deux, une autre trois, une troisième dans l'autre sens — d'où des
 * fenêtres qui s'ouvraient dans un habillage puis sautaient dans un autre.
 *
 * Tout l'état d'apparence tient désormais en un seul passage, sur <html> :
 *
 *   data-theme        light | dark        clair/sombre RÉSOLU (jamais « auto »)
 *   data-dt-theme     idem                alias historique, lu par tokens.css
 *   data-ui-base      teinte des gris
 *   data-ui-accent    couleur d'action
 *   data-ui-icons     habillage des pastilles d'icônes
 *   data-skin         metal               (+ data-skin-flavor : gold | red | premium)
 *   --radius          rayon de base
 *
 * `data-theme` et `data-dt-theme` portent la MÊME valeur, toujours. Le second
 * n'existe que parce que 84 règles de lib/tokens.css et des dizaines de
 * feuilles d'app le nomment ; le premier est celui qu'on écrit désormais.
 *
 * Script CLASSIQUE, pas un module : il doit s'exécuter en tête de <head>, avant
 * toute feuille de style, et la CSP n'autorise que `script-src 'self'`.
 */
(function () {
  "use strict";

  var KEY = "lumenTheme";           // light | dark | auto
  var LEGACY_BAR = "themePreference";
  var LEGACY_UI = "dtTheme";

  // Saveur métal effective : la clé `proFlavor` (nom historique), sinon or pour
  // une édition Pro, sinon rien (habillage standard). "" = pas de métal.
  function metalFlavor() {
    // Depuis le 15/09/2026, l'habillage par défaut est le STANDARD (shadcn)
    // pour toutes les éditions : le métal ne s'applique que s'il a été choisi
    // dans Réglages → Apparence.
    // 09/10/2026 : habillages métal (or, rouge, premium) retirés — l'ancien
    // choix est purgé, tout le monde est en habillage standard.
    try { localStorage.removeItem("proFlavor"); } catch (e) {}
    return "";
  }

  function get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  /**
   * Préférence de l'utilisateur, sur l'échelle unique.
   *
   * L'ordre de repli raconte l'histoire du réglage : la clé unifiée d'abord,
   * puis les deux anciennes (« Interface » avant « Barre de chat », parce que
   * c'était celle qui pilotait le plus de surfaces), puis le profil du bureau,
   * puis l'édition. Une valeur absente n'est PAS « clair » : c'est « auto ».
   */
  function preference() {
    var v = get(KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;

    var legacy = get(LEGACY_UI);
    if (legacy === "auto") return "auto";
    if (legacy === "light" || legacy === "dark") return legacy;

    // Le bureau préfixe sa clé par le profil actif (`profile:<id>:dtTheme`).
    // La fenêtre hôte l'expose quand elle est de même origine ; sinon on prend
    // la première clé de profil venue, ce qui vaut mieux que le thème système
    // pour une fenêtre secondaire qui ignore le profil courant.
    try {
      var prefix = window.parent && window.parent.__LUMEN_PROFILE_STORAGE_PREFIX__;
      if (prefix) {
        var scoped = get(prefix + LEGACY_UI);
        if (scoped === "auto") return "auto";
        if (scoped === "light" || scoped === "dark") return scoped;
      }
    } catch (e) { /* origine différente : on continue */ }
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.slice(-8) === ":dtTheme") {
          var val = get(k);
          if (val === "auto") return "auto";
          if (val === "light" || val === "dark") return val;
        }
      }
    } catch (e) {}

    var bar = get(LEGACY_BAR);
    if (bar === "light" || bar === "dark") return bar;

    // Édition Pro sans choix explicite : sombre. Le cache d'édition est écrit
    // par lib/pro-edition.js ; on le lit ici plutôt que d'attendre son module,
    // pour ne pas dépendre de l'ordre des scripts.
    // Les habillages métal (or, rouge, premium) sont conçus sur fond sombre.
    if (metalFlavor()) return "dark";
    return "auto";
  }

  /** Le clair/sombre effectif : « auto » demande son avis au système. */
  function resolved() {
    var pref = preference();
    if (pref === "light" || pref === "dark") return pref;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  }

  function apply() {
    var root = document.documentElement;
    if (!root) return;

    var theme = resolved();
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-dt-theme", theme);

    root.setAttribute("data-ui-base", get("uiBase") || "neutral");

    var accent = get("uiAccent");
    if (accent) root.setAttribute("data-ui-accent", accent);
    else root.removeAttribute("data-ui-accent");

    var icons = get("uiIcons");
    if (icons) root.setAttribute("data-ui-icons", icons);
    else root.removeAttribute("data-ui-icons");

    var radius = get("uiRadius");
    if (radius) root.style.setProperty("--radius", radius + "px");

    // Habillage métal (or, rouge, premium) : `data-skin` déclenche
    // lib/pro-skin.css et la palette assortie de l'orbe. Un thème d'apparence
    // comme un autre, ouvert à toutes les éditions ; reposé ici depuis le cache,
    // avant le rendu, pour qu'aucune fenêtre ne s'ouvre en standard puis bascule.
    // Mode performance (Raspberry Pi) : le trait est posé sur TOUTES les
    // fenêtres, pas seulement celles qui portent l'orbe — c'est le bureau et
    // ses panneaux qui composent le plus de couches. orb.js le pose aussi de
    // son côté, avant même ce script sur la barre, pour n'allumer aucun
    // contexte WebGL.
    if (get("lumenPerfMode") === "true") root.classList.add("perf-mode");
    else root.classList.remove("perf-mode");

    var flavor = metalFlavor();
    if (flavor) {
      root.setAttribute("data-skin", "metal");
      if (flavor === "red" || flavor === "premium") root.setAttribute("data-skin-flavor", flavor);
      else root.removeAttribute("data-skin-flavor");
    } else {
      root.removeAttribute("data-skin");
      root.removeAttribute("data-skin-flavor");
    }
  }

  apply();

  // Une autre fenêtre a changé l'apparence : on suit, sans rechargement. Le
  // filtre est volontairement large — mieux vaut un recalcul de trop qu'une
  // fenêtre restée dans l'ancien habillage.
  window.addEventListener("storage", function (e) {
    if (!e || !e.key) { apply(); return; }
    if (e.key === KEY || e.key.slice(-7) === "dtTheme" || e.key === LEGACY_BAR ||
        e.key.indexOf("ui") === 0 || e.key === "lumenEdition" || e.key === "proFlavor" ||
        e.key === "lumenPerfMode") {
      apply();
    }
  });

  // En mode « auto », le thème du système peut changer pendant que Lumen tourne
  // (bascule programmée au coucher du soleil sur macOS). Sans cet écouteur, la
  // fenêtre restait dans le thème du démarrage jusqu'au prochain lancement.
  try {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onSystem = function () { if (preference() === "auto") apply(); };
    if (mq.addEventListener) mq.addEventListener("change", onSystem);
    else if (mq.addListener) mq.addListener(onSystem);
  } catch (e) {}

  // Exposé pour lib/theme.js, qui repeint sans recharger la page.
  window.__lumenApplyTheme = apply;
})();
