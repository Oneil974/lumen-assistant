// Lumen XR — client spatial WebXR (Meta Quest 3/3S).
//
// Le casque est une INTERFACE du même Lumen, pas une nouvelle IA : il se
// connecte au WebSocket du compagnon (même appairage TOTP) et relaie tout au
// bureau, qui garde routeur, LLM/VLM, outils, mémoire. Ce que fait le casque :
//
//   • rendu MR (passthrough) : l'orbe du bureau (lib/orb-materials.js) avec un
//     visage 3D qui suit du regard l'utilisateur et ses mains, des panneaux
//     semi-transparents, l'ombre de l'orbe sur la table ;
//   • ancrage (xr-spatial.js) : ancres persistantes, aimantation aux tables et
//     aux murs détectés, fiche « Regarde » posée à côté de l'objet observé ;
//   • mains (xr-hands.js) : rayon ou saisie DIRECTE, redimensionnement à deux
//     mains, appui du bout du doigt, paume vers le haut pour appeler l'orbe ;
//   • voix : micro → Whisper du bureau (`xr-audio`), réponse lue AU FIL de la
//     génération par Piper/Kokoro (`xr-tts`) en son spatial depuis l'orbe,
//     interruption à la voix, mains libres (« Lumen, … ») ;
//   • apps (xr-apps.js) : agents, documents, données, notifications, Halo ;
//   • « Regarde » : UNE image de la caméra, uniquement à la demande ;
//   • voyant de confidentialité dès que le micro ou la caméra sont ouverts ;
//   • mode performance : 72 Hz, résolution réduite des panneaux et du rendu.
//
// Hors casque (navigateur de bureau), la même scène tourne en aperçu à la
// souris : utile pour développer sans enfiler le Quest.

import * as THREE from "/lib/three.module.js";
import { Panel, THEME, wrap, plain, markdownLines, drawMarkdownLine, roundRect, drawIcon, setPanelDensity, setMaxAnisotropy } from "/xr-panels.js";
import { PanelLayers } from "/xr-layers.js";
import { createToolBelt } from "/xr-belt.js";
import { createOrbMaterials } from "/lib/orb-materials.js";
import { mouthScale, mouthOpacity, mouthSizeFromEye, syntheticLevel } from "/lib/voice-mouth.js";
import { ORB_DEFAULT } from "/lib/orb-palette.js";
import { Spatial, setWorldPose, setWorldPosition } from "/xr-spatial.js";
import { Hands } from "/xr-hands.js";
import { createApps } from "/xr-apps.js";
import { WakeWord } from "/xr-wake.js";
import { createSpace } from "/xr-space.js";
import { createExtras } from "/xr-extras.js";
import { HEADSET_MODELS, headsetWhisperSupported, preloadHeadsetWhisper, transcribeInHeadset } from "/xr-whisper.js";
import { createLightDesk } from "/xr-light-desk.js";
import { createProps } from "/xr-props.js";
import { createThoughts } from "/xr-thoughts.js";
import { createEnvironment, ENVIRONMENTS } from "/xr-env.js";
import { createMorning } from "/xr-morning.js";
import { readText, translateInHeadset, preloadTranslation, chainFor, detectLang } from "/xr-translate.js";

const $ = (id) => document.getElementById(id);
// Langue de LUMEN (réglage du bureau), pas celle du navigateur du casque : le
// bureau l'envoie à la connexion (`lumen-lang`) et on la garde pour le prochain
// lancement ; à défaut, la langue du casque.
const LANG = (() => {
  try { const l = localStorage.getItem("xrLang"); if (l === "fr" || l === "en") return l; } catch {}
  return (navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en";
})();
const T = (fr, en) => (LANG === "fr" ? fr : en);
// Sous-titres de transcription en direct : désactivés (transcription basique).
const XR_LIVE_PARTIALS = false;

// Textes statiques de la page d'accueil (écrits en français dans xr.html).
if (LANG === "en") {
  document.documentElement.lang = "en";
  const EN = {
    "#home p": "The orb and your conversations, in the room. Pinch the orb to talk, say “Look…” to show it something.",
    "#enter-ar": "Enter mixed reality",
    "#enter-vr": "VR mode",
    "#pair h1": "Pair the headset",
    "#pair p": "Enter your Lumen identifier and the 6-digit code shown in Settings › Companion.",
    "label[for=pair-id]": "Identifier",
    "label[for=pair-code]": "Code",
    "#pair-form button": "Pair",
    "#conn": "Connecting…",
  };
  for (const [sel, txt] of Object.entries(EN)) { const el = document.querySelector(sel); if (el) el.textContent = txt; }
}

// ---------------------------------------------------------------------------
// Réglages (mémorisés dans le casque)
// ---------------------------------------------------------------------------
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const settings = {
  perf: lsGet("xrPerf", "off") === "on",
  textSize: Math.max(24,Math.min(36,Number(lsGet("xrTextSize","28")) || 28)),
  readingContrast: lsGet("xrReadingContrast","on") === "on",
  reducedMotion: lsGet("xrReducedMotion","off") === "on",
  adaptiveQuality: lsGet("xrAdaptiveQuality","on") === "on",
  handsFree: lsGet("xrHandsFree", "off") === "on",
  bargeIn: lsGet("xrBargeIn", "on") === "on",
  // Haute définition (par défaut) : texte net sur les écrans du Quest 3.
  hd: lsGet("xrHd", "on") === "on",
  // Panneaux en couches WebXR natives (expérimental, passthrough seulement).
  layers: lsGet("xrLayers", "off") === "on",
  // Reconnaissance vocale : « whisper » (Whisper du Mac), « local » (Whisper
  // DANS le casque, xr-whisper.js) ou « headset » (reconnaissance du
  // navigateur — absente du navigateur du Quest).
  stt: lsGet("xrStt", "whisper"),
  // Modèle de Whisper dans le casque : base par défaut (mesuré : tiny écrivait
  // « l'abanc » pour « la banque ») ; tiny reste au choix, deux fois plus rapide.
  localModel: lsGet("xrLocalWhisper", "Xenova/whisper-base"),
  // Modèle Whisper du bureau pour le casque : base par défaut (small trop lourd
  // pour la machine qui fait aussi tourner le LLM) ; small reste au choix.
  whisperModel: lsGet("xrWhisperModel", "Xenova/whisper-base"),
  // Aimantation des panneaux au lâcher : « near » (mur tout proche), « aimed » (mur visé), « off ».
  snap: lsGet("xrSnap", "near"),
  // Sous-titres de la réponse sous l'orbe pendant la lecture vocale.
  subtitles: lsGet("xrSubtitles", "on") === "on",
  // Occlusion par la profondeur (Quest 3) : mains et meubles passent DEVANT
  // l'orbe et les panneaux. S'applique à la prochaine entrée en XR.
  occlusion: lsGet("xrOcclusion", "on") === "on",
  // « Traduis ça » : "off" (défaut), "headset" (petits modèles Opus-MT dans le
  // casque) ou "mac" (le modèle déjà chargé du Mac). « Lis ça » marche toujours
  // (lecture OCR dans le casque, sans modèle d'IA).
  translate: lsGet("xrTranslate", "off"),
  // Rituel du matin lancé tout seul à la première entrée du jour avant 11 h.
  morningAuto: lsGet("xrMorningAuto", "off") === "on",
  // Ambiance du mode focus : index de ENVIRONMENTS, ou -1 pour aucune.
  focusEnv: Number(lsGet("xrFocusEnv", "0")),
  // Taille des figurines d'agents (facteur d'échelle, cf. AGENT_SCALES).
  agentScale: Number(lsGet("xrAgentScale", "1")) || 1,
  // Dock spatial des apps : épinglé (reste affiché) ou temporaire.
  dockPinned: lsGet("xrDockPinned", "on") === "on",
};
const AGENT_SCALES = [0.6, 1, 1.5, 2, 3];
function setAgentScale(v) {
  settings.agentScale = Math.max(0.4, Math.min(4, v));
  lsSet("xrAgentScale", String(+settings.agentScale.toFixed(2)));
  settingsPanel?.invalidate();
}
const SNAP_MODES = ["near", "aimed", "off"];
const WHISPER_CHOICES = [
  { id: "Xenova/whisper-base", label: "base" },
  { id: "Xenova/whisper-small", label: "small" },
];
function setChoice(key, value) {
  settings[key] = value;
  lsSet({ stt: "xrStt", whisperModel: "xrWhisperModel", snap: "xrSnap", localModel: "xrLocalWhisper" }[key], value);
}
function setSetting(key, on) {
  settings[key] = on;
  lsSet({ readingContrast:"xrReadingContrast", reducedMotion:"xrReducedMotion", adaptiveQuality:"xrAdaptiveQuality", perf: "xrPerf", handsFree: "xrHandsFree", bargeIn: "xrBargeIn", hd: "xrHd", layers: "xrLayers", subtitles: "xrSubtitles", occlusion: "xrOcclusion" }[key], on ? "on" : "off");
}

// ---------------------------------------------------------------------------
// Session & WebSocket (protocole du compagnon)
// ---------------------------------------------------------------------------
let token = lsGet("xrToken", "");
let ws = null;
let wsOpened = false;

const state = {
  desktop: "idle",       // état de l'orbe du bureau (idle / thinking / …)
  local: "idle",         // état propre au casque : listening / transcribing / speaking
  route: null,           // aiguillage du tour (direct / tools / orchestrate), envoyé par le bureau
  messages: [],          // transcription courante
  conversations: { items: [], currentId: null },
  chatMode: "chat",      // chat | history
  orchestrate: false,    // réponse orchestrée (réglage partagé avec le bureau)
  backend: { model: "", source: "", vision: false, sources: [], models: [] },
  voice: lsGet("xrVoice", "on") !== "off",
  scroll: 0,             // défilement du chat, en lignes depuis le bas
  historyPage: 0,
  status: "",
  connected: false,
  micActive: false,      // voyant de confidentialité
  camActive: false,
};

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/// Routes REST du compagnon (agents) : le jeton part en en-tête.
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), ...(options.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(String(res.status));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function connect() {
  if (!token) { showPairing(); return; }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  wsOpened = false;
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    wsOpened = true;
    state.connected = true;
    setStatus("");
    speech.primed = false; // la transcription reçue à la connexion n'est pas lue
    send({ type: "list-conversations" });
    send({ type: "xr-morning-config" }); // thèmes et ville du rituel du matin
    send({ type: "xr-domo-list" });
    send({ type: "xr-voice", on: state.voice });
    setTimeout(loadFillers, 1500); // après l'état initial, sans le retarder
    // Équipe d'agents : connue dès la connexion pour « demande à X de… ».
    setTimeout(() => apps?.refreshTeam?.(), 2000);
    $("conn").textContent = T("Connecté à Lumen", "Connected to Lumen");
    $("conn").classList.add("ok");
    syncMic();
  };
  ws.onclose = () => {
    state.connected = false;
    $("conn").textContent = T("Déconnecté", "Disconnected");
    $("conn").classList.remove("ok");
    syncMic();
    if (!wsOpened) { token = ""; try { localStorage.removeItem("xrToken"); } catch {} showPairing(); return; }
    setStatus(T("Reconnexion…", "Reconnecting…"));
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws && ws.close();
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (morning.onMessage(msg) || props.onMessage(msg) || apps.onMessage(msg) || space.onMessage(msg) || extras.onMessage(msg)) return;
    switch (msg.type) {
      case "session":
        if (msg.active === false) setStatus(T("Une autre session est ouverte sur l'ordinateur.", "Another session is open on the computer."));
        break;
      case "orb": state.desktop = msg.state || "idle"; chat.invalidate(); bar.invalidate(); break;
      case "transcript": onTranscript(msg.messages || []); break;
      case "conversations": {
        const changed = msg.currentId !== state.conversations.currentId;
        state.conversations = { items: msg.items || [], currentId: msg.currentId ?? null };
        if (changed) speech.primed = false; // autre conversation : on ne relit pas l'historique
        chat.invalidate();
        break;
      }
      case "backend":
        state.backend = {
          model: msg.model || "", source: msg.source || "", vision: !!msg.vision,
          sources: Array.isArray(msg.sources) ? msg.sources : [],
          models: Array.isArray(msg.models) ? msg.models : [],
          modelLabels: msg.modelLabels || {},
        };
        aiState.pending = "";
        chat.title = "Lumen" + (state.backend.model ? " · " + modelName(state.backend.model) : "");
        chat.invalidate(); bar.invalidate(); ai.invalidate();
        break;
      case "answer": onAnswer(msg.text || ""); break;
      // Un agent doté d'une voix a répondu dans ce tour : la suite est lue avec elle.
      case "turn-voice": state.turnVoice = msg.voice || ""; break;
      case "xr-morning-config": Object.assign(morningCfg, msg.config || {}); settingsPanel?.invalidate(); break;
      case "xr-translation": { const done = translateWaiting.get(msg.id); if (done) { translateWaiting.delete(msg.id); done(msg.text || ""); } break; }
      case "xr-decision": onXrDecision(msg); break;
      // Aiguillage du tour décidé par le bureau (routeur Tev1, orchestration,
      // mode outils) : la ceinture d'icônes ne vit qu'en mode outils/orchestration.
      case "route": state.route = msg.route || "direct"; if (state.route === "direct") belt.busy(false); break;
      case "xr-labels": onLiveLabels(msg); break;
      case "orchestrate": state.orchestrate = !!msg.on; chat.invalidate(); break;
      // Étape d'une réponse orchestrée (« J'utilise la météo. ») : dite dans la
      // file de lecture, avant la réponse finale.
      // Lumen attend l'utilisateur (accord sandbox, confirmation, choix
      // d'emplacement, déverrouillage) : fenêtre devant les yeux + Halo.
      case "user-request": showUserRequest(msg); break;
      case "user-request-done": hideUserRequest(msg.id); break;
      case "unlock-result": onUnlockResult(msg); break;
      case "announce":
        if (state.voice && msg.text && !speech.muted) enqueueSpeech(String(msg.text), { dedupe: false });
        // La capsule Halo reprend l'étape en cours (« Je cherche dans tes fichiers. »).
        if (msg.text) apps.activity(String(msg.text));
        break;
      case "llm-mode": if (typeof msg.orchestrate === "boolean") { state.orchestrate = msg.orchestrate; chat.invalidate(); } break;
      case "lumen-lang": {
        // Langue changée dans Lumen : on s'y range. Hors session immersive on
        // recharge tout de suite ; en plein casque, au prochain lancement.
        const l = msg.lang === "en" ? "en" : "fr";
        if (l !== LANG) {
          lsSet("xrLang", l);
          if (!renderer.xr.isPresenting) location.reload();
          else toast(l === "en" ? "Language: English from next launch" : "Langue : français au prochain lancement", 3000);
        }
        break;
      }
      case "xr-stt": onStt(msg); break;
      case "xr-stt-partial": onSttPartial(msg); break;
      case "xr-tts-audio": onTtsAudio(msg); break;
      case "orb-look": applyLook(msg); break;
      case "heartbeat": pulseHeart(msg); break;
    }
  };
}

// ---- Appairage (même API que le compagnon) --------------------------------
function showPairing() { $("pair").hidden = false; $("home").hidden = true; }
function hidePairing() { $("pair").hidden = true; $("home").hidden = false; }

// Connexion en deux temps : le code TOTP (lisible dans les Paramètres de
// Lumen) ne suffit pas pour un profil protégé, il faut aussi le mot de passe
// de la session. La page XR est toujours servie en HTTPS : il y part chiffré.
let xrTicket = "";
function acceptXrLogin(data) {
  token = data.token || "";
  lsSet("xrToken", token);
  lsSet("xrIdentifier", $("pair-id").value.trim());
  xrTicket = "";
  $("pair-password").value = "";
  $("pair-password").hidden = $("pair-password-label").hidden = true;
  hidePairing();
  connect();
}
$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pair-error").textContent = "";
  try {
    if (xrTicket) {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: xrTicket, password: $("pair-password").value }),
      });
      $("pair-password").value = "";
      if (res.ok) { acceptXrLogin(await res.json()); return; }
      if (res.status === 401) { $("pair-error").textContent = T("Mot de passe incorrect.", "Wrong password."); return; }
      if (res.status === 429) { $("pair-error").textContent = T("Trop d'essais, patientez.", "Too many attempts, please wait."); return; }
      xrTicket = "";
      $("pair-password").hidden = $("pair-password-label").hidden = true;
      $("pair-error").textContent = T("Connexion expirée : nouveau code requis.", "Sign-in expired: new code needed.");
      return;
    }
    const res = await fetch("/auth/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: $("pair-id").value.trim(), code: $("pair-code").value.trim(), device_kind: "xr" }),
    });
    if (res.status === 429) { $("pair-error").textContent = T("Trop d'essais, patientez.", "Too many attempts, please wait."); return; }
    if (!res.ok) { $("pair-error").textContent = T("Identifiant ou code invalide.", "Invalid identifier or code."); return; }
    const data = await res.json();
    if (data.step !== "password") { acceptXrLogin(data); return; }
    xrTicket = data.ticket;
    $("pair-password").hidden = $("pair-password-label").hidden = false;
    $("pair-password").focus();
  } catch {
    $("pair-error").textContent = T("Connexion impossible.", "Cannot connect.");
  }
});
$("pair-id").value = lsGet("xrIdentifier", "");

// ---------------------------------------------------------------------------
// Scène
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
$("stage").appendChild(renderer.domElement);

const scene = new THREE.Scene();
/// Nom lisible d'un modèle : libellé du bureau (Apple : « sur l'appareil »)
/// sinon le nom de fichier sans chemin ni extension.
function modelName(m) {
  const l = state.backend?.modelLabels?.[m];
  return l || String(m || "").split("/").pop().replace(/\.gguf$/i, "");
}

// État de « Regarde en continu » (déclaré tôt : les Réglages le lisent).
const liveVision = { on: false, timer: null, seq: 0, pending: null, group: new THREE.Group(), shownAt: 0 };
scene.add(liveVision.group);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 60);
camera.position.set(0, 1.6, 0);

// Fond de l'aperçu hors casque et du mode VR (en MR, le passthrough le remplace).
const previewBg = new THREE.Color(0x14161d);
scene.background = previewBg;

// Tout le contenu Lumen vit dans `world`, recentré sur la tête à l'entrée.
const world = new THREE.Group();
scene.add(world);

const spatial = new Spatial(renderer);
spatial.attachOverlay(scene);
// `panels` (plus bas) est le tableau vivant des panneaux : lu à chaque image.
const panelLayers = new PanelLayers(renderer, { filter: (fn) => panels.filter(fn) });
let currentRoom = "";
spatial.onPlanesChanged = ({ walls, surfaces }) => {
  // Pièce reconnue : sa disposition revient (panneaux là où on les avait mis).
  const room = spatial.roomKey();
  if (room && room !== currentRoom) {
    currentRoom = room;
    if (loadLayout(room)) { toast(T("Pièce reconnue : disposition restaurée", "Room recognised: layout restored"), 2600); onPanelsChanged(); settingsPanel?.invalidate?.(); return; }
  }
  if (walls || surfaces) toast(T(`Pièce : ${walls} mur(s), ${surfaces} surface(s)`, `Room: ${walls} wall(s), ${surfaces} surface(s)`), 2200);
  settingsPanel?.invalidate?.();
};
const hands = new Hands(renderer, scene);
const clock = new THREE.Clock();

// ---- L'orbe : LA MÊME que sur le bureau ------------------------------------
// Cœur de couleurs + coque de verre viennent de lib/orb-materials.js, partagé
// avec orb.js ; le thème (palette, verre, cœur, bouche) est poussé par le
// bureau (`orb-look`). Seul l'habillage change : les yeux et la bouche, en CSS
// sur le bureau, sont ici de vrais objets 3D.
const ORB_R = 0.14; // rayon de la coque, en mètres, à l'échelle 1
const look = { colors: ORB_DEFAULT.slice(), glass: "thin", heart: "#ff4d6d", mouth: false };
const { coreUniforms, coreMat, shellUniforms, shellMat, GLASS_TYPES } = createOrbMaterials(look.colors, look.heart);
const core = new THREE.Mesh(new THREE.SphereGeometry(0.82, 64, 64), coreMat);
const shell = new THREE.Mesh(new THREE.SphereGeometry(1.0, 64, 64), shellMat);
core.renderOrder = 1;
shell.renderOrder = 2;
shell.userData.isOrb = true;

function applyGlass(name) {
  const g = GLASS_TYPES[name] || GLASS_TYPES.thin;
  shellUniforms.uOpacity.value = g.opacity;
  shellUniforms.uRimPower.value = g.rimPower;
  shellUniforms.uRimStrength.value = g.rimStrength;
  shellUniforms.uSpecPower.value = g.specPower;
  shellUniforms.uSpecStrength.value = g.specStrength;
  shellUniforms.uFill.value = g.fill;
  shellUniforms.uIridescence.value = g.iridescence;
}
function applyLook(msg) {
  if (Array.isArray(msg.colors) && msg.colors.length === 5) look.colors = msg.colors;
  if (msg.glass) look.glass = msg.glass;
  if (msg.heart) look.heart = msg.heart;
  look.mouth = !!msg.mouth;
  look.colors.forEach((c, i) => coreUniforms["uCol" + i].value.set(c));
  coreUniforms.uPulseColor.value.set(look.heart);
  applyGlass(look.glass);
  glow.material.color.set(look.colors[1]);
  bar.invalidate();
}
applyGlass(look.glass);

function radialTexture(inner = "rgba(255,255,255,0.55)", mid = "rgba(255,255,255,0.18)") {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.45, mid);
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
// Lueur ambiante douce (l'équivalent du `.glowing-orb` CSS du bureau).
const glow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: radialTexture(), color: new THREE.Color(look.colors[1]),
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35,
}));
glow.scale.setScalar(3.2);
glow.renderOrder = 0;

// Visage : deux yeux en gélule (7 × 22 px sur le bureau, écart 13 px) et la
// bouche optionnelle (proportions de lib/voice-mouth.js).
function capsule(w, h) {
  const r = Math.min(w, h) / 2;
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.absarc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(w / 2, h / 2 - r);
  s.absarc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2, false);
  s.lineTo(-w / 2 + r, h / 2);
  s.absarc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, -h / 2 + r);
  s.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5, false);
  return new THREE.ShapeGeometry(s, 12);
}
const faceMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
const faceGlowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false });
const EYE_W = 0.085, EYE_H = 0.27, EYE_GAP = 0.16;
const face = new THREE.Group();
// Les yeux ont leur propre groupe : il glisse vers ce que l'on montre.
const eyesRig = new THREE.Group();
face.add(eyesRig);
const eyes = [-1, 1].map((side) => {
  const g = new THREE.Group();
  const eye = new THREE.Mesh(capsule(EYE_W, EYE_H), faceMat);
  const halo = new THREE.Mesh(capsule(EYE_W * 1.9, EYE_H * 1.25), faceGlowMat);
  halo.position.z = -0.002;
  eye.renderOrder = halo.renderOrder = 4;
  g.add(halo, eye);
  g.position.set(side * (EYE_W + EYE_GAP) / 2, 0.05, 0);
  eyesRig.add(g);
  return g;
});
const mouthSize = mouthSizeFromEye({ width: EYE_W, height: EYE_H });
const mouth = new THREE.Mesh(capsule(mouthSize.width, Math.max(0.02, mouthSize.height)), faceMat.clone());
mouth.position.set(0, 0.05 - mouthSize.offsetY, 0);
mouth.renderOrder = 4;
mouth.material.opacity = 0;
eyesRig.add(mouth);

// orbBody porte la géométrie « rayon 1 », mise à l'échelle en mètres.
const orbBody = new THREE.Group();
orbBody.add(glow, core, shell, face);
orbBody.scale.setScalar(ORB_R);
// orbRig : ce qu'on déplace et redimensionne.
const orbRig = new THREE.Group();
orbRig.add(orbBody);
orbRig.position.set(0, 0, -1.25);
world.add(orbRig);
let orbScale = Number(lsGet("xrOrbScale", "1")) || 1;
orbRig.scale.setScalar(orbScale);

function setOrbScale(s) {
  orbScale = Math.min(2.5, Math.max(0.4, s));
  orbRig.scale.setScalar(orbScale);
  lsSet("xrOrbScale", String(orbScale));
}
function resizeOrb(f) { setOrbScale(orbScale * f); saveLayout(); }

// Ombre de l'orbe : disque sombre posé sur la surface en dessous (table
// détectée, sinon le sol), qui s'estompe avec la hauteur.
const shadow = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: radialTexture("rgba(0,0,0,0.9)", "rgba(0,0,0,0.35)"), transparent: true, depthWrite: false, opacity: 0 }),
);
shadow.rotation.x = -Math.PI / 2;
shadow.renderOrder = 0;
scene.add(shadow);

// Légende sous l'orbe : l'état, ou des SOUS-TITRES — ce que l'on est en train
// de dire (transcription en continu) puis la phrase que Lumen prononce.
const caption = new Panel({ width: 0.8, height: 0.13, bare: true, draw(ctx, p) {
  const sub = subtitle();
  const text = sub?.text || orbCaption();
  if (!text) return;
  ctx.font = sub?.user ? `italic 400 32px ${THEME.font}` : `500 32px ${THEME.font}`;
  const lines = wrap(ctx, sub?.user ? `« ${text} »` : text, p.W - 90);
  const shown = lines.length > 2 ? ["…" + lines[lines.length - 2], lines[lines.length - 1]] : lines;
  const w = Math.min(p.W - 8, Math.max(...shown.map((l) => ctx.measureText(l).width)) + 60);
  const h = shown.length * 42 + 22;
  roundRect(ctx, (p.W - w) / 2, 4, w, h, Math.min(h / 2, 30));
  ctx.fillStyle = "rgba(20,22,30,0.62)";
  ctx.fill();
  ctx.fillStyle = sub?.user ? "rgba(244,245,248,0.85)" : THEME.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  shown.forEach((l, k) => ctx.fillText(l, p.W / 2, 4 + 11 + 21 + k * 42));
} });
/// Sous-titre courant : transcription partielle pendant l'écoute, phrase dite
/// pendant que Lumen parle.
function subtitle() {
  if (state.local === "listening" || state.local === "transcribing") return state.partial ? { text: state.partial, user: true } : null;
  if (speech.playing && speech.current && settings.subtitles) return { text: speech.current };
  return null;
}
world.add(caption.object);

// Pastille de l'orbe : −/+ (taille) et ☰ (rouvrir les panneaux fermés).
// Elle apparaît au survol de l'orbe et reste un instant pour qu'on l'atteigne.
const orbChip = new Panel({ width: 0.3, height: 0.085, handle: false, radius: 38, draw(ctx, p) {
  const s = 62, y = (p.H - s) / 2;
  p.iconButton("osmall", 22, y, s, "", () => resizeOrb(1 / 1.15), { inContent: true, icon: "minus" });
  p.iconButton("omenu", (p.W - s) / 2, y, s, "", reopenPanels, { inContent: true, icon: "layout-grid", active: panels.some((x) => !x.visible && x.reopenable) });
  p.iconButton("obig", p.W - 22 - s, y, s, "", () => resizeOrb(1.15), { inContent: true, icon: "plus" });
} });
orbChip.object.visible = false;
world.add(orbChip.object);
let chipUntil = 0;

function orbCaption() {
  if (state.status) return state.status;
  switch (effectiveState()) {
    case "listening": return T("Je vous écoute…", "Listening…");
    case "transcribing": return T("Transcription…", "Transcribing…");
    case "thinking": return T("Réflexion…", "Thinking…");
    case "speaking": return "";
    default: return state.connected ? "" : T("Hors ligne", "Offline");
  }
}

