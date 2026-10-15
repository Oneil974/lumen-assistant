// Lumen — compagnon mobile (client de la session « miroir »).
//
// Se connecte au WebSocket servi par l'ordinateur, reflète la transcription, et
// renvoie les requêtes saisies. L'appareil pilote aussi ce que l'ordinateur utilise
// pour répondre : backend (Ollama / llama.cpp / API / Raccourci), modèle, mode
// de discussion (chat, RAG, routeur, outils, workflow Fluxo) et pièces jointes
// (contexte complet ou indexation RAG, arbitrée côté ordinateur).
//
// La voix est 100 % locale à l'appareil :
//   - Énonciation : Web Speech API (speechSynthesis) — voix du système.
//   - Dictée : bouton micro du clavier (le plus fiable, notamment sur iOS) +
//     tentative webkitSpeechRecognition là où c'est disponible.

import { latestRender, transcriptWindow } from "/lib/companion-performance.js";
import { initChatMentions, initMentionHighlight, decorateMentions } from "/lib/chat-mentions.js";
import { mountHalo } from "/companion-halo.js";
import { agentAvatarHTML } from "/lib/agent-avatar.js";
import { mountMessenger } from "/lib/messenger-ui.js";
import { webSpeechVoice } from "/lib/voice-web.js";
import { thinkBlock, toolBlock, planBlock } from "/lib/stream-view.js";
import { tt, installCompanionI18n, companionLangSetting, setCompanionLang, speechLocale } from "/companion-i18n.js";

// Traduction AVANT tout rendu : le DOM statique est traduit tout de suite, le
// reste (feuilles, agents, notifications) l'est au fil des ajouts au DOM.
installCompanionI18n();

const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const emptyHint = $("empty-hint");
const typingEl = $("typing");
const statusbar = $("statusbar");
const stateLabel = $("state-label");
const connDot = $("conn-dot");
const input = $("input");
const btnSend = $("btn-send");
const btnMic = $("btn-mic");
const btnAttach = $("btn-attach");
const fileInput = $("file-input");
const attachmentsEl = $("attachments");
const btnNew = $("btn-new");
const btnConvos = $("btn-convos");
const drawer = $("drawer");
const drawerBackdrop = $("drawer-backdrop");
const drawerClose = $("drawer-close");
const convoNew = $("convo-new");
const convoList = $("convo-list");
const btnBackend = $("btn-backend");
const modelName = $("model-name");
const modelSub = $("model-sub");
const backendSheet = $("backend-sheet");
const backendBody = $("backend-body");
const btnMode = $("btn-mode");
const modeTag = $("mode-tag");
const modeSheet = $("mode-sheet");
const modeBody = $("mode-body");
const btnMore = $("btn-more");
const moreSheet = $("more-sheet");
const moreBadge = $("more-badge");
const menuNotifs = $("menu-notifs");
const menuNotifBadge = $("menu-notif-badge");
const notifSheet = $("notif-sheet");
const notifList = $("notif-list");
const notifClear = $("notif-clear");
const sheetBackdrop = $("sheet-backdrop");
const speakSeg = $("speak-seg");
const themeSeg = $("theme-seg");
const accentSwatches = $("accent-swatches");
const voiceSelect = $("voice-select");
const voiceTest = $("voice-test");
const toastEl = $("toast");
// Capsule Halo du téléphone : montée une fois, alimentée par le WebSocket.
// Annuaire des agents (id → nom + avatar), relu au plus toutes les minutes :
// cartes d'activité, capsule Halo et capture montrent leur personnage.
let agentDir = [];
let agentDirAt = 0;
async function loadAgentDir(force = false) {
  if (!force && Date.now() - agentDirAt < 60000) return agentDir;
  try {
    const res = await api("/agents/list");
    agentDir = res?.items || [];
    agentDirAt = Date.now();
  } catch (_) { /* hors ligne : on garde l'ancien */ }
  return agentDir;
}
function findAgent(ref) {
  const r = String(ref || "").toLowerCase();
  return agentDir.find((a) => a.id.toLowerCase() === r || (a.name || "").toLowerCase() === r) || null;
}
/// Visage + nom d'un agent (repli : l'identifiant tel quel).
function agentLabelHTML(ref, size = 26) {
  const a = findAgent(ref);
  if (!a) return `<strong>${esc(ref)}</strong>`;
  return `<span class="agent-who">${agentAvatarHTML(a, { size, hands: false })}<strong>${esc(a.name || a.id)}</strong></span>`;
}
const halo = mountHalo($("halo"), {
  face: (ref, { size = 30, state = "work" } = {}) => { const a = findAgent(ref); return a ? agentAvatarHTML(a, { size, hands: false, state }) : ""; },
  name: (ref) => findAgent(ref)?.name || "",
});
loadAgentDir().catch(() => {});

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>';

/// Alias court : le rendu des agents en fait un usage intensif.
const esc = (v) => escapeHtmlMobile(v);

function escapeHtmlMobile(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

let ws = null;
let mirrorState = "idle";   // dernier état reçu de l'ordinateur (idle/thinking)
let localSpeaking = false;  // vrai pendant que CET appareil énonce
let localListening = false; // vrai pendant que la dictée capture la voix
let lastAssistantText = "";
let localAutospeak = localStorage.getItem("companionAutospeak") === "true";
let macAutospeak = false;

// ---- Authentification (jeton de session TOTP) ---------------------------------
// Le serveur compagnon exige un jeton (obtenu via appairage). On le mémorise et
// on le passe en `?token=` (WebSocket et images ne peuvent pas porter d'en-tête).
let authToken = localStorage.getItem("companionToken") || "";
let wsOpened = false;

/**
 * Fichiers du coffre unifié cités par l'IA (`lumenmedia://localhost/<sb>/<chemin>`)
 * → servis par `/media/<sb>/<chemin>` avec le jeton : images affichées, autres
 * fichiers en lien (ouverts ou téléchargés par le navigateur). Le reste du
 * texte est échappé.
 */
function withLumenFiles(text) {
  const src = (url) => withToken(url.replace(/^lumenmedia:\/\/localhost\//, "/media/"));
  return escapeHtmlMobile(text)
    .replace(/!\[([^\]]*)\]\((lumenmedia:\/\/localhost\/[^\s)]+)\)/g, (m, alt, url) =>
      `<img class="run-image" src="${src(url)}" alt="${alt}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\((lumenmedia:\/\/localhost\/[^\s)]+)\)/g, (m, label, url) =>
      `<a href="${src(url)}" target="_blank" rel="noopener">📎 ${label}</a>`)
    .replace(/(^|\s)(lumenmedia:\/\/localhost\/[^\s<]+)/g, (m, lead, url) =>
      `${lead}<a href="${src(url)}" target="_blank" rel="noopener">📎 ${decodeURIComponent(url.split("/").pop())}</a>`);
}

function withToken(path) {
  if (!authToken) return path;
  return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(authToken);
}

/// Identité affichée après appairage (nom + avatar du profil Lumen Desktop).
let identity = null;
try { identity = JSON.parse(localStorage.getItem("companionUser") || "null"); } catch (_) { identity = null; }

function renderIdentity(user) {
  const box = $("pair-identity");
  if (!box) return;
  if (!user) { box.hidden = true; return; }
  const avatar = $("pair-avatar");
  const initial = (user.name || "?").trim().charAt(0).toUpperCase();
  // L'avatar est une image (data URL ou chemin) ou, à défaut, l'initiale — le
  // même repli que l'écran de connexion du bureau.
  avatar.innerHTML = user.avatar
    ? `<img src="${user.avatar}" alt="" />`
    : `<span>${initial}</span>`;
  $("pair-name").textContent = user.name || "";
  box.hidden = false;
}

/// Cherche à quel profil correspond l'identifiant saisi, pour montrer le visage
/// avant même le code. Silencieux en cas d'échec : un identifiant inconnu ne
/// doit rien affirmer.
let whoTimer = null;
function lookupIdentity() {
  clearTimeout(whoTimer);
  const value = $("pair-id")?.value.trim() || "";
  if (!value) { renderIdentity(null); return; }
  whoTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/auth/who?identifier=${encodeURIComponent(value)}`);
      renderIdentity(res.ok ? await res.json() : null);
    } catch (_) { renderIdentity(null); }
  }, 250);
}

function showPairing() {
  const ov = $("pair-overlay");
  if (ov) ov.hidden = false;
  resetLoginStep();
  // Le champ est prérempli avec le dernier identifiant connu : on ne redemande
  // pas son propre nom à chaque expiration de jeton.
  const last = localStorage.getItem("companionIdentifier") || "";
  if (last && $("pair-id") && !$("pair-id").value) { $("pair-id").value = last; lookupIdentity(); }
}
function hidePairing() { const ov = $("pair-overlay"); if (ov) ov.hidden = true; }

/// Connexion en deux temps : code TOTP, puis — si le profil est protégé —
/// mot de passe de la session. Le ticket rendu par `/auth/pair` ne vaut que
/// 5 minutes et quelques essais.
let loginTicket = null; // { ticket, serverKey }

function resetLoginStep() {
  loginTicket = null;
  const step = $("pair-password-step");
  if (step) step.hidden = true;
  if ($("pair-password")) $("pair-password").value = "";
  $("pair-id")?.removeAttribute("disabled");
  $("pair-code")?.removeAttribute("disabled");
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/// Chiffre le mot de passe pour la clé éphémère du serveur : ECDH P-256 →
/// HKDF-SHA256 (sel = ticket) → AES-256-GCM (données associées = ticket).
/// Même construction que l'app iOS et `auth::open_envelope` côté Rust.
async function sealPassword(password, ticket, serverKeyB64) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("insecure");
  const serverKey = await subtle.importKey("raw", unb64(serverKeyB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const mine = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const shared = await subtle.deriveBits({ name: "ECDH", public: serverKey }, mine.privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const enc = new TextEncoder();
  const aesKey = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(ticket), info: enc.encode("lumen-companion-login-v1") },
    hkdfKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(ticket) }, aesKey, enc.encode(password));
  return { client_key: b64(await subtle.exportKey("raw", mine.publicKey)), iv: b64(iv), ciphertext: b64(ct) };
}

