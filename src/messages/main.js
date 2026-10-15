// Messagerie de Lumen Pro — chiffrée de bout en bout.
//
// Ce que fait cette page, et que personne d'autre ne peut faire à sa place :
// chiffrer, déchiffrer. Le serveur range des enveloppes closes et prévient les
// destinataires ; il n'a aucune clé, donc aucun moyen de lire.
//
// Trois conséquences qui se voient à l'écran, et qu'il vaut mieux montrer que
// laisser découvrir :
//   1. un appareil appairé après coup ne voit pas le passé — il n'était
//      destinataire d'aucune enveloppe ;
//   2. la recherche est locale, puisque le serveur n'indexe rien ;
//   3. un message qu'on ne peut pas ouvrir s'affiche comme tel, plutôt que de
//      disparaître en silence.

import { autoTranslate } from "../apps-i18n.js";
import { mountShell, avatar, kpi, emptyState, progress } from "../lib/app-shell.js";
import { requireProPage } from "../lib/pro-edition.js";
import {
  api, devicesOf, directory, onServerEvent, open as openSealed, sealFor, sendEnvelope, serverState,
} from "../lib/netserver.js";

// Icônes de la coquille (nav, en-têtes) : posées avant le premier rendu.
mountShell();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  me: null,            // { id, handle, displayName }
  people: [],          // annuaire
  keyByDevice: new Map(), // device_id → clé publique, pour déchiffrer
  conversations: [],
  current: "",
  messages: [],        // messages déchiffrés de la conversation ouverte
  typing: new Map(),   // account → horodatage de la dernière frappe
  markedRead: new Set(),
  messagesRequest: 0,
  pendingFile: null,
  pendingFileConversation: "",
  pendingFiles: new Map(),
};

const personOf = (id) => state.people.find((p) => p.id === id);
const nameOf = (id) => personOf(id)?.display_name || (id === state.me?.id ? "Vous" : "Inconnu");

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3200);
}

