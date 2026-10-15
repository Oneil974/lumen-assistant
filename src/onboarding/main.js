import { t, getLang, setLang, applyI18n } from "../i18n.js";
import { ollamaGetJson, llmChat } from "../llm.js";
import { WHISPER_MODELS, whisperLoad, whisperModelId } from "../lib/whisper-dictation.js";
import { LLAMA_MODEL_CATALOG, llamaModelLabel } from "../llama-models.js";
import { createCatalogPicker } from "../lib/catalog-picker.js";
import { appleShortcutsAvailable } from "../lib/platform-flavor.js";
import { renderExpectations } from "../lib/model-expectations.js";
import { mountExpress } from "./express.js";
import { mountDecisionCard, installDecisionInBackground } from "../lib/decision-installer.js";
import {
  llamaCatalogItem, loadHardware, loadPartials, hardware, hardwareBannerText, diskTooSmall, formatBytes,
} from "../lib/llama-download.js";

const { invoke } = window.__TAURI__?.core || { invoke: async () => {} };
const tauriEvent = window.__TAURI__?.event;
const currentWindow = window.__TAURI__?.window?.getCurrentWindow?.();
const DEFAULT_OLLAMA_MODEL = "liquidai/lfm2.5-350m:latest";
const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
let appleAvailable = true; // recalculé selon la plateforme au démarrage
const LEGACY_OLLAMA_MODELS = new Set(["liquid-fm:350m"]);

function storedOllamaModel() {
  const stored = localStorage.getItem("selectedModel") || "";
  if (!stored || LEGACY_OLLAMA_MODELS.has(stored)) {
    localStorage.setItem("selectedModel", DEFAULT_OLLAMA_MODEL);
    return DEFAULT_OLLAMA_MODEL;
  }
  return stored;
}

// Modèles Ollama via le backend (fiable sous Windows : pas de CORS WebView2 ni de
// résolution IPv6 de `localhost`). Repli sur un fetch direct.
async function listOllamaModels(url) {
  if (localStorage.getItem("aiSource") === "llama") {
    const models = await invoke("llama_list_models");
    return (Array.isArray(models) ? models : []).map((m) => m.filename).filter(Boolean);
  }
  try {
    const models = await invoke("ollama_list_models", { url });
    if (Array.isArray(models)) return models.filter(Boolean);
  } catch (e) {
    try {
      const data = await ollamaGetJson("api/tags", url || "http://127.0.0.1:11434");
      return (data.models || []).map((m) => m.name).filter(Boolean);
    } catch { throw e; }
  }
  return [];
}

const REQUIRED_SHORTCUTS = [
  { key: "shortcut", name: "Apple Intelligence", icloudUrl: "https://www.icloud.com/shortcuts/ab65c1d46e7f4d0088c0cd9a7a86e5d0" },
  { key: "action", name: "Action Router", icloudUrl: "https://www.icloud.com/shortcuts/305a50cf9df94e64b8dcfc8be2dc8e78" },
  { key: "speak", name: "Speak Text", icloudUrl: "https://www.icloud.com/shortcuts/8930832d8d3d4deba6a6020d022b36c1" },
  { key: "dictate", name: "Dictate Text", icloudUrl: "https://www.icloud.com/shortcuts/ea65f5134f4f4589ae07e79c56a31bf0" },
  { key: "heartbeat", name: "Heartbeat", icloudUrl: "https://www.icloud.com/shortcuts/045a26b9031c4fd1b9810e3674023082" },
];
const LAST_STEP = 6;
let step = 0;
let aiSource = localStorage.getItem("aiSource") || "llama";
// Démarrage express : llama.cpp avec tout installé d'office (express.js).
let express = localStorage.getItem("onboardingDone") !== "true";
let expressUi = null;

const $ = (id) => document.getElementById(id);
const panel = $("onboarding-panel");
const title = $("onboarding-title");
const dots = $("onboarding-dots");
const prevBtn = $("btn-onboarding-prev");
const nextBtn = $("btn-onboarding-next");
const shortcutCards = $("shortcut-cards");

const ICONS = {
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a1.8 1.8 0 00.4 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.8 1.8 0 00-3 .7 1.8 1.8 0 01-1.7 1.2 2 2 0 11-2-2 1.8 1.8 0 00-1.2-1.7 1.8 1.8 0 00-1.9.4l-.1.1A2 2 0 113.5 16l.1-.1a1.8 1.8 0 00-1.6-3 2 2 0 010-3.8 1.8 1.8 0 001.6-3l-.1-.1A2 2 0 116.4 3.5l.1.1a1.8 1.8 0 003-1.4 2 2 0 013.8 0 1.8 1.8 0 003 1.4l.1-.1A2 2 0 1120.5 6.4l-.1.1a1.8 1.8 0 001.4 3 2 2 0 010 3.8 1.8 1.8 0 00-1.4 1.2z"/>',
  chat: '<path d="M21 11.5A8 8 0 019.5 18.6L4 20l1.4-5.3A8 8 0 1121 11.5z"/>',
  bell: '<path d="M18 16V11a6 6 0 10-12 0v5l-2 2.2h16z"/><path d="M10 21a2 2 0 004 0"/>',
  moon: '<path d="M21 13.5A8.5 8.5 0 1110.5 3 6.6 6.6 0 0021 13.5z"/>',
  bolt: '<path d="M13 2L5 13.5h5.5L10 22l8-11.5h-5.5z"/>',
  speaker: '<path d="M5 9.5v5h3l4.5 3.5V6L8 9.5z"/><path d="M16 9.5a4 4 0 010 5"/><path d="M18.5 7.5a7 7 0 010 9"/>',
  heart: '<path d="M12 20s-6.8-4.3-9.2-8.6C1.3 8.2 2.8 4.8 6 4.8c2 0 3.2 1.3 4 2.4.8-1.1 2-2.4 4-2.4 3.2 0 4.7 3.4 3.2 6.6C18.8 15.7 12 20 12 20z" fill="currentColor" stroke="none"/>',
  heartbeat: '<path d="M3 12h4l2-5 3 10 2.5-6.5L16 12h5"/>',
  mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0012 0"/><path d="M12 17v4M9 21h6"/>',
  retry: '<path d="M20 11a8 8 0 10-2.3 6"/><path d="M20 5.5V11h-5.5"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M9.5 13h5M9.5 16.5h5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 10l3 2.6-3 2.6M13 15.2h4"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9.5 2.5v2M14.5 2.5v2M9.5 19.5v2M14.5 19.5v2M2.5 9.5h2M2.5 14.5h2M19.5 9.5h2M19.5 14.5h2"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
  cursor: '<path d="M5 3l13.5 6.5-5.8 2-2 5.8z"/>',
};