function acceptLogin(data, id) {
  authToken = data.token || "";
  identity = data.user || null;
  localStorage.setItem("companionToken", authToken);
  localStorage.setItem("companionIdentifier", id);
  if (identity) localStorage.setItem("companionUser", JSON.stringify(identity));
  resetLoginStep();
  $("pair-code").value = "";
  hidePairing();
  connect();
}

async function submitPairing() {
  const id = $("pair-id").value.trim();
  const code = $("pair-code").value.trim();
  const err = $("pair-error");
  err.textContent = "";
  if (loginTicket) return submitPassword(id);
  try {
    const res = await fetch("/auth/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: id, code, device_kind: "web" }),
    });
    if (res.status === 429) { err.textContent = tt("Trop d'essais. Réessayez dans quelques minutes."); return; }
    if (!res.ok) { err.textContent = tt("Identifiant ou code invalide."); return; }
    const data = await res.json();
    if (data.step !== "password") { acceptLogin(data, id); return; }
    // Sans contexte sécurisé (page servie en HTTP), WebCrypto est absent :
    // le mot de passe ne partirait qu'en clair. On renvoie vers le HTTPS.
    if (!window.isSecureContext || !globalThis.crypto?.subtle) {
      const https = `https://${location.hostname}:8768/`;
      err.innerHTML = `${escapeHtmlMobile(tt("Pour saisir le mot de passe, ouvrez la version sécurisée :"))} <a href="${https}">${https}</a>`;
      return;
    }
    loginTicket = { ticket: data.ticket, serverKey: data.server_key };
    if (data.user) renderIdentity(data.user);
    $("pair-id").setAttribute("disabled", "");
    $("pair-code").setAttribute("disabled", "");
    $("pair-password-step").hidden = false;
    $("pair-password").focus();
  } catch (_) {
    err.textContent = tt("Connexion impossible.");
  }
}

async function submitPassword(id) {
  const err = $("pair-error");
  const password = $("pair-password").value;
  if (!password) return;
  try {
    const envelope = await sealPassword(password, loginTicket.ticket, loginTicket.serverKey);
    $("pair-password").value = "";
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: loginTicket.ticket, envelope }),
    });
    if (res.ok) { acceptLogin(await res.json(), id); return; }
    if (res.status === 429) { err.textContent = tt("Trop d'essais. Réessayez dans quelques minutes."); return; }
    if (res.status === 401) {
      const j = await res.json().catch(() => ({}));
      err.textContent = tt("Mot de passe incorrect ({n} essai(s) restant(s)).", { n: j.remaining ?? "?" });
      return;
    }
    // Ticket expiré ou épuisé : on repart du code.
    resetLoginStep();
    $("pair-code").value = "";
    err.textContent = tt("Connexion expirée : saisissez un nouveau code.");
  } catch (_) {
    err.textContent = tt("Connexion impossible.");
  }
}

/// L'ordinateur n'a qu'un bureau actif. Un appareil appairé sur un AUTRE profil reste
/// légitime — il capture, il suit ses agents — mais il ne voit pas la
/// conversation en cours : ce serait lire par-dessus l'épaule de la personne
/// connectée. On le dit clairement plutôt que d'afficher une app vide.
let drivesDesktop = true;

function handleSession(msg) {
  if (msg.user) {
    identity = msg.user;
    localStorage.setItem("companionUser", JSON.stringify(identity));
  }
  drivesDesktop = msg.active !== false;
  const composer = document.querySelector(".composer-wrap");
  if (composer) composer.style.display = drivesDesktop ? "" : "none";
  if (!drivesDesktop) {
    // Un autre profil pilote l'ordinateur : ce téléphone ne recevra plus
    // d'étapes ni de notifications, la capsule ne doit pas garder à l'écran le
    // déroulé de quelqu'un d'autre.
    halo?.reset();
    setStatus(msg.activeName
      ? tt("Session de {name} ouverte sur l'ordinateur — capture et agents restent disponibles.", { name: msg.activeName })
      : tt("Une autre session est ouverte sur l'ordinateur."));
  } else {
    setStatus("");
  }
  registerPush();
}

// ---- WebSocket ----------------------------------------------------------------
let reconnectTimer=null;
function connect() {
  clearTimeout(reconnectTimer);
  if(document.hidden || (ws && [WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState)))return;
  // Pas de jeton → on demande l'appairage plutôt que de boucler sur un refus.
  if (!authToken) { showPairing(); return; }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  wsOpened = false;
  const socket = ws = new WebSocket(`${proto}://${location.host}${withToken("/ws")}`);

  ws.onopen = () => {
    if(ws!==socket)return;
    wsOpened = true;
    connDot.classList.add("online");
    connDot.title = tt("Connecté");
    setStatus("");
    // Une seule demande : l'ordinateur répond par tout son état (conversations,
    // modes, backends, pièces jointes, notifications).
    send({ type: "list-conversations" });
    flushOutbox();
  };
  ws.onclose = () => {
    if(ws!==socket)return;
    ws=null;
    if(!wsOpened){
      const probedToken=authToken;
      fetch('/auth/check',{headers:{Authorization:`Bearer ${probedToken}`},signal:AbortSignal.timeout(5000)})
      .then(res=>{if(res.status===401&&authToken===probedToken){authToken='';localStorage.removeItem('companionToken');sessionStorage.removeItem('vaultToken');clearTimeout(reconnectTimer);vaultFrame?.removeAttribute('src');showPairing();}}).catch(()=>{});
    }
    connDot.classList.remove("online");
    connDot.title = tt("Déconnecté");
    // A connection failure also occurs when Wi-Fi sleeps. Keep the pairing token.
    setStatus(tt("Reconnexion à l'ordinateur…"));
    if(!document.hidden)reconnectTimer=setTimeout(connect, 1500);
  };
  ws.onerror = () => socket.close();
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.type === "ack") { onAck(msg); return; }
    if (msg.type === "session") handleSession(msg);
    // Halo : activité des agents et notifications de la capsule de l'ordinateur.
    else if (msg.type === "messenger") { for (const cb of mxListeners) cb(msg); }
    else if (msg.type === "agent-step") halo?.step(msg);
    else if (msg.type === "halo-notify") halo?.notify(msg);
    else if (msg.type === "orb") handleState(msg.state);
    else if (msg.type === "transcript") transcriptRenderer.push(msg.messages || []);
    else if (msg.type === "conversations") renderConversations(msg);
    else if (msg.type === "llm-mode" || msg.type === "ollama-mode") updateMode(msg);
    else if (msg.type === "orchestrate") updateOrchestrate(!!msg.on);
    else if (msg.type === "announce") handleAnnounce(msg);
    else if (msg.type === "user-request") showUserRequest(msg);
    else if (msg.type === "user-request-done") hideUserRequest(msg.id);
    else if (msg.type === "unlock-result") handleUnlockResult(msg);
    else if (msg.type === "backend") updateBackend(msg);
    else if (msg.type === "docs") renderAttachments(msg);
    else if (msg.type === "mentions") handleMentions(msg);
    else if (msg.type === "notifications") handleNotifications(msg);
    else if (msg.type === "answer") handleAnswer(msg);
    else if (msg.type === "autospeak") handleAutospeak(msg);
    // `orb-appearance`, `action`, `heartbeat` : réservés à l'orbe du bureau,
    // sans objet depuis que le compagnon est une application de discussion.
  };
}

// File d'attente hors connexion : un message ou une commande tapés pendant
// que l'ordinateur est injoignable partent dès la reconnexion (dans l'ordre).
const OUTBOX_KEY = "companionOutbox";
function outbox() { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch { return []; } }
function setOutbox(list) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch { /* plein */ } }
// Chaque entrée de la file garde son `id` jusqu'à l'accusé `{type:"ack", id}`
// de l'ordinateur : envoi un par un, retrait seulement après acceptation, et
// l'ordinateur ignore un renvoi qu'il a déjà traité.
const ackWaiters = new Map();
let flushing = false;
const newId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

function onAck(msg) {
  const done = ackWaiters.get(msg.id);
  if (done) { ackWaiters.delete(msg.id); done(true); }
}

function sendAwaitingAck(obj, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return resolve(false);
    ackWaiters.set(obj.id, resolve);
    setTimeout(() => { if (ackWaiters.delete(obj.id)) resolve(false); }, timeoutMs);
    try { ws.send(JSON.stringify(obj)); } catch { ackWaiters.delete(obj.id); resolve(false); }
  });
}

async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const [head] = outbox();
      if (!head) break;
      if (!head.id) head.id = newId();
      if (!(await sendAwaitingAck(head))) break; // gardé pour la prochaine connexion
      setOutbox(outbox().filter((o) => o.id !== head.id));
      sent++;
    }
  } finally { flushing = false; }
  if (sent) toast(tt("{n} envoi(s) en attente parti(s)", { n: sent }));
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  else if (obj.type === "chat" || obj.type === "voice-command") {
    setOutbox([...outbox(), { ...obj, id: obj.id || newId() }]);
    toast(tt("Hors ligne : envoi dès la reconnexion"));
  } else toast(tt("Pas de connexion à l'ordinateur"));
}

// ---- État ---------------------------------------------------------------------
// La barre d'état ne se montre que lorsqu'elle a quelque chose à dire : en
// marche normale, l'indicateur de saisie du fil suffit.
function setStatus(text) {
  if (!statusbar) return;
  stateLabel.textContent = text || "";
  statusbar.hidden = !text;
}

function applyActivity() {
  const busy = mirrorState === "thinking";
  if (typingEl) typingEl.hidden = !busy;
  if (busy) messagesEl.scrollTop = messagesEl.scrollHeight;
  if (localListening) setStatus(tt("Je vous écoute…"));
  else if (localSpeaking) setStatus(tt("Lecture en cours…"));
  else setStatus(ws && ws.readyState === WebSocket.OPEN ? "" : tt("Hors ligne"));
  btnMic?.classList.toggle("recording", localListening);
}

