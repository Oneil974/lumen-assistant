// Comportements communs aux pages du site : thème clair/sombre, bascule FR/EN,
// apparition au défilement, année du copyright.
//
// La traduction se fait par attribut `data-en` posé sur l'élément qui porte le
// texte français (le contenu HTML est remplacé, puis restauré au retour en FR).
// L'ancienne version du site comparait des chaînes entières dans un
// dictionnaire : la moindre virgule modifiée dans le HTML faisait retomber la
// phrase en français sans prévenir. Ici, la traduction est à côté du texte.
(function () {
  const root = document.documentElement;

  /* ── Thème ─────────────────────────────────────────────────────────────── */
  const storedTheme = localStorage.getItem("lumenSiteTheme");
  if (storedTheme === "dark" || storedTheme === "light") root.setAttribute("data-dt-theme", storedTheme);

  function currentTheme() {
    return root.getAttribute("data-dt-theme")
      || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-dt-theme", next);
      localStorage.setItem("lumenSiteTheme", next);
    });
  });

  /* ── Langue ────────────────────────────────────────────────────────────── */
  const originals = new WeakMap();
  const frAttrs = new WeakMap();

  function applyLang(lang) {
    document.querySelectorAll("[data-en]").forEach((el) => {
      if (!originals.has(el)) originals.set(el, el.innerHTML);
      el.innerHTML = lang === "en" ? el.getAttribute("data-en") : originals.get(el);
    });
    // Attributs traduisibles : `data-en-<attr>` (title, alt, aria-label, content…).
    // Les valeurs françaises d'origine vont dans une Map annexe, et non dans
    // `dataset` : un nom comme `aria-label` contient un tiret, que l'API dataset
    // refuse (SyntaxError) — et l'exception interrompait tout le script.
    document.querySelectorAll("*").forEach((el) => {
      for (const attr of el.getAttributeNames()) {
        if (!attr.startsWith("data-en-")) continue;
        const target = attr.slice("data-en-".length);
        if (!frAttrs.has(el)) frAttrs.set(el, new Map());
        const saved = frAttrs.get(el);
        if (!saved.has(target)) saved.set(target, el.getAttribute(target) || "");
        el.setAttribute(target, lang === "en" ? el.getAttribute(attr) : saved.get(target));
      }
    });
    // Sources vidéo localisées : <video data-src-en="…">.
    document.querySelectorAll("video[data-src-en]").forEach((video) => {
      if (!originals.has(video)) originals.set(video, video.getAttribute("src") || "");
      const next = lang === "en" ? video.getAttribute("data-src-en") : originals.get(video);
      if (video.getAttribute("src") !== next) {
        const wasPlaying = !video.paused;
        video.setAttribute("src", next);
        video.load();
        if (wasPlaying) video.play().catch(() => {});
      }
    });
    root.lang = lang;
    document.querySelectorAll("[data-lang-toggle]").forEach((btn) => {
      btn.textContent = lang === "en" ? "FR" : "EN";
      btn.setAttribute("aria-label", lang === "en" ? "Passer en français" : "Switch to English");
    });
    localStorage.setItem("lumenSiteLang", lang);
  }

  const initialLang = localStorage.getItem("lumenSiteLang")
    || ((navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en");
  applyLang(initialLang);
  document.querySelectorAll("[data-lang-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => applyLang(root.lang === "en" ? "fr" : "en"));
  });

  /* ── Divers ────────────────────────────────────────────────────────────── */
  /* ── Orbe du héro ──────────────────────────────────────────────────────────
   * `assets/orb.js` est un module ES : il a besoin d'être servi en HTTP et d'un
   * WebGL disponible. Quand l'un des deux manque (page ouverte en file://,
   * import bloqué, GPU indisponible), rien ne s'affichait — juste un trou.
   * On garde donc le repli CSS visible tant que l'orbe three.js n'a pas
   * réellement pris la main, et on ne masque le canevas que dans le cas
   * contraire. Un module s'exécute avant `load`, d'où la vérification à ce
   * moment-là, avec deux relances pour un import lent.
   */
  const orbCanvas = document.getElementById("orb-canvas");
  const orbEyes = document.getElementById("orb-eyes");
  const orbFallback = document.querySelector(".hero-orb-fallback");

  function settleOrb() {
    if (!orbCanvas || !orbFallback) return true;
    const live = !!window.LumenOrb && orbCanvas.width > 0;
    if (live) {
      // L'orbe se dessine par défaut à sa taille dans l'application (116 px) ;
      // sur le site il en occupe 240. Sans ce recalage, le canevas est étiré et
      // le verre devient flou.
      window.LumenOrb.setSize?.(240);
      orbFallback.hidden = true;
    }
    return live;
  }

  window.addEventListener("load", () => {
    if (settleOrb()) return;
    let tries = 0;
    const retry = setInterval(() => {
      if (settleOrb() || ++tries > 6) {
        clearInterval(retry);
        if (!window.LumenOrb) {
          // Pas de WebGL : on retire le canevas vide et ses yeux, le repli CSS
          // porte déjà les siens.
          orbCanvas?.remove();
          orbEyes?.remove();
        }
      }
    }, 250);
  });

  const year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();

  const reveals = document.querySelectorAll(".reveal");
  // Marque la page comme « animée » : c'est cette classe qui autorise le CSS à
  // masquer les blocs avant leur apparition.
  if (reveals.length) root.classList.add("js");
  // Filet de sécurité : si l'observateur ne se déclenche pas (onglet en
  // arrière-plan, navigateur exotique), tout s'affiche au bout d'une seconde et
  // demie plutôt que de rester invisible.
  setTimeout(() => reveals.forEach((el) => el.classList.add("in")), 1500);
  if (reveals.length && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("in"));
  }
})();
