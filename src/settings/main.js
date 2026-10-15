import { mountRobotHead, normalizeRobotOptions, ROBOT_DEFAULTS } from '../lib/robot-head.js';
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { ORB_CHARACTERS, characterId } from '../lib/orb-characters.js';
import { modelProviderKey, strongBackendFor } from "../lib/orchestrator-host.js";
import { llmBackend } from "../llm.js";
import { mountDecisionCard } from "../lib/decision-installer.js";
import { mountAiLevel } from "../lib/ai-level.js";
import { applyI18n, getLang, setLang, t } from "../i18n.js";
import { delegateExternalLinks } from "../lib/open-external.js";
import { platformFlavor as resolvePlatformFlavor, IS_MAC } from "../lib/platform-flavor.js";
import { openLumenApp } from "../lib/open-app.js";
import { productName, proEnabledSync, proFlavor, setProFlavor, whenProResolved } from "../lib/pro-edition.js";
import { setTheme, themePreference, resolvedTheme } from "../lib/theme.js";
import { ollamaGetJson, ollamaPostJson } from "../llm.js";
import { LLAMA_MODEL_CATALOG, llamaCatalogEntry, llamaModelLabel } from "../llama-models.js";
import { LITERT_MODEL_CATALOG, litertModelId } from "../litert-models.js";
import {
  llamaCatalogItem, loadHardware, loadPartials, hardwareBannerText, formatBytes,
} from "../lib/llama-download.js";
import { modelGroup, modelGroupLabel, modelGroupOrder } from "../lib/model-groups.js";
import { OLLAMA_MODEL_CATALOG, ollamaModelDescription, ollamaModelInstalled } from "../ollama-models.js";
import { createCatalogPicker } from "../lib/catalog-picker.js";
import { listApiModelChoices, selectApiModel } from "../llm.js";
import { pickModelForSource, rememberModelFor, rustBackend, lumenServerBackendState, listApiProfiles, activateApiProfile, appleFmBackendState, appleFmReasonText, APPLEFM_DEFAULT_MODEL } from "../llm.js";
import { renderExpectations } from "../lib/model-expectations.js";
import { renderControllerInfo } from "../lib/controller-info.js";
import { showLicense } from "../legal/license.js";
import { WHISPER_MODELS, whisperLoad, whisperModelId, whisperNativeStatus, whisperNativeInvalidate } from "../lib/whisper-dictation.js";
import { voiceControlPrefs, saveVoiceControlPrefs } from "../lib/voice-commands.js";
import { NOTIF_TYPES, NOTIF_SOUNDS, notifSoundPrefs, saveNotifSoundPrefs, playSound, notifLedColor, saveNotifLedColor } from "../lib/notif-sounds.js";
import { EMBED_CATALOG } from "../lib/embed-models.js";
import { imageModelsFor, imageSizesFor, imageModel, imageModelKey, listOllamaImageModels, ensureBonsaiKind, imageErrorMessage, DEFAULT_OLLAMA_URL, refreshPlaygroundOption, playgroundReasonText, pushImageConfig } from "../lib/image-provider.js";
import { mountBonsaiPanel } from "../lib/bonsai-panel.js";
import { suggestedModels, providerName, prioritiseModels, API_PROVIDERS, providerFor } from "../lib/api-model-catalog.js";
import { RFID_ACTIONS, RFID_CHAT_MODES, loadBindings, upsertBinding, removeBinding, findBinding, normalizeUid, migrateLegacyBindings } from "../lib/rfid-bindings.js";

import * as updater from "../lib/updater.js";
import { mountUiCustomizer, applyUiTheme } from "../lib/ui-customizer.js";
import { brandIcon, icon as lumenIcon } from "../lib/icons.js";
import { PROMPTS, promptText, loadDefaults, saveOverrides, loadOverridesFromBackend, loadFullCatalog } from "../lib/prompt-registry.js";
import { TOOL_GROUPS, agentToolNames, loadDisabledTools, sanitizeToolName, setToolPublished, setToolsPublished, settingsToolCatalog, toolHint, toolGroupText } from "../lib/tool-publishing.js";
import { WEB_ENGINES, buildWebTools, callWebTool, loadWebConfig, normalizeDomains, saveWebConfig, searchUrl } from "../lib/web-tools.js";
// ===== Dictée locale Whisper (multi-OS, moteur téléchargé à la demande) =====
// L'état vit en localStorage (whisperDictation / whisperModel), lu directement
// par src/lib/whisper-dictation.js dans la barre et le bureau — appliqué
// immédiatement, sans passer par le bouton « Enregistrer » global.
// ===== Commande vocale du bureau (opt-in) =====
// Réglage JSON en localStorage (« voiceControl »), relu par le bureau à chaque
// appui du raccourci et propagé aux boutons micro par l'événement `storage`.
function initVoiceControlUI() {
  const on = $("checkbox-voice-control"), box = $("voice-control-settings");
  const shortcut = $("select-voice-shortcut"), router = $("checkbox-voice-router");
  const intents = $("checkbox-voice-intents"), speak = $("checkbox-voice-speak");
  if (!on || !box) return;
  const prefs = voiceControlPrefs();
  on.checked = prefs.enabled; box.hidden = !prefs.enabled;
  shortcut.value = prefs.shortcut; router.checked = prefs.router;
  intents.checked = prefs.intents; intents.disabled = !prefs.router; speak.checked = prefs.speak;
  const save = () => {
    saveVoiceControlPrefs({ enabled: on.checked, shortcut: shortcut.value, router: router.checked, intents: router.checked && intents.checked, speak: speak.checked });
    box.hidden = !on.checked;
    intents.disabled = !router.checked;
  };
  for (const el of [on, shortcut, router, intents, speak]) el.addEventListener("change", save);
}

function initWhisperUI() {
  const chk = $("checkbox-whisper"), cfg = $("whisper-config"), sel = $("select-whisper-model");
  const backend = $("select-dictation-backend");
  const btn = $("btn-whisper-dl"), st = $("whisper-status");
  if (!chk || !cfg || !sel || !backend) return;
  sel.innerHTML = "";
  for (const m of WHISPER_MODELS) sel.appendChild(new Option(m.label, m.id));
  sel.value = whisperModelId();
  const on = localStorage.getItem("whisperDictation") === "1";
  chk.checked = on;
  backend.value = on ? "whisper" : "native";
  backend.addEventListener("change", () => {
    chk.checked = backend.value === "whisper";
    localStorage.setItem("whisperDictation", chk.checked ? "1" : "0");
    updateVoiceDictationModeUI();
  });
  sel.addEventListener("change", () => localStorage.setItem("whisperModel", sel.value));
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    st.textContent = t("whisper_dl_progress", { file: "…", pct: 0 });
    try {
      await whisperLoad((file, pct) => { st.textContent = t("whisper_dl_progress", { file, pct }); });
      st.textContent = t("whisper_dl_done");
    } catch (e) {
      st.textContent = t("whisper_dl_fail", { err: e?.message || e });
      btn.disabled = false;
    }
  });
}

// Moteur natif whisper.cpp : choix du moteur, modèle ggml, téléchargement.
async function initWhisperNativeUI() {
  const engine = $("select-whisper-engine"), sel = $("select-whisper-native-model");
  const dl = $("btn-whisper-native-dl"), del = $("btn-whisper-native-del"), st = $("whisper-native-status");
  if (!engine || !sel) return;
  engine.value = localStorage.getItem("whisperEngine") || "auto";
  engine.addEventListener("change", () => { localStorage.setItem("whisperEngine", engine.value); whisperNativeInvalidate(); });
  const mb = (n) => `${Math.round(n / 1e6)} Mo`;
  let status = null;
  const render = async () => {
    status = await whisperNativeStatus();
    if (!status) { $("whisper-native").hidden = true; return; }
    const want = localStorage.getItem("whisperNativeModel") || status.default_model;
    sel.innerHTML = status.models.map((m) => `<option value="${m.id}">${m.installed ? "✓ " : ""}${m.label} — ${mb(m.size)}</option>`).join("");
    sel.value = want;
    const cur = status.models.find((m) => m.id === sel.value);
    dl.hidden = !!cur?.installed; del.hidden = !cur?.installed;
    st.textContent = !status.binary
      ? t("whisper_native_nobin")
      : status.ready
        ? (status.running ? t("whisper_native_running", { model: status.running_model }) : t("whisper_native_ready"))
        : t("whisper_native_nomodel");
  };
  sel.addEventListener("change", () => { localStorage.setItem("whisperNativeModel", sel.value); whisperNativeInvalidate(); render(); });
  dl.addEventListener("click", async () => {
    dl.disabled = true;
    const ev = window.__TAURI__?.event;
    const un = ev ? await ev.listen("whisper-download", (e) => { if (e.payload?.id === sel.value && e.payload.pct >= 0) st.textContent = t("whisper_dl_progress", { file: sel.value, pct: e.payload.pct }); }) : null;
    try {
      await invoke("whisper_download_model", { id: sel.value });
      localStorage.setItem("whisperNativeModel", sel.value);
      whisperNativeInvalidate();
    } catch (e) { st.textContent = t("whisper_dl_fail", { err: e?.message || e }); }
    un?.(); dl.disabled = false; render();
  });
  del.addEventListener("click", async () => {
    try { await invoke("whisper_delete_model", { id: sel.value }); } catch (e) { st.textContent = String(e); }
    whisperNativeInvalidate(); render();
  });
  render();
}

// Lumen comme serveur MCP (mcp_server.rs) : activation avec avertissement.
async function initMcpServerUI() {
  const on = $("checkbox-mcp-server"), wr = $("checkbox-mcp-write"), box = $("mcp-server-details"), st = $("mcp-server-status");
  if (!on) return;
  let v = null, shown = false;
  const snippet = (view) => JSON.stringify({ mcpServers: { lumen: { command: view.stdio_command.replace(/ --mcp-stdio$/, ""), args: ["--mcp-stdio"] } } }, null, 2);
  const render = () => {
    on.checked = v.enabled; wr.checked = v.allow_write; wr.disabled = !v.enabled; box.hidden = !v.enabled;
    $("mcp-server-url").textContent = v.url;
    $("mcp-server-token").textContent = shown ? v.token : "••••••••••••";
    $("mcp-server-snippet").textContent = `${snippet(v)}\n\n# ${t("mcp_http_hint")}\n# URL : ${v.url}\n# Authorization: Bearer <${t("lbl_mcp_token")}>`;
    const n = (v.tools || []).filter((x) => x.enabled).length;
    $("mcp-server-tools").textContent = t("mcp_tools_count", { n, mode: v.allow_write ? t("mcp_mode_rw") : t("mcp_mode_ro") });
    st.textContent = v.enabled ? t("mcp_status_on") : "";
  };
  const save = async (patch = {}) => {
    try { v = await invoke("mcp_server_set", { enabled: patch.enabled ?? v.enabled, allowWrite: patch.allow_write ?? v.allow_write, disabled: [], regenerate: !!patch.regenerate }); render(); }
    catch (e) { st.textContent = String(e?.message || e); }
  };
  try { v = await invoke("mcp_server_get"); } catch { return; }
  render();
  on.addEventListener("change", async () => {
    if (on.checked) {
      const ok = await confirmSheet({ title: t("mcp_warn_title"), body: t("mcp_warn_body"), confirm: t("mcp_warn_ok"), cancel: t("mcp_warn_cancel") });
      if (!ok) { on.checked = false; return; }
    }
    save({ enabled: on.checked, allow_write: on.checked ? v.allow_write : false });
  });
  wr.addEventListener("change", async () => {
    if (wr.checked) {
      const ok = await confirmSheet({ title: t("mcp_warn_write_title"), body: t("mcp_warn_write_body"), confirm: t("mcp_warn_ok"), cancel: t("mcp_warn_cancel"), danger: true });
      if (!ok) { wr.checked = false; return; }
    }
    save({ allow_write: wr.checked });
  });
  $("btn-mcp-token-show").addEventListener("click", () => { shown = !shown; render(); });
  $("btn-mcp-token-copy").addEventListener("click", () => navigator.clipboard?.writeText(v.token).then(() => (st.textContent = t("mcp_copied"))).catch(() => {}));
  $("btn-mcp-snippet-copy").addEventListener("click", () => navigator.clipboard?.writeText(snippet(v)).then(() => (st.textContent = t("mcp_copied"))).catch(() => {}));
  $("btn-mcp-token-regen").addEventListener("click", async () => {
    if (await confirmSheet({ title: t("mcp_regen_title"), body: t("mcp_regen_body"), confirm: t("btn_mcp_token_regen"), cancel: t("mcp_warn_cancel") })) save({ regenerate: true });
  });
}

// Skills au format Agent Skills.
const SKILL_TEMPLATE = `---
name: compte-rendu-reunion
description: Rédiger un compte rendu de réunion au format de l'équipe (décisions, actions, responsables, échéances).
---

# Compte rendu de réunion

1. Titre : « Réunion — <sujet> — <date> ».
2. Section « Décisions » : une puce par décision, au présent.
3. Section « Actions » : tableau Action | Responsable | Échéance.
4. Terminer par les points en suspens.
`;
async function initSkillsUI() {
  const listEl = $("skills-list"), st = $("skills-status"), ed = $("skill-editor"), md = $("skill-md");
  if (!listEl) return;
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const render = async () => {
    let l = []; try { l = await invoke("agentskill_list"); } catch {}
    try { localStorage.setItem("agentSkillsCount", String(l.length)); } catch {}
    listEl.innerHTML = l.length ? l.map((k) => `<div class="skill-row" data-id="${esc(k.id)}"><div><b>${esc(k.name)}</b><small>${esc(k.description)}</small><small class="muted">${k.files.length} ${esc(t("skill_files"))}</small></div>
      <div class="skill-actions"><button type="button" data-skill="edit">${esc(t("btn_skill_edit"))}</button><button type="button" data-skill="export">${esc(t("btn_skill_export"))}</button><button type="button" data-skill="del">${esc(t("btn_skill_delete"))}</button></div></div>`).join("")
      : `<p class="setting-hint">${esc(t("skills_none"))}</p>`;
  };
  listEl.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-skill]"); if (!b) return;
    const id = b.closest("[data-id]").dataset.id;
    try {
      if (b.dataset.skill === "edit") { const g = await invoke("agentskill_get", { id }); md.value = g.markdown; ed.hidden = false; md.focus(); }
      if (b.dataset.skill === "del") { if (await confirmSheet({ title: t("skill_delete_confirm"), danger: true })) { await invoke("agentskill_delete", { id }); render(); } }
      if (b.dataset.skill === "export") { const p = await invoke("agentskill_export", { id, destDir: "" }); st.textContent = `${t("skill_exported")} ${p}`; }
    } catch (err) { st.textContent = String(err?.message || err); }
  });
  $("btn-skill-new").addEventListener("click", () => { md.value = SKILL_TEMPLATE; ed.hidden = false; md.focus(); });
  $("btn-skill-cancel").addEventListener("click", () => { ed.hidden = true; });
  $("btn-skill-save").addEventListener("click", async () => {
    try { await invoke("agentskill_save", { markdown: md.value }); ed.hidden = true; st.textContent = t("skill_saved"); render(); }
    catch (err) { st.textContent = String(err?.message || err); }
  });
  $("btn-skill-import").addEventListener("click", async () => {
    const path = $("input-skill-import").value.trim(); if (!path) return;
    try { const k = await invoke("agentskill_import", { path }); st.textContent = `${t("skill_imported")} ${k.name}`; $("input-skill-import").value = ""; render(); }
    catch (err) { st.textContent = String(err?.message || err); }
  });
  render();
}

// Performances llama.cpp (llama.rs › llama_perf_*).
async function initLlamaPerfUI() {
  const kv = $("select-llama-kv"), reuse = $("checkbox-llama-reuse"), draft = $("select-llama-draft");
  if (!kv || !draft) return;
  let v; try { v = await invoke("llama_perf_get"); } catch { return; }
  kv.value = v.kv_cache; reuse.checked = !!v.cache_reuse;
  const opts = [["", t("opt_draft_off")], ["dspark", t("opt_draft_dspark")], ["ngram", t("opt_draft_ngram")], ["auto", t("opt_draft_auto") + (v.draft_resolved ? ` → ${v.draft_resolved}` : "")]]
    .concat((v.installed || []).filter((f) => !/-dspark/i.test(f)).map((f) => [f, f]));
  draft.innerHTML = opts.map(([val, label]) => `<option value="${val}">${label}</option>`).join("");
  draft.value = v.draft || "";
  const save = () => invoke("llama_perf_set", { perf: { kv_cache: kv.value, cache_reuse: reuse.checked, draft: draft.value, draft_max: v.draft_max || 16 } }).catch(() => {});
  [kv, reuse, draft].forEach((el) => el.addEventListener("change", () => { save(); renderDspark(); }));
  // DSpark (Liquid AI) : brouillon officiel du modèle actif, s'il en a un.
  const row = $("dspark-row"), dst = $("dspark-status"), dbtn = $("btn-dspark-download");
  const mb = (n) => `${Math.round(n / 1e6)} Mo`;
  async function renderDspark() {
    let info; try { info = await invoke("llama_dspark_info", {}); } catch { row.hidden = true; return; }
    const want = draft.value === "dspark" || draft.value === "auto";
    row.hidden = !(want || info.supported);
    if (!info.target) { dst.textContent = t("dspark_no_model"); dbtn.hidden = true; return; }
    if (!info.supported) { dst.textContent = t("dspark_unsupported", { model: info.target }); dbtn.hidden = true; return; }
    dbtn.hidden = info.installed;
    dst.textContent = info.installed ? t("dspark_ready", { file: info.file }) : t("dspark_missing", { file: info.file, size: mb(info.size) });
    dbtn.onclick = async () => {
      dbtn.disabled = true; dst.textContent = t("dspark_downloading");
      try { await invoke("llama_download_model", { request: { id: `dspark-${Date.now()}`, url: info.url, filename: info.file, mmprojFilename: null, mmprojUrl: null } }); }
      catch (e) { dst.textContent = String(e?.message || e); }
      dbtn.disabled = false; renderDspark();
    };
  }
  renderDspark();
}

// Reranking (src-tauri/src/rerank.rs).
async function initRerankUI() {
  const chk = $("checkbox-rerank"), sel = $("select-rerank-model"), dl = $("btn-rerank-download"), del = $("btn-rerank-delete"), st = $("rerank-status");
  if (!chk || !sel) return;
  const mb = (n) => `${Math.round(n / 1e6)} Mo`;
  const render = async () => {
    let s; try { s = await invoke("rerank_status"); } catch { return; }
    chk.checked = s.enabled;
    const keep = sel.value || s.model;
    sel.innerHTML = s.models.map((m) => `<option value="${m.id}">${m.installed ? "✓ " : ""}${m.label} — ${mb(m.size)}</option>`).join("");
    sel.value = keep || s.models[0]?.id;
    const cur = s.models.find((m) => m.id === sel.value);
    dl.hidden = !!cur?.installed; del.hidden = !cur?.installed;
    st.textContent = !s.binary ? t("rerank_nobin") : s.model ? (s.running ? t("rerank_running", { model: s.model }) : t("rerank_ready", { model: s.model })) : t("rerank_nomodel");
  };
  const save = () => invoke("rerank_config_set", { enabled: chk.checked, model: sel.value }).then(render).catch(() => {});
  chk.addEventListener("change", save);
  sel.addEventListener("change", save);
  dl.addEventListener("click", async () => {
    dl.disabled = true;
    const un = window.__TAURI__?.event ? await window.__TAURI__.event.listen("rerank-download", (e) => { if (e.payload?.pct >= 0) st.textContent = t("whisper_dl_progress", { file: sel.value, pct: e.payload.pct }); }) : null;
    try { await invoke("rerank_download_model", { id: sel.value }); await save(); }
    catch (e) { st.textContent = t("whisper_dl_fail", { err: e?.message || e }); }
    un?.(); dl.disabled = false; render();
  });
  del.addEventListener("click", async () => { try { await invoke("rerank_delete_model", { id: sel.value }); } catch {} render(); });
  render();
}

let localTtsRuntimeReady = false;

function updateVoiceDictationModeUI() {
  const selected = $("select-speech-backend")?.value || "auto";
  const resolved = selected === "auto"
    ? (localTtsRuntimeReady ? "piper" : "system")
    : selected;
  if ($("tts-settings")) $("tts-settings").style.display = resolved === "piper" ? "block" : "none";
  if ($("webtts-settings")) $("webtts-settings").style.display = resolved === "system" ? "block" : "none";
  if ($("speech-shortcut-settings")) $("speech-shortcut-settings").style.display = resolved === "shortcut" ? "block" : "none";

  const whisper = ($("select-dictation-backend")?.value || "native") === "whisper";
  if ($("whisper-config")) $("whisper-config").hidden = !whisper;
  if ($("dictation-native-settings")) {
    $("dictation-native-settings").style.display = !whisper && !platformWithoutAppleShortcuts() ? "block" : "none";
  }
}

async function refreshLocalTtsRuntime() {
  localTtsRuntimeReady = await invoke("tts_runtime_available").catch(() => false);
  updateVoiceDictationModeUI();
}

// En iframe (workspace), Tauri n'injecte pas toujours `window.__TAURI__` dans les
// sous-frames sur Linux/WebKitGTK → tous les appels backend (memory_get, emit de
// synchro, set_ollama_config) deviennent des no-op silencieux (profil vide, pas
// de sauvegarde). L'iframe étant MÊME-ORIGINE, on récupère l'API du parent.
let TAURI = window.__TAURI__;
try { if (!TAURI && window.parent !== window) TAURI = window.parent.__TAURI__; } catch {}
const { invoke } = TAURI?.core || { invoke: async () => {} };
const currentWindow = TAURI?.window?.getCurrentWindow?.();
const DEFAULT_OLLAMA_MODEL = "liquidai/lfm2.5-350m:latest";
const LEGACY_OLLAMA_MODELS = new Set(["liquid-fm:350m"]);
const tauriEvent = TAURI?.event;

function alwaysOnTopSettingValue() {
  const input = $("checkbox-always-on-top");
  if (input?.dataset.desktopSuspended === "1") {
    return localStorage.getItem("alwaysOnTop") !== "false";
  }
  return input?.checked ?? true;
}
const embeddedInWorkspace = window.parent !== window;

// Liste les modèles Ollama via le backend Rust (fiable sous Windows : pas de CORS
// WebView2 ni de souci IPv6 `localhost`). Repli sur un fetch direct si la commande
// n'existe pas (build plus ancien).
async function listOllamaModels(url) {
  try {
    const models = await invoke("ollama_list_models", { url });
    if (Array.isArray(models)) return models.filter(Boolean);
  } catch (e) {
    // Repli direct (origine WebView — peut échouer sous Windows à cause du CORS).
    try {
      const data = await ollamaGetJson("api/tags", url || "http://127.0.0.1:11434");
      return (data.models || []).map((m) => m.name).filter(Boolean);
    } catch { throw e; }
  }
  return [];
}

// Icones : jeu unique et vendorise (cf. lib/icons.js). Les Parametres avaient
// leur propre jeu, dessine a la main et d'une graisse differente du reste.


function icon(name) {
  return lumenIcon(name);
}
function applyIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    if (!el.firstElementChild) el.innerHTML = icon(el.dataset.icon);
  });
}

const $ = (id) => document.getElementById(id);

// Orbe physique (ESP32) : saisie de l'IP + connexion via le pont Rust global
// (orb_connect). L'écriture dans localStorage réveille aussi la fenêtre
// principale (event storage) qui possède le push d'état (voir orb-bridge.js).
// ===== Badges RFID =====
//
// Mode ASSOCIATION du lecteur. En fonctionnement normal le contrôleur ne
// signale que les TRANSITIONS : un badge peut rester posé sans que son action
// se rejoue, et il n'est réémis qu'après un retrait. Un écran d'association
// attendrait donc indéfiniment un badge déjà sur le lecteur ; tant qu'il est
// armé, le contrôleur réémet l'UID présent.
//
// La fenêtre des Réglages ne sait pas dans quel champ le contrôleur a été
// renseigné (orb-bridge.js le déduit du « hello », côté fenêtre principale) :
// on envoie donc aux deux liens. L'orbe ignore les clés qu'il ne connaît pas.
async function setRfidPairing(on) {
  const line = JSON.stringify({ type: "state", rfid_pairing: !!on });
  for (const device of ["controller", "orb"]) {
    await invoke("orb_send", { line, device }).catch(() => {});
  }
}

// Le contrôleur n'envoie qu'un UID ; toute l'intelligence est ici. Le menu se
// construit à partir de RFID_ACTIONS : ajouter une action au registre la fait
// apparaître dans cette liste sans toucher à cette fonction.
function initRfidUI() {
  const btnScan = $("btn-rfid-scan");
  const statusEl = $("rfid-status");
  const assign = $("rfid-assign");
  const inputLabel = $("input-rfid-label");
  const selAction = $("select-rfid-action");
  const selParam = $("select-rfid-param");
  const btnSave = $("btn-rfid-save");
  const listEl = $("rfid-list");
  if (!btnScan || !selAction || !selParam || !listEl) return;

  let scanning = false;
  let currentUid = "";
  let unlisten = null;

  for (const [id, meta] of Object.entries(RFID_ACTIONS)) {
    selAction.appendChild(new Option(t(meta.labelKey) || id, id));
  }

  // Valeurs proposées pour l'action choisie. Le `param` du registre dit quelle
  // source interroger ; une action sans paramètre masque simplement le champ.
  async function fillParams() {
    const meta = RFID_ACTIONS[selAction.value] || {};
    selParam.innerHTML = "";
    const wrap = $("label-rfid-param");
    const visible = !!meta.param;
    selParam.hidden = !visible;
    if (wrap) wrap.hidden = !visible;
    if (!visible) return;

    if (meta.param === "chat_mode") {
      for (const m of RFID_CHAT_MODES) {
        selParam.appendChild(new Option(m, JSON.stringify({ mode: m })));
      }
      return;
    }
    if (meta.param === "voice") {
      try {
        const catalog = await invoke("tts_catalog");
        for (const v of (Array.isArray(catalog) ? catalog : []).filter((x) => x?.installed)) {
          selParam.appendChild(new Option(v.label || v.id, JSON.stringify({ voice: v.id })));
        }
      } catch (e) { /* Piper absent */ }
      if (!selParam.options.length) selParam.appendChild(new Option(t("tts_none_installed"), ""));
      return;
    }
    // meta.param === "model" : tous les modèles, tous backends confondus, pour
    // qu'un badge puisse aussi faire basculer de moteur.
    try {
      const gguf = await invoke("llama_list_models");
      for (const m of (Array.isArray(gguf) ? gguf : [])) {
        if (!m?.filename) continue;
        selParam.appendChild(new Option("llama.cpp · " + m.filename,
          JSON.stringify({ backend: "llama", model: m.filename })));
      }
    } catch (e) { /* llama.cpp non installé */ }
    try {
      const names = await listOllamaModels(localStorage.getItem("ollamaUrl") || null);
      for (const n of names) {
        selParam.appendChild(new Option("Ollama · " + n,
          JSON.stringify({ backend: "ollama", model: n })));
      }
    } catch (e) { /* Ollama hors ligne */ }
    const apiModel = localStorage.getItem("apiModel");
    if (apiModel) {
      selParam.appendChild(new Option("API · " + apiModel,
        JSON.stringify({ backend: "api", model: apiModel })));
    }
    if (!selParam.options.length) selParam.appendChild(new Option(t("rfid_no_model"), ""));
  }

  async function renderList() {
    const bindings = await loadBindings();
    listEl.innerHTML = "";
    if (!bindings.length) {
      const p = document.createElement("p");
      p.className = "setting-hint";
      p.textContent = t("hint_rfid_none");
      listEl.appendChild(p);
      return;
    }
    for (const b of bindings) {
      const row = document.createElement("div");
      row.className = "tts-voice-row";
      const meta = RFID_ACTIONS[b.action] || {};
      const value = b.params?.model || b.params?.mode || b.params?.voice || "";
      // `uid_masked` est tout ce que le backend consent à renvoyer.
      row.innerHTML = `<span class="tts-voice-meta">${escapeHTML(b.label || b.uid_masked)}<br>` +
        `<small>${escapeHTML(b.uid_masked)} · ${escapeHTML(t(meta.labelKey) || b.action)}` +
        `${value ? " · " + escapeHTML(value) : ""}</small></span>`;
      const del = document.createElement("button");
      del.className = "tts-voice-btn";
      del.textContent = t("btn_rfid_delete");
      del.addEventListener("click", async () => { await removeBinding(b.id); renderList(); });
      row.appendChild(del);
      listEl.appendChild(row);
    }
  }

  function stopScan() {
    scanning = false;
    btnScan.textContent = t("btn_rfid_scan");
    setRfidPairing(false);
    if (unlisten) { try { unlisten(); } catch (e) {} unlisten = null; }
  }

  async function startScan() {
    if (!tauriEvent) {
      statusEl.textContent = t("rfid_no_bridge");
      return;
    }
    scanning = true;
    currentUid = "";
    assign.hidden = true;
    btnScan.textContent = t("btn_rfid_cancel");
    statusEl.textContent = t("rfid_waiting");
    setRfidPairing(true);              // un badge déjà posé doit être capturé
    // Le contrôleur est branché à la fenêtre principale, mais orb_bridge.rs
    // réémet chaque ligne reçue vers TOUTES les webviews : cette fenêtre peut
    // donc écouter les scans directement.
    unlisten = await tauriEvent.listen("orb-command", async (e) => {
      const p = e?.payload || {};
      if (p.cmd !== "rfid" || !p.uid || !scanning) return;
      currentUid = normalizeUid(p.uid);
      stopScan();
      // L'UID n'est pas affiché : il n'est qu'un identifiant en transit, et
      // ne quitte cette fonction que pour aller au backend.
      statusEl.textContent = t("rfid_detected");
      const existing = await findBinding(currentUid);
      inputLabel.value = existing?.label || "";
      if (existing && RFID_ACTIONS[existing.action]) selAction.value = existing.action;
      await fillParams();
      assign.hidden = false;
    });
  }

  btnScan.addEventListener("click", () => (scanning ? stopScan() : startScan()));
  selAction.addEventListener("change", fillParams);
  btnSave.addEventListener("click", async () => {
    if (!currentUid) return;
    let params = {};
    try { params = JSON.parse(selParam.value || "{}"); } catch (e) { params = {}; }
    try {
      await upsertBinding({
        uid: currentUid,
        label: inputLabel.value.trim()
          || selParam.options[selParam.selectedIndex]?.text || "",
        action: selAction.value,
        params,
      });
    } catch (err) {
      statusEl.textContent = String(err);
      return;
    } finally {
      currentUid = "";                 // l'UID ne traîne pas en mémoire
    }
    assign.hidden = true;
    statusEl.textContent = t("rfid_saved");
    renderList();
  });

  fillParams();
  // Reprise des associations d'avant le stockage backend (UID en clair dans
  // localStorage), puis affichage.
  migrateLegacyBindings().then(() => renderList());
}

// Deux appareils, deux adresses, deux connexions indépendantes. L'orbe ESP32
// et le Lumen Controller parlent le même protocole sur le même port, mais une
// adresse unique obligeait à choisir lequel utiliser.
const ORB_DEVICES = [
  { device: "orb", input: "input-orb-host", hostKey: "orbBridgeHost", portKey: "orbBridgePort", label: "Orbe" },
  { device: "controller", input: "input-controller-host", hostKey: "controllerHost", portKey: "controllerPort", label: "Contrôleur" },
];