/** L'interrupteur Whisper dit son état en toutes lettres, pas seulement par sa couleur. */
function syncWhisperSwitchLabel() {
  const el = $("ob-whisper-state");
  const chk = $("ob-whisper-enable");
  if (el && chk) el.textContent = t(chk.checked ? "ob_switch_on" : "ob_switch_off");
}

function applyIcons() {
  document.querySelectorAll("[data-icon]").forEach((el) => {
    const inner = ICONS[el.dataset.icon] || "";
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  });
}

function order() {
  if (express) return [0, 14, 9];
  if (aiSource === "llama") return [0, 9, 10, 12, 8, 13, 3, 4, 5, 6];
  if (aiSource === "ollama") return [0, 9, 7, 12, 8, 13, 3, 4, 5, 6];
  if (aiSource === "api") return [0, 9, 11, 12, 8, 13, 3, 4, 5, 6];
  return [0, 9, 1, 2, 12, 8, 13, 3, 4, 5, 6];
}

function goToStep(next) {
  const steps = order();
  let index = steps.indexOf(next);
  if (index < 0) index = 0;
  step = steps[index];
  document.querySelectorAll(".onboarding-step").forEach((el) => {
    el.hidden = Number(el.dataset.step) !== step;
  });
  title.textContent = t(`ob_title_${step}`);
  dots.innerHTML = "";
  steps.forEach((_, i) => {
    const dot = document.createElement("span");
    dot.className = "dot" + (i === index ? " active" : i < index ? " done" : "");
    dots.appendChild(dot);
  });
  prevBtn.disabled = index === 0;
  nextBtn.textContent = index >= steps.length - 1 ? t("ob_finish") : t("ob_next");
  panel.querySelector(".onboarding-body")?.scrollTo(0, 0);
  if (step === 1) checkShortcutsInstalled();
  if (step === 7) { fetchOnboardingModels(); detectOllamaPresence(); }
  if (step === 10) { refreshLlamaStep(); mountDecisionStep("llama"); }
  if (step === 7) mountDecisionStep("ollama");
  if (step === 11) prefillApiStep();
  if (step === 12) prepareTestStep();
  if (step === 8) initWhisperOnboarding();
  if (step === 9) prefillProfileStep();
  if (step === 13) initVoiceOnboarding();
  if (step === 14 && !expressUi) {
    expressUi = mountExpress($("ob-express"), { onState: (st) => { nextBtn.disabled = st === "busy"; } });
  }
  if (step === 14) nextBtn.disabled = Boolean(expressUi?.isRunning());
  else nextBtn.disabled = false;
}

// ===== Étape « Ton profil » : renomme le profil de session actif et pose
// éventuellement son mot de passe (vérifié côté Rust, cf. session.rs). =====
// Mot de passe posé PENDANT ce parcours. L'assistant se parcourt dans les deux
// sens : revenir sur cette étape puis repartir en avant re-soumettait le même
// mot de passe, que le backend refusait — il en existait désormais un, et
// changer un mot de passe exige l'ancien. L'utilisateur se voyait alors réclamer
// « le mot de passe actuel » qu'il venait de choisir, sans champ pour le saisir.
//
// On retient donc ce qu'on a posé : refaire le trajet ne redemande rien, et
// modifier réellement le mot de passe reste possible sans ressaisie.
let passwordSetThisRun = null;

async function prefillProfileStep() {
  const nameEl = $("ob-profile-name");
  if (nameEl && !nameEl.value.trim()) {
    try {
      const data = await invoke("session_profiles");
      const active = (data?.profiles || []).find((p) => p.id === data?.active_id) || (data?.profiles || [])[0];
      if (active?.name && active.name !== "Utilisateur") nameEl.value = active.name;
    } catch {}
  }
  await refreshProfilePasswordUI();
}

/// Adapte l'étape à un profil qui a déjà un mot de passe.
///
/// Deux cas très différents se ressemblent à l'écran : celui qui repasse sur
/// l'étape après en avoir posé un ici même (on connaît l'ancien, on ne demande
/// rien), et celui qui installe Lumen sur un profil déjà protégé (il faut
/// l'ancien, et donc un champ pour le saisir).
async function refreshProfilePasswordUI() {
  const row = $("ob-profile-current-row");
  const note = $("ob-profile-status");
  if (!row) return;
  let hasPassword = false;
  try {
    hasPassword = Boolean((await invoke("session_lock_status"))?.has_password);
  } catch { hasPassword = false; }
  const needsOld = hasPassword && !passwordSetThisRun;
  row.hidden = !needsOld;
  if (!needsOld) $("ob-profile-current").value = "";
  if (note) {
    note.textContent = needsOld
      ? t("ob_profile_has_password")
      : hasPassword
        ? t("ob_profile_password_set")
        : t("ob_profile_note");
  }
}

async function saveProfileStep() {
  const name = $("ob-profile-name")?.value.trim() || "";
  const pass = $("ob-profile-pass")?.value || "";
  const pass2 = $("ob-profile-pass2")?.value || "";
  const status = $("ob-profile-status");
  if ((pass || pass2) && pass !== pass2) {
    if (status) status.textContent = t("ob_profile_pass_mismatch");
    return false;
  }
  try {
    if (name) {
      const activeId = await invoke("session_active_profile_id").catch(() => null);
      await invoke("session_save_profile", { id: activeId, name, avatar: null });
    }
    if (pass) await applyProfilePassword(pass, status);
  } catch (e) {
    if (status) status.textContent = String(e?.message || e);
    return false;
  }
  return true;
}