const when = (ts) => new Date(ts * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** Titre d'une conversation : le nom du groupe, ou celui d'en face. */
function titleOf(conv) {
  if (conv.kind === "group") return conv.title || "Groupe";
  const other = (conv.members || []).find((m) => m !== state.me?.id);
  return nameOf(other);
}

// ===================== Chargement =====================

async function loadDirectory() {
  state.people = await directory();
  state.keyByDevice = new Map();
  for (const person of state.people) {
    for (const key of person.device_keys || []) {
      state.keyByDevice.set(key.device_id, key.public_key);
    }
  }
}

async function loadConversations() {
  const { conversations } = await api("GET", "/v1/conversations");
  state.conversations = conversations || [];
  renderThreads();
}

async function loadMessages(conversationId) {
  const requestId = ++state.messagesRequest;
  const { messages } = await api("GET", `/v1/conversations/${conversationId}/messages?limit=200`);
  if (requestId !== state.messagesRequest || state.current !== conversationId) return;
  const out = [];
  for (const m of messages || []) {
    // L'enveloppe a été close avec la clé de l'appareil ÉMETTEUR : c'est elle
    // qu'il faut pour rouvrir.
    const senderKey = state.keyByDevice.get(m.author_device);
    const plaintext = senderKey ? await openSealed(m.ciphertext, senderKey) : null;
    if (requestId !== state.messagesRequest || state.current !== conversationId) return;
    let text = plaintext, attachment = null;
    if (plaintext) {
      try {
        const packet = JSON.parse(plaintext);
        if (packet?.format === "lumen-message-v1") { text = packet.text || ""; attachment = packet.attachment || null; }
      } catch { /* anciens messages texte en clair côté client, toujours déchiffrables */ }
    }
    out.push({ ...m, text, attachment });
  }
  state.messages = out;
  renderStream();
  // Les accusés sont envoyés après ouverture de l'historique, jamais au simple
  // téléchargement en arrière-plan d'un autre fil.
  const unread = out.filter((m) => m.author_account !== state.me?.id && !state.markedRead.has(m.id));
  await Promise.all(unread.map(async (m) => {
    state.markedRead.add(m.id);
    try { await api("POST", "/v1/receipts", { message_id: m.id, state: "read" }); }
    catch { state.markedRead.delete(m.id); }
  }));
}

const draftKey = (conversationId) => `lumen-message-draft:${state.me?.id || "local"}:${conversationId}`;
function saveDraft() {
  if (!state.current) return;
  try {
    const key = draftKey(state.current);
    if ($("draft").value) localStorage.setItem(key, $("draft").value);
    else localStorage.removeItem(key);
  } catch { /* stockage local indisponible : le brouillon reste dans le champ */ }
}

// ===================== Rendu =====================

function renderThreads() {
  $("thread-list").innerHTML = state.conversations.map((c) => `
    <button class="thread-row ${c.id === state.current ? "on" : ""}" data-id="${esc(c.id)}">
      <span class="tr-av">${avatar(titleOf(c))}${c.kind !== "group" && presenceOf(c) ? `<i class="tr-presence"></i>` : ""}</span>
      <span class="tr-txt"><span class="tr-name">${esc(titleOf(c))}</span>
      <span class="tr-sub">${c.kind === "group" ? `${(c.members || []).length} personnes` : (presenceOf(c) ? "en ligne" : "hors ligne")}</span></span>
    </button>`).join("") || `<div class="empty small">Aucune conversation.</div>`;

  $("thread-list").querySelectorAll(".thread-row").forEach((el) =>
    el.addEventListener("click", () => openConversation(el.dataset.id)));
}

function presenceOf(conv) {
  const other = (conv.members || []).find((m) => m !== state.me?.id);
  return personOf(other)?.presence === "online";
}

function renderStream() {
  const conv = state.conversations.find((c) => c.id === state.current);
  if (!conv) return;
  $("thread-empty").hidden = true;
  $("thread-head").hidden = false;
  $("stream").hidden = false;
  $("composer").hidden = false;
  $("thread-head").innerHTML = `${avatar(titleOf(conv))}<div><div class="th-name">${esc(titleOf(conv))}</div>
    <div class="th-sub"><span class="lock" data-icon="lock"></span>Chiffré de bout en bout · le serveur ne peut pas lire</div></div>`;
  mountShell($("thread-head"));

  $("stream").innerHTML = state.messages.map((m) => {
    const mine = m.author_account === state.me?.id;
    const body = m.text === null
      ? `<span class="unreadable">Message chiffré pour un autre appareil — celui-ci n'était pas destinataire.</span>`
      : `${esc(m.text || "")}${m.attachment ? `<button class="attachment-download" data-download-file="${esc(m.id)}"><span aria-hidden="true">↧</span><span><strong>${esc(m.attachment.name)}</strong><small>${formatBytes(m.attachment.size)} · fichier chiffré</small></span></button>` : ""}`;
    return `<div class="bubble ${mine ? "mine" : ""}">
      ${conv.kind === "group" && !mine ? `<div class="b-who">${esc(nameOf(m.author_account))}</div>` : ""}
      <div class="b-body">${body}</div>
      <div class="b-at">${esc(when(m.created_at))}</div>
    </div>`;
  }).join("") || `<div class="empty small">Rien encore. Écrivez le premier message.</div>`;
  $("stream").querySelectorAll("[data-download-file]").forEach((button) => button.addEventListener("click", async () => {
    const message = state.messages.find((m) => m.id === button.dataset.downloadFile);
    if (!message?.attachment) return;
    button.disabled = true;
    try { await downloadAttachment(message.attachment, conv.id); }
    catch (e) { toast(String(e.message || e)); }
    finally { button.disabled = false; }
  }));
  $("stream").scrollTop = $("stream").scrollHeight;
}

const formatBytes = (n) => n < 1024 ? `${n} o` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} Ko` : `${(n / 1024 / 1024).toFixed(1)} Mo`;
const b64encode = (bytes) => {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
};
const b64decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

async function encryptAttachment(file, conversationId) {
  if (file.size > 10 * 1024 * 1024) throw new Error("La taille maximale d'une pièce jointe est de 10 Mio.");
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(conversationId) }, key, await file.arrayBuffer(),
  ));
  const packed = new Uint8Array(iv.length + encrypted.length);
  packed.set(iv); packed.set(encrypted, iv.length);
  const uploaded = await api("POST", "/v1/blobs", { conversation_id: conversationId, ciphertext: b64encode(packed) });
  return { id: uploaded.id, key: b64encode(rawKey), name: file.name, type: file.type || "application/octet-stream", size: file.size };
}

async function downloadAttachment(attachment, conversationId) {
  const { ciphertext } = await api("GET", `/v1/blobs/${encodeURIComponent(attachment.id)}?conversation_id=${encodeURIComponent(conversationId)}`);
  const packed = b64decode(ciphertext);
  if (packed.length < 29) throw new Error("La pièce jointe est endommagée.");
  const key = await crypto.subtle.importKey("raw", b64decode(attachment.key), "AES-GCM", false, ["decrypt"]);
  const iv = packed.slice(0, 12);
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(conversationId) }, key, packed.slice(12),
  );
  const url = URL.createObjectURL(new Blob([clear], { type: attachment.type || "application/octet-stream" }));
  const link = document.createElement("a"); link.href = url; link.download = attachment.name || "piece-jointe"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function openConversation(id) {
  if (state.pendingFileConversation) state.pendingFiles.set(state.pendingFileConversation, state.pendingFile);
  state.current = id;
  state.pendingFile = state.pendingFiles.get(id) || null;
  state.pendingFileConversation = state.pendingFile ? id : "";
  $("file-input").value = "";
  renderPendingFile();
  try { $("draft").value = localStorage.getItem(draftKey(id)) || ""; } catch { $("draft").value = ""; }
  renderThreads();
  $("stream").innerHTML = `<div class="empty small">Déchiffrement…</div>`;
  await loadMessages(id);
}

// ===================== Envoi =====================

async function send(text) {
  const conv = state.conversations.find((c) => c.id === state.current);
  const file = state.pendingFile;
  if (!conv || (!text.trim() && !file)) return;
  // Une enveloppe par appareil de chaque membre — y compris les nôtres, pour
  // que le message apparaisse aussi sur nos autres postes.
  const devices = devicesOf(state.people, conv.members || []);
  if (!devices.length) {
    toast("Aucun appareil destinataire n'a publié de clé : le message ne peut être chiffré pour personne.");
    return;
  }
  const attachment = file ? await encryptAttachment(file, conv.id) : null;
  const messageBody = attachment ? JSON.stringify({ format: "lumen-message-v1", text, attachment }) : text;
  const sealed = await sealFor(messageBody, devices);
  if (!sealed.length) throw new Error("Aucun appareil ne peut ouvrir le message : vérifiez les clés publiques dans l'Annuaire.");
  const clientId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await api("POST", `/v1/conversations/${conv.id}/messages`, { client_id: clientId, sealed });
  if (state.current === conv.id && $("draft").value === text) {
    $("draft").value = "";
    saveDraft();
  }
  if (file && state.pendingFiles.get(conv.id) === file) {
    state.pendingFiles.delete(conv.id);
    if (state.pendingFile === file && state.pendingFileConversation === conv.id) {
      state.pendingFile = null; state.pendingFileConversation = ""; $("file-input").value = ""; renderPendingFile();
    }
  }
  if (state.current === conv.id) await loadMessages(conv.id);
}

// ===================== Nouvelle conversation =====================

function newThreadSheet() {
  const others = state.people.filter((p) => p.id !== state.me?.id);
  $("sheet-card").innerHTML = `
    <div class="modal-head"><h4>Nouvelle conversation</h4><button class="modal-close" data-close>×</button></div>
    <div class="modal-body">
      ${others.length ? `<div class="pick">${others.map((p) => `
        <label class="pick-row"><input type="checkbox" value="${esc(p.id)}" />
          <span class="pk-name">${esc(p.display_name)}</span>
          <span class="pk-h">@${esc(p.handle)}</span>
          ${(p.device_keys || []).length ? "" : `<span class="pk-warn">sans appareil</span>`}
        </label>`).join("")}</div>`
      : `<div class="empty small">L'annuaire ne contient personne d'autre.</div>`}
      <label class="f"><span class="f-label">Titre (pour un groupe)</span><input class="input" id="nt-title" placeholder="Facultatif" /></label>
    </div>
    <div class="modal-foot"><span class="err" id="nt-err"></span><span class="spacer"></span>
      <button class="btn ghost" data-close>Annuler</button>
      <button class="btn primary" id="nt-ok">Ouvrir</button></div>`;
  $("sheet").hidden = false;
  $("nt-ok").addEventListener("click", async () => {
    const members = [...$("sheet-card").querySelectorAll("input[type=checkbox]:checked")].map((el) => el.value);
    if (!members.length) { $("nt-err").textContent = "Choisissez au moins une personne."; return; }
    try {
      const conv = await api("POST", "/v1/conversations", {
        kind: members.length > 1 ? "group" : "direct",
        title: $("nt-title").value.trim(),
        members,
      });
      $("sheet").hidden = true;
      await loadConversations();
      openConversation(conv.id);
    } catch (e) { $("nt-err").textContent = String(e.message || e); }
  });
}

// ===================== Temps réel =====================

async function wireRealtime() {
  await onServerEvent(async (envelope) => {
    const kind = envelope?.t;
    if (kind === "msg") {
      const conversation = envelope.p?.conversation;
      if (conversation === state.current) await loadMessages(conversation);
      else await loadConversations();
    } else if (kind === "conversation") {
      await loadConversations();
    } else if (kind === "presence") {
      const person = personOf(envelope.p?.account);
      if (person) { person.presence = envelope.p?.presence; renderThreads(); }
    } else if (kind === "typing" && envelope.p?.conversation === state.current) {
      state.typing.set(envelope.p.account, Date.now());
      $("thread-head").querySelector(".th-sub").textContent = `${nameOf(envelope.p.account)} écrit…`;
      setTimeout(() => {
        const sub = $("thread-head").querySelector(".th-sub");
        if (sub) sub.textContent = "Chiffré de bout en bout · le serveur ne peut pas lire";
      }, 2500);
    }
  });
}

// ===================== Démarrage =====================

function notLinked() {
  $("msg").innerHTML = `<div class="unlinked"><div class="unlinked-card">
    <span class="ul-ic" data-icon="messages-square"></span>
    <div class="ul-title">Aucun serveur lié</div>
    <div class="ul-sub">La messagerie a besoin d'un Lumen Server : c'est lui qui porte les identités et transporte les enveloppes.
      Ouvrez l'application <strong>Annuaire</strong> pour lier ce poste.</div>
    <button class="btn primary" data-act="open-directory">Ouvrir l'Annuaire</button></div></div>`;
  mountShell($("msg"));
  $("msg").querySelector("[data-act=open-directory]")?.addEventListener("click", () => {
    // Depuis le bureau : ouvre l'app Annuaire à côté ; seule : on l'indique.
    const open = window.top?.__lumenOpenApp || window.parent?.__lumenOpenApp;
    if (open) open("directory"); else toast("Ouvrez l'application Annuaire depuis le bureau.");
  });
}