function initOrbDeviceUI() {
  const btn = $("btn-orb-connect");
  const status = $("orb-device-status");
  if (!btn) return;
  for (const d of ORB_DEVICES) {
    const el = $(d.input);
    if (el) el.value = localStorage.getItem(d.hostKey) || "";
  }
  const setStatus = (s) => { if (status) status.textContent = s; };

  // Un seul bouton pour les deux : on tente chaque appareil renseigné et on
  // résume le résultat, plutôt que de laisser croire à un échec global parce
  // qu'un des deux est éteint.
  async function connectAll(auto) {
    const parts = [];
    for (const d of ORB_DEVICES) {
      const el = $(d.input);
      const host = (el?.value || localStorage.getItem(d.hostKey) || "").trim();
      if (!host) {
        localStorage.removeItem(d.hostKey);
        if (!auto) await invoke("orb_disconnect", { device: d.device }).catch(() => {});
        continue;
      }
      const port = parseInt(localStorage.getItem(d.portKey) || "8787", 10);
      localStorage.setItem(d.hostKey, host);
      localStorage.setItem(d.portKey, String(port));
      try {
        await invoke("orb_connect", { host, port, device: d.device });
        parts.push(d.label + " ✓");
      } catch (e) {
        // Motif visible (refusé, délai, hôte injoignable) : « ✗ » seul ne
        // disait pas quoi corriger.
        parts.push(d.label + " ✗ (" + String(e).replace(/^connexion \w+: /, "").slice(0, 160) + ")");
      }
    }
    setStatus(parts.length ? parts.join(" · ")
                           : (t("dyn_orb_disconnected") || "Non connecté."));
  }

  btn.addEventListener("click", () => { setStatus("…"); connectAll(false); });
  // État réel du lien, même s'il est ouvert ou coupé par une autre fenêtre.
  const ev0 = TAURI && TAURI.event;
  if (ev0 && ev0.listen) {
    ev0.listen("orb-connected", (e) => {
      const d = ORB_DEVICES.find((x) => x.device === (e.payload || {}).device);
      if (d) setStatus(d.label + " ✓ " + ((e.payload || {}).host || ""));
    });
    ev0.listen("orb-disconnected", (e) => {
      const d = ORB_DEVICES.find((x) => x.device === (e.payload || {}).device);
      if (d) setStatus(d.label + " : " + (t("dyn_orb_disconnected") || "déconnecté"));
    });
  }
  // Reconnexion automatique : les adresses sont conservées après le premier
  // appairage, aucune action utilisateur n'est requise aux démarrages suivants.
  if (ORB_DEVICES.some((d) => localStorage.getItem(d.hostKey))) {
    setStatus("Connexion automatique…");
    connectAll(true);
  }

  // Zone météo de la page Heure de l'orbe (le cache est vidé si elle change).
  const wx = $("input-orb-weather");
  if (wx) {
    wx.value = localStorage.getItem("orbWeatherPlace") || "";
    wx.addEventListener("change", () => {
      const v = wx.value.trim();
      if (v) localStorage.setItem("orbWeatherPlace", v); else localStorage.removeItem("orbWeatherPlace");
      localStorage.removeItem("orbWeatherCache");
    });
  }

  // --- OTA : pousse les .py de l'orbe depuis un dossier, puis reset ---
  const fwdir = $("input-orb-fwdir");
  const btnOta = $("btn-orb-ota");
  const otaStatus = $("orb-ota-status");
  if (fwdir && btnOta) {
    // L'ancien réglage pointait vers esp32-orb (orbe ronde) : pour la M5 Fire,
    // on bascule sur le dossier voisin m5fire-orb.
    let saved = localStorage.getItem("orbFirmwareDir") || "";
    if (localStorage.getItem("orbDeviceKind") !== "round" && /esp32-orb\/?$/.test(saved)) {
      saved = saved.replace(/esp32-orb\/?$/, "m5fire-orb");
      localStorage.setItem("orbFirmwareDir", saved);
    }
    fwdir.value = saved;
    const setOta = (s) => { if (otaStatus) otaStatus.textContent = s; };
    const ev = TAURI && TAURI.event;
    if (ev && ev.listen) {
      ev.listen("orb-ota-progress", (e) => {
        const p = e.payload || {};
        setOta((t("dyn_orb_ota_running") || "Envoi… ") + p.file + " " + p.chunk + "/" + p.of);
      });
      ev.listen("orb-ota-done", (e) => {
        setOta((t("dyn_orb_ota_done") || "Mise à jour envoyée ✓ ") +
               ((e.payload || {}).files || 0) + " fichiers — l'orbe redémarre.");
      });
    }
    btnOta.addEventListener("click", async () => {
      const dir = fwdir.value.trim();
      if (!dir) { setOta(t("dyn_orb_ota_needdir") || "Renseigne le dossier esp32-orb."); return; }
      localStorage.setItem("orbFirmwareDir", dir);
      btnOta.disabled = true;
      setOta(t("dyn_orb_ota_running") || "Envoi…");
      try {
        // M5 Fire par défaut (l'ancien firmware ne se présente pas encore) ;
        // « round » seulement si l'orbe ronde s'est annoncée comme telle.
        const kind = localStorage.getItem("orbDeviceKind") === "round" ? "round" : "m5fire";
        await invoke("orb_ota", { dir, kind });
      } catch (e) {
        setOta((t("dyn_orb_ota_fail") || "Échec OTA : ") + e);
      } finally {
        btnOta.disabled = false;
      }
    });
  }
}
const bool = (key, fallback = false) => localStorage.getItem(key) == null ? fallback : localStorage.getItem(key) === "true";
const num = (key, fallback) => Number.parseInt(localStorage.getItem(key) || String(fallback), 10);
const val = (key, fallback = "") => localStorage.getItem(key) || fallback;
let profileStoragePrefix = "";
const wsKey = (key) => `${profileStoragePrefix}${key}`;
const wsVal = (key, fallback = "") => localStorage.getItem(wsKey(key)) || fallback;
function modelVal() {
  const selected = val("selectedModel", defaults.selectedModel);
  if (LEGACY_OLLAMA_MODELS.has(selected)) {
    localStorage.setItem("selectedModel", DEFAULT_OLLAMA_MODEL);
    return DEFAULT_OLLAMA_MODEL;
  }
  return selected;
}

const defaults = {
  ollamaUrl: "http://localhost:11434",
  selectedModel: DEFAULT_OLLAMA_MODEL,
  apiBaseUrl: "https://api.openai.com/v1",
  apiModel: "gpt-4o-mini",
  imageProvider: "bonsai",
  imageOllamaModel: "flux",
  imageBonsaiModel: "ternary",
  imageOpenaiModel: "gpt-image-1",
  imagePlaygroundStyle: "any",
  shortcutName: "Apple Intelligence",
  actionRouter: "Action Router",
  speechBackend: "auto",
  speakShortcut: "Speak Text",
  dictateShortcut: "Dictate Text",
  barSize: "moyen",
  barOpaque: "false",
  lumenPerfMode: "false",
  morningView: "true",
  startupLumenOS: "false",
  themePreference: "dark",
  orbColors: ["#ff54a3", "#9961ff", "#47a3ff", "#61f2c7", "#ff9e6b"],
};

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
// Les commandes TTS locales sont multiplateformes. Le test indiquera clairement
// si le binaire Piper n'a pas encore été installé par le script de la plateforme.
function ttsLocalAvailable() {
  return true;
}
function barOpaqueDefault() {
  return platformFlavor === "rpi" || platformFlavor === "linux-standard";
}
function barOpaqueAvailable() {
  // Disponible partout, macOS compris (rendu inline dans la barre).
  return true;
}

const escapeHTML = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function ttsStatus(msg) {
  const el = $("tts-status");
  if (el) el.textContent = msg || "";
}

// ---------- Personnalisation de la voix Piper ----------
// Quatre curseurs (débit, expressivité, variation, pauses) et le locuteur pour
// les modèles multi-locuteurs. Les bornes viennent du backend
// (`tts_tuning_limits`) : le curseur ne peut pas proposer une valeur que Piper
// rendrait mal. Chaque relâchement enregistre ET fait entendre le résultat.
let ttsLimits = null;
let ttsTuning = null;
let ttsTuneVoice = "";
const TTS_SPEAKER_COLORS = ["#7bd15a", "#f0a63c", "#ff7a3d", "#e63f6a", "#b64de3", "#3d8cff", "#2fc3b8", "#e0c231"];

const TTS_SLIDERS = [
  // Débit : le curseur va vers la droite = plus vite, alors que length_scale
  // grandit vers le lent — d'où l'inversion.
  { id: "pace", key: "length_scale", range: "length_scale", invert: true, fmt: (v) => `×${(1 / v).toFixed(2)}` },
  { id: "expr", key: "noise_scale", range: "noise_scale", fmt: (v) => `${Math.round(v * 100)}` },
  { id: "var", key: "noise_w", range: "noise_w", fmt: (v) => `${Math.round(v * 100)}` },
  { id: "pause", key: "sentence_silence", range: "sentence_silence", fmt: (v) => `${v.toFixed(2)} s` },
];

function ttsSliderToValue(spec, pos) {
  const [min, max] = ttsLimits[spec.range];
  const t = Math.min(100, Math.max(0, Number(pos))) / 100;
  return spec.invert ? max - (max - min) * t : min + (max - min) * t;
}
function ttsValueToSlider(spec, value) {
  const [min, max] = ttsLimits[spec.range];
  const t = (Math.min(max, Math.max(min, value)) - min) / (max - min);
  return Math.round((spec.invert ? 1 - t : t) * 100);
}

function renderTtsTuning() {
  if (!ttsLimits || !ttsTuning) return;
  for (const spec of TTS_SLIDERS) {
    const input = $(`range-tts-${spec.id}`);
    const label = $(`label-tts-${spec.id}`);
    if (input) input.value = String(ttsValueToSlider(spec, ttsTuning[spec.key]));
    if (label) label.textContent = spec.fmt(ttsTuning[spec.key]);
  }
  $("tts-speakers")?.querySelectorAll(".tts-speaker").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.id) === (ttsTuning.speaker ?? 0));
  });
}

async function refreshTtsTuning(voice) {
  const block = $("tts-tune");
  if (!block) return;
  ttsTuneVoice = voice || "";
  // Kokoro n'a pas ces réglages ; sans voix, rien à régler.
  if (!voice || voice.startsWith("kokoro:")) { block.hidden = true; return; }
  try {
    if (!ttsLimits) ttsLimits = await invoke("tts_tuning_limits");
    const [tuning, speakers] = await Promise.all([
      invoke("tts_get_tuning", { voice }),
      invoke("tts_voice_speakers", { voice }).catch(() => []),
    ]);
    ttsTuning = tuning;
    const item = $("tts-speaker-item");
    const host = $("tts-speakers");
    if (item && host) {
      host.innerHTML = "";
      item.hidden = speakers.length < 2;
      speakers.forEach((sp, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tts-speaker";
        b.dataset.id = String(sp.id);
        b.title = sp.name;
        b.style.setProperty("--sp", TTS_SPEAKER_COLORS[i % TTS_SPEAKER_COLORS.length]);
        b.innerHTML = `<span>${i + 1}</span>`;
        b.addEventListener("click", () => {
          ttsTuning.speaker = sp.id;
          renderTtsTuning();
          saveTtsTuning(true);
        });
        host.appendChild(b);
      });
    }
    block.hidden = false;
    renderTtsTuning();
  } catch (e) {
    console.warn("Réglages Piper indisponibles :", e);
    block.hidden = true;
  }
}

let ttsSaveTimer = 0;
function saveTtsTuning(preview) {
  clearTimeout(ttsSaveTimer);
  ttsSaveTimer = setTimeout(async () => {
    if (!ttsTuning || !ttsTuneVoice) return;
    try {
      ttsTuning = await invoke("tts_set_tuning", { voice: ttsTuneVoice, tuning: ttsTuning });
      renderTtsTuning();
      ttsStatus(t("tts_tune_saved"));
      if (preview) invoke("tts_speak", { text: t("tts_test_phrase"), voice: ttsTuneVoice }).catch((e) => ttsStatus("Échec : " + (e?.message || e)));
    } catch (e) {
      ttsStatus("Échec : " + (e?.message || e));
    }
  }, 350);
}

function initTtsTuningUI() {
  for (const spec of TTS_SLIDERS) {
    const input = $(`range-tts-${spec.id}`);
    if (!input) continue;
    input.addEventListener("input", () => {
      if (!ttsTuning || !ttsLimits) return;
      ttsTuning[spec.key] = ttsSliderToValue(spec, input.value);
      const label = $(`label-tts-${spec.id}`);
      if (label) label.textContent = spec.fmt(ttsTuning[spec.key]);
    });
    input.addEventListener("change", () => saveTtsTuning(true));
  }
  $("btn-tts-tune-reset")?.addEventListener("click", () => {
    if (!ttsLimits) return;
    ttsTuning = { ...ttsLimits.defaults, speaker: null };
    renderTtsTuning();
    saveTtsTuning(true);
  });
}

// ---------- Synthèse vocale « système » (Web Speech, macOS/Windows) ----------
// Choix global (localStorage `lumenVoiceURI`) réutilisé par les apps qui lisent du
// texte (Compagnon IA, Aventure…). Même origine ⇒ localStorage partagé.
let webVoices = [];
function loadWebVoices() {
  if (!("speechSynthesis" in window)) return;
  const all = speechSynthesis.getVoices();
  const isFr = (v) => v.lang && v.lang.toLowerCase().startsWith("fr");
  webVoices = [...all.filter(isFr), ...all.filter((v) => !isFr(v))];
  const sel = $("select-web-voice");
  if (!sel) return;
  const cur = localStorage.getItem("lumenVoiceURI") || "";
  sel.innerHTML = `<option value="">${escapeHTML(t("opt_default_voice"))}</option>`;
  for (const v of webVoices) {
    const o = document.createElement("option");
    o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  }
  if (cur && webVoices.some((v) => v.voiceURI === cur)) {
    sel.value = cur;
    const selected = webVoices.find((voice) => voice.voiceURI === cur);
    if (selected) {
      localStorage.setItem("lumenVoiceName", selected.name);
      localStorage.setItem("lumenVoiceLang", selected.lang || "");
    }
  }
}
function initWebVoiceUI() {
  if (!("speechSynthesis" in window)) { const s = $("webtts-settings"); if (s) s.style.display = "none"; return; }
  loadWebVoices();
  // Les voix se chargent de façon asynchrone (surtout WebView2/WebKit).
  speechSynthesis.onvoiceschanged = loadWebVoices;
  $("select-web-voice")?.addEventListener("change", (e) => {
    localStorage.setItem("lumenVoiceURI", e.target.value);
    const selected = webVoices.find((voice) => voice.voiceURI === e.target.value);
    if (selected) {
      localStorage.setItem("lumenVoiceName", selected.name);
      localStorage.setItem("lumenVoiceLang", selected.lang || "");
    } else {
      localStorage.removeItem("lumenVoiceName");
      localStorage.removeItem("lumenVoiceLang");
    }
  });
  $("btn-web-voice-test")?.addEventListener("click", async () => {
    const selectedUri = $("select-web-voice")?.value || "";
    const appLang = getLang() === "en" ? "en" : "fr";
    const v = selectedUri
      ? webVoices.find((voice) => voice.voiceURI === selectedUri)
      : webVoices.find((voice) => (voice.lang || "").toLowerCase().startsWith(appLang));
    const lang = ((v?.lang || appLang).toLowerCase().startsWith("en")) ? "en" : "fr";
    const phrase = lang === "en"
      ? "Hello, I am Lumen. Text-to-speech is working."
      : "Bonjour, je suis Lumen. La synthèse vocale fonctionne.";
    if (v) {
      localStorage.setItem("lumenVoiceURI", v.voiceURI);
      localStorage.setItem("lumenVoiceName", v.name);
      localStorage.setItem("lumenVoiceLang", v.lang || "");
    }
    speechSynthesis.cancel();
    // Sur Mac, tester exactement le moteur utilisé ensuite par Lumen (`say`).
    if (/Mac/i.test(navigator.platform || navigator.userAgent || "")) {
      try {
        await invoke("system_speak", { text: phrase, lang, voice: v?.name || null });
        return;
      } catch (_) { /* repli Web Speech ci-dessous */ }
    }
    const u = new SpeechSynthesisUtterance(phrase);
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = appLang === "en" ? "en-US" : "fr-FR"; }
    speechSynthesis.speak(u);
  });
}

// Peuple le sélecteur de voix active et le catalogue téléchargeable sur toutes
// les plateformes prises en charge par Piper.
// ===================== Connecteurs MCP =====================
//
// Deux principes tiennent tout le reste :
//  - un connecteur DÉSACTIVÉ n'existe pas pour le modèle : ni outils, ni
//    descriptions, donc aucun contexte consommé (pendant exact du réglage
//    « visible comme outil » des workflows Fluxo) ;
//  - ajouter ou activer un connecteur est une action d'utilisateur, jamais une
//    capacité offerte à l'IA.
let mcpPicker = null;
let mcpServers = [];

// ===== Boîte à outils : ce que l'IA a le droit d'appeler ==================
//
// Le catalogue est reconstruit ici À L'IDENTIQUE de celui de la barre
// (buildFluxoTools dans src/main.js) : mêmes sources (workflows exposés,
// domotique, mémoire/connaissances, MCP visibles dans la barre) et mêmes noms
// de fonction — d'où sanitizeToolName partagé. Sans cette égalité stricte, une
// case décochée ici ne retirerait rien là-bas.
//
// Le choix vit en localStorage (liste noire), lu à chaque requête par la barre :
// aucun « Enregistrer » à cliquer, et un nouvel outil est publié par défaut.
async function toolboxCatalog() {
  const groups = new Map(TOOL_GROUPS.map((g) => [g.id, { ...g, tools: [] }]));

  let names = [];
  try { names = await invoke("list_fluxo_tool_workflows"); } catch { names = []; }
  for (const name of names || []) {
    groups.get("fluxo").tools.push({
      name: sanitizeToolName(name),
      label: name,
      desc: t("toolbox_fluxo_desc", { name }),
    });
  }

  for (const tool of settingsToolCatalog()) {
    const hint = toolHint(tool.name, getLang()) || tool;
    groups.get(tool.group)?.tools.push({ name: tool.name, label: hint.label, desc: hint.desc, effect: tool.effect });
  }

  for (const spec of buildWebTools()) {
    const hint = toolHint(spec.function.name, getLang());
    groups.get("web").tools.push({
      name: spec.function.name,
      label: hint?.label || spec.function.name,
      desc: hint?.desc || spec.function.description,
    });
  }

  // Un outil par agent (lib/agent-delegation.js) : mêmes noms que la barre.
  let agentList = [];
  try { agentList = (await invoke("agent_list")) || []; } catch { agentList = []; }
  for (const { fn, agent } of agentToolNames(agentList)) {
    groups.get("agents").tools.push({
      name: fn,
      label: `${agent.icon && !/^[a-z-]+$/.test(agent.icon) ? agent.icon + " " : ""}${agent.name}`,
      desc: agent.description || t("toolbox_agent_desc", { name: agent.name }),
      effect: "write",
    });
  }

  let mcpSpecs = [];
  try { mcpSpecs = await invoke("mcp_bar_tools"); } catch { mcpSpecs = []; }
  for (const spec of mcpSpecs || []) {
    const fn = spec.function || {};
    const meta = spec.lumen || {};
    groups.get("mcp").tools.push({
      name: fn.name,
      label: meta.tool || fn.name,
      desc: `${meta.server ? meta.server + " · " : ""}${fn.description || ""}`,
      effect: meta.effect,
    });
  }

  return [...groups.values()].filter((g) => g.tools.length);
}

// Catalogue et pickers conservés entre deux basculements : un simple
// « publier/retirer » ne doit PAS reconstruire la page, sinon la recherche en
// cours et la position de défilement sautent à chaque clic — insupportable pour
// trier une vingtaine de workflows.
let toolboxCatalogCache = [];
let toolboxPickers = new Map();

function toolboxRenderGroup(group) {
  const picker = toolboxPickers.get(group.id);
  if (!picker) return;
  const off = loadDisabledTools();
  picker.setItems(group.tools.map((tool) => {
    const published = !off.has(tool.name);
    return {
      id: tool.name,
      title: tool.label,
      meta: tool.name,
      description: tool.desc,
      installed: published,
      badge: published ? t("toolbox_published") : t("toolbox_off"),
      actions: [{
        label: published ? t("toolbox_unpublish") : t("toolbox_publish"),
        kind: published ? "danger" : "default",
        onClick: () => {
          setToolPublished(tool.name, !published);
          toolboxRenderGroup(group);
          toolboxRenderSummary();
        },
      }],
    };
  }));
}

function toolboxRenderSummary() {
  const summary = $("toolbox-summary");
  if (!summary) return;
  const off = loadDisabledTools();
  const all = toolboxCatalogCache.flatMap((g) => g.tools);
  summary.textContent = t("toolbox_summary", {
    on: all.filter((tool) => !off.has(tool.name)).length,
    total: all.length,
  });
}

async function refreshToolbox() {
  const root = $("toolbox-groups");
  if (!root) return;
  const catalog = await toolboxCatalog();
  toolboxCatalogCache = catalog;
  toolboxRenderSummary();

  root.innerHTML = "";
  toolboxPickers = new Map();
  for (const group of catalog) {
    const title = document.createElement("div");
    title.className = "settings-section-title";
    // Libellés et aides portés par TOOL_GROUPS dans les deux langues : un
    // `t()` sur une clé absente renverrait la clé elle-même (« toolbox_group_web »).
    title.textContent = toolGroupText(group, getLang()).label;
    root.appendChild(title);

    const hint = document.createElement("p");
    hint.className = "setting-hint";
    hint.textContent = group.id === "fluxo" ? t("toolbox_hint_fluxo") : toolGroupText(group, getLang()).hint;
    root.appendChild(hint);

    const host = document.createElement("div");
    host.className = "setting-item";
    root.appendChild(host);

    const picker = createCatalogPicker(host, {
      searchPlaceholder: t("toolbox_search"),
      emptyLabel: t("toolbox_empty"),
      countLabel: (shown, total) => t("toolbox_count", { shown, total }),
      maxHeight: "240px",
    });
    toolboxPickers.set(group.id, picker);
    toolboxRenderGroup(group);
  }

  if (!catalog.length) {
    root.innerHTML = `<div class="loaded-empty">${escapeHTML(t("toolbox_empty"))}</div>`;
  }
}

// ===== Recherche web : réglages =========================================
//
// Tout est appliqué IMMÉDIATEMENT (pas de bouton « Enregistrer ») : la barre
// relit la configuration à chaque requête. Désactiver la recherche doit prendre
// effet tout de suite, pas au prochain enregistrement global.
function initWebSearchUI() {
  const enabled = $("checkbox-web-enabled");
  if (!enabled) return;
  const engineSelect = $("select-web-engine");
  const config = loadWebConfig();

  engineSelect.innerHTML = WEB_ENGINES
    .map((engine) => `<option value="${escapeHTML(engine.id)}">${escapeHTML((getLang() === "en" && engine.labelEn) || engine.label)}</option>`).join("");

  enabled.checked = config.enabled;
  engineSelect.value = config.engine;
  $("input-web-endpoint").value = config.endpoint || "";
  $("input-web-results").value = String(config.maxResults);
  $("checkbox-web-fallback").checked = config.fallback !== false;
  $("input-web-pages").value = String(config.pages);
  $("input-web-perdomain").value = String(config.perDomain);
  $("checkbox-web-render").checked = config.renderJs !== false;
  $("input-web-deepen").value = String(config.deepen);
  $("checkbox-web-read").checked = config.readPages;
  $("input-web-chars").value = String(config.readChars);
  $("input-web-allow").value = config.allowlist.join(", ");
  $("input-web-block").value = config.blocklist.join(", ");

  const sync = () => {
    const current = loadWebConfig();
    const engine = WEB_ENGINES.find((e) => e.id === current.engine) || WEB_ENGINES[0];
    $("web-config").hidden = !current.enabled;
    // Un moteur intégré a son URL en dur : proposer un champ modifiable
    // laisserait croire qu'on peut la changer sans effet.
    $("web-endpoint-row").hidden = Boolean(engine.url);
    $("web-readchars-row").hidden = !current.readPages;
    // Le rendu JavaScript ne sert qu'à la lecture d'une page entière.
    $("web-deepen-row").hidden = !current.readPages;
    $("web-render-row").hidden = !current.readPages;
    $("web-render-hint").hidden = !current.readPages;
    // Le repli n'a de sens qu'entre moteurs généralistes : on masque l'option
    // plutôt que de laisser croire qu'elle s'appliquera à Wikipédia ou à une
    // instance SearXNG privée.
    $("web-fallback-row").hidden = !engine.general;
    $("web-fallback-hint").hidden = !engine.general;
    $("web-engine-hint").textContent = (getLang() === "en" && engine.hintEn) || engine.hint;
    // La liste d'outils du même onglet suit : activer la recherche y fait
    // apparaître les outils, l'autorisation de lecture en ajoute un second.
    refreshToolbox().catch(() => {});
  };

  const bind = (id, event, read) => {
    $(id)?.addEventListener(event, () => { saveWebConfig(read()); sync(); });
  };
  // Activation en DEUX temps. `confirm()` est inopérant dans la WebView Tauri,
  // et surtout : cocher une case ne rend pas compte de ce qu'on autorise
  // réellement — un modèle qui envoie des requêtes sur Internet en votre nom,
  // sans validation à chaque fois. Décocher, en revanche, est immédiat : rien
  // ne doit jamais retarder une désactivation.
  const confirmBox = $("web-confirm");
  enabled.addEventListener("change", () => {
    if (!enabled.checked) {
      saveWebConfig({ enabled: false });
      if (confirmBox) confirmBox.hidden = true;
      sync();
      return;
    }
    enabled.checked = false;          // pas encore actif : la confirmation décide
    if (confirmBox) confirmBox.hidden = false;
    else { saveWebConfig({ enabled: true }); sync(); }
  });
  $("btn-web-confirm")?.addEventListener("click", () => {
    enabled.checked = true;
    confirmBox.hidden = true;
    saveWebConfig({ enabled: true });
    sync();
  });
  $("btn-web-cancel")?.addEventListener("click", () => {
    enabled.checked = false;
    confirmBox.hidden = true;
    sync();
  });
  bind("select-web-engine", "change", () => ({ engine: engineSelect.value }));
  bind("input-web-endpoint", "change", () => ({ endpoint: $("input-web-endpoint").value.trim() }));
  bind("input-web-results", "change", () => ({ maxResults: $("input-web-results").value }));
  bind("checkbox-web-fallback", "change", () => ({ fallback: $("checkbox-web-fallback").checked }));
  bind("input-web-pages", "change", () => ({ pages: $("input-web-pages").value }));
  bind("input-web-perdomain", "change", () => ({ perDomain: $("input-web-perdomain").value }));
  bind("input-web-deepen", "change", () => ({ deepen: $("input-web-deepen").value }));
  bind("checkbox-web-render", "change", () => ({ renderJs: $("checkbox-web-render").checked }));
  bind("checkbox-web-read", "change", () => ({ readPages: $("checkbox-web-read").checked }));
  bind("input-web-chars", "change", () => ({ readChars: $("input-web-chars").value }));
  bind("input-web-allow", "change", () => ({ allowlist: normalizeDomains($("input-web-allow").value) }));
  bind("input-web-block", "change", () => ({ blocklist: normalizeDomains($("input-web-block").value) }));

  $("btn-web-test")?.addEventListener("click", async () => {
    const status = $("web-test-status");
    const current = loadWebConfig();
    const target = searchUrl(current, "Lumen assistant local");
    if (!target) {
      status.textContent = t("web_test_no_engine");
      status.style.color = "var(--danger)";
      return;
    }
    status.style.color = "";
    status.textContent = t("web_test_running");
    try {
      const out = await callWebTool(invoke, "web_search", { query: "Lumen assistant local" });
      status.textContent = String(out).slice(0, 400);
    } catch (e) {
      status.textContent = String(e?.message || e);
      status.style.color = "var(--danger)";
    }
  });

  sync();
}

function toolboxSetAll(published) {
  setToolsPublished(toolboxCatalogCache.flatMap((g) => g.tools.map((tool) => tool.name)), published);
  for (const group of toolboxCatalogCache) toolboxRenderGroup(group);
  toolboxRenderSummary();
}

function mcpStatus(text, isError = false) {
  const el = $("mcp-status");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "var(--danger)" : "";
}

async function refreshMcpServers() {
  const root = $("mcp-server-list");
  if (!root) return;
  try { mcpServers = await invoke("mcp_servers"); } catch { mcpServers = []; }
  if (!Array.isArray(mcpServers)) mcpServers = [];

  if (!mcpPicker) {
    mcpPicker = createCatalogPicker(root, {
      chips: [
        { id: "all", label: t("cat_chip_all") },
        { id: "on", label: t("mcp_chip_enabled"), test: (item) => item.installed },
        { id: "off", label: t("mcp_chip_disabled"), test: (item) => !item.installed },
      ],
      searchPlaceholder: t("mcp_search"),
      emptyLabel: t("mcp_none"),
      countLabel: (shown, total) => t("mcp_count", { shown, total }),
      maxHeight: "240px",
    });
  }
  mcpPicker.setItems(mcpServers.map((server) => ({
    id: server.id,
    title: server.name,
    meta: server.transport === "http"
      ? server.url
      : [server.command, ...(server.args || [])].join(" "),
    description: server.description || "",
    installed: server.enabled,
    badge: server.enabled ? t("mcp_badge_on") : t("mcp_badge_off"),
    actions: [
      {
        label: server.enabled ? t("mcp_disable") : t("mcp_enable"),
        onClick: async (ctx) => {
          ctx.button.disabled = true;
          try {
            await invoke("mcp_set_enabled", { id: server.id, enabled: !server.enabled });
            mcpStatus(server.enabled
              ? t("mcp_disabled_done", { name: server.name })
              : t("mcp_enabled_done", { name: server.name }));
          } catch (e) { mcpStatus(String(e?.message || e), true); }
          await refreshMcpServers();
        },
      },
      {
        label: t("mcp_test"),
        onClick: async (ctx) => {
          ctx.button.disabled = true;
          ctx.setStatus(t("mcp_testing"));
          try {
            const count = await invoke("mcp_probe", { id: server.id });
            ctx.setStatus(t("mcp_probe_ok", { count }));
          } catch (e) {
            ctx.setStatus(t("mcp_probe_fail", { err: e?.message || e }), true);
          }
          ctx.button.disabled = false;
        },
      },
      {
        label: t("llama_delete"),
        kind: "danger",
        onClick: async () => {
          await invoke("mcp_delete_server", { id: server.id }).catch((e) => mcpStatus(String(e), true));
          await refreshMcpServers();
        },
      },
    ],
  })));

  const select = $("select-mcp-server");
  if (select) {
    const previous = select.value;
    select.innerHTML = mcpServers.length
      ? mcpServers.map((s) => `<option value="${escapeHTML(s.id)}">${escapeHTML(s.name)}</option>`).join("")
      : `<option value="">${escapeHTML(t("mcp_none"))}</option>`;
    if (mcpServers.some((s) => s.id === previous)) select.value = previous;
    refreshMcpTools();
  }
}

async function refreshMcpTools() {
  const root = $("mcp-tool-list");
  const id = $("select-mcp-server")?.value || "";
  if (!root) return;
  root.innerHTML = "";
  if (!id) return;
  const server = mcpServers.find((s) => s.id === id);
  if (!server?.enabled) {
    // On n'interroge pas un connecteur désactivé : ce serait le lancer dans le dos
    // de l'utilisateur, exactement ce qu'on veut éviter.
    root.innerHTML = `<div class="loaded-empty">${escapeHTML(t("mcp_tools_need_enable"))}</div>`;
    return;
  }
  root.innerHTML = `<div class="loaded-empty">${escapeHTML(t("mcp_tools_loading"))}</div>`;
  let tools = [];
  try {
    tools = await invoke("mcp_tools", { id, force: false });
  } catch (e) {
    root.innerHTML = `<div class="loaded-empty">${escapeHTML(t("mcp_probe_fail", { err: e?.message || e }))}</div>`;
    return;
  }
  root.innerHTML = "";
  const picker = createCatalogPicker(root, {
    chips: [
      { id: "all", label: t("cat_chip_all") },
      { id: "read", label: t("mcp_effect_read"), test: (item) => item.effect === "read" },
      { id: "write", label: t("mcp_effect_write"), test: (item) => item.effect === "write" },
      { id: "external", label: t("mcp_effect_external"), test: (item) => item.effect === "external" },
      { id: "destructive", label: t("mcp_effect_destructive"), test: (item) => item.effect === "destructive" },
    ],
    searchPlaceholder: t("mcp_search_tool"),
    emptyLabel: t("cat_empty"),
    countLabel: (shown, total) => t("mcp_tools_count", { shown, total }),
    maxHeight: "260px",
  });
  picker.setItems(tools.map((tool) => ({
    id: tool.name,
    title: tool.name,
    meta: `${t(`mcp_effect_${tool.effect}`)} · ${t(`mcp_risk_${tool.risk}`)}`,
    description: tool.description,
    effect: tool.effect,
    installed: tool.enabled,
    badge: tool.enabled ? "" : t("mcp_tool_off"),
    actions: [
      {
        label: tool.enabled ? t("mcp_tool_disable") : t("mcp_tool_enable"),
        onClick: async (ctx) => {
          ctx.button.disabled = true;
          await invoke("mcp_set_tool_enabled", { id, tool: tool.name, enabled: !tool.enabled })
            .catch((e) => ctx.setStatus(String(e?.message || e), true));
          await refreshMcpTools();
        },
      },
      {
        label: t("mcp_try"),
        onClick: async (ctx) => {
          ctx.button.disabled = true;
          ctx.setStatus(t("mcp_trying"));
          try {
            const out = await invoke("mcp_call_tool", { server: id, tool: tool.name, arguments: {} });
            ctx.setStatus(String(out).slice(0, 400));
          } catch (e) {
            ctx.setStatus(String(e?.message || e), true);
          }
          ctx.button.disabled = false;
        },
      },
    ],
  })));
}

// Catalogue des connecteurs, en cartes. Chaque carte porte ce que le connecteur
// fait, ce qu'il exige, et — surtout — les champs qu'il attend. Avant, les
// gabarits `{{dossier}}` du catalogue étaient recopiés tels quels dans les
// arguments : le connecteur était ajouté cassé, et rien ne permettait de le
// corriger puisque la liste n'offre pas d'édition.
const MCP_GROUPS = [
  { id: "ready", title: "Prêts à l'emploi", hint: "Rien à configurer, rien à installer." },
  { id: "key",   title: "Avec un jeton personnel", hint: "Un jeton à coller, créé sur le site du service." },
];

async function refreshMcpCatalog() {
  const root = $("mcp-catalog");
  if (!root) return;
  let catalog = [];
  try { catalog = await invoke("mcp_catalog"); } catch { catalog = []; }
  const lang = getLang();
  const pick = (entry, key) => (lang === "en" && entry[`${key}En`]) || entry[key];

  root.innerHTML = "";
  for (const group of MCP_GROUPS) {
    const items = (catalog || []).filter((e) => e.group === group.id);
    if (!items.length) continue;
    const head = document.createElement("div");
    head.className = "mcp-group";
    head.innerHTML = `<span class="mcp-group-t">${escapeHTML(t(`mcp_group_${group.id}`) || group.title)}</span>`
      + `<span class="mcp-group-h">${escapeHTML(t(`mcp_group_${group.id}_hint`) || group.hint)}</span>`;
    root.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "mcp-cards";
    for (const entry of items) grid.appendChild(mcpCard(entry, pick));
    root.appendChild(grid);
  }
}

