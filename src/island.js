// ===== Lumen · Capsule « Halo » =====
// Fenêtre flottante en haut de l'écran, avec deux usages dans la même fenêtre :
//
//  - **mode toast** (par défaut) : la capsule apparaît le temps d'une
//    notification (poussée par `POST /notify` ou la commande `notify_island`)
//    puis la fenêtre se masque. C'est le comportement historique.
//  - **mode Halo** (réglage « Capsule Halo ») : la capsule reste affichée en
//    permanence, repliée en pastille. Elle montre en direct les agents au
//    travail, les notifications du centre (cloche, Fluxo, rappels, Heartbeat)
//    et l'heure, et s'ouvre en panneau au clic.
//
// Le nom « Halo » est volontairement distinct de toute marque existante.

import { icon as lumenIcon, hasIcon as lumenHasIcon } from "./lib/icons.js";
import { markdownToHtml, looksLikeMarkdown } from "./lib/markdown.js";
import { resolvedTheme, onAppearanceChange } from "./lib/theme.js";
import { humanStep } from "./lib/agent-steps.js";
import { agentAvatarHTML } from "./lib/agent-avatar.js";
import { playUi } from "./lib/ui-sounds.js";
import { loadHaloAgenda, loadHaloMemories } from "./lib/halo-data.js";
import { loadHaloMonitor } from "./lib/halo-monitor.js";
import { llmBackend } from "./llm.js";
import { getSamples, configuredContextWindow, onSample } from "./lib/profiler.js";

const { invoke } = window.__TAURI__.core;
const { event } = window.__TAURI__;

// Doivent rester alignés avec --isl-pad / --isl-pad-bottom (island.css). La
// marge basse est plus grande : l'ombre portée descend, et si la fenêtre s'y
// arrête net on voit une arête grise sous la capsule.
const PAD = 16;
const PAD_BOTTOM = 34;
const MIN_W = 150;
const MAX_W = 600;
const MAX_H = 560;
const FEED_MAX = 30;
const AGENT_POLL_MS = 1500;

const el = document.getElementById("island");

// --- i18n minimale ----------------------------------------------------------
// La capsule ne charge pas i18n.js (module lourd, dépendant de la barre) : elle
// n'a que quelques libellés, tenus ici dans les deux langues de Lumen.
const LANG = (localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
const STRINGS = {
  fr: {
    idle: "Lumen",
    working: "au travail",
    agents_n: "{n} agents",
    sec_agents: "En cours",
    step: "étape",
    steps_n: "{n} étapes",
    steps_1: "1 étape",
    done_ok: "tâche terminée",
    done_fail: "tâche en échec",
    sec_notifs: "Notifications",
    sec_timeline: "Déroulé",
    empty_agents: "Aucun agent au travail.",
    empty_notifs: "Aucune notification récente.",
    open_agents: "Agents",
    open_notifs: "Centre de notifications",
    open_app: "Ouvrir l'app concernée",
    close: "Replier",
    clear: "Effacer",
    dismiss: "Fermer",
    queued: "{n} en attente — cliquer pour tout voir",
    live: "en direct",
    rate_src: "taux BCE du",
    wx_feels: "ressenti",
    wx_range: "min / max",
    wx_rain: "pluie",
    wx_wind: "vent",
  },
  en: {
    idle: "Lumen",
    working: "working",
    agents_n: "{n} agents",
    sec_agents: "Running",
    step: "step",
    steps_n: "{n} steps",
    steps_1: "1 step",
    done_ok: "task done",
    done_fail: "task failed",
    sec_notifs: "Notifications",
    sec_timeline: "Timeline",
    empty_agents: "No agent at work.",
    empty_notifs: "No recent notification.",
    open_agents: "Agents",
    open_notifs: "Notification center",
    open_app: "Open the related app",
    close: "Collapse",
    clear: "Clear",
    dismiss: "Dismiss",
    queued: "{n} waiting — click to see them all",
    live: "live",
    rate_src: "ECB rate of",
    wx_feels: "feels like",
    wx_range: "min / max",
    wx_rain: "rain",
    wx_wind: "wind",
  },
};
const t = (key, vars) =>
  String(key === "agents_n" && vars?.n === 1 ? "1 agent" : STRINGS[LANG][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? "");

// --- Préférences (Réglages → Notifications) --------------------------------
// La capsule partage le localStorage de la barre : on relit les valeurs à
// chaque rendu plutôt que de les figer, pour qu'un changement s'applique tout
// de suite sans recharger la fenêtre.
const bool = (key, fallback) => {
  const v = localStorage.getItem(key);
  return v == null ? fallback : v === "true";
};
const prefs = () => ({
  // Durée d'exposition d'une notification avant le repli, en millisecondes.
  // Une info doit rester assez longtemps pour être LUE : 15 s par défaut.
  // Une valeur < 5 vient d'une version précédente (défaut de 4 s) : on la
  // traite comme non renseignée plutôt que d'imposer une durée illisible.
  hold: (() => {
    const v = parseInt(localStorage.getItem("haloHold") || "", 10);
    return Math.min(120, Number.isFinite(v) && v >= 5 ? v : 15) * 1000;
  })(),
  agents: bool("haloAgents", true),
  clock: bool("haloClock", true),
  // « Collante » : la capsule reste tant qu'il reste des notifications non lues
  // et qu'on ne l'a pas fermée à la main.
  sticky: bool("haloSticky", false),
});

// Le clair/sombre vient des jetons (`data-dt-theme`, posé par
// lib/theme-init.js avant le rendu), comme dans toutes les autres fenêtres.
// On garde la classe historique pour les feuilles tierces qui la testeraient.
function applyTheme() {
  // Le thème unifié, pas l'ancienne clé de la barre : la capsule s'ouvrait en
  // sombre chez quelqu'un qui n'avait réglé que « Interface », puisque
  // `themePreference` n'existait alors pas encore chez lui.
  document.body.classList.toggle("theme-light", resolvedTheme() === "light");
}

// Une bascule venue d'ailleurs (barre de chat, bureau, Paramètres) doit
// atteindre la capsule : c'est une fenêtre à part, elle ne reçoit rien d'autre.
onAppearanceChange(applyTheme);

// --- Icônes : jeu Lucide partagé de Lumen (lib/icons.js) --------------------
const KIND_ICON = {
  info: "bell",
  success: "circle-check",
  warn: "warn",
  error: "error",
  prompt: "chat",
  progress: "bolt",
  thinking: "sparkles",
};
const svg = (name) => lumenIcon(name) || lumenIcon("bell");

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const clock = () =>
  new Date().toLocaleTimeString(LANG === "en" ? "en-GB" : "fr-FR", { hour: "2-digit", minute: "2-digit" });

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  return `${Math.round(s / 3600)}h`;
}

// ===== État ================================================================
let halo = false; // mode capsule persistante
let view = "pill"; // pill | alert | panel
let agents = []; // [{ id, name, task, since }]
// Dernière étape (appel d'outil/skill) vue par agent : `agent-step` arrive à
// chaque appel, on l'affiche en direct sur la pastille tant qu'elle est fraîche.
let steps = {}; // id -> { skill, icon, tone, ts } (libellé déjà humanisé)
// Compteurs du run en cours, par agent : étapes faites, échecs, début.
let runStats = {}; // id -> { n, fails, since }
// Fin de run tout juste constatée : la pastille la célèbre un instant.
let doneFlash = null; // { agentId, ok, ts }
const DONE_FLASH_MS = 2600;
const STEP_TTL = 25000;
let agentNames = {}; // id -> nom lisible (cache de `agent_list`)
let agentById = {}; // id -> fiche (avatar), même cache
// Petit avatar de l'agent devant son nom dans la capsule.
function avatarFor(id, state = "idle") {
  const a = agentById[id];
  return a ? `<span class="halo-av" style="display:inline-grid;vertical-align:-4px;margin-right:5px">${agentAvatarHTML(a, { size: 18, hands: false, state })}</span>` : "";
}
// Timeline du run en cours : TOUT ce que l'agent fait, dans l'ordre d'arrivée
// (raisonnement compris). La pastille n'en montre qu'une ligne à la fois ; le
// panneau les montre toutes.
let timeline = []; // [{ agentId, kind, label, input, result, ok, ts }]
const TIMELINE_MAX = 60;
let feed = []; // [{ id, kind, title, body, ts }]
let unread = 0;
let collapseTimer = null;
let hoverExpandTimer = null;
let pointerInside = false;
let dropping = false; // fichier en cours de glisser au-dessus de la capsule
// La fenêtre native est-elle affichée ? Sert à savoir s'il faut continuer à
// sonder les agents hors mode Halo (une fenêtre masquée n'a rien à rafraîchir).
let visible = false;

// File des notifications : une à la fois dans la capsule.
const queue = [];
let current = null; // notification affichée
let holdTimer = null;
// Temps pendant lequel la capsule reste en pastille après la dernière
// notification, avant de s'effacer : sans ce battement on ne verrait jamais la
// capsule se refermer, seulement des cartes qui disparaissent.
const IDLE_HOLD = 2400;
let idleTimer = null;
// Décompte de la notification affichée : il se met en PAUSE dès que le pointeur
// entre sur la capsule, pour laisser le temps de lire.
let holdLeft = 0;
let holdStart = 0;
// Masquage différé (le temps du fondu) : il doit être annulable, sinon une
// notification arrivant pendant la sortie rouvrirait la capsule… juste avant
// que le masquage en attente ne la fasse disparaître.
let hideTimer = null;
// Les étapes d'un agent arrivent en rafale (un appel d'outil peut durer 200 ms).
// On les défile à une par seconde minimum, sinon elles clignotent sans être
// lisibles.
const STEP_MIN_MS = 1000;
const STEP_QUEUE_MAX = 12;
let stepQueue = [];
let stepTimer = null;

// ===== Squelette ===========================================================
// Le DOM est construit une seule fois : seules les valeurs sont réécrites
// ensuite, pour que les transitions CSS aient un élément stable à animer.
el.className = "halo";
el.dataset.mode = "toast";
el.dataset.view = "pill";
el.dataset.state = "hidden";
el.dataset.busy = "0";
el.innerHTML = `
  <div class="halo-shell">
    <div class="halo-view halo-view-pill">
      <div class="halo-pill" role="button" tabindex="0">
        <span class="halo-glyph"><i></i><span class="halo-step-ic"></span></span>
        <span class="halo-label"></span>
        <span class="halo-tail">
          <span class="halo-tick"></span>
          <span class="halo-nsteps"></span>
          <span class="halo-eq"><i></i><i></i><i></i></span>
          <span class="halo-clock"></span>
          <span class="halo-monitor-peek"></span>
          <span class="halo-badge" data-count="0"></span>
        </span>
      </div>
    </div>
    <div class="halo-view halo-view-alert"><div class="halo-alert"></div></div>
    <div class="halo-view halo-view-panel"><div class="halo-panel"></div></div>
  </div>`;

const shell = el.querySelector(".halo-shell");
const pillEl = el.querySelector(".halo-pill");
const labelEl = el.querySelector(".halo-label");
const clockEl = el.querySelector(".halo-clock");
const badgeEl = el.querySelector(".halo-badge");
const glyphEl = el.querySelector(".halo-glyph");
const stepIcEl = el.querySelector(".halo-step-ic");
const tickEl = el.querySelector(".halo-tick");
const nstepsEl = el.querySelector(".halo-nsteps");
let glyphKey = "";
const alertEl = el.querySelector(".halo-alert");
const panelEl = el.querySelector(".halo-panel");

// Attend deux frames pour laisser le layout se stabiliser (polices, line-clamp)
// AVANT de mesurer. Repli sur un timer : une fenêtre masquée ou occultée ne
// reçoit pas de `requestAnimationFrame`, et la capsule resterait alors bloquée
// sur une notification jamais affichée.
function afterLayout(cb) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cb();
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 250);
}

