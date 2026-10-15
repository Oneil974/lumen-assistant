// Annuaire de Lumen Pro — les personnes du réseau.
//
// C'est la porte d'entrée du monde en réseau : tant que ce poste n'est lié à
// aucun Lumen Server, cette page ne montre qu'une chose — comment le lier. Le
// reste de Lumen continue de fonctionner sans, et c'est la règle qui tient tout
// le produit : le serveur ajoute le collectif, il n'est jamais une condition.

import { autoTranslate } from "../apps-i18n.js";
import { mountShell, avatar, kpi, emptyState, progress } from "../lib/app-shell.js";
import { requireProPage } from "../lib/pro-edition.js";
import { confirmSheet } from "../lib/confirm.js";
import { api, directory, linkServer, onServerEvent, sendEnvelope, serverState, unlinkServer } from "../lib/netserver.js";

// Icônes de la coquille (nav, en-têtes) : posées avant le premier rendu.
mountShell();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { link: null, people: [] };

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3600);
}

// ===================== Liaison =====================

function renderLinkForm() {
  $("dir").innerHTML = `
    <div class="link-card">
      <span class="lk-ic" data-icon="network"></span>
      <div class="lk-title">Lier ce poste à un Lumen Server</div>
      <div class="lk-sub">Votre administrateur crée votre compte et vous remet un code d'appairage,
        valable dix minutes. Une paire de clés est produite ici : la privée ne quittera jamais ce poste.</div>
      <div class="form-grid">
        <label class="f wide"><span class="f-label">Adresse du serveur</span>
          <input class="input" id="lk-url" placeholder="https://lumen.exemple.fr:8770" spellcheck="false" /></label>
        <label class="f"><span class="f-label">Code d'appairage</span>
          <input class="input" id="lk-code" placeholder="ABC-DEF-GHJ" spellcheck="false" /></label>
        <label class="f"><span class="f-label">Nom de cet appareil</span>
          <input class="input" id="lk-name" placeholder="Portable de Camille" /></label>
      </div>
      <div class="form-actions"><button class="btn primary" id="lk-go">Lier</button></div>
      <div class="err" id="lk-err"></div>
    </div>`;
  mountShell($("dir"));
  $("lk-go").addEventListener("click", async () => {
    const url = $("lk-url").value.trim();
    const code = $("lk-code").value.trim();
    const name = $("lk-name").value.trim() || "Poste Lumen";
    if (!url || !code) { $("lk-err").textContent = "Adresse et code sont nécessaires."; return; }
    $("lk-err").textContent = "";
    $("lk-go").disabled = true;
    try {
      state.link = await linkServer(url, code, name);
      await boot();
      toast("Poste lié.");
    } catch (e) {
      $("lk-err").textContent = String(e.message || e);
      $("lk-go").disabled = false;
    }
  });
}

// ===================== Annuaire =====================

function renderPeople() {
  const me = state.link?.account?.id;
  const rows = state.people.map((p) => {
    const online = p.presence === "online";
    const noKey = !(p.device_keys || []).length;
    return `
    <div class="person-card">
      <span class="pc-av">${avatar(p.display_name)}<span class="pc-dot ${online ? "on" : ""}" title="${online ? "en ligne" : "hors ligne"}"></span></span>
      <div class="pc-id">
        <div class="pc-name">${esc(p.display_name)}${p.id === me ? " <span class='pc-you'>vous</span>" : ""}</div>
        <div class="pc-handle">@${esc(p.handle)}${noKey ? " · aucun appareil lié" : ""}</div>
      </div>
      ${p.id === me ? "" : `
        <button class="btn tiny" data-write="${esc(p.id)}" ${noKey ? "disabled" : ""}>Écrire</button>
        <button class="btn tiny" data-invite="${esc(p.id)}" ${online ? "" : "disabled"}>Inviter en réunion</button>`}
    </div>`;
  }).join("");

  $("dir").innerHTML = `
    <header class="dir-head">
      <div><h1><span class="title-ic" data-icon="users"></span>Annuaire</h1><p>${esc(state.link.serverName || state.link.url)} · ${state.people.length} personne(s)</p></div>
      <button class="btn" id="unlink">Délier ce poste</button>
    </header>
    <div class="people">${rows || `<div class="empty">L'annuaire est vide.</div>`}</div>
    <p class="note">Un compte apparaît ici dès qu'il existe sur le serveur. Les clés publiques de ses appareils
      servent à lui écrire en chiffré ; sans appareil lié, personne ne peut lui adresser de message.</p>`;

  mountShell($("dir"));
  $("unlink").addEventListener("click", async () => {
    const ok = await confirmSheet({
      title: "Délier ce poste ?",
      body: "L'annuaire et la messagerie disparaissent de ce poste, et la clé de cet appareil est effacée. "
          + "L'historique chiffré qu'elle seule pouvait ouvrir deviendra définitivement illisible ici.",
      confirm: "Délier", danger: true,
    });
    if (!ok) return;
    await unlinkServer();
    state.link = null;
    renderLinkForm();
    toast("Poste délié.");
  });

  $("dir").querySelectorAll("[data-write]").forEach((el) =>
    el.addEventListener("click", async () => {
      try {
        await api("POST", "/v1/conversations", { kind: "direct", members: [el.dataset.write] });
        // La messagerie est une app à part : on ouvre la conversation là-bas.
        top.__lumenBus?.open?.("messages");
        toast("Conversation ouverte dans la Messagerie.");
      } catch (e) { toast(String(e.message || e)); }
    }));

  $("dir").querySelectorAll("[data-invite]").forEach((el) =>
    el.addEventListener("click", async () => {
      try {
        const room = await api("POST", "/v1/rooms", { name: `Réunion avec ${el.closest(".person-card").querySelector(".pc-name").textContent.trim()}` });
        await sendEnvelope("meet.invite", { to: el.dataset.invite, room: room.id, name: room.name });
        toast("Invitation envoyée.");
      } catch (e) { toast(String(e.message || e)); }
    }));
}

// ===================== Démarrage =====================

async function boot() {
  state.link = await serverState().catch(() => ({ linked: false }));
  if (!state.link.linked) { renderLinkForm(); return; }
  try {
    state.people = await directory();
    renderPeople();
  } catch (e) {
    $("dir").innerHTML = `<div class="empty">Serveur injoignable : ${esc(e.message || e)}</div>`;
    return;
  }
  await onServerEvent(async (envelope) => {
    if (envelope?.t === "hello") {
      // La première annonce de présence est parfois émise avant que cette
      // socket soit enregistrée. Le hello fournit l'identité et confirme que
      // ce poste est en ligne, sans attendre un prochain changement réseau.
      const self = state.people.find((p) => p.id === envelope.p?.account?.id);
      if (self) { self.presence = "online"; renderPeople(); }
    } else if (envelope?.t === "presence") {
      const person = state.people.find((p) => p.id === envelope.p?.account);
      if (person) { person.presence = envelope.p?.presence; renderPeople(); }
    }
    if (envelope?.t === "meet.invite") {
      const from = state.people.find((p) => p.id === envelope.p?.from);
      toast(`${from?.display_name || "Quelqu'un"} vous invite à « ${envelope.p?.name || "une réunion"} ».`);
    }
  });
}

async function init() {
  if (!(await requireProPage({ appName: "L'annuaire" }))) return;
  document.body.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) $("sheet").hidden = true; });
  await boot();
  autoTranslate({ observe: true });
}

init();