function mcpCard(entry, pick) {
  const card = document.createElement("div");
  card.className = "mcp-card";
  const already = mcpServers.some((s) => s.name === pick(entry, "name"));
  const inputs = Array.isArray(entry.inputs) ? entry.inputs : [];

  const needs = (entry.needs || []).map((n) => `<span class="mcp-need">${escapeHTML(n)}</span>`).join("");
  const warn = pick(entry, "warn");
  card.innerHTML = `
    <div class="mcp-card-head">
      <span class="mcp-card-logo">${brandIcon(entry.id) || brandIcon(String(entry.id).replace(/-.*$/, "")) || brandIcon("modelcontextprotocol")}</span>
      <span class="mcp-card-name">${escapeHTML(pick(entry, "name"))}</span>
      ${entry.transport === "http" ? `<span class="mcp-card-tag">${escapeHTML(t("mcp_tag_remote") || "en ligne")}</span>` : ""}
      ${already ? `<span class="mcp-card-tag on">${escapeHTML(t("mcp_tag_added") || "ajouté")}</span>` : ""}
    </div>
    <p class="mcp-card-desc">${escapeHTML(pick(entry, "description"))}</p>
    ${needs ? `<div class="mcp-needs">${needs}</div>` : ""}
    ${warn ? `<p class="mcp-card-warn">${escapeHTML(warn)}</p>` : ""}
    <div class="mcp-card-fields"></div>
    <div class="mcp-card-foot">
      ${entry.docs ? `<a class="mcp-card-doc" href="${escapeHTML(entry.docs)}" target="_blank" rel="noopener">${escapeHTML(t("mcp_card_doc") || "Comment l'obtenir")}</a>` : "<span></span>"}
      <button type="button" class="settings-save-btn secondary-action mcp-card-add"></button>
    </div>
    <div class="mcp-card-status"></div>`;

  const fields = card.querySelector(".mcp-card-fields");
  const values = {};
  for (const input of inputs) {
    const wrap = document.createElement("label");
    wrap.className = "mcp-field";
    wrap.innerHTML = `<span>${escapeHTML(input.label || input.key)}</span>`;
    const el = document.createElement("input");
    el.type = input.secret ? "password" : "text";
    el.placeholder = input.placeholder || "";
    el.spellcheck = false;
    el.autocomplete = "off";
    el.addEventListener("input", () => { values[input.key] = el.value.trim(); sync(); });
    wrap.appendChild(el);
    fields.appendChild(wrap);
  }

  const btn = card.querySelector(".mcp-card-add");
  const status = card.querySelector(".mcp-card-status");
  const missing = () => inputs.filter((i) => !values[i.key]).length;
  function sync() {
    const n = missing();
    btn.disabled = n > 0;
    btn.textContent = already
      ? (t("mcp_card_readd") || "Ajouter à nouveau")
      : (t("mcp_add") || "Ajouter");
    btn.title = n > 0 ? (t("mcp_card_fill") || "Renseignez les champs ci-dessus") : "";
  }
  sync();

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    status.textContent = "";
    status.classList.remove("err");
    try {
      // Substitution des gabarits : c'est ici que « {{folder}} » devient un
      // vrai chemin. Les entrées « env » partent dans l'environnement du
      // processus, jamais dans les arguments (elles seraient visibles au ps).
      const env = {};
      const headers = {};
      const fill = (text) => String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? "");
      const args = (entry.args || []).map(fill);
      // Certains services (Make) mettent le jeton DANS l'URL : le gabarit porte
      // alors sur l'adresse elle-même.
      const url = fill(entry.url || "");
      for (const input of inputs) {
        if (input.target === "env") env[input.key] = values[input.key] || "";
        // Les serveurs distants s'authentifient par en-tête : le jeton n'a
        // aucune raison de traîner dans des arguments de ligne de commande.
        // `prefix` porte le schéma attendu (« Bearer »), qu'on n'exige pas de
        // l'utilisateur — il colle son jeton, rien d'autre.
        else if (input.target === "header") headers[input.key] = (input.prefix || "") + (values[input.key] || "");
      }
      await invoke("mcp_save_server", {
        server: {
          id: "", name: pick(entry, "name"), transport: entry.transport,
          command: entry.command || "", args, env,
          url, headers, enabled: false, expose_in_bar: true,
          disabled_tools: [], auto_approve: [],
          description: pick(entry, "description"), created: 0,
        },
      });
      mcpStatus(t("mcp_added", { name: pick(entry, "name") }));
      await refreshMcpServers();
      await refreshMcpCatalog();
    } catch (e) {
      status.textContent = String(e?.message || e);
      status.classList.add("err");
      btn.disabled = false;
    }
  });
  return card;
}

async function addMcpServerManually() {
  const name = $("input-mcp-name")?.value.trim() || "";
  const transport = $("select-mcp-transport")?.value || "stdio";
  const raw = $("input-mcp-command")?.value.trim() || "";
  const url = $("input-mcp-url")?.value.trim() || "";
  const secret = $("input-mcp-secret")?.value.trim() || "";
  const parts = raw.split(/\s+/).filter(Boolean);
  const env = {};
  if (secret.includes("=")) {
    const [key, ...rest] = secret.split("=");
    env[key.trim()] = rest.join("=").trim();
  }
  try {
    await invoke("mcp_save_server", {
      server: {
        id: "", name, transport,
        command: parts[0] || "", args: parts.slice(1), env,
        url, headers: {}, enabled: false, expose_in_bar: true,
        disabled_tools: [], auto_approve: [], description: "", created: 0,
      },
    });
    ["input-mcp-name", "input-mcp-command", "input-mcp-url", "input-mcp-secret"].forEach((id) => {
      const el = $(id);
      if (el) el.value = "";
    });
    mcpStatus(t("mcp_added", { name }));
    await refreshMcpServers();
  } catch (e) {
    mcpStatus(String(e?.message || e), true);
  }
}

// Import d'une configuration `mcpServers` — le format des autres clients MCP,
// celui qu'on trouve tel quel dans les annuaires (mcpservers.org) et dans les
// docs des éditeurs. Coller le bloc évite de retranscrire une URL à la main,
// avec la faute de frappe qui va avec.
//
// Deux garde-fous, volontairement stricts :
//   * tout est ajouté DÉSACTIVÉ — un bloc collé depuis le web ne doit pas
//     obtenir d'outils actifs avant que l'utilisateur ait regardé ;
//   * une entrée `stdio` porte une commande qui SERA lancée sur la machine :
//     elle est acceptée (c'est le format), mais annoncée comme telle.
function parseMcpServersJson(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(t("mcp_import_bad_json") || "JSON illisible."); }
  // On accepte l'enveloppe complète comme le seul objet des serveurs.
  const servers = doc?.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : doc;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(t("mcp_import_no_servers") || "Aucun bloc « mcpServers » trouvé.");
  }
  const out = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    const url = String(raw.url || "").trim();
    const command = String(raw.command || "").trim();
    // `type` est déclaratif et parfois absent : c'est la présence d'une URL qui
    // tranche réellement entre distant et local.
    const transport = url ? "http" : "stdio";
    if (transport === "http" && !/^https?:\/\//i.test(url)) continue;
    if (transport === "stdio" && !command) continue;
    const headers = {};
    for (const [k, v] of Object.entries(raw.headers || {})) headers[String(k)] = String(v);
    const env = {};
    for (const [k, v] of Object.entries(raw.env || {})) env[String(k)] = String(v);
    out.push({
      id: "", name: String(name).slice(0, 60), transport,
      command, args: (Array.isArray(raw.args) ? raw.args : []).map(String),
      env, url, headers, enabled: false, expose_in_bar: true,
      disabled_tools: [], auto_approve: [],
      description: String(raw.description || ""), created: 0,
    });
  }
  if (!out.length) throw new Error(t("mcp_import_empty") || "Aucun serveur exploitable dans ce JSON.");
  return out;
}

async function importMcpServersJson() {
  const box = $("input-mcp-json");
  const status = $("mcp-import-status");
  const say = (msg, err = false) => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle("err", err);
  };
  let servers;
  try { servers = parseMcpServersJson(box?.value || ""); }
  catch (e) { return say(String(e?.message || e), true); }
  const local = servers.filter((s) => s.transport === "stdio").length;
  let added = 0;
  for (const server of servers) {
    try { await invoke("mcp_save_server", { server }); added += 1; }
    catch (e) { say(String(e?.message || e), true); }
  }
  if (!added) return;
  if (box) box.value = "";
  say(t("mcp_import_ok", { n: added }) || `${added} connecteur(s) ajouté(s), désactivé(s).`
    + (local ? " " + (t("mcp_import_local_warn") || "Attention : certains lancent une commande sur votre machine.") : ""));
  await refreshMcpServers();
  await refreshMcpCatalog();
}

function updateMcpTransportFields() {
  const http = ($("select-mcp-transport")?.value || "stdio") === "http";
  if ($("mcp-stdio-fields")) $("mcp-stdio-fields").style.display = http ? "none" : "";
  if ($("mcp-http-fields")) $("mcp-http-fields").style.display = http ? "" : "none";
}

// État du moteur vocal : livré avec Lumen (Linux/Windows) ou installable en un
// clic (macOS). Tant qu'il manque, le mode « auto » parle avec la voix système,
// donc l'utilisateur n'est jamais muet — on le lui dit explicitement.
let ttsInstallListener = false;

async function refreshTtsEngineStatus() {
  const state = $("tts-engine-state");
  const btn = $("btn-tts-install");
  if (!state) return null;
  let status = null;
  try { status = await invoke("tts_engine_status"); } catch { status = null; }
  if (!status) { state.textContent = ""; if (btn) btn.hidden = true; return null; }

  if (status.engine_ready) {
    state.textContent = status.bundled
      ? t("tts_engine_bundled")
      : t("tts_engine_installed");
  } else {
    state.textContent = status.installable ? t("tts_engine_missing") : t("tts_engine_unavailable");
  }
  if (!status.engine_ready && status.voices_installed === 0) {
    state.textContent += " " + t("tts_engine_fallback");
  }
  if (btn) btn.hidden = !(status.installable && !status.engine_ready);
  return status;
}

const TTS_INSTALL_STEPS = { venv: 25, download: 60, verify: 90, done: 100 };

function initTtsInstallEvents() {
  if (ttsInstallListener || !tauriEvent?.listen) return;
  ttsInstallListener = true;
  tauriEvent.listen("tts-install-progress", (event) => {
    const step = event?.payload?.step || "";
    const wrap = $("tts-install-progress");
    if (wrap) {
      wrap.hidden = false;
      wrap.firstElementChild.style.width = `${TTS_INSTALL_STEPS[step] || 0}%`;
    }
    ttsStatus(t(`tts_install_${step}`));
  });
}

async function installTtsRuntime() {
  const btn = $("btn-tts-install");
  if (btn) btn.disabled = true;
  initTtsInstallEvents();
  try {
    await invoke("tts_install_runtime");
    ttsStatus(t("tts_install_done"));
  } catch (e) {
    ttsStatus(t("tts_install_failed", { err: e?.message || e }));
  }
  const wrap = $("tts-install-progress");
  if (wrap) wrap.hidden = true;
  if (btn) btn.disabled = false;
  await refreshTtsUI();
}

let ttsPicker = null;
async function refreshTtsUI() {
  await refreshTtsEngineStatus();
  if (!ttsLocalAvailable()) return;
  let catalog = [];
  let active = "";
  try {
    [catalog, active] = await Promise.all([
      invoke("tts_catalog"),
      invoke("tts_active_voice").catch(() => ""),
    ]);
  } catch (e) { console.error("Catalogue TTS indisponible :", e); catalog = []; }

  const sel = $("select-tts-voice");
  if (sel) {
    const installed = catalog.filter((v) => v.installed);
    sel.innerHTML = installed.length
      ? installed.map((v) => `<option value="${escapeHTML(v.id)}">${escapeHTML(v.label)}</option>`).join("")
      : `<option value="">${t("tts_none_installed")}</option>`;
    if (active && installed.some((v) => v.id === active)) sel.value = active;
    refreshTtsTuning(sel.value || "");
  }

  // Catalogue de voix : même liste compacte filtrable que les modèles, pour ne
  // pas transformer l'onglet en page à défilement infini quand le catalogue
  // grandit (Piper + Kokoro, plusieurs langues).
  const list = $("tts-catalog");
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
        maxHeight: "232px",
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
  await refreshLocalTtsRuntime();
}

/// Sélectionne `value` dans une liste ; une valeur saisie autrefois à la main
/// et absente des choix est ajoutée telle quelle plutôt que perdue.
function setSelectKeeping(id, value) {
  const el = $(id);
  if (!el || value == null || value === "") return;
  if (![...el.options].some((o) => o.value === value)) el.appendChild(new Option(value, value));
  el.value = value;
}

// Modèle rapide / de renfort de la réponse orchestrée : choisis parmi les
// modèles du moteur courant (Ollama installés, ou ceux de l'API) au lieu d'un
// nom tapé à la main. Seuls Ollama et les API changent de modèle à la volée ;
// ailleurs, les listes sont grisées.
const orchestratePending = { fast: null, strong: null };
function refreshOrchestrateModelSelects(saved = {}) {
  if ("fast" in saved) orchestratePending.fast = saved.fast;
  if ("strong" in saved) orchestratePending.strong = saved.strong;
  const source = $("select-ai-source")?.value || val("aiSource", "");
  const names = source === "ollama"
    ? [...($("select-model")?.options || [])].map((o) => o.value)
    : ["api", "lumen"].includes(source)
      ? [...($(source === "lumen" ? "lumen-model-list" : "api-model-list")?.options || [])].map((o) => o.value)
      : [];
  const usable = ["ollama", "api", "lumen"].includes(source);
  for (const [key, id] of [["fast", "input-orchestrate-fast"], ["strong", "input-orchestrate-strong"]]) {
    const el = $(id);
    if (!el) continue;
    const current = orchestratePending[key] ?? el.value ?? "";
    el.replaceChildren(new Option(t(usable ? "opt_orchestrate_main" : "opt_orchestrate_unavailable"), ""));
    for (const n of [...new Set(names.filter(Boolean))]) el.appendChild(new Option(n, n));
    if (current && ![...el.options].some((o) => o.value === current)) el.appendChild(new Option(current, current));
    el.value = usable ? current : "";
    el.disabled = !usable;
    orchestratePending[key] = null;
  }
}

function setField(id, value) {
  const el = $(id);
  if (!el) return;
  if (el.type === "checkbox") el.checked = Boolean(value);
  else el.value = value ?? "";
}

function readOrbColors() {
  return [0, 1, 2, 3, 4].map((i) => $(`orb-color-${i}`)?.value || defaults.orbColors[i]);
}

let robotPreview = null;
function collectRobotOptions() {
  return normalizeRobotOptions({
    shape: $('select-robot-shape')?.value,
    color: $('robot-color')?.value, trimColor: $('robot-trimColor')?.value, screenColor: $('robot-screenColor')?.value,
    speed: $('slider-robot-speed')?.value,
    paused: $('robot-paused')?.checked, antenna: $('robot-antenna')?.checked,
    floorShadow: $('robot-floorShadow')?.checked, interactive: $('robot-interactive')?.checked,
  });
}
function loadRobotOptions(value) {
  const options = normalizeRobotOptions(value);
  setField('select-robot-shape', options.shape);
  for (const key of ['color', 'trimColor', 'screenColor', 'paused', 'antenna', 'floorShadow', 'interactive']) setField(`robot-${key}`, options[key]);
  setField('slider-robot-speed', options.speed);
  updateRobotPreview();
}
function updateRobotPreview() {
  const host = $('robot-head-preview'); if (!host) return;
  const size = Number($('slider-orb-size')?.value) || 116;
  host.style.width = `${size}px`; host.style.height = `${size}px`;
  host.dataset.state = $('select-robot-preview-state')?.value || 'idle';
  if (!robotPreview) {
    robotPreview = mountRobotHead(host);
    window.addEventListener('pagehide', () => robotPreview?.dispose(), { once: true });
  }
  robotPreview.settings(collectRobotOptions());
  robotPreview.setActive($('select-avatar-model')?.value === 'robot-head');
  if ($('label-robot-speed-val')) $('label-robot-speed-val').textContent = `${$('slider-robot-speed').value}×`;
}

function collectAvatarSettings() {
  return {
    orbEnabled: String($("checkbox-orb")?.checked ?? true),
    orbAvatarMode: $("select-avatar-model")?.value || "orb",
    robotHeadOptions: JSON.stringify(collectRobotOptions()),
    avatarGlbAmbientLight: $("slider-avatar-glb-light")?.value || "100",
    orbTheme: $("select-orb-theme")?.value || "default",
    orbSize: $("slider-orb-size")?.value || "116",
    orbCoreScale: $("slider-orb-core")?.value || "82",
    orbPulse: $("slider-orb-pulse")?.value || "100",
    orbMouth: String($("checkbox-orb-mouth")?.checked ?? false),
    orbMoods: String($("checkbox-orb-moods")?.checked ?? true),
    uiSounds: String($("checkbox-ui-sounds")?.checked ?? true),
    orbGlassType: $("select-orb-glass")?.value || "thin",
    orbColors: JSON.stringify(readOrbColors()),
    orbHeartbeat: String($("checkbox-orb-heartbeat")?.checked ?? true),
    orbHeartColor: $("orb-heart-color")?.value || "#ff4d6d",
    orbPulseStrength: $("slider-orb-pulse-strength")?.value || "100",
    orbPulseSpeed: $("slider-orb-pulse-speed")?.value || "100",
  };
}

function emitSettingsDraft(payload) {
  try { tauriEvent?.emit?.("settings-draft", payload); } catch {}
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Lecture du fichier impossible."));
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.readAsDataURL(file);
  });
}

function setAvatarGlbStatus(message, state = "") {
  const status = $("avatar-glb-status");
  if (!status) return;
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function updateAvatarModelUI() {
  const robot = $('select-avatar-model')?.value === 'robot-head';
  if ($('robot-head-settings')) $('robot-head-settings').hidden = !robot;
  updateRobotPreview();
  const row = $('avatar-model-row');
  row?.querySelectorAll('.avatar-glb-actions, .setting-hint, .avatar-glb-status').forEach(el => { el.hidden = robot; });
  const custom = $("select-avatar-model")?.value === "custom";
  if ($("avatar-glb-light-row")) $("avatar-glb-light-row").style.display = custom ? "" : "none";
}

async function refreshCustomAvatarStatus() {
  try {
    const info = await invoke("avatar_glb_status");
    if (!info) {
      setAvatarGlbStatus(t("avatar_glb_none"));
      return null;
    }
    const sizeMb = (Number(info.size || 0) / 1048576).toFixed(1);
    setAvatarGlbStatus(t("avatar_glb_ready", { name: info.name, size: sizeMb }), "ok");
    return info;
  } catch (error) {
    setAvatarGlbStatus(String(error), "error");
    return null;
  }
}

function initCustomAvatarUI() {
  const input = $("avatar-glb-file");
  const pick = $("btn-avatar-glb-import");
  const remove = $("btn-avatar-glb-remove");
  if (!input || !pick) return;
  refreshCustomAvatarStatus();
  pick.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    pick.disabled = true;
    setAvatarGlbStatus(t("avatar_glb_checking"));
    try {
      const data = await readFileAsBase64(file);
      const info = await invoke("avatar_glb_import", { name: file.name, data });
      setField("select-avatar-model", "custom");
      updateAvatarModelUI();
      emitSettingsDraft({ ...collectAvatarSettings(), avatarGlbReload: "true" });
      const sizeMb = (Number(info.size || file.size) / 1048576).toFixed(1);
      setAvatarGlbStatus(t("avatar_glb_ready", { name: info.name || file.name, size: sizeMb }), "ok");
    } catch (error) {
      setAvatarGlbStatus(t("avatar_glb_invalid", { error: error?.message || String(error) }), "error");
    } finally {
      pick.disabled = false;
    }
  });
  remove?.addEventListener("click", async () => {
    try {
      await invoke("avatar_glb_delete");
      setField("select-avatar-model", "orb");
      updateAvatarModelUI();
      emitSettingsDraft(collectAvatarSettings());
      setAvatarGlbStatus(t("avatar_glb_none"));
    } catch (error) {
      setAvatarGlbStatus(String(error), "error");
    }
  });
}


/*
 * Le thème « Interface » n'existe plus en tant que réglage séparé.
 *
 * Cette fenêtre posait elle-même `data-dt-theme` et gérait sa propre notion de
 * « rien n'a jamais été choisi », en double de lib/theme-init.js — deux
 * réponses possibles à la même question, donc un clignotement au chargement
 * quand elles divergeaient. C'est désormais l'amorçage qui pose l'attribut,
 * pour cette fenêtre comme pour toutes les autres, et `lib/theme.js` qui écrit.
 */

/**
 * Habillage métal et thèmes d'avatar : nés avec l'édition Pro, ouverts à
 * toutes les éditions depuis le 15/09/2026. La rangée est toujours visible ;
 * seule la valeur par défaut dépend de l'édition (or pour une Pro).
 *
 * Cette fenêtre a sa PROPRE copie du sélecteur de thèmes — distincte de celle
 * de la barre. Les deux listes doivent rester alignées : c'est ici que
 * l'utilisateur vient les chercher.
 */
function updateCharacterControls() {
  const select = $("select-orb-theme");
  if (!select) return;
  const id = characterId(select.value);
  const original = id === 'default';
  for (const key of ['orb-glass-row', 'orb-colors-row', 'orb-core-scale-row']) { const row = $(key); if (row) row.hidden = !original; }
  for (const key of ['checkbox-orb-mouth', 'orb-heart-color']) { const input = $(key); if (input?.closest('.setting-item')) input.closest('.setting-item').hidden = !original; }
  const preset = ORB_CHARACTERS[id];
  if ($('orb-character-hint')) $('orb-character-hint').textContent = document.documentElement.lang === 'en' ? preset.enDescription : preset.description;
}
function populateCharacterOptions() {
  const select = $('select-orb-theme'); if (!select) return;
  select.replaceChildren(...Object.entries(ORB_CHARACTERS).map(([id, preset]) => { const option = document.createElement('option'); option.value = id; option.textContent = document.documentElement.lang === 'en' ? preset.en : preset.name; return option; }));
}

function syncProFlavorRow() {
  const row = $("pro-flavor-row");
  const select = $("select-pro-flavor");
  const themes = $("select-orb-theme");
  if (row) row.hidden = false;
  if (select) select.value = proFlavor();
  themes?.querySelectorAll("option[data-pro]").forEach((opt) => { opt.hidden = false; opt.disabled = false; });
  whenProResolved(() => { if (select) select.value = proFlavor(); });
}

function collectImmediateSettings() {
  return {
    alwaysOnTop: String(alwaysOnTopSettingValue()),
    glassOpacity: String((Number.parseInt($("slider-transparency")?.value || "4", 10) || 4) / 100),
    barSize: $("select-bar-size")?.value || defaults.barSize,
    barOpaque: String($("checkbox-bar-opaque")?.checked ?? barOpaqueDefault()),
    lumenPerfMode: String($("checkbox-perf-mode")?.checked || false),
    morningView: String($("checkbox-morning")?.checked ?? true),
    startupLumenOS: String($("checkbox-startup-lumen-os")?.checked || false),
    halo: String($("checkbox-halo")?.checked || false),
    haloPosition: $("select-halo-position")?.value || "center",
    haloStyle: $("select-halo-style")?.value || "float",
    haloRest: $("select-halo-rest")?.value || "peek",
    haloHold: $("slider-halo-hold")?.value || "15",
    haloAgents: String($("checkbox-halo-agents")?.checked ?? true),
    haloClock: String($("checkbox-halo-clock")?.checked ?? true),
    haloSticky: String($("checkbox-halo-sticky")?.checked || false),
    // La barre de chat ne sait pas ce qu'est « automatique » : on lui transmet
    // le thème résolu, pas la préférence. Lui passer « auto » la faisait
    // retomber sur son défaut sombre, à contre-sens du réglage choisi.
    themePreference: themeForBar(),
  };
}

/** Valeur clair/sombre à transmettre aux surfaces qui ignorent « automatique ». */
function themeForBar() {
  const choice = $("select-theme")?.value || themePreference();
  return choice === "auto" ? resolvedTheme() : choice;
}

// Met à jour le placeholder du champ « Clé API » avec l'aperçu masqué fourni par
// le backend (jamais la clé en clair). N'écrit pas dans le champ : un champ vide
// = « inchangée ».
async function refreshApiKeyStatus() {
  const el = $("input-api-key");
  if (!el) return;
  try {
    const st = await invoke("llm_secret_status");
    if (st && st.configured) {
      el.placeholder = `Clé enregistrée (${st.hint}) — laisser vide pour conserver`;
      el.dataset.configured = "true";
    } else {
      el.placeholder = "sk-…";
      el.dataset.configured = "false";
    }
  } catch { /* non bloquant */ }
}

// Migration ponctuelle : si une ancienne clé traîne en localStorage (en clair),
// on la pousse vers le backend (0600) puis on l'efface, et on rafraîchit l'état.
async function migrateAndRefreshApiKey() {
  try {
    const legacy = (localStorage.getItem("apiKey") || "").trim();
    if (legacy) {
      await invoke("set_ollama_config", {
        url: val("ollamaUrl", defaults.ollamaUrl),
        model: val("selectedModel", ""),
        backend: rustBackend(val("aiSource", "shortcut")),
        apiBase: val("apiBaseUrl", defaults.apiBaseUrl),
        apiKey: legacy,
        apiModel: cloudModelFor(val("aiSource", "shortcut")),
        language: localStorage.getItem("lang") || "fr",
      });
      localStorage.removeItem("apiKey");
    }
  } catch { /* non bloquant */ }
  await refreshApiKeyStatus();
}

function collectWorkspaceSettings() {
  // L'accent n'est plus un réglage de bureau : il vient de l'apparence
  // (`uiAccent`), appliquée partout par lib/ui-customizer.js. Le thème non plus
  // n'est plus propre au bureau : c'est LE thème de Lumen.
  return { dtTheme: $("select-theme")?.value || "auto" };
}

function loadSettings() {
  document.body.classList.toggle("embedded-workspace", embeddedInWorkspace);
  if ($("workspace-settings")) $("workspace-settings").hidden = !embeddedInWorkspace;
  setField("select-language", getLang());
  // « auto » est une valeur de stockage, pas une option du menu : elle s'y
  // lit comme « Automatique (système) », dont la valeur est vide.
  // Un seul sélecteur, sur la préférence unifiée. `themePreference()` couvre la
  // migration depuis les deux anciennes clés (`dtTheme`, `themePreference`).
  setField("select-theme", themePreference());
  setField("checkbox-orchestrate", val("orchestrateChat", "false") === "true");
  refreshOrchestrateModelSelects({ fast: val("orchestratorFastModel", "") });
  setField("checkbox-llm-hybrid", val("llmHybrid", "false") === "true");
  syncHybridCard();
  refreshOrchestrateModelSelects({ strong: strongBackendFor(llmBackend())?.model || "" });
  const savedAiSource = val("aiSource", "shortcut");
  setField("select-ai-source", platformWithoutAppleShortcuts() && savedAiSource === "shortcut" ? "ollama" : savedAiSource);
  // SÉCURITÉ : on ne recharge JAMAIS la clé en clair dans le champ. On affiche
  // un aperçu masqué (placeholder) reflétant l'état backend, et on migre une
  // éventuelle ancienne valeur localStorage vers le backend.
  if ($("input-api-key")) $("input-api-key").value = "";
  migrateAndRefreshApiKey();
  setField("input-api-base", val("apiBaseUrl", defaults.apiBaseUrl));
  setField("input-api-model", val("apiModel", defaults.apiModel));
  setField("input-lumen-model", val("lumenModel", ""));
  refreshLumenServerOption();
  setField("select-applefm-model", val("applefmModel", APPLEFM_DEFAULT_MODEL));
  refreshAppleFmOption();
  setField("select-image-provider", val("imageProvider", defaults.imageProvider));
  refreshImagePlaygroundOption();
  // Les modèles d'image sont dans un sélecteur unique, repeuplé par moteur.
  renderImageModels();
  setField("input-bonsai-url", val("bonsaiUrl", ""));
  toggleImageProviderSettings();
  setField("input-system-prompt", val("systemPrompt"));
  setField("input-ollama-url", val("ollamaUrl", defaults.ollamaUrl));
  setField("checkbox-ollama-think", bool("ollamaThink"));
  setField("slider-ollama-num-ctx", ctxIndexFromValue(num("ollamaNumCtx", 0)));
  // Compatibilité : avant le réglage dédié llama-server, la taille était
  // enregistrée dans ollamaNumCtx. On la reprend automatiquement une première
  // fois pour éviter de réinitialiser un choix utilisateur à 8192.
  setField("select-llama-num-ctx", val("llamaNumCtx", val("ollamaNumCtx", "8192")));
  setSelectKeeping("input-ollama-keep-alive", val("ollamaKeepAlive", "5m"));
  setField("input-shortcut-name", val("shortcutName", defaults.shortcutName));
  setField("input-action-router", val("actionRouter", defaults.actionRouter));
  setField("select-speech-backend", val("speechBackend", defaults.speechBackend));
  setField("input-speak-shortcut", val("speakShortcut", defaults.speakShortcut));
  setField("input-dictate-shortcut", val("dictateShortcut", defaults.dictateShortcut));
  initWhisperUI();
  initVoiceControlUI();
  updateVoiceDictationModeUI();
  setField("slider-transparency", Math.round(Number.parseFloat(val("glassOpacity", "0.04")) * 100));
  setField("select-bar-size", val("barSize", defaults.barSize));
  setField("checkbox-bar-opaque", bool("barOpaque", barOpaqueDefault()));
  setField("checkbox-perf-mode", bool("lumenPerfMode", false));
  setField("checkbox-morning", bool("morningView", true));
  setField("checkbox-startup-lumen-os", bool("startupLumenOS"));
  setField("checkbox-always-on-top", bool("alwaysOnTop", true));
  setField("checkbox-halo", bool("halo"));
  setField("select-halo-position", val("haloPosition", "center"));
  setField("select-halo-style", val("haloStyle", "float"));
  setField("select-halo-rest", val("haloRest", "peek"));
  setField("slider-halo-hold", num("haloHold", 15));
  setField("checkbox-halo-agents", bool("haloAgents", true));
  setField("checkbox-halo-clock", bool("haloClock", true));
  setField("checkbox-halo-sticky", bool("haloSticky"));
  setField("checkbox-debug", bool("debugMode"));
  setField("checkbox-heartbeat", bool("heartbeatEnabled"));
  setField("input-heartbeat-shortcut", val("heartbeatShortcut", "Heartbeat"));
  // Défaut « fluxo » sauf si un ancien poste Mac tournait déjà sur la source
  // Apple : là le raccourci était le moteur implicite, on ne le lui retire pas.
  setField("select-heartbeat-engine", val("heartbeatEngine", val("aiSource") === "shortcut" ? "shortcut" : "fluxo"));
  syncHeartbeatEngineRows();
  setField("input-heartbeat-input", val("heartbeatInput"));
  setField("input-heartbeat-cron", val("heartbeatCron", "0 */10 * * * *"));
  setField("checkbox-orb", bool("orbEnabled", true));
  setField("select-avatar-model", val("orbAvatarMode", "orb"));
  setField("slider-avatar-glb-light", num("avatarGlbAmbientLight", 1));
  loadRobotOptions(val('robotHeadOptions', '{}'));
  updateAvatarModelUI();
  populateCharacterOptions();
  setField("select-orb-theme", characterId(val("orbTheme", "default")));
  updateCharacterControls();
  syncProFlavorRow();
  setField("slider-orb-size", num("orbSize", 116));
  updateRobotPreview();
  setField("slider-orb-core", num("orbCoreScale", 82));
  setField("slider-orb-pulse", num("orbPulse", 100));
  setField("checkbox-orb-mouth", bool("orbMouth", false));
  setField("checkbox-orb-moods", bool("orbMoods", true));
  setField("checkbox-ui-sounds", bool("uiSounds", true));
  setField("select-orb-glass", val("orbGlassType", "thin"));
  setField("checkbox-orb-heartbeat", bool("orbHeartbeat", true));
  setField("orb-heart-color", val("orbHeartColor", "#ff4d6d"));
  setField("slider-orb-pulse-strength", num("orbPulseStrength", 100));
  setField("slider-orb-pulse-speed", num("orbPulseSpeed", 100));

  let colors = defaults.orbColors;
  try {
    const parsed = JSON.parse(localStorage.getItem("orbColors") || "null");
    if (Array.isArray(parsed) && parsed.length === 5) colors = parsed;
  } catch {}
  colors.forEach((color, i) => setField(`orb-color-${i}`, color));

  const freq = val("heartbeatFrequency", "0 0 * * * *");
  const freqSelect = $("select-heartbeat-frequency");
  if (freqSelect && Array.from(freqSelect.options).some((o) => o.value === freq)) {
    freqSelect.value = freq;
    $("heartbeat-cron-row").style.display = "none";
  } else if (freqSelect) {
    freqSelect.value = "custom";
    setField("input-heartbeat-cron", freq);
    $("heartbeat-cron-row").style.display = "block";
  }

  updateLabels();
  toggleSourceGroups();
  populateModels();
  initLlamaProgressEvents();
  populateLlamaModels();
  refreshLlamaBackendUI().catch(() => {});
  refreshLitertUI().catch(() => {});
  initOllamaPullEvents();
  refreshOllamaCatalog().catch(() => {});
  loadHardware().then((hw) => { renderLlamaCatalog().catch(() => {}); mountAiLevelCard(hw); });
}

// ===== Niveau d'IA (Léger / Équilibré / Puissant) =====
let aiLevelCard = null;
function mountAiLevelCard(hw) {
  const root = $("ai-level-card");
  if (!root) return;
  const current = $("select-model-llama")?.value || val("selectedModel", "");
  if (aiLevelCard) { aiLevelCard.setCurrent(current); return; }
  aiLevelCard = mountAiLevel(root, {
    t, invoke, listen: window.__TAURI__?.event?.listen, hwTier: hw?.tier, current,
    onApply: async (_tier, model, ctx) => {
      await populateLlamaModels();
      setField("select-model-llama", model.filename);
      setField("select-llama-num-ctx", String(ctx));
      localStorage.setItem("selectedModel", model.filename);
      localStorage.setItem("llamaNumCtx", String(ctx));
      await saveSettings();
      await invoke("llama_start", { filename: model.filename, ctxSize: ctx });
    },
  });
  $("select-model-llama")?.addEventListener("change", (e) => aiLevelCard?.setCurrent(e.target.value));
}