// ===== Dimensionnement de la fenêtre native ================================
// La capsule ne « saute » pas d'une taille à l'autre : on pose l'ancienne
// taille sur la coque, puis la nouvelle, et la transition CSS fait le morphing.
// La fenêtre native, elle, prend d'emblée le maximum des deux (sinon le contenu
// serait rogné pendant l'animation) et se resserre à la fin.
const MORPH_MS = 420;
let morphTimer = null;
// Taille visée par le morphing en cours : un nouvel appel qui vise la même
// chose doit le laisser finir au lieu de le réinitialiser.
let morphTarget = null;
// Dernière taille connue de la coque, point de départ du prochain morphing.
let lastBox = { w: 0, h: 0 };

function clampW(v) {
  return Math.round(Math.min(el.dataset.style === "notch" ? MAX_W : 460, Math.max(MIN_W, v)));
}
function clampH(v) {
  return Math.round(Math.min(el.dataset.style === "notch" ? MAX_H : 420, v));
}

function applyWindowSize(w, h) {
  // Style Encoche : la capsule touche le bord supérieur, pas de marge au-dessus.
  const top = el.dataset.style === "notch" ? 0 : PAD;
  invoke("island_set_size", { width: w + PAD * 2, height: h + top + PAD_BOTTOM }).catch(() => {});
}

// ===== Style « Encoche » ====================================================
// Réglages → Notifications → Mode d'encoche. La capsule se colle au bord
// supérieur et prolonge l'encoche du Mac : la pastille met le contenu dans les
// deux « oreilles », de part et d'autre de la caméra (largeur mesurée par
// Rust), et les vues hautes commencent sous l'encoche.
function applyStyle(info) {
  const notch = info?.style === "notch";
  el.dataset.style = notch ? "notch" : "float";
  document.body.dataset.style = el.dataset.style;
  const root = document.documentElement.style;
  const nw = Number(info?.notchWidth) || 0;
  const nh = Number(info?.notchHeight) || 0;
  root.setProperty("--notch-w", `${notch && nw ? Math.round(nw + 8) : 0}px`);
  root.setProperty("--notch-h", `${notch && nh ? Math.round(nh) : 0}px`);
  lastBox = { w: 0, h: 0 };
  el.dataset.rest = "";
  updateRest();
  if (view === "panel") renderPanel();
  morph();
}
event.listen("halo-style", (e) => applyStyle(e.payload));

// Couleurs de l'orbe sur la mini-orbe de la pastille (même palette partout).
function applyOrbColors() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem("orbColors") || "null"); } catch { c = null; }
  if (!Array.isArray(c) || c.length < 3) return;
  const r = document.documentElement.style;
  c.slice(0, 5).forEach((hex, i) => r.setProperty(`--orb-c${i}`, hex));
}
applyOrbColors();
window.addEventListener("storage", (e) => { if (e.key === "orbColors") applyOrbColors(); });

// ===== Déposer un fichier sur la capsule ===================================
// « Pose une question sur ce fichier » : la capsule s'ouvre en cible de dépôt,
// puis transmet les fichiers à la barre (évènement `capsule-drop`) et la met
// au premier plan. Plafond de 25 Mo : au-delà, mieux vaut la barre elle-même.
const DROP_MAX = 25 * 1024 * 1024;
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (!dropping) { dropping = true; el.dataset.drop = "1"; playUi("peek"); updateRest(); renderPill(); }
});
document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener("dragleave", (e) => {
  if (e.relatedTarget) return;
  dropping = false; delete el.dataset.drop; updateRest();
});
document.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropping = false;
  delete el.dataset.drop;
  playUi("drop");
  let total = 0;
  const files = [];
  for (const f of Array.from(e.dataTransfer.files || [])) {
    total += f.size;
    if (total > DROP_MAX) break;
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    files.push({ name: f.name, type: f.type, data: btoa(bin) });
  }
  if (files.length) {
    await event.emit("capsule-drop", { files });
    invoke("capsule_focus_main").catch(() => {});
  }
  updateRest();
});

// Demande de Lumen (accord, choix…) répondue ailleurs : la carte s'efface.
event.listen("user-request-done", (e) => {
  if (current?.request_id && current.request_id === e.payload?.id) collapse();
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].request_id === e.payload?.id) queue.splice(i, 1);
});

// Mesure la taille naturelle du contenu courant, coque libérée de toute
// contrainte inline.
function naturalBox() {
  const wasTransition = shell.style.transition;
  shell.style.transition = "none";
  shell.style.width = "";
  shell.style.height = "";
  void shell.offsetWidth;
  const box = { w: clampW(shell.scrollWidth), h: clampH(shell.scrollHeight) };
  shell.style.transition = wasTransition;
  return box;
}

// Un seul morphing à la fois : plusieurs appels dans la même frame (changement
// de vue + contenu) sont fusionnés, sinon chacun repartait d'une mesure prise
// au milieu de l'animation du précédent et la capsule oscillait.
let morphPending = false;
function morph() {
  if (morphPending) return;
  morphPending = true;
  afterLayout(() => {
    morphPending = false;
    runMorph();
  });
}

function runMorph() {
  // Point de départ : la taille RÉELLEMENT affichée (éventuellement au milieu
  // d'une animation), pas la dernière cible visée.
  const rect = shell.getBoundingClientRect();
  const from = { w: Math.round(rect.width), h: Math.round(rect.height) };
  const to = naturalBox();
  // Garde anti-tremblement : au repos, chaque rafraîchissement de la pastille
  // (horloge, agents) remesurait la coque PENDANT l'animation d'entrée de la
  // vue (translateY de 4 px), et la mesure alternait de 2 px d'un tour à
  // l'autre. La fenêtre native suivait — et le bas de la capsule « respirait »
  // en continu. Un écart de 2 px ou moins n'est pas une nouvelle taille.
  if (!morphTimer && lastBox.w && Math.abs(to.w - lastBox.w) <= 2 && Math.abs(to.h - lastBox.h) <= 2) {
    return;
  }
  lastBox = to;
  // Un morphing vise déjà cette taille : on remet l'état d'arrivée et on le
  // laisse aller au bout. Sans ça, chaque appel voisin (changement de vue,
  // rafraîchissement de la pastille) coupait l'animation en cours.
  if (morphTimer && morphTarget && morphTarget.w === to.w && morphTarget.h === to.h) {
    shell.style.transition = "";
    shell.style.width = `${to.w}px`;
    shell.style.height = `${to.h}px`;
    return;
  }
  clearTimeout(morphTimer);
  morphTimer = null;
  // Première apparition, ou rien à animer : on pose directement la taille.
  if (!from.w || !from.h || (from.w === to.w && from.h === to.h)) {
    morphTarget = null;
    shell.style.transition = "none";
    shell.style.width = "";
    shell.style.height = "";
    applyWindowSize(to.w, to.h);
    afterLayout(() => (shell.style.transition = ""));
    return;
  }
  // La fenêtre prend tout de suite la place nécessaire aux deux tailles, sinon
  // le contenu serait rogné pendant l'animation.
  morphTarget = to;
  applyWindowSize(Math.max(from.w, to.w), Math.max(from.h, to.h));
  // Ordre CRUCIAL : la taille de départ est posée SANS transition, on force le
  // recalcul, PUIS on réactive la transition. Une transition activée dans la
  // même passe que le changement de taille ne démarre pas (le style d'avant
  // portait encore `transition: none`) — c'est ce qui faisait sauter la capsule
  // d'une taille à l'autre au lieu de l'animer.
  shell.style.transition = "none";
  shell.style.width = `${from.w}px`;
  shell.style.height = `${from.h}px`;
  void shell.offsetWidth; // recalcul avec `transition: none`
  shell.style.transition = "";
  void shell.offsetWidth; // recalcul AVEC la transition : le style d'avant la
  // porte désormais, la taille peut changer et l'animation démarre. Tout est
  // synchrone : pas de dépendance à une frame, qui n'arrive pas si la fenêtre
  // est occultée.
  shell.style.width = `${to.w}px`;
  shell.style.height = `${to.h}px`;
  morphTimer = setTimeout(() => {
    morphTimer = null;
    morphTarget = null;
    // Fin du morphing : on rend sa liberté à la coque et on resserre la
    // fenêtre sur la taille réellement occupée.
    shell.style.width = "";
    shell.style.height = "";
    applyWindowSize(to.w, to.h);
  }, MORPH_MS);
}

// Nom historique conservé : tout appel à `fit()` déclenche le morphing.
const fit = morph;

function setView(next) {
  if (view === next) return;
  view = next;
  el.dataset.view = next;
  fit();
}

// Anime l'entrée de la capsule (elle sort de l'état masqué).
function reveal() {
  if (el.dataset.state === "shown") return;
  el.dataset.state = "enter";
  requestAnimationFrame(() => (el.dataset.state = "shown"));
  // Filet : sans frame (fenêtre occultée), l'état final est posé quand même.
  setTimeout(() => {
    if (el.dataset.state === "enter") el.dataset.state = "shown";
  }, 120);
}



// ===== Vue pastille ========================================================
function renderPill() {
  const p = prefs();
  const live = freshStep();
  const busy = p.agents && agents.length > 0;
  const flash = doneFlash && Date.now() - doneFlash.ts < DONE_FLASH_MS ? doneFlash : null;
  el.dataset.busy = (busy || live) && !flash ? "1" : "0";
  el.dataset.done = flash ? (flash.ok ? "ok" : "fail") : "";
  clockEl.textContent = p.clock ? clock() : "";
  clockEl.hidden = !p.clock;
  badgeEl.dataset.count = String(unread);
  badgeEl.textContent = unread > 9 ? "9+" : String(unread);

  // Icône de l'étape en cours à la place du point : on VOIT ce que fait
  // l'agent (loupe, crayon, base…). Elle n'est repeinte que si elle change,
  // pour que son animation d'entrée ne rejoue pas à chaque sondage.
  const focusId = agents.length === 1 ? agents[0].id : live?.agentId;
  const st = flash ? null : steps[focusId] && Date.now() - steps[focusId].ts <= STEP_TTL ? steps[focusId] : live;
  const key = flash ? `done:${flash.ok}` : st ? `${st.icon}:${st.ts}` : "";
  if (key !== glyphKey) {
    glyphKey = key;
    const name = flash ? (flash.ok ? "check" : "x") : st?.icon;
    stepIcEl.innerHTML = name ? svg(name) : "";
    glyphEl.classList.toggle("has-step", Boolean(name));
    glyphEl.dataset.tone = flash ? (flash.ok ? "ok" : "fail") : st?.tone || "";
    // Relance l'animation d'apparition (retrait + reflow + ajout).
    stepIcEl.classList.remove("is-in");
    void stepIcEl.offsetWidth;
    if (name) stepIcEl.classList.add("is-in");
  }
  const stats = runStats[focusId];
  nstepsEl.textContent = !flash && stats?.n ? t(stats.n === 1 ? "steps_1" : "steps_n", { n: stats.n }) : "";
  nstepsEl.hidden = !nstepsEl.textContent;

  if (dropping) {
    labelEl.innerHTML = `<span>${esc(LANG === "en" ? "Drop to ask Lumen" : "Dépose pour demander à Lumen")}</span>`;
  } else if (flash) {
    const who = agentNames[flash.agentId] || t("idle");
    labelEl.innerHTML = `${avatarFor(flash.agentId, flash.ok ? "done" : "fail")}${esc(who)} <span class="halo-sub">· ${esc(t(flash.ok ? "done_ok" : "done_fail"))}</span>`;
  } else if (busy || live) {
    // `live` (étape la plus fraîche) tient la pastille même quand
    // `agents_running` n'a pas encore rattrapé le début du run : c'est elle
    // qui fait voir l'agent travailler.
    const who = agents.length === 1
      ? agents[0].name
      : agents.length > 1
        ? t("agents_n", { n: agents.length })
        : agentNames[live?.agentId] || t("working");
    // Détail : l'étape en cours, en langage courant (« Lit « cv.pdf » »),
    // la tâche à défaut. Avec plusieurs agents, l'étape la plus récente
    // parle pour l'équipe.
    const detail = stepOf(focusId) || (agents.length === 1 ? agents[0].task : "") || "";
    const face = avatarFor(agents.length === 1 ? agents[0].id : agents.length ? "" : live?.agentId, "work");
    labelEl.innerHTML = detail
      ? `${face}${esc(who)} <span class="halo-sub">· <span class="halo-step-tx" data-k="${esc(key)}">${esc(detail)}</span></span>`
      : `${face}${esc(who)} <span class="halo-sub">${esc(t("working"))}</span>`;
  } else if (unread > 0 && feed[0]) {
    labelEl.innerHTML = `${esc(feed[0].title)} <span class="halo-sub">· ${esc(feed[0].body || "")}</span>`;
  } else {
    labelEl.innerHTML = `<span class="halo-sub">${esc(t("idle"))}</span>`;
  }
  updateRest();
  if (view === "pill") fit();
}