async function applyProfilePassword(pass, status) {
  // Rien n'a changé depuis notre propre passage : ne pas rappeler le backend
  // évite de resaler et rehacher pour rien, et surtout de réclamer un ancien
  // mot de passe pour le remplacer par lui-même.
  if (passwordSetThisRun === pass) return;

  let hasPassword = false;
  try {
    hasPassword = Boolean((await invoke("session_lock_status"))?.has_password);
  } catch {}

  let currentPassword = passwordSetThisRun;
  if (hasPassword && !currentPassword) {
    currentPassword = $("ob-profile-current")?.value || "";
    if (!currentPassword) {
      // On ne laisse pas remonter l'erreur brute du backend : elle réclame un
      // mot de passe sans dire où le saisir. On ouvre le champ d'abord.
      await refreshProfilePasswordUI();
      $("ob-profile-current")?.focus();
      throw new Error(t("ob_profile_need_current"));
    }
  }
  await invoke("session_set_password", {
    password: pass,
    currentPassword: hasPassword ? currentPassword : null,
  });
  passwordSetThisRun = pass;
  if (status) status.textContent = t("ob_profile_password_set");
  await refreshProfilePasswordUI();
}

// ===== Étape « API cloud » : la clé, sans quoi ce parcours ne mène nulle part =====
//
// La clé n'est jamais conservée côté interface : elle part directement dans
// `set_ollama_config`, qui l'écrit dans un fichier protégé côté application.
let apiKeyAlreadyStored = false;

async function prefillApiStep() {
  // `llm_secret_status` ne renvoie qu'un aperçu masqué : si une clé est déjà
  // enregistrée, on autorise l'utilisateur à passer l'étape sans la ressaisir.
  try {
    const st = await invoke("llm_secret_status");
    apiKeyAlreadyStored = Boolean(st?.configured);
    const field = $("ob-api-key");
    if (field && apiKeyAlreadyStored) field.placeholder = t("ob_api_key_stored", { hint: st.hint || "" });
  } catch { apiKeyAlreadyStored = false; }
  const model = $("ob-api-model");
  const base = $("ob-api-base");
  if (model && !model.value) model.value = localStorage.getItem("apiModel") || "gpt-4o-mini";
  if (base && !base.value) base.value = localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1";
}

async function saveApiStep() {
  const key = $("ob-api-key")?.value.trim() || "";
  const model = $("ob-api-model")?.value.trim() || "gpt-4o-mini";
  const base = $("ob-api-base")?.value.trim() || "https://api.openai.com/v1";
  const status = $("ob-api-status");
  if (!key && !apiKeyAlreadyStored) {
    if (status) status.textContent = t("ob_api_missing_key");
    return false;
  }
  localStorage.setItem("apiModel", model);
  localStorage.setItem("apiBaseUrl", base);
  try {
    await invoke("set_ollama_config", {
      url: localStorage.getItem("ollamaUrl") || "http://localhost:11434",
      model: localStorage.getItem("selectedModel") || "",
      backend: "api",
      apiBase: base,
      apiKey: key, // vide = conserve la clé déjà enregistrée côté application
      apiModel: model,
    });
    if (key) apiKeyAlreadyStored = true;
    const field = $("ob-api-key");
    if (field) field.value = "";
  } catch (e) {
    if (status) status.textContent = String(e?.message || e);
    return false;
  }
  return true;
}

// ===== Étape « Test » : on parle réellement au modèle configuré =====
const TEST_PROMPT = "Réponds en une phrase courte : bonjour, es-tu prêt ?";

function prepareTestStep() {
  const model = aiSource === "api"
    ? (localStorage.getItem("apiModel") || "—")
    : (localStorage.getItem("selectedModel") || "—");
  const summary = $("ob-test-summary");
  if (summary) summary.textContent = t(`ob_test_summary_${aiSource}`, { model });
  // Cadrage honnête AVANT le premier échange : sans repère, l'utilisateur
  // compare spontanément à ChatGPT et conclut que « ça ne marche pas ».
  renderExpectations($("ob-test-expectations"), { source: aiSource, model });
  const status = $("ob-test-status");
  if (status && !status.dataset.done) status.textContent = t("ob_test_hint");
}

async function runConfigTest() {
  const btn = $("btn-ob-test");
  const status = $("ob-test-status");
  const answer = $("ob-test-answer");
  if (btn) btn.disabled = true;
  if (answer) answer.hidden = true;
  if (status) status.textContent = t("ob_test_running");
  try {
    let reply = "";
    if (aiSource === "shortcut") {
      reply = await invoke("call_macos_shortcut", {
        shortcutName: localStorage.getItem("shortcutName") || "Apple Intelligence",
        prompt: TEST_PROMPT,
      });
    } else {
      // llama-server n'est démarré que sur demande : le test doit donc le
      // lancer, sinon il échouerait alors que la configuration est bonne.
      if (aiSource === "llama") {
        const model = localStorage.getItem("selectedModel") || "";
        if (!model) throw new Error(t("ob_test_no_model"));
        await invoke("llama_start", {
          filename: model,
          ctxSize: Number(localStorage.getItem("llamaNumCtx")) || 8192,
        });
      }
      const res = await llmChat([{ role: "user", content: TEST_PROMPT }]);
      reply = res?.content || "";
    }
    reply = String(reply || "").trim();
    if (!reply) throw new Error(t("ob_test_empty"));
    if (answer) { answer.textContent = reply; answer.hidden = false; }
    if (status) { status.textContent = t("ob_test_ok"); status.dataset.done = "1"; }
  } catch (e) {
    if (status) status.textContent = t("ob_test_fail", { err: e?.message || e });
  }
  if (btn) btn.disabled = false;
}

function renderHardwareBanner() {
  const el = $("ob-hw-banner");
  if (!el) return;
  const text = hardwareBannerText();
  el.textContent = text;
  el.classList.toggle("visible", Boolean(text));
}

// ===== Étape « llama.cpp » : téléchargement d'un modèle GGUF =====
//
// Même catalogue et même commande Rust (`llama_download_model`) que les
// Paramètres, présentés en liste compacte filtrable pour ne pas noyer
// l'utilisateur sous une vingtaine de cartes.
let llamaPicker = null;
let llamaInstalled = [];