function effectiveState() {
  if (state.local !== "idle") return state.local;
  const d = state.desktop;
  if (d === "thinking" || d === "loading" || d === "tool" || d === "working") return "thinking";
  if (d === "speaking") return "speaking";
  return "idle";
}

function setStatus(s) { state.status = s || ""; caption.invalidate(); }
let toastTimer = null;
function toast(s, ms = 2600) {
  setStatus(s);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setStatus(""), ms);
}

// ---------------------------------------------------------------------------
// Panneaux + disposition mémorisée
// ---------------------------------------------------------------------------
const panels = [];
let lightDesk = null;
let space = null;  // xr-space.js (créé plus bas)
let extras = null; // xr-extras.js
const movables = {}; // clé → { obj, panel? } : ce qui se déplace, s'ancre, se mémorise
function addPanel(panel, pos, yaw = 0, reopenable = true, key = null) {
  const buttons = panel.headerButtons;
  if (panel.handle && !panel.bare) panel.headerButtons = () => [...(buttons?.() || []), {
    id: "__wall", icon: "pin", onClick: () => {
      const { pos: origin } = headPose();
      const target = panel.object.getWorldPosition(new THREE.Vector3());
      const dir = target.sub(origin).normalize();
      const previous={position:panel.object.position.clone(),quaternion:panel.object.quaternion.clone()};
      if (spatial.snapPanel(panel.object, { origin, dir })) { if(panel.key){spatial.release(panel.key);spatial.anchor(panel.key,panel.object);} panel.wallUndo=previous; panel.invalidate(); saveLayout(); toast(T("Plaqué au mur", "Snapped to wall")); }
      else toast(T("Aucun mur détecté derrière ce panneau. Scannez la pièce.", "No wall detected behind this panel. Scan the room."));
    },
  }, ...(panel.wallUndo ? [{id:"__wallUndo",icon:"undo-2",onClick:()=>{spatial.release(panel.key);panel.object.position.copy(panel.wallUndo.position);panel.object.quaternion.copy(panel.wallUndo.quaternion);panel.wallUndo=null;if(panel.key)spatial.anchor(panel.key,panel.object);panel.invalidate();saveLayout();}}] : [])];
  panel.object.position.copy(pos);
  panel.object.rotation.y = yaw;
  panel.home = { pos: pos.clone(), yaw, pitch: 0 };
  panel.reopenable = reopenable;
  world.add(panel.object);
  panels.push(panel);
  if (key) { panel.key = key; movables[key] = { obj: panel.object, panel }; }
  return panel;
}
movables.orb = { obj: orbRig };

/// Disposition relative à l'utilisateur (repère `world`), gardée d'une session
/// à l'autre. Les ancres persistantes, quand le casque les accorde, priment.
function saveLayout() {
  const out = {};
  for (const [key, m] of Object.entries(movables)) {
    const o = m.obj;
    out[key] = {
      p: o.position.toArray().map((v) => +v.toFixed(3)),
      q: o.quaternion.toArray().map((v) => +v.toFixed(4)),
      s: m.panel ? m.panel.scale : orbScale,
      // Masqué le temps du rituel du matin ou du mode focus = toujours ouvert.
      open: m.panel ? (m.panel.visible || !!morningHidden?.includes(m.panel) || (() => { try { return focusMode.hidden.includes(m.panel); } catch { return false; } })()) : true,
    };
  }
  lsSet("xrLayout", JSON.stringify(out));
  // Disposition PAR PIÈCE : celle-ci est aussi mémorisée sous l'empreinte de
  // la pièce scannée (bureau, salon…), restaurée quand on y revient.
  const room = spatial.roomKey?.();
  if (room) {
    lsSet(`xrLayout:${room}`, JSON.stringify(out));
    const rooms = new Set(JSON.parse(lsGet("xrRooms", "[]")));
    rooms.add(room);
    lsSet("xrRooms", JSON.stringify([...rooms].slice(-12)));
  }
  space?.persist();
}
/// `room` : empreinte de pièce ; sans elle (ou inconnue), la dernière disposition.
function loadLayout(room = "") {
  let saved = null;
  try { saved = JSON.parse(lsGet(room ? `xrLayout:${room}` : "xrLayout", "null")); } catch {}
  if (!saved && room) return false;
  if (!saved) return;
  for (const [key, v] of Object.entries(saved)) {
    const m = movables[key];
    if (!m || !Array.isArray(v.p)) continue;
    m.obj.position.fromArray(v.p);
    if (Array.isArray(v.q)) m.obj.quaternion.fromArray(v.q);
    if (m.panel) {
      m.panel.scale = Math.min(2.2, Math.max(0.5, Number(v.s) || 1));
      m.obj.scale.setScalar(m.panel.scale);
      if (v.open === false) m.obj.visible = false;
      else if (v.open === true && m.panel.reopenable) m.obj.visible = true;
    } else if (key === "orb" && v.s) setOrbScale(Number(v.s));
  }
  return true;
}
/// Retire un panneau créé à la volée (minuteur, graphique…) : scène, ancres, mémoire.
function removePanel(panel) {
  const i = panels.indexOf(panel);
  if (i >= 0) panels.splice(i, 1);
  panel.object.parent?.remove(panel.object);
  if (panel.key) { spatial.release(panel.key); delete movables[panel.key]; }
  panel.mesh.geometry.dispose();
  panel.texture.dispose();
  panel.material.dispose();
  for (const p of pointers) if (p.drag?.panel === panel) p.drag = null;
}

function resetLayout() {
  spatial.clearAll();
  try {
    localStorage.removeItem("xrLayout");
    const room = spatial.roomKey?.();
    if (room) localStorage.removeItem(`xrLayout:${room}`);
  } catch {}
  orbRig.position.set(0, 0, -1.25);
  orbRig.quaternion.identity();
  for (const p of panels) {
    p.object.position.copy(p.home.pos);
    p.object.rotation.set(p.home.pitch, p.home.yaw, 0);
  }
  recenter();
}

// ---- Mode focus : seule la discussion reste ouverte -------------------------
// Par la voix (« mode focus », « remets les panneaux »), le moteur de décision
// ou le bouton du dock. Les panneaux repliés reviennent exactement où ils étaient.
const focusMode = { on: false, hidden: [] };
function setFocus(on) {
  if (on === focusMode.on) return;
  focusMode.on = on;
  if (on) {
    focusMode.hidden = panels.filter((p) => p.visible && p !== chat && p !== bar && p.key);
    for (const p of focusMode.hidden) p.object.visible = false;
    if (!chat.visible) reopenPanel(chat);
    toast(T("Mode focus", "Focus mode"), 1500);
    if (settings.focusEnv >= 0) env?.show(settings.focusEnv);
  } else {
    for (const p of focusMode.hidden) if (panels.includes(p)) p.object.visible = true;
    focusMode.hidden = [];
    toast(T("Panneaux rétablis", "Panels restored"), 1500);
    env?.hide();
  }
  onPanelsChanged();
}
const FOCUS_ON_RE = /^\s*(?:lumen[, ]*)?(?:(?:passe en |active le |mets le )?mode (?:focus|concentration)|cache (?:tous )?les (?:autres )?panneaux|range (?:tous )?les panneaux|focus mode)\b/i;
const FOCUS_OFF_RE = /^\s*(?:lumen[, ]*)?(?:(?:quitte|sors du|d[ée]sactive le|arr[eê]te le) mode (?:focus|concentration)|(?:r?affiche|remets|rouvre) (?:tous )?les panneaux|exit focus)\b/i;

/// ☰ de l'orbe : rouvre les panneaux fermés (chat, barre), à leur place d'origine
/// autour de l'orbe — on les a fermés, on ne sait plus forcément où ils étaient.
function reopenPanel(p) {
  if (p.key) spatial.release(p.key);
  const o = orbRig.position;
  p.object.position.set(o.x + p.home.pos.x, o.y + p.home.pos.y, o.z + p.home.pos.z + 1.25);
  p.object.rotation.set(p.home.pitch, p.home.yaw, 0);
  p.open();
}
function reopenPanels() {
  for (const p of panels) if (!p.visible && p.reopenable) reopenPanel(p);
  onPanelsChanged();
}
function togglePanel(p) {
  if (p.visible) p.close(); else reopenPanel(p);
  onPanelsChanged();
}
/// Ouvre un panneau d'app devant soi, légèrement décalé selon son côté natal.
function openNear(p) {
  if (p.key) spatial.release(p.key);
  const { pos, quat } = headPose();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat); right.y = 0; right.normalize();
  // Search visible slots using panel bounds rather than center distances.
  const dir = Math.sign(p.home.pos.x) || 1;
  const distance = Math.max(1.25, p.width * p.scale * 1.35);
  const width = p.width * p.scale, height = p.height * p.scale;
  const others = panels.filter(q => q !== p && q.visible && !q.bare).map(q => {
    const delta = q.object.getWorldPosition(new THREE.Vector3()).sub(pos);
    return { x: delta.dot(right), y: delta.y, z: delta.dot(fwd),
      w: q.width * q.scale, h: q.height * q.scale };
  });
  const slots = [0, dir * (width / 2 + .45), -dir * (width / 2 + .45)];
  let best = null;
  for (const y of [-.08, .38, -.45]) for (const x of slots) {
    let overlap = 0;
    for (const q of others) {
      if (Math.abs(q.z - distance) > .75) continue;
      overlap += Math.max(0, (width + q.w) / 2 + .12 - Math.abs(x - q.x))
        * Math.max(0, (height + q.h) / 2 + .12 - Math.abs(y - q.y));
    }
    const score = overlap * 100 + Math.abs(x) + Math.abs(y) * 2;
    if (!best || score < best.score) best = { x, y, score };
  }
  const target = pos.clone().addScaledVector(fwd, distance).addScaledVector(right, best.x);
  target.y += best.y;
  world.updateMatrixWorld(true);
  p.object.position.copy(world.worldToLocal(target));
  p.open();
  faceHead(p.object);
  saveLayout();
}
function onPanelsChanged() {
  orbChip.invalidate();
  bar.invalidate();
  apps?.launcher.invalidate();
  saveLayout();
}

// ---- Chat (à gauche de l'orbe) + conversations passées -------------------
const chat = addPanel(new Panel({
  // Fenêtre haute : on lit plusieurs échanges sans défiler sans cesse.
  width: 0.72, height: 1.25, title: "Lumen", closable: true, onClose: onPanelsChanged,
  headerButtons: () => [
    { id: "hist", icon: "history", active: state.chatMode === "history", onClick: () => {
      state.chatMode = state.chatMode === "history" ? "chat" : "history";
      state.historyPage = 0;
      if (state.chatMode === "history") send({ type: "list-conversations" });
      chat.invalidate();
    } },
    { id: "newc", icon: "square-pen", onClick: newConversation },
    // Réponse orchestrée : analyse, outils, vérification (étapes affichées).
    { id: "orch", icon: "workflow", active: state.orchestrate, onClick: () => {
      state.orchestrate = !state.orchestrate;
      send({ type: "set-orchestrate", on: state.orchestrate });
      setStatus(state.orchestrate
        ? T("Réponse orchestrée activée", "Orchestrated answers on")
        : T("Réponse orchestrée désactivée", "Orchestrated answers off"));
      chat.invalidate();
    } },
  ],
  draw(ctx, p) {
    if (state.chatMode === "history") return drawHistory(ctx, p);
    const W = p.W, H = p.H - p.handleH;
    const padX = 34, maxBubble = W * 0.78, lineH = 44;
    ctx.font = `400 34px ${THEME.font}`;
    // Mise en page de bas en haut : on calcule toutes les bulles, puis on
    // n'affiche que la fenêtre visible selon le défilement.
    const items = [];
    const lastIdx = state.messages.length - 1;
    for (const [mi, m] of state.messages.entries()) {
      // Réponse en cours d'écriture (flux du bureau) : curseur à la fin.
      const writing = mi === lastIdx && m.sender !== "user" && (state.desktop === "thinking" || lumenBusy());
      const text = String(m.text || "") + (writing && m.text ? " ▍" : "");
      // Raisonnement / outils : une ligne de résumé discrète au-dessus de la
      // réponse (pas de repli possible sur un panneau canvas).
      const meta = [];
      for (const blk of Array.isArray(m.blocks) ? m.blocks : []) {
        if (blk.kind === "plan") {
          // Étape en cours + message d'attente, ou synthèse une fois fini.
          const steps = Array.isArray(blk.steps) ? blk.steps : [];
          const cur = steps.find((x) => x.status === "running");
          const done = steps.filter((x) => x.status !== "running" && x.status !== "skip").length;
          meta.push(blk.live && cur
            ? `◈ ${done + 1}/${Math.max(steps.length, done + 1)} ${cur.label}${cur.wait ? ` — ${cur.wait}` : ""}`
            : `◈ ${blk.summary || blk.title || ""}`);
          continue;
        }
        if (blk.kind === "think") meta.push(`✦ ${blk.label || (blk.live ? T("Réflexion…", "Thinking…") : T("Raisonnement", "Reasoning"))}`);
        else meta.push(`⚙ ${blk.name}${blk.result !== undefined ? " ✓" : " …"}`);
      }
      if (!text && !meta.length) continue;
      // Une ligne par étape/outil : on suit les appels d'outils au fil de la réponse.
      const metaLines = meta.flatMap((line) => wrap(ctx, line, maxBubble - 48));
      items.push({ user: m.sender === "user", meta: metaLines.length, lines: [...metaLines, ...(text ? markdownLines(ctx, text, maxBubble - 48, 34) : [])] });
    }
    const footer = 110;
    const viewH = H - footer - 16;
    state.scroll = Math.min(state.scroll, Math.max(0, Math.ceil((items.reduce((n, it) => n + it.lines.length * lineH + 44, 0) - viewH) / lineH)));
    let y = viewH + state.scroll * lineH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 8, W, viewH - 8);
    ctx.clip();
    for (let i = items.length - 1; i >= 0 && y > 0; i--) {
      const it = items[i];
      const h = it.lines.length * lineH + 30;
      y -= h;
      if (y < viewH) {
        const bw = Math.min(maxBubble, Math.max(...it.lines.map((l) => (typeof l === "string" ? ctx.measureText(l).width : l.width))) + 48);
        const x = it.user ? W - padX - bw : padX;
        roundRect(ctx, x, y, bw, h - 12, 28);
        ctx.fillStyle = it.user ? THEME.userBubble : THEME.botBubble;
        ctx.fill();
        ctx.fillStyle = THEME.text;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        it.lines.forEach((l, k) => {
          ctx.fillStyle = k < (it.meta || 0) ? THEME.dim : THEME.text;
          if (typeof l === "string") ctx.fillText(l, x + 24, y + 12 + k * lineH);
          else drawMarkdownLine(ctx, l, x + 24, y + 12 + k * lineH);
        });
      }
      y -= 14;
    }
    ctx.restore();
    if (!items.length) {
      ctx.fillStyle = THEME.dim;
      ctx.font = `400 32px ${THEME.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const hint = settings.handsFree
        ? T("Dites « Lumen, … » ou pincez l'orbe pour discuter.", "Say “Lumen, …” or pinch the orb to chat.")
        : T("Pincez l'orbe ou « Parler » pour discuter avec Lumen.", "Pinch the orb or “Talk” to chat with Lumen.");
      wrap(ctx, hint, W - 120).forEach((l, k) => ctx.fillText(l, W / 2, viewH / 2 - 30 + k * 44));
    }
    const fy = H - footer + 10;
    p.iconButton("up", padX, fy, 76, "", () => { state.scroll += 4; chat.invalidate(); }, { inContent: true, icon: "chevron-up" });
    p.iconButton("down", padX + 92, fy, 76, "", () => { state.scroll = Math.max(0, state.scroll - 4); chat.invalidate(); }, { inContent: true, icon: "chevron-down" });
    ctx.fillStyle = THEME.dim;
    ctx.font = `400 30px ${THEME.font}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const busy = effectiveState() === "thinking" ? T("Lumen réfléchit…", "Lumen is thinking…") : "";
    ctx.fillText(busy, W - padX, fy + 38);
  },
}), new THREE.Vector3(-0.72, 0.14, -1.08), 0.55, true, "chat");

function newConversation() {
  stopSpeaking();
  send({ type: "new-conversation" });
  state.chatMode = "chat";
  vision.close();
  chat.invalidate();
}

/// Conversations enregistrées sur le bureau : un appui l'ouvre.
function drawHistory(ctx, p) {
  const W = p.W, H = p.H - p.handleH, x = 30, w = W - 60, rowH = 84, footer = 100;
  const items = state.conversations.items;
  const per = Math.max(1, Math.floor((H - 70 - footer) / rowH));
  const pages = Math.max(1, Math.ceil(items.length / per));
  state.historyPage = Math.min(state.historyPage, pages - 1);
  ctx.font = `600 24px ${THEME.font}`;
  ctx.fillStyle = THEME.dim;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(T("CONVERSATIONS", "CONVERSATIONS"), x, 30);
  if (!items.length) {
    ctx.font = `400 28px ${THEME.font}`;
    ctx.textAlign = "center";
    ctx.fillText(T("Aucune conversation enregistrée.", "No saved conversation."), W / 2, H / 2);
  }
  items.slice(state.historyPage * per, state.historyPage * per + per).forEach((c, k) => {
    const y = 60 + k * rowH, id = "conv:" + c.id, current = c.id === state.conversations.currentId;
    const hover = p.hoverId === id;
    roundRect(ctx, x, y, w, rowH - 10, 22);
    ctx.fillStyle = current ? "rgba(153,97,255,0.35)" : hover ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
    ctx.fill();
    drawIcon(ctx, current ? "check" : "messages-square", x + 20, y + (rowH - 10) / 2 - 17, 34, "#f4f5f8", 2);
    ctx.font = `${current ? 600 : 400} 28px ${THEME.font}`;
    ctx.fillStyle = THEME.text;
    ctx.textAlign = "left";
    let title = c.title || T("Discussion", "Chat");
    while (title.length > 3 && ctx.measureText(title).width > w - 100) title = title.slice(0, -2);
    if (title !== (c.title || "")) title = title.replace(/…?$/, c.title && title.length < c.title.length ? "…" : "");
    ctx.fillText(title, x + 70, y + (rowH - 10) / 2);
    p.zones.push({ id, x, y, w, h: rowH - 10, _content: true, onClick: () => {
      stopSpeaking();
      send({ type: "load-conversation", id: c.id });
      state.chatMode = "chat";
      chat.invalidate();
    } });
  });
  const fy = H - footer + 14;
  if (pages > 1) {
    p.iconButton("hup", 30, fy, 72, "", () => { state.historyPage = Math.max(0, state.historyPage - 1); chat.invalidate(); }, { inContent: true, icon: "chevron-up" });
    p.iconButton("hdown", 118, fy, 72, "", () => { state.historyPage = Math.min(pages - 1, state.historyPage + 1); chat.invalidate(); }, { inContent: true, icon: "chevron-down" });
  }
  p.pill("hnew", W - 30 - 300, fy, 300, 72, T("Nouvelle conversation", "New conversation"), newConversation);
}

// ---- Barre de commandes : dock flottant d'icônes Lucide -------------------
// Une gélule de verre, des boutons ronds ; le bouton central « Parler » porte
// les couleurs de l'orbe et un anneau qui suit la voix. Sous le dock, la
// légende du bouton survolé puis la poignée (déplacer) et × (fermer), comme
// la barre de fenêtre de visionOS.
// Les fonctions secondaires (outils, modèle, focus, recentrer, réglages)
// sont regroupées dans le menu « ⋯ » qui s'ouvre au-dessus de la barre.
const BAR_ITEMS = () => [
  { id: "chat", icon: "messages-square", label: T("Conversation", "Conversation"), active: chat.visible, on: () => togglePanel(chat) },
  { id: "apps", icon: "layout-grid", label: lightDesk?.visible ? T("Ranger le dock des apps", "Hide the apps dock") : T("Afficher le dock des apps", "Show the apps dock"), active: lightDesk?.visible || apps.launcher.visible, badge: apps.pendingApprovals() + apps.unseen(), on: () => { lightDesk?.toggle(); bar.invalidate(); } },
  { id: "look", icon: "scan-eye", label: T("Regarde — montrer à Lumen", "Look — show Lumen"), on: () => lookAndAsk("") },
  { sep: true },
  { id: "talk", big: true, label: state.local === "listening" ? T("Arrêter l'écoute", "Stop listening") : T("Parler à Lumen", "Talk to Lumen"), on: toggleTalk },
  { sep: true },
  { id: "voice", icon: state.voice ? "volume-2" : "volume-x", label: state.voice ? T("Voix activée", "Voice on") : T("Voix coupée", "Voice off"), active: state.voice, on: toggleVoice },
  { id: "more", icon: "ellipsis", label: T("Plus : outils, modèle, focus, réglages…", "More: tools, model, focus, settings…"), active: quickMenu?.visible, on: toggleQuickMenu },
];
const QUICK_ITEMS = () => [
  { id: "tools", icon: "wrench", label: T("Outils", "Tools"), active: extras?.toolsPanel.visible, on: () => extras.openTools() },
  { id: "ai", icon: "brain-circuit", label: state.backend.model ? modelName(state.backend.model) : T("Modèle", "Model"), active: ai.visible, on: toggleAi },
  { id: "focus", icon: focusMode.on ? "maximize" : "eye-off", label: focusMode.on ? T("Rétablir", "Restore") : T("Focus", "Focus"), active: focusMode.on, on: () => setFocus(!focusMode.on) },
  { id: "center", icon: "locate-fixed", label: T("Recentrer", "Recenter"), on: () => { resetLayout(); toast(T("Recentré", "Recentered")); } },
  { id: "pin", icon: settings.dockPinned ? "lock" : "timer", label: settings.dockPinned ? T("Dock épinglé", "Dock pinned") : T("Dock temporaire", "Dock auto-hide"), active: settings.dockPinned,
    on: () => { settings.dockPinned = !settings.dockPinned; lsSet("xrDockPinned", settings.dockPinned ? "on" : "off"); lightDesk?.setPinned(settings.dockPinned); } },
  { id: "settings", icon: "settings", label: T("Réglages", "Settings"), active: settingsPanel.visible, on: () => togglePanel(settingsPanel) },
];
let quickMenu = null;
function toggleQuickMenu() {
  if (!quickMenu) return;
  if (quickMenu.visible) quickMenu.close(); else { placeQuickMenu(); quickMenu.open(); }
  bar.invalidate();
}
/// Le menu « ⋯ » s'ouvre au-dessus de la barre, ou au-dessus du dock s'il est affiché.
function placeQuickMenu() {
  if (quickMenu) quickMenu.object.position.set(0, lightDesk?.visible ? 0.41 : 0.2, 0.02);
}

const bar = addPanel(new Panel({
  width: 1.08, height: 0.22, bare: true, closable: true, onClose: onPanelsChanged,
  draw(ctx, p) {
    const W = p.W;
    const dockY = 8, dockH = 124, dockR = dockH / 2, cy = dockY + dockH / 2;
    // Dock unifié : les icônes 3D (xr-light-desk) sont posées sur cette barre ;
    // elle ne dessine plus que la poignée (déplacer) et × (fermer).
    if (lightDesk?.attached) return drawBarGrip(ctx, p, dockY + dockH + 48);
    // Gélule : verre sombre translucide, reflet en haut, liseré fin.
    roundRect(ctx, 6, dockY, W - 12, dockH, dockR);
    const g = ctx.createLinearGradient(0, dockY, 0, dockY + dockH);
    g.addColorStop(0, "rgba(64,68,86,0.62)");
    g.addColorStop(0.5, "rgba(26,28,38,0.55)");
    g.addColorStop(1, "rgba(18,20,28,0.6)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.20)";
    ctx.stroke();
    ctx.save();
    roundRect(ctx, 6, dockY, W - 12, dockH, dockR);
    ctx.clip();
    const sheen = ctx.createLinearGradient(0, dockY, 0, dockY + 40);
    sheen.addColorStop(0, "rgba(255,255,255,0.14)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(0, dockY, W, 40);
    ctx.restore();

    // Répartition : boutons de 88 px, central de 108, séparateurs fins.
    const items = BAR_ITEMS();
    const D = 88, BIG = 108, SEP = 18;
    const used = items.reduce((n, it) => n + (it.sep ? SEP : it.big ? BIG : D), 0);
    const gap = (W - 12 - 2 * 18 - used) / (items.length - 1);
    let x = 6 + 18;
    let hoverLabel = "";
    for (const it of items) {
      if (it.sep) {
        ctx.fillStyle = "rgba(255,255,255,0.16)";
        ctx.fillRect(x + SEP / 2 - 1, cy - 26, 2, 52);
        x += SEP + gap;
        continue;
      }
      const d = it.big ? BIG : D;
      const hover = p.hoverId === it.id;
      if (hover) hoverLabel = it.label;
      if (it.big) drawTalkButton(ctx, x + d / 2, cy, d / 2, hover);
      else {
        ctx.beginPath();
        ctx.arc(x + d / 2, cy, d / 2, 0, Math.PI * 2);
        ctx.fillStyle = it.active
          ? (hover ? "rgba(255,255,255,1)" : "rgba(255,255,255,0.88)")
          : (hover ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.08)");
        ctx.fill();
        const s = d * 0.42;
        drawIcon(ctx, it.icon, x + (d - s) / 2, cy - s / 2, s, it.active ? "#14161d" : "#f4f5f8", 2);
        if (it.badge) {
          ctx.beginPath();
          ctx.arc(x + d - 12, cy - d / 2 + 12, 15, 0, Math.PI * 2);
          ctx.fillStyle = "#ff4d6d";
          ctx.fill();
          ctx.font = `700 18px ${THEME.font}`;
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(it.badge > 9 ? "9+" : String(it.badge), x + d - 12, cy - d / 2 + 13);
        }
      }
      p.zones.push({ id: it.id, x, y: cy - d / 2, w: d, h: d, onClick: it.on });
      x += d + gap;
    }

    // Légende du bouton survolé (l'état, lui, est déjà écrit sous l'orbe).
    if (hoverLabel) {
      ctx.font = `500 28px ${THEME.font}`;
      ctx.fillStyle = "rgba(244,245,248,0.85)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(hoverLabel, W / 2, dockY + dockH + 22);
    }
    // Poignée + fermeture.
    const gy = dockY + dockH + 48, gw = 150;
    const grab = p.hoverId === "__handle" || p.pressedId === "__handle";
    roundRect(ctx, (W - gw) / 2, gy, gw, 12, 6);
    ctx.fillStyle = grab ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.4)";
    ctx.fill();
    p.zones.push({ id: "__handle", x: (W - gw) / 2 - 40, y: gy - 16, w: gw + 80, h: 44, drag: true });
    const cx = (W + gw) / 2 + 44, cr = 20;
    ctx.beginPath();
    ctx.arc(cx, gy + 6, cr, 0, Math.PI * 2);
    ctx.fillStyle = p.hoverId === "__close" ? "rgba(255,84,112,0.8)" : "rgba(255,255,255,0.14)";
    ctx.fill();
    drawIcon(ctx, "x", cx - 12, gy + 6 - 12, 24, "#f4f5f8", 2.5);
    p.zones.push({ id: "__close", x: cx - cr - 6, y: gy + 6 - cr - 6, w: 2 * cr + 12, h: 2 * cr + 12, onClick: () => p.close() });
  },
}), new THREE.Vector3(0, -0.36, -1.12), 0, true, "bar");
bar.object.rotation.x = bar.home.pitch = -0.3;

// Menu « ⋯ » : gélule de verre qui s'ouvre au-dessus de la barre, rattachée à
// elle (elle suit quand on déplace la barre). Icône + libellé sous chaque bouton,
// espacement régulier — plus de boutons collés.
quickMenu = addPanel(new Panel({
  width: 0.78, height: 0.17, bare: true,
  draw(ctx, p) {
    const W = p.W, H = p.H, items = QUICK_ITEMS();
    roundRect(ctx, 6, 6, W - 12, H - 12, 44);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(64,68,86,0.62)"); g.addColorStop(1, "rgba(18,20,28,0.6)");
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.20)"; ctx.stroke();
    const cell = (W - 40) / items.length, D = 76;
    items.forEach((it, i) => {
      const cx = 20 + cell * (i + 0.5), cy = 22 + D / 2, hover = p.hoverId === it.id;
      ctx.beginPath(); ctx.arc(cx, cy, D / 2, 0, Math.PI * 2);
      ctx.fillStyle = it.active ? (hover ? "#fff" : "rgba(255,255,255,0.88)") : (hover ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.08)");
      ctx.fill();
      drawIcon(ctx, it.icon, cx - 16, cy - 16, 32, it.active ? "#14161d" : "#f4f5f8", 2);
      ctx.font = `500 21px ${THEME.font}`; ctx.fillStyle = hover ? "#fff" : "rgba(244,245,248,0.78)";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      let label = it.label; while (ctx.measureText(label).width > cell - 10 && label.length > 3) label = label.slice(0, -2);
      ctx.fillText(label === it.label ? label : label + "…", cx, cy + D / 2 + 24);
      p.zones.push({ id: it.id, x: cx - cell / 2 + 4, y: 10, w: cell - 8, h: H - 20, onClick: () => { it.on(); p.invalidate(); bar.invalidate(); } });
    });
  },
}), new THREE.Vector3(0, 0.2, 0.02), 0, false);
bar.object.add(quickMenu.object);
quickMenu.object.position.copy(quickMenu.home.pos);
quickMenu.object.visible = false;