// Mode Encoche « au repos » : rien à montrer → la capsule rentre dans
// l'encoche (invisible, elle se confond avec elle) et ressort au survol.
function updateRest() {
  const rest = el.dataset.style === "notch"
    && localStorage.getItem("haloRest") !== "show"
    && view === "pill" && !current && !pointerInside && !dropping
    && el.dataset.busy !== "1" && !el.dataset.done && unread === 0;
  const next = rest ? "1" : "0";
  if (el.dataset.rest === next) return;
  el.dataset.rest = next;
  fit();
}

/// Micro-animation à droite de la pastille quand une étape se termine :
/// coche qui se dessine (succès) ou croix qui tremble (échec).
function flashTick(ok) {
  playUi(ok ? "tick" : "error");
  tickEl.innerHTML = svg(ok ? "check" : "x");
  tickEl.dataset.tone = ok ? "ok" : "fail";
  tickEl.classList.remove("is-on");
  void tickEl.offsetWidth;
  tickEl.classList.add("is-on");
}


// ===== Timeline du run =====================================================
// Une ligne par évènement d'agent : appel d'outil ou raisonnement. On la
// garde en mémoire (la capsule ne survit pas à une fermeture) et on la
// complète, à l'ouverture du panneau, avec l'activité persistée par Rust —
// sinon une capsule ouverte en cours de route n'aurait que la fin de l'histoire.
function recordStep(p) {
  if (!p?.agent_id) return;
  const ts = Number(p.ts) ? Number(p.ts) * 1000 : Date.now();
  const label = String(p.skill || "…");
  // Même évènement reçu deux fois (écoute live + relecture de l'activité).
  if (timeline.some((r) => r.ts === ts && r.label === label && r.agentId === p.agent_id)) return;
  timeline.push({
    agentId: p.agent_id,
    kind: p.kind === "thought" ? "thought" : "tool",
    label,
    input: String(p.input || ""),
    result: String(p.result || ""),
    ok: p.success !== false,
    ts,
  });
  if (timeline.length > TIMELINE_MAX) timeline.splice(0, timeline.length - TIMELINE_MAX);
  if (view === "panel") renderPanel();
}

// Complète la timeline avec ce que Rust a persisté pour les agents en cours.
// Les doublons sont écartés à l'horodatage + libellé : le même évènement peut
// arriver par l'évènement live ET par la lecture du fichier d'activité.
async function loadTimeline() {
  const ids = agents.map((a) => a.id);
  if (!ids.length) return;
  const seen = new Set(timeline.map((r) => `${r.ts}|${r.label}`));
  for (const id of ids) {
    let entries = [];
    try {
      entries = (await invoke("agent_activity", { id })) || [];
    } catch (_) {
      continue;
    }
    for (const e of entries.slice(-TIMELINE_MAX)) {
      if (e.kind !== "step" && e.kind !== "thought") continue;
      const ts = Number(e.ts) * 1000;
      const label = e.kind === "thought" ? String(e.skill || "réflexion") : String(e.skill || "");
      if (seen.has(`${ts}|${label}`)) continue;
      seen.add(`${ts}|${label}`);
      timeline.push({
        agentId: id,
        kind: e.kind === "thought" ? "thought" : "tool",
        label,
        input: String(e.input || ""),
        result: String(e.result || ""),
        ok: e.success !== false,
        ts,
      });
    }
  }
  timeline.sort((a, b) => a.ts - b.ts);
  if (timeline.length > TIMELINE_MAX) timeline.splice(0, timeline.length - TIMELINE_MAX);
  if (view === "panel") renderPanel();
}

const hhmmss = (ts) =>
  new Date(ts).toLocaleTimeString(LANG === "en" ? "en-GB" : "fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function timelineRow(r, i) {
  const h = humanStep({ kind: r.kind, skill: r.label, input: r.input, result: r.result, success: r.ok }, LANG);
  const detail = (h.detail || (r.kind === "thought" ? "" : r.input)).replace(/\s+/g, " ").trim();
  // La plus récente (en tête) est « vivante » tant que son agent travaille.
  const live = i === 0 && agents.some((a) => a.id === r.agentId);
  const mark = r.kind === "thought" ? "" : svg(r.ok ? "check" : "x");
  return `
    <div class="halo-tl ${r.kind === "thought" ? "is-thought" : ""} ${r.ok ? "" : "is-error"} ${live ? "is-live" : ""}" data-tone="${esc(h.tone)}" title="${esc(r.label)}">
      <span class="halo-tl-ic">${agentAvatarHTML(agentById[r.agentId] || { id: r.agentId }, { size: 24, hands: false, state: live ? "work" : r.ok ? "done" : "fail", title: agentNames[r.agentId] || r.agentId || "Agent" })}</span>
      <span class="halo-tl-body">
        <span>${esc(agentNames[r.agentId] || r.agentId || "Agent")}</span>
        <b>${esc(h.text)}</b>
        ${detail ? `<span>${esc(detail)}</span>` : ""}
      </span>
      <span class="halo-tl-side">
        <span class="halo-tl-dot">${mark}</span>
        <span class="halo-tl-time">${esc(hhmmss(r.ts))}</span>
      </span>
    </div>`;
}

// ===== Vue panneau =========================================================
function agentRow(a) {
  const st = runStats[a.id];
  const cur = steps[a.id] && Date.now() - steps[a.id].ts <= STEP_TTL ? steps[a.id] : null;
  return `
    <div class="halo-row is-live halo-agent" data-open="agents">
      <span class="halo-row-ic halo-agent-ic">${svg(cur?.icon || "agents")}</span>
      <span class="halo-row-txt"><b>${esc(a.name)}${st?.n ? ` <em class="halo-agent-n">${esc(t(st.n === 1 ? "steps_1" : "steps_n", { n: st.n }))}</em>` : ""}</b><span>${esc(stepOf(a.id) || a.task || t("working"))}</span>
        <i class="halo-agent-bar"><i></i></i></span>
      <span class="halo-row-time" data-ts="${a.since}">${esc(ago(a.since))}</span>
    </div>`;
}

// Le corps d'une notification vient souvent d'un modèle, donc en Markdown :
// on le rend (détail, alerte) ou on le dépouille (ligne compacte) — mais on
// ne l'affiche plus avec ses « ** » apparents.
function bodyHtml(text) {
  const raw = String(text || "");
  return looksLikeMarkdown(raw) ? `<div class="md">${markdownToHtml(raw)}</div>` : esc(raw);
}
function bodyPlain(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
}

// ---- Résumés par un petit modèle -------------------------------------------
// Quand llama.cpp est là avec un petit modèle installé, chaque notification
// longue est condensée en une ligne par le backend (`llama_summarize`, serveur
// dédié, cache). La ligne du fil montre le résumé, le survol donne le texte
// entier ; sans modèle, la ligne montre le début du texte, comme avant.
const SUMMARY_MIN_CHARS = 140;
const summaries = new Map();   // id → texte (ou "" quand indisponible)
const summaryPending = new Set();
let summaryAvailable = null;   // null = pas encore sondé

async function summaryCapable() {
  if (summaryAvailable !== null) return summaryAvailable;
  try { summaryAvailable = !!(await invoke("llama_summary_status"))?.available; }
  catch { summaryAvailable = false; }
  // Un modèle installé plus tard doit être vu : on resonde toutes les 5 min.
  setTimeout(() => { summaryAvailable = null; }, 5 * 60_000);
  return summaryAvailable;
}
function needsSummary(n) { return bodyPlain(n.body).length >= SUMMARY_MIN_CHARS; }
async function requestSummary(n) {
  if (!n || summaries.has(n.id) || summaryPending.has(n.id) || !needsSummary(n)) return;
  if (!(await summaryCapable())) return;
  summaryPending.add(n.id);
  try {
    const text = await invoke("llama_summarize", { text: `${n.title}\n${bodyPlain(n.body)}`, lang: LANG });
    summaries.set(n.id, String(text || "").trim());
  } catch { summaries.set(n.id, ""); }
  finally { summaryPending.delete(n.id); }
  // Réécrit la ligne en place : pas de rendu complet, qui ferait sauter le
  // défilement du panneau sous la souris.
  const row = panelEl?.querySelector(`.halo-row[data-notif="${CSS.escape(n.id)}"] .halo-row-txt`);
  if (row && summaries.get(n.id)) { row.querySelector("span").textContent = summaries.get(n.id); row.classList.add("has-summary"); row.closest(".halo-row").title = bodyPlain(n.body); }
  if (current?.id === n.id) { const t = alertEl.querySelector(".isl-summary"); if (t) t.textContent = summaries.get(n.id) || ""; }
}

function feedRow(n) {
  const summary = summaries.get(n.id);
  const line = summary || bodyPlain(n.body);
  return `
    <div class="halo-row ${n.kind === "error" ? "is-error" : ""}" data-notif="${esc(n.id)}" title="${esc(summary ? bodyPlain(n.body) : "")}">
      <span class="halo-row-ic">${svg(KIND_ICON[n.kind] || "bell")}</span>
      <span class="halo-row-txt${summary ? " has-summary" : ""}"><b>${esc(n.title)}</b><span>${esc(line)}</span></span>
      <span class="halo-row-time" data-ts="${n.ts}">${esc(ago(n.ts))}</span>
    </div>`;
}


// Détail d'une notification : titre, texte entier, heure, et l'accès à l'app
// concernée quand elle est nommée.
function detailBlock(n) {
  if (!n) return "";
  const app = APP_COMMANDS[n.app] ? n.app : "";
  return `
    <div class="halo-detail ${n.kind === "error" ? "is-error" : ""}">
      <div class="halo-detail-head">
        <span class="halo-row-ic">${svg(n.icon && lumenHasIcon(n.icon) ? n.icon : KIND_ICON[n.kind] || "bell")}</span>
        <b>${esc(n.title)}</b>
        <span class="halo-row-time" data-ts="${n.ts}">${esc(ago(n.ts))}</span>
      </div>
      ${summaries.get(n.id) ? `<div class="halo-detail-summary">${esc(summaries.get(n.id))}</div>` : ""}
      ${n.body ? `<div class="halo-detail-body">${bodyHtml(n.body)}</div>` : ""}
      ${app ? `<div class="halo-detail-foot"><button class="isl-btn" data-app="${esc(app)}">${esc(t("open_app"))}</button></div>` : ""}
    </div>`;
}