async function refreshLlamaStep() {
  const root = $("ob-llama-catalog");
  if (!root) return;
  try {
    const models = await invoke("llama_list_models");
    llamaInstalled = Array.isArray(models) ? models : [];
  } catch { llamaInstalled = []; }

  const select = $("ob-llama-model");
  if (select) {
    select.innerHTML = llamaInstalled.length
      ? llamaInstalled.map((m) => `<option value="${escapeHtml(m.filename)}">${escapeHtml(llamaModelLabel(m.filename))}</option>`).join("")
      : `<option value="">${escapeHtml(t("opt_no_llama_models"))}</option>`;
    const stored = localStorage.getItem("selectedModel") || "";
    if (llamaInstalled.some((m) => m.filename === stored)) select.value = stored;
    else if (llamaInstalled[0]) {
      select.value = llamaInstalled[0].filename;
      localStorage.setItem("selectedModel", llamaInstalled[0].filename);
    }
  }

  if (!llamaPicker) {
    llamaPicker = createCatalogPicker(root, {
      chips: [
        { id: "all", label: t("cat_chip_all") },
        { id: "installed", label: t("cat_chip_installed"), test: (item) => item.installed },
        { id: "fast", label: t("model_tier_fast"), test: (item) => item.tier === "fast" },
        { id: "balanced", label: t("model_tier_balanced"), test: (item) => item.tier === "balanced" },
        { id: "powerful", label: t("model_tier_powerful"), test: (item) => item.tier === "powerful" },
        { id: "vision", label: t("cat_chip_vision"), test: (item) => item.tags?.includes("vision") },
        { id: "code", label: t("cat_chip_code"), test: (item) => item.tags?.includes("code") },
      ],
      searchPlaceholder: t("cat_search_model"),
      emptyLabel: t("cat_empty"),
      countLabel: (shown, total) => t("cat_count", { shown, total }),
      maxHeight: "228px",
      infoLabel: t("cat_info"),
    });
  }
  const partials = await loadPartials();
  renderHardwareBanner();
  renderExpectations($("ob-llama-expectations"), {
    source: "llama",
    model: localStorage.getItem("selectedModel") || "",
  });
  // Sur une machine modeste, on ouvre d'emblée sur le palier qui lui convient
  // plutôt que sur une liste où le premier modèle visible est hors de portée.
  if (hardware()?.tier && !llamaPicker.chipTouched) llamaPicker.selectChip(hardware().tier);

  llamaPicker.setItems(LLAMA_MODEL_CATALOG.filter(m => !m.tags?.includes("ocr") && !m.tags?.includes("decision")).map((model) => llamaCatalogItem(model, {
    installed: llamaInstalled.some((m) => m.filename === model.filename),
    partials,
    picker: llamaPicker,
    lang: getLang(),
    onInstalled: async (installedModel) => {
      localStorage.setItem("selectedModel", installedModel.filename);
      await refreshLlamaStep();
      saveLlamaSelection();
    },
    installedActions: (installedModel) => [{
      label: t("llama_use"),
      onClick: () => {
        localStorage.setItem("selectedModel", installedModel.filename);
        const sel = $("ob-llama-model");
        if (sel) sel.value = installedModel.filename;
        saveLlamaSelection();
      },
    }],
  })));
}

async function saveLlamaSelection() {
  const model = $("ob-llama-model")?.value || localStorage.getItem("selectedModel") || "";
  if (model) localStorage.setItem("selectedModel", model);
  try { await window.__TAURI__?.event?.emit?.("settings-updated", { aiSource, selectedModel: model }); } catch {}
  await invoke("set_ollama_config", {
    url: localStorage.getItem("ollamaUrl") || "http://localhost:11434",
    model,
    backend: "llama",
    apiBase: localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1",
    apiKey: localStorage.getItem("apiKey") || "",
    apiModel: localStorage.getItem("apiModel") || "",
  }).catch(() => {});
}

function wireLlamaProgressEvents() {
  if (!tauriEvent?.listen) return;
  tauriEvent.listen("llama-download-progress", (evt) => {
    const p = evt?.payload || {};
    if (p.id) llamaPicker?.setProgress(p.id, p.percent);
  });
}

// ===== Étape « Dictée » : facultative, et adaptée à la plateforme =====
//
// Sur un Mac où les raccourcis Apple sont disponibles, la dictée système existe
// déjà : Whisper n'y est qu'une option. Ailleurs (Windows, Linux, Pi), c'est le
// seul moyen de dicter, on le propose donc coché par défaut.
let whisperPicker = null;

function whisperIsDefault() {
  return !appleAvailable;
}

function initWhisperOnboarding() {
  const chk = $("ob-whisper-enable");
  const platformNote = $("ob-whisper-platform");
  const root = $("ob-whisper-catalog");
  if (!root) return;

  if (chk) {
    const stored = localStorage.getItem("whisperDictation");
    chk.checked = stored === null ? whisperIsDefault() : stored === "1";
    syncWhisperSwitchLabel();
    localStorage.setItem("whisperDictation", chk.checked ? "1" : "0");
  }
  if (platformNote) {
    platformNote.textContent = whisperIsDefault() ? t("ob_whisper_needed") : t("ob_whisper_optional_mac");
  }

  if (!whisperPicker) {
    whisperPicker = createCatalogPicker(root, {
      search: false,
      emptyLabel: t("cat_empty"),
      maxHeight: "150px",
    });
  }
  renderWhisperCatalog();
}

function renderWhisperCatalog() {
  const active = whisperModelId();
  whisperPicker?.setItems(WHISPER_MODELS.map((model) => ({
    id: model.id,
    title: model.label,
    meta: `${model.sizeLabel} · ${t(`model_tier_${model.hint}`)}`,
    installed: model.id === active,
    badge: model.id === active ? t("cat_badge_selected") : "",
    actions: [{
      label: model.id === active ? t("btn_whisper_dl") : t("llama_use"),
      onClick: async (ctx) => {
        localStorage.setItem("whisperModel", model.id);
        if (model.id !== active) { renderWhisperCatalog(); return; }
        // Même garde-fou disque que pour les modèles de discussion.
        if (diskTooSmall(model.sizeBytes)) {
          ctx.setStatus(t("llama_disk_full", {
            need: formatBytes(model.sizeBytes),
            free: formatBytes(hardware()?.free_disk || 0),
          }), true);
          return;
        }
        await downloadWhisperModel(ctx);
      },
    }],
  })));
}