function drawBarGrip(ctx, p, gy) {
  const W = p.W, gw = 150;
  const grab = p.hoverId === "__handle" || p.pressedId === "__handle";
  roundRect(ctx, (W - gw) / 2, gy, gw, 12, 6);
  ctx.fillStyle = grab ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.4)";
  ctx.fill();
  p.zones.push({ id: "__handle", x: (W - gw) / 2 - 40, y: gy - 16, w: gw + 80, h: 44, drag: true });
  const cx = (W + gw) / 2 + 44, cr = 20;
  ctx.beginPath(); ctx.arc(cx, gy + 6, cr, 0, Math.PI * 2);
  ctx.fillStyle = p.hoverId === "__close" ? "rgba(255,84,112,0.8)" : "rgba(255,255,255,0.14)";
  ctx.fill();
  drawIcon(ctx, "x", cx - 12, gy + 6 - 12, 24, "#f4f5f8", 2.5);
  p.zones.push({ id: "__close", x: cx - cr - 6, y: gy + 6 - cr - 6, w: 2 * cr + 12, h: 2 * cr + 12, onClick: () => p.close() });
}

/// Bouton « Parler » : disque aux couleurs de l'orbe (dégradé conique de la
/// palette active) ; en écoute, il vire au rouge et un anneau suit le micro.
function drawTalkButton(ctx, cx, cy, r, hover) {
  const listening = state.local === "listening";
  const cols = look.colors;
  if (listening) {
    const rr = r + 8 + micLevel * 14;
    const ring = ctx.createConicGradient(clock.elapsedTime * 1.5, cx, cy);
    cols.forEach((c, i) => ring.addColorStop(i / cols.length, c));
    ring.addColorStop(1, cols[0]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(rr, 62), 0, Math.PI * 2);
    ctx.lineWidth = 6;
    ctx.strokeStyle = ring;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  if (listening) {
    ctx.fillStyle = hover ? "#ff6b84" : "#ff4d6d";
  } else {
    const disc = ctx.createConicGradient(-Math.PI / 2, cx, cy);
    cols.forEach((c, i) => disc.addColorStop(i / cols.length, c));
    disc.addColorStop(1, cols[0]);
    ctx.fillStyle = disc;
  }
  ctx.fill();
  if (!listening) {
    // Voile blanc : le disque reste pastel, comme l'orbe au repos.
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    const veil = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    veil.addColorStop(0, hover ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.45)");
    veil.addColorStop(1, "rgba(255,255,255,0.08)");
    ctx.fillStyle = veil;
    ctx.fill();
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.stroke();
  const s = r * 0.8;
  drawIcon(ctx, listening ? "square" : "mic", cx - s / 2, cy - s / 2, s, "#ffffff", 2.25);
  // Mains libres : petit point vert, Lumen attend son nom.
  if (settings.handsFree && !listening) {
    ctx.beginPath();
    ctx.arc(cx + r * 0.72, cy + r * 0.72, 10, 0, Math.PI * 2);
    ctx.fillStyle = "#2fd08a";
    ctx.fill();
  }
}

// ---- Fiche « Regarde » (résultat vision, près de ce qu'on regarde) -------
const visionState = { image: null, text: "", pending: false, target: null };
const vision = addPanel(new Panel({
  width: 0.5, height: 0.62, title: T("Lumen regarde", "Lumen sees"), closable: true,
  onClose: () => { visionState.target = null; },
  draw(ctx, p) {
    const W = p.W, pad = 30;
    let y = 16;
    if (visionState.mode === "translate") {
      roundRect(ctx, 14, 10, W - 28, p.H - p.handleH - 24, 22);
      ctx.fillStyle = "rgba(252,251,246,0.97)"; ctx.fill();
      ctx.fillStyle = "#1b1c22"; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.font = `500 33px ${THEME.font}`;
      const tt = visionState.pending ? (visionState.status || T("Lecture du texte…", "Reading the text…")) : String(visionState.text || "").replace(/[*_#`>]/g, "");
      const lines = tt.split("\n").flatMap((l) => wrap(ctx, l, W - pad * 2 - 20));
      const maxL = Math.floor((p.H - p.handleH - 60) / 44);
      lines.slice(0, maxL).forEach((l, k) => ctx.fillText(l, pad + 10, 34 + k * 44));
      return;
    }
    if (visionState.image) {
      const img = visionState.image;
      const iw = W - pad * 2, ih = Math.min(300, iw * img.height / img.width);
      ctx.save();
      roundRect(ctx, pad, y, iw, ih, 22);
      ctx.clip();
      const s = Math.max(iw / img.width, ih / img.height);
      ctx.drawImage(img, pad + (iw - img.width * s) / 2, y + (ih - img.height * s) / 2, img.width * s, img.height * s);
      ctx.restore();
      y += ih + 24;
    }
    ctx.fillStyle = visionState.pending ? THEME.dim : THEME.text;
    ctx.font = `400 31px ${THEME.font}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const text = visionState.pending ? T("Analyse en cours…", "Analyzing…") : plain(visionState.text);
    const lines = wrap(ctx, text, W - pad * 2);
    const maxLines = Math.floor((p.H - p.handleH - y - 20) / 40);
    lines.slice(0, maxLines).forEach((l, k) => ctx.fillText(l, pad, y + k * 40));
    if (lines.length > maxLines) ctx.fillText("…", pad, y + maxLines * 40);
  },
}), new THREE.Vector3(0.72, 0.02, -1.08), -0.55, false, "vision");
vision.object.visible = false;

// ---- Demande de Lumen (accord, confirmation, choix d'emplacement) ----------
// Même demande que la carte du bureau et le bandeau du téléphone : la première
// réponse (où qu'elle soit donnée) l'emporte, les autres se ferment.
const request = { current: null };
const requestPanel = addPanel(new Panel({
  width: 0.66, height: 0.64, title: T("Lumen a besoin de toi", "Lumen needs you"), closable: true, resizable: false,
  onClose: () => { request.current = null; },
  draw(ctx, p) {
    const r = request.current;
    if (!r) return;
    const W = p.W, H = p.H - p.handleH, pad = 34;
    let y = 18;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    drawIcon(ctx, "bell", pad, y, 40, "#ffcf6b", 2.2);
    ctx.font = `600 34px ${THEME.font}`; ctx.fillStyle = THEME.text;
    for (const l of wrap(ctx, r.title || "Lumen", W - pad * 2 - 56).slice(0, 3)) { ctx.fillText(l, pad + 56, y); y += 44; }
    if (r.body) {
      y += 6;
      ctx.font = `400 28px ${THEME.font}`; ctx.fillStyle = THEME.dim;
      for (const l of wrap(ctx, plain(r.body), W - pad * 2).slice(0, 3)) { ctx.fillText(l, pad, y); y += 36; }
    }
    // Session verrouillée : pavé numérique pour le code à 6 chiffres de
    // l'application d'authentification (vérifié par l'ordinateur — le mot de
    // passe, lui, ne quitte jamais l'ordinateur).
    if (r.kind === "unlock") { drawUnlockPad(ctx, p, r, y + 10); return; }
    const opts = r.options || [];
    if (!opts.length) {
      // Mot de passe : il ne se saisit que sur l'ordinateur.
      y += 14;
      ctx.font = `500 28px ${THEME.font}`; ctx.fillStyle = "#ffcf6b";
      for (const l of wrap(ctx, T("Réponds sur l'ordinateur.", "Answer on the computer."), W - pad * 2)) { ctx.fillText(l, pad, y); y += 36; }
      return;
    }
    // Boutons : deux par ligne au plus, calés en bas, l'indication vocale dessous.
    const perRow = opts.length > 2 ? 2 : opts.length;
    const bw = (W - pad * 2 - 16 * (perRow - 1)) / perRow, bh = 68, gap = 12, hintH = 40;
    const rows = Math.ceil(opts.length / perRow);
    let by = Math.max(y + 16, H - hintH - rows * bh - (rows - 1) * gap - 10);
    const top = by;
    opts.forEach((o, i) => {
      const col = i % perRow;
      if (i && col === 0) by += bh + gap;
      // Dernière ligne incomplète : le bouton prend toute la largeur.
      const alone = col === 0 && i === opts.length - 1 && perRow > 1;
      p.pill("req:" + o.id, pad + col * (bw + 16), by, alone ? W - pad * 2 : bw, bh, o.label, () => answerUserRequest(o.id), { active: !!o.primary });
    });
    void top;
    ctx.font = `400 22px ${THEME.font}`; ctx.fillStyle = THEME.dim; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(T("…ou réponds à voix haute (« oui », « toujours », « non »)", "…or answer out loud (“yes”, “always”, “no”)"), W / 2, by + bh + hintH / 2 + 4);
  },
}), new THREE.Vector3(0, 1.45, -0.9), 0, false);
requestPanel.object.visible = false;

/// Devant les yeux, un peu à droite et au-dessus de la barre : ni sur l'orbe
/// (dont le halo traverse les panneaux), ni sur la barre d'outils.
function placeCentered(panel) {
  const { pos, quat } = headPose();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  fwd.y = Math.max(-0.3, Math.min(0.2, fwd.y));
  fwd.normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  right.y = 0;
  right.normalize();
  const target = pos.clone().addScaledVector(fwd, 0.8).addScaledVector(right, 0.36).add(new THREE.Vector3(0, 0.06, 0));
  panel.object.position.copy(world.worldToLocal(target));
  faceHead(panel.object);
}
function drawUnlockPad(ctx, p, r, y) {
  const W = p.W, pad = 34;
  // Casque appairé : un geste (ou « oui » à voix haute) suffit.
  if (r.unlockMode === "tap" && !r.needCode) {
    ctx.font = `400 26px ${THEME.font}`; ctx.fillStyle = r.error ? THEME.danger : THEME.dim;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(r.error || (r.busy ? T("Déverrouillage…", "Unlocking…") : T("Ce casque est appairé : un geste suffit.", "This headset is paired: one tap is enough.")), W / 2, y + 20);
    p.pill("unlock:tap", pad, y + 60, W - pad * 2, 84, T("Déverrouiller", "Unlock"), () => tapUnlock(), { active: true });
    p.pill("unlock:cancel", pad, y + 160, W - pad * 2, 64, T("Annuler", "Cancel"), () => answerUserRequest("cancel"));
    return;
  }
  // Six cases, remplies au fil de la saisie.
  const box = 58, gap = 12, total = 6 * box + 5 * gap;
  let x = (W - total) / 2;
  for (let k = 0; k < 6; k++) {
    roundRect(ctx, x, y, box, 66, 14);
    ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fill();
    if (k < r.code.length) {
      ctx.fillStyle = THEME.text; ctx.beginPath(); ctx.arc(x + box / 2, y + 33, 9, 0, Math.PI * 2); ctx.fill();
    }
    x += box + gap;
  }
  y += 78;
  ctx.font = `400 22px ${THEME.font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = r.error ? THEME.danger : THEME.dim;
  ctx.fillText(r.error || (r.busy ? T("Vérification…", "Checking…") : T("Dicte ou tape le code à 6 chiffres", "Say or type the 6-digit code")), W / 2, y + 12);
  y += 34;
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✕"];
  const kw = (W - pad * 2 - 2 * 14) / 3, kh = 52, kg = 10;
  keys.forEach((key, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    p.pill("pad:" + key, pad + col * (kw + 14), y + row * (kh + kg), kw, kh, key, () => pressUnlockKey(key));
  });
}
function tapUnlock() {
  const r = request.current;
  if (!r || r.busy) return;
  r.busy = true; r.error = "";
  send({ type: "remote-unlock", id: r.id, code: "" });
  requestPanel.invalidate();
}
function pressUnlockKey(key) {
  const r = request.current;
  if (!r || r.busy) return;
  if (key === "✕") { answerUserRequest("cancel"); return; }
  r.error = "";
  if (key === "⌫") r.code = r.code.slice(0, -1);
  else if (r.code.length < 6) r.code += key;
  if (r.code.length === 6) { r.busy = true; send({ type: "remote-unlock", id: r.id, code: r.code }); }
  requestPanel.invalidate();
}
function onUnlockResult(msg) {
  const r = request.current;
  if (!r || r.id !== msg.id) return;
  if (msg.ok) { toast(T("✓ Session déverrouillée", "✓ Session unlocked")); hideUserRequest(r.id); return; }
  r.busy = false; r.code = "";
  if (msg.error === "code-required") { r.needCode = true; r.error = T("Code requis", "Code required"); }
  else r.error = msg.error || T("Code incorrect.", "Wrong code.");
  earcon(false);
  requestPanel.invalidate();
}
function showUserRequest(msg) {
  if (!msg?.id) return;
  request.current = { id: msg.id, kind: msg.kind, title: msg.title, body: msg.kind === "unlock" ? "" : msg.body, options: Array.isArray(msg.options) ? msg.options : [], code: "", error: "", busy: false, unlockMode: msg.unlockMode || "code", needCode: false };
  placeCentered(requestPanel);
  requestPanel.object.visible = true;
  requestPanel.invalidate();
  apps.waiting(msg.title || "");
  earcon(true);
  onPanelsChanged();
}
function hideUserRequest(id) {
  if (!request.current || (id && request.current.id !== id)) return;
  request.current = null;
  requestPanel.object.visible = false;
  apps.waiting(null);
  onPanelsChanged();
}
function answerUserRequest(choice) {
  const r = request.current;
  if (!r) return;
  send({ type: "user-answer", id: r.id, choice });
  const opt = r.options.find((o) => o.id === choice);
  if (opt) toast(`✓ ${opt.label}`);
  hideUserRequest(r.id);
}

// ---- Réponses spatiales : le détail dans un panneau, l'orbe résume ----------
// Une réponse riche (tableau, liste d'au moins 4 éléments, texte long) s'ouvre
// AUSSI dans un panneau « Détail » posé à côté de l'orbe, qu'on peut déplacer
// dans la pièce ; à l'oral, Lumen ne lit que l'introduction.
/// Analyse Markdown légère → { rich, intro, blocks }.
function parseRich(md) {
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let listCount = 0, table = null, introDone = false;
  const intro = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|?\s*:?-{2,}/.test(line.replace(/\|/g, "|"))) continue; // séparateur
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => plain(c.trim()));
      if (!table) { table = { type: "table", rows: [] }; blocks.push(table); }
      table.rows.push(cells);
      introDone = true;
      continue;
    }
    table = null;
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) { blocks.push({ type: "h", text: plain(h[1]) }); introDone = introDone || intro.length > 0; continue; }
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (li) { blocks.push({ type: "li", text: plain(li[1]), indent: /^\s{2,}/.test(line) }); listCount++; introDone = true; continue; }
    blocks.push({ type: "p", text: plain(line) });
    if (!introDone) intro.push(plain(line));
  }
  const hasTable = blocks.some((b) => b.type === "table");
  const rich = hasTable || listCount >= 4 || String(md || "").length > 900;
  return { rich, blocks, intro: intro.join(" ").trim() };
}

const detail = { blocks: [], title: "", scroll: 0, lines: 0 };
const detailPanel = addPanel(new Panel({
  width: 0.72, height: 0.78, title: T("Détail", "Details"), closable: true,
  draw(ctx, p) {
    const W = p.W, H = p.H - p.handleH, pad = 34, lh = 40;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    // Mise en page complète, puis fenêtre visible selon le défilement.
    const rows = [];
    ctx.font = `600 32px ${THEME.font}`;
    for (const l of wrap(ctx, detail.title, W - pad * 2).slice(0, 2)) rows.push({ t: l, f: `600 32px ${THEME.font}`, c: THEME.text, h: 44 });
    rows.push({ gap: 10 });
    for (const b of detail.blocks) {
      if (b.type === "table") {
        const cols = Math.max(...b.rows.map((r) => r.length));
        const cw = (W - pad * 2) / Math.max(1, cols);
        b.rows.forEach((r, ri) => {
          ctx.font = `${ri === 0 ? 600 : 400} 24px ${THEME.font}`;
          const cellLines = r.map((c) => wrap(ctx, c, cw - 14).slice(0, 3));
          const hgt = Math.max(1, ...cellLines.map((x) => x.length)) * 30 + 12;
          rows.push({ table: true, cells: cellLines, cw, head: ri === 0, h: hgt });
        });
        rows.push({ gap: 12 });
        continue;
      }
      const font = b.type === "h" ? `600 30px ${THEME.font}` : `400 28px ${THEME.font}`;
      ctx.font = font;
      const prefix = b.type === "li" ? (b.indent ? "    ◦ " : "• ") : "";
      const ls = wrap(ctx, prefix + b.text, W - pad * 2 - (b.type === "li" ? 10 : 0));
      ls.forEach((l, i) => rows.push({ t: i && prefix ? "   " + l : l, f: font, c: b.type === "h" ? THEME.text : "rgba(244,245,248,0.9)", h: lh }));
      rows.push({ gap: b.type === "li" ? 2 : 10 });
    }
    const total = rows.reduce((n, r) => n + (r.gap ?? r.h), 0);
    const view = H - 90;
    detail.scroll = Math.max(0, Math.min(detail.scroll, Math.max(0, total - view)));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 8, W, view); ctx.clip();
    let y = 14 - detail.scroll;
    for (const r of rows) {
      if (r.gap != null) { y += r.gap; continue; }
      if (y + r.h > 0 && y < view + 10) {
        if (r.table) {
          r.cells.forEach((cl, ci) => {
            const x = pad + ci * r.cw;
            ctx.fillStyle = r.head ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)";
            roundRect(ctx, x + 2, y, r.cw - 4, r.h - 4, 8); ctx.fill();
            ctx.font = `${r.head ? 600 : 400} 24px ${THEME.font}`;
            ctx.fillStyle = THEME.text;
            cl.forEach((l, li) => ctx.fillText(l, x + 9, y + 6 + li * 30));
          });
        } else {
          ctx.font = r.f; ctx.fillStyle = r.c;
          ctx.fillText(r.t, pad, y);
        }
      }
      y += r.h;
    }
    ctx.restore();
    // Défilement (si nécessaire).
    if (total > view) {
      p.pill("dt-up", W / 2 - 150, H - 74, 140, 60, "▲", () => { detail.scroll = Math.max(0, detail.scroll - view * 0.8); detailPanel.invalidate(); });
      p.pill("dt-down", W / 2 + 10, H - 74, 140, 60, "▼", () => { detail.scroll += view * 0.8; detailPanel.invalidate(); });
    }
  },
}), new THREE.Vector3(0.4, 1.35, -0.9), -0.3, false, "detail");
detailPanel.object.visible = false;

function showDetail(md, title) {
  const parsed = parseRich(md);
  detail.blocks = parsed.blocks;
  detail.title = title || T("Réponse de Lumen", "Lumen's answer");
  detail.scroll = 0;
  // Posé à côté de ce qu'on regarde, sauf si l'utilisateur l'a déjà placé.
  if (!detailPanel.visible) placeInGaze(detailPanel);
  detailPanel.object.visible = true;
  detailPanel.invalidate();
  onPanelsChanged();
}

const DETAIL_SAY = {
  fr: ["Je t'ai mis le détail à côté.", "Le détail est affiché à côté de moi.", "Tu trouveras le détail dans le panneau.", "J'ai posé le détail à côté."],
  en: ["I've put the details next to me.", "The details are in the panel.", "Details are shown beside me."],
};
let lastDetailSay = -1;
function detailSay() {
  const list = DETAIL_SAY[LANG === "fr" ? "fr" : "en"];
  let i = Math.floor(Math.random() * list.length);
  if (i === lastDetailSay) i = (i + 1) % list.length;
  lastDetailSay = i;
  return list[i];
}

// ---- Étapes en 3D : ceinture d'icônes en relief autour de l'orbe ------------
// Les familles d'outils tournent autour de l'orbe pendant une réponse (icônes
// Lucide extrudées, blanches, légèrement transparentes) ; celle de l'outil
// utilisé clignote dans sa couleur quelques secondes (cf. xr-belt.js).
const belt = createToolBelt(world);
/// Le tour en cours passe par des outils (routeur « tools »/« orchestrate »).
const toolRoute = () => state.route === "tools" || state.route === "orchestrate";
const stepRing = (() => {
  let turnKey = "";
  let seen = 0;
  let lastT = performance.now();
  return {
    /// Transcription reçue : nouveaux appels d'outils → clignotement.
    fromMessage(m) {
      const blocks = m?.blocks || [];
      const plan = blocks.find((b) => b.kind === "plan");
      const tools = blocks.filter((b) => b.kind === "tool");
      const key = speech.turn;
      if (key !== turnKey) { turnKey = key; seen = 0; thoughts.clear(); }
      if (plan && toolRoute()) belt.busy(!!plan.live);
      for (let i = seen; i < tools.length; i++) {
        belt.flash(tools[i].name);
        // La source utilisée sort de son icône et vole vers l'orbe.
        const from = belt.iconWorldPos(tools[i].name) || orbWorld().add(new THREE.Vector3(0, -ORB_R * orbScale, 0));
        thoughts.spawn(tools[i], from);
      }
      for (const tl of tools) if (tl.result) thoughts.update(tl);
      seen = Math.max(seen, tools.length);
    },
    update(center, r, now) {
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      // Ceinture seulement quand le routeur a choisi les outils ou
      // l'orchestration : une réponse directe n'affiche aucune icône d'outil.
      if (state.desktop === "thinking" && toolRoute()) belt.busy(true);
      else if (!lumenBusy()) belt.busy(false);
      belt.update(center, r, now, dt);
    },
  };
})();

// Aperçu navigateur (src/__preview-xr.html) seulement : accès de débogage.
if (location.pathname.includes("__preview")) window.__xr = { requestPanel, request, headPose, scene, camera, detailPanel, detail, stepRing, get apps() { return apps; }, get speech() { return speech; }, settings, cycleStt: () => cycleStt(), get localStt() { return localStt; }, get props() { return props; }, get thoughts() { return thoughts; }, get env() { return env; }, get morning() { return morning; }, flyOrbTo: (p, o) => flyOrbTo(p, o), setFollow: (on) => setFollow(on), get orbFly() { return orbFly; }, get orbFollow() { return orbFollow; }, handleUtterance: (t) => handleUtterance(t), setFocus: (on) => setFocus(on), stepRing, belt, orbWorld: () => orbWorld(), get pointers() { return pointers; }, get panels(){return panels;}, get renderer(){return renderer;}, onMsg: (m) => props.onMessage(m) };

/// Réponse à voix haute : « oui », « autorise », « toujours », « non »,
/// « annule », ou le nom d'une sandbox proposée.
const YES_RE = /\b(oui|ouais|d'accord|ok|okay|vas-y|autorise|autoriser|accepte|confirme|valide|yes|sure|allow|confirm|go ahead)\b/i;
const ALWAYS_RE = /\b(toujours|always)\b/i;
const HOUR_RE = /\b(une heure|1 ?h|pendant une heure|for an hour|one hour|an hour)\b/i;
/// Chiffres dictés (« trois un quatre… », « 314 159 ») → « 314159 ».
const DIGIT_WORDS = { zero: 0, "zéro": 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, oh: 0 };
function spokenDigits(text) {
  let out = "";
  for (const w of text.toLowerCase().split(/[^a-z0-9éè]+/)) {
    if (/^\d+$/.test(w)) out += w;
    else if (w in DIGIT_WORDS) out += DIGIT_WORDS[w];
  }
  return out;
}
const NO_RE = /\b(non|refuse|refuser|annule|annuler|pas question|laisse tomber|no|deny|cancel|don'?t)\b/i;
function matchSpokenAnswer(text) {
  const r = request.current;
  // Déverrouillage : le code se dicte chiffre par chiffre.
  if (r?.kind === "unlock") {
    if (NO_RE.test(text)) return "cancel";
    if (r.unlockMode === "tap" && !r.needCode && (YES_RE.test(text) || /d[eé]verrouill|unlock/i.test(text))) { tapUnlock(); return null; }
    const code = spokenDigits(text).slice(0, 6);
    if (code.length === 6 && !r.busy) {
      r.code = code; r.error = ""; r.busy = true;
      send({ type: "remote-unlock", id: r.id, code });
      requestPanel.invalidate();
    }
    return null;
  }
  if (!r || !r.options.length) return null;
  const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const norm = (x) => String(x).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s*\(.*\)\s*$/, "").trim();
  // Choix d'une sandbox par son nom.
  const byName = r.options.find((o) => o.id !== "__skip" && norm(o.label).length > 1 && t.includes(norm(o.label)));
  if (r.kind === "choose" && byName) return byName.id;
  const has = (id) => r.options.some((o) => o.id === id);
  if (NO_RE.test(t)) return ["deny", "no", "__skip", "cancel"].find(has) || null;
  if (ALWAYS_RE.test(t) && has("always")) return "always";
  if (HOUR_RE.test(t) && has("hour")) return "hour";
  if (YES_RE.test(t)) return (r.options.find((o) => o.primary) || r.options[0]).id;
  return byName ? byName.id : null;
}

// Trait de rappel fiche → objet observé, et point posé sur l'objet.
const leader = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }),
);
const leaderDot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
leader.visible = leaderDot.visible = false;
scene.add(leader, leaderDot);