// Paliers de taille de contexte Ollama (en tokens) ; index 0 = défaut du modèle.
// Paliers du curseur « taille du contexte » d'Ollama. 0 = défaut du modèle.
// Les trois derniers paliers (64K/128K/256K) ne valent que pour les modèles
// entraînés pour, et demandent beaucoup de mémoire : c'est le rôle du hint.
// Plafond de la fenêtre llama.cpp, aligné sur le `clamp` de `llama.rs` : une
// valeur plus haute ici serait silencieusement rabotée côté serveur.
const LLAMA_CTX_MAX = 262144;
const CTX_VALUES = [0, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
function ctxIndexFromValue(v) {
  const val = Number.parseInt(v, 10) || 0;
  if (val <= 0) return 0;
  let best = 0, bestDiff = Infinity;
  CTX_VALUES.forEach((c, i) => { const d = Math.abs(c - val); if (d < bestDiff) { bestDiff = d; best = i; } });
  return best;
}
function ctxLabel(idx) {
  const v = CTX_VALUES[idx] || 0;
  return v === 0 ? (t("ctx_model_default") || "Défaut du modèle") : `${v.toLocaleString()} tokens`;
}

function updateLabels() {
  const ctx = $("slider-ollama-num-ctx");
  if (ctx && $("label-ollama-num-ctx-val")) $("label-ollama-num-ctx-val").textContent = ctxLabel(Number.parseInt(ctx.value, 10) || 0);
  const map = [
    ["slider-transparency", "label-transparency-val", "%"],
    ["slider-halo-hold", "label-halo-hold", " s"],
    ["slider-avatar-glb-light", "label-avatar-glb-light-val", "×"],
    ["slider-orb-size", "label-orb-size-val", ""],
    ["slider-orb-core", "label-orb-core-val", ""],
    ["slider-orb-pulse", "label-orb-pulse-val", ""],
    ["slider-orb-pulse-strength", "label-orb-pulse-strength-val", ""],
    ["slider-orb-pulse-speed", "label-orb-pulse-speed-val", ""],
  ];
  map.forEach(([input, label, suffix]) => {
    if ($(input) && $(label)) $(label).textContent = `${$(input).value}${suffix}`;
  });
}

function toggleSourceGroups() {
  const source = $("select-ai-source")?.value || "shortcut";
  // Source « API » : les fournisseurs (clé + modèles) remplacent l'ancien
  // formulaire, qui reste dans le DOM (masqué) pour l'enregistrement général.
  if ($("settings-group-api")) $("settings-group-api").style.display = "none";
  if ($("settings-group-providers")) $("settings-group-providers").style.display = source === "api" ? "block" : "none";
  if (source === "api") renderApiProviders();
  if ($("settings-group-lumen")) $("settings-group-lumen").style.display = source === "lumen" ? "block" : "none";
  if ($("settings-group-cloud")) $("settings-group-cloud").style.display = source === "lumen" ? "block" : "none";
  if ($("api-profile-name-row")) $("api-profile-name-row").hidden = source !== "api";
  if ($("api-preset-row")) $("api-preset-row").hidden = source !== "api";
  if ($("settings-group-applefm")) $("settings-group-applefm").style.display = source === "applefm" ? "block" : "none";
  if ($("settings-group-ollama")) $("settings-group-ollama").style.display = source === "ollama" ? "block" : "none";
  if ($("settings-group-llama")) $("settings-group-llama").style.display = source === "llama" ? "block" : "none";
  if ($("settings-group-litert")) $("settings-group-litert").style.display = source === "litert" ? "block" : "none";
  if ($("settings-group-shortcut")) $("settings-group-shortcut").style.display = !platformWithoutAppleShortcuts() && source === "shortcut" ? "block" : "none";
}

async function handleAiSourceChange() {
  refreshOrchestrateModelSelects();
  const source = $("select-ai-source")?.value || "shortcut";
  toggleSourceGroups();
  // La liste llama.cpp est locale et n'est pas chargée par `populateModels()`
  // (qui ne concerne qu'Ollama). La rafraîchir au moment où le groupe devient
  // visible évite d'afficher une liste obsolète ou vide.
  if (source === "llama") {
    await populateLlamaModels().catch(() => {});
    await refreshLlamaBackendUI().catch(() => {});
  }
  if (source === "litert") await refreshLitertUI().catch(() => {});
  if (source === "applefm") await refreshAppleFmOption(true).catch(() => {});
  if (source === "api" || source === "lumen") await refreshApiProfiles().catch(() => {});
  // Chaque backend a ses modèles : on présélectionne celui qu'on y avait laissé
  // (ou le premier de sa liste), au lieu de laisser affiché le modèle de la
  // source qu'on vient de quitter.
  const select = source === "llama" ? $("select-model-llama")
    : source === "litert" ? $("select-model-litert")
    : source === "ollama" ? $("select-model") : null;
  if (select) {
    const options = [...select.options].map((o) => o.value).filter(Boolean);
    const model = pickModelForSource(source, options);
    if (model) select.value = model;
  }
  renderModelExpectations();
}

function formatModelBytes(bytes) {
  if (!bytes) return "";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let value = Number(bytes), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

let llamaModels = [];
let llamaProgressListener = null;
let llamaPicker = null;

// Puces de filtre communes aux catalogues de modèles (GGUF et Ollama) : elles
// évitent d'imposer une liste de 20 lignes qui défile sans fin.
function modelCatalogChips({ installedLabel = t("cat_chip_installed") } = {}) {
  return [
    { id: "all", label: t("cat_chip_all") },
    { id: "installed", label: installedLabel, test: (item) => item.installed },
    { id: "fast", label: t("model_tier_fast"), test: (item) => item.tier === "fast" },
    { id: "balanced", label: t("model_tier_balanced"), test: (item) => item.tier === "balanced" },
    { id: "powerful", label: t("model_tier_powerful"), test: (item) => item.tier === "powerful" },
    { id: "vision", label: t("cat_chip_vision"), test: (item) => item.tags?.includes("vision") },
    { id: "code", label: t("cat_chip_code"), test: (item) => item.tags?.includes("code") },
    { id: "reasoning", label: t("cat_chip_reasoning"), test: (item) => item.tags?.includes("reasoning") },
    { id: "decision", label: t("cat_chip_decision"), test: (item) => item.tags?.includes("decision") },
    { id: "embedding", label: t("cat_chip_embedding"), test: (item) => item.tags?.includes("embedding") },
  ];
}

// Sections par famille (Discussion, Vision, Code, Décision…) dans les listes
// de modèles, comme sur la bibliothèque Ollama.
const modelGroupOptions = {
  groupBy: (item) => item.group,
  groupLabel: (id) => modelGroupLabel(id, getLang()),
  groupOrder: modelGroupOrder,
};

function tierLabel(tier) {
  return tier === "fast" ? t("model_tier_fast")
    : tier === "powerful" ? t("model_tier_powerful")
      : t("model_tier_balanced");
}

function setLlamaModelsStatus(message, isError = false) {
  const status = $("llama-model-status");
  if (!status) return;
  status.textContent = message || "";
  status.style.color = isError ? "var(--danger)" : "var(--text-muted)";
}

async function deleteLlamaModel(filename, label) {
  setLlamaModelsStatus(t("llama_delete_status", { model: label }));
  try {
    await invoke("llama_delete_model", { filename });
    // Évite que Lumen tente de redémarrer au prochain lancement un modèle
    // qui vient d'être supprimé.
    if (localStorage.getItem("selectedModel") === filename) {
      localStorage.removeItem("selectedModel");
      const select = $("select-model-llama");
      if (select) select.value = "";
      await invoke("llama_stop").catch(() => {});
    }
    await populateLlamaModels();
    setLlamaModelsStatus(t("llama_deleted_status", { model: label }));
    return true;
  } catch (e) {
    setLlamaModelsStatus(t("llama_delete_error", { error: e?.message || String(e) }), true);
    return false;
  }
}

/// Sélecteur de backend de calcul llama.cpp (CPU / CUDA / Vulkan).
///
/// Le réglage est affiché dès qu'il y a quelque chose à dire : soit une variante
/// accélérée est embarquée, soit un GPU répond. Le masquer parce que le binaire
/// manque était le pire des cas — la machine a bien un GPU, Lumen tourne sur le
/// processeur, et rien à l'écran n'explique pourquoi.
///
/// Deux chemins GPU coexistent : CUDA (NVIDIA) et Vulkan (AMD, Intel, et le
/// Steam Deck). Chaque option est traitée de la même façon — désactivée quand
/// son binaire n'est pas embarqué, et le statut dit laquelle sert vraiment.
async function refreshLlamaBackendUI() {
  const item = $("llama-backend-item");
  const select = $("select-llama-backend");
  const status = $("llama-backend-status");
  if (!item || !select) return;
  let info = null;
  try {
    info = await invoke("llama_backends");
  } catch {
    item.hidden = true;
    return;
  }
  const available = Array.isArray(info?.available) ? info.available : [];
  const hasCuda = available.includes("cuda");
  const hasVulkan = available.includes("vulkan");
  const cudaGpu = !!info?.gpu_detected;
  const vulkanGpu = !!info?.vulkanDetected;
  if (!hasCuda && !hasVulkan && !cudaGpu && !vulkanGpu) {
    item.hidden = true;
    return;
  }
  item.hidden = false;
  // Sans binaire, proposer l'option revient à laisser choisir quelque chose qui
  // ne pourra jamais s'appliquer : on la désactive plutôt que de la retirer,
  // pour que la raison reste lisible dans le libellé du statut.
  const option = (value) => [...select.options].find((o) => o.value === value);
  const cudaOption = option("cuda");
  if (cudaOption) cudaOption.disabled = !hasCuda;
  const vulkanOption = option("vulkan");
  if (vulkanOption) vulkanOption.disabled = !hasVulkan;
  select.value = info.selected || "auto";
  if (status) {
    const lines = [];
    let warn = false;
    if (cudaGpu) lines.push(t("llama_backend_gpu_found").replace("{gpu}", info.gpu_name || "NVIDIA"));
    if (vulkanGpu) lines.push(t("llama_backend_gpu_vulkan_found").replace("{gpu}", info.vulkanName || "Vulkan"));
    if (!cudaGpu && !vulkanGpu) lines.push(t("llama_backend_no_gpu"));
    // Le backend effectif est le seul renseignement qui répond à « est-ce que
    // ma carte sert vraiment ? ». Il manquait : l'écran affichait une carte
    // détectée alors que le serveur tournait sur le processeur.
    const using = { cuda: "llama_backend_using_cuda", vulkan: "llama_backend_using_vulkan" };
    lines.push(t(using[info.effective] || "llama_backend_using_cpu"));
    // N'expliquer que le chemin qui aurait pu servir : sur une machine AMD, le
    // détail des binaires CUDA manquants n'apporte rien.
    if (!using[info.effective]) {
      if (cudaGpu && !hasCuda) { lines.push(t("llama_backend_no_cuda_build")); warn = true; }
      else if (hasCuda && !cudaGpu) { lines.push(t("llama_backend_no_nvidia_smi")); warn = true; }
      else if (vulkanGpu && !hasVulkan) { lines.push(t("llama_backend_no_vulkan_build")); warn = true; }
      else if (hasVulkan && !vulkanGpu) { lines.push(t("llama_backend_no_vulkan_driver")); warn = true; }
    }
    status.textContent = lines.join(" · ");
    status.style.color = warn ? "var(--danger)" : "";
  }
}

// ---- Dossiers de modèles llama.cpp (principal + supplémentaires) ----------
let llamaDirs = [];
async function renderLlamaDirs(list = null) {
  const box = $("llama-dirs");
  if (!box) return;
  try { llamaDirs = list || await invoke("llama_model_dirs"); } catch { llamaDirs = []; }
  box.innerHTML = "";
  for (const d of llamaDirs) {
    const row = document.createElement("div");
    row.className = "loaded-model-row";
    const free = d.free_bytes ? ` · ${formatModelBytes(d.free_bytes)} ${t("llama_dir_free")}` : "";
    const state = d.primary ? t("llama_dir_primary") : d.available ? `${d.models} ${t("llama_dir_models")}` : t("llama_dir_missing");
    row.innerHTML = `<span class="loaded-model-name" style="${d.available ? "" : "opacity:.55"}"><strong></strong><br><small></small></span>`;
    row.querySelector("strong").textContent = d.path;
    row.querySelector("small").textContent = `${state}${d.primary ? ` · ${d.models} ${t("llama_dir_models")}` : ""}${free}`;
    const dl = document.createElement("button");
    dl.className = "loaded-stop-btn";
    dl.textContent = d.download ? `⬇ ${t("llama_dir_download_here")}` : t("llama_dir_set_download");
    dl.disabled = d.download || !d.available;
    dl.addEventListener("click", () => saveLlamaDirs(llamaDirs.filter((x) => !x.primary).map((x) => x.path), d.primary ? "" : d.path));
    row.appendChild(dl);
    if (!d.primary) {
      const rm = document.createElement("button");
      rm.className = "loaded-stop-btn";
      rm.textContent = t("llama_dir_remove");
      rm.addEventListener("click", () => {
        const rest = llamaDirs.filter((x) => !x.primary && x.path !== d.path).map((x) => x.path);
        const dlDir = llamaDirs.find((x) => x.download && !x.primary)?.path || "";
        saveLlamaDirs(rest, dlDir === d.path ? "" : dlDir);
      });
      row.appendChild(rm);
    }
    box.appendChild(row);
  }
}
async function saveLlamaDirs(extra, downloadTo) {
  const status = $("llama-dirs-status");
  try {
    const list = await invoke("llama_model_dirs_set", { extra, downloadTo });
    if (status) status.textContent = "";
    await renderLlamaDirs(list);
    populateLlamaModels();
  } catch (e) {
    if (status) status.textContent = `❌ ${e}`;
  }
}
function initLlamaDirsUI() {
  const btn = $("btn-llama-dir-add");
  if (!btn || btn.dataset.bound === "true") return;
  btn.dataset.bound = "true";
  btn.addEventListener("click", () => {
    const input = $("input-llama-dir");
    const path = (input?.value || "").trim().replace(/^file:\/\//, "");
    if (!path) return;
    const extra = [...llamaDirs.filter((x) => !x.primary).map((x) => x.path), path];
    const dlDir = llamaDirs.find((x) => x.download && !x.primary)?.path || "";
    saveLlamaDirs(extra, dlDir).then(() => { if (input) input.value = ""; });
  });
  $("btn-llama-dir-browse")?.addEventListener("click", async () => {
    const picked = await browseFolder($("input-llama-dir")?.value.trim() || "");
    if (picked && $("input-llama-dir")) $("input-llama-dir").value = picked;
  });
  renderLlamaDirs();
}

// Navigateur de dossiers (fs_browse_dirs, lecture seule) : on descend dans
// l'arborescence, on remonte, on saute au dossier personnel ou à un disque.
function browseFolder(start = "") {
  const en = getLang() === "en";
  const L = en
    ? { title: "Choose a models folder", up: "↑ Up", choose: "Choose this folder", cancel: "Cancel", empty: "No sub-folder.", gguf: "GGUF file(s) here" }
    : { title: "Choisir un dossier de modèles", up: "↑ Dossier parent", choose: "Choisir ce dossier", cancel: "Annuler", empty: "Aucun sous-dossier.", gguf: "fichier(s) GGUF ici" };
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "fsb-ov";
    ov.innerHTML = `<div class="fsb" role="dialog" aria-modal="true"><header></header><div class="fsb-bar"></div><div class="fsb-list"></div>
      <footer><small></small><button type="button" class="llama-dir-btn" data-a="no"></button><button type="button" class="llama-dir-btn primary" data-a="ok"></button></footer></div>`;
    document.body.appendChild(ov);
    ov.querySelector("header").textContent = L.title;
    ov.querySelector("[data-a=no]").textContent = L.cancel;
    ov.querySelector("[data-a=ok]").textContent = L.choose;
    let cur = null;
    const done = (v) => { ov.remove(); resolve(v); };
    const go = async (path) => {
      let r;
      try { r = await invoke("fs_browse_dirs", { path: path || null }); }
      catch (e) { ov.querySelector("footer small").textContent = `❌ ${e}`; return; }
      cur = r;
      const bar = ov.querySelector(".fsb-bar");
      bar.innerHTML = "";
      const path0 = document.createElement("div");
      path0.className = "fsb-path"; path0.textContent = r.path; path0.title = r.path;
      bar.appendChild(path0);
      if (r.parent) { const up = document.createElement("button"); up.type = "button"; up.textContent = L.up; up.onclick = () => go(r.parent); bar.appendChild(up); }
      for (const root of r.roots || []) { const b = document.createElement("button"); b.type = "button"; b.textContent = `💾 ${root.name}`; b.onclick = () => go(root.path); bar.appendChild(b); }
      const list = ov.querySelector(".fsb-list");
      list.innerHTML = r.dirs.length ? "" : `<div class="fsb-empty">${L.empty}</div>`;
      for (const d of r.dirs) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "fsb-row";
        b.textContent = `📁 ${d.name}`;
        b.onclick = () => go(d.path);
        list.appendChild(b);
      }
      ov.querySelector("footer small").textContent = r.gguf ? `${r.gguf} ${L.gguf}` : "";
    };
    ov.addEventListener("click", (e) => {
      if (e.target === ov) return done(null);
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "no") done(null);
      if (a === "ok" && cur) done(cur.path);
    });
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
    go(start);
  });
}

async function populateLlamaModels() {
  initLlamaDirsUI();
  const select = $("select-model-llama");
  const list = $("llama-models-list");
  if (!select && !list) return;
  try {
    llamaModels = await invoke("llama_list_models");
    if (!Array.isArray(llamaModels)) llamaModels = [];
  } catch { llamaModels = []; }
  const selected = modelVal();
  if (select) {
    select.innerHTML = llamaModels.length
      ? llamaModels.map((m) => `<option value="${escapeHTML(m.filename)}">${escapeHTML(llamaModelLabel(m.filename))} — ${formatModelBytes(m.size)}</option>`).join("")
      : `<option value="">${escapeHTML(t("opt_no_llama_models"))}</option>`;
    if (llamaModels.some((m) => m.filename === selected)) select.value = selected;
    else if (llamaModels[0]) select.value = llamaModels[0].filename;
  }
  renderLlamaCatalog().catch(() => {});
  if (list) {
    const dir = $("llama-models-dir");
    if (dir && llamaModels[0]?.path) dir.textContent = llamaModels[0].path.replace(/[\\/][^\\/]+$/, "");
    list.innerHTML = llamaModels.length ? "" : `<div class="loaded-empty">${escapeHTML(t("llama_no_downloaded"))}</div>`;
    for (const model of llamaModels) {
      const row = document.createElement("div");
      row.className = "loaded-model-row";
      const label = llamaCatalogEntry(model.filename)?.label || model.filename;
      row.innerHTML = `<span class="loaded-model-name">${escapeHTML(label)} · ${formatModelBytes(model.size)}</span>`;
      const del = document.createElement("button");
      del.className = "loaded-stop-btn";
      del.textContent = t("llama_delete");
      del.addEventListener("click", async () => {
        del.disabled = true;
        del.textContent = t("llama_delete_busy");
        await deleteLlamaModel(model.filename, label);
        if (del.isConnected) {
          del.disabled = false;
          del.textContent = t("llama_delete");
        }
      });
      row.appendChild(del);
      list.appendChild(row);
    }
  }
}

// Catalogue GGUF : liste compacte filtrable (recherche + puces de palier), à
// hauteur bornée. Le téléchargement se fait ligne par ligne avec sa propre
// barre de progression alimentée par l'évènement `llama-download-progress`.
// Catalogue GGUF : liste compacte filtrable (recherche + puces de palier), à
// hauteur bornée. Téléchargement, annulation, reprise et garde-fous matériels
// sont mutualisés avec l'assistant (cf. lib/llama-download.js).
async function renderLlamaCatalog() {
  const root = $("llama-model-catalog");
  if (!root) return;
  if (!llamaPicker) {
    llamaPicker = createCatalogPicker(root, {
      chips: modelCatalogChips(),
      ...modelGroupOptions,
      searchPlaceholder: t("cat_search_model"),
      emptyLabel: t("cat_empty"),
      countLabel: (shown, total) => t("cat_count", { shown, total }),
      infoLabel: t("cat_info"),
    });
  }
  const banner = $("llama-hw-banner");
  if (banner) {
    banner.textContent = hardwareBannerText();
    banner.hidden = !banner.textContent;
  }
  const partials = await loadPartials();
  llamaPicker.setItems(LLAMA_MODEL_CATALOG.filter(m => !m.tags?.includes("ocr") && !m.tags?.includes("decision")).map((model) => ({ group: modelGroup(model), ...llamaCatalogItem(model, {
    installed: llamaModels.some((entry) => entry.filename === model.filename),
    partials,
    picker: llamaPicker,
    lang: getLang(),
    onInstalled: () => populateLlamaModels(),
    installedActions: (installedModel) => [
      {
        label: t("llama_use"),
        onClick: () => {
          const select = $("select-model-llama");
          if (select) select.value = installedModel.filename;
          localStorage.setItem("selectedModel", installedModel.filename);
        },
      },
      {
        label: t("llama_delete"),
        kind: "danger",
        onClick: async (ctx) => {
          ctx.button.disabled = true;
          ctx.button.textContent = t("llama_delete_busy");
          await deleteLlamaModel(installedModel.filename, installedModel.label);
        },
      },
    ],
  }) })));
}

function initLlamaProgressEvents() {
  if (llamaProgressListener || !tauriEvent?.listen) return;
  llamaProgressListener = tauriEvent.listen("llama-download-progress", (event) => {
    const p = event.payload || {};
    if (!p.id) return;
    if (litertDownloads.has(p.id)) {
      const bar = $("litert-model-catalog")
        ?.querySelector(`[data-litert-id="${CSS.escape(p.id)}"] .llama-model-progress > span`);
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(p.percent) || 0))}%`;
      return;
    }
    llamaPicker?.setProgress(p.id, p.percent);
  });
}

// ===== LiteRT-LM (Google AI Edge) : runtime embarqué du build Raspberry Pi =====
//
// Le runtime est un venv Python fabriqué par scripts/build-litert-runtime.sh et
// copié dans les ressources : il n'existe QUE dans le build Pi. Toute cette
// section — l'option de source comprise — disparaît donc ailleurs, plutôt que
// d'offrir un choix qui échouerait au premier message.
let litertModels = [];
let litertRuntime = null;

async function refreshLitertUI() {
  try {
    litertRuntime = await invoke("litert_runtime");
  } catch {
    litertRuntime = null;
  }
  if (!litertRuntime?.available) {
    $("select-ai-source")?.querySelector('option[value="litert"]')?.remove();
    // Une préférence enregistrée sur une machine qui avait le runtime ne doit
    // pas laisser Lumen sur une source injoignable après une mise à jour.
    if (localStorage.getItem("aiSource") === "litert") localStorage.setItem("aiSource", "llama");
    if ($("settings-group-litert")) $("settings-group-litert").style.display = "none";
    return;
  }
  await populateLitertModels();
  renderLitertCatalog();
}

async function populateLitertModels() {
  const select = $("select-model-litert");
  try {
    litertModels = await invoke("litert_list_models");
    if (!Array.isArray(litertModels)) litertModels = [];
  } catch { litertModels = []; }
  if (!select) return;
  const selected = val("selectedModel", "");
  select.innerHTML = litertModels.length
    ? litertModels
        .map((m) => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.id)} — ${formatModelBytes(m.size)}</option>`)
        .join("")
    : `<option value="">${escapeHTML(t("opt_no_litert_models"))}</option>`;
  if (litertModels.some((m) => m.id === selected)) select.value = selected;
  else if (litertModels[0]) select.value = litertModels[0].id;
  const status = $("litert-status");
  if (status) {
    status.textContent = litertModels.length
      ? t("litert_ready").replace("{version}", litertRuntime?.version || "?")
      : t("litert_no_model");
  }
}

// Liste bespoke plutôt que le sélecteur mutualisé : deux modèles, pas de
// paliers ni de filtres à proposer, et un contrat de téléchargement distinct
// (commandes litert_*). Le picker n'apporterait ici que de l'indirection.
function renderLitertCatalog() {
  const root = $("litert-model-catalog");
  if (!root) return;
  const lang = getLang();
  root.innerHTML = "";
  for (const entry of LITERT_MODEL_CATALOG) {
    const installed = litertModels.some((m) => m.filename === entry.filename);
    const card = document.createElement("div");
    card.className = "llama-model-card";
    const description = (lang === "en" && entry.descriptionEn) || entry.description;
    card.innerHTML = `<h4>${escapeHTML(entry.label)}</h4>
      <p>${escapeHTML(description)}</p>
      <div class="llama-model-meta">${escapeHTML(entry.sizeLabel)} · ${escapeHTML(t("cat_ram", { ram: entry.ramHint }))}</div>
      <div class="llama-model-progress" hidden><span style="width:0%"></span></div>`;
    const actions = document.createElement("div");
    actions.className = "llama-model-actions";
    const progress = card.querySelector(".llama-model-progress");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ios-row-action";
    button.textContent = installed ? t("llama_delete") : t("llama_download");
    if (installed) button.classList.add("danger");
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (installed) {
          await invoke("litert_delete_model", { filename: entry.filename });
        } else {
          progress.hidden = false;
          litertDownloads.add(entry.id);
          await invoke("litert_download_model", {
            request: { id: entry.id, url: entry.url, filename: entry.filename },
          });
        }
        await populateLitertModels();
        renderLitertCatalog();
      } catch (error) {
        const status = $("litert-status");
        if (status) {
          status.textContent = String(error?.message || error);
          status.style.color = "var(--danger)";
        }
        button.disabled = false;
        progress.hidden = true;
      } finally {
        litertDownloads.delete(entry.id);
      }
    });
    actions.appendChild(button);
    card.appendChild(actions);
    card.dataset.litertId = entry.id;
    root.appendChild(card);
  }
}

// Les téléchargements LiteRT réutilisent l'évènement `llama-download-progress`
// émis par le backend (même fonction de téléchargement). On garde la liste des
// ids en cours pour ne pas confondre une progression GGUF avec une .litertlm.
const litertDownloads = new Set();

// ===== Catalogue Ollama : pull depuis les Paramètres, avec progression =====
//
// Le téléchargement passe par la commande Rust `ollama_pull` (POST /api/pull en
// streaming) : l'utilisateur n'a jamais besoin d'un terminal ni de `ollama pull`.
let ollamaPicker = null;
let ollamaPullListeners = false;
let ollamaPullTarget = null; // { name, source: "catalog" | "manual" }
let ollamaInstalledNames = [];

function setOllamaPullStatus(text, isError = false) {
  const el = $("ollama-pull-status");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "var(--danger)" : "";
}

function setOllamaPullProgress(pct, visible = true) {
  const wrap = $("ollama-pull-progress");
  if (!wrap) return;
  wrap.hidden = !visible;
  wrap.firstElementChild.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
}

async function refreshOllamaCatalog() {
  const root = $("ollama-model-catalog");
  if (!root) return;
  try {
    ollamaInstalledNames = await listOllamaModels(val("ollamaUrl", defaults.ollamaUrl));
  } catch { ollamaInstalledNames = []; }
  if (!ollamaPicker) {
    ollamaPicker = createCatalogPicker(root, {
      chips: modelCatalogChips(),
      ...modelGroupOptions,
      searchPlaceholder: t("cat_search_model"),
      emptyLabel: t("cat_empty"),
      countLabel: (shown, total) => t("cat_count", { shown, total }),
    });
  }
  ollamaPicker.setItems(OLLAMA_MODEL_CATALOG.filter(m => !m.tags?.includes("ocr") && !m.tags?.includes("decision")).map((model) => {
    const installed = ollamaModelInstalled(model.name, ollamaInstalledNames);
    return {
      id: model.name,
      title: model.label,
      meta: `${model.name} · ${tierLabel(model.tier)} · ${model.sizeLabel} · ${t("cat_ram", { ram: model.ramHint })}`,
      description: ollamaModelDescription(model, getLang()),
      tags: model.tags || [],
      tier: model.tier,
      group: modelGroup(model),
      installed,
      badge: installed ? t("cat_badge_installed") : "",
      actions: installed
        ? [{
          label: t("llama_use"),
          onClick: () => {
            const select = $("select-model");
            if (select && [...select.options].some((o) => o.value === model.name)) select.value = model.name;
            localStorage.setItem("selectedModel", model.name);
            setOllamaPullStatus(t("ollama_model_selected", { model: model.name }));
          },
        }]
        : [{
          label: t("llama_download"),
          onClick: (ctx) => pullOllamaModel(model.name, ctx),
        }],
    };
  }));
}

async function pullOllamaModel(name, ctx = null) {
  const model = String(name || "").trim();
  if (!model) return;
  if (ollamaPullTarget) {
    setOllamaPullStatus(t("ollama_pull_busy", { model: ollamaPullTarget.name }), true);
    return;
  }
  ollamaPullTarget = { name: model, ctx };
  if (ctx) {
    ctx.button.disabled = true;
    ctx.button.textContent = t("llama_downloading");
    ctx.setProgress(0);
  }
  setOllamaPullProgress(0, true);
  setOllamaPullStatus(t("ollama_pull_progress", { model, pct: 0 }));
  try {
    await invoke("ollama_pull", { url: val("ollamaUrl", defaults.ollamaUrl), model });
  } catch (e) {
    // L'évènement `ollama-pull-done` gère aussi l'échec ; ce filet couvre le
    // cas où la commande échoue avant le premier octet (Ollama injoignable).
    finishOllamaPull(false, e?.message || String(e));
  }
}

function finishOllamaPull(ok, error = "") {
  const target = ollamaPullTarget;
  ollamaPullTarget = null;
  setOllamaPullProgress(0, false);
  if (!target) return;
  if (target.ctx) {
    ollamaPicker?.clearProgress(target.name);
    target.ctx.button.disabled = false;
    target.ctx.button.textContent = ok ? t("llama_download") : t("llama_retry");
  }
  setOllamaPullStatus(
    ok ? t("ollama_pull_done", { model: target.name }) : t("ollama_pull_fail", { err: error }),
    !ok,
  );
  if (ok) {
    populateModels().catch(() => {});
    refreshOllamaCatalog().catch(() => {});
  }
}

function initOllamaPullEvents() {
  if (ollamaPullListeners || !tauriEvent?.listen) return;
  ollamaPullListeners = true;
  tauriEvent.listen("ollama-pull-progress", (event) => {
    const p = event.payload || {};
    if (!ollamaPullTarget) return;
    const pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
    setOllamaPullProgress(pct, true);
    ollamaPicker?.setProgress(ollamaPullTarget.name, pct);
    setOllamaPullStatus(p.status
      ? t("ollama_pull_progress_status", { model: ollamaPullTarget.name, pct, status: p.status })
      : t("ollama_pull_progress", { model: ollamaPullTarget.name, pct }));
  });
  tauriEvent.listen("ollama-pull-done", (event) => {
    const p = event.payload || {};
    finishOllamaPull(Boolean(p.ok), p.error || "");
  });
}

// ===== Moteur d'image : modèles et résolutions =====
// Un moteur = ses modèles et ses résolutions. Bonsai propose ternary/binary,
// Ollama les modèles d'image RÉELLEMENT installés (plus le catalogue en
// suggestion), OpenAI ses trois modèles d'API.
let ollamaImageNames = null;   // null = pas encore interrogé

async function renderImageModels(refresh = false) {
  const sel = $("select-image-model");
  if (!sel) return;
  const provider = $("select-image-provider")?.value || defaults.imageProvider;
  if (provider === "bonsai") await ensureBonsaiKind(invoke);
  if (provider === "ollama" && (refresh || ollamaImageNames === null)) {
    ollamaImageNames = await listOllamaImageModels(invoke);
  }
  const models = imageModelsFor(provider, ollamaImageNames || []);
  const key = imageModelKey(provider);
  const current = localStorage.getItem(key) || defaults[key];
  sel.innerHTML = "";
  for (const m of models) {
    // Un modèle non installé reste sélectionnable : le libellé dit seulement
    // qu'il faudra le récupérer.
    sel.appendChild(new Option(m.missing ? `${m.label} — ${t("image_model_missing")}` : m.label, m.id));
  }
  if (!models.some((m) => m.id === current)) sel.appendChild(new Option(current, current));
  sel.value = current;
  if ($("btn-image-model-refresh")) $("btn-image-model-refresh").hidden = provider !== "ollama";
  renderImageModelHints();
}

function renderImageModelHints() {
  const provider = $("select-image-provider")?.value || defaults.imageProvider;
  const model = $("select-image-model")?.value || imageModel(provider);
  const hint = $("image-model-hint");
  if (hint) {
    const known = imageModelsFor(provider, ollamaImageNames || []).find((m) => m.id === model);
    hint.textContent = provider === "ollama" && known?.missing
      ? `${t("image_model_pull")} ollama pull ${model}`
      : "";
  }
  // Les résolutions dépendent du moteur ET, pour OpenAI, du modèle : l'API
  // refuse toute autre valeur, autant les annoncer ici.
  const sizes = $("image-sizes-hint");
  if (sizes) {
    sizes.textContent = `${t("image_sizes_available")} ${imageSizesFor(provider, model).map((s) => s.value).join(", ")}`;
  }
}

// « À quoi t'attendre » : rappelé là où l'utilisateur choisit son modèle, et
// pas seulement dans l'assistant — c'est aussi là qu'il change d'avis.
function renderModelExpectations() {
  const source = $("select-ai-source")?.value || val("aiSource", "shortcut");
  renderExpectations($("llama-expectations"), {
    source: "llama",
    model: $("select-model-llama")?.value || val("selectedModel", ""),
  });
  renderExpectations($("ollama-expectations"), {
    source: "ollama",
    model: $("select-model")?.value || val("selectedModel", ""),
  });
  renderExpectations($("api-expectations"), { source: "api" });
  // Sur macOS en source Apple, le cadrage se lit dans le groupe correspondant.
  if (source === "shortcut" && $("api-expectations")) {
    renderExpectations($("api-expectations"), { source: "shortcut" });
  }
}

function toggleImageProviderSettings() {
  const provider = $("select-image-provider")?.value || defaults.imageProvider;
  if ($("image-provider-openai")) $("image-provider-openai").style.display = provider === "openai" ? "block" : "none";
  if ($("image-provider-bonsai")) $("image-provider-bonsai").style.display = provider === "bonsai" ? "block" : "none";
  if ($("image-provider-ollama")) $("image-provider-ollama").style.display = provider === "ollama" ? "block" : "none";
  if ($("image-provider-playground")) $("image-provider-playground").style.display = provider === "playground" ? "block" : "none";
}

// Image Playground (macOS 27) : option révélée seulement si Apple Intelligence
// répond présent ; la raison s'affiche dans le groupe dédié.
async function refreshImagePlaygroundOption() {
  const st = await refreshPlaygroundOption($("select-image-provider"), invoke, {
    onFallback: () => { toggleImageProviderSettings(); renderImageModels(); },
  });
  if ($("playground-status") && st) {
    $("playground-status").textContent = st.available ? t("playground_ready") : playgroundReasonText(st.reason);
  }
}