function handleState(state) {
  mirrorState = state;
  applyActivity();
}

// Lecture auto sur l'appareil : déclenchée par le texte FINAL exact envoyé par le
// l'ordinateur (et non par l'état), ce qui évite de lire un indicateur de chargement.
// ---- Demandes de Lumen (accord sandbox, confirmation, choix d'emplacement) ----
// Lumen attend une réponse : bandeau en haut de l'écran, boutons qui répondent
// directement à l'ordinateur. Le mot de passe, lui, ne se saisit que là-bas ;
// à distance, la session se déverrouille par le code TOTP du profil.
const userRequests = new Map();
function showUserRequest(msg) {
  if (!msg?.id || userRequests.has(msg.id)) return;
  const el = document.createElement("div");
  el.className = "user-request";
  el.setAttribute("role", "alertdialog");
  const title = document.createElement("strong");
  title.textContent = msg.title || "Lumen";
  el.appendChild(title);
  // Le texte « saisis le mot de passe » vise l'ordinateur : ici on a le code.
  if (msg.body && msg.kind !== "unlock") { const p = document.createElement("p"); p.textContent = msg.body; el.appendChild(p); }
  const row = document.createElement("div");
  row.className = "user-request-row";
  const options = Array.isArray(msg.options) ? msg.options : [];
  // Session verrouillée : déverrouillage par le code à 6 chiffres de
  // l'application d'authentification (vérifié par l'ordinateur). Le mot de
  // passe, lui, ne quitte jamais l'ordinateur.
  if (msg.kind === "unlock") {
    // Appareil appairé (TOTP déjà prouvé) : un geste suffit, sauf si Lumen
    // exige le code — ou le redemande après coup (« code-required »).
    const tap = msg.unlockMode === "tap";
    if (tap) {
      const quick = document.createElement("button");
      quick.type = "button";
      quick.className = "primary user-request-tap";
      quick.textContent = tt("Déverrouiller");
      quick.addEventListener("click", () => { quick.disabled = true; send({ type: "remote-unlock", id: msg.id, code: "" }); });
      row.appendChild(quick);
    }
    const hint = document.createElement("p");
    hint.className = "user-request-hint";
    hint.textContent = tt("Saisis le code à 6 chiffres de ton application d'authentification.");
    hint.hidden = tap;
    el.appendChild(hint);
    const code = document.createElement("input");
    code.type = "text";
    code.inputMode = "numeric";
    code.autocomplete = "one-time-code";
    code.maxLength = 6;
    code.placeholder = "123456";
    code.className = "user-request-code";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "primary";
    go.textContent = tt("Déverrouiller");
    const submit = () => {
      const v = code.value.replace(/\D/g, "");
      if (v.length !== 6) return;
      go.disabled = true;
      send({ type: "remote-unlock", id: msg.id, code: v });
    };
    go.addEventListener("click", submit);
    code.addEventListener("input", () => { if (code.value.replace(/\D/g, "").length === 6) submit(); });
    code.hidden = go.hidden = tap;
    row.appendChild(code);
    row.appendChild(go);
    el.dataset.unlock = "1";
  }
  if (!options.length && msg.kind !== "unlock") {
    const p = document.createElement("p");
    p.className = "user-request-hint";
    p.textContent = tt("Réponds sur l'ordinateur.");
    el.appendChild(p);
  }
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt.label;
    if (opt.primary) b.className = "primary";
    b.addEventListener("click", () => {
      send({ type: "user-answer", id: msg.id, choice: opt.id });
      hideUserRequest(msg.id);
    });
    row.appendChild(b);
  }
  el.appendChild(row);
  // « Autre… » : réponse libre quand aucune option ne convient (ask_user).
  if (msg.allowOther) {
    const free = document.createElement("form");
    free.className = "user-request-row";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 400;
    input.placeholder = tt("Autre réponse…");
    input.className = "user-request-code";
    const go = document.createElement("button");
    go.type = "submit";
    go.textContent = tt("Envoyer");
    free.append(input, go);
    free.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      send({ type: "user-answer", id: msg.id, choice: `__other:${v}` });
      hideUserRequest(msg.id);
    });
    el.appendChild(free);
  }
  document.body.appendChild(el);
  userRequests.set(msg.id, el);
  try { navigator.vibrate?.(60); } catch { /* sans vibreur */ }
}
/// Réponse de l'ordinateur à un déverrouillage à distance.
function handleUnlockResult(msg) {
  const el = userRequests.get(msg.id);
  if (msg.ok) { toast(tt("Session déverrouillée")); hideUserRequest(msg.id); return; }
  if (!el) return;
  const input = el.querySelector(".user-request-code");
  // Le geste ne suffit pas (code exigé, ancien appairage) : on montre le code.
  if (msg.error === "code-required") {
    el.querySelector(".user-request-tap")?.remove();
    el.querySelectorAll(".user-request-hint, .user-request-code, .user-request-row button.primary").forEach((n) => { n.hidden = false; n.disabled = false; });
    input?.focus();
    toast(tt("Code requis pour déverrouiller."));
    return;
  }
  const btn = el.querySelector("button.primary");
  if (input) { input.value = ""; input.focus(); }
  if (btn) btn.disabled = false;
  toast(msg.error || tt("Code incorrect."));
}

function hideUserRequest(id) {
  const el = userRequests.get(id);
  if (el) { el.remove(); userRequests.delete(id); }
}

// Annonces d'étapes (réponse orchestrée) : mises en file sans couper la
// précédente ; la réponse finale passe ensuite derrière elles.
let lastAnnounceAt = 0;
function handleAnnounce(msg) {
  if (!localAutospeak || !msg.text) return;
  lastAnnounceAt = Date.now();
  speak(msg.text, { queue: true });
}

function handleAnswer(msg) {
  if (msg.text) lastAssistantText = msg.text;
  // Après des annonces, la réponse attend la fin de la dernière au lieu de la couper.
  if (localAutospeak && msg.text) speak(msg.text, { queue: Date.now() - lastAnnounceAt < 120000 });
}

// ---- Backend & modèle ---------------------------------------------------------
let backendState = { source: "ollama", sources: [], model: "", models: [], think: false, thinkAvailable: false, vision: false };

const SOURCE_SHORT = {
  ollama: "Ollama",
  llama: "llama.cpp",
  api: "API",
  shortcut: "Raccourci",
  applefm: "Apple",
  lumen: "Lumen Server",
};

function updateBackend(msg) {
  backendState = {
    source: msg.source || "ollama",
    sources: Array.isArray(msg.sources) ? msg.sources : [],
    model: msg.model || "",
    models: Array.isArray(msg.models) ? msg.models : [],
    think: !!msg.think,
    thinkAvailable: !!msg.thinkAvailable,
    vision: !!msg.vision,
    modelLabels: msg.modelLabels || {},
    sourceLabel: msg.sourceLabel || "",
  };
  modelName.textContent = SOURCE_SHORT[backendState.source] || backendState.sourceLabel || "Lumen";
  modelSub.textContent = backendState.modelLabels[backendState.model] || shortModel(backendState.model);
  if (!backendSheet.hidden) renderBackendSheet();
}

// Un nom de modèle complet (`hf.co/…/gemma-3-4b-it:Q4_K_M`) ne tient pas dans
// une barre de titre : on garde le segment qui identifie réellement le modèle.
function shortModel(full) {
  if (!full) return "";
  const name = String(full).split("/").pop().replace(/\.gguf$/i, "");
  return name.length > 22 ? name.slice(0, 20) + "…" : name;
}

function optionRow(name, desc, active, onClick) {
  const el = document.createElement("button");
  el.className = "row" + (active ? " current" : "");
  el.type = "button";
  el.innerHTML = `<span class="row-text"><span class="row-name"></span>${desc ? '<span class="row-desc"></span>' : ""}</span><span class="row-check">${CHECK_SVG}</span>`;
  el.querySelector(".row-name").textContent = name;
  if (desc) el.querySelector(".row-desc").textContent = desc;
  el.addEventListener("click", onClick);
  return el;
}

function sectionLabel(text) {
  const el = document.createElement("div");
  el.className = "section-label";
  el.textContent = text;
  return el;
}

function renderBackendSheet() {
  backendBody.innerHTML = "";
  backendBody.appendChild(sectionLabel(tt("Source d'IA")));
  const sources = backendState.sources.length
    ? backendState.sources
    : [{ id: "ollama", label: tt("Ollama local") }];
  for (const s of sources) {
    backendBody.appendChild(optionRow(s.label, "", s.id === backendState.source, () => {
      // Changer de source recharge la liste des modèles côté ordinateur : la feuille
      // reste ouverte et se redessine à l'arrivée du message `backend`.
      send({ type: "set-backend", id: s.id });
    }));
  }

  if (backendState.thinkAvailable) {
    backendBody.appendChild(sectionLabel(tt("Raisonnement")));
    backendBody.appendChild(optionRow(
      "Mode « think »",
      tt("Le modèle réfléchit avant de répondre (modèles compatibles)."),
      backendState.think,
      () => send({ type: "set-think", on: !backendState.think }),
    ));
  }

  if (backendState.source === "shortcut") return;

  backendBody.appendChild(sectionLabel(tt(({ llama: "Modèle llama.cpp", api: "Modèle de l'API", applefm: "Modèle Apple", lumen: "Modèle Lumen Server" })[backendState.source] || "Modèle Ollama")));
  if (!backendState.models.length) {
    const empty = document.createElement("div");
    empty.className = "row-empty";
    empty.textContent = backendState.source === "api"
      ? tt("Aucun modèle renvoyé par l'API (clé manquante ?).")
      : tt("Aucun modèle disponible sur ce backend.");
    backendBody.appendChild(empty);
    return;
  }
  for (const m of backendState.models) {
    backendBody.appendChild(optionRow(backendState.modelLabels[m] || m, "", m === backendState.model, () => {
      send({ type: "set-model", model: m });
      closeSheets();
    }));
  }
}