// ---- Choix du backend et du modèle IA --------------------------------------
// Mêmes commandes que le compagnon mobile (`set-backend`, `set-model`) : c'est
// le bureau qui bascule et renvoie l'état (`backend`).
const aiState = { scroll: 0, pending: "" };
const ai = addPanel(new Panel({
  width: 0.54, height: 0.95, title: T("Modèle IA", "AI model"), closable: true, onClose: onPanelsChanged,
  draw(ctx, p) {
    const W = p.W, H = p.H - p.handleH, pad = 30;
    const b = state.backend;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `600 26px ${THEME.font}`;
    ctx.fillStyle = THEME.dim;
    ctx.fillText("SOURCE", pad, 26);
    const cols = 2, gap = 14, ph = 72;
    const pw = (W - pad * 2 - gap) / cols;
    const sources = b.sources.length ? b.sources : [{ id: b.source, label: b.source || "—" }];
    sources.forEach((s, i) => {
      const x = pad + (i % cols) * (pw + gap), y = 50 + Math.floor(i / cols) * (ph + gap);
      p.pill("src:" + s.id, x, y, pw, ph, s.label, () => {
        if (s.id === b.source) return;
        aiState.pending = T("Bascule…", "Switching…");
        aiState.scroll = 0;
        send({ type: "set-backend", id: s.id });
        ai.invalidate();
      }, { active: s.id === b.source });
    });
    let y = 50 + Math.ceil(sources.length / cols) * (ph + gap) + 20;
    ctx.font = `600 26px ${THEME.font}`;
    ctx.fillStyle = THEME.dim;
    ctx.textAlign = "left";
    ctx.fillText(aiState.pending || T("MODÈLE", "MODEL"), pad, y);
    y += 24;
    const rowH = 70, footer = 96;
    const visible = Math.max(1, Math.floor((H - y - footer) / rowH));
    const models = b.models.length ? b.models : (b.model ? [b.model] : []);
    aiState.scroll = Math.max(0, Math.min(aiState.scroll, models.length - visible));
    if (!models.length) {
      ctx.font = `400 28px ${THEME.font}`;
      ctx.fillStyle = THEME.dim;
      ctx.fillText(b.source === "shortcut" ? T("Modèle choisi par le raccourci Apple", "Model chosen by the Apple Shortcut") : T("Aucun modèle trouvé", "No model found"), pad, y + 40);
    }
    models.slice(aiState.scroll, aiState.scroll + visible).forEach((m, k) => {
      const ry = y + k * rowH, id = "model:" + m, current = m === b.model;
      roundRect(ctx, pad, ry + 4, W - pad * 2, rowH - 8, 20);
      ctx.fillStyle = current ? "rgba(153,97,255,0.35)" : p.hoverId === id ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.05)";
      ctx.fill();
      if (current) drawIcon(ctx, "check", pad + 18, ry + rowH / 2 - 16, 32, "#ffffff", 2.5);
      ctx.font = `${current ? 600 : 400} 29px ${THEME.font}`;
      ctx.fillStyle = THEME.text;
      ctx.textAlign = "left";
      const full = modelName(m);
      let label = full;
      while (label.length > 4 && ctx.measureText(label).width > W - pad * 2 - 90) label = label.slice(0, -2);
      if (label !== full) label += "…";
      ctx.fillText(label, pad + 64, ry + rowH / 2);
      p.zones.push({ id, x: pad, y: ry + 4, w: W - pad * 2, h: rowH - 8, _content: true, onClick: () => {
        if (current) return;
        aiState.pending = T("Chargement du modèle…", "Loading model…");
        send({ type: "set-model", model: m });
        ai.invalidate();
      } });
    });
    const fy = H - footer + 12;
    if (models.length > visible) {
      p.iconButton("aup", pad, fy, 72, "", () => { aiState.scroll -= visible - 1; ai.invalidate(); }, { inContent: true, icon: "chevron-up" });
      p.iconButton("adown", pad + 88, fy, 72, "", () => { aiState.scroll += visible - 1; ai.invalidate(); }, { inContent: true, icon: "chevron-down" });
    }
    ctx.font = `400 26px ${THEME.font}`;
    ctx.fillStyle = THEME.dim;
    ctx.textAlign = "right";
    ctx.fillText(models.length ? T(`${models.length} modèle(s)`, `${models.length} model(s)`) : "", W - pad, fy + 36);
  },
}), new THREE.Vector3(0.7, 0.02, -1.1), -0.55, false, "ai");
ai.object.visible = false;

function toggleAi() {
  if (ai.visible) { ai.close(); return; }
  openNear(ai);
  send({ type: "list-backends" }); // catalogue à jour (modèles installés depuis)
  onPanelsChanged();
}

// ---- Réglages ----------------------------------------------------------------
const SETTINGS_ROWS = () => [
  { id: "handsFree", icon: "mic", title: T("Mains libres", "Hands-free"), sub: T("Dites « Lumen, … » sans rien toucher", "Say “Lumen, …” without touching anything"), on: settings.handsFree,
    toggle: () => { setSetting("handsFree", !settings.handsFree); syncMic(); } },
  { id: "wake", icon: "sparkles", title: T("Mot d'éveil dans le casque", "On-headset wake word"),
    sub: enroll.active ? T(`Calibrage… dites « Lumen » (${enroll.count + 1}/3)`, `Calibrating… say “Lumen” (${enroll.count + 1}/3)`)
      : wake.ready ? T("Calibré sur votre voix — touchez pour refaire", "Tuned to your voice — tap to redo") : T("Touchez puis dites 3 fois « Lumen »", "Tap, then say “Lumen” 3 times"),
    on: wake.ready, toggle: () => startEnroll() },
  { id: "stt", icon: "mic-vocal", title: T("Reconnaissance vocale", "Speech recognition"),
    sub: settings.stt === "local"
      ? (localStt.loading != null ? T(`Whisper dans le casque — téléchargement ${localStt.loading} %`, `Whisper on the headset — downloading ${localStt.loading}%`)
        : localStt.failed ? T("Whisper dans le casque indisponible — Mac utilisé · touchez pour changer", "Headset Whisper unavailable — Mac used · tap to change")
        : T("Whisper dans le casque (le Mac est soulagé) · touchez pour changer", "Whisper on the headset (spares the Mac) · tap to change"))
      : settings.stt === "headset"
        ? (headsetStt.supported ? T("Casque (navigateur) — repli Whisper si échec · touchez pour changer", "Headset (browser) — Whisper fallback · tap to change") : T("Casque indisponible dans ce navigateur — Whisper utilisé", "Headset unavailable in this browser — Whisper used"))
        : T("Whisper sur le Mac (privé, hors ligne) · touchez pour changer", "Whisper on the Mac (private, offline) · tap to change"),
    on: settings.stt !== "whisper",
    toggle: () => cycleStt() },
  { id: "whisperModel", icon: "cpu", title: settings.stt === "local" ? T("Modèle Whisper du casque", "Headset Whisper model") : T("Modèle Whisper du Mac", "Mac Whisper model"),
    sub: settings.stt === "local"
      ? (settings.localModel.endsWith("base") ? T("base — précis (≈ 80 Mo) · touchez pour tiny", "base — accurate (≈ 80 MB) · tap for tiny") : T("tiny — 2× plus rapide, moins précis (≈ 40 Mo) · touchez pour base", "tiny — 2× faster, less accurate (≈ 40 MB) · tap for base"))
      : settings.whisperModel.endsWith("small") ? T("small — plus précis (≈ 250 Mo) · touchez pour base", "small — more accurate (≈ 250 MB) · tap for base") : T("base — plus rapide (≈ 80 Mo) · touchez pour small", "base — faster (≈ 80 MB) · tap for small"),
    on: settings.stt === "local" ? settings.localModel.endsWith("base") : settings.whisperModel.endsWith("small"),
    toggle: () => {
      if (settings.stt === "local") { setChoice("localModel", settings.localModel.endsWith("base") ? HEADSET_MODELS[0].id : HEADSET_MODELS[1].id); preloadLocalStt(); }
      else setChoice("whisperModel", settings.whisperModel.endsWith("small") ? WHISPER_CHOICES[0].id : WHISPER_CHOICES[1].id);
    } },
  { id: "snap", icon: "pin", title: T("Aimanter les panneaux", "Snap panels"),
    sub: settings.snap === "near" ? T("Au mur seulement s'il est tout proche (30 cm) · touchez", "Only to a wall within 30 cm · tap")
      : settings.snap === "aimed" ? T("Au mur visé, même loin · touchez", "To the aimed wall, even far away · tap")
        : T("Jamais : le panneau reste où vous le lâchez · touchez", "Never: the panel stays where you drop it · tap"),
    on: settings.snap !== "off",
    toggle: () => setChoice("snap", SNAP_MODES[(SNAP_MODES.indexOf(settings.snap) + 1) % SNAP_MODES.length]) },
  { id: "subtitles", icon: "type", title: T("Sous-titres", "Subtitles"), sub: T("La phrase lue s'affiche sous l'orbe — utile dans le bruit", "The spoken sentence shows under the orb — handy in noise"), on: settings.subtitles,
    toggle: () => setSetting("subtitles", !settings.subtitles) },
  { id: "bargeIn", icon: "audio-lines", title: T("Interruption à la voix", "Voice interruption"), sub: T("Parlez pendant que Lumen répond pour l'arrêter", "Speak while Lumen answers to stop it"), on: settings.bargeIn,
    toggle: () => { setSetting("bargeIn", !settings.bargeIn); syncMic(); } },
  { id: "perf", icon: "gauge", title: T("Mode performance", "Performance mode"), sub: T("72 Hz et résolution réduite — économise la batterie", "72 Hz and lower resolution — saves battery"), on: settings.perf,
    toggle: () => { setSetting("perf", !settings.perf); applyPerf(); } },
  { id: "hd", icon: "scan-eye", title: T("Haute définition", "High definition"),
    sub: settings.perf ? T("Désactivée en mode performance", "Off in performance mode") : T("Texte plus net — s'applique au rendu à la prochaine entrée", "Sharper text — rendering applies on next entry"),
    on: settings.hd && !settings.perf, toggle: () => { setSetting("hd", !settings.hd); applyPerf(); } },
  { id: "room", icon: "house", title: T("Scanner la pièce", "Scan room"),
    sub: (() => { const c = spatial.counts(); return spatial.hasPlanes ? T(`${c.walls} mur(s), ${c.surfaces} surface(s) — touchez pour refaire`, `${c.walls} wall(s), ${c.surfaces} surface(s) — tap to redo`) : spatial.canCapture ? T("Murs et tables pour y poser les panneaux", "Walls and tables to place panels on") : T("Scan indisponible dans ce navigateur", "Scan unavailable in this browser"); })(),
    on: spatial.hasPlanes, toggle: () => { spatial.captureRoom().then((ok) => { if (!ok) toast(T("Scan indisponible", "Scan unavailable")); }); } },
  { id: "layers", icon: "type", title: T("Texte ultra-net (expérimental)", "Ultra-sharp text (experimental)"),
    sub: panelLayers.supported ? T("Couches natives du casque, en passthrough — à la prochaine entrée", "Headset native layers, passthrough — on next entry") : T("Non pris en charge par ce navigateur", "Not supported by this browser"),
    on: settings.layers, toggle: () => setSetting("layers", !settings.layers) },
  { id: "lookLive", icon: "eye", title: T("Regarde en continu", "Continuous look"),
    sub: T("Étiquette les objets autour de toi (une image toutes les 10 s)", "Labels objects around you (one image every 10 s)"),
    on: liveVision.on, toggle: () => setLiveVision(!liveVision.on) },
  { id: "occlusion", icon: "hand", title: T("Mains et meubles devant Lumen", "Hands and furniture in front"),
    sub: settings.occlusion ? T("Occlusion par la profondeur (Quest 3) — à la prochaine entrée", "Depth occlusion (Quest 3) — on next entry") : T("Désactivée : Lumen toujours au premier plan", "Off: Lumen always on top"),
    on: settings.occlusion, toggle: () => setSetting("occlusion", !settings.occlusion) },
  { id: "translate", icon: "globe", title: T("Traduction (« traduis ça »)", "Translation (“translate this”)"),
    sub: translateState.loading != null ? T(`Téléchargement des petits modèles… ${translateState.loading} %`, `Downloading small models… ${translateState.loading}%`)
      : settings.translate === "headset" ? T("Dans le casque (petits modèles, ≈ 110 Mo par langue) · touchez pour changer", "On the headset (small models, ≈ 110 MB per language) · tap to change")
      : settings.translate === "mac" ? T("Par le modèle déjà chargé du Mac · touchez pour changer", "By the Mac's already-loaded model · tap to change")
      : T("Désactivée (« lis ça » reste disponible) · touchez pour activer", "Off (“read this” still works) · tap to enable"),
    on: settings.translate !== "off",
    toggle: () => {
      settings.translate = { off: "headset", headset: "mac", mac: "off" }[settings.translate] || "off";
      lsSet("xrTranslate", settings.translate);
      if (settings.translate === "headset") {
        translateState.loading = 0;
        preloadTranslation(LANG === "en" ? "en" : "fr", (pct) => { translateState.loading = pct; settingsPanel.invalidate(); })
          .then(() => toast(T("Traduction prête dans le casque", "Translation ready on the headset")))
          .catch(() => toast(T("Petits modèles indisponibles (réseau ?)", "Small models unavailable (network?)"), 4000))
          .finally(() => { translateState.loading = null; settingsPanel.invalidate(); });
      }
    } },
  { id: "morning", icon: "sparkles", title: T("Rituel du matin", "Morning ritual"),
    sub: settings.morningAuto ? T("Automatique à la première entrée avant 11 h · « Lumen, bonjour » ou tuile Matin", "Automatic on first entry before 11 am · “Lumen, good morning” or Morning tile")
      : T("À la demande : « Lumen, bonjour » ou tuile Matin · touchez pour l'automatique", "On demand: “Lumen, good morning” or Morning tile · tap for automatic"),
    on: settings.morningAuto, toggle: () => { settings.morningAuto = !settings.morningAuto; lsSet("xrMorningAuto", settings.morningAuto ? "on" : "off"); } },
  { id: "morningTopics", icon: "globe", title: T("Thèmes d'actualité du matin", "Morning news topics"),
    sub: morningCfg.topics?.length ? `${morningCfg.topics.join(" · ")} — ${T("touchez pour dicter", "tap to dictate")}` : T("Aucun — touchez et dictez « IA, réalité mixte, course à pied »", "None — tap and dictate “AI, mixed reality, running”"),
    on: !!morningCfg.topics?.length,
    toggle: () => dictate(T("Quels thèmes suivre ? Sépare-les par « et » ou des virgules.", "Which topics? Separate them with “and” or commas."), (text) => {
      const topics = String(text || "").split(/\s*(?:,|;|\bet\b|\band\b)\s*/i).map((t) => t.replace(/[.!?]+$/, "").trim()).filter((t) => t.length > 1).slice(0, 6);
      if (!topics.length) return;
      send({ type: "xr-morning-config", patch: { topics } });
      morningCfg.topics = topics; settingsPanel.invalidate();
      toast(T(`Thèmes : ${topics.join(", ")}`, `Topics: ${topics.join(", ")}`), 3500);
    }) },
  { id: "morningCity", icon: "map-pin", title: T("Ville de la météo du matin", "Morning weather city"),
    sub: morningCfg.city ? `${morningCfg.city} — ${T("touchez pour dicter", "tap to dictate")}` : T("Non définie — touchez et dictez la ville", "Not set — tap and dictate the city"),
    on: !!morningCfg.city,
    toggle: () => dictate(T("Quelle ville pour la météo ?", "Which city for the weather?"), (text) => {
      const city = String(text || "").replace(/[.!?]+$/, "").trim();
      if (!city) return;
      send({ type: "xr-morning-config", patch: { city } });
      morningCfg.city = city; settingsPanel.invalidate();
      toast(T(`Météo : ${city}`, `Weather: ${city}`), 3000);
    }) },
  { id: "focusEnv", icon: "moon", title: T("Ambiance du mode focus", "Focus mode ambience"),
    sub: settings.focusEnv >= 0 ? T(`${ENVIRONMENTS[settings.focusEnv % ENVIRONMENTS.length].fr} · touchez pour changer`, `${ENVIRONMENTS[settings.focusEnv % ENVIRONMENTS.length].en} · tap to change`) : T("Aucune (la pièce reste visible)", "None (the room stays visible)"),
    on: settings.focusEnv >= 0,
    toggle: () => {
      settings.focusEnv = settings.focusEnv + 1 >= ENVIRONMENTS.length ? -1 : settings.focusEnv + 1;
      lsSet("xrFocusEnv", String(settings.focusEnv));
      if (focusMode.on) { if (settings.focusEnv >= 0) env.show(settings.focusEnv); else env.hide(); }
    } },
  { id:"readingContrast",icon:"eye",title:T("Lecture à fort contraste","High contrast reading"),sub:T("Fond opaque derrière les documents","Opaque backing behind documents"),on:settings.readingContrast,toggle:()=>{setSetting("readingContrast",!settings.readingContrast);lightDesk?.debug().reader?.invalidate();}},
  { id:"textSize",icon:"type",title:T("Taille du texte","Text size"),sub:`${settings.textSize} px · ${T("touchez pour agrandir","tap to enlarge")}`,on:true,toggle:()=>{settings.textSize=settings.textSize>=36?24:settings.textSize+4;lsSet("xrTextSize",String(settings.textSize));lightDesk?.debug().reader?.invalidate();}},
  { id:"agentScale",icon:"users",title:T("Taille des agents","Agent size"),sub:`× ${settings.agentScale} · ${T("touchez pour changer, ou « agents plus grands / plus petits »","tap to change, or “bigger / smaller agents”")}`,on:true,toggle:()=>{const i=AGENT_SCALES.findIndex(v=>v>=settings.agentScale-1e-3);setAgentScale(AGENT_SCALES[(i+1)%AGENT_SCALES.length]);}},
  { id:"reducedMotion",icon:"pause",title:T("Animations réduites","Reduced motion"),sub:T("Limite les mouvements décoratifs","Limits decorative motion"),on:settings.reducedMotion,toggle:()=>setSetting("reducedMotion",!settings.reducedMotion)},
  { id:"adaptiveQuality",icon:"gauge",title:T("Qualité adaptative","Adaptive quality"),sub:T("Ajuste les panneaux et la fovéation","Adjusts panels and foveation"),on:settings.adaptiveQuality,toggle:()=>{setSetting("adaptiveQuality",!settings.adaptiveQuality);applyPerf();}},
  { id: "anchors", icon: "anchor", title: T("Ancrer dans la pièce", "Anchor in the room"), sub: spatial.hasAnchors ? T("Lumen reste là où vous le posez", "Lumen stays where you put it") : T("Ancres indisponibles ici", "Anchors unavailable here"), on: spatial.enabled,
    toggle: () => { spatial.enabled = !spatial.enabled; lsSet("xrAnchorsOn", spatial.enabled ? "on" : "off"); if (!spatial.enabled) spatial.clearAll(); } },
];
let settingsScroll=0;
const settingsPanel = addPanel(new Panel({
  width: 0.74, height: 1.25, title: T("Réglages", "Settings"), closable: true, onClose: onPanelsChanged,
  draw(ctx, p) {
    const W = p.W, H = p.H - p.handleH, x = 30, w = W - 60;
    const allRows=SETTINGS_ROWS(),per=7;
    settingsScroll=Math.max(0,Math.min(settingsScroll,allRows.length-per));
    const rows=allRows.slice(settingsScroll,settingsScroll+per);
    p.onScroll=delta=>{settingsScroll+=delta;p.invalidate();};
    // Hauteur de ligne ajustée à la place : le bouton du bas ne chevauche jamais.
    const rowH = Math.min(112, Math.floor((H - 14 - 110) / rows.length) - 10);
    rows.forEach((r, k) => {
      const y = 14 + k * (rowH + 10), id = "set:" + r.id;
      roundRect(ctx, x, y, w, rowH, 26);
      ctx.fillStyle = p.hoverId === id ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)";
      ctx.fill();
      drawIcon(ctx, r.icon, x + 24, y + rowH / 2 - 20, 40, "#f4f5f8", 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = `600 29px ${THEME.font}`;
      ctx.fillStyle = THEME.text;
      ctx.fillText(r.title, x + 86, y + rowH / 2 - 18);
      ctx.font = `400 22px ${THEME.font}`;
      ctx.fillStyle = THEME.dim;
      let sub = r.sub;
      const room = w - 86 - 140; // l'interrupteur occupe la droite
      if (ctx.measureText(sub).width > room) {
        while (sub.length > 3 && ctx.measureText(sub + "…").width > room) sub = sub.slice(0, -1);
        sub += "…";
      }
      ctx.fillText(sub, x + 86, y + rowH / 2 + 20);
      // Interrupteur.
      const sw = 92, sh = 52, sx = x + w - sw - 24, sy = y + (rowH - sh) / 2;
      roundRect(ctx, sx, sy, sw, sh, sh / 2);
      ctx.fillStyle = r.on ? "#2fd08a" : "rgba(255,255,255,0.22)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(r.on ? sx + sw - sh / 2 : sx + sh / 2, sy + sh / 2, sh / 2 - 5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      p.zones.push({ id, x, y, w, h: rowH, _content: true, onClick: () => { r.toggle(); settingsPanel.invalidate(); bar.invalidate(); chat.invalidate(); } });
    });
    const fy = H - 96;
    p.iconButton("settings:up",x,fy,64,"",()=>p.onScroll(-per),{inContent:true,icon:"chevron-up"});
    p.iconButton("settings:down",x+76,fy,64,"",()=>p.onScroll(per),{inContent:true,icon:"chevron-down"});
    p.pill("forget", x+160, fy, w-160, 64, T("Oublier les emplacements (tout recentrer)", "Forget placements (recenter all)"), () => { resetLayout(); toast(T("Emplacements oubliés", "Placements forgotten")); });
  },
}), new THREE.Vector3(0.7, 0.05, -1.05), -0.55, false, "settings");
settingsPanel.object.visible = false;

const spokenReview={text:"",accept:null};
const spokenReviewPanel=addPanel(new Panel({width:.67,height:.58,title:T("Vérifier la dictée","Review speech"),closable:true,draw(c,p){
  const W=p.W,H=p.H-p.handleH;c.fillStyle=THEME.text;c.font=`400 29px ${THEME.font}`;c.textAlign="left";c.textBaseline="top";
  wrap(c,spokenReview.text,W-64).slice(0,7).forEach((line,k)=>c.fillText(line,32,20+k*38));
  p.pill("speech:edit",30,H-86,(W-72)/2,62,T("Redicter","Speak again"),()=>dictate(T("Corrigez la phrase","Correct the phrase"),text=>{spokenReview.text=String(text || "");spokenReviewPanel.invalidate();},{field:true}));
  p.pill("speech:send",42+(W-72)/2,H-86,(W-72)/2,62,T("Confirmer","Confirm"),()=>{const action=spokenReview.accept,text=spokenReview.text.trim();spokenReviewPanel.close();if(text)action?.(text);},{active:true});
}}),new THREE.Vector3(0,.12,-.9),0,false,"speech-review");spokenReviewPanel.object.visible=false;
const sensitiveSpeech = text => /\b(supprime|efface|détruis|detruis|delete|erase|envoie|envoyer|send|publie|publish|achète|achete|buy|paie|paye|pay|virement|transfer)\b/i.test(text);
function reviewSpeech(text,accept){spokenReview.text=text;spokenReview.accept=accept;spokenReviewPanel.invalidate();openNear(spokenReviewPanel);}

// ---- Apps (xr-apps.js) --------------------------------------------------------
const apps = createApps({
  Panel, THEME, wrap, plain, roundRect, drawIcon, send, api, T, toast, lang: LANG,
  onNotification: (item) => lightDesk?.notify(item),
  // Dictée d'une tâche d'agent, et lecture de sa réponse avec SA voix.
  dictate: (prompt, cb, options) => dictate(prompt, cb, options),
  speak: (text, { voice = "", agentId = "" } = {}) => {
    if (!text) return;
    speech.done = false; speech.spokenText = "";
    // L'agent a sa figurine dans la pièce : il parle depuis elle.
    const pos = agentId ? props?.figurinePos(agentId) : null;
    enqueueSpeech(cleanSpeech(text), { dedupe: false, voice, pos, agentId });
    speech.done = true;
  },
  stopSpeaking: () => stopSpeaking(),
  onAgentEvent: (type, msg) => props?.agentEvent(type, msg),
  // Réponse d'agent : juste au-dessus de l'orbe, tournée vers l'utilisateur.
  placeNearOrb: (p) => {
    if (p.key) spatial.release(p.key);
    setWorldPosition(p.object, orbWorld().add(new THREE.Vector3(0, 0.46, 0)));
    faceHead(p.object);
    if (!p.visible) p.open();
    onPanelsChanged();
  },
  addPanel: (panel, pos, yaw, reopenable) => addPanel(panel, pos, yaw, reopenable, "app:" + panel.title),
  openNear, onPanelsChanged,
  openChart3D: (o) => extras?.openChart3D(o),
  extraTiles: () => [
    { id: "space", icon: "map-pin", label: T("Espace", "Space"), panel: space?.hub, open: () => { if (space.hub.visible) space.hub.close(); else space.open(); } },
    // Rituel du matin (île KayKit, météo, actualité, projets, semaine).
    { id: "morning", icon: "sparkles", label: T("Matin", "Morning"), panel: { get visible() { return morning?.running; } }, open: () => (morning.running ? morning.stop() : morning.start()) },
    // Bureau physique : dossiers des sandboxes et figurines des agents sur la table.
    { id: "desk", icon: "folder-open", label: T("Bureau", "Desk"), panel: { get visible() { return props?.shown; } }, open: () => props.toggle() },
    { id: "lumenapps", icon: "app-window", label: T("Apps Lumen", "Lumen apps"), panel: extras?.appsPanel, open: () => extras.openApps() },
    { id: "mirror", icon: "monitor", label: T("Écran", "Screen"), panel: extras?.mirrorPanel, open: () => extras.openMirror() },
    { id: "keyboard", icon: "keyboard", label: T("Clavier", "Keyboard"), panel: extras?.keyboard, open: () => extras.openKeyboard() },
  ],
});
world.add(apps.halo.object);

// ---- Espace (minuteurs, post-it, objets, domotique) et extras ---------------
/// Point visé par le regard : surface réelle (hit-test) à moins de 3 m, sinon
/// un point devant soi à `dist` mètres.
function gazePoint(dist = 0.9) {
  const { pos, quat } = headPose();
  const hit = spatial.lastHit;
  if (hit && hit.distanceTo(pos) < 3) return hit.clone();
  return pos.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(quat), dist);
}
const sharedCtx = {
  THREE, scene, world, Panel, THEME, wrap, plain, roundRect, drawIcon, send, api, T, toast, lang: LANG, settings,
  mediaUrl: (sandboxId,path) => `/media/${encodeURIComponent(sandboxId)}/${String(path).split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(token)}`,
  spatial, headPose, faceHead, setWorldPosition, gazePoint, orbWorld: () => orbWorld(), openNear, onPanelsChanged,
  addPanel, removePanel,
  lookHit: () => spatial.lastHit?.clone() || null,
  look: () => look,
  lookAt: (p) => { lookFocus = { point: p.clone(), until: performance.now() + 4000 }; },
  anchor: (key, obj) => spatial.anchor(key, obj),
  audio: () => ensureAudio(),
  earcon: (up) => earcon(up),
  say: (text) => { if (text) { speech.done = false; speech.spokenText = ""; enqueueSpeech(cleanSpeech(text), { dedupe: false }); speech.done = true; } },
  captureFrame: () => captureFrame(),
  dictate: (prompt, cb, options) => dictate(prompt, cb, options),
  sendChat: (text) => { state.route = null; state.turnVoice = ""; send({ type: "chat", text, voice: true }); },
  keyboardPrefill: (t) => extras.prefillKeyboard(t),
  runIntent: (appId, intentId, args) => extras.runIntent(appId, intentId, args),
};
extras = createExtras(sharedCtx);
space = createSpace(sharedCtx);

