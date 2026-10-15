// Réunion (édition Pro) — visio, chat et assistant, sur le réseau de l'entreprise.
//
// Ce que l'app garantit, et qui explique sa forme :
//   • Le média ne quitte pas le réseau. WebRTC relie les postes directement ;
//     l'hôte ne sert qu'à les présenter l'un à l'autre (cf. rtc.js et meet.rs).
//   • La transcription est locale à chaque poste : Whisper tourne dans la
//     WebView de celui qui parle, et seul le TEXTE circule. Personne n'envoie
//     son micro à un service tiers pour être compris.
//   • Ce qui est dit ne s'évapore pas : chat, transcription et compte rendu
//     atterrissent dans une base SQLite ordinaire (store.js), relisible des mois
//     plus tard par Prisme, Fluxo ou un agent.
//   • L'assistant n'a que des outils de réunion : lire les documents et les
//     bases, programmer la prochaine, rédiger le compte rendu de celle-ci.

import { store } from "./store.js";
import { chunkedPcm, joinRoom, levelMeter } from "./rtc.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { autoTranslate } from "../apps-i18n.js";
import { mountShell, avatar, kpi, emptyState, progress } from "../lib/app-shell.js";
import { requireProPage } from "../lib/pro-edition.js";
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { WHISPER_MODELS, whisperTranscribe } from "../lib/whisper-dictation.js";
import * as db from "../tables/client.js";
import { llmChat } from "../llm.js";
import { replyLang } from "../lib/prompt-lang.js";
import { PROMPTS } from "./prompts.js";
import { handoff, makeObject } from "../lib/interop.js";

// Icônes de la coquille (nav, en-têtes) : posées avant le premier rendu.
mountShell();

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const now = () => new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const today = () => new Date().toISOString().slice(0, 10);

const state = {
  view: "room",
  settings: readSettings(),
  host: null,        // { ip, port } de CE poste
  room: null,        // { id, code, title, invite, hosted }
  session: null,     // session rtc.js
  selfId: "",
  peers: new Map(),  // id → { name, stream, mic, cam, level }
  local: { stream: null, mic: true, cam: false, screen: false },
  mediaError: "",   // dernier refus d'accès micro/caméra, affiché dans la salle
  chat: [],
  transcript: [],
  panel: "chat",
  recorder: null,
  recording: null,   // { chunks, startedAt }
  stopTranscribe: null,
  stopMeter: null,
  meetingRow: null,  // ligne « Réunions » de la séance en cours
  sandboxes: [],
  bases: [],
  startedAt: 0,
};

function readSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem("meetSettings") || "{}");
    return {
      name: raw.name || "",
      cam: raw.cam || "",
      mic: raw.mic || "",
      sandbox: raw.sandbox || "",
      whisper: raw.whisper || localStorage.getItem("whisperModel") || "Xenova/whisper-base",
      chunk: Number(raw.chunk) || 8,
    };
  } catch {
    return { name: "", cam: "", mic: "", sandbox: "", whisper: "Xenova/whisper-base", chunk: 8 };
  }
}

const saveSettings = () => localStorage.setItem("meetSettings", JSON.stringify(state.settings));

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3600);
}

const displayName = () => state.settings.name || "Moi";

// ============================ Invitation ============================
//
// Une invitation tient en une ligne copiable : « adresse:port/salle/code ».
// C'est le seul objet que les participants s'échangent.

const inviteString = (host, room) => `${host.ip || "127.0.0.1"}:${host.port}/${room.room_id}/${room.code}`;

export function parseInvite(text) {
  const clean = String(text || "").trim().replace(/^https?:\/\//, "").replace(/^lumen-meet:\/\//, "");
  const m = clean.match(/^([^/\s]+?)(?::(\d+))?\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) || 8767, room: m[3], code: m[4] || "" };
}

// ============================ Médias ============================