async function downloadWhisperModel(ctx = null) {
  const chk = $("ob-whisper-enable");
  const status = $("ob-whisper-status");
  localStorage.setItem("whisperDictation", chk?.checked ? "1" : "0");
  const report = (text) => {
    if (status) status.textContent = text;
    ctx?.setStatus(text);
  };
  ctx?.setProgress(0);
  report(t("whisper_dl_progress", { file: "...", pct: 0 }));
  try {
    await whisperLoad((file, pct) => {
      ctx?.setProgress(pct);
      report(t("whisper_dl_progress", { file, pct }));
    });
    report(t("whisper_dl_done"));
  } catch (e) {
    report(t("whisper_dl_fail", { err: e?.message || e }));
    if (ctx) ctx.setStatus(t("whisper_dl_fail", { err: e?.message || e }), true);
  }
}

// ===== Étape « La voix de Lumen » =====
//
// La synthèse vocale était jusqu'ici invisible au premier démarrage : Lumen
// parlait avec la voix système, et les voix Piper — nettement meilleures, et le
// seul moyen d'avoir une voix locale correcte sous Windows et Linux — ne se
// découvraient qu'en fouillant les Paramètres. On la propose donc ici, au même
// endroit que la dictée : entendre et parler vont ensemble.
//
// Rien n'est téléchargé sans geste explicite : l'étape est franchissable telle
// quelle, la voix système reste le repli et fonctionne partout.

let voicePicker = null;
let voiceEngineStatus = null;

function voiceStatus(text) {
  const el = $("ob-voice-status");
  if (el) el.textContent = text || "";
}

function selectedVoiceBackend() {
  return $("ob-voice-backend")?.value || localStorage.getItem("speechBackend") || "auto";
}

/// Le catalogue Piper n'a de sens que si le moteur peut réellement parler :
/// afficher des voix téléchargeables sur une machine sans moteur promet une
/// fonctionnalité qui échouera au premier essai.
function voiceLocalWanted() {
  const backend = selectedVoiceBackend();
  return backend === "piper" || backend === "auto";
}

async function initVoiceOnboarding() {
  const sel = $("ob-voice-backend");
  if (!sel) return;
  if (!sel.dataset.bound) {
    sel.dataset.bound = "1";
    sel.value = localStorage.getItem("speechBackend") || "auto";
    sel.addEventListener("change", () => {
      localStorage.setItem("speechBackend", sel.value);
      refreshVoiceStep();
    });
    $("btn-ob-voice-install")?.addEventListener("click", installVoiceRuntime);
    $("btn-ob-voice-test")?.addEventListener("click", testVoice);
    $("btn-ob-voice-skip")?.addEventListener("click", () => move(1));
  }
  await refreshVoiceStep();
}

async function refreshVoiceStep() {
  const note = $("ob-voice-engine-note");
  const installBtn = $("btn-ob-voice-install");
  const catalog = $("ob-voice-catalog");
  const activeRow = $("ob-voice-active-row");

  try {
    voiceEngineStatus = await invoke("tts_engine_status");
  } catch { voiceEngineStatus = null; }

  const local = voiceLocalWanted();
  if (catalog) catalog.hidden = !local;
  if (activeRow) activeRow.hidden = !local;
  if (installBtn) {
    // Le bouton n'a de sens que là où Lumen sait installer le moteur lui-même
    // (macOS) ; ailleurs il est livré dans le bundle.
    installBtn.hidden = !local || !voiceEngineStatus?.installable || voiceEngineStatus?.engine_ready;
  }
  if (note) {
    note.textContent = !local
      ? t("ob_voice_note_system")
      : voiceEngineStatus?.engine_ready
        ? t("ob_voice_note_ready")
        : voiceEngineStatus?.installable
          ? t("ob_voice_note_installable")
          : t("ob_voice_note_missing");
  }
  if (!local) { voiceStatus(""); return; }
  await renderVoiceCatalog();
}

async function renderVoiceCatalog() {
  const root = $("ob-voice-catalog");
  if (!root) return;
  let catalog = [];
  let active = "";
  try {
    [catalog, active] = await Promise.all([
      invoke("tts_catalog"),
      invoke("tts_active_voice").catch(() => ""),
    ]);
  } catch (e) {
    voiceStatus(String(e?.message || e));
    return;
  }

  const activeEl = $("ob-voice-active");
  const current = catalog.find((v) => v.id === active);
  if (activeEl) activeEl.textContent = current ? current.label : t("tts_none_installed");
  const testBtn = $("btn-ob-voice-test");
  if (testBtn) testBtn.disabled = !current;

  // Même liste filtrable que les Paramètres : le catalogue Piper compte
  // plusieurs dizaines de voix, une liste brute noierait l'étape.
  if (!voicePicker) {
    voicePicker = createCatalogPicker(root, {
      // Le premier filtre est celui qui s'applique d'entrée : on montre la
      // langue de l'interface, sinon un utilisateur anglophone ouvre l'étape
      // sur une liste de voix françaises.
      chips: (getLang() === "en"
        ? [
          { id: "en", label: t("cat_chip_en"), test: (item) => item.lang?.startsWith("en") },
          { id: "fr", label: t("cat_chip_fr"), test: (item) => item.lang?.startsWith("fr") },
        ]
        : [
          { id: "fr", label: t("cat_chip_fr"), test: (item) => item.lang?.startsWith("fr") },
          { id: "en", label: t("cat_chip_en"), test: (item) => item.lang?.startsWith("en") },
        ]).concat([
        { id: "installed", label: t("cat_chip_installed_f"), test: (item) => item.installed },
        { id: "all", label: t("cat_chip_all") },
      ]),
      searchPlaceholder: t("cat_search_voice"),
      emptyLabel: t("cat_empty_voice"),
      countLabel: (shown, total) => t("cat_count_voice", { shown, total }),
      maxHeight: "170px",
    });
  }
  voicePicker.setItems(catalog.map((v) => ({
    id: v.id,
    title: v.label,
    meta: `${v.lang} · ${v.quality} · ~${v.size_mb} Mo`,
    lang: v.lang,
    installed: v.installed,
    badge: v.id === active ? t("cat_badge_selected") : v.installed ? t("cat_badge_installed_f") : "",
    actions: [{
      label: v.installed ? (v.id === active ? t("ob_voice_test") : t("llama_use")) : t("tts_download"),
      onClick: async (ctx) => {
        ctx.button.disabled = true;
        try {
          if (!v.installed) {
            ctx.setStatus(t("tts_downloading", { name: v.label }));
            voiceStatus(t("tts_downloading", { name: v.label }));
            await invoke("tts_download_voice", { id: v.id });
          }
          // Une voix qu'on vient de télécharger devient la voix active : c'est
          // la seule raison de l'avoir téléchargée depuis cette étape.
          await invoke("tts_set_voice", { voice: v.id });
          if (v.id === active) { await testVoice(); return; }
          voiceStatus(t("ob_voice_selected", { name: v.label }));
        } catch (e) {
          ctx.setStatus(String(e?.message || e), true);
          voiceStatus(String(e?.message || e));
        } finally {
          ctx.button.disabled = false;
          await renderVoiceCatalog();
        }
      },
    }],
  })));
}