// ---- Objets physiques, pensée visible, ambiances ------------------------------
/// Vibration de la manette (rien avec les mains nues).
function haptic(p, intensity = 0.4, ms = 30) {
  try { p?.inputSource?.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, ms); } catch {}
}
/// Lance `cb` quand Lumen a fini de parler (au plus 12 s d'attente).
function whenSilent(cb, t0 = performance.now()) {
  if ((!speech.playing && !speech.queue.length) || performance.now() - t0 > 12000) { setTimeout(cb, 250); return; }
  setTimeout(() => whenSilent(cb, t0), 150);
}
sharedCtx.flyOrbTo = (p) => flyOrbTo(p);
const props = createProps({
  ...sharedCtx,
  apps,
  haptic,
  whenSilent,
  isSpeaking: () => speech.playing || speech.queue.length > 0,
  speakAt: (text, { voice = "", pos } = {}) => { speech.done = false; speech.spokenText = ""; enqueueSpeech(cleanSpeech(text), { dedupe: false, voice, pos }); speech.done = true; },
  agentVoiceLevel: (id) => agentVoiceLevel(id),
  openDocument: (doc) => lightDesk?.openDocument(doc),
  updateDocument: (doc) => lightDesk?.updateDocument(doc),
  pulseOrb: () => pulseHeart({ strength: 90 }),
});
lightDesk = createLightDesk({ ...sharedCtx, props, apps, extras, haptic, onDockChanged: () => { bar?.invalidate(); placeQuickMenu(); },
  barAnchor: () => (bar.visible ? bar.object.getWorldPosition(new THREE.Vector3()) : null),
  focus: () => setFocus(!focusMode.on),
  startMorning: () => morning.start(),
  dockActions: {
    talk: () => toggleTalk(), listening: () => state.local === "listening",
    chat: () => togglePanel(chat), chatOpen: () => chat.visible,
    look: () => lookAndAsk(""),
    voice: () => toggleVoice(), voiceOn: () => !!state.voice,
    tools: () => extras.openTools(), ai: () => toggleAi(), aiOpen: () => ai.visible,
    focusOn: () => focusMode.on, settingsOpen: () => settingsPanel.visible,
    center: () => { resetLayout(); toast(T("Recentré", "Recentered")); },
  },
  openSettings: () => togglePanel(settingsPanel),
  animateOpened: (origin) => { for(const panel of panels) if(panel.visible && performance.now()-(panel.openedAt || 0)<150) lightDesk.animatePanel(panel,origin); },
});
// Un seul dock : les icônes sont posées sur la barre (qu'on déplace par sa poignée).
lightDesk.attach(bar.object, new THREE.Vector3(0, 0.035, 0.02));
bar.invalidate();
if(location.pathname.includes("__preview")) window.__xr.lightDesk=lightDesk;
const thoughts = createThoughts({ ...sharedCtx, showDetail: (md, title) => showDetail(md, title) });
const env = createEnvironment(sharedCtx);
var morningHidden = null; // var : lu par saveLayout avant cette ligne
const morning = createMorning({
  ...sharedCtx,
  speak: (text, { pos } = {}) => { speech.done = false; speech.spokenText = ""; enqueueSpeech(cleanSpeech(text), { dedupe: false, pos: pos || null }); speech.done = true; },
  isSpeaking: () => speech.playing || speech.queue.length > 0,
  voiceOn: () => !!state.voice && !speech.muted,
  stopSpeaking: () => stopSpeaking(),
  showDetail: (md, title) => showDetail(md, title),
  // La pièce passe en lumière d'aube (décor voilé), le temps du rituel.
  // Le temps du rituel : décor d'aube et TOUT le reste masqué (panneaux, dock,
  // objets, notifications) pour que les cartes ne se superposent à rien ; le
  // bouton « Quitter » du rituel (ou sa fin) rétablit exactement ce qui était là.
  ambience: (on) => {
    if (on && !morningHidden) {
      morningHidden = panels.filter((p) => p.visible);
      for (const p of morningHidden) p.object.visible = false;
      props.hideAll?.(true); lightDesk?.hideAll?.(true);
      if (!focusMode.on) env.show(1, { opacity: 0.55 });
    } else if (!on && morningHidden) {
      for (const p of morningHidden) if (panels.includes(p)) p.object.visible = true;
      morningHidden = null;
      props.hideAll?.(false); lightDesk?.hideAll?.(false);
      if (!focusMode.on) env.hide();
      onPanelsChanged();
    }
  },
  orbOver: (p) => orbOver(p),
  orbHome: () => orbHome(),
});
let lookFocus = null; // l'orbe regarde un point précis (objet retrouvé)

// ---- Voyant de confidentialité ---------------------------------------------
// Pastille fixée dans le champ de vision (en haut) dès que le micro ou la
// caméra sont ouverts : orange pour le micro, vert pour la caméra — les
// couleurs des voyants système. Rien n'est capté sans qu'on le voie.
const privacy = new Panel({
  width: 0.14, height: 0.045, bare: true,
  draw(ctx, p) {
    const items = [];
    if (state.micActive) items.push({ icon: "mic", color: "#ff9f0a" });
    if (state.camActive) items.push({ icon: "camera", color: "#30d158" });
    if (!items.length) return;
    const H = p.H, w = 26 + items.length * 52;
    const x0 = (p.W - w) / 2;
    roundRect(ctx, x0, 2, w, H - 4, (H - 4) / 2);
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fill();
    items.forEach((it, i) => {
      const cx = x0 + 13 + i * 52 + 26;
      ctx.beginPath();
      ctx.arc(cx, H / 2, 17, 0, Math.PI * 2);
      ctx.fillStyle = it.color;
      ctx.fill();
      drawIcon(ctx, it.icon, cx - 11, H / 2 - 11, 22, "#000000", 2.5);
    });
  },
});
privacy.mesh.material.depthTest = false;
privacy.mesh.renderOrder = 20;
scene.add(privacy.object);
function setPrivacy() {
  privacy.object.visible = state.micActive || state.camActive;
  privacy.invalidate();
}
setPrivacy();

// ---------------------------------------------------------------------------
// Voix : sortie spatiale
// ---------------------------------------------------------------------------
// La voix de Lumen sort de l'orbe. Un PannerNode HRTF est placé à la position
// de l'orbe et l'auditeur suit la tête, à chaque image — déplacer l'orbe (ou
// tourner la tête) déplace donc la voix dans la pièce.
let audioCtx = null;
let voicePanner = null;
let voiceAnalyser = null;
let currentSource = null;
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    voicePanner = new PannerNode(audioCtx, {
      panningModel: "HRTF", distanceModel: "inverse", refDistance: 1, maxDistance: 20, rolloffFactor: 0.8,
    });
    voiceAnalyser = audioCtx.createAnalyser();
    voiceAnalyser.fftSize = 512;
    voiceAnalyser.connect(voicePanner);
    voicePanner.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

const _ap = new THREE.Vector3(), _af = new THREE.Vector3(), _au = new THREE.Vector3(), _aq = new THREE.Quaternion();
function setParam(param, v, t) { if (param?.setTargetAtTime) param.setTargetAtTime(v, t, 0.03); }
function updateSpatialAudio() {
  if (!audioCtx || !voicePanner) return;
  const t = audioCtx.currentTime;
  if (agentPanner && agentPosFn) {
    const ap = agentPosFn();
    if (ap) { setParam(agentPanner.positionX, ap.x, t); setParam(agentPanner.positionY, ap.y, t); setParam(agentPanner.positionZ, ap.z, t); }
  }
  orbRig.getWorldPosition(_ap);
  setParam(voicePanner.positionX, _ap.x, t);
  setParam(voicePanner.positionY, _ap.y, t);
  setParam(voicePanner.positionZ, _ap.z, t);
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.getWorldPosition(_ap);
  cam.getWorldQuaternion(_aq);
  _af.set(0, 0, -1).applyQuaternion(_aq);
  _au.set(0, 1, 0).applyQuaternion(_aq);
  const L = audioCtx.listener;
  if (L.positionX) {
    setParam(L.positionX, _ap.x, t); setParam(L.positionY, _ap.y, t); setParam(L.positionZ, _ap.z, t);
    setParam(L.forwardX, _af.x, t); setParam(L.forwardY, _af.y, t); setParam(L.forwardZ, _af.z, t);
    setParam(L.upX, _au.x, t); setParam(L.upY, _au.y, t); setParam(L.upZ, _au.z, t);
  } else {
    L.setPosition(_ap.x, _ap.y, _ap.z);
    L.setOrientation(_af.x, _af.y, _af.z, _au.x, _au.y, _au.z);
  }
}

/// Petit son (spatial, depuis l'orbe) : Lumen a entendu son nom, etc.
function earcon(up = true) {
  const ctx = ensureAudio();
  const o = ctx.createOscillator(), g = ctx.createGain();
  const t = ctx.currentTime;
  o.type = "sine";
  o.frequency.setValueAtTime(up ? 660 : 880, t);
  o.frequency.exponentialRampToValueAtTime(up ? 990 : 520, t + 0.16);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g).connect(voicePanner);
  o.start(t);
  o.stop(t + 0.25);
}

// ---- File de parole : lecture AU FIL de la génération ----------------------
// Chaque phrase terminée part en synthèse dès qu'elle apparaît dans la
// transcription ; les requêtes partent en parallèle, la lecture reste dans
// l'ordre. `gen` invalide tout ce qui est en vol quand on interrompt.
let ttsSeq = 0;
const ttsWaiting = new Map();
const speech = {
  gen: 0, queue: [], playing: false,
  said: new Set(), turn: "", // phrases dites pendant la question en cours
  primed: false, baseline: 0, // index à partir duquel un message est « nouveau »
  msgIdx: -1, spokenText: "", done: false,
};

/// `voice` : voix d'un agent (« local:… » Piper/Kokoro) ; vide = voix de Lumen.
function requestTts(text, voice = "") {
  const id = ++ttsSeq;
  return new Promise((resolve) => {
    ttsWaiting.set(id, resolve);
    send({ type: "xr-tts", id, text, ...(voice ? { voice } : {}) });
    setTimeout(() => { if (ttsWaiting.delete(id)) resolve(null); }, 25000);
  });
}
function onTtsAudio(msg) {
  const resolve = ttsWaiting.get(msg.id);
  if (!resolve) return;
  ttsWaiting.delete(msg.id);
  resolve(msg.b64 || null);
}

function cleanSpeech(text) {
  return plain(text).replace(/\p{Extended_Pictographic}/gu, " ").replace(/[︎️‍⃣]/g, "").replace(/\s+/g, " ").trim();
}
function chunkSpeech(text) {
  const sentences = text.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || [];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > 220) { out.push(cur.trim()); cur = s; } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/// Phrases déjà dites pour la question en cours : le même texte arrive par
/// plusieurs chemins (transcription au fil de l'eau, réponse finale `answer`,
/// bulle re-rendue avec un index différent…) — quel que soit le chemin, une
/// phrase n'est prononcée qu'UNE fois par tour.
const sayKey = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/// `pos` (fonction → Vector3 monde) : la phrase est dite DEPUIS ce point (la
/// figurine d'un agent) au lieu de l'orbe ; `agentId` anime cette figurine.
function enqueueSpeech(text, { dedupe = true, voice = "", pos = null, agentId = "" } = {}) {
  if (!state.voice) return;
  voice ||= state.turnVoice || "";
  if (dedupe) {
    const sentences = text.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || [];
    text = sentences.filter((sn) => {
      const k = sayKey(sn);
      if (!k) return false;
      if (speech.said.has(k)) return false;
      speech.said.add(k);
      return true;
    }).join(" ");
  }
  for (const part of chunkSpeech(text)) {
    if (!/[\p{L}\p{N}]/u.test(part)) continue;
    speech.queue.push({ text: part, audio: requestTts(part, voice), pos, agentId });
  }
  if (!speech.playing && speech.queue.length) playQueue();
}

async function playQueue() {
  if (speech.runner) return; // un seul lecteur : l'ordre est garanti
  speech.runner = true;
  try { await playQueueInner(); } finally { speech.runner = false; }
  if (speech.queue.length && !speech.playing) playQueue();
}
async function playQueueInner() {
  const gen = speech.gen;
  speech.playing = true;
  state.local = state.local === "listening" || state.local === "transcribing" ? state.local : "speaking";
  refreshUi();
  syncMic();
  const ctx = ensureAudio();
  while (speech.queue.length) {
    const item = speech.queue.shift();
    const b64 = await item.audio;
    if (gen !== speech.gen) return;
    if (speech.filler) { await speech.filler; speech.filler = null; if (gen !== speech.gen) return; }
    speech.current = item.text; // sous-titre
    caption.invalidate();
    if (b64) {
      try {
        const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
        const audio = await ctx.decodeAudioData(buf);
        if (gen !== speech.gen) return;
        await playBuffer(ctx, audio, item);
      } catch { await speakSystem(item.text); }
    } else {
      await speakSystem(item.text);
    }
    if (gen !== speech.gen) return;
  }
  speech.playing = false;
  speech.current = "";
  if (state.local === "speaking") state.local = "idle";
  refreshUi();
  syncMic();
}

// Lecture sur l'HORLOGE audio : chaque morceau démarre à la fin exacte du
// précédent (`voiceClock`) et on n'attend pas `onended`. Sur le Quest, un
// contexte audio suspendu (entrée en XR, perte de focus) met les `start()` en
// file puis les lâche TOUS à la reprise — d'où des phrases superposées.
let voiceClock = 0;
const liveSources = new Set();
// Voix d'un agent parlant depuis sa figurine : son propre panner + analyseur
// (la figurine « respire » au rythme de sa voix ; la bouche de l'orbe, non).
let agentPanner = null, agentAnalyser = null, speakingAgent = "", agentPosFn = null;
const agentData = new Uint8Array(256);
function agentVoiceLevel(id) {
  if (!agentAnalyser || !speakingAgent || id !== speakingAgent) return 0;
  agentAnalyser.getByteTimeDomainData(agentData);
  let sum = 0;
  for (let i = 0; i < agentData.length; i++) { const v = (agentData[i] - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / agentData.length) * 5);
}
async function playBuffer(ctx, audio, item = {}) {
  if (ctx.state !== "running") { try { await ctx.resume(); } catch {} }
  const src = ctx.createBufferSource();
  src.buffer = audio;
  if (item.pos) {
    if (!agentPanner) {
      agentPanner = new PannerNode(ctx, { panningModel: "HRTF", distanceModel: "inverse", refDistance: 0.8, maxDistance: 20, rolloffFactor: 0.8 });
      agentAnalyser = ctx.createAnalyser();
      agentAnalyser.fftSize = 512;
      agentAnalyser.connect(agentPanner);
      agentPanner.connect(ctx.destination);
    }
    agentPosFn = item.pos;
    speakingAgent = item.agentId || "";
    src.connect(agentAnalyser);
  } else src.connect(voiceAnalyser); // → panner HRTF à la position de l'orbe
  const at = Math.max(ctx.currentTime + 0.02, voiceClock);
  const end = at + audio.duration;
  voiceClock = end;
  liveSources.add(src);
  currentSource = src;
  src.onended = () => {
    liveSources.delete(src);
    if (currentSource === src) currentSource = null;
    if (item.pos && !liveSources.size) { speakingAgent = ""; agentPosFn = null; }
  };
  src.start(at);
  // Attente sur l'horloge du contexte (elle s'arrête si le contexte est suspendu).
  await new Promise((resolve) => {
    const tick = () => (!liveSources.has(src) || ctx.currentTime >= end - 0.01 ? resolve() : setTimeout(tick, 40));
    tick();
  });
}

function speakSystem(text) {
  // Repli : synthèse du navigateur, si le casque en propose une (non spatiale).
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANG === "fr" ? "fr-FR" : "en-US";
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  speech.gen++;
  speech.current = "";
  speech.filler = null;
  speech.queue = [];
  speech.playing = false;
  speech.done = true; // la réponse en cours ne sera plus lue
  for (const src of liveSources) { try { src.stop(); } catch {} }
  liveSources.clear();
  currentSource = null;
  voiceClock = 0;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (state.local === "speaking") { state.local = "idle"; refreshUi(); }
  syncMic();
}

function toggleVoice() {
  state.voice = !state.voice;
  lsSet("xrVoice", state.voice ? "on" : "off");
  send({ type: "xr-voice", on: state.voice });
  if (!state.voice) stopSpeaking();
  bar.invalidate();
}

const voiceData = new Uint8Array(256);
function voiceLevel() {
  if (!voiceAnalyser || !currentSource) return 0;
  voiceAnalyser.getByteTimeDomainData(voiceData);
  let sum = 0;
  for (let i = 0; i < voiceData.length; i++) { const v = (voiceData[i] - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / voiceData.length) * 5);
}

/// Ce qui reste à dire de `full`, compte tenu de ce qui a déjà été dit.
function remainder(full) {
  const done = speech.spokenText;
  if (!done) return full;
  if (full.startsWith(done)) return full.slice(done.length);
  // Le texte a été retouché (citations, mise en forme) : on se recale sur la
  // fin de ce qui a été dit.
  const tail = done.slice(-30);
  const i = full.indexOf(tail);
  return i >= 0 ? full.slice(i + tail.length) : "";
}

/// Nouveau texte de la réponse en cours : on lit les phrases TERMINÉES.
function feedStreaming(text, final) {
  if (speech.done || speech.muted || !state.voice) return;
  const full = cleanSpeech(text);
  const rest = remainder(full);
  if (!rest) { if (final) speech.done = true; return; }
  let cut = rest.length;
  if (!final) {
    // Dernière fin de phrase suivie d'un blanc : ce qui suit est encore en cours.
    cut = -1;
    const re = /[.!?…:;](?=\s)|\n/g;
    let m;
    while ((m = re.exec(rest))) cut = m.index + 1;
    if (cut < 0 || rest.slice(0, cut).trim().length < 12) return;
  }
  const piece = rest.slice(0, cut);
  speech.spokenText = (speech.spokenText + piece);
  enqueueSpeech(piece);
  if (final) speech.done = true;
}

// ---------------------------------------------------------------------------
// Transcription & réponses
// ---------------------------------------------------------------------------
function onTranscript(messages) {
  state.messages = messages.filter((m) => m && typeof m.text === "string");
  state.scroll = 0;
  chat.invalidate();
  // Première transcription (connexion, changement de conversation) : on ne
  // relit pas l'historique, seules les réponses à venir seront dites.
  // Nouveau tour (nouvelle question) : les phrases peuvent de nouveau être dites.
  const users = state.messages.filter((m) => m.sender === "user");
  const turn = `${users.length}:${users[users.length - 1]?.text || ""}`;
  if (turn !== speech.turn) { speech.turn = turn; speech.said.clear(); speech.muted = false; }
  if (!speech.primed) {
    speech.primed = true;
    speech.baseline = state.messages.length;
    speech.msgIdx = -1;
    speech.done = true;
  }
  let idx = -1;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].sender === "user") break;
    idx = i;
  }
  // Réponse orchestrée encore en cours : le texte affiché est un brouillon (il
  // peut être révisé) — on ne le lit pas ; la version finale arrive quand le
  // panneau d'étapes n'est plus « live ».
  const drafting = idx >= 0 && (state.messages[idx].blocks || []).some((b) => b.kind === "plan" && b.live);
  // Outils de la réponse en cours → icônes autour de l'orbe.
  if (idx >= 0) stepRing.fromMessage(state.messages[idx]);
  // Réponse orchestrée en cours : l'étape courante passe dans la capsule Halo.
  if (drafting) {
    const plan = state.messages[idx].blocks.find((b) => b.kind === "plan" && b.live);
    const cur = (plan.steps || []).find((x) => x.status === "running");
    if (cur) apps.activity(`${cur.label}${cur.wait ? ` — ${cur.wait}` : ""}`, 4000);
  }
  if (idx >= speech.baseline && !drafting) {
    if (idx !== speech.msgIdx) {
      speech.msgIdx = idx;
      speech.spokenText = "";
      speech.done = false;
    }
    // Réponse orchestrée terminée : le texte est définitif, on le lit en entier
    // (la réponse « answer » a pu arriver avant cette transcription).
    // Réponse orchestrée : lue UNIQUEMENT depuis la réponse finale (« answer »),
    // jamais depuis la transcription — l'ordre d'arrivée des deux messages
    // varie, et un brouillon révisé ne doit pas être lu.
    const orchestrated = (state.messages[idx].blocks || []).some((b) => b.kind === "plan");
    if (!orchestrated && speech.richTurn !== speech.turn) {
      // Un tableau (lignes à tabulations) ne se lit pas : on s'arrête avant.
      const t = state.messages[idx].text;
      const cut = t.search(/[^\n]*\t[^\n]*/);
      feedStreaming(cut > 0 ? t.slice(0, cut) : t, false);
    }
  }
  // Réponse vision en cours : on reflète le dernier message de l'assistant.
  if (visionState.pending || visionState.streaming) {
    const last = [...state.messages].reverse().find((m) => m.sender !== "user");
    if (last && last.text && visionState.after !== undefined && state.messages.length > visionState.after) {
      visionState.text = last.text;
      visionState.pending = false;
      visionState.streaming = true;
      vision.invalidate();
    }
  }
}

function onAnswer(text) {
  thoughts.settle();
  if (visionState.streaming) {
    visionState.text = text;
    visionState.streaming = false;
    vision.invalidate();
  }
  if (!text) return;
  // Réponse riche : panneau « Détail » + l'orbe ne lit que l'introduction.
  const rich = parseRich(text);
  if (rich.rich) {
    const lastUser = [...state.messages].reverse().find((m) => m.sender === "user");
    showDetail(text, lastUser?.text ? plain(lastUser.text).slice(0, 90) : "");
    text = `${rich.intro || ""} ${detailSay()}`.trim();
    speech.richTurn = speech.turn;
  }
  const lastIdx = (() => { for (let i = state.messages.length - 1; i >= 0; i--) if (state.messages[i].sender !== "user") return i; return -1; })();
  const orchestrated = lastIdx >= 0 && (state.messages[lastIdx].blocks || []).some((b) => b.kind === "plan");
  if (speech.muted) return;
  if ((orchestrated || rich.rich) && state.voice && speech.answeredTurn !== speech.turn) {
    // Lecture complète de la version finale (ou de l'introduction si riche).
    speech.answeredTurn = speech.turn;
    if (!rich.rich || orchestrated) { speech.msgIdx = lastIdx; speech.spokenText = ""; }
    speech.done = false;
    feedStreaming(text, true);
    return;
  }
  if (speech.msgIdx >= 0 && !speech.done) feedStreaming(text, true);
  else if (speech.msgIdx < 0 && speech.primed && !speech.playing) {
    // Réponse sans transcription observée (rare) : lue en entier.
    speech.spokenText = "";
    speech.done = false;
    feedStreaming(text, true);
  }
}

// ---------------------------------------------------------------------------
// Micro : un seul flux, plusieurs usages
// ---------------------------------------------------------------------------
//   • « Parler » (ptt)      : enregistre jusqu'au silence ; l'audio part PAR
//                             MORCEAUX pendant qu'on parle (sous-titres en
//                             direct), la fin seule déclenche la réponse ;
//   • mains libres (wake)   : chaque prise de parole est d'abord comparée, DANS
//                             le casque, au « Lumen » calibré (xr-wake.js) ;
//                             rien ne part tant qu'il n'est pas reconnu. Sans
//                             calibrage : repli sur Whisper ;
//   • interruption (barge)  : pendant que Lumen parle, une voix soutenue le
//                             coupe et démarre l'écoute (avec la demi-seconde
//                             déjà entendue, pour ne pas perdre le début) ;
//   • calibrage (enroll) et dictée d'un champ (dictate).
// Le flux n'est ouvert QUE si l'un de ces usages le demande — et le voyant de
// confidentialité le montre.
let micLevel = 0;
let sttSeq = 0;
const sttPurpose = new Map(); // id → "ptt" | "wake" | "dictate"
const sttHandlers = new Map(); // id → rappel (dictée d'un champ)
const mic = { stream: null, ctx: null, node: null, opening: null, ring: [], capture: null, voiced: 0, barge: 0 };
const CHUNK_MS = 128; // 2048 échantillons à 16 kHz
const PART_CHUNKS = 4; // un envoi partiel toutes les ~0,5 s
const wake = new WakeWord();
const enroll = { active: false, count: 0 };
let pendingDictation = null; // rappel de la prochaine prise de parole

function micWanted() {
  if (enroll.active || state.local === "listening") return true;
  if (!state.connected) return false;
  return settings.handsFree || (settings.bargeIn && (speech.playing || lumenBusy()));
}

/// Lumen travaille sur une réponse (le bureau réfléchit, ou une réponse
/// orchestrée est en cours) : on écoute pour pouvoir l'arrêter à la voix.
function lumenBusy() {
  if (state.desktop === "thinking") return true;
  const last = state.messages[state.messages.length - 1];
  return !!(last && last.sender !== "user" && (last.blocks || []).some((b) => b.kind === "plan" && b.live));
}

async function openMic() {
  if (mic.stream) return true;
  if (mic.opening) return mic.opening;
  mic.opening = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // 16 kHz directement : c'est ce qu'attend Whisper, le navigateur rééchantillonne.
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => onMicChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(node);
      node.connect(ctx.destination); // nécessaire pour que le processeur tourne
      Object.assign(mic, { stream, ctx, node, ring: [], voiced: 0, barge: 0 });
      state.micActive = true;
      setPrivacy();
      return true;
    } catch {
      toast(T("Micro refusé", "Microphone denied"));
      return false;
    } finally {
      mic.opening = null;
    }
  })();
  return mic.opening;
}

function closeMic() {
  if (!mic.stream) return;
  mic.node.onaudioprocess = null;
  try { mic.node.disconnect(); } catch {}
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.ctx.close();
  Object.assign(mic, { stream: null, ctx: null, node: null, ring: [], capture: null });
  micLevel = 0;
  state.micActive = false;
  setPrivacy();
}

/// Ouvre ou ferme le micro selon les usages en cours.
function syncMic() {
  if (micWanted()) openMic();
  else if (!mic.capture) closeMic();
}

