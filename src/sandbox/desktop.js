import { searchLumenDocs as searchDesktopDocs } from "../lib/lumen-doc-search.js";
import { collectDocumentContext } from "../lib/document-context.js";
import { appSpace } from "../lib/app-taxonomy.js";
// Mode bureau de la sandbox : un shell « OS » optionnel au-dessus de
// l'explorateur. Fenêtres draggables, barre des tâches, widgets, orbe et grande
// barre de chat (Ollama). Confiné : tout passe par les commandes sandbox.
const { invoke } = window.__TAURI__.core;
const emitEvent = window.__TAURI__?.event?.emit;
import { escapeHtml, markdownToSpeech, renderMarkdown, installLumenFileLinks, fileExt, highlightCode } from "./render.js";
// Fichiers du coffre (images, PDF…) cliqués dans une bulle : ouverts par le système.
installLumenFileLinks((cmd, args) => window.__TAURI__.core.invoke(cmd, args));
import { createStreamView, toolBlock, thinkBlock, planBlock } from "../lib/stream-view.js";
import { runOrchestrated, orchestratorText, toolCategory, isSmallTalk } from "../lib/orchestrator.js";
import { routeTurn } from "../lib/decision.js";
import { appDecider } from "../lib/decisions.js";
import { recordOrchestration, orchestrationBackends, fastBackendFor } from "../lib/orchestrator-host.js";
import { buildDataTools, callDataTool, DATA_TOOL_NAMES, DATA_TOOL_NAMES_EXTRA } from "../lib/data-tools.js";
import { buildAppDataTools, callAppDataTool, APP_DATA_TOOL_NAMES } from "../lib/app-data.js";
import { buildAppWriteTools, callAppWriteTool, APP_WRITE_TOOL_NAMES } from "../lib/app-write.js";
import { runTool } from "../lib/tool-cache.js";
import { buildSystemTools, callSystemTool, SYSTEM_TOOL_NAMES } from "../lib/system-actions.js";
import { registerActionTools } from "../lib/hybrid.js";
import { renderAnswerExtras, looksFailed } from "../lib/answer-extras.js";
import { createUserGate, answerUserRequest } from "../lib/user-gate.js";
import { stripThink } from "../lib/llm-stream.js";
import { lsSet, onStorageFull } from "../lib/safe-storage.js";
import { askScreenPrompt, waitForRepaint } from "../lib/screen-prompt.js";
import { openAiSheet, closeAiSheet } from "../lib/ai-sheet.js?v=4";
import { installWritingTools } from "../lib/writing-tools.js?v=7";
import { openExternal } from "../lib/open-external.js";
import { applyDiff, countChanges, diffLines } from "./diff.js";
import { translatePage, tt } from "../apps-i18n.js";
import { getOllamaTodayUsage, recordOllamaUsage } from "../ollama-usage.js";
import { PROMPTS as SANDBOX_PROMPTS } from "./prompts.js";
import { PROMPTS as CORE_PROMPTS } from "../lib/core-prompts.js";
import { llmChat, llmBackend, aiSourceNow, apiEscalationAvailable, withApiEscalation, ollamaGetJson, ollamaPostJson, ollamaUsesBackend, pickModelForSource, rememberModelFor, isApiLike, rustBackend, cloudModelKey, lumenServerBackendState, listApiProfiles, activateApiProfile, listApiModelChoices, selectApiModel, appleFmBackendState, appleFmReasonText, APPLEFM_DEFAULT_MODEL, APPLEFM_MODELS, withOpenAiTimings, forcedToolTurn } from "../llm.js";
import { llamaCatalogEntry } from "../llama-models.js";
import { rememberWithUndo, withMemoryRecall, memoryToolDefs, runMemoryTool } from "../memory-bridge.js";
import { setCreativeContext, openCreativeApp, openCreativeFile, creativeDocFromImage } from "./creative-editor.js";
import { installedApps, refreshInstalled, onInstalledChange, openInstalledApp, toMenuEntry, appUrl, broadcastSettings } from "../lib/appkit/installed.js";
import { mountAppHost } from "../lib/appkit/host.js";
import { intentToolDefinitions, runAppIntent } from "../lib/appkit/host.js";
import { setTheme, resolvedTheme, onAppearanceChange } from "../lib/theme.js";
import { setSheetsContext, openSheetsApp, openSheetsFile, openSheetsRows } from "./sheets.js";
import { whisperEnabled, whisperDictate } from "../lib/whisper-dictation.js";
import { showMorning, shouldShowMorning } from "./morning.js?v=2";
import { createDictationVisualizer } from "../lib/dictation-visualizer.js";
import { filterPublishedTools, sanitizeToolName, toolHint } from "../lib/tool-publishing.js";
import { initChatMentions, initMentionHighlight, decorateMentions } from "../lib/chat-mentions.js";
import { buildWebTools, callWebTool, WEB_TOOL_NAMES } from "../lib/web-tools.js";
import { buildAgentTools, callAgentTool, isAgentTool, agentToolHint, agentToolAvatar } from "../lib/agent-delegation.js";
import { buildDocTools, callDocTool, DOC_TOOL_NAMES, withoutDocToolsUnlessWriting } from "../lib/doc-generator.js";
import { snapshotToolCards, restoreToolCards } from "../lib/tool-cards.js";
import { buildMailTools, callMailTool, MAIL_TOOL_NAMES } from "../lib/mail-tools.js";
// Météo et scores : mêmes outils que la barre de Lumen (lib/live-tools.js).
import { buildLiveTools, callLiveTool, LIVE_TOOL_NAMES, takeGeneratedImage } from "../lib/live-tools.js";
import { icon as lumenIcon } from "../lib/icons.js";
import { installOsShortcuts } from "./shortcuts.js";
import { installVoiceControl } from "./voice-control.js";
import { voiceControlEnabled } from "../lib/voice-commands.js";
import { findBinding } from "../lib/rfid-bindings.js";
import { handoff, makeObject, readShelf, receive, takeHandoff, toText } from "../lib/interop.js?v=2";
import { share as shareObject } from "../lib/share-menu.js?v=2";
import { UI_ACCENTS, readUiTheme, saveUiTheme, applyUiTheme } from "../lib/ui-customizer.js";
import { platformFlavor as resolvePlatformFlavor } from "../lib/platform-flavor.js";
import { proEnabledSync, whenProResolved } from "../lib/pro-edition.js";
import { defaultOrbColors } from "../lib/orb-palette.js";
import {
  listFolders, createFolder, deleteFolder, resolveFolder, isPinned,
  conversationExcerpt, summaryMessages,
} from "../lib/conversation-folders.js";
import {
  listProjects, getProject, createProject, renameProject, deleteProject, setProjectInstructions,
  addProjectFile, removeProjectFile, projectSource, projectStats, projectDocIds, projectSystemBlock,
  projectServedInFull, PROJECT_SANDBOX,
} from "../lib/projects.js";
export { openCreativeFile, openSheetsFile };

let profileStoragePrefix = window.__LUMEN_PROFILE_STORAGE_PREFIX__ || "";
async function ensureProfileStoragePrefix() {
  if (profileStoragePrefix) return profileStoragePrefix;
  const id = await invoke("session_active_profile_id").catch(() => "default");
  profileStoragePrefix = `profile:${id || "default"}:`;
  window.__LUMEN_PROFILE_STORAGE_PREFIX__ = profileStoragePrefix;
  return profileStoragePrefix;
}
function wsKey(key) {
  return `${profileStoragePrefix || window.__LUMEN_PROFILE_STORAGE_PREFIX__ || ""}${key}`;
}
function wsGet(key) { return localStorage.getItem(wsKey(key)); }
function wsSet(key, value) { lsSet(wsKey(key), value); }
function wsRemove(key) { localStorage.removeItem(wsKey(key)); }

// Icônes SVG (reprises de la barre Lumen) pour reproduire la barre complète.
const S = (inner, sw = 2) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
// Icônes du bureau : jeu unique et vendorisé (cf. lib/icons.js). L'objet reste
// un accès par clé pour ne pas réécrire les centaines d'usages `ICON.xxx`.
const ICON = new Proxy({}, { get: (_, name) => lumenIcon(String(name)) });

// Icônes des modes du bureau : chacune dit ce que le mode FAIT — une
// conversation, un aiguillage, une boîte à outils, une doc, un enchaînement.
const MODE_ICONS = {
  chat: lumenIcon("messages-square"),
  router: lumenIcon("route"),
  tools: lumenIcon("pocket-knife"),
  docs: lumenIcon("book-open-text"),
  rag: lumenIcon("library"),
  workflow: lumenIcon("workflow"),
};
const IS_WINDOWS = /Windows/i.test(navigator.userAgent || navigator.platform || "");
// Libellés de raccourcis : ⌘ sur Mac, Ctrl partout ailleurs.
const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
// Icônes pleines pour les cartes d'applications du Start menu (reprises du HUB).
const ICONAPP_folder = lumenIcon("folder");
const ICONAPP_designer = lumenIcon("designer");
// Fluxo : deux flux qui convergent vers une sortie. Lisible dès 15 px, là où
// l'ancienne icône (blocs + éclair) se brouillait en pâté.
const ICONAPP_fluxo = lumenIcon("fluxo");
// Forge : une enclume.
const ICONAPP_forge = lumenIcon("forge");
// Automations partageait l'icône du Designer : les deux cartes étaient
// indiscernables dans le menu démarrer. Ici, un enchaînement d'étapes déclenché
// (éclair) plutôt que le graphe de nœuds du Designer.
const ICONAPP_automations = lumenIcon("automations");
const ICONAPP_kanban = lumenIcon("kanban");
const ICONAPP_docs = lumenIcon("docs");
const ICONAPP_agents = lumenIcon("agents");
const ICONAPP_pages = lumenIcon("pages");
const ICONAPP_keynote = lumenIcon("keynote");
const ICONAPP_appstudio = lumenIcon("appstudio");
const ICONAPP_imagestudio = lumenIcon("imagestudio");
const ICONAPP_moodboard = lumenIcon("moodboard");
const ICONAPP_podcast = lumenIcon("podcast");
const ICONAPP_music = lumenIcon("music");
const ICONAPP_canvas = lumenIcon("canvas");
const ICONAPP_data = lumenIcon("data");
const ICONAPP_mindmap = lumenIcon("mindmap");
const ICONAPP_domotique = lumenIcon("domotique");
const ICONAPP_editor = lumenIcon("editor");
const ICONAPP_notes = lumenIcon("notes");
const ICONAPP_calendar = lumenIcon("calendar");
const ICONAPP_knowledge = lumenIcon("knowledge");
const ICONAPP_inbox = lumenIcon("inbox");
const ICONAPP_games = lumenIcon("games");
// Atelier des agents — icône « établi / outils » (marteau + clé croisés sur un plan de travail).
// Studio de voix — micro + onde sonore.
const ICONAPP_voicelab = lumenIcon("voicelab");
// Luciole (ex-Compagnon IA) — créature ronde aux grands yeux.
const ICONAPP_aipet = lumenIcon("aipet");
// Aventure narrative — manette/dé d'aventure (boussole stylisée).
const ICONAPP_adventure = lumenIcon("adventure");
// Recherche profonde — loupe sur document.
const ICONAPP_research = lumenIcon("research");
const ICONAPP_tables = lumenIcon("tables");
const ICONAPP_llmlog = lumenIcon("llmlog");
const ICONAPP_profiler = lumenIcon("profiler");
const ICONAPP_memory = lumenIcon("memory");
// Atelier ML — petit graphe de neurones.
const ICONAPP_ml = lumenIcon("ml");
// Navigateur web — globe.
const ICONAPP_browser = lumenIcon("browser");

// Signale aux autres fenêtres (notamment la principale) l'état du mode bureau,
// pour qu'un seul orbe soit affiché à la fois.
function broadcastDesktop(active) { try { emitEvent?.("desktop-mode", { active }); } catch {} }
function requestSandboxRefresh() { window.dispatchEvent(new CustomEvent("sandbox-refresh-needed")); }

// ===== Miroir du compagnon mobile (depuis la fenêtre du bureau) =====
// Le bureau (sandbox) vit dans une fenêtre Tauri distincte : la fenêtre principale
// — où réside le miroir compagnon — ne voit ni son chat ni son orbe. On reflète
// donc l'orbe et la transcription directement vers les téléphones (le backend
// `remote_broadcast` diffuse à tous les clients connectés ; no-op s'il n'y en a pas).
function remotePush(obj) {
  invoke("remote_broadcast", { payload: JSON.stringify(obj) }).catch(() => {});
}

// Enrobe window.LumenOrb.setState pour pousser chaque changement d'état vers les
// téléphones (réflexion / parole / repos). L'orbe est servi par orb.js ; on attend
// qu'il existe puis on pose le hook une seule fois.
function hookCompanionOrb() {
  if (!window.LumenOrb || window.LumenOrb.__dtRemoteHooked) return !!window.LumenOrb?.__dtRemoteHooked;
  const origState = window.LumenOrb.setState;
  if (typeof origState !== "function") return false;
  window.LumenOrb.setState = function (next) {
    remotePush({ type: "orb", state: next });
    return origState.apply(this, arguments);
  };
  window.LumenOrb.__dtRemoteHooked = true;
  return true;
}
function ensureCompanionOrbHook() {
  if (hookCompanionOrb()) return;
  const iv = setInterval(() => { if (hookCompanionOrb()) clearInterval(iv); }, 200);
  setTimeout(() => clearInterval(iv), 5000);
}

// Snapshot de la transcription du bureau (fenêtre « assistant ») au format attendu
// par le compagnon : mêmes clés que remoteSnapshotTranscript de la barre Lumen.
function snapshotDesktopTranscript() {
  const w = openWindows.get("assistant");
  const log = w?.body?.querySelector(".dt-chat-log");
  const messages = [];
  if (!log) {
    convo.forEach((m) => {
      if (m.role === "user" || m.role === "assistant") messages.push({ sender: m.role === "user" ? "user" : "assistant", text: m.content || "" });
    });
    remotePush({ type: "transcript", messages });
    return;
  }
  log.querySelectorAll(".dt-msg").forEach((b) => {
    const sender = b.classList.contains("user") ? "user" : "assistant";
    // La réponse finale vit dans `.dt-answer` (modes routeur/outils) ; sinon tout
    // le corps (chat simple). On exclut la ligne de statistiques (hors `.dt-msg-body`).
    const el = b.querySelector(".dt-answer") || b.querySelector(".dt-msg-body") || b;
    const text = (el.innerText || el.textContent || "").trim();
    // Étapes de progression : transmises structurées (mêmes puces qu'au bureau).
    let progress;
    const steps = b.querySelectorAll(".run-progress .run-step");
    // Raisonnement et appels d'outils : blocs repliables, comme dans la barre.
    let blocks;
    const blockEls = b.querySelectorAll(".lm-plan, .lm-think, .lm-tool");
    if (blockEls.length) {
      const cut = (s) => { s = String(s || ""); return s.length > 3000 ? `${s.slice(0, 3000)}…` : s; };
      blocks = [];
      blockEls.forEach((d) => {
        if (d.classList.contains("lm-plan")) {
          blocks.push({
            kind: "plan",
            title: d.querySelector(":scope > summary .lm-name")?.textContent || "",
            live: d.classList.contains("live"),
            summary: (d.querySelector(":scope > summary .lm-hint")?.textContent || "").replace(/^\s*·\s*/, ""),
            tools: [...d.querySelectorAll(".lm-plan-tools .lm-chip")].map((c) => ({ name: c.textContent, cat: c.title })),
            steps: [...d.querySelectorAll(".lm-steps > .lm-step")].map((li, i) => ({
              id: `s${i}`,
              label: li.querySelector(".lm-step-label")?.textContent || "",
              status: ["running", "ok", "warn", "skip"].find((c) => li.classList.contains(c)) || "ok",
              detail: li.querySelector(".lm-step-detail")?.textContent || "",
              wait: li.classList.contains("running") ? li.querySelector(".lm-step-wait")?.textContent || "" : "",
              items: [...li.querySelectorAll(".lm-step-items > li")].map((x) => x.textContent).slice(0, 6),
            })),
          });
        } else if (d.classList.contains("lm-think")) {
          blocks.push({ kind: "think", live: d.classList.contains("live"), label: d.querySelector(".lm-label")?.textContent || "", text: cut(d.querySelector(".lm-body")?.textContent) });
        } else {
          const done = d.classList.contains("done");
          blocks.push({ kind: "tool", name: d.dataset.tool || d.querySelector(".lm-name")?.textContent || "", args: cut(d.querySelector(".lm-args pre")?.textContent), ...(done ? { result: cut(d.querySelector(".lm-res pre")?.textContent) } : {}) });
        }
      });
    }
    if (steps.length) {
      progress = [];
      steps.forEach((s) => {
        if (s.querySelector(".tool-call-note")) return;
        if (s.dataset.kind === "image" && s.dataset.path) { progress.push({ kind: "image", path: s.dataset.path }); return; }
        const msgEl = s.querySelector(".run-step-msg");
        const message = (msgEl?.innerText || msgEl?.textContent || "").trim();
        if (message) progress.push({ kind: s.dataset.kind || "progress", message });
      });
    }
    if (text || (progress && progress.length) || blocks) {
      const m = { sender, text };
      if (progress && progress.length) m.progress = progress;
      if (blocks) m.blocks = blocks;
      messages.push(m);
    }
  });
  remotePush({ type: "transcript", messages });
}

// Observe la fenêtre de conversation pour pousser la transcription à chaque
// changement (envoi, streaming, résultats d'action). Posé une seule fois par
// fenêtre via un drapeau sur l'élément.
function ensureTranscriptMirror(win) {
  const body = win?.body;
  if (!body || body.__dtRemoteObserved) return;
  body.__dtRemoteObserved = true;
  // Cadencé, pas « anti-rebond » : pendant un flux les mutations ne cessent
  // jamais, et le compagnon / Lumen XR doivent suivre la réponse en direct.
  let pending = null;
  const obs = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; snapshotDesktopTranscript(); }, 150);
  });
  obs.observe(body, { childList: true, subtree: true, characterData: true });
  snapshotDesktopTranscript();
}

function remotePushConversations() {
  const items = getSavedConversations().map((c) => ({ id: c.id, title: c.title || "Discussion" }));
  remotePush({ type: "conversations", items, currentId: currentConvId });
  refreshAssistConvos();  // garde la liste latérale de l'assistant à jour
}

function remotePushAutospeak() {
  remotePush({ type: "autospeak", on: localStorage.getItem("autoSpeak") === "true" });
}

async function remotePushOllamaMode() {
  let workflows = [];
  try { workflows = await invoke("list_fluxo_workflows"); } catch {}
  const modes = [
    { id: "chat", label: "Chat", desc: "Ollama direct" },
    { id: "router", label: "Routeur", desc: "Workflow « default router »" },
    { id: "tools", label: "Outils", desc: "Function calling (appel de workflows)" },
    { id: "docs", label: "Documentation", desc: "Recherche dans la documentation Lumen" },
  ];
  const mode = getMode();
  const workflow = getWorkflow();
  remotePush({
    type: "llm-mode",
    available: true,
    mode,
    workflow,
    label: mode === "workflow" && workflow ? workflow : (MODE_LABELS[mode] || "Chat"),
    modes,
    workflows,
  });
}

function remotePushNotifications() {
  let items = [];
  try {
    items = JSON.parse(localStorage.getItem("heartbeatNotifications") || "[]") || [];
  } catch {}
  remotePush({
    type: "notifications",
    items: items.map((n) => ({
      shortcut: n.shortcut,
      output: n.output,
      success: n.success,
      timestamp: n.timestamp,
    })),
  });
}

function remotePushActionMode() {
  remotePush({ type: "action-mode", available: true, active: getMode() === "router" });
}

function remotePushAll() {
  snapshotDesktopTranscript();
  remotePushConversations();
  remotePushAutospeak();
  remotePushActionMode();
  remotePushOllamaMode();
  remotePushNotifications();
  remotePushOrbAppearance();
}

// Apparence de l'orbe envoyée au(x) téléphone(s), comme le fait la barre : le
// compagnon a son propre localStorage et resterait sinon sur la palette par
// défaut. `orbSize` est volontairement absent (le mobile a la sienne) et
// `orbAvatarMode` aussi (un GLB personnalisé n'existe que sur cette machine).
function remotePushOrbAppearance() {
  const payload = {};
  for (const key of ["orbTheme", "orbColors", "orbGlassType", "orbCoreScale", "orbPulse",
    "orbHeartbeat", "orbHeartColor", "orbPulseStrength", "orbPulseSpeed", "orbMouth"]) {
    const value = localStorage.getItem(key);
    if (value != null) payload[key] = value;
  }
  remotePush({ type: "orb-appearance", payload });
}

function handleRemoteCommand(cmd) {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.type) {
    case "open-app": {
      // Raccourci « Ouvrir une app sur l'ordinateur » : par id ou par nom.
      const want = String(cmd.id || "").trim().toLowerCase();
      const byName = dtApps().find((a) => a.name?.toLowerCase() === want || a.id === want);
      if (!openAppById(byName?.id || want)) dtToast?.(`App introuvable : ${cmd.id}`);
      break;
    }
    case "chat":
      if (typeof cmd.text === "string" && cmd.text.trim() && !busy) askAssistant(cmd.text.trim());
      break;
    case "clear":
    case "new-conversation":
      newConversation();
      break;
    case "list-conversations":
      remotePushAll();
      break;
    case "load-conversation": {
      const conv = getSavedConversations().find((c) => c.id === cmd.id);
      if (conv) loadConversation(conv);
      break;
    }
    case "set-autospeak":
      autospeak = !!cmd.on;
      lsSet("autoSpeak", String(autospeak));
      chatEl?.querySelector('[data-act="speak"]')?.classList.toggle("active", autospeak);
      remotePushAutospeak();
      break;
    case "set-action-mode":
      setMode(cmd.on ? "router" : "chat");
      break;
    case "set-ollama-mode":
      if (cmd.mode) setMode(cmd.mode, cmd.workflow);
      break;
    case "list-notifications":
      remotePushNotifications();
      break;
    case "clear-notifications":
      lsSet("heartbeatNotifications", "[]");
      lsSet("heartbeatNotifUnread", "0");
      updateHeartbeatBadges();
      remotePushNotifications();
      break;
  }
}

function applySettingsPayload(payload = {}, { persist = false, pushBackend = false } = {}) {
  if (!payload || typeof payload !== "object") return;
  // Le fond d'écran a quitté la barre des tâches pour Paramètres → Apparence,
  // où sont déjà le thème et l'habillage. Mais le sélecteur appartient au
  // bureau — lui seul connaît ses widgets et sa surface : les Paramètres le
  // DEMANDENT par ce canal au lieu d'en avoir une seconde copie.
  if (payload.openWallpaper) {
    openWallpaperWindow();
    return;
  }
  if (persist) {
    Object.entries(payload).forEach(([key, value]) => {
      if (value == null) return;
      lsSet(key, typeof value === "string" ? value : JSON.stringify(value));
    });
  }
  if (Object.prototype.hasOwnProperty.call(payload, "dtTheme")) {
    const theme = String(payload.dtTheme || "");
    // « auto » = suivre le système, et c'est un CHOIX : on l'enregistre, au
    // lieu d'effacer la clé — sans quoi il se confondrait avec « jamais
    // choisi », où l'édition Pro impose son sombre.
    //
    // `setTheme` fait tout le reste : clé unifiée, anciennes clés, et pose des
    // attributs sur <html> par le même code que l'amorçage. Poser l'attribut
    // ici en plus, c'était une deuxième implémentation du même calcul.
    setTheme(theme || "auto");
    if (theme) wsSet("dtTheme", theme);
    else wsRemove("dtTheme");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "uiAccent")) {
    saveUiTheme({ accent: String(payload.uiAccent || "") });
  }
  if (chatEl) {
    if (["ollamaMode", "ollamaWorkflow", "fluxoTools"].some((key) => Object.prototype.hasOwnProperty.call(payload, key))) updateModeBtn();
    if (Object.prototype.hasOwnProperty.call(payload, "selectedModel") || Object.prototype.hasOwnProperty.call(payload, "aiSource")) {
      const pill = chatEl.querySelector(".dt-model-pill");
      if (pill) pill.textContent = effectiveModelLabel(); refreshAssistChrome();
    }
    if (["apiModel", "lumenModel", "applefmModel"].some((key) => Object.prototype.hasOwnProperty.call(payload, key)) && isApiLike(aiSourceNow())) {
      const pill = chatEl.querySelector(".dt-model-pill");
      if (pill) pill.textContent = effectiveModelLabel(); refreshAssistChrome();
    }
    if (Object.prototype.hasOwnProperty.call(payload, "autoSpeak")) {
      autospeak = payload.autoSpeak === true || payload.autoSpeak === "true";
      chatEl.querySelector('[data-act="speak"]')?.classList.toggle("active", autospeak);
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "heartbeatEnabled") || Object.prototype.hasOwnProperty.call(payload, "heartbeatNotifUnread")) {
    updateHeartbeatBadges();
  }
  // Réglages de l'avatar (Paramètres → Avatar) : appliqués aussi à l'orbe du
  // bureau, en direct (draft) comme à l'enregistrement. Taille/position exclues
  // (keepSize) : elles se règlent directement sur l'orbe du bureau. La visibilité
  // reste, elle aussi, pilotée par le bureau (showOrb).
  if (Object.keys(payload).some((k) => (k === "robotHeadOptions" || k.startsWith("orb")) && k !== "orbEnabled" && k !== "orbSize")) {
    window.LumenOrb?.applyAppearance?.(payload, { keepSize: true });
  }
  if (pushBackend && ["aiSource", "ollamaUrl", "selectedModel", "apiBaseUrl", "apiKey", "apiModel"].some((key) => Object.prototype.hasOwnProperty.call(payload, key))) {
    pushOllamaConfig();
  }
}

let getCurrent = () => null;   // renvoie la sandbox active (fournie par main.js)
let root = null;               // #desktop (fond d'écran + widgets)
let zTop = 520;                // compteur de z-index des fenêtres
let widgetsLayer, taskbarWins;
let chatEl = null, taskbarEl = null;   // chrome ajouté au <body> (au-dessus des fenêtres)
let dockEl = null;                     // dock façon macOS (mode dock)
let dockMode = false;                  // mode dock actif : dock d'icônes + chat en haut
let pendingCreativeEdit = null;        // { label, onSubmit } quand la barre est en mode édition IA

// Active le mode « édition IA » sur la barre de chat : focus + chip + surbrillance.
// Le prochain envoi route le prompt vers l'élément créatif ciblé.
function enterCreativeEditMode({ label, onSubmit }) {
  pendingCreativeEdit = { label, onSubmit };
  if (!chatEl) return;
  const row = chatEl.querySelector(".dt-chat-row");
  const input = chatEl.querySelector(".dt-chat-input");
  chatEl.classList.add("ce-edit-mode");
  let chip = chatEl.querySelector(".ce-edit-chip");
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "ce-edit-chip";
    row.insertBefore(chip, input);
  }
  chip.innerHTML = `<span>✦ ${escapeHtml(label)}</span><button title="${tt("Annuler")}">×</button>`;
  chip.querySelector("button").addEventListener("click", exitCreativeEditMode);
  input.placeholder = tt("Décris la modification puis Entrée…");
  input.focus();
}
function exitCreativeEditMode() {
  pendingCreativeEdit = null;
  if (!chatEl) return;
  chatEl.classList.remove("ce-edit-mode");
  chatEl.querySelector(".ce-edit-chip")?.remove();
  const input = chatEl.querySelector(".dt-chat-input");
  if (input) input.placeholder = "Demandez à votre assistant IA…";
}
let appEl = null;              // le vrai explorateur (#app) transformé en fenêtre
const openWindows = new Map(); // id → { el, taskBtn }

export function isDesktopActive() { return root && !root.hidden; }

export function initDesktop(opts) {
  getCurrent = opts.getCurrent;
  // Registre des applications installées. Les menus lisent `dtApps()` à
  // l'ouverture, donc il n'y a rien à repeindre : il suffit que la liste soit
  // à jour. On la relit au démarrage, à chaque installation ou désinstallation
  // (évènement `lumen-apps-changed`), et au retour sur la fenêtre — le moment
  // où quelque chose a pu bouger dans une autre fenêtre.
  refreshInstalled();
  onInstalledChange(() => { document.querySelector(".dt-start")?.remove(); refreshDock?.(); });
  // Le thème peut changer depuis une AUTRE fenêtre (Paramètres, bouton de la
  // barre de chat). Le bureau repeint alors ses iframes de même origine ; les
  // apps packagées, sur une autre origine, sont prévenues par leur pont.
  onAppearanceChange(() => { applyTheme(resolvedTheme()); refreshFramesTheme(); });
  window.addEventListener("focus", () => { refreshInstalled(); });
  // Branche l'éditeur créatif par objets sur les helpers du shell bureau.
  setCreativeContext({
    createWindow, closeWindow, getCurrent: () => getCurrent(),
    listSandboxes: async () => await invoke("sandbox_list").catch(() => []),
    requestSandboxRefresh, listSandboxImages,
    requestChatEdit: enterCreativeEditMode,
    captureReportVisuals,
  });
  // Calc (tableur) : mêmes helpers de fenêtrage, plus l'ouverture de hub dont
  // il se sert pour envoyer une feuille vers l'onglet Analyse de Prisme.
  setSheetsContext({
    createWindow, closeWindow, getCurrent: () => getCurrent(),
    listSandboxes: async () => await invoke("sandbox_list").catch(() => []),
    requestSandboxRefresh,
    openHub: (hub, tab) => openHub(hub, tab),
  });
  // Édition Pro : la question est posée au binaire dès le montage du shell. La
  // réponse arrive en quelques millisecondes ; un menu déjà peint sans les apps
  // Pro est simplement refermé, il se reconstruit au clic suivant.
  whenProResolved(async (on) => {
    if (!on) return;
    // Les espaces partagés n'existent qu'en édition Pro : on ne les demande
    // qu'une fois la réponse du Rust connue.
    await loadSharedSpaces();
    // Les menus lisent `dtApps()` à l'ouverture : il n'y a rien à repeindre,
    // il suffit que la liste soit à jour quand on les ouvre. On la rafraîchit
    // au retour sur la fenêtre, le moment où un partage a pu changer ailleurs.
    window.addEventListener("focus", () => { loadSharedSpaces(); });
    document.querySelector(".dt-start")?.remove();
    document.querySelectorAll(".dt-boot-name, .dt-start-sub").forEach((el) => {
      if (el.textContent.trim() === "Lumen Desktop") el.textContent = "Lumen Desktop Pro";
    });
  });
  root = document.getElementById("desktop");
  appEl = document.querySelector(".app");
  // Si la fenêtre est fermée alors que le bureau est actif, on rend l'orbe à la
  // fenêtre principale pour ne pas le laisser masqué.
  window.addEventListener("beforeunload", () => { if (isDesktopActive()) broadcastDesktop(false); });
  // Synchro cross-fenêtre : quand la barre Lumen (autre fenêtre) change un réglage
  // partagé, on met à jour la barre du bureau (event `storage`).
  window.addEventListener("storage", (e) => {
    if (!isDesktopActive() || !chatEl) return;
    if (e.key === "ollamaMode" || e.key === "ollamaWorkflow" || e.key === "fluxoTools") { updateModeBtn(); refreshMemoryBtn(); }
    if (e.key === "selectedModel" || e.key === "apiModel" || e.key === "aiSource") { const pill = chatEl.querySelector(".dt-model-pill"); if (pill) pill.textContent = effectiveModelLabel(); refreshAssistChrome(); }
    if (e.key === "autoSpeak") { autospeak = e.newValue === "true"; chatEl.querySelector('[data-act="speak"]')?.classList.toggle("active", autospeak); }
    if (e.key === "memoryTool" || e.key === "aiSource" || e.key === "lumenDisabledTools") refreshMemoryBtn();
    if (e.key === "orchestrateChat" || e.key === "ollamaMode" || e.key === "aiSource") refreshOrchestrateBtn();
    if (e.key === "heartbeatEnabled" || e.key === "heartbeatNotifUnread") updateHeartbeatBadges();
    if (e.key === "uiAccent" || e.key === "uiBase" || e.key === "uiRadius") applyUiTheme(document);
    // Réglages d'apparence de l'orbe modifiés depuis une autre fenêtre (repli
    // storage si l'event Tauri n'est pas reçu) — taille/visibilité exclues.
    if (e.key && (e.key === "robotHeadOptions" || e.key.startsWith("orb")) && e.key !== "orbEnabled" && e.key !== "orbSize") {
      window.LumenOrb?.applyAppearance?.({}, { keepSize: true });
    }
    if (["ollamaMode", "ollamaWorkflow", "fluxoTools", "autoSpeak", "heartbeatNotifications", "heartbeatNotifUnread"].includes(e.key)) remotePushAll();
  });
  // Progression des runs Fluxo (routeur/workflow) relayée par le serveur loopback.
  window.__TAURI__?.event?.listen?.("run-progress", (e) => onRunProgress(e.payload));
  window.__TAURI__?.event?.listen?.("settings-draft", (e) => applySettingsPayload(e.payload || {}));
  window.__TAURI__?.event?.listen?.("settings-updated", (e) => applySettingsPayload(e.payload || {}, { persist: true, pushBackend: true }));
  // Source cliquée dans une réponse de la barre : c'est le bureau qui ouvre.
  window.__TAURI__?.event?.listen?.("lumen-open", (e) => { if (isDesktopActive()) openFromAssistant(e.payload); });
  window.__TAURI__?.event?.listen?.("remote-command", (e) => {
    let cmd;
    try { cmd = JSON.parse(e.payload); } catch { return; }
    // Réponse du téléphone à une demande posée par CETTE fenêtre (id inconnu :
    // sans effet) — traitée même si le bureau n'est plus au premier plan.
    if (cmd?.type === "user-answer") { answerUserRequest(String(cmd.id || ""), String(cmd.choice || "")); return; }
    // « Stop » depuis le casque / le téléphone : génération et lecture du bureau.
    if (cmd?.type === "stop-generation") {
      dtAbort?.abort();
      dtAnnouncePending = null;
      invoke("stop_speaking").catch(() => {});
      invoke("tts_stop").catch(() => {});
      return;
    }
    if (!isDesktopActive()) return;
    handleRemoteCommand(cmd);
  });
  // Nouvelle notification Heartbeat → rafraîchit la fenêtre si elle est ouverte.
  window.__TAURI__?.event?.listen?.("heartbeat-result", () => {
    const w = openWindows.get("notifs"); if (w) renderNotifications(w.body);
    updateHeartbeatBadges();
    remotePushNotifications();
  });
  window.__TAURI__?.event?.listen?.("agents-updated", () => { refreshAgentTaskWidgets(); refreshTimelineWidgets(); refreshContextGraphWidgets(); });
  window.__TAURI__?.event?.listen?.("agent-progress", () => { refreshAgentTaskWidgets(); refreshTimelineWidgets(); refreshContextGraphWidgets(); });
  window.addEventListener("sandbox-refresh-needed", () => {
    refreshTimelineWidgets();
    refreshContextGraphWidgets();
  });
}

// L'écran de connexion n'est sauté que si CETTE fenêtre a déjà ouvert une
// session (sessionStorage, par fenêtre) ET que le backend est déverrouillé.
// Une nouvelle fenêtre workspace repasse donc toujours par le login, même si
// le dernier profil actif n'a pas de mot de passe.
// Trace de diagnostic (window-diagnostics.log via frontend_log).
const dtTrace = (m) => { try { invoke("frontend_log", { level: "desktop", message: m }); } catch {} };

async function dtSessionAlreadyOpen() {
  const flag = sessionStorage.getItem("dtSessionOpen");
  const unlocked = flag === "1" ? await invoke("session_is_unlocked").catch(() => false) : null;
  dtTrace(`dtSessionAlreadyOpen flag=${flag} unlocked=${unlocked}`);
  if (flag !== "1") return false;
  // Une session existante peut provenir d'une ancienne version qui ne
  // persistait pas encore l'identité côté webview. Réhydrate-la depuis Rust
  // afin que le mode Consultation affiche toujours le profil réellement
  // connecté, même lorsque l'écran de login est contourné.
  if (unlocked === true && !sessionStorage.getItem("lumenSessionDisplayName")) {
    const backendIdentity = await invoke("session_lock_status").catch(() => null);
    if (backendIdentity?.profile_name) sessionStorage.setItem("lumenSessionDisplayName", backendIdentity.profile_name);
    if (backendIdentity?.avatar) sessionStorage.setItem("lumenSessionAvatar", backendIdentity.avatar);
  }
  return unlocked === true;
}

// Après un changement de profil au login, la webview est rechargée : ce flag
// dit si le rechargement doit relancer le mode bureau (`?desktop=1`) ou non.
let dtLoginDesktopIntent = false;

export async function enterDesktop() {
  await ensureProfileStoragePrefix();
  if (!getCurrent() || isDesktopActive() || dtBootInProgress) return;
  // Le shell n'est PAS construit avant l'ouverture de session : rien n'est
  // préchargé (ni visible) derrière l'écran de connexion, et le mot de passe
  // est vérifié côté Rust (`session_unlock`).
  if (await dtSessionAlreadyOpen()) { activateWorkspaceMode(sessionStorage.getItem("lumenWorkspaceMode")); return; }
  dtLoginDesktopIntent = true;
  showBootAndLogin((mode) => activateWorkspaceMode(mode), true);
}

/// Un seul visage du bureau depuis la suppression du mode consultation : le
/// paramètre reste pour les appelants (écran de connexion), il est ignoré.
function activateWorkspaceMode(_selectedMode) {
  sessionStorage.setItem("lumenWorkspaceMode", "work");
  dtTrace("activateWorkspaceMode mode=work");
  // Une déconnexion/reconnexion remonte le bureau dans la même webview. On
  // démonte alors proprement l'ancien bureau pour reconstruire son chrome
  // (chat, dock, widgets) sans conserver l'état précédent.
  if (isDesktopActive()) exitDesktop();
  document.querySelector("#desktop")?.style.removeProperty("display");
  document.querySelector(".app")?.style.removeProperty("display");
  document.querySelectorAll("#dt-orb-real,.dt-chat,.dt-taskbar,.dt-dock,.orb-wrap,.bar-area,.taskbar,.desktop-status-bar").forEach(el => el.style.removeProperty("display"));
  mountDesktop();
}

export async function enterDesktopAfterUnlock(prepare) {
  await ensureProfileStoragePrefix();
  dtTrace(`enterDesktopAfterUnlock active=${isDesktopActive()} boot=${dtBootInProgress}`);
  if (isDesktopActive() || dtBootInProgress) return;
  const open = async (mode = sessionStorage.getItem("lumenWorkspaceMode")) => {
    await prepare?.();
    if (!getCurrent()) return;
    activateWorkspaceMode(mode);
  };
  if (await dtSessionAlreadyOpen()) { await open(sessionStorage.getItem("lumenWorkspaceMode")); return; }
  dtLoginDesktopIntent = true;
  showBootAndLogin(open, true);
}

// Ouverture de session SANS monter le bureau : utilisé par l'explorateur quand
// le backend est verrouillé (les commandes sandbox échoueraient sinon).
export async function requireSessionUnlock(onUnlocked) {
  if (isDesktopActive() || dtBootInProgress) return;
  if (await dtSessionAlreadyOpen()) { await onUnlocked?.(); return; }
  dtLoginDesktopIntent = false;
  showBootAndLogin(onUnlocked, false);
}
function mountDesktop() {
  buildShell();
  root.hidden = false;
  applyGlassSkin();      // barres translucides (hors Linux/WebKitGTK)
  mountAppWindow();      // l'explorateur réel devient une fenêtre draggable
  applyWallpaper();      // fond d'écran personnalisé éventuel
  applyAccentColor();    // couleur d'accent workspace
  showOrb(true);
  broadcastDesktop(true);
  ensureCompanionOrbHook();  // reflète l'orbe du bureau vers les téléphones
  invoke("companion_start").then(() => setTimeout(remotePushAll, 100)).catch(() => {});
  restoreWidgets();
  watchPreview();        // auto-masque le chat quand l'aperçu fichier s'ouvre
  updateChatVisibility();
  installDesktopShortcuts(); // clavier du bureau (cf. sandbox/shortcuts.js)
  maybeStartDesktopTour();   // visite guidée à la première session
  maybeShowMorning();        // vue du matin, une fois par jour
  watchTelegramThreads();    // fils Telegram dans la liste des conversations
  installDesktopContextMenu(); // clic droit sur le bureau → menu Lumen
  installIntelligence();     // outils d'écriture + feuille IA flottante (toutes les apps)
  installRfidBindings();     // badges RFID du Lumen Controller (hors login)
  flushInteropQueue();       // objets « Envoyer vers… » reçus avant l'ouverture de session
}

// ===== Verre liquide des barres du bureau =====================================
// Barre des tâches, dock, barre de chat et panneaux flottants deviennent
// translucides avec flou d'arrière-plan (façon Liquid Glass), UNIQUEMENT sur le
// bureau. WebKitGTK (Linux, Raspberry Pi) peint tout `backdrop-filter` en boîte
// opaque sans vrai GPU : sous ces saveurs, la classe n'est jamais posée et les
// barres restent pleines, comme partout ailleurs dans Lumen.
async function applyGlassSkin() {
  let flavor = "default";
  try { flavor = await getFlavor(); } catch {}
  const ok = flavor !== "rpi" && flavor !== "linux-standard" && !/Linux/i.test(navigator.platform || "");
  document.body.classList.toggle("dt-glass", ok && isDesktopActive());
}

// ===== Intelligence contextuelle : outils d'écriture + feuille IA ============
//
// Deux gestes façon Apple Intelligence, disponibles dans TOUTES les apps du
// bureau (natives, hubs, paquets d'une autre origine via AppKit) :
//   - sélectionner un texte → étincelle / clic droit / ⌘⇧E → Relire, Réécrire,
//     Résumer, Traduire, Demander à Lumen… (lib/writing-tools.js) ;
//   - une question contextuelle (sélection, image, capture d'écran) reçoit sa
//     réponse dans une FEUILLE FLOTTANTE posée près de la zone interrogée
//     (lib/ai-sheet.js), et non dans la fenêtre Assistant — qui reste à un
//     clic (« Agrandir ») quand l'échange mérite plus de place.

let intelligenceReady = false;
function installIntelligence() {
  if (intelligenceReady) return;
  intelligenceReady = true;
  window.LumenAskSheet = (spec) => openLumenSheet(spec);
  installWritingTools({
    openSheet: (spec) => openLumenSheet(spec),
    share: (obj) => shareObject(obj),
    toast: (msg, isError = true) => dtToast(msg, isError),
    openUrl: (url) => openExternal(url),
    // « Énoncer » : la voix locale (Piper/Kokoro) et l'orbe qui s'anime.
    speak: (text) => speak(text),
  });
}

/** Prompt système court de la feuille : l'identité de Lumen, sans le profil complet. */
async function sheetSystemPrompt() {
  let profile = { ...DT_DEFAULT_PROFILE };
  try { const e = await invoke("memory_get", { key: "user/profile" }); if (e && e.value && typeof e.value === "object") profile = { ...DT_DEFAULT_PROFILE, ...e.value }; } catch {}
  const brief = dtLang() === "en"
    ? "Answer briefly and concretely: this is a small floating panel, not a full conversation. Use Markdown sparingly."
    : "Réponds brièvement et concrètement : c'est une petite feuille flottante, pas une conversation complète. Markdown avec parcimonie.";
  return [composeProfilePreamble(profile), brief].filter(Boolean).join("\n\n");
}

/**
 * Ouvre la feuille IA du bureau. `spec` : { title, question, context, images,
 * anchor, actions, placeholder }. « Agrandir » verse l'échange dans une
 * nouvelle conversation de la fenêtre Assistant.
 */
function openLumenSheet(spec = {}) {
  if ((aiSourceNow() || "ollama") === "shortcut") {
    // Les Raccourcis Apple ne prennent ni contexte ni image : on garde le chemin classique.
    if (spec.question) askAssistant(spec.context ? `${spec.question}\n\n${spec.context}` : spec.question, spec.images || []);
    return null;
  }
  const ctrl = openAiSheet({
    ...spec,
    lang: dtLang(),
    send: async (messages, o) => {
      const sys = await sheetSystemPrompt();
      const msgs = [{ role: "system", content: sys }, ...messages.filter((m) => m.role !== "system").map(({ display: _d, ...m }) => m)];
      const out = await llmChat(msgs, { ...(o || {}), rawSystem: true });
      return typeof out === "string" ? out : out?.content ?? "";
    },
    onExpand: (messages) => {
      newConversation();
      for (const m of messages) {
        if (m.role === "system") continue;
        convo.push(m.role === "user" ? { role: "user", content: m.content, display: m.display || m.content, ...(m.images ? { images: m.images } : {}) } : { role: "assistant", content: m.content });
      }
      const win = ensureConvoWindow();
      renderAssistantConversation(win);
      snapshotDesktopTranscript();
    },
  });
  return ctrl;
}

/**
 * « Résumer la fenêtre active » : le texte visible de la fenêtre au premier
 * plan (page d'app même origine, ou app paquet via le pont AppKit) est envoyé
 * à la feuille avec une demande de résumé. Résumé INLINE, pas dans le chat.
 */
async function summarizeActiveWindow() {
  const en = dtLang() === "en";
  let top = null, z = -1;
  for (const [, w] of openWindows) {
    if (!w?.el || w.minimized) continue;
    const zi = Number(w.el.style.zIndex || 0);
    if (zi > z) { z = zi; top = w; }
  }
  if (!top) { dtToast(tt("Aucune fenêtre ouverte."), false); return; }
  const frames = [...top.el.querySelectorAll("iframe.dt-appframe")].filter((f) => f.offsetParent !== null);
  const frame = frames[frames.length - 1] || null;
  let text = "", title = top.el.querySelector(".dt-win-title")?.textContent?.trim() || "";
  try {
    if (frame?.contentDocument?.body) {
      const main = frame.contentDocument.querySelector("main, [role=main], article") || frame.contentDocument.body;
      text = main.innerText || "";
    } else if (frame?.__lumenHost) {
      const r = await frame.__lumenHost.pageText();
      text = r?.text || ""; title = r?.title || title;
    } else {
      text = top.body?.innerText || "";
    }
  } catch { text = ""; }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 40) { dtToast(en ? "Nothing to summarize in this window." : "Rien à résumer dans cette fenêtre.", false); return; }
  const r = top.el.getBoundingClientRect();
  openLumenSheet({
    title: (en ? "Summary" : "Résumé") + (title ? ` · ${title}` : ""),
    anchor: { x: r.left + 24, y: r.top + 24, w: 0, h: 0 },
    context: text.slice(0, 14000),
    question: en ? "Summarize this content in a few key points." : "Résume ce contenu en quelques points clés.",
  });
}

/** Actions « Visual Intelligence » proposées sous une réponse sur capture. */
function visualActions(image) {
  const en = dtLang() === "en";
  return [
    { label: en ? "Extract text" : "Extraire le texte", icon: "type", run: (sheet) => sheet.ask(en ? "Transcribe all visible text faithfully, without commentary." : "Transcris fidèlement tout le texte visible, sans commentaire.", [image]) },
    { label: en ? "Translate" : "Traduire", icon: "globe", run: (sheet) => sheet.ask(en ? "Translate the text visible in this image into English." : "Traduis en français le texte visible dans cette image.", [image]) },
    { label: en ? "Search the web" : "Rechercher sur le web", icon: "search", run: async (sheet) => {
      const { messages: qMsgs, opts: qOpts } = CORE_PROMPTS["core.vision.query"].build({ image: image.b64, lang: en ? "en" : "fr" });
      const q = await llmChat(qMsgs, { ...qOpts, rawSystem: true });
      const query = String(typeof q === "string" ? q : q?.content || "").replace(/^["«\s]+|["»\s.]+$/g, "").slice(0, 120);
      if (!query) return;
      const results = await callWebTool(invoke, "web_search", { query });
      sheet.ask((en ? "Web search results for « " : "Résultats de recherche web pour « ") + query + " » :\n\n" + String(results).slice(0, 6000) + (en ? "\n\nSummarize what is relevant to the image." : "\n\nRésume ce qui est pertinent par rapport à l'image."));
    } },
    { label: en ? "Save to Corpus" : "Enregistrer dans Corpus", icon: "knowledge", run: (sheet) => {
      const last = [...sheet.messages].reverse().find((m) => m.role === "assistant");
      if (last) handoff("knowledge", makeObject("text", { text: last.content, markdown: true }, { sourceApp: "screen" }));
    } },
  ];
}


// ===== Badges RFID pendant la session =====
//
// L'écran de connexion écoutait déjà `orb-command`, mais une fois le bureau
// monté plus personne ne traitait les badges d'ACTION : seule la barre Lumen le
// faisait (`runRfidBinding` dans main.js), et elle est cachée derrière le
// bureau plein écran — l'action partait dans le vide, sans le moindre retour
// visible. Le bureau applique donc lui-même l'association ; la barre s'abstient
// tant que le mode bureau est actif (voir `remoteDesktopModeActive`).
let rfidBindingsBound = false;
function installRfidBindings() {
  if (rfidBindingsBound) return;
  rfidBindingsBound = true;
  let busy = false;
  window.__TAURI__?.event?.listen?.("orb-command", async (e) => {
    const p = e?.payload || {};
    if (p.cmd !== "rfid" || !p.uid || busy) return;
    if (!isDesktopActive()) return;          // login : géré par l'écran de session
    busy = true;
    try { await applyRfidBinding(String(p.uid)); } finally { busy = false; }
  });
}

async function applyRfidBinding(uid) {
  // La table des associations reste côté Rust : seul l'UID sort d'ici.
  const binding = await findBinding(uid).catch(() => null);
  if (!binding) { dtToast(tt("Badge inconnu : associez-le dans Réglages.")); return; }
  const params = binding.params || {};
  const pill = chatEl?.querySelector(".dt-model-pill");
  switch (binding.action) {
    case "model": {
      const source = params.backend === "apple" ? "shortcut" : (params.backend || "ollama");
      lsSet("aiSource", source);
      if (params.model) rememberModelFor(source, params.model);
      pushOllamaConfig();
      if (source === "llama") {
        const model = localStorage.getItem("selectedModel") || "";
        if (model) invoke("llama_start", { filename: model, ctxSize: Number(localStorage.getItem("llamaNumCtx") || 8192) }).catch(() => {});
      } else {
        invoke("llama_stop").catch(() => {});
      }
      if (pill) pill.textContent = effectiveModelLabel(); refreshAssistChrome();
      break;
    }
    case "chat_mode":
      if (params.mode) setMode(params.mode, params.workflow);
      break;
    case "voice":
      if (params.voice) invoke("tts_set_voice", { voice: String(params.voice) }).catch(() => {});
      break;
    default:
      break;
  }
  dtToast(tt("Badge : ") + (binding.label || binding.action), false);
}

// Les fils Telegram sont chargés au montage et suivis en direct : un message
// reçu sur le téléphone apparaît dans la liste sans rouvrir la fenêtre.
let telegramWatchBound = false;
function watchTelegramThreads() {
  loadTelegramThreads().then(refreshAssistConvos).catch(() => {});
  if (telegramWatchBound) return;
  telegramWatchBound = true;
  const evt = window.__TAURI__?.event;
  evt?.listen?.("telegram-thread-updated", () => { refreshTelegramView(); });
}
export function exitDesktop() {
  document.body.classList.remove("dt-glass");
  showOrb(false);
  broadcastDesktop(false);
  unmountAppWindow();    // rend l'explorateur plein écran
  // Ferme les fenêtres secondaires (assistant, etc.).
  for (const r of openWindows.values()) r.el.remove();
  openWindows.clear();
  previewObserver?.disconnect(); previewObserver = null;
  undecoratePreview();
  chatManualHidden = false;
  chatEl?.remove(); chatEl = null;
  taskbarEl?.remove(); taskbarEl = null;
  dockEl?.remove(); dockEl = null;
  dockMode = false;
  document.body.classList.remove("dt-dockmode");
  document.querySelectorAll(".dt-panel, .dt-menu, .dt-start, .dt-launcher").forEach((el) => el.remove());
  document.documentElement.style.removeProperty("--accent");
  document.documentElement.style.removeProperty("--accent-color");
  root.hidden = true;
  root.innerHTML = "";
}

// ===== L'explorateur réel (#app) comme fenêtre du bureau =====
// On réutilise le DOM/JS existant : toutes les fonctionnalités (recherche,
// aperçu, agent IA, menu contextuel, édition, historique, launchpad…) restent
// disponibles, sans duplication.
function mountAppWindow() {
  if (!appEl) return;
  appEl.classList.add("desktop-window");
  Object.assign(appEl.style, { left: "70px", top: "44px", width: "820px", height: "580px", zIndex: String(++zTop) });
  // Glisser la fenêtre par sa barre du haut (hors contrôles), redimensionner par
  // une poignée d'angle, passer au premier plan au clic.
  const bar = appEl.querySelector(".topbar");
  if (bar) makeDraggable(appEl, bar);
  // Bouton de fermeture (feu tricolore) injecté dans la barre du haut : masque la
  // fenêtre (réaffichable via « Fichiers » dans la barre des tâches).
  if (bar && !bar.querySelector(".dt-win-close")) {
    const close = document.createElement("button");
    close.className = "dt-win-close"; close.title = tt("Fermer la fenêtre");
    close.addEventListener("click", (e) => { e.stopPropagation(); appEl.style.display = "none"; });
    bar.insertBefore(close, bar.firstChild);
  }
  if (!appEl.querySelector(".dt-resize")) {
    const grip = document.createElement("div"); grip.className = "dt-resize";
    appEl.appendChild(grip); makeResizable(appEl, grip);
  }
  appEl.addEventListener("pointerdown", appFront, true);
  // La sandbox (explorateur de fichiers) n'est PAS ouverte par défaut en mode
  // bureau : on démarre fenêtre masquée. Réaffichable via « Fichiers » dans le
  // menu Démarrer / la barre des tâches.
  appEl.style.display = "none";
}
function appFront() { if (appEl) appEl.style.zIndex = String(++zTop); }
function unmountAppWindow() {
  if (!appEl) return;
  appEl.removeEventListener("pointerdown", appFront, true);
  appEl.querySelectorAll(".dt-resize").forEach((g) => g.remove());
  appEl.querySelector(".topbar .dt-win-close")?.remove();
  appEl.classList.remove("desktop-window");
  appEl.style.cssText = "";
}
function toggleAppWindow() {
  if (!appEl) return;
  if (appEl.style.display === "none") { appEl.style.display = ""; appFront(); }
  else appFront();
  refreshDock();  // « Fichiers » ouvert → pastille active dans le dock
}

// Pilote le vrai orbe WebGL (window.LumenOrb). Position + taille déplaçables et
// persistées par sandbox.
let orbSize = 104;
function orbKey() { const sb = getCurrent(); return wsKey(sb ? "dtOrb:" + sb.id : "dtOrb"); }
function showOrb(on) {
  const wrap = document.getElementById("dt-orb-real");
  if (wrap) wrap.hidden = !on;
  try {
    if (on) {
      setupOrb();
      // orb.js est un module différé : le bureau peut être monté avant qu'il
      // n'ait publié window.LumenOrb. Réessaie brièvement pour garantir que le
      // mode GLB activé dans les réglages est aussi honoré dans Lumen Desktop.
      const apply = (attempt = 0) => {
        if (!window.LumenOrb) {
          if (attempt < 30) setTimeout(() => apply(attempt + 1), 100);
          return;
        }
        // Apparence partagée (thème, couleurs, verre, pulsation et GLB) ; la
        // taille/position restent propres au bureau (keepSize).
        window.LumenOrb.applyAppearance?.({}, { keepSize: true });
        applyOrbLayout();
        window.LumenOrb.setEnabled(true);
        window.LumenOrb.setState("idle");
      };
      apply();
    } else window.LumenOrb?.setEnabled(false);
  } catch {}
}
function applyOrbLayout() {
  const wrap = document.getElementById("dt-orb-real");
  if (!wrap) return;
  let s = null;
  try { s = JSON.parse(localStorage.getItem(orbKey()) || "null"); } catch {}
  if (s) { wrap.style.left = s.x + "px"; wrap.style.top = s.y + "px"; wrap.style.bottom = "auto"; orbSize = s.size || 104; }
  else { wrap.style.left = ""; wrap.style.top = ""; wrap.style.bottom = ""; orbSize = 104; }
  window.LumenOrb?.setSize(orbSize);
}
function saveOrbLayout() {
  const wrap = document.getElementById("dt-orb-real");
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  lsSet(orbKey(), JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), size: orbSize }));
}
// Drag (par l'orbe) + resize (poignée), avec distinction clic/déplacement.
function setupOrb() {
  const wrap = document.getElementById("dt-orb-real");
  if (!wrap || wrap._setup) return;
  wrap._setup = true;
  wrap.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".dt-orb-resize")) return;
    e.preventDefault();
    let moved = false;
    const sx = e.clientX, sy = e.clientY;
    const r = wrap.getBoundingClientRect(), ox = r.left, oy = r.top;
    wrap.style.left = ox + "px"; wrap.style.top = oy + "px"; wrap.style.bottom = "auto";
    wrap.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) moved = true;
      wrap.style.left = Math.max(0, Math.min(ox + ev.clientX - sx, window.innerWidth - 50)) + "px";
      wrap.style.top = Math.max(0, Math.min(oy + ev.clientY - sy, window.innerHeight - 50)) + "px";
    };
    const up = () => {
      wrap.removeEventListener("pointermove", move); wrap.removeEventListener("pointerup", up);
      if (moved) saveOrbLayout();
      else chatEl?.querySelector(".dt-chat-input")?.focus();  // clic simple → focus chat
    };
    wrap.addEventListener("pointermove", move);
    wrap.addEventListener("pointerup", up);
  });
  // Poignée de redimensionnement.
  let grip = wrap.querySelector(".dt-orb-resize");
  if (!grip) { grip = document.createElement("div"); grip.className = "dt-orb-resize"; wrap.appendChild(grip); }
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const start = e.clientX, base = orbSize;
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => { orbSize = Math.max(64, Math.min(240, base + (ev.clientX - start))); window.LumenOrb?.setSize(orbSize); };
    const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); saveOrbLayout(); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
}

// ===== Construction du shell =====
function buildShell() {
  root.innerHTML = "";
  // Couche widgets = fond d'écran (dans #desktop, derrière les fenêtres).
  widgetsLayer = document.createElement("div"); widgetsLayer.className = "dt-layer dt-widgets";
  root.appendChild(widgetsLayer);
  // Chrome (chat + barre des tâches) au niveau du <body>, au-dessus des fenêtres.
  buildChat();
  buildTaskbar();
  buildDock();                   // dock façon macOS (masqué hors mode dock)
  restoreDockMode();             // réapplique le mode dock s'il était actif
  restoreActiveProject();        // projet de travail de l'assistant
  // L'orbe (drag/resize/clic) est câblé par setupOrb() via showOrb().
  translatePage(document.body);  // traduit le chrome du bureau si langue anglaise
}

// ===== Grande barre de chat (style barre Lumen) =====
let convo = [];            // historique multi-tours { role, content }
let pendingImages = [];    // images jointes au prochain message (Ollama multimodal) : { dataUrl, b64 }
let autospeak = false;     // énoncer automatiquement les réponses (tts)
let busy = false;          // génération en cours
let currentConvId = null;  // id de la conversation courante (clé `saved_conversations`)
// Projet actif de la fenêtre Assistant (= dossier de discussion enrichi, cf.
// lib/projects.js). Vide : vue « toutes les conversations », sans connaissance.
let activeProjectId = "";
function activeProject() { return activeProjectId ? getProject(activeProjectId) : null; }
/// Projet dont la connaissance s'applique au tour courant : celui de la
/// discussion ouverte (une discussion rangée dans « Thèse » garde « Thèse »
/// même vue depuis « Toutes »), sinon le projet actif pour une discussion neuve.
function contextProject() {
  if (currentConvId && telegramChatId == null) {
    const folder = getSavedConversations().find((c) => c.id === currentConvId)?.folder || "";
    return folder ? getProject(folder) : null;
  }
  return activeProject();
}

// Boutons délégués à la vraie barre Lumen (ouvrent les panneaux de la fenêtre
// principale) : on transmet l'id du bouton à cliquer là-bas.
function forwardToMain(id) { try { emitEvent?.("lumen-open", { id }); } catch {} }

function buildChat() {
  const wrap = document.createElement("div");
  wrap.className = "dt-chat";
  const model = effectiveModelLabel();
  wrap.innerHTML = `
    <div class="dt-chat-row">
      <div class="dt-bar-btns">
        <button class="dt-bar-ic" data-act="convos" title="${tt("Historique des conversations")}">${ICON.history}</button>
        <button class="dt-bar-ic" data-act="theme" title="Changer de thème (clair/sombre)">${ICON.theme}</button>
        <button class="dt-bar-ic" data-act="speak" title="Énoncer automatiquement les réponses">${ICON.speak}</button>
        <button class="dt-bar-ic" data-act="memory" title="Mémoire : laisser l'IA se souvenir">${ICON.memory}</button>
        <button class="dt-bar-ic" data-act="orchestrate" title="${tt("Réponse orchestrée : analyse, outils, vérification")}">${ICON.workflow}</button>
        <button class="dt-bar-ic" data-act="new" title="Nouvelle conversation">${ICON.newchat}</button>
        <!-- « Plus d'outils » : un + et non des points de suspension. L'ellipse
             disait « il y a autre chose ici » sans dire quoi ; le + dit qu'on
             AJOUTE des outils à la conversation, ce que fait le panneau. -->
        <button class="dt-bar-ic" data-act="more" title="Plus d'outils">${ICON.plus}<span class="dt-ic-badge" hidden></span></button>
      </div>
      <input class="dt-chat-input" placeholder="Demandez à votre assistant IA…" />
      <!-- Micro discret collé au champ, comme dans la barre principale : backend
           de dictée des Réglages (raccourci Apple ou Whisper local). -->
      <button class="dt-bar-ic dt-mic-inline" data-act="mic" title="Dictée vocale">${ICON.mic}</button>
      <div class="dt-attach-preview" hidden></div>
      <button class="dt-bar-ic dt-attach" data-act="attach" title="Joindre un document ou une image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg></button>
      <input type="file" class="dt-file-input" accept="image/*,.pdf,.docx,.txt,.md,.csv,.json,.log,.rtf" multiple hidden />
      <button class="dt-mode-btn" data-act="mode" title="Mode : destination du prompt"><span class="dt-mode-ic"></span><span class="dt-mode-label"></span></button>
      <span class="dt-model-pill" title="Modèle actif — cliquer pour changer">${escapeHtml(model)}</span>
      <button class="dt-bar-ic" data-act="preload" title="Charger le modèle en mémoire">${ICON.preload}</button>
      <button class="dt-chat-send" title="Envoyer">${lumenIcon("send-horizontal")}</button>
    </div>`;

  const input = wrap.querySelector(".dt-chat-input");
  const send = async () => {
    const q = input.value.trim();
    if (!q && pendingImages.length === 0) return;
    // Mode « édition IA » (déclenché par clic droit → Éditer avec l'IA dans
    // Documents/Présentations) : le prompt est routé vers l'élément ciblé.
    if (pendingCreativeEdit) {
      const cb = pendingCreativeEdit;
      input.value = "";
      exitCreativeEditMode();
      try { await cb.onSubmit(q); }
      catch (e) { console.warn("Creative edit failed", e); }
      return;
    }
    // Un fil Telegram est ouvert : la réponse part sur Telegram, pas au modèle.
    if (telegramChatId != null) {
      input.value = "";
      clearPendingImages();
      sendToTelegram(q);
      return;
    }
    if (!busy) {
      input.value = "";
      renderMentionChips();
      const imgs = pendingImages.slice();
      clearPendingImages();
      askAssistant(q, imgs);
    }
  };
  wrap.querySelector(".dt-chat-send").addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  input.addEventListener("input", renderMentionChips);

  // Menus « @ » (outils) et « # » (documents), quel que soit le mode ; les
  // mentions saisies se peignent en pastilles dans le champ lui-même.
  mentionHighlight = initMentionHighlight(input, {
    known: () => (dtMentionTools?.tools || []).map((sp) => sp.function?.name).filter(Boolean),
  });
  initChatMentions({
    input,
    anchor: wrap.querySelector(".dt-chat-row") || input,
    labels: { tools: tt("Outils — ↑↓ pour choisir, Entrée pour insérer"),
              files: tt("Documents — ↑↓ pour choisir, Entrée pour joindre") },
    listTools: mentionToolItems,
    listFiles: mentionFileItems,
    onTool: () => { renderMentionChips(); },   // la mention vit dans le texte
    onFile: (item) => { attachMentionedFile(item); },
  });

  // Pièces jointes : le trombone ouvre le sélecteur des sandboxes ; l'entrée
  // « Depuis l'ordinateur… » de ce panneau retombe sur cet input caché.
  const fileInput = wrap.querySelector(".dt-file-input");
  wrap.querySelector('[data-act="attach"]').addEventListener("click", (e) => openAttachPanel(e.currentTarget));
  fileInput.addEventListener("change", async () => {
    for (const file of Array.from(fileInput.files || [])) await addAttachment(file);
    fileInput.value = "";
  });
  input.addEventListener("paste", async (e) => {
    for (const it of (e.clipboardData?.items || [])) {
      if (it.type && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) { e.preventDefault(); await addImageFile(file); }
      }
    }
  });

  // Menu groupé « ⋯ » (comme la barre principale) : outils peu fréquents.
  wrap.querySelector('[data-act="more"]').addEventListener("click", (e) => openMorePanel(e.currentTarget));

  // Actions locales au bureau (panneaux natifs synchronisés avec Lumen).
  wrap.querySelector('[data-act="new"]').addEventListener("click", newConversation);
  wrap.querySelector('[data-act="theme"]').addEventListener("click", (e) => toggleTheme(e.currentTarget));
  // Autospeak : synchronisé avec la clé `autoSpeak` de Lumen.
  autospeak = localStorage.getItem("autoSpeak") === "true";
  const memoryBtn = wrap.querySelector('[data-act="memory"]');
  refreshMemoryBtn(memoryBtn);
  memoryBtn.addEventListener("click", () => {
    lsSet("memoryTool", String(!memoryToolOn()));
    refreshMemoryBtn(memoryBtn);
  });
  // Réponse orchestrée : même clé que la barre (`orchestrateChat`).
  const orchBtn = wrap.querySelector('[data-act="orchestrate"]');
  refreshOrchestrateBtn(orchBtn);
  orchBtn.addEventListener("click", () => {
    const on = !orchestrateOn();
    lsSet("orchestrateChat", String(on));
    refreshOrchestrateBtn(orchBtn);
    remotePush({ type: "orchestrate", on });
    dtToast(tt(on ? "Réponse orchestrée activée" : "Réponse orchestrée désactivée"));
  });

  const speakBtn = wrap.querySelector('[data-act="speak"]');
  speakBtn.classList.toggle("active", autospeak);
  speakBtn.addEventListener("click", () => {
    autospeak = !autospeak; lsSet("autoSpeak", String(autospeak));
    speakBtn.classList.toggle("active", autospeak);
    remotePushAutospeak();
  });
  // Dictée. Whisper : spectromètre dans la rangée (lib/dictation-visualizer.js),
  // anneau de chargement discret sur le micro pendant le chargement du modèle
  // et la transcription, second clic = arrêt anticipé puis transcription.
  let dictViz = null, dictAbort = null, dictBusy = false;
  const micBtn = wrap.querySelector('[data-act="mic"]');
  const row = wrap.querySelector(".dt-chat-row");
  micBtn.addEventListener("click", async () => {
    if (dictAbort) { dictAbort.abort(); return; }
    if (dictBusy) return;
    dictBusy = true;
    const btn = micBtn; btn.classList.add("active");
    try {
      // Option Réglages : dictée Whisper locale (transformers.js, multi-OS).
      // EXCLUSIF avec la dictée native : pas de repli automatique, sinon un
      // silence/échec Whisper déclenchait la dictée Apple dans la foulée.
      let txt = "";
      if (whisperEnabled()) {
        dictViz ??= createDictationVisualizer(row, { before: wrap.querySelector(".dt-attach-preview") });
        dictAbort = new AbortController();
        row.classList.add("dictating");
        try {
          txt = await whisperDictate({
            signal: dictAbort.signal,
            onAnalyser: (a) => dictViz.setAnalyser(a),
            onLevel: (lvl, spk, end) => dictViz.setLevel(lvl, spk, end),
            onState: (phase) => {
              btn.classList.toggle("working", phase === "loading" || phase === "transcribing");
              if (phase === "recording") dictViz.start();
              else if (phase === "transcribing" || phase === "idle") dictViz.end();
              btn.title =
                phase === "loading" ? "Chargement de Whisper…" :
                phase === "recording" ? "Écoute en cours… (clic pour arrêter)" :
                phase === "transcribing" ? "Transcription en cours…" : "";
            },
          });
        } finally {
          dictAbort = null;
          row.classList.remove("dictating");
          btn.classList.remove("working");
          dictViz.hide();
        }
      } else {
        txt = await invoke("dictate", { shortcutName: localStorage.getItem("dictateShortcut") || "" });
      }
      if (txt) input.value = (input.value + " " + txt).trim(); input.focus();
    }
    catch { /* dictée indisponible */ }
    btn.title = "Dictée vocale";
    btn.classList.remove("active");
    dictBusy = false;
  });
  wrap.querySelector('[data-act="preload"]').addEventListener("click", (e) => preloadModel(e.currentTarget));
  wrap.querySelector(".dt-model-pill").addEventListener("click", (e) => openModelPanel(e.currentTarget));
  wrap.querySelector('[data-act="convos"]').addEventListener("click", (e) => openConvosPanel(e.currentTarget));
  wrap.querySelector('[data-act="mode"]').addEventListener("click", (e) => openModePanel(e.currentTarget));
  document.body.appendChild(wrap);
  chatEl = wrap;          // doit être défini AVANT updateModeBtn (qui lit chatEl)
  updateModeBtn();
  updateHeartbeatBadges();
  // Reflète le thème déjà choisi pour le bureau. Trois cas, et ils comptent :
  //   "dark"/"light" — un choix ferme ;
  //   "auto"         — suivre le système, choisi explicitement ;
  //   rien           — jamais choisi : l'édition Pro s'ouvre en sombre, parce
  //                    que l'or a besoin d'un fond sombre pour rester lisible.
  const savedTheme = wsGet("dtTheme");
  applyTheme(savedTheme === "auto" ? "" : (savedTheme || ""));
  wrap.querySelector('[data-act="theme"]')?.classList.toggle("active", !!savedTheme && savedTheme !== "auto");
}

// Thème clair/sombre du bureau (override de prefers-color-scheme via attribut).
function toggleTheme() {
  // Le même thème que la barre de chat et les fenêtres d'apps : `setTheme`
  // écrit la clé unifiée et repose les attributs partout. On recopie ensuite
  // la valeur dans la clé préfixée par profil, que ce bureau relit au
  // démarrage — deux personnes sur la même machine gardent leur thème.
  const next = resolvedTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  wsSet("dtTheme", next);
  refreshFramesTheme();
}
/**
 * Pose le clair/sombre sur ce document.
 *
 * Une valeur vide veut dire « suivre le système » — mais on pose quand même un
 * attribut EXPLICITE, avec la valeur résolue, au lieu de retirer l'attribut.
 * Le retirer laissait le CSS suivre `prefers-color-scheme` de son côté pendant
 * que l'amorçage, lui, avait déjà posé une valeur : deux sources pour le même
 * état, donc un désaccord possible à chaque bascule du système.
 */
function applyTheme(theme) {
  const value = theme === "dark" || theme === "light" ? theme : resolvedTheme();
  document.documentElement.setAttribute("data-dt-theme", value);
  document.documentElement.setAttribute("data-theme", value);
}

// ===== Popover générique (panneaux du bureau) =====
function openPanel(anchor, build) {
  closeMenus();
  document.querySelectorAll(".dt-panel").forEach((el) => el.remove());
  const p = document.createElement("div");
  p.className = "dt-panel";
  build(p, () => p.remove());
  document.body.appendChild(p);
  translatePage(p);
  // Aligné à l'ancre. S'ouvre vers le bas si la barre est en haut de l'écran
  // (mode dock : la barre de chat passe en haut), vers le haut sinon — sans quoi
  // le panneau sortirait de l'écran par le haut.
  const r = anchor.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8)) + "px";
  if (r.top < window.innerHeight / 2) {
    p.style.top = (r.bottom + 8) + "px";
    p.style.bottom = "auto";
  } else {
    p.style.bottom = (window.innerHeight - r.top + 8) + "px";
  }
  setTimeout(() => document.addEventListener("pointerdown", function h(ev) {
    if (!p.contains(ev.target) && ev.target !== anchor) { p.remove(); document.removeEventListener("pointerdown", h); }
  }), 0);
}

// ===== Panneau Modèle (synchro `selectedModel`) =====
let modelList = null;
let modelListSource = null;
// `pill` est la pastille de la barre (son libellé est tenu à jour) ; `anchor`
// l'élément sous lequel le panneau s'ouvre — par défaut la pastille elle-même,
// mais la fenêtre Assistant passe SON bouton : sinon le panneau apparaissait
// collé à la barre des tâches, à l'autre bout de l'écran.
async function openModelPanel(pill, anchor = pill) {
  const url = localStorage.getItem("ollamaUrl") || "http://localhost:11434";
  const initialSource = aiSourceNow() || "ollama";
  const loadModels = async (src) => {
    try {
      if (src === "llama") {
        const models = await invoke("llama_list_models");
        return (Array.isArray(models) ? models : []).map((m) => m.filename).filter(Boolean);
      }
      const d = await ollamaGetJson("api/tags", url);
      return (d.models || []).map((m) => m.name).filter(Boolean);
    } catch { return []; }
  };
  if (!modelList || modelListSource !== initialSource) {
    modelList = await loadModels(initialSource);
    modelListSource = initialSource;
  }
  // Lumen Server n'est proposé qu'en édition Pro, poste lié ; Apple Foundation
  // Models que sur macOS 27 avec Apple Intelligence actif.
  const [lumenState, appleState, apiProfiles, apiChoices] = await Promise.all([lumenServerBackendState(), appleFmBackendState(), listApiProfiles(), listApiModelChoices()]);
  const appleModels = APPLEFM_MODELS.filter((m) => (appleState.models || []).some((x) => x.id === m.id && x.available));
  openPanel(anchor, (panel, close) => {
    const source = aiSourceNow() || "ollama";
    const apiModel = localStorage.getItem(cloudModelKey(source)) || (source === "lumen" ? "" : "gpt-4o-mini");
    const applefmModel = localStorage.getItem("applefmModel") || APPLEFM_DEFAULT_MODEL;
    panel.innerHTML = `
      <div class="dt-panel-head">Backend IA</div>
      <label class="dt-set-field"><span class="dt-set-label">Source</span>
        <select data-k="source">
          <option value="ollama"${source === "ollama" ? " selected" : ""}>Ollama local</option>
          <option value="llama"${source === "llama" ? " selected" : ""}>llama.cpp / llama-server</option>
          <option value="api"${source === "api" ? " selected" : ""}>API cloud</option>
          ${lumenState.available ? `<option value="lumen"${source === "lumen" ? " selected" : ""}>Lumen Server</option>` : ""}
          ${appleState.available ? `<option value="applefm"${source === "applefm" ? " selected" : ""}>Apple Foundation Models</option>` : ""}
          <option value="shortcut"${source === "shortcut" ? " selected" : ""}>Raccourci Apple</option>
        </select>
      </label>
      <label class="dt-set-field" data-provider-row><span class="dt-set-label">Modèle API</span>
        <select data-k="api-choice">
          ${apiChoices.some((c) => c.active) ? "" : `<option value="">— Choisir —</option>`}
          ${[...new Set(apiChoices.map((c) => c.id))].map((pid) => { const list = apiChoices.filter((c) => c.id === pid); return `<optgroup label="${escapeHtml(list[0].name)}">${list.map((c) => `<option value="${escapeHtml(JSON.stringify([c.id, c.model]))}"${c.active ? " selected" : ""}>${escapeHtml(c.model)}</option>`).join("")}</optgroup>`; }).join("")}
        </select>
      </label>
      <label class="dt-set-field" data-api-row><span class="dt-set-label" data-api-label>Modèle API</span>
        <input type="text" data-k="api-model" value="${escapeHtml(apiModel)}" spellcheck="false" />
      </label>
      <label class="dt-set-field" data-applefm-row><span class="dt-set-label">Modèle Apple</span>
        <select data-k="applefm-model">
          ${appleModels.map((m) => `<option value="${m.id}"${applefmModel === m.id ? " selected" : ""}>${escapeHtml(m.label)}</option>`).join("")}
        </select>
      </label>
      <label class="dt-set-field" data-think-row><span class="dt-set-label">Mode « think »</span>
        <input type="checkbox" data-k="think"${localStorage.getItem("ollamaThink") === "true" ? " checked" : ""} />
      </label>
      <label class="dt-set-field" data-ctx-row><span class="dt-set-label">Taille du contexte</span>
        <select data-k="ctx">
          <option value="2048">2 048 tokens</option>
          <option value="4096">4 096 tokens</option>
          <option value="8192">8 192 tokens</option>
          <option value="16384">16 384 tokens</option>
          <option value="32768">32 768 tokens</option>
          <option value="65536">65 536 tokens (64K)</option>
          <option value="131072">131 072 tokens (128K)</option>
          <option value="262144">262 144 tokens (256K)</option>
        </select>
      </label>
      <div data-ollama-row><div class="dt-panel-sep">Modèle local</div><div data-model-list></div></div>`;
    const listBox = panel.querySelector("[data-model-list]");
    const renderModelList = () => {
      listBox.innerHTML = "";
      if (!modelList?.length) {
        listBox.innerHTML = `<div class="dt-panel-empty">Aucun modèle disponible.</div>`;
        return;
      }
      const cur = localStorage.getItem("selectedModel") || "";
      for (const m of modelList) {
        const it = document.createElement("div");
        it.className = "dt-panel-item" + (m === cur ? " active" : "");
        it.innerHTML = `<span>${escapeHtml(m)}</span><span class="dt-check">●</span>`;
        it.addEventListener("click", () => {
          const selectedSource = panel.querySelector('[data-k="source"]')?.value || "ollama";
          lsSet("aiSource", selectedSource === "llama" ? "llama" : "ollama");
          rememberModelFor(selectedSource, m);
          pushOllamaConfig();
          pill.textContent = effectiveModelLabel(); refreshAssistChrome();
          close();
        });
        listBox.appendChild(it);
      }
    };
    const refreshRows = () => {
      const src = panel.querySelector('[data-k="source"]')?.value || "ollama";
      const isApi = isApiLike(src) && src !== "applefm";
      const isLocal = src === "ollama" || src === "llama";
      const apiRow = panel.querySelector("[data-api-row]");
      // En API : menu des modèles des API à clé enregistrée ; la saisie libre
      // ne reste que pour Lumen Server (ou faute d'API configurée).
      const useChoices = src === "api" && apiChoices.length > 0;
      if (apiRow) apiRow.style.display = isApi && !useChoices ? "" : "none";
      const providerRow = panel.querySelector("[data-provider-row]");
      if (providerRow) providerRow.style.display = useChoices ? "" : "none";
      const appleRow = panel.querySelector("[data-applefm-row]");
      if (appleRow) appleRow.style.display = src === "applefm" ? "" : "none";
      const apiLabel = panel.querySelector("[data-api-label]");
      if (apiLabel) apiLabel.textContent = src === "lumen" ? "Modèle Lumen Server" : "Modèle API";
      const apiInput = panel.querySelector('[data-k="api-model"]');
      if (apiInput && isApi) apiInput.value = localStorage.getItem(cloudModelKey(src)) || (src === "lumen" ? "" : "gpt-4o-mini");
      // Les modèles locaux sont masqués hors Ollama/llama-server.
      const ollamaRow = panel.querySelector("[data-ollama-row]");
      if (ollamaRow) ollamaRow.style.display = isLocal ? "" : "none";
      const sep = panel.querySelector("[data-ollama-row] .dt-panel-sep");
      if (sep) sep.textContent = src === "llama" ? "Modèle llama.cpp" : "Modèle Ollama";
      // Le raisonnement est disponible pour les backends locaux.
      const thinkRow = panel.querySelector("[data-think-row]");
      if (thinkRow) thinkRow.style.display = isLocal ? "" : "none";
      const ctxRow = panel.querySelector("[data-ctx-row]");
      const ctxSelect = panel.querySelector('[data-k="ctx"]');
      if (ctxRow) ctxRow.style.display = isLocal ? "" : "none";
      if (ctxSelect) ctxSelect.value = localStorage.getItem(src === "llama" ? "llamaNumCtx" : "ollamaNumCtx") || (src === "llama" ? (localStorage.getItem("ollamaNumCtx") || "8192") : "0");
    };
    panel.querySelector('[data-k="think"]').addEventListener("change", (e) => {
      lsSet("ollamaThink", String(e.target.checked));
    });
    panel.querySelector('[data-k="ctx"]').addEventListener("change", (e) => {
      const src = panel.querySelector('[data-k="source"]')?.value || "ollama";
      // Plafond aligné sur le `clamp` de llama.rs : au-delà, le serveur raboterait
      // en silence et la valeur affichée ne serait plus celle utilisée.
      const value = String(Math.max(2048, Math.min(262144, Number.parseInt(e.target.value, 10) || 8192)));
      lsSet(src === "llama" ? "llamaNumCtx" : "ollamaNumCtx", value);
      if (src === "llama") {
        const model = localStorage.getItem("selectedModel") || "";
        if (model) invoke("llama_start", { filename: model, ctxSize: Number(value) }).catch(() => {});
      }
    });
    panel.querySelector('[data-k="source"]').addEventListener("change", async (e) => {
      const next = e.target.value;
      lsSet("aiSource", next);
      // Poussé TOUT DE SUITE : la lecture des modèles ci-dessous peut traîner
      // (Ollama absent), et un message envoyé entre-temps partait encore vers
      // l'ancien backend côté Rust.
      pushOllamaConfig();
      refreshRows();
      modelList = await loadModels(next);
      modelListSource = next;
      // Le modèle suit le backend. Sans ça, passer sur llama.cpp gardait le nom
      // Ollama actif : `llama_start` recevait « gemma3:4b » au lieu d'un fichier
      // GGUF, échouait en silence, et la bascule paraissait sans effet.
      if (next === "ollama" || next === "llama") {
        const model = pickModelForSource(next, modelList);
        if (model) rememberModelFor(next, model);
      }
      pushOllamaConfig();
      pill.textContent = effectiveModelLabel(); refreshAssistChrome();
      renderModelList();
      if (next === "llama") {
        const model = localStorage.getItem("selectedModel") || "";
        if (model) invoke("llama_start", { filename: model, ctxSize: Number(localStorage.getItem("llamaNumCtx") || 8192) }).catch(() => {});
      } else {
        invoke("llama_stop").catch(() => {});
      }
    });
    // Bascule entre les API déjà configurées dans les Réglages, sans y retourner.
    panel.querySelector('[data-k="api-choice"]')?.addEventListener("change", async (e) => {
      if (!e.target.value) return;
      try {
        const [pid, model] = JSON.parse(e.target.value);
        const res = await selectApiModel(pid, model);
        apiProfiles.active = pid;
        const input = panel.querySelector('[data-k="api-model"]');
        if (input) input.value = res.model || "";
        pushOllamaConfig();
        pill.textContent = effectiveModelLabel(); refreshAssistChrome();
      } catch (err) { console.error("[API]", err); }
    });
    panel.querySelector('[data-k="api-model"]').addEventListener("change", (e) => {
      const src = panel.querySelector('[data-k="source"]')?.value || "ollama";
      lsSet(cloudModelKey(src), e.target.value.trim() || (src === "lumen" ? "" : "gpt-4o-mini"));
      pushOllamaConfig();
      pill.textContent = effectiveModelLabel(); refreshAssistChrome();
    });
    panel.querySelector('[data-k="applefm-model"]')?.addEventListener("change", (e) => {
      lsSet("applefmModel", e.target.value || APPLEFM_DEFAULT_MODEL);
      pushOllamaConfig();
      pill.textContent = effectiveModelLabel(); refreshAssistChrome();
    });
    refreshRows();
    renderModelList();
  });
}

// ===== Panneau Mode (synchro `ollamaMode` / `ollamaWorkflow`) =====
const MODE_LABELS = { chat: "Chat", rag: "Documents", router: "Routeur", tools: "Outils", docs: "Documentation", workflow: "Workflow" };
// Même défaut que la barre Lumen (config.ollamaMode) pour rester synchrone.
// ===== Outil mémoire dans la discussion simple =====
//
// Même réglage que la barre principale (clé `memoryTool`) : activé ici, activé
// là-bas. Le modèle appelle lui-même `memory_recall` avant de répondre et
// `memory_remember` quand on lui demande de retenir, sans basculer en mode
// Outils — qui expose, lui, tout le catalogue.
function memoryToolOn() { return localStorage.getItem("memoryTool") === "true"; }

/// Catalogue réduit à la mémoire, filtré comme les autres par la Boîte à outils.
function memoryChatTools() {
  return filterPublishedTools([
    ...memoryToolDefs(),
  ]);
}

/// Outils de la boucle du mode Chat : la mémoire (si activée) et, dans un
/// projet, la lecture de ses autres discussions quand la question s'y réfère.
/// La boucle d'outils coûte le streaming : on n'y entre pas à chaque tour d'un
/// projet, seulement quand la demande parle d'une autre discussion (ou que la
/// mémoire est déjà active — la boucle est alors de toute façon là).
function chatLoopTools(prompt = "") {
  const memory = memoryToolOn() ? memoryChatTools() : [];
  const wantProject = memory.length > 0 || promptRefersToConversations(prompt);
  const project = wantProject && (aiSourceNow() || "ollama") !== "shortcut" ? filterPublishedTools(buildProjectTools()) : [];
  return [...memory, ...project];
}

/// La question évoque-t-elle une autre discussion du projet ?
function promptRefersToConversations(prompt) {
  // `\b` ignore les lettres accentuées : lookarounds Unicode à la place.
  return /(?<!\p{L})(discussions?|conversations?|chats?|fils?|échanges?|threads?|on (avait|a) (dit|vu|décidé|conclu)|dans l'autre|l'autre fois|précédemment|earlier chat|previous (chat|conversation)|we (said|decided|discussed))(?!\p{L})/iu.test(String(prompt || ""));
}

/// Reflète l'état du bouton. Les modes Outils et Documentation embarquent déjà
/// la mémoire : le bouton y est estompé plutôt que trompeur.
function refreshMemoryBtn(btn = chatEl?.querySelector('[data-act="memory"]')) {
  if (!btn) return;
  // Le mode Documents n'exécute aucun outil (il injecte les extraits) : le
  // bouton y est estompé plutôt que trompeusement allumé.
  const carriedByMode = getMode() === "tools" || getMode() === "docs" || getMode() === "rag";
  const shortcut = (aiSourceNow() || "ollama") === "shortcut";
  btn.hidden = shortcut;   // le chemin Raccourci Apple ne transporte pas d'outil
  btn.classList.toggle("active", memoryToolOn() && !carriedByMode);
  btn.classList.toggle("dim", carriedByMode);
  btn.title = getMode() === "rag"
    ? tt("Ce mode répond à partir de vos documents")
    : carriedByMode
    ? tt("Ce mode inclut déjà la mémoire")
    : memoryToolOn()
      ? tt("Mémoire active : l'IA rappelle et mémorise elle-même")
      : tt("Mémoire : laisser l'IA se souvenir");
}

// Aiguillage de départ par le moteur de décision (lib/decision.js), jumeau de
// `decideTurnRoute` dans main.js. Renvoie { route, tools? } ou null.
const DT_ROUTE_CATS = new Set(["apps", "mail", "memory", "knowledge", "files", "live", "home", "ask", "web", "vault", "documents"]);
async function dtDecideRoute(prompt) {
  const aiSource = aiSourceNow() || "ollama";
  if (isSmallTalk(prompt)) return null;
  const r = await routeTurn({
    query: prompt, history: convo.slice(0, -1), aiSource,
    ollamaUrl: localStorage.getItem("ollamaUrl") || "http://localhost:11434",
    toolFamilies: ["mail", "calendar", "files", "notes", "memory", "contacts", "weather", "news", "web search", "apps", "smart home", "reminders"],
    invoke,
  });
  if (!r || r.route !== "tools") return r;
  const tools = (await buildFluxoTools()).filter((tl) => DT_ROUTE_CATS.has(toolCategory(tl.function?.name)));
  return tools.length ? { ...r, tools } : { ...r, route: "direct" };
}

function orchestrateOn() { return localStorage.getItem("orchestrateChat") === "true"; }
/// Bouton « Réponse orchestrée » : actif en mode Discussion seulement.
function refreshOrchestrateBtn(btn = chatEl?.querySelector('[data-act="orchestrate"]')) {
  if (!btn) return;
  const shortcut = (aiSourceNow() || "ollama") === "shortcut";
  const inert = getMode() !== "chat";
  btn.hidden = shortcut;
  btn.classList.toggle("active", orchestrateOn() && !inert);
  btn.classList.toggle("dim", inert);
  btn.title = inert
    ? tt("La réponse orchestrée s'applique au mode Discussion")
    : orchestrateOn()
      ? tt("Réponse orchestrée forcée pour chaque demande (cliquer pour laisser le routeur décider)")
      : tt("Routeur automatique — cliquer pour forcer la réponse orchestrée");
}

function getMode() { return localStorage.getItem("ollamaMode") || (localStorage.getItem("fluxoTools") === "true" ? "tools" : "chat"); }
function getWorkflow() { return localStorage.getItem("ollamaWorkflow") || ""; }
function setMode(mode, workflow) {
  lsSet("ollamaMode", mode);
  if (mode === "workflow") lsSet("ollamaWorkflow", workflow || getWorkflow());
  // Mirroir hérité utilisé par Lumen pour le mode outils.
  lsSet("fluxoTools", String(mode === "tools"));
  updateModeBtn();
  refreshMemoryBtn();
  refreshOrchestrateBtn();
  remotePushActionMode();
  remotePushOllamaMode();
}
function updateModeBtn() {
  const lbl = chatEl?.querySelector(".dt-mode-label");
  const ic = chatEl?.querySelector(".dt-mode-ic");
  if (!lbl) return;
  const m = getMode();
  lbl.textContent = m === "workflow" && getWorkflow() ? getWorkflow() : (MODE_LABELS[m] || "Chat");
  if (ic) ic.innerHTML = MODE_ICONS[m] || MODE_ICONS.chat;
  refreshAssistChrome();
}
async function openModePanel(btn) {
  let workflows = [];
  try { workflows = await invoke("list_fluxo_workflows"); } catch {}
  openPanel(btn, (panel, close) => {
    panel.innerHTML = `<div class="dt-panel-head">Mode du prompt</div>`;
    const add = (mode, label, desc, wf) => {
      const active = mode === "workflow" ? (getMode() === "workflow" && getWorkflow() === wf) : getMode() === mode;
      const it = document.createElement("div");
      it.className = "dt-panel-item" + (active ? " active" : "");
      it.innerHTML = `<span class="dt-panel-ic">${MODE_ICONS[mode] || MODE_ICONS.chat}</span><span class="dt-panel-item-txt"><b>${escapeHtml(label)}</b><small>${escapeHtml(desc)}</small></span><span class="dt-check">●</span>`;
      it.addEventListener("click", () => { setMode(mode, wf); close(); });
      panel.appendChild(it);
    };
    add("chat", "Chat", "Ollama direct");
    add("rag", "Documents", "Répond à partir de vos documents indexés (Corpus)");
    add("router", "Routeur", "Workflow « default router »");
    add("tools", "Outils", "Function calling (appel de workflows)");
    add("docs", "Documentation", "Recherche dans la documentation Lumen");
    if (workflows.length) {
      panel.insertAdjacentHTML("beforeend", `<div class="dt-panel-sep">Workflows Fluxo</div>`);
      workflows.forEach((n) => add("workflow", n, "Envoi direct au workflow", n));
    }
  });
}


// ===== Fils Telegram (backend telegram.rs, propres au profil) =====
// Ils ne sont PAS copiés dans `saved_conversations` : le transcript vit côté
// backend, cloisonné par profil et hors de portée du localStorage. On le lit à
// l'affichage, et répondre repart sur Telegram plutôt que vers le modèle.
let telegramThreads = [];
let telegramChatId = null;

async function loadTelegramThreads() {
  try { telegramThreads = await invoke("telegram_threads"); }
  catch { telegramThreads = []; }
  return telegramThreads;
}

// Un fil Telegram présenté comme une conversation de la liste.
function telegramAsConversation(th) {
  return {
    id: `tg:${th.chatId}`,
    title: th.name || `Telegram ${th.chatId}`,
    origin: "telegram",
    unread: th.unread || 0,
    preview: th.preview || "",
    chatId: th.chatId,
    history: [],
  };
}

// Rôle d'affichage d'un tour Telegram. Le backend distingue trois écritures :
// « user » (depuis le téléphone), « lumen » (la réponse du modèle) et « desk »
// (ce que VOUS avez écrit depuis l'ordinateur). Les deux premières formes du
// même utilisateur doivent se ranger du même côté de la bulle — sans ça, ses
// propres messages envoyés depuis le bureau s'affichaient côté modèle.
function telegramTurnRole(role) {
  return role === "user" || role === "desk" ? "user" : "assistant";
}

// Charge un fil dans la fenêtre de conversation. Les appels d'outils diffusés
// (🔧 / ↳) sont rendus comme des messages de l'assistant : c'est bien ce que
// l'utilisateur a vu passer sur son téléphone.
async function loadTelegramConversation(chatId) {
  let thread;
  try { thread = await invoke("telegram_thread", { chatId, markRead: true }); }
  catch (e) { console.warn("Telegram thread", e); return; }
  telegramChatId = chatId;
  currentConvId = `tg:${chatId}`;
  convo = (thread.turns || []).map((t) => ({ role: telegramTurnRole(t.role), content: t.text || "" }));
  const win = ensureConvoWindow();
  renderAssistantConversation(win);
  refreshAssistConvos();
  scrollAssistant();
}

async function refreshTelegramView() {
  await loadTelegramThreads();
  refreshAssistConvos();
  if (telegramChatId != null && openWindows.get("assistant")) {
    const id = telegramChatId;
    try {
      const thread = await invoke("telegram_thread", { chatId: id, markRead: true });
      convo = (thread.turns || []).map((t) => ({ role: telegramTurnRole(t.role), content: t.text || "" }));
      renderAssistantConversation();
      scrollAssistant();
    } catch {}
  }
}

// Envoi d'une réponse vers Telegram depuis le bureau.
async function sendToTelegram(text) {
  const win = ensureConvoWindow();
  const log = win.body.querySelector(".dt-chat-log");
  log.appendChild(bubble("user", decorateMentions(escapeHtml(text))));
  scrollAssistant();
  try {
    await invoke("telegram_reply", { chatId: telegramChatId, text });
  } catch (e) {
    log.appendChild(bubble("ai", escapeHtml(`⚠️ ${e?.message || e}`)));
    scrollAssistant();
    return;
  }
  await refreshTelegramView();
}

// ===== Stockage local =====
// `lsSet` (lib/safe-storage.js) remplace `localStorage.setItem` dans tout le
// bureau : une écriture refusée pour cause de quota renvoie false au lieu de
// lever, et l'action en cours va jusqu'au bout. Voir le commentaire du module
// pour le pourquoi (changement de discussion cassé par un stockage saturé).
onStorageFull((msg) => dtToast(msg));

// ===== Conversations =====
// Le bureau est la vue CONSOLIDÉE : il montre ses propres discussions, celles
// de la barre Lumen et les fils Telegram. La barre, elle, ne montre que les
// siennes — c'est le bureau qui est protégé par mot de passe, pas la barre.
//
// Détail qui a longtemps caché les discussions de la barre : elle écrit dans
// `saved_conversations` (clé nue) alors que le bureau écrit dans la clé
// préfixée par le profil. Ce sont deux magasins ; on lit donc les deux et on
// marque chaque entrée de son `origin`.
function readConvStore(key) {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
}

function getSavedConversations() {
  const mine = readConvStore(wsKey("saved_conversations")).map((c) => ({ ...c, origin: c.origin || "desktop" }));
  const bar = wsKey("saved_conversations") === "saved_conversations"
    ? []
    : readConvStore("saved_conversations").map((c) => ({ ...c, origin: c.origin || "bar" }));
  return [...mine, ...bar].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
}

// Écrit dans le magasin correspondant à l'origine d'une conversation : on ne
// déplace jamais une discussion de la barre dans le magasin du bureau.
function writeConvStore(origin, list) {
  lsSet(origin === "bar" ? "saved_conversations" : wsKey("saved_conversations"), JSON.stringify(list));
}

function convOrigin(id) {
  return getSavedConversations().find((c) => c.id === id)?.origin || "desktop";
}

function effectiveModelMeta() {
  const source = aiSourceNow() || "ollama";
  if (source === "api") return { source: "api", model: localStorage.getItem("apiModel") || "gpt-4o-mini" };
  if (source === "lumen") return { source: "lumen", model: localStorage.getItem("lumenModel") || "" };
  if (source === "applefm") return { source: "applefm", model: localStorage.getItem("applefmModel") || APPLEFM_DEFAULT_MODEL };
  if (source === "shortcut") return { source: "shortcut", model: "shortcut" };
  if (source === "llama") return { source: "llama", model: localStorage.getItem("selectedModel") || "" };
  return { source: "ollama", model: localStorage.getItem("selectedModel") || "" };
}

function effectiveModelLabel() {
  const meta = effectiveModelMeta();
  return meta.source === "shortcut" ? "Apple" : (meta.model || "modèle");
}

// ===== Classement : dossiers, épingles, résumés =====
//
// Le bureau est la vue consolidée : c'est ici qu'on range vraiment. Les
// dossiers sont une taxonomie partagée avec la barre (cf.
// lib/conversation-folders.js) ; les champs `folder`, `pinned` et `summary`,
// eux, s'écrivent dans le magasin d'ORIGINE de chaque discussion — ranger une
// discussion de la barre ne la déplace pas dans celui du bureau.
function updateConversationMeta(id, patch) {
  const origin = convOrigin(id);
  const key = origin === "bar" ? "saved_conversations" : wsKey("saved_conversations");
  writeConvStore(origin, readConvStore(key).map((c) => (c.id === id ? { ...c, ...patch } : c)));
  remotePushConversations();
}

let convFilter = "all"; // 'all' | 'pinned' | 'none' | <id de dossier>

function convMatchesFilter(conv) {
  if (convFilter === "all") return true;
  if (convFilter === "pinned") return isPinned(conv);
  if (convFilter === "none") return !resolveFolder(conv);
  return conv.folder === convFilter;
}

/// Barre de filtres du panneau : dossiers existants + création à la volée.
function convFilterBar(rerender) {
  const bar = document.createElement("div");
  bar.className = "dt-conv-filters";
  const folders = listFolders();
  const chips = [
    { id: "all", label: tt("Toutes") },
    { id: "pinned", label: tt("Épinglées") },
    ...folders.map((f) => ({ id: f.id, label: f.name, color: f.color, folder: f })),
  ];
  if (folders.length) chips.push({ id: "none", label: tt("Non classées") });
  for (const chip of chips) {
    const el = document.createElement("button");
    el.className = "dt-conv-chip" + (convFilter === chip.id ? " active" : "");
    if (chip.color) el.style.setProperty("--chip-color", chip.color);
    el.innerHTML = (chip.color ? `<span class="dt-folder-dot"></span>` : "") + escapeHtml(chip.label);
    el.addEventListener("click", () => { convFilter = chip.id; rerender(); });
    // Le clic droit supprime le dossier — les discussions, elles, restent :
    // vider un dossier ne doit jamais effacer un historique.
    if (chip.folder) {
      el.title = tt("Clic droit : supprimer le dossier (les discussions sont conservées)");
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        deleteFolder(chip.folder.id);
        if (convFilter === chip.id) convFilter = "all";
        rerender();
      });
    }
    bar.appendChild(el);
  }
  const add = document.createElement("button");
  add.className = "dt-conv-chip ghost";
  add.textContent = tt("+ Dossier");
  add.addEventListener("click", () => {
    // `prompt()` est inopérant dans la WebView Tauri : saisie en ligne.
    const input = document.createElement("input");
    input.className = "dt-conv-folder-input";
    input.maxLength = 40;
    input.placeholder = tt("Nom du dossier");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { rerender(); return; }
      if (e.key !== "Enter") return;
      const name = input.value.trim();
      if (name) { try { convFilter = createFolder(name).id; } catch (err) { dtToast(String(err?.message || err)); } }
      rerender();
    });
    add.replaceWith(input);
    input.focus();
  });
  bar.appendChild(add);
  return bar;
}

/// Menu de rangement d'une discussion (dossiers existants + création).
function openConvFolderMenu(anchor, conv, rerender) {
  document.querySelectorAll(".dt-folder-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "dt-folder-menu";
  const row = (label, color, active, onClick) => {
    const el = document.createElement("button");
    el.className = "dt-folder-menu-row" + (active ? " active" : "");
    if (color) el.style.setProperty("--chip-color", color);
    el.innerHTML = (color ? `<span class="dt-folder-dot"></span>` : "") + escapeHtml(label);
    el.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    menu.appendChild(el);
  };
  row(tt("Non classées"), "", !conv.folder, () => {
    updateConversationMeta(conv.id, { folder: "" });
    rerender();
  });
  for (const folder of listFolders()) {
    row(folder.name, folder.color, conv.folder === folder.id, () => {
      updateConversationMeta(conv.id, { folder: folder.id });
      rerender();
    });
  }
  const input = document.createElement("input");
  input.className = "dt-conv-folder-input";
  input.maxLength = 40;
  input.placeholder = tt("Nom du dossier");
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const name = input.value.trim();
    if (!name) return;
    try { updateConversationMeta(conv.id, { folder: createFolder(name).id }); }
    catch (err) { dtToast(String(err?.message || err)); }
    rerender();
  });
  menu.appendChild(input);
  anchor.appendChild(menu);
  setTimeout(() => {
    const close = (e) => {
      if (menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener("click", close);
    };
    document.addEventListener("click", close);
  }, 0);
}

/// Résumé IA d'une discussion, hors du fil en cours : il sert de vignette au
/// tableau des épinglées et de rappel dans la liste.
async function summarizeConversation(conv, btn) {
  if (btn) btn.classList.add("busy");
  try {
    const { content } = await llmChat(summaryMessages(conv, dtLang()), { rawSystem: true });
    const summary = String(content || "").trim();
    if (!summary) throw new Error(tt("Le modèle n'a rien renvoyé."));
    updateConversationMeta(conv.id, { summary });
    return summary;
  } catch (e) {
    dtToast(tt("Résumé impossible : ") + String(e?.message || e));
    return "";
  } finally {
    if (btn) btn.classList.remove("busy");
  }
}

function openConvosPanel(btn) {
  openPanel(btn, (panel) => {
    const rerender = () => { panel.innerHTML = ""; build(panel); };
    build(panel);

    function build(panel) {
      panel.innerHTML = `<div class="dt-panel-head">${tt("Conversations")}</div>`;
      panel.appendChild(convFilterBar(rerender));
      const pinBoard = document.createElement("div");
      pinBoard.className = "dt-panel-item";
      pinBoard.innerHTML = `<span class="dt-panel-item-txt">${escapeHtml(tt("Ouvrir le tableau des épinglées"))}</span>`;
      pinBoard.addEventListener("click", () => { openPinboardWindow(); panel.remove(); });
      panel.appendChild(pinBoard);

      // Vue consolidée, comme la liste latérale de l'assistant. Les fils
      // Telegram vivent côté backend : ils ne se rangent ni ne s'épinglent.
      const saved = [...telegramThreads.map(telegramAsConversation), ...getSavedConversations()]
        .filter((c) => (c.origin === "telegram" ? convFilter === "all" : convMatchesFilter(c)))
        .sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)));
      if (!saved.length) { panel.insertAdjacentHTML("beforeend", `<div class="dt-panel-empty">${tt("Aucun historique.")}</div>`); return; }
      for (const conv of saved) {
        const it = document.createElement("div");
        it.className = "dt-panel-item" + (conv.id === currentConvId ? " active" : "");
        const folder = resolveFolder(conv);
        const badge = conv.origin === "telegram" ? `<span class="dt-conv-tag tg">Telegram</span>`
          : conv.origin === "bar" ? `<span class="dt-conv-tag bar">${tt("Barre")}</span>` : "";
        const folderTag = folder
          ? `<span class="dt-conv-tag folder" style="--chip-color:${escapeHtml(folder.color)}"><span class="dt-folder-dot"></span>${escapeHtml(folder.name)}</span>`
          : "";
        it.innerHTML = `<span class="dt-panel-item-txt">${escapeHtml(conv.title || "Discussion")}${badge}${folderTag}</span>`;
        if (conv.origin !== "telegram") {
          it.insertAdjacentHTML("beforeend",
            `<button class="dt-conv-act pin${isPinned(conv) ? " on" : ""}" title="${escapeHtml(isPinned(conv) ? tt("Détacher") : tt("Épingler"))}">${ICON.pin}</button>`
            + `<button class="dt-conv-act folder" title="${escapeHtml(tt("Ranger dans un dossier"))}">${ICON.folder}</button>`
            + `<button class="dt-conv-act sum" title="${escapeHtml(tt("Résumer avec l'IA"))}">${ICON.sparkles}</button>`
            + `<button class="dt-conv-del" title="${escapeHtml(tt("Supprimer"))}">${ICON.trash}</button>`);
        }
        it.querySelector(".dt-panel-item-txt").addEventListener("click", () => {
          if (conv.origin === "telegram") loadTelegramConversation(conv.chatId);
          else loadConversation(conv);
          panel.remove();
        });
        it.querySelector(".dt-conv-act.pin")?.addEventListener("click", (e) => {
          e.stopPropagation();
          updateConversationMeta(conv.id, { pinned: !isPinned(conv) });
          rerender();
        });
        it.querySelector(".dt-conv-act.folder")?.addEventListener("click", (e) => {
          e.stopPropagation();
          openConvFolderMenu(it, conv, rerender);
        });
        it.querySelector(".dt-conv-act.sum")?.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (await summarizeConversation(conv, e.currentTarget)) rerender();
        });
        it.querySelector(".dt-conv-del")?.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteConversation(conv.id);
          it.remove();
        });
        panel.appendChild(it);
      }
    }
  });
}

// ===== Tableau des épinglées =====
//
// Une liste dit « voici tes discussions » ; un tableau dit « voici ce sur quoi
// tu travailles ». Les discussions épinglées y sont posées en vignettes de
// hauteur libre (colonnes CSS, façon tableau d'inspiration) avec leur résumé :
// on retrouve un fil d'un coup d'œil, sans le rouvrir.
//
// Le tableau ne stocke rien de plus que la liste : c'est la MÊME donnée, vue
// autrement. Détacher une vignette la rend simplement à l'historique.
function openPinboardWindow() {
  const exists = openWindows.get("pinboard");
  const win = exists || createWindow({ id: "pinboard", title: tt("Épinglées"), w: 720, h: 520, x: 140, y: 60 });
  renderPinboard(win.body);
  return win;
}

function renderPinboard(body) {
  body.innerHTML = "";
  const rerender = () => renderPinboard(body);
  const head = document.createElement("div");
  head.className = "dt-pin-head";
  const pinned = getSavedConversations().filter(isPinned);
  head.innerHTML = `<span>${pinned.length} ${escapeHtml(pinned.length > 1 ? tt("discussions épinglées") : tt("discussion épinglée"))}</span>`;
  body.appendChild(head);

  if (!pinned.length) {
    body.insertAdjacentHTML("beforeend",
      `<div class="dt-pin-empty">${escapeHtml(tt("Rien d'épinglé pour l'instant. Épingle une discussion depuis la liste des conversations : elle se posera ici."))}</div>`);
    return;
  }

  const board = document.createElement("div");
  board.className = "dt-pinboard";
  for (const conv of pinned) {
    const folder = resolveFolder(conv);
    const card = document.createElement("article");
    card.className = "dt-pin-card";
    if (folder) card.style.setProperty("--chip-color", folder.color);
    const excerpt = conversationExcerpt(conv);
    const turns = (conv.history || []).filter((m) => m?.role === "user" || m?.role === "assistant").length;
    card.innerHTML = `
      ${folder ? `<span class="dt-conv-tag folder"><span class="dt-folder-dot"></span>${escapeHtml(folder.name)}</span>` : ""}
      <h3>${escapeHtml(conv.title || tt("Discussion"))}</h3>
      ${excerpt ? `<p class="dt-pin-text${conv.summary ? " summary" : ""}">${escapeHtml(excerpt)}</p>` : ""}
      <footer>
        <span class="dt-pin-meta">${turns} ${escapeHtml(tt("messages"))}${conv.origin === "bar" ? ` · ${escapeHtml(tt("Barre"))}` : ""}</span>
        <span class="dt-pin-acts">
          <button class="dt-conv-act sum" title="${escapeHtml(tt("Résumer avec l'IA"))}">${ICON.sparkles}</button>
          <button class="dt-conv-act unpin" title="${escapeHtml(tt("Détacher"))}">${ICON.pin}</button>
        </span>
      </footer>`;
    card.addEventListener("click", () => { loadConversation(conv); openAssistantWindow(); });
    card.querySelector(".dt-conv-act.sum").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (await summarizeConversation(conv, e.currentTarget)) rerender();
    });
    card.querySelector(".dt-conv-act.unpin").addEventListener("click", (e) => {
      e.stopPropagation();
      updateConversationMeta(conv.id, { pinned: false });
      rerender();
    });
    board.appendChild(card);
  }
  body.appendChild(board);
  translatePage(body);
}

// Supprime une conversation (synchro avec Lumen via `saved_conversations`).
function deleteConversation(id) {
  const origin = convOrigin(id);
  const key = origin === "bar" ? "saved_conversations" : wsKey("saved_conversations");
  lsSet(key, JSON.stringify(readConvStore(key).filter((c) => c.id !== id)));
  if (currentConvId === id) newConversation();
  remotePushConversations();
}

// Menu groupé « ⋯ » : outils peu fréquents délégués à Lumen.
function openMorePanel(btn) {
  openPanel(btn, (panel, close) => {
    panel.innerHTML = `<div class="dt-panel-head">${tt("Plus d'outils")}</div>`;
    const item = (icon, label, onClick, opts = {}) => {
      const it = document.createElement("div");
      it.className = "dt-panel-item" + (opts.active ? " active" : "");
      it.innerHTML = `<span class="dt-panel-ic">${icon}</span><span class="dt-panel-item-txt">${escapeHtml(label)}</span>${opts.badge ? `<span class="dt-panel-badge">${escapeHtml(opts.badge)}</span>` : ""}`;
      it.addEventListener("click", () => { onClick(); close(); });
      panel.appendChild(it);
    };
    const unread = heartbeatUnread();
    item(ICON.bell, tt("Centre de notifications"), () => openNotificationsWindow(), { badge: unread ? badgeText(unread) : "" });
    item(ICON.heartbeat, tt("Heartbeat"), () => forwardToMain("btn-heartbeat"), { active: heartbeatEnabled() });
  });
}

function heartbeatEnabled() { return localStorage.getItem("heartbeatEnabled") === "true"; }
function heartbeatUnread() { return parseInt(localStorage.getItem("heartbeatNotifUnread") || "0", 10) || 0; }
function badgeText(n) { return n > 99 ? "99+" : String(n); }
function updateHeartbeatBadges() {
  const more = chatEl?.querySelector('[data-act="more"]');
  const badge = more?.querySelector(".dt-ic-badge");
  const unread = heartbeatUnread();
  if (badge) {
    badge.textContent = badgeText(unread);
    badge.hidden = unread <= 0;
  }
  const dockBadge = dockEl?.querySelector(".dt-dock-notif .dt-dock-badge");
  if (dockBadge) {
    dockBadge.textContent = badgeText(unread);
    dockBadge.hidden = unread <= 0;
  }
}

// Fenêtre native des notifications Heartbeat (mêmes données que la barre Lumen,
// via la clé `heartbeatNotifications`), rafraîchie en direct sur `heartbeat-result`.
function getNotifications() {
  try { return JSON.parse(localStorage.getItem("heartbeatNotifications") || "[]"); } catch { return []; }
}
function clearNotifications() {
  lsSet("heartbeatNotifications", "[]");
  lsSet("heartbeatNotifUnread", "0");
  updateHeartbeatBadges();
}
function renderNotifications(body) {
  const list = getNotifications();
  body.innerHTML = "";
  // Barre d'outils : effacer toutes les notifications (comme le panneau Lumen).
  const bar = document.createElement("div"); bar.className = "dt-notif-bar";
  bar.innerHTML = `<span>${list.length} notification${list.length > 1 ? "s" : ""}</span>`;
  const clear = document.createElement("button");
  clear.className = "dt-notif-clear"; clear.textContent = "Tout effacer"; clear.disabled = !list.length;
  clear.addEventListener("click", () => { clearNotifications(); renderNotifications(body); });
  bar.appendChild(clear);
  body.appendChild(bar);
  const wrap = document.createElement("div"); wrap.className = "dt-notif-list";
  if (!list.length) { wrap.innerHTML = `<div class="dt-notif-empty">Aucune notification.</div>`; body.appendChild(wrap); return; }
  for (const n of list) {
    const el = document.createElement("div");
    el.className = "dt-notif-item " + (n.success !== false ? "ok" : "error");
    const out = n.output ? formatMessage(n.output) : `<span class="dt-notif-noout">${n.success !== false ? tt("Exécuté (aucune sortie)") : tt("Échec sans message")}</span>`;
    el.innerHTML = `<div class="dt-notif-head"><span class="dt-notif-ic">${n.success !== false ? ICON.heartbeat : ICON.warn}</span><span class="dt-notif-name">${escapeHtml(n.shortcut || "Heartbeat")}</span><span class="dt-notif-time">${fmtNotifTime(n.timestamp)}</span></div><div class="dt-notif-body">${out}</div>`;
    wrap.appendChild(el);
  }
  body.appendChild(wrap);
  translatePage(body);
}
function fmtNotifTime(ts) { try { return new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }); } catch { return ""; } }
function openNotificationsWindow() {
  const exists = openWindows.get("notifs");
  const win = exists || createWindow({ id: "notifs", title: tt("Centre de notifications"), w: 420, h: 460, x: 160, y: 70 });
  lsSet("heartbeatNotifUnread", "0");
  updateHeartbeatBadges();
  renderNotifications(win.body);
}

// Préchargement du modèle en mémoire (réponse vide via /api/chat, keep-alive).
async function preloadModel(btn) {
  // llama-server démarre et charge le GGUF à la première requête ; envoyer un
  // chat vide ici provoquerait une génération inutile. Le préchargement reste
  // donc réservé à Ollama.
  if (isApiLike(aiSourceNow()) || aiSourceNow() === "llama") return;
  const url = localStorage.getItem("ollamaUrl") || "http://localhost:11434";
  const model = localStorage.getItem("selectedModel") || "";
  if (!model) return;
  btn.classList.add("spinning");
  // Précharger avec le MÊME num_ctx/keep_alive que le chat, sinon Ollama charge
  // au contexte par défaut (RAM gonflée) puis recharge au premier message.
  const numCtx = parseInt(localStorage.getItem("ollamaNumCtx") || "0", 10);
  const keepAlive = localStorage.getItem("ollamaKeepAlive") || "30m";
  try {
    await ollamaPostJson("api/chat", { model, messages: [], ...(numCtx > 0 ? { options: { num_ctx: numCtx } } : {}), keep_alive: keepAlive, stream: false }, url);
  } catch {}
  btn.classList.remove("spinning");
}

function newConversation() {
  clearChatDocs();
  convo = [];
  currentConvId = null;
  telegramChatId = null;
  const win = openWindows.get("assistant");
  if (win) { win.body.querySelector(".dt-chat-log").innerHTML = ""; renderAssistWelcome(win); }
  snapshotDesktopTranscript();
  remotePushConversations();
}

/// Écran d'accueil d'une discussion vide : rappelle le projet actif et sa
/// connaissance, ou invite à en créer un.
function renderAssistWelcome(win = openWindows.get("assistant")) {
  const log = win?.body?.querySelector(".dt-chat-log");
  if (!log || convo.some((m) => m.role !== "system")) return;
  const proj = activeProject();
  const el = document.createElement("div");
  el.className = "dt-assist-welcome";
  if (proj) {
    const st = projectStats(proj);
    el.style.setProperty("--chip-color", proj.color);
    el.innerHTML = `<span class="dt-folder-dot big"></span><b></b>
      <span class="dt-assist-welcome-sub"></span>`;
    el.querySelector("b").textContent = proj.name;
    el.querySelector(".dt-assist-welcome-sub").textContent = st.docs + st.images
      ? tt("{d} document(s) et {i} image(s) sont à ma disposition. Pose ta question.", { d: st.docs, i: st.images })
      : tt("Ajoute des documents ou des images dans le volet de droite : je m'en servirai pour répondre.");
  } else {
    el.innerHTML = `${lumenIcon("sparkles", { cls: "dt-assist-welcome-ic" })}<b>${escapeHtml(tt("Comment puis-je aider ?"))}</b>
      <span class="dt-assist-welcome-sub">${escapeHtml(tt("Crée un projet pour travailler avec des documents, des images et des instructions persistantes."))}</span>`;
  }
  log.appendChild(el);
}

// Les images base64 ne sont pas persistées (quota localStorage) ; elles restent
// en mémoire pour le suivi multimodal de la session courante.
function stripImagesForStorage(history) {
  return history.map((m) => { if (!m || !m.images) return m; const { images, ...rest } = m; return rest; });
}

// Persistance synchronisée avec Lumen (même clé/forme `saved_conversations`).
function saveConversation() {
  if (!convo.length) return;
  // Un fil Telegram n'est pas une discussion locale : il vit côté backend.
  if (telegramChatId != null) return;
  const origin = currentConvId ? convOrigin(currentConvId) : "desktop";
  let saved = readConvStore(origin === "bar" ? "saved_conversations" : wsKey("saved_conversations"));
  const hist = stripImagesForStorage(convo);
  const meta = effectiveModelMeta();
  if (!currentConvId) {
    currentConvId = Date.now().toString();
    // `display` : la question seule, sans le contexte documentaire injecté —
    // sinon le titre devient « Documents à utiliser pour répondre… ».
    const firstMsg = convo.find((m) => m.role === "user");
    const first = firstMsg?.display || firstMsg?.content || "Discussion";
    const title = first.substring(0, 32) + (first.length > 32 ? "…" : "");
    saved.unshift({ id: currentConvId, title, history: hist, source: meta.source, model: meta.model, origin: "desktop", folder: activeProjectId || "" });
  } else {
    const idx = saved.findIndex((c) => c.id === currentConvId);
    if (idx !== -1) {
      saved[idx].history = hist;
      saved[idx].source = meta.source;
      saved[idx].model = meta.model;
    } else {
      saved.unshift({ id: currentConvId, title: (convo[0]?.display || convo[0]?.content || "Discussion").slice(0, 32), history: hist, source: meta.source, model: meta.model, origin });
    }
  }
  writeConvStore(origin, saved);
  remotePushConversations();
}

// Charge une conversation (depuis le panneau ou créée dans Lumen) dans le bureau.
function loadConversation(conv) {
  telegramChatId = null;
  currentConvId = conv.id;
  // La discussion emmène son projet : ouvrir un fil rangé dans « Thèse »
  // active la connaissance de « Thèse ». Un dossier disparu = aucun projet.
  setActiveProject(conv.folder && getProject(conv.folder) ? conv.folder : "", { keepConversation: true });
  convo = Array.isArray(conv.history) ? conv.history.slice() : [];
  const source = conv.source || (conv.model === "shortcut" ? "shortcut" : "ollama");
  // Écritures « au mieux » : si le stockage est plein, la discussion s'affiche
  // quand même (c'est ce que l'utilisateur a demandé), seule la mémorisation du
  // backend et du modèle est perdue.
  const sourceChanged = (aiSourceNow() || "ollama") !== source;
  lsSet("aiSource", source);
  if (isApiLike(source) && conv.model) lsSet(cloudModelKey(source), conv.model);
  else if ((source === "ollama" || source === "llama") && conv.model) lsSet("selectedModel", conv.model);
  // La conversation change de source : le backend Rust doit suivre, sinon le
  // proxy `llm_api_request` relaie vers l'ancien serveur local.
  if (sourceChanged) pushOllamaConfig();
  const pill = chatEl?.querySelector(".dt-model-pill");
  if (pill) pill.textContent = effectiveModelLabel(); refreshAssistChrome();
  const win = ensureConvoWindow();
  renderAssistantConversation(win);
  snapshotDesktopTranscript();
  remotePushConversations();
}

// Fenêtre de conversation : mêmes éléments que le chat Lumen (bulles, markdown,
// coloration de code, streaming, statistiques de tokens / tokens·s).
function ensureConvoWindow() {
  if (openWindows.get("assistant")) return focusWindow("assistant");
  const win = createWindow({ id: "assistant", title: tt("Assistant IA"), w: 1040, h: 640, x: 90, y: 50 });
  win.body.classList.add("dt-assist-body");
  if (localStorage.getItem("dtAssistSide") === "0") win.body.classList.add("side-hidden");
  // Volet de connaissances : replié si l'utilisateur l'a replié, ou par défaut
  // hors projet (il n'y a alors qu'une invite à créer/choisir un projet).
  const kbPref = localStorage.getItem("dtAssistKb");
  if (kbPref === "0" || (kbPref == null && !activeProjectId)) win.body.classList.add("kb-hidden");
  applyAssistPaneWidths(win);
  // Trois colonnes : à gauche les PROJETS et les conversations (un projet est un
  // dossier de discussion muni d'instructions et d'une base de connaissances),
  // au centre le fil façon compagnon mobile, à droite la connaissance du projet
  // actif (documents, images, instructions). Le composeur DÉLÈGUE à la barre
  // des tâches (mentions @/#, pièces jointes, mode, modèle) : une seule logique
  // d'envoi, deux endroits pour taper.
  win.body.innerHTML = `
    <aside class="dt-assist-side">
      <div class="dt-assist-side-head">
        <span class="dt-assist-side-title">${tt("Projets")}</span>
        <button class="dt-assist-mini" data-act="new-project" title="${tt("Nouveau projet")}">${lumenIcon("plus")}</button>
      </div>
      <div class="dt-assist-projects"></div>
      <div class="dt-assist-side-head convs">
        <span class="dt-assist-side-title">${tt("Conversations")}</span>
        <button class="dt-assist-mini" data-act="new" title="${tt("Nouvelle conversation")}">${ICON.newchat}</button>
      </div>
      <div class="dt-assist-search-wrap">
        ${lumenIcon("search", { cls: "dt-assist-search-ic" })}
        <input class="dt-assist-search" type="search" placeholder="${tt("Rechercher une conversation…")}" spellcheck="false" />
      </div>
      <div class="dt-assist-convos"></div>
    </aside>
    <div class="dt-assist-resizer" data-pane="side" title="${tt("Redimensionner")}"></div>
    <div class="dt-assist-main">
      <header class="dt-assist-top">
        <button class="dt-assist-ic" data-act="side" title="${tt("Conversations")}">${lumenIcon("messages-square")}</button>
        <div class="dt-assist-center">
          <button class="dt-assist-project" data-act="project" title="${tt("Projet de cette discussion")}">
            <span class="dt-folder-dot"></span><span class="dt-assist-project-name"></span>${lumenIcon("chevron-down", { cls: "chev" })}
          </button>
          <button class="dt-assist-model" data-act="model" title="${tt("Backend et modèle — cliquer pour changer")}">
            <span class="dt-assist-model-name"></span><span class="dt-assist-model-sub"></span>${lumenIcon("chevron-down", { cls: "chev" })}
          </button>
        </div>
        <div class="dt-assist-top-right">
          <button class="dt-assist-ic" data-act="kb" title="${tt("Connaissances du projet")}">${lumenIcon("library")}</button>
          <button class="dt-assist-ic" data-act="new" title="${tt("Nouvelle conversation")}">${ICON.newchat}</button>
          <button class="dt-assist-ic" data-act="more" title="${tt("Résumé, compaction, branches")}">${lumenIcon("ellipsis")}</button>
        </div>
      </header>
      <div class="dt-chat-log"></div>
      <div class="dt-assist-composer-wrap">
        <div class="dt-assist-attachments" hidden></div>
        <div class="dt-assist-composer">
          <textarea class="dt-assist-input" rows="1" placeholder="${tt("Message à Lumen")}" spellcheck="false"></textarea>
          <div class="dt-assist-row">
            <div class="dt-assist-left">
              <button class="dt-assist-ghost" data-act="attach" title="${tt("Joindre un document ou une image")}">${lumenIcon("paperclip")}</button>
              <button class="dt-assist-chip" data-act="mode" title="${tt("Mode de discussion")}"><span class="dt-assist-mode-ic"></span><span class="dt-assist-mode-label"></span></button>
              <span class="dt-assist-scope" hidden>${lumenIcon("library")}<span class="dt-assist-scope-txt"></span></span>
            </div>
            <div class="dt-assist-right">
              <button class="dt-assist-ghost" data-act="mic" title="${tt("Dictée vocale")}">${lumenIcon("mic")}</button>
              <button class="dt-assist-send" data-act="send" title="${tt("Envoyer")}">${lumenIcon("send-horizontal")}</button>
            </div>
          </div>
        </div>
      </div>
      <div class="dt-assist-drop" hidden><div class="dt-assist-drop-card">${lumenIcon("upload")}<b></b><span></span></div></div>
    </div>
    <div class="dt-assist-resizer" data-pane="kb" title="${tt("Redimensionner")}"></div>
    <aside class="dt-assist-kb"></aside>`;
  const search = win.body.querySelector(".dt-assist-search");
  search.addEventListener("input", () => renderAssistConvos(win, search.value));
  win.body.querySelectorAll('[data-act="new"]').forEach((b) => b.addEventListener("click", () => newConversation()));
  win.body.querySelector('[data-act="new-project"]').addEventListener("click", () => startProjectCreation(win));
  win.body.querySelector('[data-act="side"]').addEventListener("click", () => {
    const hidden = win.body.classList.toggle("side-hidden");
    localStorage.setItem("dtAssistSide", hidden ? "0" : "1");
  });
  // Le bouton replie/déplie TOUJOURS le volet : hors projet, il montre l'état
  // « aucun projet » (créer ou choisir), au lieu de lancer une création de
  // dossier surprise.
  win.body.querySelector('[data-act="kb"]').addEventListener("click", () => {
    const hidden = win.body.classList.toggle("kb-hidden");
    localStorage.setItem("dtAssistKb", hidden ? "0" : "1");
    refreshAssistChrome(win);
  });
  installAssistResizers(win);
  win.body.querySelector('[data-act="project"]').addEventListener("click", (e) => openProjectPicker(e.currentTarget, win));
  // Modèle et mode : les MÊMES panneaux que la barre des tâches, mais ancrés
  // sous les boutons de la fenêtre (cliquer le modèle ici ouvrait le panneau
  // contre la barre, comme si on l'avait activée). Le micro reste délégué à la
  // barre : c'est une action, pas un panneau.
  const barClick = (sel) => chatEl?.querySelector(sel)?.click();
  win.body.querySelector('[data-act="model"]').addEventListener("click", (e) => {
    const pill = chatEl?.querySelector(".dt-model-pill");
    if (pill) openModelPanel(pill, e.currentTarget);
  });
  win.body.querySelector('[data-act="mode"]').addEventListener("click", (e) => openModePanel(e.currentTarget));
  win.body.querySelector('[data-act="mic"]').addEventListener("click", () => barClick('[data-act="mic"]'));
  win.body.querySelector('[data-act="more"]').addEventListener("click", (e) => openAssistMorePanel(e.currentTarget));
  win.body.querySelector('[data-act="attach"]').addEventListener("click", (e) => openAttachPanel(e.currentTarget));
  const input = win.body.querySelector(".dt-assist-input");
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(160, input.scrollHeight) + "px"; };
  input.addEventListener("input", autosize);
  // Menus « @ » / « # » et pastilles : les mêmes que la barre, sur CE champ —
  // sinon une mention tapée ici n'était ni proposée ni peinte, et le texte
  // partait tel quel vers la barre.
  const winHighlight = initMentionHighlight(input, {
    known: () => (dtMentionTools?.tools || []).map((sp) => sp.function?.name).filter(Boolean),
  });
  initChatMentions({
    input,
    anchor: win.body.querySelector(".dt-assist-composer") || input,
    labels: { tools: tt("Outils — ↑↓ pour choisir, Entrée pour insérer"),
              files: tt("Documents — ↑↓ pour choisir, Entrée pour joindre") },
    listTools: mentionToolItems,
    listFiles: mentionFileItems,
    onTool: () => { autosize(); winHighlight.refresh(); },
    onFile: (item) => { attachMentionedFile(item); },
  });
  const sendFromWindow = () => {
    const text = input.value.trim();
    if (!text && pendingImages.length === 0 && chatDocs.length === 0) return;
    const bar = chatEl?.querySelector(".dt-chat-input");
    if (!bar) return;
    bar.value = text;
    input.value = ""; autosize(); winHighlight.refresh();
    chatEl.querySelector(".dt-chat-send")?.click();
  };
  win.body.querySelector('[data-act="send"]').addEventListener("click", sendFromWindow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFromWindow(); }
  });
  installAssistDropZone(win);
  refreshAssistChrome(win);
  renderAssistProjects(win);
  renderAssistConvos(win, "");
  renderProjectPanel(win);
  mountDtExportBar(win);
  ensureTranscriptMirror(win);  // tient la transcription du compagnon à jour
  return win;
}

// Largeurs des volets latéraux : réglables à la souris, mémorisées.
const DT_PANE_LIMITS = { side: [170, 420, 230], kb: [220, 560, 280] };
function applyAssistPaneWidths(win) {
  for (const [pane, [min, max, def]] of Object.entries(DT_PANE_LIMITS)) {
    const el = win.body.querySelector(pane === "side" ? ".dt-assist-side" : ".dt-assist-kb");
    const w = Math.max(min, Math.min(max, Number(localStorage.getItem(`dtAssistW_${pane}`)) || def));
    if (el) el.style.flexBasis = `${w}px`;
  }
}
function installAssistResizers(win) {
  win.body.querySelectorAll(".dt-assist-resizer").forEach((bar) => {
    const pane = bar.dataset.pane;
    const [min, max] = DT_PANE_LIMITS[pane];
    const el = win.body.querySelector(pane === "side" ? ".dt-assist-side" : ".dt-assist-kb");
    bar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = el.getBoundingClientRect().width;
      bar.setPointerCapture(e.pointerId);
      win.body.classList.add("resizing");
      const move = (ev) => {
        // Le volet gauche grandit vers la droite, le droit vers la gauche.
        const delta = pane === "side" ? ev.clientX - startX : startX - ev.clientX;
        const w = Math.max(min, Math.min(max, startW + delta));
        el.style.flexBasis = `${w}px`;
      };
      const up = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        win.body.classList.remove("resizing");
        localStorage.setItem(`dtAssistW_${pane}`, String(Math.round(el.getBoundingClientRect().width)));
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
    bar.addEventListener("dblclick", () => { localStorage.removeItem(`dtAssistW_${pane}`); applyAssistPaneWidths(win); });
  });
}

// ===== Projets : dossiers de discussion + base de connaissances =====
//
// Un projet regroupe des conversations (champ `folder`, partagé avec la barre),
// des instructions et une connaissance (documents indexés en RAG, images
// décrites par le modèle vision). Activer un projet filtre la liste des
// conversations, range les nouvelles discussions dedans et injecte sa
// connaissance à chaque tour (cf. buildDocContext / syncSystemPrompt).

function setActiveProject(id, { keepConversation = false } = {}) {
  const next = id && getProject(id) ? id : "";
  const changed = next !== activeProjectId;
  activeProjectId = next;
  wsSet("dtActiveProject", next);
  // Changer de projet = changer d'espace : on repart sur une discussion neuve,
  // sauf quand c'est l'ouverture d'une conversation qui a entraîné le projet,
  // que la discussion courante appartient déjà au projet visé, ou qu'on
  // revient simplement à la vue « toutes » (qui n'est qu'un filtre élargi).
  const currentFolder = currentConvId ? (getSavedConversations().find((c) => c.id === currentConvId)?.folder || "") : "";
  if (changed && !keepConversation && next && currentFolder !== next) newConversation();
  const win = openWindows.get("assistant");
  if (!win) return;
  if (next) win.body.classList.remove("no-project"); else win.body.classList.add("no-project");
  renderAssistProjects(win);
  refreshAssistConvos();
  renderProjectPanel(win);
  refreshAssistChrome(win);
}

function restoreActiveProject() {
  const id = wsGet("dtActiveProject") || "";
  activeProjectId = id && getProject(id) ? id : "";
}

/// Liste des projets dans le volet gauche : « Toutes » + un rang par projet.
function renderAssistProjects(win = openWindows.get("assistant")) {
  const host = win?.body?.querySelector(".dt-assist-projects");
  if (!host) return;
  host.innerHTML = "";
  const all = getSavedConversations();
  const row = (proj) => {
    const it = document.createElement("div");
    const active = (proj ? proj.id : "") === activeProjectId;
    it.className = "dt-assist-proj" + (active ? " active" : "") + (proj ? "" : " all");
    const n = proj ? all.filter((c) => c.folder === proj.id).length : all.length;
    it.innerHTML = `<span class="dt-assist-proj-ic">${proj ? `<span class="dt-folder-dot"></span>` : lumenIcon("messages-square")}</span>`
      + `<span class="dt-assist-proj-name"></span><span class="dt-assist-proj-n">${n || ""}</span>`;
    if (proj) it.style.setProperty("--chip-color", proj.color);
    it.querySelector(".dt-assist-proj-name").textContent = proj ? proj.name : tt("Toutes les conversations");
    it.addEventListener("click", () => setActiveProject(proj ? proj.id : ""));
    if (proj) {
      it.title = proj.name;
      it.addEventListener("contextmenu", (e) => { e.preventDefault(); openProjectMenu(e, proj, win); });
    }
    host.appendChild(it);
  };
  row(null);
  const projects = listProjects();
  for (const p of projects) row(p);
  if (!projects.length) {
    const empty = document.createElement("button");
    empty.className = "dt-assist-proj-empty";
    empty.innerHTML = `${lumenIcon("folder-open")}<span>${escapeHtml(tt("Créer un premier projet"))}</span>`;
    empty.addEventListener("click", () => startProjectCreation(win));
    host.appendChild(empty);
  }
}

/// Saisie en ligne du nom d'un nouveau projet (`prompt()` est inopérant dans la
/// WebView). Le projet devient actif dès sa création et son volet s'ouvre.
function startProjectCreation(win = openWindows.get("assistant")) {
  const host = win?.body?.querySelector(".dt-assist-projects");
  if (!host || host.querySelector(".dt-assist-proj-input")) return;
  const input = document.createElement("input");
  input.className = "dt-assist-proj-input";
  input.maxLength = 40;
  input.placeholder = tt("Nom du projet");
  const done = (commit) => {
    const name = input.value.trim();
    input.remove();
    if (!commit || !name) return;
    try {
      const proj = createProject(name);
      win.body.classList.remove("kb-hidden");
      localStorage.setItem("dtAssistKb", "1");
      setActiveProject(proj.id);
    } catch (err) { dtToast(String(err?.message || err)); }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); done(false); }
    if (e.key === "Enter") { e.preventDefault(); done(true); }
  });
  input.addEventListener("blur", () => setTimeout(() => { if (input.isConnected) done(true); }, 0));
  host.insertBefore(input, host.children[1] || null);
  input.focus();
}

/// Menu contextuel d'un projet : renommer, supprimer.
function openProjectMenu(e, proj, win) {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "dt-menu dt-project-menu";
  const item = (icon, label, onClick, danger = false) => {
    const it = document.createElement("div");
    it.className = "dt-menu-item" + (danger ? " danger" : "");
    it.innerHTML = `<span class="dt-menu-ic">${icon}</span><span></span>`;
    it.querySelector("span:last-child").textContent = label;
    it.addEventListener("click", () => { closeMenus(); onClick(); });
    menu.appendChild(it);
  };
  item(lumenIcon("pencil"), tt("Renommer"), () => renameProjectInline(proj, win));
  item(lumenIcon("folder-open"), tt("Ouvrir les connaissances"), () => {
    setActiveProject(proj.id);
    win.body.classList.remove("kb-hidden"); localStorage.setItem("dtAssistKb", "1");
  });
  item(ICON.trash, tt("Supprimer le projet"), () => confirmDeleteProject(proj, win), true);
  document.body.appendChild(menu);
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + "px";
  setTimeout(() => document.addEventListener("pointerdown", function h(ev) {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("pointerdown", h); }
  }), 0);
}

function renameProjectInline(proj, win) {
  const host = win?.body?.querySelector(".dt-assist-projects");
  const row = [...(host?.querySelectorAll(".dt-assist-proj") || [])].find((r) => r.title === proj.name);
  if (!row) return;
  const input = document.createElement("input");
  input.className = "dt-assist-proj-input";
  input.maxLength = 40;
  input.value = proj.name;
  const done = (commit) => {
    const name = input.value.trim();
    input.replaceWith(row);
    if (!commit || !name || name === proj.name) return;
    renameProject(proj.id, name);
    renderAssistProjects(win); renderProjectPanel(win); refreshAssistChrome(win);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); done(false); }
    if (e.key === "Enter") { e.preventDefault(); done(true); }
  });
  input.addEventListener("blur", () => setTimeout(() => { if (input.isConnected) done(true); }, 0));
  row.replaceWith(input);
  input.focus(); input.select();
}

/// Suppression en deux temps, dans le volet de connaissances : les discussions
/// sont conservées (dossier vidé), l'index et les fichiers du projet retirés.
function confirmDeleteProject(proj, win) {
  setActiveProject(proj.id);
  const kb = win?.body?.querySelector(".dt-assist-kb");
  if (!kb) return;
  win.body.classList.remove("kb-hidden");
  kb.querySelector(".dt-kb-confirm")?.remove();
  const box = document.createElement("div");
  box.className = "dt-kb-confirm";
  box.innerHTML = `<div class="dt-kb-confirm-txt"></div><div class="dt-kb-confirm-row">
      <button class="dt-kb-btn danger" data-act="yes">${escapeHtml(tt("Supprimer"))}</button>
      <button class="dt-kb-btn" data-act="no">${escapeHtml(tt("Annuler"))}</button></div>`;
  box.querySelector(".dt-kb-confirm-txt").textContent =
    tt("Supprimer le projet « {name} » ? Ses discussions sont conservées (non classées) ; ses documents et images sont retirés de l'index.", { name: proj.name });
  box.querySelector('[data-act="no"]').addEventListener("click", () => box.remove());
  box.querySelector('[data-act="yes"]').addEventListener("click", async () => {
    box.querySelector('[data-act="yes"]').disabled = true;
    const files = deleteProject(proj.id);
    for (const f of files) {
      if (f.docId) { try { await invoke("rag_delete", { docId: f.docId }); } catch {} }
      if (f.sandboxId && f.path) { try { await invoke("sandbox_delete_path", { id: f.sandboxId, path: f.path }); } catch {} }
    }
    if (files.length) { try { await invoke("sandbox_delete_path", { id: files[0].sandboxId, path: proj.id }); } catch {} }
    setActiveProject("");
    dtToast(tt("Projet supprimé."), false);
  });
  kb.prepend(box);
}

/// Sélecteur de projet dans l'en-tête : range la discussion courante.
function openProjectPicker(anchor, win) {
  openPanel(anchor, (panel, close) => {
    panel.classList.add("dt-project-picker");
    panel.innerHTML = `<div class="dt-panel-head">${tt("Projet")}</div>`;
    const row = (label, color, active, onClick) => {
      const it = document.createElement("div");
      it.className = "dt-panel-item" + (active ? " active" : "");
      if (color) it.style.setProperty("--chip-color", color);
      it.innerHTML = `<span class="dt-panel-ic">${color ? `<span class="dt-folder-dot"></span>` : lumenIcon("messages-square")}</span><span class="dt-panel-item-txt"></span>`;
      it.querySelector(".dt-panel-item-txt").textContent = label;
      it.addEventListener("click", () => { onClick(); close(); });
      panel.appendChild(it);
    };
    row(tt("Aucun projet"), "", !activeProjectId, () => moveConversationToProject(""));
    for (const p of listProjects()) row(p.name, p.color, p.id === activeProjectId, () => moveConversationToProject(p.id));
    const add = document.createElement("div");
    add.className = "dt-panel-item";
    add.innerHTML = `<span class="dt-panel-ic">${lumenIcon("plus")}</span><span class="dt-panel-item-txt">${escapeHtml(tt("Nouveau projet…"))}</span>`;
    add.addEventListener("click", () => { close(); startProjectCreation(win); });
    panel.appendChild(add);
  });
}

/// Range la conversation courante dans un projet (ou l'en sort) SANS la
/// réinitialiser : c'est un déplacement, pas un changement d'espace.
function moveConversationToProject(id) {
  if (currentConvId && telegramChatId == null) updateConversationMeta(currentConvId, { folder: id || "" });
  setActiveProject(id, { keepConversation: true });
}

// ---------- Volet de connaissances ----------

const PROJECT_DOC_EXTS = ["pdf", "docx", "doc", "txt", "md", "csv", "tsv", "json", "log", "rtf", "xlsx", "pptx", "html", "htm", "odt", "ods", "odp", "py", "js", "ts", "yaml", "yml"];
let projectBusy = new Map(); // projectId → nombre d'ingestions en cours

function fmtFileSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} Ko`;
  return `${(n / 1048576).toFixed(1)} Mo`;
}

function renderProjectPanel(win = openWindows.get("assistant")) {
  const kb = win?.body?.querySelector(".dt-assist-kb");
  if (!kb) return;
  const proj = activeProject();
  const confirm = kb.querySelector(".dt-kb-confirm");
  kb.innerHTML = "";
  if (confirm) kb.appendChild(confirm);
  if (!proj) {
    win.body.classList.add("no-project");
    const projects = listProjects();
    kb.innerHTML += `<div class="dt-kb-empty">${lumenIcon("folder-open")}<b>${escapeHtml(tt("Aucun projet actif"))}</b>
      <span>${escapeHtml(tt("Un projet regroupe des discussions, des instructions et des documents indexés que l'assistant consulte à chaque question."))}</span>
      <button class="dt-kb-btn primary" data-act="new">${escapeHtml(tt("Nouveau projet"))}</button>
      ${projects.length ? `<div class="dt-kb-pick"><small>${escapeHtml(tt("ou ouvrir un projet existant"))}</small></div>` : ""}</div>`;
    kb.querySelector('[data-act="new"]').addEventListener("click", () => startProjectCreation(win));
    const pick = kb.querySelector(".dt-kb-pick");
    if (pick) for (const proj of projects) {
      const b = document.createElement("button");
      b.className = "dt-kb-btn";
      b.style.setProperty("--chip-color", proj.color);
      b.innerHTML = `<span class="dt-folder-dot"></span>`;
      b.append(proj.name);
      b.addEventListener("click", () => setActiveProject(proj.id));
      pick.appendChild(b);
    }
    return;
  }
  win.body.classList.remove("no-project");
  const stats = projectStats(proj);
  const busy = projectBusy.get(proj.id) || 0;
  const head = document.createElement("div");
  head.className = "dt-kb-head";
  head.style.setProperty("--chip-color", proj.color);
  head.innerHTML = `<span class="dt-folder-dot"></span><div class="dt-kb-title"><b></b><small></small></div>
    <button class="dt-assist-mini" data-act="menu" title="${escapeHtml(tt("Options du projet"))}">${lumenIcon("ellipsis")}</button>`;
  head.querySelector("b").textContent = proj.name;
  const bits = [];
  bits.push(tt("{n} document(s)", { n: stats.docs }));
  if (stats.images) bits.push(tt("{n} image(s)", { n: stats.images }));
  if (stats.chunks) bits.push(tt("{n} extraits indexés", { n: stats.chunks }));
  head.querySelector("small").textContent = bits.join(" · ");
  head.querySelector('[data-act="menu"]').addEventListener("click", (e) => openProjectMenu(e, proj, win));
  kb.appendChild(head);

  // Instructions : ce que le modèle doit savoir ou respecter dans ce projet.
  const instr = document.createElement("section");
  instr.className = "dt-kb-section";
  instr.innerHTML = `<div class="dt-kb-section-head">${lumenIcon("sparkles")}<span>${escapeHtml(tt("Instructions"))}</span></div>
    <textarea class="dt-kb-instructions" rows="3" placeholder="${escapeHtml(tt("Contexte, ton, contraintes… appliqués à toutes les discussions du projet."))}"></textarea>`;
  const ta = instr.querySelector("textarea");
  ta.value = proj.instructions || "";
  let t = null;
  ta.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => setProjectInstructions(proj.id, ta.value), 400);
  });
  ta.addEventListener("blur", () => { clearTimeout(t); setProjectInstructions(proj.id, ta.value); });
  kb.appendChild(instr);

  // Connaissance : documents et images, avec leur état d'indexation.
  const files = document.createElement("section");
  files.className = "dt-kb-section grow";
  files.innerHTML = `<div class="dt-kb-section-head">${lumenIcon("library")}<span>${escapeHtml(tt("Connaissances"))}</span>
      <span class="dt-kb-mode"></span>
      <button class="dt-assist-mini" data-act="add" title="${escapeHtml(tt("Ajouter des documents ou des images"))}">${lumenIcon("plus")}</button></div>
    <div class="dt-kb-files"></div>`;
  files.querySelector(".dt-kb-mode").textContent = !proj.files.length ? "" : projectServedInFull(proj) ? tt("contexte complet") : tt("recherche RAG");
  files.querySelector('[data-act="add"]').addEventListener("click", (e) => openProjectAddPanel(e.currentTarget, proj, win));
  const list = files.querySelector(".dt-kb-files");
  if (!proj.files.length && !busy) {
    list.innerHTML = `<div class="dt-kb-drop">${lumenIcon("upload")}<b>${escapeHtml(tt("Glisse des fichiers ici"))}</b><span>${escapeHtml(tt("PDF, Word, Excel, PowerPoint, texte, images… indexés pour la recherche."))}</span></div>`;
    list.querySelector(".dt-kb-drop").addEventListener("click", (e) => openProjectAddPanel(e.currentTarget, proj, win));
  }
  for (const f of proj.files.slice().sort((a, b) => b.added - a.added)) {
    const row = document.createElement("div");
    row.className = "dt-kb-file" + (f.kind === "image" ? " image" : "");
    const icon = f.kind === "image"
      ? (f.thumb ? `<img src="${f.thumb}" alt="" />` : lumenIcon("image"))
      : lumenIcon(["xlsx", "csv", "tsv", "ods"].includes(fileExt(f.name)) ? "table" : ["pptx", "odp"].includes(fileExt(f.name)) ? "presentation" : "file-text");
    row.innerHTML = `<span class="dt-kb-file-ic">${icon}</span><div class="dt-kb-file-main"><b></b><small></small></div>
      <button class="dt-assist-mini" data-act="use" title="${escapeHtml(f.kind === "image" ? tt("Joindre au prochain message") : tt("Ouvrir"))}">${lumenIcon(f.kind === "image" ? "paperclip" : "external-link")}</button>
      <button class="dt-assist-mini danger" data-act="rm" title="${escapeHtml(tt("Retirer du projet"))}">${lumenIcon("x")}</button>`;
    row.querySelector("b").textContent = f.name;
    const sub = [];
    if (f.size) sub.push(fmtFileSize(f.size));
    if (f.kind === "image") sub.push(f.description ? tt("décrite") : tt("non décrite"));
    else if (f.chunks) sub.push(tt("{n} extraits", { n: f.chunks }));
    else if (f.chars) sub.push(`${f.chars} ${tt("caractères")}`);
    row.querySelector("small").textContent = sub.join(" · ");
    row.title = f.kind === "image" && f.description ? f.description : f.name;
    row.querySelector('[data-act="rm"]').addEventListener("click", () => removeProjectFileEverywhere(proj.id, f).then(() => renderProjectPanel(win)));
    row.querySelector('[data-act="use"]').addEventListener("click", async () => {
      if (f.kind === "image") {
        try {
          const b64 = await invoke("sandbox_read_b64", { id: f.sandboxId, path: f.path });
          const ext = fileExt(f.name);
          pendingImages.push({ dataUrl: `data:${ext === "jpg" ? "image/jpeg" : `image/${ext}`};base64,${b64}`, b64 });
          renderAttachPreview();
        } catch (e) { dtToast(String(e?.message || e)); }
      } else {
        openSearchFile({ id: f.sandboxId, sandbox: PROJECT_SANDBOX, path: f.path });
      }
    });
    list.appendChild(row);
  }
  if (busy) {
    const b = document.createElement("div");
    b.className = "dt-kb-busy";
    b.innerHTML = `<span class="dt-load-dot"></span>${escapeHtml(tt("Indexation de {n} fichier(s)…", { n: busy }))}`;
    list.appendChild(b);
  }
  kb.appendChild(files);
}

/// Menu « + » du volet : fichiers des sandboxes ou de l'ordinateur.
function openProjectAddPanel(anchor, proj, win) {
  openPanel(anchor, (panel, close) => {
    panel.classList.add("dt-attach-panel");
    panel.innerHTML = `<div class="dt-panel-head">${tt("Ajouter au projet")}</div>`;
    const host = document.createElement("div");
    host.className = "dt-panel-item";
    host.innerHTML = `<span class="dt-panel-ic">${lumenIcon("upload")}</span><span class="dt-panel-item-txt">${escapeHtml(tt("Depuis l'ordinateur…"))}</span>`;
    host.addEventListener("click", () => { close(); pickHostFilesForProject(proj); });
    panel.appendChild(host);
    const search = document.createElement("input");
    search.className = "dt-attach-search";
    search.placeholder = tt("Rechercher dans les sandboxes…");
    panel.appendChild(search);
    const listEl = document.createElement("div");
    listEl.className = "dt-attach-list";
    listEl.innerHTML = `<div class="dt-w-empty">${tt("Lecture des sandboxes…")}</div>`;
    panel.appendChild(listEl);
    let files = [];
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const rows = files.filter((f) => !q || f.path.toLowerCase().includes(q) || String(f.sandbox).toLowerCase().includes(q)).slice(0, 40);
      listEl.innerHTML = "";
      if (!rows.length) { listEl.innerHTML = `<div class="dt-w-empty">${tt("Aucun document dans vos sandboxes.")}</div>`; return; }
      for (const f of rows) {
        const it = document.createElement("div");
        it.className = "dt-panel-item";
        it.innerHTML = `<span class="dt-panel-ic">${ICON.file}</span><span class="dt-panel-item-txt"><b></b><small></small></span>`;
        it.querySelector("b").textContent = f.path.split("/").pop();
        it.querySelector("small").textContent = `${f.sandbox} · ${f.path}`;
        it.addEventListener("click", () => { close(); addSandboxFileToProject(proj.id, f); });
        listEl.appendChild(it);
      }
    };
    search.addEventListener("input", render);
    searchFileIndex().then((idx) => {
      files = (idx || []).filter((f) => {
        const ext = fileExt(f.path);
        return (PROJECT_DOC_EXTS.includes(ext) || DT_IMG_EXTS.includes(ext)) && f.sandbox !== PROJECT_SANDBOX;
      });
      render();
      setTimeout(() => search.focus(), 0);
    });
  });
}

function pickHostFilesForProject(proj) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = [...PROJECT_DOC_EXTS, ...DT_IMG_EXTS].map((e) => "." + e).join(",");
  input.addEventListener("change", () => addHostFilesToProject(proj.id, [...(input.files || [])]));
  input.click();
}

async function addHostFilesToProject(projectId, fileList) {
  for (const file of fileList) {
    try {
      const b64 = await fileToB64(file);
      await ingestProjectFile(projectId, file.name, b64, file.size);
    } catch (e) { dtToast(`${file.name} : ${e?.message || e}`); }
  }
}

async function addSandboxFileToProject(projectId, f) {
  const name = f.path.split("/").pop() || "document";
  try {
    const b64 = await invoke("sandbox_read_b64", { id: f.id, path: f.path });
    await ingestProjectFile(projectId, name, b64, Math.round(b64.length * 0.75));
  } catch (e) { dtToast(`${name} : ${e?.message || e}`); }
}

/// La sandbox « Projets » : créée à la demande, un sous-dossier par projet.
let projectSandboxId = null;
async function ensureProjectSandbox() {
  if (projectSandboxId) return projectSandboxId;
  const list = await invoke("sandbox_list").catch(() => []);
  let sb = (list || []).find((s) => s.name === PROJECT_SANDBOX);
  if (!sb) sb = await invoke("sandbox_create", { name: PROJECT_SANDBOX, maxMb: 2048 });
  projectSandboxId = sb.id;
  return sb.id;
}

/// Vignette JPEG compacte d'une image (pour la liste du volet, en localStorage).
function makeThumb(dataUrl, size = 72) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        const r = Math.max(size / img.width, size / img.height);
        c.width = Math.max(1, Math.round(img.width * r)); c.height = Math.max(1, Math.round(img.height * r));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.7));
      } catch { resolve(""); }
    };
    img.onerror = () => resolve("");
    img.src = dataUrl;
  });
}

/// Ingestion d'un fichier dans un projet : copie dans la sandbox « Projets »,
/// puis indexation RAG (documents : texte extrait ; images : description par
/// le modèle vision, pour que « la photo du tableau blanc » soit cherchable).
async function ingestProjectFile(projectId, name, b64, size = 0) {
  const proj = getProject(projectId);
  if (!proj) throw new Error(tt("Projet introuvable."));
  const ext = fileExt(name);
  const isImage = DT_IMG_EXTS.includes(ext);
  if (!isImage && !PROJECT_DOC_EXTS.includes(ext)) throw new Error(tt("Format de fichier non pris en charge."));
  projectBusy.set(projectId, (projectBusy.get(projectId) || 0) + 1);
  renderProjectPanel();
  try {
    const sandboxId = await ensureProjectSandbox();
    const path = `${projectId}/${name}`;
    await invoke("sandbox_import_file", { id: sandboxId, path, dataB64: b64 });
    // Un fichier du même nom remplace l'ancien : son index part avec lui.
    const previous = proj.files.find((f) => f.name === name);
    if (previous?.docId) { try { await invoke("rag_delete", { docId: previous.docId }); } catch {} }
    const entry = { name, kind: isImage ? "image" : "doc", size, path, sandboxId, added: Date.now(), chars: 0, chunks: 0, docId: "" };
    if (isImage) {
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const dataUrl = `data:${mime};base64,${b64}`;
      entry.thumb = await makeThumb(dataUrl);
      let description = "";
      try {
        const { content } = await llmChat(CORE_PROMPTS["core.vision.describe"].build({ image: b64, lang: dtLang() === "en" ? "en" : "fr" }).messages, { rawSystem: true });
        description = String(content || "").trim();
      } catch (e) {
        console.warn("[projets] description d'image impossible", e);
        dtToast(tt("Image ajoutée sans description (le modèle actif ne lit pas les images)."), false);
      }
      entry.description = description;
      if (description) {
        try {
          const res = await invoke("rag_add_text", { title: `${name} (image)`, text: description, source: projectSource(projectId) });
          entry.docId = res?.doc_id || ""; entry.chunks = res?.chunks || 0; entry.chars = res?.chars || description.length;
        } catch (e) { console.warn("[projets] indexation de la description impossible", e); }
      }
    } else {
      let extracted = null;
      try { extracted = await invoke("doc_extract_text", { title: name, b64 }); } catch (e) { throw new Error(String(e?.message || e)); }
      const text = String(extracted?.text || "");
      entry.chars = extracted?.chars || text.length;
      // Texte conservé pour les petits documents : le corpus d'un petit projet
      // part entier dans le contexte, sans passer par la recherche.
      if (entry.chars <= DT_DOC_FULL_CHARS) entry.text = text;
      try {
        const res = await invoke("rag_add_file_bytes", { title: name, b64, source: projectSource(projectId) });
        entry.docId = res?.doc_id || ""; entry.chunks = res?.chunks || 0;
      } catch (e) {
        // Sans encodeur, le document reste utilisable en contexte complet s'il
        // est court ; sinon on refuse, plutôt que de faire croire qu'il est lu.
        if (!entry.text) throw new Error(`${tt("Indexation impossible :")} ${e?.message || e}`);
        dtToast(`${name} — ${tt("non indexé (encodeur indisponible), servi en contexte complet.")}`, false);
      }
    }
    addProjectFile(projectId, entry);
    dtToast(`${name} — ${tt("ajouté au projet.")}`, false);
  } finally {
    projectBusy.set(projectId, Math.max(0, (projectBusy.get(projectId) || 1) - 1));
    renderProjectPanel();
    renderAssistProjects();
    refreshAssistChrome();
  }
}

async function removeProjectFileEverywhere(projectId, f) {
  removeProjectFile(projectId, f.name);
  if (f.docId) { try { await invoke("rag_delete", { docId: f.docId }); } catch {} }
  if (f.sandboxId && f.path) { try { await invoke("sandbox_delete_path", { id: f.sandboxId, path: f.path }); } catch {} }
  renderAssistProjects();
  refreshAssistChrome();
}

/// Glisser-déposer sur la fenêtre : dans un projet, les fichiers rejoignent sa
/// connaissance ; sans projet, ils sont joints au prochain message.
function installAssistDropZone(win) {
  const main = win.body.querySelector(".dt-assist-main");
  const overlay = win.body.querySelector(".dt-assist-drop");
  const kb = win.body.querySelector(".dt-assist-kb");
  let depth = 0;
  const show = () => {
    const proj = activeProject();
    overlay.querySelector("b").textContent = proj ? tt("Ajouter à « {name} »", { name: proj.name }) : tt("Joindre au message");
    overlay.querySelector("span").textContent = proj ? tt("Les documents sont indexés, les images décrites.") : tt("Documents et images");
    overlay.hidden = false;
  };
  const hide = () => { depth = 0; overlay.hidden = true; };
  for (const zone of [main, kb]) {
    zone.addEventListener("dragenter", (e) => { if (!e.dataTransfer?.types?.includes("Files")) return; e.preventDefault(); depth++; show(); });
    zone.addEventListener("dragover", (e) => { if (!e.dataTransfer?.types?.includes("Files")) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    zone.addEventListener("dragleave", () => { if (--depth <= 0) hide(); });
    zone.addEventListener("drop", async (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); hide();
      const files = [...e.dataTransfer.files];
      if (activeProjectId) await addHostFilesToProject(activeProjectId, files);
      else for (const f of files) await addAttachment(f);
    });
  }
}

/// Barre de titre et composeur de la fenêtre Assistant : modèle actif, mode
/// courant, pièces jointes. Appelé à l'ouverture et à chaque changement
/// (source, mode, pièces jointes) pour rester le miroir de la barre des tâches.
function refreshAssistChrome(win = openWindows.get("assistant")) {
  const body = win?.body;
  if (!body) return;
  const meta = effectiveModelMeta();
  const backend = { ollama: "Ollama", llama: "llama.cpp", api: "API", lumen: "Lumen Server", applefm: "Apple", shortcut: "Apple", litert: "LiteRT" }[meta.source] || meta.source;
  const name = body.querySelector(".dt-assist-model-name");
  const sub = body.querySelector(".dt-assist-model-sub");
  if (name) name.textContent = backend;
  if (sub) sub.textContent = meta.source === "shortcut" ? "Apple Intelligence" : (meta.model || "");
  // Projet de la discussion : pastille dans l'en-tête, portée sous le composeur.
  const proj = contextProject();
  const projBtn = body.querySelector(".dt-assist-project");
  if (projBtn) {
    projBtn.classList.toggle("none", !proj);
    projBtn.style.setProperty("--chip-color", proj ? proj.color : "transparent");
    projBtn.querySelector(".dt-assist-project-name").textContent = proj ? proj.name : tt("Aucun projet");
  }
  const scope = body.querySelector(".dt-assist-scope");
  if (scope) {
    const n = proj ? proj.files.length : 0;
    scope.hidden = !n;
    if (n) scope.querySelector(".dt-assist-scope-txt").textContent = projectServedInFull(proj)
      ? tt("{n} fichier(s) en contexte", { n })
      : tt("{n} fichier(s) · recherche", { n });
  }
  body.querySelector('[data-act="kb"]')?.classList.toggle("on", !body.classList.contains("kb-hidden"));
  const modeIc = chatEl?.querySelector(".dt-mode-ic")?.innerHTML || "";
  const modeLbl = chatEl?.querySelector(".dt-mode-label")?.textContent || "";
  const ic = body.querySelector(".dt-assist-mode-ic"), lbl = body.querySelector(".dt-assist-mode-label");
  if (ic) ic.innerHTML = modeIc;
  if (lbl) lbl.textContent = modeLbl;
  const box = body.querySelector(".dt-assist-attachments");
  if (box) {
    box.innerHTML = "";
    box.hidden = pendingImages.length === 0 && chatDocs.length === 0;
    chatDocs.forEach((doc, i) => {
      const chip = document.createElement("span");
      chip.className = "dt-assist-attach";
      chip.innerHTML = `${lumenIcon("file-text")}<span class="name"></span><button class="x" title="${escapeHtml(tt("Retirer"))}">×</button>`;
      chip.querySelector(".name").textContent = doc.name;
      chip.querySelector(".x").addEventListener("click", () => removeChatDoc(i));
      box.appendChild(chip);
    });
    pendingImages.forEach((img, i) => {
      const chip = document.createElement("span");
      chip.className = "dt-assist-attach";
      chip.innerHTML = `<img src="${img.dataUrl}" alt="" /><button class="x" title="${escapeHtml(tt("Retirer"))}">×</button>`;
      chip.querySelector(".x").addEventListener("click", () => { pendingImages.splice(i, 1); renderAttachPreview(); });
      box.appendChild(chip);
    });
  }
}

// Ouvre (ou focalise) la fenêtre de conversation et y rejoue la conversation
// courante si elle n'est pas encore affichée. Utilisé par l'icône « Assistant IA »
// du menu démarrer (la barre de saisie, elle, se bascule depuis la barre des tâches).
function openAssistantWindow() {
  const win = ensureConvoWindow();
  renderAssistantConversation(win);
  return win;
}

// La barre du desktop et la fenêtre Assistant partagent `convo`, mais leurs
// éléments DOM sont distincts. Toujours reconstruire la vue depuis cet état
// partagé évite que la fenêtre conserve une ancienne conversation, notamment
// après une réponse llama-server ou un changement de conversation.
function renderAssistantConversation(win = openWindows.get("assistant")) {
  const log = win?.body?.querySelector(".dt-chat-log");
  if (!log) return;
  clearDtSelection();  // les bulles cochées disparaissent avec le log
  log.innerHTML = "";
  renderAssistWelcome(win);
  renderAssistSummary(log);
  for (const m of convo) {
    if (m.role === "user") { const b = bubble("user", decorateMentions(escapeHtml(m.display || m.content))); b._msg = m; log.appendChild(b); }
    else if (m.role === "assistant" && !m.tool_calls) {
      const item = bubble("ai", "");
      item._msg = m;
      const body = item.querySelector(".dt-msg-body");
      // Les outils appelés pendant le tour : la barre Lumen les enregistre dans
      // `toolNotes` (dont les appels MCP), le bureau dans `progress`. On lit les
      // DEUX, sinon rouvrir une discussion de la barre efface tout ce que le
      // modèle a réellement fait pour répondre.
      const entries = [
        ...(Array.isArray(m.toolNotes) ? m.toolNotes.map((n) => ({ ...n, kind: "tool" })) : []),
        ...(Array.isArray(m.progress) ? m.progress : []),
      ];
      if (entries.length) {
        const progress = document.createElement("div");
        progress.className = "run-progress";
        renderProgressEntries(progress, entries);
        body.appendChild(progress);
      }
      if (Array.isArray(m.cards) && m.cards.length) {
        const live = document.createElement("div");
        live.className = "dt-live-cards";
        restoreToolCards(live, m.cards, { invoke });
        body.appendChild(live);
      }
      const answer = document.createElement("div");
      answer.className = "dt-answer";
      answer.innerHTML = formatMessage(m.content || "");
      body.appendChild(answer);
      appendDtReasoning(answer, m.reasoning);
      if (m.orchestration?.steps) {
        const pb = planBlock({ snapshot: { ...m.orchestration, live: false } });
        const wrapB = answer.previousElementSibling?.classList?.contains("lm-blocks") ? answer.previousElementSibling : null;
        if (wrapB) wrapB.prepend(pb.el);
        else { const w = document.createElement("div"); w.className = "lm-blocks"; w.appendChild(pb.el); body.insertBefore(w, body.firstChild); }
      }
      if (Array.isArray(m.sources) && m.sources.length) renderDtSources(body, m.sources);
      if (Array.isArray(m.fileChoices) && m.fileChoices.length) renderFileChips(body, [], m.fileChoices).catch(() => {});
      else if (entries.length) renderFileChips(body, entries).catch(() => {});
      log.appendChild(item);
    }
  }
  scrollAssistant();
}

// Liste latérale des conversations, filtrée par `query` (titre + contenu).
function renderAssistConvos(win, query = "") {
  const host = win?.body?.querySelector(".dt-assist-convos");
  if (!host) return;
  const q = query.trim().toLowerCase();
  // Vue consolidée : bureau + barre + Telegram.
  const all = [...telegramThreads.map(telegramAsConversation), ...getSavedConversations()];
  const saved = all.filter((c) => {
    // Un projet actif ne montre que ses discussions (Telegram vit hors projet).
    if (activeProjectId && c.folder !== activeProjectId) return false;
    if (!q) return true;
    if ((c.title || "").toLowerCase().includes(q)) return true;
    if ((c.preview || "").toLowerCase().includes(q)) return true;
    return Array.isArray(c.history) && c.history.some((m) => (m.content || "").toLowerCase().includes(q));
  });
  host.innerHTML = "";
  if (!saved.length) {
    host.innerHTML = `<div class="dt-assist-empty">${q ? tt("Aucun résultat.") : activeProjectId ? tt("Aucune discussion dans ce projet.") : tt("Aucune conversation.")}</div>`;
    return;
  }
  for (const conv of saved) {
    const it = document.createElement("div");
    it.className = "dt-assist-conv" + (conv.id === currentConvId ? " active" : "");
    const firstUser = Array.isArray(conv.history) ? conv.history.find((m) => m.role === "user") : null;
    // `display` d'abord : le `content` d'un message peut porter le contexte
    // documentaire injecté, illisible en aperçu.
    const preview = conv.preview || firstUser?.display || firstUser?.content || "";
    // Une pastille dit d'où vient la discussion : le bureau agrège trois sources.
    const badge = conv.origin === "telegram" ? `<span class="dt-conv-tag tg">Telegram</span>`
      : conv.origin === "bar" ? `<span class="dt-conv-tag bar">${tt("Barre")}</span>` : "";
    const unread = conv.unread ? `<span class="dt-conv-unread">${conv.unread}</span>` : "";
    // Vue « toutes » : le projet de chaque discussion, en pastille colorée.
    const folder = !activeProjectId && conv.folder ? resolveFolder(conv) : null;
    const projTag = folder ? `<span class="dt-conv-tag folder" style="--chip-color:${escapeHtml(folder.color)}"><span class="dt-folder-dot"></span>${escapeHtml(folder.name)}</span>` : "";
    // Branche : pastille avec, en infobulle, la discussion d'origine ; résumé
    // et compaction : petite marque, pour savoir ce que le modèle reçoit.
    const branchTag = conv.parent ? `<span class="dt-conv-tag branch" title="${escapeHtml(tt("Branche de « {t} »", { t: conv.parent.title || "" }))}">${lumenIcon("git-branch")}</span>` : "";
    const memoTag = conv.summary ? `<span class="dt-conv-tag memo" title="${escapeHtml(conv.compacted ? tt("Résumé transmis au modèle · discussion compactée") : tt("Résumé transmis au modèle"))}">${lumenIcon(conv.compacted ? "scissors" : "scroll-text")}</span>` : "";
    it.innerHTML = `<div class="dt-assist-conv-main">
        <div class="dt-assist-conv-title">${escapeHtml(conv.title || "Discussion")}${badge}${unread}${projTag}${branchTag}${memoTag}</div>
        <div class="dt-assist-conv-sub">${escapeHtml(preview.slice(0, 70))}</div>
      </div>${conv.origin === "telegram" ? "" : `<button class="dt-assist-conv-del" title="${tt("Supprimer")}">${ICON.trash}</button>`}`;
    it.querySelector(".dt-assist-conv-main").addEventListener("click", () => {
      if (conv.origin === "telegram") loadTelegramConversation(conv.chatId);
      else loadConversation(conv);
    });
    it.querySelector(".dt-assist-conv-del")?.addEventListener("click", (e) => {
      e.stopPropagation(); deleteConversation(conv.id); renderAssistConvos(win, query);
    });
    host.appendChild(it);
  }
}

// Rafraîchit la liste latérale (en conservant le filtre de recherche courant)
// quand l'historique change (envoi, nouvelle conv, suppression…).
function refreshAssistConvos() {
  const win = openWindows.get("assistant");
  if (!win) return;
  const search = win.body.querySelector(".dt-assist-search");
  renderAssistConvos(win, search ? search.value : "");
}

// Le conteneur scrollable est la zone principale (.dt-assist-main) : on défile
// l'assistant vers le bas à chaque nouveau message.
function scrollAssistant() {
  // Depuis la refonte façon compagnon, c'est le fil (.dt-chat-log) qui défile :
  // la zone principale porte aussi l'en-tête et le composeur, fixes.
  const log = openWindows.get("assistant")?.body?.querySelector(".dt-chat-log");
  if (log) log.scrollTop = log.scrollHeight;
}

// ===== Prompt système (profil + mémoire + systemPrompt) — comme la barre Lumen =====
// Le bureau partage la même mémoire (`user/profile`, `user/memories`) et le même
// `systemPrompt` (localStorage) que la barre principale ; on injecte le préambule
// une seule fois en tête de conversation, exactement comme handleSend de Lumen.
const DT_DEFAULT_PROFILE = { name: "", callMe: "", role: "", interests: [], goals: "", tone: "balanced", address: "tu", language: "auto", emoji: false, useProfile: true };
function dtLang() { return (localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr"; }
function dtSystemVoice(lang) {
  const name = localStorage.getItem("lumenVoiceName") || "";
  const voiceLang = (localStorage.getItem("lumenVoiceLang") || "").toLowerCase();
  return name && voiceLang.startsWith(lang) ? name : null;
}
function composeProfilePreamble(p) {
  if (!p || p.useProfile === false) return "";
  const en = dtLang() === "en";
  const bits = [];
  const who = [];
  if (p.name) who.push(en ? `is named ${p.name}` : `s'appelle ${p.name}`);
  if (p.callMe) who.push(en ? `prefers to be called "${p.callMe}"` : `préfère qu'on l'appelle « ${p.callMe} »`);
  if (p.role) who.push(en ? `works as ${p.role}` : `a pour rôle ${p.role}`);
  if (who.length) bits.push((en ? "The user " : "L'utilisateur ") + who.join(", ") + ".");
  const style = [];
  if (p.tone === "concise") style.push(en ? "be concise" : "sois concis");
  else if (p.tone === "detailed") style.push(en ? "be thorough and detailed" : "sois complet et détaillé");
  if (p.address === "vous" && !en) style.push("vouvoie l'utilisateur");
  else if (p.address === "tu" && !en) style.push("tutoie l'utilisateur");
  if (p.language && p.language !== "auto") style.push((en ? "always answer in " : "réponds toujours en ") + (p.language === "fr" ? "français" : "English"));
  style.push(p.emoji ? (en ? "emoji are welcome" : "les emoji sont les bienvenus") : (en ? "avoid emoji" : "évite les emoji"));
  if (style.length) bits.push((en ? "Style: " : "Style : ") + style.join(en ? "; " : " ; ") + ".");
  if (p.interests?.length) bits.push((en ? "Interests: " : "Centres d'intérêt : ") + p.interests.join(", ") + ".");
  if (p.goals) bits.push((en ? "Current goals: " : "Objectifs actuels : ") + p.goals + ".");
  if (Array.isArray(p._memories) && p._memories.length) {
    const facts = p._memories.map((m) => "- " + (typeof m === "string" ? m : m.text)).join("\n");
    bits.push((en ? "Remembered facts:\n" : "À retenir :\n") + facts);
  }
  if (!bits.length) return "";
  return (en ? "[User profile — honor it]\n" : "[Profil utilisateur — à respecter]\n") + bits.join("\n");
}
async function ensureSystemPrompt({ projectTools = false } = {}) {
  const existing = convo.find((m) => m.role === "system");
  const proj = contextProject();
  // Le message système est RECOMPOSÉ à chaque tour : les instructions et la
  // connaissance d'un projet changent entre deux messages, et le résumé de la
  // discussion (généré à la demande, cf. summarizeCurrentConversation) doit
  // partir dès le tour suivant. Deux lectures mémoire par tour, c'est donné.
  let profile = { ...DT_DEFAULT_PROFILE };
  try { const e = await invoke("memory_get", { key: "user/profile" }); if (e && e.value && typeof e.value === "object") profile = { ...DT_DEFAULT_PROFILE, ...e.value }; } catch {}
  try { const e = await invoke("memory_get", { key: "user/memories" }); if (e && Array.isArray(e.value)) profile._memories = e.value; } catch {}
  const sys = [
    composeProfilePreamble(profile),
    (localStorage.getItem("systemPrompt") || "").trim(),
    projectSystemBlock(proj, dtLang()),
    // L'indication n'est donnée que si les outils sont réellement dans le
    // catalogue de ce tour : sinon le modèle « appellerait » en texte libre.
    projectTools ? projectToolsHint(proj) : "",
    conversationSummaryBlock(),
  ].filter(Boolean).join("\n\n");
  if (existing) {
    if (sys) { existing.content = sys; existing.project = proj ? proj.id : ""; }
    else convo.splice(convo.indexOf(existing), 1);
  } else if (sys) {
    convo.unshift({ role: "system", content: sys, project: proj ? proj.id : "" });
  }
}

// ---------- Pièces jointes : images + documents des sandboxes ----------
//
// Le bureau ne pioche PAS dans les fichiers de l'hôte : ses documents vivent
// dans les sandboxes. Le trombone ouvre donc un sélecteur qui les parcourt
// (même index paresseux que la recherche globale) ; l'import depuis l'ordinateur reste
// une entrée secondaire, pour ce qui n'est pas encore dans une sandbox.

const DT_DOC_EXTS = ["pdf", "docx", "txt", "md", "csv", "json", "log", "rtf"];
const DT_IMG_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const DT_DOC_FULL_CHARS = 10000; // en deçà, le document part ENTIER dans le contexte

// Documents joints à la discussion : { name, mode: 'full' | 'rag', text?, docId?, chars, injected }
let chatDocs = [];

/// Source des documents éphémères de la discussion, pour pouvoir les retirer de
/// l'index sans toucher au Corpus permanent (même convention que la barre).
function dtChatDocSource() { return `chat:desktop:${currentConvId || "session"}`; }

function addImageFile(file) {
  return new Promise((resolve) => {
    if (!file || !file.type.startsWith("image/")) { resolve(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const b64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      pendingImages.push({ dataUrl, b64 });
      renderAttachPreview();
      resolve();
    };
    reader.onerror = () => resolve();
    reader.readAsDataURL(file);
  });
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      resolve(url.includes(",") ? url.slice(url.indexOf(",") + 1) : url);
    };
    reader.onerror = () => reject(new Error(tt("Lecture du fichier impossible")));
    reader.readAsDataURL(file);
  });
}

/// Aiguille un fichier de l'hôte : image (vision) ou document (extraction).
async function addAttachment(file) {
  if (!file) return;
  if (file.type?.startsWith("image/")) { await addImageFile(file); return; }
  const ext = fileExt(file.name || "");
  if (DT_DOC_EXTS.includes(ext)) {
    try { await addDocFromB64(file.name || "document", await fileToB64(file)); }
    catch (e) { dtToast(String(e?.message || e)); }
    return;
  }
  dtToast(tt("Format de fichier non pris en charge."));
}

/// Joint un fichier lu dans une sandbox : { id, path, sandbox }.
async function attachSandboxFile(f) {
  const name = f.path.split("/").pop() || "document";
  const ext = fileExt(name);
  let b64;
  try { b64 = await invoke("sandbox_read_b64", { id: f.id, path: f.path }); }
  catch (e) { dtToast(`${tt("Lecture impossible :")} ${e?.message || e}`); return; }
  if (DT_IMG_EXTS.includes(ext)) {
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    pendingImages.push({ dataUrl: `data:${mime};base64,${b64}`, b64 });
    renderAttachPreview();
    return;
  }
  await addDocFromB64(name, b64);
}

/// Deux régimes selon la taille du texte extrait : court → contexte complet
/// (un résumé doit voir tout le document), long → indexation RAG puis recherche
/// restreinte à ces documents à chaque message.
async function addDocFromB64(name, b64) {
  if (chatDocs.some((d) => d.name === name)) return;
  let extracted;
  try { extracted = await invoke("doc_extract_text", { title: name, b64 }); }
  catch (e) { dtToast(String(e?.message || e)); return; }
  const chars = extracted?.chars || 0;
  if (chars <= DT_DOC_FULL_CHARS) {
    chatDocs.push({ name, mode: "full", text: extracted.text || "", chars, injected: false });
    dtToast(`${name} — ${tt("joint à la discussion.")}`, false);
  } else {
    dtToast(`${tt("Indexation en cours :")} ${name}…`, false);
    try {
      const res = await invoke("rag_add_file_bytes", { title: name, b64, source: dtChatDocSource() });
      // On garde le texte extrait : filet de secours si la recherche ne rend
      // rien (embedder indisponible), sinon le document s'affiche en pastille
      // sans jamais atteindre le modèle.
      chatDocs.push({ name, mode: "rag", docId: res?.doc_id, chars, injected: false, text: extracted.text || "" });
      dtToast(`${name} — ${tt("indexé et joint.")}`, false);
    } catch (e) { dtToast(String(e?.message || e)); return; }
  }
  renderAttachPreview();
}


// ===== Mentions « @ » (outils) et « # » (documents) de la barre du bureau =====
// Mêmes gestes que la barre principale, dans TOUS les modes de discussion.

let dtMentionTools = null;   // { at, tools }
let dtMentionFiles = null;   // { at, items }
const DT_MENTION_TTL = 60000;
/// Outils exigés par les « @ » du message courant (consommés par askAssistant).
let pendingMentionTools = [];

async function mentionToolSpecs() {
  if (dtMentionTools && Date.now() - dtMentionTools.at < DT_MENTION_TTL) return dtMentionTools.tools;
  let tools = [];
  try { tools = await buildFluxoTools(); } catch (e) { console.warn("[mentions] outils indisponibles", e); }
  dtMentionTools = { at: Date.now(), tools };
  return tools;
}

/// Sous-titre d'un outil dans le menu « @ » : description courte localisée
/// (lib/tool-publishing.js), nom du workflow Fluxo, ou « App — intention »
/// pour une intention d'app installée ; la consigne longue du schéma (en
/// français, pour le modèle) ne sert que de repli (MCP).
function mentionToolSub(spec) {
  const name = spec.function?.name || "";
  const hint = toolHint(name, dtLang());
  if (hint) return hint.desc;
  if (fluxoToolMap[name]) return tt("Workflow Fluxo « {name} »", { name: fluxoToolMap[name] });
  const agentHint = agentToolHint(name, dtLang());
  if (agentHint) return agentHint;
  const it = intentToolMap[name];
  if (it) {
    const app = installedApps().find((a) => a.id === it.appId);
    return `${app?.name || it.appId} — ${tt(it.intent.title || it.intent.id)}`;
  }
  return String(spec.function?.description || "").slice(0, 90);
}

async function mentionToolItems() {
  return (await mentionToolSpecs())
    .map((spec) => ({ id: spec.function?.name || "", label: spec.function?.name || "", sub: mentionToolSub(spec), avatar: agentToolAvatar(spec.function?.name || "") }))
    .filter((it) => it.label);
}

/// Documents joignables : le Corpus indexé, puis les fichiers texte des
/// sandboxes (l'index de la recherche globale, déjà borné et mis en cache).
async function mentionFileItems() {
  if (dtMentionFiles && Date.now() - dtMentionFiles.at < DT_MENTION_TTL) return dtMentionFiles.items;
  const items = [];
  try {
    const docs = await invoke("rag_list");
    for (const d of (Array.isArray(docs) ? docs : [])) {
      items.push({ id: `rag:${d.doc_id}`, label: d.title || d.doc_id, sub: tt("Corpus"),
                   docId: d.doc_id, chars: d.chars || 0 });
    }
  } catch { /* base indisponible */ }
  try {
    for (const f of await searchFileIndex()) {
      if (!DT_DOC_EXTS.includes(fileExt(f.path))) continue;
      items.push({ id: `sb:${f.id}:${f.path}`, label: f.path.split("/").pop() || f.path,
                   sub: f.path, file: f });
    }
  } catch { /* pas de sandbox */ }
  dtMentionFiles = { at: Date.now(), items };
  return items;
}

/// Rafraîchit les pastilles peintes DANS le champ de saisie du bureau.
let mentionHighlight = null;
function renderMentionChips() { mentionHighlight?.refresh(); }

async function attachMentionedFile(item) {
  if (item.docId) {
    if (chatDocs.some((d) => d.docId === item.docId)) return;
    chatDocs.push({ name: item.label, mode: "rag", docId: item.docId,
                    chars: item.chars || 0, injected: false, text: "", keep: true });
    renderAttachPreview();
    dtToast(`${item.label} — ${tt("joint depuis le Corpus.")}`, false);
    return;
  }
  if (item.file) await attachSandboxFile(item.file);
}

// ===== Fichiers nommés dans la question → joints d'office ======================
//
// Un modèle de 3 B ne sait pas appeler « lister » puis « lire » avec le nom
// EXACT ; et il n'a pas à le faire : quand la question nomme un fichier de la
// sandbox (« lis The Initial Green.pdf »), Lumen le retrouve lui-même
// (comparaison souple : casse, espaces/soulignés, accents) et le joint à la
// discussion comme un « # ». Le modèle répond alors sur pièces.

const DT_FILE_EXT_RE = "pdf|docx?|txt|md|csv|tsv|json|log|rtf|xlsx|pptx|html?|py|js|ts|yaml|yml";

/// Clé de comparaison souple d'un nom de fichier (miroir de `loose_key` en Rust).
function looseFileKey(name) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_\-'’.,()\[\]]/g, "");
}

/// Noms de fichiers cités dans un texte : entre guillemets d'abord (ils peuvent
/// contenir des espaces), puis les mots nus portant une extension connue.
function fileNamesInText(text) {
  const out = new Set();
  const str = String(text || "");
  const quoted = new RegExp(`[«"“']\\s*([^«»"“”']+?\\.(?:${DT_FILE_EXT_RE}))\\s*[»"”']`, "gi");
  for (const m of str.matchAll(quoted)) out.add(m[1].trim());
  // Les noms entre guillemets sont retirés avant la passe « mots nus », sinon
  // « The Initial Green.pdf » donnait aussi un faux « Green.pdf ».
  const rest = str.replace(quoted, " ");
  for (const m of rest.matchAll(new RegExp(`(?:^|[\\s(:])([^\\s«»"“”'(),]+\\.(?:${DT_FILE_EXT_RE}))(?=$|[\\s).,;:!?])`, "gi"))) out.add(m[1].trim());
  // « le fichier CV Andre MARTIN » sans extension : tout ce qui suit le mot
  // « fichier/document » jusqu'à la ponctuation ou une préposition de lieu.
  if (!out.size) {
    for (const m of rest.matchAll(/\b(?:fichier|document|file)s?\s+(?:nommé\s+|appelé\s+|«\s*|"\s*)?([^«»"“”.,;:!?\n]{3,80}?)(?=\s+(?:dans|de|du|depuis|in|from|et|puis)\b|\s*[«»"“”.,;:!?]|\s*$)/gi)) {
      const cand = m[1].trim();
      if (cand && !/^(?:le|la|les|un|une|ce|cette|mon|ma|mes)$/i.test(cand)) out.add(cand);
    }
  }
  return [...out];
}

/// Retrouve dans les sandboxes les fichiers dont le nom est cité. Un seul
/// candidat exact par nom ; sinon (ambigu ou absent) on ne joint rien : les
/// pastilles de choix, elles, laisseront l'utilisateur trancher.
/// Retrouve dans les sandboxes (côté Rust, arborescence complète) les fichiers
/// dont le nom est cité. `attach` = un seul candidat exact par nom → à joindre ;
/// `choices` = plusieurs candidats (ou seulement des proches) → à proposer.
async function resolveFilesInText(text) {
  const names = fileNamesInText(text);
  if (!names.length) return { attach: [], choices: [] };
  const attach = [], choices = [];
  for (const name of names) {
    let found = [];
    try { found = await invoke("sandbox_find_files", { names: [name], sandbox: null }); } catch { found = []; }
    const toFile = (f) => ({ id: f.sandbox_id, sandbox: f.sandbox_name, path: f.path });
    // Seuls les formats qu'on sait joindre comptent : « The Initial Green »
    // désigne aussi un .html et un .lumenpages, mais c'est le .pdf qu'on lit.
    const usableFound = found.filter((f) => attachableFile(toFile(f)));
    const usable = usableFound.map(toFile);
    const exact = usableFound.filter((f) => f.grade === "exact").map(toFile);
    if (exact.length === 1) attach.push(exact[0]);
    else if (exact.length > 1) choices.push(...exact);
    else choices.push(...usable);
  }
  const dedupe = (list) => list.filter((f, i) => list.findIndex((x) => x.id === f.id && x.path === f.path) === i);
  return { attach: dedupe(attach), choices: dedupe(choices) };
}

function attachableFile(f) {
  const name = f.path.split("/").pop() || f.path;
  return DT_DOC_EXTS.includes(fileExt(name)) || DT_IMG_EXTS.includes(fileExt(name));
}

/// Joint automatiquement les fichiers nommés dans la question. Renvoie
/// `{ attached, choices }` : `choices` non vide = la question est ambiguë, il
/// faut proposer les pastilles plutôt que laisser le modèle deviner.
async function autoAttachFilesFromPrompt(prompt) {
  const { attach, choices } = await resolveFilesInText(prompt);
  const attached = [];
  for (const f of attach) {
    const name = f.path.split("/").pop() || f.path;
    if (chatDocs.some((d) => d.name === name)) { attached.push(f); continue; }
    if (!attachableFile(f)) continue;
    await attachSandboxFile(f);
    attached.push(f);
  }
  return { attached, choices: choices.filter(attachableFile) };
}

// ===== Pastilles de fichiers sous une réponse ===================================
//
// Après un listing (outil natif « sandbox_list_files », bloc Fluxo « Lister les
// fichiers ») ou une lecture ratée (« fichiers proches : … »), les fichiers
// cités deviennent des pastilles : un clic joint le fichier à la discussion et
// place le curseur dans la barre pour préciser la demande. Plus besoin de
// recopier un nom exact pour un modèle qui ne le fera pas correctement.

/// Chemins de fichiers cités dans les résultats d'outils d'un tour.
function filePathsInToolEntries(entries) {
  const paths = new Set();
  for (const ev of entries || []) {
    if ((ev.kind || "tool") !== "tool") continue;
    const text = String(ev.toolResult ?? ev.result ?? ev.message ?? "");
    if (!text) continue;
    // « chemin — taille » (listing), « chemin (123 o) », ou « chemin » cité.
    for (const line of text.split(/\n/)) {
      const m = line.match(new RegExp(`^\\s*[-•*]?\\s*([^«»"“”\\n]+?\\.(?:${DT_FILE_EXT_RE}))(?:\\s+[—–-]\\s+\\S+|\\s*\\(|\\s*$)`, "i"));
      if (m) paths.add(m[1].trim());
    }
    for (const m of text.matchAll(new RegExp(`«\\s*([^»]+?\\.(?:${DT_FILE_EXT_RE}))\\s*»`, "gi"))) paths.add(m[1].trim());
  }
  return [...paths];
}

async function renderFileChips(bodyEl, entries, explicit = null) {
  if (!bodyEl || bodyEl.querySelector(".dt-file-chips")) return;
  let files = explicit ? explicit.slice() : [];
  if (!files.length) {
    const cited = filePathsInToolEntries(entries);
    if (!cited.length) return;
    let found = [];
    try { found = await invoke("sandbox_find_files", { names: cited, sandbox: null }); } catch { found = []; }
    for (const f of found.filter((x) => x.grade === "exact")) {
      if (!files.some((x) => x.id === f.sandbox_id && x.path === f.path)) files.push({ id: f.sandbox_id, sandbox: f.sandbox_name, path: f.path });
    }
  }
  if (!files.length) return;
  const wrap = document.createElement("div");
  wrap.className = "dt-file-chips";
  const title = document.createElement("div");
  title.className = "dt-file-chips-title";
  title.textContent = tt("Choisis un ou plusieurs fichiers, puis précise ta demande :");
  wrap.appendChild(title);
  const row = document.createElement("div");
  row.className = "dt-file-chips-row";
  for (const f of files.slice(0, 24)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dt-file-chip";
    const name = f.path.split("/").pop() || f.path;
    b.innerHTML = `${lumenIcon(DT_IMG_EXTS.includes(fileExt(name)) ? "image" : "file-text")}<span>${escapeHtml(name)}</span>`;
    b.title = f.path;
    b.addEventListener("click", async () => {
      if (b.classList.contains("on")) return;
      b.disabled = true;
      await attachSandboxFile(f);
      b.disabled = false;
      b.classList.add("on");
      const input = chatEl?.querySelector(".dt-chat-input");
      if (input) {
        input.placeholder = tt("Précise ta demande sur ce(s) fichier(s)… (Entrée pour envoyer)");
        input.focus();
      }
    });
    row.appendChild(b);
  }
  wrap.appendChild(row);
  bodyEl.appendChild(wrap);
}

/// Outils explicitement mentionnés (« @nom_outil ») dans le message, résolus sur
/// le catalogue publié. Un « @ » qui ne correspond à rien reste un simple mot.
async function mentionedToolSpecs(query) {
  const names = new Set();
  for (const m of String(query || "").matchAll(/(?:^|\s)@([A-Za-z0-9_.-]+)/g)) names.add(m[1]);
  if (!names.size) return [];
  return (await mentionToolSpecs()).filter((sp) => names.has(sp.function?.name));
}

async function removeChatDoc(index) {
  const doc = chatDocs[index];
  if (!doc) return;
  chatDocs.splice(index, 1);
  renderAttachPreview();
  // `keep` : document du Corpus seulement RÉFÉRENCÉ par « # » — le retirer de
  // la discussion ne doit pas l'effacer de la base.
  if (doc.mode === "rag" && doc.docId && !doc.keep) {
    try { await invoke("rag_delete", { docId: doc.docId }); } catch { /* déjà parti */ }
  }
}

/// Retire de l'index les documents éphémères : sans cela, la base se remplirait
/// de pièces jointes mortes au fil des conversations.
async function clearChatDocs() {
  const docs = chatDocs.slice();
  chatDocs = [];
  renderAttachPreview();
  for (const doc of docs) {
    if (doc.mode === "rag" && doc.docId && !doc.keep) {
      try { await invoke("rag_delete", { docId: doc.docId }); } catch { /* ignoré */ }
    }
  }
}

/// Sélecteur de pièce jointe : les fichiers des sandboxes d'abord.
function openAttachPanel(btn) {
  openPanel(btn, (panel, close) => {
    panel.classList.add("dt-attach-panel");
    panel.innerHTML = `<div class="dt-panel-head">${tt("Joindre un document")}</div>`;
    const search = document.createElement("input");
    search.className = "dt-attach-search";
    search.placeholder = tt("Rechercher dans les sandboxes…");
    panel.appendChild(search);
    const listEl = document.createElement("div");
    listEl.className = "dt-attach-list";
    listEl.innerHTML = `<div class="dt-w-empty">${tt("Lecture des sandboxes…")}</div>`;
    panel.appendChild(listEl);
    const hostItem = document.createElement("div");
    hostItem.className = "dt-panel-item dt-attach-host";
    hostItem.innerHTML = `<span class="dt-panel-ic">${ICON.plus}</span><span class="dt-panel-item-txt">${escapeHtml(tt("Depuis l'ordinateur…"))}</span>`;
    hostItem.addEventListener("click", () => { close(); chatEl?.querySelector(".dt-file-input")?.click(); });
    panel.appendChild(hostItem);

    let files = [];
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const rows = files
        .filter((f) => !q || f.path.toLowerCase().includes(q) || String(f.sandbox).toLowerCase().includes(q))
        .slice(0, 40);
      listEl.innerHTML = "";
      if (!rows.length) {
        listEl.innerHTML = `<div class="dt-w-empty">${tt("Aucun document dans vos sandboxes.")}</div>`;
        return;
      }
      for (const f of rows) {
        const it = document.createElement("div");
        it.className = "dt-panel-item";
        it.innerHTML = `<span class="dt-panel-ic">${ICON.file}</span><span class="dt-panel-item-txt"><b></b><small></small></span>`;
        it.querySelector("b").textContent = f.path.split("/").pop();
        it.querySelector("small").textContent = `${f.sandbox} · ${f.path}`;
        it.addEventListener("click", () => { close(); attachSandboxFile(f); });
        listEl.appendChild(it);
      }
    };
    search.addEventListener("input", render);
    searchFileIndex().then((idx) => {
      files = (idx || []).filter((f) => {
        const ext = fileExt(f.path);
        return DT_DOC_EXTS.includes(ext) || DT_IMG_EXTS.includes(ext);
      });
      render();
      setTimeout(() => search.focus(), 0);
    });
  });
}

function clearPendingImages() { pendingImages = []; renderAttachPreview(); }
function renderAttachPreview() {
  refreshAssistChrome();
  const box = chatEl?.querySelector(".dt-attach-preview");
  if (!box) return;
  box.innerHTML = "";
  box.hidden = pendingImages.length === 0 && chatDocs.length === 0;
  chatDocs.forEach((doc, i) => {
    const chip = document.createElement("div");
    chip.className = "dt-attach-doc";
    chip.title = `${doc.name} — ${doc.chars} ${tt("caractères")} (${doc.mode === "rag" ? tt("indexé") : tt("contexte complet")})`;
    chip.innerHTML = `<span class="dt-attach-doc-ic">${ICON.file}</span><span class="dt-attach-doc-name"></span><button class="dt-attach-rm" title="${escapeHtml(tt("Retirer"))}">×</button>`;
    chip.querySelector(".dt-attach-doc-name").textContent = doc.name;
    chip.querySelector(".dt-attach-rm").addEventListener("click", () => removeChatDoc(i));
    box.appendChild(chip);
  });
  pendingImages.forEach((img, i) => {
    const chip = document.createElement("div");
    chip.className = "dt-attach-thumb";
    chip.innerHTML = `<img src="${img.dataUrl}" alt="" /><button class="dt-attach-rm" title="Retirer">×</button>`;
    chip.querySelector(".dt-attach-rm").addEventListener("click", () => {
      pendingImages.splice(i, 1); renderAttachPreview();
    });
    box.appendChild(chip);
  });
}

// ===== Mode Documents (RAG) =====
//
// Même principe que la barre : on cherche AVANT de générer et on injecte les
// passages, plutôt que d'exposer un outil que le modèle devra penser à appeler.

async function ragSearch(query, docIds = null) {
  if (!query.trim()) return [];
  try {
    // `docIds: null` = toute la base ; une liste = seulement les pièces jointes.
    return (await invoke("rag_search", { query, k: 8, docIds })) || [];
  } catch (e) {
    console.warn("[rag] recherche impossible :", e);
    return [];
  }
}

/// Bloc de contexte documentaire à préfixer au message de l'utilisateur.
///
/// Deux entrées : les pièces jointes de la discussion (documents courts injectés
/// une seule fois, documents longs cherchés à chaque tour) et le mode Documents,
/// qui interroge TOUTE la base de connaissances.
async function buildDocContext(query) {
  const result = await collectDocumentContext({
    query, documents: chatDocs, project: contextProject(), ragMode: getMode() === "rag",
    search: args => invoke("rag_search", args), fullChars: DT_DOC_FULL_CHARS,
    labels: { extracts: tt("Extraits de votre base de connaissances :"), cite: tt("Appuie-toi sur ces extraits pour répondre. Si l'information n'y figure pas, dis-le clairement. Cite les extraits utilisés sous la forme (Source 1), (Source 2)…"), truncated: tt("[…document tronqué]") },
  });
  if (result.status === "fallback") dtToast(tt("Recherche sans résultat : le début des documents a été envoyé."), false);
  else if (result.status === "failed") dtToast(`${tt("Recherche impossible :")} ${result.failure}`, false);
  else if (result.status === "empty") dtToast(tt("Aucun extrait trouvé dans votre base de connaissances."), false);
  else if (result.status === "project-empty") dtToast(tt("Aucun extrait du projet ne correspond à cette question."), false);
  return { text: result.parts.length ? `${tt("Documents à utiliser pour répondre :")}\n\n${result.parts.join("\n\n")}\n\n` : "", hits: result.hits };
}

/// Normalise un résultat de `rag_search` en source affichable (même forme que
/// la barre, pour que les deux surfaces persistent la même chose).
function toDtSource(h) {
  return {
    title: String(h?.title || "Document"),
    text: String(h?.text || "").trim(),
    docId: h?.doc_id || "",
    ordinal: Number.isFinite(h?.ordinal) ? h.ordinal : null,
    score: typeof h?.score === "number" ? h.score : null,
    lexical: !!h?.lexical,
  };
}

/// Provenance d'un extrait : son rang dans le document, ou la voie par laquelle
/// il a été trouvé.
function dtSourceOrigin(src) {
  if (src.lexical) return tt("mot-clé");
  if (src.ordinal == null) return "";
  return `${tt("extrait")} ${src.ordinal + 1}`;
}

/// Panneau « Sources » sous une réponse, calqué sur celui de la barre : une
/// pastille par extrait, le détail complet dans UN popover réutilisé. Les
/// infobulles natives ne convenaient pas — un extrait de plusieurs lignes y est
/// illisible et disparaît au moindre mouvement de souris.
function renderDtSources(bodyEl, sources) {
  if (!bodyEl || !Array.isArray(sources) || !sources.length) return;
  bodyEl.querySelector(".dt-sources")?.remove();
  const panel = document.createElement("div");
  panel.className = "dt-sources";
  const head = document.createElement("div");
  head.className = "dt-sources-head";
  // Extraits d'un seul document (le cas courant) : son nom passe en tête, et
  // les pastilles portent alors l'emplacement du passage.
  const titles = [...new Set(sources.map((s) => s.title))];
  const single = titles.length === 1 ? titles[0] : "";
  head.textContent = single ? `${tt("Sources")} · ${single}` : tt("Sources");
  head.title = single;
  panel.appendChild(head);

  const row = document.createElement("div");
  row.className = "dt-sources-row";
  const pop = document.createElement("div");
  pop.className = "dt-source-pop";
  pop.hidden = true;
  const closePop = () => {
    pop.hidden = true;
    row.querySelectorAll(".dt-source-chip.active").forEach((c) => c.classList.remove("active"));
  };

  sources.forEach((src, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dt-source-chip";
    const pct = src.score == null ? "" : `${Math.round(src.score * 100)} %`;
    // Le numéro est celui que le modèle cite dans sa réponse (« Source 3 ») :
    // sans lui, la citation ne renvoie à rien de visible.
    chip.innerHTML = `<b>${i + 1}</b><span class="dt-source-name"></span>` + (pct ? `<i>${escapeHtml(pct)}</i>` : "");
    chip.querySelector(".dt-source-name").textContent = single ? dtSourceOrigin(src) : src.title;
    chip.title = tt("Cliquer pour afficher l'extrait");
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (chip.classList.contains("active")) { closePop(); return; }
      closePop();
      chip.classList.add("active");
      pop.innerHTML = `<div class="dt-source-pop-head"><span class="dt-source-pop-title"></span>`
        + (pct ? `<i>${escapeHtml(pct)}</i>` : "")
        + `<button class="dt-source-pop-close" aria-label="${escapeHtml(tt("Fermer"))}">×</button></div>`
        + `<div class="dt-source-pop-sub"></div><div class="dt-source-pop-text"></div>`;
      pop.querySelector(".dt-source-pop-title").textContent = `${i + 1}. ${src.title}`;
      pop.querySelector(".dt-source-pop-sub").textContent = dtSourceOrigin(src);
      pop.querySelector(".dt-source-pop-text").textContent = src.text;
      pop.querySelector(".dt-source-pop-close").addEventListener("click", (ev) => { ev.stopPropagation(); closePop(); });
      pop.hidden = false;
      const max = Math.max(0, panel.clientWidth - pop.offsetWidth);
      pop.style.left = `${Math.min(Math.max(0, chip.offsetLeft), max)}px`;
      pop.style.top = `${chip.offsetTop + chip.offsetHeight + 6}px`;
    });
    row.appendChild(chip);
  });
  panel.appendChild(row);
  panel.appendChild(pop);
  panel.addEventListener("click", (e) => { if (!pop.contains(e.target)) closePop(); });
  document.addEventListener("click", (e) => { if (!panel.contains(e.target)) closePop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
  bodyEl.appendChild(panel);
}

// ===== Résumé, compaction et branches d'une discussion =====
//
// Trois gestes manuels (menu « ⋯ » de la fenêtre Assistant) :
//   - Résumer : le modèle rédige une note de mémoire de la discussion, rangée
//     dans `conv.summary`. Elle part ENSUITE à chaque tour dans le message
//     système (conversationSummaryBlock), sans que l'utilisateur ait rien à
//     refaire — mais elle n'est jamais générée toute seule.
//   - Compacter : résume (si besoin) puis retire les anciens messages du fil,
//     en gardant les derniers échanges. Le résumé remplace ce qui a été retiré.
//   - Brancher : repartir d'un point de la discussion dans un nouveau fil
//     (même projet), pour explorer sans polluer l'original ; ou repartir sur une
//     « base saine » : un fil vide qui n'emporte que le résumé.

const DT_COMPACT_KEEP_TURNS = 2; // échanges (question + réponse) conservés à la compaction

/// Enregistrement de la discussion courante (bureau ou barre), s'il existe.
function currentConversationRecord() {
  return currentConvId && telegramChatId == null ? getSavedConversations().find((c) => c.id === currentConvId) || null : null;
}

/// Bloc système du résumé : transmis à chaque tour tant qu'il existe.
function conversationSummaryBlock() {
  const conv = currentConversationRecord();
  const summary = String(conv?.summary || "").trim();
  if (!summary) return "";
  const en = dtLang() === "en";
  const head = conv.compacted
    ? (en ? "[Memory note — earlier messages of this conversation were removed; this note replaces them]" : "[Note de mémoire — les premiers messages de cette discussion ont été retirés ; cette note les remplace]")
    : (en ? "[Memory note of this conversation so far]" : "[Note de mémoire de la discussion jusqu'ici]");
  return `${head}\n${summary}`;
}

/// Le modèle peut lire les autres discussions du projet, mais seulement sur
/// demande : on le lui dit, sans les lui envoyer.
function projectToolsHint(proj) {
  if (!proj) return "";
  const others = getSavedConversations().filter((c) => c.folder === proj.id && c.id !== currentConvId).length;
  if (!others) return "";
  return dtLang() === "en"
    ? `This project has ${others} other conversation(s). When the user refers to them (“as we said in the other chat”, “the conversation about…”), call project_list_conversations then project_read_conversation to read them. Do not guess their content.`
    : `Ce projet contient ${others} autre(s) discussion(s). Quand l'utilisateur s'y réfère (« comme on l'a dit dans l'autre discussion », « la conversation sur… »), appelle project_list_conversations puis project_read_conversation pour les lire. N'invente jamais leur contenu.`;
}

const PROJECT_TOOL_NAMES = new Set(["project_list_conversations", "project_read_conversation"]);

/// Outils de lecture des discussions du projet courant (vides hors projet).
function buildProjectTools() {
  if (!contextProject()) return [];
  return [
    { type: "function", function: { name: "project_list_conversations",
      description: "Liste les autres discussions du projet courant : identifiant, titre, date, nombre de messages et résumé s'il existe. À appeler avant project_read_conversation.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Mots-clés optionnels pour filtrer les discussions (titre ou contenu)" } }, required: [] } } },
    { type: "function", function: { name: "project_read_conversation",
      description: "Lit une discussion du projet courant (par identifiant ou par titre) : son résumé puis ses messages. Sert à retrouver ce qui a été dit ou décidé dans une autre discussion du même projet.",
      parameters: { type: "object", properties: {
        conversation: { type: "string", description: "Identifiant (renvoyé par project_list_conversations) ou titre de la discussion" },
        max_chars: { type: "integer", description: "Longueur maximale du texte renvoyé (défaut 6000)" },
      }, required: ["conversation"] } } },
  ];
}

/// Transcription lisible d'une discussion (questions et réponses seulement).
function conversationTranscript(conv, maxChars = 6000) {
  const lines = (conv.history || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.tool_calls && typeof m.content === "string" && m.content.trim())
    .map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${(m.display || m.content).trim()}`);
  let text = lines.join("\n\n");
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n[… discussion tronquée]";
  return text;
}

async function callProjectTool(name, args = {}) {
  const proj = contextProject();
  if (!proj) return "Aucun projet actif : pas d'autres discussions à consulter.";
  const convs = getSavedConversations().filter((c) => c.folder === proj.id);
  if (name === "project_list_conversations") {
    const q = String(args.query || "").trim().toLowerCase();
    const list = convs.filter((c) => !q || (c.title || "").toLowerCase().includes(q)
      || (c.history || []).some((m) => typeof m.content === "string" && m.content.toLowerCase().includes(q)));
    if (!list.length) return q ? `Aucune discussion du projet « ${proj.name} » ne contient « ${q} ».` : `Aucune discussion dans le projet « ${proj.name} ».`;
    return list.map((c) => {
      const n = (c.history || []).filter((m) => m.role === "user" || m.role === "assistant").length;
      const when = new Date(Number(c.id) || 0).toLocaleDateString(dtLang() === "en" ? "en-GB" : "fr-FR");
      const flags = [c.id === currentConvId ? "discussion courante" : "", c.parent ? `branche de « ${c.parent.title || c.parent.id} »` : ""].filter(Boolean);
      return `- id ${c.id} · « ${c.title || "Discussion"} » · ${when} · ${n} messages${flags.length ? ` (${flags.join(", ")})` : ""}${c.summary ? `\n  résumé : ${String(c.summary).replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
    }).join("\n");
  }
  if (name === "project_read_conversation") {
    const ref = String(args.conversation || "").trim();
    const refLc = ref.toLowerCase();
    const conv = convs.find((c) => c.id === ref)
      || convs.find((c) => (c.title || "").toLowerCase() === refLc)
      || convs.find((c) => (c.title || "").toLowerCase().includes(refLc));
    if (!conv) return `Discussion « ${ref} » introuvable dans le projet. Appelle project_list_conversations pour voir les identifiants.`;
    const max = Math.max(500, Math.min(30000, Number(args.max_chars) || 6000));
    const head = `Discussion « ${conv.title || "Discussion"} » (id ${conv.id})${conv.id === currentConvId ? " — c'est la discussion courante" : ""}`;
    const summary = conv.summary ? `\nRésumé : ${conv.summary}\n` : "";
    return `${head}\n${summary}\n${conversationTranscript(conv, max) || "(aucun message)"}`;
  }
  throw new Error(`Outil projet inconnu : ${name}`);
}

/// Génère (ou régénère) le résumé de la discussion courante et l'enregistre.
async function summarizeCurrentConversation({ silent = false } = {}) {
  const conv = currentConversationRecord();
  if (!conv) { dtToast(tt("Envoie d'abord un message : il n'y a rien à résumer.")); return ""; }
  if (busy) { dtToast(tt("Attends la fin de la réponse en cours.")); return ""; }
  const log = openWindows.get("assistant")?.body?.querySelector(".dt-chat-log");
  const card = log ? renderAssistSummary(log, { pending: true }) : null;
  try {
    const { content } = await llmChat(summaryMessages({ history: convo }, dtLang(), { forContext: true, previous: conv.compacted ? conv.summary : "" }), { rawSystem: true });
    const summary = String(content || "").trim();
    if (!summary) throw new Error(tt("Le modèle n'a rien renvoyé."));
    updateConversationMeta(conv.id, { summary, summaryAt: Date.now() });
    if (log) renderAssistSummary(log);
    refreshAssistConvos();
    if (!silent) dtToast(tt("Résumé enregistré : il sera transmis au modèle à chaque tour."), false);
    return summary;
  } catch (e) {
    card?.remove();
    if (log) renderAssistSummary(log);
    dtToast(tt("Résumé impossible : ") + String(e?.message || e));
    return "";
  }
}

function removeConversationSummary() {
  const conv = currentConversationRecord();
  if (!conv) return;
  if (conv.compacted) { dtToast(tt("Cette discussion a été compactée : son résumé remplace les messages retirés et ne peut pas être supprimé.")); return; }
  updateConversationMeta(conv.id, { summary: "", summaryAt: 0 });
  const log = openWindows.get("assistant")?.body?.querySelector(".dt-chat-log");
  if (log) renderAssistSummary(log);
  refreshAssistConvos();
}

/// Compaction : résumé (frais) + retrait des anciens messages du fil. On coupe
/// toujours sur une question de l'utilisateur, pour ne jamais séparer un appel
/// d'outil de son résultat.
async function compactCurrentConversation() {
  const conv = currentConversationRecord();
  if (!conv) { dtToast(tt("Envoie d'abord un message : il n'y a rien à compacter.")); return; }
  if (busy) { dtToast(tt("Attends la fin de la réponse en cours.")); return; }
  const userIdx = convo.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  if (userIdx.length <= DT_COMPACT_KEEP_TURNS) { dtToast(tt("Discussion trop courte pour être compactée.")); return; }
  const summary = await summarizeCurrentConversation({ silent: true });
  if (!summary) return;
  const cut = userIdx[userIdx.length - DT_COMPACT_KEEP_TURNS];
  const system = convo.filter((m) => m.role === "system");
  const removed = convo.slice(0, cut).filter((m) => m.role !== "system").length;
  convo = [...system, ...convo.slice(cut)];
  const prev = conv.compacted || { removed: 0 };
  updateConversationMeta(conv.id, { history: stripImagesForStorage(convo), compacted: { at: Date.now(), removed: removed + (Number(prev.removed) || 0) } });
  const win = openWindows.get("assistant");
  if (win) renderAssistantConversation(win);
  refreshAssistConvos();
  snapshotDesktopTranscript();
  dtToast(tt("{n} message(s) compacté(s) : le résumé les remplace pour le modèle.", { n: removed }), false);
}

/// Nouvelle discussion issue de la courante.
///   - `atIndex` : dernier message conservé (une question = on repart AVANT
///     elle, et son texte est remis dans le composeur pour la reformuler) ;
///   - `fromSummary` : fil vide qui n'emporte que le résumé (« base saine »).
function branchConversation({ atIndex = convo.length - 1, fromSummary = false } = {}) {
  const src = currentConversationRecord();
  if (!src) { dtToast(tt("Envoie d'abord un message : il n'y a rien à brancher.")); return; }
  if (busy) { dtToast(tt("Attends la fin de la réponse en cours.")); return; }
  if (fromSummary && !src.summary) { dtToast(tt("Génère d'abord un résumé : la branche « base saine » repart de lui.")); return; }
  saveConversation();
  let history = [];
  let prefill = "";
  if (!fromSummary) {
    const msg = convo[atIndex];
    const end = msg?.role === "user" ? atIndex : atIndex + 1;
    if (msg?.role === "user") prefill = msg.display || msg.content || "";
    history = stripImagesForStorage(convo.slice(0, end)).filter((m) => m.role !== "system");
  }
  let id = Date.now().toString();
  while (getSavedConversations().some((c) => c.id === id)) id = String(Number(id) + 1);
  const baseTitle = String(src.title || "Discussion").replace(/^⑂\s*/, "");
  const record = {
    id, title: `⑂ ${baseTitle}`, history, source: src.source, model: src.model, origin: "desktop",
    folder: src.folder || "", parent: { id: src.id, title: baseTitle, at: Date.now(), fromSummary },
    ...(src.summary ? { summary: src.summary, summaryAt: src.summaryAt || Date.now() } : {}),
    // Une branche « base saine » n'a plus de messages derrière son résumé :
    // il joue le rôle des messages retirés, comme après une compaction. Une
    // branche d'un fil déjà compacté hérite du même état, pour la même raison.
    ...(fromSummary || src.compacted ? { compacted: { at: Date.now(), removed: fromSummary ? 0 : (Number(src.compacted?.removed) || 0) } } : {}),
  };
  const key = wsKey("saved_conversations");
  lsSet(key, JSON.stringify([record, ...readConvStore(key)]));
  clearChatDocs();
  loadConversation({ ...record, origin: "desktop" });
  refreshAssistConvos();
  if (prefill) {
    const input = openWindows.get("assistant")?.body?.querySelector(".dt-assist-input");
    if (input) { input.value = prefill; input.dispatchEvent(new Event("input")); input.focus(); }
  }
  dtToast(fromSummary ? tt("Nouvelle branche : repart du résumé seul.") : tt("Nouvelle branche créée dans le même projet."), false);
}

/// Carte du résumé en tête du fil (+ mention de la compaction).
function renderAssistSummary(log, { pending = false } = {}) {
  log.querySelector(".dt-assist-summary")?.remove();
  const conv = currentConversationRecord();
  const summary = String(conv?.summary || "").trim();
  if (!summary && !pending) return null;
  const card = document.createElement("div");
  card.className = "dt-assist-summary" + (pending ? " pending" : "");
  const removed = Number(conv?.compacted?.removed) || 0;
  const sub = pending ? tt("Rédaction du résumé…")
    : conv?.compacted ? tt("Transmis au modèle à chaque tour · {n} message(s) retiré(s) par compaction", { n: removed })
    : tt("Transmis au modèle à chaque tour");
  card.innerHTML = `<div class="dt-assist-summary-head">${lumenIcon("scroll-text")}<b>${escapeHtml(tt("Résumé de la discussion"))}</b><span class="sub">${escapeHtml(sub)}</span>
      <span class="spacer"></span>
      <button class="dt-assist-mini" data-act="edit" title="${escapeHtml(tt("Modifier le résumé"))}"${pending ? " disabled" : ""}>${lumenIcon("pencil")}</button>
      <button class="dt-assist-mini" data-act="refresh" title="${escapeHtml(tt("Actualiser le résumé"))}"${pending ? " disabled" : ""}>${lumenIcon("refresh-cw")}</button>
      ${conv?.compacted ? "" : `<button class="dt-assist-mini" data-act="remove" title="${escapeHtml(tt("Retirer le résumé"))}"${pending ? " disabled" : ""}>${lumenIcon("x")}</button>`}
      <button class="dt-assist-mini" data-act="expand" title="${escapeHtml(tt("Afficher en entier / réduire"))}">${lumenIcon("chevron-down")}</button>
    </div>
    <div class="dt-assist-summary-body">${pending ? '<span class="dt-typing">…</span>' : escapeHtml(summary)}</div>`;
  card.querySelector('[data-act="refresh"]').addEventListener("click", () => summarizeCurrentConversation());
  card.querySelector('[data-act="remove"]')?.addEventListener("click", () => removeConversationSummary());
  card.querySelector('[data-act="expand"]').addEventListener("click", () => card.classList.toggle("expanded"));
  // Édition en place : l'utilisateur corrige ce que le modèle recevra. Le texte
  // enregistré est exactement le sien (pas de re-génération).
  card.querySelector('[data-act="edit"]').addEventListener("click", () => {
    if (card.querySelector("textarea")) return;
    card.classList.add("expanded", "editing");
    const bodyEl = card.querySelector(".dt-assist-summary-body");
    const ta = document.createElement("textarea");
    ta.className = "dt-assist-summary-edit";
    ta.value = summary;
    ta.rows = Math.min(18, Math.max(4, summary.split("\n").length + 1));
    const row = document.createElement("div");
    row.className = "dt-assist-summary-actions";
    row.innerHTML = `<button class="dt-kb-btn primary" data-act="save">${escapeHtml(tt("Enregistrer"))}</button><button class="dt-kb-btn" data-act="cancel">${escapeHtml(tt("Annuler"))}</button>`;
    bodyEl.replaceChildren(ta, row);
    ta.focus();
    row.querySelector('[data-act="cancel"]').addEventListener("click", () => renderAssistSummary(log));
    row.querySelector('[data-act="save"]').addEventListener("click", () => {
      const text = ta.value.trim();
      if (!text) { dtToast(tt("Le résumé ne peut pas être vide (utilise « Retirer »)." )); return; }
      updateConversationMeta(conv.id, { summary: text, summaryAt: Date.now(), summaryEdited: true });
      renderAssistSummary(log);
      refreshAssistConvos();
      dtToast(tt("Résumé modifié : c'est ce texte que le modèle recevra."), false);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); renderAssistSummary(log); }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); row.querySelector('[data-act="save"]').click(); }
    });
  });
  const welcome = log.querySelector(".dt-assist-welcome");
  if (welcome && welcome.nextSibling) log.insertBefore(card, welcome.nextSibling); else log.prepend(card);
  return card;
}

/// Menu « ⋯ » de la fenêtre Assistant.
function openAssistMorePanel(btn) {
  openPanel(btn, (panel, close) => {
    const conv = currentConversationRecord();
    panel.innerHTML = `<div class="dt-panel-head">${tt("Discussion")}</div>`;
    const item = (icon, label, desc, onClick, enabled = true) => {
      const it = document.createElement("div");
      it.className = "dt-panel-item" + (enabled ? "" : " disabled");
      it.innerHTML = `<span class="dt-panel-ic">${lumenIcon(icon)}</span><span class="dt-panel-item-txt"><b>${escapeHtml(label)}</b><small>${escapeHtml(desc)}</small></span>`;
      it.addEventListener("click", () => { close(); if (enabled) onClick(); });
      panel.appendChild(it);
    };
    const has = !!conv;
    item("scroll-text", conv?.summary ? tt("Actualiser le résumé") : tt("Résumer la discussion"),
      tt("Note de mémoire transmise au modèle à chaque tour"), () => summarizeCurrentConversation(), has);
    item("scissors", tt("Compacter la discussion"),
      tt("Résume puis retire les anciens messages ({n} derniers échanges gardés)", { n: DT_COMPACT_KEEP_TURNS }), () => compactCurrentConversation(), has);
    panel.insertAdjacentHTML("beforeend", `<div class="dt-panel-sep">${tt("Branches")}</div>`);
    item("git-branch", tt("Nouvelle branche"),
      tt("Copie de la discussion, dans le même projet"), () => branchConversation(), has);
    item("git-fork", tt("Branche « base saine »"),
      tt("Fil vide qui n'emporte que le résumé"), () => branchConversation({ fromSummary: true }), has && !!conv?.summary);
    if (conv?.parent) {
      const parent = getSavedConversations().find((c) => c.id === conv.parent.id);
      item("history", tt("Ouvrir la discussion d'origine"), parent ? (parent.title || "Discussion") : tt("(discussion supprimée)"),
        () => parent && loadConversation(parent), !!parent);
    }
  });
}

let dtAbort = null; // interrompt la réponse en cours (commande « stop »)
async function askAssistant(prompt, images = []) {
  let dtRoute = null;   // aiguillage du moteur de décision (mode chat)
  dtAbort = new AbortController();
  // Un fil Telegram est affiché : une demande à l'IA (recherche globale, widget, action
  // d'app…) ne doit pas s'écrire dedans. On repart sur une discussion neuve.
  if (telegramChatId != null) newConversation();
  // Les outils de lecture des discussions du projet sont au catalogue en mode
  // Outils, et en mode Chat quand la question s'y réfère (cf. chatLoopTools).
  const projectToolsOn = !!contextProject() && (getMode() === "tools" || chatLoopTools(prompt).some((t) => PROJECT_TOOL_NAMES.has(t.function?.name)));
  await ensureSystemPrompt({ projectTools: projectToolsOn });
  const win = ensureConvoWindow();
  const log = win.body.querySelector(".dt-chat-log");
  // La barre peut continuer à recevoir une demande alors que la fenêtre
  // Assistant était déjà ouverte sur une autre vue. Repartir de `convo` garantit
  // que la conversation llama.cpp est bien visible dans cette fenêtre.
  renderAssistantConversation(win);
  // Fichiers nommés dans la question : joints d'office (cf. autoAttachFilesFromPrompt).
  const { attached: autoFiles, choices: fileChoices } = await autoAttachFilesFromPrompt(prompt).catch(() => ({ attached: [], choices: [] }));
  const imgHtml = images.length
    ? `<div class="dt-msg-images">${images.map((im) => `<img src="${im.dataUrl}" alt="" />`).join("")}</div>`
    : "";
  const autoHtml = autoFiles.length
    ? `<div class="dt-msg-files">${autoFiles.map((f) => `<span class="dt-msg-file">${lumenIcon("paperclip")}${escapeHtml(f.path.split("/").pop() || f.path)}</span>`).join("")}</div>`
    : "";
  const userBubble = bubble("user", imgHtml + decorateMentions(escapeHtml(prompt)) + autoHtml);
  log.appendChild(userBubble);
  const ai = bubble("ai", '<span class="dt-typing">…</span>');
  log.appendChild(ai);
  scrollAssistant();

  // Question ambiguë (plusieurs fichiers portent ce nom, ou seulement des noms
  // proches) et rien de joint : on ne demande PAS au modèle de deviner, on
  // propose les fichiers. Code plutôt qu'appel d'outil : c'est plus sûr.
  if (!autoFiles.length && fileChoices.length) {
    const body = ai.querySelector(".dt-msg-body");
    const text = fileChoices.length === 1
      ? tt("Je n'ai pas trouvé ce nom exact. Voulais-tu dire ce fichier ?")
      : tt("Plusieurs fichiers correspondent. Choisis celui (ou ceux) que tu veux, puis précise ta demande :");
    body.innerHTML = `<div>${escapeHtml(text)}</div>`;
    await renderFileChips(body, [], fileChoices);
    convo.push({ role: "user", content: prompt, display: prompt });
    convo.push({ role: "assistant", content: `${text}\n${fileChoices.map((f) => `• ${f.path}`).join("\n")}`, fileChoices });
    saveConversation();
    refreshAssistConvos();
    scrollAssistant();
    return;
  }

  // Mode Documents : la question interroge la base de connaissances et les
  // extraits partent avec elle. Le modèle répond donc sur pièces, sans avoir à
  // savoir appeler un outil — ce dont les petits modèles locaux sont rarement
  // capables de façon fiable.
  // Outils mentionnés avec « @ » : ils forcent la boucle d'appel d'outils pour
  // ce tour, quel que soit le mode de discussion.
  pendingMentionTools = await mentionedToolSpecs(prompt);
  const docCtx = await buildDocContext(prompt);
  const ragSources = docCtx.hits.map(toDtSource);
  // Le contexte documentaire fait partie du tour envoyé au modèle, mais pas de
  // ce qu'on montre ni de ce qu'on relit : `display` porte la question seule,
  // sinon la bulle (et le titre de la conversation) affiche tout le document.
  // En mode Outils, un document joint est présenté au modèle comme un appel
  // d'outil DÉJÀ exécuté (`sandbox_read_file` → contenu) plutôt que collé dans
  // la question : c'est la forme qu'il attend dans une boucle d'outils, et le
  // contenu n'est plus « du texte de l'utilisateur » qu'il peut ignorer en
  // répondant « je ne peux pas accéder au fichier ». L'appel reste visible
  // dans le fil, comme n'importe quel outil ; simplement, c'est Lumen qui l'a
  // exécuté, de façon sûre, à sa place.
  const readFramed = getMode() === "tools" && !!docCtx.text && (aiSourceNow() || "ollama") !== "shortcut";
  const userMsg = { role: "user", content: docCtx.text && !readFramed ? docCtx.text + prompt : prompt };
  if (docCtx.text && !readFramed) userMsg.display = prompt;
  if (images.length) userMsg.images = images.map((im) => im.b64);
  convo.push(userMsg);
  userBubble._msg = userMsg;
  let framedEntries = [];
  if (readFramed) {
    // Pièces jointes + documents du projet dont des extraits ont été retenus.
    const names = [...new Set([...chatDocs.map((d) => d.name), ...docCtx.hits.map((h) => h.title)])].filter(Boolean).join(", ");
    const callId = `call_read_${Date.now().toString(36)}`;
    convo.push({
      role: "assistant", content: "",
      tool_calls: [{ id: callId, type: "function", function: { name: "sandbox_read_file", arguments: JSON.stringify({ path: names }) } }],
    });
    convo.push({ role: "tool", name: "sandbox_read_file", tool_call_id: callId, content: docCtx.text });
    framedEntries = [{ kind: "tool", name: "sandbox_read_file", input: names, result: tt("contenu lu ({n} caractères)", { n: docCtx.text.length }) }];
  }
  busy = true;
  try { window.LumenOrb?.setState("thinking"); } catch {}
  const bodyEl = ai.querySelector(".dt-msg-body");
  const mode = getMode();
  const aiSource = aiSourceNow() || "ollama";
  let finalText = "";
  let displayText = "";
  let turnReasoning = "";
  let orchestration = null;
  let orchestratedSpeech = false;
  let conversationProgress = [];
  try {
    if (aiSource === "shortcut") {
      // Raccourci Apple : pas de function calling, la mention reste du texte.
      if (pendingMentionTools.length) {
        pendingMentionTools = [];
        dtToast(tt("Les outils « @ » ne sont pas disponibles avec les Raccourcis Apple."));
      }
      bodyEl.innerHTML = `<div class="dt-loading"><span class="dt-load-dot"></span>${tt("Modèle Apple…")}</div>`;
      finalText = await runAppleShortcutChat(prompt);
      bodyEl.innerHTML = formatMessage(finalText || "(réponse vide)");
      addStats(ai, null, prompt, finalText, true);
    } else if (pendingMentionTools.length) {
      // Outils mentionnés : ils passent avant le mode courant, avec un
      // catalogue restreint aux outils demandés.
      const picked = pendingMentionTools.slice();
      pendingMentionTools = [];
      bodyEl.innerHTML = "";
      const prog = document.createElement("div"); prog.className = "run-progress"; bodyEl.appendChild(prog);
      const ans = document.createElement("div"); ans.className = "dt-answer";
      const names = picked.map((x) => x.function?.name).join(", ");
      ans.innerHTML = `<div class="dt-loading"><span class="dt-load-dot"></span>${escapeHtml(tt("Réflexion (outils :") + " " + names + ")…")}</div>`;
      bodyEl.appendChild(ans);
      const runId = genRunId();
      activeRuns[runId] = { el: prog, entries: [] };
      const view = createStreamView({ answerEl: ans, render: formatMessage, onRender: scrollAssistant });
      try {
        finalText = await runTools(runId, (entry) => {
          if (entry) {
            activeRuns[runId].entries.push(entry);
            renderProgressEntries(prog, activeRuns[runId].entries);
          }
          scrollAssistant();
        }, { tools: picked, forced: true, view, onReasoning: (r) => { turnReasoning = r; } });
      } finally {
        conversationProgress = activeRuns[runId]?.entries?.slice() || [];
        delete activeRuns[runId];
      }
      ans.innerHTML = formatMessage(finalText || "<em>(outil exécuté)</em>");
    } else if (mode === "router" || mode === "workflow") {
      // Modes action : exécution d'un workflow Fluxo avec progression en direct
      // (étapes, images, widgets) relayée par le serveur loopback via run-progress.
      const name = mode === "router" ? "default router" : getWorkflow();
      bodyEl.innerHTML = "";
      const prog = document.createElement("div"); prog.className = "run-progress"; bodyEl.appendChild(prog);
      const ans = document.createElement("div"); ans.className = "dt-answer";
      ans.innerHTML = `<div class="dt-loading"><span class="dt-load-dot"></span>${escapeHtml(name)}…</div>`;
      bodyEl.appendChild(ans);
      const runId = genRunId();
      activeRuns[runId] = { el: prog, entries: [] };
      try { finalText = await runWorkflow(name, prompt, runId); }
      finally {
        conversationProgress = activeRuns[runId]?.entries?.slice() || [];
        delete activeRuns[runId];
      }
      ans.innerHTML = formatMessage(finalText || "(aucune sortie)");
    } else if (mode === "tools") {
      // Mode Outils : function calling — l'IA appelle les workflows Fluxo comme
      // outils (boucle agentique), avec progression en direct.
      bodyEl.innerHTML = "";
      const prog = document.createElement("div"); prog.className = "run-progress"; bodyEl.appendChild(prog);
      const ans = document.createElement("div"); ans.className = "dt-answer";
      ans.innerHTML = `<div class="dt-loading"><span class="dt-load-dot"></span>${tt("Réflexion (outils Fluxo)…")}</div>`;
      bodyEl.appendChild(ans);
      const runId = genRunId();
      activeRuns[runId] = { el: prog, entries: framedEntries.slice() };
      if (framedEntries.length) renderProgressEntries(prog, activeRuns[runId].entries);
      const view = createStreamView({ answerEl: ans, render: formatMessage, onRender: scrollAssistant });
      try {
        finalText = await runTools(runId, (entry) => {
          if (entry) {
            activeRuns[runId].entries.push(entry);
            renderProgressEntries(prog, activeRuns[runId].entries);
          }
          scrollAssistant();
        }, { view, onReasoning: (r) => { turnReasoning = r; } });
      } finally {
        conversationProgress = activeRuns[runId]?.entries?.slice() || [];
        delete activeRuns[runId];
      }
      ans.innerHTML = formatMessage(finalText || "<em>(workflow exécuté)</em>");
    } else if (mode === "docs") {
      bodyEl.innerHTML = "";
      const prog = document.createElement("div"); prog.className = "run-progress"; bodyEl.appendChild(prog);
      const ans = document.createElement("div"); ans.className = "dt-answer";
      ans.innerHTML = `<div class="dt-loading"><span class="dt-load-dot"></span>${tt("Recherche dans la documentation…")}</div>`;
      bodyEl.appendChild(ans);
      const runId = genRunId();
      activeRuns[runId] = { el: prog, entries: [] };
      const view = createStreamView({ answerEl: ans, render: formatMessage, onRender: scrollAssistant });
      try {
        finalText = await runTools(runId, (entry) => {
          if (entry) {
            activeRuns[runId].entries.push(entry);
            renderProgressEntries(prog, activeRuns[runId].entries);
          }
          scrollAssistant();
        }, { docsOnly: true, view, onReasoning: (r) => { turnReasoning = r; } });
      } finally {
        conversationProgress = activeRuns[runId]?.entries?.slice() || [];
        delete activeRuns[runId];
      }
      ans.innerHTML = formatMessage(finalText || "<em>(aucune réponse)</em>");
    } else if (mode === "chat" && (orchestrateOn()
               || (!images.length && (dtRoute = await dtDecideRoute(prompt))?.route === "orchestrate"))) {
      // Réponse orchestrée : étapes validées et visibles (lib/orchestrator.js).
      bodyEl.innerHTML = "";
      const prog = document.createElement("div"); prog.className = "run-progress"; bodyEl.appendChild(prog);
      const ans = document.createElement("div"); ans.className = "dt-answer";
      bodyEl.appendChild(ans);
      const runId = genRunId();
      activeRuns[runId] = { el: prog, entries: [] };
      const view = createStreamView({ answerEl: ans, render: formatMessage, onRender: scrollAssistant });
      const plan = planBlock({ title: orchestratorText(dtLang()).title });
      view.blocksEl.prepend(plan.el);
      scrollAssistant();
      try {
        const tools = withoutDocToolsUnlessWriting(await buildFluxoTools(), prompt);
        const categoryOverrides = {};
        Object.keys(fluxoToolMap).forEach((n) => { categoryOverrides[n] = "automation"; });
        Object.keys(intentToolMap).forEach((n) => { categoryOverrides[n] = "apps"; });
        PROJECT_TOOL_NAMES.forEach((n) => { categoryOverrides[n] = "projects"; });
        const onProgress = (entry) => {
          // Seules les images passent par le journal : les outils ont déjà leur bloc.
          if (entry && entry.kind !== "tool") { activeRuns[runId].entries.push(entry); renderProgressEntries(prog, activeRuns[runId].entries); }
        };
        if (!currentConvId) saveConversation();
        const out = await runOrchestrated({
          invoke, sessionId: `conversation:${currentConvId}`, turnId: convo.length - 1,
          ...orchestrationBackends(llmBackend()),
          query: userMsg.content, history: convo.slice(0, -1), tools, categoryOverrides, lang: dtLang(),
          chat: llmChat,
          // Système 1 (Tev1) : choix d'outil, effort, ambiguïté, injection, vérification rapide.
          decider: appDecider({ aiSource: aiSourceNow() || "llama", ollamaUrl: localStorage.getItem("ollamaUrl") || "http://localhost:11434", invoke }),
          execTool: (name, args, ctx) => executeDesktopTool(name, args, runId, onProgress, ctx),
          view, plan, signal: dtAbort.signal,
          onUsage: (data, label) => { if (data) recordOllamaUsage(data, label); },
          onAnnounce: announceStep,
          displayNames: fluxoToolMap,
          gate: dtGateFor(dtHostFor(runId)),
                });
        finalText = out.text;
        displayText = out.display || out.text;
        recordOrchestration(invoke, userMsg.content, out, llmBackend()?.model || "");
        orchestratedSpeech = true;
        turnReasoning = out.reasoning || "";
        orchestration = out.plan;
        conversationProgress = [
          ...(activeRuns[runId]?.entries || []),
          ...out.toolNotes.map((n) => ({ kind: "tool", name: n.name, input: n.input, args: n.args, result: n.result.slice(0, 4000) })),
        ];
      } catch (e) {
        plan.fail(String(e?.message || e).slice(0, 200));
        throw e;
      } finally {
        delete activeRuns[runId];
      }
      ans.innerHTML = formatMessage(displayText || finalText || "(réponse vide)");
      addStats(ai, null, prompt, finalText, true);
    } else if (mode === "chat" && dtRoute?.route === "tools") {
      // Moteur de décision : la demande appelle des outils (catalogue « assistant »).
      bodyEl.innerHTML = "";
      const prog = document.createElement("div"); prog.className = "run-progress"; bodyEl.appendChild(prog);
      const ans = document.createElement("div"); ans.className = "dt-answer";
      ans.innerHTML = `<div class="dt-loading"><span class="dt-load-dot"></span>${tt("Réflexion…")}</div>`;
      bodyEl.appendChild(ans);
      const runId = genRunId();
      activeRuns[runId] = { el: prog, entries: [] };
      const view = createStreamView({ answerEl: ans, render: formatMessage, onRender: scrollAssistant });
      try {
        finalText = await runTools(runId, (entry) => {
          if (entry) {
            activeRuns[runId].entries.push(entry);
            renderProgressEntries(prog, activeRuns[runId].entries);
          }
          scrollAssistant();
        }, { tools: dtRoute.tools, view, onReasoning: (r) => { turnReasoning = r; } });
      } finally {
        conversationProgress = activeRuns[runId]?.entries?.slice() || [];
        delete activeRuns[runId];
      }
      ans.innerHTML = formatMessage(finalText || "(réponse vide)");
      addStats(ai, null, prompt, finalText, true);
    } else if (mode !== "rag" && chatLoopTools(prompt).length) {
      // Discussion simple AVEC l'outil mémoire et/ou les discussions du projet :
      // même boucle d'appel d'outils que le mode Outils, catalogue réduit.
      bodyEl.innerHTML = "";
      const prog = document.createElement("div"); prog.className = "run-progress"; bodyEl.appendChild(prog);
      const ans = document.createElement("div"); ans.className = "dt-answer";
      ans.innerHTML = `<div class="dt-loading"><span class="dt-load-dot"></span>${tt(memoryToolOn() ? "Réflexion (mémoire)…" : "Réflexion (discussions du projet)…")}</div>`;
      bodyEl.appendChild(ans);
      const runId = genRunId();
      activeRuns[runId] = { el: prog, entries: [] };
      const view = createStreamView({ answerEl: ans, render: formatMessage, onRender: scrollAssistant });
      try {
        finalText = await runTools(runId, (entry) => {
          if (entry) {
            activeRuns[runId].entries.push(entry);
            renderProgressEntries(prog, activeRuns[runId].entries);
          }
          scrollAssistant();
        }, { tools: chatLoopTools(prompt), view, onReasoning: (r) => { turnReasoning = r; } });
      } finally {
        conversationProgress = activeRuns[runId]?.entries?.slice() || [];
        delete activeRuns[runId];
      }
      ans.innerHTML = formatMessage(finalText || "(réponse vide)");
      addStats(ai, null, prompt, finalText, true);
    } else {
      // Mode chat : streaming Ollama avec indicateurs réflexion/chargement.
      // Avec une image jointe, l'attente avant le 1ᵉʳ token = encodage de l'image
      // (phase prompt-eval), pas un chargement disque → libellé adapté.
      const loadLabel = images.length ? tt("Analyse de l'image…") : tt("Chargement du modèle…");
      bodyEl.innerHTML = `<div class="dt-loading"><span class="dt-load-dot"></span>${loadLabel}</div>`;
      const modelConvo = await withMemoryRecall(invoke, convo, prompt, { context: "bar", limit: 5 });
      const ans = document.createElement("div"); ans.className = "dt-answer";
      let view = null;
      const { text, stats, reasoning } = await streamChat(modelConvo, {
        onUpdate: (st) => {
          if (!view) {
            bodyEl.innerHTML = "";
            bodyEl.appendChild(ans);
            view = createStreamView({ answerEl: ans, render: formatMessage, onRender: scrollAssistant });
          }
          view.update(st);
        },
      });
      view?.finish();
      finalText = text;
      if (!view) { bodyEl.innerHTML = ""; bodyEl.appendChild(ans); if (reasoning) appendDtReasoning(ans, reasoning); }
      ans.innerHTML = formatMessage(text || "(réponse vide)");
      turnReasoning = reasoning || "";
      addStats(ai, stats, prompt, text, true);
    }
    if (ragSources.length) renderDtSources(bodyEl, ragSources);
    // Sources cliquables + suites en un clic (lib/answer-extras.js). Mode
    // hybride : si la réponse locale a échoué, la seule suite proposée est de
    // rejouer la demande sur l'API cloud.
    const extraNotes = conversationProgress.filter((e) => e.kind === "tool").map((e) => ({ name: e.name, args: e.args, input: e.input, result: e.result, error: e.error || e.status === "error" || e.ok === false }));
    const escalate = looksFailed(finalText, extraNotes) && await apiEscalationAvailable().catch(() => false);
    if (finalText || escalate) {
      renderAnswerExtras(bodyEl, {
        text: finalText, lang: dtLang(), icon: (n) => lumenIcon(n),
        notes: extraNotes,
        onEscalate: escalate ? () => escalateToApi(prompt, images) : null,
        onOpen: openFromAssistant,
        onPrompt: (p) => { if (!busy) askAssistant(p); },
        onPhone: (t) => invoke("notify_island", { payload: { kind: "info", title: "Lumen", body: String(t).slice(0, 600), icon: "", source: "lumen-desktop" } }),
      });
    }
    renderFileChips(bodyEl, conversationProgress).catch(() => {});
    if (finalText && !ai.querySelector(".dt-replay")) addStats(ai, null, prompt, finalText, true);
    const assistantMsg = {
      role: "assistant",
      content: finalText,
      ...(conversationProgress.length ? { progress: conversationProgress } : {}),
      ...(turnReasoning ? { reasoning: turnReasoning } : {}),
      ...(orchestration ? { orchestration } : {}),
      // Les sources voyagent avec la réponse : elles doivent réapparaître quand
      // la conversation est rechargée, comme dans la barre.
      ...(ragSources.length ? { sources: ragSources } : {}),
    };
    const cards = snapshotToolCards(ai);
    if (cards.length) assistantMsg.cards = cards;
    convo.push(assistantMsg);
    ai._msg = assistantMsg;
    saveConversation();
    refreshAssistConvos();
    remotePush({ type: "answer", text: finalText });
  } catch (e) {
    if (e?.name === "AbortError" || dtAbort?.signal.aborted) {
      // Interrompu (« stop ») : on garde ce qui était déjà écrit.
      bodyEl.insertAdjacentHTML("beforeend", `<p class="dt-msg-err">⏹ ${escapeHtml(tt("Arrêté"))}</p>`);
    } else {
      bodyEl.innerHTML = `<span class="dt-msg-err">Erreur : ${escapeHtml(e?.message || String(e))}</span>`;
      if (await apiEscalationAvailable().catch(() => false)) {
        renderAnswerExtras(bodyEl, { text: "", lang: dtLang(), icon: (n) => lumenIcon(n), onEscalate: () => escalateToApi(prompt, images), onOpen: openFromAssistant, onPrompt: () => {} });
      }
    }
  }
  busy = false;
  scrollAssistant();
  // La lecture vocale pilote elle-même l'orbe (speaking→idle) : on ne force pas
  // « idle » ici, sinon l'animation de parole serait écrasée aussitôt.
  // Réponse orchestrée : la version FINALE, après les annonces d'étapes.
  if (autospeak && finalText && orchestratedSpeech) speakAfterAnnouncements(finalText);
  else if (autospeak && finalText) speak(finalText);
  else { try { window.LumenOrb?.setState("idle"); } catch {} }
}

// ===== Actions de la recherche globale sans résultat =====
// `tool` : outil « @ » requis (filtré selon ce qui est réellement disponible) ;
// `create` : création proposée même sans avis du moteur de décision ;
// `desc` : texte pour Tev1 (en anglais, sa langue d'entraînement).
const atTool = (name) => (q) => askAssistant(`@${name} ${q}`);
const SPOT_ACTIONS = [
  { id: "document", create: true, tool: "doc_rediger", icon: "file-text", label: "Rédiger un document : « {q} »", hint: "Document nourri par tes fichiers et le Corpus",
    desc: "Write a document, letter, report or text about this subject.", run: atTool("doc_rediger"),
    // Sans l'outil de rédaction (dépublié dans la Boîte à outils) : Opus vierge.
    fallback: (q) => openCreativeApp("document", { title: q }) },
  { id: "presentation", create: true, icon: "presentation", label: "Créer une présentation : « {q} »", hint: "Diapositives générées puis ouvertes dans Opus",
    desc: "Create a slide presentation (slides, deck, keynote) about this subject.", run: (q) => spotCreatePresentation(q) },
  { id: "spreadsheet", create: true, icon: "table", label: "Créer un tableur : « {q} »", hint: "Tableau généré puis ouvert dans Calc",
    desc: "Create a spreadsheet or table (budget, list, comparison, planning with rows and columns).", run: (q) => spotCreateSheet(q) },
  { id: "tables", tool: "query_tables", search: true, icon: "database", label: "Chercher dans mes bases de données", hint: "Interroge tes tables en langage naturel",
    desc: "Look up information in the user's databases (clients, products, invoices, stock, records).", run: atTool("query_tables") },
  { id: "files", tool: "search_personal_data", search: true, icon: "folder", label: "Chercher dans mes fichiers et données", hint: "Fichiers, notes, photos et données de toutes les apps",
    desc: "Find a file, note, photo or record among the user's own data.", run: atTool("search_personal_data") },
  { id: "corpus", tool: "search_documents", search: true, icon: "book-open-text", label: "Chercher dans le Corpus", hint: "Recherche dans les documents indexés",
    desc: "Search the user's indexed documents and knowledge base.", run: atTool("search_documents") },
  { id: "mail", tool: "mail_trouver_info", icon: "mail", label: "Chercher dans mes e-mails", hint: "Répond en citant les messages",
    desc: "Find information in the user's e-mails (order number, date, address, sender).", run: atTool("mail_trouver_info") },
  { id: "reminder", tool: "create_reminder", icon: "bell", label: "Créer un rappel", hint: "Rappel daté dans l'Agenda",
    desc: "Create a reminder or a dated task (remind me, tomorrow, at 9am).", run: atTool("create_reminder") },
  { id: "web", tool: "web_search", icon: "globe", label: "Rechercher sur le web", hint: "Le seul outil qui sorte de la machine",
    desc: "Search the web for current or public information (news, prices, facts).", run: atTool("web_search") },
  { id: "image", tool: "generate_image", icon: "image", label: "Générer une image", hint: "Moteur d'image des Réglages",
    desc: "Generate an image, drawing, logo or illustration.", run: atTool("generate_image") },
];

// Capture analysée avec la saisie comme question (candidat du moteur).
SPOT_ACTIONS.push({ id: "screen", icon: "eye", label: "Analyser l'écran : « {q} »", hint: "Capture l'écran et répond à la question",
  desc: "The question is about what is currently visible on the user's screen.", run: (q) => understandScreen(q) });

// Recherche web dans le navigateur de Lumen (bus d'interop → browser/main.js).
const SPOT_BROWSER = { id: "browser", icon: "globe", label: "Rechercher « {q} » sur le web", hint: "Dans le navigateur de Lumen",
  run: (q) => handoff("browser", makeObject("text", { text: q, title: q }, { app: "search" })) };

// Agents = outils « agent_<nom> » du catalogue « @ » (lib/agent-delegation.js).
async function spotAgents() {
  let specs = [];
  try { specs = await mentionToolSpecs(); } catch {}
  return specs
    .map((sp) => sp.function)
    .filter((f) => f?.name?.startsWith("agent_"))
    .map((f) => {
      // « Confie une tâche à l'agent « Nom », sa description. Il travaille… »
      const m = String(f.description || "").match(/[«“]\s*([^»”]+?)\s*[»”]([^.\n]*)/);
      return {
        tool: f.name,
        name: m?.[1] || f.name.slice(6).replace(/_/g, " "),
        desc: (m?.[2] || "").replace(/^[\s,:—-]+/, "").slice(0, 110),
      };
    });
}
// Tâche = la saisie sans « agent », « lancer… » ni le nom de l'agent.
function spotAgentTask(text, agent) {
  const nameWords = new Set(normSearch(agent.name).split(/\s+/));
  return text.split(/\s+/)
    .filter((w) => { const n = normSearch(w).replace(/[^a-z0-9]/g, ""); return n && !nameWords.has(n) && !/^(agent|agents|lancer|lance|demarrer|run|start|launch|confier|deleguer|a|au|l)$/.test(n); })
    .join(" ").trim();
}
// Avec une tâche : délégation immédiate (carte suivie dans l'Assistant). Sans :
// le composeur reçoit « @agent_x » et attend la consigne.
function runSpotAgent(agent, task) {
  if (task && task.length >= 3) { askAssistant(`@${agent.tool} ${task}`); return; }
  const bar = chatEl?.querySelector(".dt-chat-input");
  if (!bar) { openAppById("agents"); return; }
  bar.value = `@${agent.tool} `;
  bar.dispatchEvent(new Event("input", { bubbles: true }));
  bar.focus();
  bar.setSelectionRange(bar.value.length, bar.value.length);
}

const spotJson = async (system, q, schema) => {
  const { content } = await llmChat([{ role: "system", content: system }, { role: "user", content: q }],
    { json: true, schema, rawSystem: true, think: false, maxTokens: 1800, source: "spotlight" });
  const t = String(content || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { return JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] || "null"); }
};

async function spotCreatePresentation(q) {
  dtToast(tt("Génération de la présentation…"), false);
  try {
    const en = dtLang() === "en";
    const out = await spotJson(
      en ? "You create slide decks. Return JSON {title, slides:[{title, bullets:[string]}]}: 5 to 8 slides, 2 to 5 short bullets each."
        : "Tu crées des présentations. Rends un JSON {title, slides:[{title, bullets:[string]}]} : 5 à 8 diapositives, 2 à 5 puces courtes chacune.",
      q,
      { type: "object", properties: { title: { type: "string" }, slides: { type: "array", items: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "bullets"] } } }, required: ["title", "slides"] },
    );
    if (!out?.slides?.length) throw new Error("vide");
    const html = out.slides.map((sl) => `<div class="ck-slide"><h1>${escapeHtml(sl.title || "")}</h1><ul>${(sl.bullets || []).map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul></div>`).join("");
    openCreativeApp("presentation", { html, title: out.title || q });
  } catch (e) {
    dtToast(tt("Présentation impossible : {e}", { e: e?.message || e }));
    openCreativeApp("presentation", { title: q });
  }
}

async function spotCreateSheet(q) {
  dtToast(tt("Génération du tableur…"), false);
  try {
    const en = dtLang() === "en";
    const out = await spotJson(
      en ? "You create spreadsheets. Return JSON {title, columns:[string], rows:[[string|number]]}: useful columns, realistic rows (max 30), numbers as numbers."
        : "Tu crées des tableurs. Rends un JSON {title, columns:[string], rows:[[string|number]]} : colonnes utiles, lignes réalistes (30 max), nombres en nombres.",
      q,
      { type: "object", properties: { title: { type: "string" }, columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: { type: ["string", "number"] } } } }, required: ["title", "columns", "rows"] },
    );
    if (!out?.columns?.length) throw new Error("vide");
    openSheetsRows(out.title || q, out.columns, out.rows || []);
  } catch (e) {
    dtToast(tt("Tableur impossible : {e}", { e: e?.message || e }));
    openSheetsApp({ title: q });
  }
}

// Mode hybride : la même demande, rejouée sur l'API cloud le temps d'un tour
// (harnais complet : outils, orchestration, boucle Rust).
function escalateToApi(prompt, images = []) {
  if (busy) return;
  dtToast(tt("Escalade vers l'API cloud…"), false);
  withApiEscalation(() => askAssistant(prompt, images)).catch(() => {});
}

function wfExtraVars() {
  return {
    model: localStorage.getItem("selectedModel") || "",
    ollama_url: localStorage.getItem("ollamaUrl") || "http://localhost:11434",
    lang: localStorage.getItem("lang") || "fr",
  };
}
// Exécute un workflow Fluxo (modes Routeur / Workflow), comme Lumen.
async function runWorkflow(name, input, runId) {
  if (!name) return tt("(aucun workflow sélectionné)");
  return await invoke("run_fluxo_workflow", { name, input, runId, extraVars: wfExtraVars() });
}

// ===== Mode Outils : function calling (porté de runOllamaAgent de Lumen) =====
let fluxoToolMap = {};
const DOMOTIQUE_TOOL_NAMES = new Set(["domotique_list_devices", "domotique_get_state", "domotique_command"]);
const MEMORY_TOOL_NAMES = new Set(["memory_recall", "memory_remember"]);
let intentToolMap = {};
/// Ouvre une app installée sur un onglet donné, pour lui remettre une intention.
function openAppForIntent(appId, tab) {
  const packaged = installedApps().find((a) => a.id === appId);
  if (packaged) {
    openInstalledApp(packaged, { createWindow, focusWindow, openWindows, applyFrameTheme, framePermissions: APP_FRAME_PERMISSIONS }, tab);
    return;
  }
  openAppById(appId);
}

async function buildFluxoTools() {
  let names = [];
  // `list_fluxo_tool_workflows` et NON `list_fluxo_workflows` : seuls les
  // workflows laissés « exposés au function calling » dans le designer entrent
  // dans le catalogue d'outils du modèle. L'autre commande liste tout — elle
  // sert aux listes de l'interface, pas à ce prompt.
  try { names = await invoke("list_fluxo_tool_workflows"); } catch {}
  fluxoToolMap = {};
  const tools = names.map((name) => {
    const fn = sanitizeToolName(name);
    fluxoToolMap[fn] = name;
    return { type: "function", function: { name: fn,
      description: `Exécute le workflow d'automatisation Fluxo « ${name} ». L'argument "input" lui est transmis comme entrée.`,
      parameters: { type: "object", properties: { input: { type: "string", description: "Texte d'entrée du workflow" } }, required: [] } } };
  });
  tools.push(
    ...memoryToolDefs(),
    { type: "function", function: { name: "domotique_list_devices",
      description: "Liste les objets domotiques enregistrés dans Lumen, avec leur nom, id, type, pièce et IP. N'invente jamais d'objet absent de cette liste.",
      parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "domotique_get_state",
      description: "Lit l'état réel d'un objet domotique par nom ou id.",
      parameters: { type: "object", properties: { device: { type: "string", description: "Nom ou id de l'objet, par exemple Lampe salon" } }, required: ["device"] } } },
    { type: "function", function: { name: "domotique_command",
      description: "Envoie une commande locale sécurisée à un objet domotique. Utilise set pour régler on/brightness/couleur/angle, toggle pour inverser, ou une action supportée par le firmware. Si l'objet a plusieurs composants (champ components de domotique_list_devices), précise la clé via component.",
      parameters: { type: "object", properties: {
        device: { type: "string", description: "Nom ou id de l'objet" },
        component: { type: "string", description: "Clé du composant sur un objet multi-composants (ex. relais_26). Omettre si l'objet n'a qu'un composant." },
        action: { type: "string", description: "Action, par exemple set ou toggle" },
        params: { type: "object", description: "Paramètres JSON, par exemple {\"on\":true,\"brightness\":80}" },
      }, required: ["device"] } } },
  );
  // App Intents : les actions que les apps installées PROMEUVENT à l'assistant
  // (manifeste `intents`). Connues du modèle même app fermée : Lumen l'ouvre
  // et lui remet l'intention (cf. lib/appkit/host.js).
  const intents = intentToolDefinitions(installedApps());
  intentToolMap = intents.map;
  tools.push(...intents.tools);
  // Recherche web : uniquement si l'utilisateur l'a activée (cf. web-tools.js).
  tools.push(...buildWebTools());
  tools.push(...buildLiveTools());
  // Fichiers des sandboxes + données personnelles, avec accord de l'utilisateur.
  // Le bureau n'avait ni bases de données ni Corpus : ils viennent d'ici.
  tools.push(...buildDataTools(dtLang(), { tables: true, corpus: true }));
  // Données des applications (Kanban, Agenda, Contacts, Études…), lecture seule.
  tools.push(...buildAppDataTools(dtLang()));
  // Écriture dans les apps (Kanban, Agenda, Notes), toujours après confirmation.
  tools.push(...buildAppWriteTools(dtLang()));
  // Rédaction de documents (sandboxes / Corpus / bases) et un outil par agent.
  tools.push(...buildDocTools(dtLang()));
  tools.push(...buildMailTools());
  tools.push(...(await buildAgentTools(invoke, dtLang())));
  // Discussions du projet courant, lisibles sur demande.
  tools.push(...buildProjectTools());
  // Actions sur Lumen lui-même : ouvrir une app, des Réglages, changer le thème.
  tools.push(...buildSystemTools(dtLang()));
  // Les workflows Fluxo agissent : pilier « Actions » (lib/hybrid.js).
  registerActionTools(Object.keys(fluxoToolMap));
  // Même règle de publication que la barre (Réglages › Boîte à outils).
  return filterPublishedTools(tools);
}

// Ouvre une app d'après son nom libre (« notes », « le kanban »…). Renvoie
// le nom affiché, ou false si rien ne correspond.
function openAppByName(name) {
  const n = normSearch(name).replace(/^(l'|la |le |les |app |application )+/, "").trim();
  if (!n) return false;
  const all = [...dtApps(), ...installedApps().map((a) => ({ ...a, action: () => openAppForIntent(a.id) }))];
  const score = (a) => {
    const names = [a.name, tt(a.name || ""), a.id].filter(Boolean).map(normSearch);
    if (names.some((x) => x === n)) return 3;
    if (names.some((x) => x.startsWith(n) || n.startsWith(x))) return 2;
    if (names.some((x) => x.includes(n))) return 1;
    return 0;
  };
  const best = all.map((a) => [score(a), a]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0]?.[1];
  if (!best) return false;
  if (best.action) best.action(); else openAppById(best.id);
  return tt(best.name || best.id);
}
const SYSTEM_HOST = { openApp: openAppByName, openSettings: (section) => openSettingsAt(section) };


function buildDocumentationTools() {
  return [{
    type: "function",
    function: {
      name: "search_lumen_docs",
      description: "Recherche dans la documentation intégrée de Lumen par catégories/pages.",
      parameters: { type: "object", properties: {
        query: { type: "string", description: "Question ou mots-clés" },
        category: { type: "string", description: "Page optionnelle : workspace, fluxo, agents, sandbox, tables, research…" },
      }, required: ["query"] },
    },
  }];
}

async function callDomotiqueTool(name, args = {}) {
  if (name === "domotique_list_devices") {
    return await invoke("domotique_devices_summary");
  }
  if (name === "domotique_get_state") {
    return await invoke("domotique_device_state", { reference: String(args.device || "") });
  }
  if (name === "domotique_command") {
    return await invoke("domotique_device_cmd", {
      reference: String(args.device || ""),
      component: args.component ? String(args.component) : null,
      action: String(args.action || "set"),
      params: args.params && typeof args.params === "object" ? args.params : {},
    });
  }
  throw new Error(`Outil inconnu : ${name}`);
}

async function callMemoryTool(name, args = {}) {
  return runMemoryTool(invoke, name, args);
}
// Ouvre une source d'une réponse de l'IA : fichier de sandbox, note, app, lien.
// Aussi appelé par la barre (évènement `lumen-open`).
async function openFromAssistant(open) {
  if (!open) return;
  if (open.kind === "url") { invoke("open_external", { url: open.url }).catch(() => {}); return; }
  if (open.kind === "file") {
    const list = await invoke("sandbox_list").catch(() => []);
    const sb = (list || []).find((s) => s.name === open.sandbox || s.id === open.sandbox);
    if (sb) openSearchFile({ id: sb.id, sandbox: sb.name, path: open.path });
    return;
  }
  if (open.kind === "note") { openSearchHit({ kind: "state", source: "notes", title: open.title, id: "" }); return; }
  if (open.kind === "app" && open.app) { if (!openAppByName(open.app)) openAppById(open.app); }
  if (open.kind === "settings") openSettingsAt(open.section || "general", open.focus || "");
}

// Demandes à l'utilisateur, posées dans la bulle de la réponse en cours (cf.
// lib/user-gate.js) : une porte par bulle.
const dtGates = new WeakMap();
function dtGateFor(hostEl) {
  const host = hostEl || openWindows.get("assistant")?.body?.querySelector(".dt-chat-log") || document.body;
  let gate = dtGates.get(host);
  if (!gate) {
    gate = createUserGate({
      invoke, lang: dtLang(), host: () => host,
      announce: (text) => {
        announceStep(text);
        invoke("notify_island", { payload: { kind: "info", title: "Lumen", body: text, icon: "", source: "lumen-desktop" } }).catch(() => {});
      },
      push: remotePush,
    });
    dtGates.set(host, gate);
  }
  return gate;
}
const dtHostFor = (runId) => activeRuns[runId]?.el?.parentElement || null;

// Exécute un outil du catalogue du bureau. Partagé par la boucle d'outils et
// le mode « Réponse orchestrée ». Ne jette jamais : l'erreur devient texte.
// Cache des lectures (par conversation) + journal des accès, cf. lib/tool-cache.js.
function executeDesktopTool(fnName, args, runId, onProgress, ctx) {
  if (ctx?.signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (ctx?.verify) return executeDesktopToolRaw(fnName, args, runId, onProgress);
  return runTool({ name: fnName, args, conversation: String(currentConvId || ""), surface: "bureau", opId: ctx?.opId },
    () => executeDesktopToolRaw(fnName, args, runId, onProgress));
}

async function executeDesktopToolRaw(fnName, args, runId, onProgress) {
  const realName = fluxoToolMap[fnName] || fnName;
  const input = (args && (args.input ?? args.text ?? args.texte)) || "";
  let result;
  try {
    const gate = dtGateFor(dtHostFor(runId));
    if (fnName === "domotique_command") {
      const ok = await gate.confirm({
        title: `${dtLang() === "en" ? "Run" : "Exécuter"} : ${args?.action || "set"} « ${args?.device || "?"} »${args?.params ? ` ${JSON.stringify(args.params)}` : ""}`,
        spoken: `${args?.action || "commande"} ${args?.device || ""}`,
      });
      if (!ok) return "L'utilisateur a refusé cette action. Ne la relance pas ; dis qu'elle n'a pas été faite.";
    }
    if (SYSTEM_TOOL_NAMES.has(fnName)) {
      result = await callSystemTool(fnName, args || {}, { host: SYSTEM_HOST, lang: dtLang() });
    }
    else if (APP_DATA_TOOL_NAMES.has(fnName)) {
      result = await callAppDataTool(invoke, fnName, args || {}, { lang: dtLang() });
    }
    else if (APP_WRITE_TOOL_NAMES.has(fnName)) {
      result = await callAppWriteTool(invoke, fnName, args || {}, { gate, lang: dtLang() });
    }
    else if (DATA_TOOL_NAMES.has(fnName) || DATA_TOOL_NAMES_EXTRA.has(fnName)) {
      const lastUser = [...convo].reverse().find((m) => m.role === "user");
      result = await callDataTool(invoke, fnName, args || {}, {
        gate, lang: dtLang(), query: lastUser?.display || lastUser?.content || "",
        onOcr: () => announceStep(dtLang() === "en" ? "It's a scanned document, I'm reading it with vision." : "C'est un document scanné, je le lis avec la vision."),
      });
    }
    else if (fnName === "search_lumen_docs") result = await searchDesktopDocs(String(args?.query || ""), String(args?.category || ""));
    else if (WEB_TOOL_NAMES.has(fnName)) result = await callWebTool(invoke, fnName, args || {});
    else if (LIVE_TOOL_NAMES.has(fnName)) {
      result = await callLiveTool(invoke, fnName, args || {});
      // L'image générée s'affiche dans le fil (entrée « image » du
      // journal de progression), pas seulement dans la capsule.
      if (fnName === "generate_image") {
        const img = takeGeneratedImage();
        if (img?.data_url) onProgress?.({ kind: "image", data: { path: img.data_url, label: img.label } });
      }
    }
    else if (DOMOTIQUE_TOOL_NAMES.has(fnName)) result = await callDomotiqueTool(fnName, args || {});
    else if (MEMORY_TOOL_NAMES.has(fnName)) result = await callMemoryTool(fnName, args || {});
    else if (PROJECT_TOOL_NAMES.has(fnName)) result = await callProjectTool(fnName, args || {});
    else if (MAIL_TOOL_NAMES.has(fnName)) result = await callMailTool(invoke, fnName, args || {}, { lang: dtLang() });
    else if (DOC_TOOL_NAMES.has(fnName) || isAgentTool(fnName)) {
      // Cartes vivantes (étapes animées) : dans un conteneur à côté du
      // journal de progression, que renderProgressEntries réécrit.
      const host = activeRuns[runId]?.el;
      let cards = host?.parentElement?.querySelector(":scope > .dt-live-cards");
      if (host && !cards) {
        cards = document.createElement("div");
        cards.className = "dt-live-cards";
        host.after(cards);
      }
      const o = {
        bubble: cards || null, lang: dtLang(),
        // Emplacement d'enregistrement : demandé à l'utilisateur (carte + voix + téléphone).
        chooseSandbox: ({ suggestedId }) => gate.chooseSandbox({ suggestedId, what: dtLang() === "en" ? "the document" : "le document" }),
        // Déverrouillage, puis accord sur les sandboxes à lire comme sources.
        authorizeSandboxes: async (why) => {
          if (!(await gate.ensureUnlocked())) return [];
          const all = await invoke("sandbox_list").catch(() => []);
          return all?.length ? gate.authorizeSandboxes(all, why) : [];
        },
      };
      result = DOC_TOOL_NAMES.has(fnName)
        ? await callDocTool(invoke, fnName, args || {}, o)
        : await callAgentTool(invoke, fnName, args || {}, o);
    }
    else if (intentToolMap[fnName]) {
      const { appId, intent } = intentToolMap[fnName];
      const out = await runAppIntent(appId, intent, args || {}, openAppForIntent);
      result = typeof out === "string" ? out : JSON.stringify(out ?? "OK");
    }
    else result = await invoke("run_fluxo_workflow", { name: realName, input: String(input), runId, extraVars: wfExtraVars() });
  }
  catch (e) { result = "Erreur : " + (e?.message || e); }
  return String(result);
}

// Boucle agentique : l'IA voit les workflows comme outils, les appelle, puis
// produit une réponse finale. Met à jour `convo` (assistant tool_calls + tool).
async function runTools(runId, onProgress, opts = {}) {
  const numCtx = parseInt(localStorage.getItem("ollamaNumCtx") || "0", 10);
  const think = localStorage.getItem("ollamaThink") === "true";
  const b = llmBackend(); // Ollama natif OU API cloud (OpenAI-compatible).
  // Outils de rédaction (doc_*) seulement si la demande produit un document.
  const lastAsk = [...convo].reverse().find((m) => m.role === "user");
  const tools = opts.tools || (opts.docsOnly ? buildDocumentationTools()
    : withoutDocToolsUnlessWriting(await buildFluxoTools(), lastAsk?.display || lastAsk?.content || ""));
  if (!tools.length) throw new Error("Aucun workflow Fluxo disponible comme outil.");
  const docsSystem = {
    role: "system",
    content: "Tu es l'assistant de documentation de Lumen. Réponds uniquement à partir de la documentation fournie par search_lumen_docs. Appelle cet outil avant de répondre.",
  };
  let finalText = "";
  // Outils mentionnés avec « @ » : au PREMIER tour seulement, consigne + forçage
  // de l'appel ; les tours suivants doivent pouvoir répondre en texte.
  const forced = opts.forced ? forcedToolTurn(tools, dtLang()) : null;
  // `opts.view` (createStreamView) : raisonnement replié et texte au fil de
  // l'eau ; les appels d'outils terminés passent par onProgress (blocs repliables).
  const view = opts.view || null;
  let reasoning = "";
  for (let turn = 0; turn < 6; turn++) {
    let resp;
    let data;
    if (turn > 0) view?.nextTurn();
    const lastUser = [...convo].reverse().find((m) => m.role === "user");
    const recalled = await withMemoryRecall(invoke, convo, lastUser?.content || "", { context: "bar", limit: opts.docsOnly ? 3 : 5 });
    const force = forced && turn === 0;
    const modelMessages = [
      ...(opts.docsOnly ? [docsSystem] : []),
      ...recalled,
      ...(force ? [forced.system] : []),
    ];
    if (view) {
      // Tous les backends, EN FLUX : llmChat choisit la cible (llama.cpp,
      // LiteRT, cloud, Ollama) et relaie les jetons à la vue.
      const result = await llmChat(modelMessages, {
        backend: b, tools,
        ...(force ? { tool_choice: b.llama ? "required" : forced.toolChoice } : {}),
        ...(!b.api && think ? { think: true } : {}),
        onUpdate: (st) => view.update(st),
      });
      data = b.api && !b.llama ? withOpenAiTimings(result.data) : result.data;
    } else if (b.llama) {
      // llama-server expose le même format de tool calling que l'API OpenAI,
      // mais il doit passer par llmChat (et non par le proxy cloud).
      const result = await llmChat(modelMessages, { backend: b, tools, ...(force ? { tool_choice: "required" } : {}) });
      data = result.data;
    } else if (b.api) {
      // Proxy backend sécurisé : la clé API ne transite pas par la WebView.
      data = withOpenAiTimings(await invoke("llm_api_request", {
        path: "chat/completions",
        body: { model: b.model, messages: modelMessages, tools, ...(force ? { tool_choice: forced.toolChoice } : {}) },
        backend: rustBackend(aiSourceNow()),
      }));
    } else {
      data = await ollamaPostJson("api/chat", { model: b.model, messages: modelMessages, tools, ...(think ? { think: true } : {}), ...(numCtx > 0 ? { options: { num_ctx: numCtx } } : {}), stream: false }, b.base);
    }
    recordOllamaUsage(data, "workspace-tools");
    const msg = data?.choices?.[0]?.message || data?.message || {};
    if (msg.reasoning_content || msg.thinking) reasoning = msg.reasoning_content || msg.thinking;
    if (msg.tool_calls && msg.tool_calls.length) {
      convo.push({ role: "assistant", content: stripThink(msg.content || ""), tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const fnName = call.function && call.function.name;
        const realName = fluxoToolMap[fnName] || fnName;
        let args = call.function && call.function.arguments;
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        const input = (args && (args.input ?? args.text ?? args.texte)) || "";
        const result = await executeDesktopTool(fnName, args, runId, onProgress);
        const toolReply = { role: "tool", content: String(result), name: fnName };
        if ((b.api || b.llama) && call.id) toolReply.tool_call_id = call.id;
        convo.push(toolReply);
        onProgress?.({
          kind: "tool",
          name: realName,
          input: String(input),
          args: args || {},
          result: String(result).slice(0, 4000),
          message: `${realName}${input ? ` (${String(input)})` : ""} → ${String(result).slice(0, 140)}`,
        });
      }
      continue; // reboucle pour exploiter les résultats
    }
    finalText = stripThink(msg.content || "");
    break;
  }
  view?.finish();
  if (opts.onReasoning && reasoning) opts.onReasoning(reasoning);
  return finalText;
}

function bubble(role, html) {
  const el = document.createElement("div");
  el.className = "dt-msg " + role;
  el.innerHTML = `<div class="dt-msg-body">${html}</div>`;
  addPickButton(el);
  addBranchButton(el);
  return el;
}

/// « Brancher ici » : nouvelle discussion qui s'arrête à cette bulle. La bulle
/// connaît son message par `_msg` (posé au rendu ou après l'envoi) ; sans lui —
/// bulle éphémère, réponse en cours — le bouton ne fait rien de bruyant.
function addBranchButton(bubbleEl) {
  const btn = document.createElement("button");
  btn.className = "dt-pick-btn dt-branch-btn";
  btn.title = tt("Créer une branche à partir de ce message");
  btn.innerHTML = lumenIcon("git-branch");
  btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const idx = bubbleEl._msg ? convo.indexOf(bubbleEl._msg) : -1;
    if (idx < 0) { dtToast(tt("Ce message n'est pas encore enregistré.")); return; }
    branchConversation({ atIndex: idx });
  });
  dtMsgTools(bubbleEl).appendChild(btn);
}

// ===== Sélection de messages → export PDF =====
//
// Même geste que dans la barre : un « + » discret au pied de chaque bulle, les
// messages cochés s'accumulent, et une barre en bas de la fenêtre les exporte
// d'un coup via `chat_export_pdf` (le chemin de l'outil export_pdf de l'IA).

const dtPicked = new Set();

function dtMsgTools(bubbleEl) {
  let row = bubbleEl.querySelector(":scope > .dt-msg-tools");
  if (!row) {
    row = document.createElement("div");
    row.className = "dt-msg-tools";
    bubbleEl.appendChild(row);
  }
  return row;
}

function addPickButton(bubbleEl) {
  if (!bubbleEl || bubbleEl.querySelector(":scope > .dt-msg-tools > .dt-pick-btn")) return;
  const btn = document.createElement("button");
  btn.className = "dt-pick-btn";
  btn.title = tt("Ajouter ce message à l'export PDF");
  btn.innerHTML = ICON.plus;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const picked = dtPicked.has(bubbleEl);
    if (picked) dtPicked.delete(bubbleEl); else dtPicked.add(bubbleEl);
    bubbleEl.classList.toggle("dt-msg-picked", !picked);
    btn.classList.toggle("picked", !picked);
    btn.title = picked ? tt("Ajouter ce message à l'export PDF") : tt("Retirer de l'export PDF");
    updateDtExportBar();
  });
  dtMsgTools(bubbleEl).prepend(btn);
}

/// Texte d'un message pour le PDF : sans les outils, les statistiques ni le
/// panneau de sources, qui n'ont rien à faire dans un document.
function dtPickedText(bubbleEl) {
  const clone = bubbleEl.cloneNode(true);
  clone.querySelectorAll(".dt-msg-tools, .dt-msg-stats, .run-progress, .dt-sources").forEach((el) => el.remove());
  return (clone.innerText || "").trim();
}

function dtPickedInOrder(log) {
  if (!log) return [...dtPicked];
  // Ordre d'affichage, pas ordre de clic : c'est celui de la lecture.
  return [...log.querySelectorAll(".dt-msg")].filter((b) => dtPicked.has(b));
}

/** Nom proposé : le titre du document, daté — deux exports d'affilée ne se
 *  confondent pas, et le fichier se retrouve à la date où on l'a produit. */
function defaultDtExportName() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${tt("Extrait de discussion")} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

function updateDtExportBar() {
  for (const b of [...dtPicked]) if (!b.isConnected) dtPicked.delete(b);
  const bar = openWindows.get("assistant")?.body?.querySelector(".dt-export-bar");
  if (!bar) return;
  const n = dtPicked.size;
  const wasHidden = bar.hidden;
  bar.hidden = n === 0;
  if (!n) return;
  bar.querySelector(".dt-export-count").textContent = `${n} ${n > 1 ? tt("messages") : tt("message")}`;
  // Proposition rafraîchie à chaque réapparition de la barre, jamais par-dessus
  // un nom que l'utilisateur a tapé.
  const nameField = bar.querySelector(".dt-export-name");
  if (nameField && wasHidden && !nameField.dataset.edited) nameField.value = defaultDtExportName();
}

function clearDtSelection() {
  for (const b of dtPicked) {
    b.classList.remove("dt-msg-picked");
    b.querySelector(":scope > .dt-msg-tools > .dt-pick-btn")?.classList.remove("picked");
  }
  dtPicked.clear();
  updateDtExportBar();
}

async function exportPickedDtMessages() {
  const win = openWindows.get("assistant");
  const log = win?.body?.querySelector(".dt-chat-log");
  const bubbles = dtPickedInOrder(log);
  if (!bubbles.length) return;
  const bar = win?.body?.querySelector(".dt-export-bar");
  const btn = bar?.querySelector(".dt-export-go");
  // Le nom saisi sert de titre au document ET de nom de fichier : c'est ce que
  // l'on attend en tapant un nom, et le backend en dérive le fichier.
  const title = (bar?.querySelector(".dt-export-name")?.value || "").trim() || defaultDtExportName();
  const body = bubbles.map((b) => {
    const who = b.classList.contains("user") ? tt("Vous") : tt("Assistant");
    return `### ${who}\n\n${dtPickedText(b)}`;
  }).join("\n\n---\n\n");
  const content = `# ${title}\n\n*${new Date().toLocaleString()}*\n\n${body}\n`;
  if (btn) { btn.disabled = true; btn.textContent = tt("Export…"); }
  try {
    // En mode bureau, le PDF va dans la sandbox ouverte : tout le travail y vit
    // déjà, et les Téléchargements sont hors de l'espace confiné. Sans sandbox
    // (cas improbable ici), on retombe sur l'export système de la barre.
    const sandboxId = getCurrent()?.id
      || (await invoke("sandbox_list").catch(() => []))?.[0]?.id
      || "";
    const info = sandboxId
      ? await invoke("sandbox_write_pdf", { id: sandboxId, title, content })
      : await invoke("chat_export_pdf", { title, content });
    if (sandboxId) requestSandboxRefresh();
    if (bar) {
      const done = bar.querySelector(".dt-export-done");
      done.hidden = false;
      done.textContent = info.name;
      // Dans la sandbox : on ouvre les Fichiers plutôt que l'app système, le
      // chemin renvoyé étant relatif à l'espace confiné.
      done.onclick = sandboxId
        ? () => openAppById("sandbox")
        : () => invoke("open_exported_file", { path: info.path }).catch((e) => console.error("[pdf]", e));
    }
    if (sandboxId) dtToast(tt("PDF enregistré dans la sandbox : {name}", { name: info.name }), false);
    const nameField = bar?.querySelector(".dt-export-name");
    if (nameField) delete nameField.dataset.edited;
    clearDtSelection();
  } catch (e) {
    console.error("[pdf] export sélection :", e);
    dtToast(`${tt("Export PDF impossible :")} ${e?.message || e}`);
    if (btn) btn.textContent = tt("Échec");
  } finally {
    if (btn) {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = tt("Exporter en PDF"); }, 1200);
    }
  }
}

function mountDtExportBar(win) {
  // Posée sur le corps de la fenêtre, pas dans `.dt-assist-main` : ce dernier
  // défile, la barre y remonterait avec le contenu.
  const host = win?.body;
  if (!host || host.querySelector(".dt-export-bar")) return;
  const bar = document.createElement("div");
  bar.className = "dt-export-bar";
  bar.hidden = true;
  bar.innerHTML = `<span class="dt-export-count"></span>`
    + `<input class="dt-export-name" type="text" spellcheck="false"`
    + ` placeholder="${escapeHtml(tt("Nom du fichier PDF"))}" title="${escapeHtml(tt("Nom du fichier"))}" />`
    + `<button class="dt-export-go">${escapeHtml(tt("Exporter en PDF"))}</button>`
    + `<button class="dt-export-clear" title="${escapeHtml(tt("Vider la sélection"))}">✕</button>`
    + `<a class="dt-export-done" hidden></a>`;
  // Nom proposé, modifiable : le champ se sélectionne au clic (on remplace d'un
  // geste) et Entrée lance l'export.
  const nameField = bar.querySelector(".dt-export-name");
  nameField.value = defaultDtExportName();
  nameField.addEventListener("focus", () => nameField.select());
  nameField.addEventListener("input", () => { nameField.dataset.edited = "1"; });
  nameField.addEventListener("keydown", (e) => { if (e.key === "Enter") exportPickedDtMessages(); });
  bar.querySelector(".dt-export-go").addEventListener("click", exportPickedDtMessages);
  bar.querySelector(".dt-export-clear").addEventListener("click", clearDtSelection);
  host.appendChild(bar);
}

// Statistiques de génération + bouton « relancer la lecture vocale ».
function addStats(bubbleEl, stats, prompt, text, withReplay) {
  const line = document.createElement("div");
  line.className = "dt-msg-stats";
  let txt;
  if (stats && stats.eval_count) {
    recordOllamaUsage(stats, "workspace-chat");
    const ev = stats.eval_count;
    const dur = (stats.eval_duration || 0) / 1e9;
    const tps = dur > 0 ? ev / dur : 0;
    lastTps = tps;  // mémorisé pour le widget « Modèle »
    refreshModelWidgets();
    txt = `${ev} tokens · ${tps.toFixed(1)} tok/s` + (stats.prompt_eval_count ? ` · ${stats.prompt_eval_count} de contexte` : "");
  } else {
    const est = Math.round(((prompt || "").length + (text || "").length) / 4);
    txt = `~${est} tokens (estimation)`;
  }
  line.innerHTML = `<span>${txt}</span>`;
  if (withReplay && text) {
    const btn = document.createElement("button");
    btn.className = "dt-replay"; btn.title = "Lire à voix haute"; btn.innerHTML = ICON.speak;
    btn.addEventListener("click", () => speak(text));
    line.appendChild(btn);
  }
  bubbleEl.appendChild(line);
}

// ===== Lecture vocale (même routage que speakText de Lumen) =====
let _speaking = false;
// Passe par le module partagé : son repli est "" (« on ne sait pas ») et non
// "default", qui affirmerait macOS. Voir lib/platform-flavor.js.
const getFlavor = resolvePlatformFlavor;

// L'Atelier des agents (src/village) est mis en sommeil : ses fichiers restent
// dans le dépôt (l'app Agents leur emprunte sprites et assets), mais il n'a plus
// d'entrée — ni onglet de hub, ni route héritée, ni carte de boîte à outils.
function stripForSpeech(t) {
  return markdownToSpeech(t);
}

function stripRTF(rtfStr) {
  if (!rtfStr || typeof rtfStr !== "string") return "";
  if (!rtfStr.trim().startsWith("{\\rtf")) return rtfStr;

  const ignoreDest = new Set([
    "fonttbl", "colortbl", "expandedcolortbl", "stylesheet", "info", "listtable",
    "listoverridetable", "generator", "pgdsctbl", "themedata", "colorschememapping",
    "latentstyles", "datastore", "pntext", "pntxta", "pntxtb", "pnseclvl", "field",
    "xmlnstbl", "header", "footer", "bkmkstart", "bkmkend", "shppict", "nonshppict", "pict",
  ]);

  const rtf = rtfStr;
  const n = rtf.length;
  let i = 0;
  let out = "";
  const stack = [{ ignore: false, uc: 1 }];
  const top = () => stack[stack.length - 1];
  const win1252 = (hex) => {
    try { return new TextDecoder("windows-1252").decode(new Uint8Array([parseInt(hex, 16)])); }
    catch { return ""; }
  };
  const skipTokens = (count) => {
    let skipped = 0;
    while (skipped < count && i < n) {
      const c = rtf[i];
      if (c === "{" || c === "}") break;
      if (c === "\\") {
        if (rtf[i + 1] === "'") i += 4;
        else if (/[a-zA-Z]/.test(rtf[i + 1])) {
          i += 2;
          while (i < n && /[a-zA-Z0-9-]/.test(rtf[i])) i++;
          if (rtf[i] === " ") i++;
        } else i += 2;
      } else i++;
      skipped++;
    }
  };

  while (i < n) {
    const c = rtf[i];
    if (c === "{") {
      stack.push({ ignore: top().ignore, uc: top().uc });
      i++;
    } else if (c === "}") {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === "\\") {
      const nx = rtf[i + 1];
      if (nx === "\\" || nx === "{" || nx === "}") {
        if (!top().ignore) out += nx;
        i += 2;
      } else if (nx === "*") {
        top().ignore = true;
        i += 2;
      } else if (nx === "'") {
        const ch = win1252(rtf.substr(i + 2, 2));
        i += 4;
        if (!top().ignore) out += ch;
      } else if (nx && /[a-zA-Z]/.test(nx)) {
        let j = i + 1;
        while (j < n && /[a-zA-Z]/.test(rtf[j])) j++;
        const word = rtf.slice(i + 1, j);
        let param = "";
        if (j < n && (rtf[j] === "-" || /[0-9]/.test(rtf[j]))) {
          let k = j + (rtf[j] === "-" ? 1 : 0);
          while (k < n && /[0-9]/.test(rtf[k])) k++;
          param = rtf.slice(j, k);
          j = k;
        }
        if (rtf[j] === " ") j++;
        i = j;
        if (ignoreDest.has(word)) top().ignore = true;
        else if (!top().ignore) {
          if (word === "par" || word === "line" || word === "sect") out += "\n";
          else if (word === "tab") out += "\t";
          else if (word === "uc") top().uc = parseInt(param || "1", 10);
          else if (word === "u") {
            let code = parseInt(param, 10);
            if (code < 0) code += 65536;
            out += String.fromCharCode(code);
            skipTokens(top().uc);
          }
        }
      } else {
        if (!top().ignore && nx === "~") out += " ";
        i += 2;
      }
    } else {
      if (!top().ignore) out += c;
      i++;
    }
  }

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function runAppleShortcutChat(prompt) {
  const shortcutName = localStorage.getItem("shortcutName") || "Apple Intelligence";
  const system = convo
    .filter((m) => m.role === "system" && m.content)
    .map((m) => m.content)
    .join("\n\n");
  const turns = convo
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-10)
    .map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"}: ${m.content || ""}`)
    .join("\n\n");
  const sys = [system, (localStorage.getItem("systemPrompt") || "").trim()].filter(Boolean).join("\n\n");
  const fullPrompt = [sys, turns].filter(Boolean).join("\n\n");
  return stripRTF(await invoke("call_macos_shortcut", { shortcutName, prompt: fullPrompt || prompt }));
}
// Annonces vocales des étapes d'une réponse orchestrée : une annonce en attente
// est remplacée par la suivante, et la réponse finale passe après la dernière.
let dtAnnounceChain = Promise.resolve();
let dtAnnouncePending = null;
const dtSpeechIdle = () => new Promise((r) => { const tick = () => (_speaking ? setTimeout(tick, 120) : r()); tick(); });
function announceStep(text) {
  if (!text) return;
  remotePush({ type: "announce", text });
  if (!autospeak) return;
  dtAnnouncePending = text;
  dtAnnounceChain = dtAnnounceChain.then(async () => {
    if (dtAnnouncePending !== text) return;
    dtAnnouncePending = null;
    await dtSpeechIdle();
    await speak(text);
  }).catch(() => {});
}
async function speakAfterAnnouncements(text) {
  dtAnnouncePending = null;
  await dtAnnounceChain;
  await dtSpeechIdle();
  return speak(text);
}

async function speak(text) {
  const t = stripForSpeech(text); if (!t || _speaking) return;
  _speaking = true;
  try { window.LumenOrb?.setState("speaking"); } catch {}
  try {
    const flavor = await getFlavor();
    const aiSource = aiSourceNow() || "shortcut";
    const speechBackend = localStorage.getItem("speechBackend") || "auto";
    const localVoiceReady = await Promise.all([
      invoke("tts_runtime_available").catch(() => false),
      invoke("tts_active_voice").catch(() => ""),
    ]).then(([runtime, voice]) => Boolean(runtime && voice));
    const wantsLocalVoice = speechBackend === "piper" || speechBackend === "auto";
    if (localVoiceReady && (flavor === "rpi" || flavor === "linux-standard" || wantsLocalVoice)) {
      // `tts_speak` rend la main au lancement (travail dans un thread Rust). On
      // anime l'orbe du bureau : « réflexion » pendant la synthèse, « parle »
      // quand l'audio démarre (tts-playing), puis on attend la fin (tts-ended).
      const evt = window.__TAURI__?.event;
      try { window.LumenOrb?.setState("thinking"); } catch {}
      let unEnded = null, unPlaying = null, resolveEnded;
      const ended = new Promise((r) => { resolveEnded = r; });
      if (evt?.listen) {
        unPlaying = await evt.listen("tts-playing", () => { try { window.LumenOrb?.setState("speaking"); } catch {} });
        unEnded = await evt.listen("tts-ended", () => resolveEnded());
      } else resolveEnded();
      try {
        await invoke("tts_speak", { text: t, voice: null });
        await Promise.race([ended, new Promise((r) => setTimeout(r, 180000))]);
      } finally { if (unPlaying) unPlaying(); if (unEnded) unEnded(); }
    }
    else {
      if (speechBackend === "piper") throw new Error("Piper/Kokoro est sélectionné mais aucune voix locale installée n'est disponible.");
      const useSystem = speechBackend === "system" || (speechBackend === "auto" && aiSource !== "shortcut");
      if (useSystem) { const lang = dtLang(); await invoke("system_speak", { text: t, lang, voice: dtSystemVoice(lang) }); }
      else await invoke("call_macos_shortcut", { shortcutName: localStorage.getItem("speakShortcut") || "Speak Text", prompt: t });
    }
  } catch {}
  _speaking = false;
  try { window.LumenOrb?.setState("idle"); } catch {}
}

// Rendu markdown (réutilise le moteur de l'explorateur, comme l'aperçu de fichier).
// Un `<think>` resté dans le texte ne s'affiche jamais en clair.
function formatMessage(md) { return renderMarkdown(stripThink(md || "")); }

// Raisonnement replié au-dessus d'une réponse (rechargement, repli non-stream).
function appendDtReasoning(answerEl, reasoning) {
  if (!reasoning || !answerEl?.parentNode) return;
  const wrap = document.createElement("div");
  wrap.className = "lm-blocks";
  const tb = thinkBlock();
  tb.set(reasoning);
  wrap.appendChild(tb.el);
  answerEl.parentNode.insertBefore(wrap, answerEl);
}

// Génération EN FLUX, tous backends (llama.cpp, LiteRT, Ollama local ou
// distant, cloud, Lumen Server, Apple FM) : la commande Rust `llm_stream`
// relaie les jetons. `h.onUpdate(state)` reçoit l'état cumulé (texte,
// raisonnement, outils) ; `createStreamView` s'occupe de l'affichage.
async function streamChat(messages, h = {}) {
  const backend = llmBackend();
  const think = localStorage.getItem("ollamaThink") === "true";
  const { content, data } = await llmChat(messages, {
    backend,
    ...(!backend.api && think ? { think: true } : {}),
    onUpdate: (st) => h.onUpdate?.(st),
  });
  const msg = data?.choices?.[0]?.message || data?.message || {};
  const inline = String(msg.content || "").match(/<think>([\s\S]*?)(<\/think>|$)/i)?.[1] || "";
  return { text: content || "", stats: data || null, reasoning: msg.reasoning_content || msg.thinking || inline.trim() };
}

// ===== Progression de run + widgets Fluxo (mêmes rendus que la barre Lumen) =====
const RUN_ORIGIN = "http://127.0.0.1:8765";
const activeRuns = {};
function genRunId() { return (crypto?.randomUUID?.()) || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function onRunProgress(ev) {
  if (!ev || !ev.run_id) return;
  const run = activeRuns[ev.run_id]; if (!run) return;
  run.entries.push(ev);
  renderProgressEntries(run.el, run.entries);
}
const _esc = escapeHtml;
function renderProgressEntries(container, entries) {
  container.innerHTML = (entries || []).map((ev) => {
    const kind = (ev.kind || "progress").toString();
    const cls = kind.replace(/[^a-z0-9_-]/gi, "");
    if (kind === "tool") {
      const name = ev.toolName || ev.name || "Outil";
      const input = ev.toolInput ?? ev.input ?? "";
      const result = ev.toolResult ?? ev.result ?? "";
      // Bloc repliable partagé (lib/stream-view.js) : nom en en-tête, arguments
      // et résultat au clic — même rendu que dans la barre et le compagnon.
      const el = toolBlock({ name: String(name), args: ev.args ?? input, result: String(result ?? "") }).el;
      el.classList.add("tool-call-note");
      el.dataset.kind = "tool";
      el.dataset.name = String(name);
      el.dataset.input = String(input);
      el.dataset.result = String(result);
      return el.outerHTML;
    }
    if (kind === "image" && ev.data && ev.data.path) {
      const path = String(ev.data.path);
      const full = /^(https?:|data:|blob:)/.test(path) ? path : (RUN_ORIGIN + path);
      return `<div class="run-step run-step-image" data-kind="image"><img class="run-image" src="${_esc(full)}" alt="" loading="lazy"></div>`;
    }
    if (kind === "widget" && ev.data) return `<div class="run-step run-step-widget" data-kind="widget">${renderWidget(ev.data)}</div>`;
    return `<div class="run-step run-step-${_esc(cls)}" data-kind="${_esc(cls)}"><span class="run-step-dot"></span><span class="run-step-msg">${formatMessage(ev.message || "")}</span></div>`;
  }).join("");
}
// Rendu d'un widget (complication) — porté de la barre Lumen.
function widgetTrend(trend) {
  const t = String(trend || "").toLowerCase();
  if (t === "up" || t === "hausse") return '<span class="wdg-trend up">▲</span>';
  if (t === "down" || t === "baisse") return '<span class="wdg-trend down">▼</span>';
  if (t === "flat" || t === "stable") return '<span class="wdg-trend flat">▬</span>';
  return "";
}
function widgetHeader(w) {
  const title = w.title ? _esc(String(w.title)) : "";
  if (!title) return "";
  return `<div class="wdg-head"><span class="wdg-title">${title}</span></div>`;
}
function renderWidget(w) {
  if (!w || typeof w !== "object") return "";
  const tpl = String(w.template || "metric").toLowerCase();
  const accent = /^#[0-9a-f]{3,8}$/i.test(w.accent || "") ? w.accent : "#5b8def";
  const head = widgetHeader(w);
  let body = "";
  if (tpl === "weather") {
    const hourly = Array.isArray(w.hourly) ? w.hourly.slice(0, 6).map((h) => `<div class="wdg-hour"><span>${_esc(String(h.time ?? ""))}</span><strong>${_esc(String(h.temp ?? ""))}°</strong></div>`).join("") : "";
    body = `<div class="wdg-weather"><div class="wdg-temp">${_esc(String(w.temp ?? "—"))}<span class="wdg-unit">°${_esc(String(w.unit || ""))}</span></div><div class="wdg-wcol"><div class="wdg-cond">${_esc(String(w.condition || ""))}</div><div class="wdg-loc">${_esc(String(w.location || ""))}</div></div></div>${hourly ? `<div class="wdg-hourly">${hourly}</div>` : ""}`;
  } else if (tpl === "stat-grid") {
    body = `<div class="wdg-grid">${(Array.isArray(w.items) ? w.items : []).map((it) => `<div class="wdg-cell"><div class="wdg-cell-label">${_esc(String(it.label ?? ""))}</div><div class="wdg-cell-value">${_esc(String(it.value ?? ""))}</div></div>`).join("")}</div>`;
  } else if (tpl === "list" || tpl === "news") {
    body = `<div class="wdg-list">${(Array.isArray(w.items) ? w.items : []).map((it) => `<div class="wdg-listrow"><div class="wdg-listmain"><div class="wdg-listtitle">${_esc(String(it.title ?? it.label ?? ""))}</div>${it.subtitle ? `<div class="wdg-listsub">${_esc(String(it.subtitle))}</div>` : ""}</div>${it.trailing != null ? `<div class="wdg-listtrail">${_esc(String(it.trailing))}</div>` : ""}</div>`).join("")}</div>`;
  } else if (tpl === "gauge") {
    const val = Math.max(0, Math.min(100, Number(w.value) || 0));
    const rr = 26, c = 2 * Math.PI * rr, off = c * (1 - val / 100);
    body = `<div class="wdg-gauge"><svg viewBox="0 0 64 64" class="wdg-ring"><circle cx="32" cy="32" r="${rr}" class="wdg-ring-bg"/><circle cx="32" cy="32" r="${rr}" class="wdg-ring-fg" style="stroke:${accent};stroke-dasharray:${c.toFixed(1)};stroke-dashoffset:${off.toFixed(1)}"/><text x="32" y="36" class="wdg-ring-txt">${val}%</text></svg><div class="wdg-gcol"><div class="wdg-glabel">${_esc(String(w.label || ""))}</div></div></div>`;
  } else if (tpl === "report") {
    const st = String(w.status || "").toLowerCase();
    const dot = st === "error" ? "err" : st === "running" ? "run" : "ok";
    const lines = (Array.isArray(w.lines) ? w.lines : []).map((l) => `<div class="wdg-reprow"><span>${_esc(String(l.label ?? ""))}</span><strong>${_esc(String(l.value ?? ""))}</strong></div>`).join("");
    body = `<div class="wdg-report"><span class="wdg-status wdg-status-${dot}"></span>${lines}</div>`;
  } else if (tpl === "sport" || tpl === "score" || tpl === "match") {
    const hs = w.home_score, as = w.away_score, hasScore = hs != null && as != null;
    const team = (name, score, win) => `<div class="wdg-team${win ? " win" : ""}"><div class="wdg-teamname">${_esc(String(name ?? ""))}</div><div class="wdg-teamscore">${hasScore ? _esc(String(score)) : "–"}</div></div>`;
    body = `<div class="wdg-sport">${w.competition || w.league ? `<div class="wdg-sport-league">${_esc(String(w.competition || w.league))}</div>` : ""}${team(w.home, hs, hasScore && +hs > +as)}${team(w.away, as, hasScore && +as > +hs)}${w.status ? `<div class="wdg-sport-status">${_esc(String(w.status))}</div>` : ""}</div>`;
  } else {
    body = `<div class="wdg-metric"><div class="wdg-mvalue">${_esc(String(w.value ?? "—"))}<span class="wdg-unit">${_esc(String(w.unit || ""))}</span></div><div class="wdg-mside">${widgetTrend(w.trend)}${w.delta != null ? `<span class="wdg-delta">${_esc(String(w.delta))}</span>` : ""}</div></div>${w.label ? `<div class="wdg-mlabel">${_esc(String(w.label))}</div>` : ""}`;
  }
  return `<div class="lumen-widget" style="--wdg-accent:${accent}">${head}<div class="wdg-body">${body}</div></div>`;
}

// ===== Plein écran (masque la barre de menu Raspberry Pi OS) =====
async function toggleFullscreen() {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win) return;
  try {
    await win.setFullscreen(!(await win.isFullscreen()));
  } catch {}
}
// Raccourcis façon macOS / Linux. Le module ne connaît rien du bureau : on lui
// passe les actions, il s'occupe du clavier, de l'overlay du sélecteur et du
// branchement dans les iframes des apps.
let osShortcuts = null;   // handle du module (ouverture du panneau d'aide)
let voiceControl = null;  // commande vocale (sandbox/voice-control.js)
function syncVoiceButtons() {
  const on = voiceControlEnabled();
  document.querySelectorAll(".dt-voice-btn").forEach((b) => { b.hidden = !on; });
}
function installDesktopShortcuts() {
  osShortcuts = installOsShortcuts({
    isDesktopActive,
    listWindows: () => winMru
      .map((id) => {
        const r = openWindows.get(id);
        return r && { id, title: r.title, icon: r.icon, grad: r.grad, minimized: r.minimized };
      })
      .filter(Boolean),
    focus: focusWindow,
    close: closeWindow,
    minimize: minimizeWindow,
    toggleShowDesktop,
    openStartMenu: () => {
      // Le bureau classique a un menu Démarrer ancré sur son bouton ; le mode
      // dock a un lanceur plein écran. Le raccourci ouvre celui qui existe.
      const start = document.querySelector(".dt-tb-start");
      if (start) toggleStartMenu(start);
      else openLauncher();
    },
    openSearch,
    toggleFullscreen,
  });

  // Commande vocale du bureau (opt-in, Réglages › Dictée) : « ouvre Notes »,
  // « cherche facture 2026 », « mode sombre »… — cf. sandbox/voice-control.js.
  voiceControl = installVoiceControl({
    isDesktopActive,
    lang: dtLang,
    apps: () => dtApps().map((a) => ({ id: a.id, name: tt(a.name), aliases: [a.name, a.id], desc: tt(a.desc || "") })),
    files: () => searchFileIndex(),
    workflows: async () => { try { return await invoke("list_fluxo_workflows"); } catch { return []; } },
    intents: () => installedApps().flatMap((a) => (a.intents || []).map((it) => ({ name: `${a.id}:${it.id}`, title: it.title, appId: a.id, intent: it }))),
    actions: {
      openApp: (id) => openAppById(id),
      openFile: (f) => openSearchFile(f),
      search: (q) => openSearch(q),
      runWorkflow: async (name) => {
        const out = await runWorkflow(name, "", `voice-${Date.now().toString(36)}`);
        if (out) dtToast(String(out).slice(0, 240), false);
      },
      ask: (text) => askAssistant(text),
      newConversation: () => newConversation(),
      closeWindow: () => { const id = winMru[0]; if (id) closeWindow(id); },
      minimizeWindow: () => { const id = winMru[0]; if (id) minimizeWindow(id); },
      showDesktop: () => toggleShowDesktop(),
      fullscreen: () => toggleFullscreen(),
      setTheme: (theme) => applyTheme(theme),
      help: () => osShortcuts?.openHelp(),
      notifications: () => openNotificationsWindow(),
      settings: () => openSettings(),
      lock: () => lockDesktopSession(),
      runIntent: (name) => {
        const [appId, intentId] = String(name).split(":");
        const app = installedApps().find((a) => a.id === appId);
        const intent = (app?.intents || []).find((it) => it.id === intentId);
        return intent ? runAppIntent(appId, intent, {}, openAppForIntent) : openAppById(appId);
      },
    },
    speak: (text) => speak(text),
    toast: (msg) => dtToast(msg),
    log: (text, result) => console.debug("[voice]", text, "→", result.kind, result.arg || ""),
  });
  // Le réglage est modifié depuis la fenêtre Réglages : l'événement `storage`
  // (inter-fenêtres) fait apparaître ou disparaître les boutons micro.
  window.addEventListener("storage", (e) => { if (e.key === "voiceControl") syncVoiceButtons(); });
  // Commande venue du compagnon mobile (relayée par la fenêtre principale).
  window.__TAURI__?.event?.listen?.("lumen-voice-command", (e) => {
    if (voiceControlEnabled() && e?.payload?.text) voiceControl?.run(e.payload.text);
  });
}

// ===== Barre des tâches =====
async function closeWorkspaceWindow() {
  broadcastDesktop(false);
  // « Quitter » reverrouille la session : la prochaine ouverture du workspace
  // repasse par l'écran de connexion (choix du profil + mot de passe).
  sessionStorage.removeItem("dtSessionOpen");
  await invoke("session_lock").catch(() => {});
  try {
    await invoke("close_current_window");
    return;
  } catch {}
  try {
    const w = window.__TAURI__?.window?.getCurrentWindow?.();
    await w?.close?.();
  } catch {
    exitDesktop();
  }
}

async function lockDesktopSession() {
  if (dtBootInProgress) return;
  sessionStorage.removeItem("dtSessionOpen");
  await invoke("session_lock").catch(() => {});
  document.querySelectorAll(".dt-panel, .dt-menu, .dt-start, .dt-find, .dt-launcher").forEach((el) => el.remove());
  showBootAndLogin((mode) => {
    dtBootInProgress = false;
    requestSandboxRefresh();
    activateWorkspaceMode(mode);
  }, true);
}

function buildTaskbar() {
  const bar = document.createElement("div");
  bar.className = "dt-taskbar";
  // Bouton « Démarrer » (launcher des applications Lumen).
  // Barre CONDENSÉE : les fonctions de base sont des icônes seules (le libellé
  // reste dans l'info-bulle) ; seules les fenêtres ouvertes gardent leur nom.
  const start = tbBtn("Démarrer", (e) => toggleStartMenu(e.currentTarget), ICON.grid, { iconOnly: true });
  start.classList.add("dt-tb-start");
  const searchBtn = tbBtn(IS_MAC ? "Recherche (⌘K)" : "Recherche (Ctrl+K)", () => openSearch(), lumenIcon("search"), { iconOnly: true });
  searchBtn.classList.add("dt-tb-search");
  start.classList.add("primary", "dt-start-btn");
  const addW = tbBtn("Widget", (e) => widgetMenu(e.currentTarget), ICON.newchat, { iconOnly: true });
  // Le Catalogue prend la place du fond d'écran. Depuis la 0.2, Lumen n'embarque
  // plus que son noyau : installer une application est un geste courant, changer
  // de papier peint ne l'est pas — celui-ci a rejoint Paramètres → Apparence,
  // où vivent déjà les autres réglages d'habillage.
  const market = tbBtn("Catalogue", () => openAppById("market"), lumenIcon("download"), { iconOnly: true });
  market.title = tt("Catalogue : installer des applications, modèles et voix");
  // « Comprendre cet écran » : le geste le plus utile du bureau était enfoui
  // dans le clic droit et la palette. Il a sa place dans la barre.
  const understand = tbBtn("Comprendre", (e) => openUnderstandMenu(e.currentTarget), ICON.eye, { iconOnly: true });
  understand.title = tt("Comprendre cet écran ou une zone");
  // Bouton de bascule de la barre de chat.
  chatToggleBtn = tbBtn("Chat", () => { chatManualHidden = !chatManualHidden; updateChatVisibility(); }, ICON.m_chat, { iconOnly: true });
  chatToggleBtn.classList.add("active");
  const sep1 = sep();
  taskbarWins = document.createElement("div"); taskbarWins.className = "dt-tb-wins";
  const sep2 = sep();
  const sysStatus = makeSystemStatus("dt-tb-sys");
  const clock = makeClock("dt-tb-clock");
  const settings = tbBtn("Réglages", () => openSettings(), ICON.settings, { iconOnly: true });
  const dockToggle = tbBtn("Mode dock", () => setDockMode(true), ICON.dock, { iconOnly: true });
  dockToggle.title = tt("Passer en mode dock");
  const fs = tbBtn("Plein écran", () => toggleFullscreen(), ICON.fullscreen, { iconOnly: true });
  fs.title = tt("Plein écran (F11)");
  // Commande vocale : n'apparaît que si le réglage est activé (cf. syncVoiceButtons).
  const voice = tbBtn("Commande vocale", () => voiceControl?.trigger(), ICON.mic, { iconOnly: true });
  voice.title = tt("Commande vocale (maintenir ⌥Espace)");
  voice.classList.add("dt-voice-btn");
  voice.hidden = !voiceControlEnabled();
  const logout = tbBtn("Déconnexion", () => lockDesktopSession(), ICON.logout, { iconOnly: true });
  const exit = tbBtn("Quitter", () => closeWorkspaceWindow(), ICON.power, { iconOnly: true });
  bar.append(start, searchBtn, addW, market, understand, voice, chatToggleBtn, sep1, taskbarWins, sep2, sysStatus, clock, settings, dockToggle, logout, fs, exit);
  document.body.appendChild(bar);
  taskbarEl = bar;
}

// ===== Hubs : les apps qui traitaient d'un même sujet réunies en une seule ====
// Chaque hub porte une identité propre (nom, dégradé, promesse) et regroupe des
// apps qui partagent un objet : un même corpus, une même tâche, un même flux.
// Les apps sous-jacentes restent des pages autonomes — un hub ne les réécrit
// pas, il leur donne un toit commun et une navigation d'un seul geste.
// Les hubs natifs (Équipage, Fluxo) ont été défaits comme les hubs packagés :
// chaque onglet est une app à part entière (une fenêtre chacune, plusieurs
// ouvertes côte à côte). `openHub()` reste comme compatibilité — les anciens
// appelants (raccourcis, firmwares, Calc → Analyse) passent par HUB_ALIASES.
const HUBS = [];
const HUB_ALIASES = {
  crew: { _default: "agents", team: "agents", feed: "inbox", traces: "llmlog", profiler: "profiler" },
  fluxo: { _default: "designer", designer: "designer", runs: "automations" },
  muse: { _default: "notes", notes: "notes", map: "mindmap", board: "moodboard", canvas: "canvas" },
  tempo: { _default: "kanban", board: "kanban", agenda: "calendar" },
  prisme: { _default: "tables", tables: "tables", analysis: "dataanalysis", models: "ml" },
  corpus: { _default: "knowledge", library: "knowledge", inquiry: "research" },
  echo: { _default: "podcast", podcast: "podcast", voices: "voicelab" },
  arcade: { _default: "games", games: "games", adventure: "adventure", pet: "aipet" },
  forge: { _default: "editor", code: "editor", studio: "editor" },
};

// Espaces du menu : un socle compact (Essentiel) et des espaces par activité.
// Les éditeurs restent des apps distinctes ; l'espace ne fait que les réunir.
const DT_CATS = [
  { id: "all", label: "Tout", desc: "Toutes les apps", icon: ICON.grid },
  { id: "center", label: "Essentiel", desc: "Assistant, agents, Fluxo, fichiers, mémoire, réglages", icon: ICON.m_chat },
  { id: "create", label: "Création", desc: "Capturer, organiser, composer, produire", icon: ICONAPP_appstudio },
  { id: "organize", label: "Organisation", desc: "Temps, avancement, automatismes, synthèse du matin", icon: ICONAPP_kanban },
  { id: "data", label: "Données", desc: "Sources, bases, analyse, ETL et rapports", icon: ICON.chart },
  { id: "search", label: "Recherche", desc: "Corpus, Enquête, web et cartes", icon: lumenIcon("search") },
  { id: "people", label: "Personnes", desc: "Contacts, annuaire d'équipe et clients", icon: lumenIcon("users") },
  { id: "comm", label: "Communication", desc: "Courrier, messagerie d'équipe et réunions", icon: lumenIcon("messages-square") },
  { id: "audio", label: "Audio", desc: "Voix, podcasts et musique", icon: lumenIcon("audio-lines") },
  { id: "lab", label: "Spécialisés", desc: "Packs : code, Python, ML, robotique, maison", icon: ICONAPP_editor },
  { id: "play", label: "Loisirs", desc: "Pack facultatif : jeux, compagnon, village", icon: ICONAPP_games },
  { id: "system", label: "Aide", desc: "Visite, raccourcis, stockage, documentation", icon: ICON.settings },
];
// Espace des paquets installés avant la réorganisation (manifeste ancien).


// ===== Start menu : launcher des applications, organisé comme un OS IA =====
const DT_APPS = [
  { id: "assistant", cat: "center", name: "Assistant IA", desc: "Conversation, voix et actions locales", grad: ["#6a5cff", "#c75cff"], icon: ICON.m_chat, action: () => openAssistantWindow() },
  { id: "sandbox", cat: "center", name: "Fichiers", desc: "Espaces isolés et mini-apps", grad: ["#f59f35", "#e84d6a"], icon: ICONAPP_folder, action: () => toggleAppWindow() },
  { id: "agents", cat: "center", name: "Équipe", desc: "Créer et régler vos agents", grad: ["#16b8a6", "#0a84ff"], icon: ICONAPP_agents, action: () => openAppFrame("agents", "Équipe", "/agents/manager.html", 1240, 800) },
  // Messages : parler à Lumen et à ses agents comme dans une messagerie
  // (mêmes fils que le compagnon web et l'app iOS — lib/messenger-ui.js).
  { id: "messages", cat: "center", name: "Messages", desc: "Discuter avec Lumen et vos agents, comme dans une messagerie", grad: ["#7c6cf0", "#ff5fa2"], icon: lumenIcon("messages-square"), action: () => openAppFrame("messages", "Messages", "/messenger/messenger.html", 980, 720) },
  { id: "inbox", cat: "center", name: "Fil", desc: "Messages des agents & tâches", grad: ["#0a84ff", "#16b8a6"], icon: ICONAPP_inbox, action: () => openAppFrame("inbox", "Fil", "/inbox/inbox.html", 1100, 760) },
  // Diagnostic : traces des modèles, réponses orchestrées et Profiler réunis
  // (anciennes entrées « Traces » et « Profiler », cf. DT_DIAG_ALIASES).
  { id: "diagnostic", cat: "center", name: "Diagnostic", desc: "Traces des modèles, réponses orchestrées et Profiler", grad: ["#5e5ce6", "#16b8a6"], icon: ICONAPP_llmlog, action: (view = "traces") => openAppFrame("diagnostic", "Diagnostic", `/diagnostic/diagnostic.html#${view}`, 1240, 800) },
  { id: "designer", cat: "center", name: "Fluxo Designer", desc: "Composer un workflow bloc à bloc", grad: ["#0a84ff", "#5e5ce6"], icon: ICONAPP_designer, action: () => openAppFrame("designer", "Fluxo Designer", "/fluxo/designer.html", 1320, 840) },
  { id: "automations", cat: "center", name: "Automatisations", desc: "Vos workflows et leurs exécutions", grad: ["#5e5ce6", "#0a84ff"], icon: ICONAPP_automations, action: () => openAppFrame("automations", "Automatisations", "/automations/automations.html", 1200, 800) },
  { id: "documents", cat: "create", name: "Documents", desc: "Pages, styles, tableaux et modèles ; export PDF, HTML et Markdown", grad: ["#5ac8fa", "#0a84ff"], icon: ICONAPP_pages, action: () => openCreativeApp("document") },
  { id: "presentations", cat: "create", name: "Présentations", desc: "Diapositives 16:9, notes de l'intervenant, mode présentation", grad: ["#ff9f0a", "#ff375f"], icon: ICONAPP_keynote, action: () => openCreativeApp("presentation") },
  // Navigateur complet (onglets natifs, comptes, téléchargements, extensions) :
  // fenêtre à part pilotée par src-tauri/src/browser.rs. Dans le noyau : c'est
  // lui qui ouvre ENT, Moodle, Teams ou Google Docs, que l'app « Navigateur »
  // (lecture + IA, en iframe) ne peut pas afficher.
  { id: "web", cat: "search", name: "Navigateur web", desc: "Onglets, comptes, téléchargements, extensions ; tous les sites s'ouvrent", grad: ["#0a84ff", "#16b8a6"], icon: lumenIcon("globe"), action: () => invoke("browser_open", {}).catch((e) => dtToast(String(e?.message || e))) },
  // Projets de l'espace Création : un projet réunit notes, cartes, planches,
  // canevas et documents ; chacun reste dans son éditeur (lib/creative-kit.js).
  { id: "projects", cat: "create", name: "Projets", desc: "Réunir notes, cartes, planches, canevas et documents d'un même travail", grad: ["#d8a31f", "#5ac8fa"], icon: lumenIcon("folder"), action: () => openAppFrame("projects", "Projets", "/projects/projects.html", 1080, 720) },
  { id: "calc", cat: "data", name: "Calc", desc: "Tableur : formules, graphiques, et lien direct avec les tables et l'analyse de Prisme", grad: ["#30d158", "#0a84ff"], icon: ICONAPP_tables, action: () => openSheetsApp() },
  { id: "vault", cat: "data", name: "Coffre personnel", desc: "Collections, fiches et données structurées pour vous et votre IA", grad: ["var(--primary)", "var(--primary)"], icon: lumenIcon("database"), action: () => openAppFrame("vault", "Coffre personnel", "/vault/vault.html", 1320, 860) },
  { id: "memory", cat: "center", name: "Mémoire", desc: "Souvenirs, rappel et accès de Lumen", grad: ["#bf5af2", "#0a84ff"], icon: ICONAPP_memory, action: () => openAppFrame("memory", "Mémoire", "/memory/memory.html", 1120, 740) },
  { id: "tour", cat: "system", name: "Visite guidée", desc: "(Re)découvrir le bureau pas à pas", grad: ["#0a84ff", "#5e5ce6"], icon: lumenIcon("circle-help"), action: () => startDesktopTour() },
  { id: "keys", cat: "system", name: "Raccourcis clavier", desc: "Sélecteur de fenêtres, réduction, recherche — la liste complète", grad: ["#5e5ce6", "#0a84ff"], icon: lumenIcon("command"), action: () => osShortcuts?.openHelp() },
  { id: "market", cat: "center", name: "Catalogue", desc: "Installer des modèles llama.cpp, des voix, des workflows Fluxo et des avatars 3D", grad: ["#ff9f0a", "#ff375f"], icon: lumenIcon("download"), action: () => openAppFrame("market", "Catalogue", "/market/market.html", 1120, 800) },
  { id: "storage", cat: "system", name: "Stockage", desc: "Ce que Lumen occupe sur le disque, sa répartition, et la sauvegarde à la carte", grad: ["#64d2ff", "#0a84ff"], icon: lumenIcon("disk"), action: () => openAppFrame("storage", "Stockage", "/storage/storage.html", 1000, 740) },
  { id: "settings", cat: "center", name: "Paramètres", desc: "Réglages complets de Lumen", grad: ["#8e8e93", "#3a3a3c"], icon: ICON.settings, action: () => openSettings() },
  { id: "docs", cat: "system", name: "Documentation", desc: "Guide & aide", grad: ["#37a87a", "#3a9baa"], icon: ICONAPP_docs, action: () => openAppFrame("docs", "Documentation", "/docs/docs.html", 900, 640) },
];

// ===== Édition Pro : ce que le build inclut ================================
// Les apps marquées `pro: true` n'existent que dans un binaire compilé avec la
// feature Cargo `pro`. Tant que la réponse du Rust n'est pas connue, on répond
// « non » : mieux vaut peindre le menu sans elles et le rafraîchir ensuite que
// d'offrir une app dont la page n'existera pas.
// Espaces partagés de DB Studio : des applications ENGENDRÉES, pas déclarées.
// Une table publiée à ce profil devient une entrée du menu comme une autre —
// c'est tout l'intérêt du partage : la personne ouvre son écran, pas l'atelier
// de modélisation. La liste vient du Rust, qui ne renvoie que les espaces
// auxquels le profil actif a droit ; le bureau n'a donc rien à filtrer.
let DT_SHARED = [];
async function loadSharedSpaces() {
  try {
    const list = await invoke("dbshare_list");
    DT_SHARED = (list || []).map((s) => ({
      id: `space-${s.id}`,
      cat: "data",
      shared: true,
      name: s.name,
      desc: s.description || `${s.tableName || "Table"} — ${s.access === "write" ? "saisie et consultation" : "consultation"}`,
      grad: Array.isArray(s.grad) && s.grad.length >= 2 ? s.grad : ["#16b8a6", "#5e5ce6"],
      icon: lumenIcon("table"),
      action: () => openAppFrame(`space-${s.id}`, s.name,
        `/dbstudio/space.html?share=${encodeURIComponent(s.id)}`, 1120, 780),
    }));
  } catch { DT_SHARED = []; }
}

// Le menu démarrer est la somme de trois choses : le NOYAU (DT_APPS, écrit en
// dur parce que Lumen ne s'ouvre pas sans lui), les applications INSTALLÉES
// depuis le Catalogue, et les espaces partagés engendrés par DB Studio.
//
// Les apps Pro — natives comme installées — ne paraissent que si la licence est
// valide. Une app Pro installée reste sur le disque sans licence : elle
// redevient visible dès que la clé est posée, sans rien retélécharger.
function dtApps() {
  const shell = { createWindow, focusWindow, openWindows, applyFrameTheme, framePermissions: APP_FRAME_PERMISSIONS };
  // Plus de licence d'application : toutes les apps installées paraissent.
  // Un paquet installé avant la réorganisation en espaces porte encore son
  // ancienne catégorie (« explore », « pro ») : on le range dans son espace.
  const packaged = installedApps()
    .map((a) => toMenuEntry(a, shell, (name) => lumenIcon(name)))
    .map((a) => ({ ...a, cat: appSpace(a) }));
  return [
    ...DT_APPS,
    ...packaged,
    ...DT_SHARED,
  ];
}
function dtCats() { return DT_CATS; }

// Anciens identifiants d'apps, désormais des onglets de hub. Les appelants
// externes (orbe ESP32, firmwares, apps intégrées) continuent de fonctionner :
// on les route vers le hub et l'onglet correspondants.
// Anciens identifiants d'onglets, désormais des onglets de paquets installés.
// Un firmware ESP32 ou un raccourci qui demande « notes » doit continuer de
// marcher : on ouvre le paquet qui héberge l'onglet, et le hub s'ouvrira dessus.
// Anciens onglets de hubs : ce sont désormais des paquets à part entière qui
// portent LE MÊME identifiant. Il ne reste à traduire que les identifiants des
// hubs eux-mêmes (« ouvre Muse » → Notes), cf. HUB_ALIASES.
const DT_PACKAGED_TABS = {};
const DT_DIAG_ALIASES = { llmlog: "traces", traces: "traces", profiler: "profiler", orchestrator: "orchestrator" };
const DT_LEGACY = {};

// Ouvre une app du bureau par son identifiant, actuel ou historique.
function openAppById(id) {
  // « Traces » et « Profiler » vivent désormais dans Diagnostic.
  if (DT_DIAG_ALIASES[id]) { DT_APPS.find((a) => a.id === "diagnostic").action(DT_DIAG_ALIASES[id]); return true; }
  const app = dtApps().find((candidate) => candidate.id === id);
  if (app) { app.action(); return true; }
  // Anciens identifiants de l'app CRM, avant qu'elle ne s'appelle Relia.
  if (id === "facturation" || id === "crm") { openAppById("relia"); return true; }
  // Reporting a fusionné dans Analyse de données (08/10/2026).
  if (id === "reporting") return openAppById("dataanalysis");
  // « opus » : l'ancienne app unique — on ouvre le dernier format utilisé.
  if (id === "opus") { openCreativeApp(); return true; }
  if (id === "sheets" || id === "tableur") { openSheetsApp(); return true; }
  // Ancien hub (« muse », « crew »…) : on ouvre son app par défaut.
  if (HUB_ALIASES[id]) return openAppById(HUB_ALIASES[id]._default);
  // L'app est peut-être un paquet — installé, ou pas encore.
  const packaged = installedApps().find((a) => a.id === id);
  if (packaged) {
    openInstalledApp(packaged, { createWindow, focusWindow, openWindows, applyFrameTheme, framePermissions: APP_FRAME_PERMISSIONS });
    return true;
  }
  const host = DT_PACKAGED_TABS[id];
  if (host) return openAppById(host);
  // Demander une app désinstallée doit mener au Catalogue, pas au silence :
  // sans cela, un raccourci resté sur le bureau ne fait plus rien du tout.
  if (KNOWN_PACKAGE_IDS.has(id) || DT_PACKAGED_TABS[id]) {
    openAppFrame("market", "Catalogue", `/market/market.html?app=${encodeURIComponent(host || id)}`, 1120, 800);
    return true;
  }
  return false;
}

/**
 * Identifiants que Lumen sait être des paquets, installés ou non. Sert à
 * distinguer « app désinstallée » (→ Catalogue) de « identifiant inconnu »
 * (→ rien, et c'est bien un bug d'appelant).
 */
const KNOWN_PACKAGE_IDS = new Set([
  "notes", "mindmap", "moodboard", "canvas", "nodal", "kanban", "calendar", "tables", "dataanalysis", "ml",
  "knowledge", "research", "podcast", "voicelab", "games", "adventure", "aipet", "editor", "python", "village",
  "imagestudio", "musicstudio", "browser", "budget", "domotique", "robotstudio",
  "relia", "meet", "dbstudio", "etl", "datasources", "directory", "messages",
  // Sortis du noyau le 23/09/2026 : Email, Contacts et Matin sont des paquets.
  // L'écran du matin AUTOMATIQUE reste au bureau (sandbox/morning.js) ; l'app
  // « Matin » n'est que son ouverture à la demande.
  "mail", "contacts", "morning",
  // Poste d'étudiant (23/09/2026).
  "studies", "pdf", "media",
  // Carte assistée par IA (24/09/2026).
  "carte",
]);

// Commande provenant de l'orbe ESP32 : ouvre la même application que le
// launcher du bureau, sans dupliquer les routes ni les dimensions de fenêtre.
window.LumenOpenAppById = (id) => openAppById(id);

// ===== Export de rapport à la demande du backend (bloc Fluxo) =================
// `POST /reporting/export` sur le serveur loopback émet `reporting-export-request`
// : le bureau ouvre l'app Reporting HORS ÉCRAN avec la consigne d'export dans
// l'URL, l'app recalcule, écrit PDF/HTML et répond par `reporting_export_result`
// (via le pont des apps first-party). Un rapport se dessine dans une WebView —
// c'est la seule façon d'en sortir un PDF avec ses graphiques sans Lumen ouvert
// devant soi.
// Lumen XR › Apps : le casque demande une App Intent (via la barre, qui relaie
// le WebSocket du compagnon). Les apps vivent ici, dans le bureau : c'est donc
// lui qui l'exécute — en ouvrant l'app si besoin, comme pour l'assistant.
(function installXrIntentResponder() {
  const evt = window.__TAURI__?.event;
  if (!evt) return;
  evt.listen("xr-intent-request", async (e) => {
    const req = e.payload || {};
    const reply = (r) => evt.emit("xr-intent-result", { reqId: req.reqId, ...r });
    try {
      const app = installedApps().find((a) => a.id === req.appId)
        || (await refreshInstalled().catch(() => []) || []).find((a) => a.id === req.appId);
      const intent = app?.intents?.find((it) => it.id === req.intentId);
      if (!intent) { reply({ error: "unknown-intent" }); return; }
      const out = await runAppIntent(req.appId, intent, req.args || {}, openAppForIntent);
      reply({ text: typeof out === "string" ? out : JSON.stringify(out ?? "OK", null, 2) });
    } catch (err) {
      reply({ error: String(err?.message || err) });
    }
  });
})();

// Blocs Fluxo « App : action » (POST /fluxo/intent) : même exécution que
// l'assistant ; la réponse repart par `reporting_export_result` (file corrélée).
(function installFluxoIntentResponder() {
  const evt = window.__TAURI__?.event;
  if (!evt || window.parent !== window) return; // pas depuis une iframe (Bibliothèque du mode app)
  evt.listen("fluxo-intent-request", async (e) => {
    const req = e.payload || {};
    const reply = (result, error) => invoke("reporting_export_result", { id: req.id, result: result ?? null, error: error ?? null }).catch(() => {});
    try {
      const app = installedApps().find((a) => a.id === req.appId)
        || (await refreshInstalled().catch(() => []) || []).find((a) => a.id === req.appId);
      const intent = app?.intents?.find((it) => it.id === req.intentId);
      if (!intent) { reply(null, `Action inconnue : ${req.appId}.${req.intentId} (app installée ?)`); return; }
      const out = await runAppIntent(req.appId, intent, req.args || {}, openAppForIntent);
      reply({ text: typeof out === "string" ? out : JSON.stringify(out ?? "OK", null, 2) });
    } catch (err) { reply(null, String(err?.message || err)); }
  });
})();

// Rapports d'Analyse de données rendus HORS ÉCRAN : export à la demande du bloc
// Fluxo (`reporting-export-request`, `?export=`) et envois programmés
// (`report-subscription-due`, `?subscription=`, cf. src-tauri/src/report_subs.rs).
// L'app ouverte dans un cadre invisible recalcule, exporte, envoie, puis
// répond par la commande attendue (`doneCmd`) : on démonte alors le cadre.
async function runHeadlessReportApp(query, doneCmd, onMissing, onResult) {
  const manifest = installedApps().find((a) => a.id === "dataanalysis")
    || (await refreshInstalled().catch(() => []) || []).find((a) => a.id === "dataanalysis");
  if (!manifest) { onMissing?.("L'app Analyse de données n'est pas installée sur ce poste."); return; }
  const frame = document.createElement("iframe");
  frame.className = "dt-appframe dt-appframe-headless";
  // Hors écran mais avec une vraie taille : ECharts a besoin d'un conteneur
  // mesurable pour peindre les graphiques qui partent dans le PDF.
  frame.style.cssText = "position:fixed;left:-2000px;top:0;width:1200px;height:900px;opacity:0;pointer-events:none;";
  frame.src = `${appUrl(manifest)}?${query}`;
  document.body.appendChild(frame);
  const host = mountAppHost({ frame, app: manifest, onTitle: () => {}, appNameOf: (id) => id });
  let done = false;
  const finish = () => { if (done) return; done = true; window.removeEventListener("message", watch); try { host.dispose?.(); } catch {} frame.remove(); };
  const watch = (ev) => { if (ev.source === frame.contentWindow && ev.data?.__lumenIpc && ev.data.cmd === doneCmd) { try { onResult?.(ev.data.args || {}); } catch {} setTimeout(finish, 800); } };
  window.addEventListener("message", watch);
  setTimeout(() => { if (!done) { onMissing?.("Délai dépassé : le rapport n'a pas fini son export."); finish(); } }, 175000);
}

/**
 * Visuels d'un rapport capturés par l'app Analyse de données, hors écran — pour
 * Opus (insertion d'un visuel lié, « Actualiser les données »).
 * req = { sandboxId, path, items: [{ pageId, visualId }] } → { report, items } .
 */
function captureReportVisuals(req) {
  return new Promise((resolve, reject) => {
    const token = Math.random().toString(36).slice(2);
    runHeadlessReportApp(`capture=${encodeURIComponent(JSON.stringify({ ...req, token }))}`, "dataviz_capture_result",
      (msg) => reject(new Error(msg)),
      (res) => (res.error ? reject(new Error(res.error)) : resolve(res)));
  });
}

(function installReportExportResponder() {
  const evt = window.__TAURI__?.event;
  const invoke = window.__TAURI__?.core?.invoke;
  if (!evt || !invoke) return;
  evt.listen("reporting-export-request", (e) => {
    const req = e.payload || {};
    if (req.id == null) return;
    const fail = (msg) => invoke("reporting_export_result", { id: req.id, error: msg }).catch(() => {});
    runHeadlessReportApp(`export=${encodeURIComponent(JSON.stringify(req))}`, "reporting_export_result", fail);
  });
  // Un abonnement arrive à échéance : envoi sans rien ouvrir à l'écran.
  evt.listen("report-subscription-due", (e) => {
    const id = e.payload?.id;
    if (!id) return;
    runHeadlessReportApp(`subscription=${encodeURIComponent(id)}`, "report_subs_mark", (msg) => console.warn("[rapports] envoi programmé :", msg));
  });
})();

// Ouverture d'un fichier tabulaire dans Calc depuis une app en iframe
// (Analyse de données, Bases de données) : l'app n'a que le chemin sandbox,
// c'est le shell bureau qui sait ouvrir la fenêtre.
window.LumenOpenSheetFile = (path, sandboxId) => { openSheetsFile(path, sandboxId || getCurrent()?.id || ""); };
// Fichier de la suite cité ou intégré dans un document (pastille, aperçu) :
// Opus, Calc ou l'explorateur selon l'extension.
window.LumenOpenFile = (path, sandboxId) => { if (!path) return false; openSearchFile({ id: sandboxId || getCurrent()?.id || "", path }); return true; };

// ===== Bus d'interop : « Envoyer vers… » ====================================
// Le bureau est le seul à savoir ouvrir les fenêtres : c'est donc lui qui
// héberge le sélecteur et la table des relais. Les apps (iframes même-origine)
// et les mini-apps confinées (via app-runner) appellent ces globales.
// Cf. src/lib/interop.js pour le format d'objet et le registre des cibles.
window.LumenShare = (obj) => shareObject(obj);
// Lanceur exposé aux apps en paquet (`lumen.apps.open`, lib/appkit/host.js).
window.LumenOpenApp = (id) => openAppById(id);
// Le sélecteur « Envoyer vers… » ne doit proposer que des apps réellement
// ouvrables : une app packagée désinstallée avalerait l'objet en silence.
window.LumenCanOpenApp = (id) => {
  if (dtApps().some((a) => a.id === id)) return true;
  if (["documents", "sheets", "opus"].includes(id)) return true;   // fenêtres natives du shell
  if (installedApps().some((a) => a.id === id)) return true;
  return !!DT_PACKAGED_TABS[id] && installedApps().some((a) => a.id === DT_PACKAGED_TABS[id]);
};
window.LumenMakeObject = (kind, payload, source) => makeObject(kind, payload, source);
window.LumenTakeHandoff = (appId) => takeHandoff(appId);
window.LumenReceive = (appId, handler) => receive(appId, handler);
window.LumenShelf = () => readShelf();
window.LumenObjectToText = (obj) => toText(obj);

// Les deux cibles que le bureau héberge lui-même (Opus et Calc ne sont pas des
// iframes mais des fenêtres natives du shell) s'abonnent ici. Les apps en
// iframe, elles, appellent `receive()` chez elles — cf. src/notes/main.js.
receive("documents", (obj) => {
  // Une image n'a pas de représentation Markdown chez Opus (le rendu texte
  // ignorait le `![…]` et le document sortait vide) : elle devient un
  // élément image à part entière, rechargé depuis sa propre sandbox.
  if (obj.kind === "image") {
    openCreativeApp("document", {
      title: obj.title || tt("Image"),
      doc: creativeDocFromImage({ title: obj.title || "", src: obj.path ? "" : (obj.dataUrl || ""), sandboxPath: obj.path || "", sandboxId: obj.sandboxId || "" }),
    });
    return;
  }
  openCreativeApp("document", {
    title: obj.title || "Document",
    html: renderMarkdown(toText(obj)),
  });
});
// Objet envoyé depuis une AUTRE fenêtre (barre principale, Réglages…) : elle
// ne peut pas ouvrir les apps, le bureau s'en charge (cf. lib/interop.js).
//
// L'écouteur est posé dès le chargement du module — donc AVANT le
// déverrouillage de la session. Ouvrir une app à ce moment-là ne marcherait
// pas (le bureau n'est pas monté, la fenêtre serait construite sous l'écran de
// connexion puis balayée) : on garde l'objet et on le livre au montage.
// L'accusé de réception part tout de suite, pour que l'expéditeur cesse de le
// renvoyer.
let interopPending = [];
let interopReady = false;
// id → "queued" (reçu, pas encore livré) | "done" (livré, accusé envoyé).
const interopSeen = new Map();

function ackInterop(id) {
  if (id) emitEvent?.("lumen-interop-ack", { id });
}
function deliverInterop(id, appId, object) {
  handoff(appId, object);
  if (id) interopSeen.set(id, "done");
  ackInterop(id);
}
/** Appelé par mountDesktop : le bureau existe, on peut livrer. */
function flushInteropQueue() {
  interopReady = true;
  const queue = interopPending;
  interopPending = [];
  for (const { id, appId, object } of queue) {
    try { deliverInterop(id, appId, object); } catch (e) { console.warn("[interop] livraison", e); }
  }
  // Signale aux autres fenêtres qu'elles peuvent (re)tenter leurs envois : une
  // fenêtre fermée avant le déverrouillage n'aurait rien livré du tout.
  try { emitEvent?.("lumen-interop-ready", {}); } catch {}
}
window.__TAURI__?.event?.listen?.("lumen-interop-handoff", (e) => {
  const { id, appId, object } = e?.payload || {};
  if (!appId || !object) return;
  // Renvoi de l'expéditeur : déjà livré → on ré-accuse ; encore en attente →
  // on ne fait rien (l'accusé partira à la livraison, pas avant : sinon un
  // bureau fermé avant le mot de passe perdrait l'objet pour tout le monde).
  const state = id ? interopSeen.get(id) : null;
  if (state === "done") { ackInterop(id); return; }
  if (state === "queued") return;
  if (id) interopSeen.set(id, "queued");
  if (interopReady) deliverInterop(id, appId, object);
  else interopPending.push({ id, appId, object });
});
receive("sheets", (obj) => {
  if (obj.kind !== "table") return;
  openSheetsRows(obj.title || "Tableau", obj.columns || [], obj.rows || []);
});
window.addEventListener("lumen-orb-open-app", (event) => {
  window.LumenOpenAppById(event?.detail?.app);
});
window.__TAURI__?.event?.listen?.("lumen-orb-open-app", (event) => {
  window.LumenOpenAppById(event?.payload?.app);
});

const DT_FAVORITES = ["assistant", "agents", "notes", "sandbox"];
// Palette de l'orbe par défaut : les icônes d'app y puisent leur couleur (au lieu
// de leur dégradé propre) pour rester cohérentes avec l'identité de Lumen.
// Pastels en édition standard, or en édition Pro (lib/orb-palette.js). Lue à
// chaque appel : l'édition n'est connue qu'après la réponse du backend, au
// premier lancement.
function orbPalette() {
  try {
    const c = JSON.parse(localStorage.getItem('orbColors'));
    if (Array.isArray(c) && c.length === 5 && c.every(isHexColor)) return c;
  } catch {}
  return defaultOrbColors();
}
function appOrbColor(app, i) {
  const pal = orbPalette();
  return pal[i % pal.length];
}

// Dégradé d'identité d'une app : le sien s'il est défini, sinon deux teintes
// consécutives de la palette de l'orbe pour rester dans l'identité de Lumen.
// Toutes les surfaces d'icônes (launcher, dock, boîte à outils) passent par ici
// afin qu'une app ne change jamais de couleur d'un endroit à l'autre.
function appGradient(app) {
  if (Array.isArray(app?.grad) && app.grad.length >= 2) return [app.grad[0], app.grad[1]];
  const pal = orbPalette();
  const i = Math.max(0, DT_APPS.indexOf(app));
  return [pal[i % pal.length], pal[(i + 1) % pal.length]];
}

// ===== Dock façon macOS (mode dock) =====
// Un dock d'icônes optionnel, activable/désactivable, qui remplace la barre des
// tâches. Icônes des apps épinglées (ajout/retrait), pastille « app active »,
// puis un bloc utilitaires (ex-barre d'état : notifications, thème, réglages,
// plein écran, session) intégré au dock. En mode dock, le chat passe en haut.
const DT_DOCK_DEFAULT = ["assistant", "sandbox", "agents", "notes", "kanban", "designer", "imagestudio", "settings"];
function appById(id) { return dtApps().find((a) => a.id === id); }
function getDockApps() {
  try {
    const a = JSON.parse(wsGet("dtDockApps"));
    // Un dock enregistré avant la fin des hubs contient « muse », « crew »… :
    // on les remplace par l'app par défaut de chaque ancien hub.
    if (Array.isArray(a)) {
      const migrated = [...new Set(a.map((id) => HUB_ALIASES[id]?._default || id))];
      return migrated.filter((id) => dtApps().some((x) => x.id === id));
    }
  } catch {}
  return DT_DOCK_DEFAULT.filter((id) => dtApps().some((x) => x.id === id));
}
function setDockApps(ids) { wsSet("dtDockApps", JSON.stringify(ids)); refreshDock(); }
// Ids des apps « actives » (fenêtre ouverte). Le sandbox (Fichiers) n'est pas dans
// openWindows : il correspond à la fenêtre explorateur (appEl) visible.
function runningAppIds() {
  const s = new Set(openWindows.keys());
  if (appEl && appEl.style.display !== "none") s.add("sandbox");
  return s;
}

function buildDock() {
  const dock = document.createElement("div");
  dock.className = "dt-dock";
  dock.hidden = true;
  dock.innerHTML = `
    <button class="dt-dock-util dt-dock-launch" data-act="launcher" title="${escapeHtml(tt("Toutes les applications"))}">${ICON.grid}</button>
    <div class="dt-dock-sep"></div>
    <div class="dt-dock-apps"></div>
    <div class="dt-dock-sep"></div>
    <button class="dt-dock-util dt-dock-add" data-act="add" title="${escapeHtml(tt("Ajouter une app au dock"))}">${ICON.newchat}</button>
    <div class="dt-dock-sep"></div>
    <div class="dt-dock-status"></div>`;
  document.body.appendChild(dock);
  dockEl = dock;
  dock.querySelector('[data-act="launcher"]').addEventListener("click", (e) => { e.stopPropagation(); openLauncher(); });
  dock.querySelector('[data-act="add"]').addEventListener("click", (e) => { e.stopPropagation(); openDockAddMenu(e.currentTarget); });
  buildDockStatus(dock.querySelector(".dt-dock-status"));
  refreshDock();
}

// Bloc utilitaires du dock : l'ancienne barre d'état, intégrée au dock.
function buildDockStatus(container) {
  const util = (icon, label, onClick, extra = "") => {
    const b = document.createElement("button");
    b.className = "dt-dock-util" + (extra ? " " + extra : "");
    b.title = tt(label); b.setAttribute("aria-label", tt(label));
    b.innerHTML = icon + (extra.includes("dt-dock-notif") ? `<span class="dt-dock-badge" hidden></span>` : "");
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
    return b;
  };
  const clock = makeClock("dt-dock-clock");
  const sysStatus = makeSystemStatus("dt-dock-sys");
  const voice = util(ICON.mic, "Commande vocale (maintenir ⌥Espace)", () => voiceControl?.trigger(), "dt-voice-btn");
  voice.hidden = !voiceControlEnabled();
  container.append(
    util(ICON.bell, "Centre de notifications", () => openNotificationsWindow(), "dt-dock-notif"),
    util(ICON.eye, "Comprendre cet écran ou une zone", (e) => openUnderstandMenu(e.currentTarget)),
    voice,
    util(ICON.theme, "Changer de thème (clair/sombre)", () => toggleTheme()),
    util(ICON.settings, "Réglages", () => openSettings()),
    util(ICON.fullscreen, "Plein écran (F11)", () => toggleFullscreen()),
    sysStatus,
    clock,
    util(ICON.windows, "Revenir à la barre des tâches", () => setDockMode(false), "dt-dock-exit"),
    util(ICON.logout, "Déconnexion", () => lockDesktopSession()),
    util(ICON.power, "Quitter", () => closeWorkspaceWindow()),
  );
}

// Une tuile d'app dans le dock (icône teintée + pastille active).
function dockTile(app) {
  const btn = document.createElement("button");
  btn.className = "dt-dock-app";
  btn.dataset.app = app.id;
  btn.title = tt(app.name); btn.setAttribute("aria-label", tt(app.name));
  // Même dégradé que dans le launcher et la boîte à outils : une app a une seule
  // identité de couleur, quel que soit l'endroit où on la rencontre.
  const grad = appGradient(app);
  btn.style.setProperty("--c1", grad[0]);
  btn.style.setProperty("--c2", grad[1]);
  btn.innerHTML = `<span class="dt-dock-ic">${app.icon}</span><span class="dt-dock-dot"></span>`;
  btn.addEventListener("click", () => { closeMenus(); app.action(); setTimeout(refreshDock, 80); });
  btn.addEventListener("contextmenu", (e) => { e.preventDefault(); dockAppMenu(e, app); });
  return btn;
}

// Reconstruit les tuiles : apps épinglées + apps actives non épinglées, avec la
// pastille « active » à jour. No-op si le dock n'est pas visible.
function refreshDock() {
  if (!dockEl || dockEl.hidden) return;
  const wrap = dockEl.querySelector(".dt-dock-apps");
  const pinned = getDockApps();
  const running = runningAppIds();
  const ids = pinned.slice();
  for (const id of running) if (!ids.includes(id) && appById(id)) ids.push(id);
  wrap.innerHTML = "";
  for (const id of ids) {
    const app = appById(id); if (!app) continue;
    const tile = dockTile(app);
    tile.classList.toggle("running", running.has(id));
    tile.classList.toggle("unpinned", !pinned.includes(id));
    wrap.appendChild(tile);
  }
  updateHeartbeatBadges();
}

// Menu contextuel d'une tuile : ouvrir + épingler/retirer.
function dockAppMenu(e, app) {
  closeMenus();
  const pinned = getDockApps();
  const isPinned = pinned.includes(app.id);
  const m = document.createElement("div"); m.className = "dt-menu dt-dock-menu";
  m.style.left = Math.min(e.clientX, window.innerWidth - 220) + "px";
  m.style.bottom = (window.innerHeight - e.clientY + 6) + "px";
  const row = (label, icon, onClick) => {
    const it = document.createElement("div"); it.className = "dt-menu-item";
    it.innerHTML = `<span class="dt-panel-ic">${icon}</span><span>${escapeHtml(tt(label))}</span>`;
    it.addEventListener("click", () => { onClick(); m.remove(); });
    m.appendChild(it);
  };
  row("Ouvrir", ICON.check, () => app.action());
  if (isPinned) row("Retirer du dock", ICON.trash, () => setDockApps(pinned.filter((id) => id !== app.id)));
  else row("Garder dans le dock", ICON.newchat, () => setDockApps([...pinned, app.id]));
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener("pointerdown", function h(ev) {
    if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", h); }
  }), 0);
}

// Menu « + » : liste les apps non encore épinglées, cliquer pour les ajouter.
function openDockAddMenu(anchor) {
  closeMenus();
  const pinned = getDockApps();
  const m = document.createElement("div"); m.className = "dt-menu dt-dock-add";
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 260) + "px";
  m.style.bottom = (window.innerHeight - r.top + 6) + "px";
  const avail = dtApps().filter((a) => !pinned.includes(a.id));
  if (!avail.length) {
    const empty = document.createElement("div"); empty.className = "dt-menu-item"; empty.style.opacity = ".6";
    empty.textContent = tt("Toutes les apps sont déjà dans le dock.");
    m.appendChild(empty);
  }
  for (const app of avail) {
    const it = document.createElement("div"); it.className = "dt-menu-item";
    it.innerHTML = `<span class="dt-panel-ic">${app.icon}</span><span>${escapeHtml(tt(app.name))}</span>`;
    it.addEventListener("click", () => { setDockApps([...getDockApps(), app.id]); m.remove(); });
    m.appendChild(it);
  }
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener("pointerdown", function h(ev) {
    if (!m.contains(ev.target) && ev.target !== anchor) { m.remove(); document.removeEventListener("pointerdown", h); }
  }), 0);
}

// Active/désactive le mode dock : dock ↔ barre des tâches, chat en haut ↔ en bas.
function setDockMode(on, { persist = true } = {}) {
  dockMode = !!on;
  document.body.classList.toggle("dt-dockmode", dockMode);
  if (dockEl) dockEl.hidden = !dockMode;
  if (taskbarEl) taskbarEl.style.display = dockMode ? "none" : "";
  if (persist) wsSet("dtDockMode", dockMode ? "1" : "0");
  if (dockMode) refreshDock();
  if (!dockMode) document.querySelector(".dt-launcher")?.remove();
  closeMenus();
  updateChatVisibility();
}
function restoreDockMode() { setDockMode(wsGet("dtDockMode") === "1", { persist: false }); }
// Permet à une app intégrée (iframe) d'ouvrir/focaliser une autre app du bureau
// par son id, p. ex. le Village qui ouvre la fiche d'un agent dans l'app Agents.
window.__lumenOpenApp = (id) => { if (id === "village") return; openAppById(id); };
// Ouvre une application Lumen dans une fenêtre intégrée du bureau (iframe
// même-origine : l'app garde l'accès à window.__TAURI__).
// Capacités déléguées aux apps du bureau. Elles restent soumises à
// l'autorisation système (macOS demande l'accès une fois, par application) :
// cette liste ne fait qu'ouvrir la porte que la politique d'iframe ferme par
// défaut.
const APP_FRAME_PERMISSIONS = "camera; microphone; display-capture; autoplay; clipboard-write; fullscreen";

// Nom affiché du système. L'édition Pro le dit — c'est le seul endroit où elle
// se signale d'elle-même, et c'est ce qui permet de savoir, une capture d'écran
// à la main, quel binaire tourne.
const osName = () => "Lumen Desktop";

function openAppFrame(id, title, url, w = 900, h = 600) {
  if (openWindows.get(id)) return focusWindow(id);
  const win = createWindow({ id, title: tt(title), w, h, x: 90 + Math.round(Math.random() * 40), y: 52 + Math.round(Math.random() * 30) });
  win.body.style.padding = "0";
  const frame = document.createElement("iframe");
  frame.className = "dt-appframe";
  // Une app du bureau est une iframe MÊME ORIGINE, mais la caméra, le micro et
  // la capture d'écran restent refusés dans une iframe tant qu'ils ne sont pas
  // délégués explicitement : sans cette ligne, `getUserMedia` échoue dans
  // Réunion et la liste des périphériques revient anonyme (« Périphérique »).
  frame.allow = APP_FRAME_PERMISSIONS;
  frame.addEventListener("load", () => {
    try { applyFrameTheme(frame.contentDocument.documentElement); } catch {}
  });
  frame.src = url;
  win.body.appendChild(frame);
}

// ===== Hubs : plusieurs apps réunies sous une même identité ==================
// Un hub est une fenêtre du bureau dotée d'une barre d'identité et d'onglets.
// Chaque onglet est soit une app Lumen chargée en iframe même-origine (elle
// garde donc window.parent.__TAURI__ et les globales du bureau, exactement
// comme quand elle était lancée seule), soit un panneau natif monté à la
// demande. Un onglet déjà ouvert reste vivant en arrière-plan : revenir dessus
// ne recharge rien et ne perd aucun état.

function hubTabs(hub) { return hub.tabs.filter((t) => !t.when || t.when()); }

// Synchronise le thème d'une app embarquée avec celui du bureau.
//
// Cette fonction TEINTAIT autrefois l'app aux couleurs de son hub, en écrasant
// `--accent` — la variable dont toutes les apps se servent pour leurs boutons
// et leurs sélections. Résultat : Muse virait à l'or, Équipage au turquoise,
// Prisme au bleu, et la couleur d'accent choisie par l'utilisateur n'était
// respectée nulle part. L'identité d'un hub tient à son nom et à son icône, pas
// à un repeint de l'app qu'il héberge : on ne pose donc plus que le thème
// clair/sombre.
function applyHubTheme(frame) {
  let root;
  try { root = frame.contentDocument?.documentElement; } catch { return; }
  if (!root) return;
  applyFrameTheme(root);
}

// Recopie le thème clair/sombre du bureau dans une app embarquée. Les apps
// lisent bien `dtTheme` au chargement, mais le bureau l'enregistre sous une clé
// préfixée par le profil : on impose donc l'attribut directement, ce qui couvre
// aussi les changements de thème pendant que l'app est déjà ouverte.
function applyFrameTheme(root) {
  const theme = wsGet("dtTheme");
  if (theme === "dark" || theme === "light") root.setAttribute("data-dt-theme", theme);
  else root.removeAttribute("data-dt-theme");
}

// Rejoue le thème sur toutes les apps ouvertes (bascule clair/sombre en direct).
function refreshFramesTheme() {
  document.querySelectorAll("iframe.dt-appframe").forEach((frame) => {
    try {
      const root = frame.contentDocument?.documentElement;
      if (root) applyFrameTheme(root);
    } catch {}
  });
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function openHub(hubId, tabId = "") {
  // Compatibilité : un hub n'existe plus, on ouvre l'app qui correspondait à
  // l'onglet demandé (ou celle par défaut du hub).
  const alias = HUB_ALIASES[hubId];
  if (alias) {
    const appId = alias[tabId] || alias._default;
    openAppById(appId);
    return openWindows.get(appId) || null;
  }
  const hub = HUBS.find((h) => h.id === hubId);
  // Depuis la 0.2, la plupart des hubs sont des PAQUETS : Muse, Tempo, Prisme,
  // Corpus, Écho, Arcade et Forge ne vivent plus dans ce fichier. Les appelants
  // (Calc qui envoie une feuille vers l'analyse, un ancien raccourci, un
  // firmware) n'ont pas à le savoir : on les route vers le paquet installé.
  if (!hub) {
    const packaged = installedApps().find((a) => a.id === hubId);
    if (packaged) {
      return openInstalledApp(packaged,
        { createWindow, focusWindow, openWindows, applyFrameTheme, framePermissions: APP_FRAME_PERMISSIONS },
        tabId);
    }
    return null;
  }
  const open = openWindows.get(hub.id);
  if (open) { focusWindow(hub.id); if (tabId) open.hubGo?.(tabId); return open; }

  const tabs = hubTabs(hub);
  if (!tabs.length) return null;
  const win = createWindow({
    id: hub.id, title: tt(hub.name),
    w: hub.w || 1240, h: hub.h || 800,
    x: 70 + Math.round(Math.random() * 40), y: 46 + Math.round(Math.random() * 26),
  });
  if (!win) return null;
  win.body.style.padding = "0";

  const root = document.createElement("div");
  root.className = "dt-hub";
  root.style.setProperty("--hub-a", hub.grad[0]);
  root.style.setProperty("--hub-b", hub.grad[1]);
  root.innerHTML = `
    <div class="dt-hub-bar">
      <div class="dt-hub-id">
        <span class="dt-hub-glyph">${hub.icon}</span>
        <span class="dt-hub-names"><b>${escapeHtml(tt(hub.name))}</b><i>${escapeHtml(tt(hub.tagline))}</i></span>
      </div>
      <div class="dt-hub-tabs" role="tablist">
        <span class="dt-hub-ind" aria-hidden="true"></span>
        ${tabs.map((t, i) => `
          <button class="dt-hub-tab${i === 0 ? " active" : ""}" data-tab="${t.id}" role="tab"
                  aria-selected="${i === 0}" title="${escapeHtml(tt(t.hint || t.name))}">
            <span class="dt-hub-tab-ic">${t.icon}</span><span class="dt-hub-tab-lb">${escapeHtml(tt(t.name))}</span>
          </button>`).join("")}
      </div>
      <span class="dt-hub-spacer"></span>
      <button class="dt-hub-act" data-act="reload" title="${escapeHtml(tt("Recharger cet onglet"))}">${ICON.preload}</button>
    </div>
    <div class="dt-hub-stage"></div>`;
  win.body.appendChild(root);

  const stage = root.querySelector(".dt-hub-stage");
  const strip = root.querySelector(".dt-hub-tabs");
  const ind = root.querySelector(".dt-hub-ind");
  const btns = [...root.querySelectorAll(".dt-hub-tab")];
  const panels = new Map();
  let current = "";

  const mount = (tab) => {
    const panel = document.createElement("div");
    panel.className = "dt-hub-panel";
    if (tab.url) {
      const frame = document.createElement("iframe");
      frame.className = "dt-appframe";
      frame.allow = APP_FRAME_PERMISSIONS;
      frame.addEventListener("load", () => {
        panel.classList.add("ready");
        applyHubTheme(frame);
      });
      frame.src = tab.url;
      panel.appendChild(frame);
    } else if (tab.mount) {
      panel.classList.add("native", "ready");
      tab.mount(panel);
    }
    stage.appendChild(panel);
    panels.set(tab.id, panel);
    return panel;
  };

  // La pastille suit l'onglet actif. On la mesure après layout : la fenêtre peut
  // encore être en train de s'ouvrir au premier appel.
  const moveIndicator = () => {
    const btn = btns.find((b) => b.dataset.tab === current);
    if (!btn || !btn.offsetWidth) return;
    ind.style.width = `${btn.offsetWidth}px`;
    ind.style.transform = `translateX(${btn.offsetLeft}px)`;
    ind.style.opacity = "1";
  };

  const go = (tabId) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || tabId === current) return;
    current = tabId;
    if (!panels.has(tabId)) mount(tab);
    for (const [id, panel] of panels) panel.classList.toggle("on", id === tabId);
    for (const b of btns) {
      const on = b.dataset.tab === tabId;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    }
    moveIndicator();
    win.setTitle?.(`${tt(hub.name)} — ${tt(tab.name)}`);
  };

  for (const b of btns) b.addEventListener("click", () => go(b.dataset.tab));

  // Flèches ← → sur la barre d'onglets, et ⌘/Ctrl + 1…9 quand le focus est dans
  // le chrome du hub (à l'intérieur d'une app, c'est l'app qui reçoit la touche).
  strip.addEventListener("keydown", (e) => {
    const i = tabs.findIndex((t) => t.id === current);
    if (e.key === "ArrowRight") { e.preventDefault(); go(tabs[(i + 1) % tabs.length].id); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(tabs[(i - 1 + tabs.length) % tabs.length].id); }
  });
  root.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= tabs.length) { e.preventDefault(); go(tabs[n - 1].id); }
  });

  root.querySelector('[data-act="reload"]').addEventListener("click", () => {
    const panel = panels.get(current);
    const frame = panel?.querySelector("iframe");
    if (frame) { panel.classList.remove("ready"); frame.src = frame.src; }
  });

  new ResizeObserver(moveIndicator).observe(strip);
  go(tabId && tabs.some((t) => t.id === tabId) ? tabId : tabs[0].id);
  requestAnimationFrame(moveIndicator);

  win.hubGo = go;
  return win;
}

// Monte l'App Studio dans un conteneur quelconque. Aujourd'hui c'est l'onglet
// « Studio » du hub Forge : tout le câblage part de `root`, jamais d'une
// fenêtre, pour que le panneau vive aussi bien seul qu'en onglet.
function mountAppStudio(root) {
  root.innerHTML = `
    <div class="as-app">
      <div class="as-main">
        <div class="as-head">
          <div>
            <div class="as-kicker">${tt("Expérimental")}</div>
            <h2>${tt("App Studio IA")}</h2>
          </div>
        </div>
        <div class="as-project-bar">
          <label class="as-field">${tt("Nom du projet")}
            <input class="as-project" value="mon_app" spellcheck="false" />
          </label>
          <label class="as-field">${tt("Sandbox")}
            <select class="as-sandbox"></select>
          </label>
        </div>
        <div class="as-modebar" role="tablist">
          <button class="as-mode active" data-mode="simple" role="tab">${tt("Génération simple")}</button>
          <button class="as-mode" data-mode="agent" role="tab">${tt("Agent de code")}</button>
          <label class="as-iters" hidden>${tt("Itérations")}
            <select class="as-iter-count">
              <option value="2">2</option>
              <option value="3" selected>3</option>
              <option value="4">4</option>
              <option value="6">6</option>
            </select>
          </label>
        </div>
        <textarea class="as-prompt" placeholder="${tt("Décris l'app à créer…")}"></textarea>
        <div class="as-actions">
          <button class="ck-btn primary" data-act="generate">${tt("Créer l'app")}</button>
          <button class="ck-btn" data-act="open" hidden>${tt("Ouvrir")}</button>
          <span class="as-status"></span>
        </div>
      </div>
      <div class="as-side">
        <div class="as-side-head">${tt("Journal & retour IA")}</div>
        <div class="as-side-hint">${tt("Le plan, les étapes et le code généré s'afficheront ici.")}</div>
        <div class="as-log" hidden></div>
        <pre class="as-preview" hidden></pre>
      </div>
    </div>`;
  const prompt = root.querySelector(".as-prompt");
  const projectInput = root.querySelector(".as-project");
  const sandboxSel = root.querySelector(".as-sandbox");
  const status = root.querySelector(".as-status");
  const preview = root.querySelector(".as-preview");
  const logEl = root.querySelector(".as-log");
  const sideHint = root.querySelector(".as-side-hint");
  const openBtn = root.querySelector('[data-act="open"]');
  const generateBtn = root.querySelector('[data-act="generate"]');
  const modeBtns = root.querySelectorAll(".as-mode");
  const itersWrap = root.querySelector(".as-iters");
  const iterCount = root.querySelector(".as-iter-count");
  let mode = "simple";
  let savedPath = "";
  let savedSbId = "";

  // Peuple le sélecteur de sandbox (sandbox active présélectionnée).
  (async () => {
    const list = await invoke("sandbox_list").catch(() => []);
    const cur = getCurrent();
    sandboxSel.innerHTML = "";
    if (!list.length) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = tt("Aucune sandbox");
      sandboxSel.appendChild(o);
      status.textContent = tt("Crée d'abord une sandbox dans Fichiers.");
      return;
    }
    for (const s of list) {
      const o = document.createElement("option");
      o.value = s.id; o.textContent = s.name;
      if (cur && s.id === cur.id) o.selected = true;
      sandboxSel.appendChild(o);
    }
  })();

  modeBtns.forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    modeBtns.forEach((x) => x.classList.toggle("active", x === b));
    itersWrap.hidden = mode !== "agent";
    generateBtn.textContent = mode === "agent" ? tt("Lancer l'agent") : tt("Créer l'app");
    prompt.placeholder = mode === "agent"
      ? tt("Décris l'app à construire — l'agent va réfléchir et itérer…")
      : tt("Décris l'app à créer…");
  }));

  function pushLog(kind, title, body) {
    logEl.hidden = false;
    const item = document.createElement("div");
    item.className = "as-log-item as-log-" + kind;
    item.innerHTML = `<div class="as-log-title">${escapeHtml(title)}</div>` +
      (body ? `<div class="as-log-body">${escapeHtml(body)}</div>` : "");
    logEl.appendChild(item);
    logEl.scrollTop = logEl.scrollHeight;
    return item;
  }

  generateBtn.addEventListener("click", async () => {
    const sbId = sandboxSel.value;
    if (!sbId) { status.textContent = tt("Choisis une sandbox (ou crée-en une)."); return; }
    const ask = prompt.value.trim();
    if (!ask) { prompt.focus(); return; }
    // Le projet = un DOSSIER dans la sandbox choisie. Tous les fichiers de l'app
    // y sont rangés (index.html, styles.css, app.js…), éditables ensuite dans
    // l'Éditeur de code.
    const folder = sanitizeFileName(projectInput.value || "mon_app", "mon_app").replace(/\.html?$/i, "") || "mon_app";
    projectInput.value = folder;
    generateBtn.disabled = true;
    openBtn.hidden = true;
    if (sideHint) sideHint.hidden = true;

    try {
      if (mode === "agent") {
        logEl.hidden = false;
        logEl.innerHTML = "";
        preview.hidden = false;
        preview.textContent = "";
        status.textContent = tt("Agent au travail…");
        // App MULTI-FICHIERS éditée par diff ciblé tour après tour.
        // Reprend les fichiers existants du dossier pour itérer dessus.
        const files = {};
        for (const fn of AS_AGENT_FILES) {
          try {
            const fc = await invoke("sandbox_read_file", { id: sbId, path: `${folder}/${fn}` });
            if (fc && !fc.binary && fc.content) files[fn] = fc.content;
          } catch {}
        }
        const finalFiles = await runAppStudioAgent({
          goal: ask,
          maxIters: parseInt(iterCount.value, 10) || 3,
          files,
          onStep: ({ phase, iter, text }) => {
            if (phase === "plan") pushLog("plan", tt("Étape {n} · Plan", { n: iter }), text);
            else if (phase === "review") pushLog("review", tt("Étape {n} · Revue", { n: iter }), text);
            else if (phase === "diff") pushLog("diff", tt("Étape {n} · Modif", { n: iter }), text);
            else if (phase === "think") { status.textContent = tt("Étape {n} · réflexion…", { n: iter }); }
            else if (phase === "done") pushLog("done", tt("Terminé"), text);
          },
          onFile: async (path, content, iter) => {
            await invoke("sandbox_write_file", { id: sbId, path: `${folder}/${path}`, content });
            preview.textContent = (path + " :\n" + content).slice(0, 3000);
            status.textContent = tt("Étape {n} · {file} écrit", { n: iter, file: path });
            requestSandboxRefresh();
          },
        });
        if (finalFiles["index.html"]) { savedPath = `${folder}/index.html`; savedSbId = sbId; openBtn.hidden = false; }
        status.textContent = tt("Agent terminé.");
      } else {
        status.textContent = tt("Préparation du prompt…");
        preview.hidden = false;
        preview.textContent = "";
        logEl.hidden = true;
        const html = sanitizeStandaloneHtml(await creativeOllamaStream(SANDBOX_PROMPTS["app.appstudio.single"].build({ request: ask }).messages, (chunk, full) => {
          preview.textContent = full.slice(-6000);
          preview.scrollTop = preview.scrollHeight;
          status.textContent = tt("Génération… {count} caractères", { count: full.length.toLocaleString() });
        }));
        status.textContent = tt("Écriture dans la sandbox…");
        await invoke("sandbox_write_file", { id: sbId, path: `${folder}/index.html`, content: html });
        savedPath = `${folder}/index.html`;
        savedSbId = sbId;
        // Aperçu : on montre le DÉBUT puis la FIN du fichier (avec le </html>
        // de clôture) pour que la complétude soit visible — sinon un simple
        // slice(0, N) donnait l'illusion d'une génération tronquée alors que le
        // fichier écrit est complet.
        const total = html.length;
        preview.textContent = total <= 6000
          ? html
          : html.slice(0, 3000) + "\n\n  … (" + total.toLocaleString() + " car. au total) …\n\n" + html.slice(-3000);
        preview.scrollTop = preview.scrollHeight;
        openBtn.hidden = false;
        status.textContent = tt("App créée.");
        requestSandboxRefresh();
      }
    } catch (e) {
      status.textContent = tt("Échec :") + " " + (e?.message || e);
    } finally {
      generateBtn.disabled = false;
    }
  });
  openBtn.addEventListener("click", () => {
    if (!savedPath) return;
    // Le lanceur opère sur la sandbox active : si le projet est dans une autre
    // sandbox, on invite à la sélectionner dans Fichiers plutôt que d'ouvrir le
    // mauvais dossier en silence.
    const cur = getCurrent();
    if (cur && savedSbId && savedSbId !== cur.id) {
      status.textContent = tt("Ouvre la sandbox du projet dans Fichiers pour le lancer.");
      return;
    }
    window.__launchSandboxApp?.(savedPath);
  });
}

// Fichiers standard d'une app App Studio en mode agent (multi-fichiers).
const AS_AGENT_FILES = ["index.html", "styles.css", "app.js"];

// Boucle d'agent de code « façon Codex », MULTI-FICHIERS et par DIFF. À chaque
// tour, l'IA reçoit l'état courant des fichiers, planifie, puis renvoie soit des
// éditions ciblées (search/replace) soit des fichiers complets. On applique, on
// écrit ce qui a changé, et on itère jusqu'à `done` (ou budget épuisé).
async function runAppStudioAgent({ goal, maxIters, files, onStep, onFile }) {
  for (let iter = 1; iter <= maxIters; iter += 1) {
    onStep({ phase: "think", iter });
    const isFirst = Object.keys(files).length === 0;
    const { messages, opts } = SANDBOX_PROMPTS["app.appstudio.agent"].build({ goal, files, isFirst });
    const { content, data } = await llmChat(messages, { ...opts, rawSystem: true });
    recordOllamaUsage(data, "appstudio-agent");
    const step = parseAgentStep(content);
    if (step.plan) onStep({ phase: isFirst ? "plan" : "review", iter, text: step.plan });

    const changed = [];
    for (const op of step.files) {
      const path = normalizeAgentPath(op.path);
      if (!path) continue;
      let next;
      if (op.action === "edit" && Array.isArray(op.hunks) && files[path] != null) {
        const res = applyHunks(files[path], op.hunks);
        next = res.content;
        onStep({ phase: "diff", iter, text: `${path} · ${res.applied}/${op.hunks.length} édition(s)` + (res.missed ? ` · ${res.missed} introuvable(s)` : "") });
      } else if (typeof op.content === "string") {
        next = op.content;
        onStep({ phase: "diff", iter, text: `${path} · ${files[path] == null ? tt("créé") : tt("réécrit")} (${op.content.length.toLocaleString()} car.)` });
      } else continue;
      if (next !== files[path]) { files[path] = next; changed.push(path); }
    }
    for (const path of changed) await onFile(path, files[path], iter);

    if (step.done || iter === maxIters) {
      onStep({ phase: "done", iter, text: step.summary || tt("App finalisée.") });
      break;
    }
  }
  return files;
}

// Applique une liste de hunks {search, replace} au contenu (1re occurrence de
// chaque search). Renvoie le contenu modifié + compteurs appliqués/manqués.
function applyHunks(content, hunks) {
  let out = content, applied = 0, missed = 0;
  for (const h of hunks) {
    const search = String(h?.search ?? "");
    const replace = String(h?.replace ?? "");
    if (!search) { missed += 1; continue; }
    const idx = out.indexOf(search);
    if (idx === -1) { missed += 1; continue; }
    out = out.slice(0, idx) + replace + out.slice(idx + search.length);
    applied += 1;
  }
  return { content: out, applied, missed };
}

// Restreint un chemin proposé par l'IA au nom de fichier (pas d'évasion de
// dossier) et aux extensions web autorisées.
function normalizeAgentPath(p) {
  const base = String(p || "").split("/").pop().trim();
  if (!base || !/\.(html?|css|js)$/i.test(base)) return "";
  return base;
}

// Parse la réponse de l'agent (JSON multi-fichiers attendu, repli robuste si le
// modèle renvoie du markdown ou un simple bloc HTML).
function parseAgentStep(content) {
  let raw = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch {} }
  }
  if (!obj || typeof obj !== "object") {
    // Repli : on traite tout le texte comme un index.html autonome.
    return { plan: "", files: [{ path: "index.html", action: "rewrite", content: sanitizeStandaloneHtml(raw) }], done: false, summary: "" };
  }
  const files = Array.isArray(obj.files) ? obj.files.map((f) => ({
    path: f.path,
    action: f.action || (Array.isArray(f.hunks) ? "edit" : "rewrite"),
    content: typeof f.content === "string" ? f.content : undefined,
    hunks: Array.isArray(f.hunks) ? f.hunks : undefined,
  })) : [];
  return { plan: typeof obj.plan === "string" ? obj.plan : "", files, done: obj.done === true, summary: typeof obj.summary === "string" ? obj.summary : "" };
}

function sanitizeStandaloneHtml(html) {
  let out = String(html || "").replace(/```(?:html)?/gi, "").replace(/```/g, "").trim();
  if (!/<!doctype|<html[\s>]/i.test(out)) {
    out = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mini app</title></head><body>${out}</body></html>`;
  }
  return out;
}

function sanitizeFileName(name, fallback) {
  return String(name || fallback).split("/").pop().replace(/[^\p{L}\p{N}_. -]+/gu, "").trim().replace(/\s+/g, "_") || fallback;
}

function decodeBase64Utf8(b64) {
  const bin = atob(String(b64 || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}


// Construit le bloc `options` d'un appel Ollama de génération. En plus de la
// taille de contexte (num_ctx), on FIXE explicitement le budget de tokens de
// SORTIE (num_predict). Sans ça, Ollama retombe sur son défaut et tronque les
// longues générations (ex. une app HTML complète) quelle que soit la taille de
// contexte. `ollamaNumPredict` (localStorage) permet de l'ajuster ; défaut -1 =
// pas de plafond, la sortie n'est bornée que par le contexte.
function ollamaGenOptions(extra) {
  const numCtx = parseInt(localStorage.getItem("ollamaNumCtx") || "0", 10);
  const npRaw = localStorage.getItem("ollamaNumPredict");
  const numPredict = npRaw == null || npRaw === "" ? -1 : parseInt(npRaw, 10);
  const opts = { num_predict: Number.isNaN(numPredict) ? -1 : numPredict, ...(extra || {}) };
  if (numCtx > 0) opts.num_ctx = numCtx;
  return opts;
}

async function creativeOllama(messages) {
  const { content: out, data } = await llmChat(messages, { rawSystem: true });
  recordOllamaUsage(data, "creative");
  return out || "";
}

async function creativeOllamaStream(messages, onChunk) {
  // En API cloud, pas de streaming NDJSON Ollama : on récupère le texte complet
  // et on le livre d'un coup (le rendu reste correct, sans token-par-token).
  if (llmBackend().api) {
    const out = await creativeOllama(messages);
    if (out) onChunk(out, out);
    return out;
  }
  const url = localStorage.getItem("ollamaUrl") || "http://localhost:11434";
  const model = localStorage.getItem("selectedModel") || "";
  // IMPORTANT : on privilégie le backend Rust NON-streaming (proxy HTTP hors
  // WebView) plutôt que le streaming `fetch` lu dans la WKWebView. Ce dernier
  // tronque les longues réponses (la lecture `getReader()` s'arrête avant la
  // fin sous WKWebView), ce qui coupait les apps générées en plein milieu —
  // alors qu'Ollama, lui, renvoie bien le HTML complet. On perd le rendu
  // token-par-token mais on garantit une génération entière.
  // Repli sur le streaming direct seulement si le backend est indisponible.
  try {
    const keepAlive = localStorage.getItem("ollamaKeepAlive") || "5m";
    // Appel via le proxy Rust (invoke direct) : l'HTTP se fait hors WebView,
    // donc aucune troncature liée à WKWebView, même sur localhost.
    const data = await invoke("ollama_post_json", {
      url,
      path: "api/chat",
      payload: {
        model,
        messages,
        options: ollamaGenOptions(),
        keep_alive: keepAlive,
        stream: false,
      },
    });
    const out = data?.message?.content || "";
    if (out) onChunk(out, out);
    recordOllamaUsage(data, "creative-stream");
    return out;
  } catch (e) {
    if (ollamaUsesBackend(url)) throw e; // pas de repli WebView hors localhost
    console.warn("App Studio : backend indisponible, repli streaming WebView", e);
  }
  // Respecte la taille de contexte / keep-alive globaux (cf. Paramètres).
  const keepAlive = localStorage.getItem("ollamaKeepAlive") || "5m";
  const r = await fetch(`${url}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, options: ollamaGenOptions(), keep_alive: keepAlive, stream: true }),
  });
  if (!r.ok) throw new Error("Ollama indisponible");
  if (!r.body) return creativeOllama(messages);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  let finalStats = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let data = null;
      try { data = JSON.parse(line); } catch { continue; }
      const part = data?.message?.content || "";
      if (part) {
        out += part;
        onChunk?.(part, out);
      }
      if (data?.done) finalStats = data;
    }
  }
  if (buf.trim()) {
    try {
      const data = JSON.parse(buf);
      const part = data?.message?.content || "";
      if (part) { out += part; onChunk?.(part, out); }
      if (data?.done) finalStats = data;
    } catch {}
  }
  if (finalStats) recordOllamaUsage(finalStats, "appstudio");
  return out;
}

function toggleStartMenu(anchor) {
  const open = document.querySelector(".dt-start");
  if (open) { open.remove(); return; }
  closeMenus();
  document.querySelectorAll(".dt-panel").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "dt-start";
  let activeCat = "all";
  let query = "";
  menu.innerHTML = `
    <div class="dt-start-head">
      <div>
        <div class="dt-start-hi">Applications</div>
        <div class="dt-start-sub">${escapeHtml(osName())}</div>
      </div>
      <label class="dt-start-search">
        ${S('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 1.9)}
        <input placeholder="Rechercher une app…" autocomplete="off" />
      </label>
    </div>
    <div class="dt-start-shell">
      <div class="dt-start-cats"></div>
      <div class="dt-start-main">
        <div class="dt-start-favs"></div>
        <div class="dt-start-section-title">Applications</div>
        <div class="dt-start-grid"></div>
      </div>
    </div>`;
  const cats = menu.querySelector(".dt-start-cats");
  const favs = menu.querySelector(".dt-start-favs");
  const grid = menu.querySelector(".dt-start-grid");
  const sectionTitle = menu.querySelector(".dt-start-section-title");
  const search = menu.querySelector(".dt-start-search input");
  const visibleApps = () => dtApps();
  const launch = (app) => { app.action(); menu.remove(); };
  const appButton = (app, compact = false) => {
    const card = document.createElement("button");
    card.className = compact ? "dt-app-card compact" : "dt-app-card";
    // Pastille en dégradé propre à l'app (cohérent avec le dock et la boîte à
    // outils, qui puisent au même endroit).
    const grad = appGradient(app);
    card.style.setProperty("--c1", grad[0]);
    card.style.setProperty("--c2", grad[1]);
    const tag = app.exp ? tt("Expérimental") : app.beta ? "Beta" : "";
    const tagHtml = tag ? `<span class="dt-app-tag${app.exp ? " exp" : ""}">${escapeHtml(tag)}</span>` : "";
    card.innerHTML = `<span class="dt-app-ic">${app.icon}</span><span class="dt-app-text"><span class="dt-app-nameline"><span class="dt-app-name">${escapeHtml(tt(app.name))}</span>${tagHtml}</span><span class="dt-app-desc">${escapeHtml(tt(app.desc))}</span></span>`;
    card.addEventListener("click", () => launch(app));
    return card;
  };
  function renderCats() {
    cats.innerHTML = "";
    for (const cat of dtCats()) {
      const btn = document.createElement("button");
      btn.className = "dt-start-cat" + (cat.id === activeCat ? " active" : "");
      btn.innerHTML = `<span class="dt-start-cat-ic">${cat.icon}</span><span><b>${escapeHtml(tt(cat.label))}</b><small>${escapeHtml(tt(cat.desc))}</small></span>`;
      btn.addEventListener("click", () => { activeCat = cat.id; render(); });
      cats.appendChild(btn);
    }
  }
  function render() {
    renderCats();
    const q = query.trim().toLowerCase();
    let apps = visibleApps();
    if (activeCat !== "all") apps = apps.filter((app) => app.cat === activeCat);
    if (q) apps = apps.filter((app) => `${app.name} ${app.desc}`.toLowerCase().includes(q));
    const cat = DT_CATS.find((c) => c.id === activeCat) || DT_CATS[0];
    sectionTitle.textContent = q ? tt("Résultats") : tt(cat.label);
    favs.innerHTML = "";
    if (!q) {
      const favList = DT_FAVORITES.map((id) => visibleApps().find((app) => app.id === id)).filter(Boolean);
      for (const app of favList) favs.appendChild(appButton(app, true));
    }
    favs.hidden = !!q;
    grid.innerHTML = "";
    if (!apps.length) {
      grid.innerHTML = `<div class="dt-start-empty">${escapeHtml(tt("Aucune app trouvée."))}</div>`;
      return;
    }
    for (const app of apps) grid.appendChild(appButton(app));
  }
  search.addEventListener("input", () => { query = search.value; render(); });
  render();
  document.body.appendChild(menu);
  translatePage(menu);
  search.focus({ preventScroll: true });
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, r.left) + "px";
  menu.style.bottom = (window.innerHeight - r.top + 10) + "px";
  setTimeout(() => document.addEventListener("pointerdown", function h(ev) {
    if (!menu.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) { menu.remove(); document.removeEventListener("pointerdown", h); }
  }), 0);
}

// ===== Launcher plein écran (façon Launchpad macOS / grille GNOME) =====
// Toutes les apps sur une grille scrollable, avec recherche et filtre par
// catégorie. Ouvert depuis le dock et la barre des tâches.
function openLauncher() {
  // Le lanceur plein écran est réservé au mode dock ; le bureau classique
  // conserve son menu Démarrer compact.
  if (!dockMode) return;
  const existing = document.querySelector(".dt-launcher");
  if (existing) { existing.remove(); return; }
  closeMenus();
  document.querySelectorAll(".dt-start, .dt-panel").forEach((el) => el.remove());
  const lay = document.createElement("div");
  lay.className = "dt-launcher";
  lay.innerHTML = `
    <button class="dt-launcher-close" title="${escapeHtml(tt("Fermer"))}">
      ${S('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 2.2)}
    </button>
    <label class="dt-launcher-search">
      ${S('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 1.9)}
      <input placeholder="${escapeHtml(tt("Rechercher une app…"))}" autocomplete="off" />
    </label>
    <div class="dt-launcher-cats"></div>
    <div class="dt-launcher-scroll"><div class="dt-launcher-grid"></div></div>`;
  const cats = lay.querySelector(".dt-launcher-cats");
  const grid = lay.querySelector(".dt-launcher-grid");
  const search = lay.querySelector(".dt-launcher-search input");
  let activeCat = "all";
  let query = "";
  const visibleApps = () => dtApps();
  const close = () => { lay.remove(); document.removeEventListener("keydown", onKey); };
  const launch = (app) => { close(); app.action(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  const tile = (app) => {
    const b = document.createElement("button");
    b.className = "dt-launch-tile";
    const grad = Array.isArray(app.grad) && app.grad.length >= 2 ? app.grad : [appOrbColor(app, DT_APPS.indexOf(app))];
    b.style.setProperty("--c1", grad[0]); b.style.setProperty("--c2", grad[1] || grad[0]);
    const tag = app.exp ? tt("Expérimental") : app.beta ? "Beta" : "";
    const tagHtml = tag ? `<span class="dt-launch-tag${app.exp ? " exp" : ""}">${escapeHtml(tag)}</span>` : "";
    b.innerHTML = `<span class="dt-launch-ic">${app.icon}${tagHtml}</span><span class="dt-launch-name">${escapeHtml(tt(app.name))}</span>`;
    b.title = tt(app.desc);
    b.addEventListener("click", () => launch(app));
    return b;
  };
  const renderCats = () => {
    cats.innerHTML = "";
    for (const cat of dtCats()) {
      const btn = document.createElement("button");
      btn.className = "dt-launcher-cat" + (cat.id === activeCat ? " active" : "");
      btn.innerHTML = `<span class="dt-launcher-cat-ic">${cat.icon}</span><span>${escapeHtml(tt(cat.label))}</span>`;
      btn.addEventListener("click", () => { activeCat = cat.id; render(); });
      cats.appendChild(btn);
    }
  };
  const render = () => {
    renderCats();
    const q = query.trim().toLowerCase();
    let apps = visibleApps();
    if (activeCat !== "all") apps = apps.filter((a) => a.cat === activeCat);
    if (q) apps = apps.filter((a) => `${a.name} ${a.desc}`.toLowerCase().includes(q));
    grid.innerHTML = "";
    if (!apps.length) { grid.innerHTML = `<div class="dt-launcher-empty">${escapeHtml(tt("Aucune app trouvée."))}</div>`; return; }
    for (const app of apps) grid.appendChild(tile(app));
  };
  search.addEventListener("input", () => { query = search.value; render(); });
  lay.querySelector(".dt-launcher-close").addEventListener("click", close);
  // Clic sur le fond (hors grille/recherche) → ferme, façon Launchpad.
  lay.addEventListener("pointerdown", (e) => { if (e.target === lay || e.target.classList.contains("dt-launcher-scroll")) close(); });
  render();
  document.body.appendChild(lay);
  translatePage(lay);
  document.addEventListener("keydown", onKey);
  search.focus({ preventScroll: true });
}

// Visibilité de la barre de chat : seul le bouton de bascule la contrôle.
let chatManualHidden = false, chatToggleBtn = null, previewObserver = null;
function updateChatVisibility() {
  if (!chatEl) return;
  chatEl.style.display = chatManualHidden ? "none" : "";
  chatToggleBtn?.classList.toggle("active", !chatManualHidden);
}

// L'aperçu de fichier (#preview) devient une fenêtre flottante draggable en mode
// bureau (au lieu d'un volet collé au bord droit).
function watchPreview() {
  const p = document.getElementById("preview");
  if (!p) return;
  if (!p.hidden) decoratePreview(p);
  previewObserver = new MutationObserver(() => { if (!p.hidden) decoratePreview(p); });
  previewObserver.observe(p, { attributes: true, attributeFilter: ["hidden"] });
}
function decoratePreview(p) {
  // Déjà décorée : on la remonte simplement dans l'ordre des fenêtres (pas de
  // forçage permanent au-dessus des autres).
  if (p.classList.contains("dt-pv-window")) { p.style.zIndex = String(++zTop); return; }
  p.classList.add("dt-pv-window");
  Object.assign(p.style, {
    left: Math.max(60, window.innerWidth - 480) + "px", top: "48px",
    right: "auto", bottom: "auto", width: "440px", height: "600px", zIndex: String(++zTop),
  });
  const head = p.querySelector(".preview-head");
  if (head) makeDraggable(p, head);
  if (!p.querySelector(".dt-resize")) {
    const grip = document.createElement("div"); grip.className = "dt-resize";
    p.appendChild(grip); makeResizable(p, grip);
  }
  // En workspace : désactive le resizer de bord d'origine (on garde la poignée
  // d'angle comme les autres fenêtres).
  const edge = p.querySelector(".preview-resizer"); if (edge) edge.style.display = "none";
  // Passe au premier plan au clic, comme les autres fenêtres (z partagé).
  if (!p._dtFront) { p._dtFront = () => { p.style.zIndex = String(++zTop); }; p.addEventListener("pointerdown", p._dtFront, true); }
}
function undecoratePreview() {
  const p = document.getElementById("preview");
  if (!p) return;
  p.querySelectorAll(".dt-resize").forEach((g) => g.remove());
  const edge = p.querySelector(".preview-resizer"); if (edge) edge.style.display = "";
  if (p._dtFront) { p.removeEventListener("pointerdown", p._dtFront, true); p._dtFront = null; }
  p.classList.remove("dt-pv-window");
  ["left", "top", "right", "bottom", "width", "height", "zIndex"].forEach((k) => p.style[k] = "");
}
function tbBtn(label, onClick, icon, opts = {}) {
  const b = document.createElement("button"); b.className = "dt-tb-btn";
  const translated = tt(label);
  b.title = translated; // tooltip (utile quand la barre passe en mode icônes seules)
  b.setAttribute("aria-label", translated);
  if (opts.iconOnly) b.classList.add("icon-only");
  b.innerHTML = (icon ? `<span class="dt-tb-ic">${icon}</span>` : "") + `<span class="dt-tb-label">${escapeHtml(translated)}</span>`;
  b.addEventListener("click", onClick); return b;
}
function sep() { const s = document.createElement("div"); s.className = "dt-tb-sep"; return s; }

// Horloge des barres (barre des tâches ET dock) : heure en clair, date complète
// dans l'info-bulle, mise à jour à la minute juste.
// ===== Indicateur système : connectivité et batterie =====
//
// Deux informations que le bureau ne donnait nulle part, alors qu'elles
// changent ce qu'on peut faire : hors ligne, les modèles cloud et le Catalogue
// sont inatteignables ; sur batterie basse, on évite de lancer une génération
// d'image. L'élément est le même dans la barre des tâches et dans la barre
// d'état du dock — une seule fabrique, deux points de montage.
//
// La batterie n'apparaît QUE s'il y en a une : sur un fixe (ou un Raspberry
// Pi), l'indicateur se réduit au réseau plutôt que d'afficher un « — » inutile.

/** Batterie via l'API standard, disponible sur les WebView Chromium (Windows). */
async function webBattery() {
  try {
    const b = await navigator.getBattery?.();
    if (!b) return null;
    return { hasBattery: true, percent: Math.round((b.level ?? 0) * 100), charging: !!b.charging, live: b };
  } catch { return null; }
}

/** Batterie via le backend (macOS : pmset ; Linux/Pi : sysfs). */
async function nativeBattery() {
  try {
    const st = await invoke("power_status");
    if (!st?.has_battery) return { hasBattery: false };
    return { hasBattery: true, percent: Number(st.percent), charging: !!st.charging };
  } catch { return null; }
}

function batteryIcon(percent, charging) {
  if (charging) return ICON["battery-charging"];
  return ICON.battery;
}

function makeSystemStatus(cls) {
  const box = document.createElement("div");
  box.className = "dt-sysstatus " + cls;
  box.innerHTML = `
    <span class="dt-sys-net" hidden></span>
    <span class="dt-sys-batt" hidden><span class="dt-sys-batt-ic"></span><b class="dt-sys-batt-pct"></b></span>`;
  const netEl = box.querySelector(".dt-sys-net");
  const battEl = box.querySelector(".dt-sys-batt");

  const renderNet = () => {
    const on = navigator.onLine !== false;
    netEl.hidden = false;
    netEl.innerHTML = on ? ICON.wifi : ICON["wifi-off"];
    netEl.classList.toggle("off", !on);
    netEl.title = tt(on ? "Connecté à Internet" : "Hors ligne — les modèles et services distants sont injoignables");
  };

  const renderBattery = (b) => {
    if (!b || !b.hasBattery) { battEl.hidden = true; return; }
    const pct = Number.isFinite(b.percent) && b.percent >= 0 ? b.percent : null;
    battEl.hidden = false;
    battEl.querySelector(".dt-sys-batt-ic").innerHTML = batteryIcon(pct, b.charging);
    battEl.querySelector(".dt-sys-batt-pct").textContent = pct == null ? "—" : pct + " %";
    // Seuils : en dessous de 20 % on alerte, en dessous de 10 % on insiste.
    battEl.classList.toggle("low", pct != null && !b.charging && pct <= 20);
    battEl.classList.toggle("critical", pct != null && !b.charging && pct <= 10);
    battEl.classList.toggle("charging", !!b.charging);
    battEl.title = b.charging
      ? tt("Sur secteur")
      : `${tt("Sur batterie")}${pct == null ? "" : ` — ${pct} %`}`;
  };

  renderNet();
  window.addEventListener("online", renderNet);
  window.addEventListener("offline", renderNet);

  (async () => {
    const web = await webBattery();
    if (web) {
      renderBattery(web);
      // L'API standard pousse ses propres évènements : pas de sondage.
      for (const ev of ["levelchange", "chargingchange"]) {
        web.live.addEventListener?.(ev, () => webBattery().then(renderBattery));
      }
      return;
    }
    const tick = async () => { if (box.isConnected) renderBattery(await nativeBattery()); };
    await tick();
    setInterval(tick, 60000);
  })();

  return box;
}

function makeClock(cls) {
  const clock = document.createElement("span");
  clock.className = cls;
  const lang = dtLang() === "en" ? "en-GB" : "fr-FR";
  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    clock.title = now.toLocaleDateString(lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  };
  tick();
  setTimeout(() => { tick(); setInterval(tick, 60000); }, (60 - new Date().getSeconds()) * 1000);
  return clock;
}

// ===== Gestionnaire de fenêtres =====
function createWindow({ id, title, w = 460, h = 320, x = 80, y = 60, icon, grad }) {
  if (openWindows.has(id)) return focusWindow(id);
  const el = document.createElement("div");
  el.className = "dt-win";
  el.style.cssText = `width:${w}px;height:${h}px;left:${x}px;top:${y}px;z-index:${++zTop}`;
  el.innerHTML = `
    <div class="dt-win-bar">
      <button class="dt-traffic" title="Fermer"></button>
      <span class="dt-win-title">${escapeHtml(title)}</span>
    </div>
    <div class="dt-win-body"></div>
    <div class="dt-resize"></div>`;
  const body = el.querySelector(".dt-win-body");
  el.addEventListener("pointerdown", () => touchWindow(id), true);
  el.querySelector(".dt-traffic").addEventListener("click", () => closeWindow(id));
  makeDraggable(el, el.querySelector(".dt-win-bar"));
  makeResizable(el, el.querySelector(".dt-resize"));
  document.body.appendChild(el);

  // Entrée dans la barre des tâches : icône de l'app + libellé (masqué en mode
  // compact) + tooltip = titre complet.
  // Icône ET dégradé de l'app : le sélecteur clavier et le dock affichent les
  // glyphes sur leur pastille colorée. Ce sont des SVG au trait pensés pour un
  // fond coloré — posés tels quels sur un panneau, ils sont illisibles.
  // `icon`/`grad` explicites : pour les fenêtres du shell qui ne sont pas des
  // apps du menu démarrer (fond d'écran, notifications…), sinon leur entrée de
  // barre et leur vignette du sélecteur tombent sur le gris générique.
  const appDef = DT_APPS.find((a) => a.id === id);
  const appIcon = icon || appDef?.icon || ICON.grid;
  const appGrad = grad || appDef?.grad || ["#8e8e93", "#3a3a3c"];
  // Clic sur l'entrée de barre : réduit la fenêtre si elle est déjà au premier
  // plan, la ramène sinon — le comportement d'une barre des tâches d'OS.
  const taskBtn = tbBtn(title, () => {
    const r = openWindows.get(id);
    if (r && !r.minimized && winMru[0] === id) minimizeWindow(id);
    else focusWindow(id);
  }, appIcon);
  taskBtn.classList.add("active", "dt-tb-win");
  taskbarWins.appendChild(taskBtn);
  updateTaskbarDensity();

  // `onClose` : une fenêtre qui héberge une app packagée doit pouvoir couper son
  // pont AppKit en partant. Sans ce crochet, les outils publiés par l'app
  // resteraient au catalogue des agents, sans personne pour y répondre.
  const ref = { el, body, taskBtn, icon: appIcon, grad: appGrad, title, minimized: false,
    onClose: (fn) => { ref._onClose = fn; },
    setTitle: (t) => {
    ref.title = t;
    el.querySelector(".dt-win-title").textContent = t;
    taskBtn.title = t;
    const lbl = taskBtn.querySelector(".dt-tb-label");
    if (lbl) lbl.textContent = t;
  } };
  openWindows.set(id, ref);
  touchWindow(id);
  refreshDock();  // met à jour les pastilles « app active » du dock
  return ref;
}
// Ordre d'utilisation des fenêtres, la plus récente en tête. C'est lui qui
// donne son sens au sélecteur clavier (Ctrl+Tab) : sans MRU, « la fenêtre
// suivante » n'a pas de définition utile, et un aller-retour ne ramène pas là
// d'où l'on vient.
let winMru = [];
function touchWindow(id) {
  const r = openWindows.get(id);
  if (!r) return;
  bringToFront(r.el);
  winMru = [id, ...winMru.filter((x) => x !== id)];
}
function focusWindow(id) {
  const r = openWindows.get(id);
  if (!r) return r;
  if (r.minimized) restoreWindow(id);
  touchWindow(id);
  return r;
}
function bringToFront(el) { el.style.zIndex = ++zTop; }

// Réduire = la fenêtre disparaît de l'écran mais reste vivante (son iframe
// n'est pas déchargée) et reste listée dans la barre des tâches, le dock et le
// sélecteur clavier. C'est la réduction d'un OS, pas une fermeture déguisée.
function minimizeWindow(id) {
  const r = openWindows.get(id);
  if (!r || r.minimized) return;
  r.minimized = true;
  r.el.classList.add("minimized");
  r.taskBtn.classList.remove("active");
  // La fenêtre réduite passe en queue d'ordre d'utilisation : le prochain
  // Ctrl+Tab propose celle qui est réellement visible.
  winMru = [...winMru.filter((x) => x !== id), id];
  refreshDock();
}
function restoreWindow(id) {
  const r = openWindows.get(id);
  if (!r || !r.minimized) return;
  r.minimized = false;
  r.el.classList.remove("minimized");
  r.taskBtn.classList.add("active");
  refreshDock();
}

// « Afficher le bureau » : réduit tout, ou restaure exactement ce qui avait été
// réduit par ce même raccourci (les fenêtres déjà réduites à la main le
// restent).
let showDesktopStash = null;
function toggleShowDesktop() {
  if (showDesktopStash && showDesktopStash.length) {
    const ids = showDesktopStash;
    showDesktopStash = null;
    ids.forEach((id) => restoreWindow(id));
    if (ids.length) focusWindow(ids[ids.length - 1]);
    return;
  }
  const visible = [...openWindows.entries()].filter(([, r]) => !r.minimized).map(([id]) => id);
  showDesktopStash = visible;
  visible.forEach((id) => minimizeWindow(id));
}

function closeWindow(id) {
  const r = openWindows.get(id); if (!r) return;
  try { r._onClose?.(); } catch { /* le ménage d'une app ne doit pas bloquer la fermeture */ }
  r.el.remove(); r.taskBtn.remove(); openWindows.delete(id);
  winMru = winMru.filter((x) => x !== id);
  showDesktopStash = showDesktopStash?.filter((x) => x !== id) || null;
  updateTaskbarDensity();
  refreshDock();  // retire la pastille « app active » du dock
  // Le focus revient à la fenêtre précédente, comme après un ⌘W.
  if (winMru[0]) focusWindow(winMru[0]);
}
// Passe la barre des tâches en mode « icônes seules » dès que beaucoup de
// fenêtres sont ouvertes, pour éviter le débordement. Les libellés restent
// accessibles via le tooltip (title).
function updateTaskbarDensity() {
  if (!taskbarWins) return;
  const compact = taskbarWins.childElementCount > 5;
  taskbarWins.classList.toggle("dt-tb-compact", compact);
}

// ===== Widgets =====
function widgetMenu(anchor) {
  closeMenus();
  const m = document.createElement("div"); m.className = "dt-menu";
  const r = anchor.getBoundingClientRect();
  m.style.left = r.left + "px"; m.style.bottom = (window.innerHeight - r.top + 6) + "px";
  for (const [type, label, icon] of [
    ["clock", "Horloge", ICON.clock],
    ["notes", "Notes", ICON.note],
    ["storage", "Stockage", ICON.disk],
    ["model", "Modèle actif", ICON.m_tools],
    ["tokens", "Tokens du jour", ICON.tokens],
    ["agenda", "Agenda du jour", ICON.calendar],
    ["inbox", "Boîte de réception", ICON.inbox],
    ["health", "Santé du poste", ICON.activity],
    ["llmLog", "Journal LLM", ICON.journal],
    ["agentTasks", "Tâches agents", ICON.agents],
    ["todo", "Todo list", ICON.tasklist],
    ["timeline", "Timeline", ICON.timeline],
    // "contextGraph" retiré du menu (peu utile) — le code de rendu reste pour
    // référence, et restoreWidgets() filtre les instances déjà persistées.
  ]) {
    const it = document.createElement("div"); it.className = "dt-menu-item";
    it.innerHTML = `<span class="dt-panel-ic">${icon}</span><span>${tt(label)}</span>`;
    it.addEventListener("click", () => {
      // Spawn en haut à droite (zone visible) avec un léger décalage en cascade,
      // sinon les nouveaux widgets apparaissent derrière la fenêtre explorateur.
      const n = widgetsLayer.querySelectorAll(".dt-widget").length;
      addWidget({ type, x: Math.max(20, window.innerWidth - 250), y: 50 + (n % 6) * 28 });
      closeMenus();
    });
    m.appendChild(it);
  }
  // Au niveau du <body> (et non #desktop qui est un contexte d'empilement bas),
  // sinon le menu passe derrière la barre de chat.
  document.body.appendChild(m);
  translatePage(m);
  // Fermeture au clic extérieur uniquement : sinon le pointerdown sur un item
  // retirait le menu avant que son `click` n'aboutisse (widgets non ajoutés).
  setTimeout(() => document.addEventListener("pointerdown", function h(ev) {
    if (!m.contains(ev.target) && ev.target !== anchor) { m.remove(); document.removeEventListener("pointerdown", h); }
  }), 0);
}
function closeMenus() { document.querySelectorAll(".dt-menu").forEach((m) => m.remove()); }

// Zone réservée au bas de l'écran : barre des tâches, dock et barre de chat
// sont fixés en bas et passent PAR-DESSUS tout menu qui y serait replié. Un
// menu contextuel ouvert près du bord doit donc s'arrêter au-dessus d'eux, pas
// au bord de la fenêtre. Exposé aux outils d'écriture (lib/writing-tools.js)
// qui dessinent aussi dans cette fenêtre.
function bottomSafeInset() {
  let top = window.innerHeight;
  for (const el of document.querySelectorAll(".dt-taskbar, .dt-dock, .dt-chat")) {
    if (!el.isConnected || el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom <= 0) continue;
    // La barre de chat passe en haut en mode dock : seuls les éléments ancrés
    // dans la moitié basse comptent.
    if (r.top < window.innerHeight / 2) continue;
    top = Math.min(top, r.top);
  }
  return Math.max(0, window.innerHeight - top) + 8;
}
window.__lumenSafeBottom = bottomSafeInset;

/** Place un menu fixé au point (x, y), replié dans la zone visible utile. */
function placeMenuAt(m, x, y) {
  const r = m.getBoundingClientRect();
  const maxY = window.innerHeight - bottomSafeInset() - r.height - 8;
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8, Math.min(y, maxY)) + "px";
}

function addWidget(w, persist = true) {
  const el = document.createElement("div");
  el.className = "dt-widget"; el.style.left = w.x + "px"; el.style.top = w.y + "px";
  const x = document.createElement("span"); x.className = "dt-widget-x"; x.textContent = "✕";
  x.addEventListener("click", () => { el.remove(); saveWidgets(); });
  el.appendChild(x);
  el.appendChild(buildWidgetBody(w));
  makeDraggable(el, el, saveWidgets);
  el._wtype = w.type; el._wdata = w.data || {};
  widgetsLayer.appendChild(el);
  if (persist) saveWidgets();
}

function widgetTitle(label, icon) {
  return `<div class="dt-w-title"><span class="dt-w-title-ic">${icon}</span><span>${tt(label)}</span></div>`;
}

function buildWidgetBody(w) {
  const c = document.createElement("div");
  if (w.type === "clock") {
    c.className = "dt-w-clock";
    c.innerHTML = `${widgetTitle("Horloge", ICON.clock)}<div class="dt-w-clock-time"></div><div class="dt-w-clock-date"></div>`;
    const upd = () => {
      const d = new Date();
      c.querySelector(".dt-w-clock-time").textContent = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      c.querySelector(".dt-w-clock-date").textContent = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    };
    upd(); setInterval(upd, 10000);
  } else if (w.type === "notes") {
    c.className = "dt-w-notes";
    c.innerHTML = widgetTitle("Notes", ICON.note);
    const ta = document.createElement("textarea"); ta.value = (w.data && w.data.text) || "";
    ta.addEventListener("input", () => { const el = ta.closest(".dt-widget"); if (el) el._wdata = { text: ta.value }; saveWidgets(); });
    ta.addEventListener("pointerdown", (e) => e.stopPropagation()); // permettre la sélection sans drag
    c.appendChild(ta);
  } else if (w.type === "storage") {
    c.className = "dt-w-storage";
    c.innerHTML = `${widgetTitle("Stockage", ICON.disk)}<div class="dt-w-storage-bar"><div class="dt-w-storage-fill"></div></div><div class="dt-w-storage-label">…</div>`;
    refreshStorage(c);
  } else if (w.type === "model") {
    c.className = "dt-w-model";
    c.innerHTML = `
      ${widgetTitle("Modèle actif", ICON.m_tools)}
      <div class="dt-wm-name">—</div>
      <div class="dt-wm-status"><span class="dt-wm-dot"></span><span class="dt-wm-state">…</span></div>
      <div class="dt-wm-rows">
        <div class="dt-wm-row"><span>${tt("Source")}</span><b class="dt-wm-source">—</b></div>
        <div class="dt-wm-row"><span>${tt("RAM")}</span><b class="dt-wm-ram">—</b></div>
        <div class="dt-wm-row"><span>${tt("Contexte")}</span><b class="dt-wm-ctx">—</b></div>
        <div class="dt-wm-row"><span>${tt("Vitesse")}</span><b class="dt-wm-tps">—</b></div>
      </div>`;
    refreshModelWidget(c);
    setInterval(() => { if (c.isConnected) refreshModelWidget(c); }, 8000);
  } else if (w.type === "tokens") {
    c.className = "dt-w-model dt-w-tokens";
    c.innerHTML = `
      ${widgetTitle("Tokens du jour", ICON.tokens)}
      <div class="dt-wm-name dt-wtok-total">—</div>
      <div class="dt-wm-rows">
        <div class="dt-wm-row"><span>${tt("Source")}</span><b class="dt-wtok-source">—</b></div>
        <div class="dt-wm-row"><span>${tt("Générés")}</span><b class="dt-wtok-gen">—</b></div>
        <div class="dt-wm-row"><span>${tt("Prompt")}</span><b class="dt-wtok-prompt">—</b></div>
        <div class="dt-wm-row"><span>${tt("Appels")}</span><b class="dt-wtok-calls">—</b></div>
        <div class="dt-wm-row"><span>${tt("Images")}</span><b class="dt-wtok-images">—</b></div>
      </div>`;
    refreshTokensWidget(c);
  } else if (w.type === "agenda") {
    c.className = "dt-w-agenda";
    c.innerHTML = `
      ${widgetTitle("Agenda du jour", ICON.calendar)}
      <div class="dt-wag-next"><b class="dt-wag-next-time">—</b><span class="dt-wag-next-title">${tt("Chargement…")}</span></div>
      <div class="dt-wa-list dt-wag-list"></div>
      <button class="dt-wag-open">${tt("Ouvrir le calendrier")}</button>`;
    c.querySelector(".dt-wag-open").addEventListener("click", () => openAppById("calendar"));
    refreshAgendaWidget(c);
    setInterval(() => { if (c.isConnected) refreshAgendaWidget(c); }, 60000);
  } else if (w.type === "inbox") {
    c.className = "dt-w-inbox";
    c.innerHTML = `
      ${widgetTitle("Boîte de réception", ICON.inbox)}
      <div class="dt-wa-sub dt-wib-sub">…</div>
      <div class="dt-wa-list dt-wib-list"></div>`;
    refreshInboxWidget(c);
  } else if (w.type === "health") {
    c.className = "dt-w-model dt-w-health";
    c.innerHTML = `
      ${widgetTitle("Santé du poste", ICON.activity)}
      <div class="dt-wm-status"><span class="dt-wm-dot"></span><span class="dt-wm-state dt-wh-verdict">…</span></div>
      <div class="dt-wh-gauges">
        <div class="dt-wh-gauge" data-g="ram"><span class="dt-wh-glabel">${tt("Mémoire")}</span><div class="dt-w-storage-bar"><div class="dt-w-storage-fill"></div></div><span class="dt-wh-gval">—</span></div>
        <div class="dt-wh-gauge" data-g="sandbox"><span class="dt-wh-glabel">${tt("Sandbox")}</span><div class="dt-w-storage-bar"><div class="dt-w-storage-fill"></div></div><span class="dt-wh-gval">—</span></div>
      </div>
      <div class="dt-wm-rows">
        <div class="dt-wm-row"><span>${tt("Disque libre")}</span><b class="dt-wh-disk">—</b></div>
        <div class="dt-wm-row"><span>${tt("Moteur")}</span><b class="dt-wh-engine">—</b></div>
      </div>
      <div class="dt-wh-procs"></div>`;
    refreshHealthWidget(c);
    setInterval(() => { if (c.isConnected) refreshHealthWidget(c); }, 10000);
  } else if (w.type === "llmLog") {
    // Journal LLM : dernières entrées du log global (llmlog.rs), en direct.
    c.className = "dt-w-llmlog";
    c.innerHTML = `
      ${widgetTitle("Journal LLM", ICON.journal)}
      <div class="dt-wll-list"><div class="dt-w-empty">${tt("Chargement…")}</div></div>`;
    refreshLlmLogWidget(c);
  } else if (w.type === "agentTasks") {
    c.className = "dt-w-agenttasks";
    c.innerHTML = `
      ${widgetTitle("Tâches agents", ICON.agents)}
      <div class="dt-wa-sub">…</div>
      <div class="dt-wa-list"></div>`;
    refreshAgentTasksWidget(c);
  } else if (w.type === "todo") {
    c.className = "dt-w-todo";
    const data = normalizeTodoData(w.data);
    c.innerHTML = `
      ${widgetTitle("Todo list", ICON.tasklist)}
      <div class="dt-wtodo-list"></div>
      <div class="dt-wtodo-add">
        <input type="text" placeholder="${tt("Nouvelle tâche…")}" />
        <input type="date" title="${tt("Échéance")}" />
        <button title="${tt("Ajouter")}">${ICON.check}</button>
      </div>`;
    renderTodoWidget(c, data);
    const [input, date] = c.querySelectorAll(".dt-wtodo-add input");
    const add = () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      data.tasks.push({ id: "todo-" + Date.now(), text, done: false, due: date.value || "" });
      input.value = ""; date.value = "";
      updateWidgetData(c, data);
      renderTodoWidget(c, data);
    };
    c.querySelector(".dt-wtodo-add button").addEventListener("click", add);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  } else if (w.type === "timeline") {
    c.className = "dt-w-timeline";
    c.innerHTML = `
      ${widgetTitle("Timeline", ICON.timeline)}
      <div class="dt-wtl-tabs">
        <button class="active" data-filter="all">${tt("Tout")}</button>
        <button data-filter="files">${tt("Fichiers")}</button>
        <button data-filter="agents">${tt("Agents")}</button>
      </div>
      <div class="dt-wtl-list"><div class="dt-w-empty">${tt("Chargement…")}</div></div>`;
    c._filter = "all";
    c.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
      c._filter = b.dataset.filter;
      c.querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("active", x === b));
      refreshTimelineWidget(c);
    }));
    refreshTimelineWidget(c);
  } else if (w.type === "contextGraph") {
    c.className = "dt-w-contextgraph";
    c.innerHTML = `
      ${widgetTitle("Context Graph", ICON.graph)}
      <div class="dt-wcg-layout">
        <svg class="dt-wcg-svg" viewBox="0 0 360 220" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="dt-wcg-side"><div class="dt-w-empty">${tt("Chargement…")}</div></div>
      </div>`;
    refreshContextGraphWidget(c);
  }
  return c;
}

function updateWidgetData(c, data) {
  const el = c.closest(".dt-widget");
  if (!el) return;
  el._wdata = structuredClone(data || {});
  saveWidgets();
}

function normalizeTodoData(data) {
  const raw = Array.isArray(data?.tasks) ? data.tasks : [];
  return {
    tasks: raw.map((t) => ({
      id: t.id || "todo-" + Math.random().toString(16).slice(2),
      text: String(t.text || "").trim(),
      done: !!t.done,
      due: String(t.due || ""),
    })).filter((t) => t.text),
  };
}

function todoSortValue(t) {
  if (!t.due) return Number.MAX_SAFE_INTEGER;
  const d = new Date(t.due + "T00:00:00");
  return Number.isNaN(d.getTime()) ? Number.MAX_SAFE_INTEGER : d.getTime();
}

function renderTodoWidget(c, data) {
  const list = c.querySelector(".dt-wtodo-list");
  if (!list) return;
  const tasks = data.tasks.slice().sort((a, b) => Number(a.done) - Number(b.done) || todoSortValue(a) - todoSortValue(b));
  if (!tasks.length) {
    list.innerHTML = `<div class="dt-w-empty">${tt("Aucune tâche.")}</div>`;
    return;
  }
  list.innerHTML = "";
  for (const task of tasks) {
    const row = document.createElement("div");
    row.className = "dt-wtodo-row" + (task.done ? " done" : "");
    row.innerHTML = `
      <button class="dt-wtodo-check" title="${tt("Terminé")}">${task.done ? ICON.check : ""}</button>
      <span class="dt-wtodo-text">${escapeHtml(task.text)}</span>
      ${task.due ? `<span class="dt-wtodo-due">${escapeHtml(formatDateOnly(task.due))}</span>` : ""}
      <button class="dt-wtodo-del" title="${tt("Supprimer")}">${ICON.trash}</button>`;
    row.querySelector(".dt-wtodo-check").addEventListener("click", () => {
      const t = data.tasks.find((x) => x.id === task.id);
      if (t) t.done = !t.done;
      updateWidgetData(c, data);
      renderTodoWidget(c, data);
    });
    row.querySelector(".dt-wtodo-del").addEventListener("click", () => {
      data.tasks = data.tasks.filter((x) => x.id !== task.id);
      updateWidgetData(c, data);
      renderTodoWidget(c, data);
    });
    list.appendChild(row);
  }
}

function formatDateOnly(value) {
  try {
    return new Date(value + "T00:00:00").toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  } catch {
    return value;
  }
}

function taskDateLabel(due) {
  if (due == null) return tt("Sans date");
  try {
    return new Date(due * 1000).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return tt("Sans date");
  }
}

function activityDateLabel(ts) {
  if (!ts) return "";
  try {
    return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "";
  }
}

async function refreshAgentTasksWidget(c) {
  const sub = c.querySelector(".dt-wa-sub");
  const list = c.querySelector(".dt-wa-list");
  if (!list) return;
  sub.textContent = tt("Chargement…");
  list.innerHTML = `<div class="dt-w-empty">${tt("Recherche…")}</div>`;
  let agents = [];
  try { agents = await invoke("agent_list"); } catch { agents = []; }
  const pending = [];
  for (const agent of agents) {
    for (const task of (agent.tasks || [])) {
      if (task.done) continue;
      pending.push({
        agent,
        text: task.text || "",
        due: task.due ?? null,
        sort: task.due == null ? Number.MAX_SAFE_INTEGER : task.due,
      });
    }
  }
  pending.sort((a, b) => a.sort - b.sort || String(a.agent?.name || "").localeCompare(String(b.agent?.name || "")));
  if (pending.length) {
    sub.textContent = tt("À venir");
    renderAgentTaskRows(list, pending.slice(0, 7));
    return;
  }

  const recent = [];
  await Promise.all(agents.map(async (agent) => {
    let activity = [];
    try { activity = await invoke("agent_activity", { id: agent.id }); } catch { activity = []; }
    for (const entry of activity || []) {
      if (!entry.task) continue;
      recent.push({ agent, text: entry.task, ts: entry.ts || 0, success: entry.success !== false });
    }
  }));
  recent.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  sub.textContent = recent.length ? tt("Tâches récentes") : tt("Aucune tâche.");
  renderAgentRecentRows(list, recent.slice(0, 7));
}

function refreshAgentTaskWidgets() {
  widgetsLayer?.querySelectorAll(".dt-w-agenttasks").forEach((c) => refreshAgentTasksWidget(c));
}

function renderAgentTaskRows(list, rows) {
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = `<div class="dt-w-empty">${tt("Aucune tâche.")}</div>`;
    return;
  }
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "dt-wa-row";
    el.innerHTML = `
      <span class="dt-wa-ic">${ICON.agents}</span>
      <span class="dt-wa-main"><b>${escapeHtml(row.text)}</b><small>${escapeHtml(row.agent?.name || tt("Agent"))}</small></span>
      <span class="dt-wa-date">${escapeHtml(taskDateLabel(row.due))}</span>`;
    list.appendChild(el);
  }
}

function renderAgentRecentRows(list, rows) {
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = `<div class="dt-w-empty">${tt("Aucune tâche.")}</div>`;
    return;
  }
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "dt-wa-row recent";
    el.innerHTML = `
      <span class="dt-wa-ic ${row.success ? "ok" : "fail"}">${row.success ? ICON.check : ICON.bell}</span>
      <span class="dt-wa-main"><b>${escapeHtml(row.text)}</b><small>${escapeHtml(row.agent?.name || tt("Agent"))}</small></span>
      <span class="dt-wa-date">${escapeHtml(activityDateLabel(row.ts))}</span>`;
    list.appendChild(el);
  }
}

async function collectWorkspaceContext({ maxFiles = 120 } = {}) {
  const sb = getCurrent();
  const files = [];
  async function walk(path, depth) {
    if (!sb || depth > 4 || files.length >= maxFiles) return;
    let list = [];
    try { list = await invoke("sandbox_read_dir", { id: sb.id, path }); } catch { return; }
    for (const e of list) {
      if (e.is_dir) {
        await walk(e.path, depth + 1);
      } else {
        files.push({
          ...e,
          ext: fileExt(e.name),
          modified: Number(e.modified || 0),
          folder: e.path.includes("/") ? e.path.split("/").slice(0, -1).join("/") : "",
        });
      }
      if (files.length >= maxFiles) break;
    }
  }
  await walk("", 0);
  files.sort((a, b) => (b.modified || 0) - (a.modified || 0) || a.path.localeCompare(b.path));

  let agents = [];
  try { agents = await invoke("agent_list"); } catch { agents = []; }
  const activity = [];
  await Promise.all(agents.map(async (agent) => {
    let rows = [];
    try { rows = await invoke("agent_activity", { id: agent.id }); } catch { rows = []; }
    for (const entry of rows || []) activity.push({ ...entry, agent });
  }));
  activity.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { sandbox: sb, files, agents, activity };
}

function fileKind(file) {
  const ext = file.ext || fileExt(file.name);
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (ext === "csv") return "csv";
  if (ext === "lumensheet") return "sheet";
  if (ext === "lumenpages") return "document";
  if (ext === "lumenkey") return "presentation";
  if (["md", "txt", "json"].includes(ext)) return "note";
  if (ext === "html") return "html";
  return "file";
}

function fileKindLabel(kind) {
  return ({
    image: "Image",
    csv: "CSV",
    document: "Document",
    presentation: "Présentation",
    sheet: "Classeur",
    note: "Note",
    html: "HTML",
    file: "Fichier",
  })[kind] || "Fichier";
}

function iconForFileKind(kind) {
  if (kind === "image") return ICONAPP_imagestudio;
  if (kind === "csv") return ICON.database;
  if (kind === "sheet") return ICONAPP_tables;
  if (kind === "document") return ICONAPP_pages;
  if (kind === "presentation") return ICONAPP_keynote;
  if (kind === "note") return ICON.note;
  return ICON.folder;
}

function relativeTime(ts) {
  if (!ts) return tt("Date inconnue");
  const ms = ts * 1000;
  const diff = Date.now() - ms;
  if (diff < 60_000) return tt("À l'instant");
  if (diff < 3_600_000) return Math.max(1, Math.round(diff / 60_000)) + " min";
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + " h";
  if (diff < 7 * 86_400_000) return Math.round(diff / 86_400_000) + " j";
  try { return new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "short" }); } catch { return ""; }
}

async function refreshTimelineWidget(c) {
  const list = c.querySelector(".dt-wtl-list");
  if (!list) return;
  list.innerHTML = `<div class="dt-w-empty">${tt("Chargement…")}</div>`;
  const ctxData = await collectWorkspaceContext({ maxFiles: 90 });
  const events = [];
  for (const file of ctxData.files) {
    const kind = fileKind(file);
    events.push({
      group: "files",
      ts: file.modified || 0,
      title: file.name,
      meta: `${tt(fileKindLabel(kind))}${file.folder ? " · " + file.folder : ""}`,
      icon: iconForFileKind(kind),
      // Les formats tabulaires (classeurs, CSV) gardent leur vert d'un bout à
      // l'autre : même repère de couleur que dans l'explorateur de fichiers.
      tone: kind === "sheet" || kind === "csv" ? "data" : "",
      path: file.path,
    });
  }
  for (const entry of ctxData.activity) {
    events.push({
      group: "agents",
      ts: Number(entry.ts || 0),
      title: entry.task || tt("Tâche agent"),
      meta: `${entry.agent?.name || tt("Agent")}${entry.success === false ? " · " + tt("Échec") : ""}`,
      icon: entry.success === false ? ICON.bell : ICON.agents,
    });
  }
  const usage = getOllamaTodayUsage();
  if ((usage.total || 0) || (usage.images || 0)) {
    events.push({
      group: "ai",
      ts: Math.floor((usage.updatedAt || Date.now()) / 1000),
      title: tt("Usage IA aujourd'hui"),
      meta: `${(usage.total || 0).toLocaleString()} tok · ${(usage.images || 0).toLocaleString()} images`,
      icon: ICON.tokens,
    });
  }
  const filter = c._filter || "all";
  const filtered = events
    .filter((e) => filter === "all" || e.group === filter)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 16);
  if (!filtered.length) {
    list.innerHTML = `<div class="dt-w-empty">${tt("Aucune activité.")}</div>`;
    return;
  }
  list.innerHTML = "";
  for (const ev of filtered) {
    const row = document.createElement("div");
    row.className = "dt-wtl-row";
    row.innerHTML = `
      <span class="dt-wtl-dot${ev.tone ? " tone-" + ev.tone : ""}">${ev.icon}</span>
      <span class="dt-wtl-main"><b>${escapeHtml(ev.title)}</b><small>${escapeHtml(ev.meta)}</small></span>
      <span class="dt-wtl-time">${escapeHtml(relativeTime(ev.ts))}</span>`;
    if (ev.path) {
      row.title = ev.path;
      row.addEventListener("dblclick", () => {
        try { window.dispatchEvent(new CustomEvent("sandbox-open-path", { detail: { path: ev.path } })); } catch {}
      });
    }
    list.appendChild(row);
  }
}

function relationScore(a, b) {
  const pa = a.path.toLowerCase(), pb = b.path.toLowerCase();
  const sa = pa.split("/").pop().replace(/\.[^.]+$/, "");
  const sb = pb.split("/").pop().replace(/\.[^.]+$/, "");
  if (a.folder && a.folder === b.folder) return 3;
  if (sa && sb && (sa.includes(sb) || sb.includes(sa))) return 4;
  if (pa.includes("analysis/") && b.ext === "csv") return 3;
  if (pa.includes("moodboard/") && fileKind(b) === "image") return 2;
  return 0;
}

function buildGraphModel(ctxData) {
  const nodes = [];
  const links = [];
  const addNode = (node) => {
    if (nodes.some((n) => n.id === node.id)) return;
    nodes.push(node);
  };
  addNode({ id: "sandbox", label: ctxData.sandbox?.name || tt("Sandbox"), kind: "sandbox", icon: ICON.folder });
  const groups = new Map();
  for (const f of ctxData.files.slice(0, 70)) {
    const kind = fileKind(f);
    const group = kind === "document" || kind === "presentation" ? "docs" : kind === "image" ? "images" : kind === "csv" || kind === "sheet" ? "data" : f.folder || "files";
    if (!groups.has(group)) {
      groups.set(group, { id: "group:" + group, label: group === "docs" ? tt("Documents") : group === "images" ? tt("Images") : group === "data" ? tt("Données") : group, kind: "group", icon: kind === "image" ? ICONAPP_imagestudio : ICON.folder });
    }
    addNode(groups.get(group));
    addNode({ id: "file:" + f.path, label: f.name, kind, icon: iconForFileKind(kind), path: f.path, modified: f.modified });
    links.push({ from: "sandbox", to: groups.get(group).id, kind: "contains" });
    links.push({ from: groups.get(group).id, to: "file:" + f.path, kind: "contains" });
  }
  for (const agent of ctxData.agents.slice(0, 8)) {
    addNode({ id: "agent:" + agent.id, label: agent.name || tt("Agent"), kind: "agent", icon: ICON.agents });
    links.push({ from: "sandbox", to: "agent:" + agent.id, kind: "agent" });
  }
  const interesting = ctxData.files.filter((f) => ["csv", "lumenpages", "lumenkey", "md", "html", "png", "jpg", "jpeg", "webp"].includes(f.ext)).slice(0, 40);
  for (let i = 0; i < interesting.length; i += 1) {
    for (let j = i + 1; j < interesting.length; j += 1) {
      const score = relationScore(interesting[i], interesting[j]);
      if (score >= 3) links.push({ from: "file:" + interesting[i].path, to: "file:" + interesting[j].path, kind: "related", score });
    }
  }
  return { nodes, links };
}

async function refreshContextGraphWidget(c) {
  const svg = c.querySelector(".dt-wcg-svg");
  const side = c.querySelector(".dt-wcg-side");
  if (!svg || !side) return;
  svg.innerHTML = "";
  side.innerHTML = `<div class="dt-w-empty">${tt("Chargement…")}</div>`;
  const ctxData = await collectWorkspaceContext({ maxFiles: 100 });
  const graph = buildGraphModel(ctxData);
  renderContextGraph(c, graph);
}

function renderContextGraph(c, graph) {
  const svg = c.querySelector(".dt-wcg-svg");
  const side = c.querySelector(".dt-wcg-side");
  const nodes = graph.nodes.slice(0, 42);
  const ids = new Set(nodes.map((n) => n.id));
  const links = graph.links.filter((l) => ids.has(l.from) && ids.has(l.to)).slice(0, 80);
  const center = nodes.find((n) => n.id === "sandbox") || nodes[0];
  const others = nodes.filter((n) => n !== center);
  const pos = new Map();
  pos.set(center.id, { x: 180, y: 110 });
  others.forEach((n, i) => {
    const ring = i < 10 ? 72 : 104;
    const angle = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.id, { x: 180 + Math.cos(angle) * ring, y: 110 + Math.sin(angle) * ring });
  });
  svg.innerHTML = "";
  for (const link of links) {
    const a = pos.get(link.from), b = pos.get(link.to);
    if (!a || !b) continue;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    line.setAttribute("class", "dt-wcg-link " + (link.kind || ""));
    svg.appendChild(line);
  }
  for (const node of nodes) {
    const p = pos.get(node.id);
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "dt-wcg-node " + node.kind);
    g.setAttribute("transform", `translate(${p.x} ${p.y})`);
    g.innerHTML = `<circle r="${node.id === "sandbox" ? 15 : 10}"></circle><text y="${node.id === "sandbox" ? 29 : 22}">${escapeHtml(shortLabel(node.label, 14))}</text>`;
    g.addEventListener("click", () => renderGraphDetails(side, node, graph));
    svg.appendChild(g);
  }
  renderGraphDetails(side, center, graph);
}

function shortLabel(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function renderGraphDetails(side, node, graph) {
  const connected = graph.links
    .filter((l) => l.from === node.id || l.to === node.id)
    .map((l) => graph.nodes.find((n) => n.id === (l.from === node.id ? l.to : l.from)))
    .filter(Boolean)
    .slice(0, 8);
  side.innerHTML = `
    <div class="dt-wcg-detail">
      <div class="dt-wcg-detail-head"><span>${node.icon || ICON.graph}</span><b>${escapeHtml(node.label)}</b></div>
      ${node.path ? `<small>${escapeHtml(node.path)}</small>` : ""}
      <div class="dt-wcg-count">${connected.length} ${tt("liens")}</div>
    </div>
    <div class="dt-wcg-rel"></div>`;
  const rel = side.querySelector(".dt-wcg-rel");
  if (!connected.length) {
    rel.innerHTML = `<div class="dt-w-empty">${tt("Aucun lien direct.")}</div>`;
    return;
  }
  for (const n of connected) {
    const row = document.createElement("div");
    row.className = "dt-wcg-rel-row";
    row.innerHTML = `<span>${n.icon || ICON.graph}</span><b>${escapeHtml(n.label)}</b>`;
    rel.appendChild(row);
  }
}

// ===== Widget « Modèle actif » =====
let lastTps = 0;
function fmtBytes(b) { const gb = b / 1073741824; return gb >= 1 ? gb.toFixed(1) + " Go" : (b / 1048576).toFixed(0) + " Mo"; }
// Libellé humain d'une source d'IA, pour la ligne d'état du widget.
const MODEL_SOURCE_LABELS = {
  ollama: "Ollama",
  llama: "llama-server",
  applefm: "Apple Foundation Models",
  api: "API cloud",
  lumen: "Lumen Server",
  litert: "LiteRT-LM",
  shortcut: "Raccourci Apple",
};

async function refreshModelWidget(c) {
  const source = aiSourceNow() || "ollama";
  const url = localStorage.getItem("ollamaUrl") || "http://localhost:11434";
  const setSource = (label) => {
    const el = c.querySelector(".dt-wm-source");
    if (el) el.textContent = tt(label || MODEL_SOURCE_LABELS[source] || source);
  };
  setSource();

  // ---- Apple Foundation Models (macOS 27) --------------------------------
  // Le modèle vit DANS le système : il n'y a ni fichier sur le disque, ni
  // processus à interroger, ni empreinte mémoire que Lumen puisse mesurer —
  // c'est le système qui charge et décharge. Afficher « Non chargé » comme
  // pour Ollama aurait été faux : la bonne question ici est « Apple
  // Intelligence répond-il ? », et c'est `applefm_status` qui y répond.
  if (source === "applefm") {
    const id = localStorage.getItem("applefmModel") || APPLEFM_DEFAULT_MODEL;
    const known = APPLEFM_MODELS.find((m) => m.id === id);
    c.querySelector(".dt-wm-name").textContent = tt(known?.label || id);
    c.querySelector(".dt-wm-tps").textContent = lastTps ? lastTps.toFixed(1) + " tok/s" : "—";
    const st = await appleFmBackendState().catch(() => null);
    const model = (st?.models || []).find((m) => m.id === id);
    const ok = !!st?.available && (model ? model.available : true);
    const dot = c.querySelector(".dt-wm-dot"), state = c.querySelector(".dt-wm-state");
    dot.classList.toggle("on", ok);
    state.textContent = ok
      ? tt(id === "apple-private-cloud" ? "Prêt · Private Cloud Compute" : "Prêt · sur l'appareil")
      : appleFmReasonText(model?.reason || st?.reason || "unavailable");
    // La mémoire est celle du système, pas la nôtre : le dire vaut mieux que
    // d'afficher un chiffre inventé.
    c.querySelector(".dt-wm-ram").textContent = ok ? tt("système") : "—";
    const ctx = Number(model?.context_size || localStorage.getItem(`applefmContext:${id}`) || 0);
    c.querySelector(".dt-wm-ctx").textContent = ctx ? `${ctx.toLocaleString()} tok` : tt("défaut");
    return;
  }

  // ---- Sources distantes (API cloud, Lumen Server) -----------------------
  // Rien à charger localement : le modèle tourne ailleurs. On affiche le
  // modèle retenu et l'état de la liaison, pas une RAM qui n'existe pas ici.
  if (isApiLike(source)) {
    const model = localStorage.getItem(cloudModelKey(source)) || "—";
    c.querySelector(".dt-wm-name").textContent = model;
    c.querySelector(".dt-wm-tps").textContent = lastTps ? lastTps.toFixed(1) + " tok/s" : "—";
    const dot = c.querySelector(".dt-wm-dot"), state = c.querySelector(".dt-wm-state");
    let ok = !!model && model !== "—";
    if (source === "lumen") {
      const st = await lumenServerBackendState().catch(() => null);
      ok = ok && !!st?.available;
    }
    dot.classList.toggle("on", ok);
    state.textContent = ok ? tt("Distant · prêt") : tt("Aucun modèle choisi");
    c.querySelector(".dt-wm-ram").textContent = tt("distant");
    const ctx = parseInt(localStorage.getItem("apiNumCtx") || "0", 10);
    c.querySelector(".dt-wm-ctx").textContent = ctx ? `${ctx.toLocaleString()} tok` : tt("défaut");
    return;
  }

  // ---- Modèles locaux (llama-server, Ollama) -----------------------------
  const model = localStorage.getItem("selectedModel") || "—";
  c.querySelector(".dt-wm-name").textContent = model;
  c.querySelector(".dt-wm-tps").textContent = lastTps ? lastTps.toFixed(1) + " tok/s" : "—";
  let running = null;
  let context = parseInt(localStorage.getItem("ollamaNumCtx") || "0", 10);
  let backendError = false;
  if (source === "llama") {
    try {
      const status = await invoke("llama_status");
      const models = await invoke("llama_list_models");
      const active = status?.running && status.model ? status.model : null;
      const diskModel = (Array.isArray(models) ? models : []).find((m) => m.filename === active);
      if (active) c.querySelector(".dt-wm-name").textContent = active;
      context = Number(status?.ctx_size || context || 0);
      // Le statut du processus est la source de vérité. La présence du fichier
      // dans la liste locale ne doit pas faire repasser le widget en « inactif »
      // si la liste est momentanément indisponible ou si le nom a été aliasé.
      running = active ? {
        name: active,
        size: Number(diskModel?.size || 0),
        context_length: context,
      } : null;
    } catch { backendError = true; }
  } else {
    try {
      const d = await ollamaGetJson("api/ps", url);
      running = (d.models || []).find((m) => m.name === model || m.model === model) || (d.models || [])[0] || null;
    } catch {}
  }
  const dot = c.querySelector(".dt-wm-dot"), state = c.querySelector(".dt-wm-state");
  if (running) {
    dot.classList.add("on"); state.textContent = source === "llama" ? "En mémoire · llama-server" : tt("Chargé en mémoire");
    c.querySelector(".dt-wm-ram").textContent = fmtBytes(running.size_vram || running.size || 0);
    const ctx = running.context_length || running?.details?.context_length || context;
    c.querySelector(".dt-wm-ctx").textContent = ctx ? `${ctx.toLocaleString()} tok` : tt("défaut");
  } else {
    dot.classList.remove("on");
    state.textContent = source === "llama"
      ? (backendError ? tt("Statut llama-server indisponible") : tt("llama-server arrêté"))
      : tt("Non chargé");
    c.querySelector(".dt-wm-ram").textContent = "—";
    const ctx = context;
    c.querySelector(".dt-wm-ctx").textContent = ctx ? `${ctx.toLocaleString()} tok` : tt("défaut");
  }
}
// Rafraîchit tous les widgets « Modèle » ouverts (après une génération, etc.).
function refreshModelWidgets() {
  widgetsLayer?.querySelectorAll(".dt-w-model:not(.dt-w-tokens)").forEach((c) => refreshModelWidget(c));
}
function refreshTokensWidget(c) {
  const u = getOllamaTodayUsage();
  // Le compteur additionne TOUTES les sources (Ollama, llama-server, API,
  // Apple Foundation Models) : la passerelle Apple renvoie bien `usage` au
  // format OpenAI, que `recordOllamaUsage` sait lire. On nomme la source
  // courante pour que le total ne soit pas attribué au mauvais backend.
  const src = aiSourceNow() || "ollama";
  const srcEl = c.querySelector(".dt-wtok-source");
  if (srcEl) srcEl.textContent = tt(MODEL_SOURCE_LABELS[src] || src);
  c.querySelector(".dt-wtok-total").textContent = `${(u.total || 0).toLocaleString()} tok`;
  c.querySelector(".dt-wtok-gen").textContent = (u.generated || 0).toLocaleString();
  c.querySelector(".dt-wtok-prompt").textContent = (u.prompt || 0).toLocaleString();
  c.querySelector(".dt-wtok-calls").textContent = (u.calls || 0).toLocaleString();
  c.querySelector(".dt-wtok-images").textContent = (u.images || 0).toLocaleString();
}
function refreshTokenWidgets() {
  widgetsLayer?.querySelectorAll(".dt-w-tokens").forEach((c) => refreshTokensWidget(c));
}
// ===== Widget « Agenda du jour » =====
//
// Trois sources que rien ne réunissait sur le bureau : les rappels du
// Calendrier, les tâches d'agents qui portent une échéance, et les workflows
// Fluxo planifiés en CRON. Le Calendrier les fusionne déjà pour sa grille
// mensuelle ; ici on ne garde que la journée en cours, parce que c'est la
// seule question qu'on pose à un coup d'œil.
const AGENDA_KIND_ICON = { reminder: "calendar", agent: "agents", workflow: "workflow" };

/// Occurrences du jour d'une expression CRON à 6 champs. Volontairement
/// limité aux expressions « tous les jours » (jour, mois et jour de semaine à
/// `*`) : les autres demanderaient un vrai évaluateur, que le backend possède
/// déjà et qu'on ne redouble pas ici pour une vignette.
function cronTodayTimes(expr, day) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 6) return [];
  const [sec, min, hour, dom, mon, dow] = f;
  if (![dom, mon, dow].every((v) => v === "*")) return [];
  const minute = /^\d+$/.test(min) ? Number(min) : 0;
  const seconds = /^\d+$/.test(sec) ? Number(sec) : 0;
  const hours = /^\d+$/.test(hour) ? [Number(hour)] : [];
  return hours.map((h) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, minute, seconds).getTime());
}

async function refreshAgendaWidget(c) {
  const now = Date.now();
  const today = new Date();
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayEnd = dayStart + 86400000;
  const items = [];

  try {
    const raw = await invoke("reminders_load");
    for (const r of (raw ? JSON.parse(raw) : [])) {
      if (r?.done || typeof r.due_at !== "number") continue;
      if (r.due_at < dayStart || r.due_at >= dayEnd) continue;
      items.push({ at: r.due_at, title: r.title || "(rappel)", sub: r.note || "", kind: "reminder" });
    }
  } catch { /* rappels indisponibles */ }

  try {
    for (const a of (await invoke("agent_list")) || []) {
      for (const t of a.tasks || []) {
        if (t.done || t.due == null) continue;
        const at = t.due * 1000;
        if (at < dayStart || at >= dayEnd) continue;
        items.push({ at, title: t.text || "(tâche)", sub: a.name || "Agent", kind: "agent" });
      }
    }
  } catch { /* app Agents absente */ }

  try {
    for (const sch of (await invoke("list_workflow_schedules")) || []) {
      for (const at of cronTodayTimes(sch.expr, today)) {
        items.push({ at, title: sch.name || "(workflow)", sub: tt("Automatisation"), kind: "workflow" });
      }
    }
  } catch { /* pas de planification */ }

  items.sort((a, b) => a.at - b.at);
  const upcoming = items.filter((i) => i.at >= now);
  const next = upcoming[0];
  const nextTime = c.querySelector(".dt-wag-next-time");
  const nextTitle = c.querySelector(".dt-wag-next-title");
  if (next) {
    nextTime.textContent = new Date(next.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    nextTitle.textContent = next.title;
    c.querySelector(".dt-wag-next").classList.toggle("soon", next.at - now <= 15 * 60000);
  } else {
    nextTime.textContent = "—";
    nextTitle.textContent = items.length ? tt("Plus rien aujourd'hui.") : tt("Journée libre.");
    c.querySelector(".dt-wag-next").classList.remove("soon");
  }

  const list = c.querySelector(".dt-wag-list");
  list.innerHTML = "";
  // Les échéances PASSÉES du jour restent affichées, estompées : savoir qu'on a
  // laissé filer le point de 10 h vaut mieux que de le voir disparaître.
  const shown = items.slice(0, 6);
  if (!shown.length) {
    list.innerHTML = `<div class="dt-w-empty">${tt("Aucune échéance aujourd'hui.")}</div>`;
    return;
  }
  for (const it of shown) {
    const row = document.createElement("div");
    row.className = "dt-wa-row" + (it.at < now ? " past" : "");
    row.innerHTML = `<span class="dt-wa-ic">${lumenIcon(AGENDA_KIND_ICON[it.kind] || "calendar")}</span>` +
      `<span class="dt-wa-main"><b>${escapeHtml(it.title)}</b>${it.sub ? `<small>${escapeHtml(it.sub)}</small>` : ""}</span>` +
      `<span class="dt-wa-date">${new Date(it.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>`;
    list.appendChild(row);
  }
}
function refreshAgendaWidgets() {
  widgetsLayer?.querySelectorAll(".dt-w-agenda").forEach((c) => refreshAgendaWidget(c));
}
window.__TAURI__?.event?.listen?.("reminders-updated", () => refreshAgendaWidgets());

// ===== Widget « Boîte de réception » =====
// Les agents écrivent dans le Fil (inbox.rs) et rien sur le bureau ne le
// disait : on découvrait ses messages en ouvrant l'app. Le widget montre le
// nombre de non-lus et les quatre derniers ; un clic ouvre le message.
async function refreshInboxWidget(c) {
  let messages = [];
  try {
    const raw = await invoke("inbox_load");
    messages = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(messages)) messages = [];
  } catch { messages = []; }
  const unread = messages.filter((m) => !m.read).length;
  const sub = c.querySelector(".dt-wib-sub");
  sub.textContent = unread
    ? `${unread} ${tt(unread > 1 ? "messages non lus" : "message non lu")}`
    : tt("Tout est lu.");
  sub.classList.toggle("unread", unread > 0);

  const list = c.querySelector(".dt-wib-list");
  list.innerHTML = "";
  if (!messages.length) {
    list.innerHTML = `<div class="dt-w-empty">${tt("Aucun message.")}</div>`;
    return;
  }
  for (const m of messages.slice(0, 4)) {
    const row = document.createElement("div");
    row.className = "dt-wa-row dt-wib-row" + (m.read ? "" : " unread");
    const when = new Date((m.ts || 0) * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    row.innerHTML = `<span class="dt-wa-ic">${lumenIcon("inbox")}</span>` +
      `<span class="dt-wa-main"><b>${escapeHtml(m.subject || tt("(sans objet)"))}</b><small>${escapeHtml(m.from || "")}</small></span>` +
      `<span class="dt-wa-date">${when}</span>`;
    row.addEventListener("click", () => openAppById("inbox"));
    list.appendChild(row);
  }
}
function refreshInboxWidgets() {
  widgetsLayer?.querySelectorAll(".dt-w-inbox").forEach((c) => refreshInboxWidget(c));
}
window.__TAURI__?.event?.listen?.("inbox-updated", () => refreshInboxWidgets());

// ===== Widget « Santé du poste » =====
// Répond à une seule question, celle qu'on se pose avant de lancer une grosse
// génération : est-ce que la machine peut encaisser ? Mémoire, disque, quota
// de la sandbox courante, moteur actif et serveurs d'inférence en cours.
function healthPct(used, total) {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
}
function setGauge(c, name, pct, label) {
  const g = c.querySelector(`.dt-wh-gauge[data-g="${name}"]`);
  if (!g) return;
  g.querySelector(".dt-w-storage-fill").style.width = pct + "%";
  g.querySelector(".dt-wh-gval").textContent = label;
  g.classList.toggle("warn", pct >= 80);
  g.classList.toggle("bad", pct >= 92);
}
async function refreshHealthWidget(c) {
  let ramPct = 0;
  let procs = [];

  try {
    const st = await invoke("profiler_system_stats");
    const total = Number(st?.total_memory || 0);
    const used = Number(st?.used_memory || 0);
    ramPct = healthPct(used, total);
    setGauge(c, "ram", ramPct, total ? `${fmtBytes(used)} / ${fmtBytes(total)}` : "—");
    procs = Array.isArray(st?.processes) ? st.processes : [];
  } catch { setGauge(c, "ram", 0, "—"); }

  // Le disque en CHIFFRE et non en jauge : `system_resources` rapporte
  // l'espace libre du volume des modèles, pas sa taille totale — un
  // pourcentage serait inventé. Et c'est bien « combien reste-t-il ? » qu'on
  // se demande avant de télécharger un GGUF de 8 Go.
  try {
    const res = await invoke("system_resources");
    const free = Number(res?.free_disk || 0);
    c.querySelector(".dt-wh-disk").textContent = free ? fmtBytes(free) : "—";
  } catch { c.querySelector(".dt-wh-disk").textContent = "—"; }

  const sb = getCurrent();
  if (sb) {
    try {
      const u = await invoke("sandbox_usage", { id: sb.id });
      const pct = healthPct(Number(u.used_bytes || 0), Number(u.max_bytes || 0));
      setGauge(c, "sandbox", pct, `${fmtMB(u.used_bytes)} / ${fmtMB(u.max_bytes)}`);
    } catch { setGauge(c, "sandbox", 0, "—"); }
  } else setGauge(c, "sandbox", 0, "—");

  const source = aiSourceNow() || "ollama";
  c.querySelector(".dt-wh-engine").textContent = tt(MODEL_SOURCE_LABELS[source] || source);

  const box = c.querySelector(".dt-wh-procs");
  box.innerHTML = procs.length
    ? procs.slice(0, 3).map((pr) =>
        `<span class="dt-wh-proc"><b>${escapeHtml(pr.name || "?")}</b> ${fmtBytes(Number(pr.rss || 0))}</span>`).join("")
    : `<span class="dt-wh-proc muted">${tt("Aucun serveur d'inférence en cours.")}</span>`;

  // Verdict : on nomme la contrainte la plus serrée plutôt que d'empiler des
  // pourcentages que personne ne compare de tête.
  const dot = c.querySelector(".dt-wm-dot");
  const verdict = c.querySelector(".dt-wh-verdict");
  if (ramPct >= 92) { dot.classList.remove("on"); verdict.textContent = tt("Mémoire saturée — évitez une grosse génération."); }
  else if (ramPct >= 80) { dot.classList.remove("on"); verdict.textContent = tt("Mémoire tendue."); }
  else { dot.classList.add("on"); verdict.textContent = tt("Prêt à travailler."); }
}
function refreshHealthWidgets() {
  widgetsLayer?.querySelectorAll(".dt-w-health").forEach((c) => refreshHealthWidget(c));
}

// ===== Widget « Journal LLM » =====
// Dernières entrées du log global des agissements des modèles (agents, chat,
// skills, escalades). Rafraîchi en direct par l'événement `llm-log`.
const LLMLOG_KINDS = { call: "Appel", tool: "Outil", delegation: "Délégation", skill: "Skill", compaction: "Compaction", escalation: "Escalade" };
async function refreshLlmLogWidget(c) {
  let entries = [];
  try { entries = (await invoke("llm_log_list", { kind: null })) || []; } catch (e) { entries = []; }
  const list = c.querySelector(".dt-wll-list");
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = `<div class="dt-w-empty">${tt("Aucun agissement enregistré.")}</div>`;
    return;
  }
  list.innerHTML = entries.slice(0, 6).map((e) => {
    const when = new Date((e.ts || 0) * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const kind = tt(LLMLOG_KINDS[e.kind] || e.kind || "?");
    const tok = (e.prompt_tokens || e.gen_tokens) ? ` · ${(e.prompt_tokens || 0) + (e.gen_tokens || 0)} tok` : "";
    return `<div class="dt-wll-row${e.kind === "escalation" ? " esc" : ""}">` +
      `<span class="dt-wll-kind">${_esc(kind)}</span>` +
      `<span class="dt-wll-text">${_esc(e.source || "?")} — ${_esc(String(e.detail || "").slice(0, 80))}${tok}</span>` +
      `<span class="dt-wll-when">${when}</span></div>`;
  }).join("");
}
function refreshLlmLogWidgets() {
  widgetsLayer?.querySelectorAll(".dt-w-llmlog").forEach((c) => refreshLlmLogWidget(c));
}
window.__TAURI__?.event?.listen?.("llm-log", () => refreshLlmLogWidgets());
window.__TAURI__?.event?.listen?.("llm-log-cleared", () => refreshLlmLogWidgets());
window.addEventListener("ollama-usage-updated", () => {
  refreshTokenWidgets();
  refreshTimelineWidgets();
});
// Bascule de backend depuis la barre ou les Réglages : les deux widgets
// nomment la source, ils doivent suivre sans attendre la prochaine génération.
window.addEventListener("storage", (e) => {
  if (e.key && (e.key === "aiSource" || e.key.endsWith(":aiSource"))) {
    refreshModelWidgets();
    refreshTokenWidgets();
  }
});
// L'usage est partagé en localStorage : une génération depuis une autre fenêtre
// (Studio d'images autonome) ou une iframe embarquée déclenche un event `storage`
// ici → on rafraîchit le widget de compteur (tokens & images).
window.addEventListener("storage", (e) => {
  // Accepte aussi l'ancienne clé non profilée utilisée par la barre
  // principale, sinon le widget reste figé à zéro après un appel LLM.
  if (e.key === wsKey("ollamaDailyUsage") || e.key === "ollamaDailyUsage") {
    refreshTokenWidgets();
    refreshTimelineWidgets();
  }
});

function refreshTimelineWidgets() {
  widgetsLayer?.querySelectorAll(".dt-w-timeline").forEach((c) => refreshTimelineWidget(c));
}
function refreshContextGraphWidgets() {
  widgetsLayer?.querySelectorAll(".dt-w-contextgraph").forEach((c) => refreshContextGraphWidget(c));
}
async function refreshStorage(c) {
  const sb = getCurrent(); if (!sb) return;
  try {
    const u = await invoke("sandbox_usage", { id: sb.id });
    const pct = u.max_bytes ? Math.min(100, Math.round(u.used_bytes / u.max_bytes * 100)) : 0;
    c.querySelector(".dt-w-storage-fill").style.width = pct + "%";
    c.querySelector(".dt-w-storage-label").textContent = `${fmtMB(u.used_bytes)} / ${fmtMB(u.max_bytes)} (${pct} %)`;
  } catch {}
}
function fmtMB(b) { return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " Mo"; }

// Persistance des widgets par sandbox (positions + données).
function widgetsKey() { const sb = getCurrent(); return sb ? wsKey("sbDesktop:" + sb.id) : null; }
function saveWidgets() {
  const key = widgetsKey(); if (!key) return;
  const list = [...widgetsLayer.querySelectorAll(".dt-widget")].map((el) => ({
    type: el._wtype, x: parseInt(el.style.left, 10) || 0, y: parseInt(el.style.top, 10) || 0, data: el._wdata || {},
  }));
  lsSet(key, JSON.stringify(list));
}
function restoreWidgets() {
  const key = widgetsKey(); if (!key) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
  if (!list.length) { addWidget({ type: "clock", x: window.innerWidth - 230, y: 40 }, false); saveWidgets(); return; }
  // Widget retiré du catalogue : on purge les instances persistées.
  for (const w of list.filter((w) => w.type !== "contextGraph")) addWidget(w, false);
}

// ===== Fond d'écran personnalisé (image d'une sandbox, persistant) =====
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };
function wallpaperKey() { const sb = getCurrent(); return wsKey(sb ? "dtWallpaper:" + sb.id : "dtWallpaper"); }
function isHexColor(color) { return /^#[0-9a-f]{6}$/i.test(String(color || "")); }
// Le bureau n'a plus SA couleur d'accent : il suit celle de l'apparence
// (`uiAccent` → `data-ui-accent` → `--primary`, cf. lib/tokens.css). Il posait
// avant un hexadécimal libre par-dessus `--accent`, ce qui donnait deux
// couleurs d'action concurrentes dans la même application — celle des Réglages
// et celle du bureau — et cassait le contraste du texte, calculé pour la
// couleur de la palette et non pour celle-là.
function applyAccentColor() {
  applyUiTheme(document);
  // Purge de l'ancien réglage : sans ça, la surcharge inline d'une session
  // précédente survivait au changement d'apparence.
  document.documentElement.style.removeProperty("--accent");
  document.documentElement.style.removeProperty("--accent-color");
  wsRemove("dtAccent");
}
// Nuancier d'accent commun à toute l'application (lib/ui-customizer.js). Une
// pastille = un accent de la palette, dont le contraste du texte est déjà
// calculé — c'est précisément ce qu'un sélecteur de couleur libre ne pouvait
// pas garantir.
function accentSwatches(onPick) {
  const wrap = document.createElement("div");
  wrap.className = "dt-accent-swatches";
  const current = readUiTheme().accent;
  for (const a of UI_ACCENTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dt-accent-sw" + (a.id === current ? " active" : "");
    b.title = a.label;
    b.setAttribute("aria-label", a.label);
    // La pastille se peint elle-même : l'attribut suffit, la valeur vient des
    // jetons. Sans accent (« Palette »), c'est la couleur de la base.
    if (a.id) b.setAttribute("data-ui-accent", a.id);
    b.addEventListener("click", () => {
      saveUiTheme({ accent: a.id });
      applyAccentColor();
      onPick?.(a.id);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

// Le fond enregistré est soit une IMAGE (data: URL, comme avant), soit une
// valeur CSS `background-image` toute faite — c'est ce qui permet aux dégradés
// d'emprunter le même réglage et la même clé de stockage, sans migration : une
// valeur qui ne commence pas par `data:` est du CSS.
function isImageWallpaper(v) { return /^(data:|https?:|sb:)/i.test(String(v || "")); }

// Une image de sandbox est enregistrée par RÉFÉRENCE (`sb:<sandbox>:<chemin>`)
// et non par son contenu : une photo de quelques Mo, encodée en base64, dépasse
// le quota localStorage (~5 Mo) — `setItem` levait alors une exception dans le
// gestionnaire de clic et le fond n'était jamais posé, sans un mot d'erreur.
// Les anciennes valeurs `data:` restent lues telles quelles.
const wallpaperRef = (sandboxId, path) => `sb:${sandboxId}:${path}`;
const parseWallpaperRef = (v) => {
  const m = /^sb:([^:]+):(.+)$/.exec(String(v || ""));
  return m ? { id: m[1], path: m[2] } : null;
};
const wallpaperDataCache = new Map(); // référence → data: URL (une lecture par session)

async function wallpaperDataUrl(value) {
  if (!value.startsWith("sb:")) return value;
  if (wallpaperDataCache.has(value)) return wallpaperDataCache.get(value);
  const ref = parseWallpaperRef(value);
  if (!ref) return "";
  // Passe par le redimensionnement backend : une photo de téléphone dépasse le
  // plafond de 8 Mo de `sandbox_read_b64`, qui refusait la lecture — l'image ne
  // s'appliquait alors jamais, sans message.
  const url = await invoke("sandbox_read_image_b64", { id: ref.id, path: ref.path, maxPx: 2560 });
  wallpaperDataCache.set(value, url);
  return url;
}

async function applyWallpaper() {
  if (!root) return;
  const data = localStorage.getItem(wallpaperKey());
  if (!data) {
    root.style.backgroundImage = "";
    root.style.backgroundSize = "";
    root.style.backgroundPosition = "";
    root.style.backgroundRepeat = "";
    return;
  }
  if (isImageWallpaper(data)) {
    let url = data;
    if (data.startsWith("sb:")) {
      try { url = await wallpaperDataUrl(data); }
      catch (e) {
        // Image supprimée, illisible ou sandbox absente : on ne laisse pas un
        // fond fantôme, et on le dit — l'échec était muet jusqu'ici.
        console.warn("[wallpaper] image indisponible :", e);
        root.style.backgroundImage = "";
        dtToast(tt("Fond d'écran indisponible :") + " " + (e?.message || e));
        return;
      }
    }
    root.style.backgroundImage = `url("${url}")`;
    root.style.backgroundSize = "cover";
    root.style.backgroundPosition = "center";
    root.style.backgroundRepeat = "no-repeat";
  } else {
    root.style.backgroundImage = data;
    root.style.backgroundSize = "cover";
    root.style.backgroundPosition = "";
    root.style.backgroundRepeat = "";
  }
}

/// Enregistre le choix de fond. Renvoie false (et prévient) si le stockage
/// refuse la valeur — cas des anciens fonds `data:` trop volumineux.
function saveWallpaper(value) {
  try {
    // `lsSet` ne lève pas : il renvoie false et prévient déjà si le stockage est
    // plein. On relaie son verdict au lieu de prétendre avoir enregistré.
    if (value) return lsSet(wallpaperKey(), value);
    localStorage.removeItem(wallpaperKey());
    return true;
  } catch (e) {
    console.error("[wallpaper]", e);
    dtToast(tt("Fond d'écran non enregistré : stockage plein."));
    return false;
  }
}

// Dégradés livrés avec le bureau. Chacun est empilé comme le fond par défaut —
// deux halos radiaux sur un dégradé linéaire — parce qu'un dégradé à deux
// couleurs sur un écran entier fait tout de suite « fond de page web » : les
// halos décentrés donnent la profondeur qu'on attend d'un fond de bureau.
const DT_WALLPAPERS = [
  { id: "aurore", name: "Aurore", css: "radial-gradient(120% 90% at 80% 0%, rgba(255,170,190,0.55), transparent 60%), radial-gradient(120% 90% at 0% 100%, rgba(170,200,255,0.55), transparent 60%), linear-gradient(160deg, #fbeef0, #eef1fb 55%, #f1f7f1)" },
  { id: "crepuscule", name: "Crépuscule", css: "radial-gradient(110% 80% at 15% 10%, rgba(255,140,90,0.55), transparent 62%), radial-gradient(120% 90% at 85% 90%, rgba(120,60,180,0.60), transparent 60%), linear-gradient(160deg, #2b1b3d, #43265a 55%, #1d1430)" },
  { id: "abysse", name: "Abysse", css: "radial-gradient(120% 90% at 75% 5%, rgba(40,120,200,0.45), transparent 60%), radial-gradient(110% 85% at 5% 95%, rgba(20,180,180,0.40), transparent 62%), linear-gradient(160deg, #0b1a2b, #10263d 55%, #07131f)" },
  { id: "agrumes", name: "Agrumes", css: "radial-gradient(110% 85% at 10% 0%, rgba(255,214,102,0.75), transparent 60%), radial-gradient(120% 90% at 95% 100%, rgba(255,122,89,0.55), transparent 62%), linear-gradient(160deg, #fff5e0, #ffe9d6 55%, #fff1e8)" },
  { id: "menthe", name: "Menthe", css: "radial-gradient(115% 85% at 85% 5%, rgba(120,230,200,0.55), transparent 60%), radial-gradient(120% 90% at 0% 100%, rgba(150,220,255,0.45), transparent 62%), linear-gradient(160deg, #eefbf4, #e6f5fb 55%, #f2fbf6)" },
  { id: "encre", name: "Encre", css: "radial-gradient(120% 90% at 20% 0%, rgba(90,90,120,0.45), transparent 62%), radial-gradient(110% 80% at 100% 100%, rgba(50,50,70,0.55), transparent 60%), linear-gradient(160deg, #16161c, #1e1e26 55%, #101014)" },
  { id: "lavande", name: "Lavande", css: "radial-gradient(115% 85% at 70% 0%, rgba(190,160,255,0.55), transparent 60%), radial-gradient(120% 90% at 10% 100%, rgba(255,170,220,0.45), transparent 62%), linear-gradient(160deg, #f5f0ff, #f8eefb 55%, #f1f0fb)" },
  { id: "foret", name: "Forêt", css: "radial-gradient(120% 90% at 80% 10%, rgba(80,200,140,0.35), transparent 60%), radial-gradient(110% 85% at 0% 90%, rgba(30,120,90,0.55), transparent 62%), linear-gradient(160deg, #10251c, #16342a 55%, #0b1a14)" },
  { id: "corail", name: "Corail", css: "radial-gradient(115% 85% at 15% 5%, rgba(255,120,150,0.60), transparent 60%), radial-gradient(120% 90% at 90% 95%, rgba(255,190,120,0.55), transparent 62%), linear-gradient(160deg, #fff0f2, #ffeae2 55%, #fff5f0)" },
  { id: "nuit-bleue", name: "Nuit bleue", css: "radial-gradient(120% 90% at 85% 0%, rgba(60,90,220,0.45), transparent 60%), radial-gradient(110% 85% at 10% 100%, rgba(150,60,200,0.40), transparent 62%), linear-gradient(160deg, #0d1030, #141a44 55%, #090b20)" },
  { id: "sable", name: "Sable", css: "radial-gradient(115% 85% at 10% 0%, rgba(230,205,165,0.70), transparent 62%), radial-gradient(120% 90% at 95% 100%, rgba(200,170,140,0.55), transparent 60%), linear-gradient(160deg, #faf3e8, #f3e8da 55%, #f7f0e6)" },
  { id: "graphite", name: "Graphite", css: "radial-gradient(120% 90% at 75% 5%, rgba(255,255,255,0.10), transparent 60%), radial-gradient(110% 85% at 5% 95%, rgba(120,140,170,0.20), transparent 62%), linear-gradient(160deg, #202028, #2a2a34 55%, #191920)" },
];
async function listSandboxImages(id) {
  const out = [];
  async function walk(path, depth) {
    let list; try { list = await invoke("sandbox_read_dir", { id, path }); } catch { return; }
    for (const e of list) {
      if (e.is_dir) { if (depth < 3) await walk(e.path, depth + 1); }
      else if (IMG_MIME[fileExt(e.name)]) out.push(e);
    }
  }
  await walk("", 0);
  return out;
}
// Fenêtre « Fond d'écran ». C'était un petit panneau ancré au bouton de la
// barre, qui listait les images de la sandbox par leur CHEMIN, sans aperçu :
// impossible de choisir un fond sans le connaître par cœur. On en fait une
// vraie fenêtre du bureau, avec une galerie de dégradés et des vignettes.
//
// Tout s'applique au clic (pas de bouton « Appliquer ») : c'est un réglage
// visuel, on juge sur pièce, et la fenêtre reste ouverte pour essayer autre
// chose.
function openWallpaperWindow() {
  const existing = openWindows.get("wallpaper");
  if (existing) return focusWindow("wallpaper");
  const win = createWindow({
    id: "wallpaper",
    title: tt("Fond d'écran"),
    w: 720, h: 560,
    x: Math.max(40, Math.round((window.innerWidth - 720) / 2)),
    y: Math.max(30, Math.round((window.innerHeight - 560) / 3)),
    icon: ICON.wallpaper,
    grad: ["#0a84ff", "#5e5ce6"],
  });
  win.body.classList.add("dt-wp");
  renderWallpaperWindow(win.body);
  return win;
}

async function renderWallpaperWindow(body) {
  const sb = getCurrent();
  const current = () => localStorage.getItem(wallpaperKey()) || "";

  body.innerHTML = `
    <div class="dt-wp-sec">${tt("Dégradés")}</div>
    <div class="dt-wp-grid" data-grid="grad"></div>
    <div class="dt-wp-sec">${tt("Couleur d'accent")}</div>
    <div class="dt-wp-accent"></div>
    <div class="dt-wp-sec" data-sec="img">${tt("Images de")} « ${escapeHtml(sb?.name || "—")} »</div>
    <div class="dt-wp-grid" data-grid="img"></div>`;

  const gradGrid = body.querySelector('[data-grid="grad"]');
  const imgGrid = body.querySelector('[data-grid="img"]');
  body.querySelector(".dt-wp-accent").appendChild(accentSwatches(() => {}));

  const paintActive = () => {
    const cur = current();
    body.querySelectorAll(".dt-wp-card").forEach((c) => {
      c.classList.toggle("on", (c.dataset.value || "") === cur);
    });
  };

  const card = (value, label, style) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dt-wp-card";
    b.dataset.value = value;
    b.innerHTML = `<span class="dt-wp-thumb" style="${style}"></span><span class="dt-wp-name">${escapeHtml(label)}</span>`;
    b.addEventListener("click", () => {
      if (!saveWallpaper(value)) return;
      applyWallpaper();
      paintActive();
    });
    return b;
  };

  // « Par défaut » d'abord : c'est aussi le moyen de revenir en arrière, et il
  // doit se voir autant que les autres.
  gradGrid.appendChild(card("", tt("Par défaut"), "background:linear-gradient(160deg,#fbeef0,#eef1fb 55%,#f1f7f1)"));
  for (const w of DT_WALLPAPERS) {
    gradGrid.appendChild(card(w.css, tt(w.name), `background:${w.css};background-size:cover`));
  }
  paintActive();

  if (!sb) {
    body.querySelector('[data-sec="img"]').remove();
    imgGrid.remove();
    return;
  }
  imgGrid.innerHTML = `<div class="dt-wp-empty">${tt("Recherche…")}</div>`;
  const imgs = await listSandboxImages(sb.id);
  imgGrid.innerHTML = "";
  if (!imgs.length) {
    imgGrid.innerHTML = `<div class="dt-wp-empty">${tt("Aucune image dans cette sandbox.")}</div>`;
    return;
  }
  // Les vignettes se chargent à l'approche du regard : lire d'un coup le base64
  // de toutes les images d'une sandbox peut représenter des dizaines de Mo, pour
  // des vignettes que l'utilisateur ne fera peut-être jamais défiler.
  const io = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      obs.unobserve(e.target);
      loadThumb(e.target);
    }
  }, { root: body, rootMargin: "120px" });

  async function loadThumb(el) {
    const path = el.dataset.path;
    const ref = wallpaperRef(sb.id, path);
    try {
      // Vignette : une version réduite suffit, et elle passe quelle que soit la
      // taille du fichier d'origine.
      const data = await invoke("sandbox_read_image_b64", { id: sb.id, path, maxPx: 480 });
      el.dataset.value = ref;
      el.querySelector(".dt-wp-thumb").style.backgroundImage = `url("${data}")`;
      el.classList.remove("loading");
      if (ref === current()) el.classList.add("on");
    } catch (e) {
      el.classList.remove("loading");
      el.classList.add("failed");
      el.title = `${el.dataset.path} — ${e?.message || e}`;
    }
  }

  for (const en of imgs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dt-wp-card loading";
    b.dataset.path = en.path;
    b.dataset.value = wallpaperRef(sb.id, en.path);
    b.title = en.path;
    b.innerHTML = `<span class="dt-wp-thumb"></span><span class="dt-wp-name">${escapeHtml(en.name)}</span>`;
    b.addEventListener("click", () => {
      // Tant que la vignette n'est pas lue, il n'y a rien à appliquer : on la
      // charge à la demande, puis on pose le fond.
      const apply = () => {
        if (!b.dataset.value) return;
        if (!saveWallpaper(b.dataset.value)) return;
        applyWallpaper();
        paintActive();
      };
      if (b.dataset.value) apply();
      else loadThumb(b).then(apply);
    });
    imgGrid.appendChild(b);
    io.observe(b);
  }
}

// ===== Fenêtre Réglages (onglets) =====
// Regroupe dans le bureau les réglages disponibles dans la barre Lumen de base.
// Tout est persisté sur les MÊMES clés localStorage (partagées entre webviews
// même-origine) et via les mêmes commandes Tauri, donc parfaitement synchrone
// avec la barre principale.
const SETTINGS_TABS = [
  { id: "general", label: "Général" },
  { id: "model", label: "Modèle" },
  { id: "prompt", label: "Invite système" },
  { id: "voice", label: "Voix" },
  { id: "advanced", label: "Avancé" },
];

async function openSettings() {
  return openAppFrame("settings", "Paramètres", "/settings/settings.html", 980, 720);
}

// Ouvre les Réglages sur un onglet (et une section à mettre en évidence).
// Fenêtre déjà ouverte : on y navigue (settings/main.js, __settingsGo).
function openSettingsAt(tab, focus = "") {
  const win = openWindows.get("settings");
  const frame = win?.el?.querySelector("iframe.dt-appframe");
  if (frame?.contentWindow?.__settingsGo) {
    focusWindow("settings");
    frame.contentWindow.__settingsGo(tab, focus);
    return;
  }
  if (win) closeWindow("settings");
  const q = new URLSearchParams({ tab, ...(focus ? { focus } : {}) });
  return openAppFrame("settings", "Paramètres", `/settings/settings.html?${q}`, 980, 720);
}

// Accès rapides aux réglages courants depuis la recherche globale. `k` : mots
// cherchés (FR + EN, sans accents) en plus du libellé.
const QUICK_SETTINGS = [
  { label: "Apparence", hint: "Thème clair/sombre, couleurs, coins", icon: "sparkles", tab: "appearance", focus: "select-theme", k: "theme sombre clair dark light couleur accent appearance look style" },
  { label: "Fond d'écran", hint: "Image du bureau", icon: "image", tab: "appearance", focus: "btn-wallpaper", k: "fond ecran wallpaper background image bureau" },
  { label: "Avatar", hint: "Orbe, personnage et animations", icon: "user", tab: "appearance", focus: "avatar-settings", k: "avatar orbe orb personnage character mascotte" },
  { label: "Profil", hint: "Nom, rôle, ton et langue des réponses", icon: "user", tab: "profile", k: "profil profile nom name prenom role ton tutoiement" },
  { label: "Compagnon mobile", hint: "Téléphone, QR de connexion, appareils de confiance", icon: "smartphone", tab: "companion", k: "compagnon companion mobile telephone phone iphone android qr appareil" },
  { label: "Modèles IA", hint: "Backend, modèle, API cloud, contexte", icon: "cpu", tab: "models", k: "modele model llm ia ai backend ollama llama api openai cle key contexte gguf" },
  { label: "Intelligence hybride", hint: "Escalade vers l'API cloud après un échec local", icon: "sparkles", tab: "general", focus: "hybrid-card", k: "intelligence hybride hybrid escalade api cloud acces fichiers actions modeles locaux autorisations permissions copilot" },
  { label: "Moteur de décision", hint: "Tev1, Laya ou Clef Flash : aiguillage rapide des demandes", icon: "cpu", tab: "models", focus: "settings-decision", k: "decision tev1 routeur router aiguillage" },
  { label: "Dictée et voix", hint: "Micro, Whisper, voix de lecture", icon: "mic", tab: "voice", k: "voix voice dictee dictation micro whisper piper lecture parole tts" },
  { label: "Notifications", hint: "Alertes, sons, capsule", icon: "bell", tab: "notifications", k: "notification notifs alerte son sound" },
  { label: "Mémoire", hint: "Souvenirs et accès de l'IA", icon: "database", tab: "memory", k: "memoire memory souvenir oublier" },
  { label: "Boîte à outils", hint: "Outils proposés à l'IA", icon: "wrench", tab: "toolbox", k: "outil outils tools toolbox" },
  { label: "Connecteurs", hint: "MCP et services distants", icon: "plug", tab: "mcp", k: "connecteur connecteurs mcp integration service" },
  { label: "Objets connectés", hint: "Domotique, ESP32, appareils", icon: "cpu", tab: "devices", k: "objets connectes devices domotique esp32 iot" },
  { label: "Langue", hint: "Langue de l'interface", icon: "globe", tab: "general", focus: "select-language", k: "langue language anglais english francais" },
  { label: "Sauvegarde et mises à jour", hint: "Archive, restauration, version", icon: "download", tab: "maintenance", k: "sauvegarde backup restaurer restore mise a jour update version" },
  { label: "Applications et licence", hint: "Apps installées, licence", icon: "layout-grid", tab: "licence", k: "application apps licence license installer" },
  { label: "Telegram", hint: "Passerelle Telegram", icon: "send", tab: "telegram", k: "telegram bot" },
  { label: "Slack", hint: "Passerelle Slack", icon: "messages-square", tab: "slack", k: "slack" },
];
const normSearch = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Synchronise la config Ollama backend (URL + modèle), comme la barre Lumen.
function pushOllamaConfig() {
  // Les apps packagées ouvertes suivent le même réglage (elles vivent sur une
  // autre origine et ne voient pas notre localStorage).
  broadcastSettings();
  invoke("set_ollama_config", {
    url: localStorage.getItem("ollamaUrl") || "http://localhost:11434",
    model: localStorage.getItem("selectedModel") || "",
    backend: rustBackend(aiSourceNow()),
    apiBase: localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1",
    apiKey: localStorage.getItem("apiKey") || "",
    apiModel: localStorage.getItem(cloudModelKey(aiSourceNow())) || "",
    systemPrompt: localStorage.getItem("systemPrompt") || "",
  }).catch(() => {});
}

function settingsField(label, inner, hint) {
  return `<label class="dt-set-field"><span class="dt-set-label">${escapeHtml(label)}</span>${inner}${hint ? `<span class="dt-set-hint">${escapeHtml(hint)}</span>` : ""}</label>`;
}

function renderSettingsPane(id, body) {
  if (id === "general") return renderSettingsGeneral(body);
  if (id === "model") return renderSettingsModel(body);
  if (id === "prompt") return renderSettingsPrompt(body);
  if (id === "voice") return renderSettingsVoice(body);
  if (id === "advanced") return renderSettingsAdvanced(body);
}

function renderSettingsGeneral(body) {
  const theme = wsGet("dtTheme") || "";
  const lang = (localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  body.innerHTML = `
    <div class="dt-set-sect">
      ${settingsField(tt("Thème du bureau"), `
        <select data-k="theme">
          <option value="">${tt("Automatique (système)")}</option>
          <option value="dark"${theme === "dark" ? " selected" : ""}>${tt("Sombre")}</option>
          <option value="light"${theme === "light" ? " selected" : ""}>${tt("Clair")}</option>
        </select>`)}
      ${settingsField(tt("Couleur d'accent"), `<span data-accent-host></span>`,
        tt("Partagée avec toute l'application (Réglages › Apparence)."))}
      ${settingsField(tt("Langue"), `
        <select data-k="lang">
          <option value="fr"${lang === "fr" ? " selected" : ""}>Français</option>
          <option value="en"${lang === "en" ? " selected" : ""}>English</option>
        </select>`, tt("Prise en compte complète au prochain démarrage."))}
    </div>`;
  body.querySelector('[data-k="theme"]').addEventListener("change", (e) => {
    const v = e.target.value;
    applyTheme(v);
    if (v) wsSet("dtTheme", v); else wsRemove("dtTheme");
  });
  body.querySelector("[data-accent-host]")?.appendChild(
    accentSwatches(() => renderSettingsGeneral(body)));
  body.querySelector('[data-k="lang"]').addEventListener("change", (e) => {
    lsSet("lang", e.target.value);
  });
}

async function renderSettingsModel(body) {
  const url = localStorage.getItem("ollamaUrl") || "http://localhost:11434";
  const cur = localStorage.getItem("selectedModel") || "";
  const mode = getMode();
  const numCtx = parseInt(localStorage.getItem("ollamaNumCtx") || "0", 10);
  const keepAlive = localStorage.getItem("ollamaKeepAlive") || "5m";
  const think = localStorage.getItem("ollamaThink") === "true";
  body.innerHTML = `
    <div class="dt-set-sect">
      ${settingsField(tt("URL Ollama"), `<input type="text" data-k="url" value="${escapeHtml(url)}" spellcheck="false" />`)}
      ${settingsField(tt("Modèle"), `<select data-k="model"><option value="${escapeHtml(cur)}">${escapeHtml(cur || tt("Chargement…"))}</option></select>`)}
      ${settingsField(tt("Mode"), `
        <select data-k="mode">
          ${Object.entries(MODE_LABELS).map(([v, l]) => `<option value="${v}"${v === mode ? " selected" : ""}>${tt(l)}</option>`).join("")}
        </select>`)}
      ${settingsField(tt("Fenêtre de contexte (num_ctx)"), `<input type="number" min="0" step="512" data-k="numctx" value="${numCtx}" />`, tt("0 = valeur par défaut du modèle."))}
      ${settingsField(tt("Maintien en mémoire (keep_alive)"), `<input type="text" data-k="keepalive" value="${escapeHtml(keepAlive)}" spellcheck="false" />`, tt("ex. 5m, 1h, -1 = toujours."))}
      <label class="dt-set-check"><input type="checkbox" data-k="think"${think ? " checked" : ""} /> <span>${tt("Activer la réflexion (think)")}</span></label>
    </div>`;
  body.querySelector('[data-k="url"]').addEventListener("change", (e) => {
    lsSet("ollamaUrl", e.target.value.trim()); modelList = null; pushOllamaConfig(); renderSettingsModel(body);
  });
  const sel = body.querySelector('[data-k="model"]');
  try {
    const d = await ollamaGetJson("api/tags", url);
    const models = (d.models || []).map((m) => m.name);
    sel.innerHTML = models.length
      ? models.map((m) => `<option value="${escapeHtml(m)}"${m === cur ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")
      : `<option value="${escapeHtml(cur)}">${escapeHtml(cur || tt("Aucun modèle"))}</option>`;
  } catch { sel.innerHTML = `<option value="${escapeHtml(cur)}">${escapeHtml(cur || tt("Ollama injoignable"))}</option>`; }
  sel.addEventListener("change", (e) => { lsSet("selectedModel", e.target.value); pushOllamaConfig(); });
  body.querySelector('[data-k="mode"]').addEventListener("change", (e) => setMode(e.target.value));
  body.querySelector('[data-k="numctx"]').addEventListener("change", (e) => lsSet("ollamaNumCtx", String(parseInt(e.target.value || "0", 10) || 0)));
  body.querySelector('[data-k="keepalive"]').addEventListener("change", (e) => lsSet("ollamaKeepAlive", e.target.value.trim() || "5m"));
  body.querySelector('[data-k="think"]').addEventListener("change", (e) => lsSet("ollamaThink", String(e.target.checked)));
}

function renderSettingsPrompt(body) {
  const sys = localStorage.getItem("systemPrompt") || "";
  body.innerHTML = `
    <div class="dt-set-sect">
      ${settingsField(tt("Invite système"), `<textarea data-k="sys" rows="12" placeholder="${tt("Instructions persistantes pour l'assistant…")}">${escapeHtml(sys)}</textarea>`, tt("Appliquée à toutes les conversations du bureau et de la barre."))}
    </div>`;
  body.querySelector('[data-k="sys"]').addEventListener("change", (e) => lsSet("systemPrompt", e.target.value));
}

async function renderSettingsVoice(body) {
  const auto = localStorage.getItem("autoSpeak") === "true";
  const speechBackend = localStorage.getItem("speechBackend") || "auto";
  const speakShortcut = localStorage.getItem("speakShortcut") || "Speak Text";
  body.innerHTML = `
    <div class="dt-set-sect">
      <label class="dt-set-check"><input type="checkbox" data-k="autospeak"${auto ? " checked" : ""} /> <span>${tt("Énoncer automatiquement les réponses")}</span></label>
      ${settingsField(tt("Voix sur Mac"), `
        <select data-k="speech-backend">
          <option value="auto"${speechBackend === "auto" ? " selected" : ""}>${tt("Automatique")}</option>
          <option value="shortcut"${speechBackend === "shortcut" ? " selected" : ""}>${tt("Raccourci Apple")}</option>
          <option value="system"${speechBackend === "system" ? " selected" : ""}>${tt("Synthèse intégrée macOS")}</option>
        </select>`)}
      ${settingsField(tt("Raccourci pour énoncer"), `<input type="text" data-k="speak-shortcut" value="${escapeHtml(speakShortcut)}" spellcheck="false" />`)}
      ${settingsField(tt("Voix (Piper)"), `<select data-k="voice"><option>${tt("Chargement…")}</option></select>`)}
      <button class="dt-set-btn" data-act="test-voice">${tt("Tester la voix")}</button>
    </div>`;
  body.querySelector('[data-k="autospeak"]').addEventListener("change", (e) => {
    autospeak = e.target.checked; lsSet("autoSpeak", String(autospeak));
  });
  body.querySelector('[data-k="speech-backend"]').addEventListener("change", (e) => lsSet("speechBackend", e.target.value));
  body.querySelector('[data-k="speak-shortcut"]').addEventListener("change", (e) => lsSet("speakShortcut", e.target.value.trim() || "Speak Text"));
  const sel = body.querySelector('[data-k="voice"]');
  try {
    const [installed, active] = await Promise.all([
      invoke("tts_installed").catch(() => []),
      invoke("tts_active_voice").catch(() => ""),
    ]);
    sel.innerHTML = installed.length
      ? installed.map((v) => `<option value="${escapeHtml(v)}"${v === active ? " selected" : ""}>${escapeHtml(v)}</option>`).join("")
      : `<option value="">${tt("Aucune voix installée")}</option>`;
  } catch { sel.innerHTML = `<option value="">${tt("Synthèse indisponible")}</option>`; }
  sel.addEventListener("change", (e) => { if (e.target.value) invoke("tts_set_voice", { voice: e.target.value }).catch(() => {}); });
  body.querySelector('[data-act="test-voice"]').addEventListener("click", () => {
    invoke("tts_speak", { text: tt("Bonjour, ceci est un test de la voix."), voice: sel.value || undefined }).catch(() => {});
  });
}

function renderSettingsAdvanced(body) {
  const debug = localStorage.getItem("debugMode") === "true";
  body.innerHTML = `
    <div class="dt-set-sect">
      <label class="dt-set-check"><input type="checkbox" data-k="debug"${debug ? " checked" : ""} /> <span>${tt("Mode debug")}</span></label>
      ${settingsField(tt("Raccourcis"), `<span class="dt-set-row">
        <button class="dt-set-btn" data-act="open-sandbox">${tt("Ouvrir les sandboxes")}</button>
        <button class="dt-set-btn" data-act="open-agents">${tt("Gérer les agents")}</button>
      </span>`)}
    </div>`;
  body.querySelector('[data-k="debug"]').addEventListener("change", (e) => lsSet("debugMode", String(e.target.checked)));
  body.querySelector('[data-act="open-sandbox"]').addEventListener("click", () => toggleAppWindow());
  body.querySelector('[data-act="open-agents"]').addEventListener("click", () => openAppById("agents"));
}

// ===== Drag & resize génériques =====
function makeDraggable(el, handle, onEnd) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".dt-traffic, .dt-widget-x, textarea, input, button, select, .sb-select, .usage, .dt-wtl-list, .dt-wcg-svg, .dt-wcg-side")) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = parseInt(el.style.left, 10) || 0, oy = parseInt(el.style.top, 10) || 0;
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      el.style.left = Math.max(0, Math.min(ox + ev.clientX - sx, window.innerWidth - 60)) + "px";
      el.style.top = Math.max(0, Math.min(oy + ev.clientY - sy, window.innerHeight - 40)) + "px";
    };
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); onEnd?.(); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
// Rend `el` redimensionnable depuis ses 4 coins ET ses 4 bords. Le 2e argument (ancienne
// poignée unique éventuellement présente dans le markup) est ignoré : on génère
// nos propres poignées d'angle. minW/minH bornent la taille minimale.
function makeResizable(el, _legacyGrip, minW = 280, minH = 160) {
  // Nettoie d'éventuelles poignées existantes (compat ascendante / ré-entrée).
  el.querySelectorAll(".dt-resize").forEach((g) => g.remove());
  // [classe, signe horizontal, signe vertical] : un signe négatif déplace aussi
  // l'origine (left/top) pour garder le coin opposé fixe pendant le redim.
  // Un signe nul = axe non concerné (poignées de bord). Les coins sont ajoutés
  // APRÈS les bords pour passer au-dessus d'eux là où ils se recouvrent.
  const handles = [
    ["n", 0, -1], ["s", 0, 1], ["w", -1, 0], ["e", 1, 0],
    ["nw", -1, -1], ["ne", 1, -1], ["sw", -1, 1], ["se", 1, 1],
  ];
  for (const [name, dx, dy] of handles) {
    const grip = document.createElement("div");
    grip.className = `dt-resize dt-rz-${name}`;
    el.appendChild(grip);
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      const ow = el.offsetWidth, oh = el.offsetHeight, ol = el.offsetLeft, ot = el.offsetTop;
      grip.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (dx) {
          const nw = Math.max(minW, ow + dx * (ev.clientX - sx));
          el.style.width = nw + "px";
          if (dx < 0) el.style.left = ol + (ow - nw) + "px";
        }
        if (dy) {
          const nh = Math.max(minH, oh + dy * (ev.clientY - sy));
          el.style.height = nh + "px";
          if (dy < 0) el.style.top = ot + (oh - nh) + "px";
        }
      };
      const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
  }
}

// ===== Session Lumen Desktop : chargement + écran de connexion =====
// À l'entrée du bureau : courte animation de démarrage (orbe + barre de
// progression), puis écran de connexion façon OS (avatar, nom du profil,
// mot de passe optionnel — activable dans Paramètres → Notifications).
// La session vaut pour la durée de vie de la fenêtre (sessionStorage).

let dtBootInProgress = false;

async function dtUserProfile() {
  try {
    const entry = await invoke("memory_get", { key: "user/profile" });
    const p = entry?.value || entry || {};
    return {
      name: String(p.callMe || p.name || "").trim() || tt("Utilisateur"),
      avatar: String(p.avatar || "").trim(),
    };
  } catch {
    return { name: tt("Utilisateur"), avatar: "" };
  }
}

async function dtLoginProfiles() {
  try {
    const data = await invoke("session_profiles");
    const profiles = Array.isArray(data?.profiles) && data.profiles.length ? data.profiles : [];
    const active = profiles.find((p) => p.id === data?.active_id) || profiles[0];
    return { profiles, active };
  } catch {
    return { profiles: [], active: null };
  }
}

// ===== Écran de chargement de session =====
//
// Entre « Ouvrir la session » et un bureau réellement utilisable, il peut
// s'écouler plusieurs secondes (listing de la sandbox, vignettes, widgets).
// On garde donc l'overlay sombre, en remplaçant le formulaire par une
// animation « Lumen Desktop », jusqu'à ce que le bureau ait fini de se peindre.
function showSessionLoading(ov) {
  if (!ov?.isConnected) return;
  ov.classList.add("dt-boot-loading");
  ov.innerHTML = `
    <div class="dt-boot-center">
      <div class="dt-load-mark">
        <div class="dt-load-orb"></div>
        <div class="dt-load-ring"></div>
      </div>
      <div class="dt-boot-name dt-load-name">${escapeHtml(osName())}</div>
      <div class="dt-load-dots"><i></i><i></i><i></i></div>
      <div class="dt-load-hint">${tt("Ouverture de votre espace…")}</div>
    </div>`;
}

// « Prêt » = l'explorateur a rendu ses fichiers (événement `sandbox-rendered`)
// puis deux trames peintes sans travail en attente. Bornes : un minimum pour
// que l'animation ne clignote pas, un maximum pour ne jamais rester bloqué si
// un signal manque (sandbox absente, erreur de listing…).
function waitDesktopReady({ min = 900, max = 9000 } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("sandbox-rendered", onRendered);
      clearTimeout(hardStop);
      const wait = Math.max(0, min - (Date.now() - started));
      setTimeout(resolve, wait);
    };
    // Deux rAF + une trame d'inactivité : le navigateur a peint le bureau.
    const settle = () => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (window.requestIdleCallback) requestIdleCallback(finish, { timeout: 1200 });
      else setTimeout(finish, 120);
    }));
    const onRendered = () => settle();
    window.addEventListener("sandbox-rendered", onRendered, { once: true });
    // Aucune sandbox à lister (ou listing déjà terminé avant l'abonnement) :
    // on retombe sur la simple stabilisation du rendu.
    const fallback = setTimeout(settle, 1500);
    const hardStop = setTimeout(() => { clearTimeout(fallback); finish(); }, max);
  });
}

function showBootAndLogin(onUnlocked, desktopIntent = dtLoginDesktopIntent) {
  // Plusieurs appels IPC peuvent demander le bureau pendant le même cycle de
  // chargement. Un seul écran de connexion doit exister et décider du mode.
  if (document.querySelector(".dt-boot")) {
    dtTrace(`showBootAndLogin ignored duplicate desktopIntent=${desktopIntent}`);
    return;
  }
  dtTrace("showBootAndLogin");
  dtBootInProgress = true;
  const ov = document.createElement("div");
  ov.className = "dt-boot";
  ov.innerHTML = `
    <div class="dt-boot-center">
      <div class="dt-boot-orb"></div>
      <div class="dt-boot-name">${escapeHtml(osName())}</div>
      <div class="dt-boot-bar"><i></i></div>
    </div>`;
  document.body.appendChild(ov);
  // L'intention appartient à CET écran de connexion. Elle ne doit pas être
  // affectée par une autre demande de déverrouillage lancée entre-temps.
  setTimeout(() => {
    if (ov.isConnected) showLoginScreen(ov, onUnlocked, desktopIntent);
  }, 1700);
}

async function showLoginScreen(ov, onUnlocked, desktopIntent = false) {
  dtTrace("showLoginScreen");
  const login = await dtLoginProfiles();
  let selectedProfile = login.active;
  const memoryProfile = await dtUserProfile();
  const currentIdentity = () => ({
    name: selectedProfile?.name || memoryProfile.name || tt("Utilisateur"),
    avatar: selectedProfile?.avatar || memoryProfile.avatar || "",
  });
  let identity = currentIdentity();
  const name = identity.name;
  const initial = name.trim().charAt(0).toUpperCase() || "L";
  // Le verrouillage vit côté Rust (session_lock.json) — pas en localStorage.
  const lock = await invoke("session_lock_status").catch(() => ({}));
  const needPass = !!(lock?.enabled && lock?.has_password) || login.profiles.some((p) => p.enabled);
  let selectedWorkspaceMode = sessionStorage.getItem("lumenWorkspaceMode") || "work";
  const modeChoice = "";   // plus de choix Travail / Consultation
  ov.innerHTML = `
    <div class="dt-login">
      <div class="dt-login-avatar">${identity.avatar ? `<img src="${escapeHtml(identity.avatar)}" alt="" />` : escapeHtml(initial)}</div>
      <div class="dt-login-name">${escapeHtml(name)}</div>
      ${login.profiles.length > 1
        ? `<select class="dt-login-profile">${login.profiles.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === selectedProfile?.id ? "selected" : ""}>${escapeHtml(p.name || tt("Utilisateur"))}</option>`).join("")}</select>`
        : ""}
      ${needPass
        ? `<input type="password" class="dt-login-pass" placeholder="${tt("Mot de passe")}" autocomplete="current-password" />
           <div class="dt-login-err"></div>`
        : ""}
      ${modeChoice}
      <button class="dt-login-btn">${tt("Ouvrir la session")}</button>
    </div>
    <button class="dt-login-quit" title="${tt("Quitter")}">${tt("Quitter")}</button>
    <div class="dt-login-clock"><span class="dt-login-time"></span><span class="dt-login-date"></span></div>`;
  const clockTime = ov.querySelector(".dt-login-time");
  const clockDate = ov.querySelector(".dt-login-date");
  const clockLocale = dtLang() === "en" ? "en-US" : "fr-FR";
  const clockTick = () => {
    const d = new Date();
    if (clockTime) clockTime.textContent = d.toLocaleTimeString(clockLocale, { hour: "2-digit", minute: "2-digit" });
    if (clockDate) clockDate.textContent = d.toLocaleDateString(clockLocale, { weekday: "long", day: "numeric", month: "long" });
  };
  clockTick();
  const clockTimer = setInterval(() => { if (ov.isConnected) clockTick(); else clearInterval(clockTimer); }, 15000);
  ov.querySelector(".dt-login-quit")?.addEventListener("click", async () => {
    // Quitter depuis le login : on ferme la fenêtre workspace sans ouvrir la session.
    broadcastDesktop(false);
    sessionStorage.removeItem("dtSessionOpen");
    try { await invoke("close_current_window"); return; } catch {}
    try { await window.__TAURI__?.window?.getCurrentWindow?.()?.close?.(); } catch {}
  });
  const btn = ov.querySelector(".dt-login-btn");
  const pass = ov.querySelector(".dt-login-pass");
  const err = ov.querySelector(".dt-login-err");
  const selector = ov.querySelector(".dt-login-profile");
  ov.querySelectorAll("[data-workspace-mode]").forEach((card) => card.addEventListener("click", () => { selectedWorkspaceMode = card.dataset.workspaceMode; ov.querySelectorAll("[data-workspace-mode]").forEach((item) => item.classList.toggle("active", item === card)); }));
  const refreshIdentity = () => {
    identity = currentIdentity();
    const avatar = ov.querySelector(".dt-login-avatar");
    const label = ov.querySelector(".dt-login-name");
    if (label) label.textContent = identity.name;
    if (avatar) avatar.innerHTML = identity.avatar
      ? `<img src="${escapeHtml(identity.avatar)}" alt="" />`
      : escapeHtml(identity.name.trim().charAt(0).toUpperCase() || "L");
  };
  selector?.addEventListener("change", () => {
    // Pas de bascule backend ici : le profil actif ne change qu'après un
    // `session_unlock` réussi (bascule transactionnelle côté Rust).
    selectedProfile = login.profiles.find((p) => p.id === selector.value) || selectedProfile;
    refreshIdentity();
  });
  // Ouverture de session proprement dite, une fois l'identité VÉRIFIÉE côté
  // Rust. Partagée par le mot de passe et par le badge RFID, pour qu'aucun des
  // deux chemins ne puisse diverger de l'autre.
  const finishUnlock = async () => {
    showSessionLoading(ov);
    sessionStorage.setItem("dtSessionOpen", "1");
    sessionStorage.setItem("lumenSessionDisplayName", identity.name || selectedProfile?.name || tt("Utilisateur"));
    if (identity.avatar) sessionStorage.setItem("lumenSessionAvatar", identity.avatar); else sessionStorage.removeItem("lumenSessionAvatar");
    if (desktopIntent) sessionStorage.setItem("lumenWorkspaceMode", selectedWorkspaceMode);
    dtTrace(`session unlocked desktopIntent=${desktopIntent} selectedMode=${selectedWorkspaceMode}`);
    // La page a été chargée avec le workspace d'un autre profil (préfixe
    // localStorage, liste des sandboxes…) : on recharge la webview pour tout
    // reconstruire sur le bon profil. Le déverrouillage vit côté Rust, donc
    // le bureau se remonte directement après rechargement.
    const bootedProfile = window.__LUMEN_PROFILE_ID__ || "";
    if (selectedProfile?.id && bootedProfile && selectedProfile.id !== bootedProfile) {
      const url = new URL(location.href);
      if (desktopIntent) url.searchParams.set("desktop", "1");
      else url.searchParams.delete("desktop");
      location.replace(url.toString());
      return;
    }
    dtBootInProgress = false;
    // Le bureau se monte DERRIÈRE l'écran de chargement : plus la sandbox est
    // remplie, plus le rendu prend du temps, et on ne veut pas montrer un
    // bureau vide qui se remplit sous les yeux de l'utilisateur.
    await onUnlocked?.(selectedWorkspaceMode);
    await waitDesktopReady();
    // Nettoie également d'éventuels overlays issus d'une ancienne course au
    // démarrage, afin qu'ils ne puissent plus modifier le mode après coup.
    document.querySelectorAll(".dt-boot").forEach((overlay) => overlay.classList.add("out"));
    setTimeout(() => document.querySelectorAll(".dt-boot").forEach((overlay) => overlay.remove()), 450);
  };

  const unlock = async () => {
    const ok = await invoke("session_unlock", {
      profileId: selectedProfile?.id || null,
      password: pass?.value || "",
    }).catch(() => false);
    if (!ok) {
      if (err) err.textContent = tt("Mot de passe incorrect.");
      pass?.select();
      ov.querySelector(".dt-login")?.classList.add("shake");
      setTimeout(() => ov.querySelector(".dt-login")?.classList.remove("shake"), 450);
      return;
    }
    await finishUnlock();
  };

  btn.addEventListener("click", unlock);
  pass?.addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });

  // Badge RFID passé sur le Lumen Controller. `orb_bridge.rs` réémet chaque
  // ligne reçue vers TOUTES les webviews : l'écran de connexion peut donc
  // écouter directement, sans passer par la fenêtre principale.
  //
  // La vérification reste entièrement côté Rust (`session_unlock_rfid`, qui
  // compare des hachages salés et applique le même blocage après cinq échecs
  // que le mot de passe). Le badge n'ouvre QUE les profils auxquels il a été
  // explicitement associé, et sélectionne le bon profil au passage.
  let rfidBusy = false;
  window.__TAURI__?.event?.listen?.("orb-command", async (e) => {
    const p = e?.payload || {};
    if (p.cmd !== "rfid" || !p.uid || rfidBusy) return;
    if (!document.body.contains(ov)) return;      // session déjà ouverte
    rfidBusy = true;
    try {
      const ok = await invoke("session_unlock_rfid", { uid: String(p.uid) })
        .catch(() => false);
      if (!ok) {
        if (err) err.textContent = tt("Badge non reconnu.");
        ov.querySelector(".dt-login")?.classList.add("shake");
        setTimeout(() => ov.querySelector(".dt-login")?.classList.remove("shake"), 450);
        return;
      }
      // Le profil actif a pu changer : on repart du profil désigné par le
      // badge pour la suite de l'ouverture de session.
      const status = await invoke("session_lock_status").catch(() => null);
      if (status?.profile_id) {
        selectedProfile = login.profiles.find((x) => x.id === status.profile_id)
          || selectedProfile;
        if (selector) selector.value = selectedProfile?.id || selector.value;
        refreshIdentity();
      }
      await finishUnlock();
    } finally {
      rfidBusy = false;
    }
  });

  (pass || btn).focus();
}

// ===== « Comprendre cet écran » =====
//
// Une capture de l'ÉCRAN RÉEL (pas du DOM) part vers le modèle multimodal actif.
// C'est la seule façon de parler de ce que l'utilisateur voit vraiment : fenêtres
// natives, apps hors de Lumen, boîtes de dialogue système. Le PNG intermédiaire
// est réduit puis supprimé côté Rust ; seul un JPEG en mémoire circule ici.

// Petit bandeau d'information, calé sur le #toast de l'explorateur (même CSS).
function dtToast(msg, isError = true) {
  let host = document.querySelector("#toast");
  if (!host) { host = document.createElement("div"); host.id = "toast"; document.body.appendChild(host); }
  host.textContent = msg;
  host.className = "show" + (isError ? " err" : "");
  clearTimeout(dtToast._t);
  dtToast._t = setTimeout(() => { host.className = ""; }, 4000);
}

// Message d'avertissement si le moteur actif ne sait manifestement pas lire une
// image ; "" quand rien ne s'y oppose. On avertit sans bloquer : un modèle Ollama
// ou une API peuvent être multimodaux sans qu'on puisse le deviner d'ici.
function visionWarning() {
  const source = aiSourceNow() || "ollama";
  if (source === "shortcut") {
    return tt("Le modèle Apple ne lit pas les images : choisissez un modèle vision (Réglages → Modèle).");
  }
  if (source === "llama") {
    const model = localStorage.getItem("selectedModel") || "";
    const entry = llamaCatalogEntry(model);
    if (entry && !(entry.tags || []).includes("vision")) {
      return tt("Ce modèle local ne lit pas les images. Installez un modèle vision (par ex. LFM2.5-VL 3B).");
    }
  }
  return "";
}

/**
 * Capture l'écran et demande à Lumen de l'expliquer.
 * @param {string} question — précision facultative de l'utilisateur.
 */
// Questions par défaut du geste « Comprendre… ». Elles sont PRÉ-REMPLIES dans
// le composeur (lib/screen-prompt.js) et modifiables avant envoi : la question
// figée d'origine ne servait qu'un seul usage.
function screenPromptBase(kind) {
  const en = dtLang() === "en";
  if (kind === "region") {
    return en
      ? "Here is an area I cropped from my screen. Explain precisely what it shows and what I should take away from it. Keep it short and concrete."
      : "Voici une zone que j'ai découpée dans mon écran. Explique précisément ce qu'elle montre et ce que je dois en retenir. Va à l'essentiel.";
  }
  return en
    ? "Here is a screenshot of my screen. Explain what is displayed: the app or window in front, the important information, and what I can do next. Keep it short and concrete."
    : "Voici une capture de mon écran. Explique ce qui est affiché : la fenêtre ou l'application au premier plan, les informations importantes, et ce que je peux faire ensuite. Va à l'essentiel.";
}

/// Ouvre le composeur et renvoie la question validée (ou null si annulé).
function askScreenQuestion(kind, question = "") {
  const base = screenPromptBase(kind);
  const extra = String(question || "").trim();
  return askScreenPrompt({
    defaultPrompt: extra ? `${base}\n\n${extra}` : base,
    title: tt(kind === "region" ? "Comprendre une zone" : "Comprendre cet écran"),
    lang: dtLang(),
  });
}

export async function understandScreen(question = "") {
  const warning = visionWarning();
  if (warning) dtToast(warning);
  if ((aiSourceNow() || "ollama") === "shortcut") return;

  const prompt = await askScreenQuestion("screen", question);
  if (prompt == null) return; // annulé

  // La feuille de saisie fait partie de l'écran : on attend son effacement
  // avant de déclencher la capture, sinon elle figure sur l'image.
  await waitForRepaint();

  let shot;
  try {
    shot = await invoke("capture_screen", { maxWidth: 1280 });
  } catch (e) {
    const detail = String(e?.message || e || "");
    dtToast(tt("Capture d'écran impossible : ") + detail);
    return;
  }
  const mime = shot?.mime || "image/jpeg";
  const b64 = shot?.image || "";
  if (!b64) { dtToast(tt("Capture d'écran vide.")); return; }
  const image = { dataUrl: `data:${mime};base64,${b64}`, b64 };
  openLumenSheet({ title: tt("Comprendre cet écran"), question: prompt, images: [image], actions: visualActions(image) });
}

/**
 * Comme `understandScreen`, mais sur une zone tracée par l'utilisateur.
 *
 * Le tracé se fait dans une surface plein écran ouverte par le Rust, sur une
 * capture déjà prise (cf. screen.rs) : la zone recadrée revient par l'événement
 * `screen-selection`, adressé à cette seule fenêtre.
 */
export async function understandScreenRegion(question = "") {
  const warning = visionWarning();
  if (warning) dtToast(warning);
  if ((aiSourceNow() || "ollama") === "shortcut") return;

  // La question se choisit AVANT le tracé : une fois la surface de sélection
  // ouverte, plus rien d'autre n'est cliquable.
  const prompt = await askScreenQuestion("region", question);
  if (prompt == null) return;
  pendingRegionPrompt = prompt;
  regionRequestedHere = true;

  bindScreenSelection();
  await waitForRepaint();
  try {
    await invoke("screen_select_open");
  } catch (e) {
    pendingRegionPrompt = null;
    regionRequestedHere = false;
    dtToast(tt("Capture d'écran impossible : ") + String(e?.message || e || ""));
  }
}

// Question validée pour le prochain tracé de zone (consommée par l'événement
// `screen-selection`).
let pendingRegionPrompt = null;
// Vrai entre `screen_select_open` lancé d'ICI et le retour de la zone : le
// `listen()` de Tauri reçoit aussi les `screen-selection` adressés à la barre
// principale, qui pose alors sa propre question — deux réponses pour un tracé.
let regionRequestedHere = false;

let screenSelectionBound = false;
function bindScreenSelection() {
  if (screenSelectionBound) return;
  screenSelectionBound = true;
  const evt = window.__TAURI__?.event;
  // Raccourci global / menu de la barre des menus « Comprendre cet écran » :
  // quand le bureau est visible, le Rust l'adresse ici (suffixe `-desktop`)
  // plutôt qu'à la barre flottante.
  evt?.listen?.("understand-screen-desktop", () => { understandScreen(); });
  evt?.listen?.("understand-screen-region-desktop", () => { understandScreenRegion(); });
  evt?.listen?.("screen-selection", async (e) => {
    if (!regionRequestedHere) return; // tracé demandé depuis la barre principale
    regionRequestedHere = false;
    const shot = e?.payload;
    if (!shot?.image) { dtToast(tt("Capture d'écran vide.")); return; }
    const image = { dataUrl: `data:${shot.mime || "image/jpeg"};base64,${shot.image}`, b64: shot.image };
    const prompt = pendingRegionPrompt || screenPromptBase("region");
    pendingRegionPrompt = null;
    openLumenSheet({ title: tt("Comprendre une zone"), question: prompt, images: [image], actions: visualActions(image) });
  });
}
// Dès le chargement : les événements du raccourci global n'attendent pas
// qu'on ait déjà demandé une zone depuis le bureau.
bindScreenSelection();

// ===== Menu contextuel de Lumen (clic droit sur le bureau) =====
//
// Le clic droit n'ouvrait rien sur le fond du bureau. Il donne maintenant accès
// aux gestes les plus fréquents — dont « Comprendre cet écran », qui n'a de sens
// qu'ici : au moment où l'utilisateur regarde quelque chose qu'il ne comprend pas.

// Zones qui gardent leur propre clic droit (menus d'app, saisie de texte,
// fenêtres, dock, barre des tâches…) : on ne les intercepte pas.
const CTX_MENU_EXCLUDE = [
  ".dt-win", "#app", ".dt-chat", ".dt-taskbar", ".dt-dock", ".dt-menu", ".dt-panel",
  ".dt-start", ".dt-find", ".dt-launcher", "input", "textarea", "select", "[contenteditable]",
].join(",");

let ctxMenuBound = false;
function installDesktopContextMenu() {
  if (ctxMenuBound) return;
  ctxMenuBound = true;
  document.addEventListener("contextmenu", (e) => {
    if (!isDesktopActive()) return;
    if (e.target instanceof Element && e.target.closest(CTX_MENU_EXCLUDE)) return;
    e.preventDefault();
    openLumenContextMenu(e.clientX, e.clientY);
  });
}

// Le bouton « œil » propose les DEUX gestes : tout l'écran, ou une zone à
// tracer. Un seul clic ne doit pas décider à la place de l'utilisateur.
function openUnderstandMenu(anchor) {
  closeMenus();
  const m = document.createElement("div");
  m.className = "dt-menu dt-ctx-menu";
  const items = [
    ["Comprendre cet écran", ICON.eye, () => understandScreen()],
    ["Comprendre une zone…", lumenIcon("maximize"), () => understandScreenRegion()],
  ];
  for (const [label, icon, onClick] of items) {
    const it = document.createElement("div"); it.className = "dt-menu-item";
    it.innerHTML = `<span class="dt-panel-ic">${icon}</span><span>${escapeHtml(tt(label))}</span>`;
    it.addEventListener("click", () => { m.remove(); onClick(); });
    m.appendChild(it);
  }
  document.body.appendChild(m);
  const a = anchor?.getBoundingClientRect?.() || { left: window.innerWidth / 2, top: window.innerHeight - 80, width: 0 };
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(a.left + a.width / 2 - r.width / 2, window.innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8, a.top - r.height - 10) + "px";
  setTimeout(() => document.addEventListener("pointerdown", function h(ev) {
    if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", h); }
  }), 0);
}

function openLumenContextMenu(x, y) {
  closeMenus();
  const m = document.createElement("div");
  m.className = "dt-menu dt-ctx-menu";
  const items = [
    ["Comprendre cet écran", ICON.eye, () => { understandScreen(); }],
    ["Comprendre une zone…", ICON.eye, () => { understandScreenRegion(); }],
    ["Demander à Lumen…", ICON.sparkles, () => openLumenSheet({ title: tt("Demander à Lumen"), anchor: { x, y, w: 0, h: 0 } })],
    ["Résumer la fenêtre active", ICON.sparkles, () => summarizeActiveWindow()],
    ["Nouvelle conversation", ICON.newchat, () => { newConversation(); openAssistantWindow(); }],
    ["Discussions épinglées", ICON.pin, () => openPinboardWindow()],
    [null],
    [IS_MAC ? "Rechercher (⌘K)" : "Rechercher (Ctrl+K)", ICON.search, () => openSearch()],
    // Pas d'entrée « Ajouter un widget » ici : sans choix de type elle ne
    // pouvait poser qu'une horloge, et le clic droit finissait couvert
    // d'horloges. Le choix du widget se fait dans le menu de la barre des
    // tâches (bouton « Widget »), qui liste les types.
    ["Fond d'écran", ICON.wallpaper, () => openWallpaperWindow()],
    ["Changer de thème", ICON.theme, () => toggleTheme()],
  ];
  for (const [label, icon, onClick] of items) {
    if (label === null) {
      const sepEl = document.createElement("div"); sepEl.className = "dt-menu-sep";
      m.appendChild(sepEl);
      continue;
    }
    const it = document.createElement("div"); it.className = "dt-menu-item";
    it.innerHTML = `<span class="dt-panel-ic">${icon}</span><span>${escapeHtml(tt(label))}</span>`;
    it.addEventListener("click", () => { m.remove(); onClick(); });
    m.appendChild(it);
  }
  // Au niveau du <body> : #desktop est un contexte d'empilement bas, le menu
  // passerait derrière la barre de chat.
  document.body.appendChild(m);
  // Position mesurée après insertion : près d'un bord, le menu se replie vers
  // l'intérieur plutôt que de déborder sous la barre des tâches.
  placeMenuAt(m, x, y);
  setTimeout(() => document.addEventListener("pointerdown", function h(ev) {
    if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", h); }
  }), 0);
}

// ===== Vue du matin =====
// Une fois par jour, après la visite guidée s'il y en a une : c'est le premier
// écran de la journée, pas une notification. Le nom affiché vient de la
// session ouverte — sans lui, l'écran salue « Bonjour » tout court, ce qui est
// préférable à « Bonjour, undefined ».
function openMorningView() {
  showMorning({
    openApp: (id) => openAppById(id),
    profileName: sessionStorage.getItem("lumenSessionDisplayName") || "",
  });
}
function maybeShowMorning() {
  if (!shouldShowMorning()) return;
  // La visite guidée passe devant au tout premier démarrage : on attend
  // qu'elle soit finie plutôt que de superposer deux écrans d'accueil.
  const wait = () => {
    if (document.querySelector(".dt-tour-ov")) { setTimeout(wait, 1200); return; }
    openMorningView();
  };
  setTimeout(wait, 700);
}

// ===== Recherche globale (⌘K) =====
// Cmd/Ctrl+K ou la loupe de la barre des tâches. Cherche instantanément dans
// les apps et fenêtres ouvertes ; les fichiers des sandboxes sont indexés
// paresseusement (parcours limité, cache 60 s) pour rester léger.

let searchEl = null;
let spotFileIndex = null;       // [{ sandbox, id, path }]
let spotFileIndexAt = 0;

async function searchFileIndex() {
  if (spotFileIndex && Date.now() - spotFileIndexAt < 60000) return spotFileIndex;
  const out = [];
  try {
    const sandboxes = await invoke("sandbox_list").catch(() => []);
    // Parcours en largeur, borné (profondeur 3, 400 entrées max au total).
    for (const sb of sandboxes || []) {
      const queue = [""];
      let depth = 0;
      while (queue.length && out.length < 400 && depth < 3) {
        const level = queue.splice(0);
        depth++;
        for (const dir of level) {
          const entries = await invoke("sandbox_read_dir", { id: sb.id, path: dir }).catch(() => []);
          for (const en of entries || []) {
            if (out.length >= 400) break;
            const p = dir ? `${dir}/${en.name}` : en.name;
            if (en.is_dir) queue.push(p);
            else out.push({ sandbox: sb.name || sb.id, id: sb.id, path: p });
          }
        }
      }
    }
  } catch {}
  spotFileIndex = out;
  spotFileIndexAt = Date.now();
  return out;
}

// Ouvre un fichier trouvé par la recherche globale dans l'app la plus adaptée :
// documents/présentations → éditeur créatif ; le reste → explorateur sur la
// bonne sandbox, avec l'aperçu dédié (image, PDF, audio, code…) du fichier.
async function openSearchFile(f) {
  const ext = fileExt(f.path);
  if (["lumenpages", "lumenkey", "docx", "pptx"].includes(ext)) {
    openCreativeFile(f.path, ext === "lumenkey" || ext === "pptx" ? "presentation" : "document", f.id);
    return;
  }
  if (ext === "lumensheet" || ext === "xlsx") { openSheetsFile(f.path, f.id); return; }
  toggleAppWindow();
  if (getCurrent()?.id !== f.id) await window.__selectSandbox?.(f.id);
  window.dispatchEvent(new CustomEvent("sandbox-open-path", { detail: { path: f.path } }));
}

// Ouvre un résultat de contenu (cf. search.rs). Une entrée d'état d'app
// (note, planche…) rouvre l'app ; si celle-ci promeut une intention
// `open_<qqch>` (Notes → `open_note`), on la lui remet avec l'identifiant pour
// atterrir directement sur l'entrée.
// Sources de données propres à Lumen (search.rs, DATA_SOURCES) : chacune a son
// app, qu'un identifiant d'entrée ne sert pas à ouvrir plus précisément — on y
// va, et la recherche interne de l'app fait le reste.
const HIT_APP = { inbox: "inbox", reminder: "calendar", mail: "mail", contact: "contacts" };

function openSearchHit(h) {
  if (h.kind === "file") { openSearchFile({ id: h.source, sandbox: h.source_name || h.source, path: h.path }); return; }
  if (HIT_APP[h.kind]) { openAppById(HIT_APP[h.kind]); return; }
  const appId = h.source;
  const packaged = installedApps().find((a) => a.id === appId);
  const intent = (packaged?.intents || []).find((it) => /^open_/.test(it.id) && (it.required || []).length === 1);
  if (packaged && intent && (h.id || h.title)) {
    const param = intent.required[0];
    runAppIntent(appId, intent, { [param]: h.id || h.title }, openAppForIntent).catch(() => openAppForIntent(appId));
    return;
  }
  openAppForIntent(appId);
}

// Élément d'un projet de l'espace Création (projects/projects.js) : le
// document Opus s'ouvre par son chemin ; les autres éditeurs reçoivent leur
// intention « open_* » quand ils en promeuvent une, sinon l'app s'ouvre.
window.LumenOpenProjectItem = (it) => {
  if (!it) return;
  if (it.app === "opus") {
    const [sb, ...rest] = String(it.ref).split(":");
    const path = rest.join(":");
    openCreativeFile(path, /\.(lumenkey|pptx)$/i.test(path) ? "presentation" : "document", sb);
    return;
  }
  openSearchHit({ kind: "state", source: it.app, id: it.ref, title: it.title });
};

function closeSearch() { searchEl?.remove(); searchEl = null; }

function openSearch(prefill = "") {
  if (searchEl) { closeSearch(); if (!prefill) return; }
  const ov = document.createElement("div");
  ov.className = "dt-find-ov";
  ov.innerHTML = `
    <div class="dt-find">
      <div class="dt-find-bar">
        ${lumenIcon("search")}
        <input type="text" class="dt-find-input" placeholder="${tt("Rechercher apps, notes, documents…")}" spellcheck="false" />
        <kbd>esc</kbd>
      </div>
      <div class="dt-find-list"></div>
    </div>`;
  document.body.appendChild(ov);
  searchEl = ov;
  const input = ov.querySelector(".dt-find-input");
  const list = ov.querySelector(".dt-find-list");
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closeSearch(); });

  let items = [];   // résultats courants [{ label, sub, icon, run }]
  let sel = 0;
  let fileTimer = null;
  let contentTimer = null;
  let deepTimer = null;
  let llmTimer = null;
  let agentTimer = null;

  // Met à jour la surbrillance sans reconstruire la liste (reconstruire au
  // survol remplaçait l'élément entre mousedown et mouseup → clic perdu).
  const highlight = () => {
    list.querySelectorAll(".dt-find-item").forEach((el, i) => el.classList.toggle("sel", i === sel));
  };
  const render = () => {
    list.innerHTML = "";
    items.forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "dt-find-item" + (i === sel ? " sel" : "");
      el.innerHTML = `<span class="dt-find-ic">${it.icon || ""}</span>
        <span class="dt-find-txt"><b>${escapeHtml(it.label)}</b>${it.sub ? `<i>${escapeHtml(it.sub)}</i>` : ""}</span>`;
      el.addEventListener("pointerenter", () => { sel = i; highlight(); });
      // pointerdown (et non click) : insensible aux re-rendus et plus réactif.
      el.addEventListener("pointerdown", (e) => { e.preventDefault(); closeSearch(); it.run(); });
      list.appendChild(el);
    });
    list.hidden = !items.length;
  };

  const search = (q) => {
    const needle = q.trim().toLowerCase();
    items = [];
    sel = 0;
    if (!needle) { render(); return; }
    // 0) Gestes Lumen : « Comprendre cet écran » n'appartient à aucune app, et
    // c'est justement ce qu'on cherche quand on ne sait pas où regarder.
    const screenTerms = dtLang() === "en"
      ? "understand this screen screenshot vision explain"
      : "comprendre cet écran capture vision expliquer";
    const screenHit = screenTerms.includes(needle)
      || normSearch(needle).split(/[\s'’]+/).some((w) => w.length >= 4 && /^(captur|analys|analyz|screensh|ecran|screen|comprend)/.test(w));
    if (screenHit) {
      items.push({
        label: tt("Comprendre cet écran"),
        sub: tt("Capture l'écran et demande à Lumen de l'expliquer"),
        icon: ICON.eye,
        run: () => understandScreen(),
      });
      items.push({
        label: tt("Comprendre une zone…"),
        sub: tt("Trace un rectangle et Lumen n'analyse que celui-là"),
        icon: ICON.eye,
        run: () => understandScreenRegion(),
      });
    }
    // Le tableau des épinglées n'est pas une app : sans entrée ici, il ne se
    // trouve que par le menu contextuel.
    const pinTerms = dtLang() === "en" ? "pinned board conversations pinboard" : "épinglées tableau discussions épingles";
    if (pinTerms.includes(needle)) {
      items.push({
        label: tt("Discussions épinglées"),
        sub: tt("Le tableau des discussions que tu as épinglées"),
        icon: ICON.pin,
        run: () => openPinboardWindow(),
      });
    }
    // 1) Apps du menu démarrer (instantané).
    for (const app of dtApps()) {
      const hay = `${app.name} ${app.desc}`.toLowerCase();
      if (hay.includes(needle)) {
        items.push({ label: tt(app.name), sub: tt(app.desc), icon: app.icon, run: () => app.action() });
      }
      if (items.length >= 6) break;
    }
    // 1 ter) Réglages courants : « thème », « avatar », « clé api »… mènent
    // droit à la bonne section. « réglages » seul liste les plus utiles.
    {
      const n = normSearch(needle);
      const words = n.split(/\s+/).filter((w) => w.length >= 3);
      const all = /^(reglage|parametre|setting|pref)/.test(n);
      let added = 0;
      for (const qs of QUICK_SETTINGS) {
        if (added >= (all ? 6 : 3)) break;
        const hay = normSearch(`${tt(qs.label)} ${qs.label} ${qs.k}`);
        if (!all && (n.length < 2 || (!hay.includes(n) && !(words.length && words.every((w) => hay.includes(w)))))) continue;
        items.push({
          label: `${tt("Réglages")} — ${tt(qs.label)}`,
          sub: tt(qs.hint),
          icon: lumenIcon(qs.icon),
          run: () => openSettingsAt(qs.tab, qs.focus),
        });
        added++;
      }
    }
    // 1 bis) Onglets des hubs : sans cela, une app devenue onglet (Traces,
    // Profiler, Designer…) reste introuvable à son propre nom.
    for (const hub of HUBS) {
      for (const tab of hub.tabs) {
        if (items.length >= 10) break;
        if (tab.when && !tab.when()) continue;
        if (!`${tab.name} ${tab.hint || ""}`.toLowerCase().includes(needle)) continue;
        items.push({
          label: `${tt(hub.name)} — ${tt(tab.name)}`,
          sub: tt(tab.hint || ""),
          icon: tab.icon,
          run: () => openHub(hub.id, tab.id),
        });
      }
    }
    // 2) Fenêtres ouvertes → focus.
    for (const [id, w] of openWindows) {
      const title = w.el?.querySelector(".dt-win-title")?.textContent || id;
      if (title.toLowerCase().includes(needle)) {
        items.push({ label: title, sub: tt("Fenêtre ouverte"), icon: ICON.grid, run: () => focusWindow(id) });
      }
    }
    // 2 bis) Discussions passées — titre ET contenu des messages. Elles vivent
    // en localStorage (deux magasins : barre et bureau), hors de portée de la
    // recherche Rust ; c'est pourtant « ce qu'on s'était dit » qu'on cherche le
    // plus souvent. Lecture synchrone bornée : on s'arrête à 5 résultats.
    if (needle.length >= 3) {
      let added = 0;
      for (const conv of getSavedConversations()) {
        if (added >= 5) break;
        const title = conv.title || tt("Discussion");
        let sn = "";
        if (String(title).toLowerCase().includes(needle)) sn = tt("Titre de la discussion");
        else {
          for (const m of (conv.history || [])) {
            // Le prompt système n'est pas de la conversation : le donner en
            // résultat ferait remonter chaque discussion pour n'importe quel
            // mot de la consigne.
            if (m?.role === "system" || m?.role === "tool") continue;
            const text = String(m?.display || m?.content || "");
            const at = text.toLowerCase().indexOf(needle);
            if (at < 0) continue;
            sn = text.slice(Math.max(0, at - 30), at + 90).replace(/\s+/g, " ").trim();
            break;
          }
        }
        if (!sn) continue;
        items.push({
          label: title,
          sub: `${tt("Discussion")} — ${sn}`,
          icon: ICON.chat,
          run: () => loadConversation(conv),
        });
        added++;
      }
    }
    render();
    // 2 ter) Agents de l'atelier (outils « @agent_<nom> ») : « agent » seul les
    // liste ; sinon on cherche le nom. Le texte restant devient la tâche.
    clearTimeout(agentTimer);
    if (needle.length >= 3) {
      agentTimer = setTimeout(async () => {
        const agents = await spotAgents();
        if (!searchEl || input.value.trim().toLowerCase() !== needle || !agents.length) return;
        const n = normSearch(needle);
        const wantsAgent = /\b(agent|agents|deleguer|delegate|confier)\b/.test(n);
        const hits = agents.filter((a) => wantsAgent || n.split(/\s+/).some((w) => w.length >= 3 && normSearch(a.name).includes(w)));
        if (!hits.length) return;
        const at = items.findIndex((it) => it.icon === ICONAPP_research);
        const rows = hits.slice(0, 4).map((a) => {
          const task = spotAgentTask(input.value.trim(), a);
          return {
            label: tt("Lancer l'agent {name}", { name: a.name }),
            sub: task ? `${tt("Tâche")} : ${task}` : (a.desc || tt("Préparer une tâche pour cet agent")),
            icon: ICONAPP_agents,
            run: () => runSpotAgent(a, task),
          };
        });
        items.splice(at < 0 ? items.length : at, 0, ...rows);
        render();
      }, 260);
    }
    // 3) Fichiers sandbox (différé + index paresseux).
    clearTimeout(fileTimer);
    if (needle.length >= 2) {
      fileTimer = setTimeout(async () => {
        const idx = await searchFileIndex();
        if (!searchEl || input.value.trim().toLowerCase() !== needle) return;
        let added = 0;
        for (const f of idx) {
          if (added >= 6) break;
          if (f.path.toLowerCase().includes(needle)) {
            const kind = fileKind({ name: f.path.split("/").pop() });
            items.push({
              label: f.path.split("/").pop(),
              sub: `${f.sandbox} · ${f.path}`,
              icon: iconForFileKind(kind),
              run: () => openSearchFile(f),
            });
            added++;
          }
        }
        if (added) render();
      }, 220);
    }
    // 4) Contenu des notes, documents et fichiers texte (états d'apps +
    // sandboxes), côté Rust sous budget strict : rien n'est indexé ni gardé
    // en mémoire, la lecture ne part qu'à partir de 3 caractères, après un
    // délai, et s'arrête au premier des plafonds (fichiers, octets, 400 ms).
    clearTimeout(contentTimer);
    if (needle.length >= 3) {
      contentTimer = setTimeout(async () => {
        let hits = [];
        try { hits = await invoke("lumen_search", { query: needle, limit: 8 }); } catch { hits = []; }
        if (!searchEl || input.value.trim().toLowerCase() !== needle) return;
        let added = 0;
        for (const h of hits || []) {
          // Déjà proposé par son nom à l'étape 3 : on n'ajoute pas un doublon.
          if (h.kind === "file" && items.some((it) => it.sub === `${h.source_name} · ${h.path}`)) continue;
          const app = h.kind === "state" ? (installedApps().find((a) => a.id === h.source) || dtApps().find((a) => a.id === h.source)) : null;
          items.push({
            label: h.title,
            sub: h.kind === "file" ? `${h.source_name || h.source} · ${h.path} — ${h.snippet}` : `${app ? tt(app.name) : h.source} — ${h.snippet}`,
            icon: h.kind === "file" ? iconForFileKind(fileKind({ name: h.title })) : (app?.icon || ICON.note),
            run: () => openSearchHit(h),
          });
          added++;
        }
        if (added) render();
      }, 320);
    }
    // 5) Une seule recherche, plusieurs moteurs : fiches du coffre unifié
    // (apps + appareils) et passages de Corpus, chacun avec sa PROVENANCE,
    // puis « Approfondir avec Enquête ». On n'a pas à choisir le moteur avant.
    clearTimeout(deepTimer);
    if (needle.length >= 3) {
      deepTimer = setTimeout(async () => {
        // Délai maximal : `rag_search` passe par le serveur d'embeddings, qui
        // peut mettre des dizaines de secondes à démarrer (mémoire saturée).
        // Sans plafond, toute la suite (Enquête, réponse LLM, actions)
        // attendait derrière lui et la liste restait vide.
        const capped = (p) => Promise.race([p.catch(() => []), new Promise((r) => setTimeout(() => r([]), 1500))]);
        const [recs, passages] = await Promise.all([
          capped(invoke("datahub_query", { args: { text: needle, limit: 5 } })),
          capped(invoke("rag_search", { query: needle, k: 3 })),
        ]);
        if (!searchEl || input.value.trim().toLowerCase() !== needle) return;
        for (const r of recs || []) {
          if (items.some((it) => it.label === r.title)) continue;
          const app = dtApps().find((x) => x.id === r.app);
          items.push({
            label: r.title || tt("(sans titre)"),
            sub: `${tt("Coffre")} · ${app ? tt(app.name) : r.app || r.type} — ${String(r.text || "").slice(0, 90)}`,
            icon: app?.icon || ICON.note,
            run: () => (app ? app.action() : openAppById("assistant")),
          });
        }
        for (const p of passages || []) {
          const title = p.title || p.doc_title || p.source || tt("Document");
          items.push({
            label: title,
            sub: `${tt("Corpus")} — ${String(p.text || p.content || p.chunk || "").replace(/\s+/g, " ").slice(0, 100)}`,
            icon: ICONAPP_knowledge,
            run: () => openAppById("knowledge"),
          });
        }
        items.push({
          label: tt("Approfondir « {q} » avec Enquête", { q: input.value.trim() }),
          sub: tt("Rapport sourcé à partir de vos documents"),
          icon: ICONAPP_research,
          run: () => handoff("research", makeObject("text", { text: input.value.trim(), title: input.value.trim() }, { app: "search" })),
        });
        render();
        // 6) Rien trouvé nulle part (seule l'entrée Enquête reste) : la
        // saisie est sans doute une question → réponse d'un LLM rapide.
        // Une vraie question (« ? », mot interrogatif) mérite la réponse du
        // LLM même quand des fichiers contiennent ses mots.
        const asked = /\?\s*$|^(qu(el|elle|els|elles|oi|e|i)|comment|pourquoi|combien|o[uù]|quand|est-ce|what|why|how|when|where|who|which|is|are|can|do|does)\b/i.test(input.value.trim());
        // Réponse LLM et actions : de simples PROPOSITIONS. Rien n'est lancé
        // (ni outil, ni app) avant un clic ou Entrée sur la ligne choisie.
        const noResult = items.length === 1;
        if (noResult || asked) {
          askSpotLlm(input.value.trim(), needle);
          suggestSpotActions(input.value.trim(), needle, noResult);
        }
      }, 420);
    }
  };

  // Actions proposées quand rien n'est trouvé : le moteur de décision (Tev1)
  // n'est consulté QUE dans ce cas, pour placer en tête l'action la plus
  // probable ; les autres créations restent proposées dessous. Chaque action
  // passe par un outil existant (mention « @ » qui force l'appel) ou par
  // l'éditeur concerné (Opus, Calc).
  const suggestSpotActions = async (q, needle, noResult = false) => {
    const stale = () => !searchEl || input.value.trim().toLowerCase() !== needle;
    let toolNames = new Set();
    try { toolNames = new Set((await mentionToolSpecs()).map((t) => t.function?.name).filter(Boolean)); } catch {}
    const actions = SPOT_ACTIONS
      .filter((a) => !a.tool || a.fallback || toolNames.has(a.tool))
      .map((a) => (a.tool && !toolNames.has(a.tool) ? { ...a, run: a.fallback } : a));
    // Agents de l'atelier : candidats du moteur de décision au même titre
    // que les outils (« Confier à l'agent X »).
    for (const a of (await spotAgents()).slice(0, 8)) {
      actions.push({ id: a.tool, icon: "agents", label: `${tt("Confier à l'agent {name}", { name: a.name })} : « {q} »`, hint: a.desc || tt("Délégation suivie en direct"),
        desc: `Delegate the task to the agent "${a.name}": ${a.desc || ""}`.slice(0, 280), run: (text) => runSpotAgent(a, text) });
    }
    if (stale() || !actions.length) return;
    let chosen = null;
    try {
      const decider = appDecider({ aiSource: aiSourceNow() || "llama", ollamaUrl: localStorage.getItem("ollamaUrl") || "http://localhost:11434", invoke });
      chosen = await decider?.choice(
        `User typed in the global search box (nothing matched in apps, files or data): ${q.slice(0, 500)}`,
        "Which action best serves what the user wants?",
        [...actions.map((a) => ({ key: a.id, description: a.desc })),
          { key: "none", description: "None of these: it is a plain question to answer." }],
        0.4,
      );
    } catch { chosen = null; }
    if (stale()) return;
    const best = actions.find((a) => a.id === chosen?.value);
    // Sans avis du moteur : les trois créations de base seulement.
    // Sans avis du moteur : créations + recherches (fichiers, Corpus, bases).
    const base = actions.filter((a) => a.create || a.search);
    // Aucun résultat nulle part : recherche web dans le navigateur de Lumen.
    if (noResult) base.push(SPOT_BROWSER);
    const shown = best ? [best, ...base.filter((a) => a !== best)] : base;
    const rows = shown.slice(0, noResult ? 7 : 6).map((a, i) => ({
      label: tt(a.label, { q: q.length > 50 ? `${q.slice(0, 50)}…` : q }),
      sub: `${i === 0 && best ? `${tt("Suggéré")} · ` : ""}${tt(a.hint)} — ${tt("cliquer pour lancer")}`,
      icon: lumenIcon(a.icon),
      run: () => a.run(q),
    }));
    // Avant « Approfondir avec Enquête » (toujours en dernier).
    const enquete = items.findIndex((it) => it.icon === ICONAPP_research);
    items.splice(enquete < 0 ? items.length : enquete, 0, ...rows);
    render();
  };

  // Réponse courte du modèle rapide (orchestratorFastModel, sinon le modèle
  // courant), en flux dans la ligne de résultat. Entrée → la discussion
  // complète dans l'Assistant. Échec local + mode hybride → escalade API.
  const askSpotLlm = (q, needle) => {
    clearTimeout(llmTimer);
    if (aiSourceNow() === "shortcut") return;
    llmTimer = setTimeout(async () => {
      const stale = () => !searchEl || input.value.trim().toLowerCase() !== needle;
      if (stale()) return;
      const item = {
        label: tt("Demander à Lumen : « {q} »", { q }),
        sub: tt("Réflexion…"),
        icon: ICON.chat,
        run: () => askAssistant(q),
      };
      items.unshift(item);
      sel = 0;
      render();
      const setSub = (t) => {
        item.sub = t;
        const el = list.children[items.indexOf(item)]?.querySelector("i");
        if (el) el.textContent = t; else render();
      };
      const short = (t) => String(t || "").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 220);
      try {
        const backend = llmBackend();
        const { content } = await llmChat([
          // Date et heure locales : sans elles, « quel jour sommes-nous ? »
          // reçoit la date d'entraînement du modèle.
          { role: "system", content: (dtLang() === "en"
            ? "Answer in 1 to 3 short sentences, plain text, no markdown. Now: "
            : "Réponds en 1 à 3 phrases courtes, texte brut, sans markdown. Maintenant : ")
            + new Date().toLocaleString(dtLang() === "en" ? "en-GB" : "fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + "." },
          { role: "user", content: q },
        ], {
          backend: fastBackendFor(backend) || backend,
          rawSystem: true,
          think: false,
          maxTokens: 160,
          source: "spotlight",
          onDelta: (t) => { if (!stale()) setSub(short(t)); },
        });
        if (stale()) return;
        if (!String(content || "").trim()) throw new Error("vide");
        setSub(short(content));
      } catch {
        if (stale()) return;
        if (await apiEscalationAvailable().catch(() => false)) {
          item.label = tt("Demander à l'API cloud : « {q} »", { q });
          item.icon = lumenIcon("cloud");
          item.run = () => escalateToApi(q);
          setSub(tt("Le modèle local n'a pas répondu — Entrée pour escalader vers l'API"));
          render();
        } else setSub(tt("Le modèle n'a pas répondu — Entrée pour ouvrir l'Assistant"));
      }
    }, 300);
  };

  input.addEventListener("input", () => search(input.value));
  // Requête imposée (commande vocale « cherche … ») : la liste s'ouvre déjà remplie.
  if (prefill) { input.value = prefill; search(prefill); }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSearch(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
    if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    if (e.key === "Enter" && items[sel]) { const it = items[sel]; closeSearch(); it.run(); }
  });
  input.focus();
}

// ===== Visite guidée du bureau =====
// Lancée automatiquement après la première ouverture de session, puis
// disponible dans le menu démarrer (Système → Visite guidée).

// Parcours de la barre des tâches (mode par défaut).
const DT_TOUR_STEPS = [
  { sel: ".dt-tb-start", title: "Menu démarrer", body: "Toutes les apps de Lumen Desktop, organisées par usages : créer, organiser, explorer, jouer…" },
  { sel: ".dt-tb-search", title: "Recherche globale", body: IS_MAC ? "Apps, fenêtres et fichiers en un raccourci : ⌘K (ou Ctrl+K)." : "Apps, fenêtres et fichiers en un raccourci : Ctrl+K." },
  { sel: ".dt-taskbar", title: "Barre des tâches", body: "Vos fenêtres ouvertes, les widgets, le fond d'écran et l'heure — tout est là." },
  { sel: "#orb-container", title: "L'orbe", body: "L'avatar de Lumen : il réagit quand l'assistant réfléchit, parle ou exécute une action." },
  { sel: ".dt-chat", title: "Assistant", body: "Parlez à Lumen ici : conversation, actions locales, workflows Fluxo — tout en local." },
];

// Parcours adapté au mode dock (barre des tâches masquée, dock façon macOS actif).
const DT_DOCK_TOUR_STEPS = [
  { sel: ".dt-dock-launch", title: "Toutes les applications", body: "Ouvre le launcher plein écran : toutes les apps de Lumen Desktop, avec recherche et filtres par catégorie." },
  { sel: ".dt-dock-apps", title: "Votre dock", body: "Vos apps épinglées. Un point sous une icône signale une app ouverte. Clic droit sur une icône pour la retirer du dock." },
  { sel: ".dt-dock-add", title: "Personnaliser le dock", body: "Ajoutez ici n'importe quelle app au dock. Le dock se désactive depuis sa barre d'état pour revenir à la barre des tâches." },
  { sel: ".dt-dock-status", title: "Barre d'état intégrée", body: "Notifications, thème, réglages, plein écran, horloge et session — regroupés à droite du dock." },
  { sel: "#orb-container", title: "L'orbe", body: "L'avatar de Lumen : il réagit quand l'assistant réfléchit, parle ou exécute une action." },
  { sel: ".dt-chat", title: "Assistant", body: "En mode dock, la barre de l'assistant passe en haut de l'écran. Conversation, actions locales et workflows Fluxo — tout en local." },
];

function maybeStartDesktopTour() {
  if (wsGet("dtTourDone") === "1") return;
  setTimeout(() => startDesktopTour(), 600);
}

// N'affiche que les étapes dont la cible est réellement visible (une cible cachée
// — p. ex. la barre des tâches en mode dock — a des rects vides).
function tourTargetVisible(sel) {
  const el = document.querySelector(sel);
  return !!(el && el.getClientRects().length);
}

function startDesktopTour() {
  document.querySelector(".dt-tour-ov")?.remove();
  const source = dockMode ? DT_DOCK_TOUR_STEPS : DT_TOUR_STEPS;
  const steps = source.filter((s) => tourTargetVisible(s.sel));
  if (!steps.length) return;
  const ov = document.createElement("div");
  ov.className = "dt-tour-ov";
  ov.innerHTML = `<div class="dt-tour-hl"></div>
    <div class="dt-tour-card">
      <div class="dt-tour-step"></div>
      <h3></h3><p></p>
      <div class="dt-tour-actions">
        <button class="dt-tour-skip">${tt("Passer")}</button>
        <button class="dt-tour-next">${tt("Suivant")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const hl = ov.querySelector(".dt-tour-hl");
  const card = ov.querySelector(".dt-tour-card");
  let i = 0;
  const done = () => { wsSet("dtTourDone", "1"); ov.remove(); };
  const show = () => {
    const step = steps[i];
    const target = document.querySelector(step.sel);
    if (!target) { next(); return; }
    const r = target.getBoundingClientRect();
    const pad = 8;
    hl.style.left = r.left - pad + "px";
    hl.style.top = r.top - pad + "px";
    hl.style.width = r.width + pad * 2 + "px";
    hl.style.height = r.height + pad * 2 + "px";
    ov.querySelector(".dt-tour-step").textContent = `${i + 1} / ${steps.length}`;
    ov.querySelector("h3").textContent = tt(step.title);
    ov.querySelector("p").textContent = tt(step.body);
    ov.querySelector(".dt-tour-next").textContent = i === steps.length - 1 ? tt("Terminer") : tt("Suivant");
    // Carte près de la cible, sans sortir de l'écran.
    const cw = 320, ch = 170;
    let x = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
    let y = r.top > window.innerHeight / 2 ? r.top - ch - 18 : r.bottom + 18;
    y = Math.min(Math.max(12, y), window.innerHeight - ch - 12);
    card.style.left = x + "px";
    card.style.top = y + "px";
  };
  const next = () => { i++; if (i >= steps.length) { done(); return; } show(); };
  ov.querySelector(".dt-tour-next").addEventListener("click", next);
  ov.querySelector(".dt-tour-skip").addEventListener("click", done);
  show();
}