async function installVoiceRuntime() {
  const btn = $("btn-ob-voice-install");
  if (btn) btn.disabled = true;
  voiceStatus(t("tts_install_download"));
  try {
    await invoke("tts_install_runtime");
    voiceStatus(t("tts_install_done"));
  } catch (e) {
    voiceStatus(t("tts_install_failed", { err: e?.message || e }));
  }
  if (btn) btn.disabled = false;
  await refreshVoiceStep();
}

/// Écoute d'essai : c'est le seul moyen honnête de choisir une voix.
async function testVoice() {
  voiceStatus(t("ob_voice_testing"));
  try {
    await invoke("tts_speak", { text: t("ob_voice_sample") });
    voiceStatus("");
  } catch (e) {
    voiceStatus(String(e?.message || e));
  }
}

/// « Plus tard » : on désactive la dictée et on passe à la suite sans rien
/// télécharger. Elle reste activable dans les Paramètres.
function skipWhisperStep() {
  const chk = $("ob-whisper-enable");
  if (chk) chk.checked = false;
  localStorage.setItem("whisperDictation", "0");
  syncWhisperSwitchLabel();
  move(1);
}

async function move(delta) {
  // Quitter l'étape profil vers l'avant = enregistrer (bloque si les deux
  // mots de passe ne correspondent pas).
  if (delta > 0 && step === 9 && !(await saveProfileStep())) return;
  if (delta > 0 && step === 11 && !(await saveApiStep())) return;
  // Sauter l'installation express reste possible : on prévient, c'est tout.
  if (delta > 0 && step === 14 && !expressUi?.isDone() && !confirmSkipExpress()) return;
  const steps = order();
  const index = Math.max(0, steps.indexOf(step));
  const nextIndex = index + delta;
  if (nextIndex < 0) return;
  if (nextIndex >= steps.length) return finish();
  goToStep(steps[nextIndex]);
}

// ===== Moteur de décision (Tev1-0.8B) =====
// Une carte par moteur (étape llama.cpp / étape Ollama). Case « installer en
// fin d'assistant » cochée par défaut : le téléchargement part en arrière-plan
// à la fermeture, côté Rust, et survit à la fenêtre.
const decisionCards = {};
function decisionOllamaUrl() {
  return ($("ob-ollama-url")?.value.trim() || localStorage.getItem("ollamaUrl") || "http://127.0.0.1:11434").replace(/\/$/, "");
}
function mountDecisionStep(engine) {
  const root = $(`ob-decision-${engine}`);
  if (!root) return;
  if (decisionCards[engine]) { decisionCards[engine].refresh(); return; }
  decisionCards[engine] = mountDecisionCard(root, { t, engine, ollamaUrl: decisionOllamaUrl(), autoOption: true });
}

let expressSkipWarned = false;
function confirmSkipExpress() {
  if (expressSkipWarned) return true;
  expressSkipWarned = true;
  const st = $("ex-status");
  if (st) st.textContent = t("ex_skip_warn");
  return false;
}

async function finish() {
  nextBtn.disabled = true;
  localStorage.setItem("onboardingDone", "true");
  const decisionEngine = aiSource === "ollama" ? "ollama" : aiSource === "llama" ? "llama" : null;
  if (decisionEngine && decisionCards[decisionEngine]?.wantsAutoInstall()) {
    installDecisionInBackground({ engine: decisionEngine, ollamaUrl: decisionOllamaUrl() });
  }
  try {
    await saveSettings();
    // La barre enchaîne sur sa mini-visite : l'utilisateur découvre les boutons
    // au moment où il les a sous les yeux, pas dans une liste de l'assistant.
    await window.__TAURI__?.event?.emit?.("onboarding-finished", {});
  } finally {
    await currentWindow?.close?.();
    window.close();
  }
}

async function saveSettings() {
  const ollama = readOllamaFields();
  // En mode llama.cpp, le modèle actif est le GGUF choisi à l'étape 10, pas
  // l'entrée du sélecteur Ollama.
  const model = aiSource === "llama"
    ? ($("ob-llama-model")?.value || localStorage.getItem("selectedModel") || "")
    : ollama.model;
  const payload = {
    aiSource,
    onboardingDone: "true",
    ollamaUrl: ollama.url,
    selectedModel: model,
  };

  Object.entries(payload).forEach(([key, value]) => {
    if (value != null) localStorage.setItem(key, value);
  });

  try {
    await invoke("set_ollama_config", {
      url: ollama.url,
      model,
      backend: aiSource === "api" ? "api" : aiSource === "llama" ? "llama" : "ollama",
      apiBase: localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1",
      apiKey: localStorage.getItem("apiKey") || "",
      apiModel: localStorage.getItem("apiModel") || "",
    });
  } catch {}

  try {
    await window.__TAURI__?.event?.emit?.("settings-updated", payload);
  } catch {}
}

function updateSourceCards() {
  document.querySelectorAll(".source-card").forEach((card) => {
    card.classList.toggle("active", express ? card.dataset.source === "express" : card.dataset.source === aiSource);
  });
  const welcome = $("ob-welcome-p");
  if (welcome) {
    welcome.textContent = aiSource === "ollama" || aiSource === "llama"
      ? t("ob_welcome_p_ollama")
      : aiSource === "api"
        ? t("ob_welcome_p_api")
        : t("ob_welcome_p");
  }
}

function selectSource(source) {
  express = source === "express";
  if (express) source = "llama";
  if (source !== "shortcut" && source !== "ollama" && source !== "llama" && source !== "api") return;
  aiSource = source;
  localStorage.setItem("aiSource", source);
  try { window.__TAURI__?.event?.emit?.("settings-updated", { aiSource: source }); } catch {}
  updateSourceCards();
  goToStep(step);
}