function onMicChunk(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / data.length);
  micLevel = Math.min(1, rms * 9);
  const now = performance.now();
  mic.ring.push(data);
  if (mic.ring.length > 5) mic.ring.shift(); // ~0,6 s de pré-écoute

  // Plancher de bruit adaptatif (télé, ventilation, écho résiduel) : il suit
  // vite les baisses et lentement les hausses. Le seuil de voix est relatif à
  // ce plancher — avec un seuil FIXE (0,02), une pièce bruyante n'atteignait
  // jamais le « silence » : 25 s d'enregistrement, bruit compris, et Whisper
  // rendait de longues phrases fausses (puis des réponses à côté).
  mic.floor = mic.floor == null ? rms : rms < mic.floor ? mic.floor * 0.8 + rms * 0.2 : mic.floor * 0.998 + rms * 0.002;
  const voiceTh = Math.max(0.02, mic.floor * 3);
  const cap = mic.capture;
  if (cap) {
    cap.chunks.push(data);
    if (rms > voiceTh) { cap.started = true; cap.lastVoice = now; cap.lastVoiceChunk = cap.chunks.length; }
    // Envoi en continu (écoute « Parler » uniquement) : le bureau transcrit
    // au fil de l'eau, le casque affiche le sous-titre.
    // (Whisper du casque : pas de partiels, la phrase est transcrite d'un bloc.)
    // Transcription BASIQUE (demande explicite) : plus de partiels en direct —
    // tout l'audio part d'un bloc à la fin, transcrit une seule fois.
    if (XR_LIVE_PARTIALS && cap.streamId && !cap.headset && !localSttActive() && cap.started && cap.chunks.length - cap.sent >= PART_CHUNKS) {
      send({ type: "xr-audio-part", model: settings.whisperModel, id: cap.streamId, pcm16: pcm16b64(cap.chunks.slice(cap.sent)) });
      cap.sent = cap.chunks.length;
    }
    const short = cap.purpose === "wake" || cap.purpose === "enroll";
    const silence = cap.purpose === "enroll" ? 500 : cap.purpose === "wake" ? 800 : 1300;
    const max = cap.purpose === "enroll" ? 2500 : cap.purpose === "wake" ? 9000 : 15000;
    if ((cap.started && now - cap.lastVoice > silence) || now - cap.t0 > max) finishCapture(true);
    else if (!cap.started && now - cap.t0 > (short ? 1500 : 8000)) finishCapture(false);
    return;
  }
  // Interruption : la voix de l'utilisateur doit dominer celle de Lumen (que
  // l'annulation d'écho atténue déjà) pendant ~0,4 s.
  if (settings.bargeIn && (speech.playing || lumenBusy())) {
    // Pendant la lecture, la voix de l'utilisateur doit dominer celle de
    // Lumen ; pendant la réflexion (silence), un seuil de parole normal suffit.
    const th = speech.playing ? 0.045 + voiceLevel() * 0.05 : 0.03;
    mic.barge = rms > th ? mic.barge + 1 : 0;
    if (mic.barge >= 3) {
      mic.barge = 0;
      stopSpeaking();
      earcon(true);
      startCapture("ptt", true);
    }
    return;
  }
  // Calibrage : on attend que l'utilisateur dise « Lumen ».
  if (enroll.active) {
    mic.voiced = rms > 0.02 ? mic.voiced + 1 : 0;
    if (mic.voiced >= 1) { mic.voiced = 0; startCapture("enroll", true); }
    return;
  }
  // Mains libres : une prise de parole commence.
  if (settings.handsFree && state.local === "idle" && effectiveState() === "idle") {
    mic.voiced = rms > Math.max(0.025, voiceTh * 1.2) ? mic.voiced + 1 : 0;
    if (mic.voiced >= 2) { mic.voiced = 0; startCapture("wake", true); }
  }
}

// ---- Whisper DANS le casque (xr-whisper.js) ----------------------------------
// La voix ne part plus au Mac : il garde toute sa mémoire pour le LLM. Échec
// (premier téléchargement impossible, worker refusé) → repli sur le Mac avec
// le même audio.
const localStt = { loading: null, failed: false, failures: 0 };
function localSttActive() { return settings.stt === "local" && headsetWhisperSupported() && localStt.failures < 3; }
function cycleStt() {
  const order = ["whisper", "local", ...(headsetStt.supported ? ["headset"] : [])];
  setChoice("stt", order[(order.indexOf(settings.stt) + 1) % order.length]);
  if (settings.stt === "local") preloadLocalStt();
  settingsPanel.invalidate();
}
function preloadLocalStt() {
  if (!headsetWhisperSupported()) { localStt.failed = true; return; }
  localStt.loading = 0;
  localStt.failed = false;
  settingsPanel.invalidate();
  preloadHeadsetWhisper(settings.localModel, (pct) => { localStt.loading = pct; settingsPanel.invalidate(); })
    .then(() => { localStt.loading = null; localStt.failures = 0; settingsPanel.invalidate(); toast(T("Whisper prêt dans le casque", "Whisper ready on the headset")); })
    .catch(() => { localStt.loading = null; localStt.failed = true; settingsPanel.invalidate(); toast(T("Whisper du casque indisponible (réseau ?) — le Mac transcrit", "Headset Whisper unavailable (network?) — the Mac transcribes"), 4000); });
}
/**
 * Envoie un audio à transcrire : au Whisper du casque si choisi, sinon (ou en
 * cas d'échec) au Mac. `chunks` = PCM 16 kHz de ce message.
 */
function sendAudio(msg, chunks) {
  if (msg.type !== "xr-audio" || !localSttActive()) { send(msg); return; }
  transcribeInHeadset(concat(chunks), { modelId: settings.localModel, lang: LANG })
    .then((text) => { localStt.failures = 0; onStt({ id: msg.id, text }); })
    .catch(() => {
      localStt.failures++;
      if (localStt.failures >= 3) { localStt.failed = true; settingsPanel.invalidate(); }
      send(msg);
    });
}

// ---- Reconnaissance vocale du casque (Web Speech API du navigateur) --------
// Option des Réglages. Le micro du casque continue d'enregistrer en parallèle :
// si le navigateur échoue (pas de réseau, refus), l'enregistrement part à
// Whisper comme avant — l'utilisateur n'a jamais à répéter.
const HeadsetSR = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const headsetStt = { supported: !!HeadsetSR };
function headsetSttActive() { return settings.stt === "headset" && headsetStt.supported; }
function startHeadsetRecognition(cap) {
  let rec;
  try { rec = new HeadsetSR(); } catch { cap.headset = null; return; }
  rec.lang = LANG === "en" ? "en-US" : "fr-FR";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    state.partial = (finalText + interim).trim();
    caption.invalidate();
  };
  rec.onerror = () => { cap.headsetFailed = true; };
  rec.onend = () => {
    const text = finalText.trim();
    if (cap.headsetDone) return;
    cap.headsetDone = true;
    if (text) { onStt({ id: cap.streamId, text }); return; }
    // Échec ou rien compris : repli sur Whisper avec l'audio déjà enregistré.
    if (cap.chunks.length && cap.started) {
      sendAudio({ type: "xr-audio", model: settings.whisperModel, id: cap.streamId, pcm16: pcm16b64(cap.chunks) }, cap.chunks);
      state.local = "transcribing";
      refreshUi();
    } else onStt({ id: cap.streamId, text: "" });
  };
  cap.headset = rec;
  try { rec.start(); } catch { cap.headset = null; }
}

function startCapture(purpose, withPreroll) {
  mic.capture = {
    purpose, chunks: withPreroll ? mic.ring.slice() : [], started: withPreroll, sent: 0,
    lastVoice: performance.now(), t0: performance.now(),
    streamId: purpose === "ptt" || purpose === "dictate" ? ++sttSeq : 0,
  };
  if (mic.capture.streamId && headsetSttActive()) startHeadsetRecognition(mic.capture);
  if (mic.capture.streamId) {
    sttPurpose.set(mic.capture.streamId, purpose);
    if (purpose === "dictate" && pendingDictation) { sttHandlers.set(mic.capture.streamId, pendingDictation); pendingDictation = null; }
    state.partial = "";
    state.partialId = mic.capture.streamId;
    state.local = "listening";
    refreshUi();
  }
}

/// PCM float → int16 → Base64 (32 ko/s : raisonnable sur le Wi-Fi local).
function pcm16b64(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total * 2);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      const v = s < 0 ? s * 0x8000 : s * 0x7fff;
      bytes[o++] = v & 0xff;
      bytes[o++] = (v >> 8) & 0xff;
    }
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function concat(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function finishCapture(submit) {
  const cap = mic.capture;
  if (!cap) return;
  mic.capture = null;
  const tooShort = cap.chunks.length * CHUNK_MS < (cap.purpose === "wake" ? 450 : 250);
  if (!submit || !cap.started || tooShort) {
    if (cap.headset) { cap.headsetDone = true; try { cap.headset.abort(); } catch {} }
    if (cap.streamId) {
      send({ type: "xr-audio-cancel", id: cap.streamId }); // libère le tampon du bureau
      sttPurpose.delete(cap.streamId);
      sttHandlers.delete(cap.streamId);
      state.local = "idle";
      state.partial = "";
      refreshUi();
      if (submit) toast(T("Je n'ai rien entendu", "I didn't hear anything"));
    }
    if (cap.purpose === "enroll" && submit) toast(T("Trop court — redites « Lumen »", "Too short — say “Lumen” again"));
    syncMic();
    return;
  }
  if (cap.purpose === "enroll") { onEnrollSample(concat(cap.chunks)); syncMic(); return; }
  if (cap.headset) {
    // La reconnaissance du casque rend le texte dans `onend` (repli Whisper inclus).
    state.local = "transcribing";
    refreshUi();
    try { cap.headset.stop(); } catch { cap.headset.onend?.(); }
    syncMic();
    return;
  }
  if (cap.purpose === "wake" && wake.ready) {
    // Mot d'éveil LOCAL : rien ne sort du casque tant que « Lumen » n'est pas
    // reconnu ; ensuite, seule la phrase qui suit part à Whisper.
    const pcm = concat(cap.chunks);
    const r = wake.detect(pcm);
    if (!r.match) { syncMic(); return; }
    earcon(true);
    const rest = pcm.subarray(Math.min(pcm.length, r.endSample));
    if (rest.length < 16000 * 0.4) { stopSpeaking(); startCapture("ptt", false); return; } // « Lumen » seul : on écoute
    const id = ++sttSeq;
    sttPurpose.set(id, "ptt");
    sendAudio({ type: "xr-audio", model: settings.whisperModel, id, pcm16: pcm16b64([rest]) }, [rest]);
    syncMic();
    return;
  }
  if (cap.streamId) {
    // Fin d'une écoute en continu : seul le reste non envoyé part.
    // Whisper du casque : aucun partiel envoyé, `cap.sent` vaut 0 → tout l'audio.
    sendAudio({ type: "xr-audio", model: settings.whisperModel, id: cap.streamId, stream: true, pcm16: pcm16b64(cap.chunks.slice(cap.sent)) }, cap.chunks.slice(cap.sent));
    state.local = "transcribing";
    refreshUi();
  } else {
    const id = ++sttSeq;
    sttPurpose.set(id, cap.purpose);
    sendAudio({ type: "xr-audio", model: settings.whisperModel, id, pcm16: pcm16b64(cap.chunks) }, cap.chunks);
  }
  syncMic();
}

async function toggleTalk() {
  if (state.local === "listening") { finishCapture(true); return; }
  if (!state.connected) { toast(T("Pas connecté à Lumen", "Not connected to Lumen")); return; }
  stopSpeaking(); // on coupe la parole de Lumen : l'utilisateur reprend la main
  if (!(await openMic())) return;
  startCapture("ptt", false);
}

/// Dicte un champ (post-it, nom d'objet, clavier) : la prochaine phrase
/// transcrite va au rappel au lieu de partir dans la conversation.
async function dictate(prompt, cb, { field = false } = {}) {
  if(field && typeof cb === "function") cb.speechField=true;
  if (!state.connected) { toast(T("Pas connecté à Lumen", "Not connected to Lumen")); return; }
  stopSpeaking();
  if (!(await openMic())) return;
  pendingDictation = cb;
  toast(prompt, 3000);
  startCapture("dictate", false);
}

// ---- Calibrage du mot d'éveil ------------------------------------------------
async function startEnroll() {
  wake.clear();
  enroll.active = true;
  enroll.count = 0;
  if (!(await openMic())) { enroll.active = false; return; }
  toast(T("Dites « Lumen » (1/3)", "Say “Lumen” (1/3)"), 6000);
  settingsPanel.invalidate();
}
function onEnrollSample(pcm) {
  const n = wake.addSample(pcm);
  if (n === enroll.count) { toast(T("Pas compris — redites « Lumen »", "Didn't get it — say “Lumen” again"), 4000); return; }
  enroll.count = n;
  earcon(true);
  if (n >= 3) {
    enroll.active = false;
    toast(T("Mot d'éveil enregistré — il est reconnu dans le casque", "Wake word saved — recognised on the headset"), 4000);
    syncMic();
  } else toast(T(`Encore une fois (${n + 1}/3)`, `Once more (${n + 1}/3)`), 6000);
  settingsPanel.invalidate();
}

// « Regarde… », « Lumen, regarde ça », « look at this »…
const LOOK_RE = /^\s*(?:lumen[\s,.!]*)?(?:regarde[sz]?|look(?:\s+at)?)\b[\s,.:!]*/i;
// Mot d'éveil tel que Whisper l'écrit : « Lumen », « Lumène », « Hey Lumen »…
const WAKE_RE = /^\W*(?:(?:hey|hé|eh|ok|okay|dis|salut|bonjour|allô|allo)\W+)?l[uy]m[eèéi]n+e?\b[\s,.!?:;-]*/i;

function onSttPartial(msg) {
  if (msg.id !== state.partialId || state.local !== "listening") return;
  state.partial = msg.text || "";
  caption.invalidate();
}

function onStt(msg) {
  // Pas de relecture par le LLM : le texte de Whisper est utilisé tel quel.
  if (!msg.checked && !msg.error && msg.text?.trim()) msg.checked = true;
  if (!msg.checked && !msg.error && msg.text?.trim()) {
    send({ type: "xr-stt-check", id: msg.id, text: msg.text });
    return;
  }
  const purpose = sttPurpose.get(msg.id) || "ptt";
  sttPurpose.delete(msg.id);
  const handler = sttHandlers.get(msg.id);
  sttHandlers.delete(msg.id);
  if ((purpose === "ptt" || purpose === "dictate") && state.local === "transcribing") { state.local = "idle"; refreshUi(); }
  state.partial = "";
  caption.invalidate();
  const text = (msg.text || "").trim();
  if (msg.unclear) { toast(T("Phrase ambiguë : pouvez-vous la répéter ?", "Unclear phrase: please repeat it."), 4000); return; }
  if (purpose === "wake") {
    // Repli sans calibrage : c'est Whisper qui repère « Lumen ».
    if (!text || !WAKE_RE.test(text)) return; // pas pour Lumen : ignoré
    const rest = text.replace(WAKE_RE, "").trim();
    if (rest.length > 2) { earcon(true); if(sensitiveSpeech(rest))reviewSpeech(rest,t=>handleUtterance(t));else handleUtterance(rest); }
    else { earcon(true); stopSpeaking(); startCapture("ptt", false); }
    return;
  }
  if (msg.original) toast(T(`Compris : ${text}`, `Understood: ${text}`), 3500);
  if(text && !handler?.speechField && sensitiveSpeech(text)) {reviewSpeech(text,handler || (t=>handleUtterance(t.replace(WAKE_RE,"") || t)));return;}
  if (handler) { handler(text); return; }
  if (msg.error) { toast(T("Transcription impossible", "Transcription failed")); return; }
  if (!text) { toast(T("Je n'ai rien compris", "I didn't catch that")); return; }
  handleUtterance(text.replace(WAKE_RE, "") || text);
}

/// « Stop », « attends », « tais-toi »… : arrête la lecture ET la génération.
const STOP_RE = /^\s*(lumen[, ]*)?((stop+|stoppe|arr[eê]te(-toi| tout| de parler)?|attends?|attendez|tais[- ]toi|silence|chut|pause|annule|laisse tomber|c.est bon|ça suffit|ca suffit|stop it|wait|hold on|cancel|shut up|be quiet|never mind|enough)\b[\s.!,]*)+(lumen)?[\s.!]*$/i;
function interruptLumen() {
  stopSpeaking();
  speech.muted = true; // plus rien n'est lu pour ce tour (annonces, réponse)
  send({ type: "stop-generation" });
  toast(T("Arrêté", "Stopped"));
  earcon(false);
  syncMic();
}

function handleUtterance(text) {
  // Rituel du matin : « Lumen, bonjour », « passe », « arrête le rituel »…
  if (morning.handleUtterance(text)) return;
  // « range Max », « appelle Léa », « fais venir l'agent Max », « put away Max ».
  const agCmd = /^\s*(?:lumen[, ]*)?(range|cache|appelle|fais venir|put away|hide|call|summon)\s+(?:l'agent\s+|agent\s+)?(.+?)[\s.!]*$/i.exec(text);
  if (agCmd) {
    const name = agCmd[2].toLowerCase();
    const a = (apps.team?.() || []).find((x) => String(x.name || "").toLowerCase() === name || String(x.name || "").toLowerCase().startsWith(name));
    if (a) {
      if (/range|cache|put away|hide/i.test(agCmd[1])) props.dismissAgent(a.id); else props.summonAgent(a.id);
      return;
    }
  }
  // « agents plus grands / plus petits », « agrandis les agents », « bigger agents »…
  const sizeCmd = /^\s*(?:lumen[, ]*)?(?:(?:les |mes )?agents? (?:plus )?(grands?|gros|petits?)|(agrandi[st]?|rapetisse|réduis|reduis) (?:les |mes )?agents?|(bigger|larger|smaller) agents?|make (?:the )?agents? (bigger|larger|smaller))\b/i.exec(text);
  if (sizeCmd) {
    const up = /grand|gros|agrandi|bigger|larger/i.test(sizeCmd[0]);
    setAgentScale(settings.agentScale * (up ? 1.4 : 1 / 1.4));
    toast(T(`Agents × ${settings.agentScale.toFixed(1)}`, `Agents × ${settings.agentScale.toFixed(1)}`));
    return;
  }
  // 0) « Stop » / « attends » : on interrompt, rien ne part comme question.
  if (STOP_RE.test(text)) { interruptLumen(); return; }
  // 0 bis) Une demande de Lumen attend : la phrase y répond si elle le peut.
  const answer = matchSpokenAnswer(text);
  if (answer) { answerUserRequest(answer); return; }
  // 0 ter) « Approuve » / « refuse » : la demande d'approbation d'un agent.
  if (!request.current && apps.approvalUtterance?.(text)) return;
  // Demande en cours sans réponse reconnue : Lumen attend, la phrase ne part
  // pas comme nouvelle question (elle serait ignorée ou mal comprise).
  if (request.current) {
    if (request.current.kind === "unlock" && request.current.busy) return;
    const hint = request.current.kind === "unlock"
      ? (request.current.unlockMode === "tap" && !request.current.needCode
        ? T("Dis « déverrouille » ou touche le bouton.", "Say “unlock” or tap the button.")
        : T("Dis le code à 6 chiffres de ton application d'authentification.", "Say the 6-digit code from your authenticator app."))
      : request.current.options.length
      ? T("Réponds à la demande : « oui », « toujours » ou « non ».", "Answer the request: “yes”, “always” or “no”.")
      : T("Déverrouille ta session sur l'ordinateur.", "Unlock your session on the computer.");
    toast(hint, 3500);
    enqueueSpeech(hint, { dedupe: false });
    return;
  }
  // 0 quater) Mode focus, et « demande à Veilleur de… » (agent nommé).
  if (FOCUS_ON_RE.test(text)) { setFocus(true); return; }
  if (FOCUS_OFF_RE.test(text)) { setFocus(false); return; }
  // Orbe vivante, bureau physique, ambiances.
  if (FOLLOW_RE.test(text)) { setFollow(true); enqueueSpeech(T("Je te suis.", "Right behind you."), { dedupe: false }); return; }
  if (STAY_RE.test(text) && orbFollow) { setFollow(false); enqueueSpeech(T("Je reste là.", "Staying here."), { dedupe: false }); return; }
  if (DESK_ON_RE.test(text)) { props.show(true); return; }
  if (DESK_OFF_RE.test(text)) { props.show(false); enqueueSpeech(T("C'est rangé.", "All tidied up."), { dedupe: false }); return; }
  if (AMBIENCE_RE.test(text)) {
    const named = /oc[ée]an|mer|ocean/i.test(text) ? 2 : /aube|dawn/i.test(text) ? 1 : /nuit|[ée]toil|night/i.test(text) ? 0 : -1;
    const i = named >= 0 ? named : (settings.focusEnv + 1) % ENVIRONMENTS.length;
    settings.focusEnv = i; lsSet("xrFocusEnv", String(i));
    if (!focusMode.on) setFocus(true); else env.show(i);
    enqueueSpeech(T(ENVIRONMENTS[i].fr + ".", ENVIRONMENTS[i].en + "."), { dedupe: false });
    return;
  }
  // « Traduis ça » / « lis ça » : le texte regardé, traduit ou recopié, posé dessus.
  const tr = text.match(TRANSLATE_RE);
  if (tr) { readAndTranslate(text, tr); return; }
  if (apps.delegateUtterance?.(text)) return;
  // 1) Actions locales immédiates (minuteur, objets, domotique, clavier…).
  if (space.handleUtterance(text) || extras.handleUtterance(text)) return;
  // 2) « Regarde… » : une image part avec la question.
  if (LOOK_RE.test(text)) {
    const rest = text.replace(LOOK_RE, "").trim();
    lookAndAsk(rest.length > 3 ? text : "");
    return;
  }
  // 3) Moteur de décision (Tev1, ~0,1 s) : une action du casque formulée
  // autrement (« montre-moi mes agents »), ou une question pour Lumen ?
  decideXrIntent(text).then((d) => {
    // « look » prend une PHOTO : jamais sur la seule foi du moteur (seuil 0,4
    // sur 8 choix → une question sur deux partait avec une image). Il faut
    // une confiance haute ET une désignation explicite de ce qu'on voit.
    let intent = d?.intent || null;
    if (intent === "look" && !((d.confidence ?? 0) >= 0.75 && VISUAL_CUE_RE.test(text))) intent = null;
    if (runXrIntent(intent, text)) return;
    // 4) Le reste va à Lumen ; un petit « Hmm » comble l'attente.
    state.route = null;
    state.turnVoice = "";
    send({ type: "chat", text, voice: true });
    setTimeout(() => playFiller("think"), 150);
  });
}

let xrDecideSeq = 0;
const xrDecideWaiting = new Map();
/// Intention du casque décidée par le bureau, ou null (moteur absent, lent,
/// indécis) : passé 1,2 s, la phrase part simplement à Lumen.
function decideXrIntent(text) {
  if (!state.connected) return Promise.resolve(null);
  const id = ++xrDecideSeq;
  return new Promise((resolve) => {
    xrDecideWaiting.set(id, resolve);
    send({ type: "xr-decide", id, text });
    setTimeout(() => { if (xrDecideWaiting.delete(id)) resolve(null); }, 1200);
  });
}
function onXrDecision(msg) {
  const resolve = xrDecideWaiting.get(msg.id);
  if (!resolve) return;
  xrDecideWaiting.delete(msg.id);
  resolve(msg.intent ? { intent: msg.intent, confidence: msg.confidence } : null);
}
// Désignation explicite d'un objet réel (« ça », « ce que je tiens »…).
const VISUAL_CUE_RE = /(?:^|[\s'’,.!?])(ça|ceci|cela|celui-ci|celle-ci|devant moi|je tiens|je vois|je regarde|dans ma main|this|that|these|those|in front of me|i'?m holding|i see|i'?m looking at|in my hand)(?=$|[\s'’,.!?])/iu;
/// Exécute une intention du casque. Vrai si la phrase a été traitée.
function runXrIntent(intent, text) {
  const open = (p, refresh) => { if (!p) return false; if (!p.visible) openNear(p); refresh?.(); onPanelsChanged(); return true; };
  switch (intent) {
    case "look": lookAndAsk(text); return true;
    case "open_agents": return open(apps.panels.agents, apps.refreshTeam);
    case "open_notifications": return open(apps.panels.notifs);
    case "open_documents": return open(apps.panels.docs, () => send({ type: "xr-docs-list" }));
    case "open_settings": return open(settingsPanel);
    case "focus": setFocus(true); return true;
    case "unfocus": setFocus(false); return true;
    default: return false;
  }
}

// ---- Premier son immédiat -----------------------------------------------------
// Quelques mots de Lumen, synthétisés UNE fois (même voix que les réponses) et
// gardés en mémoire : joués dès que la question part, ils comblent la latence
// du modèle. Le vrai début de réponse attend qu'ils soient finis.
const fillers = { think: [], look: [], loading: false };
async function loadFillers() {
  if (fillers.loading || fillers.think.length) return;
  fillers.loading = true;
  const ctx = ensureAudio();
  const sets = {
    think: T(["Hmm…", "Voyons voir.", "Bonne question.", "Je réfléchis."], ["Hmm…", "Let me see.", "Good question.", "Let me think."]),
    look: T(["Je regarde.", "Voyons ça."], ["Let me look.", "Let's see."]),
  };
  for (const [kind, texts] of Object.entries(sets)) {
    for (const text of texts) {
      const b64 = await requestTts(text);
      if (!b64) continue;
      try { fillers[kind].push(await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer)); } catch {}
    }
  }
  fillers.loading = false;
}
function playFiller(kind) {
  const list = fillers[kind];
  if (!state.voice || !list.length || speech.playing || currentSource) return;
  const buf = list[Math.floor(Math.random() * list.length)];
  speech.filler = playBuffer(ensureAudio(), buf);
}

// ---------------------------------------------------------------------------
// « Regarde » : une image, à la demande, vers le modèle vision
// ---------------------------------------------------------------------------
async function captureFrame() {
  // Sur le Quest, la caméra passthrough est exposée comme une caméra « arrière »
  // (permission HEADSET_CAMERA). Le flux est coupé aussitôt l'image prise :
  // aucune image ne sort tant que l'utilisateur ne l'a pas demandé.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
  });
  state.camActive = true;
  setPrivacy();
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 350)); // exposition
    const max = 1024;
    const s = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(video.videoWidth * s);
    c.height = Math.round(video.videoHeight * s);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    state.camActive = false;
    setPrivacy();
  }
}

// ---------------------------------------------------------------------------
// « Regarde en continu » : toutes les 10 s, une image part vers le modèle
// vision du bureau (hors conversation) qui renvoie les objets repérés ; le
// casque pose une étiquette dans la direction de chacun. Le témoin caméra
// s'allume à chaque prise, et le mode se coupe en quittant l'XR.
// ---------------------------------------------------------------------------
// Champ de vision approximatif de la caméra passthrough du Quest (4:3).
const CAM_HFOV = THREE.MathUtils.degToRad(80), CAM_VFOV = THREE.MathUtils.degToRad(64);

function makeLabelSprite(text) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = `600 44px ${THEME.font}`;
  const w = Math.ceil(ctx.measureText(text).width) + 60;
  c.width = w; c.height = 84;
  ctx.font = `600 44px ${THEME.font}`;
  roundRect(ctx, 0, 0, w, 84, 42);
  ctx.fillStyle = "rgba(20,20,28,0.82)"; ctx.fill();
  ctx.fillStyle = "#46d6a0"; ctx.beginPath(); ctx.arc(30, 42, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#f4f5f8"; ctx.textBaseline = "middle"; ctx.fillText(text, 48, 44);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const h = 0.05;
  sprite.scale.set(h * (w / 84), h, 1);
  sprite.renderOrder = 5;
  return sprite;
}

function clearLiveLabels() {
  for (const s of [...liveVision.group.children]) { s.material.map?.dispose(); s.material.dispose(); liveVision.group.remove(s); }
}

async function liveVisionTick() {
  if (!liveVision.on || !state.connected || liveVision.pending || !renderer.xr.isPresenting) return;
  const pose = headPose();
  let canvas;
  try { canvas = await captureFrame(); } catch { setLiveVision(false); toast(T("Caméra indisponible", "Camera unavailable")); return; }
  const id = `lv${++liveVision.seq}`;
  liveVision.pending = { id, pose };
  send({ type: "xr-vision", id, image: canvas.toDataURL("image/jpeg", 0.75) });
  setTimeout(() => { if (liveVision.pending?.id === id) liveVision.pending = null; }, 30000);
}

function onLiveLabels(msg) {
  const p = liveVision.pending;
  if (!p || p.id !== msg.id) return;
  liveVision.pending = null;
  if (msg.error === "no-vision") { setLiveVision(false); toast(T("Le modèle actif ne lit pas les images", "The active model can't read images"), 3500); return; }
  clearLiveLabels();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(p.pose.quat);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(p.pose.quat);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(p.pose.quat);
  for (const it of msg.items || []) {
    const dir = fwd.clone()
      .addScaledVector(right, Math.tan((it.x - 0.5) * CAM_HFOV))
      .addScaledVector(up, -Math.tan((it.y - 0.5) * CAM_VFOV))
      .normalize();
    // Posée sur le mur visé s'il est connu, sinon à 1,5 m.
    const wall = spatial.raycastWall(p.pose.pos, dir, 5);
    const at = wall ? wall.point.clone().addScaledVector(dir, -0.05) : p.pose.pos.clone().addScaledVector(dir, 1.5);
    const sprite = makeLabelSprite(it.label);
    sprite.position.copy(at);
    liveVision.group.add(sprite);
  }
  liveVision.shownAt = Date.now();
}