async function init() {
  if (!(await requireProPage({ appName: "La messagerie" }))) return;
  document.body.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) $("sheet").hidden = true; });

  const link = await serverState().catch(() => ({ linked: false }));
  if (!link.linked) { notLinked(); return; }
  state.me = link.account;
  $("me-name").textContent = link.account.displayName || "Messagerie";
  $("link-state").textContent = link.serverName || link.url;
  $("link-dot").classList.add("on");

  $("new-thread").addEventListener("click", newThreadSheet);
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("draft").value;
    try { await send(text); } catch (err) { toast(String(err.message || err)); }
  });
  $("draft").addEventListener("input", saveDraft);
  $("pick-file").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", () => {
    const file = $("file-input").files?.[0] || null;
    if (file && file.size > 10 * 1024 * 1024) { toast("La taille maximale d'une pièce jointe est de 10 Mio."); $("file-input").value = ""; return; }
    state.pendingFile = file; state.pendingFileConversation = state.current;
    if (file) state.pendingFiles.set(state.current, file); else state.pendingFiles.delete(state.current);
    renderPendingFile();
  });
  $("remove-file").addEventListener("click", () => { state.pendingFile = null; state.pendingFiles.delete(state.current); state.pendingFileConversation = ""; $("file-input").value = ""; renderPendingFile(); });
  // La frappe en cours ne se stocke pas : elle vaut deux secondes.
  let lastTyping = 0;
  $("draft").addEventListener("input", () => {
    const now = Date.now();
    if (state.current && now - lastTyping > 2000) {
      lastTyping = now;
      sendEnvelope("typing", { conversation: state.current }).catch(() => {});
    }
  });

  try {
    await loadDirectory();
    await loadConversations();
    await wireRealtime();
  } catch (e) { toast(String(e.message || e)); }
  autoTranslate({ observe: true });
}

function renderPendingFile() {
  const file = state.pendingFile;
  $("attach-row").hidden = !file;
  $("file-label").textContent = file ? `${file.name} · ${formatBytes(file.size)} · chiffré avant envoi` : "";
}

init();
