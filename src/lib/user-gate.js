// « Porte » vers l'utilisateur : tout ce qu'un outil ne peut pas faire sans lui.
//
//   • consentir à ce que l'IA consulte une ou plusieurs sandboxes ;
//   • déverrouiller la session Lumen OS (les sandboxes sont chiffrées/gardées) ;
//   • confirmer une action sensible (domotique, connecteur en écriture…) ;
//   • choisir la sandbox où enregistrer un document.
//
// Chaque demande :
//   1. s'affiche en carte dans la bulle de réponse (host) ;
//   2. est ANNONCÉE à voix haute (« J'ai besoin de ton accord pour… »), avec un
//      rappel si personne ne répond ;
//   3. est relayée au compagnon mobile, qui peut y répondre (sauf le mot de
//      passe, qui ne quitte jamais l'ordinateur) ;
//   4. met en pause les délais de l'orchestration (subscribe) : attendre
//      l'utilisateur n'est pas « un outil qui ne répond pas ».
// Sans réponse au bout de 5 minutes, la demande est considérée refusée.

const POLICY_KEY = "aiSandboxPolicy";          // { [id]: "always" | "until:<ms>" } — partagé barre/bureau
const HOUR_MS = 3600 * 1000;
const sessionAllowed = new Set();              // « Autoriser » : jusqu'à la fermeture de la fenêtre
const USER_WAIT_MS = 5 * 60 * 1000;
const REMIND_MS = 45000;