function applyPlatformFlavorUi() {
  document.body.classList.toggle("flavor-rpi", platformFlavor === "rpi");
  document.body.classList.toggle("flavor-linux-standard", platformFlavor === "linux-standard");
  document.body.classList.toggle("flavor-windows", platformFlavor === "windows");
  document.querySelectorAll(".platform-opaque-only").forEach((el) => { el.hidden = !barOpaqueAvailable(); });
  // Mode performance : Raspberry Pi uniquement. Ailleurs, le gain est nul et
  // la perte visuelle réelle — l'option n'a rien à faire dans la liste.
  document.querySelectorAll(".platform-rpi-only").forEach((el) => { el.hidden = platformFlavor !== "rpi"; });
  updateVoiceDictationModeUI();
  if (!platformWithoutAppleShortcuts()) return;
  $("select-ai-source")?.querySelector('option[value="shortcut"]')?.remove();
  $("select-speech-backend")?.querySelector('option[value="shortcut"]')?.remove();
  // Le sélecteur reste visible partout. Le masquer sous Linux/Pi — au motif que
  // Piper y est le seul moteur *local* — rendait la voix du système
  // inatteignable, et créait surtout un cul-de-sac : `auto` retombe sur
  // « système » tant qu'aucune voix Piper n'est installée, ce qui masque la
  // section Piper, donc le catalogue par lequel on installe justement une voix.
  // Seule l'option « Raccourci Apple » est retirée hors macOS (plus haut).
  if (localStorage.getItem("aiSource") === "shortcut") localStorage.setItem("aiSource", "ollama");
}

// Déduit un palier « humain » (Rapide / Équilibré / Puissant) du nombre de
// paramètres présent dans le nom du modèle (ex. 350m, 3b, 7b, 70b).
function modelTierLabel(name) {
  const m = /(\d+(?:\.\d+)?)\s*([mb])\b/i.exec(name || "");
  if (!m) return "";
  let billions = parseFloat(m[1]);
  if (m[2].toLowerCase() === "m") billions /= 1000;
  if (billions <= 0) return "";
  if (billions < 2) return t("model_tier_fast");
  if (billions <= 8) return t("model_tier_balanced");
  return t("model_tier_powerful");
}

async function populateModels() {
  const select = $("select-model");
  if (!select) return;
  const selected = modelVal();
  select.innerHTML = `<option value="${selected}">${selected}</option>`;
  await refreshLoadedModels();
  try {
    const url = ($("input-ollama-url")?.value || defaults.ollamaUrl).replace(/\/$/, "");
    const models = await listOllamaModels(url);
    select.innerHTML = "";
    models.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      const tier = modelTierLabel(name);
      opt.textContent = tier ? `${name} — ${tier}` : name;
      select.appendChild(opt);
    });
    if (models.includes(selected)) select.value = selected;
    refreshOrchestrateModelSelects();
  } catch {
    const list = $("loaded-models-list");
    if (list) list.textContent = "Ollama indisponible pour le moment.";
  }
}

async function ollamaJson(path) {
  const url = ($("input-ollama-url")?.value || defaults.ollamaUrl).replace(/\/$/, "");
  try {
    return await invoke("ollama_get_json", { url, path });
  } catch (e) {
    return await ollamaGetJson(path, url);
  }
}

async function refreshLoadedModels() {
  const list = $("loaded-models-list");
  if (!list) return;
  list.innerHTML = `<div class="loaded-empty">${t("loaded_checking")}</div>`;
  let models = [];
  try {
    models = (await ollamaJson("api/ps")).models || [];
  } catch {
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
    const size = m.size_vram || m.size || 0;
    const sizeTxt = size ? ` · ${(size / 1e9).toFixed(1)} Go` : "";
    const row = document.createElement("div");
    row.className = "loaded-model-row";
    row.innerHTML = `<span class="loaded-model-name">${escapeHTML(name)}${sizeTxt}</span>`;
    const btn = document.createElement("button");
    btn.className = "loaded-stop-btn";
    btn.textContent = t("loaded_stop");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      await unloadModel(name);
      await refreshLoadedModels();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
}

async function unloadModel(name) {
  const url = ($("input-ollama-url")?.value || defaults.ollamaUrl).replace(/\/$/, "");
  try {
    await ollamaPostJson("api/generate", { model: name, keep_alive: 0 }, url);
  } catch { /* non bloquant */ }
}

async function saveSettings() {
  const source = platformWithoutAppleShortcuts() && $("select-ai-source")?.value === "shortcut"
    ? "ollama"
    : ($("select-ai-source")?.value || "shortcut");
  const cron = $("select-heartbeat-frequency")?.value === "custom"
    ? ($("input-heartbeat-cron")?.value.trim() || "0 */10 * * * *")
    : ($("select-heartbeat-frequency")?.value || "0 0 * * * *");
  // SÉCURITÉ : la clé API n'est JAMAIS écrite en localStorage ni diffusée dans
  // l'évènement settings-updated. Elle n'est transmise qu'au backend (ci-dessous).
  const apiKeyInput = $("input-api-key")?.value.trim() || "";
  const pairs = {
    ...collectWorkspaceSettings(),
    aiSource: source,
    apiBaseUrl: $("input-api-base")?.value.trim() || defaults.apiBaseUrl,
    apiModel: $("input-api-model")?.value.trim() || defaults.apiModel,
    orchestrateChat: String($("checkbox-orchestrate")?.checked || false),
    orchestratorFastModel: $("input-orchestrate-fast")?.value.trim() || "",
    llmHybrid: String($("checkbox-llm-hybrid")?.checked || false),
    orchestratorStrongModel: ["api", "ollama"].includes(source) ? ($("input-orchestrate-strong")?.value.trim() || "") : "",
    lumenModel: $("input-lumen-model")?.value.trim() || "",
    applefmModel: $("select-applefm-model")?.value || APPLEFM_DEFAULT_MODEL,
    imageProvider: $("select-image-provider")?.value || defaults.imageProvider,
    imageBonsaiModel: localStorage.getItem("imageBonsaiModel") || defaults.imageBonsaiModel,
    imageOpenaiModel: localStorage.getItem("imageOpenaiModel") || defaults.imageOpenaiModel,
    imageOllamaModel: localStorage.getItem("imageOllamaModel") || defaults.imageOllamaModel,
    imagePlaygroundStyle: localStorage.getItem("imagePlaygroundStyle") || defaults.imagePlaygroundStyle,
    systemPrompt: $("input-system-prompt")?.value.trim() || "",
    ollamaUrl: $("input-ollama-url")?.value.trim() || defaults.ollamaUrl,
    selectedModel: source === "llama"
      ? ($("select-model-llama")?.value || "")
      : source === "litert"
        ? ($("select-model-litert")?.value || "")
        : ($("select-model")?.value || modelVal()),
    ollamaThink: String($("checkbox-ollama-think")?.checked || false),
    ollamaNumCtx: String(CTX_VALUES[Number.parseInt($("slider-ollama-num-ctx")?.value || "0", 10)] || 0),
    llamaNumCtx: String(Math.max(2048, Math.min(LLAMA_CTX_MAX, Number.parseInt($("select-llama-num-ctx")?.value || "8192", 10) || 8192))),
    ollamaKeepAlive: $("input-ollama-keep-alive")?.value.trim() || "5m",
    shortcutName: $("input-shortcut-name")?.value.trim() || defaults.shortcutName,
    actionRouter: $("input-action-router")?.value.trim() || defaults.actionRouter,
    speechBackend: $("select-speech-backend")?.value || defaults.speechBackend,
    speakShortcut: $("input-speak-shortcut")?.value.trim() || defaults.speakShortcut,
    dictateShortcut: $("input-dictate-shortcut")?.value.trim() || defaults.dictateShortcut,
    glassOpacity: String((Number.parseInt($("slider-transparency")?.value || "4", 10) || 4) / 100),
    barSize: $("select-bar-size")?.value || defaults.barSize,
    barOpaque: String($("checkbox-bar-opaque")?.checked ?? barOpaqueDefault()),
    lumenPerfMode: String($("checkbox-perf-mode")?.checked || false),
    morningView: String($("checkbox-morning")?.checked ?? true),
    startupLumenOS: String($("checkbox-startup-lumen-os")?.checked || false),
    themePreference: themeForBar(),
    alwaysOnTop: String(alwaysOnTopSettingValue()),
    halo: String($("checkbox-halo")?.checked || false),
    haloPosition: $("select-halo-position")?.value || "center",
    haloStyle: $("select-halo-style")?.value || "float",
    haloRest: $("select-halo-rest")?.value || "peek",
    haloHold: $("slider-halo-hold")?.value || "15",
    haloAgents: String($("checkbox-halo-agents")?.checked ?? true),
    haloClock: String($("checkbox-halo-clock")?.checked ?? true),
    haloSticky: String($("checkbox-halo-sticky")?.checked || false),
    debugMode: String($("checkbox-debug")?.checked || false),
    heartbeatEnabled: String($("checkbox-heartbeat")?.checked || false),
    heartbeatShortcut: $("input-heartbeat-shortcut")?.value.trim() || "Heartbeat",
    heartbeatEngine: IS_MAC ? ($("select-heartbeat-engine")?.value || "fluxo") : "fluxo",
    heartbeatInput: $("input-heartbeat-input")?.value.trim() || "",
    heartbeatCron: $("input-heartbeat-cron")?.value.trim() || "0 */10 * * * *",
    heartbeatFrequency: cron,
    orbEnabled: String($("checkbox-orb")?.checked ?? true),
    orbAvatarMode: $("select-avatar-model")?.value || "orb",
    robotHeadOptions: JSON.stringify(collectRobotOptions()),
    avatarGlbAmbientLight: $("slider-avatar-glb-light")?.value || "100",
    orbTheme: $("select-orb-theme")?.value || "default",
    orbSize: $("slider-orb-size")?.value || "116",
    orbCoreScale: $("slider-orb-core")?.value || "82",
    orbPulse: $("slider-orb-pulse")?.value || "100",
    orbMouth: String($("checkbox-orb-mouth")?.checked ?? false),
    orbMoods: String($("checkbox-orb-moods")?.checked ?? true),
    uiSounds: String($("checkbox-ui-sounds")?.checked ?? true),
    orbGlassType: $("select-orb-glass")?.value || "thin",
    orbColors: JSON.stringify(readOrbColors()),
    orbHeartbeat: String($("checkbox-orb-heartbeat")?.checked ?? true),
    orbHeartColor: $("orb-heart-color")?.value || "#ff4d6d",
    orbPulseStrength: $("slider-orb-pulse-strength")?.value || "100",
    orbPulseSpeed: $("slider-orb-pulse-speed")?.value || "100",
  };
  Object.entries(pairs).forEach(([key, value]) => localStorage.setItem(key, value));
  localStorage.setItem("orchestratorStrongProvider", modelProviderKey(llmBackend()));
  pushImageConfig(invoke);
  // Mémoire par backend : le modèle choisi ici appartient à CE backend. Sans
  // elle, revenir sur l'autre source repartait sur le premier modèle de sa
  // liste au lieu de celui qu'on y avait laissé.
  if (source === "ollama" || source === "llama") rememberModelFor(source, pairs.selectedModel);
  localStorage.removeItem("apiKey"); // purge d'une éventuelle ancienne valeur en clair
  if ($("select-language")) {
    setLang($("select-language").value);
    applyI18n();
    // Les puces de filtre sont construites une fois avec leurs libellés : on
    // rebâtit les listes compactes pour qu'elles suivent la langue.
    llamaPicker = null;
    ollamaPicker = null;
    ttsPicker = null;
    renderLlamaCatalog().catch(() => {});
    populateLlamaModels().catch(() => {});
    refreshOllamaCatalog().catch(() => {});
    refreshTtsUI().catch(() => {});
    // Les libellés des puces MCP suivent aussi la langue.
    mcpPicker = null;
    refreshMcpServers().then(refreshMcpCatalog).catch(() => {});
    refreshToolbox().catch(() => {});
    renderControllerInfo();
  }
  try {
    await invoke("set_ollama_config", {
      url: pairs.ollamaUrl,
      model: pairs.selectedModel,
      backend: rustBackend(source),
      apiBase: pairs.apiBaseUrl,
      // Clé envoyée UNIQUEMENT si l'utilisateur en a saisi une (sinon le backend
      // conserve celle déjà stockée — cf. set_ollama_config).
      apiKey: apiKeyInput,
      // En source Lumen Server ou Apple, `api_model` porte leur modèle.
      apiModel: source === "lumen" ? pairs.lumenModel : source === "applefm" ? pairs.applefmModel : pairs.apiModel,
      language: getLang(),
    });
    await invoke("agent_set_fallback_model", { model: pairs.orchestratorStrongModel });
    if (apiKeyInput && $("input-api-key")) {
      $("input-api-key").value = "";
      await refreshApiKeyStatus();
    }
    refreshApiProfiles().catch(() => {});
  } catch {}
  let llamaStartFailed = false;
  if (source === "llama" && pairs.selectedModel) {
    // Le backend est déjà persisté par son propre handler ; on le réaffirme ici
    // pour couvrir le cas d'un premier enregistrement où le champ n'a jamais été
    // touché, puis `llama_start` relance le serveur avec la bonne variante.
    // Uniquement si le champ est réellement proposé : quand il est masqué (pas
    // de variante CUDA, pas de carte), il vaut « auto » par défaut et le
    // réaffirmer écraserait un choix explicite fait sur une autre machine.
    const backendItem = $("llama-backend-item");
    const backend = backendItem && !backendItem.hidden ? $("select-llama-backend")?.value : "";
    if (backend) { try { await invoke("llama_set_backend", { backend }); } catch {} }
    try { await invoke("llama_start", { filename: pairs.selectedModel, ctxSize: Number.parseInt(pairs.llamaNumCtx, 10) || 8192 }); } catch (e) {
      // Ne plus se contenter d'un warning en console : si le serveur ne démarre
      // pas (modèle absent, port tenu par un llama-server orphelin), l'écran
      // afficherait sinon le modèle choisi alors qu'un autre est réellement
      // servi — c'est indétectable à l'usage.
      console.warn("llama-server ne démarre pas :", e);
      const el = $("llama-start-status");
      if (el) { el.textContent = String(e?.message || e); el.style.color = "var(--danger)"; }
      // On garde la fenêtre ouverte pour que le message soit lu, mais le reste
      // des réglages est bien enregistré : l'échec ne concerne que llama-server.
      llamaStartFailed = true;
    }
  } else if (source !== "llama") {
    invoke("llama_stop").catch(() => {});
  }
  try { await tauriEvent?.emit?.("settings-updated", pairs); } catch {}
  if (!embeddedInWorkspace && !llamaStartFailed) currentWindow?.close?.();
}

/** Hors Mac : pas de choix de moteur (Fluxo imposé) ; sur Mac, le nom du
 * raccourci n'a de sens que si c'est lui le moteur. */
function syncHeartbeatEngineRows() {
  const engineRow = $("heartbeat-engine-row");
  const shortcutRow = $("heartbeat-shortcut-row");
  const engine = IS_MAC ? ($("select-heartbeat-engine")?.value || "fluxo") : "fluxo";
  if (engineRow) engineRow.hidden = !IS_MAC;
  if (shortcutRow) shortcutRow.hidden = engine !== "shortcut";
}

// Intelligence hybride : maître coupé → piliers grisés (leur valeur est
// gardée pour la prochaine activation, cf. lib/hybrid.js).
// Intelligence hybride = escalade vers l'API cloud : la carte signale quand
// aucune API munie d'une clé n'existe (l'escalade ne pourrait rien proposer).
async function syncHybridCard() {
  const on = !!$("checkbox-llm-hybrid")?.checked;
  $("hybrid-card")?.classList.toggle("off", !on);
  const note = $("hybrid-api-note");
  if (!note) return;
  let configured = true;
  try {
    const { profiles } = await listApiProfiles();
    configured = (profiles || []).some((p) => p.configured);
  } catch { /* liste indisponible : on ne prévient pas à tort */ }
  note.hidden = !on || configured;
}
document.addEventListener("change", (e) => { if (e.target?.id === "checkbox-llm-hybrid") syncHybridCard(); });

function bindNavigation() {
  const activate = (name) => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.tab === name));
    document.querySelectorAll(".settings-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
    document.querySelectorAll(".settings-tab-pane").forEach((pane) => pane.classList.toggle("active", pane.dataset.pane === name));
    const dropdown = $("settings-tab-dropdown");
    if (dropdown) dropdown.value = name;
  };
  document.querySelectorAll(".nav-item, .settings-tab").forEach((item) => {
    item.addEventListener("click", () => activate(item.dataset.tab));
  });
  $("settings-tab-dropdown")?.addEventListener("change", (event) => activate(event.target.value));
  // Lien profond (recherche globale du bureau) : `?tab=appearance&focus=id`,
  // ou `window.__settingsGo(tab, focus)` quand la fenêtre est déjà ouverte.
  const go = (tab, focus) => {
    if (tab && document.querySelector(`.settings-tab-pane[data-pane="${tab}"]`)) activate(tab);
    const el = focus && document.getElementById(focus);
    if (!el) return;
    setTimeout(() => {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("settings-flash");
      setTimeout(() => el.classList.remove("settings-flash"), 1600);
    }, 60);
  };
  window.__settingsGo = go;
  const params = new URLSearchParams(location.search);
  if (params.get("tab") || params.get("focus")) go(params.get("tab"), params.get("focus"));
}

const DEFAULT_PROFILE = {
  name: "", callMe: "", role: "", interests: [], goals: "",
  tone: "balanced", address: "tu", language: "auto", emoji: false, useProfile: true,
};
let userProfile = { ...DEFAULT_PROFILE };
let userMemories = [];
let profileSaveTimer = null;

function initProfileUI() {
  const pane = document.querySelector('.settings-tab-pane[data-pane="profile"]');
  if (!pane || pane.dataset.bound === "true") return;
  pane.dataset.bound = "true";
  const nameEl = $("profile-name"), callmeEl = $("profile-callme"), roleEl = $("profile-role");
  const goalsEl = $("profile-goals"), langEl = $("profile-language");
  const emojiEl = $("profile-emoji"), useEl = $("profile-use");
  const toneSeg = $("profile-tone"), addrSeg = $("profile-address");
  const interestsEl = $("profile-interests"), interestAdd = $("profile-interest-add");
  const memListEl = $("profile-memories"), memAdd = $("profile-memory-add");
  const heroName = $("profile-hero-name"), heroAvatar = $("profile-avatar");
  const avatarFile = $("profile-avatar-file"), avatarPick = $("btn-profile-avatar"), avatarClear = $("btn-profile-avatar-clear");
  const sessionSelect = $("session-profile-select"), sessionNew = $("btn-session-profile-new"), sessionDelete = $("btn-session-profile-delete");
  if (!nameEl || !memListEl) return;
  let sessionProfiles = [];
  let activeSessionId = "";

  const saveProfileSoon = () => {
    clearTimeout(profileSaveTimer);
    profileSaveTimer = setTimeout(async () => {
      await invoke("memory_set", { key: "user/profile", value: userProfile }).catch(() => {});
      const displayName = (userProfile.callMe || userProfile.name || "Utilisateur").trim();
      await invoke("session_save_profile", {
        id: activeSessionId || null,
        name: displayName,
        avatar: userProfile.avatar || "",
      }).catch(() => {});
      await loadSessions();
    }, 350);
  };
  const saveMemories = () => invoke("memory_set", { key: "user/memories", value: userMemories }).catch(() => {});
  const renderHero = () => {
    const nm = userProfile.callMe || userProfile.name;
    heroName.textContent = nm || "Votre profil";
    if (userProfile.avatar) {
      heroAvatar.innerHTML = `<img src="${escapeHTML(userProfile.avatar)}" alt="" />`;
    } else {
      heroAvatar.textContent = (nm || "L").trim().charAt(0).toUpperCase();
    }
  };
  const renderSegmented = (seg, value) => {
    if (!seg) return;
    seg.dataset.value = value;
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.val === value));
  };
  const renderInterests = () => {
    interestsEl.innerHTML = "";
    (userProfile.interests || []).forEach((interest, index) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = '<span></span><button type="button" title="Supprimer">×</button>';
      chip.querySelector("span").textContent = interest;
      chip.querySelector("button").addEventListener("click", () => {
        userProfile.interests.splice(index, 1);
        renderInterests();
        saveProfileSoon();
      });
      interestsEl.appendChild(chip);
    });
  };
  const renderMemories = () => {
    memListEl.innerHTML = "";
    if (!userMemories.length) {
      const empty = document.createElement("div");
      empty.className = "ios-row";
      empty.style.opacity = "0.62";
      empty.innerHTML = "<span>Rien encore. Lumen apprendra au fil du temps.</span>";
      memListEl.appendChild(empty);
      return;
    }
    userMemories.forEach((memory, index) => {
      const text = typeof memory === "string" ? memory : memory.text;
      const source = typeof memory === "object" && memory.source === "appris" ? "appris" : "ajouté";
      const row = document.createElement("div");
      row.className = "ios-row memory-fact";
      row.innerHTML = `<span class="fact-text"></span><span class="fact-meta"></span><button type="button" class="fact-del" title="Supprimer">${icon("trash")}</button>`;
      row.querySelector(".fact-text").textContent = text || "";
      row.querySelector(".fact-meta").textContent = source;
      row.querySelector(".fact-del").addEventListener("click", () => {
        userMemories.splice(index, 1);
        renderMemories();
        saveMemories();
      });
      memListEl.appendChild(row);
    });
  };
  const render = () => {
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
  };
  const renderSessions = () => {
    if (!sessionSelect) return;
    sessionSelect.innerHTML = sessionProfiles
      .map((p) => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name || "Utilisateur")}</option>`)
      .join("");
    sessionSelect.value = activeSessionId;
  };
  const loadSessions = async () => {
    const data = await invoke("session_profiles").catch(() => null);
    sessionProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
    activeSessionId = data?.active_id || sessionProfiles[0]?.id || "";
    renderSessions();
  };
  const syncActiveSessionLabel = async () => {
    if (!activeSessionId) return;
    const displayName = (userProfile.callMe || userProfile.name || "").trim();
    const active = sessionProfiles.find((p) => p.id === activeSessionId);
    if (!displayName || (active?.name === displayName && (active?.avatar || "") === (userProfile.avatar || ""))) return;
    await invoke("session_save_profile", {
      id: activeSessionId,
      name: displayName,
      avatar: userProfile.avatar || "",
    }).catch(() => {});
    await loadSessions();
  };
  const load = async () => {
    await loadSessions();
    try {
      const entry = await invoke("memory_get", { key: "user/profile" });
      if (entry?.value && typeof entry.value === "object") userProfile = { ...DEFAULT_PROFILE, ...entry.value };
      else userProfile = { ...DEFAULT_PROFILE };
    } catch {}
    try {
      const entry = await invoke("memory_get", { key: "user/memories" });
      userMemories = Array.isArray(entry?.value) ? entry.value : [];
    } catch { userMemories = []; }
    await syncActiveSessionLabel();
    render();
  };

  const bindText = (el, key) => el?.addEventListener("input", () => {
    userProfile[key] = el.value;
    if (key === "name" || key === "callMe") renderHero();
    saveProfileSoon();
  });
  bindText(nameEl, "name");
  bindText(callmeEl, "callMe");
  bindText(roleEl, "role");
  bindText(goalsEl, "goals");
  langEl?.addEventListener("change", () => { userProfile.language = langEl.value; saveProfileSoon(); });
  emojiEl?.addEventListener("change", () => { userProfile.emoji = emojiEl.checked; saveProfileSoon(); });
  useEl?.addEventListener("change", () => { userProfile.useProfile = useEl.checked; saveProfileSoon(); });
  [toneSeg, addrSeg].forEach((seg) => seg?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-val]");
    if (!btn) return;
    userProfile[seg === toneSeg ? "tone" : "address"] = btn.dataset.val;
    renderSegmented(seg, btn.dataset.val);
    saveProfileSoon();
  }));
  interestAdd?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const value = interestAdd.value.trim();
    if (!value) return;
    userProfile.interests = userProfile.interests || [];
    userProfile.interests.push(value);
    interestAdd.value = "";
    renderInterests();
    saveProfileSoon();
  });
  memAdd?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const value = memAdd.value.trim();
    if (!value) return;
    userMemories.push({ text: value, source: "manuel", ts: Date.now() });
    memAdd.value = "";
    renderMemories();
    saveMemories();
  });
  sessionSelect?.addEventListener("change", async () => {
    const id = sessionSelect.value;
    await invoke("session_set_active_profile", { id }).catch((e) => alert(String(e)));
    await load();
    window.__refreshProfileLockUI?.();
  });
  sessionNew?.addEventListener("click", async () => {
    const p = await invoke("session_save_profile", { id: null, name: t("profile_new"), avatar: "" }).catch((e) => {
      alert(String(e));
      return null;
    });
    if (p?.id) await invoke("session_set_active_profile", { id: p.id }).catch(() => {});
    await load();
    window.__refreshProfileLockUI?.();
    nameEl.focus();
    nameEl.select();
  });
  sessionDelete?.addEventListener("click", async () => {
    if (!activeSessionId || sessionProfiles.length <= 1) return;
    if (!(await confirmSheet({ title: t("profile_delete_confirm"), danger: true }))) return;
    await invoke("session_delete_profile", { id: activeSessionId }).catch((e) => alert(String(e)));
    await load();
    window.__refreshProfileLockUI?.();
  });
  avatarPick?.addEventListener("click", () => avatarFile?.click());
  avatarFile?.addEventListener("change", () => {
    const file = avatarFile.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      userProfile.avatar = String(reader.result || "");
      renderHero();
      saveProfileSoon();
    };
    reader.readAsDataURL(file);
    avatarFile.value = "";
  });
  avatarClear?.addEventListener("click", () => {
    userProfile.avatar = "";
    renderHero();
    saveProfileSoon();
  });
  $("btn-clear-api-key")?.addEventListener("click", async () => {
    // confirm() est inopérant sous WKWebView : on agit directement (action
    // réversible — il suffit de ressaisir la clé).
    try { await invoke("llm_clear_api_key"); } catch {}
    localStorage.removeItem("apiKey");
    if ($("input-api-key")) $("input-api-key").value = "";
    await refreshApiKeyStatus();
  });
  $("profile-export")?.addEventListener("click", async () => {
    const data = JSON.stringify({ profile: userProfile, memories: userMemories }, null, 2);
    try { await navigator.clipboard.writeText(data); alert("Profil copié dans le presse-papiers."); }
    catch { alert(data); }
  });
  $("profile-clear")?.addEventListener("click", async () => {
    if (!(await confirmSheet({ title: "Effacer tout le profil et les souvenirs ?", danger: true }))) return;
    await invoke("memory_delete", { key: "user/profile" }).catch(() => {});
    await invoke("memory_delete", { key: "user/memories" }).catch(() => {});
    userProfile = { ...DEFAULT_PROFILE };
    userMemories = [];
    render();
  });
  tauriEvent?.listen?.("memory-changed", (event) => {
    const key = event?.payload?.key;
    if ((key === "user/profile" || key === "user/memories") && pane.classList.contains("active")) load();
  });
  load();
}

function initSharedMemoryUI() {
  const listEl = $("memory-list");
  const emptyEl = $("memory-empty");
  const nsSel = $("select-memory-ns");
  const keyInput = $("input-memory-key");
  const valInput = $("input-memory-value");
  const saveBtn = $("btn-memory-save");
  if (!listEl || listEl.dataset.bound === "true") return;
  listEl.dataset.bound = "true";

  const refresh = async () => {
    let entries = [];
    try { entries = await invoke("memory_list", { prefix: nsSel?.value || null }); } catch {}
    if (!Array.isArray(entries)) entries = [];
    listEl.innerHTML = "";
    if (!entries.length) {
      if (emptyEl) emptyEl.style.display = "";
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    entries.forEach((entry) => {
      const valueText = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      const row = document.createElement("div");
      row.className = "memory-row";
      row.innerHTML = '<div class="memory-row-main"><code class="memory-key"></code><span class="memory-val"></span></div><div class="memory-row-actions">' +
        `<button type="button" class="memory-edit" title="Modifier">${icon("pencil")}</button>` +
        `<button type="button" class="memory-del" title="Supprimer">${icon("trash")}</button></div>`;
      row.querySelector(".memory-key").textContent = entry.key;
      row.querySelector(".memory-val").textContent = valueText.length > 120 ? valueText.slice(0, 120) + "…" : valueText;
      row.querySelector(".memory-edit").addEventListener("click", () => {
        keyInput.value = entry.key;
        valInput.value = JSON.stringify(entry.value, null, 2);
      });
      row.querySelector(".memory-del").addEventListener("click", async () => {
        await invoke("memory_delete", { key: entry.key }).catch(() => {});
        refresh();
      });
      listEl.appendChild(row);
    });
  };
  nsSel?.addEventListener("change", refresh);
  saveBtn?.addEventListener("click", async () => {
    const key = keyInput.value.trim();
    if (!key) return;
    const raw = valInput.value.trim();
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    try {
      await invoke("memory_set", { key, value });
      keyInput.value = "";
      valInput.value = "";
      refresh();
    } catch (error) { alert(String(error)); }
  });
  // Formulaire simplifié : « note à retenir » sans clé ni JSON visibles.
  // La clé est dérivée du titre (slug) ou horodatée, sous l'espace store/.
  const noteInput = $("input-memory-note");
  const labelInput = $("input-memory-label");
  const addSimpleBtn = $("btn-memory-add-simple");
  addSimpleBtn?.addEventListener("click", async () => {
    const note = noteInput?.value.trim();
    if (!note) return;
    const label = labelInput?.value.trim() || "";
    const slug = (label || note)
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "note";
    const key = `store/${slug}-${Date.now().toString(36)}`;
    const value = label ? { titre: label, note } : note;
    try {
      await invoke("memory_set", { key, value });
      if (noteInput) noteInput.value = "";
      if (labelInput) labelInput.value = "";
      refresh();
    } catch (error) { alert(String(error)); }
  });

  tauriEvent?.listen?.("memory-changed", () => {
    const pane = document.querySelector('.settings-tab-pane[data-pane="memory"]');
    if (pane?.classList.contains("active")) refresh();
  });
  refresh();
}

// Sauvegarde automatique chiffrée (src-tauri/src/autobackup.rs).
function initAutoBackupUI() {
  const on = $("checkbox-autobackup"), dir = $("input-autobackup-dir"), every = $("select-autobackup-every");
  const keep = $("input-autobackup-keep"), pass = $("input-autobackup-pass"), status = $("autobackup-status");
  if (!on || on.dataset.bound === "true") return;
  on.dataset.bound = "true";
  const show = (st) => {
    on.checked = st.enabled;
    dir.value = st.dir || "";
    every.value = String(st.every_hours);
    keep.value = String(st.keep);
    const last = st.last_run ? new Date(st.last_run * 1000).toLocaleString() : t("autobackup_never");
    status.textContent = `${t("autobackup_last")} ${last}${st.last_error ? " — ❌ " + st.last_error : ""}${st.has_passphrase ? "" : " — " + t("autobackup_nopass")}`;
  };
  invoke("autobackup_get").then(show).catch(() => {});
  $("btn-autobackup-save")?.addEventListener("click", async () => {
    try {
      show(await invoke("autobackup_set", {
        enabled: on.checked, dir: dir.value, everyHours: Number(every.value) || 24,
        keep: Number(keep.value) || 7, passphrase: pass.value || null,
      }));
      pass.value = "";
    } catch (e) { status.textContent = `❌ ${e}`; }
  });
  $("btn-autobackup-run")?.addEventListener("click", async () => {
    status.textContent = t("autobackup_running");
    try { status.textContent = `✅ ${await invoke("autobackup_run_now")}`; }
    catch (e) { status.textContent = `❌ ${e}`; }
  });
}

// Appareils de confiance + journal de sécurité (src-tauri/src/devices.rs).
function fmtAgo(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(getLang() === "en" ? "en-GB" : "fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
const DEVICE_ICON = { ios: "📱", web: "🌐", xr: "🥽" };
async function refreshDevices() {
  const box = $("devices-list");
  if (!box) return;
  let list = [];
  try { list = await invoke("devices_list"); } catch {}
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="ios-row"><span class="setting-hint" style="margin:0">${escapeHTML(t("devices_empty"))}</span></div>`;
  }
  for (const d of list) {
    const row = document.createElement("div");
    row.className = "ios-row";
    row.innerHTML = `<span>${DEVICE_ICON[d.kind] || "💻"} <strong></strong><br><small class="setting-hint" style="margin:0"></small></span><button type="button" class="ios-row-action danger" style="width:auto;padding:4px 10px"></button>`;
    row.querySelector("strong").textContent = d.name + (d.biometric ? " · Face ID" : "");
    row.querySelector("small").textContent = `${d.profile_name} — ${t("devices_seen")} ${fmtAgo(d.last_seen)}`;
    const btn = row.querySelector("button");
    btn.textContent = t("devices_revoke");
    // confirm() est inopérant dans la WebView : confirmation en deux temps.
    btn.addEventListener("click", async () => {
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = t("devices_revoke_confirm");
        setTimeout(() => { btn.dataset.armed = ""; btn.textContent = t("devices_revoke"); }, 4000);
        return;
      }
      try { await invoke("device_revoke", { id: d.id }); } catch {}
      refreshDevices();
      refreshSecurityLog();
    });
    box.appendChild(row);
  }
}
const LOG_LABEL = {
  pair: "log_pair", "unlock-code": "log_unlock_code", "unlock-bio": "log_unlock_bio",
  "unlock-local": "log_unlock_local", "unlock-device": "log_unlock_device", revoke: "log_revoke", "bio-key": "log_bio_key",
};
async function refreshSecurityLog() {
  const box = $("security-log");
  if (!box) return;
  let list = [];
  try { list = await invoke("security_log", { limit: 60 }); } catch {}
  box.innerHTML = list.length ? "" : `<div class="ios-row"><span class="setting-hint" style="margin:0">${escapeHTML(t("log_empty"))}</span></div>`;
  for (const e of list) {
    const row = document.createElement("div");
    row.className = "ios-row";
    row.innerHTML = `<span><span></span> <small class="setting-hint" style="margin:0"></small></span><small></small>`;
    const [label, detail] = row.querySelectorAll("span > span, span > small");
    label.textContent = `${e.ok ? "✓" : "✕"} ${t(LOG_LABEL[e.event] || e.event)}${e.device_name ? " — " + e.device_name : ""}`;
    label.style.color = e.ok ? "" : "var(--destructive)";
    detail.textContent = e.detail || "";
    row.lastElementChild.textContent = fmtAgo(e.ts);
    box.appendChild(row);
  }
}