btnBackend.addEventListener("click", () => {
  send({ type: "list-backends" });
  renderBackendSheet();
  openSheet(backendSheet);
});

// ---- Mode de discussion -------------------------------------------------------
// Reflète le sélecteur du bureau (chat / RAG / routeur / outils / docs /
// workflow Fluxo) et permet d'en changer depuis le téléphone.
let modeState = { available: false, mode: "chat", workflow: "", modes: [], workflows: [] };

const MODE_SHORT = {
  chat: "Chat", rag: "RAG", router: "Routeur",
  tools: "Outils", docs: "Docs", workflow: "Fluxo",
};

// ---- Réponse orchestrée ------------------------------------------------------
// Même réglage que la barre et le bureau (le bureau l'applique au mode Chat).
let orchestrateOn = false;
const btnOrchestrate = $("btn-orchestrate");
function updateOrchestrate(on) {
  orchestrateOn = on;
  if (!btnOrchestrate) return;
  btnOrchestrate.classList.toggle("on", on);
  btnOrchestrate.hidden = !(modeState?.available ?? true) || (modeState?.mode && modeState.mode !== "chat");
  btnOrchestrate.title = tt(on ? "Réponse orchestrée : activée" : "Réponse orchestrée : désactivée");
}
btnOrchestrate?.addEventListener("click", () => {
  updateOrchestrate(!orchestrateOn);
  send({ type: "set-orchestrate", on: orchestrateOn });
});

function updateMode(msg) {
  modeState = {
    available: !!msg.available,
    mode: msg.mode || "chat",
    workflow: msg.workflow || "",
    modes: Array.isArray(msg.modes) ? msg.modes : [],
    workflows: Array.isArray(msg.workflows) ? msg.workflows : [],
  };
  btnMode.hidden = !modeState.available;
  btnMode.classList.toggle("on", modeState.mode !== "chat");
  modeTag.textContent = modeState.mode === "workflow"
    ? (modeState.workflow || "Fluxo")
    : (tt(MODE_SHORT[modeState.mode] || msg.label || "Chat"));
  if (typeof msg.orchestrate === "boolean") updateOrchestrate(msg.orchestrate);
  else updateOrchestrate(orchestrateOn);
  if (!modeState.available && !modeSheet.hidden) closeSheets();
  if (!modeSheet.hidden) renderModeSheet();
}

function renderModeSheet() {
  modeBody.innerHTML = "";
  for (const m of modeState.modes) {
    modeBody.appendChild(optionRow(m.label, m.desc, modeState.mode === m.id, () => {
      send({ type: "set-ollama-mode", mode: m.id });
      closeSheets();
    }));
  }
  if (modeState.workflows.length) {
    modeBody.appendChild(sectionLabel(tt("Workflows Fluxo")));
    for (const n of modeState.workflows) {
      const active = modeState.mode === "workflow" && modeState.workflow === n;
      modeBody.appendChild(optionRow(n, tt("Exécute ce workflow"), active, () => {
        send({ type: "set-ollama-mode", mode: "workflow", workflow: n });
        closeSheets();
      }));
    }
  }
}

btnMode.addEventListener("click", () => {
  renderModeSheet();
  openSheet(modeSheet);
});

// ---- Pièces jointes -----------------------------------------------------------
// Le fichier part en Base64 sur la WebSocket : c'est l'ordinateur qui extrait le texte
// et décide du régime (contexte complet pour un document court, indexation RAG
// au-delà). Le téléphone n'affiche que le résultat de cet arbitrage.
function renderAttachments(msg) {
  const items = Array.isArray(msg.items) ? msg.items : [];
  const images = Number(msg.images) || 0;
  attachmentsEl.innerHTML = "";
  attachmentsEl.hidden = !items.length && !images;
  if (images) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.innerHTML = '<span class="name"></span>'
      + '<button class="x" aria-label="Retirer les images"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    chip.querySelector(".name").textContent = images > 1 ? `${images} images` : "1 image";
    chip.querySelector(".x").addEventListener("click", () => send({ type: "clear-images" }));
    attachmentsEl.appendChild(chip);
  }
  for (const doc of items) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.innerHTML = '<span class="name"></span><span class="tag"></span>'
      + '<button class="x" aria-label="Retirer"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    chip.querySelector(".name").textContent = doc.name;
    chip.querySelector(".tag").textContent = tt(doc.mode === "rag" ? "indexé" : "contexte");
    chip.querySelector(".x").addEventListener("click", () => send({ type: "remove-doc", name: doc.name }));
    attachmentsEl.appendChild(chip);
  }
}

// ---- Mentions « @ » (outils) et « # » (documents) ------------------------------
// Les deux catalogues vivent sur l'ordinateur (outils publiés, Corpus, sandboxes) :
// l'appareil les demande, les garde en mémoire le temps de la saisie, et laisse
// l'hôte faire le travail — insérer « @outil » dans le texte suffit à forcer
// l'appel d'outil côté ordinateur, quel que soit le mode de discussion.
let mentionCatalog = { tools: [], files: [] };
let mentionWaiters = [];
let mentionAskedAt = 0;

function handleMentions(msg) {
  mentionCatalog = {
    tools: Array.isArray(msg.tools) ? msg.tools : [],
    files: Array.isArray(msg.files) ? msg.files : [],
  };
  const waiters = mentionWaiters;
  mentionWaiters = [];
  for (const resolve of waiters) resolve();
}

/// Catalogue à jour, avec rafraîchissement paresseux : on n'attend l'ordinateur que si
/// on n'a rien à afficher, sinon le menu s'ouvre tout de suite sur la liste
/// connue (et se corrigera à la réponse suivante).
function mentionItems(kind) {
  const fresh = Date.now() - mentionAskedAt < 30000;
  const known = mentionCatalog[kind] || [];
  if (fresh && known.length) return known;
  mentionAskedAt = Date.now();
  send({ type: "list-mentions" });
  if (known.length) return known;
  return new Promise((resolve) => {
    // Sans réponse (ordinateur occupé, connexion perdue), le menu ne s'ouvre pas :
    // c'est préférable à un menu figé sur « chargement ».
    const done = () => resolve(mentionCatalog[kind] || []);
    mentionWaiters.push(done);
    setTimeout(done, 2500);
  });
}

// Les mentions saisies se peignent en pastilles DANS le champ (pas de rangée
// de pastilles en plus) ; le texte reste la source de vérité envoyée à l'hôte.
const mentionHighlight = initMentionHighlight(input, {
  known: () => (mentionCatalog.tools || []).map((it) => it.label).filter(Boolean),
});
function renderMentionChips() { mentionHighlight.refresh(); }

initChatMentions({
  input,
  anchor: input,
  labels: { tools: tt("Outils — touchez pour insérer"), files: tt("Documents — touchez pour joindre") },
  listTools: () => mentionItems("tools"),
  listFiles: () => mentionItems("files"),
  onTool: () => { updateSendState(); autoGrow(); renderMentionChips(); },
  onFile: (item) => {
    // Le document est sur l'ordinateur : c'est lui qui le joint et renvoie la pastille.
    send({ type: "attach-doc-ref", item });
    toast(tt("{label} — joint à la discussion", { label: item.label }));
  },
});

btnAttach.addEventListener("click", () => fileInput.click());

// L'appareil photo a SON input : poser `capture` sur celui des pièces jointes
// supprimerait l'accès à la photothèque et aux documents sur iOS.
const cameraInput = document.createElement("input");
cameraInput.type = "file";
cameraInput.accept = "image/*";
cameraInput.capture = "environment";
cameraInput.hidden = true;
document.body.append(cameraInput);
$("btn-camera")?.addEventListener("click", () => {
  if (!backendState.vision) { toast(tt("Ce backend ne lit pas les images")); return; }
  cameraInput.click();
});
cameraInput.addEventListener("change", async () => {
  const file = cameraInput.files?.[0];
  cameraInput.value = "";
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) { toast(tt("Photo trop volumineuse (12 Mo max)")); return; }
  toast(tt("Envoi de la photo…"));
  try {
    send({ type: "attach-image", dataUrl: await fileToDataUrl(file) });
  } catch (_) {
    toast(tt("Lecture de la photo impossible"));
  }
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  // 12 Mo : au-delà, l'encodage Base64 en mémoire sur un téléphone et la trame
  // WebSocket deviennent hasardeux — mieux vaut le dire que planter.
  if (file.size > 12 * 1024 * 1024) { toast(tt("Fichier trop volumineux (12 Mo max)")); return; }
  // Une image part vers la vision du modèle, un document vers l'extraction de
  // texte : le même bouton, deux chemins — l'utilisateur n'a pas à le savoir.
  const isImage = (file.type || "").startsWith("image/");
  if (isImage && !backendState.vision) { toast(tt("Ce backend ne lit pas les images")); return; }
  toast(tt("Envoi de {name}…", { name: file.name }));
  try {
    const dataUrl = await fileToDataUrl(file);
    if (isImage) send({ type: "attach-image", dataUrl });
    else send({ type: "attach-doc", name: file.name, b64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
  } catch (_) {
    toast(tt("Lecture du fichier impossible"));
  }
});

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("lecture impossible"));
    reader.readAsDataURL(file);
  });
}