let notchTab = "home";
let notchPeek = false;
let monitor = null;
let monitorPending = false;
async function refreshMonitor() {
  if (monitorPending || el.dataset.style !== "notch" || (!halo && !visible)) return;
  monitorPending = true;
  try {
    const backend = llmBackend();
    const name = backend.llama ? "llama.cpp" : backend.applefm ? "applefm" : backend.api ? "api" : "ollama";
    let chatContext = null;
    try { chatContext = JSON.parse(localStorage.getItem("haloChatContext") || "null"); } catch {}
    monitor = await loadHaloMonitor({ invoke, ollamaGetJson: (path, url) => invoke("ollama_get_json", { path, url }), backend, configuredContext: configuredContextWindow(name), samples: getSamples(), chatContext });
    const peek = el.querySelector(".halo-monitor-peek");
    if (peek) {
      peek.textContent = monitor.modelMemory != null ? `RAM ${(monitor.modelMemory / 1073741824).toFixed(1)}G` : "";
      peek.title = `${monitor.model || monitor.backend} · ${monitor.ctxUsed ?? "?"}/${monitor.ctxTotal ?? "?"} tokens`;
    }
    if (view === "panel" && (notchTab === "home" || notchPeek)) {
      const expanded = panelEl.querySelector(".halo-monitor-processes")?.open;
      renderPanel();
      const details = panelEl.querySelector(".halo-monitor-processes");
      if (details) details.open = !!expanded;
    }
  } catch (error) {
    monitor = { backend: "", model: "", slots: [], errors: [String(error?.message || error)], ts: Date.now() };
    if (view === "panel" && notchTab === "monitor") renderPanel();
  } finally { monitorPending = false; }
}
setInterval(refreshMonitor, 3000);
// Vue « Maintenant » : compte à rebours des rendez-vous et agenda frais.
setInterval(() => {
  if (view !== "panel" || el.dataset.style !== "notch" || notchTab !== "home") return;
  refreshHaloData("home");
}, 60000);
onSample(() => { if (notchTab === "monitor") refreshMonitor(); });
function monitorContent() {
  const tr = bilingual, m = monitor;
  if (!m) return `<p role="status">${esc(tr("Chargement des mesures…", "Loading metrics…"))}</p>`;
  const bytes = value => value == null ? "—" : `${(value / 1073741824).toFixed(1)} Go`;
  const metric = (label, value, detail = "") => `<section class="halo-monitor-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></section>`;
  const sys = m.system;
  const used = m.ctxUsed, total = m.ctxTotal;
  const source = m.ctxSource === "slot" ? tr("Slot serveur", "Server slot") : m.ctxSource === "estimate" ? tr("Conversation · estimation", "Conversation · estimate") : m.ctxSource === "sample" ? tr("Dernier appel · prompt", "Last call · prompt") : tr("Mesure indisponible", "Metric unavailable");
  const sample = m.sample;
  return `<div class="halo-monitor-model"><span class="halo-section-title">${esc(m.backend)}${m.accelerator ? ` · ${esc(m.accelerator)}` : ""}</span><h2>${esc(m.model || tr("Aucun modèle sélectionné", "No selected model"))}</h2><p>${esc(m.loaded === true ? tr("Chargé", "Loaded") : m.loaded === false ? tr("Non chargé", "Not loaded") : tr("Exécution distante ou gérée", "Remote or managed runtime"))}</p></div><div class="halo-monitor-grid">${metric(tr("RAM du modèle", "Model RAM"), bytes(m.modelMemory), m.memorySource === "rss" ? tr("Serveur + contexte · RSS", "Server + context · RSS") : tr("Allocation hors VRAM · Ollama", "Allocation excluding VRAM · Ollama"))}${metric("VRAM", bytes(m.vram), tr("Allocation GPU", "GPU allocation"))}${metric(tr("Contexte", "Context"), `${used ?? "—"} / ${total ?? "—"}`, source)}${metric(tr("Génération", "Generation"), sample?.tps > 0 ? `${sample.tps.toFixed(1)} tok/s` : "—", sample ? `${sample.app} · ${ago(sample.ts)}` : tr("Aucun appel mesuré", "No measured call"))}</div>${used != null && total > 0 ? `<div class="halo-monitor-track" aria-label="${esc(tr("Occupation du contexte", "Context usage"))}"><span style="width:${Math.min(100, Math.max(0, used / total * 100))}%"></span></div>` : ""}${m.contextTs ? `<p>${esc(source)} · ${esc(ago(m.contextTs))}</p>` : ""}<details class="halo-monitor-processes"><summary>${esc(tr("Processus du modèle", "Model processes"))}</summary>${(sys?.processes || []).map(p => `<div class="halo-pref-row"><span>${esc(p.name)} · PID ${p.pid}</span><span>${bytes(p.rss)} · CPU ${Number(p.cpu).toFixed(1)} %</span></div>`).join("")}</details>${m.errors.length ? `<p class="halo-data-error" role="status">${esc(m.errors.join(" · "))}</p>` : ""}<p class="halo-monitor-updated">${esc(tr("Relevé toutes les 3 s", "Updated every 3 s"))} · ${esc(clock())}</p>`;
}
const haloData = {
  home: { items: [], loaded: false }, memory: { items: [], loaded: false },
  files: { spaces: [], items: [], id: "", path: "", preview: null, loaded: false },
};
async function refreshHaloData(key = notchTab) {
  const state = haloData[key];
  if (!state || state.loading) return;
  state.loading = true;
  state.error = "";
  if (view === "panel") renderPanel();
  try {
    if (key === "home") Object.assign(state, await loadHaloAgenda(invoke));
    if (key === "memory") Object.assign(state, await loadHaloMemories(invoke));
    if (key === "files") {
      const spaces = await invoke("sandbox_list");
      if (!Array.isArray(spaces)) throw new Error(bilingual("Réponse fichiers invalide", "Invalid file response"));
      state.spaces = spaces;
      if (!spaces.some(s => s.id === state.id)) { state.id = spaces[0]?.id || ""; state.path = ""; state.preview = null; }
      state.items = state.id ? await invoke("sandbox_read_dir", { id: state.id, path: state.path }) : [];
      if (!Array.isArray(state.items)) throw new Error(bilingual("Réponse dossier invalide", "Invalid folder response"));
    }
    state.loaded = true;
  } catch (error) { state.error = String(error?.message || error); }
  finally {
    state.loading = false;
    if (view === "panel" && notchTab === key) renderPanel();
  }
}
const isLocked = (msg) => /SESSION_LOCKED|verrouill|locked/i.test(String(msg || ""));
/** Écran de déverrouillage en place d'une erreur « session verrouillée ». */
function lockedCard(key) {
  const tr = bilingual;
  return `<form class="halo-lock" data-halo-unlock="${key}"><span class="halo-lock-ic">${svg("lock")}</span><h2>${esc(tr("Session verrouillée", "Session locked"))}</h2><p>${esc(tr("Saisis ton mot de passe Lumen pour afficher ces données.", "Enter your Lumen password to show this data."))}</p><div class="halo-lock-row"><input type="password" autocomplete="current-password" placeholder="${esc(tr("Mot de passe", "Password"))}" aria-label="${esc(tr("Mot de passe", "Password"))}" required><button class="isl-btn" type="submit">${esc(tr("Déverrouiller", "Unlock"))}</button></div><p class="halo-data-error" role="alert" hidden></p></form>`;
}
function dataStatus(key) {
  const state = haloData[key];
  const error = state.error || state.errors?.join(" · ");
  if (!state.loading && isLocked(error)) return lockedCard(key);
  return `${state.loading ? `<p role="status">${esc(bilingual("Chargement…", "Loading…"))}</p>` : ""}${error ? `<p class="halo-data-error" role="alert">${esc(error)}</p>` : ""}<button class="isl-btn halo-refresh" data-halo-refresh="${key}" ${state.loading ? "disabled" : ""}>${esc(bilingual("Actualiser", "Refresh"))}</button>`;
}
event.listen("reminders-updated", () => {
  if (view === "panel" && notchTab === "home") refreshHaloData("home");
});
panelEl.addEventListener("click", async (e) => {
  const refresh = e.target.closest("[data-halo-refresh]");
  if (refresh) return refreshHaloData(refresh.dataset.haloRefresh);
  const file = e.target.closest("[data-halo-file]");
  const up = e.target.closest("[data-halo-up]");
  const state = haloData.files;
  if (up) { state.preview = null; state.path = state.path.split("/").slice(0, -1).join("/"); return refreshHaloData("files"); }
  if (!file || state.loading) return;
  const entry = state.items[Number(file.dataset.haloFile)];
  if (!entry) return;
  if (entry.is_dir) { state.path = entry.path; state.preview = null; return refreshHaloData("files"); }
  state.loading = true; state.error = "";
  renderPanel();
  try { state.preview = { name: entry.name, ...(await invoke("sandbox_read_file", { id: state.id, path: entry.path })) }; }
  catch (error) { state.error = String(error?.message || error); }
  finally { state.loading = false; if (view === "panel" && notchTab === "files") renderPanel(); }
});
panelEl.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-halo-unlock]");
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector("input"), err = form.querySelector(".halo-data-error"), btn = form.querySelector("button");
  btn.disabled = true; err.hidden = true;
  let ok = false;
  try { ok = await invoke("session_unlock", { profileId: null, password: input.value }); } catch { ok = false; }
  input.value = "";
  if (!ok) { btn.disabled = false; err.hidden = false; err.textContent = bilingual("Mot de passe incorrect.", "Wrong password."); input.focus(); return; }
  for (const key of ["files", "home", "memory"]) if (haloData[key]) haloData[key].error = "";
  refreshHaloData(form.dataset.haloUnlock);
});
panelEl.addEventListener("change", async (e) => {
  if (e.target.matches("[data-halo-space]")) {
    if (haloData.files.loading) return;
    Object.assign(haloData.files, { id: e.target.value, path: "", preview: null });
    return refreshHaloData("files");
  }
  const key = e.target.dataset.haloPref;
  if (!["haloAgents", "haloClock", "haloSticky", "haloRest", "haloHold"].includes(key)) return;
  const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  const previous = localStorage.getItem(key);
  try {
    localStorage.setItem(key, String(value));
    await event.emit("settings-updated", { [key]: value });
    updateRest(); renderPill();
  } catch (error) {
    if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous);
    const status = panelEl.querySelector(".halo-pref-status");
    if (status) status.textContent = String(error?.message || error);
  }
});
let focusDuration = 25 * 60;
let focusRemaining = focusDuration;
let focusDeadline = 0;
const bilingual = (fr, en) => LANG === "en" ? en : fr;
const focusTime = () => {
  const seconds = focusDeadline ? Math.max(0, Math.ceil((focusDeadline - Date.now()) / 1000)) : focusRemaining;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
function handleFocus(action) {
  if (action === "toggle") {
    if (focusDeadline) {
      focusRemaining = Math.max(0, Math.ceil((focusDeadline - Date.now()) / 1000));
      focusDeadline = 0;
    } else {
      if (!focusRemaining) focusRemaining = focusDuration;
      focusDeadline = Date.now() + focusRemaining * 1000;
    }
  } else if (action === "reset") {
    focusDeadline = 0;
    focusRemaining = focusDuration;
  }
  renderPanel();
}
setInterval(() => {
  if (!focusDeadline) return;
  const display = panelEl.querySelector(".halo-focus-time");
  if (display) display.textContent = focusTime();
  if (Date.now() >= focusDeadline) {
    focusDeadline = 0;
    focusRemaining = 0;
    enqueue({ kind: "success", title: bilingual("Session Focus terminée", "Focus session complete"), body: bilingual("Prenez une pause avant de reprendre.", "Take a break before continuing.") });
  }
}, 1000);
panelEl.addEventListener("change", (e) => {
  if (!e.target.matches("[data-focus-duration]")) return;
  const minutes = Number(e.target.value);
  if (![25, 45, 60].includes(minutes)) return;
  focusDuration = minutes * 60;
  focusRemaining = focusDuration;
  focusDeadline = 0;
  renderPanel();
});

// ---- Vue « Maintenant » de l'encoche ------------------------------------------
// Ne montre que ce qui se passe EN CE MOMENT ou très bientôt ; une section
// vide n'est pas affichée. Ordre = urgence : ce qui attend une réponse, ce
// qui tourne, ce qui arrive, puis le reste.
function untilLabel(ts) {
  const tr = bilingual, min = Math.round((ts - Date.now()) / 60000);
  if (min <= 0) return tr("maintenant", "now");
  if (min < 60) return tr(`dans ${min} min`, `in ${min} min`);
  const d = new Date(ts);
  const time = d.toLocaleTimeString(LANG === "en" ? "en-GB" : "fr-FR", { hour: "2-digit", minute: "2-digit" });
  return new Date().toDateString() === d.toDateString() ? tr(`à ${time}`, `at ${time}`) : tr(`demain ${time}`, `tomorrow ${time}`);
}
function liveSection(title, body, count) {
  return `<section class="halo-live"><div class="halo-section-title">${esc(title)}${count ? `<span class="halo-count">${count}</span>` : ""}</div>${body}</section>`;
}
function liveContent() {
  const tr = bilingual, now = Date.now(), out = [];
  const liveAgents = prefs().agents ? agents : [];
  // 1. Ce qui attend une réponse (notifications à boutons).
  const pending = feed.filter(n => n.actions?.length).slice(0, 3);
  if (pending.length) out.push(liveSection(tr("Attend ta réponse", "Needs you"), `<div class="halo-list">${pending.map(feedRow).join("")}</div>`, pending.length));
  // 2. Agents au travail (Lumen, Claude Code…), étape en cours.
  if (liveAgents.length) out.push(liveSection(tr("En cours", "Running"), `<div class="halo-list">${liveAgents.map(agentRow).join("")}</div>`, liveAgents.length));
  // 3. IA locale : seulement pendant/juste après une génération.
  const m = monitor, sample = m?.sample, hot = sample && now - sample.ts < 15000;
  if (m && hot) {
    const used = m.ctxUsed, total = m.ctxTotal;
    out.push(liveSection(tr("IA locale", "Local AI"), `<div class="halo-ai"><div class="halo-ai-line"><b title="${esc(m.model || "")}">${esc(String(m.model || m.backend || "").replace(/\.gguf$/i, ""))}</b><span>${sample.tps > 0 ? `${sample.tps.toFixed(0)} tok/s` : ""}${m.modelMemory != null ? ` · ${(m.modelMemory / 1073741824).toFixed(1)} Go` : ""}</span></div>${used != null && total > 0 ? `<div class="halo-monitor-track" title="${used} / ${total} tokens"><span style="width:${Math.min(100, used / total * 100)}%"></span></div>` : ""}<small>${esc(sample.app || "")} · ${esc(ago(sample.ts))}</small></div>`));
  }
  // 4. Focus en cours.
  if (focusDeadline || focusRemaining !== focusDuration) {
    out.push(liveSection("Focus", `<div class="halo-live-focus"><span class="halo-focus-time" role="timer">${focusTime()}</span><button class="isl-btn primary" data-focus-action="toggle">${esc(focusDeadline ? tr("Pause", "Pause") : tr("Reprendre", "Resume"))}</button><button class="isl-btn" data-focus-action="reset">${esc(tr("Arrêter", "Stop"))}</button></div>`));
  }
  // 5. Prochain rendez-vous / rappel des 24 h.
  const next = (haloData.home.items || []).map(i => ({ ...i, at: new Date(i.due_at).getTime() })).filter(i => i.at > now - 5 * 60000 && i.at < now + 24 * 3600000).sort((a, b) => a.at - b.at).slice(0, 2);
  if (next.length) out.push(liveSection(tr("À venir", "Coming up"), `<div class="halo-list">${next.map(i => `<div class="halo-row" data-app="calendar"><span class="halo-row-ic">${svg("calendar")}</span><span class="halo-row-txt"><b>${esc(i.title)}</b><span>${esc(i.location || "")}</span></span><span class="halo-row-time halo-until">${esc(untilLabel(i.at))}</span></div>`).join("")}</div>`));
  // 6. Dernières notifications.
  const recent = feed.filter(n => !n.actions?.length).slice(0, 3);
  if (recent.length) out.push(liveSection(tr("Récent", "Recent"), `<div class="halo-list">${recent.map(feedRow).join("")}</div>${feed.length > 3 ? `<button class="halo-link" data-halo-tab="notifications">${esc(tr(`Tout voir (${feed.length})`, `See all (${feed.length})`))}</button>` : ""}`));
  if (!out.length) {
    const date = new Date().toLocaleDateString(LANG === "en" ? "en-GB" : "fr-FR", { weekday: "long", day: "numeric", month: "long" });
    out.push(`<div class="halo-idle"><strong>${esc(clock())}</strong><span>${esc(date)}</span><small>${esc(tr("Rien en cours. Les agents, l’IA, tes rendez-vous et tes notifications s’afficheront ici.", "Nothing running. Agents, AI, appointments and notifications will show up here."))}</small></div>`);
  }
  // Raccourci unique, utile depuis l'encoche : lancer un Focus.
  if (!focusDeadline && focusRemaining === focusDuration) out.push(`<div class="halo-quick"><button class="isl-btn" data-focus-action="toggle">${svg("clock")} ${esc(tr(`Focus ${focusDuration / 60} min`, `Focus ${focusDuration / 60} min`))}</button></div>`);
  return out.join("");
}
function renderNotchPanel() {
  const tr = bilingual;
  panelEl.classList.toggle("is-peek", notchPeek);
  if (notchPeek) {
    const active = prefs().agents ? agents[0] : null;
    const ram = monitor?.modelMemory;
    const context = monitor?.ctxUsed;
    const total = monitor?.ctxTotal;
    const model = monitor?.model || "";
    panelEl.innerHTML = `<div class="halo-peek-head"><span class="halo-glyph"><i></i></span><span class="halo-peek-title"><b>${esc(active?.name || "Lumen")}</b><small>${esc(active ? stepOf(active.id) || active.task : model || tr("Disponible", "Ready"))}</small></span><button class="halo-icon-btn" data-halo-tab="agents" aria-label="${esc(tr("Voir l’activité", "View activity"))}" title="${esc(tr("Voir l’activité", "View activity"))}">${svg("arrow-right")}</button></div><div class="halo-peek-metrics"><button data-halo-tab="monitor" title="${esc(model)}"><span>${esc(tr("RAM modèle", "Model RAM"))}</span><b>${ram != null ? `${(ram / 1073741824).toFixed(1)} Go` : "—"}</b></button><button data-halo-tab="monitor"><span>CTX</span><b>${esc(context != null ? `${context} / ${total ?? "?"}` : total ? `— / ${total}` : "—")}</b></button><button data-halo-tab="home" aria-label="${esc(tr("Ouvrir les onglets", "Open tabs"))}">${svg("grid")}</button></div>`;
    if (view === "panel") fit();
    return;
  }
  // Une seule vue utile en temps réel (« Maintenant ») ; deux sous-vues
  // seulement : le détail d'une notification et les réglages.
  const empty = (text) => `<div class="halo-empty">${esc(text)}</div>`;
  let content = "";
  if (notchTab === "notifications") {
    content = `${detailBlock(focusNotif)}<div class="halo-section-title">${esc(t("sec_notifs"))}<span class="halo-count">${feed.length}</span></div><div class="halo-list">${feed.length ? feed.map(feedRow).join("") : empty(t("empty_notifs"))}</div><div class="halo-foot"><button class="isl-btn" data-act="clear">${esc(t("clear"))}</button><button class="isl-btn" data-act="notifications">${esc(t("open_notifs"))}</button></div>`;
  } else if (notchTab === "settings") {
    const preferences = prefs();
    content = `<div class="halo-section-title">${esc(tr("Préférences du Halo", "Halo preferences"))}</div>${[["haloAgents", tr("Afficher les agents", "Show agents"), preferences.agents], ["haloClock", tr("Afficher l’heure", "Show time"), preferences.clock], ["haloSticky", tr("Garder les notifications non lues", "Keep unread notifications visible"), preferences.sticky]].map(([key,label,on]) => `<label class="halo-pref-row"><span>${esc(label)}</span><input type="checkbox" data-halo-pref="${key}" ${on ? "checked" : ""}></label>`).join("")}<label class="halo-pref-row"><span>${esc(tr("Au repos", "When idle"))}</span><select data-halo-pref="haloRest"><option value="peek" ${localStorage.getItem("haloRest") !== "show" ? "selected" : ""}>${esc(tr("Se cacher", "Hide"))}</option><option value="show" ${localStorage.getItem("haloRest") === "show" ? "selected" : ""}>${esc(tr("Rester visible", "Stay visible"))}</option></select></label><label class="halo-pref-row"><span>${esc(tr("Durée des notifications", "Notification duration"))}</span><select data-halo-pref="haloHold">${[...new Set([5,15,30,60,120,preferences.hold / 1000])].sort((a,b)=>a-b).map(n => `<option value="${n}" ${preferences.hold === n*1000 ? "selected" : ""}>${n} s</option>`).join("")}</select></label><p class="halo-pref-status" role="status"></p>`;
  } else {
    notchTab = "home";
    content = liveContent();
  }
  const sub = notchTab !== "home";
  const status = clock();
  panelEl.innerHTML = `<div class="halo-panel-head">${sub ? `<button class="halo-icon-btn" data-halo-tab="home" aria-label="${esc(tr("Retour", "Back"))}" title="${esc(tr("Retour", "Back"))}">${svg("chevron-left")}</button>` : `<span class="halo-glyph"><i></i></span>`}<strong>${esc(notchTab === "settings" ? tr("Réglages", "Settings") : notchTab === "notifications" ? tr("Notifications", "Notifications") : "Lumen")}</strong><span class="halo-spacer"></span><span class="halo-panel-status">${esc(status)}</span>${sub ? "" : `<button class="halo-icon-btn" data-halo-tab="settings" aria-label="${esc(tr("Réglages", "Settings"))}" title="${esc(tr("Réglages", "Settings"))}">${svg("settings")}</button>`}<button class="halo-icon-btn" data-act="collapse" aria-label="${esc(t("close"))}">${svg("minus")}</button></div><div class="halo-tab-content">${content}</div>`;
  markTimelineEdges();
  if (view === "panel") fit();
}

function renderPanel() {
  if (el.dataset.style === "notch") return renderNotchPanel();
  const showAgents = prefs().agents;
  panelEl.innerHTML = `
    <div class="halo-panel-head">
      <span class="halo-glyph"><i></i></span>
      <strong>${esc(t("idle"))}</strong>
      <span class="halo-spacer"></span>
      <button class="halo-icon-btn" data-act="clear" title="${esc(t("clear"))}">${svg("trash")}</button>
      <button class="halo-icon-btn" data-act="collapse" title="${esc(t("close"))}">${svg("x")}</button>
    </div>
    ${detailBlock(focusNotif)}
    ${
      showAgents
        ? `<div class="halo-section">
      <div class="halo-section-title">${esc(t("sec_agents"))}<span class="halo-count">${agents.length}</span></div>
      <div class="halo-list">${
        agents.length ? agents.map(agentRow).join("") : `<div class="halo-empty">${esc(t("empty_agents"))}</div>`
      }</div>
    </div>`
        : ""
    }
    ${
      timeline.length
        ? `<div class="halo-section">
      <div class="halo-section-title">${esc(t("sec_timeline"))}<span class="halo-count">${timeline.length}</span></div>
      <div class="halo-list halo-tl-list">${timeline.slice(-24).reverse().map((r, i) => timelineRow(r, i)).join("")}</div>
    </div>`
        : ""
    }
    <div class="halo-section">
      <div class="halo-section-title">${esc(t("sec_notifs"))}<span class="halo-count">${feed.length}</span></div>
      <div class="halo-list">${
        feed.length ? feed.map(feedRow).join("") : `<div class="halo-empty">${esc(t("empty_notifs"))}</div>`
      }</div>
    </div>
    <div class="halo-foot">
      <button class="isl-btn" data-act="agents">${esc(t("open_agents"))}</button>
      <button class="isl-btn primary" data-act="notifications">${esc(t("open_notifs"))}</button>
    </div>`;
  markTimelineEdges();
  if (view === "panel") fit();
}

// Estompe l'extrémité du déroulé du côté où il reste du contenu : une ligne
// tranchée net au ras du bord se lit comme un défaut d'affichage.
function markTimelineEdges() {
  const list = panelEl.querySelector(".halo-tl-list");
  if (!list) return;
  const update = () => {
    // Panneau encore masqué (le rendu précède le changement de vue) : les
    // hauteurs valent 0 et il n'y a rien à mesurer. On repassera.
    if (!list.clientHeight) return;
    const bottom = list.scrollHeight - list.scrollTop - list.clientHeight > 2;
    list.classList.toggle("is-more-below", bottom);
    list.classList.toggle("is-more-above", list.scrollTop > 2);
  };
  // Le contenu vient d'être posé : la mesure attend la mise en page.
  afterLayout(update);
  if (list.dataset.edges) return;
  list.dataset.edges = "1";
  list.addEventListener("scroll", update, { passive: true });
}

// La carte d'alerte teinte la capsule selon le type de notification
// (`data-kind` + `--accent`). Hors de cette carte, on rend son accent d'origine
// à la capsule, sinon un échec laisserait la pastille et le panneau en rouge.
function clearKind() {
  delete el.dataset.kind;
  el.style.removeProperty("--accent");
}

// Notification dépliée en tête de panneau : c'est là qu'on lit le texte
// COMPLET, celui que la carte tronque à deux lignes.
let focusNotif = null;

function openPanel(focus, peek = false) {
  notchPeek = peek && el.dataset.style === "notch";
  // Le clic d'une alerte ne doit pas intercepter les contrôles du panneau.
  shell.onclick = null;
  clearTimeout(collapseTimer);
  if (view !== "panel") playUi("open");
  // Ceinture : seule une vraie notification (celle que la carte affiche, ou une
  // ligne du fil) peut prendre la tête du panneau.
  const item = focus && typeof focus === "object" && typeof focus.title === "string" ? focus : null;
  focusNotif = item || focusNotif || feed[0] || null;
  if (item) notchTab = "notifications";
  shell.classList.remove("is-tall");
  clearTimeout(holdTimer);
  clearTimeout(idleTimer);
  idleTimer = null;
  clearKind();
  unread = 0;
  renderPanel();
  renderPill();
  setView("panel");
  // La vue vient seulement de s'afficher : c'est maintenant que le déroulé a
  // une hauteur à mesurer.
  markTimelineEdges();
  refreshHaloData();
  refreshMonitor();
  // Complément asynchrone : le panneau s'ouvre tout de suite, la timeline se
  // remplit dès que Rust a répondu.
  loadTimeline();
}

// Referme ce qui est affiché : notification suivante s'il en reste, sinon
// pastille d'activité ou effacement.
function collapse() {
  clearTimeout(hoverExpandTimer);
  clearTimeout(collapseTimer);
  clearTimeout(holdTimer);
  current = null;
  present();
}

// Clics du panneau (délégation : le contenu est réécrit à chaque rendu).
panelEl.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-halo-tab]");
  if (tab) {
    notchPeek = false;
    notchTab = tab.dataset.haloTab;
    renderPanel();
    if (notchTab === "monitor") refreshMonitor();
    refreshHaloData();
    panelEl.querySelector(`[data-halo-tab="${notchTab}"]`)?.focus();
    return;
  }
  const focusAction = e.target.closest("[data-focus-action]");
  if (focusAction) return handleFocus(focusAction.dataset.focusAction);
  const target = e.target.closest("[data-act], [data-open], [data-notif], [data-app]");
  if (!target) return;
  // Une ligne du fil : on la déplie en tête de panneau. C'est le seul endroit
  // où le texte entier est lisible.
  if (target.dataset.notif) {
    focusNotif = feed.find((n) => n.id === target.dataset.notif) || focusNotif;
    notchTab = "notifications";
    renderPanel();
    return;
  }
  if (target.dataset.app) {
    openApp({ app: target.dataset.app });
    return collapse();
  }
  const act = target.dataset.act || target.dataset.open;
  if (act === "collapse") return collapse();
  if (act === "clear") {
    feed = [];
    focusNotif = null;
    unread = 0;
    renderPanel();
    renderPill();
    return;
  }
  if (act === "agents") {
    invoke("open_agents_manager").catch(() => {});
    return collapse();
  }
  if (act === "notifications") {
    // La barre ouvre son centre de notifications (la cloche) sur cet évènement.
    event.emit("halo-open", { section: "notifications" });
    return collapse();
  }
});