// Coffre de données partagé.
async function refreshVault() {
  const box = $("vault-list");
  if (!box) return;
  let list = [];
  try { list = await invoke("vault_list", { prefix: null }); } catch {}
  box.innerHTML = list.length ? "" : `<div class="ios-row"><span class="setting-hint" style="margin:0">${escapeHTML(t("vault_empty"))}</span></div>`;
  const obj = (o) => Object.entries(o).filter(([, x]) => x !== "" && x != null).map(([k, x]) => `${k} : ${x}`).join(", ");
  const show = (v) => Array.isArray(v)
    ? (v.some((x) => x && typeof x === "object") ? t("hub_items").replace("{n}", v.length) : v.join(", "))
    : (v && typeof v === "object") ? obj(v) : String(v ?? "—");
  for (const e of list) {
    const row = document.createElement("div");
    row.className = "ios-row";
    row.innerHTML = `<span><code></code><br><small class="setting-hint" style="margin:0"></small></span><button type="button" class="ios-row-action danger" style="width:auto;padding:4px 10px">✕</button>`;
    row.querySelector("code").textContent = e.key;
    row.querySelector("small").textContent = `${show(e.value)} · ${e.type}${e.device ? " · " + e.device : ""}`;
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      $("input-vault-key").value = e.key;
      $("input-vault-value").value = typeof e.value === "object" ? JSON.stringify(e.value) : String(e.value ?? "");
      $("select-vault-type").value = ["text", "number", "bool", "list", "dict"].includes(e.type) ? e.type : "text";
    });
    row.querySelector("button").addEventListener("click", async () => { await invoke("vault_delete", { key: e.key }).catch(() => {}); refreshVault(); });
    box.appendChild(row);
  }
}
function initVaultUI() {
  const openVault = $("btn-vault-open");
  if (openVault && !openVault.dataset.bound) { openVault.dataset.bound="true"; openVault.addEventListener("click",()=>openLumenApp("vault")); }
  const btn = $("btn-vault-set");
  if (!btn || btn.dataset.bound === "true") return;
  btn.dataset.bound = "true";
  btn.addEventListener("click", async () => {
    const key = $("input-vault-key").value.trim();
    if (!key) return;
    try {
      await invoke("vault_set", { key, value: $("input-vault-value").value, kind: $("select-vault-type").value });
      $("input-vault-value").value = "";
    } catch (e) { $("input-vault-value").placeholder = `❌ ${e}`; }
    refreshVault();
  });
  window.__TAURI__?.event?.listen?.("vault-changed", () => refreshVault());
  refreshVault();
  initHubUI();
}

// Coffre unifié : sources, partage des sandboxes, recherche.
const HUB_TYPE_ICON = { event: "📅", task: "☑️", note: "📝", contact: "👤", message: "✉️", file: "📦", image: "🖼️", media: "🎞️", document: "📄", table: "🗂️", metric: "📈", list: "📋", value: "🔹", agent: "🤖", item: "•" };
let hubSettings = { disabled: [], excluded_sandboxes: [] };
async function saveHub() {
  try { await invoke("datahub_settings_set", { settings: hubSettings }); } catch {}
  setTimeout(refreshHub, 1500);
}
function hubToggleRow(label, detail, on, onChange) {
  const row = document.createElement("label");
  row.className = "ios-row";
  row.innerHTML = `<span><span class="hub-l"></span><br><small class="setting-hint" style="margin:0"></small></span><input type="checkbox" />`;
  row.querySelector(".hub-l").textContent = label;
  row.querySelector("small").textContent = detail;
  const cb = row.querySelector("input");
  cb.checked = on;
  cb.addEventListener("change", () => onChange(cb.checked));
  return row;
}
async function refreshHub() {
  const box = $("hub-sources");
  if (!box) return;
  let o = { sources: [], types: [], settings: {} };
  try { o = await invoke("datahub_overview"); } catch {}
  hubSettings = { disabled: o.settings?.disabled || [], excluded_sandboxes: o.settings?.excluded_sandboxes || [] };
  const en = getLang() === "en";
  const ago = (ms) => ms ? new Date(ms).toLocaleTimeString(en ? "en-GB" : "fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
  box.innerHTML = "";
  const shown = new Set();
  for (const src of o.sources.filter((x) => !x.id.startsWith("fichiers:"))) {
    shown.add(src.id);
    box.appendChild(hubToggleRow(en ? src.label_en : src.label_fr, `${t("hub_count").replace("{n}", src.count)} · ${ago(src.indexed)}`, true, (on) => {
      hubSettings.disabled = on ? hubSettings.disabled.filter((x) => x !== src.id) : [...new Set([...hubSettings.disabled, src.id])];
      saveHub();
    }));
  }
  for (const id of hubSettings.disabled.filter((x) => !shown.has(x))) {
    box.appendChild(hubToggleRow(id, t("hub_off"), false, (on) => {
      if (on) { hubSettings.disabled = hubSettings.disabled.filter((x) => x !== id); saveHub(); }
    }));
  }
  // Recherche par le sens : passages encodés par l'encodeur LOCAL du Corpus.
  const sem = o.semantic || {};
  const semRow = document.createElement("div");
  semRow.className = "ios-row";
  semRow.innerHTML = `<span><span></span><br><small class="setting-hint" style="margin:0"></small></span>`;
  semRow.querySelector("span span").textContent = t("hub_semantic");
  semRow.querySelector("small").textContent = sem.passages
    ? t("hub_semantic_on").replace("{r}", sem.records).replace("{p}", sem.passages).replace("{m}", sem.model || "")
    : t("hub_semantic_off");
  box.prepend(semRow);
  const sbBox = $("hub-sandboxes");
  let sbs = [];
  try { sbs = await invoke("sandbox_list"); } catch {}
  sbBox.innerHTML = "";
  for (const sb of sbs || []) {
    const src = o.sources.find((x) => x.id === `fichiers:${sb.id}`);
    const on = !hubSettings.excluded_sandboxes.includes(sb.id);
    sbBox.appendChild(hubToggleRow(sb.name, on ? t("hub_count").replace("{n}", src?.count ?? "…") : t("hub_sb_off"), on, (v) => {
      hubSettings.excluded_sandboxes = v ? hubSettings.excluded_sandboxes.filter((x) => x !== sb.id) : [...new Set([...hubSettings.excluded_sandboxes, sb.id])];
      saveHub();
    }));
  }
}
async function searchHub(q) {
  const box = $("hub-results");
  if (!q.trim()) { box.style.display = "none"; return; }
  let recs = [];
  try { recs = await invoke("datahub_query", { args: { text: q, limit: 30 } }); } catch {}
  box.style.display = "";
  box.innerHTML = recs.length ? "" : `<div class="ios-row"><span class="setting-hint" style="margin:0">${escapeHTML(t("hub_none"))}</span></div>`;
  const en = getLang() === "en";
  for (const r of recs) {
    const row = document.createElement("div");
    row.className = "ios-row";
    row.innerHTML = `<span><span class="hub-t"></span><br><small class="setting-hint" style="margin:0"></small></span>`;
    row.querySelector(".hub-t").textContent = `${HUB_TYPE_ICON[r.type] || "•"} ${r.title}`;
    const when = r.start ? new Date(r.start).toLocaleString(en ? "en-GB" : "fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "";
    row.querySelector("small").textContent = [r.app, when, r.status, r.text].filter(Boolean).join(" · ").slice(0, 220);
    box.appendChild(row);
  }
}
function initHubUI() {
  const input = $("input-hub-search");
  if (!input || input.dataset.bound === "true") return;
  input.dataset.bound = "true";
  let timer;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => searchHub(input.value), 250); });
  $("btn-hub-reindex").addEventListener("click", async (ev) => {
    const b = ev.currentTarget;
    const label = b.textContent;
    b.disabled = true; b.textContent = "…";
    try { await invoke("datahub_reindex"); } catch {}
    b.disabled = false; b.textContent = label;
    refreshHub();
  });
  window.__TAURI__?.event?.listen?.("datahub-changed", () => refreshHub());
  refreshHub();
}

// Appareils de confiance, politique de déverrouillage, journal de sécurité.
function initDevicesUI() {
  initVaultUI();
  refreshDevices();
  refreshSecurityLog();
  const req = $("checkbox-unlock-require-code");
  if (req && req.dataset.bound !== "true") {
    req.dataset.bound = "true";
    invoke("unlock_policy_get").then((v) => { req.checked = !!v; }).catch(() => {});
    req.addEventListener("change", () => invoke("unlock_policy_set", { requireCode: req.checked }).catch(() => {}));
  }
}