const L = {
  fr: {
    consentTitle: (names) => `Lumen souhaite consulter ${names.length > 1 ? "les sandboxes" : "la sandbox"} ${names.map((n) => `« ${n} »`).join(", ")}`,
    consentBody: (why) => (why ? `Pour : ${why}` : "Pour répondre à ta demande."),
    allowOnce: "Autoriser", allowHour: "Pendant 1 h", allowAlways: "Toujours autoriser", deny: "Refuser",
    sayConsent: (names) => `J'ai besoin de ton accord pour consulter ${names.length > 1 ? "les sandboxes" : "la sandbox"} ${names.join(" et ")}.`,
    unlockTitle: "Tes fichiers sont verrouillés",
    unlockBody: "Saisis le mot de passe de ta session pour que Lumen puisse y accéder.",
    unlockRemote: "Déverrouille la session sur l'ordinateur pour que Lumen accède à tes fichiers.",
    unlockCode: "Saisis le code à 6 chiffres de ton application d'authentification (celui de l'appairage).",
    unlockedRemote: "Déverrouillé à distance",
    password: "Mot de passe", unlock: "Déverrouiller", cancel: "Annuler",
    wrong: "Mot de passe incorrect (ou trop d'essais : patiente un instant).",
    sayUnlock: "Tes fichiers sont verrouillés. Saisis ton mot de passe pour que je puisse y accéder.",
    confirm: "Confirmer",
    sayConfirm: (t) => `J'ai besoin de ta confirmation : ${t}.`,
    chooseTitle: (what) => `Dans quelle sandbox enregistrer ${what || "le document"} ?`,
    skip: "Ne pas enregistrer", suggested: "suggérée",
    noSandbox: "Aucune sandbox : crée-en une dans l'explorateur de fichiers.",
    sayChoose: (what) => `Dis-moi dans quelle sandbox enregistrer ${what || "le document"}.`,
    remind: "J'attends toujours ta réponse.",
    expired: "Sans réponse : demande annulée.",
    answered: (c) => `Réponse : ${c}`,
    other: "Autre…", otherPh: "Votre réponse…", send: "Envoyer",
  },
  en: {
    consentTitle: (names) => `Lumen would like to read ${names.length > 1 ? "the sandboxes" : "the sandbox"} ${names.map((n) => `“${n}”`).join(", ")}`,
    consentBody: (why) => (why ? `To: ${why}` : "To answer your request."),
    allowOnce: "Allow", allowHour: "For 1 hour", allowAlways: "Always allow", deny: "Deny",
    sayConsent: (names) => `I need your permission to read ${names.length > 1 ? "the sandboxes" : "the sandbox"} ${names.join(" and ")}.`,
    unlockTitle: "Your files are locked",
    unlockBody: "Enter your session password so Lumen can access them.",
    unlockRemote: "Unlock the session on the computer so Lumen can access your files.",
    unlockCode: "Enter the 6-digit code from your authenticator app (the pairing code).",
    unlockedRemote: "Unlocked remotely",
    password: "Password", unlock: "Unlock", cancel: "Cancel",
    wrong: "Wrong password (or too many attempts: wait a moment).",
    sayUnlock: "Your files are locked. Enter your password so I can access them.",
    confirm: "Confirm",
    sayConfirm: (t) => `I need your confirmation: ${t}.`,
    chooseTitle: (what) => `Which sandbox should I save ${what || "the document"} to?`,
    skip: "Don't save", suggested: "suggested",
    noSandbox: "No sandbox yet: create one in the file explorer.",
    sayChoose: (what) => `Tell me which sandbox to save ${what || "the document"} to.`,
    remind: "I'm still waiting for your answer.",
    expired: "No answer: request cancelled.",
    answered: (c) => `Answer: ${c}`,
    other: "Other…", otherPh: "Your answer…", send: "Send",
  },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function sandboxPolicy() {
  try { return JSON.parse(localStorage.getItem(POLICY_KEY) || "{}") || {}; } catch { return {}; }
}
function setPolicy(id, value) {
  const p = sandboxPolicy();
  if (value) p[id] = value; else delete p[id];
  try { localStorage.setItem(POLICY_KEY, JSON.stringify(p)); } catch { /* stockage plein */ }
}
/** Accès déjà accordé (toujours, pour une durée encore valide, ou pour cette
 * session de fenêtre). Une durée expirée est oubliée au passage. */
export function sandboxAllowed(id) {
  const v = sandboxPolicy()[id];
  if (v === "always" || sessionAllowed.has(id)) return true;
  if (typeof v === "string" && v.startsWith("until:")) {
    if (Date.now() < Number(v.slice(6))) return true;
    setPolicy(id, null);
  }
  return false;
}
/** Échéance d'un accès temporaire (ms), ou null. */
export function sandboxAllowedUntil(id) {
  const v = sandboxPolicy()[id];
  return typeof v === "string" && v.startsWith("until:") ? Number(v.slice(6)) : null;
}
/** Retire toutes les autorisations (Réglages). */
export function resetSandboxPolicy() {
  sessionAllowed.clear();
  try { localStorage.removeItem(POLICY_KEY); } catch { /* rien */ }
}

const OTHER = "__other:";
/** Texte libre d'une réponse « Autre… », ou null pour une option prévue. */
export function otherAnswer(choice) {
  return typeof choice === "string" && choice.startsWith(OTHER) ? choice.slice(OTHER.length) : null;
}

let seq = 0;
const pendingRemote = new Map(); // id → (choice) => void

/** Réponse venue du compagnon mobile ({type:"user-answer", id, choice}). */
export function answerUserRequest(id, choice) {
  const fn = pendingRemote.get(id);
  if (fn) fn(choice);
}

/**
 * @param {object} o
 * @param {Function} o.invoke
 * @param {() => HTMLElement} o.host        où poser les cartes (bulle en cours)
 * @param {(text:string)=>void} [o.announce]  annonce vocale
 * @param {(obj:object)=>void} [o.push]       diffusion au compagnon / XR
 * @param {"fr"|"en"} [o.lang]
 */
export function createUserGate(o) {
  const T = L[o.lang === "en" ? "en" : "fr"];
  const listeners = new Set();
  let waiting = 0;
  const setWaiting = (on, text) => {
    waiting += on ? 1 : -1;
    for (const fn of listeners) { try { fn(waiting > 0, text); } catch { /* écouteur fautif */ } }
  };

  // Socle commun : carte + annonce + relais mobile + rappel + expiration.
  function ask({ kind, title, body = "", options, say, render, remoteOptions, allowOther = false }) {
    const id = `ask${Date.now().toString(36)}${++seq}`;
    const host = o.host?.() || document.body;
    ensureCss(host.ownerDocument || document);
    const card = (host.ownerDocument || document).createElement("div");
    card.className = `lm-ask lm-ask-${kind}`;
    card.innerHTML = `<div class="lm-ask-head"><span class="lm-ask-dot"></span><strong></strong></div><p class="lm-ask-body"></p><div class="lm-ask-row"></div><p class="lm-ask-note" hidden></p>`;
    card.querySelector("strong").textContent = title;
    const bodyEl = card.querySelector(".lm-ask-body");
    bodyEl.textContent = body;
    bodyEl.hidden = !body;
    // Posée juste sous le dernier appel d'outil (celui qui demande), pas après
    // le texte de la réponse : la question se lit dans l'ordre du raisonnement.
    const lastTool = [...host.querySelectorAll(".lm-blocks > .lm-tool")].pop();
    if (lastTool) lastTool.after(card); else host.appendChild(card);
    card.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    o.announce?.(say);
    setWaiting(true, title);
    o.push?.({ type: "user-request", id, kind, title, body, allowOther, options: remoteOptions ?? options.map(({ id: oid, label, primary }) => ({ id: oid, label, primary: !!primary })) });

    return new Promise((resolve) => {
      let done = false;
      const remind = setInterval(() => o.announce?.(T.remind), REMIND_MS);
      const expire = setTimeout(() => finish(null, T.expired), USER_WAIT_MS);
      function finish(choice, note) {
        if (done) return;
        done = true;
        clearInterval(remind);
        clearTimeout(expire);
        pendingRemote.delete(id);
        o.push?.({ type: "user-request-done", id });
        setWaiting(false);
        card.classList.add("done");
        card.querySelectorAll("button,input").forEach((b) => { b.disabled = true; });
        const n = card.querySelector(".lm-ask-note");
        if (note) { n.textContent = note; n.hidden = false; }
        resolve(choice);
      }
      pendingRemote.set(id, (choice) => {
        const opt = options.find((x) => x.id === choice);
        if (opt) finish(choice, T.answered(opt.label));
        // Réponse libre (« Autre ») venue du compagnon : « __other:texte ».
        else if (allowOther && typeof choice === "string" && choice.startsWith(OTHER)) {
          const txt = choice.slice(OTHER.length).trim();
          if (txt) finish(choice, T.answered(txt));
        }
      });
      const row = card.querySelector(".lm-ask-row");
      if (render) render(card, row, finish);
      else {
        for (const opt of options) {
          const b = (host.ownerDocument || document).createElement("button");
          b.type = "button";
          b.textContent = opt.label;
          if (opt.primary) b.className = "primary";
          b.addEventListener("click", () => finish(opt.id, T.answered(opt.label)));
          row.appendChild(b);
        }
        if (allowOther) addOther(card, row, finish);
      }
    });
  }

  // Bouton « Autre… » : déplie un champ libre, pour une réponse que l'IA
  // n'avait pas prévue. La réponse revient sous la forme « __other:texte ».
  function addOther(card, row, finish) {
    const doc = card.ownerDocument;
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "lm-ask-other";
    b.textContent = T.other;
    row.appendChild(b);
    const form = doc.createElement("form");
    form.className = "lm-ask-free";
    form.hidden = true;
    form.innerHTML = `<input type="text" maxlength="400" placeholder="${esc(T.otherPh)}" /><button type="submit" class="primary">${esc(T.send)}</button>`;
    row.after(form);
    const input = form.querySelector("input");
    b.addEventListener("click", () => {
      form.hidden = !form.hidden;
      b.classList.toggle("on", !form.hidden);
      if (!form.hidden) setTimeout(() => input.focus(), 20);
    });
    input.addEventListener("keydown", (e) => e.stopPropagation());
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const txt = input.value.trim();
      if (!txt) { input.focus(); return; }
      finish(OTHER + txt, T.answered(txt));
    });
  }

  const gate = {
    get waiting() { return waiting > 0; },
    /** fn(isWaiting:boolean, title:string) — l'orchestrateur y suspend ses délais. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Session verrouillée → carte de mot de passe. Renvoie true si déverrouillée. */
    async ensureUnlocked() {
      let unlocked = true;
      try { unlocked = await o.invoke("session_is_unlocked"); } catch { /* ancienne version : on tente */ }
      if (unlocked) return true;
      const r = await ask({
        kind: "unlock", title: T.unlockTitle, body: T.unlockBody, say: T.sayUnlock,
        // « ok » n'a pas de bouton ici : c'est la réponse que Rust injecte
        // après un déverrouillage à distance réussi (code TOTP vérifié par
        // companion.rs). Le mot de passe, lui, ne transite jamais.
        options: [{ id: "cancel", label: T.cancel }, { id: "ok", label: T.unlockedRemote }],
        remoteOptions: [{ id: "cancel", label: T.cancel }],
        render(card, row, finish) {
          row.innerHTML = `<input type="password" autocomplete="current-password" placeholder="${esc(T.password)}" /><button type="button" class="primary" data-u>${esc(T.unlock)}</button><button type="button" data-c>${esc(T.cancel)}</button>`;
          const input = row.querySelector("input");
          const note = card.querySelector(".lm-ask-note");
          const go = async () => {
            if (!input.value) return;
            let ok = false;
            try { ok = await o.invoke("session_unlock", { profileId: null, password: input.value }); } catch { /* faux */ }
            if (ok) finish("ok", "✓");
            else { note.textContent = T.wrong; note.hidden = false; input.select(); }
          };
          row.querySelector("[data-u]").addEventListener("click", go);
          row.querySelector("[data-c]").addEventListener("click", () => finish(null, T.cancel));
          input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); go(); } });
          setTimeout(() => input.focus(), 30);
        },
      });
      if (r !== "ok") return false;
      try { return await o.invoke("session_is_unlocked"); } catch { return true; }
    },

    /**
     * Accès aux sandboxes : renvoie les ids autorisés parmi `list` ({id,name}).
     * Les accès déjà accordés ne redemandent rien.
     */
    async authorizeSandboxes(list, reason = "") {
      const already = list.filter((s) => sandboxAllowed(s.id));
      const ask_ = list.filter((s) => !sandboxAllowed(s.id));
      if (!ask_.length) return already.map((s) => s.id);
      const names = ask_.map((s) => s.name);
      // Plusieurs sandboxes : cases à cocher, pour n'en ouvrir que certaines.
      // (Depuis le téléphone, la réponse vaut pour toutes.)
      let picked = new Set(ask_.map((s) => s.id));
      const options = [
        { id: "once", label: T.allowOnce, primary: true },
        { id: "hour", label: T.allowHour },
        { id: "always", label: T.allowAlways },
        { id: "deny", label: T.deny },
      ];
      const choice = await ask({
        kind: "consent",
        title: T.consentTitle(names),
        body: T.consentBody(reason),
        say: T.sayConsent(names),
        options,
        render: ask_.length < 2 ? undefined : (card, row, finish) => {
          const doc = card.ownerDocument;
          const boxes = doc.createElement("div");
          boxes.className = "lm-ask-checks";
          for (const sb of ask_) {
            const lab = doc.createElement("label");
            lab.innerHTML = `<input type="checkbox" checked /> <span></span>`;
            lab.querySelector("span").textContent = sb.name;
            lab.querySelector("input").addEventListener("change", (e) => {
              if (e.target.checked) picked.add(sb.id); else picked.delete(sb.id);
            });
            boxes.appendChild(lab);
          }
          row.before(boxes);
          for (const opt of options) {
            const b = doc.createElement("button");
            b.type = "button";
            b.textContent = opt.label;
            if (opt.primary) b.className = "primary";
            b.addEventListener("click", () => finish(opt.id, T.answered(opt.label)));
            row.appendChild(b);
          }
        },
      });
      if (choice === "once" || choice === "hour" || choice === "always") {
        const granted = ask_.filter((s) => picked.has(s.id));
        for (const s of granted) {
          // « Pendant 1 h » : pas d'accès de session, l'échéance fait foi —
          // sinon l'accès survivrait à l'heure tant que la fenêtre reste ouverte.
          if (choice === "hour") setPolicy(s.id, `until:${Date.now() + HOUR_MS}`);
          else sessionAllowed.add(s.id);
          if (choice === "always") setPolicy(s.id, "always");
        }
        return [...already, ...granted].map((s) => s.id);
      }
      return already.map((s) => s.id);
    },

    /** Confirmation d'une action sensible. */
    async confirm({ title, body = "", spoken }) {
      const choice = await ask({
        kind: "confirm", title, body, say: T.sayConfirm(spoken || title),
        options: [{ id: "yes", label: T.confirm, primary: true }, { id: "no", label: T.cancel }],
      });
      return choice === "yes";
    },

    /**
     * Question à choix (lever une ambiguïté) → id de l'option, ou null.
     * options : [{ id, label, primary? }]
     * allowOther : ajoute « Autre… » (champ libre) ; la réponse est alors
     * « __other:texte » (cf. otherAnswer()).
     */
    async choose({ title, body = "", options = [], spoken, allowOther = false }) {
      if (!options.length) return null;
      const choice = await ask({
        kind: "choose", title, body, say: spoken || title, allowOther,
        options: options.map((o, i) => ({ id: String(o.id), label: String(o.label), primary: o.primary ?? i === 0 })),
      });
      return choice ?? null;
    },

    /** Choix de la sandbox d'enregistrement → {id, name} ou null. */
    async chooseSandbox({ suggestedId = "", what = "" } = {}) {
      if (!(await gate.ensureUnlocked())) return null;
      let list = [];
      try { list = (await o.invoke("sandbox_list")) || []; } catch { /* aucune */ }
      list.sort((a, b) => (b.id === suggestedId) - (a.id === suggestedId));
      if (!list.length) {
        await ask({ kind: "choose", title: T.noSandbox, say: T.noSandbox, options: [{ id: "ok", label: "OK", primary: true }] });
        return null;
      }
      const choice = await ask({
        kind: "choose", title: T.chooseTitle(what), say: T.sayChoose(what),
        options: [
          ...list.map((s, i) => ({ id: s.id, label: s.id === suggestedId ? `${s.name} (${T.suggested})` : s.name, primary: i === 0 })),
          { id: "__skip", label: T.skip },
        ],
      });
      const sb = list.find((s) => s.id === choice);
      return sb ? { id: sb.id, name: sb.name } : null;
    },
  };
  return gate;
}

function ensureCss(doc) {
  if (doc.getElementById("lm-stream-css")) return;
  const link = doc.createElement("link");
  link.id = "lm-stream-css";
  link.rel = "stylesheet";
  link.href = new URL("./stream-view.css", import.meta.url).href;
  doc.head.appendChild(link);
}
