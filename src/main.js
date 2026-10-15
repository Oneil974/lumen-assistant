import { confirmSheet, promptSheet } from "./lib/confirm.js";
import { ORB_CHARACTERS, characterId } from "./lib/orb-characters.js";
import { intentToolDefinitions, runAppIntent } from "./lib/appkit/host.js";
import { installedApps as installedPackages } from "./lib/appkit/installed.js";
import { searchLumenDocs } from "./lib/lumen-doc-search.js";
import { collectDocumentContext } from "./lib/document-context.js";
import { getProject, projectSystemBlock, projectServedInFull } from "./lib/projects.js";
import { mountProjectKb } from "./lib/project-kb.js";
import { conversationGroups } from "./lib/conversation-groups.js";
import { checkSpeech } from "./lib/speech-check.js";
import { ensureLicenseAccepted, showLicense, LICENSE_VERSION } from "./legal/license.js";
import { PROMPTS as CORE_PROMPTS } from "./lib/core-prompts.js";
import { setTheme, resolvedTheme } from "./lib/theme.js";
import { defaultOrbColors } from './lib/orb-palette.js';
import { proEnabledSync, proFlavor, setProFlavor, whenProResolved } from './lib/pro-edition.js';
import { askScreenPrompt, waitForRepaint } from "./lib/screen-prompt.js";
import { installWritingTools } from "./lib/writing-tools.js?v=7";
import { openAiSheet } from "./lib/ai-sheet.js?v=4";
import { lsSet, onStorageFull } from "./lib/safe-storage.js";
import { t, getLang, setLang, applyI18n } from "./i18n.js";
import { tt as ttApps } from "./apps-i18n.js";
import { markdownToSpeech, renderMarkdown, installLumenFileLinks, stripCitations } from "./sandbox/render.js";
// Fichiers du coffre (images, PDF…) cliqués dans une bulle : ouverts par le système.
installLumenFileLinks((cmd, args) => window.__TAURI__.core.invoke(cmd, args));
import { recordOllamaUsage, scheduleUsageFallback } from "./ollama-usage.js";
import { notePayloadRequest } from "./lib/profiler.js";
import { whisperEnabled, whisperDictate, whisperTranscribe, WHISPER_MODELS } from "./lib/whisper-dictation.js";
import { createDictationVisualizer } from "./lib/dictation-visualizer.js";
import { installEmbedResponder } from "./lib/embed-service.js";
import { rememberWithUndo, withMemoryRecall, memoryToolDefs, runMemoryTool } from "./memory-bridge.js";
import * as tablesDb from "./tables/client.js";
import { playNotifSound, notifTypeFor } from "./lib/notif-sounds.js";
import { imageModelsFor, listOllamaImageModels, refreshPlaygroundOption, playgroundReasonText, pushImageConfig } from "./lib/image-provider.js";
import { mountBonsaiPanel } from "./lib/bonsai-panel.js";
import { llamaCatalogEntry, llamaModelLabel } from "./llama-models.js";
import { isLfmModel, lfmSampling, LFM_TOOLS_SYSTEM, extractLfmToolCalls } from "./lib/lfm.js";
import { createCatalogPicker } from "./lib/catalog-picker.js";
import { maybeStartBarTour, startBarTour } from "./lib/bar-tour.js";
import { bootShell, changeMode } from "./lib/shell-mode.js";
import { mountAppMode } from "./lib/app-mode.js?v=3";
import { buildLumenSystemPrompt, isLumenSystemPrompt } from "./lib/system-prompt.js";
import { findBinding, migrateLegacyBindings } from "./lib/rfid-bindings.js";
import { checkQuietly as checkUpdateQuietly } from "./lib/updater.js";

import { icon as lumenIcon, brandIcon } from "./lib/icons.js";
// Météo et scores : mêmes schémas et même exécution que le bureau (lib/live-tools.js).
import { buildLiveTools, callLiveTool, LIVE_TOOL_NAMES, takeGeneratedImage } from "./lib/live-tools.js";
import { platformFlavor as resolvePlatformFlavor, gpuFlavor as resolveGpuFlavor, IS_MAC } from "./lib/platform-flavor.js";
import { pickModelForSource, rememberModelFor, withOpenAiImages, llmChat, llmBackend, apiEscalationAvailable, withApiEscalation, isApiLike, rustBackend, lumenServerBackendState, listApiProfiles, activateApiProfile, listApiModelChoices, selectApiModel, appleFmBackendState, appleFmReasonText, APPLEFM_DEFAULT_MODEL, APPLEFM_MODELS, withOpenAiTimings, forcedToolTurn } from "./llm.js";
import {
  listFolders, createFolder, resolveFolder, isPinned, summaryMessages,
} from "./lib/conversation-folders.js";
import { resolvePrompt } from "./lib/prompt-registry.js";
import { filterPublishedTools, sanitizeToolName, toolHint } from "./lib/tool-publishing.js";
import { initChatMentions, initMentionHighlight, decorateMentions } from "./lib/chat-mentions.js";
import { buildWebTools, callWebTool, mirrorWebConfig, WEB_TOOL_NAMES } from "./lib/web-tools.js";
import { buildAgentTools, callAgentTool, isAgentTool, agentToolHint, agentToolAvatar } from "./lib/agent-delegation.js";
import { takeAgentVoice } from "./lib/agent-voice.js";
import { buildDocTools, callDocTool, DOC_TOOL_NAMES, withoutDocToolsUnlessWriting } from "./lib/doc-generator.js";
import { snapshotToolCards, restoreToolCards } from "./lib/tool-cards.js";
import { canStream, streamInvoke, stripThink } from "./lib/llm-stream.js";
import { createStreamView, thinkBlock, toolBlock, planBlock } from "./lib/stream-view.js";
import { runOrchestrated, orchestratorText, detectSignals, toolCategory, isSmallTalk, limitsFor } from "./lib/orchestrator.js";
import { routeTurn, topicContinuity } from "./lib/decision.js";
import { appDecider } from "./lib/decisions.js";
import { modelProviderKey, strongBackendFor, recordOrchestration, orchestrationBackends } from "./lib/orchestrator-host.js";
import { buildDataTools, callDataTool, DATA_TOOL_NAMES } from "./lib/data-tools.js";
import { buildAppDataTools, callAppDataTool, APP_DATA_TOOL_NAMES } from "./lib/app-data.js";
import { buildAppWriteTools, callAppWriteTool, APP_WRITE_TOOL_NAMES } from "./lib/app-write.js";
import { runTool, readAccessLog, clearAccessLog } from "./lib/tool-cache.js";
import { renderAnswerExtras, looksFailed } from "./lib/answer-extras.js";
import { buildSystemTools, callSystemTool, SYSTEM_TOOL_NAMES } from "./lib/system-actions.js";
import { registerActionTools } from "./lib/hybrid.js";
import { createUserGate, answerUserRequest, resetSandboxPolicy } from "./lib/user-gate.js";
import { playUi } from "./lib/ui-sounds.js";
import { buildMailTools, callMailTool, MAIL_TOOL_NAMES } from "./lib/mail-tools.js";
const { invoke } = window.__TAURI__.core;
// Préfixe de profil pour le stockage partagé (compteur de tokens…) : la barre
// écrivait sous la clé nue, que le bureau devait re-fusionner à chaque lecture.
if (!window.__LUMEN_PROFILE_STORAGE_PREFIX__) {
  invoke("session_active_profile_id")
    .then((id) => { window.__LUMEN_PROFILE_STORAGE_PREFIX__ ||= `profile:${id || "default"}:`; })
    .catch(() => {});
}
const IS_WINDOWS = /Windows/i.test(navigator.userAgent || navigator.platform || "");
const DEFAULT_OLLAMA_MODEL = "liquidai/lfm2.5-350m:latest";
const LEGACY_OLLAMA_MODELS = new Set(["liquid-fm:350m"]);

function storedOllamaModel() {
  const stored = localStorage.getItem("selectedModel") || localStorage.getItem("model1") || "";
  if (!stored || LEGACY_OLLAMA_MODELS.has(stored)) {
    localStorage.setItem("selectedModel", DEFAULT_OLLAMA_MODEL);
    return DEFAULT_OLLAMA_MODEL;
  }
  return stored;
}

// Pousse l'URL + le modèle Ollama vers le backend (fichier ollama.json) pour que
// la boucle agentique, qui tourne sans fenêtre (cron/heartbeat), y ait accès.
function pushOllamaConfig() {
  try {
    invoke("set_ollama_config", {
      url: config.ollamaUrl || "http://localhost:11434",
      model: config.selectedModel || "",
      // Backend actif partagé avec le Rust (agents + blocs Fluxo) : quand la
      // source « API cloud » est choisie, TOUT bascule sur OpenAI-compatible.
      backend: rustBackend(config.aiSource),
      apiBase: config.apiBaseUrl || "https://api.openai.com/v1",
      apiKey: config.apiKey || "",
      apiModel: cloudModel() || "",
      language: getLang(),
      // Taille de contexte globale : partagée avec la boucle agentique (un agent
      // sans num_ctx propre retombe sur cette valeur).
      numCtx: config.ollamaNumCtx || 0,
      // Consigne personnalisée : les surfaces sans fenêtre (passerelle Telegram)
      // répondent ainsi avec les mêmes consignes que la barre.
      systemPrompt: config.systemPrompt || "",
    });
  } catch (e) { /* non bloquant */ }
}

// Modèle de la source « API » courante : cloud (`apiModel`) ou Lumen Server
// (`lumenModel`). Chaque source garde le sien, comme les backends locaux.
function cloudModel(source = config.aiSource) {
  if (source === 'lumen') return config.lumenModel || '';
  if (source === 'applefm') return config.applefmModel || APPLEFM_DEFAULT_MODEL;
  return config.apiModel || 'gpt-4o-mini';
}
function setCloudModel(name, source = config.aiSource) {
  const value = String(name || '').trim();
  if (source === 'lumen') {
    config.lumenModel = value;
    localStorage.setItem('lumenModel', value);
  } else if (source === 'applefm') {
    config.applefmModel = value || APPLEFM_DEFAULT_MODEL;
    localStorage.setItem('applefmModel', config.applefmModel);
  } else {
    config.apiModel = value || 'gpt-4o-mini';
    localStorage.setItem('apiModel', config.apiModel);
  }
}

// État de Lumen Server comme backend : l'option n'apparaît que si l'édition
// Pro est active ET que ce poste est lié. Sinon une source « lumen » résiduelle
// retombe sur Ollama plutôt que d'échouer à chaque message.
async function refreshLumenServerBackend() {
  const st = await lumenServerBackendState();
  config.lumenLinked = st.available;
  config.lumenUrl = st.url;
  const opt = selectAiSource?.querySelector('option[value="lumen"]');
  if (opt) opt.hidden = !st.available;
  const urlEl = document.querySelector('#lumen-server-url');
  if (urlEl) urlEl.textContent = st.url || '';
  if (!st.available && config.aiSource === 'lumen') {
    config.aiSource = 'ollama';
    localStorage.setItem('aiSource', 'ollama');
    if (selectAiSource) selectAiSource.value = 'ollama';
    pushOllamaConfig();
  }
}

// Apple Foundation Models (macOS 27) : l'option n'apparaît que si la passerelle
// est embarquée et qu'Apple Intelligence répond. Une source « applefm »
// résiduelle (autre Mac, Apple Intelligence désactivé) retombe sur Ollama.
async function refreshAppleFmBackend(force = false) {
  const st = await appleFmBackendState(force);
  config.applefmAvailable = !!st.available;
  config.applefmReason = st.reason || '';
  config.applefmModels = Array.isArray(st.models) ? st.models : [];
  const opt = selectAiSource?.querySelector('option[value="applefm"]');
  if (opt) opt.hidden = !st.available;
  const hint = document.querySelector('#applefm-status');
  if (hint) {
    hint.textContent = st.available
      ? (t('applefm_ready') || 'Apple Foundation Models prêt.')
      : appleFmReasonText(st.reason);
  }
  // Si le modèle mémorisé n'est plus proposé (Private Cloud Compute sans
  // entitlement, par exemple), on revient au modèle sur l'appareil.
  const usable = config.applefmModels.filter((m) => m.available).map((m) => m.id);
  if (usable.length && !usable.includes(config.applefmModel)) setCloudModel(usable[0], 'applefm');
  if (!st.available && config.aiSource === 'applefm') {
    config.aiSource = 'ollama';
    localStorage.setItem('aiSource', 'ollama');
    if (selectAiSource) selectAiSource.value = 'ollama';
    pushOllamaConfig();
  }
}

// Migre l'ancienne clé API (localStorage, en clair) vers le backend, puis
// l'efface localement. Met à jour `config.apiConfigured` à partir de l'état
// backend (la clé en clair n'est jamais renvoyée au front).
async function syncApiKeyState() {
  try {
    const legacy = (localStorage.getItem('apiKey') || '').trim();
    if (legacy) {
      await invoke("set_ollama_config", {
        url: config.ollamaUrl || "http://localhost:11434",
        model: config.selectedModel || "",
        backend: rustBackend(config.aiSource),
        apiBase: config.apiBaseUrl || "https://api.openai.com/v1",
        apiKey: legacy,
        apiModel: cloudModel() || "",
        language: getLang(),
        numCtx: config.ollamaNumCtx || 0,
      });
      localStorage.removeItem('apiKey');
      config.apiKey = '';
    }
    const st = await invoke("llm_secret_status");
    config.apiConfigured = !!(st && st.configured);
  } catch (e) { /* non bloquant */ }
}

// ===== Jeu d'icônes SVG (style SF Symbols, monochrome, suit currentColor) =====
// Une seule source de vérité. Les éléments `[data-icon="nom"]` sont remplis par
// applyIcons() ; le JS dynamique utilise ic("nom").
// Icônes : jeu unique et vendorisé (Lucide ISC + Simple Icons CC0), cf.
// lib/icons.js. Les noms historiques (« gear », « bolt »…) restent valides,
// ce sont des alias — aucun appel existant n'a eu besoin d'être réécrit.
const ic = (name) => lumenIcon(name);
function applyIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    if (!el.firstElementChild) el.innerHTML = ic(el.dataset.icon);
  });
}

// Elements
let chatInput;
// Le champ de saisie est un <textarea> d'une ligne qui grandit avec le texte
// (jusqu'à --chat-input-max, ~5 lignes) : sur une seule ligne on ne pouvait pas
// se relire, la fin du message masquait le début. À appeler après CHAQUE
// écriture programmatique de `chatInput.value` — l'événement `input` ne part
// pas tout seul dans ce cas.
function autosizeChatInput() {
  if (!chatInput) return;
  const bar = chatInput.closest(".search-bar");
  // Deux passes : la classe `expanded` change à la fois la largeur du champ
  // (pleine largeur sur sa propre rangée) et son rembourrage, donc la première
  // mesure ne vaut plus rien une fois la bascule faite.
  const measure = () => {
    const cs = getComputedStyle(chatInput);
    const line = parseFloat(cs.getPropertyValue("--chat-input-line")) || 20;
    const max = parseFloat(cs.getPropertyValue("--chat-input-max")) || 100;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // En `border-box` (le réglage global du projet) la hauteur posée doit
    // inclure le rembourrage, sinon les dernières lignes sont rognées.
    const extra = cs.boxSizing === "border-box" ? pad : 0;
    chatInput.style.height = "auto"; // sinon scrollHeight ne redescend jamais
    const needed = Math.max(line, chatInput.scrollHeight - pad);
    const height = Math.min(needed, max);
    chatInput.style.height = `${height + extra}px`;
    chatInput.classList.toggle("multiline", needed > max);
    return height > line + 1;
  };
  if (!bar) { measure(); return; }
  // C'est TOUJOURS la mesure en capsule compacte qui décide : « le texte
  // déborde-t-il de la colonne étroite ? ». La juger en pleine largeur ferait
  // osciller la barre entre les deux dispositions à chaque frappe.
  bar.classList.remove("expanded");
  if (measure()) {
    bar.classList.add("expanded");
    measure(); // hauteur définitive, cette fois en pleine largeur
  }
}
let sendBtn;
// Moteurs capables de recevoir une image : Ollama (champ `images`), llama.cpp
// avec un projecteur mmproj, les API compatibles OpenAI et Apple Foundation
// Models (parties `image_url`, converties par withOpenAiImages ; la passerelle
// Apple les transmet au modèle en pièces jointes). Le chemin Raccourci Apple ne
// transporte que du texte.
const VISION_SOURCES = ['ollama', 'llama', 'api', 'applefm'];

// Images jointes au prochain message (modèles multimodaux Ollama, ex. Gemma 3).
// Chaque entrée = { dataUrl, b64 } ; `b64` est le base64 nu (sans préfixe
// data:) attendu par le champ `images` d'Ollama.
let pendingImages = [];
let btnAttach, imageInput, attachPreview;
let messagesContainer;
let messagesList;
let statusIndicator;
let btn350mToggle;
let btn350mLabel;
let winClose;
let btnClearChat;
let searchBar;
let activeChatLabel;

// Settings Elements
let btnSettings;
let settingsPanel;
let btnCloseSettings;
let btnSaveSettings;
let inputOllamaUrl;
let selectModel;
let checkboxAlwaysOnTop;
let checkboxBarOpaque;
let checkboxStartupLumenOS;
let checkboxHalo;
let checkboxDebug;
let sliderTransparency;
let labelTransparencyVal;
let selectBarSize;
let selectAiSource;
let groupApi, inputApiKey, inputApiBase, inputApiModel, selectImageProvider, selectImageModel;
let groupOllama;
let groupShortcut;
let groupFluxo;
let checkboxFluxoTools;
let checkboxOllamaThink;
// Fenêtre de contexte maximale acceptée par llama-server (voir `llama.rs`).
const LLAMA_CTX_MAX = 262144;
let inputOllamaNumCtx;
let inputOllamaKeepAlive;
let inputShortcutName;
let inputActionRouter;
let selectSpeechBackend;
let inputSpeakShortcut;
let inputDictateShortcut;
let inputSystemPrompt;
let checkboxOrb;
let sliderOrbSize;
let labelOrbSizeVal;
let sliderOrbCore;
let labelOrbCoreVal;
let sliderOrbPulse;
let labelOrbPulseVal;
let checkboxOrbHeartbeat;
let orbHeartColorInput;
let btnOrbHeartColorReset;
let sliderOrbPulseStrength;
let labelOrbPulseStrengthVal;
let sliderOrbPulseSpeed;
let labelOrbPulseSpeedVal;
let btnOrbPulsePreview;
let selectOrbGlass;
let selectOrbTheme;
let orbColorInputs;
let btnOrbColorsReset;
let selectTheme;
let selectTextColor;
let btnThemeToggle;
let btnActionMode;
let btnFluxoTools;
let btnAutoSpeak;
let btnDictation;
let btnMore;
let toolbarOverflow;
let btnHeartbeat;
let btnMemory;
let btnOrchestrate;
let checkboxOrchestrate;
let checkboxHeartbeat;
let inputHeartbeatShortcut;
let selectHeartbeatFrequency;
let heartbeatCronRow;
let inputHeartbeatCron;
let inputHeartbeatInput;

// Onboarding wizard elements
let onboardingPanel;
let onboardingTitle;
let onboardingDots;
let shortcutCardsContainer;
let btnOpenOnboarding;
let btnCloseOnboarding;
let btnOnboardingPrev;
let btnOnboardingNext;
let btnRecheckShortcuts;
let btnOpenAiSettings;

// History Elements
let btnHistory;
let historyPanel;
let btnCloseHistory;
let btnNewChat;
let conversationsListContainer;

// Notifications (Heartbeat) Elements
let btnNotifications;
let notifBadge;
let notificationsPanel;
let toolboxPanel;
let btnCloseNotifications;
let btnClearNotifications;
let notificationsListContainer;

// Fluxo (automatisations) Elements
let btnFluxo;
let btnLumenOS;
let btnShellMode;
let btnAgents;
let btnOllamaMode, ollamaModeMenu;
let backendMenu;
let fluxoPanel;
let btnCloseFluxo;
let btnRefreshFluxo;
let btnOpenFluxoDesigner;
let fluxoListContainer;

// `localhost` se résout souvent en IPv6 (`::1`) sous Windows alors qu'Ollama
// n'écoute que sur l'IPv4 `127.0.0.1` → connexion refusée. On force l'IPv4 (même
// machine, donc sans effet de bord) pour TOUS les appels WebView (chat + préchauffe).
const normOllamaUrl = (u) => (u || 'http://127.0.0.1:11434').replace('://localhost', '://127.0.0.1');

// Configuration state
let config = {
  ollamaUrl: normOllamaUrl(localStorage.getItem('ollamaUrl')),
  selectedModel: storedOllamaModel(),
  alwaysOnTop: localStorage.getItem('alwaysOnTop') !== 'false',
  debugMode: localStorage.getItem('debugMode') === 'true',
  glassOpacity: parseFloat(localStorage.getItem('glassOpacity') || '0.04'),
  barSize: localStorage.getItem('barSize') || 'moyen',
  barOpaque: localStorage.getItem('barOpaque') === 'true',
  startupLumenOS: localStorage.getItem('startupLumenOS') === 'true',
  halo: localStorage.getItem('halo') === 'true',
  haloPosition: localStorage.getItem('haloPosition') || 'center',
  haloStyle: localStorage.getItem('haloStyle') || 'float',
  aiSource: localStorage.getItem('aiSource') || 'shortcut', // Apple Intelligence par défaut
  shortcutName: localStorage.getItem('shortcutName') || 'Apple Intelligence',
  actionRouter: localStorage.getItem('actionRouter') || 'Action Router',
  speechBackend: localStorage.getItem('speechBackend') || 'auto',
  speakShortcut: localStorage.getItem('speakShortcut') || 'Speak Text',
  dictateShortcut: localStorage.getItem('dictateShortcut') || 'Dictate Text',
  // Le repli n'est PAS « dark » mais le thème unifié de Lumen. Quelqu'un qui
  // n'avait réglé que « Interface » se retrouvait sinon avec une barre sombre
  // au-dessus d'un bureau clair, jusqu'à ce qu'il touche la bascule — le défaut
  // exact que l'unification supprime.
  themePreference: localStorage.getItem('themePreference') || resolvedTheme(),
  textColor: localStorage.getItem('textColor') || 'default',
  actionModeActive: localStorage.getItem('actionModeActive') === 'true',
  autoSpeak: localStorage.getItem('autoSpeak') === 'true',
  fluxoTools: localStorage.getItem('fluxoTools') === 'true',
  ollamaThink: localStorage.getItem('ollamaThink') === 'true',
  ollamaNumCtx: parseInt(localStorage.getItem('ollamaNumCtx') || '0', 10), // 0 = défaut du modèle
  llamaNumCtx: parseInt(localStorage.getItem('llamaNumCtx') || localStorage.getItem('ollamaNumCtx') || '8192', 10), // fenêtre llama-server
  ollamaKeepAlive: localStorage.getItem('ollamaKeepAlive') || '5m', // durée de maintien en mémoire (ex. 5m, 1h, -1 = toujours)
  // Source « API » : IA cloud compatible OpenAI (ChatGPT…), via une clé API.
  // SÉCURITÉ : la clé n'est PLUS conservée côté front. Elle vit uniquement côté
  // backend (ollama.json, 0600) ; `apiKey` ne sert plus qu'à la migration ponctuelle
  // de l'ancienne valeur localStorage. `apiConfigured` reflète l'état backend.
  apiKey: localStorage.getItem('apiKey') || '',
  apiConfigured: false,
  // Lumen Server (édition Pro) : modèle choisi sur le serveur et état de la
  // liaison (URL et jeton restent côté Rust).
  lumenModel: localStorage.getItem('lumenModel') || '',
  lumenLinked: false,
  lumenUrl: '',
  // Apple Foundation Models (macOS 27) : modèle choisi et état de la passerelle.
  applefmModel: localStorage.getItem('applefmModel') || APPLEFM_DEFAULT_MODEL,
  applefmAvailable: false,
  applefmReason: '',
  applefmModels: [],
  apiBaseUrl: localStorage.getItem('apiBaseUrl') || 'https://api.openai.com/v1',
  apiModel: localStorage.getItem('apiModel') || 'gpt-4o-mini',
  imageProvider: localStorage.getItem('imageProvider') || 'bonsai',
  imageOpenaiModel: localStorage.getItem('imageOpenaiModel') || 'gpt-image-1',
  imageOllamaModel: localStorage.getItem('imageOllamaModel') || 'flux',
  imageBonsaiModel: localStorage.getItem('imageBonsaiModel') || 'ternary',
  imagePlaygroundStyle: localStorage.getItem('imagePlaygroundStyle') || 'any',
  // Mode unifié de destination du prompt en source Ollama : 'chat' (Ollama
  // direct), 'router' (workflow « default router »), 'tools' (function calling),
  // 'workflow' (workflow Fluxo spécifique nommé par `ollamaWorkflow`).
  ollamaMode: localStorage.getItem('ollamaMode') || (localStorage.getItem('fluxoTools') === 'true' ? 'tools' : 'chat'),
  ollamaWorkflow: localStorage.getItem('ollamaWorkflow') || '',
  systemPrompt: localStorage.getItem('systemPrompt') || '',
  orbEnabled: localStorage.getItem('orbEnabled') !== 'false',
  robotHeadOptions: localStorage.getItem('robotHeadOptions') || '{}',
  orbAvatarMode: localStorage.getItem('orbAvatarMode') || 'orb',
  avatarGlbAmbientLight: Number(localStorage.getItem('avatarGlbAmbientLight') || '1') > 10 ? Number(localStorage.getItem('avatarGlbAmbientLight')) / 100 : Number(localStorage.getItem('avatarGlbAmbientLight') || '1'),
  orbSize: parseInt(localStorage.getItem('orbSize') || '116', 10),
  orbCoreScale: parseInt(localStorage.getItem('orbCoreScale') || '82', 10),
  orbGlassType: localStorage.getItem('orbGlassType') || 'thin',
  orbPulse: parseInt(localStorage.getItem('orbPulse') || '100', 10),
  // Bouche animée par la voix : option, éteinte par défaut (elle change le
  // visage de l'avatar, ce n'est pas à Lumen de le décider).
  orbMouth: localStorage.getItem('orbMouth') === 'true',
  orbHeartbeat: localStorage.getItem('orbHeartbeat') !== 'false',
  orbHeartColor: localStorage.getItem('orbHeartColor') || '#ff4d6d',
  orbPulseStrength: parseInt(localStorage.getItem('orbPulseStrength') || '100', 10),
  orbPulseSpeed: parseInt(localStorage.getItem('orbPulseSpeed') || '100', 10),
  heartbeatEnabled: localStorage.getItem('heartbeatEnabled') === 'true',
  // Outil mémoire dans la discussion simple : le modèle peut rappeler et
  // mémoriser de lui-même, sans passer par le mode Outils complet.
  memoryTool: localStorage.getItem('memoryTool') === 'true',
  orchestrate: localStorage.getItem('orchestrateChat') === 'true',
  heartbeatShortcut: localStorage.getItem('heartbeatShortcut') || 'Heartbeat',
  // 'fluxo' (workflow « Heartbeat », toutes plateformes) ou 'shortcut' (Raccourci
  // macOS). Vide = pas encore choisi : cf. heartbeatEngine().
  heartbeatEngine: localStorage.getItem('heartbeatEngine') || '',
  heartbeatFrequency: localStorage.getItem('heartbeatFrequency') || '0 0 * * * *',
  heartbeatCron: localStorage.getItem('heartbeatCron') || '0 */10 * * * *',
  heartbeatInput: localStorage.getItem('heartbeatInput') || '',
  orbColors: (() => {
    try {
      const c = JSON.parse(localStorage.getItem('orbColors'));
      if (Array.isArray(c) && c.length === 5) return c;
    } catch (e) {}
    // Pas de choix de l'utilisateur : la palette de l'édition (or en Pro).
    return defaultOrbColors();
  })(),
  orbTheme: characterId(localStorage.getItem('orbTheme') || 'default'),
};

function reloadConfigFromStorage(overrides = {}) {
  const read = (key, fallback = "") => {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    return localStorage.getItem(key) ?? fallback;
  };
  const readBool = (key, fallback = false) => {
    const value = read(key, fallback ? "true" : "false");
    return value === true || value === "true";
  };
  const readInt = (key, fallback = 0) => {
    const value = parseInt(read(key, String(fallback)), 10);
    return Number.isFinite(value) ? value : fallback;
  };
  let orbColors = defaultOrbColors();
  try {
    const raw = Object.prototype.hasOwnProperty.call(overrides, "orbColors")
      ? overrides.orbColors
      : localStorage.getItem('orbColors');
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed) && parsed.length === 5) orbColors = parsed;
  } catch {}

  config = {
    ...config,
    ollamaUrl: normOllamaUrl(read('ollamaUrl', 'http://127.0.0.1:11434')),
    selectedModel: LEGACY_OLLAMA_MODELS.has(read('selectedModel', localStorage.getItem('model1') || DEFAULT_OLLAMA_MODEL))
      ? DEFAULT_OLLAMA_MODEL
      : read('selectedModel', localStorage.getItem('model1') || DEFAULT_OLLAMA_MODEL),
    alwaysOnTop: readBool('alwaysOnTop', true),
    debugMode: readBool('debugMode', false),
    glassOpacity: parseFloat(read('glassOpacity', '0.04')) || 0.04,
    barSize: read('barSize', 'moyen'),
    barOpaque: readBool('barOpaque', platformFlavor === "rpi" || platformFlavor === "linux-standard"),
    startupLumenOS: readBool('startupLumenOS', false),
    halo: readBool('halo', false),
    haloPosition: read('haloPosition', 'center'),
    haloStyle: read('haloStyle', 'float'),
    aiSource: read('aiSource', 'shortcut'),
    shortcutName: read('shortcutName', 'Apple Intelligence'),
    actionRouter: read('actionRouter', 'Action Router'),
    speechBackend: read('speechBackend', 'auto'),
    speakShortcut: read('speakShortcut', 'Speak Text'),
    dictateShortcut: read('dictateShortcut', 'Dictate Text'),
    themePreference: read('themePreference', resolvedTheme()),
    textColor: read('textColor', 'default'),
    actionModeActive: readBool('actionModeActive', false),
    autoSpeak: readBool('autoSpeak', false),
    fluxoTools: readBool('fluxoTools', false),
    ollamaThink: readBool('ollamaThink', false),
    ollamaNumCtx: readInt('ollamaNumCtx', 0),
    // Plafond aligné sur le `clamp` de llama.rs (256K) : les paliers 64K/128K/256K
    // ne sont utilisables que par les modèles entraînés pour, et coûtent cher en mémoire.
    llamaNumCtx: Math.max(2048, Math.min(LLAMA_CTX_MAX, readInt('llamaNumCtx', readInt('ollamaNumCtx', 8192)))),
    ollamaKeepAlive: read('ollamaKeepAlive', '5m'),
    apiKey: read('apiKey', ''),
    apiBaseUrl: read('apiBaseUrl', 'https://api.openai.com/v1'),
    apiModel: read('apiModel', 'gpt-4o-mini'),
    imageProvider: read('imageProvider', 'bonsai'),
    imageOpenaiModel: read('imageOpenaiModel', 'gpt-image-1'),
    imageOllamaModel: read('imageOllamaModel', 'flux'),
    imageBonsaiModel: read('imageBonsaiModel', 'ternary'),
    imagePlaygroundStyle: read('imagePlaygroundStyle', 'any'),
    ollamaMode: read('ollamaMode', readBool('fluxoTools', false) ? 'tools' : 'chat'),
    ollamaWorkflow: read('ollamaWorkflow', ''),
    systemPrompt: read('systemPrompt', ''),
    orbEnabled: readBool('orbEnabled', true),
    robotHeadOptions: read('robotHeadOptions', '{}'),
    orbAvatarMode: read('orbAvatarMode', 'orb'),
    avatarGlbAmbientLight: (() => { const raw = Number(localStorage.getItem('avatarGlbAmbientLight') || '1'); return raw > 10 ? raw / 100 : raw; })(),
    orbSize: readInt('orbSize', 116),
    orbCoreScale: readInt('orbCoreScale', 82),
    orbGlassType: read('orbGlassType', 'thin'),
    orbPulse: readInt('orbPulse', 100),
    orbMouth: readBool('orbMouth', false),
    orbHeartbeat: readBool('orbHeartbeat', true),
    orbHeartColor: read('orbHeartColor', '#ff4d6d'),
    orbPulseStrength: readInt('orbPulseStrength', 100),
    orbPulseSpeed: readInt('orbPulseSpeed', 100),
    heartbeatEnabled: readBool('heartbeatEnabled', false),
    memoryTool: readBool('memoryTool', false),
    orchestrate: readBool('orchestrateChat', false),
    heartbeatShortcut: read('heartbeatShortcut', 'Heartbeat'),
    heartbeatEngine: read('heartbeatEngine', ''),
    heartbeatFrequency: read('heartbeatFrequency', '0 0 * * * *'),
    heartbeatCron: read('heartbeatCron', '0 */10 * * * *'),
    heartbeatInput: read('heartbeatInput', ''),
    orbColors,
    orbTheme: characterId(read('orbTheme', 'default')),
  };
  currentModel = config.selectedModel;
}

// === Thèmes complets de l'avatar ===========================================
// Un thème change *complètement* l'aspect : il teinte tous les panneaux (classe
// Le personnage choisi ne modifie jamais les jetons de l’interface.
const LEGACY_ORB_UI_CLASSES = ['theme-rubis', 'theme-dark-glass', 'theme-violet', 'theme-rose', 'theme-ice', 'theme-sky', 'theme-gold', 'theme-metalred', 'theme-graphite', 'theme-navy', 'theme-emeraude', 'theme-bordeaux', 'theme-ardoise', 'theme-amber'];
function applyOrbTheme() {
  config.orbTheme = characterId(config.orbTheme);
  document.body.classList.remove('orb-themed', ...LEGACY_ORB_UI_CLASSES);
  for (const property of ['--action-color', '--speak-color', '--heartbeat-color']) document.body.style.removeProperty(property);
  window.LumenOrb?.setCharacter?.(config.orbTheme);
  window.LumenOrb?.setInnerIcons([]);
  if (config.orbTheme === 'default') {
    window.LumenOrb?.setColors(config.orbColors);
    window.LumenOrb?.setHeartColor(config.orbHeartColor || '#ff4d6d');
    window.LumenOrb?.setGlassType(config.orbGlassType || 'thin');
  }
}

function applyOrbRuntimeSettings() {
  window.LumenOrb?.setRobotHeadOptions?.(config.robotHeadOptions);
  window.LumenOrb?.setEnabled(config.orbEnabled);
  window.LumenOrb?.setAvatarMode(config.orbAvatarMode === 'robot-head' ? 'robot-head' : characterId(config.orbTheme) === 'default' ? config.orbAvatarMode : 'orb');
  window.LumenOrb?.setCustomAmbientLight(config.avatarGlbAmbientLight);
  window.LumenOrb?.setSize(config.orbSize);
  window.LumenOrb?.setCoreScale(config.orbCoreScale);
  window.LumenOrb?.setPulse(config.orbPulse);
  window.LumenOrb?.setMouth(config.orbMouth);
  window.LumenOrb?.setHeartbeat(config.orbHeartbeat);
  window.LumenOrb?.setPulseStrength(config.orbPulseStrength);
  window.LumenOrb?.setPulseSpeed(config.orbPulseSpeed);
  // Le téléphone suit la même apparence que la barre.
  remotePushOrbAppearance();
}

// Quand un thème complet est actif, les réglages de couleurs/verre sont
// surchargés : on les grise visuellement (sans les casser ni les supprimer).
function updateOrbThemeLock() {
  const original = characterId(config.orbTheme) === 'default';
  for (const id of ['orb-colors-row', 'orb-glass-row', 'orb-core-scale-row']) {
    const row = document.getElementById(id);
    if (row) { row.hidden = !original; row.style.opacity = ''; row.style.pointerEvents = ''; }
  }
  const hint = document.getElementById('orb-character-hint');
  const preset = ORB_CHARACTERS[characterId(config.orbTheme)];
  if (hint) hint.textContent = config.language === 'en' ? preset.enDescription : preset.description;
}

// === Raccourcis requis par Lumen ===
// Remplace les `icloudUrl` ci-dessous par TES liens de partage iCloud
// (dans Raccourcis : clic droit sur le raccourci → Partager → Copier le lien iCloud).
// `name` doit correspondre au nom exact du raccourci tel qu'il apparaît dans l'app Raccourcis.
const REQUIRED_SHORTCUTS = [
  {
    key: 'shortcut',
    name: 'Apple Intelligence',
    desc: "Génère les réponses via les modèles d'Apple (app Raccourcis).",
    icloudUrl: 'https://www.icloud.com/shortcuts/ab65c1d46e7f4d0088c0cd9a7a86e5d0'
  },
  {
    key: 'action',
    name: 'Action Router',
    desc: "Routeur d'actions pour le mode Action direct.",
    icloudUrl: 'https://www.icloud.com/shortcuts/305a50cf9df94e64b8dcfc8be2dc8e78'
  },
  {
    key: 'speak',
    name: 'Speak Text',
    desc: "Énonce les réponses à voix haute.",
    icloudUrl: 'https://www.icloud.com/shortcuts/8930832d8d3d4deba6a6020d022b36c1'
  },
  {
    key: 'dictate',
    name: 'Dictate Text',
    desc: "Dicte un message à la voix (action « Dicter le texte »).",
    icloudUrl: 'https://www.icloud.com/shortcuts/ea65f5134f4f4589ae07e79c56a31bf0'
  },
  {
    key: 'heartbeat',
    name: 'Heartbeat',
    desc: "Tâche d'arrière-plan déclenchée à intervalle régulier par le Heartbeat.",
    icloudUrl: 'https://www.icloud.com/shortcuts/045a26b9031c4fd1b9810e3674023082'
  }
];
const ONBOARDING_LAST_STEP = 6;
let onboardingStep = 0;

let currentModel = config.selectedModel;
let availableModels = [];
// Source à laquelle appartient `availableModels` (les listes ne sont pas
// interchangeables : noms de modèles Ollama d'un côté, fichiers GGUF de l'autre).
let availableModelsSource = null;
let isSpeaking = false;
let currentSpeakBtn = null;   // bouton 🔊 du message en cours de lecture (toggle stop)
let speakEndedResolver = null; // résout l'attente de fin (énonciation locale Piper) sur arrêt
let isGenerating = false;
// Arrêt demandé depuis le contrôleur physique. Coopératif : la boucle de
// lecture du flux le teste et s'interrompt en conservant ce qui est déjà
// arrivé, plutôt que d'annuler la requête et de tomber dans le chemin
// d'erreur, qui afficherait un échec pour un arrêt volontaire.
let stopRequested = false;
// Interrompt le flux de la génération en cours (Stop de la manette, etc.).
let generationAbort = null;
let agentRunningCount = 0; // nombre d'agents en cours d'exécution (indicateur orbe)
let lastOrbAgent = { active: false, count: 0, task: "", agent_id: "" };
let conversationHistory = [];
/// Poids estimé des définitions d'outils du dernier tour qui en a envoyé.
let lastToolTokens = 0;
let currentConversationId = null;

// Context window indicator DOM refs
let contextMeter;
let contextMeterFill;
let contextMeterLabel;
// Tracks whether we've already warned the user about context trimming for the
// current conversation (avoid spamming a note on every message).
let contextWarned = false;

// ===== Context window management =====
// Apple Intelligence (the Shortcut path) has a hard prompt budget. We keep the
// conversation usable without overflowing it.
const CTX = {
  maxMessages: 10,     // hard cap on messages sent to the shortcut
  hardLimit: 4000,     // Apple Intelligence token ceiling (for the meter)
  trimTrigger: 3000,   // above this many tokens, start trimming older messages
  trimTarget: 2500,    // trim down until at/below this many tokens
  warnRatio: 0.75,     // meter turns amber at 75% of hardLimit
  dangerRatio: 0.9,    // meter turns red at 90%
};

// Rough token estimate (~4 chars/token, +a few for role framing).
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4) + 4;
}
function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

// Build the windowed list of messages to actually send to Apple Intelligence.
// We never cut a conversation arbitrarily: the window must stay role-coherent —
// it always begins with a `user` turn and preserves the user→assistant
// alternation, so the serialized transcript reads as complete exchanges
// (and ends on the current user question). It's also capped at maxMessages and
// trimmed by tokens when the conversation grows large.
function buildShortcutWindow() {
  // Only user/assistant turns carry conversational context for the shortcut.
  const turns = conversationHistory.filter(m => m.role === 'user' || m.role === 'assistant');

  // 1) Hard cap on the number of messages.
  let win = turns.slice(-CTX.maxMessages);

  // 2) Token budget: once above the trigger, drop the oldest turns until we're
  //    back down to the target (keep at least the current question).
  if (estimateMessagesTokens(win) > CTX.trimTrigger) {
    while (win.length > 1 && estimateMessagesTokens(win) > CTX.trimTarget) {
      win.shift();
    }
  }

  // 3) Role parity: a transcript must start on a user turn. If the cuts above
  //    left a dangling assistant reply at the front, drop it so the window
  //    reads as complete user→assistant exchanges ending on the current user.
  while (win.length > 1 && win[0].role !== 'user') {
    win.shift();
  }

  return win;
}

// Serialize recent turns into a single prompt string for the shortcut, with the
// system prompt prepended once at the top.
function buildShortcutPrompt() {
  const win = buildShortcutWindow();
  const lines = [];
  const effSys = getEffectiveSystemPrompt();
  if (effSys) lines.push(effSys.trim(), "");

  if (win.length <= 1) {
    // Single turn: send it plainly (no transcript framing needed).
    lines.push(win[win.length - 1]?.content ?? "");
  } else {
    const uLabel = getLang() === 'en' ? 'User' : 'Utilisateur';
    const aLabel = 'Assistant';
    for (const m of win) {
      lines.push(`${m.role === 'user' ? uLabel : aLabel}: ${m.content}`);
    }
    // La fenêtre se termine déjà sur la question courante (`Utilisateur: …`).
    // On amorce donc le tour de l'ASSISTANT pour qu'il y réponde — et non un
    // nouveau tour utilisateur vide, qui poussait le modèle à re-saluer.
    lines.push(`${aLabel}:`);
  }
  return { promptText: lines.join("\n"), window: win };
}

// Update the on-screen context meter for the active mode.
/// Fenêtre de contexte du serveur llama.cpp en cours d'exécution (0 = arrêté).
/// Renseignée par la sonde d'état : elle prime sur le réglage, qui ne prendra
/// effet qu'au prochain démarrage du serveur.
let llamaRunningCtx = 0;

/// Fenêtre de contexte réellement applicable, en tokens.
///
/// `known: false` quand elle dépend d'un modèle distant ou d'un défaut qu'on ne
/// peut pas lire (Ollama sans `num_ctx` explicite, API cloud) : le compteur
/// affiche alors un nombre de tokens plutôt qu'un pourcentage inventé.
function contextWindow() {
  if (config.aiSource === 'shortcut') return { window: CTX.hardLimit, known: true };
  if (config.aiSource === 'llama') {
    return { window: llamaRunningCtx || config.llamaNumCtx || 8192, known: true };
  }
  if (config.aiSource === 'ollama' && config.ollamaNumCtx > 0) {
    return { window: config.ollamaNumCtx, known: true };
  }
  // Référence d'affichage, faute de mieux : le défaut d'Ollama dépend du modèle
  // et la fenêtre d'une API cloud n'est pas exposée.
  return { window: 8192, known: false };
}

/// Nombre de tokens en forme courte (« 2,8 k »).
function shortTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')} k` : String(n);
}

function updateContextMeter() {
  if (!contextMeter) return;
  const turns = conversationHistory.filter(m => m.role === 'user' || m.role === 'assistant');
  if (turns.length === 0) { contextMeter.hidden = true; return; }

  // What will actually be sent next.
  const isShortcut = config.aiSource === 'shortcut';
  const sent = isShortcut ? buildShortcutWindow() : turns;
  let used = estimateMessagesTokens(sent);
  if (config.systemPrompt) used += estimateTokens(config.systemPrompt);
  // Définitions d'outils du dernier tour avec outils (souvent > la discussion).
  if (!isShortcut) used += lastToolTokens;

  // Le pourcentage se mesure sur la fenêtre RÉELLE. Il était calculé sur une
  // référence figée à 8 000 tokens quelle que soit la source : avec llama.cpp
  // réglé à 32 768, le compteur affichait quatre fois trop, et il passait au
  // rouge sur une conversation que le modèle encaissait sans difficulté.
  const { window: max, known } = contextWindow();
  const ratio = Math.min(used / max, 1);

  contextMeter.hidden = false;
  contextMeterFill.style.width = `${Math.round(ratio * 100)}%`;
  // Fenêtre inconnue : afficher un pourcentage serait inventer un dénominateur.
  // On montre alors la quantité brute, qui elle est exacte.
  contextMeterLabel.textContent = known ? `${Math.round(ratio * 100)}%` : `~${shortTokens(used)} tok`;
  contextMeter.classList.toggle('danger', known && ratio >= CTX.dangerRatio);
  contextMeter.classList.toggle('warn', known && ratio >= CTX.warnRatio && ratio < CTX.dangerRatio);
  contextMeter.title = known
    ? t("ctx_tooltip", { used, max, count: sent.length })
    : t("ctx_tooltip_unknown", { used, count: sent.length });

  try { window.OrbBridge?.pushContext?.(used, max); } catch (e) {}
  // Mesure de la conversation courante partagée avec la fenêtre Halo.
  try {
    const source = config.aiSource || "shortcut";
    const backend = source === "llama" ? "llama.cpp" : source === "applefm" ? "applefm" : ["api", "lumen"].includes(source) ? "api" : "ollama";
    const model = source === "llama" ? config.selectedModel : source === "api" ? config.apiModel : source === "lumen" ? config.lumenModel : source === "applefm" ? config.applefmModel : config.selectedModel;
    localStorage.setItem("haloChatContext", JSON.stringify({ backend, model, used, total: known ? max : null, ts: Date.now() }));
  } catch {}

  // Warn once when the TOKEN budget is genuinely close to the limit (same
  // threshold as the amber meter). The 10-message sliding cap alone is normal
  // and must not trigger a scary note while usage is still low.
  if (isShortcut && ratio >= CTX.warnRatio && !contextWarned) {
    contextWarned = true;
    addContextNote(t("ctx_warn", { max: CTX.hardLimit }));
  }
}

// Append a centered, non-spoken system note inside the conversation.
function addContextNote(message) {
  if (!messagesList) return;
  const note = document.createElement('div');
  note.className = 'context-note';
  note.textContent = message;
  messagesList.appendChild(note);
  scrollToBottom();
}

// Initialize
// Poste un message dans la boîte de réception quand une nouvelle version est
// disponible. Une seule annonce par version : la clé `updater:announced` évite
// de reposter le même message à chaque démarrage.
async function announceUpdateIfAny() {
  try {
    const update = await checkUpdateQuietly();
    if (!update) return;
    if (localStorage.getItem("updater:announced") === update.version) return;
    localStorage.setItem("updater:announced", update.version);
    await invoke("inbox_post", {
      from: "Lumen",
      fromId: "system",
      subject: t("update_inbox_subject", { version: update.version }),
      body:
        t("update_inbox_body", { version: update.version, current: update.currentVersion }) + "\n\n" +
        `${update.body || ""}\n\n` +
        t("update_inbox_hint"),
    });
  } catch {
    // Pas de réseau, pas de release publiée, updater non configuré : on se tait.
  }
}

// GPL information is available in Settings; running Lumen needs no acceptance.
function initLicenseUI() {
  const btn = document.querySelector("#btn-show-license");
  if (!btn) return;
  btn.addEventListener("click", () => showLicense({ readOnly: true }));
  const status = document.querySelector("#license-status");
  if (status) {
    status.textContent = LICENSE_VERSION;
  }
}

// Stockage saturé : on le dit dans la barre, une seule fois.
onStorageFull((msg) => { try { showDictationHint(msg); } catch { console.warn(msg); } });

window.addEventListener("DOMContentLoaded", async () => {
  // Contrat de licence : rien d'autre ne démarre tant qu'il n'est pas accepté.
  // Refuser ferme Lumen (cf. legal/license.js). Une nouvelle version du contrat
  // rouvre cette porte au lancement suivant.
  await ensureLicenseAccepted();

  // Saveur de build (Raspberry Pi : Apple masqué, Ollama forcé). Détectée avant
  // toute application d'UI pour que la source soit correcte d'entrée.
  await applyPlatformFlavor();

  // SÉCURITÉ — clé API : migration ponctuelle de l'ancienne valeur localStorage
  // vers le backend (où elle vit désormais, en 0600), puis effacement local.
  // Ensuite on lit l'état (configurée ?) sans jamais récupérer la clé en clair.
  await syncApiKeyState();

  // Outils d'écriture (sélection → Relire, Réécrire, Traduire…) et feuille IA
  // flottante, aussi dans la barre : le champ de saisie et les réponses du fil
  // sont du texte comme les autres. Cf. lib/writing-tools.js.
  try {
    const { share: shareObject } = await import("./lib/share-menu.js?v=2");
    installWritingTools({
      openSheet: (spec) => openAiSheet({ ...spec, lang: getLang() === "en" ? "en" : "fr" }),
      // « Envoyer vers… » depuis la barre : le sélecteur s'affiche ici, et
      // l'objet est relayé au bureau, seul capable d'ouvrir les apps.
      share: (obj) => shareObject(obj),
      toast: (msg) => { try { addMessageBubble(String(msg), "assistant"); } catch {} },
    });
    window.LumenAskSheet = (spec) => openAiSheet({ ...spec, lang: getLang() === "en" ? "en" : "fr" });
  } catch (e) { console.warn("[writing-tools]", e); }

  // Réglages de la recherche web : copie côté backend, pour que les AGENTS
  // (qui tournent en Rust, parfois sur un CRON fenêtre fermée) voient la même
  // configuration que la barre. Cf. lib/web-tools.js.
  mirrorWebConfig();

  // Mise à jour disponible ? Vérification discrète (une fois par jour, silence
  // total en cas d'échec). Le résultat arrive dans la boîte de réception plutôt
  // qu'en modale : rien ne doit interrompre l'ouverture de la barre.
  announceUpdateIfAny();

  // Query search search elements
  chatInput = document.querySelector("#chat-input");
  sendBtn = document.querySelector("#send-btn");
  messagesContainer = document.querySelector("#messages-container");
  messagesList = document.querySelector("#messages-list");
  statusIndicator = document.querySelector("#status-indicator");
  wireStatusRepair();
  btn350mToggle = document.querySelector("#model-toggle-pill");
  btn350mLabel = document.querySelector("#model-toggle-label");
  winClose = document.querySelector("#win-close");
  btnClearChat = document.querySelector("#btn-clear-chat");
  mountExportBar();
  searchBar = document.querySelector("#search-bar");
  btnAttach = document.querySelector("#btn-attach");
  imageInput = document.querySelector("#image-input");
  attachPreview = document.querySelector("#attach-preview");
  activeChatLabel = document.querySelector("#active-chat-label");
  contextMeter = document.querySelector("#context-meter");
  contextMeterFill = document.querySelector("#context-meter-fill");
  contextMeterLabel = document.querySelector("#context-meter-label");

  // Query settings elements
  btnSettings = document.querySelector("#btn-settings");
  settingsPanel = document.querySelector("#settings-panel");
  btnCloseSettings = document.querySelector("#btn-close-settings");
  btnSaveSettings = document.querySelector("#btn-save-settings");
  inputOllamaUrl = document.querySelector("#input-ollama-url");
  selectModel = document.querySelector("#select-model");
  checkboxAlwaysOnTop = document.querySelector("#checkbox-always-on-top");
  checkboxBarOpaque = document.querySelector("#checkbox-bar-opaque");
  checkboxStartupLumenOS = document.querySelector("#checkbox-startup-lumen-os");
  checkboxHalo = document.querySelector("#checkbox-halo");
  checkboxDebug = document.querySelector("#checkbox-debug");
  sliderTransparency = document.querySelector("#slider-transparency");
  labelTransparencyVal = document.querySelector("#label-transparency-val");
  selectBarSize = document.querySelector("#select-bar-size");
  selectAiSource = document.querySelector("#select-ai-source");
  groupApi = document.querySelector("#settings-group-api");
  Promise.all([refreshLumenServerBackend(), refreshAppleFmBackend()])
    .then(() => { toggleSettingsGroups(config.aiSource); updateModelLabel(); checkOllamaStatus(); })
    .catch(() => {});
  inputApiKey = document.querySelector("#input-api-key");
  inputApiBase = document.querySelector("#input-api-base");
  inputApiModel = document.querySelector("#input-api-model");
  selectImageModel = document.querySelector("#select-image-model");
  // Changer de moteur repeuple la liste des modèles : chacun a les siens.
  selectImageProvider?.addEventListener("change", () => renderImageModelSelect(selectImageProvider.value));
  selectImageProvider = document.querySelector("#select-image-provider");
  groupOllama = document.querySelector("#settings-group-ollama");
  groupShortcut = document.querySelector("#settings-group-shortcut");
  groupFluxo = document.querySelector("#settings-group-fluxo");
  checkboxFluxoTools = document.querySelector("#checkbox-fluxo-tools");
  checkboxOllamaThink = document.querySelector("#checkbox-ollama-think");
  inputOllamaNumCtx = document.querySelector("#input-ollama-num-ctx");
  inputOllamaKeepAlive = document.querySelector("#input-ollama-keep-alive");
  inputShortcutName = document.querySelector("#input-shortcut-name");
  inputActionRouter = document.querySelector("#input-action-router");
  selectSpeechBackend = document.querySelector("#select-speech-backend");
  inputSpeakShortcut = document.querySelector("#input-speak-shortcut");
  inputDictateShortcut = document.querySelector("#input-dictate-shortcut");
  inputSystemPrompt = document.querySelector("#input-system-prompt");
  checkboxOrb = document.querySelector("#checkbox-orb");
  sliderOrbSize = document.querySelector("#slider-orb-size");
  labelOrbSizeVal = document.querySelector("#label-orb-size-val");
  sliderOrbCore = document.querySelector("#slider-orb-core");
  labelOrbCoreVal = document.querySelector("#label-orb-core-val");
  sliderOrbPulse = document.querySelector("#slider-orb-pulse");
  labelOrbPulseVal = document.querySelector("#label-orb-pulse-val");
  checkboxOrbHeartbeat = document.querySelector("#checkbox-orb-heartbeat");
  orbHeartColorInput = document.querySelector("#orb-heart-color");
  btnOrbHeartColorReset = document.querySelector("#btn-orb-heart-color-reset");
  sliderOrbPulseStrength = document.querySelector("#slider-orb-pulse-strength");
  labelOrbPulseStrengthVal = document.querySelector("#label-orb-pulse-strength-val");
  sliderOrbPulseSpeed = document.querySelector("#slider-orb-pulse-speed");
  labelOrbPulseSpeedVal = document.querySelector("#label-orb-pulse-speed-val");
  btnOrbPulsePreview = document.querySelector("#btn-orb-pulse-preview");
  selectOrbGlass = document.querySelector("#select-orb-glass");
  selectOrbTheme = document.querySelector("#select-orb-theme");
  if (selectOrbTheme) selectOrbTheme.replaceChildren(...Object.entries(ORB_CHARACTERS).map(([id, preset]) => {
    const option = document.createElement('option'); option.value = id; option.textContent = config.language === 'en' ? preset.en : preset.name; return option;
  }));
  // Habillage de l'édition Pro : la ligne n'existe que si l'édition l'est.
  const flavorSelect = document.querySelector("#select-pro-flavor");
  if (flavorSelect) {
    flavorSelect.value = proFlavor();
    whenProResolved((on) => {
      const row = document.querySelector("#pro-flavor-row");
      if (row) row.hidden = !on;
      flavorSelect.value = proFlavor();
    });
    flavorSelect.addEventListener("change", () => {
      setProFlavor(flavorSelect.value);
      applyOrbTheme();
    });
  }
  orbColorInputs = [0,1,2,3,4].map(i => document.querySelector(`#orb-color-${i}`));
  btnOrbColorsReset = document.querySelector("#btn-orb-colors-reset");
  selectTheme = document.querySelector("#select-theme");
  selectTextColor = document.querySelector("#select-text-color");
  btnThemeToggle = document.querySelector("#btn-theme-toggle");
  btnActionMode = document.querySelector("#btn-action-mode");
  btnFluxoTools = document.querySelector("#btn-fluxo-tools");
  btnAutoSpeak = document.querySelector("#btn-autospeak");
  btnDictation = document.querySelector("#btn-dictation");
  btnMore = document.querySelector("#btn-more");
  toolbarOverflow = document.querySelector("#toolbar-overflow");
  btnHeartbeat = document.querySelector("#btn-heartbeat");
  btnMemory = document.querySelector("#btn-memory");
  btnOrchestrate = document.querySelector("#btn-orchestrate");
  checkboxOrchestrate = document.querySelector("#checkbox-orchestrate");
  checkboxHeartbeat = document.querySelector("#checkbox-heartbeat");
  inputHeartbeatShortcut = document.querySelector("#input-heartbeat-shortcut");
  selectHeartbeatFrequency = document.querySelector("#select-heartbeat-frequency");
  heartbeatCronRow = document.querySelector("#heartbeat-cron-row");
  inputHeartbeatCron = document.querySelector("#input-heartbeat-cron");
  inputHeartbeatInput = document.querySelector("#input-heartbeat-input");

  // Onboarding wizard elements
  onboardingPanel = document.querySelector("#onboarding-panel");
  onboardingTitle = document.querySelector("#onboarding-title");
  onboardingDots = document.querySelector("#onboarding-dots");
  shortcutCardsContainer = document.querySelector("#shortcut-cards");
  btnOpenOnboarding = document.querySelector("#btn-open-onboarding");
  btnCloseOnboarding = document.querySelector("#btn-close-onboarding");
  btnOnboardingPrev = document.querySelector("#btn-onboarding-prev");
  btnOnboardingNext = document.querySelector("#btn-onboarding-next");
  btnRecheckShortcuts = document.querySelector("#btn-recheck-shortcuts");
  btnOpenAiSettings = document.querySelector("#btn-open-ai-settings");

  // Query history elements
  btnHistory = document.querySelector("#btn-history");
  historyPanel = document.querySelector("#history-panel");
  btnCloseHistory = document.querySelector("#btn-close-history");
  btnNewChat = document.querySelector("#btn-new-chat");
  conversationsListContainer = document.querySelector("#conversations-list-container");

  // Query notifications elements
  btnNotifications = document.querySelector("#btn-notifications");
  notifBadge = document.querySelector("#notif-badge");
  notificationsPanel = document.querySelector("#notifications-panel");
  btnCloseNotifications = document.querySelector("#btn-close-notifications");
  btnClearNotifications = document.querySelector("#btn-clear-notifications");
  notificationsListContainer = document.querySelector("#notifications-list-container");

  // Query Fluxo elements
  btnFluxo = document.querySelector("#btn-fluxo");
  btnLumenOS = document.querySelector("#btn-lumen-os");
  btnShellMode = document.querySelector("#btn-shell-mode");
  btnShellMode?.addEventListener("click", () => changeMode(invoke).catch((e) => console.error(e)));
  btnAgents = document.querySelector("#btn-agents");
  btnOllamaMode = document.querySelector("#btn-ollama-mode");
  ollamaModeMenu = document.querySelector("#ollama-mode-menu");
  backendMenu = document.querySelector("#backend-menu");
  fluxoPanel = document.querySelector("#fluxo-panel");
  toolboxPanel = document.querySelector("#toolbox-panel");
  btnCloseFluxo = document.querySelector("#btn-close-fluxo");
  btnRefreshFluxo = document.querySelector("#btn-refresh-fluxo");
  btnOpenFluxoDesigner = document.querySelector("#btn-open-fluxo-designer");
  fluxoListContainer = document.querySelector("#fluxo-list-container");

  // Toggle Theme Button Listener
  btnThemeToggle.addEventListener("click", () => {
    // Ce bouton bascule LE thème de Lumen, pas seulement celui de la barre.
    // Il n'y a plus qu'un clair/sombre : le bureau, les fenêtres d'apps et la
    // capsule suivent, ici comme depuis le bouton du bureau. `setTheme` écrit
    // la clé unifiée et les anciennes, et repose les attributs de <html>.
    const next = resolvedTheme() === 'light' ? 'dark' : 'light';
    setTheme(next);
    config.themePreference = next;
    applyConfigUI();
  });

  // Avatar (orb) live controls
  checkboxOrb.addEventListener("change", () => {
    window.LumenOrb?.setEnabled(checkboxOrb.checked);
  });
  sliderOrbSize.addEventListener("input", () => {
    const v = parseInt(sliderOrbSize.value, 10);
    labelOrbSizeVal.textContent = v;
    window.LumenOrb?.setSize(v);
  });
  sliderOrbCore.addEventListener("input", () => {
    const v = parseInt(sliderOrbCore.value, 10);
    labelOrbCoreVal.textContent = v;
    window.LumenOrb?.setCoreScale(v);
  });
  selectOrbGlass.addEventListener("change", () => {
    window.LumenOrb?.setGlassType(selectOrbGlass.value);
  });
  if (selectOrbTheme) {
    selectOrbTheme.addEventListener("change", () => {
      config.orbTheme = selectOrbTheme.value;
      localStorage.setItem('orbTheme', config.orbTheme);
      applyConfigUI();              // ré-applique fond barre + orbe en direct
      updateOrbThemeLock();         // grise les réglages quand un thème est actif
    });
  }
  checkboxOrbHeartbeat.addEventListener("change", () => {
    window.LumenOrb?.setHeartbeat(checkboxOrbHeartbeat.checked);
    // Preview the heart pulse when the user turns it on.
    if (checkboxOrbHeartbeat.checked) window.LumenOrb?.pulseHeart();
  });
  // Choix de couleur de pulsation retiré (jamais fonctionnel) : la couleur du
  // heartbeat suit la palette de l'orbe / le thème.
  orbHeartColorInput?.addEventListener("input", () => {
    window.LumenOrb?.setHeartColor(orbHeartColorInput.value);
    window.LumenOrb?.pulseHeart(); // live preview
  });
  btnOrbHeartColorReset?.addEventListener("click", () => {
    orbHeartColorInput.value = '#ff4d6d';
    window.LumenOrb?.setHeartColor('#ff4d6d');
    window.LumenOrb?.pulseHeart();
  });
  sliderOrbPulseStrength.addEventListener("input", () => {
    const v = parseInt(sliderOrbPulseStrength.value, 10);
    labelOrbPulseStrengthVal.textContent = v;
    window.LumenOrb?.setPulseStrength(v);
    window.LumenOrb?.pulseHeart();
  });
  sliderOrbPulseSpeed.addEventListener("input", () => {
    const v = parseInt(sliderOrbPulseSpeed.value, 10);
    labelOrbPulseSpeedVal.textContent = v;
    window.LumenOrb?.setPulseSpeed(v);
    window.LumenOrb?.pulseHeart();
  });
  btnOrbPulsePreview.addEventListener("click", () => window.LumenOrb?.pulseHeart());

  // Orbe physique (ESP32) : IP + connexion via le pont (voir orb-bridge.js)
  const inputOrbHost = document.querySelector("#input-orb-host");
  const btnOrbConnect = document.querySelector("#btn-orb-connect");
  const orbDeviceStatus = document.querySelector("#orb-device-status");
  if (inputOrbHost && btnOrbConnect) {
    inputOrbHost.value = localStorage.getItem("orbBridgeHost") || "";
    const refreshOrbStatus = () => {
      if (!orbDeviceStatus) return;
      orbDeviceStatus.textContent = window.OrbBridge?.connected
        ? t("dyn_orb_connected") || "Connecté ✓"
        : t("dyn_orb_disconnected") || "Non connecté.";
    };
    btnOrbConnect.addEventListener("click", async () => {
      const host = inputOrbHost.value.trim();
      // Ce champ de la fenêtre principale ne concerne que l'ORBE. Le Lumen
      // Controller a sa propre adresse (`controllerHost`), réglable dans la
      // fenêtre Réglages : les deux appareils fonctionnent en même temps.
      if (host) localStorage.setItem("orbBridgeHost", host);
      else localStorage.removeItem("orbBridgeHost");
      try {
        await window.OrbBridge?.connect('orb');
      } catch (e) {}
      setTimeout(refreshOrbStatus, 400);
    });
    setInterval(refreshOrbStatus, 2000);
    refreshOrbStatus();
  }

  // Settings tabs
  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      document.querySelectorAll(".settings-tab").forEach(t => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".settings-tab-pane").forEach(p => p.classList.toggle("active", p.dataset.pane === name));
      const dd = document.querySelector("#settings-tab-dropdown");
      if (dd) dd.value = name; // garde le menu compact synchronisé
    });
  });
  // Variante compacte (barre étroite) : le menu déroulant pilote les mêmes onglets.
  const tabDropdown = document.querySelector("#settings-tab-dropdown");
  if (tabDropdown) {
    tabDropdown.addEventListener("change", () => {
      const btn = document.querySelector(`.settings-tab[data-tab="${tabDropdown.value}"]`);
      if (btn) btn.click(); // réutilise toute la logique (dont chargement profil/mémoire)
    });
  }
  let pulsePreviewTimer = null;
  sliderOrbPulse.addEventListener("input", () => {
    const v = parseInt(sliderOrbPulse.value, 10);
    labelOrbPulseVal.textContent = v;
    window.LumenOrb?.setPulse(v);
    // Briefly drive the speaking animation so the amplitude is visible live,
    // unless a real synthesis is actually running.
    if (!isSpeaking) {
      window.LumenOrb?.setState('speaking');
      clearTimeout(pulsePreviewTimer);
      pulsePreviewTimer = setTimeout(() => {
        if (!isSpeaking) window.LumenOrb?.setState(isGenerating ? 'thinking' : 'idle');
      }, 1400);
    }
  });
  const applyOrbColorsLive = () => {
    const cols = orbColorInputs.map(i => i.value);
    window.LumenOrb?.setColors(cols);

  };
  orbColorInputs.forEach(inp => inp && inp.addEventListener("input", applyOrbColorsLive));
  btnOrbColorsReset.addEventListener("click", () => {
    const def = window.LumenOrb?.DEFAULT_COLORS || defaultOrbColors();
    orbColorInputs.forEach((inp, i) => { if (inp) inp.value = def[i]; });
    applyOrbColorsLive();
  });

  // Toggle Action Mode Listener
  btnActionMode.addEventListener("click", () => {
    config.actionModeActive = !config.actionModeActive;
    localStorage.setItem('actionModeActive', config.actionModeActive.toString());
    updateActionModeUI();
    remotePushActionMode();
  });

  // Équivalent Ollama du mode Action : active le function calling Fluxo, pour
  // que le modèle déclenche lui-même les workflows. Reflète (et synchronise) la
  // case « Actions Fluxo via l'IA » des Paramètres.
  btnFluxoTools?.addEventListener("click", () => {
    config.fluxoTools = !config.fluxoTools;
    localStorage.setItem('fluxoTools', config.fluxoTools.toString());
    if (checkboxFluxoTools) checkboxFluxoTools.checked = config.fluxoTools;
    updateFluxoToolsUI();
  });

  // Outil mémoire : disponible dans la discussion simple, sans basculer en mode
  // Outils. Le modèle décide lui-même d'appeler `memory_recall` avant de
  // répondre, ou `memory_remember` quand l'utilisateur lui demande de retenir.
  btnMemory?.addEventListener("click", () => {
    config.memoryTool = !config.memoryTool;
    localStorage.setItem('memoryTool', config.memoryTool.toString());
    updateMemoryToolUI();
  });

  // Réponse orchestrée : bouton de la barre + interrupteur des Réglages,
  // partagés avec le bureau, le compagnon et Lumen XR (clé `orchestrateChat`).
  btnOrchestrate?.addEventListener("click", () => setOrchestrate(!config.orchestrate));
  checkboxOrchestrate?.addEventListener("change", () => setOrchestrate(checkboxOrchestrate.checked));
  // Modèle rapide de la réponse orchestrée (lib/orchestrator-host.js).
  const fastInput = document.querySelector("#input-orchestrate-fast");
  if (fastInput) {
    fastInput.value = localStorage.getItem("orchestratorFastModel") || "";
    fastInput.addEventListener("change", () => {
      const v = fastInput.value.trim();
      if (v) localStorage.setItem("orchestratorFastModel", v); else localStorage.removeItem("orchestratorFastModel");
    });
  }
  const strongInput = document.querySelector("#input-orchestrate-strong");
  if (strongInput) {
    strongInput.value = strongBackendFor(llmBackend())?.model || "";
    strongInput.addEventListener("change", async () => {
      const value = strongInput.value.trim();
      try { await invoke("agent_set_fallback_model", { model: value }); }
      catch (e) { showHint(String(e)); return; }
      localStorage.setItem("orchestratorStrongProvider", modelProviderKey(llmBackend()));
      if (value) localStorage.setItem("orchestratorStrongModel", value);
      else localStorage.removeItem("orchestratorStrongModel");
    });
  }
  // « Toujours autoriser » doit rester révocable.
  document.querySelector("#btn-access-log")?.addEventListener("click", showAccessLog);
  document.querySelector("#btn-reset-sandbox-access")?.addEventListener("click", () => {
    resetSandboxPolicy();
    showHint(t("dyn_sandbox_access_reset"));
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "orchestrateChat") setOrchestrate(e.newValue === "true", { persist: false });
  });
  updateOrchestrateUI();

  // Toggle Auto-Speak Listener
  btnAutoSpeak.addEventListener("click", () => {
    config.autoSpeak = !config.autoSpeak;
    localStorage.setItem('autoSpeak', config.autoSpeak.toString());
    updateAutoSpeakUI();
    remotePushAutospeak();
  });

  // Dictation: run a macOS shortcut containing a "Dictate Text" action. The
  // shortcut captures the voice and returns the transcription, which we drop
  // into the chat input. Reliable and needs no Accessibility permission.
  // `autoSend` : la dictée a été déclenchée depuis le Lumen Controller, donc
  // sans clavier à portée. On envoie le message dès la transcription obtenue,
  // sinon il faudrait revenir à l'ordinateur pour appuyer sur Entrée.
  let dictationViz = null;
  let dictationAbort = null;
  let dictationBusy = false;
  async function runDictation(autoSend = false) {
    // Whisper à l'écoute : un second clic arrête l'enregistrement (le bouton
    // reste actif exprès pour ça) et lance la transcription.
    if (dictationAbort) { dictationAbort.abort(); return; }
    if (dictationBusy) return;
    dictationBusy = true;
    messagesContainer.style.display = 'flex';
    btnDictation.classList.add("active");
    // Dictée native : le bouton n'a rien à faire pendant le raccourci. Avec
    // Whisper il reste cliquable (arrêt anticipé, cf. dictationAbort).
    if (!whisperEnabled()) btnDictation.disabled = true;
    showDictationHint(t("dyn_dictating"));
    try {
      let text = "";
      // Option Réglages : dictée Whisper locale (transformers.js, multi-OS).
      // Moteur téléchargé à la demande + mis en cache. EXCLUSIF : quand
      // l'option est active, on ne déclenche JAMAIS la dictée native derrière
      // (sinon un silence/échec Whisper enchaînait sur la dictée Apple, vécue
      // comme un double déclenchement). Un souci = message, pas de repli.
      if (whisperEnabled()) {
        // Spectromètre dans la capsule : début d'écoute, spectre en direct,
        // compte à rebours de la pause puis affaissement à la fin (cf.
        // lib/dictation-visualizer.js). Le micro reste cliquable pour arrêter
        // plus tôt : on transcrit alors ce qui a été capté.
        dictationViz ??= createDictationVisualizer(searchBar, { before: attachPreview });
        dictationAbort = new AbortController();
        searchBar.classList.add("dictating");
        try {
          text = await whisperDictate({
            signal: dictationAbort.signal,
            onAnalyser: (a) => dictationViz.setAnalyser(a),
            onLevel: (lvl, spk, end) => dictationViz.setLevel(lvl, spk, end),
            onState: (phase) => {
              // Anneau fin autour du micro pendant le chargement du modèle et
              // la transcription (cf. .dictation-btn.working dans styles.css).
              btnDictation.classList.toggle("working", phase === "loading" || phase === "transcribing");
              if (phase === "recording") dictationViz.start();
              else if (phase === "transcribing" || phase === "idle") dictationViz.end();
              showDictationHint(
                phase === "loading" ? t("dyn_whisper_loading") :
                phase === "recording" ? t("dyn_whisper_recording") :
                phase === "transcribing" ? t("dyn_whisper_transcribing") : t("dyn_dictating"));
            },
          });
        } finally {
          dictationAbort = null;
          searchBar.classList.remove("dictating");
          btnDictation.classList.remove("working");
          dictationViz.hide();
        }
      } else {
        // Dictée indépendante du moteur d'actions : la commande Rust `dictate`
        // choisit la dictée native de l'OS si disponible (macOS), sinon le
        // repli portable (Fluxo + Whisper).
        text = await invoke("dictate", { shortcutName: config.dictateShortcut });
      }
      text = stripRTF(text || '').trim();
      if (text) {
        chatInput.value = chatInput.value.trim()
          ? `${chatInput.value.trim()} ${text}`
          : text;
        autosizeChatInput();
        chatInput.focus();
        chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
        hideDictationHint();
        if (autoSend) {
          // Le bouton est réarmé dans le `finally`, qui n'a pas encore été
          // exécuté : on laisse la main avant d'enchaîner sur l'envoi.
          setTimeout(() => handleSend(), 0);
        }
      } else {
        showDictationHint(t("dyn_no_dictation"));
      }
    } catch (err) {
      console.error("Dictée impossible :", err);
      // Message adapté au moteur actif : l'erreur Whisper (micro refusé, modèle
      // non téléchargé hors-ligne…) n'a rien à voir avec le raccourci Apple.
      showDictationHint(whisperEnabled()
        ? t("dyn_whisper_fail", { err: err?.message || err })
        : t("dyn_dictate_missing", { name: config.dictateShortcut }));
    } finally {
      btnDictation.classList.remove("active");
      btnDictation.disabled = false;
      dictationBusy = false;
    }
  }

  btnDictation.addEventListener("click", () => runDictation(false));

  // Infobulle du micro : nomme le backend réellement utilisé (le réglage vit
  // en localStorage et peut changer depuis la fenêtre Réglages → on relit à
  // chaque survol plutôt que de figer la valeur au chargement).
  const syncDictationTitle = () => {
    btnDictation.title = t(whisperEnabled() ? "tt_dictation_whisper" : "tt_dictation_native");
    btnDictation.removeAttribute("data-i18n-title");
  };
  syncDictationTitle();
  btnDictation.addEventListener("mouseenter", syncDictationTitle);
  window.addEventListener("storage", (e) => { if (e.key === "whisperDictation") syncDictationTitle(); });

  // Raccourcis clavier de la barre. Enregistrés en capture pour rester
  // atteignables même quand le focus est dans le champ de saisie.
  document.addEventListener("keydown", (e) => {
    if (!isShortcutChord(e)) return;
    switch (e.code) {
      case "KeyD": e.preventDefault(); runDictation(false); break;
      case "KeyB": e.preventDefault(); cycleAiSource(1); break;
      case "KeyM": e.preventDefault(); cycleOllamaMode(1); break;
      case "KeyK": e.preventDefault(); showHint(t("dyn_shortcuts_help", { mod: SHORTCUT_MOD_LABEL })); break;
      default: break;
    }
  }, true);

  // Bouton Mic du Lumen Controller. L'événement est annulable : en appelant
  // preventDefault() on signale à orb-bridge.js que la dictée est prise en
  // charge ici, ce qui lui évite son repli par clic sur le bouton.
  window.addEventListener("lumen-controller-dictation", (e) => {
    e.preventDefault();
    runDictation(true);
  });

  // Appui long sur Backend : charge en mémoire le modèle affiché.
  window.addEventListener("lumen-controller-preload", (e) => {
    e.preventDefault();
    preloadModel();
  });

  // Appui long sur Mic : nouvelle conversation. On passe par le clic du
  // bouton plutôt que d'appeler startNewChat() directement, pour emprunter
  // exactement le même chemin que « Nettoyer la discussion » — c'est déjà ce
  // que fait la commande distante `clear`.
  window.addEventListener("lumen-controller-new-chat", (e) => {
    e.preventDefault();
    btnClearChat?.click();
  });

  // Bouton Mode : mode de discussion. On passe par setOllamaMode(), qui gère
  // aussi la compatibilité `fluxoTools` et la synchronisation mobile.
  window.addEventListener("lumen-controller-mode", (e) => {
    e.preventDefault();
    const mode = e?.detail?.mode;
    if (OLLAMA_MODES[mode]) setOllamaMode(mode, e?.detail?.workflow);
  });

  // Appui long sur le poussoir de l'encodeur : tout arrêter.
  window.addEventListener("lumen-controller-stop", (e) => {
    e.preventDefault();
    orbSpeechGen++;
    stopFromController();
  });

  // Badge RFID passé sur le contrôleur. En mode bureau, c'est la fenêtre du
  // bureau qui applique l'association (`installRfidBindings` dans
  // sandbox/desktop.js) : la barre est cachée derrière lui, agir ici ferait
  // l'action deux fois et n'afficherait le retour nulle part.
  window.addEventListener("lumen-controller-rfid", (e) => {
    e.preventDefault();
    if (remoteDesktopModeActive) return;
    runRfidBinding(e?.detail?.uid);
  });
  // Reprise des associations d'avant le stockage backend, où l'UID vivait en
  // clair dans localStorage. Faite ici aussi, pour ne pas dépendre de
  // l'ouverture des Réglages.
  migrateLegacyBindings().catch(() => {});

  // Potentiomètre de volume du contrôleur. L'événement était bien émis par
  // orb-bridge.js, mais personne ne l'écoutait : c'est le maillon qui manquait
  // pour que la molette agisse réellement sur le son de l'ordinateur.
  window.addEventListener("lumen-controller-volume", (e) => {
    applyControllerVolume(e?.detail?.value);
  });

  // Heartbeat: toolbar button toggles the scheduled background task on/off.
  btnHeartbeat.addEventListener("click", () => {
    config.heartbeatEnabled = !config.heartbeatEnabled;
    localStorage.setItem('heartbeatEnabled', config.heartbeatEnabled.toString());
    applyHeartbeat();
    updateHeartbeatUI();
  });

  // Show the custom CRON field only when "Personnalisé" is selected.
  selectHeartbeatFrequency.addEventListener("change", (e) => {
    heartbeatCronRow.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  // Overflow toolbar menu: deploy/hide the collapsed tool buttons.
  btnMore.addEventListener("click", (e) => {
    e.stopPropagation();
    toolbarOverflow.classList.toggle("open");
    btnMore.classList.toggle("active", toolbarOverflow.classList.contains("open"));
  });
  // Close the overflow when a tool inside it is used, or when clicking elsewhere.
  toolbarOverflow.addEventListener("click", () => closeToolbarOverflow());
  document.addEventListener("click", (e) => {
    if (!toolbarOverflow.contains(e.target) && e.target !== btnMore && !btnMore.contains(e.target)) {
      closeToolbarOverflow();
    }
  });

  // Distribute the tool buttons between the bar and the overflow menu.
  applyToolbarLayout();

  // Close App
  winClose.addEventListener("click", () => invoke("close_window"));
  
  // Custom Mouse Drag Handling.
  // On gère le déplacement nous-mêmes (via set_window_position) plutôt qu'avec
  // le drag natif : ce dernier est contraint par macOS et empêche de remonter la
  // fenêtre au-dessus d'une certaine limite (barre de menus). Le positionnement
  // manuel, lui, n'est pas bridé.
  searchBar.addEventListener("mousedown", (e) => {
    // `textarea` est indispensable : le champ de saisie en est un depuis qu'il
    // grandit avec le texte — sans lui, cliquer dedans déplace la fenêtre au
    // lieu de donner le focus.
    const isClickable = e.target.closest('input, textarea, button, .quick-model-toggle');
    if (!isClickable) {
      e.preventDefault();
      startManualDrag();
    }
  });

  // L'orbe est une seconde poignée : c'est la cible la plus évidente du regard,
  // et la barre peut être entièrement occupée par le champ et les boutons.
  document.querySelector("#orb-grab")?.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || document.documentElement.classList.contains("shell-app")) return; // la barre conserve sa poignée, Application utilise son en-tête
    e.preventDefault();
    startManualDrag();
  });

  // Settings Panel Toggles
  btnSettings.addEventListener("click", (e) => {
    e.stopPropagation();
    closeToolbarOverflow();
    invoke("open_settings").catch((err) => console.error("Ouverture des paramètres impossible :", err));
    return;
    historyPanel.classList.remove("active");
    notificationsPanel.classList.remove("active");
    fluxoPanel.classList.remove("active");

    // Fill settings inputs
    inputOllamaUrl.value = config.ollamaUrl;
    if (inputApiKey) inputApiKey.value = config.apiKey;
    if (inputApiBase) inputApiBase.value = config.apiBaseUrl;
    if (inputApiModel) inputApiModel.value = config.apiModel;
    const inputLumenModel = document.querySelector('#input-lumen-model');
    if (inputLumenModel) inputLumenModel.value = config.lumenModel;
    refreshLumenServerBackend();
    const selectApplefmModel = document.querySelector('#select-applefm-model');
    if (selectApplefmModel) selectApplefmModel.value = config.applefmModel;
    refreshAppleFmBackend();
    if (selectImageProvider) selectImageProvider.value = config.imageProvider;
    refreshImagePlaygroundOption();
    pushImageConfig(invoke);
    renderImageModelSelect();
    populateModelDropdown();
    fetchAvailableModels();
    checkboxAlwaysOnTop.checked = config.alwaysOnTop;
    if (checkboxBarOpaque) checkboxBarOpaque.checked = effectiveBarOpaque();
    if (checkboxStartupLumenOS) checkboxStartupLumenOS.checked = config.startupLumenOS;
    if (checkboxHalo) checkboxHalo.checked = config.halo;
    if (checkboxDebug) checkboxDebug.checked = config.debugMode;
    sliderTransparency.value = Math.round(config.glassOpacity * 100);
    labelTransparencyVal.textContent = `${Math.round(config.glassOpacity * 100)}%`;
    selectBarSize.value = config.barSize;
    selectAiSource.value = config.aiSource;
    inputShortcutName.value = config.shortcutName;
    inputActionRouter.value = config.actionRouter;
    if (selectSpeechBackend) selectSpeechBackend.value = config.speechBackend || 'auto';
    inputSpeakShortcut.value = config.speakShortcut;
    inputDictateShortcut.value = config.dictateShortcut;
    inputSystemPrompt.value = config.systemPrompt;
    if (checkboxFluxoTools) checkboxFluxoTools.checked = config.fluxoTools;
    if (checkboxOllamaThink) checkboxOllamaThink.checked = config.ollamaThink;
    if (inputOllamaNumCtx) inputOllamaNumCtx.value = config.ollamaNumCtx || '';
    if (inputOllamaKeepAlive) inputOllamaKeepAlive.value = config.ollamaKeepAlive || '';
    checkboxOrb.checked = config.orbEnabled;
    sliderOrbSize.value = config.orbSize;
    labelOrbSizeVal.textContent = config.orbSize;
    sliderOrbCore.value = config.orbCoreScale;
    labelOrbCoreVal.textContent = config.orbCoreScale;
    sliderOrbPulse.value = config.orbPulse;
    labelOrbPulseVal.textContent = config.orbPulse;
    checkboxOrbHeartbeat.checked = config.orbHeartbeat;
    if (orbHeartColorInput) orbHeartColorInput.value = config.orbHeartColor;
    sliderOrbPulseStrength.value = config.orbPulseStrength;
    labelOrbPulseStrengthVal.textContent = config.orbPulseStrength;
    sliderOrbPulseSpeed.value = config.orbPulseSpeed;
    labelOrbPulseSpeedVal.textContent = config.orbPulseSpeed;
    selectOrbGlass.value = config.orbGlassType;
    if (selectOrbTheme) {
      // Tous les thèmes sont offerts à toutes les éditions (les anciens thèmes
      // « Pro » sont des habillages comme les autres depuis le 15/09/2026).
      selectOrbTheme.querySelectorAll('option[data-pro]').forEach((opt) => {
        opt.hidden = false;
        opt.disabled = false;
      });
      selectOrbTheme.value = config.orbTheme;
    }
    updateOrbThemeLock();
    orbColorInputs.forEach((inp, i) => { if (inp) inp.value = config.orbColors[i]; });
    selectTheme.value = config.themePreference;
    if (selectTextColor) selectTextColor.value = config.textColor;

    // Heartbeat fields
    checkboxHeartbeat.checked = config.heartbeatEnabled;
    inputHeartbeatShortcut.value = config.heartbeatShortcut;
    inputHeartbeatInput.value = config.heartbeatInput;
    inputHeartbeatCron.value = config.heartbeatCron;
    const presets = Array.from(selectHeartbeatFrequency.options).map(o => o.value);
    if (presets.includes(config.heartbeatFrequency)) {
      selectHeartbeatFrequency.value = config.heartbeatFrequency;
      heartbeatCronRow.style.display = 'none';
    } else {
      selectHeartbeatFrequency.value = 'custom';
      inputHeartbeatCron.value = config.heartbeatFrequency;
      heartbeatCronRow.style.display = 'block';
    }

    toggleSettingsGroups(config.aiSource);
    settingsPanel.classList.toggle("active");
    settingsPanel.scrollTop = 0; // Scroll settings panel back to top
    if (settingsPanel.classList.contains("active")) { refreshLoadedModels(); refreshTtsUI(); }
  });

  const btnRefreshLoaded = document.querySelector("#btn-refresh-loaded");
  if (btnRefreshLoaded) btnRefreshLoaded.addEventListener("click", () => refreshLoadedModels());
  // Préchargement du modèle : bouton discret à côté du sélecteur de modèle.
  const btnPreloadInline = document.querySelector("#btn-preload-inline");
  if (btnPreloadInline) btnPreloadInline.addEventListener("click", () => preloadModel());

  // Synthèse vocale Piper locale.
  document.querySelector("#btn-tts-refresh")?.addEventListener("click", () => refreshTtsUI());
  document.querySelector("#select-tts-voice")?.addEventListener("change", (e) => {
    invoke("tts_set_voice", { voice: e.target.value }).catch(() => {});
  });
  document.querySelector("#btn-tts-test")?.addEventListener("click", () => {
    const voice = document.querySelector("#select-tts-voice")?.value || null;
    ttsStatus(t("tts_testing"));
    invoke("tts_speak", { text: t("tts_test_phrase"), voice })
      .then(() => ttsStatus(""))
      .catch((e) => ttsStatus("Échec : " + (e?.message || e)));
  });

  // Dynamically toggle inputs based on AI source option
  selectAiSource.addEventListener("change", (e) => {
    toggleSettingsGroups(e.target.value);
  });

  sliderTransparency.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    labelTransparencyVal.textContent = `${val}%`;
    document.documentElement.style.setProperty('--glass-opacity', (val / 100).toString());
  });

  btnCloseSettings.addEventListener("click", () => {
    document.documentElement.style.setProperty('--glass-opacity', config.glassOpacity.toString());
    // revert any unsaved live avatar tweaks
    window.LumenOrb?.setEnabled(config.orbEnabled);
    window.LumenOrb?.setSize(config.orbSize);
    window.LumenOrb?.setColors(config.orbColors);
    window.LumenOrb?.setCoreScale(config.orbCoreScale);
    window.LumenOrb?.setGlassType(config.orbGlassType);
    window.LumenOrb?.setPulse(config.orbPulse);
    window.LumenOrb?.setHeartbeat(config.orbHeartbeat);
    window.LumenOrb?.setHeartColor(config.orbHeartColor);
    window.LumenOrb?.setPulseStrength(config.orbPulseStrength);
    window.LumenOrb?.setPulseSpeed(config.orbPulseSpeed);

    settingsPanel.classList.remove("active");
  });

  btnSaveSettings.addEventListener("click", () => {
    config.ollamaUrl = inputOllamaUrl.value.trim() || 'http://localhost:11434';
    if (inputApiKey) config.apiKey = inputApiKey.value.trim();
    if (inputApiBase) config.apiBaseUrl = inputApiBase.value.trim() || 'https://api.openai.com/v1';
    if (inputApiModel) config.apiModel = inputApiModel.value.trim() || 'gpt-4o-mini';
    const inputLumenModelSave = document.querySelector('#input-lumen-model');
    if (inputLumenModelSave) { config.lumenModel = inputLumenModelSave.value.trim(); localStorage.setItem('lumenModel', config.lumenModel); }
    const selectApplefmSave = document.querySelector('#select-applefm-model');
    if (selectApplefmSave && selectApplefmSave.value) setCloudModel(selectApplefmSave.value, 'applefm');
    if (selectImageProvider) config.imageProvider = selectImageProvider.value || 'bonsai';
    // Le sélecteur de modèle ne vaut que pour le moteur affiché : les deux
    // autres gardent leur valeur mémorisée.
    if (selectImageModel && selectImageModel.value) {
      if (config.imageProvider === 'bonsai') config.imageBonsaiModel = selectImageModel.value;
      else if (config.imageProvider === 'ollama') config.imageOllamaModel = selectImageModel.value;
      else if (config.imageProvider === 'playground') config.imagePlaygroundStyle = selectImageModel.value;
      else config.imageOpenaiModel = selectImageModel.value;
    }
    config.selectedModel = selectModel.value || config.selectedModel;
    currentModel = config.selectedModel;
    // En mode desktop la case est visuellement suspendue/décochée, mais ce
    // n'est pas une modification de la préférence permanente de l'utilisateur.
    if (!remoteDesktopModeActive) config.alwaysOnTop = checkboxAlwaysOnTop.checked;
    config.barOpaque = checkboxBarOpaque ? checkboxBarOpaque.checked : config.barOpaque;
    config.startupLumenOS = checkboxStartupLumenOS ? checkboxStartupLumenOS.checked : config.startupLumenOS;
    config.halo = checkboxHalo ? checkboxHalo.checked : config.halo;
    config.debugMode = checkboxDebug ? checkboxDebug.checked : config.debugMode;
    config.glassOpacity = parseInt(sliderTransparency.value) / 100;
    config.barSize = selectBarSize.value;
    config.aiSource = selectAiSource.value;
    config.shortcutName = inputShortcutName.value.trim() || 'Apple Intelligence';
    config.actionRouter = inputActionRouter.value.trim() || 'Action Router';
    config.speechBackend = selectSpeechBackend?.value || 'auto';
    config.speakShortcut = inputSpeakShortcut.value.trim() || 'Speak Text';
    config.dictateShortcut = inputDictateShortcut.value.trim() || 'Dictate Text';
    config.systemPrompt = inputSystemPrompt.value.trim();
    config.fluxoTools = checkboxFluxoTools ? checkboxFluxoTools.checked : config.fluxoTools;
    config.ollamaThink = checkboxOllamaThink ? checkboxOllamaThink.checked : config.ollamaThink;
    config.ollamaNumCtx = inputOllamaNumCtx ? (parseInt(inputOllamaNumCtx.value, 10) || 0) : config.ollamaNumCtx;
    config.ollamaKeepAlive = inputOllamaKeepAlive ? (inputOllamaKeepAlive.value.trim() || '5m') : config.ollamaKeepAlive;
    // Réconcilie le mode Ollama unifié avec la case « function calling » :
    // activer la case ⇒ mode Outils ; la décocher ⇒ retour au mode Discussion.
    if (config.fluxoTools && config.ollamaMode !== 'tools') {
      config.ollamaMode = 'tools';
      localStorage.setItem('ollamaMode', 'tools');
    } else if (!config.fluxoTools && config.ollamaMode === 'tools') {
      config.ollamaMode = 'chat';
      localStorage.setItem('ollamaMode', 'chat');
    }
    config.orbEnabled = checkboxOrb.checked;
    config.orbSize = parseInt(sliderOrbSize.value, 10);
    config.orbCoreScale = parseInt(sliderOrbCore.value, 10);
    config.orbPulse = parseInt(sliderOrbPulse.value, 10);
    config.orbHeartbeat = checkboxOrbHeartbeat.checked;
    if (orbHeartColorInput) config.orbHeartColor = orbHeartColorInput.value;
    config.orbPulseStrength = parseInt(sliderOrbPulseStrength.value, 10);
    config.orbPulseSpeed = parseInt(sliderOrbPulseSpeed.value, 10);
    config.orbGlassType = selectOrbGlass.value;
    if (selectOrbTheme) config.orbTheme = selectOrbTheme.value;
    config.orbColors = orbColorInputs.map(i => i.value);
    config.themePreference = selectTheme.value;
    if (selectTextColor) config.textColor = selectTextColor.value;

    // Heartbeat: resolve the effective CRON expression (preset or custom).
    config.heartbeatEnabled = checkboxHeartbeat.checked;
    config.heartbeatShortcut = inputHeartbeatShortcut.value.trim() || 'Heartbeat';
    config.heartbeatInput = inputHeartbeatInput.value.trim();
    config.heartbeatCron = inputHeartbeatCron.value.trim() || '0 */10 * * * *';
    config.heartbeatFrequency = selectHeartbeatFrequency.value === 'custom'
      ? config.heartbeatCron
      : selectHeartbeatFrequency.value;

    localStorage.setItem('ollamaUrl', config.ollamaUrl);
    // SÉCURITÉ : la clé API n'est PLUS persistée en localStorage. Elle est
    // poussée vers le backend (ollama.json, 0600) par pushOllamaConfig() ci-dessous.
    if (config.apiKey) { config.apiConfigured = true; localStorage.removeItem('apiKey'); }
    localStorage.setItem('apiBaseUrl', config.apiBaseUrl);
    localStorage.setItem('apiModel', config.apiModel);
    localStorage.setItem('imageProvider', config.imageProvider);
    localStorage.setItem('imageOpenaiModel', config.imageOpenaiModel);
    localStorage.setItem('imagePlaygroundStyle', config.imagePlaygroundStyle);
    pushImageConfig(invoke);
    localStorage.setItem('imageOllamaModel', config.imageOllamaModel);
    localStorage.setItem('imageBonsaiModel', config.imageBonsaiModel);
    localStorage.setItem('ollamaThink', config.ollamaThink.toString());
    localStorage.setItem('ollamaNumCtx', config.ollamaNumCtx.toString());
    localStorage.setItem('llamaNumCtx', config.llamaNumCtx.toString());
    localStorage.setItem('ollamaKeepAlive', config.ollamaKeepAlive);
    // Le modèle enregistré depuis les Réglages appartient au backend courant.
    rememberModelFor(config.aiSource, config.selectedModel);
    localStorage.setItem('alwaysOnTop', config.alwaysOnTop);
    localStorage.setItem('barOpaque', config.barOpaque.toString());
    localStorage.setItem('startupLumenOS', config.startupLumenOS.toString());
    // Case « ouvrir Lumen Desktop au démarrage » = mode bureau mémorisé.
    if (config.startupLumenOS) { localStorage.setItem('shellMode', 'desktop'); localStorage.setItem('shellRemember', 'true'); }
    else if (localStorage.getItem('shellMode') === 'desktop') localStorage.setItem('shellRemember', 'false');
    localStorage.setItem('halo', config.halo.toString());
    localStorage.setItem('debugMode', config.debugMode);
    localStorage.setItem('glassOpacity', config.glassOpacity.toString());
    localStorage.setItem('barSize', config.barSize);
    localStorage.setItem('aiSource', config.aiSource);
    localStorage.setItem('shortcutName', config.shortcutName);
    localStorage.setItem('actionRouter', config.actionRouter);
    localStorage.setItem('speechBackend', config.speechBackend);
    localStorage.setItem('speakShortcut', config.speakShortcut);
    localStorage.setItem('dictateShortcut', config.dictateShortcut);
    localStorage.setItem('systemPrompt', config.systemPrompt);
    localStorage.setItem('fluxoTools', config.fluxoTools.toString());
    // Pousse la config LLM côté serveur une fois la source IA persistée.
    pushOllamaConfig();
    localStorage.setItem('orbEnabled', config.orbEnabled.toString());
    localStorage.setItem('orbSize', config.orbSize.toString());
    localStorage.setItem('orbCoreScale', config.orbCoreScale.toString());
    localStorage.setItem('orbPulse', config.orbPulse.toString());
    localStorage.setItem('orbHeartbeat', config.orbHeartbeat.toString());
    localStorage.setItem('orbHeartColor', config.orbHeartColor);
    localStorage.setItem('orbPulseStrength', config.orbPulseStrength.toString());
    localStorage.setItem('orbPulseSpeed', config.orbPulseSpeed.toString());
    localStorage.setItem('orbGlassType', config.orbGlassType);
    localStorage.setItem('orbTheme', config.orbTheme);
    localStorage.setItem('orbColors', JSON.stringify(config.orbColors));
    localStorage.setItem('themePreference', config.themePreference);
    localStorage.setItem('textColor', config.textColor);
    localStorage.setItem('heartbeatEnabled', config.heartbeatEnabled.toString());
    localStorage.setItem('heartbeatShortcut', config.heartbeatShortcut);
    localStorage.setItem('heartbeatEngine', config.heartbeatEngine || '');
    localStorage.setItem('heartbeatFrequency', config.heartbeatFrequency);
    localStorage.setItem('heartbeatCron', config.heartbeatCron);
    localStorage.setItem('heartbeatInput', config.heartbeatInput);

    applyConfigUI();
    settingsPanel.classList.remove("active");

    // Apply configs
    invoke("set_always_on_top", { alwaysOnTop: config.alwaysOnTop && !remoteDesktopModeActive });
    applyHalo();
    applyWindowSize();
    checkOllamaStatus();
    applyHeartbeat();
    updateHeartbeatUI();
  });

  // History Panel Actions
  // Messages : la messagerie avec Lumen et ses agents (fenêtre dédiée).
  document.querySelector("#btn-messages")?.addEventListener("click", () => {
    invoke("open_messenger").catch((e) => console.warn("[messages]", e));
  });
  btnHistory.addEventListener("click", (e) => {
    e.stopPropagation();
    closeToolbarOverflow();
    settingsPanel.classList.remove("active");
    notificationsPanel.classList.remove("active");
    fluxoPanel.classList.remove("active");
    toolboxPanel?.classList.remove("active");
    renderSavedConversationsList();
    historyPanel.classList.toggle("active");
  });

  btnCloseHistory.addEventListener("click", () => {
    historyPanel.classList.remove("active");
  });

  // Notifications panel (résultats du Heartbeat)
  btnNotifications.addEventListener("click", (e) => {
    e.stopPropagation();
    closeToolbarOverflow();
    settingsPanel.classList.remove("active");
    historyPanel.classList.remove("active");
    fluxoPanel.classList.remove("active");
    toolboxPanel?.classList.remove("active");
    renderNotificationsList();
    notificationsPanel.classList.toggle("active");
    if (notificationsPanel.classList.contains("active")) markNotificationsRead();
  });
  btnCloseNotifications.addEventListener("click", () => {
    notificationsPanel.classList.remove("active");
  });
  btnClearNotifications.addEventListener("click", () => {
    heartbeatNotifications = [];
    notifUnread = 0;
    saveNotifications();
    renderNotificationsList();
    updateNotifBadge();
    remotePushNotifications();
  });

  // Fluxo panel (automatisations)
  btnFluxo.addEventListener("click", (e) => {
    e.stopPropagation();
    closeToolbarOverflow();
    settingsPanel.classList.remove("active");
    historyPanel.classList.remove("active");
    notificationsPanel.classList.remove("active");
    toolboxPanel?.classList.remove("active");
    const willOpen = !fluxoPanel.classList.contains("active");
    fluxoPanel.classList.toggle("active");
    if (willOpen) loadFluxoList();
  });
  btnCloseFluxo.addEventListener("click", () => fluxoPanel.classList.remove("active"));
  btnRefreshFluxo.addEventListener("click", loadFluxoList);
  // Ouvre le designer Fluxo intégré dans sa fenêtre dédiée.
  if (btnOpenFluxoDesigner) {
    btnOpenFluxoDesigner.addEventListener("click", async () => {
      try { await invoke("open_fluxo_designer"); }
      catch (e) { console.error("Ouverture du designer Fluxo impossible :", e); }
    });
  }

  // Ouvre l'explorateur de sandboxes dans sa fenêtre dédiée.
  const btnOpenSandbox = document.querySelector("#btn-open-sandbox");
  if (btnOpenSandbox) {
    btnOpenSandbox.addEventListener("click", async () => {
      try { await invoke("open_sandbox_explorer"); }
      catch (e) { console.error("Ouverture des sandboxes impossible :", e); }
    });
  }

  // Ouvre le gestionnaire d'agents dans sa fenêtre dédiée.
  const btnOpenAgents = document.querySelector("#btn-open-agents");
  if (btnOpenAgents) {
    btnOpenAgents.addEventListener("click", async () => {
      try { await invoke("open_agents_manager"); }
      catch (e) { console.error("Ouverture des agents impossible :", e); }
    });
  }
  initBonsaiSettings();

  // Bouton Boîte à outils de la barre : panneau intégré sous la barre (même
  // style que discussion/notifications), avec la grille des modules Lumen.
  btnAgents?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeToolbarOverflow();
    historyPanel.classList.remove("active");
    notificationsPanel.classList.remove("active");
    fluxoPanel.classList.remove("active");
    const willOpen = !toolboxPanel?.classList.contains("active");
    toolboxPanel?.classList.toggle("active");
    // Rouvrir la boîte à outils doit donner un launcher, pas le formulaire de
    // personnalisation laissé ouvert la fois précédente.
    if (willOpen) setToolboxEditing(false);
  });
  document.querySelector("#btn-close-toolbox")?.addEventListener("click", () => {
    toolboxPanel?.classList.remove("active");
    setToolboxEditing(false);
  });
  document.querySelector("#btn-toolbox-edit")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setToolboxEditing(!toolboxEditing);
  });

  // Accès direct à Lumen Desktop : ouvre la sandbox directement en mode bureau.
  btnLumenOS?.addEventListener("click", async () => {
    try { await invoke("open_sandbox_explorer", { desktop: true }); }
    catch (e) { console.error("Ouverture de Lumen Desktop impossible :", e); }
  });

  async function openStartupLumenOS() {
    if (!config.startupLumenOS || openStartupLumenOS.done) return;
    openStartupLumenOS.done = true;
    try { await invoke("open_sandbox_explorer", { desktop: true }); }
    catch (e) { console.error("Ouverture automatique de Lumen Desktop impossible :", e); }
  }

  // Synchronise la config Ollama côté serveur au démarrage (pour les agents headless).
  pushOllamaConfig();
  // L'ouverture du bureau au démarrage passe désormais par le choix du mode
  // (« Toujours ouvrir ce mode » ; l'ancien réglage y est migré).

  // Bouton « mode » unifié (Ollama) : ouvre/ferme le menu des destinations.
  btnOllamaMode.addEventListener("click", (e) => {
    e.stopPropagation();
    closeToolbarOverflow();
    closeBackendMenu();
    const willOpen = ollamaModeMenu.hidden;
    if (willOpen) openOllamaModeMenu(); else closeOllamaModeMenu();
  });
  document.addEventListener("click", (e) => {
    if (!ollamaModeMenu.hidden &&
        !ollamaModeMenu.contains(e.target) &&
        e.target !== btnOllamaMode && !btnOllamaMode.contains(e.target)) {
      closeOllamaModeMenu();
    }
  });

  btnNewChat.addEventListener("click", () => {
    startNewChat();
    historyPanel.classList.remove("active");
  });

  // Clear chat
  btnClearChat.addEventListener("click", () => {
    startNewChat();
  });

  // Pastille de modèle : ouvre le panneau « Backend IA » (source + modèle + think),
  // au style de la barre. Remplace l'ancien cycle de modèles.
  btn350mToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    closeToolbarOverflow();
    closeOllamaModeMenu();
    if (backendMenu && backendMenu.hidden) openBackendMenu(); else closeBackendMenu();
  });
  document.addEventListener("click", (e) => {
    if (backendMenu && !backendMenu.hidden &&
        !backendMenu.contains(e.target) &&
        e.target !== btn350mToggle && !btn350mToggle.contains(e.target)) {
      closeBackendMenu();
    }
  });
  
  // Submit chat
  // Pendant un traitement IA, la flèche devient « Stop » : un clic arrête la
  // génération, le moteur d'outils, la voix et les workflows en cours.
  sendBtn.addEventListener("click", () => {
    if (sendBtn.classList.contains("is-stop")) { stopFromController(); return; }
    handleSend();
  });
  syncSendButton();
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Maj+Entrée insère un saut de ligne : la hauteur doit suivre une fois le
    // caractère inséré, d'où le report au tick suivant.
    else if (e.key === "Enter") requestAnimationFrame(autosizeChatInput);
  });
  chatInput.addEventListener("input", autosizeChatInput);
  chatInput.addEventListener("input", renderMentionChips);
  autosizeChatInput();

  // Menus « @ » (outils) et « # » (documents) — actifs dans tous les modes.
  initBarMentions();

  // Pièces jointes image (modèles multimodaux Ollama). Le bouton ouvre le
  // sélecteur ; on accepte aussi le collage (Ctrl/Cmd+V) d'une image.
  if (btnAttach) btnAttach.addEventListener("click", () => {
    if (!imageInput) return;
    // `showPicker()` d'abord : c'est le chemin fiable dans WKWebView, où le
    // `.click()` d'un champ fichier discret est parfois ignoré sans erreur.
    try { imageInput.showPicker(); } catch { imageInput.click(); }
  });
  // Glisser-déposer une image sur la barre : second chemin, indépendant du
  // sélecteur natif (et du collage).
  searchBar.addEventListener("dragover", (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();
    searchBar.classList.add("drop-target");
  });
  searchBar.addEventListener("dragleave", (e) => {
    if (e.target === searchBar) searchBar.classList.remove("drop-target");
  });
  searchBar.addEventListener("drop", async (e) => {
    e.preventDefault();
    searchBar.classList.remove("drop-target");
    for (const file of Array.from(e.dataTransfer?.files || [])) await addAttachment(file);
  });
  if (imageInput) imageInput.addEventListener("change", async () => {
    for (const file of Array.from(imageInput.files || [])) await addAttachment(file);
    imageInput.value = ""; // permet de re-sélectionner le même fichier
  });
  chatInput.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) { e.preventDefault(); await addImageFile(file); }
      }
    }
  });

  // Hide messages panel on launch
  messagesContainer.style.display = 'none';

  // Internationalisation : applique la langue et branche les sélecteurs.
  setupLanguage();

  // Apply setups
  applyConfigUI();
  invoke("set_always_on_top", { alwaysOnTop: config.alwaysOnTop && !remoteDesktopModeActive });
  applyHalo();
  applyWindowSize();
  fetchAvailableModels();
  checkOllamaStatus();
  applyHeartbeat();
  updateHeartbeatUI();

  // WKWebView drops backdrop-filter when the window loses OS focus, leaving the
  // glass transparent until a repaint. We force that repaint on focus only for an
  // always-on-top panel (where staying frosted matters). For a normal window this
  // repaint causes a visible flash on every focus change, so we skip it there.
  window.addEventListener("focus", () => { if (config.alwaysOnTop) nudgeGlass(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && config.alwaysOnTop) nudgeGlass();
  });

  // Click-through : laisse passer les clics vers le bureau hors de l'UI.
  initClickThrough();

  // Centre de notifications (résultats des tâches du Heartbeat).
  initNotifications();

  // Compagnon mobile : serveur LAN + miroir de la session.
  initRemoteCompanion();

  // Remplit toutes les icônes SVG (`[data-icon]`) — Paramètres + assistant.
  applyIcons();

  // Panneau d'aide & documentation.
  initHelp();

  // Profil utilisateur (éditeur Apple-friendly) + mémoire partagée + auth compagnon.
  initProfileUI();
  initSharedMemoryUI();
  initCompanionAuthUI();

  // Licence : relecture depuis les Réglages + rappel de la version acceptée.
  initLicenseUI();

  // Onboarding wizard
  initOnboarding();
  // Choix du mode au lancement (barre / application / bureau) : la fenêtre
  // démarre cachée, lib/shell-mode.js décide de ce qui s'affiche.
  bootShell({
    invoke,
    listen: window.__TAURI__?.event?.listen,
    onboardingDone: () => localStorage.getItem('onboardingDone') === 'true',
    openOnboarding,
    applyApp: () => mountAppShell(),
    applyBar: () => {
      applyWindowSize();
      invoke("set_always_on_top", { alwaysOnTop: config.alwaysOnTop && !remoteDesktopModeActive }).catch(() => {});
    },
    // Barre affichée : mini-visite au premier lancement, forcée juste après
    // l'assistant de configuration.
    onBarShown: (firstRun) => (firstRun ? setTimeout(() => startBarTour({ force: true }), 700) : maybeStartBarTour()),
  });
});

/// Monte le mode « application » (lib/app-mode.js) sur les nœuds de la barre.
async function mountAppShell() {
  let userName = "";
  try {
    const data = await invoke("session_profiles");
    const active = (data?.profiles || []).find((p) => p.id === data?.active_id) || (data?.profiles || [])[0];
    if (active?.name && active.name !== "Utilisateur") userName = active.name;
  } catch {}
  mountAppMode({
    invoke,
    lang: getLang(),
    userName: () => userName,
    renderConversations: () => renderSavedConversationsList(),
    currentConversationId: () => currentConversationId,
    currentProject: () => contextProject(),
    onChangeMode: () => changeMode(invoke).catch((e) => console.error(e)),
  });
}

// Rejouable depuis les Paramètres (« Revoir le mini-tuto de la barre ») et à la
// fermeture de l'assistant, moment où l'utilisateur découvre la barre.
window.__TAURI__?.event?.listen?.("bar-tour-replay", () => startBarTour({ force: true }));
// Fin de l'assistant de configuration : l'écran de choix du mode prend le
// relais (lib/shell-mode.js) ; la mini-visite ne part que si la barre est choisie.

// Panneau Bonsai de la barre : moteur embarqué, modèles PrismML (téléchargement
// depuis Hugging Face), démarrage/arrêt — logique partagée avec les Réglages
// dans lib/bonsai-panel.js.
function initBonsaiSettings() {
  mountBonsaiPanel({
    invoke,
    listen: window.__TAURI__?.event?.listen,
    t,
    onChange: () => {
      config.imageBonsaiModel = localStorage.getItem('imageBonsaiModel') || config.imageBonsaiModel;
      if (config.imageProvider === 'bonsai') renderImageModelSelect('bonsai');
    },
  });
}

// Image Playground (macOS 27) : l'option n'apparaît que si Apple Intelligence
// répond présent ; sinon on explique pourquoi sous le sélecteur.
async function refreshImagePlaygroundOption() {
  const st = await refreshPlaygroundOption(selectImageProvider, invoke, {
    onFallback: (provider) => { config.imageProvider = provider; renderImageModelSelect(provider); },
  });
  const hint = document.querySelector('#playground-status');
  if (hint && st) {
    hint.hidden = st.available || st.reason === 'not_bundled' || st.reason === 'unsupported_platform';
    hint.textContent = st.available ? '' : playgroundReasonText(st.reason);
  }
}

// ===== Saveur de plateforme (exports Linux) =====
// Les builds Linux ne disposent pas de Shortcuts Apple. Le Pi garde en plus sa
// classe dédiée pour les réglages WebKitGTK/Piper.
// Vide, et non "default" : tant que le Rust n'a pas répondu on ne sait pas,
// et « default » serait une affirmation — celle d'être sur un Mac.
let platformFlavor = "";
function platformWithoutAppleShortcuts() {
  // Une plateforme sans Raccourcis macOS, c'est avant tout une plateforme qui
  // n'est pas un Mac. Ne dépendre que de la saveur laissait le cas « pas
  // encore résolue » se faire passer pour macOS.
  return !IS_MAC
    || platformFlavor === "rpi" || platformFlavor === "linux-standard" || platformFlavor === "windows";
}

// Le backend TTS local est compilé sur toutes les plateformes. La disponibilité
// réelle du binaire Piper est vérifiée juste avant chaque lecture.
function ttsLocalAvailable() {
  return true;
}
function barOpaqueAvailable() {
  // Disponible partout, macOS compris : le rendu opaque passe par des styles
  // inline (applyBarOpaqueMode) qui ne dépendent d'aucune spécificité d'OS.
  return true;
}
function barOpaqueDefault() {
  return platformFlavor === "rpi" || platformFlavor === "linux-standard";
}
function effectiveBarOpaque() {
  if (!barOpaqueAvailable()) return false;
  if (localStorage.getItem("barOpaque") === null) return barOpaqueDefault();
  return !!config.barOpaque;
}

function disableAppleShortcutUi() {
  document.querySelector('#select-ai-source option[value="shortcut"]')?.remove();
  document.querySelector('.source-card[data-source="shortcut"]')?.remove();
  document.querySelector('#select-speech-backend option[value="shortcut"]')?.remove();
  // Sur Linux/Pi Piper est le seul moteur local ; sur Windows le sélecteur reste
  // visible pour choisir entre Piper et la voix système.
  const speechRow = document.querySelector("#select-speech-backend")?.closest(".setting-item");
  if (speechRow) speechRow.style.display =
    (platformFlavor === "rpi" || platformFlavor === "linux-standard") ? "none" : "";
  const shortcutGroup = document.querySelector("#settings-group-shortcut");
  if (shortcutGroup) shortcutGroup.style.display = "none";
  if (config.aiSource === "shortcut") {
    config.aiSource = "ollama";
    localStorage.setItem("aiSource", "ollama");
  }
}

async function applyPlatformFlavor() {
  // "" tant que la saveur n'est pas établie : « default » signifierait macOS.
  platformFlavor = await resolvePlatformFlavor();
  document.body.classList.toggle("flavor-rpi", platformFlavor === "rpi");
  document.body.classList.toggle("flavor-linux-standard", platformFlavor === "linux-standard");
  document.body.classList.toggle("flavor-windows", platformFlavor === "windows");
  // Pilote NVIDIA propriétaire : même famille de dégâts que le WebKitGTK sans
  // GPU (couches de compositing mal peintes), en pire — rémanence et ombres
  // noires. On coupe les effets décoratifs coûteux en plus du repli « verre ».
  document.body.classList.toggle("gpu-nvidia", (await resolveGpuFlavor()) === "nvidia");
  document.querySelectorAll(".platform-opaque-only").forEach((el) => { el.hidden = !barOpaqueAvailable(); });
  if (platformWithoutAppleShortcuts()) disableAppleShortcutUi();
  applyBarOpaqueMode();
  applyLinuxWebkitGlassFallback();
}

// WebKitGTK (Linux : Pi ET Ubuntu/desktop) ne peint pas la couche
// `backdrop-filter` de la barre → elle devient invisible. Le correctif CSS
// (flavor-rpi/linux-standard) n'est PAS appliqué de façon fiable par WebKitGTK
// (l'animation `backdrop-filter` continue de l'emporter sur nos règles, même
// `!important`). On force donc le style en INLINE : un `!important` inline bat
// l'animation et toute la cascade. Réappliqué à chaque changement de thème.
function applyBarOpaqueMode() {
  const opaque = effectiveBarOpaque();
  document.body.classList.toggle("bar-opaque", opaque);
  document.querySelectorAll(".platform-opaque-only").forEach((el) => { el.hidden = !barOpaqueAvailable(); });
  const bar = document.querySelector(".search-bar");
  if (!bar) return;
  if (!opaque) {
    bar.style.removeProperty("backdrop-filter");
    bar.style.removeProperty("-webkit-backdrop-filter");
    bar.style.removeProperty("background");
    bar.style.removeProperty("border-color");
    bar.style.removeProperty("box-shadow");
    bar.style.removeProperty("animation");
    return;
  }
  bar.style.setProperty("backdrop-filter", "none", "important");
  bar.style.setProperty("-webkit-backdrop-filter", "none", "important");
  // Keep these values theme-aware. Solid colours are defined in CSS so custom
  // themes cannot accidentally fall back to the translucent white variant.
  bar.style.setProperty("background", "var(--bar-opaque-bg)", "important");
  bar.style.setProperty("border-color", "var(--bar-opaque-border)", "important");
  bar.style.setProperty("box-shadow", "var(--bar-opaque-shadow)", "important");
  bar.style.setProperty("animation", "none", "important");
}

function applyLinuxWebkitGlassFallback() {
  const linuxWebkit = platformFlavor === "rpi" || platformFlavor === "linux-standard";
  const selectors = [
    ".search-bar",
    ".messages-container",
    ".settings-panel",
    ".toolbar-overflow",
    ".mode-menu",
    ".orb-frost",
  ];
  if (!linuxWebkit) {
    document.querySelectorAll(selectors.join(",")).forEach((el) => {
      el.style.removeProperty("backdrop-filter");
      el.style.removeProperty("-webkit-backdrop-filter");
      el.style.removeProperty("will-change");
      el.style.removeProperty("animation");
      el.style.removeProperty("filter");
      el.style.removeProperty("mix-blend-mode");
    });
    return;
  }
  const dark = document.body.classList.contains("theme-dark-forced");
  const opaque = effectiveBarOpaque();
  const solidBg = opaque
    ? "var(--panel-opaque-bg)"
    : (dark ? "rgba(34, 34, 40, 0.96)" : "rgba(255, 255, 255, 0.96)");
  document.querySelectorAll(selectors.join(",")).forEach((el) => {
    el.style.setProperty("backdrop-filter", "none", "important");
    el.style.setProperty("-webkit-backdrop-filter", "none", "important");
    el.style.setProperty("will-change", "auto", "important");
    el.style.setProperty("animation", "none", "important");
  });
  document.querySelectorAll(".messages-container, .settings-panel, .toolbar-overflow, .mode-menu").forEach((el) => {
    el.style.setProperty("background", solidBg, "important");
  });
  document.querySelectorAll(".search-bar").forEach((el) => {
    el.style.setProperty("background", opaque ? "var(--bar-opaque-bg)" : solidBg, "important");
    el.style.setProperty("border-color", opaque ? "var(--bar-opaque-border)" : (dark ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.1)"), "important");
    el.style.setProperty("box-shadow", opaque ? "var(--bar-opaque-shadow)" : "none", "important");
  });
  document.querySelectorAll(".orb-frost").forEach((el) => {
    el.style.setProperty("background", "transparent", "important");
    el.style.setProperty("filter", "none", "important");
    el.style.setProperty("mix-blend-mode", "normal", "important");
  });
}

// ===== Synthèse vocale Piper locale =====
function ttsStatus(msg) { const el = document.querySelector("#tts-status"); if (el) el.textContent = msg || ""; }

let ttsPicker = null;
async function refreshTtsUI() {
  if (!ttsLocalAvailable()) return;
  let catalog = [];
  let active = "";
  try {
    [catalog, active] = await Promise.all([
      invoke("tts_catalog"),
      invoke("tts_active_voice").catch(() => ""),
    ]);
  } catch (e) { catalog = []; }

  // Sélecteur de voix active (voix installées seulement).
  const sel = document.querySelector("#select-tts-voice");
  if (sel) {
    const installed = catalog.filter((v) => v.installed);
    sel.innerHTML = installed.length
      ? installed.map((v) => `<option value="${v.id}">${escapeHTML(v.label)}</option>`).join("")
      : `<option value="">${t("tts_none_installed")}</option>`;
    if (active && installed.some((v) => v.id === active)) sel.value = active;
  }

  // Catalogue téléchargeable : liste compacte filtrable (langue, moteur), à
  // hauteur bornée — la barre ne doit pas devenir une page qui défile sans fin.
  const list = document.querySelector("#tts-catalog");
  if (list) {
    if (!ttsPicker) {
      ttsPicker = createCatalogPicker(list, {
        chips: [
          { id: "all", label: t("cat_chip_all") },
          { id: "installed", label: t("cat_chip_installed_f"), test: (item) => item.installed },
          { id: "fr", label: t("cat_chip_fr"), test: (item) => item.lang?.startsWith("fr") },
          { id: "en", label: t("cat_chip_en"), test: (item) => item.lang?.startsWith("en") },
          { id: "piper", label: "Piper", test: (item) => item.engine === "piper" },
          { id: "kokoro", label: "Kokoro", test: (item) => item.engine === "kokoro" },
        ],
        searchPlaceholder: t("cat_search_voice"),
        emptyLabel: t("cat_empty_voice"),
        countLabel: (shown, total) => t("cat_count_voice", { shown, total }),
        maxHeight: "204px",
      });
    }
    ttsPicker.setItems(catalog.map((v) => ({
      id: v.id,
      title: v.label,
      meta: `${v.lang} · ${v.quality} · ~${v.size_mb} Mo · ${v.license}`,
      lang: v.lang,
      engine: v.engine,
      installed: v.installed,
      badge: v.installed ? t("cat_badge_installed_f") : "",
      actions: [{
        label: v.installed ? t("tts_delete") : t("tts_download"),
        kind: v.installed ? "danger" : "default",
        onClick: async (ctx) => {
          ctx.button.disabled = true;
          try {
            if (v.installed) {
              await invoke("tts_delete_voice", { id: v.id });
            } else {
              ctx.setStatus(t("tts_downloading", { name: v.label }));
              ttsStatus(t("tts_downloading", { name: v.label }));
              await invoke("tts_download_voice", { id: v.id });
              ttsStatus(t("tts_downloaded", { name: v.label }));
            }
          } catch (e) {
            ctx.setStatus(t("tts_dl_failed", { err: e?.message || e }), true);
            ttsStatus(t("tts_dl_failed", { err: e?.message || e }));
          }
          await refreshTtsUI();
        },
      }],
    })));
  }
}

// ===== Internationalisation =====
function setupLanguage() {
  applyI18n();
  const selSettings = document.querySelector("#select-language");
  const selOnboarding = document.querySelector("#onboarding-lang");
  if (selSettings) {
    selSettings.value = getLang();
    selSettings.addEventListener("change", () => changeLanguage(selSettings.value));
  }
  if (selOnboarding) {
    selOnboarding.value = getLang();
    selOnboarding.addEventListener("change", () => changeLanguage(selOnboarding.value));
  }
}

function changeLanguage(lang) {
  setLang(lang);
  // Les agents/skills peuvent tourner sans fenêtre : synchroniser aussi leur
  // prompt système immédiatement, sans attendre un changement de réglages IA.
  pushOllamaConfig();
  applyI18n();
  const s1 = document.querySelector("#select-language");
  const s2 = document.querySelector("#onboarding-lang");
  if (s1) s1.value = getLang();
  if (s2) s2.value = getLang();
  // Resynchronise les textes dynamiques (placeholders, libellés, étapes).
  applyConfigUI();
  // Les puces de filtre du catalogue de voix portent leurs libellés : on rebâtit
  // la liste compacte pour qu'elle suive la langue.
  ttsPicker = null;
  refreshTtsUI?.().catch?.(() => {});
  if (onboardingPanel?.classList.contains("active")) goToStep(onboardingStep);
  if (notificationsPanel?.classList.contains("active")) renderNotificationsList();
  if (fluxoPanel?.classList.contains("active")) loadFluxoList();
}

let dictationHintTimer = null;
function showDictationHint(message) {
  let toast = document.querySelector('#dictation-hint');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dictation-hint';
    toast.className = 'dictation-hint';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(dictationHintTimer);
  dictationHintTimer = setTimeout(() => toast.classList.remove('visible'), 6000);
}

function hideDictationHint() {
  const toast = document.querySelector('#dictation-hint');
  if (toast) toast.classList.remove('visible');
  clearTimeout(dictationHintTimer);
}

function nudgeGlass() {
  document.querySelectorAll('.search-bar, #messages-container').forEach(el => {
    const prev = el.style.backdropFilter;
    el.style.backdropFilter = 'none';
    void el.offsetHeight; // force reflow
    el.style.backdropFilter = prev;
  });
}

// ===== Onboarding / Setup wizard =====
function initOnboarding() {
  if (!onboardingPanel) return;

  // Build the step progress dots.
  onboardingDots.innerHTML = "";
  for (let i = 0; i <= ONBOARDING_LAST_STEP; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    onboardingDots.appendChild(dot);
  }

  renderShortcutCards();

  btnOpenOnboarding?.addEventListener("click", () => {
    settingsPanel.classList.remove("active");
    openOnboarding();
  });
  btnCloseOnboarding?.addEventListener("click", finishOnboarding);
  btnOnboardingPrev?.addEventListener("click", () => moveStep(-1));
  btnOnboardingNext?.addEventListener("click", () => moveStep(1));
  btnRecheckShortcuts?.addEventListener("click", checkShortcutsInstalled);
  btnOpenAiSettings?.addEventListener("click", openAppleIntelligenceSettings);

  // Étape Ollama de l'assistant : URL + modèle (réutilise la config Lumen).
  const obUrl = document.querySelector("#ob-ollama-url");
  const obModel = document.querySelector("#ob-ollama-model");
  obUrl?.addEventListener("change", () => {
    config.ollamaUrl = obUrl.value.trim() || "http://localhost:11434";
    localStorage.setItem("ollamaUrl", config.ollamaUrl);
    pushOllamaConfig();
    fetchOnboardingModels();
    checkOllamaStatus();
  });
  obModel?.addEventListener("change", () => {
    config.selectedModel = obModel.value || config.selectedModel;
    currentModel = config.selectedModel;
    rememberModelFor(config.aiSource, config.selectedModel);
    pushOllamaConfig();
    updateModelLabel();
    checkOllamaStatus();
  });
  document.querySelector("#btn-ob-refresh-models")?.addEventListener("click", fetchOnboardingModels);

  // Choix de la source d'IA dès l'accueil (Apple Intelligence par défaut).
  onboardingPanel.querySelectorAll('.source-card').forEach(card => {
    card.addEventListener("click", () => selectOnboardingSource(card.dataset.source));
  });
  updateOnboardingSourceCards();
}

// Ordre des étapes selon la source choisie : les étapes Apple (raccourcis, IA
// d'Apple) ou l'étape Ollama sont incluses selon le mode.
function onboardingStepOrder() {
  if (config.aiSource === 'ollama') return [0, 7, 3, 4, 5, 6];
  if (config.aiSource === 'llama') return [0, 7, 3, 4, 5, 6];
  if (isApiLike(config.aiSource)) return [0, 3, 4, 5, 6];
  return [0, 1, 2, 3, 4, 5, 6];
}

// Avance/recule d'une étape dans l'ordre courant ; au-delà de la dernière, termine.
function moveStep(delta) {
  const order = onboardingStepOrder();
  let idx = order.indexOf(onboardingStep);
  if (idx < 0) idx = 0;
  const ni = idx + delta;
  if (ni < 0) return;
  if (ni >= order.length) { finishOnboarding(); return; }
  goToStep(order[ni]);
}

// Peuple le sélecteur de modèles de l'étape Ollama de l'assistant.
async function fetchOnboardingModels() {
  const sel = document.querySelector("#ob-ollama-model");
  const status = document.querySelector("#ob-ollama-status");
  if (!sel) return;
  try {
    const models = await listOllamaModels(config.ollamaUrl);
    sel.innerHTML = models.length
      ? models.map(n => `<option value="${escapeHTML(n)}">${escapeHTML(n)}</option>`).join("")
      : `<option value="">${t("loaded_none")}</option>`;
    if (models.includes(config.selectedModel)) sel.value = config.selectedModel;
    if (status) status.textContent = t("ob_ollama_note");
  } catch (e) {
    sel.innerHTML = `<option value="">—</option>`;
    if (status) status.textContent = t("loaded_offline");
  }
}

// Applique le choix de source depuis l'assistant et met l'UI à jour.
function selectOnboardingSource(source) {
  if (source !== 'ollama' && source !== 'llama' && source !== 'shortcut' && source !== 'api') return;
  config.aiSource = source;
  localStorage.setItem('aiSource', source);
  updateOnboardingSourceCards();
  applyConfigUI();
  if (source === 'ollama' || source === 'llama') fetchOnboardingModels();
  checkOllamaStatus();
  // Réaffiche l'étape courante pour recalculer dots/navigation selon le mode.
  goToStep(onboardingStep);
}

function updateOnboardingSourceCards() {
  onboardingPanel.querySelectorAll('.source-card').forEach(card => {
    card.classList.toggle('active', card.dataset.source === config.aiSource);
  });
  // Adapte le texte d'accueil au mode choisi.
  const wp = document.querySelector("#ob-welcome-p");
  if (wp) {
    wp.textContent = config.aiSource === 'ollama' || config.aiSource === 'llama'
      ? t("ob_welcome_p_ollama")
      : isApiLike(config.aiSource)
        ? t("ob_welcome_p_api")
        : t("ob_welcome_p");
  }
}

function openOnboarding() {
  if (window.__TAURI__?.core?.invoke) {
    invoke("open_onboarding").catch((err) => {
      console.error("Ouverture de l'assistant de configuration impossible :", err);
      openInlineOnboarding();
    });
    return;
  }
  openInlineOnboarding();
}

function openInlineOnboarding() {
  // La fenêtre démarre cachée : le panneau intégré doit être visible.
  invoke("set_shell_mode", { mode: "bar" }).catch(() => {});
  onboardingStep = 0;
  // Pré-remplit l'étape Ollama avec la config courante.
  const obUrl = document.querySelector("#ob-ollama-url");
  if (obUrl) obUrl.value = config.ollamaUrl || "";
  if (config.aiSource === 'ollama' || config.aiSource === 'llama') fetchOnboardingModels();
  goToStep(0);
  onboardingPanel.classList.add("active");
  checkShortcutsInstalled();
}

function finishOnboarding() {
  localStorage.setItem('onboardingDone', 'true');
  onboardingPanel.classList.remove("active");
}

function goToStep(step) {
  const order = onboardingStepOrder();
  let idx = order.indexOf(step);
  if (idx < 0) idx = 0;
  onboardingStep = order[idx];

  onboardingPanel.querySelectorAll('.onboarding-step').forEach(el => {
    el.hidden = Number(el.dataset.step) !== onboardingStep;
  });

  onboardingTitle.textContent = t(`ob_title_${onboardingStep}`);

  // Reconstruit les pastilles de progression d'après l'ordre courant (longueur
  // variable selon le mode Apple/Ollama).
  onboardingDots.innerHTML = "";
  order.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = 'dot' + (i === idx ? ' active' : (i < idx ? ' done' : ''));
    onboardingDots.appendChild(dot);
  });

  btnOnboardingPrev.disabled = idx === 0;
  btnOnboardingNext.textContent = idx >= order.length - 1 ? t("ob_finish") : t("ob_next");

  onboardingPanel.querySelector('.onboarding-body').scrollTop = 0;
}

function renderShortcutCards() {
  if (!shortcutCardsContainer) return;
  shortcutCardsContainer.innerHTML = "";
  REQUIRED_SHORTCUTS.forEach(sc => {
    const card = document.createElement('div');
    card.className = 'shortcut-card';
    card.dataset.shortcutKey = sc.key;
    card.innerHTML = `
      <div class="shortcut-card-info">
        <div class="shortcut-card-name">
          ${escapeHTML(sc.name)}
          <span class="shortcut-status missing" data-status>${t("dyn_not_detected")}</span>
        </div>
        <div class="shortcut-card-desc">${escapeHTML(t("dyn_sc_desc_" + sc.key))}</div>
      </div>
      <button class="shortcut-install-btn" data-install>${t("dyn_install")}</button>
    `;
    card.querySelector('[data-install]').addEventListener("click", () => installShortcut(sc));
    shortcutCardsContainer.appendChild(card);
  });
}

function installShortcut(sc) {
  if (!sc.icloudUrl || sc.icloudUrl.includes('REMPLACE_MOI')) {
    alert(t("dyn_icloud_missing", { name: sc.name }));
    return;
  }
  invoke("open_external", { url: sc.icloudUrl })
    .catch(err => console.error("Ouverture du lien iCloud impossible :", err));
}

async function checkShortcutsInstalled() {
  let installed = [];
  try {
    installed = await invoke("list_shortcuts");
  } catch (err) {
    console.error("Impossible de lister les raccourcis :", err);
  }
  const installedLower = installed.map(n => n.toLowerCase());

  REQUIRED_SHORTCUTS.forEach(sc => {
    const card = shortcutCardsContainer.querySelector(`[data-shortcut-key="${sc.key}"]`);
    if (!card) return;
    const statusEl = card.querySelector('[data-status]');
    const installBtn = card.querySelector('[data-install]');
    const present = installedLower.includes(sc.name.toLowerCase());

    if (present) {
      statusEl.textContent = t("dyn_installed");
      statusEl.classList.remove('missing');
      statusEl.classList.add('ok');
      installBtn.textContent = t("dyn_reinstall");
      installBtn.classList.add('installed');
    } else {
      statusEl.textContent = t("dyn_not_detected");
      statusEl.classList.remove('ok');
      statusEl.classList.add('missing');
      installBtn.textContent = t("dyn_install");
      installBtn.classList.remove('installed');
    }
  });
}

function openAppleIntelligenceSettings() {
  // Best-effort deep-link to the Apple Intelligence & Siri settings pane.
  // The exact anchor varies between macOS versions, so we try a known scheme
  // and fall back to opening System Settings if it doesn't land.
  invoke("open_external", { url: "x-apple.systempreferences:com.apple.Siri-Settings.extension" })
    .catch(() => invoke("open_external", { url: "x-apple.systempreferences:" }))
    .catch(err => console.error("Ouverture des réglages impossible :", err));
}

function toggleSettingsGroups(source) {
  const isOllama = source === 'ollama';
  const isLlama = source === 'llama';
  const isShortcut = source === 'shortcut';
  const isApi = isApiLike(source);
  // Réglages de la clé API (source cloud compatible OpenAI).
  if (groupApi) groupApi.style.display = source === 'api' ? 'block' : 'none';
  const groupLumen = document.querySelector('#settings-group-lumen');
  if (groupLumen) groupLumen.style.display = source === 'lumen' ? 'block' : 'none';
  const groupApplefm = document.querySelector('#settings-group-applefm');
  if (groupApplefm) groupApplefm.style.display = source === 'applefm' ? 'block' : 'none';
  // Connexion IA Ollama.
  groupOllama.style.display = isOllama || isLlama ? 'block' : 'none';
  // Moteur d'actions : Fluxo pour Ollama, Apple Shortcuts pour Apple Intelligence.
  if (groupFluxo) groupFluxo.style.display = isOllama || isLlama ? 'block' : 'none';
  groupShortcut.style.display = isShortcut ? 'block' : 'none';
  // Sandboxes & agents reposent sur le « function calling » d'Ollama : en source
  // Apple Intelligence on n'expose que le Heartbeat dans l'onglet Sandbox & agents.
  const groupSandboxAgents = document.querySelector('#group-sandbox-agents');
  if (groupSandboxAgents) groupSandboxAgents.style.display = isOllama || isLlama ? 'block' : 'none';
}

// Moteur d'actions effectif selon la source d'IA choisie.
function actionEngine() {
  // 'shortcut' = Apple Raccourcis (uniquement source Apple). Ollama ET API cloud
  // utilisent le moteur d'actions Fluxo.
  return config.aiSource === 'shortcut' ? 'shortcut' : 'fluxo';
}

// Moteur du Heartbeat. Hors macOS il n'y a pas de Raccourcis : Fluxo est
// imposé, quoi que dise un réglage importé d'un autre poste. Sur Mac, l'utilisateur
// choisit ; tant qu'il ne l'a pas fait, on suit la source d'IA comme avant.
function heartbeatEngine() {
  if (!IS_MAC) return 'fluxo';
  return config.heartbeatEngine === 'shortcut' || config.heartbeatEngine === 'fluxo'
    ? config.heartbeatEngine
    : actionEngine();
}

function closeToolbarOverflow() {
  if (!toolbarOverflow) return;
  toolbarOverflow.classList.remove("open");
  btnMore?.classList.remove("active");
}

// Distribute the toolbar tool buttons between the bar (inline) and the overflow
// menu, depending on the bar size:
//   • grand  : keep Settings/History/Theme inline, collapse the rest (comme moyen
//     — éviter une barre surchargée quand il y a beaucoup de boutons).
//   • moyen  : keep Settings/History/Theme inline, collapse the rest (compromise).
//   • petit  : keep only Settings inline, collapse everything else into the menu.
// Settings always stays first inline; the menu button stays last in the bar.
function applyToolbarLayout() {
  if (!btnMore || !toolbarOverflow) return;
  const leftControls = document.querySelector(".left-controls");
  // Canonical order of the collapsible tool buttons (Settings is never collapsed).
  // Le micro (#btn-dictation) n'en fait plus partie : il vit dans le champ de
  // saisie, toujours visible quelle que soit la taille de barre.
  const tools = [btnHistory, btnNotifications, btnOllamaMode, btnThemeToggle, btnActionMode, btnAutoSpeak, btnHeartbeat, btnLumenOS, btnShellMode, btnAgents];

  let collapseFrom;
  if (config.barSize === 'petit') collapseFrom = 0;       // all of them
  else collapseFrom = 2;                                  // moyen & grand : à partir d'Action

  toolbarOverflow.innerHTML = "";
  tools.forEach((btn, i) => {
    if (!btn) return;
    // Mode application : le choix du mode (Chat, Documents/RAG, Outils…) reste
    // en vue dans le compositeur, comme sur le bureau, au lieu du menu « … ».
    const keepInline = btn === btnOllamaMode && document.documentElement.classList.contains('shell-app');
    if (i >= collapseFrom && !keepInline) {
      toolbarOverflow.appendChild(btn);
    } else {
      // Re-insert inline, before the menu button to preserve order.
      leftControls.insertBefore(btn, btnMore);
    }
  });

  const hasCollapsed = collapseFrom < tools.length;
  btnMore.style.display = hasCollapsed ? 'flex' : 'none';
  closeToolbarOverflow();
  // La cloche a pu changer de place : resynchronise l'indicateur de non-lus.
  if (typeof updateNotifBadge === 'function') updateNotifBadge();
}

function applyWindowSize() {
  let width = 680;
  if (config.barSize === 'petit') width = 520;
  if (config.barSize === 'grand') width = 840;
  invoke("resize_window", { width, height: 680 });
  document.body.dataset.barSize = config.barSize;
  applyToolbarLayout();
}

function startNewChat() {
  clearChatDocs();
  conversationHistory = [];
  currentConversationId = null;
  contextWarned = false;
  messagesList.innerHTML = "";
  clearMessageSelection();
  messagesContainer.style.display = 'none';
  updateContextMeter();
}

function applyConfigUI() {
  document.body.classList.remove("theme-light-forced", "theme-dark-forced");
  const isDark = config.themePreference !== 'light';
  document.body.classList.add(isDark ? 'theme-dark-forced' : 'theme-light-forced');
  // La couche de jetons (tokens.css) se pilote par `data-dt-theme` sur <html>.
  // La fenêtre principale ne le posait jamais : tout ce qui passe par un jeton
  // (--accent en mode « Palette », arrondis, surfaces partagées) restait figé
  // sur le thème du SYSTÈME et ignorait ce bouton.
  document.documentElement.setAttribute('data-dt-theme', isDark ? 'dark' : 'light');
  if (btnThemeToggle) {
    const svg = btnThemeToggle.querySelector('svg');
    if (svg) {
      svg.innerHTML = isDark
        ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>'
        : '<circle cx="12" cy="12" r="4.5"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M19.4 4.6l-1.8 1.8M6.4 17.6l-1.8 1.8"></path>';
    }
    btnThemeToggle.classList.remove('is-locked', 'is-denied');
    if (btnThemeToggle.dataset.baseTitle) btnThemeToggle.title = btnThemeToggle.dataset.baseTitle;
  }

  // Linux : réapplique le fond opaque inline de la barre selon le thème courant.
  applyBarOpaqueMode();
  applyLinuxWebkitGlassFallback();

  // Option « couleur personnalisée des polices » retirée : on neutralise tout
  // réglage hérité pour revenir au comportement par défaut (suit le thème).
  document.body.style.removeProperty('--text-main');
  document.body.style.removeProperty('--text-muted');
  document.body.classList.remove('custom-text-color');

  if (config.aiSource === 'shortcut') {
    btn350mLabel.textContent = "Modèle Apple";
    btn350mToggle.style.opacity = "0.75";
    btn350mToggle.title = t("dyn_tt_source_shortcut");
    activeChatLabel.textContent = `Modèle Apple (${config.shortcutName})`;
    chatInput.placeholder = t("dyn_ask_ai");
    btnActionMode.style.display = 'flex';
    updateActionModeUI();
    if (btnOllamaMode) btnOllamaMode.style.display = 'none';
    closeOllamaModeMenu();
  } else {
    if (availableModels.length && !availableModels.includes(currentModel)) {
      currentModel = config.selectedModel || availableModels[0];
    }
    btn350mToggle.style.opacity = "1";
    btn350mToggle.title = t("dyn_tt_change_model");
    // Le libellé nomme la source RÉELLE : « Ollama actif » au-dessus d'une
    // conversation Apple ou API cloud faisait douter de ce qui répondait.
    activeChatLabel.textContent = ({
      llama: "llama.cpp actif",
      applefm: "Apple Intelligence " + (getLang() === "en" ? "active" : "actif"),
      api: "API " + (getLang() === "en" ? "active" : "active"),
      lumen: "Lumen Server " + (getLang() === "en" ? "active" : "actif"),
      litert: "LiteRT " + (getLang() === "en" ? "active" : "actif"),
    })[config.aiSource] || t("dyn_ollama_active");
    chatInput.placeholder = t("dyn_ask_ollama");
    updateModelLabel();
    // En Ollama, toutes les destinations du prompt sont unifiées dans le seul
    // bouton « mode ». Les anciens boutons (Action, function calling, Fluxo)
    // sont masqués au profit de ce contrôle.
    btnActionMode.style.display = 'none';
    if (btnOllamaMode) {
      btnOllamaMode.style.display = 'flex';
      updateOllamaModeUI();
    }
  }

  // Boutons Fluxo séparés : masqués en Ollama (repliés dans le bouton mode) et
  // en Apple (sans objet). Le menu Fluxo reste accessible via le mode « workflow ».
  if (btnFluxo) btnFluxo.style.display = 'none';
  if (btnFluxoTools) btnFluxoTools.style.display = 'none';

  // Outil mémoire : seuls les moteurs qui savent appeler des outils l'affichent
  // (le chemin Raccourci Apple ne transporte pas de tool call).
  if (btnMemory) {
    btnMemory.style.display = config.aiSource === 'shortcut' ? 'none' : 'flex';
    updateMemoryToolUI();
  }

  // Préchargement du modèle : pertinent seulement en source Ollama (à côté du
  // sélecteur de modèle).
  const btnPreloadInline = document.querySelector("#btn-preload-inline");
  if (btnPreloadInline) btnPreloadInline.style.display = config.aiSource === 'ollama' ? 'inline-flex' : 'none';

  // Bouton « joindre une image » : modèles multimodaux Ollama uniquement (le
  // chemin Raccourci Apple ne transporte pas d'image). On purge l'éventuel
  // brouillon d'images si on quitte la source Ollama.
  // Le trombone reste visible quelle que soit la source : les documents sont
  // pris en charge partout (extraction de texte), seules les IMAGES dépendent
  // d'un modèle multimodal.
  if (btnAttach) btnAttach.style.display = 'flex';
  if (!VISION_SOURCES.includes(config.aiSource) && pendingImages.length) clearPendingImages();

  // Bouton Boîte à outils : toujours visible (donne accès à tous les modules).
  if (btnAgents) btnAgents.style.display = 'flex';

  updateAutoSpeakUI();

  // Apply transparency to CSS
  document.documentElement.style.setProperty('--glass-opacity', config.glassOpacity.toString());

  // Applique le thème d'avatar (orbe + accents barre). En 'default', ceci
  // restaure la palette utilisateur et synchronise les couleurs de la barre.
  applyOrbTheme();
  applyOrbRuntimeSettings();

  // The context budget depends on the active AI source, refresh the meter.
  updateContextMeter();
}

// Applique immédiatement la sélection reçue du contrôleur physique. Le bridge
// persiste déjà les valeurs; cette écoute évite d'attendre un redémarrage de
// Lumen pour basculer entre Ollama, llama-server, Apple et l'API.
window.addEventListener("lumen-controller-config", async (event) => {
  const detail = event?.detail || {};
  const source = detail.source ||
    (detail.backend === "apple" ? "shortcut" : detail.backend);
  const valid = ["ollama", "llama", "shortcut", "api", "lumen", "applefm"].includes(source);

  // Le modèle EN PREMIER : setAiSourceFromPanel() démarre llama-server avec
  // `currentModel`, qui doit donc déjà être à jour quand on l'appelle.
  if (detail.model) {
    if (isApiLike(source)) {
      setCloudModel(detail.model, source);
    } else if (source !== "shortcut") {
      config.selectedModel = String(detail.model);
      currentModel = config.selectedModel;
      rememberModelFor(source, config.selectedModel);
    }
  }

  if (valid && source !== config.aiSource) {
    // Chemin canonique, le même que le menu de la barre. Il ne se contente
    // pas de changer config.aiSource : il pousse le backend actif vers le
    // Rust (pushOllamaConfig -> ollama.json, lu par les agents et les blocs
    // Fluxo) et démarre/arrête llama-server. Sans ces deux étapes,
    // l'interface basculait bien mais les requêtes continuaient de partir
    // vers l'ancien backend.
    // Attendu : la fonction est asynchrone et recharge elle-même la liste des
    // modèles. Sans `await`, elle courait contre le `fetchAvailableModels()`
    // quelques lignes plus bas, et le modèle retenu dépendait de l'ordre
    // d'arrivée des deux réponses.
    await setAiSourceFromPanel(source);
  } else {
    pushOllamaConfig();
    // llama-server est lié à UN fichier de modèle : changer de modèle sans
    // changer de source impose de le relancer.
    if (config.aiSource === "llama" && detail.model && currentModel) {
      startLlamaModel(currentModel);
    }
  }

  try {
    if (source === "ollama" || source === "llama") {
      await fetchAvailableModels();
    }
  } catch (_) {}
  applyConfigUI();
  updateModelLabel();
  // Renvoi immédiat vers l'écran du contrôleur. Sans cela, un badge RFID
  // devait attendre le battement de 3 s pour que l'e-paper suive, ce qui
  // donnait l'impression que le badge n'avait rien fait. Réémettre vers le
  // contrôleur qui vient lui-même d'émettre est sans effet : il réapplique
  // une valeur identique.
  window.OrbBridge?.pushControllerState?.(true);
});

// Arrêt demandé depuis le contrôleur : la synthèse vocale, la génération en
// cours, et un éventuel workflow Fluxo. Trois mécanismes distincts, mais un
// seul geste côté utilisateur.
const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';
const STOP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"></rect></svg>';
// L'état « occupé » a plusieurs sources (génération, chat distant, voix) :
// une sonde légère aligne le bouton sans instrumenter chacune.
function syncSendButton() {
  if (!sendBtn) return;
  const busy = isGenerating || remoteChatRunning;
  if (sendBtn.classList.contains("is-stop") !== busy) {
    sendBtn.classList.toggle("is-stop", busy);
    sendBtn.innerHTML = busy ? STOP_ICON : SEND_ICON;
    sendBtn.title = busy ? t("tt_stop") : t("tt_send");
  }
  setTimeout(syncSendButton, 200);
}

async function stopFromController() {
  stopRequested = true;
  generationAbort?.abort();
  announcePending = null;
  await stopSpeaking();
  // Les workflows Fluxo tournent côté Rust : ils s'arrêtent par leur runId.
  for (const runId of Object.keys(activeRuns || {})) {
    invoke("clear_run", { runId }).catch(() => {});
  }
  showHint(t("controller_stopped"));
}

// Volume système piloté par le potentiomètre du contrôleur.
//
// Chaque réglage lance un processus (osascript / PowerShell / pactl). Tourner
// le bouton produit une dizaine d'événements par seconde : on ne garde donc que
// la DERNIÈRE valeur reçue pendant qu'un réglage est en cours, et on l'applique
// dès qu'il se termine. La cadence s'ajuste ainsi d'elle-même au coût réel de
// l'appel, sans délai fixe qui rendrait le bouton mou.
let pendingVolume = null;
let volumeBusy = false;

async function flushControllerVolume() {
  if (volumeBusy || pendingVolume === null) return;
  const percent = pendingVolume;
  pendingVolume = null;
  volumeBusy = true;
  try {
    await invoke("system_set_volume", { percent });
  } catch (err) {
    console.warn("[Volume]", err);
    showHint(t("volume_failed"));
    pendingVolume = null;            // inutile d'insister à chaque cran
  } finally {
    volumeBusy = false;
    if (pendingVolume !== null) flushControllerVolume();
  }
}

function applyControllerVolume(value) {
  const raw = Number(value);
  if (!isFinite(raw)) return;
  pendingVolume = Math.max(0, Math.min(100, Math.round(raw)));
  flushControllerVolume();
}

// Exécute l'action associée à un badge RFID.
//
// Point d'extension du système : pour qu'un badge déclenche autre chose qu'un
// changement de modèle, il suffit d'ajouter une entrée à RFID_ACTIONS
// (src/lib/rfid-bindings.js) et un `case` ici. Le menu des Réglages se
// construit à partir du registre, il n'y a rien d'autre à toucher, et le
// firmware du contrôleur n'a pas à être reflashé : il n'envoie qu'un UID.
async function runRfidBinding(uid) {
  // La résolution se fait côté Rust : l'UID ne fait qu'entrer, et la table
  // des associations n'est jamais exposée à la webview.
  const binding = await findBinding(uid);
  if (!binding) {
    showHint(t("rfid_unknown"));
    return;
  }
  const p = binding.params || {};
  switch (binding.action) {
    case "model":
      // On réemprunte le chemin du contrôleur physique, donc setAiSourceFromPanel()
      // : bascule de backend, démarrage de llama-server et poussée vers le Rust.
      window.dispatchEvent(new CustomEvent("lumen-controller-config", {
        detail: {
          backend: p.backend,
          model: p.model,
          source: p.backend === "apple" ? "shortcut" : p.backend,
        },
      }));
      break;
    case "chat_mode":
      if (OLLAMA_MODES[p.mode]) setOllamaMode(p.mode);
      break;
    case "voice":
      if (p.voice) invoke("tts_set_voice", { voice: String(p.voice) }).catch(() => {});
      break;
    default:
      console.warn("[RFID] action inconnue :", binding.action);
      return;
  }
  showHint(t("rfid_applied", { label: binding.label || binding.action }));
}

// Derive the toolbar button accent colors from the orb's palette, so Heartbeat,
function updateActionModeUI() {
  if (!btnActionMode) return;
  if (config.actionModeActive) {
    btnActionMode.classList.add("active");
    btnActionMode.title = t("dyn_action_on");
  } else {
    btnActionMode.classList.remove("active");
    btnActionMode.title = t("dyn_action_off");
  }
}

function updateMemoryToolUI() {
  updateOrchestrateUI();
  if (!btnMemory) return;
  // Les modes Outils et Documentation embarquent déjà la mémoire dans leur
  // catalogue : le bouton n'y changerait rien. On l'estompe et on le dit, plutôt
  // que de laisser un interrupteur sans effet.
  const carriedByMode = config.ollamaMode === "tools" || config.ollamaMode === "docs";
  // Le mode Documents, lui, ne passe par AUCUN outil : il injecte les extraits
  // et laisse le modèle répondre. Laisser le bouton allumé y ferait croire à
  // une mémoire active qui ne s'exécute jamais.
  const ragMode = config.ollamaMode === "rag";
  const inert = carriedByMode || ragMode;
  btnMemory.classList.toggle("active", !!config.memoryTool && !inert);
  btnMemory.classList.toggle("dim", inert);
  btnMemory.title = ragMode
    ? t("dyn_memory_tool_rag")
    : carriedByMode
      ? t("dyn_memory_tool_mode")
      : config.memoryTool ? t("dyn_memory_tool_on") : t("dyn_memory_tool_off");
}

// Journal des accès de l'IA (lib/tool-cache.js) : fenêtre de consultation.
const ACCESS_LABELS = {
  fr: {
    title: "Journal des accès de l'IA", empty: "Aucun accès enregistré.", clear: "Effacer", close: "Fermer",
    cached: "déjà lu", write: "modification", failed: "refusé / échec",
    tools: {
      sandbox_list: "Liste des sandboxes", sandbox_search: "Recherche dans les fichiers", sandbox_read: "Lecture d'un fichier",
      search_personal_data: "Données personnelles", notes_search: "Recherche dans Notes", notes_read: "Lecture d'une note",
      tables_list: "Liste des bases", query_tables: "Requête sur une base", search_documents: "Recherche dans le Corpus",
      apps_list: "Liste des applications", app_data: "Données d'une application", apps_search: "Recherche dans les applications",
      search_lumen_docs: "Documentation de Lumen", memory_recall: "Mémoire (lecture)", memory_remember: "Mémoire (ajout)",
      create_reminder: "Création d'un rappel", kanban_add_card: "Ajout au Kanban", agenda_add_event: "Ajout à l'Agenda",
      notes_create: "Création d'une note", notes_append: "Ajout à une note", domotique_command: "Commande domotique",
      domotique_get_state: "État d'un objet", export_pdf: "Export PDF",
    },
  },
  en: {
    title: "AI access log", empty: "No access recorded.", clear: "Clear", close: "Close",
    cached: "already read", write: "change", failed: "refused / failed",
    tools: {},
  },
};
async function showAccessLog() {
  const L = ACCESS_LABELS[getLang() === "en" ? "en" : "fr"];
  const entries = (await readAccessLog()).slice().reverse();
  const ov = document.createElement("div");
  ov.className = "access-log-ov";
  const rows = entries.map((e) => {
    const label = L.tools[e.tool] || ACCESS_LABELS.fr.tools[e.tool] || e.tool;
    const tags = [e.cached ? L.cached : "", e.write ? L.write : "", e.ok === false ? L.failed : ""].filter(Boolean);
    return `<li class="${e.write ? "w" : ""}${e.ok === false ? " ko" : ""}"><time>${escapeHTML(new Date(e.ts).toLocaleString())}</time>`
      + `<strong>${escapeHTML(label)}</strong>${e.target ? `<span class="t">${escapeHTML(e.target)}</span>` : ""}`
      + `<span class="s">${escapeHTML(e.surface || "")}${tags.length ? ` · ${escapeHTML(tags.join(" · "))}` : ""}</span></li>`;
  }).join("");
  ov.innerHTML = `<div class="access-log" role="dialog"><header><h3>${escapeHTML(L.title)}</h3><span>${entries.length}</span></header>
    <ul>${rows || `<li class="empty">${escapeHTML(L.empty)}</li>`}</ul>
    <footer><button type="button" data-clear>${escapeHTML(L.clear)}</button><button type="button" class="primary" data-close>${escapeHTML(L.close)}</button></footer></div>`;
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.querySelector("[data-close]").addEventListener("click", close);
  ov.querySelector("[data-clear]").addEventListener("click", async () => { await clearAccessLog(); close(); showAccessLog(); });
  document.body.appendChild(ov);
}

function setOrchestrate(on, { persist = true } = {}) {
  config.orchestrate = !!on;
  if (persist) localStorage.setItem('orchestrateChat', config.orchestrate.toString());
  updateOrchestrateUI();
  remotePush({ type: "orchestrate", on: config.orchestrate });
  if (persist) showHint(t(config.orchestrate ? "dyn_orchestrate_on" : "dyn_orchestrate_off"));
}

function updateOrchestrateUI() {
  if (checkboxOrchestrate) checkboxOrchestrate.checked = !!config.orchestrate;
  if (!btnOrchestrate) return;
  // Ne s'applique qu'à la discussion simple (les autres modes ont leur propre
  // chaîne) et pas aux Raccourcis Apple, qui n'appellent pas d'outils.
  const inert = config.aiSource === "shortcut" || (config.ollamaMode && config.ollamaMode !== "chat");
  btnOrchestrate.classList.toggle("active", !!config.orchestrate && !inert);
  btnOrchestrate.classList.toggle("dim", inert);
  btnOrchestrate.title = inert ? t("dyn_orchestrate_mode") : t(config.orchestrate ? "dyn_orchestrate_on" : "dyn_orchestrate_off");
}

function updateFluxoToolsUI() {
  if (!btnFluxoTools) return;
  if (config.fluxoTools) {
    btnFluxoTools.classList.add("active");
    btnFluxoTools.title = t("dyn_fluxo_tools_on");
  } else {
    btnFluxoTools.classList.remove("active");
    btnFluxoTools.title = t("dyn_fluxo_tools_off");
  }
}

// ===== Mode Ollama unifié (destination du prompt) =====
// Un seul contrôle remplace les anciens boutons (Action Router, function calling,
// workflow Fluxo) : un seul est actif à la fois.
const OLLAMA_MODES = {
  chat:     { icon: 'messages-square', labelKey: 'mode_chat',     descKey: 'mode_chat_desc' },
  router:   { icon: 'route',           labelKey: 'mode_router',   descKey: 'mode_router_desc' },
  tools:    { icon: 'pocket-knife',    labelKey: 'mode_tools',    descKey: 'mode_tools_desc' },
  docs:     { icon: 'book-open-text',  labelKey: 'mode_docs',     descKey: 'mode_docs_desc' },
  rag:      { icon: 'library',         labelKey: 'mode_rag',      descKey: 'mode_rag_desc' },
  workflow: { icon: 'workflow',        labelKey: 'mode_workflow', descKey: 'mode_workflow_desc' },
};

function ollamaModeLabel() {
  if (config.ollamaMode === 'workflow' && config.ollamaWorkflow) return config.ollamaWorkflow;
  if (!config.ollamaMode || config.ollamaMode === 'chat') return t('mode_auto');
  const meta = OLLAMA_MODES[config.ollamaMode] || OLLAMA_MODES.chat;
  return t(meta.labelKey);
}

function updateOllamaModeUI() {
  if (!btnOllamaMode) return;
  const meta = OLLAMA_MODES[config.ollamaMode] || OLLAMA_MODES.chat;
  const icEl = document.querySelector('#ollama-mode-ic');
  const lblEl = document.querySelector('#ollama-mode-label');
  if (icEl) icEl.innerHTML = ic(meta.icon);
  if (lblEl) lblEl.textContent = ollamaModeLabel();
  // Le bouton Mémoire dépend du mode courant : il s'estompe là où la mémoire
  // est déjà dans le catalogue d'outils.
  updateMemoryToolUI();
}

function makeModeItem(iconName, name, desc, active, onClick) {
  const item = document.createElement('div');
  item.className = 'mode-item' + (active ? ' active' : '');
  item.innerHTML =
    `<span class="mode-item-ic">${ic(iconName)}</span>` +
    `<span class="mode-item-text"><span class="mode-item-name"></span>` +
    `<span class="mode-item-desc"></span></span>` +
    `<span class="mode-item-check">${ic('retry')}</span>`;
  item.querySelector('.mode-item-name').textContent = name;
  item.querySelector('.mode-item-desc').textContent = desc;
  // Pastille de sélection : un simple point (réutilise le glyphe via CSS opacity).
  item.querySelector('.mode-item-check').innerHTML = '●';
  item.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return item;
}

async function openOllamaModeMenu() {
  if (!ollamaModeMenu) return;
  ollamaModeMenu.innerHTML = '';
  // « Automatique » (le routeur décide) d'abord ; les modes forcés sont
  // rangés sous « Modes avancés », dépliés seulement si l'un d'eux est actif.
  const auto = OLLAMA_MODES.chat;
  ollamaModeMenu.appendChild(makeModeItem(auto.icon, t('mode_auto'), t('mode_auto_desc'), !config.ollamaMode || config.ollamaMode === 'chat', () => setOllamaMode('chat')));
  const adv = document.createElement('div');
  adv.className = 'mode-menu-adv';
  const open = Boolean(config.ollamaMode && config.ollamaMode !== 'chat');
  adv.hidden = !open;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mode-menu-sep mode-menu-adv-toggle';
  toggle.textContent = `${open ? '▾' : '▸'} ${t('mode_advanced')}`;
  toggle.addEventListener('click', (e) => { e.stopPropagation(); adv.hidden = !adv.hidden; toggle.textContent = `${adv.hidden ? '▸' : '▾'} ${t('mode_advanced')}`; });
  ollamaModeMenu.appendChild(toggle);
  ollamaModeMenu.appendChild(adv);
  for (const m of ['rag', 'router', 'tools', 'docs']) {
    const meta = OLLAMA_MODES[m];
    adv.appendChild(makeModeItem(meta.icon, t(meta.labelKey), t(meta.descKey), config.ollamaMode === m, () => setOllamaMode(m)));
  }
  // Workflows Fluxo spécifiques.
  const sep = document.createElement('div');
  sep.className = 'mode-menu-sep';
  sep.textContent = t('mode_workflows_header');
  adv.appendChild(sep);
  let names = [];
  try { names = await invoke('list_fluxo_workflows'); } catch (_) {}
  if (names.length) {
    names.forEach((n) => {
      const active = config.ollamaMode === 'workflow' && config.ollamaWorkflow === n;
      adv.appendChild(makeModeItem('terminal', n, t('mode_workflow_desc'), active, () => setOllamaMode('workflow', n)));
    });
  } else {
    const empty = document.createElement('div');
    empty.className = 'mode-menu-sep';
    empty.style.textTransform = 'none';
    empty.textContent = t('mode_no_workflow');
    adv.appendChild(empty);
  }
  ollamaModeMenu.hidden = false;
  btnOllamaMode.classList.add('open');
}

// ===== Panneau « Backend IA » (source + modèle + think), ouvert depuis la
// pastille de modèle. Même contenu que le panneau du workspace, au style de la
// barre. Règles : modèles Ollama affichés UNIQUEMENT en source Ollama ; le mode
// « think » est proposé pour Ollama et llama-server (modèles compatibles).
async function setAiSourceFromPanel(src) {
  config.aiSource = src;
  localStorage.setItem('aiSource', src);
  pushOllamaConfig();
  applyConfigUI();
  if (src !== 'llama') invoke('llama_stop').catch(() => {});
  // La liste des modèles dépend de la source : en Ollama ce sont des noms de
  // modèles, en llama.cpp des fichiers GGUF. Sans ce rafraîchissement,
  // `currentModel` restait le modèle de l'ancienne source et `llama_start`
  // recevait un nom Ollama — il échouait, et le changement de backend semblait
  // ne rien faire tant qu'on n'était pas passé par les Paramètres.
  try { await fetchAvailableModels(); } catch (e) { console.error(e); }
  // `fetchAvailableModels` a pu retomber sur un autre modèle (celui de l'ancienne
  // source n'existe pas dans la nouvelle) : on persiste le choix effectif, sinon
  // le prochain démarrage repartirait sur un nom invalide.
  if (currentModel) {
    config.selectedModel = currentModel;
    rememberModelFor(src, currentModel);
    pushOllamaConfig();
  }
  updateModelLabel();
  if (src === 'llama' && currentModel) {
    // En cas d'échec, `startLlamaModel` a déjà posé un état explicite : ne pas
    // le laisser écraser par le ping générique.
    if (!(await startLlamaModel(currentModel))) return;
  }
  checkOllamaStatus();
}

// Démarrage de llama-server avec retour visible. L'erreur était jusqu'ici avalée
// (`.catch(() => {})`) : quand le démarrage échouait — modèle absent, ou port
// déjà tenu par un llama-server orphelin — l'interface continuait d'afficher le
// modèle choisi pendant que les requêtes partaient ailleurs.
async function startLlamaModel(filename) {
  try {
    // Relu à chaque démarrage : les Réglages (autre fenêtre) ont pu le changer
    // depuis le chargement de la barre.
    const stored = parseInt(localStorage.getItem('llamaNumCtx') || '0', 10);
    if (stored >= 2048) config.llamaNumCtx = Math.min(LLAMA_CTX_MAX, stored);
    await invoke('llama_start', { filename, ctxSize: config.llamaNumCtx || 8192 });
    return true;
  } catch (e) {
    const msg = String(e?.message || e || "");
    console.error("llama_start :", msg);
    // L'état persistant suffit : la pastille passe au rouge et l'infobulle porte
    // la raison. Surtout PAS le centre de notifications — il est réservé au
    // Heartbeat, il empile les entrées, et cet échec se rejoue à chaque
    // tentative de bascule : on obtenait le même message en boucle.
    statusIndicator.className = 'status-dot offline';
    statusIndicator.title = msg;
    llmStatusReason = 'llama_start_failed';
    return false;
  }
}

async function openBackendMenu() {
  if (!backendMenu) return;
  backendMenu.innerHTML = '';
  const source = config.aiSource || 'ollama';

  const head = document.createElement('div');
  head.className = 'mode-menu-sep';
  head.textContent = t('lbl_backend_ia') || 'Backend IA';
  backendMenu.appendChild(head);

  // --- Source ---
  const sources = [['ollama', t('src_ollama') || 'Ollama local', 'chip'], ['llama', 'llama.cpp / llama-server', 'terminal']];
  // L'API cloud est UN backend ; ses modèles (tous fournisseurs dont la clé est
  // enregistrée) se choisissent dans la section « Modèle API » plus bas.
  const apiChoices = await listApiModelChoices();
  const apiActive = apiChoices.find((c) => c.active) || apiChoices[0];
  sources.push(['api', t('src_api') || 'API cloud', 'bolt', {
    desc: apiChoices.length ? (apiActive ? `${apiActive.model} · ${apiActive.name}` : '') : 'Ajoutez une clé dans les Réglages',
    active: source === 'api',
    before: async () => {
      if (source === 'api' || !apiActive) return;
      await selectApiModel(apiActive.id, apiActive.model);
      config.apiBaseUrl = localStorage.getItem('apiBaseUrl');
      config.apiModel = localStorage.getItem('apiModel') || config.apiModel;
    },
  }]);
  if ((await lumenServerBackendState()).available) sources.push(['lumen', 'Lumen Server', 'bolt']);
  if (config.applefmAvailable) sources.push(['applefm', t('src_applefm') || 'Apple Foundation Models', 'sparkles']);
  if (!platformWithoutAppleShortcuts()) sources.push(['shortcut', t('src_apple') || 'Raccourci Apple', 'sparkles']);
  for (const [id, label, icon, extra] of sources) {
    backendMenu.appendChild(makeModeItem(icon, label, extra?.desc || '', extra ? extra.active : source === id, async () => {
      if (extra?.before) { try { await extra.before(); } catch (e) { console.error(e); } }
      // `setAiSourceFromPanel` est asynchrone (elle recharge la liste des
      // modèles de la nouvelle source) : redessiner sans l'attendre affichait
      // l'ancien état, et il fallait recliquer pour voir le bon.
      await setAiSourceFromPanel(id);
      openBackendMenu(); // re-render : adapte les sections (modèles / think)
    }));
  }

  // --- Modèle Apple Foundation Models : choix fermé (sur l'appareil / PCC) ---
  if (source === 'applefm') {
    const sep = document.createElement('div');
    sep.className = 'mode-menu-sep';
    sep.textContent = t('lbl_applefm_model') || 'Modèle Apple';
    backendMenu.appendChild(sep);
    const known = APPLEFM_MODELS.filter((m) => config.applefmModels.some((x) => x.id === m.id && x.available));
    for (const m of known.length ? known : APPLEFM_MODELS.slice(0, 1)) {
      backendMenu.appendChild(makeModeItem('sparkles', m.label, '', cloudModel(source) === m.id, () => {
        setCloudModel(m.id, source);
        pushOllamaConfig(); updateModelLabel(); checkOllamaStatus();
        openBackendMenu();
      }));
    }
  }

  // --- Modèle API (source API uniquement) ---
  if (isApiLike(source) && source !== 'applefm') {
    const sep = document.createElement('div');
    sep.className = 'mode-menu-sep';
    sep.textContent = source === 'lumen' ? 'Modèle Lumen Server' : (t('lbl_api_model') || 'Modèle API');
    backendMenu.appendChild(sep);
    // Modèles des fournisseurs configurés : un clic bascule fournisseur + modèle.
    if (source === 'api') {
      for (const c of apiChoices) {
        backendMenu.appendChild(makeModeItem('bolt', c.model, c.name, c.active, async () => {
          try {
            await selectApiModel(c.id, c.model);
            config.apiBaseUrl = localStorage.getItem('apiBaseUrl');
            config.apiModel = localStorage.getItem('apiModel') || c.model;
            setCloudModel(config.apiModel, source);
            pushOllamaConfig(); updateModelLabel(); checkOllamaStatus();
          } catch (e) { console.error(e); }
          openBackendMenu();
        }));
      }
    }
    const row = document.createElement('div');
    row.className = 'backend-field';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.spellcheck = false;
    inp.value = cloudModel(source);
    inp.placeholder = source === 'lumen' ? 'modèle du serveur' : 'gpt-4o-mini';
    inp.addEventListener('change', () => {
      setCloudModel(inp.value, source);
      pushOllamaConfig(); updateModelLabel(); checkOllamaStatus();
    });
    inp.addEventListener('click', (e) => e.stopPropagation());
    row.appendChild(inp);
    backendMenu.appendChild(row);
  }

  // --- Modèles Ollama (source Ollama uniquement) ---
  if (source === 'ollama' || source === 'llama') {
    // Ne pas se contenter de « la liste est vide » : après un changement de
    // source, elle contient encore les modèles de l'ancienne (noms Ollama vs
    // fichiers GGUF). On recharge dès que la source du cache ne correspond plus.
    if (!availableModels.length || availableModelsSource !== source) {
      try { await fetchAvailableModels(); } catch (_) {}
    }

    // --- Mode « think » : Ollama et llama-server uniquement.
    // Placé AVANT la liste des modèles pour rester visible même quand celle-ci
    // est longue (sinon il passe sous la zone scrollable). ---
    const tsep = document.createElement('div');
    tsep.className = 'mode-menu-sep';
    if (source === 'ollama' || source === 'llama') {
      tsep.textContent = t('lbl_reasoning') || 'Raisonnement';
      backendMenu.appendChild(tsep);
      backendMenu.appendChild(makeModeItem('sparkles',
        t('lbl_think_mode') || 'Mode « think »',
        t('hint_think_mode') || 'Le modèle réfléchit avant de répondre (modèles compatibles).',
        config.ollamaThink, () => {
          config.ollamaThink = !config.ollamaThink;
          localStorage.setItem('ollamaThink', config.ollamaThink.toString());
          if (checkboxOllamaThink) checkboxOllamaThink.checked = config.ollamaThink;
          openBackendMenu();
        }));
    }

    const sep = document.createElement('div');
    sep.className = 'mode-menu-sep';
    sep.textContent = source === 'llama' ? 'Modèle llama.cpp' : (t('lbl_models') || 'Modèle Ollama');
    backendMenu.appendChild(sep);
    if (availableModels.length) {
      availableModels.forEach((m) => {
        backendMenu.appendChild(makeModeItem('chip', m, '', m === currentModel, () => {
          currentModel = m;
          config.selectedModel = m;
          rememberModelFor(source, m);
          updateModelLabel(); pushOllamaConfig();
          if (source === 'llama') startLlamaModel(m);
          checkOllamaStatus();
          closeBackendMenu();
        }));
      });
    } else {
      const empty = document.createElement('div');
      empty.className = 'mode-menu-sep';
      empty.style.textTransform = 'none';
      empty.textContent = t('mode_no_model') || 'Aucun modèle (vérifie Ollama).';
      backendMenu.appendChild(empty);
    }
  }

  backendMenu.hidden = false;
  btn350mToggle.classList.add('open');
}

function closeBackendMenu() {
  if (!backendMenu) return;
  backendMenu.hidden = true;
  btn350mToggle.classList.remove('open');
}

function closeOllamaModeMenu() {
  if (!ollamaModeMenu) return;
  ollamaModeMenu.hidden = true;
  btnOllamaMode?.classList.remove('open');
}

function setOllamaMode(mode, workflow) {
  config.ollamaMode = mode;
  if (mode === 'workflow') config.ollamaWorkflow = workflow || config.ollamaWorkflow || '';
  localStorage.setItem('ollamaMode', mode);
  localStorage.setItem('ollamaWorkflow', config.ollamaWorkflow || '');
  // Compat : la case « function calling » des Paramètres reflète l'état du mode.
  config.fluxoTools = (mode === 'tools');
  localStorage.setItem('fluxoTools', config.fluxoTools.toString());
  if (checkboxFluxoTools) checkboxFluxoTools.checked = config.fluxoTools;
  updateOllamaModeUI();
  closeOllamaModeMenu();
  showHint(t('dyn_mode_set', { mode: ollamaModeLabel() }));
  remotePushOllamaMode(); // reflète le changement sur le(s) téléphone(s)
  remotePushActionMode(); // synchronise le raccourci Action mobile (router/chat)
  remotePushOrbAppearance(); // et l'apparence de l'orbe (thème, couleurs, verre)
}

// ===== Raccourcis clavier globaux de la barre =====
// Modificateur unique : Control + Option (⌃⌥) sur macOS, Ctrl + Alt ailleurs.
// PAS ⌥⌘ : macOS s'est réservé ⌥⌘D (afficher/masquer le Dock), ⌥⌘M (tout
// réduire) et ⌥⌘/ — l'application ne les reçoit jamais. ⌃⌥ est libre sur les
// trois plateformes (seul ⌃⌥E est déjà pris par Lumen : « comprendre cet
// écran »). On teste `e.code` et non `e.key`, car Option produit des caractères
// morts sur macOS (⌥D → « ∂ »).
const SHORTCUT_MOD_LABEL = navigator.platform.toLowerCase().includes('mac') ? '⌃⌥' : 'Ctrl+Alt+';

function isShortcutChord(e) {
  return e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey;
}

// Sources IA disponibles sur la plateforme courante, dans l'ordre du menu
// Backend : la bascule au clavier suit exactement la même liste.
function backendCycleSources() {
  const list = [['ollama', t('src_ollama') || 'Ollama local'],
                ['llama', 'llama.cpp / llama-server'],
                ['api', t('src_api') || 'API cloud']];
  if (config.applefmAvailable) list.push(['applefm', t('src_applefm') || 'Apple Foundation Models']);
  if (!platformWithoutAppleShortcuts()) list.push(['shortcut', t('src_apple') || 'Raccourci Apple']);
  return list;
}

async function cycleAiSource(step = 1) {
  const list = backendCycleSources();
  const idx = list.findIndex(([id]) => id === (config.aiSource || 'ollama'));
  const next = list[((idx < 0 ? 0 : idx) + step + list.length) % list.length];
  showHint(t('dyn_backend_set', { backend: next[1] }));
  await setAiSourceFromPanel(next[0]);
  // Le menu Backend peut être ouvert : le redessiner pour refléter la source.
  if (backendMenu && !backendMenu.hidden) openBackendMenu();
}

// Modes de discussion fixes (les workflows Fluxo restent au menu : ils sont
// nommés, donc pas cyclables de façon prévisible).
const CHAT_MODE_CYCLE = ['chat', 'rag', 'router', 'tools', 'docs'];

function cycleOllamaMode(step = 1) {
  const idx = CHAT_MODE_CYCLE.indexOf(config.ollamaMode);
  const next = CHAT_MODE_CYCLE[((idx < 0 ? 0 : idx) + step + CHAT_MODE_CYCLE.length) % CHAT_MODE_CYCLE.length];
  setOllamaMode(next);
}

// Toast d'indication discret (réutilise le style de l'astuce de dictée).
let barHintTimer = null;
function showHint(message) {
  let toast = document.querySelector('#bar-hint');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'bar-hint';
    toast.className = 'dictation-hint';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(barHintTimer);
  barHintTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

function updateAutoSpeakUI() {
  if (!btnAutoSpeak) return;
  if (config.autoSpeak) {
    btnAutoSpeak.classList.add("active");
    btnAutoSpeak.title = t("dyn_autospeak_on");
  } else {
    btnAutoSpeak.classList.remove("active");
    btnAutoSpeak.title = t("dyn_autospeak_off");
  }
}

// Start or stop the Rust-side CRON scheduler to match the current config.
async function applyHeartbeat() {
  try {
    if (config.heartbeatEnabled) {
      await invoke("start_heartbeat", {
        shortcutName: config.heartbeatShortcut,
        cron: config.heartbeatFrequency,
        input: config.heartbeatInput,
        engine: heartbeatEngine()
      });
    } else {
      await invoke("stop_heartbeat");
    }
  } catch (err) {
    console.error("Heartbeat :", err);
    showDictationHint(t("dyn_heartbeat_fail", { err }));
  }
}

function updateHeartbeatUI() {
  if (!btnHeartbeat) return;
  btnHeartbeat.classList.toggle("active", config.heartbeatEnabled);
  btnHeartbeat.title = config.heartbeatEnabled
    ? t("dyn_heartbeat_on", { name: config.heartbeatShortcut })
    : t("dyn_heartbeat_off");
}

// Retire les emojis (et marqueurs associés) d'un texte AVANT l'énonciation, sans
// toucher au texte affiché dans la discussion : on ne les prononce simplement pas.
function stripForSpeech(text) {
  return markdownToSpeech(text);
}

function setBubbleRawText(bubble, text) {
  if (bubble) bubble.dataset.rawText = String(text || "");
}

function getBubbleSpeechText(bubble, fallback = "") {
  return (
    bubble?.dataset?.rawText ||
    bubble?.querySelector(".msg-answer")?.innerText ||
    bubble?.querySelector(".msg-text-content")?.innerText ||
    fallback ||
    ""
  );
}

// Speak the given text through the configured macOS shortcut.
// Returns a promise; respects the global single-speech lock.
// Interrompt la lecture vocale en cours (voix système ET Piper). Le backend tue
// le process de lecture ; côté Piper on débloque aussi l'attente de fin pour que
// `speakText` rende la main immédiatement.
async function stopSpeaking() {
  try { await invoke("stop_speaking"); } catch (e) { /* non bloquant */ }
  if (speakEndedResolver) { try { speakEndedResolver(); } catch {} }
  // Le verrou est libéré tout de suite : si l'ancienne lecture n'a jamais
  // signalé sa fin (évènement perdu, autre fenêtre/vue qui a coupé la voix),
  // `isSpeaking` restait vrai et TOUTE lecture suivante — bouton 🔊 compris —
  // était ignorée en silence. Le `finally` de l'ancienne lecture ne le
  // réarmera pas : il ne touche que sa propre lecture (speechSeq).
  speechSeq++;
  isSpeaking = false;
}
let speechSeq = 0;

// Double-clic sur l'avatar (orb.js → lib/voice-stop.js) : le backend a déjà été
// coupé, mais `speakText` attend encore l'évènement `tts-ended` que Piper
// n'émettra plus. Sans ce relais, `isSpeaking` restait vrai et la barre
// devenait muette jusqu'au prochain lancement.
window.addEventListener("lumen-voice-stop", () => {
  if (speakEndedResolver) { try { speakEndedResolver(); } catch {} }
  speechSeq++;
  isSpeaking = false;
  window.LumenOrb?.setState("idle");
});

// Empêche un appel d'énonciation backend figé de bloquer `isSpeaking`
// indéfiniment (sinon le bouton 🔊 et l'auto-lecture deviennent muets jusqu'à
// réouverture de Lumen). Au-delà du délai, on rend la main : le `finally` de
// speakText réarme l'état.
function speakWithWatchdog(promise, ms = 120000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("énonciation expirée")), ms)),
  ]);
}

function selectedSystemVoice(lang) {
  const name = localStorage.getItem("lumenVoiceName") || "";
  const voiceLang = (localStorage.getItem("lumenVoiceLang") || "").toLowerCase();
  return name && voiceLang.startsWith(lang) ? name : null;
}

// Lumen XR lit lui-même les réponses (voix spatiale dans le casque) : tant
// qu'un casque le signale (`xr-voice`, renouvelé toutes les 10 s), le Mac se
// tait — sinon la réponse est dite deux fois, et le micro du casque, entendant
// le Mac, coupait sa propre lecture (interruption à la voix).
let xrVoiceUntil = 0;
async function speakText(text, { voice } = {}) {
  if (Date.now() < xrVoiceUntil) { console.warn("Énonciation laissée au casque Lumen XR."); return false; }
  // Réponse d'un agent doté de sa propre voix : elle prime sur le réglage.
  const agentVoice = voice ?? takeAgentVoice();
  const trimmed = stripForSpeech(text);
  if (!trimmed) {
    console.warn("Énonciation ignorée : texte vide.");
    return false;
  }
  if (isSpeaking) {
    console.warn("Énonciation ignorée : lecture déjà en cours.");
    return false;
  }
  isSpeaking = true;
  const mySeq = ++speechSeq;
  window.LumenOrb?.setState('speaking');
  try {
    const localVoiceReady = ttsLocalAvailable() && await Promise.all([
      invoke("tts_runtime_available").catch(() => false),
      invoke("tts_active_voice").catch(() => ""),
    ]).then(([runtime, voice]) => Boolean(runtime && voice));
    const linuxLocalOnly = platformFlavor === "rpi" || platformFlavor === "linux-standard";
    const wantsLocalVoice = config.speechBackend === "piper" || config.speechBackend === "auto";
    const localAgentVoice = agentVoice.startsWith("local:") ? agentVoice.slice(6) : null;
    const systemAgentVoice = agentVoice.startsWith("system:") ? agentVoice.slice(7) : null;
    const runtimeReady = localAgentVoice && ttsLocalAvailable() && await invoke("tts_runtime_available").catch(() => false);
    if (systemAgentVoice && !linuxLocalOnly) {
      const lang = (localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
      await speakWithWatchdog(invoke("system_speak", { text: trimmed, lang, voice: systemAgentVoice }));
    } else if ((localVoiceReady || runtimeReady) && (linuxLocalOnly || wantsLocalVoice || runtimeReady)) {
      // Énonciation locale (Piper/Kokoro). `tts_speak` rend la main
      // dès le lancement (travail fait dans un thread Rust) ; on attend l'event
      // « tts-ended » pour garder l'orbe animé toute la durée de la lecture.
      const evt = window.__TAURI__?.event;
      // Pendant la synthèse (avant le son), l'orbe « réfléchit » ; il passe en
      // « parle » seulement quand l'audio démarre réellement (event tts-playing).
      window.LumenOrb?.setState('thinking');
      let unEnded = null, unPlaying = null, unError = null, resolveEnded;
      let speechError = null;
      const ended = new Promise((r) => { resolveEnded = r; });
      // Exposé pour que stopSpeaking() débloque l'attente quand on coupe Piper.
      speakEndedResolver = resolveEnded;
      // Écoutes attachées AVANT l'invoke (sinon une synthèse rapide pourrait
      // émettre l'event avant qu'on l'écoute).
      if (evt?.listen) {
        unPlaying = await evt.listen("tts-playing", () => window.LumenOrb?.setState('speaking'));
        unEnded = await evt.listen("tts-ended", () => resolveEnded());
        unError = await evt.listen("tts-error", (event) => {
          speechError = String(event.payload || "Erreur Piper");
          resolveEnded();
        });
      } else resolveEnded();
      try {
        await invoke("tts_speak", { text: trimmed, voice: runtimeReady ? localAgentVoice : null });
        // Sécurité : on ne bloque jamais l'orbe indéfiniment si l'event se perd.
        await Promise.race([ended, new Promise((r) => setTimeout(r, 180000))]);
        if (speechError) throw new Error(speechError);
      } finally {
        if (unPlaying) unPlaying();
        if (unEnded) unEnded();
        if (unError) unError();
        speakEndedResolver = null;
      }
    } else if (platformFlavor === 'windows' || config.speechBackend === 'system' || (config.speechBackend === 'auto' && actionEngine() === 'fluxo')) {
      // Windows n'a pas les Raccourcis Apple : on force toujours la voix système.
      // En mode Ollama/Fluxo sur Mac/Linux standard, ce chemin évite aussi de
      // relancer un workflow complet juste pour parler.
      // Garde-fou : si l'appel backend se fige, on ne bloque pas `isSpeaking`
      // (sinon plus aucune énonciation possible sans rouvrir Lumen).
      // La voix système par défaut suit la langue de l'OS : on transmet la
      // langue de l'app pour qu'une interface en anglais parle en anglais.
      const lang = (localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
      await speakWithWatchdog(invoke("system_speak", { text: trimmed, lang, voice: selectedSystemVoice(lang) }));
    } else {
      await speakWithWatchdog(invoke("call_macos_shortcut", {
        shortcutName: config.speakShortcut,
        prompt: trimmed
      }));
    }
  } catch (err) {
    console.error("Erreur d'énonciation :", err);
    showDictationHint(`Voix : ${err?.message || err}`);
    return false;
  } finally {
    // Une lecture coupée par stopSpeaking() ne libère pas celle qui l'a remplacée.
    if (mySeq === speechSeq) {
      isSpeaking = false;
      window.LumenOrb?.setState(isGenerating ? 'thinking' : 'idle');
    }
  }
  return true;
}

// Liste des modèles Ollama via le backend Rust : fiable sous Windows (pas de CORS
// WebView2, ni de résolution IPv6 de `localhost`). Repli sur un fetch direct.
async function listOllamaModels(url) {
  if (config.aiSource === "llama") {
    const models = await invoke("llama_list_models");
    return (Array.isArray(models) ? models : []).map((model) => model.filename).filter(Boolean);
  }
  try {
    const models = await invoke("ollama_list_models", { url });
    // Le moteur de décision (Tev1) n'est pas un modèle de discussion.
    if (Array.isArray(models)) return models.filter((n) => n && !/tev1|clef-flash|laya/i.test(n));
  } catch (e) {
    try {
      const data = await ollamaGetJson("api/tags", url || "http://127.0.0.1:11434");
      return (data.models || []).map(m => m.name).filter((n) => n && !/tev1|clef-flash|laya/i.test(n));
    } catch { throw e; }
  }
  return [];
}

// La CSP de la WebView n'autorise en HTTP clair que `localhost`/`127.0.0.1`.
// Pour un Ollama sur un AUTRE hôte local (IP LAN, *.local, autre machine), le
// `fetch` direct est bloqué : on route alors par le backend Rust (reqwest, hors
// CSP), comme on le fait déjà sous Windows pour contourner le CORS.
function ollamaUsesBackend(url = config.ollamaUrl) {
  if (!invoke) return false;
  // llama-server expose une API OpenAI-compatible locale sur 11435. Il ne faut
  // jamais laisser le chemin de génération streamée tomber sur l'URL Ollama.
  if (config.aiSource === "llama") return true;
  if (platformFlavor === "windows") return true;
  try {
    const h = new URL(url || "http://127.0.0.1:11434").hostname;
    return !(h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]");
  } catch {
    return false;
  }
}

async function ollamaGetJson(path, url = config.ollamaUrl) {
  const cleanPath = path.replace(/^\/+/, "");
  if (config.aiSource === "llama") {
    if (cleanPath === "api/tags") {
      const models = await invoke("llama_list_models");
      return { models: (Array.isArray(models) ? models : []).map((model) => ({ name: model.filename })) };
    }
    return invoke("llama_get_json", { path: cleanPath.replace(/^api\//, "") });
  }
  if (ollamaUsesBackend(url)) {
    return invoke("ollama_get_json", { url, path: cleanPath });
  }
  const r = await fetch(`${(url || "http://127.0.0.1:11434").replace(/\/$/, "")}/${cleanPath}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// `hooks` (facultatif) : { onUpdate(state), signal } — la réponse arrive alors
// EN FLUX (commande Rust `llm_stream`), puis la promesse renvoie la même forme
// agrégée qu'en non-stream.
async function ollamaPostJson(path, payload, url = config.ollamaUrl, hooks = null) {
  const cleanPath = path.replace(/^\/+/, "");
  const streaming = !!hooks && canStream() && cleanPath === "api/chat";
  if (config.aiSource === "llama") {
    if (cleanPath !== "api/chat") throw new Error("Cet endpoint n'est pas disponible avec llama-server");
    const options = payload?.options || {};
    // Le serveur llama.cpp expose une API compatible OpenAI : le prompt
    // système doit donc être transmis comme un vrai message `system`, comme
    // le fait Ollama avec son champ `system`. Le garde-fou est utile pour les
    // appels venant des mini-apps ou de l'agent, qui ne passent pas forcément
    // par handleSend().
    let messages = Array.isArray(payload?.messages) ? payload.messages.slice() : [];
    // `rawSystem` : l'appelant a composé lui-même son bloc système et ne veut
    // PAS du prompt Lumen (mode Outils avec un modèle LFM, cf. runOllamaAgent).
    // Sans ce garde-fou, le prompt court serait réinjecté derrière le long, et
    // la correction n'aurait aucun effet.
    const systemPrompt = payload?.rawSystem ? "" : getEffectiveSystemPrompt();
    if (systemPrompt) {
      // Seules les consignes VRAIMENT explicites (mini-app, agent) sont
      // fusionnées. On écarte le prompt Lumen, déjà présent, mais aussi la
      // fiche « legacy » d'une conversation commencée sous Ollama : la
      // concaténer reviendrait à injecter une description de l'utilisateur
      // dans le bloc système, que le modèle prend pour une prise de parole.
      const explicitSystem = messages
        .filter((message) => message?.role === "system"
          && !isLumenSystemPrompt(message.content)
          && !isLegacySystemPrompt(message.content))
        .map((message) => String(message.content || "").trim())
        .filter(Boolean);
      const nonSystem = messages.filter((message) => message?.role !== "system");
      messages = [{
        role: "system",
        content: [systemPrompt, ...explicitSystem].join("\n\n"),
      }, ...nonSystem];
    }
    // NB : `rawSystem` est un drapeau interne — il n'est jamais recopié dans le
    // corps envoyé au serveur.
    const llamaPayload = {
      model: payload?.model || currentModel,
      // llama-server (lancé avec --mmproj) attend un contenu découpé en parties
      // `image_url`, pas le champ `images` d'Ollama : sans cette conversion, la
      // capture d'écran partait dans le vide et le modèle répondait à l'aveugle.
      messages: withOpenAiImages(messages),
      stream: false,
      // llama-server renvoie alors son bloc `timings` avec predicted_n et
      // predicted_ms, nécessaire pour afficher les tokens/s dans Lumen.
      timings_per_token: true,
      ...(payload?.tools ? { tools: payload.tools } : {}),
      ...(payload?.tools ? { tool_choice: payload?.tool_choice || "auto", parallel_tool_calls: false } : {}),
      ...(Number(options.num_predict) > 0 ? { max_tokens: Number(options.num_predict) } : {}),
    };
    // Famille Liquid AI : mêmes règles que dans `llmChat` (llm.js), au lieu du
    // cas particulier « 1.2B Thinking » qui traînait ici.
    //  - les réglages officiels s'appliquent à TOUTE la famille, sinon 350M,
    //    1.2B Instruct et 2.6B tournaient avec la température générique de
    //    llama-server (0,8) et partaient en roue libre sur les appels d'outils ;
    //  - `enable_thinking` n'existe pas dans leur template officiel (il connaît
    //    `preserve_thinking`) : le lui passer brouille la détection de format ;
    //  - le format LFM sait émettre PLUSIEURS appels dans un même bloc
    //    `<|tool_call_start|>[a(...), b(...)]<|tool_call_end|>` — le brider
    //    revenait à ignorer la moitié de ce que le modèle sait faire.
    const lfm = isLfmModel(llamaPayload.model);
    if (!lfm && typeof payload?.think === "boolean") {
      llamaPayload.chat_template_kwargs = { enable_thinking: payload.think };
    }
    Object.assign(llamaPayload, lfmSampling(llamaPayload.model) || { repeat_penalty: 1.1 });
    if (lfm && llamaPayload.tools) llamaPayload.parallel_tool_calls = true;
    const data = streaming
      ? await streamInvoke({ target: "llama", payload: llamaPayload }, hooks)
      : await invoke("llama_post_json", { path: "v1/chat/completions", payload: llamaPayload });
    const message = data?.choices?.[0]?.message || {};
    // Appels LFM restés dans le texte (format non reconnu par le serveur) :
    // convertis en tool_calls, et retirés du contenu affiché.
    if (typeof message.content === "string" && message.content.includes("<|tool_call_start|>")) {
      const { content, calls } = extractLfmToolCalls(message.content);
      message.content = content;
      if (calls.length && !message.tool_calls?.length) message.tool_calls = calls;
    }
    const timings = data?.timings || {};
    const evalCount = Number(data?.usage?.completion_tokens || timings.predicted_n || 0);
    const promptCount = Number(data?.usage?.prompt_tokens || timings.prompt_n || 0);
    const evalDuration = Number(timings.predicted_ms || 0) * 1e6;
    const promptDuration = Number(timings.prompt_ms || 0) * 1e6;
    const result = {
      ...data,
      message,
      eval_count: evalCount,
      prompt_eval_count: promptCount,
      eval_duration: evalDuration,
      prompt_eval_duration: promptDuration,
      total_duration: evalDuration + promptDuration,
    };
    // La barre n'utilise pas `llmChat` : c'est ici qu'on retient les outils
    // présentés et les réglages, pour que le Profiler les recolle à la réponse.
    notePayloadRequest(result, llamaPayload, "llama.cpp");
    scheduleUsageFallback(result, "main");
    return result;
  }
  const useBackend = ollamaUsesBackend(url);
  // `rawSystem` est interne à Lumen (cf. plus haut) : Ollama n'en a que faire.
  const { rawSystem: _rawSystem, ...cleanPayload } = (payload && typeof payload === "object") ? payload : {};
  const body = payload && typeof payload === "object"
    ? (useBackend ? { ...cleanPayload, stream: false } : cleanPayload)
    : payload;
  let result;
  if (streaming) {
    result = await streamInvoke({ target: "ollama", payload: { ...cleanPayload, stream: true }, url }, hooks);
  } else if (useBackend) {
    result = await invoke("ollama_post_json", { url, path: cleanPath, payload: body });
  } else {
    const r = await fetch(`${(url || "http://127.0.0.1:11434").replace(/\/$/, "")}/${cleanPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    result = await r.json();
  }
  notePayloadRequest(result, body, "ollama");
  scheduleUsageFallback(result, "main");
  return result;
}

async function fetchAvailableModels() {
  try {
    availableModels = await listOllamaModels(config.ollamaUrl);
    availableModelsSource = config.aiSource;
    // Le modèle courant doit appartenir au backend courant. S'il n'y est pas
    // (bascule Ollama ⇄ llama.cpp, ou modèle désinstallé), on reprend celui
    // qu'on avait laissé sur CE backend, et à défaut le premier de sa liste.
    if (availableModels.length && !availableModels.includes(currentModel)) {
      currentModel = pickModelForSource(config.aiSource, availableModels);
      config.selectedModel = currentModel;
      rememberModelFor(config.aiSource, currentModel);
      updateModelLabel();
    }
    populateModelDropdown();
  } catch (err) {
    console.error("Impossible de récupérer la liste des modèles Ollama :", err);
  }
}

function populateModelDropdown() {
  if (!selectModel) return;
  if (!availableModels.length) {
    selectModel.innerHTML = `<option value="${currentModel}">${currentModel}</option>`;
    selectModel.value = currentModel;
    return;
  }
  selectModel.innerHTML = availableModels
    .map(name => `<option value="${name}">${name}</option>`)
    .join('');
  selectModel.value = availableModels.includes(currentModel) ? currentModel : availableModels[0];
}

function updateModelLabel() {
  // En source API, la pastille reflète le modèle cloud (ex. GPT-4O-MINI).
  btn350mLabel.textContent = getModelLabel(isApiLike(config.aiSource) ? cloudModel() : currentModel);
  // Le compagnon affiche la même pastille : un changement fait au bureau doit
  // s'y refléter sans avoir à rouvrir la page. Regroupé, car cette fonction est
  // appelée en rafale pendant une bascule de backend.
  clearTimeout(remoteBackendTimer);
  remoteBackendTimer = setTimeout(() => { remotePushBackends(); }, 300);
}
let remoteBackendTimer = null;

function getModelLabel(fullName) {
  if (!fullName) return "";
  const parts = fullName.split(/[\/:]/);
  const name = parts[parts.length - 1];
  if (name.length > 12) {
    return name.substring(0, 10) + "...";
  }
  return name.toUpperCase();
}

// État courant de la connexion IA, exploité par la réparation en 1 clic.
let llmStatusReason = null; // 'ok' | 'model_missing' | 'ollama_offline' | 'api_missing'

async function checkOllamaStatus() {
  if (config.aiSource === 'shortcut') {
    statusIndicator.className = 'status-dot online';
    statusIndicator.title = t("dyn_status_shortcut", { name: config.shortcutName });
    llmStatusReason = 'ok';
    return;
  }
  if (config.aiSource === 'applefm') {
    // Apple Foundation Models : vert si la passerelle et Apple Intelligence
    // répondent (sondé par `applefm_status`, pas de ping par message).
    const ok = config.applefmAvailable;
    statusIndicator.className = 'status-dot ' + (ok ? 'online' : 'offline');
    statusIndicator.title = ok ? `Apple Foundation Models : ${cloudModel()}` : appleFmReasonText(config.applefmReason);
    llmStatusReason = ok ? 'ok' : 'applefm';
    return;
  }
  if (config.aiSource === 'lumen') {
    // Lumen Server : vert si le poste est lié et un modèle choisi.
    const ok = config.lumenLinked && !!config.lumenModel;
    statusIndicator.className = 'status-dot ' + (ok ? 'online' : 'offline');
    statusIndicator.title = ok ? `Lumen Server : ${config.lumenModel}` : (config.lumenLinked ? "Choisissez un modèle du serveur" : "Poste non lié à un Lumen Server");
    llmStatusReason = ok ? 'ok' : 'lumen';
    return;
  }
  if (isApiLike(config.aiSource)) {
    // Source cloud : pas de ping (la clé est validée à l'appel). Vert si une clé
    // est renseignée, sinon orange pour signaler qu'il en manque une.
    const ok = config.apiConfigured;
    statusIndicator.className = 'status-dot ' + (ok ? 'online' : 'offline');
    statusIndicator.title = ok ? `API : ${cloudModel()}` : "Clé API manquante (Réglages)";
    llmStatusReason = ok ? 'ok' : 'api_missing';
    return;
  }
  if (config.aiSource === 'llama') {
    try {
      const models = await invoke("llama_list_models");
      const installed = (Array.isArray(models) ? models : []).some((m) => m.filename === currentModel);
      const status = await invoke("llama_status");
      // Fenêtre du serveur EN COURS : elle peut différer du réglage si celui-ci
      // a été changé depuis le démarrage. C'est elle qui contraint réellement.
      const ctx = Number(status?.ctx_size) || 0;
      if (ctx !== llamaRunningCtx) {
        llamaRunningCtx = status?.running ? ctx : 0;
        updateContextMeter();
      }
      if (installed && status?.running && status.model === currentModel) {
        statusIndicator.className = 'status-dot online';
        statusIndicator.title = `llama-server : ${llamaModelLabel(currentModel)}`;
        llmStatusReason = 'ok';
      } else if (installed) {
        // Serveur à l'arrêt = état normal tant qu'aucune requête n'a été envoyée
        // (llama-server ne démarre qu'à la première prompt). Gris, pas rouge :
        // le rouge laissait croire à une panne au lancement de l'app.
        statusIndicator.className = 'status-dot idle';
        statusIndicator.title = `llama-server en veille : ${llamaModelLabel(currentModel)} (démarre à la première requête)`;
        llmStatusReason = 'llama_stopped';
      } else {
        statusIndicator.className = 'status-dot offline';
        statusIndicator.title = 'Modèle GGUF non téléchargé';
        llmStatusReason = 'model_missing';
      }
    } catch {
      statusIndicator.className = 'status-dot offline';
      statusIndicator.title = 'llama-server indisponible';
      llmStatusReason = 'ollama_offline';
    }
    return;
  }

  try {
    statusIndicator.className = 'status-dot loading';

    const data = await ollamaGetJson("api/tags");
    if (data) {
      const models = data.models || [];
      const modelNames = models.map(m => m.name);

      const hasModel = modelNames.some(name => name.includes(currentModel) || currentModel.includes(name));

      if (hasModel) {
        statusIndicator.className = 'status-dot online';
        statusIndicator.title = t("dyn_status_connected", { model: currentModel });
        llmStatusReason = 'ok';
      } else {
        statusIndicator.className = 'status-dot offline';
        statusIndicator.title = t("dyn_status_model_missing", { model: currentModel });
        llmStatusReason = 'model_missing';
      }
    }
  } catch (err) {
    statusIndicator.className = 'status-dot offline';
    statusIndicator.title = t("dyn_status_offline");
    llmStatusReason = 'ollama_offline';
  }
}

// ===== Réparation en 1 clic : la pastille de statut est cliquable =====
// Au lieu de laisser l'utilisateur deviner pourquoi la pastille est rouge, un clic
// propose l'action correspondante : télécharger le modèle manquant (sans terminal),
// installer/lancer Ollama, ou ouvrir les réglages pour la clé API.
let repairing = false;
async function handleStatusRepair() {
  if (repairing) return;
  if (llmStatusReason === 'ok' || !llmStatusReason) {
    showHint(statusIndicator.title || t("repair_done"));
    return;
  }
  if (llmStatusReason === 'llama_stopped' || llmStatusReason === 'llama_start_failed') {
    // Pastille grise : rien à réparer, mais un clic permet de démarrer le
    // serveur sans attendre la première requête.
    repairing = true;
    statusIndicator.className = 'status-dot loading';
    await startLlamaModel(currentModel);
    repairing = false;
    checkOllamaStatus();
    return;
  }
  if (llmStatusReason === 'api_missing' || llmStatusReason === 'lumen' || llmStatusReason === 'applefm') {
    showHint(llmStatusReason === 'api_missing' ? t("repair_api_missing") : statusIndicator.title);
    invoke("open_settings").catch(() => {});
    return;
  }
  if (llmStatusReason === 'ollama_offline') {
    showHint(t("repair_offline_ollama"));
    invoke("open_external", { url: "https://ollama.com/download" }).catch(() => {});
    return;
  }
  if (llmStatusReason === 'model_missing') {
    repairing = true;
    statusIndicator.className = 'status-dot loading';
    showHint(t("repair_pulling", { pct: 0 }));
    try {
      await invoke("ollama_pull", { url: config.ollamaUrl || null, model: currentModel });
    } catch (e) {
      showHint(t("ob_model_dl_fail", { err: e?.message || e }));
      repairing = false;
      checkOllamaStatus();
    }
  }
}

function wireStatusRepair() {
  if (!statusIndicator || statusIndicator.dataset.repairBound === 'true') return;
  statusIndicator.dataset.repairBound = 'true';
  statusIndicator.style.cursor = 'pointer';
  statusIndicator.addEventListener('click', handleStatusRepair);
  // Suivi de la progression / fin du téléchargement déclenché depuis la pastille.
  const evtApi = window.__TAURI__?.event;
  evtApi?.listen?.("ollama-pull-progress", (evt) => {
    if (!repairing) return;
    showHint(t("repair_pulling", { pct: evt?.payload?.percent ?? 0 }));
  });
  evtApi?.listen?.("ollama-pull-done", (evt) => {
    if (!repairing) return;
    repairing = false;
    showHint(evt?.payload?.ok ? t("repair_done") : t("ob_model_dl_fail", { err: evt?.payload?.error || "" }));
    checkOllamaStatus();
  });
}

// ===== Suivi des runs du Action Router (progression temps réel) =====
//
// Lumen dispatche au Action Router une enveloppe JSON avec un `run_id` ; le
// routeur POSTe sa progression sur le serveur 8765, relayée ici via l'évènement
// `run-progress`. On affiche chaque étape en direct dans la bulle de la tâche et
// on la persiste dans l'historique de la conversation.
const activeRuns = {};
// Origine du serveur local (côté bureau, la WebView Tauri n'est pas servie par 8765).
const RUN_SERVER_ORIGIN = "http://127.0.0.1:8765";

function genRunId() {
  return (crypto?.randomUUID?.()) || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ===== Mode debug : afficher le prompt exact envoyé au modèle =====
// Insère un bloc repliable au-dessus de la réponse, montrant le texte/JSON
// réellement transmis (raccourci, Ollama, ou Ollama + outils Fluxo).
function showDebugPrompt(bubble, label, content) {
  if (!config.debugMode || !bubble || !bubble.parentNode) return;
  // Bloc toujours déplié, en flux normal (aucun <details>, aucun overflow) :
  // le contenu s'affiche en entier, on lit en scrollant la conversation.
  const el = document.createElement('div');
  el.className = 'debug-prompt';
  const head = document.createElement('div');
  head.className = 'debug-head';
  head.innerHTML = `<span class="debug-ic">${ic('terminal')}</span>`
    + `<span class="debug-label">${escapeHTML(t('debug_label') || 'Prompt envoyé')} · ${escapeHTML(label)}</span>`
    + `<button type="button" class="debug-copy" title="Copier">${ic('doc')}</button>`;
  const pre = document.createElement('pre');
  pre.textContent = content;
  head.querySelector('.debug-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(content).catch(() => {});
  });
  el.appendChild(head);
  el.appendChild(pre);
  bubble.parentNode.insertBefore(el, bubble);
  scrollToBottom();
}

// ===== Widgets (complications) — rendus à la volée depuis un POST /run/widget =====
// Le modèle/raccourci choisit un `template` et fournit des champs structurés ;
// Lumen dessine la carte. Gabarits : weather, metric, stat-grid, list, gauge,
// report. Tout est échappé (contenu non fiable venant d'un raccourci).
const WIDGET_ICONS = {
  weather: 'sparkles', metric: 'chip', 'stat-grid': 'chip', list: 'doc',
  gauge: 'retry', report: 'bolt', news: 'doc', stocks: 'bolt',
  sport: 'bolt', score: 'bolt', match: 'bolt',
};
function widgetTrend(trend) {
  const t = String(trend || '').toLowerCase();
  if (t === 'up' || t === 'hausse') return '<span class="wdg-trend up">▲</span>';
  if (t === 'down' || t === 'baisse') return '<span class="wdg-trend down">▼</span>';
  if (t === 'flat' || t === 'stable') return '<span class="wdg-trend flat">▬</span>';
  return '';
}
function widgetHeader(w, fallbackIcon) {
  const iconName = w.icon && ICONS[w.icon] ? w.icon : fallbackIcon;
  const title = w.title ? escapeHTML(String(w.title)) : '';
  if (!title && !iconName) return '';
  return `<div class="wdg-head">${iconName ? `<span class="wdg-ic">${ic(iconName)}</span>` : ''}`
    + `<span class="wdg-title">${title}</span></div>`;
}
function renderWidget(w) {
  if (!w || typeof w !== 'object') return '';
  const tpl = String(w.template || 'metric').toLowerCase();
  const accent = /^#[0-9a-f]{3,8}$/i.test(w.accent || '') ? w.accent : '#5b8def';
  const head = widgetHeader(w, WIDGET_ICONS[tpl] || 'chip');
  let body = '';

  if (tpl === 'weather') {
    const hourly = Array.isArray(w.hourly) ? w.hourly.slice(0, 6).map(h =>
      `<div class="wdg-hour"><span>${escapeHTML(String(h.time ?? ''))}</span>`
      + `<strong>${escapeHTML(String(h.temp ?? ''))}°</strong></div>`).join('') : '';
    body = `<div class="wdg-weather">
      <div class="wdg-temp">${escapeHTML(String(w.temp ?? '—'))}<span class="wdg-unit">°${escapeHTML(String(w.unit || ''))}</span></div>
      <div class="wdg-wcol">
        <div class="wdg-cond">${escapeHTML(String(w.condition || ''))}</div>
        <div class="wdg-loc">${escapeHTML(String(w.location || ''))}</div>
        <div class="wdg-hilo">${w.hi != null ? '↑ ' + escapeHTML(String(w.hi)) + '°' : ''} ${w.lo != null ? '↓ ' + escapeHTML(String(w.lo)) + '°' : ''}</div>
      </div></div>${hourly ? `<div class="wdg-hourly">${hourly}</div>` : ''}`;
  } else if (tpl === 'stat-grid') {
    const items = (Array.isArray(w.items) ? w.items : []).map(it =>
      `<div class="wdg-cell">
        <div class="wdg-cell-label">${escapeHTML(String(it.label ?? ''))}</div>
        <div class="wdg-cell-value">${escapeHTML(String(it.value ?? ''))}</div></div>`).join('');
    body = `<div class="wdg-grid">${items}</div>`;
  } else if (tpl === 'list' || tpl === 'news') {
    const items = (Array.isArray(w.items) ? w.items : []).map(it =>
      `<div class="wdg-listrow">
        <div class="wdg-listmain">
          <div class="wdg-listtitle">${escapeHTML(String(it.title ?? it.label ?? ''))}</div>
          ${it.subtitle ? `<div class="wdg-listsub">${escapeHTML(String(it.subtitle))}</div>` : ''}
        </div>
        ${it.trailing != null ? `<div class="wdg-listtrail">${escapeHTML(String(it.trailing))}</div>` : ''}
      </div>`).join('');
    body = `<div class="wdg-list">${items}</div>`;
  } else if (tpl === 'gauge') {
    const val = Math.max(0, Math.min(100, Number(w.value) || 0));
    const r = 26, c = 2 * Math.PI * r, off = c * (1 - val / 100);
    body = `<div class="wdg-gauge">
      <svg viewBox="0 0 64 64" class="wdg-ring">
        <circle cx="32" cy="32" r="${r}" class="wdg-ring-bg"/>
        <circle cx="32" cy="32" r="${r}" class="wdg-ring-fg" style="stroke:${accent};stroke-dasharray:${c.toFixed(1)};stroke-dashoffset:${off.toFixed(1)}"/>
        <text x="32" y="36" class="wdg-ring-txt">${val}%</text>
      </svg>
      <div class="wdg-gcol"><div class="wdg-glabel">${escapeHTML(String(w.label || ''))}</div>
      ${w.caption ? `<div class="wdg-caption">${escapeHTML(String(w.caption))}</div>` : ''}</div></div>`;
  } else if (tpl === 'report') {
    const st = String(w.status || '').toLowerCase();
    const dot = st === 'error' ? 'err' : st === 'running' ? 'run' : 'ok';
    const lines = (Array.isArray(w.lines) ? w.lines : []).map(l =>
      `<div class="wdg-reprow"><span>${escapeHTML(String(l.label ?? ''))}</span>`
      + `<strong class="wdg-rep-${(String(l.state||'')).replace(/[^a-z]/gi,'') || 'na'}">${escapeHTML(String(l.value ?? ''))}</strong></div>`).join('');
    body = `<div class="wdg-report"><span class="wdg-status wdg-status-${dot}"></span>${lines}</div>`
      + (w.caption ? `<div class="wdg-caption">${escapeHTML(String(w.caption))}</div>` : '');
  } else if (tpl === 'sport' || tpl === 'score' || tpl === 'match') {
    // Résultat sportif : deux équipes, scores, statut (live/terminé/à venir).
    const st = String(w.status || '').toLowerCase();
    const live = /(live|en cours|\d+\s*['’]|mi-temps|halftime|ht)/i.test(w.status || '');
    const stateCls = st.includes('term') || st.includes('final') || st.includes('ft') ? 'final'
      : live ? 'live' : 'sched';
    const hs = w.home_score, as = w.away_score;
    const hasScore = hs != null && as != null;
    const hWin = hasScore && Number(hs) > Number(as);
    const aWin = hasScore && Number(as) > Number(hs);
    const team = (name, logo, score, win) =>
      `<div class="wdg-team${win ? ' win' : ''}">
        <div class="wdg-teamname">${logo ? `<span class="wdg-teamlogo">${escapeHTML(String(logo))}</span>` : ''}${escapeHTML(String(name ?? ''))}</div>
        <div class="wdg-teamscore">${hasScore ? escapeHTML(String(score)) : '–'}</div>
      </div>`;
    const statusLine = w.status
      ? `<div class="wdg-sport-status wdg-sport-${stateCls}">${live ? '<span class="wdg-livedot"></span>' : ''}${escapeHTML(String(w.status))}</div>`
      : '';
    body = `<div class="wdg-sport">
      ${w.competition || w.league ? `<div class="wdg-sport-league">${escapeHTML(String(w.competition || w.league))}</div>` : ''}
      ${team(w.home, w.home_logo, hs, hWin)}
      ${team(w.away, w.away_logo, as, aWin)}
      ${statusLine}
    </div>` + (w.caption ? `<div class="wdg-caption">${escapeHTML(String(w.caption))}</div>` : '');
  } else { // metric (défaut)
    body = `<div class="wdg-metric">
      <div class="wdg-mvalue">${escapeHTML(String(w.value ?? '—'))}<span class="wdg-unit">${escapeHTML(String(w.unit || ''))}</span></div>
      <div class="wdg-mside">${widgetTrend(w.trend)}${w.delta != null ? `<span class="wdg-delta">${escapeHTML(String(w.delta))}</span>` : ''}</div>
    </div>${w.label ? `<div class="wdg-mlabel">${escapeHTML(String(w.label))}</div>` : ''}`
      + (w.caption ? `<div class="wdg-caption">${escapeHTML(String(w.caption))}</div>` : '');
  }

  return `<div class="lumen-widget" style="--wdg-accent:${accent}">${head}<div class="wdg-body">${body}</div></div>`;
}

// Rendu d'une étape de run : puce + texte, image (Image Playground), ou widget.
function renderProgressEntries(container, entries) {
  container.innerHTML = (entries || []).map(ev => {
    const kind = (ev.kind || 'progress').toString();
    const cls = kind.replace(/[^a-z0-9_-]/gi, '');
    // Étape image : <img> servie par le serveur local. On conserve le chemin
    // relatif (`data-path`) pour que le miroir mobile reconstruise l'URL.
    if (kind === 'image' && ev.data && ev.data.path) {
      const path = String(ev.data.path);
      const full = path.startsWith('http') ? path : (RUN_SERVER_ORIGIN + path);
      return `<div class="run-step run-step-image" data-kind="image" data-path="${escapeHTML(path)}">`
        + `<img class="run-image" src="${escapeHTML(full)}" alt="" loading="lazy">`
        + `</div>`;
    }
    // Étape widget : complication structurée choisie par le modèle/raccourci.
    if (kind === 'widget' && ev.data) {
      return `<div class="run-step run-step-widget" data-kind="widget">${renderWidget(ev.data)}</div>`;
    }
    return `<div class="run-step run-step-${escapeHTML(cls)}" data-kind="${escapeHTML(cls)}">`
      + `<span class="run-step-dot"></span>`
      + `<span class="run-step-msg">${formatMessage(ev.message || '')}</span>`
      + `</div>`;
  }).join('');
}

// Reçu pour chaque callback du routeur. Route l'évènement vers la bulle du run.
function onRunProgress(ev) {
  if (!ev || !ev.run_id) return;
  const run = activeRuns[ev.run_id];
  if (!run) return; // run inconnu (ex. fenêtre rouverte sans rejeu) : ignoré
  run.entries.push(ev);
  renderProgressEntries(run.progressEl, run.entries);
  scrollToBottom();
}

// ---------- Pièces jointes image (Ollama multimodal) ----------
// Lit un fichier image en data URL, l'ajoute aux pièces en attente et rafraîchit
// l'aperçu. Le champ `images` d'Ollama veut le base64 NU (sans préfixe data:).
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

// ===== « Comprendre cet écran » (menu de la barre d'état, raccourci global) =====
//
// Capture l'écran RÉEL — donc l'app que l'utilisateur regardait juste avant, pas
// Lumen — et la fait décrire par le moteur actif. Le point d'entrée est côté
// système (tray/hotkey) parce que c'est précisément quand Lumen n'est pas au
// premier plan qu'on en a besoin.
function visionReadyForScreen() {
  if (isGenerating) return false;
  if (!VISION_SOURCES.includes(config.aiSource)) {
    showDictationHint(t('understand_screen_no_vision'));
    return false;
  }
  // Modèle local dont on SAIT qu'il n'a pas de projecteur vision : le dire tout
  // de suite plutôt que laisser le modèle inventer une description.
  if (config.aiSource === 'llama') {
    const entry = llamaCatalogEntry(currentModel || config.selectedModel || '');
    if (entry && !(entry.tags || []).includes('vision')) {
      showDictationHint(t('understand_screen_no_vision_model'));
      return false;
    }
  }
  return true;
}

/// Envoie une capture déjà prise au moteur actif, en se montrant seulement une
/// fois l'image en main.
async function sendScreenShot(shot, prompt) {
  if (!shot?.image) { showDictationHint(t('understand_screen_failed')); return; }
  // La capture est faite, on peut se montrer : dans l'autre ordre, la barre
  // Lumen figurerait sur l'image, par-dessus ce qu'on voulait faire lire.
  try {
    const w = window.__TAURI__?.window?.getCurrentWindow?.();
    await w?.show?.();
    await w?.setFocus?.();
  } catch {}
  pendingImages = [{ dataUrl: `data:${shot.mime || 'image/jpeg'};base64,${shot.image}`, b64: shot.image }];
  renderAttachPreview();
  await handleSend(prompt, { withImages: true });
}

/// Variante « une zone plutôt que tout l'écran ». La capture et le tracé sont
/// pilotés par le Rust (surface plein écran) ; la réponse revient par
/// l'événement `screen-selection`, adressé à cette seule fenêtre.
/// Question validée pour le prochain tracé de zone (consommée par l'événement
/// `screen-selection`).
let pendingRegionPrompt = null;
// Vrai entre `screen_select_open` lancé d'ICI et le retour de la zone. Le Rust
// adresse `screen-selection` à la fenêtre demandeuse, mais `listen()` (cible
// « Any ») reçoit aussi les événements destinés aux autres fenêtres : sans ce
// verrou, une zone tracée depuis le bureau Lumen OS partait DEUX fois au modèle
// (une bulle ici, une feuille là-bas).
let regionRequestedHere = false;

/// Ouvre le composeur de question depuis un geste déclenché HORS de Lumen
/// (icône de la barre de menus, raccourci global) : la fenêtre est alors
/// masquée, il faut la montrer le temps de la saisie… puis la re-masquer, sinon
/// elle se retrouve sur la capture, par-dessus ce qu'on voulait faire lire.
async function askWithBarVisible(options) {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  try { await win?.show?.(); await win?.setFocus?.(); } catch {}
  const prompt = await askScreenPrompt(options);
  try { await win?.hide?.(); } catch {}
  return prompt;
}

async function understandScreenRegionFromBar() {
  if (!visionReadyForScreen()) return;
  // La question se choisit AVANT le tracé : une fois la surface de sélection
  // ouverte, plus rien d'autre n'est cliquable.
  const prompt = await askWithBarVisible({
    defaultPrompt: t('understand_region_prompt'),
    title: t('understand_region_title'),
  });
  if (prompt == null) return;
  pendingRegionPrompt = prompt;
  regionRequestedHere = true;
  await waitForRepaint();
  try {
    await invoke("screen_select_open");
  } catch (error) {
    pendingRegionPrompt = null;
    regionRequestedHere = false;
    showDictationHint(t('understand_screen_failed') + (error?.message || error));
  }
}

async function understandScreenFromBar() {
  if (!visionReadyForScreen()) return;
  // Question pré-remplie et modifiable : le geste servait une seule formulation,
  // écrite en dur, alors que la moitié des usages sont des questions précises
  // (« traduis ce message », « qu'est-ce que cette erreur ? »).
  const prompt = await askWithBarVisible({
    defaultPrompt: t('understand_screen_prompt'),
    title: t('understand_screen_title'),
  });
  if (prompt == null) return;
  // La feuille de saisie fait partie de l'écran : on la laisse disparaître avant
  // de capturer, sinon elle figure sur l'image.
  await waitForRepaint();
  let shot;
  try {
    shot = await invoke("capture_screen", { maxWidth: 1280 });
  } catch (error) {
    showDictationHint(t('understand_screen_failed') + (error?.message || error));
    return;
  }
  await sendScreenShot(shot, prompt);
}

// ===== Documents joints à la discussion (PDF / DOCX / texte) ===============
//
// Deux régimes, choisis sur la taille du texte extrait :
//   • court  → le document part ENTIER dans le contexte, une seule fois. Pour
//     « résume ce PDF », le RAG serait contre-productif : il ne rendrait que
//     quelques passages, et le modèle résumerait un extrait.
//   • long   → indexation dans la base RAG sous la source `chat:<id>`, puis
//     recherche restreinte à ces documents à chaque message.
//
// Les documents restent attachés tant que la discussion vit : les questions de
// suivi (« et le tableau page 3 ? ») doivent porter sur le même document.

const DOC_FULL_CONTEXT_CHARS = 10000; // ≈ 2 500 tokens
const DOC_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.csv', '.json', '.log', '.rtf'];

let chatDocs = []; // { name, mode: 'full' | 'rag', text?, docId?, chars, injected }

function isDocFile(file) {
  const name = (file?.name || '').toLowerCase();
  return DOC_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/// Identifiant de source des documents éphémères, pour pouvoir les retirer de
/// l'index sans toucher au Corpus permanent de l'utilisateur.
function chatDocSource() {
  return `chat:${currentConversationId || 'session'}`;
}

async function addDocFile(file) {
  const name = file?.name || 'document';
  if (chatDocs.some((d) => d.name === name)) return;
  const b64 = await fileToBase64(file);
  await addDocBytes(name, b64);
}

/// Même traitement, mais à partir d'un contenu déjà encodé : c'est le chemin
/// emprunté par le compagnon mobile, qui envoie le fichier en Base64 sur la
/// WebSocket plutôt qu'un objet `File` (il n'existe pas de ce côté).
async function addDocBytes(name, b64) {
  if (chatDocs.some((d) => d.name === name)) return;
  showDictationHint(t('doc_reading', { name }));
  let extracted;
  try {
    extracted = await invoke('doc_extract_text', { title: name, b64 });
  } catch (e) {
    showDictationHint(String(e?.message || e));
    return;
  }
  const chars = extracted?.chars || 0;
  if (chars <= DOC_FULL_CONTEXT_CHARS) {
    chatDocs.push({ name, mode: 'full', text: extracted.text, chars, injected: false });
    showDictationHint(t('doc_added_full', { name }));
  } else {
    // Trop long pour le contexte : on indexe. L'encodage peut prendre quelques
    // secondes, d'où le message d'attente avant l'appel.
    showDictationHint(t('doc_indexing', { name }));
    try {
      const res = await invoke('rag_add_file_bytes', { title: name, b64, source: chatDocSource() });
      // On garde le texte extrait même en mode RAG : c'est le filet de secours
      // si la recherche ne rend rien (index vectoriel indisponible, embedder
      // qui ne démarre pas — cas vu sous Windows). Sans lui, le document
      // s'affichait en pastille mais n'atteignait jamais le modèle.
      chatDocs.push({ name, mode: 'rag', docId: res?.doc_id, chars, injected: false, text: extracted.text || '' });
      showDictationHint(t('doc_added_rag', { name, chunks: res?.chunks || 0 }));
    } catch (e) {
      showDictationHint(String(e?.message || e));
      return;
    }
  }
  renderAttachPreview();
}

/// Aiguille une pièce jointe : image (modèles multimodaux) ou document.
///
/// Un même bouton pour les deux : l'utilisateur ne devrait pas avoir à savoir
/// si son fichier passe par la vision ou par l'extraction de texte.
async function addAttachment(file) {
  if (!file) return;
  if (file.type?.startsWith('image/')) {
    if (!VISION_SOURCES.includes(config.aiSource)) {
      showDictationHint(t('doc_no_vision'));
      return;
    }
    await addImageFile(file);
    return;
  }
  if (isDocFile(file)) {
    await addDocFile(file);
    return;
  }
  showDictationHint(t('doc_unsupported', { name: file.name || '' }));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      resolve(url.includes(',') ? url.slice(url.indexOf(',') + 1) : url);
    };
    reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
    reader.readAsDataURL(file);
  });
}

async function removeChatDoc(index) {
  const doc = chatDocs[index];
  if (!doc) return;
  chatDocs.splice(index, 1);
  // `keep` : document déjà présent dans le Corpus, seulement RÉFÉRENCÉ par « # ».
  // Le retirer de la discussion ne doit pas l'effacer de la base.
  if (doc.mode === 'rag' && doc.docId && !doc.keep) {
    try { await invoke('rag_delete', { docId: doc.docId }); } catch { /* déjà parti */ }
  }
  renderAttachPreview();
}

/// Retire de l'index les documents éphémères de la discussion. Appelé quand on
/// repart de zéro : sans cela, la base se remplirait de pièces jointes mortes.
async function clearChatDocs() {
  const docs = chatDocs.slice();
  chatDocs = [];
  renderAttachPreview();
  for (const doc of docs) {
    if (doc.mode === 'rag' && doc.docId && !doc.keep) {
      try { await invoke('rag_delete', { docId: doc.docId }); } catch { /* ignoré */ }
    }
  }
}

/// Extraits qui ont servi à la réponse en cours de préparation, dans l'ordre de
/// pertinence. Alimenté par la recherche documentaire (pièces jointes) et par
/// l'outil `search_documents` ; consommé par le panneau « Sources » du message.
let pendingRagSources = [];
/// Bulle de réponse en cours : l'outil `search_documents` s'exécute au milieu
/// de la génération et doit pouvoir y accrocher ses sources.
let activeAssistantBubble = null;

/// Normalise un résultat de `rag_search` en source affichable.
function toRagSource(h) {
  return {
    title: String(h?.title || 'Document'),
    text: String(h?.text || '').trim(),
    docId: h?.doc_id || '',
    ordinal: Number.isFinite(h?.ordinal) ? h.ordinal : null,
    score: typeof h?.score === 'number' ? h.score : null,
    lexical: !!h?.lexical,
  };
}

/// Provenance d'un extrait : son rang dans le document, ou la voie par laquelle
/// il a été trouvé.
function sourceOrigin(src) {
  if (src.lexical) return t('rag_source_keyword') || 'mot-clé';
  if (src.ordinal == null) return '';
  return t('rag_source_extract', { n: src.ordinal + 1 }) || `extrait ${src.ordinal + 1}`;
}

/// Panneau « Sources » sous une réponse : une carte par extrait, avec son score
/// de pertinence. Cliquer une carte déplie l'extrait complet — c'est ce qui
/// permet de contrôler ce que le modèle a réellement lu.
function renderRagSources(bubble, sources) {
  if (!bubble || !Array.isArray(sources) || !sources.length) return;
  // Enfant direct de la bulle, comme le panneau de progression : plusieurs
  // chemins de génération réécrivent `.msg-text-content` en entier à la fin du
  // streaming, ce qui emporterait le panneau.
  const host = bubble;
  // Une génération peut passer deux fois par ici (contexte documentaire puis
  // outil) : on remplace le panneau plutôt que d'en empiler un second.
  host.querySelector('.msg-sources')?.remove();
  const panel = document.createElement('div');
  panel.className = 'msg-sources';
  const head = document.createElement('div');
  head.className = 'msg-sources-head';
  // Quand tous les extraits viennent du même document — le cas courant — son nom
  // passe en tête. Le répéter tronqué sur chaque pastille n'apprenait rien et
  // les rendait si larges qu'elles s'empilaient une par ligne.
  const titles = [...new Set(sources.map((s) => s.title))];
  const single = titles.length === 1 ? titles[0] : '';
  head.textContent = single
    ? `${t('rag_sources_title') || 'Sources'} · ${single}`
    : (t('rag_sources_title') || 'Sources');
  head.title = single;
  panel.appendChild(head);

  const row = document.createElement('div');
  row.className = 'msg-sources-row';
  // Le détail vit dans UN seul panneau réutilisé, ancré sous la pastille
  // cliquée : empiler un bloc dépliable par source reprenait toute la hauteur
  // de la conversation.
  const pop = document.createElement('div');
  pop.className = 'source-pop';
  pop.hidden = true;

  const closePop = () => {
    pop.hidden = true;
    row.querySelectorAll('.source-chip.active').forEach((c) => c.classList.remove('active'));
  };

  sources.forEach((src, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'source-chip';
    const pct = src.score == null ? '' : `${Math.round(src.score * 100)} %`;
    chip.innerHTML =
      // Le numéro est celui que le modèle cite dans sa réponse (« Source 3 ») :
      // sans lui, la citation ne renvoie à rien de visible.
      `<span class="source-chip-num">${i + 1}</span>` +
      `<span class="source-chip-title"></span>` +
      (pct ? `<span class="source-chip-score">${escapeHTML(pct)}</span>` : '');
    // Document unique : la pastille porte l'emplacement du passage, pas le nom
    // du fichier déjà affiché au-dessus.
    chip.querySelector('.source-chip-title').textContent = single ? sourceOrigin(src) : src.title;
    chip.title = t('rag_source_expand') || "Cliquer pour afficher l'extrait";
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (chip.classList.contains('active')) { closePop(); return; }
      closePop();
      chip.classList.add('active');
      pop.innerHTML =
        `<div class="source-pop-head">` +
          `<span class="source-pop-title"></span>` +
          (pct ? `<span class="source-chip-score">${escapeHTML(pct)}</span>` : '') +
          `<button class="source-pop-close" aria-label="${escapeHTML(t('doc_remove') || 'Fermer')}">×</button>` +
        `</div>` +
        `<div class="source-pop-sub"></div>` +
        `<div class="source-pop-text"></div>`;
      pop.querySelector('.source-pop-title').textContent = `${i + 1}. ${src.title}`;
      // Provenance : l'endroit de l'extrait dans le document, ou la voie par
      // laquelle il a été trouvé.
      pop.querySelector('.source-pop-sub').textContent = sourceOrigin(src);
      pop.querySelector('.source-pop-text').textContent = src.text;
      pop.querySelector('.source-pop-close').addEventListener('click', (ev) => {
        ev.stopPropagation();
        closePop();
      });
      // Ancrage sous la pastille, borné à la largeur du panneau pour ne pas
      // déborder de la bulle.
      pop.hidden = false;
      const max = Math.max(0, panel.clientWidth - pop.offsetWidth);
      pop.style.left = `${Math.min(Math.max(0, chip.offsetLeft), max)}px`;
      pop.style.top = `${chip.offsetTop + chip.offsetHeight + 6}px`;
    });
    row.appendChild(chip);
  });

  panel.appendChild(row);
  panel.appendChild(pop);
  // Un clic ailleurs (ou Échap) referme : un popover qui reste ouvert pendant
  // qu'on lit la suite de la conversation gêne plus qu'il n'aide.
  panel.addEventListener('click', (e) => { if (!pop.contains(e.target)) closePop(); });
  document.addEventListener('click', (e) => { if (!panel.contains(e.target)) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  host.appendChild(panel);
}

/// Bloc de contexte documentaire à préfixer au message de l'utilisateur.
/// Les documents courts ne sont injectés qu'une fois (ils restent ensuite dans
/// l'historique) ; les extraits RAG dépendent de la question, donc à chaque tour.
async function buildDocContext(query) {
  const ragMode = config.ollamaMode === 'rag';
  const result = await collectDocumentContext({
    query, documents: chatDocs, project: contextProject(), ragMode,
    search: args => invoke('rag_search', args), fullChars: DOC_FULL_CONTEXT_CHARS,
    labels: { extracts: t(ragMode ? 'rag_ctx_extracts' : 'doc_ctx_extracts'), cite: t('doc_ctx_cite'), truncated: t('doc_ctx_truncated') },
  });
  pendingRagSources = result.hits.map(toRagSource);
  if (result.status === 'fallback') showHint(t('doc_rag_fallback'));
  else if (result.status === 'failed') showHint(t('doc_rag_failed', { error: result.failure }));
  else if (result.status === 'empty' && ragMode) showHint(t(await ragBaseIsEmpty() ? 'rag_mode_empty' : 'rag_mode_no_hit'));
  else if (result.status === 'project-empty') showHint(getLang() === 'en' ? 'No project excerpt matches this question.' : 'Aucun extrait du projet ne correspond à cette question.');
  if (!result.parts.length) return '';
  return `${t(ragMode ? 'rag_ctx_header' : 'doc_ctx_header')}\n\n${result.parts.join('\n\n')}\n\n${t('doc_ctx_footer')}\n\n`;
}

/// Vrai si la base de connaissances ne contient aucun extrait. Sert à
/// distinguer « rien d'indexé » de « rien trouvé » : le remède n'est pas le même.
async function ragBaseIsEmpty() {
  try {
    const st = await invoke('rag_status');
    return !(st?.chunks > 0);
  } catch { return false; }
}

function clearPendingImages() {
  pendingImages = [];
  renderAttachPreview();
}

// Affiche les vignettes des images jointes (avec bouton de retrait).
function renderAttachPreview() {
  // Les pièces jointes existent aussi côté téléphone : il les affiche dans son
  // propre composeur, d'où la diffusion à chaque changement.
  remotePushDocs();
  if (!attachPreview) return;
  attachPreview.innerHTML = "";
  attachPreview.hidden = pendingImages.length === 0 && chatDocs.length === 0;
  chatDocs.forEach((doc, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-doc";
    // Le régime (contexte complet / indexé) est affiché : c'est ce qui explique
    // pourquoi un gros document répond par extraits.
    chip.title = t(doc.mode === 'full' ? 'doc_chip_full' : 'doc_chip_rag', { name: doc.name });
    chip.innerHTML = `<span class="attach-doc-ic">${ic('file')}</span>` +
      `<span class="attach-doc-name"></span>` +
      `<button class="attach-remove" title="${escapeHTML(t('doc_remove'))}">×</button>`;
    chip.querySelector('.attach-doc-name').textContent = doc.name;
    chip.classList.toggle('is-indexed', doc.mode === 'rag');
    chip.querySelector('.attach-remove').addEventListener('click', () => removeChatDoc(i));
    attachPreview.appendChild(chip);
  });
  pendingImages.forEach((img, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-thumb";
    chip.innerHTML = `<img src="${img.dataUrl}" alt="" /><button class="attach-remove" title="Retirer">×</button>`;
    chip.querySelector(".attach-remove").addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderAttachPreview();
    });
    attachPreview.appendChild(chip);
  });
}


// ===== Mentions « @ » (outils) et « # » (documents) de la barre =====
//
// Deux gestes disponibles DANS TOUS LES MODES de discussion : « @ » expose le
// catalogue d'outils (le modèle pourra les appeler même en discussion simple),
// « # » joint un document du Corpus ou de la sandbox sans passer par le
// trombone. La liste est rendue par lib/chat-mentions.js.

let mentionToolCache = null;   // { at, tools } — catalogue d'outils publié
let mentionFileCache = null;   // { at, items } — documents joignables
const MENTION_CACHE_MS = 60000;

/// Catalogue complet d'outils, tel qu'il partirait en mode Outils (filtre de
/// publication compris) : mentionner un outil décoché dans les Réglages n'a
/// donc aucun effet, ce qui est le comportement attendu.
async function mentionToolSpecs() {
  if (mentionToolCache && Date.now() - mentionToolCache.at < MENTION_CACHE_MS) {
    return mentionToolCache.tools;
  }
  let tools = [];
  try { tools = await buildFluxoTools(); } catch (e) { console.warn('[mentions] outils indisponibles', e); }
  mentionToolCache = { at: Date.now(), tools };
  return tools;
}

/// Sous-titre d'un outil dans le menu « @ » : la description COURTE et
/// localisée du catalogue (lib/tool-publishing.js) plutôt que la consigne
/// longue en français destinée au modèle. Workflows Fluxo et outils MCP n'y
/// figurent pas : nom du workflow, ou description fournie par le serveur.
function mentionToolSub(spec) {
  const name = spec.function?.name || '';
  const hint = toolHint(name, getLang());
  if (hint) return hint.desc;
  if (fluxoToolMap[name]) return ttApps("Workflow Fluxo « {name} »", { name: fluxoToolMap[name] });
  const agentHint = agentToolHint(name, getLang());
  if (agentHint) return agentHint;
  return String(spec.function?.description || '').slice(0, 90);
}

async function mentionToolItems() {
  return (await mentionToolSpecs()).map((spec) => ({
    id: spec.function?.name || '',
    label: spec.function?.name || '',
    sub: mentionToolSub(spec),
    avatar: agentToolAvatar(spec.function?.name || ''),
  })).filter((it) => it.label);
}

/// Documents joignables : le Corpus indexé d'abord (réponse immédiate, déjà
/// vectorisé), puis les fichiers texte des sandboxes.
async function mentionFileItems() {
  if (mentionFileCache && Date.now() - mentionFileCache.at < MENTION_CACHE_MS) {
    return mentionFileCache.items;
  }
  const items = [];
  try {
    const docs = await invoke('rag_list');
    for (const d of (Array.isArray(docs) ? docs : [])) {
      items.push({ id: `rag:${d.doc_id}`, label: d.title || d.doc_id, sub: t('mention_corpus'),
                   docId: d.doc_id, chars: d.chars || 0 });
    }
  } catch { /* base indisponible */ }
  try {
    const boxes = await invoke('sandbox_list');
    // Parcours borné (profondeur 3, 300 fichiers) : le menu doit s'ouvrir vite.
    for (const sb of (boxes || [])) {
      let queue = [''];
      for (let depth = 0; depth < 3 && queue.length && items.length < 300; depth++) {
        const level = queue;
        queue = [];
        for (const dir of level) {
          let entries = [];
          try { entries = await invoke('sandbox_read_dir', { id: sb.id, path: dir }); } catch { continue; }
          for (const en of entries || []) {
            if (items.length >= 300) break;
            const path = dir ? `${dir}/${en.name}` : en.name;
            if (en.is_dir) { queue.push(path); continue; }
            if (!isDocFile({ name: en.name })) continue;
            items.push({ id: `sb:${sb.id}:${path}`, label: en.name, sub: path,
                         sandboxId: sb.id, path });
          }
        }
      }
    }
  } catch { /* pas de sandbox */ }
  mentionFileCache = { at: Date.now(), items };
  return items;
}

/// Joint le document choisi dans le menu « # ».
async function attachMentionedFile(item) {
  if (item.docId) {
    // Déjà indexé dans le Corpus : on le référence, sans le réencoder ni le
    // dupliquer (et sans le supprimer de la base au retrait de la pastille).
    if (chatDocs.some((d) => d.docId === item.docId)) return;
    chatDocs.push({ name: item.label, mode: 'rag', docId: item.docId,
                    chars: item.chars || 0, injected: false, text: '', keep: true });
    renderAttachPreview();
    showDictationHint(t('mention_doc_attached', { name: item.label }));
    return;
  }
  if (!item.path) return;
  try {
    const b64 = await invoke('sandbox_read_b64', { id: item.sandboxId, path: item.path });
    await addDocBytes(item.label, b64);
  } catch (e) {
    showDictationHint(String(e?.message || e));
  }
}

/// Outils explicitement mentionnés dans le message (« @nom_outil »), résolus
/// sur le catalogue publié. Un « @ » qui ne correspond à rien est ignoré : ce
/// n'est alors qu'un mot du message.
async function mentionedToolSpecs(query) {
  const names = new Set();
  for (const m of String(query || '').matchAll(/(?:^|\s)@([A-Za-z0-9_.-]+)/g)) names.add(m[1]);
  if (!names.size) return [];
  const specs = await mentionToolSpecs();
  return specs.filter((s) => names.has(s.function?.name));
}

/// Rafraîchit les pastilles peintes DANS le champ de saisie.
let mentionHighlight = null;
function renderMentionChips() { mentionHighlight?.refresh(); }

/// Branche les deux menus sur la barre principale.
function initBarMentions() {
  if (!chatInput) return;
  // Les mentions se peignent dans le champ lui-même : « @export_pdf » devient
  // une pastille là où il est écrit, sans pastille supplémentaire à côté.
  mentionHighlight = initMentionHighlight(chatInput, {
    known: () => (mentionToolCache?.tools || []).map((sp) => sp.function?.name).filter(Boolean),
  });
  initChatMentions({
    input: chatInput,
    anchor: searchBar || chatInput,
    labels: { tools: t('mention_hint_tools'), files: t('mention_hint_files') },
    listTools: mentionToolItems,
    listFiles: mentionFileItems,
    onTool: () => { renderMentionChips(); },   // la mention vit dans le texte, la pastille la reflète
    onFile: (item) => { attachMentionedFile(item); },
  });
}

// Chat via une API cloud compatible OpenAI (ChatGPT, Groq, OpenRouter…). Streaming
// SSE : chaque ligne `data: {json}` porte un delta `choices[0].delta.content`.
async function runApiChat(assistantBubble, history) {
  const notReady = config.aiSource === 'lumen' ? !config.lumenLinked
    : config.aiSource === 'applefm' ? !config.applefmAvailable
    : !config.apiConfigured;
  if (notReady) {
    showErrorInBubble(assistantBubble, config.aiSource === 'lumen'
      ? t("lumen_not_linked")
      : config.aiSource === 'applefm'
        ? appleFmReasonText(config.applefmReason)
        : t("api_key_missing_hint"));
    statusIndicator.className = 'status-dot offline';
    isGenerating = false;
    if (!isSpeaking) window.LumenOrb?.setState('idle');
    return;
  }
  // Format OpenAI : messages texte {role, content} (on ignore les images ici).
  const baseMessages = history.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : '',
    // Les images du tour restent attachées jusqu'à la conversion finale, sinon
    // « Comprendre cet écran » n'enverrait qu'un texte au modèle cloud.
    ...(Array.isArray(m.images) && m.images.length ? { images: m.images } : {}),
  }));
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const recalled = await withMemoryRecall(invoke, baseMessages, lastUser?.content || "", { context: "bar", limit: 5 });
  const messages = withOpenAiImages(recalled);
  const base = (config.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');

  let loadingEl = null, firstToken = false;
  const clearLoading = () => { if (loadingEl) { loadingEl.remove(); loadingEl = null; } };
  const showLoading = () => {
    if (loadingEl || firstToken) return;
    loadingEl = document.createElement('div');
    loadingEl.className = 'thinking-indicator';
    loadingEl.innerHTML = `<span class="thinking-dot"></span><span>${t('loading_model')}</span>`;
    const textEl = assistantBubble.querySelector('.msg-text-content');
    if (textEl) assistantBubble.insertBefore(loadingEl, textEl); else assistantBubble.appendChild(loadingEl);
    scrollToBottom();
  };

  try {
    showLoading();
    // SÉCURITÉ : on passe par le proxy backend `llm_api_request`, qui détient
    // seul la clé API (jamais exposée à la WebView). Réponse non-stream : le
    // backend agrège la réponse puis on l'affiche en une fois.
    // Réponse EN FLUX via `llm_stream`, qui résout la cible exactement comme
    // le proxy agrégé (clé côté Rust uniquement).
    const sv = bubbleStreamView(assistantBubble);
    const backend = rustBackend(localStorage.getItem("aiSource"));
    const body = { model: cloudModel(), messages };
    const data = withOpenAiTimings(canStream()
      ? await streamInvoke({ target: "api", payload: body, backend }, sv.hooks(() => { firstToken = true; clearLoading(); }))
      : await invoke("llm_api_request", { path: "chat/completions", body, backend }));
    const parts = splitMessage(data?.choices?.[0]?.message);
    const accumulated = parts.answer;
    firstToken = true; clearLoading();
    if (!sv.state) sv.view.update({ answer: accumulated, reasoning: parts.reasoning, tools: [], thinking: false, reasoningSeconds: 0 });
    sv.view.finish();
    setBubbleRawText(assistantBubble, accumulated);
    scrollToBottom();
    // Le proxy Rust ne compte pas cet appel (c'est l'appelant qui compte, cf.
    // agents.rs send_llm) : jetons du jour + bouton « infos » (tokens/s quand
    // le serveur fournit des timings — passerelle Apple FM, llama-server).
    recordOllamaUsage(data, "main-chat");
    addGenStatsButton(assistantBubble, data);

    conversationHistory.push({ role: 'assistant', content: accumulated, ...(parts.reasoning ? { reasoning: parts.reasoning } : {}) });
    pushOrbMessage(accumulated);
    updateContextMeter();
    statusIndicator.className = 'status-dot online';
    saveCurrentConversation();
    remoteSpeak(accumulated);
    if (config.autoSpeak) speakAfterAnnouncements(accumulated);
  } catch (error) {
    showErrorInBubble(assistantBubble, "Échec de l'appel API : " + (error?.message || error));
    statusIndicator.className = 'status-dot offline';
  } finally {
    clearLoading();
    isGenerating = false;
    if (!isSpeaking) window.LumenOrb?.setState('idle');
  }
}

// `queryOverride` permet d'envoyer une requête sans passer par la barre de saisie
// (ex. « Ask Lumen » via POST /ask). Indispensable car `<input type=text>` supprime
// les retours à la ligne : on ne peut pas faire transiter le texte multi-lignes du
// raccourci par le champ.
async function handleSend(queryOverride, opts = {}) {
  const query = (queryOverride ?? chatInput.value).trim();
  // Les images ne sont prises en charge que par Ollama (modèles multimodaux) et
  // jamais via une requête programmatique (`queryOverride`).
  // Les images jointes ne partent pas avec une requête programmatique (POST
  // /ask, RFID…), sauf demande explicite : « Comprendre cet écran » fournit à la
  // fois le prompt ET la capture.
  const images = (VISION_SOURCES.includes(config.aiSource) && (queryOverride == null || opts.withImages))
    ? pendingImages.slice() : [];
  if ((!query && images.length === 0) || isGenerating) return;

  if (queryOverride == null) { chatInput.value = ""; autosizeChatInput(); renderMentionChips(); }
  messagesContainer.style.display = 'flex';
  try { window.OrbBridge?.pushActivity?.("thinking"); } catch (e) {}

  // Compose system context at each turn, including the active project.
  // (Ollama supports a system role; the macOS shortcut path prepends it to the
  //  first user message inside runGeneration).
  const effSysPrompt = getEffectiveSystemPrompt();
  if (effSysPrompt && (config.aiSource === 'ollama' || config.aiSource === 'llama' || isApiLike(config.aiSource))) {
    const sysIndex = conversationHistory.findIndex(m => m.role === 'system');
    if (sysIndex < 0) {
      conversationHistory.unshift({ role: 'system', content: effSysPrompt });
    } else if (conversationHistory[sysIndex].content !== effSysPrompt) {
      // Refresh project instructions/profile each turn, just like Desktop.
      // The backend or project knowledge can change during a conversation.
      conversationHistory[sysIndex].content = effSysPrompt;
    }
  }

  // Contexte documentaire (pièces jointes de la discussion), calculé avant
  // d'empiler le message : il fait partie du tour, pas d'un message à part.
  pendingRagSources = [];
  // Outils mentionnés avec « @ » : ils forcent la boucle d'appel d'outils pour
  // CE tour, quel que soit le mode de discussion en cours.
  pendingMentionTools = await mentionedToolSpecs(query);
  const docContext = await buildDocContext(query);
  // Fiches du coffre imposées (lues maintenant, montrées comme un appel d'outil).
  turnPinned = [];
  // Document joint : le mode orchestré ne relit pas le message augmenté, il
  // le reçoit comme une donnée imposée (sinon il le cherchait par outils).
  if (docContext) turnPinned.push({ name: "document", args: { files: chatDocs.map((d) => d.name).join(", ") }, result: docContext, attached: true });
  for (const id of pendingPinnedRecords.splice(0)) {
    try {
      const result = await invoke("native_tool_exec", { name: "data_get", args: { id } });
      turnPinned.push({ name: "data_get", args: { id }, result: String(result) });
    } catch (e) { turnPinned.push({ name: "data_get", args: { id }, result: `Erreur : ${e}` }); }
  }
  const vaultPins = turnPinned.filter((x) => !x.attached);
  const pinnedContext = vaultPins.length
    ? `${getLang() === "en" ? "The user selected these items from their vault: answer ABOUT THEM." : "L'utilisateur a choisi ces éléments de son coffre : réponds À PROPOS D'EUX."}\n${vaultPins.map((x) => x.result).join("\n\n")}\n\n`
    : "";
  // Tour venu de Lumen XR (réponse LUE à voix haute dans le casque) : court.
  // Mais JAMAIS pour un document (joint, déposé sur l'orbe, ou demande
  // d'analyse/résumé) : là, il faut une vraie réponse développée.
  const aboutDocs = !!docContext || chatDocs.length > 0 || turnPinned.length > 0
    || /\b(document|fichier|pdf|rapport|analys|résum|resum|explique|détaill|detaill|file|report|summar|explain|detail)/i.test(query);
  const voiceHint = pendingVoiceBrief && !aboutDocs
    ? (getLang() === "en" ? "\n\n(Spoken answer in a headset: a few clear sentences, no markdown; go into detail when the question calls for it.)" : "\n\n(Réponse lue à voix haute dans un casque : quelques phrases claires, sans markdown ; développe si la question le demande.)")
    : "";
  pendingVoiceBrief = false;
  const augmented = `${pinnedContext}${docContext || ""}${query}${voiceHint}`;

  // Add User Message
  addMessageBubble(query, 'user', { images: images.map((im) => im.dataUrl) });
  // `display` : la question seule. Le contexte documentaire fait partie du tour
  // envoyé au modèle, mais ni le titre de la discussion ni sa relecture ne
  // doivent afficher le document injecté.
  const userMsg = { role: 'user', content: augmented };
  if (docContext || pinnedContext || voiceHint) userMsg.display = query;
  // Champ `images` d'Ollama : tableau de base64 nus, joint au message utilisateur.
  if (images.length) userMsg.images = images.map((im) => im.b64);
  conversationHistory.push(userMsg);
  turnRoute = null;   // décision du routeur propre à CE tour
  clearPendingImages();
  updateContextMeter();

  // Sujet détaché de la discussion (moteur de décision) : le tour ne reçoit
  // que les 2 derniers échanges ; l'historique complet est rendu ensuite.
  const detachRestore = await detachIfNewTopic(query);
  const restoreHistory = detachRestore || autoCompactIfNeeded();
  if (detachRestore) autoCompactIfNeeded();
  try { await runGeneration(augmented); } finally { restoreHistory?.(); }
  // Mode LLM hybride : tour local raté → bouton d'escalade vers l'API cloud.
  offerApiEscalation(query).catch(() => {});

  // Les sources sont attachées au message d'historique une fois la réponse
  // terminée : elles doivent réapparaître quand la conversation est rechargée.
  if (pendingRagSources.length) {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      if (conversationHistory[i].role !== 'assistant') continue;
      conversationHistory[i].sources = pendingRagSources;
      saveCurrentConversation();
      break;
    }
  }
}

// Retry the last exchange: drop the failed answer from the context (and the DOM)
// then regenerate a response for the last user message.
async function retryGeneration(failedBubble) {
  if (isGenerating) return;
  if (failedBubble) failedBubble.remove();
  // Remove any trailing assistant turns so the error/bad reply isn't kept in context.
  while (conversationHistory.length &&
         conversationHistory[conversationHistory.length - 1].role === 'assistant') {
    conversationHistory.pop();
  }
  const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user');
  if (!lastUser) return;
  await runGeneration(lastUser.content);
}

/// Outils exigés par les mentions « @ » du message courant (consommés par
/// runGeneration, puis remis à zéro).
let pendingMentionTools = [];
/// Fiches du coffre unifié choisies pour le prochain message (« Utiliser dans
/// la discussion » du téléphone) : lues par data_get, imposées à la réponse.
let pendingPinnedRecords = [];
let turnPinned = [];

// Vue de flux d'une bulle d'assistant : blocs repliables (raisonnement, outils)
// au-dessus de `.msg-answer`, où la réponse s'écrit au fil de l'eau.
function bubbleStreamView(bubble) {
  const textEl = bubble.querySelector('.msg-text-content') || bubble;
  let answerEl = textEl.querySelector('.msg-answer');
  if (!answerEl) {
    answerEl = document.createElement('span');
    answerEl.className = 'msg-answer';
    textEl.appendChild(answerEl);
  }
  const view = createStreamView({ answerEl, render: formatMessage, onRender: scrollToBottom });
  let lastState = null;
  return {
    view,
    answerEl,
    get state() { return lastState; },
    hooks(onFirst) {
      let first = false;
      return {
        signal: generationAbort?.signal,
        onUpdate: (st) => {
          lastState = st;
          if (!first) { first = true; onFirst?.(); }
          setBubbleRawText(bubble, st.answer);
          view.update(st);
        },
      };
    },
  };
}

// Réponse finale d'un message agrégé (OpenAI ou Ollama), `<think>` retiré, et
// raisonnement éventuel (champ serveur ou balises en ligne).
function splitMessage(msg) {
  const raw = msg?.content || "";
  const inline = /<think>|<\/think>/i.test(raw);
  const answer = stripThink(raw);
  const reasoning = [msg?.reasoning_content || msg?.thinking || "", inline ? raw.replace(answer, "").replace(/<\/?think>/gi, "").trim() : ""].filter(Boolean).join("\n\n");
  return { answer, reasoning };
}

async function runGeneration(query) {
  stopRequested = false;
  lastToolTokens = 0;   // remis par runOllamaAgent si ce tour envoie des outils
  generationAbort = new AbortController();
  const assistantBubble = addMessageBubble('', 'assistant');
  activeAssistantBubble = assistantBubble;
  // Fiches du coffre imposées, hors mode orchestré (qui les affiche lui-même) :
  // un bloc d'appel data_get par fiche, visible ici et sur le téléphone.
  if (!config.orchestrate && turnPinned.some((p) => !p.attached)) {
    const host = assistantBubble.querySelector('.msg-text-content') || assistantBubble;
    const wrap = document.createElement("div");
    wrap.className = "lm-blocks";
    turnPinned.filter((p) => !p.attached).forEach((pin) => wrap.appendChild(toolBlock({ name: pin.name, args: pin.args, result: pin.result }).el));
    host.prepend(wrap);
  }
  // Le panneau est posé tout de suite : placé après la réponse dans le DOM, il
  // reste sous le texte au fil du streaming, et l'utilisateur voit d'emblée sur
  // quoi le modèle s'appuie.
  renderRagSources(assistantBubble, pendingRagSources);

  statusIndicator.className = 'status-dot loading';
  isGenerating = true;
  window.LumenOrb?.setState('thinking');

  if (config.aiSource === 'shortcut') {
    // Raccourci Apple : pas de function calling — une mention « @ » ne peut pas
    // être honorée, on la laisse simplement dans le texte du prompt.
    if (pendingMentionTools.length) {
      pendingMentionTools = [];
      showHint(t('mention_tools_unsupported'));
    }
    const isAction = config.actionModeActive;
    const targetShortcut = isAction ? config.actionRouter : config.shortcutName;
    const sourceLabel = isAction ? t("dyn_source_router") : "Modèles Apple";

    // Router run: flip the orb's cores to the action (amber) color so the user
    // sees a tool/action is executing, not just the model thinking.
    if (isAction) window.LumenOrb?.setActionExecuting(true);

    const contentEl = assistantBubble.querySelector('.msg-text-content') || assistantBubble;
    const answerEl = contentEl.querySelector('.msg-answer') || contentEl;

    // En mode Action : on prépare un panneau de progression au-dessus de la
    // réponse, qui se remplira en direct via les callbacks du Action Router.
    let runId = null;
    if (isAction) {
      runId = genRunId();
      const progressEl = document.createElement('div');
      progressEl.className = 'run-progress';
      contentEl.insertBefore(progressEl, answerEl);
      activeRuns[runId] = { progressEl, entries: [] };
    }

    answerEl.innerHTML = `<div class="shortcut-loading-indicator"><span class="pulse-dot"></span><span>${t("dyn_calc_via", { source: sourceLabel })}</span></div>`;

    try {
      // The shortcut path has no "system" role and is stateless, so we serialize
      // recent context into the prompt itself (up to 10 messages, trimmed by
      // tokens to stay under Apple Intelligence's budget).
      // In Action mode the router only needs the current request to classify the
      // intent, so we keep that prompt clean (system prompt prepended once).
      let promptToSend;
      if (isAction) {
        const firstUserContent = conversationHistory.find(m => m.role === 'user')?.content;
        const effSys = getEffectiveSystemPrompt();
        promptToSend = (effSys && firstUserContent === query)
          ? `${effSys}\n\n${query}`
          : query;
      } else {
        promptToSend = buildShortcutPrompt().promptText;
      }

      if (config.debugMode) {
        const lbl = sourceLabel + (isAction ? ' · Action Router' : '');
        showDebugPrompt(assistantBubble, lbl, promptToSend);
      }

      // Mode Action : dispatch au Action Router (enveloppe JSON + run_id) ; la
      // progression arrive via 8765, le résultat final est le stdout du routeur.
      // Mode normal : appel direct (Apple Intelligence) comme avant.
      let result;
      let entries = runId ? (activeRuns[runId]?.entries || []) : [];
      if (isAction) {
        const res = await invoke("dispatch_action", {
          runId,
          routerShortcut: targetShortcut,
          prompt: promptToSend,
          conversationId: currentConversationId,
          lang: getLang(),
        });
        // run_shortcut_capture renvoie stdout si succès, sinon le message d'erreur.
        const ok = !(res && res.success === false);
        result = ok ? stripRTF(res?.output || '') : '';
        const errText = ok ? '' : ((res && res.output) || "échec du routeur");

        // Le routeur peut livrer la réponse finale par callback `kind:result`
        // (success/answer/final/reply/done). On l'utilise si le stdout est vide
        // — y compris quand le raccourci a échoué APRÈS l'avoir postée (ex. une
        // étape ultérieure plante, ou Apple Intelligence refuse en fin de chaîne).
        if (!result.trim() && (entries = runId ? (activeRuns[runId]?.entries || []) : []).length) {
          const FINAL_KINDS = ['result', 'success', 'answer', 'final', 'reply', 'done'];
          for (let i = entries.length - 1; i >= 0; i--) {
            if (FINAL_KINDS.includes((entries[i].kind || '').toLowerCase()) && (entries[i].message || '').trim()) {
              result = stripRTF(entries[i].message);
              entries = entries.filter((_, j) => j !== i);
              if (activeRuns[runId]) {
                activeRuns[runId].entries = entries;
                renderProgressEntries(activeRuns[runId].progressEl, entries);
              }
              break;
            }
          }
        }

        // Aucune réponse exploitable ET le raccourci a échoué → on remonte l'erreur.
        if (!result.trim() && !ok) throw new Error(errText);
      } else {
        result = stripRTF((await invoke("call_macos_shortcut", {
          shortcutName: targetShortcut,
          prompt: promptToSend
        })) || '');
      }

      if (result.startsWith('ACTION:') || result.startsWith('TOOL_CALL:')) {
        assistantBubble.remove();
        addMessageBubble(result, 'assistant');
      } else {
        setBubbleRawText(assistantBubble, result);
        answerEl.innerHTML = formatMessage(result);
        remoteSpeak(result);
        if (config.autoSpeak) speakAfterAnnouncements(result);
        scrollToBottom();
      }

      // Persiste la réponse + les étapes de progression (rejouées au rechargement).
      const histMsg = { role: 'assistant', content: result };
      if (entries.length) histMsg.progress = entries;
      conversationHistory.push(histMsg);
      updateContextMeter();
      statusIndicator.className = 'status-dot online';
      saveCurrentConversation();
    } catch (err) {
      showErrorInBubble(assistantBubble, t("dyn_err_shortcut", { name: targetShortcut, err }));
      statusIndicator.className = 'status-dot offline';
    } finally {
      if (runId) {
        delete activeRuns[runId];
        invoke("clear_run", { runId }).catch(() => {});
      }
      if (isAction) window.LumenOrb?.setActionExecuting(false);
      isGenerating = false;
      if (!isSpeaking) window.LumenOrb?.setState('idle');
    }
  } else if (pendingMentionTools.length) {
    // Outils mentionnés avec « @ » : ils passent avant le mode courant. Le
    // catalogue est restreint aux outils demandés, pour que même un petit
    // modèle local sache lequel appeler.
    const tools = pendingMentionTools.slice();
    pendingMentionTools = [];
    await runOllamaAgent(assistantBubble, {
      tools,
      forced: true,
      label: t('mention_tools_wait', { tools: tools.map((x) => x.function?.name).join(', ') }),
    });
  } else if (config.ollamaMode === 'router' && !turnHasImages()) {
    // Mode Routeur : workflow Fluxo « default router » (équivalent Action Router).
    // Fonctionne pour Ollama ET API cloud (le workflow Rust lit le backend actif).
    await runFluxoDispatch(assistantBubble, query, FLUXO_ROUTER_NAME);
  } else if (config.ollamaMode === 'workflow' && config.ollamaWorkflow && !turnHasImages()) {
    // Mode Workflow : envoi direct au workflow Fluxo spécifique sélectionné.
    await runFluxoDispatch(assistantBubble, query, config.ollamaWorkflow);
  } else if (config.ollamaMode === 'tools') {
    // Mode Outils : function calling — l'IA appelle les workflows Fluxo.
    await runOllamaAgent(assistantBubble);
  } else if (config.ollamaMode === 'docs' && !turnHasImages()) {
    // Mode Documentation : function calling limité à la documentation intégrée.
    await runOllamaAgent(assistantBubble);
  } else if ((!config.ollamaMode || config.ollamaMode === 'chat') && !turnHasImages()
             && (turnRoute = await withRouteIndicator(assistantBubble, () => decideTurnRoute(query))) && turnRoute.route !== 'direct') {
    // Moteur de décision (Tev1-0.8B) : il a jugé que la demande demande des
    // outils ou une orchestration. « direct » retombe dans les branches
    // suivantes, sans détection d'outils.
    // Petit modèle (≤ 1.2B) : même pour un simple appel d'outil, l'orchestrateur
    // et son planificateur par règles (mesuré : 5/14 → 14/14 au banc).
    if (turnRoute.route === 'orchestrate' || smallModelPlanner()) {
      await runOrchestratedChat(assistantBubble, query);
    } else {
      await runOllamaAgent(assistantBubble, { tools: turnRoute.tools, label: t("dyn_memory_tool_wait") });
    }
  } else if (config.orchestrate && !turnRoute && (!config.ollamaMode || config.ollamaMode === 'chat')) {
    // Le ROUTEUR décide des trois modes (direct / outils / orchestration).
    // « Réponse orchestrée » ne sert plus que de repli quand il n'a pas pu
    // trancher (moteur absent ou indécis) — avant, il court-circuitait le
    // routeur et orchestrait TOUTES les demandes, même « bonjour ».
    await runOrchestratedChat(assistantBubble, query);
  } else if ((!config.ollamaMode || config.ollamaMode === 'chat') && !turnHasImages()
             && turnRoute?.route !== 'direct'
             && (assistantTools = await assistantToolsFor(query)).length) {
    // Discussion simple, mais la demande porte sur la journée, le courrier, la
    // mémoire, les apps ou une recherche (« planifie ma journée », « lis mes
    // mails non lus », « où ai-je noté… ») : sans outils, le modèle inventait.
    // Catalogue réduit aux familles détectées, pour qu'un petit modèle choisisse bien.
    // Très petit modèle : le planificateur par règles de l'orchestrateur choisit à sa place.
    if (smallModelPlanner()) await runOrchestratedChat(assistantBubble, query);
    else await runOllamaAgent(assistantBubble, { tools: assistantTools, label: t("dyn_memory_tool_wait") });
  } else if (config.ollamaMode !== 'rag' && config.memoryTool && memoryChatTools().length && turnRoute?.route !== 'direct') {
    // (« direct » décidé par le routeur = réponse SANS outil, mémoire comprise.)
    // Discussion simple AVEC l'outil mémoire : même boucle d'appel d'outils que
    // le mode Outils, mais un catalogue réduit à la mémoire. Le modèle rappelle
    // avant de répondre et mémorise sur demande, sans qu'on ait à basculer dans
    // un mode dédié.
    await runOllamaAgent(assistantBubble, { tools: memoryChatTools(), label: t("dyn_memory_tool_wait") });
  } else if (isApiLike(config.aiSource)) {
    // Source API cloud (OpenAI-compatible) en mode chat simple.
    await runApiChat(assistantBubble, conversationHistory);
  } else {
    // Indicateur de chargement du modèle (disque lent) : géré hors du try pour que
    // le `finally` puisse toujours le nettoyer.
    let loadingEl = null, loadPoll = null, firstToken = false;
    const clearLoading = () => {
      if (loadPoll) { clearInterval(loadPoll); loadPoll = null; }
      if (loadingEl) { loadingEl.remove(); loadingEl = null; }
    };
    // Si le dernier message porte une image, la longue attente avant le 1ᵉʳ token
    // est l'ENCODAGE de l'image (phase prompt-eval du modèle multimodal), pas un
    // chargement disque : on l'annonce correctement pour ne pas inquiéter.
    const lastMsg = conversationHistory[conversationHistory.length - 1];
    const hasImage = !!(lastMsg && Array.isArray(lastMsg.images) && lastMsg.images.length);
    const showLoading = () => {
      if (loadingEl || firstToken) return;
      loadingEl = document.createElement('div');
      loadingEl.className = 'thinking-indicator';
      const llamaThinking = config.aiSource === 'llama' && config.ollamaThink;
      loadingEl.innerHTML = `<span class="thinking-dot"></span><span>${hasImage ? t('analyzing_image') : llamaThinking ? t('thinking_indicator') : t('loading_model')}</span>`;
      const textEl = assistantBubble.querySelector('.msg-text-content');
      if (textEl) assistantBubble.insertBefore(loadingEl, textEl);
      else assistantBubble.appendChild(loadingEl);
      scrollToBottom();
    };
    try {
      if (config.debugMode) {
        showDebugPrompt(assistantBubble, 'Ollama · ' + currentModel, JSON.stringify(conversationHistory, null, 2));
      }
      // Indicateur de chargement affiché immédiatement : tant qu'aucun token/raisonnement
      // n'est arrivé, on montre « Chargement du modèle… ». Retiré au premier signe de vie.
      showLoading();
      let accumulatedText = "";
      let assistantReasoning = "";
      let genStats = null;   // métriques du chunk final (eval_count, eval_duration…)
      const modelMessages = await withMemoryRecall(invoke, conversationHistory, query, { context: "bar", limit: 5 });
      const chatPayload = {
        model: currentModel,
        messages: modelMessages,
        // Ollama utilise `think`; llama-server reçoit explicitement l'état et
        // le convertit en `chat_template_kwargs.enable_thinking`.
        ...(config.aiSource === 'llama'
          ? { think: Boolean(config.ollamaThink) }
          : (config.ollamaThink ? { think: true } : {})),
        // Taille de la fenêtre de contexte : surcharge le défaut du modèle/hôte
        // quand l'utilisateur la fixe (0 = laisser le défaut).
        ...(config.ollamaNumCtx > 0 ? { options: { num_ctx: config.ollamaNumCtx } } : {}),
        keep_alive: keepAliveValue(),
      };
      // Toujours en flux quand Lumen tourne dans Tauri (llama.cpp, LiteRT,
      // Ollama local ou distant) : la commande Rust relaie les jetons.
      const sv = bubbleStreamView(assistantBubble);
      const json = await ollamaPostJson("api/chat", chatPayload, config.ollamaUrl,
        canStream() ? sv.hooks(() => { firstToken = true; clearLoading(); }) : null);
      clearLoading();
      const parts = splitMessage(json?.message || json?.choices?.[0]?.message);
      accumulatedText = parts.answer;
      genStats = json;
      if (!sv.state) {
        // Repli non-stream (aperçu hors Tauri) : rendu en une fois, même mise en forme.
        sv.view.update({ answer: accumulatedText, reasoning: parts.reasoning, tools: [], thinking: false, reasoningSeconds: 0 });
      }
      sv.view.finish();
      setBubbleRawText(assistantBubble, accumulatedText);
      assistantReasoning = parts.reasoning;
      scrollToBottom();

      recordOllamaUsage(genStats, "main-chat");
      addGenStatsButton(assistantBubble, genStats);
      conversationHistory.push({ role: 'assistant', content: accumulatedText, ...(assistantReasoning ? { reasoning: assistantReasoning } : {}) });
      pushOrbMessage(accumulatedText);
      updateContextMeter();
      statusIndicator.className = 'status-dot online';
      saveCurrentConversation();
      remoteSpeak(accumulatedText);
      if (config.autoSpeak) speakAfterAnnouncements(accumulatedText);

    } catch (error) {
      if (config.aiSource === "llama") {
        const detail = error?.message ? `<br><code>${escapeHTML(String(error.message))}</code>` : "";
        showErrorInBubble(assistantBubble, t("dyn_err_llama", {
          url: "http://127.0.0.1:11435",
          model: currentModel,
        }) + detail);
      } else {
        showErrorInBubble(assistantBubble, t("dyn_err_ollama", { url: config.ollamaUrl, model: currentModel }));
      }
      statusIndicator.className = 'status-dot offline';
    } finally {
      clearLoading();
      isGenerating = false;
      if (!isSpeaking) window.LumenOrb?.setState('idle');
    }
  }
}

// Normalise la valeur keep-alive pour Ollama : nombre si purement numérique
// (secondes, ou -1 = toujours), sinon chaîne de durée ("5m", "1h"…).
function keepAliveValue() {
  const v = (config.ollamaKeepAlive || '5m').trim();
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

// Pré-charge le modèle sélectionné en mémoire (réponse vide via /api/chat avec
// keep_alive), pour des premières réponses instantanées.
async function preloadModel() {
  // Feedback via le bouton discret (état « loading ») + une astuce brève, plutôt
  // que l'ancien libellé de statut des réglages (le bouton y a été déplacé).
  const btn = document.querySelector("#btn-preload-inline");
  const statusEl = document.querySelector("#preload-status"); // peut être absent
  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; if (typeof showHint === "function") showHint(msg); };
  // Le bouton est situé dans la barre principale : `selectModel` est le
  // sélecteur des réglages et peut encore contenir l'ancien modèle lorsque le
  // choix a été fait depuis le menu rapide de la barre. Toujours privilégier
  // le modèle actif, puis la configuration persistée ; le sélecteur des
  // réglages ne sert qu'en dernier recours.
  const model = currentModel || config.selectedModel || (selectModel && selectModel.value);
  if (!model) { setStatus(t("preload_no_model")); return; }
  if (btn) { if (btn.classList.contains("loading")) return; btn.classList.add("loading"); }
  setStatus(t("preload_loading", { model }));
  // Le chargement peut durer plusieurs secondes sur un gros modèle : l'écran
  // du contrôleur doit le dire, sinon il reste sur « Ready » sans rien faire.
  try { window.OrbBridge?.pushBusy?.("loading"); } catch (e) {}
  try {
    // IMPORTANT : précharger avec le MÊME `num_ctx` que le chat. Sinon Ollama
    // charge le modèle à son contexte par défaut (souvent bien plus grand →
    // RAM gonflée) puis le RECHARGE au premier message (contexte différent).
    await ollamaPostJson("api/chat", { model, messages: [], ...(config.ollamaNumCtx > 0 ? { options: { num_ctx: config.ollamaNumCtx } } : {}), keep_alive: keepAliveValue(), stream: false });
    setStatus(t("preload_done", { model }));
    refreshLoadedModels();
  } catch (e) {
    setStatus(t("preload_failed"));
  } finally {
    if (btn) btn.classList.remove("loading");
    // On rend la main à l'état réel de l'orbe (idle, ou speaking si une
    // synthèse vocale tourne encore par-dessus).
    try { window.OrbBridge?.pushBusy?.(isSpeaking ? "speaking" : "idle"); } catch (e) {}
  }
}

// Vrai si le modèle est déjà résident en mémoire côté Ollama (endpoint /api/ps).
// Sert à détecter la phase de chargement (disque lent) avant le premier token.
async function isModelLoaded(url, model) {
  try {
    const data = await ollamaGetJson("api/ps", url);
    return (data.models || []).some(m => m.name === model || m.model === model);
  } catch (e) {
    return false; // en cas d'échec on n'affiche pas l'indicateur (pas bloquant)
  }
}

// ===== Modèles chargés en mémoire (Ollama /api/ps) =====
// Liste les modèles résidents et permet de les décharger (keep_alive: 0).
async function refreshLoadedModels() {
  const list = document.querySelector("#loaded-models-list");
  if (!list) return;
  if (config.aiSource === "llama") {
    list.innerHTML = `<div class="loaded-empty">Recherche des modèles GGUF…</div>`;
    try {
      const models = await invoke("llama_list_models");
      if (!models?.length) {
        list.innerHTML = `<div class="loaded-empty">Aucun modèle GGUF téléchargé. Ouvre les Paramètres → Modèles.</div>`;
        return;
      }
      list.innerHTML = "";
      for (const model of models) {
        const row = document.createElement("div");
        row.className = "loaded-model-row";
        row.innerHTML = `<span class="loaded-model-name">${escapeHTML(llamaModelLabel(model.filename))}</span>`;
        const btn = document.createElement("button");
        btn.className = "loaded-stop-btn";
        btn.textContent = "Arrêter";
        btn.addEventListener("click", () => invoke("llama_stop").then(() => checkOllamaStatus()).catch(() => {}));
        row.appendChild(btn);
        list.appendChild(row);
      }
    } catch { list.innerHTML = `<div class="loaded-empty">llama-server indisponible.</div>`; }
    return;
  }
  list.innerHTML = `<div class="loaded-empty">${t("loaded_checking")}</div>`;
  let models = [];
  const url = (inputOllamaUrl?.value || config.ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
  try {
    models = (await ollamaGetJson("api/ps", url)).models || [];
  } catch (e) {
    list.innerHTML = `<div class="loaded-empty">${t("loaded_offline")}</div>`;
    return;
  }
  if (!models.length) {
    list.innerHTML = `<div class="loaded-empty">${t("loaded_none")}</div>`;
    return;
  }
  list.innerHTML = "";
  for (const m of models) {
    const name = m.name || m.model;
    const row = document.createElement("div");
    row.className = "loaded-model-row";
    const size = m.size_vram || m.size || 0;
    const sizeTxt = size ? ` · ${(size / 1e9).toFixed(1)} Go` : "";
    row.innerHTML = `<span class="loaded-model-name">${escapeHTML(name)}${sizeTxt}</span>`;
    const btn = document.createElement("button");
    btn.className = "loaded-stop-btn";
    btn.textContent = t("loaded_stop");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      await unloadModel(name);
      refreshLoadedModels();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
}

// Décharge un modèle de la mémoire (keep_alive: 0 sur /api/generate).
async function unloadModel(name) {
  const url = (inputOllamaUrl?.value || config.ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
  try {
    await ollamaPostJson("api/generate", { model: name, keep_alive: 0 }, url);
  } catch (e) { /* non bloquant */ }
}

// Render an error inside an assistant bubble and offer a retry button.
function showErrorInBubble(bubble, htmlMsg) {
  window.LumenOrb?.setMood?.('sad', { ms: 2400 });
  // A spoken error makes no sense; drop the speak button on error bubbles.
  const speakBtn = bubble.querySelector('.msg-speak-btn');
  if (speakBtn) speakBtn.remove();
  // Pas de réponse, donc rien à sourcer.
  bubble.querySelector('.msg-sources')?.remove();

  const textEl = bubble.querySelector('.msg-text-content');
  if (textEl) {
    textEl.innerHTML = `<span style="color: #ef4444;">${htmlMsg}</span>`;
  } else {
    bubble.innerHTML = `<span style="color: #ef4444;">${htmlMsg}</span>`;
  }
  bubble.classList.add('has-error');
  addRetryButton(bubble);
  // Dépassement de la fenêtre de contexte : on propose les deux remèdes
  // (compacter la discussion, agrandir la fenêtre) au lieu d'un simple
  // « Réessayer » qui échouerait à l'identique.
  const overflow = contextOverflowOf(htmlMsg);
  if (overflow) renderContextOverflow(bubble, overflow);
  else renderErrorFix(bubble, htmlMsg);
  scrollToBottom();
}

/// Erreurs courantes → un bouton qui répare, au lieu d'un simple message.
function errorFixOf(text) {
  const s = String(text || '').replace(/<[^>]+>/g, ' ');
  const local = config.aiSource === 'llama';
  if (local && !(currentModel || config.selectedModel)) return 'model';
  if (/no such file|introuvable|not found|aucun mod[eè]le|no model/i.test(s) && (local || config.aiSource === 'ollama')) return 'model';
  if (local && /connection refused|ECONNREFUSED|error sending request|failed to connect|connexion refus|llama-server|not running|arr[eê]t[ée]/i.test(s)) return 'restart';
  if (config.aiSource === 'ollama' && /connection refused|ECONNREFUSED|error sending request|failed to connect|11434/i.test(s)) return 'ollama';
  if (/401|invalid api key|incorrect api key|unauthorized/i.test(s) && isApiLike(config.aiSource)) return 'key';
  return null;
}
function renderErrorFix(bubble, htmlMsg) {
  const kind = errorFixOf(htmlMsg);
  if (!kind) return;
  const textEl = bubble.querySelector('.msg-text-content') || bubble;
  const box = document.createElement('div');
  box.className = 'ctx-overflow-actions err-fix';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'msg-retry-btn';
  b.textContent = t(`err_fix_${kind}`);
  b.addEventListener('click', async () => {
    b.disabled = true;
    if (kind === 'restart') {
      if (await startLlamaModel(currentModel || config.selectedModel)) await retryGeneration(bubble);
      else b.disabled = false;
    } else if (kind === 'model') {
      if (document.documentElement.classList.contains('shell-app')) window.LumenAppMode?.openView?.('market');
      else invoke('open_settings').catch(() => {});
      b.disabled = false;
    } else if (kind === 'ollama') {
      await invoke('open_external', { url: 'ollama://' }).catch(() => {});
      setTimeout(() => retryGeneration(bubble), 2500);
    } else if (kind === 'key') {
      invoke('open_settings').catch(() => {});
      b.disabled = false;
    }
  });
  box.appendChild(b);
  textEl.appendChild(box);
}

/// Lit une erreur de dépassement de contexte (llama-server, API OpenAI-
/// compatible). `{ need, have }` en jetons (0 si inconnus), sinon null.
function contextOverflowOf(text) {
  const s = String(text || "").replace(/&quot;/g, '"').replace(/<[^>]+>/g, " ");
  let m = s.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i);
  if (m) return { need: +m[1], have: +m[2] };
  m = s.match(/maximum context length is (\d+) tokens[\s\S]*?(\d+) tokens/i);
  if (m) return { need: +m[2], have: +m[1] };
  if (/exceed_context_size_error|context_length_exceeded|exceeds the available context/i.test(s)) return { need: 0, have: 0 };
  return null;
}

/// Fenêtre proposée : la requête refusée + 50 % de marge, arrondie à 4 096.
function suggestedContext({ need, have }) {
  const base = Math.max(need * 1.5, (have || 8192) * 2);
  return Math.min(LLAMA_CTX_MAX, Math.ceil(base / 4096) * 4096);
}

/// Ne garde que les questions et les réponses : plus d'appels d'outils, de
/// cartes, d'étapes, de raisonnement ni de documents injectés (le texte
/// affiché remplace le texte enrichi). C'est ce qui gonfle une discussion.
function compactConversationHistory() {
  const before = estimateMessagesTokens(conversationHistory);
  conversationHistory = conversationHistory
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.display || m.content || '').trim())
    .map((m) => ({ role: m.role, content: String(m.role === 'user' ? (m.display || m.content) : m.content) }));
  saveCurrentConversation();
  updateContextMeter();
  return { before, after: estimateMessagesTokens(conversationHistory) };
}

/// Compaction silencieuse avant de déborder : au-delà de 70 % de la fenêtre
/// (la marge couvre prompt système + outils + réponse), on retire d'abord les
/// détails (outils, cartes, documents injectés), puis les plus vieux échanges.
function autoCompactIfNeeded() {
  if (localStorage.getItem('autoCompact') === 'off') return null;
  const { window: win, known } = contextWindow();
  if (!known) return null;
  const budget = Math.floor(win * 0.7);
  if (estimateMessagesTokens(conversationHistory) <= budget) return null;
  const last = conversationHistory.at(-1);
  const { before } = compactConversationHistory();
  // compactConversationHistory réécrit le dernier message : on remet celui
  // de ce tour tel quel (contexte documentaire, images).
  conversationHistory[conversationHistory.length - 1] = last;
  // Les plus vieux échanges ne sont pas supprimés : mis de côté pour ce
  // tour (comme un sujet détaché), ils restent dans la discussion sauvegardée.
  const removed = [];
  while (estimateMessagesTokens(conversationHistory) > budget) {
    const i = conversationHistory.findIndex((m) => m.role !== 'system');
    if (i < 0 || i >= conversationHistory.length - 1) break;
    removed.push(...conversationHistory.splice(i, 1));
  }
  const dropped = removed.length;
  let restore = null;
  if (dropped) {
    if (detachedPrefix) detachedPrefix.push(...removed);
    else {
      detachedPrefix = removed;
      restore = () => { conversationHistory = fullConversationHistory(); detachedPrefix = null; updateContextMeter(); saveCurrentConversation(); };
    }
  }
  saveCurrentConversation();
  updateContextMeter();
  const chip = document.createElement('div');
  chip.className = 'route-chip route-topic';
  chip.textContent = t('ctx_auto_compacted', { before: shortTokens(before), after: shortTokens(estimateMessagesTokens(conversationHistory)) });
  if (dropped) chip.title = t('ctx_auto_dropped', { n: dropped });
  const bubbles = document.querySelectorAll('.message-bubble.user');
  bubbles[bubbles.length - 1]?.after(chip);
  return restore;
}

function renderContextOverflow(bubble, overflow) {
  const textEl = bubble.querySelector('.msg-text-content') || bubble;
  const msgTokens = estimateMessagesTokens(conversationHistory);
  // Ce qui n'est pas la discussion : le prompt système et surtout les
  // définitions d'outils, souvent la plus grosse part de la requête.
  const overhead = overflow.need ? Math.max(0, overflow.need - msgTokens) : 0;
  const lines = [
    t('ctx_overflow_title'),
    overflow.need ? t('ctx_overflow_detail', { need: overflow.need, have: overflow.have, msgs: msgTokens, overhead }) : '',
  ].filter(Boolean);
  const box = document.createElement('div');
  box.className = 'ctx-overflow';
  box.innerHTML = `<p>${lines.map(escapeHTML).join('<br>')}</p><div class="ctx-overflow-actions"></div>`;
  const actions = box.querySelector('.ctx-overflow-actions');
  const add = (label, run) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'msg-retry-btn';
    b.textContent = label;
    b.addEventListener('click', async () => { actions.querySelectorAll('button').forEach((x) => (x.disabled = true)); await run(); });
    actions.appendChild(b);
  };
  add(t('ctx_overflow_compact'), async () => {
    compactConversationHistory();
    await retryGeneration(bubble);
  });
  const local = config.aiSource === 'llama' || config.aiSource === 'ollama';
  if (local) {
    const next = suggestedContext(overflow);
    add(t('ctx_overflow_grow', { k: Math.round(next / 1024) }), async () => {
      if (config.aiSource === 'llama') {
        config.llamaNumCtx = next;
        localStorage.setItem('llamaNumCtx', String(next));
        // llama-server est lié à sa taille de contexte : il faut le relancer.
        const ok = await startLlamaModel(currentModel || config.selectedModel);
        if (!ok) return;
      } else {
        config.ollamaNumCtx = next;
        localStorage.setItem('ollamaNumCtx', String(next));
        if (inputOllamaNumCtx) inputOllamaNumCtx.value = String(next);
      }
      updateContextMeter();
      await retryGeneration(bubble);
    });
  }
  textEl.appendChild(box);
}

function addRetryButton(bubble) {
  if (bubble.querySelector('.msg-retry-btn')) return;
  const retryBtn = document.createElement('button');
  retryBtn.className = 'msg-retry-btn';
  retryBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg><span>${t("dyn_retry")}</span>`;
  retryBtn.addEventListener('click', () => retryGeneration(bubble));
  bubble.appendChild(retryBtn);
}

// Petit bouton infos (discret) sur un message assistant : affiche tokens, tokens/s,
// durée à partir des métriques Ollama du chunk final. Sans métriques, n'affiche rien.
function addGenStatsButton(bubble, stats) {
  if (!bubble || !stats || !stats.eval_count) return;
  const evalCount = stats.eval_count || 0;
  const evalNs = stats.eval_duration || 0;
  const promptCount = stats.prompt_eval_count || 0;
  const totalNs = stats.total_duration || 0;
  const tps = evalNs > 0 ? (evalCount / (evalNs / 1e9)) : 0;
  const totalS = totalNs / 1e9;
  // Seul endroit qui dispose des métriques de fin de génération, quel que soit
  // le backend : on en profite pour les envoyer à l'écran du contrôleur.
  try { window.OrbBridge?.pushTokens?.(tps); } catch (e) {}
  const detail =
    `${evalCount} ${t("msg_info_tokens")} · ${tps.toFixed(1)} ${t("msg_info_speed")}` +
    (promptCount ? ` · prompt ${promptCount}` : "") +
    (totalS ? ` · ${t("msg_info_duration")} ${totalS.toFixed(1)}s` : "");

  const btn = document.createElement("button");
  btn.className = "msg-info-btn";
  btn.title = t("msg_info_title");
  btn.setAttribute("aria-label", t("msg_info_title"));
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.5" r="0.6" fill="currentColor"/></svg>`;

  const pop = document.createElement("span");
  pop.className = "msg-info-pop";
  pop.textContent = detail;
  pop.hidden = true;

  // Positionne l'infobulle en `fixed` pour qu'elle échappe au rognage du
  // conteneur de messages (overflow) et reste dans les limites de la fenêtre.
  const placePop = () => {
    const r = btn.getBoundingClientRect();
    pop.style.maxWidth = Math.min(280, window.innerWidth - 16) + "px";
    // mesure après avoir rendu visible
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = r.right - pw;                 // aligné à droite sur le bouton
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.top - ph - 6;                // au-dessus du bouton
    if (top < 8) top = r.bottom + 6;         // sinon en dessous
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pop.hidden) { pop.hidden = false; placePop(); }
    else { pop.hidden = true; }
  });
  // Referme l'infobulle au clic ailleurs.
  document.addEventListener("click", () => { if (!pop.hidden) pop.hidden = true; });
  window.addEventListener("scroll", () => { if (!pop.hidden) placePop(); }, true);
  window.addEventListener("resize", () => { if (!pop.hidden) placePop(); });

  const wrap = document.createElement("span");
  wrap.className = "msg-info-wrap";
  wrap.appendChild(btn);
  msgToolsRow(bubble).appendChild(wrap);
  // L'infobulle est `position: fixed` : on la place sur <body> et non dans la
  // bulle, car .messages-container applique un transform/backdrop-filter qui
  // « capture » les éléments fixed (ils seraient mal positionnés et rognés).
  document.body.appendChild(pop);
  // Retire l'infobulle si la bulle est supprimée (nettoyage de la discussion).
  if (typeof MutationObserver !== "undefined") {
    const mo = new MutationObserver(() => {
      if (!bubble.isConnected) { pop.remove(); mo.disconnect(); }
    });
    if (bubble.parentNode) mo.observe(bubble.parentNode, { childList: true });
  }
}

// ===== Sélection de messages → export PDF =====
//
// Un « + » discret vit à côté du bouton infos (même rangée d'outils, en bas de
// la bulle). Les messages cochés s'accumulent ; un bandeau apparaît sous la
// liste des messages (dans le flux, jamais par-dessus les bulles) pour les
// exporter d'un coup via `chat_export_pdf` (le même chemin que l'outil
// export_pdf de l'IA).

const pickedBubbles = new Set();

// Rangée d'outils au pied d'une bulle : le « + » et le « i » y cohabitent,
// quel que soit leur ordre d'apparition (le « i » n'arrive qu'en fin de
// génération, quand les métriques sont connues).
function msgToolsRow(bubble) {
  let row = bubble.querySelector(":scope > .msg-tools");
  if (!row) {
    row = document.createElement("span");
    row.className = "msg-tools";
    bubble.appendChild(row);
  }
  return row;
}

function addPickButton(bubble) {
  if (!bubble || bubble.querySelector(":scope > .msg-tools > .msg-pick-btn")) return;
  const btn = document.createElement("button");
  btn.className = "msg-pick-btn";
  btn.title = t("msg_pick_title");
  btn.setAttribute("aria-label", t("msg_pick_title"));
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const picked = pickedBubbles.has(bubble);
    if (picked) pickedBubbles.delete(bubble); else pickedBubbles.add(bubble);
    bubble.classList.toggle("msg-picked", !picked);
    btn.classList.toggle("picked", !picked);
    btn.title = picked ? t("msg_pick_title") : t("msg_unpick_title");
    updateExportBar();
  });
  msgToolsRow(bubble).prepend(btn);
}

// Texte d'un message pour le PDF : le markdown brut quand on l'a (dataset), le
// texte rendu sinon — sans les libellés des boutons d'outils.
function pickedBubbleText(bubble) {
  const raw = bubble.dataset?.rawText;
  if (raw && raw.trim()) return raw.trim();
  const clone = bubble.cloneNode(true);
  clone.querySelectorAll(".msg-tools, .msg-speak-btn, .msg-retry-btn, .run-progress").forEach((el) => el.remove());
  return (clone.innerText || "").trim();
}

function pickedInOrder() {
  // Ordre d'affichage, pas ordre de clic : c'est celui de la lecture.
  return [...messagesList.querySelectorAll(".message-bubble")].filter((b) => pickedBubbles.has(b));
}

/** Nom proposé : le titre du document, daté — deux exports d'affilée ne se
 *  confondent pas, et le fichier se retrouve à la date où on l'a produit. */
function defaultExportName() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${t("msg_export_doc_title")} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

function updateExportBar() {
  // Purge les bulles disparues (discussion effacée, conversation rechargée).
  for (const b of [...pickedBubbles]) if (!b.isConnected) pickedBubbles.delete(b);
  const bar = document.getElementById("msg-export-bar");
  const n = pickedBubbles.size;
  if (!bar) return;
  const wasHidden = bar.hidden;
  bar.hidden = n === 0;
  if (n === 0) return;
  bar.querySelector(".msg-export-count").textContent = t("msg_export_count", { n });
  // Proposition rafraîchie à chaque réapparition de la barre, jamais par-dessus
  // un nom que l'utilisateur a tapé.
  const nameField = bar.querySelector(".msg-export-name");
  if (nameField && wasHidden && !nameField.dataset.edited) nameField.value = defaultExportName();
  if (nameField && !nameField.dataset.bound) {
    nameField.dataset.bound = "1";
    nameField.addEventListener("input", () => { nameField.dataset.edited = "1"; });
  }
}

function clearMessageSelection() {
  for (const b of pickedBubbles) {
    b.classList.remove("msg-picked");
    b.querySelector(":scope > .msg-tools > .msg-pick-btn")?.classList.remove("picked");
  }
  pickedBubbles.clear();
  updateExportBar();
}

async function exportPickedMessages() {
  const bubbles = pickedInOrder();
  if (!bubbles.length) return;
  const bar = document.getElementById("msg-export-bar");
  const btn = bar?.querySelector(".msg-export-go");
  const stamp = new Date().toLocaleString();
  const body = bubbles.map((b) => {
    const who = b.classList.contains("user") ? t("msg_export_you") : t("msg_export_assistant");
    return `### ${who}\n\n${pickedBubbleText(b)}`;
  }).join("\n\n---\n\n");
  // Le nom saisi sert de titre au document ET de nom de fichier : c'est ce que
  // l'on attend en tapant un nom, et le backend en dérive le fichier.
  const name = (bar?.querySelector(".msg-export-name")?.value || "").trim() || defaultExportName();
  const content = `# ${name}\n\n*${stamp}*\n\n${body}\n`;
  if (btn) { btn.disabled = true; btn.textContent = t("msg_export_running"); }
  try {
    const info = await invoke("chat_export_pdf", { title: name, content });
    if (bar) {
      const done = bar.querySelector(".msg-export-done");
      done.hidden = false;
      done.textContent = info.name;
      done.onclick = () => invoke("open_exported_file", { path: info.path }).catch((e) => console.error("[pdf]", e));
    }
    const nameField = bar?.querySelector(".msg-export-name");
    if (nameField) delete nameField.dataset.edited;
    clearMessageSelection();
  } catch (e) {
    console.error("[pdf] export sélection :", e);
    if (btn) btn.textContent = t("msg_export_failed");
  } finally {
    if (btn) {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = t("msg_export_go"); }, 1200);
    }
  }
}

// Barre d'export : posée DANS le conteneur de messages (et non en `fixed` sur
// <body>) car son backdrop-filter capture les éléments fixed. Dernier enfant
// de la colonne, elle prend la largeur du conteneur et pousse la liste au
// lieu de la recouvrir.
function mountExportBar() {
  if (document.getElementById("msg-export-bar") || !messagesContainer) return;
  const bar = document.createElement("div");
  bar.id = "msg-export-bar";
  bar.className = "msg-export-bar";
  bar.hidden = true;
  bar.innerHTML =
    `<span class="msg-export-count"></span>` +
    `<input class="msg-export-name" type="text" spellcheck="false"` +
    ` data-i18n-ph="msg_export_name_ph" placeholder="${t("msg_export_name_ph")}"` +
    ` data-i18n-title="msg_export_name_label" title="${t("msg_export_name_label")}" />` +
    `<button class="msg-export-go" data-i18n="msg_export_go">${t("msg_export_go")}</button>` +
    `<button class="msg-export-clear" data-i18n-title="msg_export_clear" title="${t("msg_export_clear")}">✕</button>` +
    `<a class="msg-export-done" hidden></a>`;
  // Le nom proposé est modifiable : un clic dans le champ sélectionne tout, pour
  // le remplacer d'un geste plutôt que d'effacer la proposition caractère à
  // caractère.
  const nameField = bar.querySelector(".msg-export-name");
  nameField.addEventListener("focus", () => nameField.select());
  nameField.addEventListener("keydown", (e) => { if (e.key === "Enter") exportPickedMessages(); });
  bar.querySelector(".msg-export-go").addEventListener("click", exportPickedMessages);
  bar.querySelector(".msg-export-clear").addEventListener("click", clearMessageSelection);
  messagesContainer.appendChild(bar);
}

function addMessageBubble(text, sender, opts = {}) {
  if (sender === 'assistant' && (text.startsWith('ACTION:') || text.startsWith('TOOL_CALL:'))) {
    const card = document.createElement('div');
    card.className = 'action-validation-card';
    
    const raw = text.replace(/^(ACTION:|TOOL_CALL:)\s*/i, '');
    const parts = raw.split('|');
    const actionName = parts[0]?.trim() || t("dyn_action_default_name");
    const actionDesc = parts[1]?.trim() || t("dyn_action_no_desc");
    
    card.innerHTML = `
      <div class="action-card-header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>
        <span>${t("dyn_validation_required", { name: escapeHTML(actionName) })}</span>
      </div>
      <div class="action-card-body">
        ${escapeHTML(actionDesc)}
      </div>
      <div class="action-card-footer">
        <button class="action-btn-confirm">${t("dyn_confirm")}</button>
        <button class="action-btn-cancel">${t("dyn_cancel")}</button>
      </div>
    `;
    
    const confirmBtn = card.querySelector('.action-btn-confirm');
    const cancelBtn = card.querySelector('.action-btn-cancel');
    
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      confirmBtn.textContent = t("dyn_executing");

      // Visually signal a real action is running: amber cores + active orb.
      window.LumenOrb?.setState('thinking');
      window.LumenOrb?.setActionExecuting(true);

      try {
        const result = await invoke("call_macos_shortcut", {
          shortcutName: config.actionRouter,
          prompt: `EXECUTE: ${actionName} | ${actionDesc}`
        });

        card.innerHTML = `
          <div class="action-card-header" style="color: #10b981;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>${t("dyn_action_done", { name: escapeHTML(actionName) })}</span>
          </div>
          <div class="action-card-body" style="opacity: 0.85;">
            ${formatMessage(stripRTF(result))}
          </div>
        `;
      } catch (err) {
        card.innerHTML = `
          <div class="action-card-header" style="color: #ef4444;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            <span>${t("dyn_action_error", { name: escapeHTML(actionName) })}</span>
          </div>
          <div class="action-card-body" style="color: #ef4444;">
            ${escapeHTML(err)}
          </div>
        `;
      } finally {
        window.LumenOrb?.setActionExecuting(false);
        if (!isSpeaking) window.LumenOrb?.setState('idle');
      }
    });

    cancelBtn.addEventListener("click", () => {
      card.innerHTML = `
        <div class="action-card-header" style="color: rgba(255, 255, 255, 0.4);">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          <span>${t("dyn_action_cancelled", { name: escapeHTML(actionName) })}</span>
        </div>
      `;
    });
    
    messagesList.appendChild(card);
    scrollToBottom();
    return card;
  }

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${sender}`;
  setBubbleRawText(bubble, text);

  if (sender === 'assistant') {
    const textSpan = document.createElement('span');
    textSpan.className = 'msg-text-content';
    // Panneau de progression du run (rejeu depuis l'historique le cas échéant).
    if (Array.isArray(opts.progress) && opts.progress.length) {
      const prog = document.createElement('div');
      prog.className = 'run-progress';
      renderProgressEntries(prog, opts.progress);
      textSpan.appendChild(prog);
    }
    // La réponse finale vit dans `.msg-answer` (séparée des étapes de progression
    // pour que l'énonciation ne lise pas les logs de progression).
    const answer = document.createElement('span');
    answer.className = 'msg-answer';
    answer.innerHTML = formatMessage(text);
    textSpan.appendChild(answer);
    bubble.appendChild(textSpan);

    renderRagSources(bubble, opts.sources);
    restoreToolCards(bubble, opts.cards, { invoke });

    appendReasoningBlock(bubble, opts.reasoning);
    if (Array.isArray(opts.toolNotes)) {
      opts.toolNotes.forEach((note) => {
        appendToolCallNote(bubble, note.name, note.input, note.result);
      });
    }
    if (Array.isArray(opts.toolNotes) && opts.toolNotes.length && text) {
      setTimeout(() => addAnswerExtras(bubble, text, opts.toolNotes.map((n) => ({ ...n, name: n.tool || n.name }))), 0);
    }
    // Panneau d'étapes d'une réponse orchestrée, replié, en tête de bulle.
    if (opts.orchestration?.steps) {
      const blocks = textSpan.querySelector(':scope > .lm-blocks') || (() => {
        const b = document.createElement('div');
        b.className = 'lm-blocks';
        textSpan.insertBefore(b, answer);
        return b;
      })();
      blocks.prepend(planBlock({ snapshot: { ...opts.orchestration, live: false } }).el);
    }

    const speakBtn = document.createElement('button');
    speakBtn.className = 'msg-speak-btn';
    speakBtn.title = "Énoncer le texte";
    speakBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
    
    speakBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Bascule lecture / arrêt : un clic sur le bouton du message en cours de
      // lecture l'interrompt.
      if (isSpeaking && currentSpeakBtn === speakBtn) {
        await stopSpeaking();
        return;
      }
      // Une autre lecture est en cours → on l'arrête avant de démarrer celle-ci.
      if (isSpeaking) await stopSpeaking();
      const textToSpeak = stripForSpeech(getBubbleSpeechText(bubble, text));
      if (!textToSpeak) return;
      currentSpeakBtn = speakBtn;
      speakBtn.classList.add('speaking');
      speakBtn.title = "Arrêter la lecture";
      try {
        await speakText(textToSpeak, { voice: bubble.dataset.agentVoice || "" });
      } catch (err) {
        console.error("Erreur d'énonciation :", err);
        speakBtn.title = "Erreur : " + err;
      } finally {
        speakBtn.classList.remove('speaking');
        speakBtn.title = "Énoncer le texte";
        if (currentSpeakBtn === speakBtn) currentSpeakBtn = null;
      }
    });
    
    bubble.appendChild(speakBtn);
  } else {
    // Vignettes des images jointes (au-dessus du texte), le cas échéant.
    if (Array.isArray(opts.images) && opts.images.length) {
      const gal = document.createElement('div');
      gal.className = 'msg-images';
      for (const src of opts.images) {
        const im = document.createElement('img');
        im.src = src.startsWith('data:') ? src : `data:image/*;base64,${src}`;
        im.alt = "";
        gal.appendChild(im);
      }
      bubble.appendChild(gal);
    }
    if (text) {
      const txt = document.createElement('div');
      // Message de l'utilisateur : les « @outil » deviennent des pastilles, pour
      // qu'on relise d'un coup d'œil quels outils ce tour a exigés.
      txt.innerHTML = decorateMentions(formatMessage(text));
      bubble.appendChild(txt);
    }
  }

  addPickButton(bubble);
  messagesList.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

// Scroll the conversation to the latest message. Deferred to the next frame so
// it runs after the DOM/layout has updated (e.g. after innerHTML changes).
function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesList.scrollTop = messagesList.scrollHeight;
  });
}

function formatMessage(text) {
  // Un `<think>` resté dans le texte (réponse agrégée, historique) ne s'affiche
  // jamais en clair : le raisonnement a son propre bloc repliable.
  return renderMarkdown(stripThink(text || ""));
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// Conversations Management Logic
function getSavedConversations() {
  try {
    return JSON.parse(localStorage.getItem('saved_conversations')) || [];
  } catch (e) {
    return [];
  }
}

// Les images (base64) sont volumineuses : on ne les persiste PAS dans
// localStorage (quota), on garde l'historique texte. Elles restent en mémoire
// pour la session courante (suivi multimodal multi-tours).
function stripImagesForStorage(history) {
  return history.map((m) => {
    if (!m || !m.images) return m;
    const { images, ...rest } = m;
    return rest;
  });
}

function currentConversationModelMeta() {
  if (isApiLike(config.aiSource)) return { source: config.aiSource, model: cloudModel() };
  if (config.aiSource === 'shortcut') return { source: 'shortcut', model: 'shortcut' };
  if (config.aiSource === 'llama') return { source: 'llama', model: currentModel || config.selectedModel || '' };
  return { source: 'ollama', model: currentModel || config.selectedModel || '' };
}

function conversationModelLabel(conv) {
  const source = conv.source || (conv.model === 'shortcut' ? 'shortcut' : 'ollama');
  if (source === 'shortcut') return 'Modèles Apple';
  if (source === 'applefm') return conv.model === 'apple-private-cloud' ? 'Apple PCC' : 'Apple FM';
  if (source === 'llama') return llamaModelLabel(conv.model);
  return conv.model ? getModelLabel(conv.model) : 'Inconnu';
}

function saveCurrentConversation() {
  let saved = getSavedConversations();
  const modelMeta = currentConversationModelMeta();

  if (!currentConversationId) {
    const projectId = contextProject()?.id || "";
    currentConversationId = Date.now().toString();
    const firstUser = conversationHistory.find(m => m.role === 'user');
    const firstUserQuery = firstUser?.display || firstUser?.content || 'Discussion';
    const title = firstUserQuery.substring(0, 32) + (firstUserQuery.length > 32 ? '...' : '');
    
    saved.unshift({
      id: currentConversationId,
      title: title,
      folder: projectId,
      history: stripImagesForStorage(fullConversationHistory()),
      source: modelMeta.source,
      model: modelMeta.model,
      // Surface d'origine (≠ `source`, qui désigne le backend IA). Le bureau
      // agrège barre + bureau + Telegram ; la barre ne montre qu'elle-même.
      origin: 'bar'
    });
  } else {
    const idx = saved.findIndex(c => c.id === currentConversationId);
    if (idx !== -1) {
      saved[idx].history = stripImagesForStorage(fullConversationHistory());
      saved[idx].source = modelMeta.source;
      saved[idx].model = modelMeta.model;
    }
  }
  
  lsSet('saved_conversations', JSON.stringify(saved));
}

// ===== Classement des discussions (dossiers, épingles, résumés) =====
//
// Le panneau d'historique était une liste plate : au-delà d'une vingtaine de
// discussions, retrouver « celle sur le devis » relevait du défilement. On y
// ajoute donc trois gestes, tous facultatifs — une discussion non classée reste
// une entrée normale, au même endroit qu'avant.

/// Écrit une modification sur UNE conversation, dans le magasin de la barre.
/// Le bureau a le sien (préfixé par le profil) : on ne déplace jamais une
/// discussion d'un magasin à l'autre, cf. lib/conversation-folders.js.
function updateConversation(id, patch) {
  const saved = getSavedConversations().map((c) => (c.id === id ? { ...c, ...patch } : c));
  lsSet('saved_conversations', JSON.stringify(saved));
}

let historyFilter = 'all'; // 'all' | 'pinned' | 'none' | <id de dossier>

// A saved conversation always keeps its own project. Selecting a sidebar
// filter only supplies context to a NEW Application conversation.
function contextProject() {
  const folder = currentConversationId
    ? getSavedConversations().find(c => c.id === currentConversationId)?.folder
    : document.documentElement.classList.contains('shell-app') ? historyFilter : '';
  return folder ? getProject(folder) : null;
}


// ===== Connaissances du projet (mode application) =====
// Pastille du compositeur + volet partagé (lib/project-kb.js) : les documents du
// dossier de discussions partent en contexte complet ou par recherche RAG.
let projectKb = null;
let projectKbShown = '';
function projectKbLabel(proj) {
  const n = proj.files.filter((f) => f.kind !== 'image').length;
  const en = getLang() === 'en';
  if (!n) return en ? 'Add documents' : 'Ajouter des documents';
  return projectServedInFull(proj) ? (en ? `${n} file(s) in context` : `${n} fichier(s) en contexte`)
    : (en ? `${n} file(s) · search` : `${n} fichier(s) · recherche`);
}
function updateProjectKbChip() {
  const btn = document.getElementById('btn-project-kb');
  if (!btn) return;
  const proj = document.documentElement.classList.contains('shell-app') ? contextProject() : null;
  btn.hidden = !proj;
  if (!proj) { if (projectKb?.open) projectKb.toggle(false); projectKbShown = ''; return; }
  btn.querySelector('.mode-ic').innerHTML = lumenIcon('library');
  btn.querySelector('.mode-label').textContent = projectKbLabel(proj);
  btn.classList.toggle('active', !!projectKb?.open);
  // Redessine le volet seulement quand le projet change (le champ Instructions
  // garderait sinon son focus perdu à chaque tic).
  if (projectKb?.open && projectKbShown !== proj.id) { projectKbShown = proj.id; projectKb.refresh(); }
}
function toggleProjectKb() {
  if (!projectKb) {
    const host = document.querySelector('.as-main') || document.body;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    projectKb = mountProjectKb({
      host, invoke, project: contextProject, lang: () => (getLang() === 'en' ? 'en' : 'fr'),
      toast: (m) => showHint(m),
      onToggle: () => updateProjectKbChip(),
      onChange: () => { const p = contextProject(); const b = document.getElementById('btn-project-kb'); if (p && b) b.querySelector('.mode-label').textContent = projectKbLabel(p); },
    });
  }
  projectKbShown = contextProject()?.id || '';
  projectKb.toggle();
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-project-kb')?.addEventListener('click', toggleProjectKb);
  setInterval(updateProjectKbChip, 1500);
});

function renderConversationFilters() {
  const bar = document.createElement('div');
  bar.className = 'conv-filter-bar';
  const folders = listFolders();
  const chips = [
    { id: 'all', label: t('conv_filter_all') },
    { id: 'pinned', label: t('conv_filter_pinned') },
    ...folders.map((f) => ({ id: f.id, label: f.name, color: f.color })),
  ];
  // « Non classées » n'apparaît que s'il existe au moins un dossier : sans
  // dossier, tout est non classé et le filtre ne trierait rien.
  if (folders.length) chips.push({ id: 'none', label: t('conv_filter_unfiled') });
  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.className = 'conv-filter-chip' + (historyFilter === chip.id ? ' active' : '');
    btn.type = 'button';
    if (chip.color) btn.style.setProperty('--chip-color', chip.color);
    btn.innerHTML = (chip.color ? '<span class="conv-folder-dot"></span>' : '') + escapeHTML(chip.label);
    btn.addEventListener('click', () => {
      historyFilter = chip.id;
      renderSavedConversationsList();
    });
    bar.appendChild(btn);
  }
  const add = document.createElement('button');
  add.className = 'conv-filter-chip ghost';
  add.type = 'button';
  // Icône « dossier + » plutôt qu'une pastille en pointillés : une action
  // discrète, pas un filtre de plus.
  add.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6M9 13h6"/></svg><span>${escapeHTML(t('conv_folder_new'))}</span>`;
  add.title = t('conv_folder_new_hint');
  add.addEventListener('click', async () => {
    // `prompt()` est inopérant dans la WebView Tauri (cf. confirm()) : on ouvre
    // une saisie en ligne dans la barre de filtres.
    add.replaceWith(folderNameInput());
  });
  bar.appendChild(add);
  return bar;
}

function folderNameInput() {
  const input = document.createElement('input');
  input.className = 'conv-folder-input';
  input.type = 'text';
  input.maxLength = 40;
  input.placeholder = t('conv_folder_name');
  const commit = () => {
    const name = input.value.trim();
    if (!name) { renderSavedConversationsList(); return; }
    try {
      historyFilter = createFolder(name).id;
    } catch (e) {
      showDictationHint(String(e?.message || e));
    }
    renderSavedConversationsList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') renderSavedConversationsList();
  });
  input.addEventListener('blur', commit);
  setTimeout(() => input.focus(), 0);
  return input;
}

function conversationMatchesFilter(conv) {
  if (historyFilter === 'all') return true;
  if (historyFilter === 'pinned') return isPinned(conv);
  if (historyFilter === 'none') return !resolveFolder(conv);
  return conv.folder === historyFilter;
}

function renderSavedConversationsList() {
  conversationsListContainer.innerHTML = "";
  // La barre n'affiche QUE ce qui a été fait depuis la barre. Le bureau, lui,
  // est protégé par mot de passe : c'est lui qui consolide toutes les sources.
  // Une entrée sans `origin` est un historique d'avant ce marquage : elle vient
  // forcément de la barre.
  const all = getSavedConversations().filter((c) => !c.origin || c.origin === 'bar');
  conversationsListContainer.appendChild(renderConversationFilters());

  // Les épinglées remontent en tête, quel que soit le filtre : c'est tout
  // l'intérêt de les avoir épinglées.
  const saved = all
    .filter(conversationMatchesFilter)
    .sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)));

  if (saved.length === 0) {
    conversationsListContainer.insertAdjacentHTML('beforeend',
      `<span class="conv-empty">${escapeHTML(all.length ? t('conv_filter_empty') : t('conv_history_empty'))}</span>`);
    return;
  }

  const groups = document.documentElement.classList.contains('shell-app') && historyFilter === 'all'
    ? conversationGroups(saved, listFolders(), {
      pinned: getLang() === 'en' ? 'Pinned' : 'Épinglés',
      recent: getLang() === 'en' ? 'Recent chats' : 'Discussions récentes',
    }) : [{ conversations: saved }];
  const headings = new Map(groups.filter(g => g.label).map(g => [g.conversations[0], g]));
  groups.flatMap(g => g.conversations).forEach(conv => {
    const group = headings.get(conv);
    if (group) {
      const heading = document.createElement(group.kind === 'project' ? 'button' : 'div');
      heading.className = 'as-group-heading';
      if (group.kind === 'project') {
        heading.type = 'button';
        heading.addEventListener('click', () => {
          if (isGenerating) return;
          historyFilter = group.id.slice('project:'.length);
          startNewChat();
          renderSavedConversationsList();
        });
      }
      heading.dataset.kind = group.kind;
      heading.textContent = group.label;
      conversationsListContainer.appendChild(heading);
    }
    const item = document.createElement('div');
    item.className = 'conversation-history-item' + (isPinned(conv) ? ' pinned' : '');
    item.dataset.id = conv.id;

    const main = document.createElement('div');
    main.className = 'conversation-history-main';
    main.setAttribute('role', 'button');
    main.tabIndex = 0;
    main.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); main.click(); }
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'conversation-history-title';
    titleSpan.textContent = conv.title;
    main.appendChild(titleSpan);

    const folder = resolveFolder(conv);
    if (folder) {
      const tag = document.createElement('span');
      tag.className = 'conv-folder-tag';
      tag.style.setProperty('--chip-color', folder.color);
      tag.innerHTML = `<span class="conv-folder-dot"></span>${escapeHTML(folder.name)}`;
      main.appendChild(tag);
    }

    const modelBadge = document.createElement('span');
    modelBadge.className = 'conversation-model-badge';
    const modelLabel = conversationModelLabel(conv);
    modelBadge.textContent = modelLabel;
    modelBadge.title = `Modèle : ${modelLabel}`;

    const pinBtn = document.createElement('button');
    pinBtn.className = 'btn-conv-icon' + (isPinned(conv) ? ' on' : '');
    pinBtn.title = isPinned(conv) ? t('conv_unpin') : t('conv_pin');
    pinBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="${isPinned(conv) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M15 3l6 6-3 1-4 4-1 5-2 2-4-4-4.5 2.5L7 15 3 11l2-2 5-1 4-4z"/></svg>`;

    const folderBtn = document.createElement('button');
    folderBtn.className = 'btn-conv-icon';
    folderBtn.title = t('conv_folder_assign');
    folderBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>`;

    const summaryBtn = document.createElement('button');
    summaryBtn.className = 'btn-conv-icon';
    summaryBtn.title = t('conv_summarize');
    summaryBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 6h14M5 11h14M5 16h8"/></svg>`;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete-conv';
    deleteBtn.title = "Supprimer";
    deleteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

    main.addEventListener("click", () => {
      loadConversation(conv);
      historyPanel.classList.remove("active");
    });

    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      updateConversation(conv.id, { pinned: !isPinned(conv) });
      renderSavedConversationsList();
    });

    folderBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFolderMenu(item, conv);
    });

    summaryBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await summarizeConversation(conv, summaryBtn);
    });

    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });

    item.appendChild(main);
    item.appendChild(modelBadge);
    item.appendChild(pinBtn);
    item.appendChild(folderBtn);
    item.appendChild(summaryBtn);
    item.appendChild(deleteBtn);

    if (conv.summary) {
      const note = document.createElement('p');
      note.className = 'conv-summary';
      note.textContent = conv.summary;
      item.appendChild(note);
    }
    conversationsListContainer.appendChild(item);
  });
}

/// Petit menu de rangement : les dossiers existants, « aucun », et la création
/// à la volée — pour ne pas obliger à créer le dossier avant de ranger.
function openFolderMenu(anchor, conv) {
  document.querySelectorAll('.conv-folder-menu').forEach((el) => el.remove());
  const menu = document.createElement('div');
  menu.className = 'conv-folder-menu';
  const entry = (label, onClick, color = '', active = false) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'conv-folder-menu-row' + (active ? ' active' : '');
    if (color) row.style.setProperty('--chip-color', color);
    row.innerHTML = (color ? '<span class="conv-folder-dot"></span>' : '') + escapeHTML(label);
    row.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    menu.appendChild(row);
  };
  entry(t('conv_filter_unfiled'), () => {
    updateConversation(conv.id, { folder: '' });
    renderSavedConversationsList();
  }, '', !conv.folder);
  for (const folder of listFolders()) {
    entry(folder.name, () => {
      updateConversation(conv.id, { folder: folder.id });
      renderSavedConversationsList();
    }, folder.color, conv.folder === folder.id);
  }
  const input = document.createElement('input');
  input.className = 'conv-folder-input';
  input.type = 'text';
  input.maxLength = 40;
  input.placeholder = t('conv_folder_name');
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const name = input.value.trim();
    if (!name) return;
    try {
      updateConversation(conv.id, { folder: createFolder(name).id });
    } catch (err) {
      showDictationHint(String(err?.message || err));
    }
    renderSavedConversationsList();
  });
  menu.appendChild(input);
  anchor.appendChild(menu);
  setTimeout(() => {
    const close = (e) => {
      if (menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener('click', close);
    };
    document.addEventListener('click', close);
  }, 0);
}

/// Résumé IA d'une discussion, écrit dans la fiche et affiché sous le titre.
///
/// Le résumé passe par le moteur ACTIF, hors de la discussion en cours : il ne
/// doit ni apparaître dans le fil, ni polluer le contexte de ce que
/// l'utilisateur est en train de faire.
async function summarizeConversation(conv, btn) {
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try {
    const { content } = await llmChat(summaryMessages(conv, getLang()), { rawSystem: true });
    const summary = String(content || '').trim();
    if (!summary) throw new Error(t('conv_summary_empty'));
    updateConversation(conv.id, { summary });
    renderSavedConversationsList();
  } catch (e) {
    showDictationHint(t('conv_summary_failed') + (e?.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
  }
}

function loadConversation(conv) {
  currentConversationId = conv.id;
  conversationHistory = conv.history;
  contextWarned = false;

  // Écritures « au mieux » (cf. lib/safe-storage.js) : un stockage saturé ne doit
  // pas empêcher la discussion de s'afficher — seule la mémorisation du backend
  // est perdue.
  if ((conv.source === 'applefm' && !config.applefmAvailable)
      || (conv.source === 'lumen' && !config.lumenLinked)
      || (conv.source === 'api' && !config.apiConfigured)) {
    // Conversation tenue avec une source indisponible ici (autre Mac, poste
    // délié, clé retirée) : on garde l'historique sur la source courante.
  } else if (conv.source === 'llama') {
    // llama.cpp reste llama.cpp : le rabattre sur Ollama faisait « changer de
    // moteur tout seul » à la réouverture d'une discussion.
    config.aiSource = 'llama';
    if (conv.model) currentModel = conv.model;
    lsSet('aiSource', config.aiSource);
  } else if (isApiLike(conv.source)) {
    config.aiSource = conv.source;
    if (conv.model) setCloudModel(conv.model, conv.source);
    lsSet('aiSource', config.aiSource);
  } else if (conv.model === 'shortcut' || conv.source === 'shortcut') {
    config.aiSource = 'shortcut';
    lsSet('aiSource', config.aiSource);
  } else {
    config.aiSource = 'ollama';
    currentModel = conv.model || config.selectedModel;
    lsSet('aiSource', config.aiSource);
  }
  
  applyConfigUI();
  // Le Rust (agents, Telegram/Slack, Fluxo) suit la même source que la barre.
  pushOllamaConfig();
  
  messagesList.innerHTML = "";
  clearMessageSelection();
  messagesContainer.style.display = 'flex';
  conversationHistory.forEach(msg => {
    if (msg.role === 'tool' || (msg.role === 'assistant' && msg.tool_calls)) return;
    // Le prompt système fait partie de l'historique (il doit repartir au modèle
    // au tour suivant), mais ce n'est pas un message de la conversation : le
    // rouvrir déversait plusieurs écrans de consignes avant le premier
    // « Bonjour ». On ne l'affiche qu'en mode DEV, où c'est justement ce qu'on
    // vient vérifier.
    if (msg.role === 'system' && !config.debugMode) return;
    addMessageBubble(msg.display || msg.content, msg.role, { progress: msg.progress, toolNotes: msg.toolNotes, reasoning: msg.reasoning, orchestration: msg.orchestration, sources: msg.sources, cards: msg.cards });
  });
  updateContextMeter();
}

function deleteConversation(id) {
  let saved = getSavedConversations();
  saved = saved.filter(c => c.id !== id);
  lsSet('saved_conversations', JSON.stringify(saved));
  
  if (currentConversationId === id) {
    startNewChat();
  }
  
  renderSavedConversationsList();
}



function stripRTF(rtfStr) {
  if (!rtfStr || typeof rtfStr !== 'string') return '';
  if (!rtfStr.trim().startsWith('{\\rtf')) return rtfStr;

  // Destination groups whose entire content must be discarded.
  const ignoreDest = new Set([
    'fonttbl','colortbl','expandedcolortbl','stylesheet','info','listtable',
    'listoverridetable','generator','pgdsctbl','themedata','colorschememapping',
    'latentstyles','datastore','pntext','pntxta','pntxtb','pnseclvl','field',
    'xmlnstbl','header','footer','bkmkstart','bkmkend','shppict','nonshppict','pict'
  ]);

  const rtf = rtfStr;
  const n = rtf.length;
  let i = 0;
  let out = '';
  const stack = [{ ignore: false, uc: 1 }];
  const top = () => stack[stack.length - 1];

  const win1252 = (hex) => {
    try { return new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(hex, 16)])); }
    catch (e) { return ''; }
  };

  // After a \uNNNN, skip `count` fallback tokens (\'xx, \x or plain chars).
  const skipTokens = (count) => {
    let skipped = 0;
    while (skipped < count && i < n) {
      const c = rtf[i];
      if (c === '{' || c === '}') break;
      if (c === '\\') {
        if (rtf[i + 1] === "'") { i += 4; }
        else if (/[a-zA-Z]/.test(rtf[i + 1])) { i += 2; while (i < n && /[a-zA-Z0-9-]/.test(rtf[i])) i++; if (rtf[i] === ' ') i++; }
        else { i += 2; }
      } else { i++; }
      skipped++;
    }
  };

  while (i < n) {
    const c = rtf[i];
    if (c === '{') {
      stack.push({ ignore: top().ignore, uc: top().uc });
      i++;
    } else if (c === '}') {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === '\\') {
      const nx = rtf[i + 1];
      if (nx === '\\' || nx === '{' || nx === '}') {
        if (!top().ignore) out += nx;
        i += 2;
      } else if (nx === '*') {
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
        let param = '';
        if (j < n && (rtf[j] === '-' || /[0-9]/.test(rtf[j]))) {
          let k = j + (rtf[j] === '-' ? 1 : 0);
          while (k < n && /[0-9]/.test(rtf[k])) k++;
          param = rtf.slice(j, k);
          j = k;
        }
        if (rtf[j] === ' ') j++;
        i = j;

        if (ignoreDest.has(word)) {
          top().ignore = true;
        } else if (!top().ignore) {
          if (word === 'par' || word === 'line' || word === 'sect') out += '\n';
          else if (word === 'tab') out += '\t';
          else if (word === 'uc') top().uc = parseInt(param || '1', 10);
          else if (word === 'u') {
            let code = parseInt(param, 10);
            if (code < 0) code += 65536;
            out += String.fromCharCode(code);
            skipTokens(top().uc);
          }
          // all other control words are formatting: ignored
        }
      } else {
        // control symbol (\~ \- \_ ...)
        if (!top().ignore && nx === '~') out += ' ';
        i += 2;
      }
    } else {
      if (!top().ignore) out += c;
      i++;
    }
  }

  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ===== Click-through (passe-clic) =====
// La fenêtre est transparente mais occupe tout son rectangle : par défaut elle
// capte la souris partout, ce qui bloque le bureau visible dans les zones vides.
// On surveille la position du curseur (côté natif, car le webview ne reçoit plus
// d'évènement dès que la fenêtre ignore la souris) et on active le passe-clic
// dès que le curseur n'est PAS au-dessus d'un élément réellement affiché.

// Conteneurs purement décoratifs / de mise en page : transparents → passe-clic.
// Tout autre élément (barre, orbe, panneaux, bulles…) est considéré « plein ».
const CLICKTHROUGH_PASS_IDS = new Set([
  "bar-stage", "bar-area", "orb-wrap"
]);
const CLICKTHROUGH_PASS_CLASSES = ["glowing-orb", "orb-shadow"];

let clickThroughIgnoring = null; // null = état natif encore inconnu
let clickThroughSuspended = false; // vrai pendant un déplacement de la fenêtre

// Déplacement manuel de la fenêtre (non contraint par la barre de menus macOS).
// On suspend le passe-clic le temps du glissement pour que le webview continue
// de recevoir les évènements souris.
async function startManualDrag() {
  clickThroughIgnoring = false;
  invoke("set_ignore_cursor_events", { ignore: false }).catch(() => {});
  // Sur Linux (WebKitGTK), le déplacement « manuel » ne reçoit plus d'évènements
  // `mousemove` dès que le curseur sort du webview → le drag est impossible. Le
  // drag NATIF du gestionnaire de fenêtres est fiable. (Le manuel ne sert qu'à
  // esquiver la barre de menus macOS, contrainte absente sur Linux.)
  if (platformFlavor === "rpi" || platformFlavor === "linux-standard") {
    invoke("start_drag").catch(() => {});
    return;
  }
  let grab;
  try {
    grab = await invoke("cursor_pos_in_window"); // point saisi, relatif à la fenêtre
  } catch (e) {
    invoke("start_drag").catch(() => {}); // repli sur le drag natif
    return;
  }
  const grabX = grab[0], grabY = grab[1];
  clickThroughSuspended = true;

  const onMove = (e) => {
    // screenX/screenY : position du curseur à l'écran (px logiques).
    invoke("set_window_position", { x: e.screenX - grabX, y: e.screenY - grabY })
      .catch(() => {});
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    clickThroughSuspended = false;
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// Détermine si le point (coord. DOM logiques) tombe sur de l'UI visible.
function pointOverContent(cx, cy) {
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
    return false;
  }
  let el = document.elementFromPoint(cx, cy);
  while (el && el !== document.body && el !== document.documentElement) {
    const isPass =
      (el.id && CLICKTHROUGH_PASS_IDS.has(el.id)) ||
      CLICKTHROUGH_PASS_CLASSES.some(c => el.classList.contains(c));
    if (!isPass) return true;          // un vrai widget : la fenêtre doit capter
    el = el.parentElement;             // décor transparent : on remonte
  }
  return false;                         // on n'a croisé que du décor / le body
}

async function updateClickThrough() {
  // Pendant un déplacement, on force la fenêtre à rester cliquable.
  if (clickThroughSuspended) {
    if (clickThroughIgnoring !== false) {
      clickThroughIgnoring = false;
      invoke("set_ignore_cursor_events", { ignore: false }).catch(() => {});
    }
    return;
  }
  let pos;
  try {
    pos = await invoke("cursor_pos_in_window");
  } catch (e) {
    // Sonde indisponible/erreur (cas observé sous Windows) : on NE laisse PAS la
    // fenêtre coincée en click-through (sinon plus aucun clic ni glisser ne passe).
    // On force l'état interactif et on abandonne le click-through pour cette session.
    if (clickThroughIgnoring !== false) {
      clickThroughIgnoring = false;
      invoke("set_ignore_cursor_events", { ignore: false }).catch(() => {});
    }
    return;
  }
  const shouldIgnore = !pointOverContent(pos[0], pos[1]);
  if (shouldIgnore === clickThroughIgnoring) return; // pas de changement
  clickThroughIgnoring = shouldIgnore;
  invoke("set_ignore_cursor_events", { ignore: shouldIgnore }).catch(() => {});
}

function initClickThrough() {
  // Un sondage périodique suffit : les timers JS continuent de tourner même
  // quand la fenêtre ignore la souris (contrairement aux évènements souris).
  setInterval(updateClickThrough, 60);
}

// ===== Centre de notifications du Heartbeat =====
// Le Heartbeat (tâche programmée côté Rust) exécute un raccourci macOS à
// intervalle régulier. Chaque exécution renvoie sa sortie via l'évènement
// `heartbeat-result`, qu'on stocke et affiche ici (cloche + badge + panneau).
const NOTIF_MAX = 50; // on ne garde que les derniers résultats
let heartbeatNotifications = (() => {
  try {
    const arr = JSON.parse(localStorage.getItem('heartbeatNotifications'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
})();
let notifUnread = parseInt(localStorage.getItem('heartbeatNotifUnread') || '0', 10) || 0;

// Synchro inter-fenêtres : si le mode bureau (fenêtre sandbox) efface les
// notifications, on recharge ici la liste/le badge (event `storage`).
window.addEventListener('storage', (e) => {
  if (e.key === 'heartbeatNotifications') {
    try { heartbeatNotifications = JSON.parse(e.newValue || '[]') || []; } catch { heartbeatNotifications = []; }
    updateNotifBadge?.();
    if (notificationsPanel?.classList.contains('active')) renderNotificationsList();
  } else if (e.key === 'heartbeatNotifUnread') {
    notifUnread = parseInt(e.newValue || '0', 10) || 0;
    updateNotifBadge?.();
  }
});

// ===== Capsule Halo =====
// Petite capsule persistante en haut de l'écran (fenêtre `island`) : agents en
// cours, notifications et heure. Le réglage pilote le mode côté Rust, qui crée
// ou masque la fenêtre ; la capsule fait le reste.
function applyHalo() {
  invoke("halo_set_position", { position: config.haloPosition || "center" }).catch(() => {});
  invoke("halo_set_style", { style: config.haloStyle || "float" }).catch(() => {});
  invoke("halo_set_enabled", { enabled: !!config.halo }).catch(() => {});
}

function initNotifications() {
  updateNotifBadge();
  // La capsule demande l'ouverture du centre de notifications (bouton du panneau).
  window.__TAURI__?.event?.listen?.("halo-open", () => {
    settingsPanel?.classList.remove("active");
    notificationsPanel?.classList.add("active");
    markNotificationsRead();
    renderNotificationsList();
  });
  // S'abonner aux résultats émis par le scheduler Rust.
  const evt = window.__TAURI__?.event;
  if (evt?.listen) {
    evt.listen("heartbeat-result", (e) => addNotification(e.payload));
    // Son « Messagerie » : joué quand le nombre de messages de l'inbox augmente
    // (nouveau message d'agent), pas quand elle est simplement resauvée.
    let inboxCount = -1;
    const countInbox = async () => {
      try { return (JSON.parse(await invoke("inbox_load") || "[]") || []).length; } catch { return -1; }
    };
    countInbox().then((n) => { inboxCount = n; });
    evt.listen("inbox-updated", async () => {
      const n = await countInbox();
      if (n > inboxCount && inboxCount >= 0) playNotifSound("messages");
      if (n >= 0) inboxCount = n;
    });
    // Pulse a red heart over the orb the moment the Heartbeat fires
    // (before the shortcut/workflow runs), not when the result comes back.
    evt.listen("heartbeat-tick", () => window.LumenOrb?.pulseHeart());
    // Progression temps réel d'un run du Action Router (callbacks via 8765).
    evt.listen("run-progress", (e) => onRunProgress(e.payload));
    // Indicateur « agent en cours d'exécution » : cœur jaune sur l'orbe (comme le
    // mode action). Compteur pour gérer plusieurs agents simultanés.
    evt.listen("agent-running", (e) => {
      const active = !!(e.payload && e.payload.active);
      agentRunningCount = Math.max(0, agentRunningCount + (active ? 1 : -1));
      lastOrbAgent = {
        active: agentRunningCount > 0,
        count: agentRunningCount,
        task: active ? (e.payload?.task || "Tache en cours") : "Aucune tache en cours",
        agent_id: e.payload?.agent_id || "",
      };
      window.OrbBridge?.pushAgent(lastOrbAgent);
      const on = agentRunningCount > 0;
      window.LumenOrb?.setActionExecuting(on);
      if (on) { window.LumenOrb?.setHeartColor('#ffcc00'); window.LumenOrb?.pulseHeart(); }
      else if (!isGenerating) window.LumenOrb?.setHeartColor(config.orbHeartColor || '#ff4d6d');
    });
    // Demandes d'embeddings du backend (bloc Fluxo « Prédire (ML) » sur un
    // modèle texte) : calculées ici via le worker transformers.js partagé.
    installEmbedResponder();
    // Mode bureau de la sandbox : l'orbe y est déjà affiché → on masque celui de
    // la fenêtre principale tant que le bureau est actif (un seul orbe à la fois),
    // sans toucher au réglage utilisateur (restauré à la fermeture du bureau).
    evt.listen("desktop-mode", (e) => {
      const active = !!(e.payload && e.payload.active);
      remoteDesktopModeActive = active;
      window.LumenOrb?.setEnabled(active ? false : (config.orbEnabled !== false));
      // « Toujours au-dessus » suspendu tant que le bureau Lumen Desktop est ouvert :
      // sinon la barre flotte en permanence PAR-DESSUS le bureau (qui a sa
      // propre barre de chat). Le réglage utilisateur est restauré à la fermeture.
      invoke("set_always_on_top", { alwaysOnTop: active ? false : config.alwaysOnTop }).catch(() => {});
      if (checkboxAlwaysOnTop) {
        checkboxAlwaysOnTop.checked = active ? false : !!config.alwaysOnTop;
        checkboxAlwaysOnTop.disabled = active;
        checkboxAlwaysOnTop.closest(".setting-row, .setting-item, .field")?.classList.toggle("desktop-disabled", active);
        checkboxAlwaysOnTop.title = active ? "Indisponible pendant le mode desktop" : "";
      }
    });
    // La barre de chat du bureau (fenêtre sandbox) délègue ses actions « panneaux »
    // (Réglages, Historique, Notifications, Heartbeat, Fluxo, Agents) à la vraie
    // barre Lumen : on ramène la fenêtre au premier plan et on clique le bouton.
    evt.listen("lumen-open", async (e) => {
      const id = (e.payload && (e.payload.id || e.payload)) || "";
      try { const w = window.__TAURI__?.window?.getCurrentWindow?.(); await w?.show?.(); await w?.setFocus?.(); } catch {}
      document.getElementById(id)?.click();
    });
    // Menu de la barre d'état et raccourci global : le Rust ne fait que réveiller
    // la fenêtre et transmettre la demande, la capture est faite ici.
    evt.listen("understand-screen", () => { understandScreenFromBar(); });
    evt.listen("understand-screen-region", () => { understandScreenRegionFromBar(); });
    // Résultat du tracé : la zone recadrée revient prête à partir au modèle.
    evt.listen("screen-selection", (e) => {
      // Zone demandée par une autre fenêtre (bureau Lumen OS) : pas pour nous.
      if (!regionRequestedHere) return;
      regionRequestedHere = false;
      const prompt = pendingRegionPrompt || t('understand_region_prompt');
      pendingRegionPrompt = null;
      sendScreenShot(e.payload, prompt);
    });
    evt.listen("open-inline-onboarding", async () => {
      try { const w = window.__TAURI__?.window?.getCurrentWindow?.(); await w?.show?.(); await w?.setFocus?.(); } catch {}
      openInlineOnboarding();
    });
    evt.listen("open-inline-settings", async () => {
      try { const w = window.__TAURI__?.window?.getCurrentWindow?.(); await w?.show?.(); await w?.setFocus?.(); } catch {}
      btnSettings?.click();
    });
    evt.listen("force-main-interactive", () => {
      clickThroughIgnoring = false;
      clickThroughSuspended = false;
      invoke("set_ignore_cursor_events", { ignore: false }).catch(() => {});
    });
    // « Ask Lumen » : requête injectée par un raccourci macOS (POST /ask).
    // On remplit la barre puis on déclenche l'envoi comme une saisie normale.
    evt.listen("ask-lumen", (e) => {
      const query = typeof e.payload === "string" ? e.payload : (e.payload?.text || "");
      if (!query.trim() || isGenerating) return;
      // Nouvelle conversation : évite que la sélection se mélange au fil en cours.
      startNewChat();
      handleSend(query);
    });
    // ⌥Espace : place le curseur dans la barre pour taper dans la foulée.
    evt.listen("focus-input", () => {
      // Léger délai : la fenêtre vient d'être affichée/refocalisée.
      requestAnimationFrame(() => {
        if (!chatInput) return;
        chatInput.focus();
        chatInput.select();
      });
    });
    evt.listen("settings-updated", async (e) => {
      const payload = e.payload && typeof e.payload === "object" ? e.payload : {};
      Object.entries(payload).forEach(([key, value]) => {
        if (value == null) return;
        localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
      });
      reloadConfigFromStorage(payload);
      pushOllamaConfig();
      applyI18n();
      applyConfigUI();
      applyWindowSize();
      applyHeartbeat();
      updateHeartbeatUI();
      updateFluxoToolsUI();
      updateActionModeUI();
      updateAutoSpeakUI();
      remotePushActionMode();
      remotePushOllamaMode();
      try { await invoke("set_always_on_top", { alwaysOnTop: config.alwaysOnTop && !remoteDesktopModeActive }); } catch {}
      applyHalo();
      fetchAvailableModels();
      checkOllamaStatus();
    });
    // Humeur de l'orbe à la fin d'une tâche d'agent : joie ou mine contrariée.
    evt.listen("agent-progress", (e) => {
      window.LumenOrb?.setMood?.(e.payload?.success === false ? 'sad' : 'joy', { ms: 2600 });
    });
    evt.listen("settings-draft", (e) => {
      const payload = e.payload && typeof e.payload === "object" ? e.payload : {};
      reloadConfigFromStorage(payload);
      applyConfigUI();
      if (Object.prototype.hasOwnProperty.call(payload, "barSize")) applyWindowSize();
      if (Object.prototype.hasOwnProperty.call(payload, "alwaysOnTop")) {
        invoke("set_always_on_top", { alwaysOnTop: config.alwaysOnTop && !remoteDesktopModeActive }).catch(() => {});
      }
      if (["halo", "haloPosition", "haloStyle"].some((k) => Object.prototype.hasOwnProperty.call(payload, k))) applyHalo();
      if (payload.avatarGlbReload === "true") window.LumenOrb?.reloadCustomAvatar?.();
      if (payload.previewPulse === "true") window.LumenOrb?.pulseHeart();
    });
  }
}

// ===== Compagnon mobile (miroir de la session sur le réseau local) =====
//
// Le backend Rust sert une page web mobile et un WebSocket. Ici on :
//   1. démarre le serveur et on retient l'URL (affichée dans les Paramètres) ;
//   2. pousse l'état de l'orbe et la transcription vers les téléphones ;
//   3. reçoit les requêtes du téléphone (« remote-command ») et les exécute
//      comme si elles avaient été tapées sur le Mac.
let companionInfo = null;
let remoteDesktopModeActive = false;

// Panneau d'étapes lu depuis le DOM (miroir compagnon / Lumen XR).
function planSnapshotFromDom(d) {
  return {
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
  };
}

function remotePush(obj) {
  // Diffusion best-effort : on n'interrompt jamais l'app si le serveur est off.
  invoke("remote_broadcast", { payload: JSON.stringify(obj) }).catch(() => {});
}

// Construit la transcription courante depuis le DOM (une seule source de vérité,
// quel que soit le moteur : Ollama, raccourci, Fluxo, mode Action).
function remoteSnapshotTranscript() {
  const bubbles = messagesList?.querySelectorAll(".message-bubble") || [];
  const messages = [];
  bubbles.forEach((b) => {
    const sender = b.classList.contains("user") ? "user" : "assistant";
    // La réponse finale vit dans `.msg-answer` (mode Action) ; sinon tout le
    // contenu (Ollama, raccourci simple). `innerText` préserve la mise en forme.
    const answerEl = b.querySelector(".msg-answer");
    let text;
    if (answerEl) {
      text = (answerEl.innerText || answerEl.textContent || "").trim();
    } else {
      // Sans `.msg-answer`, on retire les blocs repliables avant de lire le
      // texte : raisonnement et outils ne font pas partie de la réponse.
      const el = b.querySelector(".msg-text-content") || b;
      const clone = el.cloneNode(true);
      clone.querySelectorAll(".lm-blocks, .run-progress").forEach((n) => n.remove());
      text = (clone.textContent || "").trim();
    }
    // Raisonnement et appels d'outils, STRUCTURÉS : le compagnon les replie
    // comme le bureau, Lumen XR en affiche un résumé d'une ligne.
    let blocks;
    const blockEls = b.querySelectorAll(".lm-blocks > .lm-think, .lm-blocks > .lm-tool, .lm-blocks > .lm-plan");
    if (blockEls.length) {
      blocks = [];
      blockEls.forEach((d) => {
        const cut = (s) => { s = String(s || ""); return s.length > 3000 ? `${s.slice(0, 3000)}…` : s; };
        if (d.classList.contains("lm-plan")) {
          blocks.push({ kind: "plan", ...planSnapshotFromDom(d) });
        } else if (d.classList.contains("lm-think")) {
          blocks.push({ kind: "think", live: d.classList.contains("live"), label: d.querySelector(".lm-label")?.textContent || "", text: cut(d.querySelector(".lm-body")?.textContent) });
        } else {
          const done = d.classList.contains("done");
          blocks.push({ kind: "tool", name: d.dataset.tool || d.querySelector(".lm-name")?.textContent || "", args: cut(d.querySelector(".lm-args pre")?.textContent), ...(done ? { result: cut(d.querySelector(".lm-res pre")?.textContent) } : {}) });
        }
      });
    }
    // Étapes de progression du mode Action : envoyées STRUCTURÉES au mobile pour
    // qu'il les affiche avec les mêmes puces colorées que le bureau.
    let progress;
    const steps = b.querySelectorAll(".run-progress .run-step");
    if (steps.length) {
      progress = [];
      steps.forEach((s) => {
        // Image : on transmet le chemin relatif (le mobile le résout sur l'IP du Mac).
        if (s.dataset.kind === "image" && s.dataset.path) {
          progress.push({ kind: "image", path: s.dataset.path });
          return;
        }
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

function initRemoteCompanion() {
  const evt = window.__TAURI__?.event;

  // Port local 8765 pris par un autre programme : le compagnon réseau démarre
  // quand même, mais on prévient (notifications/widgets locaux indisponibles).
  evt?.listen("companion-port-conflict", (e) => {
    const msg = String(e?.payload?.message || "");
    console.warn(msg);   // l'alerte visible part du Rust (centre de notifications)
  });

  // 1) Démarrage du serveur LAN (idempotent côté Rust).
  invoke("companion_start")
    .then((info) => { companionInfo = info; updateCompanionUI(); })
    .catch((e) => console.error("Compagnon mobile : démarrage impossible :", e));

  // 2) Miroir de l'orbe : on enrobe setState pour pousser chaque changement.
  //    L'orbe est initialisé par orb.js (module distinct) ; on attend qu'il existe.
  const hookOrb = () => {
    if (!window.LumenOrb || window.LumenOrb.__remoteHooked) return false;
    const origState = window.LumenOrb.setState;
    window.LumenOrb.setState = function (next) {
      remotePush({ type: "orb", state: next });
      return origState.apply(this, arguments);
    };
    // Mode Action : reflète le jaune sur l'orbe du téléphone.
    const origAction = window.LumenOrb.setActionExecuting;
    if (origAction) {
      window.LumenOrb.setActionExecuting = function (on) {
        remotePush({ type: "action", on: !!on });
        return origAction.apply(this, arguments);
      };
    }
    window.LumenOrb.__remoteHooked = true;
    return true;
  };
  if (!hookOrb()) {
    const iv = setInterval(() => { if (hookOrb()) clearInterval(iv); }, 200);
    setTimeout(() => clearInterval(iv), 5000);
  }

  // 3) Miroir de la transcription : un observateur unique capte tous les chemins
  //    (messages utilisateur, streaming assistant, résultats d'action…).
  if (messagesList) {
    // Cadencé (et non « anti-rebond ») : pendant le streaming les mutations
    // ne s'arrêtent jamais, un anti-rebond n'envoyait donc rien avant la fin de
    // la réponse. Lumen XR lit la réponse au fil de l'eau : il faut du flux.
    let pending = null;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        remoteSnapshotTranscript();
        remotePushConversations(); // garde la liste du téléphone à jour
        remotePushActionMode();    // et l'état du mode Action
        remotePushOllamaMode();    // et l'état du mode Ollama unifié
        remotePushOrbAppearance(); // et l'apparence de l'orbe
      }, 150);
    });
    obs.observe(messagesList, { childList: true, subtree: true, characterData: true });
  }

  // 4) Commandes venues du téléphone + relais du Heartbeat vers l'orbe mobile.
  if (evt?.listen) {
    evt.listen("remote-command", (e) => {
      if (remoteDesktopModeActive) return;
      let cmd;
      try { cmd = JSON.parse(e.payload); } catch (_) { return; }
      handleRemoteCommand(cmd);
    });
    evt.listen("heartbeat-tick", () => {
      remotePush({
        type: "heartbeat",
        color: localStorage.getItem("orbHeartColor") || "#ff4d6d",
        strength: parseFloat(localStorage.getItem("orbPulseStrength") || "100"),
        speed: parseFloat(localStorage.getItem("orbPulseSpeed") || "100"),
      });
    });
  }
}

// Pousse le texte d'une réponse finale au(x) téléphone(s) pour la lecture auto
// locale (le téléphone). Diffusé quel que soit l'état de la lecture auto du
// bureau, afin que l'appareil puisse lire même quand le bureau, lui, ne lit pas. On envoie le
// texte *final* exact (et non l'indicateur de chargement).
let orbSpeechQueue = Promise.resolve();

function splitOrbSpeech(text) {
  const sentences = (text.trim().slice(0, 2000).match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || []);
  const out = [];
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    let part = "";
    for (const word of words) {
      if (part && (part.length + word.length + 1) > 180) {
        out.push(part); part = word;
      } else part += (part ? " " : "") + word;
    }
    if (part) out.push(part);
  }
  return out;
}

function cleanOrbSpeech(text) {
  // Nettoyage Markdown commun à la lecture vocale, puis suppression explicite
  // des pictogrammes Unicode et de leurs séquences (variation/ZWJ/keycap).
  return stripForSpeech(String(text || ""))
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\uFE0E\uFE0F\u200D\u20E3]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Génération de la voix de l'orbe : incrémentée par « stop » (bouton de la
// Fire, retournement face contre table, Stop du bureau) pour que les packs
// restants ne partent plus.
let orbSpeechGen = 0;
window.addEventListener("lumen-orb-stop-speech", () => { orbSpeechGen++; });

async function sendOrbSpeech(text) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!window.OrbBridge?.connected || !invoke) return;
  const gen = orbSpeechGen;
  const sentences = splitOrbSpeech(cleanOrbSpeech(text));
  for (let i = 0; i < sentences.length; i += 2) {
    if (gen !== orbSpeechGen) return;
    // Deux phrases par synthèse/transfert : moins de coupures et le second
    // buffer du M5 peut se remplir pendant la lecture du précédent.
    const pack = sentences.slice(i, i + 2).join(" ");
    await invoke("tts_send_to_orb", { text: pack, voice: null });
    // Le double buffer du M5 attend lui-même la fin réelle de la lecture.
    // Lumen précharge donc le pack suivant presque immédiatement.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Délégation à un agent doté d'une voix : le casque lit la suite du tour avec elle.
window.addEventListener("lumen-agent-voice", (e) => remotePush({ type: "turn-voice", voice: e.detail?.voice || "" }));

function remoteSpeak(text) {
  if (typeof text === "string" && text.trim()) {
    // Le téléphone affiche la réponse : il garde les renvois. L'orbe la
    // prononce : elle, non.
    remotePush({ type: "answer", text });
    if (window.OrbBridge?.connected) {
      const spoken = stripCitations(text);
      // Sous-titre : la réponse s'affiche sur l'écran de l'orbe pendant qu'elle
      // est lue (M5 Fire « charm »), sans les renvois de sources.
      window.OrbBridge.pushCaption?.(cleanOrbSpeech(spoken));
      window.OrbBridge.pushActivity?.("speaking");
      orbSpeechQueue = orbSpeechQueue.then(() => sendOrbSpeech(spoken))
        .catch((e) => console.warn("[OrbBridge] réponse audio", e));
    }
  }
}

// État de la lecture auto du Mac, reflété sur le téléphone (pour le sélecteur
// bureau / appareil / les deux).
function remotePushAutospeak() {
  remotePush({ type: "autospeak", on: !!config.autoSpeak });
}

// État du mode Action poussé vers le téléphone. En source Apple, il reflète le
// raccourci Action Router. En sources Fluxo (Ollama/API), il sert de raccourci
// vers le mode Routeur du sélecteur de discussion.
// Apparence de l'orbe poussée vers le(s) téléphone(s).
//
// Le compagnon a son PROPRE localStorage : sans cet envoi, il affiche la palette
// par défaut pendant que le Mac arbore le thème choisi — deux orbes différents
// pour le même assistant. On envoie exactement les clés que lit
// `LumenOrb.applyAppearance`, à deux exceptions près :
//   • `orbSize` : le téléphone a la sienne (petit écran), d'où `keepSize` côté
//     compagnon ;
//   • `orbAvatarMode` : un avatar GLB personnalisé vit dans les fichiers du Mac,
//     le téléphone ne peut pas le charger — il reste donc sur l'orbe.
function remotePushOrbAppearance() {
  const keys = [
    "orbTheme", "orbColors", "orbGlassType", "orbCoreScale", "orbPulse",
    "orbHeartbeat", "orbHeartColor", "orbPulseStrength", "orbPulseSpeed", "orbMouth",
  ];
  const payload = {};
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value != null) payload[key] = value;
  }
  remotePush({ type: "orb-appearance", payload });
}

function remotePushActionMode() {
  const fluxoMode = config.aiSource === "ollama" || config.aiSource === "llama" || isApiLike(config.aiSource);
  remotePush({
    type: "action-mode",
    active: fluxoMode ? config.ollamaMode === "router" : !!config.actionModeActive,
    available: config.aiSource === "shortcut" || fluxoMode,
  });
}

// État du mode unifié poussé vers le téléphone. Disponible en source Ollama et
// API cloud : dans les deux cas les modes routeur/outils/workflow passent par
// Fluxo, avec le backend actif configuré côté Rust.
async function remotePushOllamaMode() {
  const available = config.aiSource === "ollama" || config.aiSource === "llama" || isApiLike(config.aiSource);
  let workflows = [];
  if (available) {
    try { workflows = await invoke("list_fluxo_workflows"); } catch (_) { workflows = []; }
  }
  remotePush({
    type: "llm-mode",
    available,
    mode: config.ollamaMode,
    source: config.aiSource,
    orchestrate: !!config.orchestrate,
    workflow: config.ollamaWorkflow || "",
    label: ollamaModeLabel(),
    modes: ["chat", "rag", "router", "tools", "docs"].map((m) => ({
      id: m, label: t(OLLAMA_MODES[m].labelKey), desc: t(OLLAMA_MODES[m].descKey),
    })),
    workflows,
  });
}

// Notifications du Heartbeat, poussées vers le(s) téléphone(s).
function remotePushNotifications() {
  remotePush({
    type: "notifications",
    items: heartbeatNotifications.map((n) => ({
      shortcut: n.shortcut,
      output: n.output,
      success: n.success,
      timestamp: n.timestamp,
    })),
  });
}

// Backends et modèles disponibles, poussés vers le(s) téléphone(s).
//
// Le compagnon propose exactement les mêmes choix que la pastille de modèle du
// bureau (source d'IA puis modèle de cette source), sans jamais dupliquer la
// logique : la liste des modèles est demandée aux mêmes commandes Rust.
async function remotePushBackends() {
  const source = config.aiSource || "ollama";
  // MÊME liste que le menu Backend de la barre : avant, le téléphone recevait
  // une liste figée (sans Apple Foundation Models ni Lumen Server) et ne
  // savait pas nommer la source active.
  const sources = backendCycleSources().map(([id, label]) => ({ id, label }));
  try {
    if ((await lumenServerBackendState()).available) sources.splice(3, 0, { id: "lumen", label: "Lumen Server" });
  } catch { /* serveur absent */ }
  if (!sources.some((s) => s.id === source)) sources.push({ id: source, label: source });

  let models = [];
  let model = "";
  // Libellés lisibles des modèles (Apple : « sur l'appareil » / PCC) et où
  // ils tournent : "local" (cet ordinateur), "device" (puce Apple), "cloud".
  const modelLabels = {};
  let where = "local";
  if (source === "applefm") {
    model = cloudModel(source);
    const usable = APPLEFM_MODELS.filter((m) => config.applefmModels.some((x) => x.id === m.id && x.available));
    for (const m of usable.length ? usable : APPLEFM_MODELS.slice(0, 1)) { models.push(m.id); modelLabels[m.id] = m.label; }
    where = model === "apple-private-cloud" ? "cloud" : "device";
  } else if (source === "shortcut") {
    where = "device";
  } else if (isApiLike(source)) {
    where = "cloud";
    model = cloudModel(source);
    // Catalogue réel de l'endpoint configuré. La clé reste côté Rust : le
    // téléphone ne reçoit que des noms de modèles.
    try { models = await invoke("llm_cloud_models"); } catch (_) { models = []; }
    if (model && !models.includes(model)) models = [model, ...models];
  } else if (source === "ollama" || source === "llama") {
    model = currentModel || config.selectedModel || "";
    try { models = await listOllamaModels(config.ollamaUrl); } catch (_) { models = []; }
  }

  remotePush({
    type: "backend",
    source,
    sourceLabel: sources.find((s) => s.id === source)?.label || source,
    sources,
    model,
    modelLabel: modelLabels[model] || "",
    modelLabels,
    where,
    models: Array.isArray(models) ? models.filter(Boolean) : [],
    think: !!config.ollamaThink,
    thinkAvailable: source === "ollama" || source === "llama",
    vision: VISION_SOURCES.includes(source),
  });
}

// Pièces jointes de la discussion courante, poussées vers le(s) téléphone(s).
// `mode` distingue le document parti entier dans le contexte de celui qui a été
// indexé (RAG) : le téléphone affiche la même nuance que le bureau.
function remotePushDocs() {
  remotePush({
    type: "docs",
    items: chatDocs.map((d) => ({ name: d.name, mode: d.mode, chars: d.chars })),
    images: pendingImages.length,
  });
}

// Catalogues des mentions « @ » (outils) et « # » (documents), poussés vers le(s)
// compagnon(s). Le téléphone n'a accès ni aux commandes Tauri ni aux sandboxes :
// il affiche la liste calculée ici, exactement la même qu'au bureau.
async function remotePushMentions() {
  let tools = [], files = [];
  try { tools = await mentionToolItems(); } catch { tools = []; }
  try { files = await mentionFileItems(); } catch { files = []; }
  remotePush({ type: "mentions", tools, files });
}

// Liste des conversations enregistrées, poussée vers le(s) téléphone(s).
function remotePushConversations() {
  let items = [];
  try {
    items = (JSON.parse(localStorage.getItem("saved_conversations")) || [])
      .map((c) => ({ id: c.id, title: c.title }));
  } catch (_) {}
  remotePush({ type: "conversations", items, currentId: currentConversationId });
}

// ---- Lumen XR : transcription en continu --------------------------------------
const xrStt = new Map(); // id → { parts: Float32Array[], samples, doneAt, chain }
function xrPcmFromB64(b64) {
  const bin = atob(b64 || "");
  const n = bin.length >> 1;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    pcm[i] = v / 32768;
  }
  return pcm;
}
/// Modèle Whisper choisi dans les Réglages du casque (`model`), s'il est connu ;
/// sinon celui du bureau.
function xrWhisperOpts(model) {
  return WHISPER_MODELS.some((m) => m.id === model) ? { modelId: model } : {};
}
function xrSttAppend(id, b64, model) {
  if (id == null) return;
  let st = xrStt.get(id);
  if (!st) {
    st = { parts: [], samples: 0, doneAt: 0, chain: Promise.resolve(), busy: false, t: Date.now(), opts: xrWhisperOpts(model) };
    xrStt.set(id, st);
    // Ménage : un enregistrement abandonné ne doit pas rester en mémoire.
    for (const [k, v] of xrStt) if (Date.now() - v.t > 120000) xrStt.delete(k);
  }
  if (b64) {
    const pcm = xrPcmFromB64(b64);
    st.parts.push(pcm);
    st.samples += pcm.length;
  }
}
function xrSttConcat(st) {
  const out = new Float32Array(st.samples);
  let o = 0;
  for (const p of st.parts) { out.set(p, o); o += p.length; }
  return out;
}
function xrSttMaybePartial(id) {
  const st = xrStt.get(id);
  // Une seule transcription partielle à la fois, et seulement si le tampon a
  // grossi d'au moins une seconde (16 000 échantillons) depuis la précédente.
  if (!st || st.busy || st.samples - st.doneAt < 16000) return;
  st.busy = true;
  st.doneAt = st.samples;
  // Sous-titre = les 6 DERNIÈRES secondes seulement. Retranscrire tout le
  // tampon à chaque seconde coûtait de plus en plus cher (quadratique), et la
  // transcription finale attendait derrière : « Transcription… » interminable.
  const all = xrSttConcat(st);
  const pcm = all.length > 16000 * 6 ? all.subarray(all.length - 16000 * 6) : all;
  st.chain = whisperTranscribe(pcm, undefined, st.opts)
    .then((text) => { if (xrStt.has(id)) remotePush({ type: "xr-stt-partial", id, text: String(text || "").trim() }); })
    .catch(() => {})
    .finally(() => { st.busy = false; });
}

// ---- Lumen XR : App Intents exécutées par le bureau ----------------------------
let xrIntentSeq = 0;
const xrIntentWaiting = new Map();
window.__TAURI__?.event?.listen?.("xr-intent-result", (e) => {
  const r = e.payload || {};
  const done = xrIntentWaiting.get(r.reqId);
  if (!done) return;
  xrIntentWaiting.delete(r.reqId);
  done(r);
});
function xrRunIntent(cmd) {
  const reqId = ++xrIntentSeq;
  const reply = (r) => remotePush({ type: "xr-app-result", id: cmd.id, appId: cmd.appId, intentId: cmd.intentId, text: r.text ?? "", error: r.error });
  const timer = setTimeout(() => {
    // Code d'erreur, traduit par le casque : le bureau n'a pas répondu.
    if (xrIntentWaiting.delete(reqId)) reply({ error: "desktop-closed" });
  }, 25000);
  xrIntentWaiting.set(reqId, (r) => { clearTimeout(timer); reply(r); });
  window.__TAURI__?.event?.emit?.("xr-intent-request", { reqId, appId: cmd.appId, intentId: cmd.intentId, args: cmd.args || {} });
}

// Apparence de l'orbe (palette, verre, cœur, bouche) : Lumen XR dessine la
// même orbe que le bureau et doit donc porter le même thème.
function remotePushOrbLook() {
  let colors = null;
  try { colors = JSON.parse(localStorage.getItem("orbColors") || "null"); } catch {}
  remotePush({
    type: "orb-look",
    colors: Array.isArray(colors) && colors.length === 5 ? colors : null,
    glass: localStorage.getItem("orbGlassType") || "thin",
    heart: localStorage.getItem("orbHeartColor") || "#ff4d6d",
    mouth: localStorage.getItem("orbMouth") === "true",
  });
}

/// Lumen XR › « traduis ça » (option « modèle du Mac ») : le casque a lu le
/// texte lui-même (OCR) ; le modèle DÉJÀ chargé le traduit — aucun modèle de
/// vision à charger, juste une courte génération.
async function xrTranslateText(cmd) {
  const text = String(cmd.text || "").slice(0, 4000);
  if (!text.trim()) { remotePush({ type: "xr-translation", id: cmd.id, text: "" }); return; }
  try {
    const { messages, opts } = CORE_PROMPTS["core.xr.translate"].build({ text, target: String(cmd.target || "français"), lang: getLang() === "en" ? "en" : "fr" });
    const { content } = await llmChat(messages, { ...opts, rawSystem: true, source: "xr-translate" });
    remotePush({ type: "xr-translation", id: cmd.id, text: String(content || "").trim() });
  } catch (e) {
    remotePush({ type: "xr-translation", id: cmd.id, text: "", error: String(e?.message || e) });
  }
}

const xrCheckSpeech = (text) => checkSpeech(text, { chat: llmChat });

let xrVisionBusy = false;
async function xrVisionLabels(cmd) {
  if (xrVisionBusy || typeof cmd.image !== "string" || !cmd.image.startsWith("data:image/")) return;
  if (!VISION_SOURCES.includes(config.aiSource)) { remotePush({ type: "xr-labels", id: cmd.id, items: [], error: "no-vision" }); return; }
  xrVisionBusy = true;
  try {
    const b64 = cmd.image.slice(cmd.image.indexOf(",") + 1);
    const { messages, opts } = CORE_PROMPTS["core.xr.labels"].build({ image: b64, lang: getLang() === "en" ? "en" : "fr" });
    const { content } = await llmChat(messages, { ...opts, rawSystem: true });
    const m = String(content || "").match(/\[[\s\S]*\]/);
    let items = [];
    try { items = m ? JSON.parse(m[0]) : []; } catch { items = []; }
    items = (Array.isArray(items) ? items : [])
      .filter((it) => it && typeof it.label === "string" && Number.isFinite(+it.x) && Number.isFinite(+it.y))
      .slice(0, 6)
      .map((it) => ({ label: it.label.slice(0, 40), x: Math.min(1, Math.max(0, +it.x)), y: Math.min(1, Math.max(0, +it.y)) }));
    remotePush({ type: "xr-labels", id: cmd.id, items });
  } catch (e) {
    remotePush({ type: "xr-labels", id: cmd.id, items: [], error: String(e?.message || e) });
  } finally {
    xrVisionBusy = false;
  }
}

// ---- Messages du téléphone / casque : file d'attente + accusés ---------------
// Un message reçu pendant une réponse n'est plus refusé (« Je termine
// d'abord… ») : il attend son tour. Chaque message porteur d'un `id` reçoit un
// accusé `{type:"ack", id}` dès qu'il est ACCEPTÉ (démarré ou mis en file) ; le
// téléphone ne le retire de sa file hors ligne qu'à ce moment-là. Un `id` déjà
// vu (renvoi après une coupure) est ré-accusé sans être exécuté deux fois.
const remoteChatQueue = [];
const remoteSeenIds = new Map(); // id → horodatage
let remoteQueueTimer = null;
// handleSend attend (mentions, documents) AVANT de lever isGenerating : sans
// ce drapeau, deux messages de la file pourraient démarrer ensemble.
let remoteChatRunning = false;

function remoteDuplicate(cmd) {
  const id = typeof cmd.id === "string" ? cmd.id.slice(0, 80) : "";
  if (!id) return false;
  const now = Date.now();
  for (const [k, t] of remoteSeenIds) if (now - t > 24 * 3600e3) remoteSeenIds.delete(k);
  const dup = remoteSeenIds.has(id);
  if (!dup) remoteSeenIds.set(id, now);
  remotePush({ type: "ack", id, duplicate: dup });
  return dup;
}

// Langue changée dans les Réglages (autre fenêtre) : casque et M5 suivent.
window.addEventListener("storage", (e) => {
  if (e.key !== "lang") return;
  const lang = getLang() === "en" ? "en" : "fr";
  remotePush({ type: "lumen-lang", lang });
  window.OrbBridge?.pushLang?.(lang);
});
let pendingVoiceBrief = false;
// Porte « demandes à l'utilisateur » des requêtes du casque (déverrouillage).
let xrGateInst = null;
function xrEnsureUnlocked() {
  if (!xrGateInst) xrGateInst = createUserGate({
    invoke, lang: getLang(),
    // Carte FLOTTANTE (en bas à droite, fond opaque) : avant, faute d'hôte,
    // elle tombait dans <body> et se superposait en haut à gauche de la fenêtre.
    host: () => {
      let box = document.getElementById("xr-gate-host");
      if (!box) {
        box = document.createElement("div");
        box.id = "xr-gate-host";
        box.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:9999;max-width:360px;padding:14px 16px;border-radius:14px;background:var(--popover,var(--background,#fff));color:var(--foreground,#111);border:1px solid var(--border,rgba(0,0,0,.12));box-shadow:var(--shadow-3,0 10px 30px rgba(0,0,0,.18))";
        document.body.appendChild(box);
      }
      box.hidden = false;
      return box;
    },
    announce: (text) => invoke("notify_island", { payload: { kind: "info", title: "Lumen XR", body: text, icon: "", source: "lumen-xr" } }).catch(() => {}),
    push: remotePush,
  });
  return xrGateInst.ensureUnlocked().catch(() => false).then((ok) => {
    // Réponse donnée : la carte disparaît après un court instant.
    setTimeout(() => { const box = document.getElementById("xr-gate-host"); if (box) { box.innerHTML = ""; box.hidden = true; } }, 2500);
    return ok;
  });
}
function startRemoteChat(cmd) {
  pendingVoiceBrief = !!cmd.voice;
  // Image jointe DANS le même message (Lumen XR « Regarde ») : plus de
  // course entre « attach-image » et « chat » envoyés séparément.
  if (typeof cmd.image === "string" && cmd.image.startsWith("data:image/")) {
    if (!VISION_SOURCES.includes(config.aiSource)) showDictationHint(t('doc_no_vision'));
    else pendingImages.push({ dataUrl: cmd.image, b64: cmd.image.slice(cmd.image.indexOf(",") + 1) });
    renderAttachPreview();
  }
  // Fiches du coffre jointes depuis le téléphone (ids du coffre unifié).
  if (Array.isArray(cmd.records)) pendingPinnedRecords = cmd.records.filter((x) => typeof x === "string").slice(0, 5);
  chatInput.value = cmd.text;
  autosizeChatInput();
  remoteChatRunning = true;
  Promise.resolve(handleSend()).catch(() => {}).finally(() => { remoteChatRunning = false; });
}

function drainRemoteChat() {
  if (isGenerating || remoteChatRunning) return;
  const next = remoteChatQueue.shift();
  if (next) startRemoteChat(next);
  if (!remoteChatQueue.length) { clearInterval(remoteQueueTimer); remoteQueueTimer = null; }
}

function acceptRemoteChat(cmd) {
  if (remoteDuplicate(cmd)) return;
  if (!isGenerating && !remoteChatRunning && !remoteChatQueue.length) { startRemoteChat(cmd); return; }
  if (remoteChatQueue.length >= 50) {
    remotePush({ type: "announce", text: getLang() === "en" ? "Too many pending messages." : "Trop de messages en attente." });
    return;
  }
  remoteChatQueue.push(cmd);
  if (!cmd.id) {
    // Casque / commande vocale sans file côté appareil : on dit que c'est noté.
    remotePush({ type: "announce", text: getLang() === "en" ? "Noted, I'll answer right after." : "C'est noté, je réponds juste après." });
  }
  // Pas de crochet unique sur la fin d'une génération (plusieurs chemins
  // remettent isGenerating à faux) : une sonde légère suffit.
  if (!remoteQueueTimer) remoteQueueTimer = setInterval(drainRemoteChat, 400);
}

function handleRemoteCommand(cmd) {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.type) {
    case "chat":
      if (typeof cmd.text === "string" && cmd.text.trim()) acceptRemoteChat(cmd);
      break;
    case "clear":
      btnClearChat?.click();
      break;
    case "list-conversations":
      remotePushOrbLook();
      remotePushConversations();
      remotePushActionMode();
      remotePushOllamaMode();
      remotePushNotifications();
      remotePushAutospeak();
      remotePushBackends();
      remotePushDocs();
      remotePushMentions();
      remotePush({ type: "orchestrate", on: !!config.orchestrate });
      remotePush({ type: "lumen-lang", lang: getLang() === "en" ? "en" : "fr" });   // Lumen XR suit la langue de Lumen
      break;
    case "set-orchestrate":
      setOrchestrate(!!cmd.on);
      break;
    case "stop-generation":
      // « Stop » dit dans le casque / sur le téléphone : même effet que la
      // manette — lecture, génération et annonces en attente s'arrêtent.
      if (isGenerating || isSpeaking) stopFromController();
      break;
    case "user-answer":
      // Réponse du téléphone à une demande (accord sandbox, confirmation…).
      if (cmd.id) answerUserRequest(String(cmd.id), String(cmd.choice || ""));
      break;
    case "list-backends":
      remotePushBackends();
      break;
    case "set-backend":
      if (cmd.id && cmd.id !== config.aiSource) {
        // Le casque attend une réponse (« Bascule… ») : on la lui renvoie
        // TOUJOURS, échec compris — avant, une erreur en route le laissait
        // bloqué sans rien dire, et la source semblait ne jamais changer.
        setAiSourceFromPanel(cmd.id)
          .catch((e) => {
            console.warn("[XR] set-backend", cmd.id, e);
            remotePush({ type: "announce", text: (getLang() === "en" ? "Backend switch failed: " : "Changement de backend impossible : ") + String(e?.message || e).slice(0, 140) });
          })
          .finally(() => {
            remotePushBackends();
            remotePushOllamaMode();
            remotePushActionMode();
          });
      } else {
        remotePushBackends();
      }
      break;
    case "set-model": {
      const source = config.aiSource || "ollama";
      const name = String(cmd.model || "").trim();
      if (!name) break;
      if (isApiLike(source)) {
        setCloudModel(name, source);
        pushOllamaConfig(); updateModelLabel(); checkOllamaStatus();
      } else if (source === "ollama" || source === "llama") {
        currentModel = name;
        config.selectedModel = name;
        rememberModelFor(source, name);
        updateModelLabel(); pushOllamaConfig();
        // Comme au bureau : changer de GGUF, c'est redémarrer llama-server.
        if (source === "llama") startLlamaModel(name);
        checkOllamaStatus();
      }
      remotePushBackends();
      break;
    }
    case "set-think":
      config.ollamaThink = !!cmd.on;
      localStorage.setItem("ollamaThink", config.ollamaThink.toString());
      if (checkboxOllamaThink) checkboxOllamaThink.checked = config.ollamaThink;
      remotePushBackends();
      break;
    case "attach-doc":
      if (typeof cmd.b64 === "string" && cmd.b64) {
        addDocBytes(String(cmd.name || "document"), cmd.b64)
          .catch((e) => console.warn("[Compagnon] pièce jointe", e))
          .finally(() => remotePushDocs());
      }
      break;
    case "remove-doc": {
      const idx = chatDocs.findIndex((d) => d.name === cmd.name);
      if (idx >= 0) removeChatDoc(idx);
      break;
    }
    case "attach-image":
      // Vision : le téléphone envoie l'image telle quelle (data URL), comme le
      // ferait un collage au bureau. Refusé hors backend multimodal.
      if (typeof cmd.dataUrl === "string" && cmd.dataUrl.startsWith("data:image/")) {
        if (!VISION_SOURCES.includes(config.aiSource)) {
          showDictationHint(t('doc_no_vision'));
        } else {
          const url = cmd.dataUrl;
          pendingImages.push({ dataUrl: url, b64: url.slice(url.indexOf(",") + 1) });
          renderAttachPreview();
        }
      }
      break;
    case "clear-images":
      clearPendingImages();
      break;
    case "list-docs":
      remotePushDocs();
      break;
    case "list-mentions":
      remotePushMentions();
      break;
    case "xr-voice":
      xrVoiceUntil = cmd.on ? Date.now() + 25000 : 0;
      break;
    case "xr-vision":
      // « Regarde en continu » (Lumen XR) : repérage des objets de l'image,
      // HORS conversation — la réponse ne va qu'au casque, qui pose des
      // étiquettes dans la pièce.
      xrVisionLabels(cmd);
      break;
    case "xr-audio-cancel":
      // Écoute abandonnée (rien dit) : le tampon est jeté, rien n'est transcrit.
      xrStt.delete(cmd.id);
      break;
    case "xr-audio-part":
      // Lumen XR, transcription EN CONTINU : le casque envoie la voix par
      // morceaux pendant qu'on parle ; on retranscrit le tampon accumulé dès
      // qu'il a grossi d'une seconde, et le texte partiel part en sous-titre.
      xrSttAppend(cmd.id, cmd.pcm16, cmd.model);
      xrSttMaybePartial(cmd.id);
      break;
    case "xr-stt-check":
      xrCheckSpeech(String(cmd.text || "")).then((out) => remotePush({ type: "xr-stt", id: cmd.id, ...out }));
      break;
    case "xr-audio":
      // Lumen XR : le casque enregistre la voix (PCM 16 kHz mono, int16 en
      // Base64) et c'est Whisper, ici, qui transcrit (modèle choisi dans les
      // Réglages du casque ; la reconnaissance du navigateur du casque, quand
      // elle existe, ne passe pas par ici). Le casque décide ensuite quoi faire
      // du texte (discussion, ou « Regarde… » avec une capture caméra).
      // `stream: true` : ce n'est que la FIN d'un enregistrement déjà reçu
      // par morceaux (`xr-audio-part`).
      if (typeof cmd.pcm16 === "string") {
        (async () => {
          try {
            let pcm;
            if (cmd.stream) {
              xrSttAppend(cmd.id, cmd.pcm16, cmd.model);
              const st = xrStt.get(cmd.id);
              xrStt.delete(cmd.id);
              await st?.chain; // un partiel en cours finit d'abord (worker sériel)
              pcm = st ? xrSttConcat(st) : new Float32Array(0);
            } else {
              pcm = xrPcmFromB64(cmd.pcm16);
            }
            const text = pcm.length ? String(await whisperTranscribe(pcm, undefined, xrWhisperOpts(cmd.model)) || "").trim() : "";
            // Transcription basique : le texte de Whisper tel quel (plus de
            // relecture/réparation par le LLM, qui ralentissait et déformait).
            remotePush({ type: "xr-stt", id: cmd.id, text, checked: true });
          } catch (e) {
            remotePush({ type: "xr-stt", id: cmd.id, text: "", error: String(e?.message || e) });
          }
        })();
      }
      break;
    case "xr-domo-list":
      // Lumen XR › Domotique : objets connus (sans les clés).
      invoke("domotique_devices_summary")
        .then((raw) => remotePush({ type: "xr-domo", devices: JSON.parse(raw || "[]") }))
        .catch(() => remotePush({ type: "xr-domo", devices: [] }));
      break;
    case "xr-domo-cmd":
      // Commande signée vers un objet (on / off / toggle…), puis son état.
      (async () => {
        const reference = String(cmd.device || "");
        try {
          const out = await invoke("domotique_device_cmd", {
            reference, component: cmd.component || null, action: String(cmd.action || "toggle"),
            params: cmd.params && typeof cmd.params === "object" ? cmd.params : {},
          });
          remotePush({ type: "xr-domo-result", id: cmd.id, device: reference, ok: true, out: String(out).slice(0, 400) });
        } catch (e) {
          remotePush({ type: "xr-domo-result", id: cmd.id, device: reference, ok: false, error: String(e) });
        }
      })();
      break;
    case "xr-domo-state":
      invoke("domotique_device_state", { reference: String(cmd.device || "") })
        .then((out) => remotePush({ type: "xr-domo-state", device: cmd.device, state: String(out).slice(0, 400) }))
        .catch((e) => remotePush({ type: "xr-domo-state", device: cmd.device, error: String(e) }));
      break;
    case "xr-mirror-frame":
      // Recopie de l'écran : une image à la fois, le casque redemande la
      // suivante à réception (le débit s'adapte seul au réseau et au Mac).
      invoke("screen_mirror_frame", { mode: String(cmd.mode || "screen"), maxWidth: Number(cmd.maxWidth) || 1600 })
        .then((f) => remotePush({ type: "xr-mirror", id: cmd.id, image: f.image, width: f.width, height: f.height }))
        .catch((e) => remotePush({ type: "xr-mirror", id: cmd.id, error: String(e) }));
      break;
    case "xr-app-list":
      // Apps installées qui exposent des App Intents (vues pour le casque).
      invoke("app_list")
        .then((apps) => remotePush({
          type: "xr-app-list",
          apps: (apps || []).filter((a) => (a.intents || []).length).map((a) => ({
            id: a.id, name: a.name, icon: a.icon, xr: a.xr || null,
            intents: (a.intents || []).map((it) => ({ id: it.id, title: it.title, required: it.required || [], parameters: it.parameters || {} })),
          })),
        }))
        .catch(() => remotePush({ type: "xr-app-list", apps: [] }));
      break;
    case "xr-app-intent":
      // L'intention s'exécute dans le BUREAU Lumen (c'est lui qui héberge les
      // apps) : on la lui passe par un évènement et on attend sa réponse.
      xrRunIntent(cmd);
      break;
    case "xr-docs-list":
      // Lumen XR › Documents : les mêmes documents que le menu « # » (Corpus +
      // fichiers des sandboxes), sans leur contenu.
      mentionFileItems()
        .then((items) => remotePush({ type: "xr-docs", items }))
        .catch(() => remotePush({ type: "xr-docs", items: [] }));
      break;
    case "xr-morning-config":
      // Réglages du rituel dictés dans le casque (thèmes, ville) : fusion
      // dans morning.json, puis renvoi de la configuration à jour.
      (async () => {
        const cur = (await invoke("morning_config_get").catch(() => null)) || {};
        const next = { ...cur, ...(cmd.patch && typeof cmd.patch === "object" ? cmd.patch : {}) };
        if (cmd.patch) await invoke("morning_config_set", { config: next }).catch(() => {});
        remotePush({ type: "xr-morning-config", config: { city: next.city || "", topics: Array.isArray(next.topics) ? next.topics : [] } });
      })();
      break;
    case "xr-morning-brief":
      // Lumen XR › rituel du matin : météo, actualité des thèmes, projets,
      // semaine — assemblés côté Rust en un appel (morning.rs).
      invoke("morning_brief")
        .then((brief) => remotePush({ type: "xr-morning", id: cmd.id, brief }))
        .catch(() => remotePush({ type: "xr-morning", id: cmd.id, brief: { weather: null, news: [], projects: [], events: [] } }));
      break;
    case "xr-translate-text":
      xrTranslateText(cmd);
      break;
    case "xr-sandboxes":
      // Lumen XR › Bureau : chaque sandbox devient un dossier 3D.
      invoke("sandbox_list_names")
        .then((list) => remotePush({ type: "xr-sandboxes", items: (list || []).map((sb) => ({ id: sb.id, name: sb.name || sb.id })) }))
        .catch(() => remotePush({ type: "xr-sandboxes", error: true }));
      break;
    case "xr-sandbox-dir":
      // Contenu d'un dossier ouvert dans le casque (fichiers + sous-dossiers).
      // Session verrouillée (Lumen relancé sans reconnexion…) → on DEMANDE
      // l'accès (carte de mot de passe sur le Mac, relayée au casque et au
      // compagnon) au lieu de renvoyer un dossier « vide ».
      xrEnsureUnlocked().then((ok) => ok ? invoke("sandbox_read_dir", { id: String(cmd.sandboxId || ""), path: String(cmd.path || "") }) : Promise.reject("locked"))
        .then((entries) => remotePush({
          type: "xr-sandbox-dir", id: cmd.id, sandboxId: cmd.sandboxId, path: cmd.path || "",
          entries: (entries || []).filter((e) => !String(e.name).startsWith("."))
            .sort((a, b) => (b.is_dir - a.is_dir) || String(a.name).localeCompare(String(b.name)))
            .slice(0, 200).map((e) => ({ name: e.name, path: e.path, is_dir: !!e.is_dir, size: e.size || 0 })),
        }))
        .catch((e) => {
          console.warn("[xr] sandbox_read_dir", cmd.sandboxId, e);
          const err = String(e || "");
          remotePush({ type: "xr-sandbox-dir", id: cmd.id, sandboxId: cmd.sandboxId, path: cmd.path || "", entries: [],
            error: /session|verrouill|locked/i.test(err) ? "accès refusé : Lumen reste verrouillé sur le Mac." : err.slice(0, 160) });
        });
      break;
    case "xr-doc-read": {
      // Texte d'un document pour le panneau de lecture du casque.
      const it = cmd.item || {};
      const title = String(it.label || it.path || "document");
      const done = (text, error) => remotePush({ type: "xr-doc", id: cmd.id, title, text: String(text || ""), error });
      if (it.docId) {
        invoke("rag_doc_text", { docId: String(it.docId), maxChars: 120000 })
          .then((t) => done(t)).catch((e) => done("", String(e)));
      } else if (it.sandboxId && it.path) {
        invoke("sandbox_read_file", { id: String(it.sandboxId), path: String(it.path) })
          .then((f) => done(f?.binary ? "" : f?.content, f?.binary ? "binary" : undefined))
          .catch((e) => done("", String(e)));
      } else done("", "unknown");
      break;
    }
    case "xr-data-list":
      // Lumen XR › Données : bases et tables (Tables / Prisme).
      (async () => {
        const bases = [];
        try {
          for (const b of (await tablesDb.listBases()) || []) {
            let tables = [];
            try { tables = (await tablesDb.listTables(b.base_id)) || []; } catch {}
            bases.push({ id: b.base_id, name: b.name,
              tables: tables.map((t) => ({ id: t.table_id, name: t.name, rows: t.rows })) });
          }
        } catch {}
        remotePush({ type: "xr-tables", bases });
      })();
      break;
    case "xr-data-read":
      // Vue simplifiée d'une table : colonnes + 200 premières lignes. Le casque
      // en fait un tableau et un graphique, sans embarquer l'app entière.
      (async () => {
        try {
          const id = String(cmd.tableId || "");
          const cols = (await tablesDb.tableSchema(id)) || [];
          const data = await tablesDb.rows(id, 200, 0);
          remotePush({
            type: "xr-table", id: cmd.id, tableId: id, name: String(cmd.name || ""),
            columns: cols.map((c) => ({ id: c.col_id, name: c.name, type: c.type })),
            rows: data?.rows || [],
          });
        } catch (e) {
          remotePush({ type: "xr-table", id: cmd.id, error: String(e) });
        }
      })();
      break;
    case "xr-decide": {
      // Lumen XR : une phrase qu'aucune commande locale n'a reconnue. Le
      // moteur de décision (Tev1, ~0,1 s) dit si c'est une action du casque
      // (ouvrir un panneau, regarder, mode focus…) ou une question pour Lumen.
      const decider = appDecider({ aiSource: config.aiSource, ollamaUrl: config.ollamaUrl, invoke });
      (decider ? decider.decide("xrIntent", { text: String(cmd.text || "") }).catch(() => null) : Promise.resolve(null))
        .then((r) => remotePush({ type: "xr-decision", id: cmd.id, intent: r?.value || null, confidence: r?.confidence ?? null }));
      break;
    }
    case "xr-tts":
      // Lumen XR : la réponse est lue avec la voix Piper/Kokoro de Lumen, le
      // WAV repart au casque. En cas d'échec, le casque se rabat sur sa
      // synthèse système (s'il en a une).
      if (typeof cmd.text === "string" && cmd.text.trim()) {
        const spoken = cleanOrbSpeech(stripCitations(cmd.text)).slice(0, 1200);
        // Voix d'un agent (Lumen XR lit ses réponses avec elle) : « local:… »
        // = Piper/Kokoro du bureau ; une voix « system:… » n'existe que sur
        // l'appareil d'origine → voix de Lumen.
        const v = typeof cmd.voice === "string" ? cmd.voice : "";
        const voice = v.startsWith("local:") ? v.slice(6) || null : v && !v.startsWith("system:") ? v : null;
        invoke("tts_synth_b64", { text: spoken, voice })
          .then((b64) => remotePush({ type: "xr-tts-audio", id: cmd.id, b64 }))
          .catch((e) => remotePush({ type: "xr-tts-audio", id: cmd.id, error: String(e) }));
      }
      break;
    case "voice-command":
      // Commande vocale dictée sur le téléphone : c'est le bureau qui sait
      // ouvrir les apps et les fichiers, on lui relaie le texte (il n'agit que
      // si la commande vocale est activée dans les Réglages).
      if (remoteDuplicate(cmd)) break;
      if (typeof cmd.text === "string" && cmd.text.trim()) {
        try { window.__TAURI__?.event?.emit?.("lumen-voice-command", { text: cmd.text.trim() }); } catch {}
      }
      break;
    case "attach-doc-ref": {
      // Document choisi avec « # » sur le téléphone : il vit ici (Corpus ou
      // sandbox), donc c'est l'hôte qui le joint à la discussion.
      const it = cmd.item || {};
      const ref = it.docId
        ? { label: String(it.label || "document"), docId: String(it.docId), chars: Number(it.chars) || 0 }
        : (it.sandboxId && it.path
            ? { label: String(it.label || String(it.path).split("/").pop() || "document"),
                sandboxId: String(it.sandboxId), path: String(it.path) }
            : null);
      if (ref) {
        attachMentionedFile(ref)
          .catch((e) => console.warn("[Compagnon] document mentionné", e))
          .finally(() => remotePushDocs());
      }
      break;
    }
    case "set-autospeak":
      config.autoSpeak = !!cmd.on;
      localStorage.setItem("autoSpeak", config.autoSpeak.toString());
      updateAutoSpeakUI();
      remotePushAutospeak();
      break;
    case "list-notifications":
      remotePushNotifications();
      break;
    case "clear-notifications":
      heartbeatNotifications = [];
      notifUnread = 0;
      saveNotifications();
      if (notificationsPanel?.classList.contains("active")) renderNotificationsList();
      updateNotifBadge();
      remotePushNotifications();
      break;
    case "set-action-mode":
      if (config.aiSource === "shortcut") {
        config.actionModeActive = !!cmd.on;
        localStorage.setItem("actionModeActive", config.actionModeActive.toString());
        updateActionModeUI();
      } else if (config.aiSource === "ollama" || config.aiSource === "llama" || isApiLike(config.aiSource)) {
        setOllamaMode(cmd.on ? "router" : "chat");
      }
      remotePushActionMode();
      break;
    case "set-ollama-mode":
      if ((config.aiSource === "ollama" || config.aiSource === "llama" || isApiLike(config.aiSource)) && cmd.mode) {
        setOllamaMode(cmd.mode, cmd.workflow);
      }
      remotePushOllamaMode();
      break;
    case "new-conversation":
      startNewChat();
      remotePushConversations();
      break;
    case "load-conversation": {
      const conv = getSavedConversations().find((c) => c.id === cmd.id);
      if (conv) loadConversation(conv);
      break;
    }
    case "delete-conversation":
      // Même chemin que la corbeille du bureau : si la discussion supprimée
      // était la discussion active, `deleteConversation` repart d'une page
      // blanche — le téléphone le verra par la transcription vide.
      if (cmd.id != null) {
        deleteConversation(cmd.id);
        remotePushConversations();
      }
      break;
  }
}

// ===== Panneau d'aide & documentation =====
function initHelp() {
  // La documentation vit désormais dans sa propre fenêtre (docs/docs.html), avec
  // sommaire latéral et pages dédiées (Guide, Agents, Sandbox, Fluxo, API).
  document.querySelector("#btn-open-help")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    try { await invoke("open_docs"); }
    catch (err) { console.error("Ouverture de la documentation impossible :", err); }
  });
}

// ===== Profil utilisateur (onglet « Profil ») =====
// Éditeur Apple-friendly au-dessus de la mémoire `user/profile` + `user/memories`.
// Le profil conditionne réellement les réponses via getEffectiveSystemPrompt().
const DEFAULT_PROFILE = {
  name: "", callMe: "", role: "", interests: [], goals: "",
  tone: "balanced", address: "tu", language: "auto", emoji: false, useProfile: true,
};
let userProfile = { ...DEFAULT_PROFILE };
let userMemories = []; // [{ text, source, ts }]
let profileSaveTimer = null;

// Format historique conservé pour Ollama natif, l'API et le chemin Shortcut.
// La structure détaillée ci-dessous est réservée à llama-server.
function getLegacySystemPrompt() {
  const p = userProfile;
  const en = getLang() === "en";
  const bits = [];
  if (p && p.useProfile !== false) {
    const who = [];
    if (p.name) who.push(en ? `is named ${p.name}` : `s'appelle ${p.name}`);
    if (p.callMe) who.push(en ? `prefers to be called "${p.callMe}"` : `préfère qu'on l'appelle « ${p.callMe} »`);
    if (p.role) who.push(en ? `works as ${p.role}` : `a pour rôle ${p.role}`);
    if (who.length) bits.push((en ? "The user " : "L'utilisateur ") + who.join(en ? ", " : ", ") + ".");
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
    if (userMemories.length) {
      const facts = userMemories.map((m) => "- " + (typeof m === "string" ? m : m.text)).join("\n");
      bits.push((en ? "Remembered facts:\n" : "À retenir :\n") + facts);
    }
  }
  const date = new Date();
  const dateText = en ? date.toLocaleString("en-US") : date.toLocaleString("fr-FR");
  return [`[Date et heure actuelles] ${dateText}`, ...bits, (config.systemPrompt || "").trim()]
    .filter(Boolean)
    .join("\n\n");
}

// Prompt système effectif. La nouvelle structure est réservée à
// llama.cpp/llama-server ; les autres sources gardent leur format antérieur.
// Le prompt « legacy » (source Ollama/API) n'est pas au format Lumen : c'est une
// simple fiche descriptive de l'utilisateur, sans le cadrage « réponds en tant
// qu'assistant, jamais en tant que l'utilisateur ». Son marqueur est unique et
// identique dans les deux langues.
function isLegacySystemPrompt(content) {
  return String(content || "").trimStart().startsWith("[Date et heure actuelles]");
}

function getEffectiveSystemPrompt() {
  const base = config.aiSource !== "llama" ? getLegacySystemPrompt() : buildLumenSystemPrompt({
    profile: userProfile, memories: userMemories, customPrompt: config.systemPrompt,
    compact: true, language: getLang(),
  });
  return [base, projectSystemBlock(contextProject(), getLang())].filter(Boolean).join("\n\n");
}

function scheduleProfileSave() {
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(async () => {
    try { await invoke("memory_set", { key: "user/profile", value: userProfile }); } catch (_) {}
  }, 400);
}
async function saveMemories() {
  try { await invoke("memory_set", { key: "user/memories", value: userMemories }); } catch (_) {}
}

function initProfileUI() {
  const pane = document.querySelector('.settings-tab-pane[data-pane="profile"]');
  if (!pane) return;
  const $$ = (id) => document.querySelector(id);
  const nameEl = $$("#profile-name"), callmeEl = $$("#profile-callme"), roleEl = $$("#profile-role");
  const goalsEl = $$("#profile-goals"), langEl = $$("#profile-language");
  const emojiEl = $$("#profile-emoji"), useEl = $$("#profile-use");
  const toneSeg = $$("#profile-tone"), addrSeg = $$("#profile-address");
  const interestsEl = $$("#profile-interests"), interestAdd = $$("#profile-interest-add");
  const memListEl = $$("#profile-memories"), memAdd = $$("#profile-memory-add");
  const heroName = $$("#profile-hero-name"), heroAvatar = $$("#profile-avatar");

  function renderHero() {
    const nm = userProfile.callMe || userProfile.name;
    heroName.textContent = nm || t("profile_hero_default") || "Votre profil";
    heroAvatar.textContent = (nm || "L").trim().charAt(0).toUpperCase();
  }
  function renderInterests() {
    interestsEl.innerHTML = "";
    (userProfile.interests || []).forEach((it, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = '<span></span><button title="×">×</button>';
      chip.querySelector("span").textContent = it;
      chip.querySelector("button").addEventListener("click", () => {
        userProfile.interests.splice(i, 1); renderInterests(); scheduleProfileSave();
      });
      interestsEl.appendChild(chip);
    });
  }
  function renderMemories() {
    memListEl.innerHTML = "";
    if (!userMemories.length) {
      const empty = document.createElement("div");
      empty.className = "ios-row"; empty.style.opacity = "0.5";
      empty.innerHTML = `<span>${t("profile_mem_empty") || "Rien encore. Lumen apprendra au fil du temps."}</span>`;
      memListEl.appendChild(empty); return;
    }
    userMemories.forEach((m, i) => {
      const text = typeof m === "string" ? m : m.text;
      const src = typeof m === "object" && m.source === "appris" ? (t("profile_mem_learned") || "appris") : (t("profile_mem_manual") || "ajouté");
      const row = document.createElement("div");
      row.className = "ios-row memory-fact";
      row.innerHTML = `<span class="fact-text"></span><span class="fact-meta"></span><button class="fact-del" title="Supprimer">${ic('trash')}</button>`;
      row.querySelector(".fact-text").textContent = text;
      row.querySelector(".fact-meta").textContent = src;
      row.querySelector(".fact-del").addEventListener("click", () => {
        userMemories.splice(i, 1); renderMemories(); saveMemories();
      });
      memListEl.appendChild(row);
    });
  }
  function renderSegmented(seg, value) {
    seg.dataset.value = value;
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.val === value));
  }
  function render() {
    nameEl.value = userProfile.name || "";
    callmeEl.value = userProfile.callMe || "";
    roleEl.value = userProfile.role || "";
    goalsEl.value = userProfile.goals || "";
    langEl.value = userProfile.language || "auto";
    emojiEl.checked = !!userProfile.emoji;
    useEl.checked = userProfile.useProfile !== false;
    renderSegmented(toneSeg, userProfile.tone || "balanced");
    renderSegmented(addrSeg, userProfile.address || "tu");
    renderInterests();
    renderMemories();
    renderHero();
  }

  async function load() {
    try {
      const e = await invoke("memory_get", { key: "user/profile" });
      if (e && e.value && typeof e.value === "object") userProfile = { ...DEFAULT_PROFILE, ...e.value };
    } catch (_) {}
    try {
      const e = await invoke("memory_get", { key: "user/memories" });
      if (e && Array.isArray(e.value)) userMemories = e.value;
    } catch (_) {}
    render();
  }

  // --- bindings champs texte ---
  const bindText = (el, key) => el.addEventListener("input", () => {
    userProfile[key] = el.value; if (key === "name" || key === "callMe") renderHero(); scheduleProfileSave();
  });
  bindText(nameEl, "name"); bindText(callmeEl, "callMe"); bindText(roleEl, "role"); bindText(goalsEl, "goals");
  langEl.addEventListener("change", () => { userProfile.language = langEl.value; scheduleProfileSave(); });
  emojiEl.addEventListener("change", () => { userProfile.emoji = emojiEl.checked; scheduleProfileSave(); });
  useEl.addEventListener("change", () => { userProfile.useProfile = useEl.checked; scheduleProfileSave(); });

  // --- segmented ---
  const bindSeg = (seg, key) => seg.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { userProfile[key] = b.dataset.val; renderSegmented(seg, b.dataset.val); scheduleProfileSave(); }));
  bindSeg(toneSeg, "tone"); bindSeg(addrSeg, "address");

  // --- chips intérêts ---
  interestAdd.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = interestAdd.value.trim();
    if (v) { userProfile.interests = userProfile.interests || []; userProfile.interests.push(v); interestAdd.value = ""; renderInterests(); scheduleProfileSave(); }
  });
  // --- souvenirs ---
  memAdd.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = memAdd.value.trim();
    if (v) { userMemories.push({ text: v, source: "manuel", ts: Date.now() }); memAdd.value = ""; renderMemories(); saveMemories(); }
  });

  // --- export / clear ---
  $$("#profile-export").addEventListener("click", async () => {
    const data = JSON.stringify({ profile: userProfile, memories: userMemories }, null, 2);
    try { await navigator.clipboard.writeText(data); alert(t("profile_exported") || "Profil copié dans le presse-papiers."); }
    catch (_) { alert(data); }
  });
  $$("#profile-clear").addEventListener("click", async () => {
    if (!(await confirmSheet({ title: t("profile_clear_confirm") || "Effacer tout le profil et les souvenirs ?", danger: true }))) return;
    try { await invoke("memory_delete", { key: "user/profile" }); await invoke("memory_delete", { key: "user/memories" }); } catch (_) {}
    userProfile = { ...DEFAULT_PROFILE }; userMemories = []; render();
  });

  // Recharge à l'ouverture de l'onglet + des Paramètres + sur changement externe.
  document.querySelectorAll('.settings-tab[data-tab="profile"]').forEach((tab) => tab.addEventListener("click", load));
  document.querySelector("#btn-settings")?.addEventListener("click", load);
  window.__TAURI__?.event?.listen?.("memory-changed", (e) => {
    const key = e?.payload?.key;
    if ((key === "user/profile" || key === "user/memories") && pane.classList.contains("active")) load();
  });

  load();
}

// ===== Mémoire partagée (onglet « Mémoire ») =====
// Lit/écrit le MemoryStore via les commandes Tauri. Optionnelle : si le store
// est vide, l'onglet affiche simplement « Aucune entrée ».
function initSharedMemoryUI() {
  const listEl = document.querySelector("#memory-list");
  const emptyEl = document.querySelector("#memory-empty");
  const nsSel = document.querySelector("#select-memory-ns");
  const keyInput = document.querySelector("#input-memory-key");
  const valInput = document.querySelector("#input-memory-value");
  const saveBtn = document.querySelector("#btn-memory-save");
  if (!listEl) return;

  async function refresh() {
    let entries = [];
    try { entries = await invoke("memory_list", { prefix: nsSel?.value || null }); }
    catch (_) { entries = []; }
    listEl.innerHTML = "";
    if (!entries.length) { if (emptyEl) emptyEl.style.display = ""; return; }
    if (emptyEl) emptyEl.style.display = "none";
    entries.forEach((e) => {
      const val = typeof e.value === "string" ? e.value : JSON.stringify(e.value);
      const row = document.createElement("div");
      row.className = "memory-row";
      row.innerHTML =
        '<div class="memory-row-main"><code class="memory-key"></code>' +
        '<span class="memory-val"></span></div>' +
        '<div class="memory-row-actions">' +
        `<button class="memory-edit" title="Modifier">${ic('pencil')}</button>` +
        `<button class="memory-del" title="Supprimer">${ic('trash')}</button></div>`;
      row.querySelector(".memory-key").textContent = e.key;
      row.querySelector(".memory-val").textContent =
        val.length > 120 ? val.slice(0, 120) + "…" : val;
      row.querySelector(".memory-edit").addEventListener("click", () => {
        keyInput.value = e.key;
        valInput.value = JSON.stringify(e.value, null, 2);
      });
      row.querySelector(".memory-del").addEventListener("click", async () => {
        try { await invoke("memory_delete", { key: e.key }); } catch (_) {}
        refresh();
      });
      listEl.appendChild(row);
    });
  }

  nsSel?.addEventListener("change", refresh);

  saveBtn?.addEventListener("click", async () => {
    const key = keyInput.value.trim();
    if (!key) return;
    const raw = valInput.value.trim();
    let value;
    try { value = JSON.parse(raw); }   // JSON (objet, tableau, nombre, "chaîne")
    catch (_) { value = raw; }         // sinon : texte brut
    try {
      await invoke("memory_set", { key, value });
      keyInput.value = ""; valInput.value = "";
      refresh();
    } catch (e) { alert(String(e)); }
  });

  // Recharge à l'ouverture de l'onglet Mémoire.
  document.querySelectorAll('.settings-tab[data-tab="memory"]').forEach((tab) =>
    tab.addEventListener("click", refresh));

  // Mise à jour en direct, quelle que soit l'origine (HTTP raccourci, heartbeat, UI).
  window.__TAURI__?.event?.listen?.("memory-changed", () => {
    const pane = document.querySelector('.settings-tab-pane[data-pane="memory"]');
    if (pane?.classList.contains("active")) refresh();
  });
}

// ===== Authentification du compagnon (TOTP) =====
// Affiche le nom du profil + un code à 6 chiffres qui tourne toutes les 30 s, à
// saisir sur le mobile au premier appairage. Le secret peut être régénéré.
function initCompanionAuthUI() {
  const idEl = document.querySelector("#companion-identifier");
  const codeEl = document.querySelector("#companion-code");
  const cdEl = document.querySelector("#companion-code-countdown");
  const regenBtn = document.querySelector("#btn-companion-regenerate");
  const settingsP = document.querySelector("#settings-panel");
  const qrEl = document.querySelector("#companion-qr");
  const keyEl = document.querySelector("#companion-key");
  if (!codeEl) return;

  let lastSecret = null; // n'injecte le QR/la clé que quand le secret change

  async function refreshInfo() {
    let info = null;
    try { info = await invoke("companion_auth_info"); } catch (_) {}
    if (!info) { codeEl.textContent = "——————"; return; }
    codeEl.textContent = info.current_code || "——————";
    if (cdEl) cdEl.textContent = `${info.seconds_remaining}s`;
    // Le nom du profil EST l'identifiant : rien à configurer, rien à retenir.
    if (idEl) idEl.textContent = info.profile_name || "—";
    // QR + clé d'association : ne changent qu'à la régénération du secret.
    if (info.secret_base32 !== lastSecret) {
      lastSecret = info.secret_base32;
      if (qrEl) { qrEl.innerHTML = info.qr_svg || ""; qrEl.title = info.otpauth_uri || ""; }
      if (keyEl) { keyEl.textContent = info.secret_base32 || "—"; keyEl.title = info.otpauth_uri || ""; }
    }
  }

  // Ticker : ne tourne que quand le panneau Paramètres est visible. Refetch à
  // chaque frontière de 30 s (nouveau code) ; sinon simple décompte visuel.
  setInterval(async () => {
    if (!settingsP?.classList.contains("active")) return;
    const cur = parseInt(cdEl?.textContent, 10);
    if (isNaN(cur) || cur <= 1) { await refreshInfo(); }
    else if (cdEl) { cdEl.textContent = `${cur - 1}s`; }
  }, 1000);

  // Charge à l'ouverture des Paramètres.
  document.querySelector("#btn-settings")?.addEventListener("click", () => {
    refreshInfo();
  });

  regenBtn?.addEventListener("click", async () => {
    const msg = t("confirm_regen") || "Régénérer le secret ? Tous les appareils devront se ré-appairer.";
    if (!(await confirmSheet({ title: msg, danger: true }))) return;
    try { await invoke("companion_regenerate_secret"); refreshInfo(); }
    catch (e) { alert(String(e)); }
  });
}

function updateCompanionUI() {
  const el = document.querySelector("#companion-url");
  if (!el) return;
  if (companionInfo?.url) {
    el.textContent = companionInfo.url;
    el.dataset.url = companionInfo.url;
    if (companionInfo.host) {
      el.title = `${companionInfo.url}  •  http://${companionInfo.host}:${companionInfo.port}`;
    }
  } else {
    el.textContent = "—";
  }
}

function addNotification(payload) {
  if (!payload) return;
  heartbeatNotifications.unshift({
    shortcut: payload.shortcut || "Heartbeat",
    output: stripRTF(payload.output || "").trim(),
    success: payload.success !== false,
    timestamp: payload.timestamp || Date.now(),
  });
  if (heartbeatNotifications.length > NOTIF_MAX) {
    heartbeatNotifications.length = NOTIF_MAX;
  }
  notifUnread++;
  const orbNotifText = stripRTF(payload.output || payload.shortcut || "Nouvelle notification").trim();
  window.OrbBridge?.pushNotification({
    text: orbNotifText,
    source: payload.shortcut || "Heartbeat",
    success: payload.success !== false,
    timestamp: new Date(payload.timestamp || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    count: notifUnread,
  });
  playNotifSound(notifTypeFor(payload));
  saveNotifications();
  updateNotifBadge();
  remotePushNotifications(); // reflète la nouvelle notif sur le(s) téléphone(s)
  // Mise à jour en direct si le panneau est déjà ouvert.
  if (notificationsPanel?.classList.contains("active")) {
    renderNotificationsList();
    markNotificationsRead();
  }
}


// À la connexion, plus de notification visuelle rejouée sur l'orbe (elle
// couvrait l'écran 8 s à chaque reconnexion) : un simple bip suffit. La
// dernière notification reste lisible sur la page Messages de la Fire.
window.addEventListener("lumen-orb-connected", (e) => {
  if ((e?.detail?.device || "orb") === "orb") window.OrbBridge?.pushChime?.("connect");
});

function pushOrbMessage(text) {
  if (text) window.OrbBridge?.pushMessage(text);
}

window.addEventListener("lumen-orb-request-message", () => {
  const last = [...conversationHistory].reverse().find((m) => m.role === "assistant" && m.content);
  window.OrbBridge?.pushMessage(last?.content || "Aucun message recent");
});
window.addEventListener("lumen-orb-request-agent", () => {
  window.OrbBridge?.pushAgent(lastOrbAgent);
});

window.addEventListener("lumen-orb-mic-audio", async (event) => {
  try {
    showDictationHint(t("dyn_whisper_transcribing"));
    window.OrbBridge?.pushActivity?.("transcribing");
    const bytes = new Uint8Array(event.detail || []);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const source = decoded.getChannelData(0);
    let pcm16k = source;
    if (decoded.sampleRate !== 16000) {
      const length = Math.round(source.length * 16000 / decoded.sampleRate);
      pcm16k = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const pos = i * decoded.sampleRate / 16000;
        const a = Math.floor(pos), b = Math.min(source.length - 1, a + 1);
        const u = pos - a;
        pcm16k[i] = source[a] * (1 - u) + source[b] * u;
      }
    }
    // Whisper reçoit le signal brut du M5. Aucun filtrage, noise gate,
    // centrage ou gain logiciel n'est appliqué ici.
    let energy = 0, peak = 0;
    for (let i = 0; i < pcm16k.length; i++) {
      const value = pcm16k[i];
      energy += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(energy / Math.max(1, pcm16k.length));
    console.info("Audio M5 reçu", {
      bytes: bytes.length,
      samples: pcm16k.length,
      sampleRate: decoded.sampleRate,
      rms: Number(rms.toFixed(6)),
      peak: Number(peak.toFixed(6)),
    });
    if (rms < 0.00005 || peak < 0.0002) throw new Error("Le micro M5 a envoyé du silence");
    // Whisper du réglage (base par défaut), signal brut : comme l'ancienne
    // version, qui transcrivait bien une fois l'écoute démarrée au bon moment.
    const text = (await whisperTranscribe(pcm16k)).trim();
    await ctx.close();
    window.OrbBridge?.pushMicResult(text, true, "");
    if (text) {
      chatInput.value = chatInput.value.trim() ? `${chatInput.value.trim()} ${text}` : text;
      autosizeChatInput();
      hideDictationHint();
      await handleSend();
    } else showDictationHint(t("dyn_no_dictation"));
  } catch (err) {
    console.error("Dictée M5 impossible :", err);
    window.OrbBridge?.pushMicResult("", false, err?.message || String(err));
    showDictationHint(t("dyn_whisper_fail", { err: err?.message || err }));
  }
});

function saveNotifications() {
  localStorage.setItem('heartbeatNotifications', JSON.stringify(heartbeatNotifications));
  localStorage.setItem('heartbeatNotifUnread', notifUnread.toString());
}

function updateNotifBadge() {
  if (!notifBadge) return;
  if (notifUnread > 0) {
    notifBadge.textContent = notifUnread > 99 ? "99+" : notifUnread.toString();
    notifBadge.hidden = false;
    btnNotifications?.classList.add("has-unread");
  } else {
    notifBadge.hidden = true;
    btnNotifications?.classList.remove("has-unread");
  }
  // Si la cloche est repliée dans le menu « ⋯ », on signale les non-lus dessus.
  const collapsed = btnNotifications?.parentElement === toolbarOverflow;
  btnMore?.classList.toggle("has-unread", collapsed && notifUnread > 0);
}

function markNotificationsRead() {
  notifUnread = 0;
  saveNotifications();
  updateNotifBadge();
}

function formatNotifTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderNotificationsList() {
  if (!notificationsListContainer) return;
  if (!heartbeatNotifications.length) {
    notificationsListContainer.innerHTML =
      `<div class="notif-empty">${t("dyn_notif_empty")}</div>`;
    return;
  }
  notificationsListContainer.innerHTML = heartbeatNotifications.map(n => {
    const body = n.output
      ? formatMessage(n.output)
      : `<span class="notif-empty-output">${n.success ? "Exécuté (aucune sortie)" : "Échec sans message"}</span>`;
    return `
      <div class="notif-item ${n.success ? 'ok' : 'error'}">
        <div class="notif-item-head">
          <span class="notif-ic">${ic(n.success ? 'heartbeat' : 'warn')}</span>
          <span class="notif-shortcut">${escapeHTML(n.shortcut)}</span>
          <span class="notif-time">${formatNotifTime(n.timestamp)}</span>
        </div>
        <div class="notif-item-body">${body}</div>
      </div>`;
  }).join('');
}

// ===== Accès aux automatisations Fluxo =====
// Lumen liste et exécute les workflows créés dans l'app Fluxo (via le moteur
// partagé fluxo-engine). Le texte de la barre sert d'entrée ({{input}}) et le
// résultat s'affiche comme une réponse dans la discussion.
async function loadFluxoList() {
  let names = [];
  try {
    names = await invoke("list_fluxo_workflows");
  } catch (e) {
    console.error("Fluxo : liste impossible", e);
  }
  renderFluxoList(names);
}

function renderFluxoList(names) {
  if (!fluxoListContainer) return;
  fluxoListContainer.innerHTML = "";
  if (!names || !names.length) {
    const empty = document.createElement("div");
    empty.className = "fluxo-empty";
    empty.innerHTML = t("dyn_fluxo_empty");
    fluxoListContainer.appendChild(empty);
    return;
  }
  names.forEach((name) => {
    const item = document.createElement("div");
    item.className = "fluxo-item";
    item.innerHTML = `<span class="fluxo-name">${escapeHTML(name)}</span><button class="fluxo-run-btn">Lancer</button>`;
    item.querySelector(".fluxo-run-btn").addEventListener("click", () => runFluxoWorkflow(name));
    fluxoListContainer.appendChild(item);
  });
}

// Sélecteur de modèle d'image de la barre : Bonsai (ternary/binary), modèles
// d'image Ollama installés, ou modèles OpenAI, selon le moteur choisi.
let ollamaImageNamesCache = null;
async function renderImageModelSelect(provider = config.imageProvider) {
  if (!selectImageModel) return;
  if (provider === 'ollama' && ollamaImageNamesCache === null) {
    ollamaImageNamesCache = await listOllamaImageModels(invoke);
  }
  const models = imageModelsFor(provider, ollamaImageNamesCache || []);
  const current = provider === 'bonsai' ? config.imageBonsaiModel
    : provider === 'ollama' ? config.imageOllamaModel
    : provider === 'playground' ? config.imagePlaygroundStyle : config.imageOpenaiModel;
  selectImageModel.innerHTML = '';
  for (const m of models) {
    selectImageModel.appendChild(new Option(m.missing ? `${m.label} — à installer` : m.label, m.id));
  }
  if (!models.some((m) => m.id === current)) selectImageModel.appendChild(new Option(current, current));
  selectImageModel.value = current;
}

// ===== Boîte à outils intégrée =====
// Raccourcis essentiels depuis la barre, volontairement courts : tout le reste
// des applications vit dans le bureau (Lumen Desktop), regroupé par hubs. Dupliquer
// ici la trentaine d'apps du launcher n'apportait rien — on garde les points
// d'entrée qu'on veut atteindre sans passer par le bureau.
// Les dégradés reprennent l'identité des hubs correspondants (Agents → Équipage,
// Designer → Fluxo), pour qu'une app garde la même couleur partout.
// Le CATALOGUE : tout ce que la barre sait ouvrir sans passer par le bureau.
// Chaque entrée correspond à une commande Tauri `open_*` enregistrée dans
// lib.rs — une app qui n'a pas de fenêtre propre (elles vivent dans les hubs du
// bureau) n'a rien à faire ici, la barre ne saurait pas l'ouvrir.
// Les dégradés reprennent l'identité des hubs correspondants (Agents → Équipage,
// Designer → Fluxo), pour qu'une app garde la même couleur partout.
const TOOLBOX_CATALOG = [
  { id: "lumen-os", name: "Lumen Desktop", icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>', cmd: "open_sandbox_explorer", args: { desktop: true }, c1: "#ff5e3a", c2: "#ff2d55" },
  { id: "sandbox", name: "Sandbox", icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M2 11h20"/>', cmd: "open_sandbox_explorer", c1: "#f59f35", c2: "#e84d6a" },
  { id: "agents", name: "Agents", icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>', cmd: "open_agents_manager", c1: "#16b8a6", c2: "#0a84ff" },
  { id: "designer", name: "Designer", icon: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>', cmd: "open_fluxo_designer", c1: "#0a84ff", c2: "#5e5ce6" },
  { id: "automations", name: "Automations", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', cmd: "open_automations", c1: "#5e5ce6", c2: "#0a84ff" },
  { id: "domotique", name: "Domotique", icon: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><rect x="10" y="13" width="4" height="4" rx="0.6"/>', cmd: "open_domotique", c1: "#2aa98f", c2: "#2670c9" },
  { id: "profiler", name: "Profiler", icon: '<path d="M3 12h4l3 8 4-16 3 8h4"/>', cmd: "open_profiler", c1: "#30d158", c2: "#0a84ff" },
  { id: "docs", name: "Documentation", icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 10h5"/>', cmd: "open_docs", c1: "#37a87a", c2: "#3a9baa" },
  { id: "knowledge", name: "Corpus", icon: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22z"/><path d="M8 7h8M8 11h6"/>', cmd: "open_knowledge", c1: "#3a9baa", c2: "#2670c9" },
  { id: "vault", name: "Coffre personnel", icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0"/>', cmd: "open_vault", c1: "var(--primary)", c2: "var(--primary)" },
  { id: "memory", name: "Mémoire", icon: '<path d="M12 3a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.8V17a3 3 0 0 0 5 2.2A3 3 0 0 0 17 17v-3.2A3.5 3.5 0 0 0 16 7a4 4 0 0 0-4-4z"/><path d="M12 3v16"/>', cmd: "open_memory", c1: "#c86bd8", c2: "#7a5cf0" },
  { id: "data-analysis", name: "Data Analysis", icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', cmd: "open_data_analysis", c1: "#0a84ff", c2: "#30d158" },
  { id: "image-studio", name: "Studio d’images", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="M21 15l-5-5L5 21"/>', cmd: "open_image_studio", c1: "#ff9f0a", c2: "#ff375f" },
  { id: "moodboard", name: "Moodboard", icon: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>', cmd: "open_moodboard", c1: "#ff375f", c2: "#c86bd8" },
  { id: "kanban", name: "Kanban", icon: '<rect x="3" y="3" width="5" height="18" rx="1.5"/><rect x="9.5" y="3" width="5" height="12" rx="1.5"/><rect x="16" y="3" width="5" height="15" rx="1.5"/>', cmd: "open_kanban_board", c1: "#0a84ff", c2: "#16b8a6" },
  { id: "calendar", name: "Calendrier", icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', cmd: "open_calendar", c1: "#ff5e3a", c2: "#ff9f0a" },
  { id: "inbox", name: "Messagerie", icon: '<path d="M4 4h16v12H7l-3 3z"/><path d="M8 9h8M8 12h5"/>', cmd: "open_inbox", c1: "#2670c9", c2: "#5e5ce6" },
  { id: "budget", name: "Budget", icon: '<path d="M12 2v20"/><path d="M17 6.5C17 4.6 14.8 3.5 12 3.5S7 4.6 7 6.5 9.2 10 12 10s5 1.4 5 3.5-2.2 3.5-5 3.5-5-1.4-5-3.5"/>', cmd: "open_budget", c1: "#30d158", c2: "#16b8a6" },
  { id: "games", name: "Jeux", icon: '<rect x="2" y="7" width="20" height="11" rx="4"/><path d="M7 11v3M5.5 12.5h3M16 12h.01M18.5 14h.01"/>', cmd: "open_games", c1: "#ff375f", c2: "#9f6bff" },
  { id: "llmlog", name: "Journal LLM", icon: '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h4"/>', cmd: "open_llm_log", c1: "#6e7781", c2: "#3a9baa" },
  { id: "storage", name: "Stockage", icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 11v8c0 1.66 4 3 9 3s9-1.34 9-3v-8"/>', cmd: "open_storage", c1: "#64d2ff", c2: "#0a84ff" },
  { id: "settings", name: "Réglages", icon: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>', cmd: "open_settings", c1: "#6e7781", c2: "#0a84ff" },
];

// Sélection par défaut : les sept raccourcis historiques de la boîte à outils.
// Tout le reste du catalogue reste à un clic dans « Personnaliser ».
const TOOLBOX_DEFAULT = ["lumen-os", "sandbox", "agents", "designer", "domotique", "profiler", "storage", "docs"];
const TOOLBOX_STORAGE_KEY = "toolboxApps";

/// Apps ajoutées après coup : une sélection enregistrée avant leur existence ne
/// les mentionne pas, et elles resteraient invisibles pour les utilisateurs de
/// longue date. On les ajoute UNE fois, sans jamais retirer quoi que ce soit ;
/// l'utilisateur reste libre de les décocher ensuite.
const TOOLBOX_NEW_APPS = [{ id: "storage", flag: "toolboxAdded:storage" }];

function withNewToolboxApps(ids) {
  const out = ids.slice();
  for (const { id, flag } of TOOLBOX_NEW_APPS) {
    if (localStorage.getItem(flag) === "1") continue;
    lsSet(flag, "1");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/// Identifiants réellement affichés, filtrés sur le catalogue : une app retirée
/// d'une version à l'autre ne doit pas laisser une tuile morte.
function toolboxSelection() {
  let ids = null;
  try {
    const raw = localStorage.getItem(TOOLBOX_STORAGE_KEY);
    if (raw) ids = JSON.parse(raw);
  } catch { /* préférence illisible : on repart du défaut */ }
  if (!Array.isArray(ids)) ids = TOOLBOX_DEFAULT;
  else ids = withNewToolboxApps(ids);
  const known = ids.filter((id) => TOOLBOX_CATALOG.some((a) => a.id === id));
  // Une sélection vide est autorisée : l'utilisateur peut vouloir une boîte à
  // outils vide. Seule une préférence ABSENTE retombe sur le défaut.
  return new Set(known);
}

function saveToolboxSelection(set) {
  // Ordre du catalogue plutôt qu'ordre de clic : la grille ne doit pas se
  // réorganiser dans le dos de l'utilisateur quand il coche puis décoche.
  const ids = TOOLBOX_CATALOG.filter((a) => set.has(a.id)).map((a) => a.id);
  localStorage.setItem(TOOLBOX_STORAGE_KEY, JSON.stringify(ids));
}

// Mode personnalisation : la grille montre TOUT le catalogue, et un clic coche
// ou décoche au lieu d'ouvrir l'app.
let toolboxEditing = false;

function toolboxTile(app, { editing, selected }) {
  const btn = document.createElement("button");
  btn.className = "toolbox-item" + (editing && !selected ? " is-off" : "");
  btn.type = "button";
  btn.style.setProperty("--c1", app.c1);
  btn.style.setProperty("--c2", app.c2);
  const label = ttApps(app.name);
  btn.innerHTML = `<span class="tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${app.icon}</svg>`
    + (editing ? `<span class="tb-check" aria-hidden="true">${selected ? "✓" : ""}</span>` : "")
    + `</span>`
    + `<span class="tb-name">${escapeHTML(label)}</span>`;
  btn.title = editing
    ? (selected ? t("toolbox_uncheck", { name: label }) : t("toolbox_check", { name: label }))
    : label;
  if (editing) {
    btn.setAttribute("role", "checkbox");
    btn.setAttribute("aria-checked", String(!!selected));
  }
  return btn;
}

function renderToolboxGrid() {
  const grid = document.querySelector("#toolbox-grid");
  if (!grid) return;
  const selection = toolboxSelection();
  const apps = toolboxEditing
    ? TOOLBOX_CATALOG
    : TOOLBOX_CATALOG.filter((a) => selection.has(a.id));
  grid.innerHTML = "";
  grid.classList.toggle("is-editing", toolboxEditing);

  if (!apps.length) {
    const empty = document.createElement("p");
    empty.className = "toolbox-empty";
    empty.textContent = t("toolbox_empty");
    grid.appendChild(empty);
  }

  for (const app of apps) {
    const selected = selection.has(app.id);
    const btn = toolboxTile(app, { editing: toolboxEditing, selected });
    btn.addEventListener("click", () => {
      if (toolboxEditing) {
        if (selection.has(app.id)) selection.delete(app.id);
        else selection.add(app.id);
        saveToolboxSelection(selection);
        renderToolboxGrid();
        return;
      }
      toolboxPanel?.classList.remove("active");
      invoke(app.cmd, app.args || {}).catch((e) => console.error("Ouverture impossible :", e));
    });
    grid.appendChild(btn);
  }

  const hint = document.querySelector("#toolbox-edit-hint");
  if (hint) {
    hint.textContent = toolboxEditing ? t("toolbox_edit_hint") : "";
    hint.hidden = !toolboxEditing;
  }
  const editBtn = document.querySelector("#btn-toolbox-edit");
  if (editBtn) {
    editBtn.classList.toggle("active", toolboxEditing);
    editBtn.title = toolboxEditing ? t("toolbox_edit_done") : t("toolbox_edit");
    editBtn.setAttribute("aria-pressed", String(toolboxEditing));
  }
}

/// Quitte le mode personnalisation. Appelé à la fermeture du panneau : rouvrir
/// la boîte à outils doit donner un launcher, pas un formulaire.
function setToolboxEditing(on) {
  toolboxEditing = !!on;
  renderToolboxGrid();
}

// Budget s'affiche dans le bureau Travail comme une app intégrée, afin de
// conserver le même espace visuel que les autres panneaux Lumen. Le fallback
// Tauri reste disponible pour les appels externes (consultation, agents, etc.).
function openEmbeddedBudget() {
  const existing = document.querySelector(".budget-embedded-window");
  if (existing) { existing.classList.add("is-focused"); setTimeout(() => existing.classList.remove("is-focused"), 260); return; }
  const win = document.createElement("section");
  win.className = "budget-embedded-window";
  win.innerHTML = `<header class="budget-embedded-titlebar"><span class="budget-embedded-dot"></span><strong>Budget</strong><button type="button" aria-label="Fermer Budget">×</button></header><iframe title="Budget" src="/budget/budget.html"></iframe>`;
  win.querySelector("button").onclick = () => win.remove();
  document.body.appendChild(win);
}

async function runFluxoWorkflow(name) {
  const input = chatInput.value.trim();
  fluxoPanel.classList.remove("active");
  messagesContainer.style.display = "flex";

  addMessageBubble(t("dyn_fluxo_run", { name }), "user");
  const bubble = addMessageBubble("", "assistant");
  const loadingEl = bubble.querySelector(".msg-text-content") || bubble;
  loadingEl.innerHTML = `<div class="shortcut-loading-indicator"><span class="pulse-dot"></span><span>${t("dyn_fluxo_running", { name: escapeHTML(name) })}</span></div>`;

  try {
    const output = await invoke("run_fluxo_workflow", { name, input });
    const textEl = bubble.querySelector(".msg-text-content");
    const html = output ? formatMessage(output) : `<em>${t("dyn_fluxo_no_output")}</em>`;
    if (textEl) textEl.innerHTML = html; else bubble.innerHTML = html;
    remoteSpeak(output);
    if (config.autoSpeak && output) speakAfterAnnouncements(output);
    scrollToBottom();
  } catch (err) {
    showErrorInBubble(bubble, t("dyn_fluxo_fail", { err: escapeHTML(String(err)) }));
  }
}

// ===== Function calling : l'IA Ollama appelle des workflows Fluxo =====
// Quand l'option est activée et un modèle compatible « tools » est utilisé,
// les workflows Fluxo sont exposés comme outils. L'agent boucle : appel(s)
// d'outil → exécution Fluxo → résultat réinjecté → réponse finale.
let fluxoToolMap = {};
const DOMOTIQUE_TOOL_NAMES = new Set(["domotique_list_devices", "domotique_get_state", "domotique_command"]);
// Production de documents. `export_pdf` est le premier outil de Lumen qui
// dépose un FICHIER chez l'utilisateur : le modèle rédige, le Rust rend et
// écrit dans les Téléchargements (cf. pdf.rs). On décrit précisément QUAND s'en
// servir — sans cette phrase, un modèle local exporte à la moindre réponse un
// peu longue.
const DOCUMENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "export_pdf",
      description:
        "Génère un document PDF et l'enregistre dans le dossier Téléchargements de l'utilisateur. "
        + "À utiliser UNIQUEMENT quand l'utilisateur demande explicitement un PDF, un document à imprimer, "
        + "à archiver ou à partager. Si l'utilisateur veut le PDF de ce que tu viens d'écrire, appelle "
        + "l'outil avec le titre seul : ta réponse précédente sera reprise telle quelle. Ne renseigne "
        + "content que pour un document DIFFÉRENT de ta dernière réponse ; c'est du Markdown (titres, "
        + "listes, gras, tableaux, code), sans commentaire adressé à l'utilisateur.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Titre du document. Sert aussi de nom de fichier." },
          content: { type: "string", description: "Le document complet en Markdown. À omettre pour reprendre la réponse précédente." },
        },
        required: ["title"],
      },
    },
  },
];
const DOCUMENT_TOOL_NAMES = new Set(["export_pdf"]);

const MEMORY_TOOL_NAMES = new Set(["memory_recall", "memory_remember", "create_reminder", "search_documents", "query_tables", "search_lumen_docs"]);

// Outils mémoire exposés à l'IA de la barre. Le contexte « bar » est cloisonné
// côté backend (cf. recall.rs) : l'IA ne lit/écrit QUE les types autorisés par la
// politique, même si elle demande autre chose.
const MEMORY_TOOLS = [
  // Outils mémoire : définition partagée (memory-bridge.js).
  ...memoryToolDefs(),
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Crée un rappel daté qui notifiera l'utilisateur à l'échéance (cloche + pulsation de l'orbe). À utiliser quand l'utilisateur demande un rappel/une alerte à une date ou heure précise (« rappelle-moi… », « préviens-moi… »). Calcule l'échéance à partir de la date/heure courante.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Intitulé court du rappel" },
          note: { type: "string", description: "Détail optionnel" },
          due_at_iso: { type: "string", description: "Échéance en ISO 8601 heure locale, ex. 2026-06-24T09:00" },
          recur: { type: "string", description: "Récurrence", enum: ["none", "daily", "weekly", "monthly"] },
        },
        required: ["title", "due_at_iso"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_lumen_docs",
      description: "Recherche dans la documentation intégrée de Lumen par catégories/pages (installation, IA, Lumen Desktop, Fluxo, agents, sandbox, bases de données, recherche profonde, etc.). À utiliser pour répondre aux questions sur le fonctionnement de Lumen.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Question ou mots-clés à chercher dans la documentation Lumen" },
          category: { type: "string", description: "Catégorie/page optionnelle : workspace, fluxo, agents, sandbox, tables, research, aiconfig, install…" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_documents",
      description: "Recherche dans la base de connaissances locale de l'utilisateur (documents importés : PDF, notes, fichiers). À utiliser quand la réponse dépend de documents personnels/internes plutôt que de connaissances générales. Renvoie les extraits les plus pertinents, à citer dans la réponse.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "La question ou les mots-clés à rechercher dans les documents" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_tables",
      description: "Interroge les bases de données structurées de l'utilisateur (app « Bases de données ») en langage naturel. À utiliser quand la réponse dépend de données tabulaires (listes, inventaires, suivis, chiffres par catégorie…). Lecture seule. La bonne base est choisie automatiquement (voir tables_list pour les connaître).",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "La question à poser sur les données tabulaires" },
          base: { type: "string", description: "Nom de la base à interroger (facultatif : sinon, celle qui correspond le mieux à la question)" },
        },
        required: ["question"],
      },
    },
  },
];


async function callMemoryTool(name, args = {}) {
  if (name === "search_lumen_docs") {
    return await searchLumenDocs(String(args.query || ""), String(args.category || ""));
  }
  if (name === "memory_recall" || name === "memory_remember") return runMemoryTool(invoke, name, args);
  if (name === "create_reminder") {
    const iso = String(args.due_at_iso || "").trim();
    const due = Date.parse(iso);
    if (!iso || Number.isNaN(due)) return "Échéance invalide : fournis due_at_iso au format ISO 8601 (ex. 2026-06-24T09:00).";
    const recur = ["daily", "weekly", "monthly"].includes(args.recur) ? args.recur : "none";
    await invoke("reminder_add", {
      title: String(args.title || "").trim() || "Rappel",
      note: String(args.note || ""),
      dueAt: due,
      recur,
      source: "ai",
    });
    const when = new Date(due).toLocaleString();
    return `Rappel créé pour le ${when}${recur !== "none" ? ` (récurrence : ${recur})` : ""}.`;
  }
  if (name === "search_documents") {
    const hits = await invoke("rag_search", { query: String(args.query || ""), k: 5 });
    if (!hits || !hits.length) return t("rag_no_hits");
    // Une recherche déclenchée par le modèle mérite le même panneau de sources
    // qu'une pièce jointe : sinon la réponse cite « Source 3 » sans que rien à
    // l'écran ne dise ce qu'est la source 3.
    pendingRagSources = hits.map(toRagSource);
    renderRagSources(activeAssistantBubble, pendingRagSources);
    return hits.map((h, i) => `[${i + 1}] (${h.title}) ${String(h.text || "").trim()}`).join("\n\n");
  }
  if (name === "query_tables") {
    // Choix automatique de la base selon la question (lib/data-tools.js).
    return callDataTool(invoke, "query_tables", args, { lang: getLang() });
  }
  throw new Error(`Outil mémoire inconnu : ${name}`);
}

// sanitizeToolName vit désormais dans lib/tool-publishing.js : l'écran de
// réglages doit dériver EXACTEMENT les mêmes noms de fonction pour cocher les
// bons outils.

// Outils MCP visibles depuis la barre : uniquement les connecteurs ACTIVÉS et
// marqués « visible dans la barre ». Un connecteur dormant ne coûte donc rien en
// contexte. `mcpToolMap` retient la cible réelle (serveur + outil) pour le
// dispatch, comme `fluxoToolMap` pour les workflows.
let mcpToolMap = {};
// App Intents en mode application (run_python, create_note…) : la coque
// ouvre l'app dans sa vue, sans quitter la discussion (lib/app-mode.js).
let intentToolMap = {};
const isAppShell = () => document.documentElement.classList.contains('shell-app') && !!window.LumenAppMode;
function openAppViewForIntent(appId) { window.LumenAppMode?.openView?.(`pkg:${appId}`, { background: true }); }

async function buildMcpTools() {
  mcpToolMap = {};
  let specs = [];
  try { specs = await invoke("mcp_bar_tools"); } catch { return []; }
  return (specs || []).map((spec) => {
    const meta = spec.lumen || {};
    mcpToolMap[spec.function?.name] = { server: meta.server, tool: meta.tool, risk: meta.risk, effect: meta.effect };
    const { lumen, ...clean } = spec;
    return clean;
  });
}

async function buildFluxoTools() {
  let names = [];
  // `list_fluxo_tool_workflows` et NON `list_fluxo_workflows` : seuls les
  // workflows laissés « exposés au function calling » dans le designer entrent
  // dans le catalogue d'outils du modèle. L'autre commande liste tout — elle
  // sert aux listes de l'interface, pas à ce prompt.
  try { names = await invoke("list_fluxo_tool_workflows"); } catch (e) { console.error(e); }
  fluxoToolMap = {};
  const tools = names.map((name) => {
    const fn = sanitizeToolName(name);
    fluxoToolMap[fn] = name;
    return {
      type: "function",
      function: {
        name: fn,
        description: `Exécute le workflow d'automatisation Fluxo « ${name} ». L'argument "input" lui est transmis comme entrée.`,
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "Texte d'entrée du workflow" } },
          required: [],
        },
      },
    };
  });
  tools.push(
    {
      type: "function",
      function: {
        name: "domotique_list_devices",
        description: "Liste les objets domotiques enregistrés dans Lumen, avec leur nom, id, type, pièce et IP. N'invente jamais d'objet absent de cette liste.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "domotique_get_state",
        description: "Lit l'état réel d'un objet domotique par nom ou id.",
        parameters: {
          type: "object",
          properties: { device: { type: "string", description: "Nom ou id de l'objet, par exemple Lampe salon" } },
          required: ["device"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "domotique_command",
        description: "Envoie une commande locale sécurisée à un objet domotique. Utilise set pour régler on/brightness/couleur/angle, toggle pour inverser, ou une action supportée par le firmware. Si l'objet a plusieurs composants (voir le champ components de domotique_list_devices), précise la clé du composant à piloter via component.",
        parameters: {
          type: "object",
          properties: {
            device: { type: "string", description: "Nom ou id de l'objet" },
            component: { type: "string", description: "Clé du composant à piloter sur un objet multi-composants (ex. relais_26). Omettre si l'objet n'a qu'un composant." },
            action: { type: "string", description: "Action, par exemple set ou toggle" },
            params: { type: "object", description: "Paramètres JSON, par exemple {\"on\":true,\"brightness\":80}" },
          },
          required: ["device"],
        },
      },
    },
  );
  tools.push(...DOCUMENT_TOOLS);
  // Rédaction de documents nourrie par les sandboxes / Corpus / bases, et un
  // outil par agent (« @agent_… » lui confie une tâche, suivie en direct).
  tools.push(...buildDocTools(getLang()));
  // Courrier relevé par l'app Email : lecture, recherche, résumé, brouillons.
  tools.push(...buildMailTools());
  tools.push(...(await buildAgentTools(invoke, getLang())));
  tools.push(...MEMORY_TOOLS);
  // Fichiers des sandboxes + données personnelles, avec accord de l'utilisateur.
  tools.push(...buildDataTools(getLang()));
  // Données des applications (Kanban, Agenda, Contacts, Études…), lecture seule.
  tools.push(...buildAppDataTools(getLang()));
  // Écriture dans les apps (Kanban, Agenda, Notes), toujours après confirmation.
  tools.push(...buildAppWriteTools(getLang()));
  tools.push(...buildLiveTools());
  // Recherche web : présente UNIQUEMENT si l'utilisateur l'a activée (elle est
  // le seul outil qui sorte de la machine), cf. lib/web-tools.js.
  tools.push(...buildWebTools());
  // Outils des connecteurs MCP activés.
  tools.push(...(await buildMcpTools()));
  if (isAppShell()) {
    const intents = intentToolDefinitions(installedPackages());
    intentToolMap = intents.map;
    tools.push(...intents.tools);
  } else intentToolMap = {};
  // Actions sur Lumen lui-même (ouvrir une app, des Réglages, changer le thème).
  tools.push(...buildSystemTools(getLang()));
  // Workflows Fluxo et outils MCP agissent : pilier « Actions » (lib/hybrid.js).
  registerActionTools([...Object.keys(fluxoToolMap), ...Object.keys(mcpToolMap)]);
  // Publication : les outils décochés dans Réglages › Boîte à outils ne partent
  // pas dans la requête (ni schéma, ni description) — cf. lib/tool-publishing.js.
  return filterPublishedTools(tools);
}

// Blocs Fluxo « App : action » quand le bureau est fermé : la coque du mode
// application exécute l'intention dans la vue de l'app (en coulisse).
(function installFluxoIntentResponder() {
  const evt = window.__TAURI__?.event;
  if (!evt) return;
  evt.listen("fluxo-intent-request", async (e) => {
    const req = e.payload || {};
    const reply = (result, error) => invoke("reporting_export_result", { id: req.id, result: result ?? null, error: error ?? null }).catch(() => {});
    if (!isAppShell()) { reply(null, "Ouvrez Lumen Desktop ou le mode application pour exécuter une action d'app."); return; }
    try {
      const { refreshInstalled } = await import("./lib/appkit/installed.js");
      const app = installedPackages().find((a) => a.id === req.appId) || (await refreshInstalled().catch(() => []) || []).find((a) => a.id === req.appId);
      const intent = app?.intents?.find((it) => it.id === req.intentId);
      if (!intent) { reply(null, `Action inconnue : ${req.appId}.${req.intentId} (app installée ?)`); return; }
      const out = await runAppIntent(req.appId, intent, req.args || {}, openAppViewForIntent);
      reply({ text: typeof out === "string" ? out : JSON.stringify(out ?? "OK", null, 2) });
    } catch (err) { reply(null, String(err?.message || err)); }
  });
})();

// La barre n'a pas de fenêtres : elle relaie au bureau (évènement `lumen-open`,
// cf. openFromAssistant dans sandbox/desktop.js).
const SYSTEM_HOST = {
  // Mode application : l'app s'ouvre dans sa vue de la coque, pas au bureau.
  openApp: (app) => {
    const pkg = installedPackages().find((a) => a.id === app);
    if (isAppShell() && pkg) { window.LumenAppMode.openView(`pkg:${pkg.id}`); return app; }
    openInLumen({ kind: "app", app }); return app;
  },
  openSettings: (section) => openInLumen({ kind: "settings", section }),
};

// Outils « assistant personnel » de la discussion simple (barre, compagnon,
// Lumen XR) : seulement si la question touche une famille qui en a besoin
// (signaux forts de l'orchestrateur), et réduits à ces familles + la
// recherche globale et la mémoire. Vide = discussion sans outil.
const ASSISTANT_CATS = new Set(["apps", "mail", "memory", "knowledge", "files", "live", "home", "ask", "web"]);
async function assistantToolsFor(query) {
  const q = String(query || "");
  if (!q.trim() || isSmallTalk(q)) return [];
  const all = await buildFluxoTools();
  const byCat = new Map();
  for (const tl of all) {
    const c = toolCategory(tl.function?.name);
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(tl);
  }
  const prev = [...conversationHistory].reverse().filter((m) => m.role === "user")[1];
  const sig = detectSignals(q, byCat, prev?.display || prev?.content || "");
  const cats = sig.strong.filter((c) => ASSISTANT_CATS.has(c));
  if (!cats.length) return [];
  const keep = new Set(["lumen_search", "day_overview", "memory_recall", "memory_remember", "create_reminder", "ask_user"]);
  return all.filter((tl) => cats.includes(toolCategory(tl.function?.name)) || keep.has(tl.function?.name));
}
let assistantTools = [];

// Aiguillage de départ par le moteur de décision (lib/decision.js) :
// { route: "direct"|"tools"|"orchestrate", tools? } ou null (moteur absent,
// coupé ou indécis → heuristique habituelle). Les signaux forts restent
// prioritaires : un 0,8 B qui dit « direct » pour la météo ne doit pas faire
// inventer la réponse au modèle principal.
let turnRoute = null;

// ---- Sujet détaché : contexte allégé pour ce tour ----
// Messages mis de côté pendant le tour (null hors tour détaché). La
// sauvegarde passe par fullConversationHistory() pour ne jamais les perdre.
let detachedPrefix = null;
function fullConversationHistory() {
  if (!detachedPrefix) return conversationHistory;
  const sys = conversationHistory.filter((m, i) => m.role === 'system' && conversationHistory.slice(0, i).every((x) => x.role === 'system'));
  return [...sys, ...detachedPrefix, ...conversationHistory.slice(sys.length)];
}
const KEEP_RECENT = 4;   // 2 échanges
async function detachIfNewTopic(query) {
  if (localStorage.getItem('detachTopics') === 'off') return null;
  if (config.ollamaMode && config.ollamaMode !== 'chat') return null;
  if (turnHasImages() || isSmallTalk(query)) return null;
  let sysCount = 0;
  while (sysCount < conversationHistory.length && conversationHistory[sysCount].role === 'system') sysCount++;
  const body = conversationHistory.slice(sysCount, -1);       // avant la demande courante
  const turns = body.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (turns.length < 6) return null;                           // trop court pour valoir la peine
  const r = await topicContinuity({ query, history: body, aiSource: config.aiSource, ollamaUrl: config.ollamaUrl, invoke });
  if (r?.key !== 'detached') return null;
  // On coupe au début d'un tour utilisateur pour ne pas laisser d'appel
  // d'outil orphelin.
  let cut = body.length - KEEP_RECENT;
  while (cut > 0 && body[cut]?.role !== 'user') cut--;
  if (cut <= 0) return null;
  detachedPrefix = body.slice(0, cut);
  conversationHistory = [...conversationHistory.slice(0, sysCount), ...body.slice(cut), conversationHistory.at(-1)];
  if (config.debugMode) console.debug('[decision] sujet détaché', r.confidence, `${detachedPrefix.length} messages mis de côté`);
  showTopicChip();
  return () => {
    conversationHistory = fullConversationHistory();
    detachedPrefix = null;
    updateContextMeter();
    saveCurrentConversation();
  };
}
function showTopicChip() {
  const bubbles = document.querySelectorAll('.message-bubble.user');
  const last = bubbles[bubbles.length - 1];
  if (!last) return;
  const chip = document.createElement('div');
  chip.className = 'route-chip route-topic';
  chip.textContent = t('topic_detached');
  chip.title = t('topic_detached_hint');
  last.after(chip);
}
// Indicateur visible pendant que le routeur choisit, puis une pastille qui
// garde le choix (direct / outils / orchestration) en tête de la réponse.
async function withRouteIndicator(bubble, fn) {
  const el = document.createElement('div');
  el.className = 'thinking-indicator route-indicator';
  el.innerHTML = `<span class="thinking-dot"></span><span>${t('route_deciding')}</span>`;
  const textEl = bubble?.querySelector('.msg-text-content');
  if (bubble) { textEl ? bubble.insertBefore(el, textEl) : bubble.appendChild(el); scrollToBottom(); }
  let r = null;
  try { r = await fn(); } finally {
    // Lumen XR : aiguillage du tour (la ceinture d'outils en dépend).
    if (r?.route === "direct") remotePush({ type: "route", route: "direct" });
    if (r?.route && r.engine !== 'rule') {
      const key = { direct: 'route_direct', tools: 'route_tools', orchestrate: 'route_orchestrate' }[r.route];
      el.className = 'route-chip route-' + r.route;
      el.textContent = t(key) + (r.ms ? ` · ${r.ms} ms` : '');
    } else el.remove();
  }
  return r;
}
const ASSISTANT_ROUTE_CATS = new Set([...ASSISTANT_CATS, "web", "vault", "documents"]);
async function decideTurnRoute(query) {
  turnRoute = null;
  if (isSmallTalk(query)) return (turnRoute = { route: "direct", engine: "rule" });
  const history = conversationHistory.slice(0, -1);
  const families = ["mail", "calendar", "files", "notes", "memory", "contacts", "weather", "news", "web search", "apps", "smart home", "reminders"];
  const r = await routeTurn({ query, history, toolFamilies: families, aiSource: config.aiSource, ollamaUrl: config.ollamaUrl, invoke });
  if (!r) return null;
  if (config.debugMode) console.debug("[decision]", r.route, r.confidence, `${r.ms} ms`, r.engine);
  if (r.route === "orchestrate") return (turnRoute = r);
  const signaled = await assistantToolsFor(query);
  if (r.route === "direct" && !signaled.length) return (turnRoute = r);
  // « tools », ou « direct » contredit par un signal fort : catalogue réduit
  // aux familles détectées, sinon à toutes les familles « assistant ».
  let tools = signaled;
  if (!tools.length) {
    const all = await buildFluxoTools();
    tools = all.filter((tl) => ASSISTANT_ROUTE_CATS.has(toolCategory(tl.function?.name)));
  }
  // Le catalogue ne doit jamais manger la fenêtre : au-delà de 45 %, on garde
  // les outils dans l'ordre jusqu'à remplir ce budget (les familles signalées
  // et les outils de base viennent en tête).
  const budget = Math.floor(contextWindow().window * 0.45);
  if (estimateTokens(JSON.stringify(tools)) > budget) {
    const kept = [];
    let used = 0;
    for (const tl of tools) {
      const w = estimateTokens(JSON.stringify(tl));
      if (used + w > budget) continue;
      kept.push(tl);
      used += w;
    }
    tools = kept;
  }
  return (turnRoute = tools.length ? { ...r, route: "tools", tools } : { ...r, route: "direct" });
}

// Catalogue réduit du bouton Mémoire : rappeler et mémoriser, rien d'autre.
// Il passe par le même filtre de publication que le mode Outils — un outil
// décoché dans Réglages › Boîte à outils ne doit pas revenir par cette porte.
// « Mémorise que… », « Retiens : … », « Souviens-toi que je… » : la phrase à
// retenir, ou "" si le message n'est pas un ordre de mémorisation explicite.
// On préfère le texte entre guillemets s'il y en a, sinon ce qui suit le verbe.
function explicitMemoryRequest(text) {
  const raw = String(text || "").trim();
  const m = raw.match(/^(?:s'il te plaît[,\s]*)?(?:mémorise|memorise|retiens|souviens[- ]toi|rappelle[- ]toi|remember|memorize|keep in mind)\b[\s:,-]*(?:que|that|de|of)?\s*(.+)$/i);
  if (!m) return "";
  let body = m[1].trim();
  const quoted = body.match(/^[«"“'](.+?)[»"”']\s*[.!]?$/);
  if (quoted) body = quoted[1].trim();
  body = body.replace(/[.!\s]+$/, "");
  return body.length >= 3 ? body : "";
}

function memoryChatTools() {
  return filterPublishedTools(
    MEMORY_TOOLS.filter((tool) => ["memory_recall", "memory_remember"].includes(tool.function?.name)),
  );
}

function buildDocumentationTools() {
  return MEMORY_TOOLS.filter((t) => t.function?.name === "search_lumen_docs");
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

// Exécution des outils de production de documents.
//
// Le résultat rendu au MODÈLE est une phrase courte : il n'a pas besoin du
// chemin complet, et le lui donner l'incite à le recracher dans sa réponse.
// L'utilisateur, lui, reçoit une carte cliquable — c'est le seul endroit où le
// fichier est réellement à portée de main.
async function callDocumentTool(name, args, bubble) {
  if (name !== "export_pdf") return `Outil inconnu : ${name}`;
  const title = String(args.title || args.name || args.filename || "").trim() || "Document Lumen";
  // Les modèles improvisent le nom du champ de contenu : on accepte les
  // variantes plutôt que d'échouer sur un synonyme.
  let content = String(args.content ?? args.text ?? args.markdown ?? args.body ?? args.document ?? "");
  // Demande la plus courante — « mets ça en PDF » — et celle qui échouait :
  // le modèle appelait l'outil sans recopier son propre texte, et l'outil
  // répondait « rien à exporter ». Une réponse déjà écrite à l'écran est un
  // contenu parfaitement valable : on la reprend.
  if (!content.trim()) content = lastAssistantAnswer();
  if (!content.trim()) {
    return "Échec : aucun contenu à exporter. Écris d'abord le document, ou passe-le dans le paramètre content.";
  }
  const info = await invoke("chat_export_pdf", { title, content });
  appendFileCard(bubble, info);
  return `PDF « ${info.name} » créé dans le dossier Téléchargements (${formatBytes(info.bytes)}).`;
}

/// Dernière réponse rédigée par l'assistant, hors messages d'appel d'outil (dont
/// le contenu est vide) et hors tours de l'utilisateur.
function lastAssistantAnswer() {
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (msg?.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
      return msg.content;
    }
  }
  return "";
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} o`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} Ko`;
  return `${(v / (1024 * 1024)).toFixed(1)} Mo`;
}

// Image générée par l'outil `generate_image` : l'image elle-même, le moteur,
// et un geste pour l'enregistrer dans Téléchargements.
function appendImageCard(bubble, info) {
  const card = document.createElement("div");
  card.className = "image-card";
  card.dataset.name = (info.path || "image").split("/").pop().replace(/\.png$/, "");
  const img = document.createElement("img");
  img.className = "image-card-img";
  img.alt = info.prompt || "";
  img.src = info.data_url;
  const meta = document.createElement("div");
  meta.className = "image-card-meta";
  meta.innerHTML = `<span>${escapeHTML(info.label || info.provider || "")}</span>`
    + (info.sandbox_name ? `<i>${escapeHTML(info.sandbox_name)} · ${escapeHTML(info.path || "")}</i>` : "")
    + `<button type="button" class="file-card-btn" data-act="save">${ic("download")} ${escapeHTML(t("dyn_image_save"))}</button>`;
  meta.querySelector('[data-act="save"]').addEventListener("click", () => {
    invoke("bonsai_save_png", { dataUrl: info.data_url, name: (info.path || "image").split("/").pop().replace(/\.png$/, "") })
      .catch((e) => console.error("[image]", e));
  });
  card.append(img, meta);
  bubble.appendChild(card);
  scrollToBottom();
}

// Carte de fichier produit : le nom, la taille, et les deux gestes qu'on veut
// faire juste après — ouvrir, ou aller voir dans le dossier.
function appendFileCard(bubble, info) {
  const card = document.createElement("div");
  card.className = "file-card";
  card.dataset.path = info.path || "";
  card.innerHTML =
    `<span class="file-card-ic">${ic("pdf")}</span>`
    + `<span class="file-card-tx"><b>${escapeHTML(info.name)}</b>`
    + `<i>${escapeHTML(t("dyn_pdf_in_downloads"))} · ${formatBytes(info.bytes)}</i></span>`
    + `<button type="button" class="file-card-btn" data-act="open">${ic("external-link")} ${escapeHTML(t("dyn_pdf_open"))}</button>`
    + `<button type="button" class="file-card-btn" data-act="reveal">${ic("folderOpen")}</button>`;
  card.querySelector('[data-act="open"]').addEventListener("click", () => {
    invoke("open_exported_file", { path: info.path }).catch((e) => console.error("[pdf]", e));
  });
  const reveal = card.querySelector('[data-act="reveal"]');
  reveal.title = t("dyn_pdf_reveal");
  reveal.addEventListener("click", () => {
    invoke("backup_reveal", { path: info.path }).catch((e) => console.error("[pdf]", e));
  });
  bubble.appendChild(card);
  scrollToBottom();
}

// Appel d'outil terminé : même bloc repliable que pendant le flux (nom en
// en-tête, arguments et résultat au clic), rangé avec les autres blocs.
function appendToolCallNote(bubble, name, input, result) {
  const textEl = bubble.querySelector('.msg-text-content') || bubble;
  let blocks = textEl.querySelector(':scope > .lm-blocks');
  if (!blocks) {
    blocks = document.createElement('div');
    blocks.className = 'lm-blocks';
    textEl.insertBefore(blocks, textEl.querySelector(':scope > .msg-answer'));
  }
  blocks.appendChild(toolBlock({ name, args: input, result }).el);
  scrollToBottom();
}

// Raisonnement restauré depuis l'historique : replié, au-dessus de la réponse.
function appendReasoningBlock(bubble, reasoning) {
  if (!reasoning) return;
  const textEl = bubble.querySelector('.msg-text-content') || bubble;
  let blocks = textEl.querySelector(':scope > .lm-blocks');
  if (!blocks) {
    blocks = document.createElement('div');
    blocks.className = 'lm-blocks';
    textEl.insertBefore(blocks, textEl.querySelector(':scope > .msg-answer'));
  }
  const tb = thinkBlock();
  tb.set(reasoning);
  blocks.insertBefore(tb.el, blocks.firstChild);
}

// Nom du workflow routeur par défaut (semé côté Rust). Équivalent Fluxo du
// « Action Router » d'Apple : reçoit la requête en mode Action + Ollama.
const FLUXO_ROUTER_NAME = "default router";

// Dispatch d'une requête Ollama vers un workflow Fluxo nommé (routeur par défaut
// OU workflow spécifique). Symétrique du chemin Apple (dispatch_action), mais via
// le moteur Fluxo local. Le run_id relie la progression (blocs lumen_progress/
// widget) à la bulle ; model + ollama_url sont injectés pour les blocs IA.
async function runFluxoDispatch(assistantBubble, query, workflowName) {
  const isRouter = workflowName === FLUXO_ROUTER_NAME;
  window.LumenOrb?.setActionExecuting(true);

  const contentEl = assistantBubble.querySelector('.msg-text-content') || assistantBubble;
  const answerEl = contentEl.querySelector('.msg-answer') || contentEl;

  const runId = genRunId();
  const progressEl = document.createElement('div');
  progressEl.className = 'run-progress';
  contentEl.insertBefore(progressEl, answerEl);
  activeRuns[runId] = { progressEl, entries: [] };

  const sourceLabel = isRouter ? t("dyn_source_router") : workflowName;
  answerEl.innerHTML = `<div class="shortcut-loading-indicator"><span class="pulse-dot"></span><span>${t("dyn_calc_via", { source: escapeHTML(sourceLabel) })}</span></div>`;

  try {
    const result = await invoke("run_fluxo_workflow", {
      name: workflowName,
      input: query,
      runId,
      extraVars: { model: currentModel, ollama_url: config.ollamaUrl, lang: getLang() },
    });

    setBubbleRawText(assistantBubble, result);
    answerEl.innerHTML = formatMessage(result);
    remoteSpeak(result);
    if (config.autoSpeak) speakAfterAnnouncements(result);

    const entries = activeRuns[runId]?.entries || [];
    const histMsg = { role: 'assistant', content: result };
    if (entries.length) histMsg.progress = entries;
    conversationHistory.push(histMsg);
    updateContextMeter();
    statusIndicator.className = 'status-dot online';
    saveCurrentConversation();
    scrollToBottom();
  } catch (err) {
    const msg = isRouter
      ? t("dyn_err_router", { err })
      : t("dyn_err_workflow", { name: escapeHTML(workflowName), err });
    showErrorInBubble(assistantBubble, msg);
    statusIndicator.className = 'status-dot offline';
  } finally {
    delete activeRuns[runId];
    window.LumenOrb?.setActionExecuting(false);
    isGenerating = false;
    if (!isSpeaking) window.LumenOrb?.setState('idle');
  }
}

/**
 * Boucle d'appel d'outils de la barre.
 * @param {HTMLElement} assistantBubble bulle où écrire la réponse
 * @param {{tools?: object[], label?: string}} [opts]
 *   `tools` restreint le catalogue exposé au modèle (l'outil mémoire seul, par
 *   exemple) ; sans lui, c'est le catalogue complet du mode Outils.
 */
// Demandes à l'utilisateur (accord sandbox, mot de passe, confirmation, choix
// d'emplacement) : une « porte » par bulle, cartes posées dans la bulle,
// annoncées à voix haute, signalées dans la capsule et relayées au compagnon.
const barGates = new WeakMap();
function gateFor(bubble) {
  if (!bubble) return null;
  let gate = barGates.get(bubble);
  if (!gate) {
    gate = createUserGate({
      invoke,
      lang: getLang(),
      host: () => bubble.querySelector('.msg-text-content') || bubble,
      // La capsule porte la demande elle-même (carte à boutons, cf. capsuleAsk).
      announce: (text) => announceStep(text),
      push: (obj) => { remotePush(obj); capsuleAsk(obj, "lumen-chat"); },
    });
    // L'orbe lève un sourcil tant que Lumen attend une réponse.
    gate.subscribe((waiting) => window.LumenOrb?.setMood?.(waiting ? 'ask' : '', { ms: 0 }));
    barGates.set(bubble, gate);
  }
  return gate;
}
// Demandes de Lumen relayées dans la capsule : on y répond d'un clic, comme
// sur le téléphone (le mot de passe, lui, ne se saisit jamais hors de la barre).
function capsuleAsk(obj, source) {
  if (obj?.type === "user-request") {
    const actions = (obj.options || []).map((o) => ({ id: o.id, label: o.label, primary: !!o.primary }));
    invoke("notify_island", { payload: {
      kind: "prompt", title: obj.title || "Lumen", body: obj.kind === "unlock" ? t("capsule_unlock_hint") : (obj.body || ""),
      icon: "", source, request_id: obj.id, actions: obj.kind === "unlock" ? [] : actions,
    } }).catch(() => {});
  } else if (obj?.type === "user-request-done") {
    window.__TAURI__?.event?.emit("user-request-done", { id: obj.id }).catch?.(() => {});
  }
}
window.__TAURI__?.event?.listen("island-action", (e) => {
  const rid = e.payload?.payload?.request_id;
  if (rid) answerUserRequest(rid, e.payload.id);
});
// Fichiers déposés sur la capsule : joints à la barre, prête pour la question.
window.__TAURI__?.event?.listen("capsule-drop", async (e) => {
  for (const f of e.payload?.files || []) {
    try {
      const bin = atob(f.data || "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await addAttachment(new File([bytes], f.name || "fichier", { type: f.type || "" }));
    } catch (err) { console.warn("[capsule-drop]", err); }
  }
  chatInput?.focus();
});

// Outils qui agissent sur le monde réel : confirmation préalable.
function needsConfirmation(fnName) {
  if (fnName === "domotique_command") return true;
  const mcp = mcpToolMap[fnName];
  return !!mcp && (mcp.effect === "write" || mcp.effect === "destructive" || mcp.risk === "high");
}
function describeAction(fnName, args) {
  if (fnName === "domotique_command") {
    const p = args?.params && typeof args.params === "object" ? Object.entries(args.params).map(([k, v]) => `${k}=${v}`).join(", ") : "";
    return `${args?.action || "set"} « ${args?.device || "?"} »${args?.component ? ` (${args.component})` : ""}${p ? ` : ${p}` : ""}`;
  }
  const mcp = mcpToolMap[fnName];
  return `${mcp ? `${mcp.server} · ${mcp.tool}` : fnName} ${JSON.stringify(args || {}).slice(0, 160)}`;
}

// Exécute un outil du catalogue de la barre (MCP, domotique, direct, web,
// documents, courrier, agents, mémoire, workflows Fluxo). Partagé par la boucle
// d'outils et le mode « Réponse orchestrée ». Ne jette jamais : une erreur
// devient un résultat texte que le modèle peut lire.
// Cache des lectures (par conversation) + journal des accès, cf. lib/tool-cache.js.
function executeBarTool(fnName, args, bubble, runId, ctx) {
  if (ctx?.signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (ctx?.verify) return executeBarToolRaw(fnName, args, bubble, runId);
  return runTool({ name: fnName, args, conversation: String(currentConversationId || ""), surface: "barre", opId: ctx?.opId },
    () => executeBarToolRaw(fnName, args, bubble, runId));
}

async function executeBarToolRaw(fnName, args, bubble, runId) {
  const realName = fluxoToolMap[fnName] || fnName;
  // Orbe physique : icône de l'outil pendant l'appel, puis retour à la réflexion.
  try { window.OrbBridge?.pushActivity?.("tool", "", fnName); } catch (e) {}
  try {
    return await executeBarToolInner(fnName, realName, args, bubble, runId);
  } finally {
    try { window.OrbBridge?.pushActivity?.("thinking"); } catch (e) {}
  }
}

async function executeBarToolInner(fnName, realName, args, bubble, runId) {
  const input = (args && (args.input ?? args.text ?? args.texte)) || "";
  let result;
  try {
    const gate = gateFor(bubble);
    if (gate && needsConfirmation(fnName)) {
      const ok = await gate.confirm({
        title: getLang() === "en" ? `Run: ${describeAction(fnName, args)}` : `Exécuter : ${describeAction(fnName, args)}`,
        spoken: fnName === "domotique_command" ? `${args?.action || "commande"} ${args?.device || ""}` : (mcpToolMap[fnName]?.tool || fnName),
      });
      if (!ok) return getLang() === "en" ? "The user declined this action. Do not retry it; say it was not done." : "L'utilisateur a refusé cette action. Ne la relance pas ; dis qu'elle n'a pas été faite.";
    }
    if (SYSTEM_TOOL_NAMES.has(fnName)) {
      result = await callSystemTool(fnName, args || {}, { host: SYSTEM_HOST, lang: getLang() });
    } else if (APP_DATA_TOOL_NAMES.has(fnName)) {
      result = await callAppDataTool(invoke, fnName, args || {}, { lang: getLang() });
    } else if (APP_WRITE_TOOL_NAMES.has(fnName)) {
      result = await callAppWriteTool(invoke, fnName, args || {}, { gate, lang: getLang() });
    } else if (DATA_TOOL_NAMES.has(fnName)) {
      const lastUser = [...conversationHistory].reverse().find((m) => m.role === "user");
      result = await callDataTool(invoke, fnName, args || {}, {
        gate, lang: getLang(), query: lastUser?.display || lastUser?.content || "",
        // PDF scanné : on prévient que la lecture passe par la vision (plus longue).
        onOcr: () => announceStep(getLang() === "en" ? "It's a scanned document, I'm reading it with vision." : "C'est un document scanné, je le lis avec la vision."),
      });
    } else if (mcpToolMap[fnName]) {
      const target = mcpToolMap[fnName];
      result = await invoke("mcp_call_tool", {
        server: target.server, tool: target.tool, arguments: args || {},
      });
    } else if (DOMOTIQUE_TOOL_NAMES.has(fnName)) {
      result = await callDomotiqueTool(fnName, args || {});
    } else if (LIVE_TOOL_NAMES.has(fnName)) {
      result = await callLiveTool(invoke, fnName, args || {});
      // L'image générée s'affiche dans la bulle, à côté du texte que
      // le modèle va rédiger : c'est elle qu'on est venu chercher.
      if (fnName === "generate_image") {
        const img = takeGeneratedImage();
        if (img?.data_url) appendImageCard(bubble, img);
      }
    } else if (WEB_TOOL_NAMES.has(fnName)) {
      result = await callWebTool(invoke, fnName, args || {});
    } else if (DOCUMENT_TOOL_NAMES.has(fnName)) {
      result = await callDocumentTool(fnName, args || {}, bubble);
    } else if (MAIL_TOOL_NAMES.has(fnName)) {
      result = await callMailTool(invoke, fnName, args || {}, { lang: getLang() });
    } else if (DOC_TOOL_NAMES.has(fnName)) {
      result = await callDocTool(invoke, fnName, args || {}, {
        bubble: bubble, lang: getLang(),
        // Choix d'emplacement : carte + annonce + réponse possible depuis le téléphone.
        chooseSandbox: ({ suggestedId }) => gateFor(bubble).chooseSandbox({ suggestedId, what: getLang() === "en" ? "the document" : "le document" }),
        // Déverrouillage, puis accord sur les sandboxes à lire comme sources.
        authorizeSandboxes: async (why) => {
          if (!(await gateFor(bubble).ensureUnlocked())) return [];
          const all = await invoke("sandbox_list").catch(() => []);
          return all?.length ? gateFor(bubble).authorizeSandboxes(all, why) : [];
        },
      });
    } else if (isAgentTool(fnName)) {
      result = await callAgentTool(invoke, fnName, args || {}, { bubble: bubble, lang: getLang() });
    } else if (MEMORY_TOOL_NAMES.has(fnName)) {
      result = await callMemoryTool(fnName, args || {});
    } else if (intentToolMap[fnName]) {
      const { appId, intent } = intentToolMap[fnName];
      const out = await runAppIntent(appId, intent, args || {}, openAppViewForIntent);
      result = typeof out === "string" ? out : JSON.stringify(out ?? "OK");
    } else {
      result = await invoke("run_fluxo_workflow", { name: realName, input: String(input), runId });
    }
  } catch (e) {
    result = `Erreur : ${e}`;
  }
  return String(result);
}

// Réponse orchestrée (lib/orchestrator.js) dans une bulle de la barre. Même
// catalogue et même exécuteur que le mode Outils ; en plus, un panneau
// d'étapes en tête de bulle, rejoué au rechargement de la conversation.
// ---- Annonces vocales des étapes (réponse orchestrée) ----------------------
// File d'annonces : une annonce en attente est REMPLACÉE par la suivante (on
// ne rattrape pas des étapes déjà passées), et la réponse finale n'est lue
// qu'une fois l'annonce en cours terminée.
let announceChain = Promise.resolve();
let announcePending = null;
function waitSpeechIdle() {
  return new Promise((resolve) => {
    const tick = () => (isSpeaking ? setTimeout(tick, 120) : resolve());
    tick();
  });
}
function announceStep(text) {
  // Étape annoncée (« Je consulte la météo ») : libellé sous l'orbe physique.
  try { if (text) window.OrbBridge?.pushActivity?.("thinking", text); } catch (e) {}
  if (!text) return;
  // Téléphone et Lumen XR décident eux-mêmes s'ils lisent (leur lecture auto).
  remotePush({ type: "announce", text });
  if (!config.autoSpeak) return;
  announcePending = text;
  announceChain = announceChain.then(async () => {
    if (announcePending !== text || stopRequested) return;
    announcePending = null;
    await waitSpeechIdle();
    await speakText(text);
  }).catch(() => {});
}
async function speakAfterAnnouncements(text) {
  announcePending = null;          // les annonces encore en attente sont périmées
  await announceChain;
  await waitSpeechIdle();
  return speakText(text);
}

// Ouvre une source dans Lumen Desktop (fichier, note, app, lien) : la fenêtre
// du bureau écoute `lumen-open` (cf. sandbox/desktop.js).
function openInLumen(open) {
  if (!open) return;
  if (open.kind === "url") { invoke("open_external", { url: open.url }).catch(() => {}); return; }
  window.__TAURI__?.event?.emit?.("lumen-open", open).catch?.(() => {});
}
// Sources cliquables + suites en un clic sous une réponse (lib/answer-extras.js).
function addAnswerExtras(bubble, text, notes) {
  const host = bubble?.querySelector('.msg-text-content') || bubble;
  renderAnswerExtras(host, {
    text, notes, lang: getLang(), icon: (n) => ic(n),
    onOpen: openInLumen,
    onPrompt: (p) => { if (isGenerating) return; chatInput.value = p; autosizeChatInput(); handleSend(); },
    // « Envoyer au téléphone » : notification sur les compagnons connectés.
    onPhone: (t) => invoke("notify_island", { payload: { kind: "info", title: "Lumen", body: String(t).slice(0, 600), icon: "", source: "lumen-chat" } }),
  });
}

// ===== Mode LLM hybride (Réglages › llmHybrid) =====
// Après chaque tour : réponse vide, erreur, outils en échec ou recherches sans
// résultat (cf. looksFailed) → la seule suite proposée est de rejouer la
// demande sur l'API cloud, à la place de « Ajouter au Kanban ».
async function offerApiEscalation(query) {
  const last = conversationHistory[conversationHistory.length - 1];
  const answered = last?.role === 'assistant';
  const notes = (answered && Array.isArray(last.toolNotes) ? last.toolNotes : []).map((n) => ({ ...n, name: n.tool || n.name }));
  if (answered && !looksFailed(last.content, notes)) return;
  if (!(await apiEscalationAvailable())) return;
  let bubble = [...messagesList.querySelectorAll('.message-bubble')].pop();
  // Erreur sans bulle de réponse : on en pose une pour porter le bouton.
  if (!bubble || bubble.classList.contains('user')) {
    bubble = document.createElement('div');
    bubble.className = 'message-bubble assistant';
    messagesList.appendChild(bubble);
  }
  const host = bubble.querySelector('.msg-text-content') || bubble;
  renderAnswerExtras(host, {
    text: answered ? String(last.content || '') : '', notes, lang: getLang(), icon: (n) => ic(n),
    onOpen: openInLumen, onPrompt: () => {},
    onEscalate: () => escalateToApi(query),
  });
  scrollToBottom();
}

// Rejoue la demande sur l'API le temps d'UN tour : `config.aiSource` (barre)
// et la surcharge de llm.js (backends, proxy Rust) basculent ensemble, puis
// sont restaurés — rien n'est enregistré dans les Réglages.
async function escalateToApi(query) {
  if (isGenerating) return;
  showHint(getLang() === 'en' ? 'Escalating to the cloud API…' : "Escalade vers l'API cloud…");
  const prev = config.aiSource;
  config.aiSource = 'api';
  try { await withApiEscalation(() => handleSend(query)); } finally { config.aiSource = prev; }
}

// Le tour courant porte-t-il une image ? Les modes Routeur / Workflow /
// Documentation ne transmettent que du texte : une photo (« Regarde » du casque)
// y était perdue en silence. Ces tours passent donc par la discussion.
function turnHasImages() {
  const last = conversationHistory[conversationHistory.length - 1];
  return !!(last && last.role === 'user' && Array.isArray(last.images) && last.images.length);
}

/// Le modèle courant est-il assez petit pour le planificateur par règles
/// (profil `planner` de limitsFor : 350M à 1.2B) ?
function smallModelPlanner() {
  const b = llmBackend();
  return !!limitsFor(b?.model || "", config.aiSource || "").planner;
}

async function runOrchestratedChat(assistantBubble, query) {
  // Lumen XR : la ceinture d'outils ne s'affiche qu'en mode outils/orchestration.
  remotePush({ type: "route", route: "orchestrate" });
  const lang = getLang();
  const runId = genRunId();
  const progressEl = document.createElement('div');
  progressEl.className = 'run-progress';
  assistantBubble.appendChild(progressEl);
  activeRuns[runId] = { progressEl, entries: [] };
  const sv = bubbleStreamView(assistantBubble);
  const plan = planBlock({ title: orchestratorText(lang).title });
  sv.view.blocksEl.prepend(plan.el);
  scrollToBottom();
  try {
    const tools = withoutDocToolsUnlessWriting(await buildFluxoTools(), query);
    const categoryOverrides = {};
    Object.keys(fluxoToolMap).forEach((n) => { categoryOverrides[n] = "automation"; });
    Object.keys(mcpToolMap).forEach((n) => { categoryOverrides[n] = "mcp"; });
    // La question est le dernier message de l'historique : on la retire du contexte.
    const history = conversationHistory.slice(0, -1);
    if (!currentConversationId) saveCurrentConversation();
    const out = await runOrchestrated({
      invoke, sessionId: `conversation:${currentConversationId}`, turnId: history.length,
      ...orchestrationBackends(llmBackend()),
      query, history, tools, categoryOverrides, lang,
      chat: llmChat,
      // Système 1 (Tev1) : choix d'outil, effort, ambiguïté, injection, vérification rapide.
      decider: appDecider({ aiSource: config.aiSource, ollamaUrl: config.ollamaUrl, invoke }),
      execTool: (name, args, ctx) => executeBarTool(name, args, assistantBubble, runId, ctx),
      // Images du tour (capture « Regarde » du casque, collage, écran) : sans
      // elles, le mode orchestré répondait sans jamais voir la photo.
      images: Array.isArray(conversationHistory.at(-1)?.images) ? conversationHistory.at(-1).images : [],
      view: sv.view,
      plan,
      signal: generationAbort?.signal,
      onUsage: (data, label) => { if (data) recordOllamaUsage(data, label); },
      onAnnounce: announceStep,
      displayNames: fluxoToolMap,
      gate: gateFor(assistantBubble),
      pinned: turnPinned,
    });
    const finalText = out.text;
    recordOrchestration(invoke, query, out, llmBackend()?.model || "");
    setBubbleRawText(assistantBubble, finalText);
    // Affichage avec les sources citées [n] ; voix et historique sans crochets.
    sv.answerEl.innerHTML = formatMessage(out.display || finalText || "");
    addAnswerExtras(assistantBubble, finalText, out.toolNotes);
    const cards = snapshotToolCards(assistantBubble);
    conversationHistory.push({
      role: 'assistant', content: finalText,
      ...(out.reasoning ? { reasoning: out.reasoning } : {}),
      ...(out.toolNotes.length ? { toolNotes: out.toolNotes.map((n) => ({ ...n, result: n.result.slice(0, 4000) })) } : {}),
      ...(cards.length ? { cards } : {}),
      orchestration: out.plan,
    });
    pushOrbMessage(finalText);
    updateContextMeter();
    statusIndicator.className = 'status-dot online';
    saveCurrentConversation();
    remoteSpeak(finalText);
    // Seule la réponse FINALE (après vérification / révision) est lue, après
    // la dernière annonce d'étape.
    if (config.autoSpeak && finalText) speakAfterAnnouncements(finalText);
    scrollToBottom();
  } catch (error) {
    const aborted = error?.name === "AbortError" || stopRequested;
    plan.fail(aborted ? t("controller_stopped") : String(error?.message || error).slice(0, 200));
    if (!aborted) {
      console.error("[orchestration]", error);
      showErrorInBubble(assistantBubble, escapeHTML(String(error?.message || error)).slice(0, 300));
      statusIndicator.className = 'status-dot offline';
    }
  } finally {
    isGenerating = false;
    if (!isSpeaking) window.LumenOrb?.setState('idle');
    const run = activeRuns[runId];
    if (run && (!run.entries || run.entries.length === 0)) run.progressEl?.remove();
    delete activeRuns[runId];
  }
}

async function runOllamaAgent(assistantBubble, opts = {}) {
  remotePush({ type: "route", route: "tools" });
  const loadingEl = assistantBubble.querySelector('.msg-text-content') || assistantBubble;
  const docsMode = config.ollamaMode === 'docs';
  const waitLabel = opts.label || (docsMode ? "Recherche dans la documentation…" : "Réflexion (outils Fluxo)…");
  loadingEl.innerHTML = `<div class="shortcut-loading-indicator"><span class="pulse-dot"></span><span>${escapeHTML(waitLabel)}</span></div>`;

  // Panneau de progression : les blocs de retour Fluxo (progression, widget)
  // POSTent vers le serveur local avec ce run_id ; les évènements `run-progress`
  // reçus sont rendus ici. Ajouté en enfant direct de la bulle pour survivre à
  // l'écriture du texte final (qui réécrit `.msg-text-content`).
  const runId = genRunId();
  const progressEl = document.createElement('div');
  progressEl.className = 'run-progress';
  assistantBubble.appendChild(progressEl);
  activeRuns[runId] = { progressEl, entries: [] };

  try {
    // Outils de rédaction (doc_*) seulement si l'utilisateur demande de produire
    // un document : sinon le modèle « répond » en écrivant un fichier.
    const lastAsk = [...conversationHistory].reverse().find((m) => m.role === "user");
    const tools = opts.tools || (docsMode ? buildDocumentationTools()
      : withoutDocToolsUnlessWriting(await buildFluxoTools(), lastAsk?.display || lastAsk?.content || ""));
    // La jauge de contexte doit compter ce que pèsent les outils envoyés :
    // sans eux elle affichait ~0 % alors que la requête saturait la fenêtre.
    lastToolTokens = estimateTokens(JSON.stringify(tools || []));
    updateContextMeter();
    let finalText = "";
    const toolNotes = [];
    const docsSystem = {
      role: "system",
      content: resolvePrompt("desktop.docs", "Tu es l'assistant de documentation de Lumen. Réponds uniquement à partir de la documentation fournie par l'outil search_lumen_docs. Appelle cet outil avant de répondre. Si l'information n'est pas présente, dis-le clairement et propose la page/catégorie à consulter. Cite les pages entre parenthèses quand c'est utile."),
    };

    if (config.debugMode) {
      showDebugPrompt(assistantBubble, 'Ollama (Fluxo tools) · ' + currentModel,
        JSON.stringify({ messages: docsMode ? [docsSystem, ...conversationHistory] : conversationHistory, tools }, null, 2));
    }

    const isApi = isApiLike(config.aiSource);
    // Famille Liquid AI : ce sont des moteurs de décision, pas des causeurs.
    // Leur fiche officielle impose un prompt système COURT ; le prompt Lumen
    // complet (identité + profil + mémoires + règles, ~1 400 tokens) les fait
    // répondre à côté, en anglais, sans appeler l'outil qui convenait. On leur
    // compose donc un bloc système minimal, et on saute l'injection de mémoire
    // — deux blocs de contexte en moins pour un modèle qui en a peu.
    const lfm = !docsMode && isLfmModel(currentModel);
    const lfmSystem = { role: "system", content: resolvePrompt("tools.lfm", LFM_TOOLS_SYSTEM) };
    // Outils mentionnés avec « @ » : au PREMIER tour seulement, consigne +
    // forçage de l'appel (cf. forcedToolTurn) ; ensuite le modèle doit pouvoir
    // conclure en texte.
    const forced = opts.forced ? forcedToolTurn(tools, getLang()) : null;
    // Flux : raisonnement et appels d'outils en blocs repliables, texte au fil
    // de l'eau. L'indicateur d'attente disparaît au premier signe de vie.
    const sv = bubbleStreamView(assistantBubble);
    const dropWait = () => loadingEl.querySelector('.shortcut-loading-indicator')?.remove();
    let turnReasoning = "";
    for (let turn = 0; turn < 6; turn++) {
      if (turn > 0) sv.view.nextTurn();
      const hooks = canStream() ? sv.hooks(dropWait) : null;
      let data;
      const lastUser = [...conversationHistory].reverse().find((m) => m.role === "user");
      const recalled = lfm
        ? conversationHistory
        : await withMemoryRecall(invoke, conversationHistory, lastUser?.content || "", { context: "bar", limit: docsMode ? 3 : 5 });
      const force = forced && turn === 0;
      const modelMessages = [
        ...(docsMode
          ? [docsSystem, ...recalled]
          : lfm
            ? [lfmSystem, ...recalled.filter((m) => m?.role !== "system")]
            : recalled),
        ...(force ? [forced.system] : []),
      ];
      if (isApi) {
        // Proxy backend sécurisé : la clé API ne transite pas par la WebView.
        const body = { model: cloudModel(), messages: modelMessages, tools, ...(force ? { tool_choice: forced.toolChoice } : {}) };
        const backend = rustBackend(localStorage.getItem("aiSource"));
        data = hooks
          ? await streamInvoke({ target: "api", payload: body, backend }, hooks)
          : await invoke("llm_api_request", { path: "chat/completions", body, backend });
      } else {
        data = await ollamaPostJson("api/chat", {
          model: currentModel,
          messages: modelMessages,
          // Le bloc système est déjà composé ci-dessus : le chemin llama.cpp ne
          // doit pas y remettre le prompt Lumen (cf. ollamaPostJson).
          rawSystem: lfm,
          tools,
          tool_choice: force ? "required" : "auto",
          ...(config.aiSource === 'llama' ? { think: Boolean(config.ollamaThink) } : (config.ollamaThink ? { think: true } : {})),
          ...(config.ollamaNumCtx > 0 ? { options: { num_ctx: config.ollamaNumCtx } } : {}),
          keep_alive: keepAliveValue(),
          stream: false,
        }, config.ollamaUrl, hooks);
      }
      if (isApi) data = withOpenAiTimings(data);
      dropWait();
      recordOllamaUsage(data, "main-tools");
      // OpenAI : message dans choices[0].message ; Ollama : message direct.
      const msg = isApi ? ((data.choices && data.choices[0] && data.choices[0].message) || {}) : (data.message || {});
      const parts = splitMessage(msg);
      if (parts.reasoning) turnReasoning = parts.reasoning;
      if (!sv.state && parts.reasoning) sv.view.update({ answer: "", reasoning: parts.reasoning, tools: [], thinking: false, reasoningSeconds: 0 });
      if (data?.cancelled) { finalText = parts.answer; break; }

      if (msg.tool_calls && msg.tool_calls.length) {
        conversationHistory.push({ role: 'assistant', content: parts.answer, tool_calls: msg.tool_calls });
        // Le texte d'accompagnement d'un tour d'outils (« je regarde… ») n'est
        // pas la réponse : il reste lisible le temps de l'appel, puis s'efface.
        for (const [callIndex, call] of msg.tool_calls.entries()) {
          const fnName = call.function && call.function.name;
          const realName = fluxoToolMap[fnName] || fnName;
          let args = call.function && call.function.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
          const input = (args && (args.input ?? args.text ?? args.texte)) || "";
          const result = await executeBarTool(fnName, args, assistantBubble, runId);
          const note = {
            name: mcpToolMap[fnName] ? `MCP · ${mcpToolMap[fnName].tool}`
              : (DOMOTIQUE_TOOL_NAMES.has(fnName) || WEB_TOOL_NAMES.has(fnName) || DOCUMENT_TOOL_NAMES.has(fnName) || LIVE_TOOL_NAMES.has(fnName) || DOC_TOOL_NAMES.has(fnName) || MAIL_TOOL_NAMES.has(fnName) || isAgentTool(fnName)) ? fnName : realName,
            input: input || args?.query || args?.url || args?.device || args?.title || args?.place || args?.league || args?.task || args?.brief || args?.question || "",
            result: String(result),
            args: args || {},
            tool: fnName,
          };
          sv.view.toolResult(callIndex, note.name, args || note.input, note.result);
          playUi(/^(Erreur|Error)\b/i.test(String(note.result || '').trim()) ? 'error' : 'tick');
          toolNotes.push(note);
          if (stopRequested) break;
          // OpenAI exige tool_call_id ; Ollama se contente du name.
          const toolReply = { role: 'tool', content: String(result), name: fnName };
          if (isApi && call.id) toolReply.tool_call_id = call.id;
          conversationHistory.push(toolReply);
        }
        if (stopRequested) break;
        continue; // reboucle pour exploiter les résultats
      }

      finalText = parts.answer;
      // Filet : l'utilisateur a DEMANDÉ explicitement de mémoriser et le modèle a
      // répondu sans appeler l'outil (les petits modèles — Apple sur l'appareil,
      // LFM… — préfèrent expliquer « comment mémoriser » plutôt que d'appeler
      // memory_remember). L'intention étant sans ambiguïté, on enregistre le
      // souvenir nous-mêmes et on le dit, plutôt que de laisser la demande sans
      // effet avec l'icône mémoire allumée.
      const explicit = !toolNotes.some((n) => n.name === "memory_remember")
        && tools.some((tl) => tl.function?.name === "memory_remember")
        && explicitMemoryRequest(lastUser?.content || "");
      if (explicit) {
        const result = await callMemoryTool("memory_remember", { text: explicit, kind: "episodic" }).catch((e) => `Erreur : ${e}`);
        const note = { name: "memory_remember", input: explicit, result: String(result) };
        appendToolCallNote(assistantBubble, note.name, note.input, note.result);
        toolNotes.push(note);
        finalText = t("dyn_memory_saved_direct", { text: explicit });
      }
      break;
    }

    sv.view.finish();
    dropWait();
    const html = finalText ? formatMessage(finalText) : "<em>(workflow exécuté)</em>";
    setBubbleRawText(assistantBubble, finalText);
    sv.answerEl.innerHTML = html;
    if (finalText) addAnswerExtras(assistantBubble, finalText, toolNotes.map((n) => ({ ...n, name: n.tool || n.name })));
    const cards = snapshotToolCards(assistantBubble);
    conversationHistory.push({ role: 'assistant', content: finalText, ...(turnReasoning ? { reasoning: turnReasoning } : {}), ...(toolNotes.length ? { toolNotes } : {}), ...(cards.length ? { cards } : {}) });
    pushOrbMessage(finalText);
    statusIndicator.className = 'status-dot online';
    saveCurrentConversation();
    remoteSpeak(finalText);
    if (config.autoSpeak && finalText) speakAfterAnnouncements(finalText);
    scrollToBottom();
  } catch (error) {
    // La cause exacte VIENT EN PREMIER. Ce bloc n'affichait qu'un conseil
    // générique : quelle que soit la panne — modèle sans outils, serveur
    // injoignable, requête rejetée — l'utilisateur lisait la même phrase et
    // n'avait aucun moyen de savoir laquelle des trois pistes le concernait.
    const detail = escapeHTML(String(error?.message || error || "")).slice(0, 300);
    console.error("[outils]", error);
    showErrorInBubble(assistantBubble,
      (detail ? `${detail}<br><br>` : "")
      + `Function calling impossible. Vérifie qu'un modèle compatible outils est sélectionné, que llama-server est lancé avec <code>--jinja</code> et que le template GGUF prend en charge les outils.`);
    statusIndicator.className = 'status-dot offline';
  } finally {
    isGenerating = false;
    if (!isSpeaking) window.LumenOrb?.setState('idle');
    // Libère le tampon du run ; retire le panneau s'il est resté vide.
    const run = activeRuns[runId];
    if (run && (!run.entries || run.entries.length === 0)) run.progressEl?.remove();
    delete activeRuns[runId];
  }
}