function initCompanionAuthUI() {
  const idEl = $("companion-identifier");
  const codeEl = $("companion-code");
  const cdEl = $("companion-code-countdown");
  const regenBtn = $("btn-companion-regenerate");
  const qrEl = $("companion-qr");
  const keyEl = $("companion-key");
  if (!codeEl || codeEl.dataset.bound === "true") return;
  codeEl.dataset.bound = "true";
  let lastSecret = null;

  const refreshAccessUrl = async () => {
    const urlEl = $("companion-url");
    if (!urlEl) return;
    try {
      const info = await invoke("companion_start");
      if (info?.url) {
        urlEl.textContent = info.url;
        urlEl.dataset.url = info.url;
        urlEl.title = [info.url, info.http_url && `HTTP : ${info.http_url}`].filter(Boolean).join("  •  ");
        invoke("companion_tls_fingerprint").then((fp) => { const el = $("companion-tls-fp"); if (el) el.textContent = fp; }).catch(() => {});
        const qrUrlEl = $("companion-url-qr");
        if (qrUrlEl) {
          qrUrlEl.innerHTML = info.url_qr_svg || "";
          qrUrlEl.title = info.url;
          $("companion-url-qr-row").hidden = !info.url_qr_svg;
        }
        const xrEl = $("companion-xr-url");
        if (xrEl) xrEl.textContent = info.xr_url || "—";
      } else {
        urlEl.textContent = "—";
      }
    } catch {
      urlEl.textContent = "—";
    }
  };

  // Profil dont on affiche les clés. Vide = profil actif du Mac.
  const profileSelect = $("select-companion-profile");
  let selectedProfile = "";

  const refreshProfiles = async () => {
    if (!profileSelect) return;
    let profiles = [];
    try { profiles = await invoke("companion_auth_profiles"); } catch {}
    profileSelect.innerHTML = profiles
      .map((p) => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name || p.id)}</option>`)
      .join("");
    // Un seul profil : le sélecteur n'apprend rien, on le masque.
    profileSelect.closest(".ios-row").hidden = profiles.length < 2;
    if (selectedProfile) profileSelect.value = selectedProfile;
    selectedProfile = profileSelect.value || "";
  };

  const refreshInfo = async () => {
    let info = null;
    try { info = await invoke("companion_auth_info", { profileId: selectedProfile || null }); } catch {}
    if (!info) {
      codeEl.textContent = "——————";
      return;
    }
    codeEl.textContent = info.current_code || "——————";
    // Le profil réellement servi fait foi (au premier affichage, le backend
    // choisit l'actif) : sans cela, changer d'identifiant viserait le mauvais.
    selectedProfile = info.profile_id || selectedProfile;
    if (profileSelect && profileSelect.value !== selectedProfile) profileSelect.value = selectedProfile;
    if (cdEl) cdEl.textContent = `${info.seconds_remaining}s`;
    // Le nom du profil EST l'identifiant : rien à configurer, rien à retenir.
    if (idEl) idEl.textContent = info.profile_name || "—";
    if (info.secret_base32 !== lastSecret) {
      lastSecret = info.secret_base32;
      if (qrEl) { qrEl.innerHTML = info.qr_svg || ""; qrEl.title = info.otpauth_uri || ""; }
      if (keyEl) { keyEl.textContent = info.secret_base32 || "—"; keyEl.title = info.otpauth_uri || ""; }
    }
  };
  profileSelect?.addEventListener("change", () => {
    selectedProfile = profileSelect.value;
    lastSecret = null;   // force le réaffichage du QR et de la clé
    refreshInfo();
  });
  regenBtn?.addEventListener("click", async () => {
    if (!confirm("Révoquer la clé actuelle et en générer une nouvelle ?")) return;
    await invoke("companion_regenerate_secret", { profileId: selectedProfile || null }).catch(() => {});
    refreshInfo();
  });
  refreshProfiles().then(refreshInfo);
  refreshAccessUrl();
  initDevicesUI();
  setInterval(async () => {
    const pane = document.querySelector('.settings-tab-pane[data-pane="companion"]');
    if (!pane?.classList.contains("active")) return;
    const current = parseInt(cdEl?.textContent, 10);
    if (Number.isNaN(current) || current <= 1) await refreshInfo();
    else if (cdEl) cdEl.textContent = `${current - 1}s`;
  }, 1000);
  refreshInfo();
}

function bindActions() {
  $("btn-close-settings")?.addEventListener("click", () => {
    if (!embeddedInWorkspace && !llamaStartFailed) currentWindow?.close?.();
  });
  $("btn-save-settings")?.addEventListener("click", saveSettings);
  $("select-ai-source")?.addEventListener("change", handleAiSourceChange);
  $("select-model")?.addEventListener("change", renderModelExpectations);
  $("select-model-llama")?.addEventListener("change", renderModelExpectations);
  $("btn-bar-tour")?.addEventListener("click", () => {
    // La visite se joue dans la fenêtre de la barre, pas dans les Paramètres.
    tauriEvent?.emit?.("bar-tour-replay", {});
  });
  $("select-image-provider")?.addEventListener("change", () => {
    toggleImageProviderSettings();
    renderImageModels();
  });
  $("select-image-model")?.addEventListener("change", () => {
    const provider = $("select-image-provider")?.value || defaults.imageProvider;
    localStorage.setItem(imageModelKey(provider), $("select-image-model").value);
    pushImageConfig(invoke);
    renderImageModelHints();
  });
  $("btn-image-model-refresh")?.addEventListener("click", () => renderImageModels(true));
  $("select-heartbeat-frequency")?.addEventListener("change", (event) => {
    if ($("heartbeat-cron-row")) $("heartbeat-cron-row").style.display = event.target.value === "custom" ? "block" : "none";
  });
  $("select-heartbeat-engine")?.addEventListener("change", syncHeartbeatEngineRows);
  // Mode performance : effet visible tout de suite dans cette fenêtre, et le
  // trait est écrit immédiatement pour que les autres fenêtres suivent par
  // l'évènement `storage`. L'orbe, lui, est déjà construit dans la barre : sa
  // suppression ne peut se faire qu'au prochain démarrage, et on le dit.
  $("checkbox-perf-mode")?.addEventListener("change", (event) => {
    const on = !!event.target.checked;
    localStorage.setItem("lumenPerfMode", String(on));
    document.documentElement.classList.toggle("perf-mode", on);
    const hint = document.querySelector('[data-i18n="hint_perf_mode"]');
    if (hint) hint.classList.add("needs-restart");
  });
  document.querySelectorAll('input[type="range"]').forEach((input) => input.addEventListener("input", updateLabels));
  document.querySelectorAll('#checkbox-always-on-top, #checkbox-halo, #select-halo-position, #select-halo-style, #checkbox-orb-moods, #checkbox-ui-sounds, #select-halo-rest, #slider-halo-hold, #checkbox-halo-agents, #checkbox-halo-clock, #checkbox-halo-sticky, #checkbox-bar-opaque, #slider-transparency, #select-bar-size')
    .forEach((input) => {
      const eventName = input.tagName === "SELECT" || input.type === "checkbox" ? "change" : "input";
      input.addEventListener(eventName, () => {
        emitSettingsDraft(collectImmediateSettings());
      });
    });
  // Le thème s'applique TOUT DE SUITE, ici et dans les autres fenêtres : un
  // thème qui n'apparaîtrait qu'après « Enregistrer » ne se choisit pas, il se
  // devine. `setTheme` écrit la clé unifiée et les deux anciennes ; il reste à
  // recopier la valeur dans la clé PRÉFIXÉE PAR PROFIL que lit le bureau.
  // Fond d'écran : les Paramètres n'ouvrent pas le sélecteur eux-mêmes, ils le
  // DEMANDENT au bureau (cf. applySettingsPayload dans sandbox/desktop.js). Le
  // sélecteur montre un aperçu sur la vraie surface, widgets compris ; en avoir
  // une seconde version ici aurait fait deux choses à maintenir.
  $("btn-wallpaper")?.addEventListener("click", () => {
    emitSettingsDraft({ openWallpaper: true });
  });

  $("select-theme")?.addEventListener("change", () => {
    const choice = setTheme($("select-theme").value);
    try { localStorage.setItem(wsKey("dtTheme"), choice); } catch { /* stockage indisponible */ }
    emitSettingsDraft(collectWorkspaceSettings());
    emitSettingsDraft(collectImmediateSettings());
  });
  document.querySelectorAll('#checkbox-orb, #select-avatar-model, #slider-avatar-glb-light, #select-orb-theme, #slider-orb-size, #slider-orb-core, #slider-orb-pulse, #select-orb-glass, #orb-color-0, #orb-color-1, #orb-color-2, #orb-color-3, #orb-color-4, #checkbox-orb-heartbeat, #orb-heart-color, #slider-orb-pulse-strength, #slider-orb-pulse-speed')
    .forEach((input) => input.addEventListener("input", () => emitSettingsDraft(collectAvatarSettings())));
  $("select-orb-theme")?.addEventListener("change", () => { updateCharacterControls(); emitSettingsDraft(collectAvatarSettings()); });
  // L'habillage Pro s'applique TOUT DE SUITE, dans cette fenêtre comme dans les
  // autres : `setProFlavor` repose l'attribut ici, et les autres fenêtres
  // suivent par l'évènement `storage`. Un habillage qui n'apparaîtrait qu'après
  // « Enregistrer » ne se choisit pas, il se devine.
  $("select-pro-flavor")?.addEventListener("change", (e) => {
    setProFlavor(e.target.value);
    // La palette de l'orbe suit la saveur, sauf si l'utilisateur a choisi la
    // sienne : un réglage à lui ne se reprend pas.
    if (!localStorage.getItem("orbColors")) {
      emitSettingsDraft(collectAvatarSettings());
    }
  });
  $("select-orb-glass")?.addEventListener("change", () => emitSettingsDraft(collectAvatarSettings()));
  $("checkbox-orb")?.addEventListener("change", () => emitSettingsDraft(collectAvatarSettings()));
  $("checkbox-orb-heartbeat")?.addEventListener("change", () => emitSettingsDraft(collectAvatarSettings()));
  $("select-avatar-model")?.addEventListener("change", updateAvatarModelUI);
  document.querySelectorAll('#select-robot-shape, #robot-color, #robot-trimColor, #robot-screenColor, #slider-robot-speed, #robot-paused, #robot-antenna, #robot-floorShadow, #robot-interactive')
    .forEach(input => input.addEventListener('input', () => { updateRobotPreview(); emitSettingsDraft(collectAvatarSettings()); }));
  $('slider-orb-size')?.addEventListener('input', updateRobotPreview);
  $('select-robot-preview-state')?.addEventListener('change', updateRobotPreview);
  $('btn-robot-reset')?.addEventListener('click', () => { setField('slider-orb-size', 116); setField('select-robot-preview-state', 'idle'); loadRobotOptions(ROBOT_DEFAULTS); updateLabels(); emitSettingsDraft(collectAvatarSettings()); });
  // Synthèse vocale locale : voix active, catalogue et test synchronisé.
  $("select-tts-voice")?.addEventListener("change", (e) => {
    const id = e.target.value;
    if (id) invoke("tts_set_voice", { voice: id }).catch(() => {});
    refreshTtsTuning(id);
  });
  initTtsTuningUI();
  $("btn-tts-refresh")?.addEventListener("click", () => refreshTtsUI());
  $("btn-tts-install")?.addEventListener("click", installTtsRuntime);
  $("btn-mcp-refresh")?.addEventListener("click", () => { refreshMcpServers(); refreshMcpCatalog(); });
  $("btn-toolbox-refresh")?.addEventListener("click", () => { refreshToolbox().catch(() => {}); });
  $("btn-toolbox-all-on")?.addEventListener("click", () => toolboxSetAll(true));
  $("btn-toolbox-all-off")?.addEventListener("click", () => toolboxSetAll(false));
  $("btn-mcp-add")?.addEventListener("click", addMcpServerManually);
  $("btn-mcp-import")?.addEventListener("click", importMcpServersJson);
  $("select-mcp-transport")?.addEventListener("change", updateMcpTransportFields);
  $("select-mcp-server")?.addEventListener("change", refreshMcpTools);
  $("btn-tts-test")?.addEventListener("click", async () => {
    ttsStatus(t("tts_testing"));
    let unError = null, unEnded = null;
    try {
      let settle;
      const completed = new Promise((resolve, reject) => {
        let done = false;
        settle = (error) => {
          if (done) return;
          done = true;
          error ? reject(new Error(String(error))) : resolve();
        };
      });
      if (tauriEvent?.listen) {
        unError = await tauriEvent.listen("tts-error", (event) => settle(event.payload));
        unEnded = await tauriEvent.listen("tts-ended", () => settle());
      }
      await invoke("tts_speak", { text: t("tts_test_phrase"), voice: null });
      if (tauriEvent?.listen) {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(() => reject(new Error(t("tts_test_timeout"))), 30000)),
        ]);
      }
      ttsStatus(t("tts_test_ok"));
    } catch (e) {
      ttsStatus("Échec : " + (e?.message || e));
    } finally {
      unError?.();
      unEnded?.();
    }
  });
  $("select-speech-backend")?.addEventListener("change", updateVoiceDictationModeUI);
  $("btn-refresh-loaded")?.addEventListener("click", populateModels);
  $("input-ollama-url")?.addEventListener("change", populateModels);
  $("btn-refresh-llama-models")?.addEventListener("click", populateLlamaModels);
  $("btn-refresh-ollama-catalog")?.addEventListener("click", () => refreshOllamaCatalog());
  $("btn-ollama-pull")?.addEventListener("click", () => {
    const input = $("input-ollama-pull");
    const name = input?.value.trim();
    if (!name) { setOllamaPullStatus(t("ollama_pull_need_name"), true); return; }
    pullOllamaModel(name);
  });
  $("input-ollama-pull")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("btn-ollama-pull")?.click(); }
  });
  $("select-model-llama")?.addEventListener("change", (event) => localStorage.setItem("selectedModel", event.target.value));
  $("select-llama-backend")?.addEventListener("change", async (event) => {
    // Enregistré tout de suite côté Rust : c'est lui qui fait autorité au
    // prochain démarrage, y compris si la fenêtre est fermée sans « Enregistrer ».
    try { await invoke("llama_set_backend", { backend: event.target.value }); } catch (e) {
      // Un échec d'écriture silencieux se manifestait par un réglage qui
      // « revient tout seul sur Automatique » à la réouverture, sans aucune
      // trace visible. Le dire ici évite de chercher un bug d'interface.
      console.warn("Backend llama.cpp non enregistré :", e);
      const el = $("llama-backend-status");
      if (el) {
        el.textContent = `${t("llama_backend_save_failed")} ${String(e?.message || e)}`;
        el.style.color = "var(--danger)";
      }
      return;
    }
    await refreshLlamaBackendUI().catch(() => {});
  });
  $("select-llama-num-ctx")?.addEventListener("change", (event) => {
    localStorage.setItem("llamaNumCtx", String(Number.parseInt(event.target.value, 10) || 8192));
  });
  $("btn-open-help")?.addEventListener("click", () => invoke("open_docs"));
  $("btn-open-onboarding")?.addEventListener("click", () => invoke("open_onboarding"));
  $("btn-open-sandbox")?.addEventListener("click", () => invoke("open_sandbox_explorer"));
  $("btn-open-agents")?.addEventListener("click", () => invoke("open_agents_manager"));
  wireOllamaImageUI();
  // Moteur Bonsai embarqué : modèles, téléchargements, démarrage (lib/bonsai-panel.js).
  mountBonsaiPanel({
    invoke, listen: TAURI?.event?.listen, t,
    onChange: () => { if ($("select-image-provider")?.value === "bonsai") renderImageModels(); },
  });
  wireRagUI();
  $("btn-orb-colors-reset")?.addEventListener("click", () => {
    defaults.orbColors.forEach((color, i) => setField(`orb-color-${i}`, color));
    emitSettingsDraft(collectAvatarSettings());
  });
  $("btn-orb-heart-color-reset")?.addEventListener("click", () => {
    setField("orb-heart-color", "#ff4d6d");
    emitSettingsDraft(collectAvatarSettings());
  });
  $("btn-orb-pulse-preview")?.addEventListener("click", () => emitSettingsDraft({ ...collectAvatarSettings(), previewPulse: "true" }));
  initCustomAvatarUI();
  initProfileUI();
  initSharedMemoryUI();
  initCompanionAuthUI();
  document.querySelectorAll(".ios-segmented").forEach((group) => {
    group.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-val]");
      if (!btn) return;
      group.dataset.value = btn.dataset.val;
      group.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
}

// ===== Base de connaissances (RAG) =====
// La gestion complète (import, liste, recherche) vit dans l'app dédiée
// « Connaissances ». Ici on affiche juste un résumé + un bouton d'ouverture.
function ragSetStatus(msg) { const el = $("rag-status"); if (el) el.textContent = msg; }

async function refreshRag() {
  try {
    const st = await invoke("rag_status");
    const docs = st?.docs || 0, chunks = st?.chunks || 0;
    if (docs > 0) {
      const model = st.embed_model ? ` · modèle ${st.embed_model}` : "";
      ragSetStatus(`${docs} document(s), ${chunks} extrait(s) indexés${model}.`);
    } else {
      ragSetStatus("Base vide — ouvrez la base pour importer des documents.");
    }
  } catch (e) { ragSetStatus("Indisponible."); }
}

// ===== Embeddings : modèle GGUF servi par le llama.cpp intégré =============
//
// Deux encodeurs au catalogue, tous deux hors du serveur de discussion : un
// llama-server ne charge qu'un modèle, donc l'indexation tourne sur son propre
// processus (port 11436). Le choix est mémorisé côté RAG, pas dans la config
// d'IA : on peut discuter avec une API cloud et encoder ses documents en local.

// Le catalogue vit dans lib/embed-models.js : l'app Connaissances propose le
// même choix, et une entrée ajoutée doit apparaître aux deux endroits.

let embedInstalled = [];

function embedSetStatus(text, isError = false) {
  const el = $("embed-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-error", !!isError);
}

async function refreshEmbedUI() {
  const select = $("select-embed-model");
  const btn = $("btn-embed-download");
  const warn = $("embed-index-warning");
  if (!select) return;
  let pref = "auto", indexedWith = null;
  try {
    const cfg = await invoke("rag_get_embed_pref");
    pref = cfg?.pref || "auto";
    indexedWith = cfg?.indexed_with || null;
  } catch { /* base RAG pas encore créée : « auto » convient */ }
  try {
    const st = await invoke("llama_embed_status");
    embedInstalled = st?.installed || [];
    if (st?.running && st?.model) embedSetStatus(t("embed_running", { model: st.model }));
    else embedSetStatus("");
  } catch { embedInstalled = []; }

  select.value = pref;
  const chosen = select.value;
  const isGguf = chosen !== "auto";
  const installed = isGguf && embedInstalled.includes(chosen);
  if (btn) {
    btn.hidden = !isGguf || installed;
    btn.textContent = t("btn_embed_download");
  }
  if (isGguf && !installed) embedSetStatus(t("embed_missing", { size: formatBytes(EMBED_CATALOG[chosen]?.sizeBytes || 0) }));
  else if (isGguf && installed && !$("embed-status").textContent) embedSetStatus(t("embed_ready"));

  // Changer d'encodeur alors que la base est déjà indexée avec un autre rendrait
  // les vecteurs incomparables : l'avertir ici plutôt qu'à la première erreur.
  if (warn) {
    const conflict = isGguf && indexedWith && indexedWith !== chosen;
    warn.hidden = !conflict;
    if (conflict) warn.textContent = t("embed_reindex_warning", { model: indexedWith });
  }
}

function initEmbedUI() {
  const select = $("select-embed-model");
  const btn = $("btn-embed-download");
  if (!select || select.dataset.bound === "true") return;
  select.dataset.bound = "true";
  // Options tirées du catalogue (lib/embed-models.js) : la liste écrite en dur
  // dans le HTML oubliait chaque nouvel encodeur (EmbeddingGemma 2…).
  const auto = select.querySelector('option[value="auto"]');
  select.replaceChildren(...[auto].filter(Boolean), ...Object.entries(EMBED_CATALOG).map(([filename, entry]) => {
    const opt = document.createElement("option");
    opt.value = filename;
    opt.textContent = `${entry.label} · ${formatBytes(entry.sizeBytes || 0)}`;
    return opt;
  }));

  select.addEventListener("change", async () => {
    try {
      await invoke("rag_set_embed_pref", { model: select.value });
    } catch (e) {
      embedSetStatus(String(e?.message || e), true);
      return;
    }
    await refreshEmbedUI();
  });

  btn?.addEventListener("click", async () => {
    const filename = select.value;
    const entry = EMBED_CATALOG[filename];
    if (!entry) return;
    btn.disabled = true;
    embedSetStatus(t("llama_downloading"));
    try {
      await invoke("llama_download_model", {
        request: { id: entry.id, url: entry.url, filename, mmprojFilename: null, mmprojUrl: null },
      });
      embedSetStatus(t("embed_ready"));
    } catch (e) {
      embedSetStatus(t("llama_download_error", { error: String(e?.message || e) }), true);
    } finally {
      btn.disabled = false;
      await refreshEmbedUI();
    }
  });
}

// ===== Moteur d'image Ollama =====
// Le sélecteur de modèle est commun aux trois moteurs (renderImageModels) ; il
// ne reste ici que l'essai de bout en bout, seul moyen de savoir si le modèle
// désigné sait réellement produire une image (Ollama n'expose rien d'autre).
function wireOllamaImageUI() {
  const btn = $("btn-image-ollama-test");
  const status = $("image-ollama-status");
  if (!btn || btn.dataset.bound === "true") return;
  btn.dataset.bound = "true";
  btn.addEventListener("click", async () => {
    const model = $("select-image-model")?.value || defaults.imageOllamaModel;
    btn.disabled = true;
    if (status) status.textContent = t("image_ollama_testing");
    try {
      await invoke("bonsai_generate_data_url", {
        prompt: "a small blue circle on white background",
        width: 512, height: 512, seed: null, steps: null, backend: null,
        provider: "ollama",
        apiBase: localStorage.getItem("ollamaUrl") || DEFAULT_OLLAMA_URL,
        apiKey: "",
        apiModel: model,
      });
      if (status) status.textContent = t("image_ollama_ok").replace("{model}", model);
    } catch (e) {
      if (status) status.textContent = `${t("image_ollama_ko")} ${imageErrorMessage(e, "ollama")}`;
    } finally { btn.disabled = false; }
  });
}

function wireRagUI() {
  $("btn-open-knowledge")?.addEventListener("click", () => invoke("open_knowledge").catch(() => {}));
}

// ===== Onglet Notifications : sons par type =====
function initNotifSoundsUI() {
  const wrap = $("notif-sound-rows");
  if (!wrap || wrap.dataset.bound === "true") return;
  wrap.dataset.bound = "true";
  const prefs = notifSoundPrefs();
  for (const type of NOTIF_TYPES) {
    const row = document.createElement("div");
    row.className = "setting-item";
    row.style.display = "flex"; row.style.flexDirection = "row"; row.style.alignItems = "center"; row.style.gap = "10px";
    const label = document.createElement("label");
    label.innerHTML = `<span class="notif-type-ic">${icon(type.icon || "bell")}</span>`;
    label.appendChild(document.createTextNode(t(`notif_type_${type.id}`)));
    label.style.flex = "1"; label.style.margin = "0";
    label.style.display = "flex"; label.style.alignItems = "center"; label.style.gap = "8px";
    const sel = document.createElement("select");
    sel.style.maxWidth = "180px";
    sel.innerHTML = NOTIF_SOUNDS.map((s) => `<option value="${s.id}"${prefs[type.id] === s.id ? " selected" : ""}>${t(`notif_sound_${s.id}`)}</option>`).join("");
    sel.addEventListener("change", () => {
      const cur = notifSoundPrefs();
      cur[type.id] = sel.value;
      saveNotifSoundPrefs(cur);
      playSound(sel.value);
    });
    const play = document.createElement("button");
    play.type = "button";
    play.className = "settings-save-btn secondary-action compact";
    play.innerHTML = icon("play");
    play.title = t("notif_listen");
    play.addEventListener("click", () => playSound(sel.value));
    row.append(label, sel, play);
    wrap.appendChild(row);
  }
  initNotifLedUI();
}

// Couleur des notifications lumineuses (bandeau LED du Lumen Controller).
function initNotifLedUI() {
  const input = $("input-notif-led-color");
  if (!input || input.dataset.bound === "true") return;
  input.dataset.bound = "true";
  input.value = notifLedColor();
  const status = $("notif-led-status");
  const setStatus = (msg) => { if (status) status.textContent = msg || ""; };

  // Le contrôleur énumère ses capacités dans son message « hello », que le pont
  // de la fenêtre principale recopie dans localStorage. On peut donc distinguer
  // deux échecs très différents : le message n'est pas parti (lien coupé), ou il
  // est parti vers un firmware qui ne sait pas encore le traiter — cas d'un
  // Lumen Controller dont les .py n'ont pas été repoussés depuis l'ajout des
  // notifications lumineuses. Renvoie true seulement si on SAIT que la capacité
  // manque : sans « hello » connu, on n'affirme rien.
  const missingNotifyLeds = () => {
    for (const d of ORB_DEVICES) {
      let caps = null;
      try { caps = JSON.parse(localStorage.getItem("controllerCaps:" + d.device) || "null"); }
      catch { caps = null; }
      if (Array.isArray(caps) && caps.includes("notify_leds")) return false;
    }
    // Au moins un appareil s'est présenté, et aucun n'annonce la capacité.
    return ORB_DEVICES.some((d) => localStorage.getItem("controllerCaps:" + d.device));
  };

  // Reconnecte un appareil dont l'adresse est connue. Le lien vit côté Rust et
  // meurt avec le contrôleur (veille, Wi-Fi qui saute, firmware relancé) : sans
  // cette relance, le bouton restait définitivement muet jusqu'au prochain
  // redémarrage de Lumen.
  const reconnect = async (device) => {
    const spec = ORB_DEVICES.find((d) => d.device === device);
    const host = (spec && localStorage.getItem(spec.hostKey) || "").trim();
    if (!host) return false;
    const port = parseInt(localStorage.getItem(spec.portKey) || "8787", 10);
    try { await invoke("orb_connect", { host, port, device }); return true; } catch { return false; }
  };

  // Le pont vit dans la fenêtre principale ; depuis les Réglages on parle
  // directement au backend. Les deux liens sont tentés : le contrôleur peut
  // avoir été renseigné dans l'un ou l'autre champ d'adresse.
  const flash = async (color) => {
    const line = JSON.stringify({ notification: {
      text: t("notif_led_test_text"), source: "Lumen", success: true, count: 1, color,
    } });
    const errors = [];
    let sent = 0;
    for (const device of ["controller", "orb"]) {
      try {
        await invoke("orb_send", { line, device });
        sent += 1;
      } catch (e) {
        // Deuxième chance : on rétablit le lien puis on renvoie une fois.
        if (await reconnect(device)) {
          try { await invoke("orb_send", { line, device }); sent += 1; continue; } catch (e2) { e = e2; }
        }
        errors.push(String(e?.message || e));
      }
    }
    // L'échec était jusqu'ici avalé (`catch(() => {})`) : un bouton « Tester »
    // qui ne fait rien ET ne dit rien ne laisse aucune prise au diagnostic.
    if (sent) setStatus(missingNotifyLeds() ? t("notif_led_old_firmware") : t("notif_led_sent"));
    else if (ORB_DEVICES.every((d) => !localStorage.getItem(d.hostKey))) setStatus(t("notif_led_no_host"));
    else setStatus(t("notif_led_failed", { error: errors.join(" · ") }));
  };
  input.addEventListener("change", () => {
    saveNotifLedColor(input.value);
    flash(notifLedColor());
  });
  $("btn-notif-led-test")?.addEventListener("click", () => { setStatus("…"); flash(notifLedColor()); });
}

// Verrouillage du profil actif : l'état vit CÔTÉ RUST, par profil/session.
function initLockUI() {
  const chk = $("checkbox-lock-enabled"), pass = $("input-lock-pass");
  const save = $("btn-lock-save"), clear = $("btn-lock-clear"), status = $("lock-status");
  if (!chk || chk.dataset.bound === "true") return;
  chk.dataset.bound = "true";
  const refresh = async () => {
    const st = await invoke("session_lock_status").catch(() => ({}));
    chk.checked = !!st?.enabled;
    if (status) {
      status.textContent = st?.has_password
        ? t("profile_lock_has_password")
        : t("profile_lock_no_password");
    }
    chk.dataset.hasPassword = st?.has_password ? "true" : "false";
    // Plus de mot de passe : le champ « actuel » n'a plus d'objet et ne doit
    // pas rester à l'écran avec une saisie dedans.
    if (!st?.has_password) {
      const cur = $("input-lock-current");
      if (cur) { cur.value = ""; cur.hidden = true; }
    }
    const rfidStatus = $("profile-rfid-status");
    if (rfidStatus && !rfidStatus.dataset.transient) {
      rfidStatus.textContent = st?.has_rfid
        ? t("profile_rfid_present")
        : t("profile_rfid_absent");
    }
  };
  window.__refreshProfileLockUI = refresh;

  // Mot de passe actuel : champ MASQUÉ dans la page, jamais `prompt()`.
  //
  // `prompt()` posait deux problèmes à la fois. Il affiche la saisie EN CLAIR —
  // un mot de passe tapé devant quelqu'un, ou sur une capture d'écran, est un
  // mot de passe perdu ; et dans la webview Tauri de macOS (WKWebView) il ne
  // s'affiche pas du tout et renvoie `null` en silence, si bien que le bouton
  // semblait ne rien faire. La section RFID juste en dessous avait déjà réglé
  // le problème de cette façon : on s'aligne dessus.
  const current = $("input-lock-current");
  const needsCurrent = () => chk.dataset.hasPassword === "true";

  /// Révèle le champ et rend la main si le mot de passe actuel manque encore.
  /// `null` = l'appelant doit s'arrêter là.
  const requireCurrentPassword = () => {
    if (!needsCurrent()) return null;
    const value = current?.value || "";
    if (!value) {
      if (current) { current.hidden = false; current.focus(); }
      if (status) status.textContent = t("profile_lock_need_current");
      return undefined;
    }
    return value;
  };

  /// Après un changement réussi, le champ ne doit pas garder le mot de passe.
  const clearCurrent = () => {
    if (!current) return;
    current.value = "";
    current.hidden = true;
  };

  chk.addEventListener("change", async () => {
    // Activer la protection ne demande rien ; la retirer exige de prouver qu'on
    // la connaît, sinon une session déjà ouverte suffirait à la lever.
    const currentPassword = !chk.checked ? requireCurrentPassword() : null;
    if (currentPassword === undefined) { chk.checked = true; return; }
    try {
      await invoke("session_set_enabled", { enabled: chk.checked, currentPassword });
      clearCurrent();
    } catch (e) {
      if (status) status.textContent = String(e);
      chk.checked = !chk.checked;
    }
    refresh();
  });
  save?.addEventListener("click", async () => {
    const v = (pass?.value || "").trim();
    if (!v) { if (status) status.textContent = t("profile_lock_enter_password"); return; }
    const currentPassword = requireCurrentPassword();
    if (currentPassword === undefined) return;
    try {
      await invoke("session_set_password", { password: v, currentPassword });
      if (pass) pass.value = "";
      clearCurrent();
    } catch (e) { if (status) { status.textContent = String(e); return; } }
    refresh();
  });
  clear?.addEventListener("click", async () => {
    const currentPassword = requireCurrentPassword();
    if (currentPassword === undefined) return;
    try {
      await invoke("session_clear_password", { currentPassword });
      clearCurrent();
    } catch (e) { if (status) { status.textContent = String(e); return; } }
    refresh();
  });
  initProfileRfidUI(refresh);
  refresh();
}

// Badge d'ouverture de session, lié au PROFIL (et non à une action).
//
// Tout se vérifie côté Rust : l'UID est haché avec sel dans le fichier de
// profils, jamais dans une webview. Lier ou retirer un badge exige le mot de
// passe courant, sinon quiconque a la main sur une session déjà ouverte
// pourrait s'ajouter un accès permanent en silence.
function initProfileRfidUI(refreshLock) {
  const btnScan = $("btn-profile-rfid-scan");
  const btnClear = $("btn-profile-rfid-clear");
  const status = $("profile-rfid-status");
  const passInput = $("input-profile-rfid-pass");
  if (!btnScan || btnScan.dataset.bound === "true") return;
  btnScan.dataset.bound = "true";

  let scanning = false;
  let unlisten = null;
  const setStatus = (msg) => { if (status) status.textContent = msg; };
  const needsPassword = () => $("checkbox-lock-enabled")?.dataset.hasPassword === "true";

  // PAS de prompt() ici : dans la webview Tauri (WKWebView), prompt() et
  // confirm() ne s'affichent pas et renvoient null en silence. Le bouton
  // semblait alors « ne rien faire ». On utilise un champ en clair dans la
  // page, révélé seulement quand le profil a effectivement un mot de passe.
  const currentPassword = () => {
    if (!needsPassword()) return null;
    return passInput?.value || "";
  };
  const checkPassword = () => {
    if (!needsPassword()) return true;
    if (passInput && !passInput.value) {
      passInput.hidden = false;
      passInput.focus();
      setStatus(t("profile_rfid_need_password"));
      return false;
    }
    return true;
  };

  const stopScan = () => {
    scanning = false;
    btnScan.textContent = t("profile_rfid_bind");
    setRfidPairing(false);
    if (unlisten) { try { unlisten(); } catch (e) {} unlisten = null; }
  };

  btnScan.addEventListener("click", async () => {
    if (scanning) { stopScan(); setStatus(""); return; }
    if (!tauriEvent) { setStatus(t("rfid_no_bridge")); return; }
    // Le mot de passe est exigé AVANT la détection : inutile de faire passer
    // un badge pour découvrir ensuite qu'on ne peut pas l'enregistrer.
    if (!checkPassword()) return;
    const password = currentPassword();
    scanning = true;
    btnScan.textContent = t("btn_rfid_cancel");
    setStatus(t("rfid_waiting"));
    setRfidPairing(true);              // un badge déjà posé doit être capturé
    unlisten = await tauriEvent.listen("orb-command", async (e) => {
      const p = e?.payload || {};
      if (p.cmd !== "rfid" || !p.uid || !scanning) return;
      stopScan();
      try {
        await invoke("session_set_rfid", { uid: String(p.uid), currentPassword: password });
        if (passInput) { passInput.value = ""; passInput.hidden = true; }
        setStatus(t("profile_rfid_bound"));
      } catch (err) {
        setStatus(String(err));
      }
      refreshLock?.();
    });
  });

  btnClear?.addEventListener("click", async () => {
    if (!checkPassword()) return;
    try {
      await invoke("session_clear_rfid", { currentPassword: currentPassword() });
      if (passInput) { passInput.value = ""; passInput.hidden = true; }
      setStatus(t("profile_rfid_removed"));
    } catch (err) {
      setStatus(String(err));
    }
    refreshLock?.();
  });
}

// ===== Modèles de l'API cloud =====
// Deux sources, dans cet ordre : les modèles réellement servis par l'endpoint
// configuré (`GET {api_base}/models` via le backend, clé jamais exposée), et à
// défaut un catalogue de suggestions par fournisseur. Le champ reste une saisie
// libre : la `datalist` propose, elle n'impose pas.
let apiModelsLoaded = "";

function fillApiModelList(models, note) {
  const list = $("api-model-list");
  const status = $("api-models-status");
  if (list) {
    list.innerHTML = "";
    for (const m of models) list.appendChild(new Option(m));
  }
  refreshOrchestrateModelSelects();
  if (status) status.textContent = note || "";
}

function applySuggestedApiModels() {
  const base = $("input-api-base")?.value.trim() || val("apiBaseUrl", defaults.apiBaseUrl);
  const models = suggestedModels(base);
  const name = providerName(base);
  fillApiModelList(
    models,
    models.length ? t("api_models_suggested", { provider: name }) : t("api_models_hint"),
  );
}

async function refreshApiModels() {
  const status = $("api-models-status");
  if (status) status.textContent = t("api_models_loading");
  try {
    const loaded = await invoke("llm_api_models");
    if (!loaded.length) throw new Error(t("api_models_empty"));
    const base = $("input-api-base")?.value.trim() || val("apiBaseUrl", defaults.apiBaseUrl);
    // Les principaux d'abord : la liste reste exhaustive, mais utilisable.
    const models = prioritiseModels(loaded, base);
    apiModelsLoaded = models.join("\n");
    fillApiModelList(models, t("api_models_loaded", { n: models.length }));
  } catch (e) {
    // Repli sur les suggestions : l'endpoint peut être injoignable, sans clé
    // enregistrée, ou ne pas exposer /models.
    const base = $("input-api-base")?.value.trim() || val("apiBaseUrl", defaults.apiBaseUrl);
    const models = suggestedModels(base);
    fillApiModelList(models, `${e?.message || e}`);
  }
}

/** Modèle à pousser dans `api_model` pour une source « API » donnée. */
function cloudModelFor(source) {
  if (source === "lumen") return val("lumenModel", "");
  if (source === "applefm") return val("applefmModel", APPLEFM_DEFAULT_MODEL);
  return val("apiModel", defaults.apiModel);
}

// ---------- Apple Foundation Models (macOS 27) ----------
// Même règle que Lumen Server : l'option n'apparaît que si la passerelle est
// embarquée et qu'Apple Intelligence répond. Les modèles réellement
// utilisables (Private Cloud Compute exige un entitlement) sont filtrés.
async function refreshAppleFmOption(force = false) {
  const opt = $("select-ai-source")?.querySelector('option[value="applefm"]');
  const st = await appleFmBackendState(force);
  if (opt) opt.hidden = !st.available;
  const select = $("select-applefm-model");
  if (select) {
    const models = Array.isArray(st.models) ? st.models : [];
    for (const option of [...select.options]) {
      const info = models.find((m) => m.id === option.value);
      const usable = !!(info && info.available);
      option.disabled = !usable;
      option.hidden = !usable && models.length > 0;
    }
    if (select.selectedOptions[0]?.disabled) {
      const first = [...select.options].find((o) => !o.disabled);
      if (first) select.value = first.value;
    }
  }
  if ($("applefm-status")) {
    $("applefm-status").textContent = st.available ? t("applefm_ready") : appleFmReasonText(st.reason);
  }
  if (!st.available && $("select-ai-source")?.value === "applefm") {
    $("select-ai-source").value = platformWithoutAppleShortcuts() ? "ollama" : "shortcut";
    toggleSourceGroups();
  }
}

// ---------- Lumen Server comme backend (édition Pro) ----------
// L'option n'existe que si l'édition Pro est active ET que ce poste est lié :
// proposer un backend qui ne peut pas répondre serait pire que de le cacher.
async function refreshLumenServerOption() {
  const opt = $("select-ai-source")?.querySelector('option[value="lumen"]');
  const st = await lumenServerBackendState();
  if (opt) opt.hidden = !st.available;
  if ($("lumen-server-url")) $("lumen-server-url").textContent = st.url || t("lumen_not_linked");
  if (!st.available && $("select-ai-source")?.value === "lumen") {
    $("select-ai-source").value = platformWithoutAppleShortcuts() ? "ollama" : "shortcut";
    toggleSourceGroups();
  }
}

// Modèles servis par le Lumen Server lié : `GET /v1/ai/models`, forme OpenAI.
// Le jeton reste côté Rust (netserver_api) ; le front ne reçoit que des noms.
async function refreshLumenModels() {
  const status = $("lumen-models-status");
  const list = $("lumen-model-list");
  if (status) status.textContent = t("api_models_loading");
  try {
    const res = await invoke("netserver_api", { method: "GET", path: "/v1/ai/models", body: null });
    const models = (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [])
      .map((m) => (typeof m === "string" ? m : m?.id || m?.name || ""))
      .filter(Boolean);
    if (!models.length) throw new Error(t("api_models_empty"));
    if (list) { list.innerHTML = ""; for (const m of models) list.appendChild(new Option(m)); }
    if (status) status.textContent = t("api_models_loaded", { n: models.length });
    if ($("input-lumen-model") && !$("input-lumen-model").value.trim()) $("input-lumen-model").value = models[0];
  } catch (e) {
    if (status) status.textContent = String(e?.message || e);
  }
}

// ---------- Plusieurs API cloud ----------
// Le formulaire « API cloud » édite toujours le profil ACTIF (set_ollama_config
// le reporte côté Rust). Changer de profil enregistre d'abord le formulaire
// courant dans le profil quitté, puis recharge les champs du nouveau.
const API_NEW = "__new__";
const API_LUMEN = "__lumen__";

async function refreshApiProfiles() {
  const sel = $("select-api-profile");
  if (!sel) return;
  const data = await listApiProfiles();
  const lumen = await lumenServerBackendState();
  const source = $("select-ai-source")?.value;
  sel.innerHTML = "";
  for (const p of data.profiles) {
    sel.appendChild(new Option(p.model ? `${p.name} — ${p.model}` : p.name, p.id));
  }
  if (lumen.available) sel.appendChild(new Option("Lumen Server", API_LUMEN));
  sel.appendChild(new Option(t("opt_api_profile_new"), API_NEW));
  sel.value = source === "lumen" && lumen.available ? API_LUMEN : (data.active || API_NEW);
  const active = data.profiles.find((p) => p.id === data.active);
  if ($("input-api-profile-name")) $("input-api-profile-name").value = active?.name || "";
  if ($("btn-delete-api-profile")) $("btn-delete-api-profile").disabled = !active;
  if ($("select-api-preset")) $("select-api-preset").value = "";
  if ($("api-preset-hint")) $("api-preset-hint").hidden = true;
}

async function saveCurrentApiProfileForm() {
  const data = await listApiProfiles();
  if (!data.active || $("select-ai-source")?.value !== "api") return;
  await invoke("llm_api_profile_save", {
    id: data.active,
    name: $("input-api-profile-name")?.value.trim() || "",
    base: $("input-api-base")?.value.trim() || defaults.apiBaseUrl,
    key: $("input-api-key")?.value.trim() || "",
    model: $("input-api-model")?.value.trim() || "",
  });
}

async function loadApiProfileIntoForm(res) {
  setField("input-api-base", res.base || defaults.apiBaseUrl);
  setField("input-api-model", res.model || "");
  if ($("input-api-key")) $("input-api-key").value = "";
  apiModelsLoaded = "";
  applySuggestedApiModels();
  await refreshApiKeyStatus();
}

async function handleApiProfileChange() {
  const sel = $("select-api-profile");
  const choice = sel?.value;
  try {
    if (choice === API_LUMEN) {
      setField("select-ai-source", "lumen");
    } else {
      await saveCurrentApiProfileForm();
      let id = choice;
      if (choice === API_NEW) {
        const res = await invoke("llm_api_profile_save", {
          id: null, name: t("api_profile_default_name"), base: defaults.apiBaseUrl, key: null, model: "",
        });
        id = res.id;
      }
      const res = await activateApiProfile(id);
      await loadApiProfileIntoForm(res);
      setField("select-ai-source", "api");
    }
    await handleAiSourceChange();
    await saveSettings();
  } catch (e) {
    console.error("[API]", e);
  }
  await refreshApiProfiles();
  if (choice === API_NEW) $("input-api-profile-name")?.select();
}

function applyApiPreset() {
  const v = $("select-api-preset")?.value || "";
  const hint = $("api-preset-hint");
  if (hint) hint.hidden = v !== "lumen";
  if (!v) return;
  const base = $("input-api-base");
  const details = base?.closest("details");
  if (details) details.open = true;
  if (v === "lumen") {
    if (base) { base.value = ""; base.placeholder = "https://serveur.local/v1/ai"; base.focus(); }
  } else if (base) {
    base.value = v;
  }
  const name = $("input-api-profile-name");
  const label = $("select-api-preset").selectedOptions[0]?.textContent.replace(/\s*\(.*\)$/, "").trim();
  if (name && (!name.value.trim() || name.value === t("api_profile_default_name"))) {
    name.value = v === "lumen" ? "Lumen Server" : label;
    name.dispatchEvent(new Event("change"));
  }
  apiModelsLoaded = "";
  applySuggestedApiModels();
}

function initApiProfiles() {
  $("select-api-profile")?.addEventListener("change", handleApiProfileChange);
  $("select-api-preset")?.addEventListener("change", applyApiPreset);
  $("input-api-profile-name")?.addEventListener("change", async () => {
    const data = await listApiProfiles();
    if (!data.active) return;
    await invoke("llm_api_profile_save", { id: data.active, name: $("input-api-profile-name").value, base: null, key: null, model: null }).catch(() => {});
    await refreshApiProfiles();
  });
  // confirm() est inopérant sous WKWebView : suppression directe (la clé se
  // ressaisit), comme « Retirer la clé enregistrée ».
  $("btn-delete-api-profile")?.addEventListener("click", async () => {
    const data = await listApiProfiles();
    if (!data.active) return;
    try {
      const next = await invoke("llm_api_profile_delete", { id: data.active });
      const p = next.profiles.find((x) => x.id === next.active);
      if (p) await loadApiProfileIntoForm(await activateApiProfile(p.id));
      else await loadApiProfileIntoForm({ base: defaults.apiBaseUrl, model: "" });
      await saveSettings();
    } catch (e) { console.error("[API]", e); }
    await refreshApiProfiles();
  });
  refreshApiProfiles();
}

// ---------- Fournisseurs d'API (clé + modèles) ----------
// Catalogue de fournisseurs connus ; une API = un profil Rust (URL, clé
// scellée, modèles retenus). La clé saisie part une fois vers Rust puis le
// champ est vidé : elle ne revient jamais (seul un aperçu masqué).
const PROV_COLORS = { openai: "#10a37f", anthropic: "#d97757", gemini: "#4285f4", mistral: "#fa520f", groq: "#f55036", deepseek: "#4d6bfe", xai: "#111111", openrouter: "#6467f2", local: "#71717a", custom: "#8b5cf6" };
const L = (fr, en) => (getLang() === "en" ? en : fr);
const escA = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let apiProvOpen = new Set();
const apiFetched = new Map(); // profil → modèles lus sur /models

function profileForProvider(profiles, prov) {
  return profiles.find((p) => p.provider === prov.id) || profiles.find((p) => !p.provider && providerFor(p.base)?.id === prov.id) || null;
}

async function renderApiProviders() {
  const host = $("api-providers");
  if (!host) return;
  const data = await listApiProfiles();
  const profiles = data.profiles || [];
  const used = new Set();
  const cards = API_PROVIDERS.map((prov) => { const p = profileForProvider(profiles, prov); if (p) used.add(p.id); return { prov, p }; });
  for (const p of profiles) if (!used.has(p.id)) cards.push({ prov: { id: "custom", name: p.name, base: p.base, models: [], keyUrl: "", keyHint: "", custom: true }, p });
  host.innerHTML = cards.map(({ prov, p }) => {
    const key = p ? p.id : `cat:${prov.id}`;
    const configured = !!p?.configured;
    const local = !!prov.local || /localhost|127\.0\.0\.1/.test(p?.base || "");
    const chosen = new Set(p?.models || []);
    const all = [...new Set([...(prov.models || []), ...(p?.models || [])])];
    const fetched = apiFetched.get(key) || [];
    const badge = configured ? `<span class="api-badge ok">${escA(L("Clé", "Key"))} ${escA(p.hint || "••••")}</span>` : local && p ? `<span class="api-badge ok">${escA(L("Local", "Local"))}</span>` : `<span class="api-badge">${escA(L("Aucune clé", "No key"))}</span>`;
    const count = p && (configured || local) ? `<span class="api-badge">${chosen.size} ${escA(L("modèle(s)", "model(s)"))}</span>` : "";
    return `<details class="api-prov" data-card="${escA(key)}" data-prov="${escA(prov.id)}"${apiProvOpen.has(key) ? " open" : ""}>
      <summary><span class="api-prov-ic" style="background:${PROV_COLORS[prov.id] || PROV_COLORS.custom}">${escA((p?.name || prov.name).slice(0, 1).toUpperCase())}</span><span class="api-prov-name">${escA(prov.custom ? p.name : prov.name)}</span>${count}${badge}</summary>
      <div class="api-prov-body">
        ${prov.custom || prov.local ? `<div class="api-sub">${escA(L("Adresse de l'API (compatible OpenAI)", "API address (OpenAI-compatible)"))}</div><div class="api-row"><input type="url" data-f="base" value="${escA(p?.base || prov.base || "")}" placeholder="https://…/v1" spellcheck="false" /></div>` : ""}
        <div class="api-sub">${escA(L("Clé API", "API key"))}${prov.local ? ` (${escA(L("facultative", "optional"))})` : ""}</div>
        <div class="api-row"><input type="password" data-f="key" placeholder="${escA(configured ? L("Remplacer la clé…", "Replace the key…") : prov.keyHint || L("Collez la clé", "Paste the key"))}" autocomplete="off" spellcheck="false" />
          <button type="button" class="ios-row-action" data-a="save-key">${escA(L("Enregistrer", "Save"))}</button>
          ${p ? `<button type="button" class="ios-row-action danger" data-a="remove">${escA(L("Retirer", "Remove"))}</button>` : ""}</div>
        ${prov.keyUrl ? `<a class="api-link" href="${escA(prov.keyUrl)}">${escA(L("Obtenir une clé chez", "Get a key from"))} ${escA(prov.name)} ↗</a>` : ""}
        <div class="api-sub">${escA(L("Modèles proposés", "Offered models"))}</div>
        <div class="api-models">${all.length ? all.map((m) => `<label class="api-model${chosen.has(m) ? " on" : ""}"><input type="checkbox" data-model="${escA(m)}"${chosen.has(m) ? " checked" : ""}${p ? "" : " disabled"} />${escA(m)}${!(prov.models || []).includes(m) ? `<button type="button" class="x" data-rm-model="${escA(m)}" title="${escA(L("Retirer", "Remove"))}">×</button>` : ""}</label>`).join("") : `<span class="api-msg">${escA(L("Aucun modèle prédéfini : ajoutez-en ou chargez la liste de l'API.", "No preset models: add some or load the API's list."))}</span>`}</div>
        <div class="api-row"><input type="text" data-f="add" list="api-fetched-${escA(key)}" placeholder="${escA(L("Ajouter un modèle (identifiant exact)…", "Add a model (exact id)…"))}" spellcheck="false" ${p ? "" : "disabled"} /><datalist id="api-fetched-${escA(key)}">${fetched.map((m) => `<option value="${escA(m)}"></option>`).join("")}</datalist>
          <button type="button" class="ios-row-action" data-a="add-model" ${p ? "" : "disabled"}>${escA(L("Ajouter", "Add"))}</button>
          <button type="button" class="ios-row-action" data-a="fetch" ${p && (configured || local) ? "" : "disabled"}>${escA(L("Charger depuis l'API", "Load from the API"))}</button></div>
        <div class="api-msg" data-msg>${p ? "" : escA(L("Enregistrez d'abord la clé pour choisir les modèles.", "Save the key first to choose models."))}</div>
      </div></details>`;
  }).join("") + `<button type="button" class="ios-row-action" data-a="new-custom">＋ ${escA(L("Ajouter une autre API compatible OpenAI", "Add another OpenAI-compatible API"))}</button>`;
  await renderApiChoice();
}

async function renderApiChoice() {
  const sel = $("select-api-choice");
  if (!sel) return;
  const choices = await listApiModelChoices();
  if (!choices.length) { sel.innerHTML = `<option value="">${escA(L("Ajoutez la clé d'un fournisseur ci-dessous", "Add a provider key below"))}</option>`; sel.disabled = true; return; }
  sel.disabled = false;
  const groups = new Map();
  for (const c of choices) { if (!groups.has(c.id)) groups.set(c.id, { name: c.name, list: [] }); groups.get(c.id).list.push(c); }
  sel.innerHTML = [...groups.values()].map((g) => `<optgroup label="${escA(g.name)}">${g.list.map((c) => `<option value="${escA(JSON.stringify([c.id, c.model]))}"${c.active ? " selected" : ""}>${escA(c.model)}</option>`).join("")}</optgroup>`).join("");
  if (!choices.some((c) => c.active)) sel.insertAdjacentHTML("afterbegin", `<option value="" selected>${escA(L("— Choisir un modèle —", "— Choose a model —"))}</option>`);
}

async function apiProviderAction(card, action, extra) {
  const msg = card.querySelector("[data-msg]");
  const say = (text, err = false) => { if (msg) { msg.textContent = text; msg.classList.toggle("err", err); } };
  const key = card.dataset.card;
  const provId = card.dataset.prov;
  const prov = API_PROVIDERS.find((x) => x.id === provId);
  const id = key.startsWith("cat:") || key.startsWith("new:") ? null : key;
  const data = await listApiProfiles();
  const p = id ? (data.profiles || []).find((x) => x.id === id) : null;
  apiProvOpen.add(key);
  try {
    if (action === "save-key") {
      const input = card.querySelector('[data-f="key"]');
      const base = card.querySelector('[data-f="base"]')?.value.trim() || p?.base || prov?.base || "";
      const k = input.value.trim();
      input.value = ""; // la clé ne reste pas dans le DOM
      if (!k && !prov?.local && provId !== "custom") { say(L("Collez d'abord la clé.", "Paste the key first."), true); return; }
      if (!/^https?:\/\//i.test(base)) { say(L("Adresse d'API invalide.", "Invalid API address."), true); return; }
      const res = await invoke("llm_api_profile_save", {
        id, name: p?.name || prov?.name || L("Mon API", "My API"), base, key: k || null,
        model: p?.model || prov?.models?.[0] || "", provider: prov && provId !== "custom" ? prov.id : (p?.provider || ""),
        models: p ? null : [...(prov?.models || [])],
      });
      apiProvOpen.delete(key); apiProvOpen.add(res.id);
      // Première API configurée : elle devient l'API active.
      if (!data.active || !(data.profiles || []).some((x) => x.id === data.active && x.configured)) {
        const sel = await selectApiModel(res.id, p?.model || prov?.models?.[0] || "").catch(() => null);
        if (sel) { await loadApiProfileIntoForm(sel); await saveSettings(); }
      }
      await renderApiProviders();
      return;
    }
    if (action === "remove" && p) {
      await invoke("llm_api_profile_delete", { id: p.id });
      apiFetched.delete(p.id); apiProvOpen.delete(p.id);
      const next = await listApiProfiles();
      const np = (next.profiles || []).find((x) => x.id === next.active);
      await loadApiProfileIntoForm(np ? await activateApiProfile(np.id) : { base: defaults.apiBaseUrl, model: "" });
      await saveSettings();
      await renderApiProviders();
      return;
    }
    if (!p) return;
    const models = new Set(p.models || []);
    if (action === "toggle") { if (extra.on) models.add(extra.model); else models.delete(extra.model); }
    else if (action === "rm-model") models.delete(extra.model);
    else if (action === "add-model") {
      const inp = card.querySelector('[data-f="add"]');
      const m = inp.value.trim();
      if (!m) return;
      models.add(m); inp.value = "";
    } else if (action === "fetch") {
      say(L("Chargement…", "Loading…"));
      const list = await invoke("llm_api_profile_models", { id: p.id });
      apiFetched.set(p.id, prioritiseModels(list, p.base));
      await renderApiProviders();
      const c2 = $("api-providers").querySelector(`[data-card="${CSS.escape(p.id)}"] [data-msg]`);
      if (c2) c2.textContent = L(`${list.length} modèles servis par l'API : tapez dans « Ajouter un modèle » pour les retrouver.`, `${list.length} models served by the API: type in “Add a model” to find them.`);
      return;
    } else if (action === "base") {
      await invoke("llm_api_profile_save", { id: p.id, name: p.name, base: extra.base, key: null, model: null, provider: null, models: null });
      await renderApiProviders();
      return;
    }
    await invoke("llm_api_profile_save", { id: p.id, name: p.name, base: null, key: null, model: null, provider: null, models: [...models] });
    await renderApiProviders();
  } catch (e) { say(String(e?.message || e), true); }
}

function initApiProviders() {
  const host = $("api-providers");
  if (!host) return;
  host.addEventListener("toggle", (e) => { const d = e.target.closest?.(".api-prov"); if (d) { if (d.open) apiProvOpen.add(d.dataset.card); else apiProvOpen.delete(d.dataset.card); } }, true);
  host.addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-rm-model]");
    if (rm) { e.preventDefault(); await apiProviderAction(rm.closest(".api-prov"), "rm-model", { model: rm.dataset.rmModel }); return; }
    const b = e.target.closest("[data-a]");
    if (!b) return;
    if (b.dataset.a === "new-custom") {
      const res = await invoke("llm_api_profile_save", { id: null, name: L("Mon API", "My API"), base: "https://", key: null, model: "", provider: "", models: [] }).catch((err) => { console.error(err); return null; });
      if (res) { apiProvOpen.add(res.id); await renderApiProviders(); host.querySelector(`[data-card="${CSS.escape(res.id)}"] [data-f="base"]`)?.focus(); }
      return;
    }
    await apiProviderAction(b.closest(".api-prov"), b.dataset.a);
  });
  host.addEventListener("change", async (e) => {
    const t2 = e.target;
    if (t2.dataset.model) await apiProviderAction(t2.closest(".api-prov"), "toggle", { model: t2.dataset.model, on: t2.checked });
    else if (t2.dataset.f === "base" && !t2.closest(".api-prov").dataset.card.startsWith("cat:")) await apiProviderAction(t2.closest(".api-prov"), "base", { base: t2.value.trim() });
  });
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const f = e.target.dataset?.f;
    if (f === "key") { e.preventDefault(); apiProviderAction(e.target.closest(".api-prov"), "save-key"); }
    if (f === "add") { e.preventDefault(); apiProviderAction(e.target.closest(".api-prov"), "add-model"); }
  });
  $("select-api-choice")?.addEventListener("change", async (e) => {
    if (!e.target.value) return;
    try {
      const [id, model] = JSON.parse(e.target.value);
      const res = await selectApiModel(id, model);
      await loadApiProfileIntoForm(res); // garde le formulaire masqué aligné
      await saveSettings();
      await renderApiChoice();
    } catch (err) { console.error("[API]", err); }
  });
}

function initApiModelPicker() {
  initApiProviders();
  $("btn-lumen-models-refresh")?.addEventListener("click", refreshLumenModels);
  initApiProfiles();
  if (!$("input-api-model")) return;
  applySuggestedApiModels();
  $("input-api-base")?.addEventListener("change", () => {
    apiModelsLoaded = "";
    applySuggestedApiModels();
  });
  $("btn-api-models-refresh")?.addEventListener("click", refreshApiModels);
}

// Alimente la liste du champ « Modèle » de l'onglet Telegram. En backend API on
// réutilise les modèles chargés (ou suggérés) pour l'endpoint de Lumen ; en
// Ollama, les modèles réellement installés.
async function fillTelegramModelList(st) {
  const list = $("telegram-model-list");
  if (!list) return;
  const backend = $("select-telegram-backend")?.value || st.backend || "lumen";
  let models = [];
  if (backend === "api") {
    models = apiModelsLoaded ? apiModelsLoaded.split("\n") : suggestedModels(st.apiBase || "");
  } else if (backend === "ollama") {
    // `listOllamaModels` passe par le backend Rust : pas de CORS WebView2 sous
    // Windows, et repli intégré.
    models = await listOllamaModels(val("ollamaUrl", defaults.ollamaUrl)).catch(() => []);
  } else if (backend === "applefm") {
    const afm = await appleFmBackendState();
    models = (afm.models || []).filter((m) => m.available).map((m) => m.id);
  }
  list.innerHTML = "";
  for (const m of models) list.appendChild(new Option(m));
}