// ---- Transcription ------------------------------------------------------------
const transcriptRenderer=latestRender(renderTranscript);
let transcriptLimit=120;
function renderTranscript(messages) {
  const follow=messagesEl.scrollHeight-messagesEl.scrollTop-messagesEl.clientHeight<100;
  const previous=new Map([...messagesEl.querySelectorAll(".bubble[data-message-index]")].map(el=>[Number(el.dataset.messageIndex),el]));
  if (emptyHint) emptyHint.hidden = messages.length > 0;
  // Re-render simple : la transcription reste courte. Les blocs repliables
  // ouverts par l'utilisateur le restent d'un rendu (≈ 150 ms en flux) à l'autre.
  const opened = new Set();
  messagesEl.querySelectorAll(".bubble details[data-key][open]").forEach((d) => opened.add(d.dataset.key));
  const visible=transcriptWindow(messages,transcriptLimit);
  const kept=new Set(visible.map(v=>v.index));
  for(const [index,el] of previous)if(!kept.has(index))el.remove();
  let older=document.getElementById('older-messages');
  if(messages.length>transcriptLimit){
    if(!older){older=document.createElement('button');older.id='older-messages';older.className='ghost-btn';messagesEl.prepend(older);}
    older.textContent=`Afficher ${Math.min(120,messages.length-transcriptLimit)} messages précédents`;
    older.onclick=()=>{transcriptLimit+=120;renderTranscript(messages);};
  }else older?.remove();

  let lastAssistant = "";
  for (const {index:mi,message:m,signature} of visible) {
    const old=previous.get(mi);
    if(m.sender==='assistant')lastAssistant=m.text;
    if(old?.__signature===signature)continue;
    const b = document.createElement("div");
    b.dataset.messageIndex=String(mi);b.__signature=signature;
    b.className = `bubble ${m.sender === "user" ? "user" : "assistant"}`;

    // Étapes de progression du mode Action / des outils.
    if (Array.isArray(m.progress) && m.progress.length) {
      const prog = document.createElement("div");
      prog.className = "run-progress";
      prog.innerHTML = m.progress.map((ev) => {
        // Image : chemin relatif → même origine que cette page (l'IP de l'ordinateur).
        if (ev.kind === "image" && ev.path) {
          return `<div class="run-step run-step-image">`
            + `<img class="run-image" src="${escapeHtmlMobile(withToken(ev.path))}" alt="" loading="lazy">`
            + `</div>`;
        }
        const cls = (ev.kind || "progress").replace(/[^a-z0-9_-]/gi, "");
        return `<div class="run-step run-step-${cls}">`
          + `<span class="run-step-dot"></span>`
          + `<span class="run-step-msg">${escapeHtmlMobile(ev.message || "")}</span>`
          + `</div>`;
      }).join("");
      b.appendChild(prog);
    }

    // Raisonnement et appels d'outils : mêmes blocs repliables qu'au bureau.
    if (Array.isArray(m.blocks) && m.blocks.length) {
      const wrap = document.createElement("div");
      wrap.className = "lm-blocks";
      m.blocks.forEach((blk, bi) => {
        let el;
        if (blk.kind === "plan") {
          const pb = planBlock({ snapshot: blk });
          el = pb.el;
          // Pendant le travail, le panneau reste ouvert comme au bureau.
          if (blk.live) el.open = true;
        } else if (blk.kind === "think") {
          const tb = thinkBlock();
          tb.set(blk.text || "", { live: !!blk.live });
          if (blk.label) tb.el.querySelector(".lm-label").textContent = blk.label;
          el = tb.el;
        } else {
          el = toolBlock({ name: blk.name, args: blk.args, ...(blk.result !== undefined ? { result: blk.result } : {}) }).el;
        }
        el.dataset.key = `${mi}:${bi}`;
        if (opened.has(el.dataset.key)) el.open = true;
        wrap.appendChild(el);
      });
      b.appendChild(wrap);
    }

    // Réponse (séparée de la progression pour ne pas la lire à voix haute).
    const answer = document.createElement("div");
    answer.className = "bubble-text";
    if (m.sender === "user") {
      // Message envoyé : les « @outil » deviennent des pastilles. Le texte est
      // échappé AVANT d'être décoré — le seul HTML injecté est celui des
      // pastilles.
      answer.innerHTML = decorateMentions(escapeHtmlMobile(m.text));
    } else if (/lumenmedia:\/\/localhost\//.test(m.text || "")) {
      answer.innerHTML = withLumenFiles(m.text);
    } else {
      answer.textContent = m.text;
    }
    b.appendChild(answer);

    if (m.sender === "assistant") {
      lastAssistant = m.text;
      const sb = document.createElement("button");
      sb.className = "speak-mini";
      sb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9.5v5h3l4.5 3.5V6L8 9.5z"/><path d="M16 9.5a4 4 0 010 5"/></svg><span>Lire</span>';
      sb.onclick = () => speak(m.text);
      b.appendChild(sb);
    }
    if(old)old.replaceWith(b);else messagesEl.insertBefore(b, typingEl);
  }
  lastAssistantText = lastAssistant;
  if(follow)messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- Envoi --------------------------------------------------------------------
// « Bureau » : la prochaine phrase (tapée ou dictée) est une commande pour
// Lumen Desktop — « ouvre Notes », « cherche facture 2026 » — et non un
// message au modèle. L'ordinateur l'exécute si sa commande vocale est activée.
let voiceCmdMode = false;
const btnVoiceCmd = $("btn-voicecmd");
btnVoiceCmd?.addEventListener("click", () => {
  voiceCmdMode = !voiceCmdMode;
  btnVoiceCmd.classList.toggle("on", voiceCmdMode);
  input.placeholder = voiceCmdMode ? tt("Commande pour le bureau…") : tt("Message à Lumen");
  input.focus();
});

function doSend() {
  const text = input.value.trim();
  if (!text) return;
  if (voiceCmdMode) {
    send({ type: "voice-command", text });
    toast(tt("Commande envoyée au bureau"));
    voiceCmdMode = false;
    btnVoiceCmd?.classList.remove("on");
    input.placeholder = tt("Message à Lumen");
    input.value = ""; autoGrow(); updateSendState(); renderMentionChips(); input.blur();
    return;
  }
  send({ type: "chat", text });
  // Premier envoi = geste explicite : c'est le moment d'obtenir la permission
  // de notifier (iOS l'exige, et la refuse hors d'un geste utilisateur).
  ensureNotificationPermission();
  input.value = "";
  autoGrow();
  updateSendState();
  renderMentionChips();
  input.blur();
}

btnSend.addEventListener("click", doSend);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
});

function updateSendState() {
  btnSend.disabled = !input.value.trim();
}

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}
input.addEventListener("input", () => { autoGrow(); updateSendState(); });
updateSendState();

$("suggestions")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".suggestion");
  if (!btn) return;
  input.value = btn.dataset.prompt || btn.textContent;
  autoGrow();
  updateSendState();
  doSend();
});

btnNew.addEventListener("click", () => {
  send({ type: "new-conversation" });
  toast(tt("Nouvelle discussion"));
});

// ---- Énonciation (speechSynthesis) -------------------------------------------
let voices = [];
let selectedVoiceURI = localStorage.getItem("companionVoiceURI") || "";

function populateVoices() {
  if (!("speechSynthesis" in window)) return;
  const all = speechSynthesis.getVoices();
  if (!all.length) return;

  // On ne garde que le français et l'anglais. Français d'abord.
  const isFr = (v) => v.lang && v.lang.toLowerCase().startsWith("fr");
  const isEn = (v) => v.lang && v.lang.toLowerCase().startsWith("en");
  voices = [...all.filter(isFr), ...all.filter(isEn)];

  voiceSelect.innerHTML = `<option value="">${tt("Voix par défaut")}</option>`;
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  }
  // Restaure le choix mémorisé s'il existe encore.
  if (selectedVoiceURI && voices.some((v) => v.voiceURI === selectedVoiceURI)) {
    voiceSelect.value = selectedVoiceURI;
  }
}

function currentVoice() {
  if (!selectedVoiceURI) return null;
  return voices.find((v) => v.voiceURI === selectedVoiceURI) || null;
}

if ("speechSynthesis" in window) {
  populateVoices();
  // iOS charge la liste de façon asynchrone : on réagit à l'événement.
  speechSynthesis.onvoiceschanged = populateVoices;
}

voiceSelect.addEventListener("change", () => {
  selectedVoiceURI = voiceSelect.value;
  localStorage.setItem("companionVoiceURI", selectedVoiceURI);
});

voiceTest.addEventListener("click", () => speak("Bonjour, je suis Lumen."));

// Retire les emojis avant l'énonciation (ils restent visibles à l'écran).
function stripForSpeech(text) {
  return (text || "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function speak(text, { queue = false } = {}) {
  if (!("speechSynthesis" in window) || !text) return;
  const clean = stripForSpeech(text);
  if (!clean) return;
  if (!queue) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  const v = currentVoice();
  if (v) { u.voice = v; u.lang = v.lang; }
  else { u.lang = speechLocale(); }
  u.onstart = () => { localSpeaking = true; applyActivity(); };
  u.onend = () => { localSpeaking = false; applyActivity(); };
  u.onerror = () => { localSpeaking = false; applyActivity(); };
  speechSynthesis.speak(u);
}

// ---- Cible de la lecture auto : ordinateur / appareil / les deux / désactivée ----
const SPEAK_LABEL = {
  off: "Lecture auto désactivée",
  phone: "Lecture auto : cet appareil",
  desktop: "Lecture auto : ordinateur",
  both: "Lecture auto : ordinateur + appareil",
};

function speakMode() {
  if (localAutospeak && macAutospeak) return "both";
  if (localAutospeak) return "phone";
  if (macAutospeak) return "desktop";
  return "off";
}

function applySpeakSegment() {
  const m = speakMode();
  speakSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
}

// Débloque la synthèse vocale iOS (doit être appelé depuis un geste utilisateur).
function unlockSpeech() {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  speechSynthesis.speak(u);
}

function setSpeakMode(m, fromUser) {
  localAutospeak = m === "phone" || m === "both";
  localStorage.setItem("companionAutospeak", localAutospeak);
  const macWanted = m === "desktop" || m === "both";
  if (fromUser && macWanted !== macAutospeak) {
    macAutospeak = macWanted; // optimiste, confirmé par la diffusion de l'ordinateur
    send({ type: "set-autospeak", on: macWanted });
  }
  if (fromUser) {
    if (localAutospeak) unlockSpeech();
    else speechSynthesis.cancel();
    toast(tt(SPEAK_LABEL[m]));
  }
  applySpeakSegment();
}

speakSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (btn) setSpeakMode(btn.dataset.mode, true);
});

function handleAutospeak(msg) {
  macAutospeak = !!msg.on;
  applySpeakSegment();
}

applySpeakSegment();

// ---- Dictée -------------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;

