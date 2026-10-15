// Déverrouillage de la session Lumen OS depuis n'importe quelle app.
//
// Les sandboxes sont gardées par la session : tant qu'elle est verrouillée,
// `sandbox_list`, le flux `lumenmedia://` et toute écriture échouent. En mode
// Bureau l'utilisateur s'est connecté, donc tout marche ; en mode barre ou
// application, personne ne lui a demandé son mot de passe — et l'app échouait
// en silence (« l'export ne marche qu'en mode Desktop »).
//
//   if (!(await ensureSessionUnlocked({ invoke, reason: "Exporter la vidéo" }))) return;
//
// Le dialogue reprend la carte de lib/confirm.css (même anneau, mêmes rayons
// shadcn) : une app n'a rien à charger de plus que confirm.css.

const L = {
  fr: {
    title: "Vos fichiers sont verrouillés",
    body: "Saisissez le mot de passe de votre session Lumen pour accéder à vos sandboxes.",
    password: "Mot de passe",
    unlock: "Déverrouiller",
    cancel: "Annuler",
    wrong: "Mot de passe incorrect (ou trop d'essais : patientez un instant).",
  },
  en: {
    title: "Your files are locked",
    body: "Enter your Lumen session password to access your sandboxes.",
    password: "Password",
    unlock: "Unlock",
    cancel: "Cancel",
    wrong: "Wrong password (or too many attempts: wait a moment).",
  },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lang = () => ((localStorage.getItem("lang") || navigator.language || "fr").toLowerCase().startsWith("en") ? "en" : "fr");

/** Vrai si la session est ouverte (ou si la commande n'existe pas : ancienne version). */
export async function isSessionUnlocked(invoke) {
  if (!invoke) return true;
  try { return !!(await invoke("session_is_unlocked")); } catch { return true; }
}

/** Erreur de commande due au verrou de session ? */
export function isLockError(e) {
  return /verrouill|SESSION_LOCKED|locked/i.test(String(e?.message || e || ""));
}

let pending = null;

/**
 * Demande le mot de passe si la session est verrouillée.
 * @returns {Promise<boolean>} true si la session est (désormais) ouverte.
 */
export async function ensureSessionUnlocked({ invoke, reason = "" } = {}) {
  if (await isSessionUnlocked(invoke)) return true;
  // Plusieurs appels simultanés (scan + lecture) : un seul dialogue.
  if (pending) return pending;
  pending = new Promise((resolve) => {
    const s = L[lang()];
    const el = document.createElement("div");
    el.className = "lumen-confirm";
    el.innerHTML = `
      <form class="lumen-confirm-card" role="dialog" aria-modal="true" aria-label="${esc(s.title)}">
        <div class="lumen-confirm-title">${esc(s.title)}</div>
        <div class="lumen-confirm-body">${esc(reason ? `${reason} — ${s.body}` : s.body)}</div>
        <input class="lumen-prompt-input" type="password" autocomplete="current-password" placeholder="${esc(s.password)}" />
        <div class="lumen-confirm-body" data-err hidden style="color:var(--destructive,#ef4444)">${esc(s.wrong)}</div>
        <div class="lumen-confirm-actions">
          <button type="button" class="lumen-confirm-btn" data-act="cancel">${esc(s.cancel)}</button>
          <button type="submit" class="lumen-confirm-btn primary">${esc(s.unlock)}</button>
        </div>
      </form>`;
    document.body.appendChild(el);
    const input = el.querySelector("input");
    const done = (v) => { el.remove(); pending = null; resolve(v); };
    el.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input.value) return;
      let ok = false;
      try { ok = await invoke("session_unlock", { profileId: null, password: input.value }); } catch {}
      if (ok) { done(true); window.dispatchEvent(new CustomEvent("lumen-session-unlocked")); return; }
      el.querySelector("[data-err]").hidden = false;
      input.select();
    });
    el.querySelector('[data-act="cancel"]').addEventListener("click", () => done(false));
    el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } });
    setTimeout(() => input.focus(), 0);
  });
  return pending;
}

/**
 * Appelle une commande gardée par la session ; sur refus « verrouillée »,
 * propose le déverrouillage puis réessaie une fois.
 */
export async function invokeUnlocked(invoke, cmd, args, reason = "") {
  try { return await invoke(cmd, args); } catch (e) {
    if (!isLockError(e)) throw e;
    if (!(await ensureSessionUnlocked({ invoke, reason }))) throw e;
    return invoke(cmd, args);
  }
}
