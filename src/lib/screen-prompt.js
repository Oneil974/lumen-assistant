// Composeur de question pour « Comprendre cet écran ».
//
// Le geste envoyait jusqu'ici une question figée, écrite en dur : l'utilisateur
// ne pouvait pas demander autre chose que « explique ce qui est affiché ». Cette
// petite feuille présente la question par défaut, DÉJÀ REMPLIE et modifiable, et
// n'envoie qu'après validation. Partagée par la barre Lumen (icône de la barre
// de menus) et par le bureau Lumen Desktop, pour que le geste soit le même partout.
//
// Important : la feuille fait partie de l'écran. L'appelant doit la fermer AVANT
// de capturer — d'où `waitForRepaint()`, utilisé après la validation.

const DEFAULT_LABELS = {
  fr: {
    title: "Comprendre cet écran",
    hint: "Cette question part avec la capture. Modifiez-la si besoin.",
    send: "Envoyer",
    cancel: "Annuler",
    reset: "Question par défaut",
    shortcut: "⌘/Ctrl + Entrée pour envoyer",
  },
  en: {
    title: "Understand this screen",
    hint: "This question is sent with the screenshot. Edit it if you like.",
    send: "Send",
    cancel: "Cancel",
    reset: "Default question",
    shortcut: "⌘/Ctrl + Enter to send",
  },
};

const esc = (s) => {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
};

/**
 * Ouvre le composeur. Résout avec la question finale, ou `null` si l'utilisateur
 * annule (Échap, clic hors de la feuille, bouton Annuler).
 *
 * @param {object} o
 * @param {string} o.defaultPrompt  question pré-remplie
 * @param {string} [o.title]        titre de la feuille
 * @param {string} [o.lang]         "fr" | "en" (défaut : langue de l'app)
 * @param {object} [o.labels]       surcharge des libellés
 */
export function askScreenPrompt({ defaultPrompt, title, lang, labels } = {}) {
  const code = (lang || localStorage.getItem("lang") || navigator.language || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const L = { ...DEFAULT_LABELS[code], ...(labels || {}) };
  const base = String(defaultPrompt || "");

  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "lumen-shot-ask";
    el.innerHTML = `
      <div class="lumen-shot-card" role="dialog" aria-modal="true" aria-label="${esc(title || L.title)}">
        <div class="lumen-shot-head">
          <span class="lumen-shot-ic">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>
          </span>
          <strong>${esc(title || L.title)}</strong>
        </div>
        <p class="lumen-shot-hint">${esc(L.hint)}</p>
        <textarea class="lumen-shot-input" rows="4" spellcheck="true"></textarea>
        <div class="lumen-shot-foot">
          <button type="button" class="lumen-shot-link" data-act="reset">${esc(L.reset)}</button>
          <span class="lumen-shot-kbd">${esc(L.shortcut)}</span>
          <button type="button" class="lumen-shot-btn" data-act="cancel">${esc(L.cancel)}</button>
          <button type="button" class="lumen-shot-btn primary" data-act="send">${esc(L.send)}</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    const input = el.querySelector(".lumen-shot-input");
    input.value = base;

    const done = (value) => {
      document.removeEventListener("keydown", onKey, true);
      el.remove();
      resolve(value);
    };
    const send = () => {
      const v = input.value.trim();
      done(v || base);
    };
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); done(null); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    }

    el.querySelector('[data-act="send"]').addEventListener("click", send);
    el.querySelector('[data-act="cancel"]').addEventListener("click", () => done(null));
    el.querySelector('[data-act="reset"]').addEventListener("click", () => { input.value = base; input.focus(); });
    el.addEventListener("click", (e) => { if (e.target === el) done(null); });
    document.addEventListener("keydown", onKey, true);

    // Curseur en fin de texte : on complète plus souvent la question par défaut
    // qu'on ne la réécrit.
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

/**
 * Laisse le compositeur repeindre avant une capture d'écran : sans cette
 * attente, la feuille de saisie qu'on vient de fermer figure encore sur l'image.
 */
export function waitForRepaint(ms = 220) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, ms));
  });
}