function setLiveVision(on) {
  liveVision.on = on;
  clearInterval(liveVision.timer);
  liveVision.timer = null;
  if (on) {
    liveVision.timer = setInterval(liveVisionTick, 10000);
    liveVisionTick();
    toast(T("Regarde en continu : activé", "Continuous look: on"));
  } else {
    liveVision.pending = null;
    clearLiveLabels();
  }
  settingsPanel.invalidate();
}

// « Traduis ça », « lis-moi ce panneau », « traduis ce menu en anglais », « translate this ».
const TRANSLATE_RE = /^\s*(?:lumen[, ]*)?(traduis|traduire|translate|lis|read)(?:[- ]moi)?\s+(?:ça|ca|ceci|cela|(?:ce|cette)\s+(?!mail|message|courriel|document|fichier|note|pdf|conversation)\S+|this|that|it)\b/i;

const translateState = { loading: null };
/// Réglages du rituel du matin (morning.json du bureau), relus à la connexion.
const morningCfg = { city: "", topics: [] };
const translateWaiting = new Map();
let translateSeq = 0;
const LANG_CODES = { anglais: "en", english: "en", français: "fr", francais: "fr", french: "fr", espagnol: "es", spanish: "es", allemand: "de", german: "de", italien: "it", italian: "it" };
const LANG_LABEL = { fr: "français", en: "anglais", es: "espagnol", de: "allemand", it: "italien" };
/// « Lis ça » / « traduis ça » : photo, lecture OCR DANS le casque, puis
/// traduction par de petits modèles (casque) ou par le modèle déjà chargé du
/// Mac. Jamais de modèle de vision : rien de lourd ne se charge.
async function readAndTranslate(text, m) {
  const read = /^(lis|read)$/i.test(m[1]);
  if (!read && settings.translate === "off") {
    const msg = T("La traduction est désactivée : active-la dans les Réglages. Je peux te lire le texte : dis « lis ça ».", "Translation is off: turn it on in Settings. I can read the text: say “read this”.");
    toast(msg, 4500); enqueueSpeech(msg, { dedupe: false });
    return;
  }
  const asked = (text.match(/\b(?:en|in|into)\s+(anglais|english|espagnol|spanish|allemand|german|italien|italian|français|francais|french)\b/i) || [])[1];
  const to = asked ? LANG_CODES[asked.toLowerCase()] : (LANG === "en" ? "en" : "fr");
  const target = spatial.lastHit ? spatial.lastHit.clone() : null;
  let canvas;
  try { canvas = await captureFrame(); } catch {
    toast(T("Caméra indisponible (autorisez l'accès caméra du casque)", "Camera unavailable (allow headset camera access)"), 4000);
    return;
  }
  visionState.image = null; visionState.text = ""; visionState.pending = true; visionState.streaming = false;
  visionState.mode = "translate"; visionState.status = T("Lecture du texte…", "Reading the text…"); visionState.target = target;
  vision.title = read ? T("Texte lu", "Text") : T("Traduction", "Translation");
  spatial.release(vision.key);
  if (target) placeOn(vision, target); else placeInGaze(vision);
  vision.open(); vision.invalidate();
  const status = (s) => { visionState.status = s; vision.invalidate(); };
  let out = "";
  try {
    const seen = await readText(canvas, (st, p) => status(T(`Lecture du texte… ${Math.round(p * 100)} %`, `Reading… ${Math.round(p * 100)}%`)));
    if (!seen) out = T("Je ne vois pas de texte lisible. Rapproche-toi un peu.", "I can't see readable text. Get a bit closer.");
    else if (read) out = seen;
    else if (detectLang(seen) === to) out = seen;
    else {
      const headsetOk = settings.translate === "headset" && chainFor(detectLang(seen), to) !== null;
      if (headsetOk) {
        status(T("Traduction…", "Translating…"));
        out = await translateInHeadset(seen, to, (pct) => status(T(`Téléchargement du modèle de traduction… ${pct} %`, `Downloading the translation model… ${pct}%`)));
      } else if (state.connected) {
        status(T("Traduction sur le Mac…", "Translating on the Mac…"));
        const id = ++translateSeq;
        send({ type: "xr-translate-text", id, text: seen, target: LANG_LABEL[to] || "français" });
        out = await new Promise((resolve) => { translateWaiting.set(id, resolve); setTimeout(() => { if (translateWaiting.delete(id)) resolve(""); }, 30000); });
        if (!out) out = T(`Traduction impossible. Texte lu :\n${seen}`, `Translation failed. Text read:\n${seen}`);
      } else out = seen;
    }
  } catch {
    out = T("Lecture impossible (les petits modèles n'ont pas pu se charger).", "Couldn't read (the small models failed to load).");
  }
  visionState.pending = false; visionState.text = out; visionState.status = "";
  vision.invalidate();
  // Court : Lumen le lit aussi à voix haute.
  if (out.length <= 280) enqueueSpeech(out, { dedupe: false });
}

async function lookAndAsk(question, { mode = "look" } = {}) {
  if (!state.connected) { toast(T("Pas connecté à Lumen", "Not connected to Lumen")); return; }
  if (!state.backend.vision) {
    toast(T("Le modèle actif ne lit pas les images", "The active model can't read images"), 3500);
    return;
  }
  // Point réel visé au moment de la demande (hit-test), avant de bouger la tête.
  const target = spatial.lastHit ? spatial.lastHit.clone() : null;
  setStatus(T("Capture…", "Capturing…"));
  playFiller("look");
  let canvas;
  try { canvas = await captureFrame(); } catch {
    toast(T("Caméra indisponible (autorisez l'accès caméra du casque)", "Camera unavailable (allow headset camera access)"), 4000);
    return;
  }
  setStatus("");
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  visionState.image = canvas;
  visionState.text = "";
  visionState.pending = true;
  visionState.streaming = false;
  visionState.after = state.messages.length + 1; // la question de l'utilisateur
  visionState.target = target;
  visionState.mode = mode;
  vision.title = mode === "translate" ? T("Traduction", "Translation") : T("Lumen regarde", "Lumen sees");
  spatial.release(vision.key);
  // Traduction : la fiche se pose SUR le texte lu, comme un calque.
  if (target && mode === "translate") placeOn(vision, target);
  else if (target) placeBeside(vision, target); else placeInGaze(vision);
  vision.open();
  vision.invalidate();
  const q = question || T(
    "Regarde cette image prise par mon casque : décris ce que tu vois et ce qui pourrait m'être utile.",
    "Look at this image from my headset: describe what you see and anything useful to me.",
  );
  // Image ET question dans le même message : le bureau joint l'image au tour
  // qu'il lance, quel que soit le mode (orchestré compris), sans course.
  state.route = null;
  state.turnVoice = "";
  send({ type: "chat", text: q, image: dataUrl, voice: true });
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

function headPose() {
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.updateMatrixWorld(true);
  const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  cam.getWorldQuaternion(tmpQ);
  tmpE.setFromQuaternion(tmpQ, "YXZ");
  return { pos, yaw: tmpE.y, quat: tmpQ.clone() };
}

function recenter() {
  const { pos, yaw } = headPose();
  world.position.set(pos.x, pos.y - 0.05, pos.z);
  world.rotation.set(0, yaw, 0);
}

function placeInGaze(panel) {
  const { pos, quat } = headPose();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  fwd.y = Math.max(-0.4, Math.min(0.3, fwd.y));
  fwd.normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  right.y = 0;
  right.normalize();
  const target = pos.clone().addScaledVector(fwd, 0.95).addScaledVector(right, 0.32);
  panel.object.position.copy(world.worldToLocal(target.clone()));
  faceHead(panel.object);
}

/// Fiche posée SUR l'objet visé (menu, panneau, notice), 3 cm devant, tournée
/// vers l'utilisateur : la traduction recouvre le texte d'origine.
function placeOn(panel, point) {
  const { pos } = headPose();
  const toUser = pos.clone().sub(point).normalize();
  const target = point.clone().addScaledVector(toUser, 0.03);
  if (target.distanceTo(pos) < 0.4) target.copy(pos).addScaledVector(target.clone().sub(pos).normalize(), 0.4);
  panel.object.position.copy(world.worldToLocal(target));
  faceHead(panel.object);
}

/// Fiche posée à côté de l'objet réel visé (à droite, un peu plus haut),
/// tournée vers l'utilisateur, reliée à l'objet par un trait.
function placeBeside(panel, point) {
  const { pos } = headPose();
  const toUser = pos.clone().sub(point).setY(0).normalize();
  const right = new THREE.Vector3(0, 1, 0).cross(toUser).normalize().negate();
  const target = point.clone().addScaledVector(right, 0.32).add(new THREE.Vector3(0, 0.18, 0)).addScaledVector(toUser, 0.08);
  // Pas trop près des yeux.
  if (target.distanceTo(pos) < 0.55) target.copy(pos).addScaledVector(target.clone().sub(pos).normalize(), 0.55);
  panel.object.position.copy(world.worldToLocal(target));
  faceHead(panel.object);
}

function faceHead(obj) {
  const { pos } = headPose();
  const local = world.worldToLocal(pos.clone());
  local.y = obj.position.y; // reste vertical
  obj.lookAt(world.localToWorld(local));
}

// ---------------------------------------------------------------------------
// Pointeurs : manettes / mains (WebXR) et souris (aperçu)
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointers = [];

function makeRay() {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
  line.scale.z = 3;
  return line;
}
const cursorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
function makeCursor() {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.006, 0.01, 24), cursorMat);
  m.renderOrder = 10;
  m.visible = false;
  scene.add(m);
  return m;
}
function newPointer(source) {
  return { source, hit: null, pressed: null, drag: null, cursor: makeCursor(), origin: new THREE.Vector3(), dir: new THREE.Vector3() };
}

for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i);
  const p = newPointer(ctrl);
  const ray = makeRay();
  ctrl.add(ray);
  p.ray = ray;
  ctrl.addEventListener("connected", (e) => { p.inputSource = e.data; ray.visible = true; });
  ctrl.addEventListener("disconnected", () => { p.inputSource = null; ray.visible = false; p.cursor.visible = false; endDrag(p); if (p.propDrag) { props.release(p.propDrag, p); p.propDrag = null; } });
  ctrl.addEventListener("selectstart", () => pointerDown(p));
  ctrl.addEventListener("selectend", () => pointerUp(p));
  scene.add(ctrl);
  p.update = () => {
    ctrl.updateMatrixWorld(true);
    p.origin.setFromMatrixPosition(ctrl.matrixWorld);
    p.dir.set(0, 0, -1).applyQuaternion(ctrl.getWorldQuaternion(tmpQ));
    return !!p.inputSource;
  };
  pointers.push(p);
}

// Souris (aperçu hors casque).
const mouse = newPointer(null);
const ndc = new THREE.Vector2(9, 9);
mouse.update = () => {
  if (renderer.xr.isPresenting || ndc.x > 2) return false;
  raycaster.setFromCamera(ndc, camera);
  mouse.origin.copy(raycaster.ray.origin);
  mouse.dir.copy(raycaster.ray.direction);
  return true;
};
pointers.push(mouse);
// Le survol est calculé à chaque image, mais un appui tactile (ou un clic sans
// mouvement préalable) n'envoie pas de pointermove : on recalcule le point
// visé au moment même de l'appui et du relâchement.
function aimMouse(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  mouse.hit = mouse.update() ? intersect(mouse) : null;
}
renderer.domElement.addEventListener("pointermove", (e) => {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
});
renderer.domElement.addEventListener("pointerdown", (e) => { aimMouse(e); ensureAudio(); pointerDown(mouse); });
renderer.domElement.addEventListener("pointerup", (e) => { aimMouse(e); pointerUp(mouse); });
renderer.domElement.addEventListener("wheel", (e) => {
  aimMouse(e);
  if (mouse.hit?.panel?.onScroll) { mouse.hit.panel.onScroll(e.deltaY > 0 ? 2 : -2); return; }
  if (mouse.hit?.panel === ai) { aiState.scroll += e.deltaY > 0 ? 1 : -1; ai.invalidate(); return; }
  if (mouse.hit?.panel === chat) {
    state.scroll = Math.max(0, state.scroll + (e.deltaY < 0 ? 2 : -2));
    chat.invalidate();
  }
});

/// Panneaux interactifs visibles (la pastille de l'orbe comprise).
function interactivePanels() {
  const list = panels.filter((x) => x.visible);
  if (orbChip.object.visible) list.push(orbChip);
  return list;
}

function intersect(p) {
  raycaster.set(p.origin, p.dir);
  const targets = [shell, ...interactivePanels().map((x) => x.mesh), ...props.pickables(), ...thoughts.pickables(), ...morning.pickables(), ...(lightDesk?.pickables() || [])];
  const hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) return null;
  const h = hits[0];
  if (h.object.userData.spatialControl) return { control: h.object.userData.spatialControl, point: h.point, distance: h.distance };
  if (h.object.userData.isOrb) return { orb: true, point: h.point, distance: h.distance };
  if (h.object.userData.prop) return { prop: h.object.userData.prop, point: h.point, distance: h.distance };
  if (h.object.userData.thought) return { thought: h.object.userData.thought, point: h.point, distance: h.distance };
  if (h.object.userData.morning) return { morning: h.object.userData.morning, point: h.point, distance: h.distance };
  const panel = h.object.userData.panel;
  return { panel, zone: panel.hitTest(h.uv), point: h.point, distance: h.distance };
}

const orbWorld = () => orbRig.getWorldPosition(new THREE.Vector3());
const keyOf = (obj) => Object.entries(movables).find(([, m]) => m.obj === obj)?.[0] || null;
const scaleOf = (obj) => (obj === orbRig ? orbScale : movables[keyOf(obj)]?.panel?.scale ?? 1);
function setScaleOf(obj, s) {
  if (obj === orbRig) return setOrbScale(s);
  const panel = movables[keyOf(obj)]?.panel;
  if (!panel) return;
  panel.scale = Math.min(2.2, Math.max(0.5, s));
  obj.scale.setScalar(panel.scale);
}

/// Point de saisie courant d'un pointeur : point de pincement (saisie
/// directe) ou point le long du rayon.
function grabPoint(p, out = new THREE.Vector3()) {
  if (p.drag?.hand) return out.copy(p.drag.hand.pinchPoint);
  return out.copy(p.origin).addScaledVector(p.dir, p.drag ? p.drag.distance : (p.hit?.distance ?? 1));
}

/// Saisie : l'objet suit le rayon (distance constante, le stick l'éloigne) ou
/// la main (saisie directe). Deux saisies du même objet = redimensionnement.
function startDrag(p, obj, point, distance, panel = null, hand = null) {
  const other = pointers.find((q) => q !== p && q.drag && q.drag.obj === obj);
  const key = keyOf(obj);
  if (key) spatial.release(key);
  p.drag = { obj, panel, distance, hand, offset: obj.getWorldPosition(new THREE.Vector3()).sub(point) };
  if (other) {
    // Deuxième main sur le même objet : on passe en redimensionnement.
    const a = grabPoint(other), b = point.clone();
    p.drag.scale = { other, d0: Math.max(0.02, a.distanceTo(b)), s0: scaleOf(obj) };
  }
  if (panel) { panel.pressedId = "__handle"; panel.invalidate(); spatial.showPlanes(true); }
}

function endDrag(p) {
  const d = p.drag;
  if (!d) return;
  p.drag = null;
  if (d.panel) { d.panel.pressedId = null; d.panel.invalidate(); }
  // L'autre main tient encore l'objet : elle garde la main, pas d'ancrage.
  if (pointers.some((q) => q.drag && q.drag.obj === d.obj)) {
    for (const q of pointers) if (q.drag?.scale?.other === p) q.drag.scale = null;
    // La main restante repart de sa position actuelle.
    for (const q of pointers) if (q.drag && q.drag.obj === d.obj) q.drag.offset = d.obj.getWorldPosition(new THREE.Vector3()).sub(grabPoint(q));
    return;
  }
  // Lâcher : aimantation (table pour l'orbe, mur pour un panneau), ancre, mémoire.
  if (d.obj === orbRig) spatial.snapOrb(orbRig, ORB_R * orbScale);
  // Panneau : selon le réglage « Aimanter les panneaux » — mur tout proche
  // (défaut), mur visé par le rayon, ou jamais (le panneau reste en l'air).
  else if (d.panel && settings.snap !== "off"
    && spatial.snapPanel(d.obj, settings.snap === "aimed" && !d.hand ? { origin: p.origin.clone(), dir: p.dir.clone() } : null)) toast(T("Plaqué au mur", "Snapped to wall"), 1200);
  if (d.panel) spatial.showPlanes(false);
  const key = keyOf(d.obj);
  if (key) spatial.anchor(key, d.obj);
  saveLayout();
}

function pointerDown(p) {
  const hand = p.inputSource ? hands.forSource(p.inputSource) : null;
  // Saisie DIRECTE à la main : pincement à portée de l'orbe ou d'une poignée.
  if (hand) {
    const pp = hand.pinchPoint;
    const control=lightDesk?.nearest(pp);
    if(control) { p.pressed={control,hand,point:pp.clone()};return; }
    // Objet physique à portée de la main : on le prend directement.
    const near = props.nearest(pp, 0.07);
    if (near && near.kind !== "approve" && near.kind !== "reject" && near.kind !== "dismiss") {
      p.pressed = { prop: near, t0: performance.now(), point: pp.clone(), distance: 0, hand };
      return;
    }
    if (pp.distanceTo(orbWorld()) < ORB_R * orbScale * 1.5) {
      startDrag(p, orbRig, pp.clone(), 0, null, hand);
      p.drag.direct = true;
      return;
    }
    for (const panel of interactivePanels()) {
      const lh = panel.localHit(pp);
      if (!lh || Math.abs(lh.depth) > 0.06) continue;
      const zone = panel.hitTest(lh.uv);
      if (zone?.drag) { startDrag(p, panel.object, pp.clone(), 0, panel, hand); return; }
      // Deuxième main qui pince un panneau déjà tenu : redimensionnement.
      if (pointers.some((q) => q !== p && q.drag?.obj === panel.object)) { startDrag(p, panel.object, pp.clone(), 0, panel, hand); return; }
    }
  }
  const h = p.hit;
  if (!h) return;
  // Deuxième pointeur sur un objet déjà tenu : redimensionnement.
  const held = pointers.find((q) => q !== p && q.drag && (h.orb ? q.drag.obj === orbRig : q.drag.obj === h.panel?.object));
  if (held) { startDrag(p, held.drag.obj, h.point, h.distance, h.panel || null); return; }
  // Objet physique : appui bref = clic, appui puis mouvement = saisie.
  if (h.control) { p.pressed={control:h.control,point:h.point.clone(),distance:h.distance,t0:performance.now()};return; }
  if (h.prop) { p.pressed = { prop: h.prop, t0: performance.now(), point: h.point.clone(), distance: h.distance }; return; }
  if (h.thought) { p.pressed = { thought: h.thought }; return; }
  if (h.morning) { p.pressed = { morning: h.morning }; return; }
  // Orbe : un pincement bref = parler ; pincer puis bouger (ou tenir) = déplacer.
  if (h.orb) { p.pressed = { orb: true, t0: performance.now(), point: h.point.clone(), distance: h.distance }; return; }
  if (h.zone?.drag) { startDrag(p, h.panel.object, h.point, h.distance, h.panel); return; }
  if (h.zone) p.pressed = { panel: h.panel, id: h.zone.id, point:h.point.clone() };
  else if(h.panel?.onScroll) p.pressed={panel:h.panel,scroll:true,point:h.point.clone()};
}

function pointerUp(p) {
  if (p.propDrag) { props.release(p.propDrag, p); p.propDrag = null; return; }
  if (p.drag) { endDrag(p); return; }
  const pr = p.pressed;
  p.pressed = null;
  if (!pr) return;
  if (pr.control) { if(pr.hand || p.hit?.control===pr.control) { ensureAudio();lightDesk.click(pr.control,p); } return; }
  if (pr.prop) { ensureAudio(); props.click(pr.prop, p); return; }
  if (pr.thought) { ensureAudio(); thoughts.open(pr.thought); return; }
  if (pr.morning) { ensureAudio(); pr.morning.onClick?.(); return; }
  const h = p.hit;
  if (pr.orb) { ensureAudio(); toggleTalk(); return; }
  if(pr.panel?.onScroll && pr.point && h?.panel===pr.panel) {
    const delta=pr.panel.mesh.worldToLocal(h.point.clone()).y-pr.panel.mesh.worldToLocal(pr.point.clone()).y;
    if(Math.abs(delta)>.015) {pr.panel.onScroll(Math.round(delta*900/40));return;}
  }
  if (pr.panel && h?.panel === pr.panel && h.zone?.id === pr.id && !pr.scroll) {
    ensureAudio();
    h.zone.onClick?.();
    pr.panel.invalidate();
  }
}

// ---- Appui du bout du doigt (« poke ») ----------------------------------------
// L'index traverse le plan d'un panneau proche : le bouton sous le doigt est
// pressé. Un loquet empêche la répétition tant que le doigt n'est pas ressorti.
const pokeLatch = [null, null];
function updatePoke(hovered) {
  for (const h of hands.hands) {
    const i = h.index;
    const ptr = pointers[i];
    if (!h.tracked || h.pinching || ptr?.drag) { pokeLatch[i] = null; continue; }
    let near = false;
    const control=lightDesk?.nearest(h.tip,.045);
    if(control) {
      near=true;
      if(!pokeLatch[i]) {pokeLatch[i]={control};ensureAudio();lightDesk.click(control,ptr);}
    } else if(pokeLatch[i]?.control) pokeLatch[i]=null;
    // Orbe : toucher l'orbe du doigt = parler.
    const od = h.tip.distanceTo(orbWorld());
    if (od < ORB_R * orbScale * 1.05) {
      near = true;
      if (!pokeLatch[i]) { pokeLatch[i] = "orb"; ensureAudio(); toggleTalk(); }
    } else if (pokeLatch[i] === "orb" && od > ORB_R * orbScale * 1.3) pokeLatch[i] = null;
    for (const panel of interactivePanels()) {
      const lh = panel.localHit(h.tip);
      if (!lh || lh.depth > 0.07 || lh.depth < -0.04) {
        if (pokeLatch[i]?.panel === panel) pokeLatch[i] = null;
        continue;
      }
      near = true;
      const zone = panel.hitTest(lh.uv);
      if(panel.onScroll && !zone && lh.depth<.025) {
        if(!pokeLatch[i]) pokeLatch[i]={panel,scroll:true,y:lh.uv.y};
        const latch=pokeLatch[i];
        if(latch?.panel===panel && latch.scroll) {const delta=(lh.uv.y-latch.y)*panel.H/40;if(Math.abs(delta)>=1){panel.onScroll(Math.round(delta));latch.y=lh.uv.y;}}
      }
      if (zone && !zone.drag) hovered.set(panel, zone.id);
      if (lh.depth < 0.012 && zone?.onClick && !pokeLatch[i]) {
        pokeLatch[i] = { panel, id: zone.id };
        ensureAudio();
        zone.onClick();
        panel.invalidate();
      } else if (pokeLatch[i]?.panel === panel && lh.depth > 0.03) pokeLatch[i] = null;
    }
    // Doigt tout près d'un panneau : le rayon s'efface, il gênerait.
    if (ptr?.ray) ptr.ray.visible = !near;
  }
}

// ---- Orbe vivante : vols, « suis-moi », esquive ------------------------------
let orbFly = null; // { from, to, t0, dur, arc, then }
let orbFollow = false;
let orbDodge = null; // { v: Vector3, t0 }
/// L'orbe vole jusqu'à un point (un objet retrouvé, ce dont elle parle), s'y
/// arrête quelques secondes, puis revient à sa place.
function flyOrbTo(point, { stayMs = 6500 } = {}) {
  if (pointers.some((p) => p.drag?.obj === orbRig)) return;
  const home = orbWorld();
  const { pos } = headPose();
  const toUser = pos.clone().sub(point).setY(0).normalize();
  const to = point.clone().addScaledVector(toUser, 0.18).add(new THREE.Vector3(0, 0.16, 0));
  spatial.release("orb");
  orbFly = {
    from: home, to, t0: performance.now(), dur: 950, arc: 0.18,
    then: () => {
      if (orbFollow) return;
      setTimeout(() => {
        if (orbFly || orbFollow || pointers.some((p) => p.drag?.obj === orbRig)) return;
        orbFly = { from: orbWorld(), to: home, t0: performance.now(), dur: 900, arc: 0.12, then: () => { spatial.anchor("orb", orbRig); saveLayout(); } };
      }, stayMs);
    },
  };
}
/// L'orbe vient se placer au-dessus d'un point et y RESTE (rituel du matin)…
let orbHomePos = null;
function orbOver(point) {
  if (pointers.some((p) => p.drag?.obj === orbRig)) return;
  orbHomePos ??= orbWorld();
  spatial.release("orb");
  orbFly = { from: orbWorld(), to: point.clone(), t0: performance.now(), dur: 1400, arc: 0.1, then: () => {} };
}
/// … puis revient à sa place.
function orbHome() {
  if (!orbHomePos) return;
  const to = orbHomePos; orbHomePos = null;
  orbFly = { from: orbWorld(), to, t0: performance.now(), dur: 1200, arc: 0.08, then: () => { spatial.anchor("orb", orbRig); saveLayout(); } };
}
function setFollow(on) {
  orbFollow = on;
  if (on) { spatial.release("orb"); earcon(true); }
  else { spatial.snapOrb(orbRig, ORB_R * orbScale); spatial.anchor("orb", orbRig); saveLayout(); earcon(false); }
}
const FOLLOW_RE = /^\s*(?:lumen[, ]*)?(?:viens avec moi|suis[- ]moi|accompagne[- ]moi|follow me|come with me)\b/i;
const STAY_RE = /^\s*(?:lumen[, ]*)?(?:reste (?:là|la|ici)|arr[eê]te de me suivre|pose[- ]toi(?: ici| là)?|stay(?: here)?|stop following)(?![\p{L}])/iu;
const DESK_ON_RE = /^\s*(?:lumen[, ]*)?(?:montre|sors|affiche|ouvre|show)(?:[- ]moi)?\s+(?:mes |les |le |mon |my |the )?(?:dossiers|sandbox(?:es)?|bureau|folders|desk)\b/i;
const DESK_OFF_RE = /^\s*(?:lumen[, ]*)?(?:range|cache|enl[eè]ve|hide)\s+(?:mes |les |le |mon |my |the )?(?:dossiers|sandbox(?:es)?|bureau|figurines|folders|desk)\b/i;
const AMBIENCE_RE = /\b(?:(?:change|changer) (?:d['’]|l['’])ambiance|autre ambiance|ambiance (?:suivante|nuit|[ée]toil[ée]e|aube|oc[ée]an|mer)|(?:next|change) ambience)\b/i;

// ---- Paume vers le haut : l'orbe vient dans la main ------------------------
hands.onPalmUp = (h) => {
  if (pointers.some((p) => p.drag?.obj === orbRig)) return;
  lightDesk?.show(hands.abovePalm(h,.06));
  spatial.release("orb");
  orbFollow = false;
  orbFly = { from: orbWorld(), to: hands.abovePalm(h, 0.14 + ORB_R * orbScale), t0: performance.now() };
  earcon(true);
};
// Pouce levé : approuve la demande de l'agent regardé.
hands.onThumbsUp = () => { if (props.thumbsUp()) earcon(true); };