// Le panneau s'ouvre aussi pendant une simple session d'activité : c'est la
// même capsule, et c'est là qu'on voit ce que fait l'agent.
// `() => openPanel()` et non `openPanel` : sans cela, l'évènement de clic
// partait comme notification à déplier, et le panneau s'ouvrait sur un bloc de
// détail fantôme (titre vide, pas de texte).
pillEl.addEventListener("click", () => openPanel());
pillEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openPanel();
  }
});

// Le panneau se replie tout seul quand le pointeur quitte la capsule : sans
// « clic ailleurs » possible (fenêtre séparée), c'est le seul repli naturel.
shell.addEventListener("mouseenter", () => {
  pointerInside = true;
  if (el.dataset.rest === "1") { playUi("peek"); updateRest(); }
  // Survol = intention de lire : la vignette s'ouvre en carte complète.
  if (view === "alert") setDensity("full");
  clearTimeout(collapseTimer);
  clearTimeout(idleTimer);
  idleTimer = null;
  // Consultation en cours : le décompte se bloque jusqu'à ce qu'on ressorte.
  pauseHold();
  // L'encoche se déploie sans clic ; une alerte conserve ses actions propres.
  clearTimeout(hoverExpandTimer);
  if (el.dataset.style === "notch" && view === "pill") {
    hoverExpandTimer = setTimeout(() => {
      // Plus d'aperçu intermédiaire (nom + modèle + RAM/CTX) : le panneau complet directement.
      if (pointerInside && view === "pill" && el.dataset.style === "notch") openPanel(null, false);
    }, 220);
  }
});
shell.addEventListener("mouseleave", () => {
  clearTimeout(hoverExpandTimer);
  pointerInside = false;
  setTimeout(() => { if (!pointerInside) updateRest(); }, 900);
  // Retour à la vignette en sortant — mais jamais sur une carte à boutons (on
  // ne fait pas disparaître une décision en attente) ni sur une carte de
  // données, qui doit rester lisible tout le temps qu'elle est affichée.
  if (view === "alert" && !current?.actions?.length && !current?.layout) setDensity("mini");
  resumeHold();
  if (view === "panel") collapseTimer = setTimeout(collapse, 1400);
  // Repos interrompu par le survol : on le relance en sortant.
  else if (view === "pill" && !current) settle();
});

