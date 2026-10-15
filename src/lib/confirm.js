// Confirmation maison — `window.confirm()` est INOPÉRANT dans la webview Tauri.
//
// WKWebView n'a pas de délégué de panneau JS : `confirm()` (comme `alert()`)
// ne s'affiche pas et renvoie `false` en silence. Le symptôme est toujours le
// même — « je clique sur le bouton et il ne se passe rien » — parce que le code
// qui suit fait `if (!ok) return;`.
//
// Trois apps s'étaient déjà écrit leur propre modale (Fluxo, Compagnon,
// Data Analysis) ; celle-ci est partagée, pour que la prochaine n'ait pas à le
// refaire ni à retomber dans le piège.
//
//   if (await confirmSheet({ title: "Vider « Voix » ?", body: "320 Mo libérés.", danger: true })) …
//
// `prompt()` souffre exactement du même mal, en pire : il renvoie `null`, donc
// le code appelant croit à une annulation et ne fait RIEN, sans le moindre
// message. D'où `promptSheet()`, sa doublure.
//
//   const nom = await promptSheet({ title: "Nom du modèle", value: "" });
//   if (nom === null) return;   // annulé

// La feuille de style suit le module : une page qui oublie le <link> voyait la
// boîte s'afficher sans mise en forme, sous le reste.
(function ensureStyle() {
  if (typeof document === "undefined" || document.querySelector("link[data-lumen-confirm]")) return;
  if ([...document.styleSheets].some((s) => String(s.href || "").includes("confirm.css"))) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.dataset.lumenConfirm = ""; l.href = new URL("./confirm.css", import.meta.url).href;
  document.head.appendChild(l);
})();

const esc = (s) => {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
};

/**
 * @returns {Promise<boolean>} true si l'utilisateur confirme.
 */
export function confirmSheet({ title, body = "", confirm = "Confirmer", cancel = "Annuler", danger = false } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "lumen-confirm";
    el.innerHTML = `
      <div class="lumen-confirm-card" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="lumen-confirm-title">${esc(title)}</div>
        ${body ? `<div class="lumen-confirm-body">${esc(body)}</div>` : ""}
        <div class="lumen-confirm-actions">
          <button type="button" class="lumen-confirm-btn" data-act="cancel">${esc(cancel)}</button>
          <button type="button" class="lumen-confirm-btn ${danger ? "danger" : "primary"}" data-act="ok">${esc(confirm)}</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    const done = (value) => {
      document.removeEventListener("keydown", onKey, true);
      el.remove();
      resolve(value);
    };
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); done(false); }
      else if (e.key === "Enter") { e.preventDefault(); done(true); }
    }
    el.querySelector('[data-act="ok"]').addEventListener("click", () => done(true));
    el.querySelector('[data-act="cancel"]').addEventListener("click", () => done(false));
    el.addEventListener("click", (e) => { if (e.target === el) done(false); });
    document.addEventListener("keydown", onKey, true);
    // Le bouton sûr a le focus : une validation au clavier ne détruit rien.
    el.querySelector('[data-act="cancel"]').focus();
  });
}

/**
 * Saisie d'une ligne de texte. Doublure de `window.prompt()`, inopérant lui
 * aussi dans la webview.
 *
 * @returns {Promise<string|null>} le texte saisi, ou `null` si l'utilisateur
 * annule — même contrat que `prompt()`, pour que la reprise soit mécanique.
 */
export function promptSheet({
  title, body = "", value = "", placeholder = "", confirm = "Valider", cancel = "Annuler",
  multiline = false, type = "text",
} = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "lumen-confirm";
    const field = multiline
      ? `<textarea class="lumen-prompt-input" rows="4" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="lumen-prompt-input" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}" />`;
    el.innerHTML = `
      <div class="lumen-confirm-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="lumen-confirm-title">${esc(title)}</div>
        ${body ? `<div class="lumen-confirm-body">${esc(body)}</div>` : ""}
        ${field}
        <div class="lumen-confirm-actions">
          <button type="button" class="lumen-confirm-btn" data-act="cancel">${esc(cancel)}</button>
          <button type="button" class="lumen-confirm-btn primary" data-act="ok">${esc(confirm)}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    const input = el.querySelector(".lumen-prompt-input");

    const done = (result) => {
      document.removeEventListener("keydown", onKey, true);
      el.remove();
      resolve(result);
    };
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); done(null); }
      // Entrée valide, sauf dans un champ multiligne où elle sert à écrire.
      else if (e.key === "Enter" && !multiline) { e.preventDefault(); done(input.value); }
    }
    el.querySelector('[data-act="ok"]').addEventListener("click", () => done(input.value));
    el.querySelector('[data-act="cancel"]').addEventListener("click", () => done(null));
    el.addEventListener("click", (e) => { if (e.target === el) done(null); });
    document.addEventListener("keydown", onKey, true);
    input.focus();
    input.select?.();
  });
}