function stopDictation() {
  if (recog) recog.stop();
  localListening = false;
  applyActivity();
}

function startDictation() {
  if (recog) { stopDictation(); return; }
  // Le premier appui utilisateur débloque la synthèse vocale iOS pour que la
  // réponse de l'ordinateur puisse être lue automatiquement dès son arrivée.
  if (localAutospeak) unlockSpeech();
  if (!SR) {
    // iOS Safari : pas d'API Web Speech Recognition fiable → on s'appuie sur la
    // dictée native du clavier (le bouton micro à côté de la barre d'espace).
    input.focus({ preventScroll: true });
    input.click();
    toast(tt("Touchez le micro du clavier pour dicter"));
    return;
  }
  recog = new SR();
  recog.lang = speechLocale();
  recog.interimResults = true;
  recog.continuous = false;
  const base = input.value ? input.value + " " : "";
  recog.onresult = (e) => {
    let txt = "";
    for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
    input.value = base + txt;
    autoGrow();
    updateSendState();
  };
  recog.onend = () => {
    recog = null;
    localListening = false;
    applyActivity();
  };
  recog.onerror = () => {
    recog = null;
    localListening = false;
    applyActivity();
    toast(tt("Dictée indisponible"));
  };
  localListening = true;
  applyActivity();
  recog.start();
}

btnMic.addEventListener("click", startDictation);

// ---- Surfaces (tiroir + feuilles) ---------------------------------------------
const SHEETS = [backendSheet, modeSheet, moreSheet, notifSheet, $("capture-sheet"), $("agents-sheet"),$("vault-sheet")];

function openSheet(sheet) {
  closeDrawer();
  document.activeElement?.blur?.();
  SHEETS.forEach((s) => { s.hidden = s !== sheet; });
  sheetBackdrop.hidden = false;
}
function closeSheets() {
  clearInterval(agentsTimer);
  SHEETS.forEach((s) => { s.hidden = true; });
  sheetBackdrop.hidden = true;
  markNotificationsSeen();
}
sheetBackdrop.addEventListener("click", closeSheets);
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheets));

btnMore.addEventListener("click", () => openSheet(moreSheet));

function openDrawer() {
  drawer.hidden = false;
  drawerBackdrop.hidden = false;
  send({ type: "list-conversations" });
}
function closeDrawer() {
  drawer.hidden = true;
  drawerBackdrop.hidden = true;
}
btnConvos.addEventListener("click", openDrawer);
drawerClose.addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);
convoNew.addEventListener("click", () => {
  send({ type: "new-conversation" });
  closeDrawer();
});

function renderConversations(msg) {
  const items = msg.items || [];
  convoList.innerHTML = "";
  if (!items.length) {
    convoList.innerHTML = `<div class="row-empty">${tt("Aucune conversation enregistrée.")}</div>`;
    return;
  }
  for (const c of items) {
    const row = document.createElement("div");
    row.className = "convo-row";
    row.appendChild(optionRow(c.title || tt("Discussion"), "", c.id === msg.currentId, () => {
      send({ type: "load-conversation", id: c.id });
      closeDrawer();
    }));

    const trash = document.createElement("button");
    trash.className = "row-trash";
    trash.type = "button";
    trash.setAttribute("aria-label", `Supprimer « ${c.title || "Discussion"} »`);
    trash.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/></svg>';
    trash.addEventListener("click", () => askDeleteConversation(row, c));
    row.appendChild(trash);
    convoList.appendChild(row);
  }
}

/// Confirmation en place : la ligne cède le pas à une question, sans dialogue
/// système. Un appui sur la corbeille ne supprime jamais directement — le
/// geste est irréversible et le pouce est imprécis.
function askDeleteConversation(row, conv) {
  if (row.classList.contains("confirming")) return;
  const original = [...row.childNodes];
  row.classList.add("confirming");
  row.innerHTML = "";

  const box = document.createElement("div");
  box.className = "confirm-row";
  box.innerHTML = '<span class="confirm-text"></span>';
  box.querySelector(".confirm-text").textContent = tt("Supprimer ?");

  const no = document.createElement("button");
  no.type = "button";
  no.textContent = tt("Annuler");
  no.addEventListener("click", () => {
    row.classList.remove("confirming");
    row.innerHTML = "";
    original.forEach((n) => row.appendChild(n));
  });

  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "yes";
  yes.textContent = tt("Supprimer");
  yes.addEventListener("click", () => {
    send({ type: "delete-conversation", id: conv.id });
    row.remove();
    toast(tt("Discussion supprimée"));
  });

  box.appendChild(no);
  box.appendChild(yes);
  row.appendChild(box);
}

// ---- Notifications (Heartbeat) ------------------------------------------------
let notifications = [];
let notifSeenCount = parseInt(localStorage.getItem("companionNotifSeen") || "0", 10) || 0;

function updateNotifBadge() {
  const unseen = Math.max(0, notifications.length - notifSeenCount);
  const show = unseen > 0 && notifSheet.hidden;
  const label = unseen > 99 ? "99+" : String(unseen);
  moreBadge.textContent = label;
  moreBadge.hidden = !show;
  menuNotifBadge.textContent = label;
  menuNotifBadge.hidden = !show;
}

function markNotificationsSeen() {
  notifSeenCount = notifications.length;
  localStorage.setItem("companionNotifSeen", String(notifSeenCount));
  updateNotifBadge();
}

function handleNotifications(msg) {
  notifications = msg.items || [];
  // La liste a pu être nettoyée côté ordinateur : on borne le compteur de « vus ».
  if (notifSeenCount > notifications.length) {
    notifSeenCount = notifications.length;
    localStorage.setItem("companionNotifSeen", String(notifSeenCount));
  }
  if (!notifSheet.hidden) renderNotifications();
  updateNotifBadge();
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderNotifications() {
  notifList.innerHTML = "";
  if (!notifications.length) {
    notifList.innerHTML = `<div class="row-empty">${tt("Aucune notification.")}</div>`;
    return;
  }
  for (const n of notifications) {
    const card = document.createElement("div");
    card.className = "notif-card" + (n.success === false ? " error" : "");
    const head = document.createElement("div");
    head.className = "notif-card-head";
    const name = document.createElement("span");
    name.className = "notif-card-name";
    name.textContent = n.shortcut || "Heartbeat";
    const time = document.createElement("span");
    time.className = "notif-card-time";
    time.textContent = fmtTime(n.timestamp);
    head.appendChild(name);
    head.appendChild(time);
    const body = document.createElement("div");
    body.className = "notif-card-body";
    if (n.output) body.textContent = n.output;
    else { const em = document.createElement("em"); em.textContent = tt(n.success === false ? "Échec sans message" : "Exécuté (aucune sortie)"); body.appendChild(em); }
    card.appendChild(head);
    card.appendChild(body);
    notifList.appendChild(card);
  }
}

menuNotifs.addEventListener("click", () => {
  send({ type: "list-notifications" });
  renderNotifications();
  openSheet(notifSheet);
  markNotificationsSeen();
});
notifClear.addEventListener("click", () => send({ type: "clear-notifications" }));

// ---- Thème clair / sombre -----------------------------------------------------
let theme = localStorage.getItem("companionTheme") || "dark";
function applyTheme() {
  // Le compagnon s'habille avec les jetons de l'application : c'est cet
  // attribut — le même que sur le bureau — qui bascule toute la palette.
  document.documentElement.setAttribute("data-dt-theme", theme === "light" ? "light" : "dark");
  themeSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.theme === theme));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    // Lue sur le fond réel plutôt que codée en dur : la barre d'état d'iOS
    // reste raccord si la palette change.
    const bg = getComputedStyle(document.body).backgroundColor;
    meta.setAttribute("content", bg || (theme === "light" ? "#ffffff" : "#0a0a0a"));
  }
}
// ---- Couleur d'accent ---------------------------------------------------------
// Le téléphone a son propre habillage : la clé `uiAccent` est celle que lit
// `lib/theme-init.js` (le même script que sur le bureau), et l'attribut
// `data-ui-accent` suffit à reteinter toute la page — boutons, bulles, coches.
const ACCENTS = [
  { id: "", label: "Défaut" },
  { id: "orbe-rose", label: "Rose" },
  { id: "orbe-violet", label: "Violet" },
  { id: "orbe-bleu", label: "Bleu" },
  { id: "orbe-menthe", label: "Menthe" },
  { id: "orbe-peche", label: "Pêche" },
  { id: "blue", label: "Azur" },
  { id: "green", label: "Vert" },
  { id: "amber", label: "Ambre" },
  { id: "rose", label: "Framboise" },
];
let accent = localStorage.getItem("uiAccent") || "";

function applyAccent() {
  if (accent) document.documentElement.setAttribute("data-ui-accent", accent);
  else document.documentElement.removeAttribute("data-ui-accent");
  accentSwatches?.querySelectorAll(".swatch").forEach((b) => {
    b.classList.toggle("on", (b.dataset.uiAccent || "") === accent);
  });
}

function renderAccents() {
  if (!accentSwatches) return;
  accentSwatches.innerHTML = "";
  for (const a of ACCENTS) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.type = "button";
    b.title = tt(a.label);
    b.setAttribute("aria-label", `Accent ${tt(a.label)}`);
    if (a.id) b.dataset.uiAccent = a.id;
    b.addEventListener("click", () => {
      accent = a.id;
      if (accent) localStorage.setItem("uiAccent", accent);
      else localStorage.removeItem("uiAccent");
      applyAccent();
    });
    accentSwatches.appendChild(b);
  }
  applyAccent();
}
renderAccents();

// Langue : un changement recharge la page — plus simple et plus sûr que de
// retraduire un DOM déjà traduit (les libellés FR d'origine ne sont plus là).
const langSeg = $("lang-seg");
langSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.lang === companionLangSetting()));
langSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-lang]");
  if (!btn || btn.dataset.lang === companionLangSetting()) return;
  setCompanionLang(btn.dataset.lang);
  location.reload();
});

themeSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-theme]");
  if (!btn) return;
  theme = btn.dataset.theme;
  localStorage.setItem("companionTheme", theme);
  applyTheme();
});
applyTheme();