async function ensureLocalStream({ cam = state.local.cam } = {}) {
  const constraints = {
    audio: state.settings.mic ? { deviceId: { exact: state.settings.mic }, echoCancellation: true, noiseSuppression: true }
                              : { echoCancellation: true, noiseSuppression: true },
    video: cam ? (state.settings.cam ? { deviceId: { exact: state.settings.cam }, width: { ideal: 1280 } } : { width: { ideal: 1280 } }) : false,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  // On garde UN seul flux local : les pistes du précédent sont libérées, sinon
  // le voyant de la caméra reste allumé après extinction.
  if (state.local.stream) {
    for (const track of state.local.stream.getTracks()) {
      if (!stream.getTracks().includes(track)) track.stop();
    }
  }
  state.local.stream = stream;
  for (const track of stream.getAudioTracks()) track.enabled = state.local.mic;
  state.session?.setLocalStream(stream);
  restartMeter();
  return stream;
}

function restartMeter() {
  state.stopMeter?.();
  state.stopMeter = null;
  const stream = state.local.stream;
  if (!stream || !stream.getAudioTracks().length) return;
  state.stopMeter = levelMeter(stream, (level) => {
    const tile = document.querySelector('.tile[data-id="me"]');
    tile?.classList.toggle("talking", level > 0.12 && state.local.mic);
  });
}

async function toggleMic() {
  state.local.mic = !state.local.mic;
  for (const track of state.local.stream?.getAudioTracks() || []) track.enabled = state.local.mic;
  broadcastState();
  renderStage();
}

async function toggleCam() {
  try {
    if (state.local.cam) {
      for (const track of state.local.stream?.getVideoTracks() || []) track.stop();
      state.local.cam = false;
      await ensureLocalStream({ cam: false });
    } else {
      state.local.cam = true;
      state.local.screen = false;
      await ensureLocalStream({ cam: true });
    }
  } catch (e) {
    state.local.cam = false;
    state.mediaError = mediaMessage(e);
    toast(state.mediaError);
  }
  broadcastState();
  renderStage();
}

/** Partage d'écran : la piste d'écran remplace la caméra, sans renégociation. */
async function toggleScreen() {
  try {
    if (state.local.screen) {
      state.local.screen = false;
      await ensureLocalStream({ cam: state.local.cam });
    } else {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = display.getVideoTracks()[0];
      screenTrack.addEventListener("ended", () => { state.local.screen = false; ensureLocalStream({ cam: state.local.cam }).then(renderStage); });
      const stream = new MediaStream([...(state.local.stream?.getAudioTracks() || []), screenTrack]);
      state.local.stream = stream;
      state.local.screen = true;
      state.session?.setLocalStream(stream);
    }
  } catch (e) {
    state.local.screen = false;
    // Un refus explicite de l'utilisateur n'est pas une erreur ; le reste si.
    if (e?.name !== "NotAllowedError") {
      toast(`Partage d'écran impossible : ${e.message || e}. Sur macOS, autorisez Lumen dans Réglages système → Confidentialité et sécurité → Enregistrement de l'écran.`);
    }
  }
  broadcastState();
  renderStage();
}

const broadcastState = () => state.session?.say({ type: "state", mic: state.local.mic, cam: state.local.cam || state.local.screen });

// ============================ Enregistrement & transcription ============================

/**
 * Enregistrement local de la séance : l'audio de CE poste, écrit dans une
 * sandbox à la fin. On n'enregistre pas le flux des autres — chacun est maître
 * de sa propre trace, et c'est plus honnête que de capter la salle entière
 * depuis un seul poste.
 */
async function toggleRecording() {
  if (state.recorder) {
    state.recorder.stop();
    return;
  }
  const stream = state.local.stream;
  if (!stream) { toast("Aucun micro actif."); return; }
  try {
    const audio = new MediaStream(stream.getAudioTracks());
    const recorder = new MediaRecorder(audio);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      state.recorder = null;
      renderStage();
      await saveRecording(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    recorder.start(1000);
    state.recorder = recorder;
    state.recording = { startedAt: Date.now() };
    startTranscription();
    toast("Enregistrement et transcription en cours.");
  } catch (e) {
    toast(`Enregistrement impossible : ${e.message || e}`);
  }
  renderStage();
}

async function saveRecording(blob) {
  stopTranscription();
  const sandbox = state.settings.sandbox || state.sandboxes[0]?.id;
  if (!sandbox || !invoke) { toast("Aucune sandbox : l'enregistrement n'a pas été conservé."); return; }
  const path = `reunions/${today()}-${(state.room?.title || "reunion").replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase()}.webm`;
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  try {
    await invoke("sandbox_import_file", { id: sandbox, path, dataB64: btoa(binary) });
    if (state.meetingRow) await store.update("meetings", state.meetingRow, { "Enregistrement": path });
    toast(`Enregistrement conservé : ${path}`);
  } catch (e) {
    toast(`Enregistrement non écrit : ${e.message || e}`);
  }
}

/**
 * Transcription continue, sur place. Chaque tranche est transcrite localement
 * puis diffusée en TEXTE aux autres participants : le fil de transcription est
 * donc complet chez tout le monde, sans qu'aucun micro ne quitte son poste.
 */
function startTranscription() {
  if (state.stopTranscribe || !state.local.stream) return;
  localStorage.setItem("whisperModel", state.settings.whisper);
  let busy = false;
  state.stopTranscribe = chunkedPcm(state.local.stream, {
    seconds: Math.max(4, Number(state.settings.chunk) || 8),
    onChunk: async (pcm) => {
      if (busy || !state.local.mic) return;   // micro coupé : rien à transcrire
      busy = true;
      try {
        const text = await whisperTranscribe(pcm);
        if (text) addTranscript(displayName(), text, true);
      } catch (e) {
        console.warn("[meet] transcription", e);
      } finally { busy = false; }
    },
  });
}

function stopTranscription() {
  state.stopTranscribe?.();
  state.stopTranscribe = null;
}

// ============================ Fil de salle ============================

async function addChat(author, text, mine) {
  const entry = { at: now(), author, text };
  state.chat.push(entry);
  if (mine) state.session?.say({ type: "chat", text });
  if (state.room && state.meetingRow !== null) {
    await safely(() => store.insert("messages", { "Salle": state.room.id, "Heure": entry.at, "Auteur": author, "Message": text }));
  }
  renderPanel();
}

async function addTranscript(speaker, text, mine) {
  const entry = { at: now(), speaker, text };
  state.transcript.push(entry);
  if (mine) state.session?.say({ type: "transcript", text });
  if (state.room && state.meetingRow !== null) {
    await safely(() => store.insert("transcript", { "Salle": state.room.id, "Heure": entry.at, "Intervenant": speaker, "Texte": text }));
  }
  if (state.panel === "transcript") renderPanel();
}

// ============================ Session ============================

async function openSession({ url, room, code, title, hosted }) {
  // La salle s'AFFICHE d'abord. Tout ce qui suit peut échouer — micro refusé,
  // hôte injoignable, base indisponible — et rien de tout cela ne doit laisser
  // l'utilisateur devant le formulaire, sans écran ni explication : c'était le
  // défaut le plus visible de la première version.
  state.room = { id: room, code, title: title || "Réunion", url, hosted };
  state.startedAt = Date.now();
  state.chat = [];
  state.transcript = [];
  state.peers.clear();
  state.mediaError = "";
  $("lobby").hidden = true;
  $("stage").hidden = false;
  showView("room");
  renderStage();
  renderPanel();

  try {
    await ensureLocalStream({ cam: false });
  } catch (e) {
    state.mediaError = mediaMessage(e);
    addSystem(state.mediaError);
    renderStage();
  }

  state.session = joinRoom({
    url, room, code, name: displayName(),
    onEvent: async (event) => {
      switch (event.type) {
        case "welcome":
          state.selfId = event.self;
          if (event.title) state.room.title = event.title;
          for (const p of event.peers || []) state.peers.set(p.id, { name: p.name, stream: null, mic: true, cam: false });
          renderStage();
          break;
        case "peer-join":
          state.peers.set(event.id, { name: event.name, stream: null, mic: true, cam: false });
          addSystem(`${event.name} a rejoint la réunion.`);
          renderStage();
          break;
        case "peer-leave":
          state.peers.delete(event.id);
          addSystem(`${event.name || "Un participant"} a quitté la réunion.`);
          renderStage();
          break;
        case "stream": {
          const peer = state.peers.get(event.id) || { name: event.name };
          peer.stream = event.stream;
          state.peers.set(event.id, peer);
          renderStage();
          break;
        }
        case "chat":
          await addChat(event.name || "Invité", event.text, false);
          break;
        case "transcript":
          await addTranscript(event.name || "Invité", event.text, false);
          break;
        case "state": {
          const peer = state.peers.get(event.from);
          if (peer) { peer.mic = event.mic; peer.cam = event.cam; renderStage(); }
          break;
        }
        case "error":
          toast(event.message);
          setNet(false, "connexion impossible");
          break;
        case "closed":
          setNet(false, "salle fermée");
          break;
        default: break;
      }
    },
  });

  // Le flux local est ouvert AVANT la session (autorisation micro) : il faut
  // donc le donner à la session dès sa création, sinon le premier appel part
  // sans piste et l'on s'entend « connecté mais muet ».
  if (state.local.stream) state.session.setLocalStream(state.local.stream);

  // Ligne de séance : elle existe dès l'ouverture, pour que le chat et la
  // transcription aient toujours une réunion à laquelle se rattacher. Si la
  // base n'est pas là, la réunion se tient quand même — elle ne laissera
  // simplement pas de trace, et on le dit.
  state.meetingRow = await safely(() => store.insert("meetings", {
    "Titre": state.room.title, "Date": today(), "Début": now(),
    "Salle": room, "Code": code, "Hôte": hosted ? displayName() : "",
    "Participants": displayName(),
  }), null);
  if (state.meetingRow === null) addSystem("La base « Réunions » n'est pas disponible : cette séance ne sera pas archivée.");
  renderStage();
  renderPanel();
}

/**
 * Exécute une écriture de base sans jamais faire tomber l'appelant. Les
 * fonctions du magasin lèvent DE FAÇON SYNCHRONE quand le schéma n'a pas pu
 * être créé : un simple `.catch()` ne les rattrape donc pas.
 */
async function safely(fn, fallback = null) {
  try { return await fn(); } catch (e) { console.warn("[meet]", e); return fallback; }
}

/** Message lisible pour un refus d'accès média — le plus courant des échecs. */
function mediaMessage(e) {
  const name = e?.name || "";
  if (!navigator.mediaDevices?.getUserMedia) {
    return "Cette fenêtre n'a pas accès aux périphériques audio et vidéo.";
  }
  if (name === "NotAllowedError") {
    return "Accès au micro refusé. Autorisez Lumen dans Réglages système → Confidentialité et sécurité → Microphone (et Caméra), puis relancez l'application.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Aucun périphérique correspondant : vérifiez la caméra et le micro choisis dans « Accès & matériel ».";
  }
  if (name === "NotReadableError") {
    return "Le périphérique est déjà utilisé par une autre application.";
  }
  return `Micro ou caméra indisponible : ${e?.message || e}`;
}

function addSystem(text) {
  state.chat.push({ at: now(), author: "", text, system: true });
  renderPanel();
}

async function leaveSession() {
  if (state.recorder) state.recorder.stop();
  stopTranscription();
  state.stopMeter?.();
  state.session?.close();
  state.session = null;
  for (const track of state.local.stream?.getTracks() || []) track.stop();
  state.local = { stream: null, mic: true, cam: false, screen: false };
  const minutes = Math.max(1, Math.round((Date.now() - state.startedAt) / 60000));
  if (state.meetingRow) {
    await safely(() => store.update("meetings", state.meetingRow, {
      "Fin": now(), "Durée min": minutes,
      "Participants": [displayName(), ...[...state.peers.values()].map((p) => p.name)].join(", "),
    }));
  }
  state.peers.clear();
  state.room = null;
  setNet(false, "hors salle");
  $("stage").hidden = true;
  $("lobby").hidden = false;
  await loadHistory();
  showView("room");
}

function setNet(on, label) {
  $("net-badge").textContent = label;
  $("net-dot").style.background = on ? "var(--accent)" : "var(--text-muted)";
}

// ============================ Rendu ============================


// Icônes des commandes de séance. Dessinées ici plutôt que puisées dans le jeu
// partagé : Lumen n'a ni caméra ni écran dans son jeu d'icônes, et des emojis
// détonneraient au milieu d'une interface entièrement en traits.
const CTRL_ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9V5a3 3 0 0 0-6 0v1"/><path d="M9 9v5a3 3 0 0 0 5.1 2.1"/><path d="M5 10a7 7 0 0 0 10.9 5.8"/><path d="M19 10v1a7 7 0 0 1-.3 2"/><path d="M12 17v5"/><path d="M3 3l18 18"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4z"/></svg>',
  screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="m12 12-2.5-2.5M12 8v4l2.5-2.5" /></svg>',
  record: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/></svg>',
  leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>',
};

const VIEW_META = {
  room: ["Salle", "Créer ou rejoindre une réunion"],
  history: ["Historique", "Ce que vos réunions ont laissé"],
  settings: ["Accès & matériel", "Identité, caméra, micro, transcription"],
};

function showView(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const [title, sub] = VIEW_META[view] || ["", ""];
  $("view-title").textContent = state.room && view === "room" ? state.room.title : title;
  $("view-sub").textContent = state.room && view === "room"
    ? `Salle ${state.room.id} · ${state.peers.size + 1} participant(s)` : sub;
  $("top-actions").innerHTML = view === "room" && state.room
    ? `<button class="btn ghost" data-act="copy-invite">Copier l'invitation</button>
       <button class="btn" data-act="minutes">Compte rendu</button>
       <button class="btn danger" data-act="leave">Quitter la réunion</button>`
    : "";
  $("scroll").scrollTop = 0;
  if (view === "history") renderHistory();
  if (view === "settings") renderSettings();
}

function renderStage() {
  if (!state.room) return;
  // L'en-tête suit la salle : un participant qui arrive ou qui part change le
  // décompte, sans qu'on ait à changer de vue.
  const count = state.peers.size + 1;
  $("view-sub").textContent = `Salle ${state.room.id} · ${count} participant(s)`;
  setNet(true, `${count} participant(s)`);
  const tiles = [
    { id: "me", name: `${displayName()} (vous)`, stream: state.local.stream, mic: state.local.mic, cam: state.local.cam || state.local.screen, self: true },
    ...[...state.peers.entries()].map(([id, p]) => ({ id, name: p.name, stream: p.stream, mic: p.mic, cam: p.cam })),
  ];
  const banner = $("media-banner");
  banner.hidden = !state.mediaError;
  if (state.mediaError) {
    banner.innerHTML = `<span>${esc(state.mediaError)}</span>
      <button class="btn tiny" data-act="retry-media">Réessayer</button>`;
  }

  const host = $("tiles");
  host.style.setProperty("--cols", Math.min(3, Math.ceil(Math.sqrt(tiles.length))));
  host.innerHTML = tiles.map((t) => `
    <figure class="tile ${t.cam ? "" : "no-video"}" data-id="${esc(t.id)}">
      <video autoplay playsinline ${t.self ? "muted" : ""}></video>
      <div class="avatar">${esc((t.name || "?").trim().charAt(0).toUpperCase())}</div>
      <figcaption><span class="t-name">${esc(t.name)}</span>${t.mic ? "" : `<span class="t-muted" title="Micro coupé">${CTRL_ICONS.micOff}</span>`}</figcaption>
    </figure>`).join("");
  // Les flux sont posés APRÈS l'écriture du HTML : un srcObject ne survit pas
  // à une sérialisation en chaîne.
  for (const t of tiles) {
    const video = host.querySelector(`.tile[data-id="${CSS.escape(t.id)}"] video`);
    if (video && t.stream && video.srcObject !== t.stream) video.srcObject = t.stream;
  }

  $("controls").innerHTML = `
    <button class="ctrl ${state.local.mic ? "" : "off"}" data-act="mic" title="Micro">${state.local.mic ? CTRL_ICONS.mic : CTRL_ICONS.micOff}<span>${state.local.mic ? "Micro" : "Coupé"}</span></button>
    <button class="ctrl ${state.local.cam ? "on" : ""}" data-act="cam" title="Caméra">${CTRL_ICONS.cam}<span>Caméra</span></button>
    <button class="ctrl ${state.local.screen ? "on" : ""}" data-act="screen" title="Partager l'écran">${CTRL_ICONS.screen}<span>Écran</span></button>
    <button class="ctrl ${state.recorder ? "rec" : ""}" data-act="record" title="Enregistrer et transcrire">${state.recorder ? CTRL_ICONS.stop : CTRL_ICONS.record}<span>${state.recorder ? "Arrêter" : "Enregistrer l'audio"}</span></button>
    <button class="ctrl danger" data-act="leave" title="Quitter la réunion">${CTRL_ICONS.leave}<span>Quitter la réunion</span></button>`;
}

function renderPanel() {
  const body = $("panel-body");
  document.querySelectorAll("#panel-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.panel === state.panel));
  $("chat-form").hidden = state.panel !== "chat";
  if (state.panel === "chat") {
    body.innerHTML = state.chat.map((m) => m.system
      ? `<div class="sys">${esc(m.text)}</div>`
      : `<div class="msg"><div class="m-head"><span class="m-author">${esc(m.author)}</span><span class="m-at">${esc(m.at)}</span></div><div class="m-text">${esc(m.text)}</div></div>`).join("")
      || `<div class="empty">Le fil est vide. Écrivez au groupe, ou demandez quelque chose à l'assistant.</div>`;
  } else if (state.panel === "transcript") {
    body.innerHTML = state.transcript.map((t) => `<div class="line"><span class="l-at">${esc(t.at)}</span><span class="l-who">${esc(t.speaker)}</span><span class="l-text">${esc(t.text)}</span></div>`).join("")
      || `<div class="empty">Aucune transcription. Lancez l'enregistrement : chaque participant transcrit sa propre voix, sur sa machine.</div>`;
  } else {
    const rows = [{ name: `${displayName()} (vous)`, mic: state.local.mic, cam: state.local.cam || state.local.screen },
      ...[...state.peers.values()].map((p) => ({ name: p.name, mic: p.mic, cam: p.cam }))];
    body.innerHTML = rows.map((p) => `<div class="person"><span class="p-dot"></span><span class="p-name">${esc(p.name)}</span>
      <span class="badge ${p.mic ? "ok" : ""}">${p.mic ? "micro" : "muet"}</span>${p.cam ? `<span class="badge">caméra</span>` : ""}</div>`).join("");
  }
  body.scrollTop = body.scrollHeight;
}

async function loadHistory() {
  try { state.history = await store.list("meetings"); } catch { state.history = []; }
  state.history.reverse();
}

function renderHistory() {
  const q = $("history-search").value.trim().toLowerCase();
  const rows = (state.history || []).filter((r) => `${r["Titre"]} ${r["Participants"]} ${r["Compte rendu"]}`.toLowerCase().includes(q));
  $("history-table").innerHTML = `
    <thead><tr><th>Réunion</th><th>Date</th><th>Durée</th><th>Participants</th><th>Compte rendu</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><strong>${esc(r["Titre"] || "Réunion")}</strong>${r["Enregistrement"] ? ` <span class="badge">enregistrée</span>` : ""}</td>
      <td>${esc(r["Date"] || "")} ${esc(r["Début"] || "")}</td>
      <td>${r["Durée min"] ? `${esc(r["Durée min"])} min` : "—"}</td>
      <td>${esc(r["Participants"] || "—")}</td>
      <td>${r["Compte rendu"] ? `<span class="badge ok">rédigé</span>` : `<span class="badge">absent</span>`}</td>
      <td><div class="row-actions">
        <button class="btn tiny ghost" data-act="open-minutes" data-id="${r._id}">Ouvrir</button>
        <button class="btn tiny ghost danger" data-act="del-meeting" data-id="${r._id}">Suppr.</button>
      </div></td></tr>`).join("") || `<tr><td colspan="6"><div class="empty">Aucune réunion enregistrée.</div></td></tr>`}</tbody>`;
}

async function renderSettings() {
  $("set-name").value = state.settings.name;
  $("set-chunk").value = state.settings.chunk;
  $("set-whisper").innerHTML = WHISPER_MODELS.map((m) => `<option value="${esc(m.id)}" ${m.id === state.settings.whisper ? "selected" : ""}>${esc(m.label)} — ${esc(m.sizeLabel)}</option>`).join("");
  $("set-sandbox").innerHTML = state.sandboxes.map((s) => `<option value="${esc(s.id)}" ${s.id === state.settings.sandbox ? "selected" : ""}>${esc(s.name || s.id)}</option>`).join("")
    || `<option value="">Aucune sandbox</option>`;
  const info = state.host
    ? `Votre poste est joignable sur <code>${esc(state.host.ip || "adresse inconnue")}:${state.host.port}</code>. Les participants doivent être sur le même réseau (LAN ou VPN d'entreprise) et ce port doit être ouvert entre les postes.`
    : "Adresse réseau inconnue.";
  $("net-info").innerHTML = info;
}

/**
 * Périphériques. Un navigateur ne DONNE LE NOM d'une caméra ou d'un micro
 * qu'après une autorisation d'accès : sans elle, la liste revient anonyme
 * (« Périphérique »), ce qui se lit à tort comme « Lumen ne voit pas ma
 * caméra ». On demande donc l'accès aux deux avant d'énumérer, et on explique
 * ce qui manque quand le nom reste vide.
 */
async function listDevices() {
  const status = $("device-status");
  if (!navigator.mediaDevices?.enumerateDevices) {
    status.textContent = "Cette fenêtre n'a pas accès aux périphériques audio et vidéo.";
    return;
  }
  let granted = { audio: false, video: false };
  for (const kind of ["audio", "video"]) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ [kind]: true });
      stream.getTracks().forEach((t) => t.stop());
      granted[kind] = true;
    } catch { /* refus ou absence : on le dira plus bas */ }
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (id, kind, label) => {
    const list = devices.filter((d) => d.kind === kind);
    $(id).innerHTML = list
      .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `${label} ${i + 1} (nom masqué)`)}</option>`).join("")
      || `<option value="">Aucun ${label.toLowerCase()} détecté</option>`;
    return list.length;
  };
  const cams = fill("set-cam", "videoinput", "Caméra");
  const mics = fill("set-mic", "audioinput", "Micro");
  if (state.settings.cam) $("set-cam").value = state.settings.cam;
  if (state.settings.mic) $("set-mic").value = state.settings.mic;

  const missing = [];
  if (!granted.video) missing.push("caméra");
  if (!granted.audio) missing.push("micro");
  status.textContent = missing.length
    ? `${cams} caméra(s), ${mics} micro(s) détecté(s), mais l'accès ${missing.join(" et ")} n'est pas accordé. `
      + "Sur macOS : Réglages système → Confidentialité et sécurité → Caméra / Microphone, cochez Lumen, puis relancez l'application."
    : `${cams} caméra(s) et ${mics} micro(s) disponibles.`;
}

// ============================ Compte rendu ============================

const transcriptText = () => state.transcript.map((t) => `[${t.at}] ${t.speaker} : ${t.text}`).join("\n");
const chatText = () => state.chat.filter((m) => !m.system).map((m) => `[${m.at}] ${m.author} : ${m.text}`).join("\n");

/**
 * Compte rendu : rédigé à partir de la transcription ET du fil de discussion.
 * Sans transcription, on le dit — un compte rendu inventé serait pire que pas
 * de compte rendu du tout.
 */
async function makeMinutes(onDelta) {
  if (!state.transcript.length && !state.chat.length) {
    return "Aucune matière : ni transcription, ni messages. Lancez l'enregistrement pendant la réunion pour obtenir un compte rendu.";
  }
  const participants = [displayName(), ...[...state.peers.values()].map((p) => p.name)].join(", ");
  const { messages } = PROMPTS["app.meet.minutes"].build({
    title: state.room?.title || "sans titre", date: today(), participants,
    transcript: transcriptText(), chat: chatText(), lang: replyLang(),
  });
  const { content } = await llmChat(messages, { rawSystem: true, ...(onDelta ? { onDelta } : {}) });
  return String(content || "").trim();
}

/** Puces de la rubrique « Actions » d'un compte rendu (hors « Rien à signaler »). */
export function minutesActions(md) {
  const lines = String(md || "").split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    const head = line.replace(/[#*_]/g, "").trim();
    if (/^actions?\s*:?$/i.test(head)) { inside = true; continue; }
    if (inside && /^(#|\*\*)/.test(line.trim()) && !/^[-*•]\s/.test(line.trim())) break;
    if (!inside) continue;
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (m && m[1].trim() && !/rien à signaler/i.test(m[1])) out.push(m[1].replace(/\*\*/g, "").trim());
  }
  return out;
}

async function openMinutes(existing) {
  $("minutes-modal").hidden = false;
  $("minutes-status").textContent = existing ? "" : "Rédaction en cours…";
  $("minutes-text").value = existing || "";
  if (existing) return;
  try {
    // Le compte rendu s'écrit sous les yeux de l'utilisateur.
    $("minutes-text").value = await makeMinutes((txt) => { if (txt) $("minutes-text").value = txt; });
    $("minutes-status").textContent = "Relisez avant diffusion : le compte rendu est produit à partir de la transcription.";
  } catch (e) {
    $("minutes-status").textContent = `Rédaction impossible : ${e.message || e}`;
  }
}

// ============================ Assistant de réunion ============================
//
// Les quatre gestes attendus pendant une réunion : consulter (documents, bases),
// programmer la suivante, rendre compte de celle-ci, et sortir un rapport
// chiffré. Chacun est un outil — l'assistant ne peut rien faire d'autre.

const MEET_TOOLS = [
  tool("room_status", "État de la réunion : titre, participants, durée, enregistrement, nombre de lignes de transcription.", {}),
  tool("send_message", "Poste un message dans le fil de la réunion (visible par tous les participants).",
    { texte: T.str("") }, ["texte"]),
  tool("read_transcript", "Renvoie la transcription de la réunion en cours.", { derniers: T.int("Nombre de lignes récentes ; toutes si omis") }),
  tool("list_documents", "Liste les fichiers d'une sandbox (dossier facultatif).",
    { sandbox: T.str("Nom ou identifiant ; la sandbox par défaut si omis"), dossier: T.str("Sous-dossier, ex. « contrats »") }, []),
  tool("read_document", "Lit un document d'une sandbox et renvoie son texte. PDF, Word, Excel, PowerPoint, OpenDocument, HTML et texte sont convertis ; une image est décrite.",
    { chemin: T.str("Chemin dans la sandbox"), sandbox: T.str("") }, ["chemin"]),
  tool("list_bases", "Liste les bases de données locales et leurs tables.", {}),
  tool("ask_data", "Interroge une base en langage naturel : l'analyste enchaîne plusieurs requêtes SQL de lecture puis répond.",
    { base: T.str("Nom de la base"), question: T.str("") }, ["base", "question"]),
  tool("data_report", "Produit un rapport écrit sur des données (constats chiffrés, tendances, points d'attention) et le poste dans le fil.",
    { base: T.str(""), sujet: T.str("Ce sur quoi porte le rapport") }, ["base", "sujet"]),
  tool("schedule_meeting", "Programme une réunion dans le calendrier de Lumen (rappel daté).",
    { titre: T.str(""), date: T.str("AAAA-MM-JJ"), heure: T.str("HH:MM"), duree_min: T.int("Durée en minutes"),
      participants: T.list("Noms des participants"), note: T.str("Ordre du jour") }, ["titre", "date", "heure"]),
  tool("write_minutes", "Rédige le compte rendu de la réunion en cours à partir de la transcription et du fil, et l'enregistre.", {}),
  tool("save_note", "Ajoute une décision ou une action à la fiche de la réunion.",
    { texte: T.str("La décision ou l'action, en une phrase") }, ["texte"]),
];

const sandboxIdOf = (name) => {
  if (!name) return state.settings.sandbox || state.sandboxes[0]?.id || "";
  const found = state.sandboxes.find((s) => s.id === name || (s.name || "").toLowerCase() === String(name).toLowerCase());
  return found?.id || state.settings.sandbox || state.sandboxes[0]?.id || "";
};

async function runMeetTool(name, a) {
  switch (name) {
    case "room_status": {
      if (!state.room) return "Aucune réunion en cours. L'utilisateur doit ouvrir ou rejoindre une salle.";
      const minutes = Math.max(1, Math.round((Date.now() - state.startedAt) / 60000));
      return JSON.stringify({
        titre: state.room.title, salle: state.room.id, minutes_ecoulees: minutes,
        participants: [displayName(), ...[...state.peers.values()].map((p) => p.name)],
        enregistrement: !!state.recorder, lignes_transcription: state.transcript.length, messages: state.chat.length,
      });
    }
    case "send_message":
      await addChat(displayName(), a.texte, true);
      return "Message posté dans le fil.";
    case "read_transcript": {
      if (!state.transcript.length) return "La transcription est vide : l'enregistrement n'a pas été lancé.";
      const lines = a.derniers ? state.transcript.slice(-Number(a.derniers)) : state.transcript;
      return lines.map((t) => `[${t.at}] ${t.speaker} : ${t.text}`).join("\n");
    }
    case "list_documents": {
      const id = sandboxIdOf(a.sandbox);
      if (!id || !invoke) return "Aucune sandbox disponible.";
      const entries = await invoke("sandbox_read_dir", { id, path: a.dossier || "" }).catch(() => []);
      if (!entries?.length) return "Ce dossier est vide.";
      return entries.map((e) => `${e.name || e}${e.is_dir ? "/" : ""}`).join("\n");
    }
    case "read_document": {
      const id = sandboxIdOf(a.sandbox);
      if (!id || !invoke) return "Aucune sandbox disponible.";
      try {
        const file = await invoke("sandbox_read_file", { id, path: a.chemin });
        const text = typeof file === "string" ? file : (file?.content ?? "");
        if (!text) return `« ${a.chemin} » est vide ou illisible.`;
        // Un document long sature le contexte : on borne, en le disant.
        return text.length > 24000 ? `${text.slice(0, 24000)}\n… (document tronqué)` : text;
      } catch (e) {
        return `Lecture impossible de « ${a.chemin} » : ${e.message || e}`;
      }
    }
    case "list_bases": {
      const bases = await db.listBases();
      state.bases = bases;
      if (!bases.length) return "Aucune base de données locale.";
      const out = [];
      for (const b of bases) {
        const tables = await db.listTables(b.base_id).catch(() => []);
        out.push(`${b.name} : ${tables.map((t) => `${t.name} (${t.rows} lignes)`).join(", ") || "aucune table"}`);
      }
      return out.join("\n");
    }
    case "ask_data": {
      const base = (await db.listBases()).find((b) => b.name.toLowerCase() === String(a.base).toLowerCase());
      if (!base) return `Base « ${a.base} » introuvable — appelle list_bases.`;
      const { answer, steps } = await db.investigate(base.base_id, a.question, null, 4);
      return `${answer}\n\n(${steps.length} requête(s) exécutée(s))`;
    }
    case "data_report": {
      const base = (await db.listBases()).find((b) => b.name.toLowerCase() === String(a.base).toLowerCase());
      if (!base) return `Base « ${a.base} » introuvable — appelle list_bases.`;
      const { answer } = await db.investigate(base.base_id,
        `Rédige un rapport structuré sur : ${a.sujet}. Donne les chiffres clés, les tendances, les points d'attention, puis une conclusion courte.`,
        null, 5);
      await addChat(displayName(), `📊 Rapport — ${a.sujet}\n\n${answer}`, true);
      return `Rapport produit et posté dans le fil :\n${answer}`;
    }
    case "schedule_meeting": {
      if (!invoke) return "Calendrier indisponible hors de Lumen.";
      const due = new Date(`${a.date}T${(a.heure || "09:00")}:00`).getTime();
      if (!Number.isFinite(due)) return "Date ou heure invalide (format attendu : AAAA-MM-JJ et HH:MM).";
      let reminders = [];
      try { reminders = JSON.parse((await invoke("reminders_load")) || "[]"); } catch { reminders = []; }
      if (!Array.isArray(reminders)) reminders = [];
      reminders.unshift({
        id: `rem-${Date.now()}`, title: a.titre, note: a.note || "",
        due_at: due, recur: "none", done: false, fired: false,
        source: "meet", created_at: Date.now(),
        participants: a.participants || [],
      });
      await invoke("reminders_save", { data: JSON.stringify(reminders) });
      return `Réunion « ${a.titre} » programmée le ${new Date(due).toLocaleString("fr-FR")}${a.participants?.length ? ` avec ${a.participants.join(", ")}` : ""}. Elle apparaît dans Tempo → Agenda.`;
    }
    case "write_minutes": {
      const text = await makeMinutes();
      if (state.meetingRow) await store.update("meetings", state.meetingRow, { "Compte rendu": text });
      $("minutes-text").value = text;
      return `Compte rendu rédigé et enregistré :\n\n${text}`;
    }
    case "save_note": {
      if (!state.meetingRow) return "Aucune réunion en cours.";
      const row = (await store.list("meetings")).find((r) => r._id === state.meetingRow);
      const decisions = `${row?.["Décisions"] || ""}${row?.["Décisions"] ? "\n" : ""}- ${a.texte}`;
      await store.update("meetings", state.meetingRow, { "Décisions": decisions });
      return "Noté dans la fiche de la réunion.";
    }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountAi() {
  mountAiPrompt(null, {
    app: "Réunion",
    title: "Assistant",
    intro: "Tu assistes une réunion d'équipe : tu consultes les documents et les bases de l'entreprise, tu réponds aux questions posées en séance, tu programmes les réunions et tu rédiges les comptes rendus.",
    rules: [
      "- Pour répondre à partir d'un document, lis-le vraiment (list_documents puis read_document) : ne réponds jamais de mémoire sur un fichier.",
      "- Pour une question chiffrée, passe par ask_data ou data_report : les nombres viennent de la base, jamais d'une estimation.",
      "- Un compte rendu ne s'invente pas : sans transcription ni messages, dis-le et propose de lancer l'enregistrement.",
      "- Quand ta réponse intéresse toute la salle, poste-la avec send_message plutôt que de la garder pour l'utilisateur seul.",
      "- Pour programmer une réunion, vérifie la date, l'heure et les participants avant d'appeler schedule_meeting.",
    ].join("\n"),
    placeholder: "Ex. : résume le contrat dans Documents et dis-moi ce qui change pour nous…",
    suggestions: [
      { label: "Analyser un document", prompt: "Lis les documents utiles de ma sandbox et réponds à la question que je vais te poser." },
      { label: "Interroger les données", prompt: "Interroge ma base de données pour répondre à une question chiffrée posée en réunion." },
      { label: "Compte rendu", prompt: "Rédige le compte rendu de cette réunion à partir de la transcription, puis enregistre-le." },
      { label: "Programmer la suivante", prompt: "Programme la prochaine réunion et note l'ordre du jour." },
      { label: "Rapport de données", prompt: "Produis un rapport chiffré sur l'activité et poste-le dans le fil de la réunion." },
    ],
    tools: MEET_TOOLS,
    context: async () => {
      const lines = [
        state.room ? `Réunion en cours : « ${state.room.title} » (salle ${state.room.id}), ${state.peers.size + 1} participant(s).` : "Aucune réunion en cours.",
        `Transcription : ${state.transcript.length} ligne(s). Messages : ${state.chat.length}.`,
        `Sandboxes : ${state.sandboxes.map((s) => s.name || s.id).join(", ") || "aucune"}.`,
      ];
      if (state.transcript.length) lines.push(`Dernières paroles :\n${state.transcript.slice(-12).map((t) => `${t.speaker} : ${t.text}`).join("\n")}`);
      return lines.join("\n");
    },
    execute: runMeetTool,
    onApplied: async () => { renderPanel(); },
  });
}