// ===== Ouverture de l'app concernée ========================================
// Une notification parle toujours de QUELQUE CHOSE : un clic doit amener là où
// ça se passe, pas seulement déplier le fil. La clé vient du champ `app` de la
// notification (poussé par Rust), la valeur est la commande Tauri qui ouvre la
// fenêtre correspondante.
const APP_COMMANDS = {
  agents: "open_agents_manager",
  sandbox: "open_sandbox_explorer",
  inbox: "open_inbox",
  kanban: "open_kanban_board",
  budget: "open_budget",
  calendar: "open_calendar",
  automations: "open_automations",
  fluxo: "open_fluxo_designer",
  domotique: "open_domotique",
  memory: "open_memory",
  vault: "open_vault",
  knowledge: "open_knowledge",
  storage: "open_storage",
  journal: "open_llm_log",
  settings: "open_settings",
};
// Repli quand l'émetteur n'a pas nommé d'app : l'icône en dit déjà long.
const APP_BY_ICON = { agents: "agents", calendar: "calendar", inbox: "inbox" };

// Ouvre l'app d'une notification (bouton « Ouvrir l'app concernée » du
// panneau). Renvoie false s'il n'y en a pas.
function openApp(item) {
  const cmd = APP_COMMANDS[item?.app];
  if (!cmd) return false;
  invoke(cmd).catch(() => {});
  return true;
}

// ===== Notifications =======================================================
function normalize(item) {
  const kind = String(item.kind || "info").toLowerCase();
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    title: String(item.title || "Lumen"),
    body: String(item.body || item.message || ""),
    ts: Number(item.timestamp) || Date.now(),
    icon: item.icon,
    accent: item.accent,
    // App à ouvrir au clic (« Équipage » pour un agent, etc.). Renseigné par
    // l'émetteur ; à défaut on la devine depuis l'icône.
    app: String(item.app || "") || APP_BY_ICON[item.icon] || "",
    actions: Array.isArray(item.actions) ? item.actions : [],
    // Carte « riche » : mise en page dédiée (score, météo…) et ses données.
    layout: LAYOUTS[item.layout] ? String(item.layout) : "",
    data: item.data && typeof item.data === "object" ? item.data : {},
    timeout_ms: item.timeout_ms,
    // Demande de Lumen (lib/user-gate.js) : les boutons y répondent directement.
    request_id: item.request_id ? String(item.request_id) : "",
  };
}

function pushToFeed(n) {
  feed.unshift(n);
  if (feed.length > FEED_MAX) feed.length = FEED_MAX;
  unread++;
  requestSummary(n);
}

// Une notification entre TOUJOURS par la capsule : elle s'ouvre dessus, la
// tient un moment, puis se replie. Il n'y a pas de « bulle » séparée — c'est la
// même coque qui change de forme, comme sur la pastille d'activité.
function enqueue(raw) {
  if (!raw || typeof raw !== "object") return;
  const item = normalize(raw);
  pushToFeed(item);
  // Panneau ouvert : on ne le vole pas à l'utilisateur, la notification est
  // déjà dans le fil qu'il est en train de lire.
  if (view === "panel") {
    unread = 0;
    renderPanel();
    return;
  }
  queue.push(item);
  if (current) {
    // Une notification est déjà à l'écran : on met à jour le compteur « +N »
    // plutôt que de la bousculer. La capsule dit ce qui attend son tour.
    renderMore();
    fit();
    return;
  }
  present();
}

// Compteur des notifications en attente, dans la zone de droite de la capsule.
function renderMore() {
  const trail = alertEl.querySelector(".isl-trail");
  if (!trail) return;
  let chip = trail.querySelector(".isl-more");
  if (!queue.length) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "isl-more";
    trail.prepend(chip);
  }
  chip.textContent = `+${queue.length}`;
  chip.title = t("queued", { n: queue.length });
}

// Densité de la carte : « mini » (titre seul, format vignette) ou « full »
// (message et actions). Le morphing de la capsule suit le changement.
let density = "mini";
function setDensity(next) {
  // Style Encoche : la carte se déploie toujours en entier, comme une île
  // dynamique. En vignette, il ne restait qu'un titre perdu sous l'encoche.
  if (el.dataset.style === "notch") next = "full";
  if (density === next) return;
  density = next;
  el.dataset.density = next;
  // Une carte riche dépliée est haute : elle prend le rayon du panneau, la
  // vignette garde la géométrie de capsule.
  if (view === "alert" && alertEl.classList.contains("is-rich")) {
    shell.classList.toggle("is-tall", next === "full");
  }
  if (view === "alert") fit();
}
el.dataset.density = density;


// ===== Cartes riches (score, météo) ========================================
// Certaines notifications ne sont pas une phrase : un score se lit d'un coup
// d'œil. Ces mises en page remplacent le couple titre/texte par une vraie
// carte, en vignette comme en grand — c'est la même densité qui décide de ce
// qu'on montre, le CSS fait le reste.