// ---- Toast --------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

// ---- Appels HTTP authentifiés --------------------------------------------------
// Le WebSocket porte le jeton en query (il ne peut pas porter d'en-tête) ; les
// routes REST, elles, l'envoient normalement en `Authorization`.
async function api(path, options = {}) {
  const res = await fetch(path, {
    signal: options.signal || AbortSignal.timeout(20000),
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${authToken}`,
    },
  });
  if (!res.ok) throw new Error(await res.text().catch(() => String(res.status)));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- Capture rapide -----------------------------------------------------------
// Sur un téléphone on capture bien plus souvent qu'on ne dialogue : attendre la
// réponse d'un modèle pour noter trois mots est une friction inutile.
const captureSheet = $("capture-sheet");
let captureKind = "note";
let captureAgents = [];
let captureSending = false;
let captureRefining = false;
let captureRequest = 0;
let captureDraftId = newId();
const captureDraftKey = () => `captureDraft:${location.host}:${identity?.id || identity?.name || "local"}`;
function updateCaptureDraft() {
  captureDraftId = newId();
  const text = $("capture-text").value;
  const count = text.trim() ? text.trim().split(/\s+/u).length : 0;
  $("capture-count").textContent = `${count} ${tt(count === 1 ? "mot" : "mots")}`;
  try {
    localStorage.setItem(captureDraftKey(), JSON.stringify({ id: captureDraftId, text, title: $("capture-title").value, kind: captureKind, agent: $("capture-agent").value, when: $("capture-when").value }));
  } catch (_) { $("capture-status").textContent = tt("Le brouillon ne peut pas être conservé sur cet appareil."); }
  syncCaptureKind();
}
function renderCaptureAgent() {
  const agent = captureAgents.find(a => a.id === $("capture-agent").value);
  $("capture-agent-preview").innerHTML = agent ? `${agentAvatarHTML(agent, { size: 36, hands: false, title: agent.name || agent.id })}<span>${esc(agent.name || agent.id)}</span>` : "";
}
$("capture-text")?.addEventListener("input", () => { $("capture-review").hidden = true; updateCaptureDraft(); });
$("capture-title")?.addEventListener("input", updateCaptureDraft);
$("capture-agent")?.addEventListener("change", () => { renderCaptureAgent(); updateCaptureDraft(); });
$("capture-when")?.addEventListener("change", updateCaptureDraft);
$("capture-expand")?.addEventListener("click", e => {
  const expanded = captureSheet.classList.toggle("expanded");
  e.currentTarget.setAttribute("aria-pressed", String(expanded));
});
$("capture-list")?.addEventListener("click", () => {
  const input = $("capture-text");
  input.value = input.value.split("\n").map(line => line.trim() && !/^\s*[-*•]\s/u.test(line) ? `- ${line}` : line).join("\n");
  $("capture-review").hidden = true;
  updateCaptureDraft(); input.focus();
});
$("capture-import")?.addEventListener("click", () => $("capture-file").click());
$("capture-file")?.addEventListener("change", async e => {
  const file = e.target.files?.[0]; e.target.value = "";
  if (!file) return;
  if (file.size > 256 * 1024) { toast(tt("Texte trop volumineux (256 Ko max)")); return; }
  try {
    const text = await file.text();
    if (text.includes("\0")) throw new Error(tt("Ce fichier n’est pas un texte."));
    $("capture-text").value += ($("capture-text").value ? "\n\n" : "") + text;
    if (!$("capture-title").value) $("capture-title").value = file.name.replace(/\.(txt|md)$/i, "").slice(0, 120);
    $("capture-review").hidden = true; updateCaptureDraft();
  } catch (error) { toast(String(error?.message || tt("Lecture du fichier impossible"))); }
});
$("capture-refine")?.addEventListener("click", async () => {
  const original = $("capture-text").value;
  if (!original.trim() || captureRefining) return;
  const request = ++captureRequest;
  captureRefining = true; $("capture-refine").disabled = true;
  $("capture-status").textContent = tt("Correction en cours…");
  try {
    const result = await api("/sc/text", { method: "POST", body: JSON.stringify({ text: original, action: "proofread" }) });
    if (request !== captureRequest) return;
    if ($("capture-text").value !== original) { $("capture-status").textContent = tt("La note a changé. Relancez la correction."); return; }
    if (!result?.text?.trim()) throw new Error(tt("Aucune correction reçue."));
    $("capture-proposal").textContent = result.text;
    $("capture-review").hidden = false;
    $("capture-status").textContent = tt("Relisez la proposition avant de l’appliquer.");
  } catch (error) { if (request === captureRequest) $("capture-status").textContent = String(error?.message || tt("Correction impossible")); }
  finally { if (request === captureRequest) { captureRefining = false; $("capture-refine").disabled = false; } }
});
$("capture-accept")?.addEventListener("click", () => { $("capture-text").value = $("capture-proposal").textContent; $("capture-review").hidden = true; $("capture-status").textContent = tt("Correction appliquée au brouillon."); updateCaptureDraft(); });
$("capture-reject")?.addEventListener("click", () => { $("capture-review").hidden = true; $("capture-status").textContent = tt("Texte original conservé."); });

/// Agents disponibles, relus à chaque ouverture : la liste vit sur l'ordinateur
/// et peut avoir changé depuis la dernière capture.
async function loadCaptureAgents() {
  const sel = $("capture-agent");
  if (!sel) return;
  try {
    const res = await api("/agents/list");
    captureAgents = res?.items || [];
    agentDir = captureAgents; agentDirAt = Date.now();
  } catch (_) {
    captureAgents = [];
  }
  sel.innerHTML = captureAgents.length
    ? captureAgents.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`).join("")
    : '<option value="">Aucun agent</option>';
  // Le dernier agent choisi est reproposé : on capture presque toujours pour le
  // même.
  const last = localStorage.getItem("captureAgent");
  if (last && captureAgents.some((a) => a.id === last)) sel.value = last;
  try { const draft = JSON.parse(localStorage.getItem(captureDraftKey()) || "null"); if (captureAgents.some(a => a.id === draft?.agent)) sel.value = draft.agent; } catch (_) {}
  renderCaptureAgent();
  syncCaptureKind();
}

/// Affiche les champs de la destination courante, et interdit l'envoi vers un
/// agent quand il n'y en a aucun.
function syncCaptureKind() {
  $("capture-when-row").hidden = captureKind !== "reminder";
  $("capture-agent-row").hidden = captureKind !== "task";
  const noAgent = captureKind === "task" && !captureAgents.length;
  $("capture-send").disabled = noAgent || captureSending || !$("capture-text").value.trim();
  $("capture-send").textContent = captureSending ? tt("Enregistrement…") : noAgent ? tt("Aucun agent disponible") : tt("Enregistrer");
}

function openCapture() {
  closeDrawer();
  openSheet(captureSheet);
  captureRequest++; captureRefining = false; $("capture-refine").disabled = false;
  $("capture-review").hidden = true;
  $("capture-status").textContent = tt("Brouillon conservé sur cet appareil. Les notes sont enregistrées dans la messagerie.");
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(captureDraftKey()) || "null"); } catch (_) {}
  captureDraftId = draft?.id || newId();
  $("capture-text").value = typeof draft?.text === "string" ? draft.text : "";
  $("capture-title").value = typeof draft?.title === "string" ? draft.title : "";
  captureKind = ["note", "task", "card", "reminder"].includes(draft?.kind) ? draft.kind : "note";
  $("capture-kind").querySelectorAll("button").forEach(b => { b.classList.toggle("active", b.dataset.kind === captureKind); b.setAttribute("aria-pressed", String(b.dataset.kind === captureKind)); });
  if (["3600000", "10800000", "86400000", "604800000"].includes(draft?.when)) $("capture-when").value = draft.when;
  const words = $("capture-text").value.trim().split(/\s+/u).filter(Boolean).length;
  $("capture-count").textContent = `${words} ${tt(words === 1 ? "mot" : "mots")}`;
  syncCaptureKind();
  loadCaptureAgents();
  setTimeout(() => $("capture-text")?.focus(), 120);
}

$("convo-capture")?.addEventListener("click", openCapture);

$("capture-kind")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-kind]");
  if (!btn) return;
  captureKind = btn.dataset.kind;
  $("capture-kind").querySelectorAll("button").forEach((b) => { b.classList.toggle("active", b === btn); b.setAttribute("aria-pressed", String(b === btn)); });
  updateCaptureDraft();
});

$("capture-send")?.addEventListener("click", async () => {
  const body = $("capture-text").value.trim();
  if (!body || captureSending) return;
  const title = $("capture-title").value.trim();
  const payload = { kind: captureKind, text: title ? `${title}\n\n${body}` : body, id: captureDraftId };
  const draftKey = captureDraftKey();
  const draftSnapshot = localStorage.getItem(draftKey);
  if (captureKind === "reminder") {
    payload.due_in_ms = parseInt($("capture-when").value, 10) || 3600000;
  }
  if (captureKind === "task") {
    const agent = $("capture-agent").value;
    if (!agent) { toast(tt("Aucun agent disponible")); return; }
    payload.agent = agent;
    localStorage.setItem("captureAgent", agent);
  }
  captureRequest++; captureRefining = false; $("capture-refine").disabled = false;
  captureSending = true; syncCaptureKind();
  try {
    await api("/capture", { method: "POST", body: JSON.stringify(payload) });
    if (localStorage.getItem(draftKey) === draftSnapshot) localStorage.removeItem(draftKey);
    closeSheets();
    const agentName = captureAgents.find((a) => a.id === payload.agent)?.name || "l'agent";
    toast(payload.kind === "reminder" ? tt("Rappel programmé")
      : payload.kind === "card" ? tt("Carte ajoutée")
      : payload.kind === "note" ? tt("Note enregistrée dans la messagerie")
      : tt("Tâche ajoutée à {name}", { name: agentName }));
  } catch (e) {
    toast(String(e?.message || tt("Capture impossible")));
  } finally { captureSending = false; syncCaptureKind(); }
});