// ============================ Câblage ============================

function wire() {
  $("nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) showView(b.dataset.view);
  });
  $("panel-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-panel]");
    if (!b) return;
    state.panel = b.dataset.panel;
    renderPanel();
  });
  $("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("chat-input").value.trim();
    if (!text) return;
    $("chat-input").value = "";
    await addChat(displayName(), text, true);
  });
  $("history-search").addEventListener("input", renderHistory);
  document.querySelectorAll(".backdrop").forEach((bd) => bd.addEventListener("click", (e) => {
    if (e.target === bd || e.target.closest("[data-close]")) bd.hidden = true;
  }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".backdrop:not([hidden])").forEach((bd) => { bd.hidden = true; });
  });

  $("minutes-save").addEventListener("click", async () => {
    if (!state.meetingRow) { toast("Aucune réunion à laquelle rattacher ce compte rendu."); return; }
    await store.update("meetings", state.meetingRow, { "Compte rendu": $("minutes-text").value });
    await loadHistory();
    $("minutes-modal").hidden = true;
    toast("Compte rendu enregistré.");
  });
  // Les actions décidées vont dans Organisation (Tableau) : Réunion ne tient
  // pas de seconde liste de tâches. Une carte par puce de la rubrique
  // « Actions » (« responsable — action — échéance »).
  $("minutes-actions")?.addEventListener("click", () => {
    const actions = minutesActions($("minutes-text").value);
    if (!actions.length) { toast("Aucune action dans le compte rendu."); return; }
    for (const text of actions) {
      handoff("kanban", makeObject("task", { text, title: text }, { app: "meet", title: state.room?.title || "Réunion" }));
    }
    toast(`${actions.length} action(s) envoyée(s) au Tableau.`);
  });
  $("minutes-export").addEventListener("click", () => {
    const make = window.parent?.LumenMakeObject || window.LumenMakeObject;
    const share = window.parent?.LumenShare || window.LumenShare;
    if (!make || !share) { toast("Disponible depuis le bureau de Lumen."); return; }
    share(make("text", {
      title: `Compte rendu — ${state.room?.title || "réunion"}`,
      text: $("minutes-text").value, markdown: true,
    }, { app: "meet" }));
  });

  document.body.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    switch (btn.dataset.act) {
      case "host": {
        const title = $("host-title").value.trim() || "Réunion";
        state.settings.name = $("host-name").value.trim() || state.settings.name;
        saveSettings();
        $("host-status").textContent = "Ouverture de la salle…";
        try {
          const room = await invoke("meet_open_room", { title, roomId: null, code: null });
          // Sans adresse de LAN (machine hors réseau, VPN qui n'expose rien),
          // la salle existe quand même : elle n'est joignable que depuis ce
          // poste, et l'invitation le dit plutôt que d'afficher « undefined ».
          state.host = (await invoke("meet_host").catch(() => null)) || { port: 8767, ip: "" };
          const localOnly = !state.host.ip;
          if (localOnly) state.host = { ...state.host, ip: "127.0.0.1" };
          const invite = inviteString(state.host, room);
          $("host-status").textContent = "";
          $("invite").hidden = false;
          $("invite").innerHTML = `<div class="i-label">Invitation à transmettre</div>
            <code class="i-code">${esc(invite)}</code>
            <button class="btn tiny" data-act="copy-invite">Copier</button>
            <p class="hint">${localOnly
              ? "Aucune adresse réseau détectée : cette salle n'est joignable que depuis ce poste. Connectez-vous au réseau de l'entreprise ou au VPN, puis rouvrez la salle."
              : "Les participants doivent être sur le même réseau (LAN ou VPN)."} Code de salle : <strong>${esc(room.code)}</strong>.</p>`;
          await openSession({ url: `http://${state.host.ip}:${state.host.port}`, room: room.room_id, code: room.code, title, hosted: true });
        } catch (err) {
          $("host-status").textContent = String(err?.message || err);
        }
        break;
      }
      case "join": {
        const parsed = parseInvite($("join-invite").value);
        state.settings.name = $("join-name").value.trim() || state.settings.name;
        saveSettings();
        if (!parsed) { $("join-status").textContent = "Invitation illisible. Format attendu : adresse:port/salle/code"; return; }
        $("join-status").textContent = "Connexion…";
        await openSession({ url: `http://${parsed.host}:${parsed.port}`, room: parsed.room, code: parsed.code, title: "Réunion", hosted: false });
        $("join-status").textContent = "";
        break;
      }
      case "copy-invite": {
        const invite = state.room ? `${state.host?.ip || "127.0.0.1"}:${state.host?.port || 8767}/${state.room.id}/${state.room.code}` : "";
        try { await navigator.clipboard.writeText(invite); toast("Invitation copiée."); }
        catch { toast(invite); }
        break;
      }
      case "retry-media":
        try {
          await ensureLocalStream({ cam: state.local.cam });
          state.mediaError = "";
          addSystem("Micro et caméra disponibles.");
        } catch (e) {
          state.mediaError = mediaMessage(e);
          toast(state.mediaError);
        }
        renderStage();
        break;
      case "mic": await toggleMic(); break;
      case "cam": await toggleCam(); break;
      case "screen": await toggleScreen(); break;
      case "record": await toggleRecording(); break;
      case "leave": await leaveSession(); break;
      case "minutes": await openMinutes(""); break;
      case "devices": await listDevices(); break;
      case "save-settings":
        state.settings = {
          ...state.settings,
          name: $("set-name").value.trim(),
          cam: $("set-cam").value, mic: $("set-mic").value,
          sandbox: $("set-sandbox").value,
          whisper: $("set-whisper").value,
          chunk: Number($("set-chunk").value) || 8,
        };
        saveSettings();
        $("settings-status").textContent = "Réglages enregistrés.";
        break;
      case "open-minutes": {
        const row = (state.history || []).find((r) => String(r._id) === btn.dataset.id);
        if (!row) return;
        $("minutes-title").textContent = `Compte rendu — ${row["Titre"] || "réunion"}`;
        state.meetingRow = row._id;
        await openMinutes(row["Compte rendu"] || "");
        break;
      }
      case "del-meeting":
        if (!await confirmSheet({ title: "Supprimer cette réunion ?", body: "Son compte rendu et sa fiche seront retirés de l'historique.", confirm: "Supprimer", danger: true })) return;
        await store.remove("meetings", Number(btn.dataset.id));
        await loadHistory();
        renderHistory();
        break;
      default: break;
    }
  });

  // Quitter proprement : sans cela, la salle garde un participant fantôme et la
  // caméra reste allumée jusqu'à la fermeture de la fenêtre.
  window.addEventListener("beforeunload", () => {
    state.session?.close();
    for (const track of state.local.stream?.getTracks() || []) track.stop();
  });
}

// ============================ Démarrage ============================

async function init() {
  if (!(await requireProPage({ appName: "L'application Réunion" }))) return;
  wire();
  state.settings.name = state.settings.name || "Moi";
  $("host-name").value = state.settings.name;
  $("join-name").value = state.settings.name;
  try {
    await store.ensureSchema();
    await loadHistory();
  } catch (e) {
    console.warn("[meet] base indisponible", e);
  }
  state.sandboxes = invoke ? await invoke("sandbox_list").catch(() => []) : [];
  state.host = invoke ? await invoke("meet_host").catch(() => null) : null;
  if (state.host?.ip) $("brand-sub").textContent = `${state.host.ip}:${state.host.port}`;
  showView("room");
  mountAi();
  autoTranslate({ observe: true });
}

init();