const _dragTarget = new THREE.Vector3();
const _gp = new THREE.Vector3();
let lastPointAt = null; // ce que l'utilisateur montre (pour le regard de l'orbe)
function updatePointers() {
  const hovered = new Map(); // panel → zone id
  const hoveredProps = [];
  const hoveredControls = [];
  let orbHover = false;
  const now = performance.now();
  lastPointAt = null;
  for (const p of pointers) {
    const active = p.update();
    if (!active) { p.cursor.visible = false; p.hit = null; continue; }
    const gp = p.inputSource?.gamepad;
    // Orbe pincée : devient une saisie dès que le rayon bouge ou que ça dure.
    if (p.pressed?.orb && !p.drag) {
      _dragTarget.copy(p.origin).addScaledVector(p.dir, p.pressed.distance);
      if (_dragTarget.distanceTo(p.pressed.point) > 0.03 || now - p.pressed.t0 > 450) {
        startDrag(p, orbRig, p.pressed.point, p.pressed.distance);
        p.pressed = null;
      }
    }
    // Objet de lumière déplaçable (enveloppe de notification…) : pincé puis bougé = saisi.
    if (p.pressed?.control?.draggable && !p.drag && p.pressed.point) {
      const pr = p.pressed;
      const cur = pr.hand ? pr.hand.pinchPoint : _dragTarget.copy(p.origin).addScaledVector(p.dir, pr.distance || 0.5);
      if (cur.distanceTo(pr.point) > 0.03) { startDrag(p, pr.control.holder, pr.point, pr.distance || 0, null, pr.hand || null); p.pressed = null; }
    }
    // Objet physique pressé : devient une saisie dès que ça bouge ou que ça dure.
    if (p.pressed?.prop && !p.propDrag) {
      const pr = p.pressed;
      const cur = pr.hand ? pr.hand.pinchPoint : _dragTarget.copy(p.origin).addScaledVector(p.dir, pr.distance);
      if (cur.distanceTo(pr.point) > 0.025 || now - pr.t0 > 380) {
        p.propDrag = props.grab(pr.prop, p, pr.point);
        if (p.propDrag) { p.propDrag.hand = pr.hand || null; p.propDrag.distance = pr.distance; }
        p.pressed = null;
      }
    }
    if (p.propDrag) {
      const d = p.propDrag;
      if (!d.hand && gp && gp.axes.length >= 4 && Math.abs(gp.axes[3]) > 0.3) d.distance = Math.min(5, Math.max(0.25, d.distance - gp.axes[3] * 0.03));
      const target = d.hand ? d.hand.pinchPoint.clone() : p.origin.clone().addScaledVector(p.dir, d.distance);
      props.drag(d, target, now);
      lastPointAt = target;
    }
    if (p.drag) {
      const d = p.drag;
      if (d.scale && d.scale.other.drag) {
        // Deux mains : l'échelle suit l'écart entre les deux prises.
        const dist = grabPoint(p, _gp).distanceTo(grabPoint(d.scale.other));
        setScaleOf(d.obj, d.scale.s0 * dist / d.scale.d0);
      } else {
        // La main « principale » déplace ; le stick règle la distance du rayon.
        if (!d.hand && gp && gp.axes.length >= 4 && Math.abs(gp.axes[3]) > 0.3) {
          d.distance = Math.min(6, Math.max(0.3, d.distance - gp.axes[3] * 0.03));
        }
        grabPoint(p, _dragTarget).add(d.offset);
        setWorldPosition(d.obj, _dragTarget);
        if (d.panel) faceHead(d.obj);
      }
      if (d.obj === orbRig) chipUntil = now + 2500;
      lastPointAt = grabPoint(p);
    }
    const h = p.drag?.hand || p.propDrag?.hand ? null : intersect(p);
    p.hit = h;
    if(h?.control) hoveredControls.push(h.control);
    if (h?.prop) hoveredProps.push(h.prop);
    if (h?.thought) h.thought.hover = 1;
    if (h) {
      p.cursor.visible = true;
      p.cursor.position.copy(h.point).addScaledVector(p.dir, -0.004);
      p.cursor.quaternion.copy(renderer.xr.isPresenting ? renderer.xr.getCamera().quaternion : camera.quaternion);
      if (p.ray) p.ray.scale.z = h.distance;
      if (h.orb) orbHover = true;
      else if (h.zone) hovered.set(h.panel, h.zone.id);
      if (h.orb || h.panel === orbChip) chipUntil = now + 2500;
      if (!lastPointAt) lastPointAt = h.point.clone();
    } else {
      p.cursor.visible = false;
      if (p.ray) p.ray.scale.z = 3;
    }
    // Stick vertical des manettes : défilement du chat sous le pointeur.
    if (!p.drag && gp && (h?.panel === chat || h?.panel?.onScroll) && gp.axes.length >= 4 && Math.abs(gp.axes[3]) > 0.6) {
      p.scrollAcc = (p.scrollAcc || 0) + gp.axes[3] * -0.25;
      if (Math.abs(p.scrollAcc) >= 1) {
        if (h.panel.onScroll) h.panel.onScroll(-Math.trunc(p.scrollAcc));
        else state.scroll = Math.max(0, state.scroll + Math.trunc(p.scrollAcc));
        p.scrollAcc -= Math.trunc(p.scrollAcc);
        chat.invalidate();
      }
    }
  }
  updatePoke(hovered);
  // Mains nues : l'objet à portée de doigt est « survolé » (il se soulève).
  for (const hd of hands.hands) if (hd.tracked) { const n = props.nearest(hd.pinchPoint, 0.07); if (n) hoveredProps.push(n); }
  for(const hd of hands.hands) if(hd.tracked){const item=lightDesk?.nearest(hd.pinchPoint,.08);if(item)hoveredControls.push(item);}
  lightDesk?.setHovered(hoveredControls);
  props.setHovered(hoveredProps);
  for (const panel of [...panels, orbChip]) panel.setHover(hovered.get(panel) ?? null);
  orbHoverGlow += ((orbHover ? 1 : 0) - orbHoverGlow) * 0.2;
  const showChip = now < chipUntil;
  if (showChip !== orbChip.object.visible) { orbChip.object.visible = showChip; orbChip.invalidate(); }
  renderer.domElement.style.cursor = orbHover || hovered.size ? "pointer" : "default";
}

// ---------------------------------------------------------------------------
// Boucle — animation de l'orbe calquée sur orb.js (même vitesse, même niveau)
// ---------------------------------------------------------------------------
function refreshUi() {
  caption.invalidate();
  bar.invalidate();
  chat.invalidate();
}

let needsRecenter = false;
let colorTime = 0;
let audioLevel = 0;
let mouthLevel = 0;
let orbHoverGlow = 0;
const targets = { speed: 0.30, intensity: 1.0 };

// Battement de cœur du bureau : anneau coloré qui traverse la sphère.
let pulse = null;
function pulseHeart(msg) {
  if (msg.color) coreUniforms.uPulseColor.value.set(msg.color);
  pulse = {
    start: clock.elapsedTime,
    duration: 1.6 / Math.max(0.1, (Number(msg.speed) || 100) / 100),
    strength: (Number(msg.strength) || 100) / 100,
  };
}

const _head = new THREE.Vector3(), _local = new THREE.Vector3(), _o = new THREE.Vector3();
function placeAroundOrb() {
  // Légende, pastille et capsule Halo suivent l'orbe (taille et place).
  const r = ORB_R * orbScale;
  orbRig.getWorldPosition(_o);
  // Sous la ceinture d'icônes (à la base de l'orbe) : légende et pastille
  // descendent un peu pour ne pas être traversées par les icônes.
  setWorldPosition(caption.object, _o.clone().add(new THREE.Vector3(0, -r - 0.105, 0)));
  setWorldPosition(orbChip.object, _o.clone().add(new THREE.Vector3(0, -r - 0.215, 0)));
  setWorldPosition(apps.halo.object, _o.clone().add(new THREE.Vector3(0, r + 0.08, 0)));
  stepRing.update(_o, r, performance.now());
  faceHead(caption.object);
  faceHead(orbChip.object);
  faceHead(apps.halo.object);
}

/// Voyant de confidentialité : en haut du champ de vision, suit la tête.
function placePrivacy() {
  if (!privacy.object.visible) return;
  const { pos, quat } = headPose();
  const p = new THREE.Vector3(0.13, 0.17, -0.6).applyQuaternion(quat).add(pos);
  privacy.object.position.copy(p);
  privacy.object.quaternion.copy(quat);
}

function updateShadow() {
  const o = orbWorld();
  const surface = spatial.surfaceBelow(o);
  const h = o.y - surface;
  const r = ORB_R * orbScale;
  shadow.position.set(o.x, surface + 0.002, o.z);
  shadow.scale.setScalar(r * (2.2 + h * 0.8));
  shadow.material.opacity = Math.max(0, 0.5 * (1 - (h - r) / 1.0));
  shadow.visible = shadow.material.opacity > 0.01;
}

function updateLeader() {
  const t = visionState.target;
  const show = !!t && vision.visible;
  leader.visible = leaderDot.visible = show;
  if (!show) return;
  const panelPos = vision.object.getWorldPosition(new THREE.Vector3());
  // Départ du trait : bord bas-gauche de la fiche, vers l'objet.
  const corner = new THREE.Vector3(-vision.width / 2, -vision.height / 2, 0).multiplyScalar(vision.scale);
  corner.applyQuaternion(vision.object.getWorldQuaternion(new THREE.Quaternion())).add(panelPos);
  const pos = leader.geometry.attributes.position;
  pos.setXYZ(0, corner.x, corner.y, corner.z);
  pos.setXYZ(1, t.x, t.y, t.z);
  pos.needsUpdate = true;
  leaderDot.position.copy(t);
}

// Paupières et regard de l'orbe.
const _eyeT = new THREE.Vector3();
function updateFace(st, t, dt) {
  const { pos } = headPose();
  _head.copy(pos);
  _local.copy(_head);
  orbBody.worldToLocal(_local).normalize().multiplyScalar(0.9);
  face.position.copy(_local);
  face.lookAt(_head);
  // Les yeux glissent vers ce que l'on montre (rayon, main), sinon vers nous.
  let tx = 0, ty = 0;
  if (lookFocus && performance.now() > lookFocus.until) lookFocus = null;
  const focus = lookFocus?.point || lastPointAt || nearestHandTip();
  if (focus && st !== "speaking") {
    _eyeT.copy(focus);
    face.worldToLocal(_eyeT);
    const n = _eyeT.length() || 1;
    tx = Math.max(-0.09, Math.min(0.09, (_eyeT.x / n) * 0.2));
    ty = Math.max(-0.07, Math.min(0.07, (_eyeT.y / n) * 0.2));
  }
  eyesRig.position.x += (tx - eyesRig.position.x) * Math.min(1, dt * 8);
  eyesRig.position.y += (ty - eyesRig.position.y) * Math.min(1, dt * 8);
  // Clignement : même rythme que le CSS du bureau (plus vif en activité).
  const period = st === "idle" ? 5.2 : 2.6;
  const ph = (t % period) / period;
  const blink = ph < 0.92 ? 1 : 1 - 0.9 * (1 - Math.abs(ph - 0.95) / 0.05);
  for (const e of eyes) e.scale.y = Math.max(0.1, Math.min(1, blink));
  // Bouche (si activée sur le bureau) : naît de la voix.
  mouthLevel += ((look.mouth && st === "speaking" ? audioLevel : 0) - mouthLevel) * 0.38;
  const ms = mouthScale(mouthLevel);
  mouth.scale.set(ms.x, ms.y, 1);
  mouth.material.opacity = look.mouth ? mouthOpacity(mouthLevel) : 0;
}

/// Main suivie la plus proche de l'orbe (à moins d'un mètre) : l'orbe la regarde.
function nearestHandTip() {
  let best = null, bd = 1.0;
  const o = orbWorld();
  for (const h of hands.hands) {
    if (!h.tracked) continue;
    const d = h.tip.distanceTo(o);
    if (d < bd) { bd = d; best = h.tip; }
  }
  return best;
}

let lightProbe=null;
const wallGhost=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({color:0x9ddaff,transparent:true,opacity:.22,depthWrite:false,side:THREE.DoubleSide}));
wallGhost.visible=false;scene.add(wallGhost);
function updateWallPreview(){
  const panel=panels.find(p=>p.visible && p.hoverId==="__wall");wallGhost.visible=false;if(!panel)return;
  const origin=headPose().pos,dir=panel.object.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const hit=spatial.raycastWall(origin,dir);if(!hit)return;
  wallGhost.visible=true;wallGhost.position.copy(hit.point);wallGhost.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),hit.normal);wallGhost.scale.set(panel.width*panel.scale,panel.height*panel.scale,1);
}
let renderCursor = 0; // tour de rôle du rendu des panneaux (mode performance)
renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const now = performance.now();
  updateAdaptive(now);
  if(frame && lightProbe && frame.getLightEstimate){try{const estimate=frame.getLightEstimate(lightProbe);if(estimate)belt.setLighting(estimate);}catch{lightProbe=null;belt.setLighting(null);}}
  if (frame) spatial.update(frame, renderer.xr.getReferenceSpace());
  if (frame) panelLayers.update(frame, renderer.xr.getReferenceSpace());
  hands.update(now);
  if (needsRecenter && renderer.xr.isPresenting) {
    // Attend une pose de tête valide (la 1re image peut être à l'origine).
    const { pos } = headPose();
    if (pos.y > 0.3) { recenter(); lightDesk?.show(); needsRecenter = false; }
  }

  // Vol de l'orbe vers la paume.
  if (orbFly) {
    const k = Math.min(1, (now - orbFly.t0) / (orbFly.dur || 500));
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const p = orbFly.from.clone().lerp(orbFly.to, e);
    p.y += Math.sin(k * Math.PI) * (orbFly.arc || 0);
    setWorldPosition(orbRig, p);
    if (k >= 1) {
      const then = orbFly.then;
      orbFly = null;
      if (then) then(); else { spatial.anchor("orb", orbRig); saveLayout(); }
    }
  } else if (orbFollow && !pointers.some((p) => p.drag?.obj === orbRig)) {
    // « Suis-moi » : l'orbe flotte un peu devant, à droite, et suit sans à-coups.
    const { pos, yaw } = headPose();
    const target = pos.clone().add(new THREE.Vector3(0.38, -0.2, -0.5).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    const cur = orbWorld();
    if (cur.distanceTo(target) > 0.06) setWorldPosition(orbRig, cur.lerp(target, Math.min(1, dt * 1.8)));
  }
  // Esquive : une main qui fonce vers l'orbe la fait s'écarter, puis revenir.
  if (!orbDodge) {
    const o = orbWorld();
    for (const hd of hands.hands) {
      if (!hd.tracked || hd.pinching || hd.speed < 1.3) continue;
      const d = hd.tip.distanceTo(o);
      if (d > 0.24 || d < ORB_R * orbScale * 0.9) continue;
      const away = o.clone().sub(hd.tip).setY(0).normalize();
      const side = new THREE.Vector3(-away.z, 0, away.x);
      orbDodge = { v: world.worldToLocal(o.clone().addScaledVector(away, 0.1).addScaledVector(side, 0.06).add(new THREE.Vector3(0, 0.05, 0))).sub(world.worldToLocal(o.clone())), t0: now };
      earcon(false);
      break;
    }
  }

  // États : mêmes cibles que la machine d'états d'orb.js, plus « écoute ».
  const st = effectiveState();
  if (st === "thinking" || st === "transcribing") { targets.speed = 1.1; targets.intensity = 1.12; }
  else if (st === "speaking") { targets.speed = 0.7; targets.intensity = 1.18; }
  else if (st === "listening") { targets.speed = 0.6; targets.intensity = 1.1; }
  else { targets.speed = 0.30; targets.intensity = state.connected ? 1.0 : 0.7; }
  coreUniforms.uSpeed.value += (targets.speed - coreUniforms.uSpeed.value) * 0.05;
  coreUniforms.uIntensity.value += (targets.intensity - coreUniforms.uIntensity.value + orbHoverGlow * 0.1) * 0.06;

  // Niveau : la VRAIE voix (analyseur) quand Lumen parle, le micro quand il
  // écoute — là où le bureau n'a qu'une enveloppe synthétique.
  let audioTarget;
  if (st === "speaking") audioTarget = currentSource ? 0.40 + 0.60 * voiceLevel() : 0.40 + 0.60 * syntheticLevel(t);
  else if (st === "listening") audioTarget = 0.25 + 0.7 * micLevel;
  else if (st === "thinking" || st === "transcribing") audioTarget = 0.40 + 0.12 * (0.5 + 0.5 * Math.sin(t * 2.0));
  else audioTarget = 0.05 + 0.05 * (0.5 + 0.5 * Math.sin(t * 0.8));
  audioLevel += (audioTarget - audioLevel) * (st === "speaking" || st === "listening" ? 0.35 : 0.06);
  coreUniforms.uAudio.value = audioLevel;
  colorTime += dt * coreUniforms.uSpeed.value * 3.0;
  coreUniforms.uTime.value = colorTime;

  if (pulse) {
    const pe = (t - pulse.start) / pulse.duration;
    if (pe >= 1) { pulse = null; coreUniforms.uPulse.value = 0; coreUniforms.uPulseRadius.value = 0; }
    else { coreUniforms.uPulseRadius.value = pe * 1.1; coreUniforms.uPulse.value = (1 - pe) * pulse.strength; }
  }

  core.rotation.y += dt * 0.25;
  core.rotation.x = Math.sin(t * 0.3) * 0.12;
  shell.rotation.copy(core.rotation);
  const breathe = st === "speaking" ? 1 + audioLevel * 0.05 : 1 + Math.sin(t) * 0.012;
  core.scale.setScalar(breathe);
  shell.scale.setScalar(breathe);
  orbBody.position.set(0, Math.sin(t * 1.1) * 0.01, 0); // flottement
  if (orbDodge) {
    const k = (now - orbDodge.t0) / 1200;
    if (k >= 1) orbDodge = null;
    else orbBody.position.addScaledVector(orbDodge.v, Math.sin(Math.min(1, k * 4) * Math.PI / 2) * (1 - k) / Math.max(0.1, orbScale));
  }
  glow.material.opacity = 0.28 + audioLevel * 0.25 + orbHoverGlow * 0.15;

  if (state.local === "listening") bar.invalidate(); // anneau du micro
  updatePointers();
  updateWallPreview();
  updateFace(st, t, dt);
  placeAroundOrb();
  placePrivacy();
  updateShadow();
  updateLeader();
  updateSpatialAudio();
  apps.tick();
  space.tick(now);
  extras.tick(now);
  props.tick(now);
  lightDesk?.tick(now,dt);
  morning.tick(now);
  {
    const hp = headPose().pos;
    thoughts.tick(now, dt, orbWorld(), ORB_R * orbScale, hp);
    env.tick(dt, hp);
  }

  // Rendu des panneaux : en mode performance, deux au plus par image.
  // La demande de Lumen passe toujours en premier, puis tour de rôle : sans
  // cela, les panneaux en tête de liste qui se redessinent sans cesse (chat en
  // flux) consommaient tout le budget et ceux de fin de liste ne s'affichaient
  // jamais en mode performance.
  let budget = settings.perf ? 2 : Infinity;
  if (requestPanel.dirty && requestPanel.visible) { requestPanel.render(); budget--; }
  if (bar.dirty) { bar.render(); budget--; }
  const n = panels.length;
  for (let k = 0; k < n && budget > 0; k++) {
    const p = panels[(renderCursor + k) % n];
    if (p.dirty && p.visible) { p.render(); budget--; }
  }
  renderCursor = (renderCursor + 1) % Math.max(1, n);
  caption.render();
  privacy.render();
  if (orbChip.object.visible) orbChip.render();
  renderer.render(scene, camera);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Mode performance
// ---------------------------------------------------------------------------
// 72 Hz (au lieu de 90/120), fovéation maximale, panneaux dessinés aux 2/3 de
// leur résolution, rendu à 80 % de la résolution native. Les deux derniers
// s'appliquent dès maintenant pour les panneaux, à la prochaine entrée en XR
// pour le rendu (le framebuffer se choisit à l'ouverture de session).
//
// Haute définition (défaut, ignorée en mode performance) : panneaux à 1,6× —
// 1 440 px par mètre, soit un texte aussi net que la dalle du Quest 3 le
// permet à 80 cm —, rendu à 125 % de la résolution recommandée par le casque
// (sur-échantillonnage : arêtes et texte plus fins) et fovéation légère, pour
// que le texte en bord de champ reste net.
let adaptiveTier=0;
const baseQuality = () => settings.perf
  ? { density: 0.66, scale: 0.8, foveation: 1 }
  : settings.hd ? { density: 1.6, scale: 1.25, foveation: 0.2 } : { density: 1, scale: 1, foveation: 0.5 };
const quality = () => {
  const q=baseQuality(), tier=settings.adaptiveQuality && !settings.perf ? adaptiveTier : 0;
  return {...q,density:Math.max(.66,q.density-tier*.3),foveation:Math.min(1,q.foveation+tier*.3)};
};
const adaptive={ema:0,last:0,slow:0,fast:0,changed:0};
function updateAdaptive(now) {
  if(!renderer.xr.isPresenting || !settings.adaptiveQuality || settings.perf){adaptive.last=now;return;}
  const elapsed=now-adaptive.last;adaptive.last=now;if(elapsed<=0 || elapsed>120)return;
  const target=1000/(renderer.xr.getSession()?.frameRate || 90);
  adaptive.ema=adaptive.ema?adaptive.ema*.95+elapsed*.05:elapsed;
  adaptive.slow=adaptive.ema>target*1.3?adaptive.slow+elapsed:0;
  adaptive.fast=adaptive.ema<target*1.12?adaptive.fast+elapsed:0;
  if(now-adaptive.changed<10000)return;
  if(adaptive.slow>2200 && adaptiveTier<2){adaptiveTier++;adaptive.changed=now;adaptive.slow=0;applyPerf();}
  else if(adaptive.fast>14000 && adaptiveTier>0){adaptiveTier--;adaptive.changed=now;adaptive.fast=0;applyPerf();}
}
function applyPerf() {
  setPanelDensity(quality().density);
  const session = renderer.xr.getSession?.();
  if (session) {
    renderer.xr.setFoveation(quality().foveation);
    const rates = session.supportedFrameRates ? [...session.supportedFrameRates] : [];
    if (session.updateTargetFrameRate && rates.length) {
      const want = settings.perf ? 72 : Math.max(...rates.filter((r) => r <= 90), rates[0]);
      const rate = rates.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
      session.updateTargetFrameRate(rate).catch(() => {});
    }
  }
  panels.forEach((p) => p.invalidate());
}

// ---------------------------------------------------------------------------
// Entrée en XR
// ---------------------------------------------------------------------------
async function supported(mode) {
  try { return !!(await navigator.xr?.isSessionSupported(mode)); } catch { return false; }
}

async function enter(mode) {
  ensureAudio();
  renderer.xr.setFramebufferScaleFactor(quality().scale);
  const session = await navigator.xr.requestSession(mode, {
    requiredFeatures: ["local-floor"],
    optionalFeatures: ["light-estimation", "hand-tracking", "anchors", "plane-detection", "mesh-detection", "hit-test", "bounded-floor",
      ...(settings.layers ? ["layers"] : []),
      // Profondeur du Quest 3 : three.js écrit la profondeur réelle dans le
      // tampon de profondeur → mains et meubles cachent ce qui est derrière eux.
      ...(settings.occlusion && mode === "immersive-ar" ? ["depth-sensing"] : [])],
    ...(settings.occlusion && mode === "immersive-ar" ? { depthSensing: { usagePreference: ["gpu-optimized"], dataFormatPreference: ["luminance-alpha", "float32", "unsigned-short"] } } : {}),
  });
  scene.background = mode === "immersive-ar" ? null : previewBg;
  await renderer.xr.setSession(session);
  lightProbe=null;
  if(session.requestLightProbe)session.requestLightProbe().then(probe=>{if(renderer.xr.getSession()===session)lightProbe=probe;}).catch(()=>{});
  panelLayers.enabled = settings.layers;
  if (panelLayers.start(session, mode === "immersive-ar")) toast(T("Texte en couches natives", "Native-layer text"), 1800);
  needsRecenter = true;
  // Rituel du matin automatique (première entrée du jour, avant 11 h).
  morning.maybeAuto(settings.morningAuto);
  document.body.classList.add("in-xr");
  applyPerf();
  const objs = Object.fromEntries(Object.entries(movables).map(([k, m]) => [k, m.obj]));
  spatial.start(session, objs).then(() => settingsPanel.invalidate());
  // Pièce jamais scannée : aucun plan au bout de quelques secondes. On lance
  // le scan du casque une fois (ensuite, il reste dans les Réglages).
  setTimeout(async () => {
    if (!spatial.session || spatial.hasPlanes || !spatial.canCapture) return;
    if (lsGet("xrRoomAsked", "") === "yes") { toast(T("Pièce non scannée : Réglages › Scanner la pièce", "Room not scanned: Settings › Scan room"), 4000); return; }
    lsSet("xrRoomAsked", "yes");
    toast(T("Scan de la pièce : suis les consignes du casque", "Room scan: follow the headset's instructions"), 4000);
    await spatial.captureRoom();
  }, 5000);
  session.addEventListener("end", () => {
    if (liveVision.on) setLiveVision(false);
    lightProbe=null;belt.setLighting(null);
    panelLayers.stop();
    spatial.stop();
    scene.background = previewBg;
    document.body.classList.remove("in-xr");
    camera.position.set(0, 1.6, 0);
    camera.rotation.set(0, 0, 0);
    recenter();
  });
}

(async () => {
  const ar = await supported("immersive-ar");
  const vr = await supported("immersive-vr");
  const btnAr = $("enter-ar");
  const btnVr = $("enter-vr");
  btnAr.hidden = !ar;
  btnVr.hidden = !vr;
  btnAr.onclick = () => enter("immersive-ar").catch((e) => toast(String(e.message || e)));
  btnVr.onclick = () => enter("immersive-vr").catch((e) => toast(String(e.message || e)));
  if (!ar && !vr) {
    $("xr-note").textContent = window.isSecureContext
      ? T("WebXR indisponible dans ce navigateur : aperçu à la souris ci-dessous. Ouvrez cette page dans le navigateur du Meta Quest.",
          "WebXR unavailable in this browser: mouse preview below. Open this page in the Meta Quest browser.")
      : T("WebXR exige HTTPS : ouvrez l'adresse https://…:8768/xr.", "WebXR requires HTTPS: open the https://…:8768/xr address.");
  }
})();

recenter();
loadLayout();
setPanelDensity(quality().density);
connect();
// Le casque rappelle au bureau qu'il lit lui-même les réponses (le Mac se tait).
setInterval(() => { if (state.connected && state.voice) send({ type: "xr-voice", on: true }); }, 10000);

// Accès de débogage (console du casque via chrome://inspect, ou aperçu).
window.__lumenXR = {
  state, settings, speech, onTranscript, onAnswer, refreshUi, panels, apps, lookAndAsk, visionState, vision,
  placeInGaze, applyLook, pulseHeart, orbRig, resizeOrb, feedStreaming, spatial, hands, onStt, setPrivacy, settingsPanel,
  space, extras, wake, handleUtterance, onSttPartial, caption, playQueue, audio: () => ensureAudio(),
};

// Whisper dans le casque déjà choisi : modèle chargé en arrière-plan (depuis le
// cache du navigateur après le premier téléchargement).
if (settings.stt === "local") setTimeout(preloadLocalStt, 2500);