function renderShortcutCards() {
  shortcutCards.innerHTML = "";
  REQUIRED_SHORTCUTS.forEach((shortcut) => {
    const card = document.createElement("div");
    card.className = "shortcut-card";
    card.dataset.shortcutKey = shortcut.key;
    card.innerHTML = `
      <div class="shortcut-card-info">
        <div class="shortcut-card-name">
          ${escapeHtml(shortcut.name)}
          <span class="shortcut-status missing" data-status>${t("dyn_not_detected")}</span>
        </div>
        <div class="shortcut-card-desc">${escapeHtml(t("dyn_sc_desc_" + shortcut.key))}</div>
      </div>
      <button class="shortcut-install-btn" data-install>${t("dyn_install")}</button>
    `;
    card.querySelector("[data-install]").addEventListener("click", () => installShortcut(shortcut));
    shortcutCards.appendChild(card);
  });
}

function installShortcut(shortcut) {
  invoke("open_external", { url: shortcut.icloudUrl }).catch((error) => console.error("Shortcut link:", error));
}

async function checkShortcutsInstalled() {
  let installed = [];
  try { installed = await invoke("list_shortcuts"); } catch {}
  const names = installed.map((name) => String(name).toLowerCase());
  REQUIRED_SHORTCUTS.forEach((shortcut) => {
    const card = shortcutCards.querySelector(`[data-shortcut-key="${shortcut.key}"]`);
    if (!card) return;
    const present = names.includes(shortcut.name.toLowerCase());
    const status = card.querySelector("[data-status]");
    const button = card.querySelector("[data-install]");
    status.textContent = present ? t("dyn_installed") : t("dyn_not_detected");
    status.classList.toggle("ok", present);
    status.classList.toggle("missing", !present);
    button.textContent = present ? t("dyn_reinstall") : t("dyn_install");
    button.classList.toggle("installed", present);
  });
}

async function fetchOnboardingModels() {
  const urlInput = $("ob-ollama-url");
  const modelSelect = $("ob-ollama-model");
  const status = $("ob-ollama-status");
  if (!modelSelect) return;
  const ollamaUrl = (urlInput?.value.trim() || localStorage.getItem("ollamaUrl") || "http://127.0.0.1:11434").replace(/\/$/, "");
  localStorage.setItem("ollamaUrl", ollamaUrl);
  try {
    const models = await listOllamaModels(ollamaUrl);
    modelSelect.innerHTML = models.length
      ? models.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
      : `<option value="">${t("loaded_none")}</option>`;
    const selected = storedOllamaModel();
    if (models.includes(selected)) modelSelect.value = selected;
    if (status) status.textContent = t("ob_ollama_note");
  } catch {
    modelSelect.innerHTML = '<option value="">—</option>';
    if (status) status.textContent = t("loaded_offline");
  }
}

function readOllamaFields() {
  return {
    url: $("ob-ollama-url")?.value.trim() || "http://localhost:11434",
    model: $("ob-ollama-model")?.value || storedOllamaModel(),
  };
}

async function saveOllamaFields() {
  const { url, model } = readOllamaFields();
  localStorage.setItem("ollamaUrl", url);
  if (model) localStorage.setItem("selectedModel", model);
  try { await window.__TAURI__?.event?.emit?.("settings-updated", { aiSource, ollamaUrl: url, selectedModel: model }); } catch {}
  await invoke("set_ollama_config", {
    url,
    model,
    backend: aiSource === "api" ? "api" : aiSource === "llama" ? "llama" : "ollama",
    apiBase: localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1",
    apiKey: localStorage.getItem("apiKey") || "",
    apiModel: localStorage.getItem("apiModel") || "",
  }).catch(() => {});
}

// ===== Détection de la plateforme & d'Ollama (assistant simplifié) =====
async function detectPlatform() {
  // Voir lib/platform-flavor.js : le repli « default » de l'ancienne version
  // signifiait macOS, si bien qu'une détection en échec faisait recommander
  // « Modèle Apple » sur un PC Windows ou un Raspberry Pi.
  appleAvailable = await appleShortcutsAvailable();
  // Sert au CSS (mentions « sur Mac » de l'étape Heartbeat).
  if (appleAvailable) document.documentElement.setAttribute("data-mac", "");
  const appleCard = $("usage-card-apple");
  if (appleCard) appleCard.hidden = !appleAvailable;
  // Sur Mac récent, on signale seulement que l'IA d'Apple est disponible.
  if (appleAvailable) appleCard?.querySelector(".source-card-detect")?.removeAttribute("hidden");
  // Sur toutes les versions, la voie recommandée est llama.cpp : le moteur est
  // embarqué dans Lumen, il n'y a rien à installer (Ollama, lui, suppose un
  // logiciel tiers déjà présent, et « Modèle Apple » dépend des Raccourcis).
  const llamaBadge = $("usage-badge-llama");
  if (llamaBadge) llamaBadge.hidden = false;
  const appleBadge = $("usage-badge-apple");
  if (appleBadge) appleBadge.hidden = true;
  if (!appleAvailable && aiSource === "shortcut") selectSource("llama");
  detectOllamaPresence();
}

async function detectOllamaPresence() {
  const hint = $("usage-detect-ollama");
  const engineStatus = $("ob-ollama-engine-status");
  if (engineStatus) {
    engineStatus.textContent = t("ob_ollama_status_checking");
    engineStatus.className = "shortcut-status missing";
  }
  let present = false;
  try {
    const url = (localStorage.getItem("ollamaUrl") || "http://127.0.0.1:11434");
    await listOllamaModels(url);
    present = true;
  } catch { present = false; }
  if (hint) hint.hidden = !present;
  if (engineStatus) {
    engineStatus.textContent = present ? t("ob_ollama_status_found") : t("ob_ollama_status_missing");
    engineStatus.classList.toggle("ok", present);
    engineStatus.classList.toggle("missing", !present);
  }
  // Affiche/masque le bouton « Installer Ollama » selon la présence.
  const installBtn = $("btn-ob-install-ollama");
  if (installBtn) installBtn.style.display = present ? "none" : "";
  refreshModelPresence();
}