// ---- Activité des agents ------------------------------------------------------
const agentsSheet = $("agents-sheet");
let agentsTimer = null;

function agentStatusLabel(status) {
  return tt(({
    running: "en cours", succeeded: "terminé", blocked: "bloqué",
    cancelled: "annulé", retry_scheduled: "nouvelle tentative",
    waiting_approval: "en attente", queued: "en file", interrupted: "interrompu",
  })[status] || status);
}

function renderAgents(data) {
  const body = $("agents-body");
  const approvals = data.approvals || [];
  const runs = data.runs || [];
  const tasks = data.tasks || [];
  const parts = [];

  // Les approbations d'abord : c'est la seule chose qui ATTEND l'utilisateur.
  if (approvals.length) {
    parts.push(`<div class="section-label">${tt("À décider")}</div>`);
    for (const a of approvals) {
      parts.push(`<div class="agent-card pending" data-approval="${esc(a.approval_id)}">
        <div class="agent-line">${agentLabelHTML(a.agent_id)}<span class="risk risk-${esc(a.risk)}">${esc(a.risk)}</span></div>
        <div class="agent-sub">${tt("veut utiliser")} <code>${esc(a.tool)}</code></div>
        ${a.reason ? `<div class="agent-sub dim">${esc(a.reason)}</div>` : ""}
        <div class="agent-actions">
          <button class="outline-btn" data-decide="reject">${tt("Refuser")}</button>
          <button class="primary-btn" data-decide="approve">${tt("Approuver")}</button>
        </div>
      </div>`);
    }
  }
  if (tasks.length) {
    parts.push(`<div class="section-label">${tt("En cours")}</div>`);
    for (const t of tasks) {
      parts.push(`<div class="agent-card">
        <div class="agent-line">${agentLabelHTML(t.agent_id)}<span class="dim">${esc(agentStatusLabel(t.status))}</span></div>
        <div class="agent-sub">${esc(t.text)}</div>
        ${t.error ? `<div class="agent-sub dim">${esc(t.error)}</div>` : ""}
      </div>`);
    }
  }
  if (runs.length) {
    parts.push(`<div class="section-label">${tt("Derniers runs")}</div>`);
    for (const r of runs.slice(0, 8)) {
      parts.push(`<div class="agent-card">
        <div class="agent-line">${agentLabelHTML(r.agent_id)}<span class="dim">${esc(agentStatusLabel(r.status))}</span></div>
        ${r.error ? `<div class="agent-sub dim">${esc(r.error)}</div>` : ""}
      </div>`);
    }
  }
  body.innerHTML = parts.join("") || `<div class="agents-empty">${tt("Aucune activité pour l'instant.")}</div>`;

  const badge = $("agents-badge");
  if (badge) {
    badge.hidden = approvals.length === 0;
    badge.textContent = String(approvals.length);
  }
}

let agentsRefreshing=false;
async function refreshAgents(silent = false) {
  if(agentsRefreshing||document.hidden)return;
  agentsRefreshing=true;
  try {
    const [data] = await Promise.all([api("/agents/activity"), loadAgentDir()]);
    renderAgents(data);
  } catch (_) {
    if (!silent) $("agents-body").innerHTML = `<div class="agents-empty">${tt("Activité indisponible.")}</div>`;
  }finally{agentsRefreshing=false;}
}

$("btn-agents")?.addEventListener("click", () => {
  openSheet(agentsSheet);
  refreshAgents();
  // Rafraîchissement tant que la feuille est ouverte : une approbation peut
  // arriver pendant qu'on la regarde.
  clearInterval(agentsTimer);
  agentsTimer = setInterval(() => { if (!agentsSheet.hidden) refreshAgents(true); else clearInterval(agentsTimer); }, 5000);
});

$("agents-body")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-decide]");
  if (!btn) return;
  const card = btn.closest("[data-approval]");
  const approve = btn.dataset.decide === "approve";
  btn.disabled = true;
  try {
    const out = await api("/agents/approve", {
      method: "POST",
      body: JSON.stringify({ approval_id: card.dataset.approval, approve }),
    });
    // `ok: false` = quelqu'un a déjà tranché entre l'affichage et le geste.
    toast(tt(out?.ok ? (approve ? "Approuvé" : "Refusé") : "Demande déjà traitée"));
  } catch (_) {
    toast(tt("Décision impossible"));
  }
  refreshAgents(true);
});

// ---- Notifications push (PWA) -------------------------------------------------
// Sans elles, le téléphone ne sait ce qui se passe QUE page ouverte. Avec, un
// agent qui attend une approbation peut réveiller l'écran d'accueil.
function b64UrlToUint8(b64) {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registerPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  // iOS n'autorise le push QUE pour une app ajoutée à l'écran d'accueil : on
  // n'insiste pas dans Safari, où la demande échouerait de toute façon.
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone;
  if (!standalone) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    if (Notification.permission === "default") {
      // La demande doit suivre un geste : on la déclenche au premier envoi.
      return;
    }
    if (Notification.permission !== "granted") return;
    const { key } = await api("/push/key");
    const existing = await reg.pushManager.getSubscription();
    const sub = existing || (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64UrlToUint8(key),
    }));
    const json = sub.toJSON();
    await api("/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: sub.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }),
    });
  } catch (_) { /* le push est un bonus : jamais bloquant */ }
}

/// Demande la permission au premier geste explicite (envoi d'un message).
async function ensureNotificationPermission() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone;
  if (!standalone) return;
  try {
    if ((await Notification.requestPermission()) === "granted") registerPush();
  } catch (_) { /* refus : on n'insiste pas */ }
}

// Appairage : bouton + validation au clavier (Entrée).
$("pair-submit")?.addEventListener("click", submitPairing);
$("pair-code")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitPairing(); });
$("pair-password")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitPairing(); });
$("pair-id")?.addEventListener("input", lookupIdentity);
renderIdentity(identity);

applyActivity();
connect();


// ---- Messages (mode messagerie) -------------------------------------------------
// Une messagerie façon Messenger, pour qui veut juste « écrire à Lumen » : des
// discussions séparées avec Lumen ou un agent, et la coupure de contexte. Le
// mode choisi est mémorisé : ouvert, il devient l'écran d'accueil de l'app.
const mxListeners = new Set();
let mx = null;
const mxTransport = {
  contacts: async () => (await api("/messenger/contacts"))?.items || [],
  threads: async () => api("/messenger/threads"),
  thread: async (id) => (await api(`/messenger/thread/${encodeURIComponent(id)}`))?.data,
  create: async (contact) => (await api("/messenger/new", { method: "POST", body: JSON.stringify({ contact }) }))?.data,
  send: (thread, text, images) => api("/messenger/send", { method: "POST", body: JSON.stringify({ thread, text, images }) }),
  cut: (thread) => api("/messenger/cut", { method: "POST", body: JSON.stringify({ thread }) }),
  stop: (thread) => api("/messenger/stop", { method: "POST", body: JSON.stringify({ thread }) }),
  remove: (thread) => api("/messenger/delete", { method: "POST", body: JSON.stringify({ thread }) }),
  update: (thread, patch) => api("/messenger/update", { method: "POST", body: JSON.stringify({ thread, ...patch }) }),
  fileUrl: async (id) => withToken(`/messenger/file/${encodeURIComponent(id)}`),
  tools: async (thread) => (await api(`/messenger/tools/${encodeURIComponent(thread)}`))?.items || [],
  onEvent(cb) { mxListeners.add(cb); return () => mxListeners.delete(cb); },
  // Mode vocal : reconnaissance + voix du navigateur (iOS : celles de l'iPhone).
  voice: webSpeechVoice({
    lang: speechLocale(),
    voice: () => currentVoice(),
    // Voix Piper/Kokoro d'un agent : synthétisée par l'ordinateur.
    remoteSynth: async (text, voice) => {
      const res = await fetch("/messenger/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ text, voice }),
      });
      return res.ok ? res.blob() : null;
    },
  }),
};

function openMessages(threadId) {
  closeSheets();
  closeDrawer();
  document.body.dataset.companionMode = 'messages';
  const root = $("mx-root");
  root.hidden = false;
  localStorage.setItem("companionMode", "messages");
  if (!mx) {
    mx = mountMessenger(root, mxTransport, {
      lang: document.documentElement.lang || "fr",
      openThread: threadId,
      onClose: closeMessages,
      onVault: () => $("btn-vault").click(),
    });
  } else if (threadId) mx.open(threadId);
  else mx.refresh();
}
function closeMessages() {
  $("mx-root").hidden = true;
  delete document.body.dataset.companionMode;
  localStorage.setItem("companionMode", "classic");
}
$("btn-messages")?.addEventListener("click", () => openMessages());
{
  // Lien de notification (« /?messages=<fil> ») ou mode mémorisé.
  const q = new URLSearchParams(location.search).get("messages");
  if (q != null) openMessages(q || undefined);
  else if (localStorage.getItem("companionMode") === "messages" && authToken) openMessages();
}

// Pause painting while Safari is backgrounded; one socket/retry per page.
document.addEventListener('visibilitychange',()=>{
 if(document.hidden){transcriptRenderer.pause();clearTimeout(reconnectTimer);const socket=ws;ws=null;if(socket){socket.onclose=null;socket.close();}}
 else{transcriptRenderer.resume();connect();}
});
window.addEventListener('pagehide',()=>{transcriptRenderer.pause();clearTimeout(reconnectTimer);const socket=ws;ws=null;if(socket){socket.onclose=null;socket.close();}});
window.addEventListener('pageshow',()=>{transcriptRenderer.resume();connect();});
const vaultSheet=$('vault-sheet');const vaultFrame=$('vault-frame');
$('btn-vault')?.addEventListener('click',()=>{
 if(!authToken){showPairing();return;}
 sessionStorage.setItem('vaultToken',authToken);
 localStorage.setItem('lumenTheme',theme);
 if(!vaultFrame.getAttribute('src'))vaultFrame.src='/vault/vault.html';
 openSheet(vaultSheet);
});