// Sigle porté par l'écusson. Une abréviation fournie par la source (« CHE »,
// « BAR ») se suffit à elle-même ; un nom complet est réduit à ses initiales.
function initials(name) {
  const words = String(name || "?").split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

// Écusson : le logo distant est BLOQUÉ par la CSP de la WebView, on ne le
// charge donc jamais — c'est la couleur du club, tirée de la source, qui
// identifie l'équipe.
function crest(side) {
  const color = /^#[0-9a-f]{3,8}$/i.test(side?.color || "") ? side.color : "var(--secondary)";
  return `<span class="isl-crest" style="--crest:${esc(color)}">${esc(initials(side?.short || side?.name))}</span>`;
}

function renderScore(d) {
  const line = (side, align) => `
    <div class="isl-team is-${align}">
      ${crest(side)}
      <span class="isl-team-txt">
        <b>${esc(side?.name || side?.short || "—")}</b>
        ${side?.record ? `<span>${esc(side.record)}</span>` : ""}
      </span>
    </div>`;
  return `
    <div class="isl-score">
      <div class="isl-score-head">
        ${d.live ? `<span class="isl-live">${esc(t("live"))}</span>` : ""}
        <span class="isl-score-league">${esc(d.league || "")}</span>
        <span class="isl-score-status">${esc(d.status || "")}</span>
      </div>
      <div class="isl-score-row">
        ${line(d.home, "home")}
        <div class="isl-score-num"><b>${esc(d.home?.score ?? "-")}</b><i>–</i><b>${esc(d.away?.score ?? "-")}</b></div>
        ${line(d.away, "away")}
      </div>
    </div>`;
}

function renderWeather(d) {
  const chip = (label, value) => `<span class="isl-chip"><i>${esc(label)}</i>${esc(value)}</span>`;
  // Une valeur absente s'écrit « — », jamais « undefined » : une carte de
  // données affiche un chiffre ou rien, pas un mot de programmeur.
  const num = (v, unit = "") => (v === null || v === undefined || v === "" ? "—" : `${v}${unit}`);
  return `
    <div class="isl-weather">
      <div class="isl-wx-main">
        <span class="isl-wx-icon">${svg(d.glyph || "cloud")}</span>
        <span class="isl-wx-temp">${esc(String(d.temp ?? "—"))}<sup>°</sup></span>
        <span class="isl-wx-txt">
          <b>${esc(d.city || d.place || "")}</b>
          <span>${esc(d.label || "")}</span>
        </span>
      </div>
      <div class="isl-wx-chips">
        ${chip(t("wx_feels"), num(d.feels, "°"))}
        ${chip(t("wx_range"), `${num(d.min, "°")} / ${num(d.max, "°")}`)}
        ${chip(t("wx_rain"), num(d.rain, " %"))}
        ${chip(t("wx_wind"), num(d.wind, " km/h"))}
      </div>
    </div>`;
}

// Cours d'une valeur (bourse ou crypto) : le prix en grand, la variation colorée.
function renderQuote(d) {
  return `
    <div class="isl-quote">
      <div class="isl-quote-main">
        <span class="isl-quote-price">${esc(d.price ?? "—")}<small>${esc(d.currency || "")}</small></span>
        <span class="isl-quote-chg ${d.up ? "up" : "down"}">${d.up ? "▲" : "▼"} ${esc(d.change || "")}</span>
      </div>
      <div class="isl-quote-sub"><b>${esc(d.name || d.symbol || "")}</b><span>${esc(d.symbol || "")} · ${esc(d.source || "")}</span></div>
    </div>`;
}

// Taux de change : le montant converti, puis le taux unitaire.
function renderRate(d) {
  return `
    <div class="isl-rate">
      <div class="isl-rate-main"><span>${esc(d.amount)} <i>${esc(d.from)}</i></span><span class="isl-rate-arrow">→</span><span><b>${esc(d.value)}</b> <i>${esc(d.to)}</i></span></div>
      <div class="isl-rate-sub">1 ${esc(d.from)} = ${esc(d.rate)} ${esc(d.to)} · ${esc(t("rate_src"))} ${esc(d.date || "")}</div>
    </div>`;
}

// Qualité de l'air : une jauge à six paliers (indice européen) et les polluants.
function renderAqi(d) {
  const chip = (label, value) => `<span class="isl-chip"><i>${esc(label)}</i>${esc(value)}</span>`;
  const pos = Math.max(0, Math.min(100, Number(d.aqi) || 0));
  return `
    <div class="isl-aqi" data-level="${esc(d.level || "good")}">
      <div class="isl-aqi-main"><span class="isl-aqi-num">${esc(String(d.aqi ?? "—"))}</span><span class="isl-aqi-txt"><b>${esc(d.city || "")}</b><span>${esc(d.label || "")}</span></span></div>
      <div class="isl-aqi-bar"><i style="left:${pos}%"></i></div>
      <div class="isl-wx-chips">${chip("PM2.5", `${d.pm25 ?? "—"}`)}${chip("PM10", `${d.pm10 ?? "—"}`)}${chip("NO₂", `${d.no2 ?? "—"}`)}${chip("O₃", `${d.o3 ?? "—"}`)}</div>
    </div>`;
}

// Actualités : une liste courte, la source en sourdine.
function renderNews(d) {
  const items = Array.isArray(d.items) ? d.items.slice(0, 8) : [];
  return `
    <div class="isl-news">
      ${items.map((it) => `<div class="isl-news-row"><b>${esc(it.title || "")}</b><span>${esc(it.source || "")}</span></div>`).join("")}
    </div>`;
}

// Image générée (outil generate_image) : la vignette JPEG voyage dans la
// notification en data URL (autorisée par la CSP, contrairement aux URL
// distantes) ; le prompt et le moteur en légende.
function renderImage(d) {
  return `
    <div class="isl-image">
      <img class="isl-image-pic" src="${esc(d.src || "")}" alt="">
      <div class="isl-image-cap">
        <b>${esc(d.prompt || "")}</b>
        <span>${esc(d.provider || "")}${d.sandbox ? ` · ${esc(d.sandbox)}` : ""}</span>
      </div>
    </div>`;
}

const LAYOUTS = { score: renderScore, weather: renderWeather, quote: renderQuote, rate: renderRate, aqi: renderAqi, news: renderNews, image: renderImage };

// Contenu de la carte : icône, titre, texte, actions, barre de temps.
function paintAlert(item, withTimer) {
  applyTheme();
  const iconName = item.icon && lumenHasIcon(item.icon) ? item.icon : KIND_ICON[item.kind] || "bell";
  if (item.accent) el.style.setProperty("--accent", item.accent);
  else el.style.removeProperty("--accent");
  el.dataset.kind = item.kind;

  const actions = item.actions;
  const actionsHtml = actions.length
    ? `<div class="isl-actions">${actions
        .map(
          (a, i) =>
            `<button class="isl-btn ${a.primary || (actions.length === 1 && i === 0) ? "primary" : ""}" data-action="${esc(
              a.id ?? i
            )}">${esc(a.label || "OK")}</button>`
        )
        .join("")}</div>`
    : "";

  // Carte riche : elle ne remplace pas la vignette dans le DOM, elle la
  // DOUBLE — c'est le CSS qui montre l'une ou l'autre selon la densité, sans
  // repeindre. Une carte de données s'affiche d'emblée en densité pleine (voir
  // plus bas) ; la vignette ne ressert que si la capsule se replie.
  const rich = LAYOUTS[item.layout] ? LAYOUTS[item.layout](item.data) : "";
  alertEl.classList.toggle("is-rich", Boolean(rich));
  // Sans message, la capsule se resserre en pastille étirée : elle épouse son
  // contenu au lieu de garder une largeur de notification standard.
  const compact = !item.body.trim() && !actions.length;
  alertEl.classList.toggle("is-compact", compact);
  // Densité d'arrivée : une notification ORDINAIRE se pose en vignette (titre
  // seul, à peine plus grosse que la pastille) et ne s'ouvre qu'au survol.
  // Deux exceptions arrivent d'emblée en grand :
  //  • une demande de décision (boutons) — on doit pouvoir cliquer sans
  //    survoler d'abord ;
  //  • une carte de DONNÉES (météo, score) — c'est le dessin qui EST
  //    l'information : la réduire à son titre reviendrait à ne rien afficher,
  //    et obliger à survoler pour voir un score n'a pas de sens.
  setDensity(rich || actions.length || pointerInside ? "full" : "mini");
  // Seule une carte à boutons d'action est assez haute pour mériter un rayon de
  // coin ; sinon la capsule reste entièrement arrondie.
  shell.classList.toggle("is-tall", actions.length > 0 || (Boolean(rich) && density === "full"));

  // « +N » : les notifications qui attendent leur tour restent visibles dans la
  // capsule, on ne les découvre pas une par une sans savoir combien il en reste.
  const more = queue.length;
  alertEl.innerHTML = `
    <div class="isl-lead">
      ${withTimer ? `<svg class="isl-ring" viewBox="0 0 38 38"><circle cx="19" cy="19" r="17"></circle></svg>` : ""}
      <div class="isl-icon">${svg(iconName)}</div>
    </div>
    <div class="isl-body">
      <div class="isl-title">${esc(item.title)}</div>
      <div class="isl-summary">${esc(summaries.get(item.id) || "")}</div>
      <div class="isl-text">${bodyHtml(item.body)}</div>
    </div>
    ${rich ? `<div class="isl-rich">${rich}</div>` : ""}
    ${actionsHtml}
    <div class="isl-trail">
      ${more ? `<span class="isl-more" title="${esc(t("queued", { n: more }))}">+${more}</span>` : ""}
      <button class="isl-close" aria-label="${esc(t("dismiss"))}" title="${esc(t("dismiss"))}">${svg("x")}</button>
    </div>
  `;
  alertEl.querySelectorAll(".isl-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      event.emit("island-action", { id: btn.dataset.action, kind: item.kind, payload: item });
      collapse();
    });
  });
  // Fermeture explicite : marque tout comme lu, pour que la capsule collante
  // puisse effectivement se retirer.
  alertEl.querySelector(".isl-close").addEventListener("click", (e) => {
    e.stopPropagation();
    dismissAll();
  });
}

// Fermeture manuelle : vide la file, remet le compteur de non-lues à zéro et
// laisse `settle()` refermer la capsule.
function dismissAll() {
  queue.length = 0;
  unread = 0;
  clearTimeout(holdTimer);
  holdTimer = null;
  holdLeft = 0;
  current = null;
  delete el.dataset.paused;
  settle();
}

// Circonférence de l'anneau de décompte (2πr, r = 17) — doit rester alignée
// avec `stroke-dasharray` dans island.css.
const RING_LEN = 106.8;

function timerRing() {
  return alertEl.querySelector(".isl-ring circle");
}

// Anime l'anneau sur le temps restant : il se vide au fur et à mesure.
function runTimerRing(ms, total) {
  const ring = timerRing();
  if (!ring) return;
  const left = Math.max(0, Math.min(1, ms / (total || ms)));
  ring.style.transition = "none";
  ring.style.strokeDashoffset = String(RING_LEN * (1 - left));
  // `afterLayout` plutôt qu'un `requestAnimationFrame` nu : sans frame (fenêtre
  // occultée), l'anneau resterait figé à son point de départ.
  afterLayout(() => {
    ring.style.transition = `stroke-dashoffset ${ms}ms linear`;
    afterLayout(() => (ring.style.strokeDashoffset = String(RING_LEN)));
  });
}

// Fige l'anneau là où il en est (survol).
function freezeTimerRing() {
  const ring = timerRing();
  if (!ring) return;
  const now = getComputedStyle(ring).strokeDashoffset;
  ring.style.transition = "none";
  ring.style.strokeDashoffset = now;
}

// Démarre / reprend le décompte de la notification affichée.
function resumeHold() {
  if (!current) return;
  if (holdLeft <= 0) {
    // Le temps s'était écoulé pendant la consultation : on enchaîne en sortant
    // plutôt que de laisser la carte affichée indéfiniment.
    if (current.holdTotal > 0) present();
    return;
  }
  delete el.dataset.paused;
  holdStart = Date.now();
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    holdLeft = 0;
    present();
  }, holdLeft);
  runTimerRing(holdLeft, current.holdTotal || holdLeft);
}

// Met le décompte en pause : l'utilisateur consulte, on ne lui retire rien.
function pauseHold() {
  if (!holdTimer) return;
  clearTimeout(holdTimer);
  holdTimer = null;
  holdLeft = Math.max(0, holdLeft - (Date.now() - holdStart));
  el.dataset.paused = "1";
  freezeTimerRing();
}

// Affiche la notification suivante ; s'il n'y en a plus, la capsule se replie.
async function present() {
  const item = queue.shift();
  clearTimeout(holdTimer);
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!item) {
    current = null;
    settle();
    return;
  }
  current = item;
  // Entrée façon capsule : absente de l'écran, elle apparaît d'abord en
  // pastille puis s'ouvre sur la notification. C'est le morphing qui fait
  // reconnaître la capsule — sans lui, on ne voit qu'une carte surgir.
  if (!visible || el.dataset.state === "hidden") {
    renderPill();
    setView("pill");
    await ensureVisible();
    await wait(300);
    if (current !== item) return; // devancée par une autre notification
  }
  const isPrompt = item.kind === "prompt" || item.actions.length > 0;
  // Un prompt (avec actions) reste affiché tant qu'on n'a pas répondu.
  const hold = item.timeout_ms != null ? Number(item.timeout_ms) : isPrompt ? 0 : prefs().hold;
  paintAlert(item, hold > 0);
  playUi(isPrompt ? "ask" : item.kind === "error" ? "error" : item.kind === "success" ? "success" : "peek");
  await ensureVisible();
  setView("alert");
  fit(); // le contenu a changé même si la vue ne change pas
  // Clic sur la carte (hors boutons) : la capsule s'ouvre en panneau, avec les
  // notifications en attente et les agents en cours. C'est la même capsule qui
  // continue de grandir, pas une autre fenêtre.
  shell.onclick = (e) => {
    if (isPrompt || e.target.closest(".isl-btn") || e.target.closest(".isl-close")) return;
    // Clic = « dis-m'en plus ». Le panneau déplie la notification en entier
    // (une carte tronque à deux lignes) et montre le déroulé du run ; l'app
    // concernée reste à un bouton de là. Ouvrir l'app directement faisait
    // perdre l'information au lieu de l'ouvrir.
    openPanel(item);
  };
  item.holdTotal = hold;
  holdLeft = hold;
  if (hold > 0) {
    // Pointeur déjà sur la capsule à l'arrivée : le décompte ne démarre pas.
    if (pointerInside) {
      el.dataset.paused = "1";
      freezeTimerRing();
    } else {
      resumeHold();
    }
  }
}

// Plus rien à annoncer : pastille d'activité si un agent travaille (ou si le
// mode Halo est actif), sinon la capsule s'efface.
function settle() {
  clearKind();
  setDensity("mini");
  shell.onclick = null;
  shell.classList.remove("is-tall");
  clearTimeout(idleTimer);
  idleTimer = null;
  renderPill();
  setView("pill");
  reveal();
  // Mode Halo, agent au travail, ou capsule « collante » avec des non-lues :
  // la pastille reste. Sinon elle tient un court instant — le temps de la voir
  // se refermer — puis s'efface.
  const p = prefs();
  if (halo || (p.agents && agents.length) || (p.sticky && unread > 0)) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    fadeOut();
  }, IDLE_HOLD);
}

// Sortie en fondu AVANT de masquer la fenêtre native : sans le délai, la
// capsule disparaîtrait d'un coup au milieu de son animation.
function fadeOut() {
  clearTimeout(idleTimer);
  idleTimer = null;
  visible = false;
  el.dataset.state = "hidden";
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    invoke("island_hide").catch(() => {});
  }, 360);
}

async function ensureVisible() {
  // Une sortie en cours est annulée : on remonte la capsule au lieu de la
  // laisser se faire masquer une fraction de seconde plus tard.
  clearTimeout(hideTimer);
  hideTimer = null;
  // L'affichage se fait AVANT toute attente de frame : une fenêtre native
  // masquée n'en reçoit pas, et la capsule ne se montrerait jamais.
  if (!visible) {
    visible = true;
    try {
      await invoke("island_show");
    } catch (_) {}
  }
  reveal();
}

// ===== Agents en cours =====================================================
// Les étapes arrivent par rafales : on les défile à une par seconde au moins,
// pour qu'on les VOIE passer sur la pastille au lieu d'un clignotement.
function pushStep(agentId, payload) {
  if (!agentId) return;
  const h = humanStep(payload || {}, LANG);
  stepQueue.push({ agentId, text: h.text, icon: h.icon, tone: h.tone, done: payload?.kind !== "thought" });
  // File plafonnée : on préfère perdre les plus anciennes plutôt que d'afficher
  // avec dix secondes de retard sur ce que fait réellement l'agent.
  if (stepQueue.length > STEP_QUEUE_MAX) stepQueue.splice(0, stepQueue.length - STEP_QUEUE_MAX);
  if (!stepTimer) drainSteps();
}

function drainSteps() {
  // Une notification occupe la capsule : les étapes attendent leur tour plutôt
  // que de défiler à vide derrière la carte.
  if (view === "alert") {
    stepTimer = setTimeout(drainSteps, STEP_MIN_MS);
    return;
  }
  const s = stepQueue.shift();
  if (!s) {
    stepTimer = null;
    return;
  }
  steps[s.agentId] = { skill: s.text, icon: s.icon, tone: s.tone, ts: Date.now() };
  if (s.done && view === "pill") flashTick(s.tone !== "fail");
  if (view === "pill") renderPill();
  else if (view === "panel") renderPanel();
  stepTimer = setTimeout(drainSteps, STEP_MIN_MS);
}

// Fin de run : on oublie l'étape courante ET celles encore en file.
function clearSteps(agentId) {
  if (!agentId) return;
  delete steps[agentId];
  delete runStats[agentId];
  stepQueue = stepQueue.filter((s) => s.agentId !== agentId);
}

// Étape la plus récente, tous agents confondus, tant qu'elle est fraîche.
function freshStep() {
  let best = null;
  for (const [agentId, st] of Object.entries(steps)) {
    if (Date.now() - st.ts > STEP_TTL) continue;
    if (!best || st.ts > best.ts) best = { agentId, ...st };
  }
  return best;
}

// Étape courante d'un agent, si elle est encore fraîche : « ⚙ web_search ».
function stepOf(id) {
  const st = steps[id];
  if (!st || Date.now() - st.ts > STEP_TTL) return "";
  return st.skill;
}
async function refreshAgentNames() {
  try {
    const list = await invoke("agent_list");
    if (Array.isArray(list)) {
      agentNames = Object.fromEntries(list.map((a) => [a.id, a.name || a.id]));
      agentById = Object.fromEntries(list.map((a) => [a.id, a]));
    }
  } catch (_) {}
}

let polling = false;
async function pollAgents() {
  // Un sondage à la fois : les évènements d'agent en déclenchent en rafale,
  // et deux réponses croisées faisaient clignoter la liste.
  if (polling) return;
  polling = true;
  try { await pollAgentsOnce(); } finally { polling = false; }
}

async function pollAgentsOnce() {
  // Hors mode Halo on sonde quand même tant que la capsule est affichée : c'est
  // ce qui alimente la pastille d'activité pendant un run d'agent.
  if (!halo && !visible) return;
  let running = [];
  try {
    running = (await invoke("agents_running")) || [];
  } catch (_) {
    return;
  }
  const previous = Object.fromEntries(agents.map((a) => [a.id, a.since]));
  const next = running.map((r) => ({
    id: r.id,
    name: r.name || agentNames[r.id] || r.id,
    task: r.task || "",
    since: previous[r.id] || Date.now(),
  }));
  const changed =
    next.length !== agents.length ||
    next.some((a, i) => a.id !== agents[i]?.id || a.task !== agents[i]?.task);
  agents = next;
  // Un nom manquant = un agent créé depuis le dernier cache : on le recharge.
  if (next.some((a) => a.name === a.id)) refreshAgentNames();
  if (changed || view === "pill") renderPill();
  // Le panneau n'est reconstruit que si la liste a réellement bougé (sinon on
  // remettrait à zéro le défilement et le survol à chaque sondage).
  if (changed && view === "panel") renderPanel();
  // Session d'activité terminée (hors mode Halo) : plus rien à montrer.
  // Session d'activité terminée : la pastille tient son battement puis part.
  if (
    !halo &&
    visible &&
    !current &&
    !idleTimer &&
    !pointerInside &&
    view === "pill" &&
    !agents.length &&
    // Une étape encore fraîche = un run qui vient de passer : on garde la
    // pastille le temps de la lire.
    !freshStep()
  )
    settle();
}

// ===== Mode Halo : activation / extinction =================================
async function setHalo(on) {
  halo = !!on;
  el.dataset.mode = halo ? "halo" : "toast";
  if (!halo) {
    clearTimeout(collapseTimer);
    if (!current) settle();
    return;
  }
  await refreshAgentNames();
  await pollAgents();
  unread = 0;
  renderPill();
  // Une notification affichée pendant l'activation garde la main : son propre
  // repli ramènera la capsule sur la pastille.
  if (!current) setView("pill");
  applyTheme();
  await ensureVisible();
}

// ===== Réception ===========================================================
// On draine la file Rust au chargement (rattrape un démarrage à froid) puis à
// chaque « poke » émis quand la fenêtre est déjà ouverte.
async function drain() {
  try {
    const items = await invoke("island_drain");
    if (Array.isArray(items)) items.forEach(enqueue);
  } catch (_) {}
}

event.listen("notify-poke", drain);
// Push direct par évènement (ex. depuis main.js).
event.listen("notify", (e) => enqueue(e.payload));
// Le mode Halo est piloté par la barre (réglage « Capsule Halo »).
event.listen("halo-mode", (e) => setHalo(e.payload));
// Centre de notifications : Heartbeat, rappels, blocs Fluxo « Notification » et
// « Centre de notifications ». Dès que cette fenêtre existe, c'est elle qui les
// affiche — `emit_center` ne pousse une bulle que quand elle n'existe pas, donc
// pas de doublon, et pas de notification perdue si la fenêtre est simplement
// masquée entre deux bulles.
event.listen("heartbeat-result", (e) => {
  const p = e.payload || {};
  enqueue({
    kind: p.success === false ? "error" : "success",
    title: p.shortcut || "Lumen",
    body: p.output || "",
    app: p.app || "",
    timestamp: p.timestamp,
  });
});
// Réactivité immédiate sur les agents (le sondage sert de filet de sécurité).
event.listen("agent-running", (e) => {
  const id = e.payload?.agent_id;
  // Début de run : compteurs remis à zéro (ils vivent même capsule masquée,
  // pour être justes quand elle apparaîtra).
  if (e.payload?.active && id) runStats[id] = { n: 0, fails: 0, since: Date.now() };
  if (!halo && !visible) return;
  // Fin de run : l'étape affichée n'a plus de sens.
  if (e.payload?.active === false) clearSteps(e.payload?.agent_id);
  pollAgents();
});
// Chaque appel d'outil/skill : l'activité de l'agent en direct sur la pastille.
event.listen("agent-step", async (e) => {
  const p = e.payload || {};
  try {
    recordStep(p);
    if (p.agent_id && p.kind !== "thought") {
      const st = (runStats[p.agent_id] ||= { n: 0, fails: 0, since: Date.now() });
      st.n += 1;
      if (p.success === false) st.fails += 1;
    }
    if (p.agent_id && p.agent) agentNames[p.agent_id] = p.agent; // agent externe (Claude Code…)
    if (p.agent_id && !agentNames[p.agent_id]) refreshAgentNames();
    // Le raisonnement défile aussi sur la pastille : c'est le signe qu'il se
    // passe quelque chose entre deux outils.
    pushStep(p.agent_id, p);
    // Un appel d'outil est une preuve de vie : la capsule se montre en pastille
    // même hors mode Halo, sinon l'activité de l'agent restait invisible et
    // seule l'erreur finale apparaissait.
    if (!halo && !visible) {
      renderPill();
      setView("pill");
      await ensureVisible();
    }
  } catch (err) {
    console.warn("[halo] agent-step", err);
  }
  pollAgents();
});
// Fin de tâche / escalade : le compte rendu lui-même arrive par la file de
// notifications (Rust pousse la bulle, cf. `notify_capsule`), pour que la
// capsule se montre aussi quand le mode Halo est coupé. Ici on ne fait que
// rafraîchir l'état des agents.
event.listen("agent-progress", (e) => {
  if (!halo && !visible) return;
  clearSteps(e.payload?.agent_id);
  // Petite célébration sur la pastille (coche qui éclot) avant que la carte
  // du compte rendu ne prenne la place.
  if (e.payload?.agent_id) {
    doneFlash = { agentId: e.payload.agent_id, ok: e.payload.success !== false, ts: Date.now() };
    if (view === "pill") renderPill();
    setTimeout(() => { if (view === "pill") renderPill(); }, DONE_FLASH_MS + 50);
  }
  pollAgents();
});
event.listen("agent-escalated", (e) => {
  if (!halo && !visible) return;
  clearSteps(e.payload?.agent_id);
  pollAgents();
});

// Rafraîchit les seuls horodatages relatifs : reconstruire le panneau à chaque
// tick réinitialiserait le défilement et le survol.
function touchTimes() {
  // Chaque horodatage porte sa propre date (`data-ts`) : les recaler par
  // position mélangeait les lignes dès qu'un bloc de détail précédait la liste.
  panelEl.querySelectorAll(".halo-row-time[data-ts]").forEach((node) => {
    const ts = Number(node.dataset.ts);
    if (ts) node.textContent = ago(ts);
  });
}

setInterval(() => {
  if (!halo && !visible) return;
  pollAgents();
  if (view === "pill") renderPill();
  else if (view === "panel") touchTimes();
}, AGENT_POLL_MS);

applyTheme();
drain();
// Si la fenêtre a été (re)créée alors que le mode Halo est déjà actif, la barre
// nous le redit via `halo-mode` ; on interroge aussi l'état au chargement.
invoke("halo_is_enabled")
  .then((on) => on && setHalo(true))
  .catch(() => {});
invoke("halo_get_style").then(applyStyle).catch(() => {});
