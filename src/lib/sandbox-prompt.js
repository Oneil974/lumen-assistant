// Choix d'une sandbox depuis une surface sans sandbox ouverte (barre de chat).
//
// Les sandboxes sont protégées par la session Lumen OS : tant qu'elle est
// verrouillée, `sandbox_list` / `sandbox_write_file` échouent. Plutôt que de
// perdre le document, on demande le mot de passe dans la carte elle-même, puis
// on propose les sandboxes (la suggestion en premier). Rien n'est enregistré
// sans choix explicite : « Ne pas enregistrer » renvoie null.

const L = {
  fr: {
    locked: "Les sandboxes sont verrouillées. Saisissez le mot de passe de votre session pour enregistrer.",
    password: "Mot de passe",
    unlock: "Déverrouiller",
    wrong: "Mot de passe incorrect (ou trop d'essais : patientez un instant).",
    choose: "Enregistrer dans quelle sandbox ?",
    skip: "Ne pas enregistrer",
    none: "Aucune sandbox : créez-en une dans l'explorateur de fichiers.",
    suggested: "suggérée",
  },
  en: {
    locked: "Sandboxes are locked. Enter your session password to save.",
    password: "Password",
    unlock: "Unlock",
    wrong: "Wrong password (or too many attempts: wait a moment).",
    choose: "Save to which sandbox?",
    skip: "Don't save",
    none: "No sandbox yet: create one in the file explorer.",
    suggested: "suggested",
  },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function ensureStyles() {
  if (document.getElementById("sb-prompt-styles")) return;
  const st = document.createElement("style");
  st.id = "sb-prompt-styles";
  st.textContent = `
.sb-prompt{margin-top:8px;padding:10px;border-radius:10px;border:1px solid var(--border,rgba(127,127,127,.25));display:flex;flex-direction:column;gap:8px;font-size:12.5px}
.sb-prompt p{margin:0;opacity:.85}
.sb-prompt-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.sb-prompt input{flex:1;min-width:140px;padding:6px 8px;border-radius:8px;border:1px solid var(--border,rgba(127,127,127,.3));background:transparent;color:inherit;font:inherit}
.sb-prompt button{padding:5px 10px;border-radius:8px;border:1px solid var(--border,rgba(127,127,127,.3));background:transparent;color:inherit;font:inherit;cursor:pointer}
.sb-prompt button.is-primary{background:var(--primary,#111);color:var(--primary-foreground,#fff);border-color:transparent}
.sb-prompt button small{opacity:.6;margin-left:4px}
.sb-prompt .sb-prompt-err{color:#ef4444}`;
  document.head.appendChild(st);
}

/**
 * Monte le sélecteur dans `host` et résout avec `{id, name}` ou null.
 * @param {HTMLElement} host
 * @param {{invoke:Function, suggestedId?:string, lang?:string}} opts
 */
export async function askSandbox(host, { invoke, suggestedId = "", lang = "fr" } = {}) {
  if (!host || !invoke) return null;
  ensureStyles();
  const s = L[lang === "en" ? "en" : "fr"];
  const box = document.createElement("div");
  box.className = "sb-prompt";
  host.appendChild(box);
  const done = (value, resolve) => { box.remove(); resolve(value); };

  let unlocked = true;
  try { unlocked = await invoke("session_is_unlocked"); } catch {}

  return new Promise((resolve) => {
    const showList = async () => {
      let list = [];
      try { list = (await invoke("sandbox_list")) || []; } catch {}
      list.sort((a, b) => (b.id === suggestedId) - (a.id === suggestedId));
      box.innerHTML = list.length
        ? `<p>${esc(s.choose)}</p><div class="sb-prompt-row">${list.map((sb, i) =>
          `<button type="button" data-id="${esc(sb.id)}" class="${i === 0 ? "is-primary" : ""}">${esc(sb.name)}${sb.id === suggestedId ? `<small>${esc(s.suggested)}</small>` : ""}</button>`).join("")}
          <button type="button" data-skip>${esc(s.skip)}</button></div>`
        : `<p>${esc(s.none)}</p><div class="sb-prompt-row"><button type="button" data-skip>OK</button></div>`;
      box.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => {
        const sb = list.find((x) => x.id === b.dataset.id);
        done(sb ? { id: sb.id, name: sb.name } : null, resolve);
      }));
      box.querySelector("[data-skip]").addEventListener("click", () => done(null, resolve));
    };

    if (unlocked) { showList(); return; }
    box.innerHTML = `<p>${esc(s.locked)}</p>
      <div class="sb-prompt-row"><input type="password" autocomplete="current-password" placeholder="${esc(s.password)}" />
        <button type="button" class="is-primary" data-unlock>${esc(s.unlock)}</button>
        <button type="button" data-skip>${esc(s.skip)}</button></div>
      <p class="sb-prompt-err" hidden>${esc(s.wrong)}</p>`;
    const input = box.querySelector("input");
    const err = box.querySelector(".sb-prompt-err");
    const tryUnlock = async () => {
      const password = input.value;
      if (!password) return;
      let ok = false;
      try { ok = await invoke("session_unlock", { profileId: null, password }); } catch {}
      if (ok) showList();
      else { err.hidden = false; input.select(); }
    };
    box.querySelector("[data-unlock]").addEventListener("click", tryUnlock);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); tryUnlock(); } });
    box.querySelector("[data-skip]").addEventListener("click", () => done(null, resolve));
    setTimeout(() => input.focus(), 0);
  });
}