async function refreshModelPresence() {
  const status = $("ob-pull-status");
  const pullBtn = $("btn-ob-pull-model");
  const nameEl = $("ob-model-name");
  const target = storedOllamaModel();
  if (nameEl) nameEl.textContent = target;
  try {
    const url = (localStorage.getItem("ollamaUrl") || "http://127.0.0.1:11434");
    const models = await listOllamaModels(url);
    const present = models.some((m) => m === target || m.startsWith(target.split(":")[0]));
    if (present) {
      if (status) status.textContent = t("ob_model_present");
      if (pullBtn) pullBtn.disabled = true;
    } else if (pullBtn) {
      pullBtn.disabled = false;
    }
  } catch { /* Ollama absent : le bouton reste actif, il échouera proprement */ }
}

function installOllama() {
  invoke("open_external", { url: OLLAMA_DOWNLOAD_URL }).catch((e) => console.error("Ollama download:", e));
  const status = $("ob-ollama-engine-status");
  if (status) status.textContent = t("ob_ollama_status_after_install");
}

async function pullRecommendedModel() {
  const model = storedOllamaModel();
  const pullBtn = $("btn-ob-pull-model");
  const status = $("ob-pull-status");
  const wrap = $("ob-pull-progress");
  const bar = $("ob-pull-progress-bar");
  if (pullBtn) pullBtn.disabled = true;
  if (wrap) wrap.hidden = false;
  if (status) status.textContent = t("ob_model_dl_progress", { pct: 0 });
  const url = (localStorage.getItem("ollamaUrl") || "http://127.0.0.1:11434");
  try {
    await invoke("ollama_pull", { url, model });
  } catch (e) {
    if (status) status.textContent = t("ob_model_dl_fail", { err: e?.message || e });
    if (pullBtn) pullBtn.disabled = false;
    if (wrap) wrap.hidden = true;
  }
}

function wireOllamaPullEvents() {
  if (!tauriEvent) return;
  tauriEvent.listen?.("ollama-pull-progress", (evt) => {
    if (evt?.payload?.model && evt.payload.model !== storedOllamaModel()) return;   // moteur de décision, etc.
    const pct = evt?.payload?.percent ?? 0;
    const bar = $("ob-pull-progress-bar");
    const status = $("ob-pull-status");
    if (bar) bar.style.width = `${pct}%`;
    if (status) status.textContent = t("ob_model_dl_progress", { pct });
  });
  tauriEvent.listen?.("ollama-pull-done", (evt) => {
    if (evt?.payload?.model && evt.payload.model !== storedOllamaModel()) return;
    const ok = evt?.payload?.ok;
    const status = $("ob-pull-status");
    const wrap = $("ob-pull-progress");
    const pullBtn = $("btn-ob-pull-model");
    if (ok) {
      if (status) status.textContent = t("ob_model_dl_done");
      if (wrap) wrap.hidden = true;
      saveOllamaFields();
      fetchOnboardingModels();
    } else {
      if (status) status.textContent = t("ob_model_dl_fail", { err: evt?.payload?.error || "" });
      if (pullBtn) pullBtn.disabled = false;
      if (wrap) wrap.hidden = true;
    }
  });
}

// Installe les 5 raccourcis d'un coup puis revérifie automatiquement.
async function installAllShortcuts() {
  for (const shortcut of REQUIRED_SHORTCUTS) {
    try { await invoke("open_external", { url: shortcut.icloudUrl }); } catch {}
    await new Promise((r) => setTimeout(r, 600));
  }
  // Laisse à l'utilisateur le temps d'ajouter les raccourcis, puis revérifie.
  setTimeout(checkShortcutsInstalled, 2500);
}

function openAppleIntelligenceSettings() {
  invoke("open_external", { url: "x-apple.systempreferences:com.apple.Siri-Settings.extension" })
    .catch(() => invoke("open_external", { url: "x-apple.systempreferences:" }))
    .catch((error) => console.error("System Settings:", error));
}

function changeLanguage(lang) {
  setLang(lang);
  applyI18n();
  $("onboarding-lang").value = getLang();
  renderShortcutCards();
  updateSourceCards();
  // Les puces de filtre du catalogue portent leurs libellés : on rebâtit la
  // liste compacte pour qu'elle suive la langue choisie.
  llamaPicker = null;
  goToStep(step);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

window.addEventListener("DOMContentLoaded", () => {
  applyI18n();
  applyIcons();
  $("onboarding-lang").value = getLang();
  $("onboarding-lang").addEventListener("change", (event) => changeLanguage(event.target.value));
  document.querySelectorAll(".source-card").forEach((card) => {
    card.addEventListener("click", () => selectSource(card.dataset.source));
  });
  prevBtn.addEventListener("click", () => move(-1));
  nextBtn.addEventListener("click", () => move(1));
  $("btn-recheck-shortcuts")?.addEventListener("click", checkShortcutsInstalled);
  $("btn-install-all-shortcuts")?.addEventListener("click", installAllShortcuts);
  $("btn-open-ai-settings")?.addEventListener("click", openAppleIntelligenceSettings);
  $("btn-ob-refresh-models")?.addEventListener("click", fetchOnboardingModels);
  $("btn-ob-install-ollama")?.addEventListener("click", installOllama);
  $("btn-ob-check-ollama")?.addEventListener("click", detectOllamaPresence);
  $("btn-ob-pull-model")?.addEventListener("click", pullRecommendedModel);
  $("ob-llama-model")?.addEventListener("change", saveLlamaSelection);
  $("btn-ob-whisper-skip")?.addEventListener("click", skipWhisperStep);
  $("ob-whisper-enable")?.addEventListener("change", (event) => {
    localStorage.setItem("whisperDictation", event.target.checked ? "1" : "0");
    syncWhisperSwitchLabel();
  });
  $("ob-ollama-url")?.addEventListener("change", () => { saveOllamaFields(); fetchOnboardingModels(); detectOllamaPresence(); });
  $("ob-ollama-model")?.addEventListener("change", saveOllamaFields);
  $("ob-ollama-url").value = localStorage.getItem("ollamaUrl") || "http://localhost:11434";
  initWhisperOnboarding();
  wireOllamaPullEvents();
  wireLlamaProgressEvents();
  loadHardware().then(renderHardwareBanner);
  $("btn-ob-test")?.addEventListener("click", runConfigTest);
  detectPlatform();
  renderShortcutCards();
  updateSourceCards();
  goToStep(0);
});