// ===== Onglet Telegram =====
// Le jeton du bot ne transite JAMAIS dans l'autre sens : le backend n'en renvoie
// qu'un aperçu masqué (cf. telegram.rs). Un champ laissé vide = « inchangé ».
// Moteur et mode sont une source de vérité UNIQUE, partagée avec les commandes
// Telegram (/backend, /modele, /mode) : ce panneau affiche donc toujours
// exactement ce que /etat annonce sur le téléphone.
// Les interrupteurs s'appliquent immédiatement (pas de bouton « Enregistrer ») :
// couper une capacité à distance doit être instantané.
function initTelegramUI() {
  const pane = document.querySelector('.settings-tab-pane[data-pane="telegram"]');
  if (!pane) return;
  const stateEl = $("telegram-state");
  const codeEl = $("telegram-pair-code");
  const cdEl = $("telegram-pair-countdown");
  const chatsEl = $("telegram-chats");
  const tokenInput = $("input-telegram-token");
  let expiresAt = 0;

  const setState = (txt) => { if (stateEl) stateEl.textContent = txt; };

  async function refresh() {
    let st;
    try { st = await invoke("telegram_status"); } catch (e) { setState(String(e)); return; }
    if (tokenInput) {
      tokenInput.placeholder = st.configured
        ? t("tg_token_saved", { hint: st.hint })
        : "123456789:AA…";
    }
    $("checkbox-telegram-enabled").checked = !!st.enabled;
    $("checkbox-telegram-tools").checked = !!st.allowTools;
    $("checkbox-telegram-agents").checked = !!st.allowAgents;
    $("checkbox-telegram-images").checked = !!st.allowImages;
    $("checkbox-telegram-showtools").checked = !!st.showToolCalls;
    $("select-telegram-backend").value = st.backend || "lumen";
    $("input-telegram-model").value = st.model || "";
    $("select-telegram-mode").value = st.mode || "tools";
    // Le champ modèle propose les modèles pertinents pour le backend choisi ici :
    // ceux de l'API cloud, ou ceux installés côté Ollama.
    fillTelegramModelList(st);
    $("select-telegram-image-provider").value = st.imageProvider || "bonsai";
    $("input-telegram-image-model").value = st.imageModel || "";

    if (!st.configured) setState(t("tg_state_notoken"));
    else if (!st.enabled) setState(t("tg_state_off"));
    else if (st.lastError) setState(`⚠️ ${st.lastError}`);
    else if (st.running) setState(t("tg_state_on", { user: st.username || "?" }));
    else setState(t("tg_state_starting"));

    if (st.pairCode) {
      codeEl.textContent = st.pairCode;
      expiresAt = Date.now() + (st.pairExpiresIn || 0) * 1000;
    } else if (!expiresAt || expiresAt < Date.now()) {
      codeEl.textContent = "——————————";
      cdEl.textContent = "—";
      expiresAt = 0;
    }

    chatsEl.innerHTML = "";
    if (!st.chats?.length) {
      const row = document.createElement("div");
      row.className = "ios-row";
      row.innerHTML = `<span>${t("tg_no_chat")}</span>`;
      chatsEl.appendChild(row);
      return;
    }
    for (const c of st.chats) {
      const row = document.createElement("div");
      row.className = "ios-row";
      const label = document.createElement("span");
      label.textContent = `${c.name || t("tg_chat")} · ${c.id}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "danger";
      btn.textContent = t("tg_revoke");
      btn.addEventListener("click", async () => {
        await invoke("telegram_revoke_chat", { chatId: c.id }).catch(() => {});
        refresh();
      });
      row.append(label, btn);
      chatsEl.appendChild(row);
    }
  }

  const pushOptions = () => invoke("telegram_set_options", {
    backend: $("select-telegram-backend").value,
    model: $("input-telegram-model").value.trim(),
    mode: $("select-telegram-mode").value,
    allowTools: $("checkbox-telegram-tools").checked,
    allowAgents: $("checkbox-telegram-agents").checked,
    allowImages: $("checkbox-telegram-images").checked,
    showToolCalls: $("checkbox-telegram-showtools").checked,
    imageProvider: $("select-telegram-image-provider").value,
    imageModel: $("input-telegram-image-model").value.trim(),
  }).catch((e) => setState(String(e)));

  $("select-telegram-backend")?.addEventListener("change", () => invoke("telegram_status").then(fillTelegramModelList).catch(() => {}));
  ["select-telegram-backend", "input-telegram-model", "select-telegram-mode", "checkbox-telegram-tools",
   "checkbox-telegram-agents", "checkbox-telegram-images", "checkbox-telegram-showtools",
   "select-telegram-image-provider", "input-telegram-image-model"]
    .forEach((id) => $(id)?.addEventListener("change", pushOptions));

  tokenInput?.addEventListener("change", async () => {
    const token = tokenInput.value.trim();
    if (!token) return;
    tokenInput.value = ""; // ne garde jamais le secret dans le DOM
    try { await invoke("telegram_set_token", { token }); } catch (e) { setState(String(e)); }
    refresh();
  });

  $("checkbox-telegram-enabled")?.addEventListener("change", async (ev) => {
    setState(t("tg_state_starting"));
    try {
      await invoke("telegram_set_enabled", { enabled: ev.target.checked });
    } catch (e) {
      setState(String(e));
      ev.target.checked = false;
    }
    refresh();
  });

  $("btn-telegram-pair")?.addEventListener("click", async () => {
    try {
      const res = await invoke("telegram_new_pair_code");
      codeEl.textContent = res.code;
      expiresAt = Date.now() + res.expiresIn * 1000;
    } catch (e) { setState(String(e)); }
  });

  $("btn-telegram-test")?.addEventListener("click", async () => {
    try {
      const n = await invoke("telegram_test");
      setState(t("tg_test_sent", { n }));
    } catch (e) { setState(String(e)); }
  });

  $("btn-telegram-clear")?.addEventListener("click", async () => {
    // confirm() est inopérant sous WKWebView (cf. Lumen) → on demande une
    // seconde intention par un double clic explicite sur le bouton.
    const btn = $("btn-telegram-clear");
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = t("tg_clear_confirm");
      setTimeout(() => {
        btn.dataset.armed = "0";
        btn.textContent = t("btn_tg_clear");
      }, 5000);
      return;
    }
    btn.dataset.armed = "0";
    btn.textContent = t("btn_tg_clear");
    await invoke("telegram_clear_token").catch(() => {});
    refresh();
  });

  tauriEvent?.listen?.("telegram-updated", () => refresh());
  setInterval(() => {
    if (!pane.classList.contains("active")) return;
    if (expiresAt) {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      cdEl.textContent = left ? `${left}s` : "—";
      if (!left) { expiresAt = 0; codeEl.textContent = "——————————"; }
    }
  }, 1000);
  setInterval(() => { if (pane.classList.contains("active")) refresh(); }, 8000);
  refresh();
}

// ===== Bot Slack =============================================================
// Même logique que l'onglet Telegram : aucun jeton ne revient du backend (aperçu
// masqué seulement), les options s'appliquent dès qu'on les change, et la
// suppression demande un second clic (confirm() est inopérant sous WKWebView).
function initSlackUI() {
  const pane = document.querySelector('.settings-tab-pane[data-pane="slack"]');
  if (!pane) return;
  const stateEl = $("slack-state");
  const codeEl = $("slack-pair-code");
  const cdEl = $("slack-pair-countdown");
  const usersEl = $("slack-users");
  const botInput = $("input-slack-bot");
  const appInput = $("input-slack-app");
  let expiresAt = 0;
  let manifest = "";
  const setState = (txt) => { if (stateEl) stateEl.textContent = txt; };

  async function refresh() {
    let st;
    try { st = await invoke("slack_status"); } catch (e) { setState(String(e)); return; }
    manifest = st.manifest || "";
    const pre = $("slack-manifest");
    if (pre && pre.textContent !== manifest) pre.textContent = manifest;
    if (botInput) botInput.placeholder = st.botConfigured ? t("sl_token_saved", { hint: st.botHint }) : "xoxb-…";
    if (appInput) appInput.placeholder = st.appConfigured ? t("sl_token_saved", { hint: st.appHint }) : "xapp-…";
    $("checkbox-slack-enabled").checked = !!st.enabled;
    $("checkbox-slack-tools").checked = !!st.allowTools;
    $("checkbox-slack-agents").checked = !!st.allowAgents;
    $("checkbox-slack-personas").checked = !!st.agentPersonas;
    $("checkbox-slack-channels").checked = !!st.channels;
    $("checkbox-slack-images").checked = !!st.allowImages;
    $("checkbox-slack-showtools").checked = !!st.showToolCalls;
    $("select-slack-backend").value = st.backend || "lumen";
    if (document.activeElement !== $("input-slack-model")) $("input-slack-model").value = st.model || "";
    $("select-slack-mode").value = ["tools", "chat", "agent", "image"].includes(st.mode) ? st.mode : "tools";
    $("select-slack-image-provider").value = st.imageProvider || "bonsai";

    if (!st.botConfigured || !st.appConfigured) setState(t("sl_state_notoken"));
    else if (!st.enabled) setState(t("tg_state_off"));
    else if (st.lastError) setState(`⚠️ ${st.lastError}`);
    else if (st.running) setState(t("sl_state_on", { team: st.team || "Slack", bot: st.botName || "lumen" }));
    else setState(t("tg_state_starting"));

    if (st.pairCode) {
      codeEl.textContent = st.pairCode;
      expiresAt = Date.now() + (st.pairExpiresIn || 0) * 1000;
    } else if (!expiresAt || expiresAt < Date.now()) {
      codeEl.textContent = "——————————";
      cdEl.textContent = "—";
      expiresAt = 0;
    }

    usersEl.innerHTML = "";
    if (!st.users?.length) {
      const row = document.createElement("div");
      row.className = "ios-row";
      row.innerHTML = `<span>${t("sl_no_user")}</span>`;
      usersEl.appendChild(row);
      return;
    }
    for (const u of st.users) {
      const row = document.createElement("div");
      row.className = "ios-row";
      const label = document.createElement("span");
      label.textContent = `${u.name || t("sl_user")} · ${u.id}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "danger";
      btn.textContent = t("tg_revoke");
      btn.addEventListener("click", async () => {
        await invoke("slack_revoke_user", { userId: u.id }).catch(() => {});
        refresh();
      });
      row.append(label, btn);
      usersEl.appendChild(row);
    }
  }

  const pushOptions = () => invoke("slack_set_options", {
    backend: $("select-slack-backend").value,
    model: $("input-slack-model").value.trim(),
    mode: $("select-slack-mode").value,
    allowTools: $("checkbox-slack-tools").checked,
    allowAgents: $("checkbox-slack-agents").checked,
    allowImages: $("checkbox-slack-images").checked,
    showToolCalls: $("checkbox-slack-showtools").checked,
    agentPersonas: $("checkbox-slack-personas").checked,
    channels: $("checkbox-slack-channels").checked,
    imageProvider: $("select-slack-image-provider").value,
  }).catch((e) => setState(String(e)));

  ["select-slack-backend", "input-slack-model", "select-slack-mode", "checkbox-slack-tools",
   "checkbox-slack-agents", "checkbox-slack-images", "checkbox-slack-showtools",
   "checkbox-slack-personas", "checkbox-slack-channels", "select-slack-image-provider"]
    .forEach((id) => $(id)?.addEventListener("change", pushOptions));

  // Les jetons ne restent jamais dans le DOM : champ vidé aussitôt envoyé.
  const saveToken = async (input, field) => {
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    try { await invoke("slack_set_tokens", { [field]: value }); } catch (e) { setState(String(e)); return; }
    refresh();
  };
  botInput?.addEventListener("change", () => saveToken(botInput, "botToken"));
  appInput?.addEventListener("change", () => saveToken(appInput, "appToken"));

  $("checkbox-slack-enabled")?.addEventListener("change", async (ev) => {
    setState(t("tg_state_starting"));
    try {
      await invoke("slack_set_enabled", { enabled: ev.target.checked });
    } catch (e) {
      setState(String(e));
      ev.target.checked = false;
    }
    refresh();
  });

  $("btn-slack-copy-manifest")?.addEventListener("click", async () => {
    const btn = $("btn-slack-copy-manifest");
    try {
      await navigator.clipboard.writeText(manifest);
      btn.textContent = t("sl_copied");
    } catch {
      // Presse-papiers refusé : on déplie le manifeste pour une copie manuelle.
      pane.querySelector(".slack-manifest")?.setAttribute("open", "");
    }
    setTimeout(() => { btn.textContent = t("btn_sl_copy"); }, 2200);
  });

  $("btn-slack-pair")?.addEventListener("click", async () => {
    try {
      const res = await invoke("slack_new_pair_code");
      codeEl.textContent = res.code;
      expiresAt = Date.now() + res.expiresIn * 1000;
    } catch (e) { setState(String(e)); }
  });

  $("btn-slack-test")?.addEventListener("click", async () => {
    try {
      const n = await invoke("slack_test");
      setState(t("sl_test_sent", { n }));
    } catch (e) { setState(String(e)); }
  });

  $("btn-slack-clear")?.addEventListener("click", async () => {
    const btn = $("btn-slack-clear");
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = t("sl_clear_confirm");
      setTimeout(() => { btn.dataset.armed = "0"; btn.textContent = t("btn_sl_clear"); }, 5000);
      return;
    }
    btn.dataset.armed = "0";
    btn.textContent = t("btn_sl_clear");
    await invoke("slack_clear_tokens").catch(() => {});
    refresh();
  });

  tauriEvent?.listen?.("slack-updated", () => refresh());
  setInterval(() => {
    if (!pane.classList.contains("active")) return;
    if (expiresAt) {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      cdEl.textContent = left ? `${left}s` : "—";
      if (!left) { expiresAt = 0; codeEl.textContent = "——————————"; }
    }
  }, 1000);
  setInterval(() => { if (pane.classList.contains("active")) refresh(); }, 8000);
  refresh();
}

window.addEventListener("DOMContentLoaded", async () => {
  applyUiTheme();
  mountUiCustomizer();
  // "" tant que la saveur n'est pas établie : « default » signifierait macOS.
  platformFlavor = await resolvePlatformFlavor();
  const profileId = await invoke("session_active_profile_id").catch(() => "default");
  profileStoragePrefix = `profile:${profileId || "default"}:`;
  window.__LUMEN_PROFILE_STORAGE_PREFIX__ = profileStoragePrefix;
  applyPlatformFlavorUi();
  applyIcons();
  applyI18n();
  bindNavigation();
  bindActions();
  loadSettings();
  tauriEvent?.listen?.("desktop-mode", (event) => {
    const active = !!event?.payload?.active;
    const input = $("checkbox-always-on-top");
    if (!input) return;
    input.dataset.desktopSuspended = active ? "1" : "0";
    input.disabled = active;
    input.checked = active ? false : localStorage.getItem("alwaysOnTop") !== "false";
    input.title = active ? "Indisponible pendant le mode desktop" : "";
  });
  initWebVoiceUI();
  initOrbDeviceUI();
  initRfidUI();
  initNotifSoundsUI();
  initApiModelPicker();
  initTelegramUI();
  initSlackUI();
  initLockUI();
  refreshTtsUI().catch(() => {});
  refreshLocalTtsRuntime().catch(() => {});
  refreshRag().catch(() => {});
  initEmbedUI();
  refreshEmbedUI().catch(() => {});
  updateMcpTransportFields();
  refreshMcpServers().then(refreshMcpCatalog).catch(() => {});
  refreshToolbox().catch(() => {});
  initWebSearchUI();
  initWhisperNativeUI().catch(() => {});
  initRerankUI().catch(() => {});
  initLlamaPerfUI().catch(() => {});
  initSkillsUI().catch(() => {});
  initMcpServerUI().catch(() => {});
  { const b = $("checkbox-voice-bargein"); if (b) { b.checked = localStorage.getItem("voiceBargeIn") !== "0"; b.addEventListener("change", () => localStorage.setItem("voiceBargeIn", b.checked ? "1" : "0")); } }
  initPromptsDialog();
  initBackupUI();
  initUpdateUI();
  renderModelExpectations();
  renderControllerInfo();
});

// ===== Catalogue des prompts système ======================================
// Toutes les consignes envoyées aux modèles par Lumen, réunies dans une boîte
// dédiée : celles du cœur (identité, règles), celles des agents et de Telegram
// (côté Rust) et celles de chaque app.
//
// Le texte d'origine reste affiché en permanence au-dessus du champ : sans lui,
// « personnaliser » revient à écrire à l'aveugle, et on ne sait plus ce qu'on a
// remplacé. Un champ vide vaut « revenir au défaut » — jamais « pas de prompt ».
function initPromptsDialog() {
  const overlay = $("prompts-overlay");
  const body = $("prompts-body");
  if (!overlay || !body) return;
  const lang = getLang();
  let overrides = {};

  const close = () => { overlay.hidden = true; };

  let defaults = {};
  let catalog = PROMPTS;

  const open = async () => {
    // Le backend fait foi : les prompts des agents ont pu être modifiés depuis
    // une autre fenêtre, ou le localStorage vidé par un changement de profil.
    [overrides, defaults, catalog] = await Promise.all([loadOverridesFromBackend(), loadDefaults(), loadFullCatalog().catch(() => PROMPTS)]);
    overrides = { ...overrides };
    render();
    overlay.hidden = false;
    $("prompts-search")?.focus();
  };

  function render(filter = "") {
    const needle = filter.trim().toLowerCase();
    body.innerHTML = "";
    let shown = 0;
    for (const group of catalog) {
      const items = group.items.filter((item) =>
        !needle || `${promptText(item, "label", lang)} ${promptText(item, "hint", lang)} ${item.id}`.toLowerCase().includes(needle));
      if (!items.length) continue;
      const title = document.createElement("div");
      title.className = "prompts-group-title";
      title.textContent = promptText(group, "group", lang);
      body.appendChild(title);
      for (const item of items) {
        body.appendChild(promptRow(item, defaults[item.id] || item.default || ""));
        shown++;
      }
    }
    if (!shown) {
      body.innerHTML = `<p class="prompt-hint">${t("prompts_no_match")}</p>`;
    }
  }

  function promptRow(item, observedDefault) {
    const row = document.createElement("div");
    row.className = "prompt-item" + (overrides[item.id] ? " custom" : "");
    const scope = t(item.scope === "rust" ? "prompt_scope_backend" : "prompt_scope_app");
    // Le défaut observé à l'exécution est plus fiable qu'un texte recopié ici :
    // il tient compte de la langue et de ce que le code envoie réellement.
    const fallback = observedDefault || t("prompt_default_unknown");
    row.innerHTML =
      `<div class="prompt-item-head"><b></b><span class="prompt-scope"></span>` +
      `<button type="button" class="prompt-reset"></button></div>` +
      `<p class="prompt-hint"></p><div class="prompt-default"></div><textarea rows="3"></textarea>`;
    row.querySelector("b").textContent = promptText(item, "label", lang);
    row.querySelector(".prompt-scope").textContent = scope;
    row.querySelector(".prompt-hint").textContent = promptText(item, "hint", lang);
    row.querySelector(".prompt-default").textContent = fallback;
    const reset = row.querySelector(".prompt-reset");
    reset.textContent = t("btn_prompt_reset");
    reset.disabled = !overrides[item.id];
    const area = row.querySelector("textarea");
    area.value = overrides[item.id] || "";
    area.placeholder = t("ph_prompt_override");
    area.addEventListener("input", () => {
      if (area.value.trim()) overrides[item.id] = area.value;
      else delete overrides[item.id];
      row.classList.toggle("custom", !!overrides[item.id]);
      reset.disabled = !overrides[item.id];
    });
    reset.addEventListener("click", () => {
      delete overrides[item.id];
      area.value = "";
      row.classList.remove("custom");
      reset.disabled = true;
    });
    return row;
  }

  $("btn-open-prompts")?.addEventListener("click", () => { open().catch(() => {}); });
  $("btn-prompts-close")?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) close();
  });
  $("prompts-search")?.addEventListener("input", (event) => render(event.target.value));
  $("btn-prompts-reset-all")?.addEventListener("click", () => {
    overrides = {};
    render($("prompts-search")?.value || "");
    setPromptsStatus(t("prompts_reset_pending"));
  });
  $("btn-prompts-save")?.addEventListener("click", async () => {
    await saveOverrides(overrides);
    const count = Object.keys(overrides).length;
    setPromptsStatus(count ? `${count} ${t("prompts_saved_count")}` : t("prompts_saved_none"));
  });
}

function setPromptsStatus(message) {
  const el = $("prompts-status");
  if (!el) return;
  el.textContent = message;
  setTimeout(() => { if (el.textContent === message) el.textContent = ""; }, 6000);
}

// ===== Sauvegarde / restauration =====
// Tout l'état utilisateur vit dans app_data_dir ; le backend (backup.rs) en fait
// une archive .lumenbackup. Ici on ne fait que présenter, confirmer et rendre
// compte — y compris du chemin de l'archive de secours créée avant restauration,
// qui est la seule voie de retour si la restauration déçoit.
function formatBytesUI(n) {
  if (!Number.isFinite(n)) return "—";
  const units = ["o", "ko", "Mo", "Go"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function initBackupUI() {
  const estimate = $("backup-estimate");
  const status = $("backup-status");
  const restoreStatus = $("restore-status");
  const pathInput = $("input-restore-path");
  const applyBtn = $("btn-restore-apply");
  if (!estimate) return;

  // L'archive examinée et validée. Tant qu'elle ne correspond pas au chemin
  // affiché, « Restaurer » reste désactivé : on n'écrase jamais sur un simple
  // collage de chemin.
  let inspected = null;

  async function refreshEstimate() {
    try {
      const info = await invoke("backup_estimate");
      estimate.textContent =
        `${info.files} fichiers · ${formatBytesUI(info.bytes)} avant compression` +
        (info.skipped?.length ? ` · ${info.skipped.length} éléments exclus (modèles, voix, journaux)` : "");
    } catch (e) {
      estimate.textContent = `Estimation impossible : ${e}`;
    }
  }
  refreshEstimate();

  $("btn-backup-export")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    status.textContent = "Sauvegarde en cours…";
    try {
      const res = await invoke("backup_export", { destDir: $("input-backup-dir")?.value || "" });
      status.textContent = `✅ ${res.files} fichiers · ${formatBytesUI(res.archive_bytes)} → ${res.path}`;
      invoke("backup_reveal", { path: res.path }).catch(() => {});
    } catch (e) {
      status.textContent = `❌ ${e}`;
    } finally {
      btn.disabled = false;
    }
  });

  function invalidate() {
    inspected = null;
    if (applyBtn) applyBtn.disabled = true;
  }
  pathInput?.addEventListener("input", invalidate);

  initAutoBackupUI();

  $("btn-restore-inspect")?.addEventListener("click", async () => {
    const path = pathInput?.value.trim();
    if (!path) { restoreStatus.textContent = "Indique le chemin d'une archive."; return; }
    try {
      const m = await invoke("backup_inspect", { path, passphrase: $("input-restore-pass")?.value || null });
      inspected = path;
      if (applyBtn) applyBtn.disabled = false;
      restoreStatus.textContent =
        `Archive du ${new Date(m.created_at).toLocaleString()} · Lumen ${m.app_version} · ` +
        `${m.files} fichiers · ${formatBytesUI(m.bytes)}. Clique sur Restaurer pour l'appliquer.`;
    } catch (e) {
      invalidate();
      restoreStatus.textContent = `❌ ${e}`;
    }
  });

  applyBtn?.addEventListener("click", async () => {
    const path = pathInput?.value.trim();
    if (!path || path !== inspected) {
      restoreStatus.textContent = "Examine l'archive avant de la restaurer.";
      return;
    }
    const wipe = $("checkbox-restore-wipe")?.checked || false;
    // confirm() est inopérant dans WKWebView (cf. les autres dialogues de
    // l'app) : on demande une confirmation explicite en deux temps sur le
    // bouton lui-même.
    if (applyBtn.dataset.armed !== "1") {
      applyBtn.dataset.armed = "1";
      applyBtn.textContent = wipe ? "Confirmer le remplacement total" : "Confirmer la fusion";
      restoreStatus.textContent = "Lumen devra être relancé après la restauration.";
      setTimeout(() => {
        if (applyBtn.dataset.armed === "1") {
          applyBtn.dataset.armed = "0";
          applyBtn.textContent = t("btn_restore_apply") || "Restaurer";
        }
      }, 8000);
      return;
    }
    applyBtn.dataset.armed = "0";
    applyBtn.textContent = t("btn_restore_apply") || "Restaurer";
    applyBtn.disabled = true;
    restoreStatus.textContent = "Restauration en cours…";
    try {
      const res = await invoke("backup_import", { path, wipe, passphrase: $("input-restore-pass")?.value || null });
      restoreStatus.textContent =
        `✅ ${res.files} fichiers restaurés (${formatBytesUI(res.bytes)}). ` +
        `État précédent conservé ici : ${res.rollback_path}. Relance Lumen pour finir.`;
      refreshEstimate();
    } catch (e) {
      restoreStatus.textContent = `❌ ${e}`;
      applyBtn.disabled = false;
    }
  });

  // Dépôt d'un fichier .lumenbackup n'importe où sur la fenêtre : plus simple
  // que de coller un chemin. L'évènement Tauri porte les chemins réels ; le
  // drop HTML natif, lui, ne les donne pas.
  tauriEvent?.listen?.("tauri://drag-drop", (event) => {
    const file = (event.payload?.paths || []).find((p) => p.endsWith(".lumenbackup"));
    if (!file || !pathInput) return;
    pathInput.value = file;
    invalidate();
    $("btn-restore-inspect")?.click();
  }).catch(() => {});
}

// ===== Mises à jour =====
function initUpdateUI() {
  const status = $("update-status");
  const notes = $("update-notes");
  const checkBtn = $("btn-update-check");
  const installBtn = $("btn-update-install");
  const auto = $("checkbox-update-auto");
  if (!status) return;

  let pending = null;

  if (auto) {
    auto.checked = updater.autoCheckEnabled();
    auto.addEventListener("change", () => updater.setAutoCheck(auto.checked));
  }

  checkBtn?.addEventListener("click", async () => {
    checkBtn.disabled = true;
    status.textContent = "Vérification…";
    notes.textContent = "";
    try {
      const update = await updater.check();
      if (!update) {
        status.textContent = "✅ Lumen est à jour.";
        installBtn.hidden = true;
        return;
      }
      pending = update;
      status.textContent = `Version ${update.version} disponible (tu as la ${update.currentVersion}).`;
      notes.textContent = update.body || "";
      installBtn.hidden = false;
    } catch (e) {
      // Cas le plus fréquent en développement : `pubkey` vide dans
      // tauri.conf.json, ou aucune release publiée. On le dit franchement.
      status.textContent = `❌ ${e}`;
    } finally {
      checkBtn.disabled = false;
    }
  });

  installBtn?.addEventListener("click", async () => {
    if (!pending) return;
    installBtn.disabled = true;
    try {
      await updater.install(pending, (p) => {
        if (p.stage === "download") {
          const pct = p.total ? ` (${Math.round((p.downloaded / p.total) * 100)} %)` : "";
          status.textContent = `Téléchargement${pct} — ${updater.formatBytes(p.downloaded)}`;
        } else if (p.stage === "install") {
          status.textContent = "Installation…";
        } else {
          status.textContent = "Redémarrage…";
        }
      });
    } catch (e) {
      status.textContent = `❌ ${e}`;
      installBtn.disabled = false;
    }
  });
}

// Les liens sortants (fiches, docs des connecteurs, markdown) ouvrent le
// navigateur du système : `target="_blank"` est inerte dans la WebView.
delegateExternalLinks(document);


// Nom du produit dans l'en-tête des réglages : « Lumen » ou « Lumen Pro », lu
// sur le bundle plutôt qu'écrit en dur (cf. lib/pro-edition.js).
productName().then((name) => {
  const el = document.getElementById("brand-product");
  if (el && name) el.textContent = name;
  if (name === "Lumen Pro") {
    const logo = document.querySelector(".sidebar-brand .logo img");
    if (logo) logo.src = "/lib/brand/lumen-pro.png";
  }
}).catch(() => {});

/* ===== Applications et licence =============================================
 *
 * Une seule page pour deux questions qui n'en font qu'une du point de vue de
 * l'utilisateur : ce que Lumen sait faire (la licence Pro) et ce que chaque
 * application installée a le droit de faire (les permissions).
 *
 * La licence est vérifiée par le binaire, hors ligne, contre une clé publique
 * qu'il embarque. Rien ici ne « déverrouille » quoi que ce soit : ce module
 * transmet une chaîne et affiche la réponse.
 */
{
  const invokeCmd = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
  const $$ = (id) => document.getElementById(id);

  const CAP_LABELS = {
    ai: "Intelligence artificielle", assistant: "Mode assistant", tools: "Outils pour les agents",
    storage: "Espace de stockage", files: "Vos fichiers", tables: "Bases de données",
    memory: "Mémoire de Lumen", network: "Accès internet", notifications: "Notifications",
    clipboard: "Presse-papier",
  };
  const capLabel = (cap) => {
    const [base, target] = String(cap).split(":");
    if (base === "interop" && target) return `Envoi vers ${target}`;
    return CAP_LABELS[cap] || cap;
  };

  async function renderLicence() {
    const box = $$("licence-state");
    if (!box || !invokeCmd) return;
    try {
      const st = await invokeCmd("license_status");
      if (st.active) {
        const until = st.expires
          ? `jusqu'au ${new Date(st.expires * 1000).toLocaleDateString()}`
          : "sans limite de durée";
        box.innerHTML = `<strong>Licence Lumen Server active</strong> — au nom de ${esc(st.holder)}, ${until}.`;
      } else if (st.error) {
        // Une licence posée mais invalide doit se voir : la faire passer pour
        // « pas de licence » ferait chercher au mauvais endroit.
        box.innerHTML = `<strong>Licence refusée</strong> — ${esc(st.error)}`;
      } else {
        box.innerHTML = "Aucune licence Lumen Server. Toutes les applications restent disponibles ; seule la liaison à un serveur en demande une.";
      }
    } catch {
      box.textContent = "État de la licence indisponible.";
    }
  }

  async function renderPerms() {
    const list = $$("perms-list");
    if (!list || !invokeCmd) return;
    let installed = [];
    let store = {};
    try {
      installed = (await invokeCmd("app_list")) || [];
      store = (await invokeCmd("perm_list", { appId: null })) || {};
    } catch { /* backend absent : la section reste vide plutôt que fausse */ }

    list.innerHTML = "";
    const names = new Map(installed.map((a) => [a.id, a.name]));
    const ids = [...new Set([...Object.keys(store), ...installed.map((a) => a.id)])].sort();
    if (!ids.length) {
      list.innerHTML = '<p class="hint">Aucune application installée pour l\'instant.</p>';
      return;
    }
    for (const appId of ids) {
      const caps = store[appId] || {};
      const block = document.createElement("div");
      block.className = "perms-app";
      block.innerHTML = `<div class="perms-app-name">${esc(names.get(appId) || appId)}</div>`;
      const entries = Object.entries(caps);
      if (!entries.length) {
        block.insertAdjacentHTML("beforeend", '<div class="hint">Rien d\'accordé ni de refusé pour l\'instant.</div>');
      }
      for (const [cap, decision] of entries) {
        const row = document.createElement("div");
        row.className = "perms-row";
        row.innerHTML = `<span>${esc(capLabel(cap))}</span>
          <span class="perms-state ${decision === "granted" ? "ok" : "no"}">${decision === "granted" ? "Autorisé" : "Refusé"}</span>`;
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "btn";
        reset.textContent = "Redemander";
        reset.addEventListener("click", async () => {
          // « Ask » n'est pas une troisième valeur stockée : c'est l'effacement
          // de la décision, donc la question reposée à la prochaine utilisation.
          await invokeCmd("perm_set", { appId, cap, decision: "ask" });
          renderPerms();
        });
        row.appendChild(reset);
        block.appendChild(row);
      }
      list.appendChild(block);
    }
  }

  async function renderRepo() {
    const input = $$("input-repo");
    if (!input || !invokeCmd) return;
    try { input.value = await invokeCmd("store_repo_url"); } catch {}
  }

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  $$("btn-licence-activate")?.addEventListener("click", async () => {
    const key = $$("input-licence")?.value?.trim();
    if (!key) return;
    try {
      await invokeCmd("license_activate", { key });
      $$("input-licence").value = "";
      await renderLicence();
      // Les fenêtres déjà ouvertes peignent leurs menus depuis l'édition connue :
      // sans rechargement, les apps Pro n'apparaîtraient qu'au redémarrage.
      alert("Licence activée. Rechargez les fenêtres ouvertes pour voir les applications Pro.");
    } catch (error) {
      alert(String(error?.message || error));
    }
  });

  $$("btn-licence-clear")?.addEventListener("click", async () => {
    if (!confirm("Retirer la licence de cette machine ? Vos données Pro restent sur le disque.")) return;
    try { await invokeCmd("license_clear"); } catch {}
    renderLicence();
  });

  $$("btn-repo-save")?.addEventListener("click", async () => {
    try {
      const url = await invokeCmd("store_set_repo", { url: $$("input-repo").value.trim() });
      $$("input-repo").value = url;
      alert("Dépôt enregistré.");
    } catch (error) {
      alert(String(error?.message || error));
    }
  });

  // ----- Licence libre, consultable sans acceptation supplémentaire -------
  function renderEula() {
    const box = $$("eula-state");
    if (box) box.textContent = t("eula_pending") || "GPL-3.0-or-later";
  }
  $$("btn-eula-read")?.addEventListener("click", () => { showLicense({ readOnly: true }); });

  renderLicence();
  renderPerms();
  renderRepo();
  renderEula();
}

// Diagnostic (traces, réponses orchestrées, Profiler) : une app du bureau.
document.getElementById("btn-open-diagnostic")?.addEventListener("click", () => openLumenApp("diagnostic"));

// Moteur de décision : installation / activation selon la source d'IA courante
// (Ollama → tirage par Ollama, sinon GGUF sur le llama.cpp intégré).
(function mountSettingsDecision() {
  const root = document.getElementById("settings-decision");
  if (!root || !window.__TAURI__) return;
  const source = localStorage.getItem("aiSource") || "ollama";
  if (source === "shortcut") { root.closest(".setting-item").hidden = true; return; }
  mountDecisionCard(root, {
    t,
    engine: source === "ollama" ? "ollama" : "llama",
    ollamaUrl: localStorage.getItem("ollamaUrl") || "http://127.0.0.1:11434",
  });
})();


// Suivi de Claude Code dans la capsule : installe le hook (cf. hooks.rs).
document.getElementById("btn-hook-claude")?.addEventListener("click", async () => {
  const out = document.getElementById("hook-claude-status");
  try {
    const r = await window.__TAURI__.core.invoke("agent_hook_install", { target: "claude-code" });
    if (out) out.textContent = r;
  } catch (e) {
    if (out) out.textContent = String(e?.message || e);
  }
});
