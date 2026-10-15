// Gestionnaire d'agents. Données via commandes Rust (agents.rs) ; sandboxes et
// workflows listés via leurs commandes respectives.
// Fallback sur la fenêtre parente (intégration en iframe dans le bureau).
const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const { listen } = __TAURI.event || {};
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { autoTranslate, translatePage, tt, appLang } from "../apps-i18n.js";
import { ollamaGetJson, llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { agentAvatarHTML, avatarOf, randomAvatar, setAvatarState, preloadAvatar, AVATAR_COLORS, AVATAR_FACES } from "../lib/agent-avatar.js";
import { AGENT_TEMPLATES, TEMPLATE_CATEGORIES, templateDraft, templateText, localCronToUtc } from "../lib/agent-templates.js";
import { mountAvatarStudio } from "./avatar-studio.js";
import { icon as lumenIcon } from "../lib/icons.js";
import { mountCronEditor } from "../lib/cron-editor.js";
import { openLumenApp } from "../lib/open-app.js";
import { fillVoiceSelect, speakWithVoice } from "../lib/agent-voice.js";
autoTranslate({ observe: true });

let agents = [];
let sandboxes = [];
let workflows = [];
let editing = null; // copie de travail de l'agent en cours d'édition
let cronEditor = null; // instance de l'éditeur de récurrence (lib/cron-editor.js)
let calCursor = new Date(); // mois affiché dans la vue calendrier

const $ = (s) => document.querySelector(s);

// L'identité visuelle d'un agent est son AVATAR (personnage Kenney, cf.
// lib/agent-avatar.js) — il a remplacé l'ancienne icône et le sprite du Village.
// Toutes les surfaces (liste, en-tête, assistant, chat) le rendent pareil.
const av = (agent, size, opts = {}) => agentAvatarHTML(agent, { size, ...opts });

window.addEventListener("DOMContentLoaded", async () => {
  paintIcons();
  wire();
  await reloadAll();
  // Activité en direct quand un agent travaille (tick planifié ou manuel).
  listen("agent-progress", (e) => { addActivity(e.payload); heroMood(e.payload, e.payload?.success === false ? "fail" : "done"); });
  // Appels de skills intermédiaires (raisonnement de l'agent en direct).
  listen("agent-step", (e) => { addStep(e.payload); heroMood(e.payload, "work"); });
  // Tâches modifiées depuis l'extérieur (ex. assignation depuis le Kanban) : on
  // resynchronise la todo de l'agent ouvert sans écraser ses autres champs en
  // cours d'édition.
  listen("agents-updated", () => syncTasksFromDisk());
  // Escalade en direct : bannière mise à jour si l'agent affiché est concerné.
  listen("agent-escalated", (e) => {
    if (editing && e.payload && e.payload.agent_id === editing.id) refreshEscalation();
  });
});

async function syncTasksFromDisk() {
  const fresh = await invoke("agent_list").catch(() => null);
  if (!fresh) return;
  agents = fresh;
  if (editing && editing.id) {
    const a = agents.find((x) => x.id === editing.id);
    if (a) { editing.tasks = structuredClone(a.tasks || []); renderTasks(); renderCalendar?.(); }
  }
  renderSidebar();
}

async function reloadAll() {
  [agents, sandboxes, workflows] = await Promise.all([
    invoke("agent_list").catch(() => []),
    // Noms seuls, lisibles même bureau verrouillé : le choix, lui, demande le
    // mot de passe de session (cf. `askSessionPassword`).
    invoke("sandbox_list_names").catch(() => invoke("sandbox_list")).catch(() => []),
    invoke("list_fluxo_workflows").catch(() => []),
  ]);
  renderSidebar();
  if (editing) {
    const fresh = agents.find((a) => a.id === editing.id);
    if (fresh) editing = structuredClone(fresh);
  }
  if (editing) renderEditor(); else showEmpty();
}

// Un câblage ne doit jamais pouvoir en empêcher un autre. `wire()` enchaînait
// des `$("#id").addEventListener(…)` : un seul élément absent — renommé, retiré
// d'un build, pas encore peint — levait une TypeError, et TOUS les contrôles
// câblés après restaient morts. Le bouton « Lancer » se retrouvait ainsi sans
// gestionnaire : au clic, rien, pas même un message d'erreur.
//
// On lie donc chaque contrôle isolément. Un raté est signalé plutôt qu'avalé,
// et il ne coûte que son propre bouton.
const bindFailures = [];
function bind(sel, ev, fn, opts) {
  const el = typeof sel === "string" ? $(sel) : sel;
  if (!el) {
    bindFailures.push(sel);
    console.error(`[agents] contrôle introuvable, non câblé : ${sel}`);
    return null;
  }
  el.addEventListener(ev, (e) => {
    // Une exception dans un gestionnaire (y compris asynchrone) partait dans la
    // console d'une fenêtre qu'on n'ouvre jamais. Elle s'affiche maintenant là
    // où l'utilisateur regarde.
    try {
      const out = fn(e);
      if (out && typeof out.catch === "function") out.catch(reportUiError);
    } catch (err) { reportUiError(err); }
  }, opts);
  return el;
}

function reportUiError(err) {
  console.error("[agents]", err);
  const state = $("#save-state");
  if (state) state.textContent = tt("Erreur :") + " " + (err?.message || err);
}

function wire() {
  bind("#btn-new-agent", "click", newAgent);
  bind("#btn-diagnostic", "click", () => openLumenApp("diagnostic"));
  wireWizard();
  bind("#agent-name", "input", (e) => { editing.name = e.target.value; refreshSidebarName(); });
  bind("#agent-description", "input", (e) => { editing.description = e.target.value; });
  bind("#agent-icon", "click", openAvatarStudio);
  bind("#btn-open-designer", "click", openDesigner);
  bind("#agent-instruction", "input", (e) => { editing.instruction = e.target.value; });
  bind("#btn-var-add", "click", () => { (editing.variables ||= []).push({ key: "", value: "", hint: "" }); renderVariables(true); });
  bind("#agent-backend", "change", (e) => {
    editing.backend = e.target.value;
    // Les modèles ne se ressemblent pas d'une source à l'autre : garder le nom
    // précédent produirait un modèle introuvable au premier tick. On vide, et
    // le champ vide signifie « modèle global », qui est un repli valide.
    editing.model = "";
    $("#agent-model").value = "";
    const urlField = $("#agent-ollama-url")?.closest(".field");
    if (urlField) urlField.hidden = editingBackend() !== "ollama";
    loadModelSuggestions();
  });
  bind("#agent-model", "input", (e) => { editing.model = e.target.value; });
  bind("#agent-ollama-url", "input", (e) => { editing.ollama_url = e.target.value; });
  bind("#agent-num-ctx", "input", (e) => { editing.num_ctx = parseInt(e.target.value, 10) || 0; });
  bind("#agent-voice", "change", (e) => { editing.voice = e.target.value; });
  bind("#btn-voice-test", "click", () => {
    const name = editing?.name || "Lumen";
    const text = appLang() === "en" ? `Hello, I am ${name}. This is my voice.` : `Bonjour, je suis ${name}. Voici ma voix.`;
    const btn = $("#btn-voice-test");
    speakWithVoice(invoke, $("#agent-voice").value || "", text).catch((e) => { btn.title = String(e?.message || e); btn.classList.add("danger"); });
  });
  bind("#agent-enabled", "change", (e) => { editing.enabled = e.target.checked; });
  bind("#agent-learning", "change", (e) => { editing.learning_enabled = e.target.checked; });
  bind("#agent-orchestrator", "change", (e) => { editing.orchestrator = e.target.checked; });
  bind("#agent-create-skills", "change", (e) => { editing.can_create_skills = e.target.checked; });
  bind("#agent-max-iters", "input", (e) => { editing.max_iterations = parseInt(e.target.value, 10) || 0; });
  bind("#agent-max-tokens", "input", (e) => { editing.max_tokens = parseInt(e.target.value, 10) || 0; });
  bind("#agent-permission-mode", "change", (e) => applyPermissionMode(e.target.value));
  bind("#esc-continue", "click", () => decideEscalation(true));
  bind("#esc-abort", "click", () => decideEscalation(false));
  bind("#btn-distill", "click", distillMemory);
  bind("#agent-lessons", "input", (e) => { editing.memory = editing.memory || {}; editing.memory.lessons = e.target.value; });
  bind("#agent-sandbox", "change", onSandboxPick);
  bind("#pw-form", "submit", (e) => { e.preventDefault(); submitSessionPassword(); });
  bind("#pw-cancel", "click", () => closeSessionPassword(false));
  bind("#pw-modal", "keydown", (e) => { if (e.key === "Escape") closeSessionPassword(false); });
  bind("#btn-open-sandbox", "click", openAgentSandbox);
  bind("#btn-add-skill", "click", addSkill);
  bind("#btn-add-task", "click", addTask);
  bind("#task-input", "keydown", (e) => { if (e.key === "Enter") addTask(); });
  bind("#btn-calendar", "click", openCalendar);
  bind("#cal-close", "click", () => { $("#calendar-modal").hidden = true; });
  bind("#cal-prev", "click", () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); });
  bind("#cal-next", "click", () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); });
  bind("#btn-save", "click", saveAgent);
  bind("#btn-delete", "click", deleteAgent);
  bind("#btn-run", "click", runNow);
  bind("#btn-publish-server", "click", publishToServer);
  bind("#btn-queue-server", "click", queueOnServer);
  bind("#btn-cancel-run", "click", cancelRun);
  bind("#btn-clear-activity", "click", clearActivity);
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  bind("#btn-corpus-build", "click", buildCorpus);
  bind("#btn-case-add", "click", addManualCase);
  bind("#btn-optimize-instruction", "click", optimizeInstruction);

  // Studio d'avatar (modale) : on édite une copie, « Appliquer » la reporte.
  bind("#avatar-modal-close", "click", closeAvatarStudio);
  bind("#avatar-cancel", "click", closeAvatarStudio);
  bind("#avatar-apply", "click", applyAvatarStudio);
  bind("#avatar-modal", "click", (e) => { if (e.target.id === "avatar-modal") closeAvatarStudio(); });
  bind("#avatar-modal", "keydown", (e) => { if (e.key === "Escape") closeAvatarStudio(); });

  if (bindFailures.length) {
    console.error(`[agents] ${bindFailures.length} contrôle(s) non câblé(s) :`, bindFailures);
  }
}


// ===== Icônes & onglets =====================================================

/** Remplit tous les `data-ic` du document avec le jeu d'icônes de Lumen. */
function paintIcons(root = document) {
  root.querySelectorAll("[data-ic]").forEach((el) => {
    if (el.firstChild) return;           // déjà peint
    el.innerHTML = lumenIcon(el.dataset.ic);
  });
}

/** Onglet actif de l'éditeur. Mémorisé : on revient là où on travaillait. */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel-tab").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
  try { localStorage.setItem("agentsTab", name); } catch { /* stockage indisponible */ }
  if (name === "progress") loadEvolution();
}

function currentTab() {
  try { return localStorage.getItem("agentsTab") || "tasks"; } catch { return "tasks"; }
}

// Source d'IA effective de l'agent en cours d'édition : la sienne si elle est
// définie, sinon celle de Lumen (c'est elle qui s'appliquera à l'exécution).
function editingBackend() {
  const own = (editing && editing.backend) || "";
  if (own) return own;
  try { return localStorage.getItem("aiSource") || "ollama"; } catch { return "ollama"; }
}

// Peuple la liste de suggestions de modèles selon la source d'IA de l'agent :
// noms Ollama, fichiers GGUF locaux, ou modèles de l'API cloud. Proposer des
// modèles Ollama à un agent réglé sur llama.cpp n'aurait produit que des noms
// invalides.
async function loadModelSuggestions() {
  const dl = $("#agent-model-list");
  if (!dl) return;
  const backend = editingBackend();
  const hint = $("#agent-model-hint");
  let models = [];
  try {
    if (backend === "llama") {
      const list = await invoke("llama_list_models");
      models = (Array.isArray(list) ? list : []).map((m) => m.filename);
      if (hint) hint.textContent = "Fichier GGUF géré par Lumen (téléchargeable depuis les Réglages).";
    } else if (backend === "api") {
      // `llm_cloud_models` et non `llm_api_models` : ce dernier interroge la
      // source COURANTE de Lumen, et listait donc les GGUF locaux quand Lumen
      // tourne en llama.cpp — sous l'étiquette « API cloud ».
      models = await invoke("llm_cloud_models");
      if (hint) hint.textContent = "Modèle de l'API cloud configurée dans les Réglages.";
    } else {
      const url = (editing && editing.ollama_url) || localStorage.getItem("ollamaUrl") || "http://localhost:11434";
      models = ((await ollamaGetJson("api/tags", url)).models || []).map((m) => m.name);
      if (hint) hint.textContent = "Doit supporter les outils (qwen2.5, llama3.1…).";
    }
  } catch (e) { /* hors-ligne ou source indisponible : pas de suggestions */ }
  dl.innerHTML = (Array.isArray(models) ? models : [])
    .filter(Boolean)
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

// Champ historique `icon` : conservé pour la compatibilité du format, l'UI ne
// l'affiche plus (l'avatar l'a remplacé).
const DEFAULT_ICON = "sparkles";
const uiLang = () => (String(appLang?.() || "fr").startsWith("en") ? "en" : "fr");

// Agent neuf, tous champs présents. Extrait de `newAgent` pour que l'assistant
// parte EXACTEMENT des mêmes valeurs par défaut sans peindre l'éditeur derrière
// sa modale — un champ oublié ici casserait `agent_save` côté Rust.
function blankAgent() {
  return { id: "", name: "", icon: DEFAULT_ICON, description: "", instruction: "", backend: "", model: "", ollama_url: "", num_ctx: 0, voice: "", sandbox_id: "", skills: [], mcp_servers: [], native_tools: [], tasks: [], cron: "", enabled: false, created: 0, appearance: {}, avatar: randomAvatar(), learning_enabled: false, memory: { lessons: "" }, orchestrator: false, can_create_skills: false, max_iterations: 0, max_tokens: 0, allowed_effects: [], require_approval_for: [], variables: [] };
}

function newAgent() {
  editing = blankAgent();
  renderEditor();
  setTimeout(() => $("#agent-name").focus(), 0);
}

function permissionModeOf(agent) {
  const allowed = agent.allowed_effects || [];
  const approvals = agent.require_approval_for || [];
  if (allowed.length && !allowed.includes("destructive")) return "strict";
  if (approvals.length === 2 && approvals.includes("high") && approvals.includes("destructive")) return "trusted";
  return "balanced";
}

function applyPermissionMode(mode) {
  if (!editing) return;
  if (mode === "strict") {
    // « Strict » n'interdit plus les outils EXTERNES : un outil coché
    // explicitement (météo, actualités…) doit pouvoir servir. Il interdit le
    // destructif et fait valider l'écriture et tout risque moyen ou élevé.
    editing.allowed_effects = ["read", "write", "external"];
    editing.require_approval_for = ["write", "medium", "high"];
  } else if (mode === "trusted") {
    editing.allowed_effects = [];
    editing.require_approval_for = ["high", "destructive"];
  } else {
    editing.allowed_effects = [];
    editing.require_approval_for = [];
  }
}

function openDesigner() {
  invoke("open_fluxo_designer").catch((e) => { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); });
}

// ===== Avatar ===============================================================

/** Peint l'avatar de l'en-tête de l'éditeur. */
function renderHeroAvatar(state = "idle") {
  const slot = document.querySelector("#agent-icon .agent-avatar-slot");
  if (slot && editing) slot.innerHTML = av(editing, 54, { state, title: editing.name || tt("Avatar") });
}

// L'avatar de l'en-tête vit au rythme de l'agent : il s'active pendant un run,
// saute de joie à la réussite, secoue la tête à l'échec, puis revient au repos.
let heroMoodTimer = null;
function heroMood(p, mood) {
  if (!editing || !p || p.agent_id !== editing.id) return;
  const el = document.querySelector("#agent-icon .ka");
  if (!el) return;
  clearTimeout(heroMoodTimer);
  setAvatarState(el, mood);
  // Sans nouvelle étape pendant 20 s, on considère le run terminé ou en pause.
  heroMoodTimer = setTimeout(() => setAvatarState(el, "idle"), mood === "work" ? 20000 : 2600);
}

let studio = null;
let studioDraft = null;
function openAvatarStudio(e) {
  e?.stopPropagation();
  if (!editing) return;
  studioDraft = avatarOf(editing);
  const host = $("#avatar-studio");
  if (!studio) studio = mountAvatarStudio(host, { value: studioDraft, onChange: (a) => { studioDraft = a; } });
  else studio.set(studioDraft);
  $("#avatar-modal").hidden = false;
  paintIcons($("#avatar-modal"));
  setTimeout(() => $("#avatar-apply")?.focus(), 0);
}
function closeAvatarStudio() { $("#avatar-modal").hidden = true; }
function applyAvatarStudio() {
  if (editing && studioDraft) {
    editing.avatar = { ...studioDraft };
    renderHeroAvatar("done");
    setTimeout(() => renderHeroAvatar(), 1700);
    const state = $("#save-state");
    if (state) state.textContent = tt("Avatar modifié — pense à Enregistrer");
  }
  closeAvatarStudio();
}

function showEmpty() {
  $("#editor").hidden = true;
  $("#empty").hidden = false;
  renderEmptyHome();
}

// ===== Modèles d'agents =====================================================

// Vitrine de l'accueil : quelques personnages des modèles, qui bougent.
function renderEmptyHome() {
  const crew = $("#empty-crew");
  if (crew && !crew.childElementCount) {
    crew.innerHTML = AGENT_TEMPLATES.slice(0, 5)
      .map((t, i) => `<span class="crew-slot" style="--i:${i}">${av(t.avatar, i === 2 ? 92 : 70, { title: templateText(t, uiLang()).name })}</span>`)
      .join("");
  }
  renderTemplates($("#empty-tpl-cats"), $("#empty-templates"), (tpl) => { openWizard(); startFromTemplate(tpl); });
  paintIcons($("#empty"));
}

let tplCategory = "all";
/**
 * Galerie de modèles (accueil ET première étape de l'assistant) : filtres de
 * catégorie + cartes. Un clic choisit le modèle — rien n'est créé avant la
 * revue de l'assistant.
 */
function renderTemplates(catsHost, gridHost, onPick) {
  if (!gridHost) return;
  const lang = uiLang();
  if (catsHost) {
    catsHost.innerHTML = "";
    for (const c of TEMPLATE_CATEGORIES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tpl-cat" + (c.key === tplCategory ? " on" : "");
      b.textContent = c[lang] || c.fr;
      b.addEventListener("click", () => { tplCategory = c.key; renderTemplates(catsHost, gridHost, onPick); });
      catsHost.appendChild(b);
    }
  }
  gridHost.innerHTML = "";
  for (const tpl of AGENT_TEMPLATES.filter((t) => tplCategory === "all" || t.category === tplCategory)) {
    const t = templateText(tpl, lang);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "tpl-card ka-wave";
    card.style.setProperty("--tpl-c", (AVATAR_TINT[tpl.avatar.color] || "#7c6cf0"));
    card.innerHTML =
      `<span class="tpl-av">${av(tpl.avatar, 58)}</span>`
      + `<span class="tpl-tx"><b>${escapeHtml(t.name)}</b><i>${escapeHtml(t.tagline)}</i>`
      + `<span class="tpl-meta">${lumenIcon("pocket-knife")}${tpl.tools.length} ${escapeHtml(tt("outils"))}`
      + `${tpl.cron ? ` · ${lumenIcon("clock")}${escapeHtml(tt("planifié"))}` : ""}</span></span>`;
    card.title = t.description;
    card.addEventListener("click", () => onPick(tpl));
    gridHost.appendChild(card);
  }
}
const AVATAR_TINT = { blue: "#6f8ff0", purple: "#8e5be0", pink: "#f27fbf", red: "#e0545f", yellow: "#f5b12d", green: "#5cbf6e" };

// Un modèle remplace la génération par IA : le brouillon est complet d'emblée,
// toutes les étapes deviennent accessibles et l'on atterrit sur l'identité.
async function startFromTemplate(tpl) {
  if (!nativeToolCatalog) {
    try { nativeToolCatalog = await invoke("native_tool_catalog"); } catch { nativeToolCatalog = []; }
  }
  const ids = (nativeToolCatalog || []).map((t) => t.id);
  wizDraft = templateDraft(tpl, uiLang(), ids);
  wizDraft.brief = "";
  wizDraft.note = "";
  renderWizardIdentity();
  renderWizardBehavior();
  renderWizardTools();
  renderWizardPlan();
  wizSeen = WIZ_STEPS.length - 1;
  wizAt = 1;
  paintWizardStep();
}

function renderSidebar() {
  const list = $("#agent-list");
  list.innerHTML = "";
  if (!agents.length) {
    list.innerHTML = `<div class="agent-list-empty">${tt("Aucun agent.")}<br>${tt("Décris ce que tu veux, l'assistant s'occupe du reste.")}</div>`;
    return;
  }
  for (const a of agents) {
    const el = document.createElement("div");
    el.className = "agent-item" + (a.enabled ? " on" : "") + (editing && editing.id === a.id ? " active" : "");
    const sub = a.description ? `<span class="sub">${escapeHtml(a.description)}</span>` : `<span class="sub muted">${tt(a.enabled ? "Planifié" : "Manuel")}</span>`;
    el.innerHTML =
      `<span class="agent-item-ic">${av(a, 34, { hands: false })}</span>` +
      `<span class="agent-item-text"><span class="nm">${escapeHtml(a.name || tt("Sans nom"))}</span>${sub}</span>` +
      `<span class="dot"></span>`;
    el.addEventListener("click", () => { editing = structuredClone(a); renderEditor(); renderSidebar(); });
    list.appendChild(el);
  }
}

// Met à jour à la volée le nom/description affichés dans la barre latérale pendant
// la saisie (sans recharger toute la liste).
function refreshSidebarName() {
  if (!editing || !editing.id) return;
  const items = document.querySelectorAll("#agent-list .agent-item");
  const idx = agents.findIndex((a) => a.id === editing.id);
  const el = items[idx];
  if (el) {
    const nm = el.querySelector(".nm");
    if (nm) nm.textContent = editing.name || tt("Sans nom");
  }
}

function renderLessons() {
  const box = $("#agent-lessons");
  if (!box) return;
  editing.memory = editing.memory || { lessons: "" };
  box.value = editing.memory.lessons || "";
  const meta = $("#lessons-meta");
  if (meta) {
    const at = editing.memory.distilled_at;
    meta.textContent = at
      ? tt("Distillée le") + " " + new Date(at * 1000).toLocaleString() + (editing.memory.task_count ? ` · ${editing.memory.task_count} ${tt("tâches")}` : "")
      : tt("Modifiable : écris ou édite les leçons à la main, puis Enregistre.");
  }
}

async function distillMemory() {
  if (!editing.id) { $("#save-state").textContent = tt("Enregistre l'agent d'abord."); return; }
  const btn = $("#btn-distill");
  const prev = btn.textContent; btn.disabled = true; btn.textContent = tt("Distillation…");
  $("#save-state").textContent = tt("Distillation en cours (modèle)…");
  try {
    const lessons = await invoke("agent_distill_memory", { id: editing.id });
    editing.memory = editing.memory || {};
    editing.memory.lessons = lessons;
    editing.memory.distilled_at = Math.floor(Date.now() / 1000);
    renderLessons();
    $("#save-state").textContent = tt("Mémoire mise à jour ✓");
  } catch (e) {
    $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e);
  } finally { btn.disabled = false; btn.textContent = prev; }
}

function renderEditor() {
  $("#empty").hidden = true;
  $("#editor").hidden = false;
  translatePage();  // l'éditeur était masqué : traduire son contenu statique
  $("#agent-name").value = editing.name;
  $("#agent-description").value = editing.description || "";
  renderHeroAvatar();
  preloadAvatar(editing);
  $("#agent-instruction").value = editing.instruction || "";
  renderVariables();
  $("#agent-backend").value = editing.backend || "";
  $("#agent-model").value = editing.model || "";
  $("#agent-ollama-url").value = editing.ollama_url || "";
  // L'URL Ollama dédiée n'a de sens que pour la source Ollama.
  const urlField = $("#agent-ollama-url")?.closest(".field");
  if (urlField) urlField.hidden = editingBackend() !== "ollama";
  $("#agent-num-ctx").value = editing.num_ctx || "";
  fillVoiceSelect($("#agent-voice"), invoke, editing.voice || "", { isEn: appLang() === "en" }).catch(() => {});
  $("#agent-enabled").checked = !!editing.enabled;
  $("#agent-learning").checked = !!editing.learning_enabled;
  $("#agent-orchestrator").checked = !!editing.orchestrator;
  $("#agent-create-skills").checked = !!editing.can_create_skills;
  $("#agent-max-iters").value = editing.max_iterations || "";
  $("#agent-max-tokens").value = editing.max_tokens || "";
  $("#agent-permission-mode").value = permissionModeOf(editing);
  refreshEscalation();
  renderLessons();
  loadModelSuggestions();

  // Sandboxes
  const sb = $("#agent-sandbox");
  sb.innerHTML = `<option value="">${tt("— Aucune —")}</option>`;
  for (const s of sandboxes) {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name;
    sb.appendChild(o);
  }
  sb.value = editing.sandbox_id || "";
  updateSandboxBtn();

  // Récurrence : constructeur visuel + saisie manuelle (lib/cron-editor.js).
  // L'éditeur est monté une fois puis rechargé à chaque changement d'agent —
  // le remonter à chaque rendu perdrait le mode en cours de réglage.
  if (cronEditor) {
    cronEditor.setValue(editing.cron || "");
  } else {
    cronEditor = mountCronEditor($("#agent-cron"), {
      value: editing.cron || "",
      onChange: (expr) => { editing.cron = expr; },
    });
  }

  renderSkills();
  renderSkillSelect();
  renderMcpServers();
  renderNativeTools();
  renderTasks();
  $("#save-state").textContent = editing.id ? "" : tt("Non enregistré");
  showTab(currentTab());
  refreshCounts();
  paintIcons();
  loadActivity();
}

/** Pastilles de comptage sur les onglets : on voit la charge sans y entrer. */
function refreshCounts() {
  const open = (editing?.tasks || []).filter((t) => !t.done).length;
  $("#count-tasks").textContent = open || "";
  $("#count-skills").textContent = (editing?.skills || []).length || "";
}

// Charge l'activité persistée de l'agent (conservée jusqu'à suppression).
async function loadActivity() {
  const list = $("#activity");
  list.innerHTML = "";
  if (!editing || !editing.id) return;
  let entries = [];
  try { entries = await invoke("agent_activity", { id: editing.id }); } catch (e) { entries = []; }
  for (const p of entries) {
    if (p.kind === "step") renderStep(p);
    else if (p.kind === "thought") renderThought(p);
    else renderReport(p);
  }
}

async function clearActivity() {
  if (!editing || !editing.id) { $("#activity").innerHTML = ""; return; }
  try {
    await invoke("agent_activity_clear", { id: editing.id });
    $("#activity").innerHTML = "";
  } catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
}

function renderSkills() {
  const wrap = $("#skills");
  wrap.innerHTML = "";
  if (!editing.skills.length) {
    wrap.innerHTML = `<span class="hint">${tt("Aucun skill. Les tâches seront simplement archivées.")}</span>`;
    return;
  }
  editing.skills.forEach((name, i) => {
    const chip = document.createElement("span");
    chip.className = "skill-chip";
    chip.innerHTML = `<span class="order">${i + 1}.</span><span>${escapeHtml(name)}</span><span class="rm">✕</span>`;
    chip.querySelector(".rm").addEventListener("click", () => { editing.skills.splice(i, 1); renderSkills(); });
    wrap.appendChild(chip);
  });
}

// Outils natifs de Lumen, groupés comme dans le catalogue backend. Le catalogue
// fait foi : l'atelier n'en connaît aucun en dur, il affiche ce que
// `native_tool_catalog` renvoie (libellé et description déjà dans la langue de
// Lumen). Ajouter une capacité côté Rust la fait apparaître ici sans toucher
// à cette interface.
const NATIVE_GROUPS = {
  home: "Maison connectée",
  web: "Web",
  live: "Données en direct",
  knowledge: "Connaissances locales",
  memory: "Mémoire & rappels",
  files: "Fichiers de la sandbox",
  lumen: "Lumen",
  mail: "Courrier",
};

let nativeToolCatalog = null;

async function renderNativeTools() {
  const wrap = $("#agent-native-tools");
  if (!wrap) return;
  if (!nativeToolCatalog) {
    try { nativeToolCatalog = await invoke("native_tool_catalog"); } catch { nativeToolCatalog = []; }
  }
  if (!Array.isArray(editing.native_tools)) editing.native_tools = [];
  wrap.innerHTML = "";
  if (!nativeToolCatalog.length) {
    wrap.innerHTML = `<span class="hint">${tt("Aucun outil natif disponible.")}</span>`;
    return;
  }
  const groups = [...new Set(nativeToolCatalog.map((t) => t.group))];
  for (const group of groups) {
    const head = document.createElement("div");
    head.className = "hint";
    head.style.margin = "8px 0 4px";
    head.textContent = tt(NATIVE_GROUPS[group] || group);
    wrap.appendChild(head);

    const row = document.createElement("div");
    row.className = "skills";
    for (const tool of nativeToolCatalog.filter((t) => t.group === group)) {
      const on = editing.native_tools.includes(tool.id);
      const chip = document.createElement("span");
      chip.className = "skill-chip" + (on ? "" : " off");
      chip.style.opacity = on ? "1" : "0.55";
      chip.style.cursor = "pointer";
      // L'effet est le seul détail de contrat utile ici : « external » = l'appel
      // sort de la machine et passera par une approbation.
      const tag = tool.effect === "external" ? " ↗" : "";
      chip.title = tool.description;
      chip.innerHTML = `<span>${on ? "✓" : "○"}</span><span>${escapeHtml(tool.label)}${tag}</span>`;
      chip.addEventListener("click", () => {
        if (on) editing.native_tools = editing.native_tools.filter((id) => id !== tool.id);
        else editing.native_tools.push(tool.id);
        renderNativeTools();
      });
      row.appendChild(chip);
    }
    wrap.appendChild(row);
  }
}

// Connecteurs MCP disponibles : on ne propose que ceux ACTIVÉS globalement.
// Cocher revient à autoriser cet agent à les voir ; décoché, rien n'est injecté.
async function renderMcpServers() {
  const wrap = $("#agent-mcp-list");
  if (!wrap) return;
  let servers = [];
  try { servers = await invoke("mcp_servers"); } catch { servers = []; }
  const enabled = (servers || []).filter((s) => s.enabled);
  wrap.innerHTML = "";
  if (!enabled.length) {
    wrap.innerHTML = `<span class="hint">${tt("Aucun connecteur MCP activé (Paramètres → Connecteurs).")}</span>`;
    return;
  }
  if (!Array.isArray(editing.mcp_servers)) editing.mcp_servers = [];
  for (const server of enabled) {
    const on = editing.mcp_servers.includes(server.id);
    const chip = document.createElement("span");
    chip.className = "skill-chip" + (on ? "" : " off");
    chip.style.opacity = on ? "1" : "0.55";
    chip.innerHTML = `<span>${on ? "✓" : "○"}</span><span>${escapeHtml(server.name)}</span>`;
    chip.style.cursor = "pointer";
    chip.addEventListener("click", () => {
      if (on) editing.mcp_servers = editing.mcp_servers.filter((id) => id !== server.id);
      else editing.mcp_servers.push(server.id);
      renderMcpServers();
    });
    wrap.appendChild(chip);
  }
}

function renderSkillSelect() {
  const sel = $("#skill-select");
  sel.innerHTML = "";
  if (!workflows.length) {
    sel.innerHTML = `<option value="">${tt("Aucun workflow — crée-en dans le designer Fluxo")}</option>`;
    return;
  }
  for (const w of workflows) {
    const o = document.createElement("option");
    o.value = w; o.textContent = w;
    sel.appendChild(o);
  }
}

// Active le bouton « Ouvrir » seulement si une sandbox est attribuée.
function updateSandboxBtn() {
  const btn = $("#btn-open-sandbox");
  if (btn) btn.disabled = !(editing && editing.sandbox_id);
}

// Ouvre l'explorateur de sandboxes en présélectionnant celle de l'agent.
async function openAgentSandbox() {
  if (!editing || !editing.sandbox_id) return;
  try { await invoke("open_sandbox_explorer", { sandboxId: editing.sandbox_id }); }
  catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
}

function addSkill() {
  const v = $("#skill-select").value;
  if (!v) return;
  editing.skills.push(v);
  renderSkills();
}

// Les tâches sont enregistrées dès qu'on y touche : le bouton « Enregistrer »
// est en bas de page, hors de vue quand on est dans la liste, et une tâche
// ajoutée puis perdue est un bug silencieux. On passe par `agent_set_tasks`, qui
// n'écrit QUE la todo : `agent_save` emporterait aussi l'instruction et les
// réglages en cours d'édition, que l'utilisateur n'a pas validés.
//
// Tant que l'agent n'a pas d'id (jamais enregistré), il n'y a rien à mettre à
// jour sur le disque : on le dit, plutôt que d'échouer en silence.
let tasksSaveSeq = 0;
async function persistTasks() {
  const state = $("#tasks-state");
  if (!editing) return;
  if (!editing.id) {
    if (state) { state.className = "tasks-state hint-inline"; state.textContent = tt("Enregistrez l'agent pour conserver ses tâches."); }
    return;
  }
  const seq = ++tasksSaveSeq;
  try {
    await invoke("agent_set_tasks", { agentId: editing.id, tasks: editing.tasks });
    // Une sauvegarde plus ancienne qui répond après une plus récente ne doit pas
    // repeindre un état périmé.
    if (seq !== tasksSaveSeq || !state) return;
    state.className = "tasks-state ok";
    state.textContent = tt("Tâches enregistrées ✓");
    setTimeout(() => { if (seq === tasksSaveSeq && state.classList.contains("ok")) state.textContent = ""; }, 2000);
  } catch (e) {
    if (seq !== tasksSaveSeq || !state) return;
    state.className = "tasks-state err";
    state.textContent = tt("Échec :") + " " + (e?.message || e);
  }
}

function renderTasks() {
  const wrap = $("#tasks");
  wrap.innerHTML = "";
  if (!editing.tasks.length) {
    wrap.innerHTML = `<span class="hint">${tt("Aucune tâche.")}</span>`;
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  editing.tasks.forEach((t, i) => {
    const scheduled = t.due != null && t.due > nowSec; // programmée dans le futur
    const row = document.createElement("div");
    row.className = "task-row" + (t.done ? " done" : "") + (scheduled ? " scheduled" : "");
    const badge = t.due != null
      ? `<span class="task-due${scheduled ? "" : " due-now"}" title="${tt(scheduled ? "Programmée — invisible pour l'agent jusqu'à cette date" : "Échue — accessible à l'agent")}">${scheduled ? "🔒 " : ""}${fmtDue(t.due)}</span>`
      : "";
    const priority = Number(t.priority || 0);
    const criteria = (t.acceptance_criteria || []).length ? ` · ✓ ${(t.acceptance_criteria || []).length} critère(s)` : "";
    const priorityBadge = priority ? `<span class="task-due">P${priority > 0 ? "+" : ""}${priority}${criteria}</span>` : (criteria ? `<span class="task-due">${criteria.slice(3)}</span>` : "");
    row.innerHTML = `<span class="task-check">${t.done ? "✓" : ""}</span><span class="task-text">${escapeHtml(t.text)}</span>${priorityBadge}${badge}<input type="date" class="task-date-edit input" value="${dueToDate(t.due)}" title="${tt("Date d'exécution programmée")}" /><span class="task-rm">✕</span>`;
    row.querySelector(".task-check").addEventListener("click", () => { t.done = !t.done; renderTasks(); persistTasks(); });
    row.querySelector(".task-date-edit").addEventListener("change", (e) => { t.due = dateToDue(e.target.value); renderTasks(); persistTasks(); });
    row.querySelector(".task-rm").addEventListener("click", () => { editing.tasks.splice(i, 1); renderTasks(); persistTasks(); });
    wrap.appendChild(row);
  });
}

function addTask() {
  const input = $("#task-input");
  const dateInput = $("#task-date");
  const criteriaInput = $("#task-criteria");
  const priorityInput = $("#task-priority");
  const text = input.value.trim();
  if (!text) return;
  const acceptance_criteria = criteriaInput.value.split(";").map((v) => v.trim()).filter(Boolean);
  editing.tasks.push({ id: `t-${Date.now()}`, text, done: false, due: dateToDue(dateInput.value), acceptance_criteria, priority: parseInt(priorityInput.value, 10) || 0 });
  input.value = "";
  dateInput.value = "";
  criteriaInput.value = "";
  priorityInput.value = "0";
  renderTasks();
  persistTasks();
}

// ===== Dates des tâches =====
// `due` = epoch **secondes** au minuit local du jour programmé (ou null).
function dateToDue(str) {
  if (!str) return null;
  const [y, m, d] = str.split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
}
function dueToDate(due) {
  if (due == null) return "";
  const dt = new Date(due * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
function fmtDue(due) {
  return new Date(due * 1000).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

/// Variables de l'agent : lignes « nom / valeur » éditables (supprimées si vides
/// à l'enregistrement).
function renderVariables(focusLast = false) {
  const box = $("#agent-vars");
  if (!box) return;
  const vars = (editing.variables ||= []);
  box.innerHTML = "";
  if (!vars.length) {
    const p = document.createElement("p");
    p.className = "var-empty";
    p.textContent = "Aucune variable. Exemple : ville = Lyon, thèmes = IA, course à pied.";
    box.appendChild(p);
    return;
  }
  vars.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "var-row";
    const key = Object.assign(document.createElement("input"), { className: "input", placeholder: "nom (ex. ville)", value: v.key || "" });
    const val = Object.assign(document.createElement("input"), { className: "input", placeholder: "valeur", value: v.value || "" });
    if (v.hint) val.title = v.hint;
    const del = Object.assign(document.createElement("button"), { type: "button", className: "var-del", textContent: "×", title: "Supprimer" });
    key.addEventListener("input", () => { v.key = key.value.trim().replace(/\s+/g, "_"); });
    val.addEventListener("input", () => { v.value = val.value; });
    del.addEventListener("click", () => { vars.splice(i, 1); renderVariables(); });
    row.append(key, val, del);
    box.appendChild(row);
  });
  if (focusLast) box.querySelector(".var-row:last-child input")?.focus();
}

async function saveAgent() {
  editing.variables = (editing.variables || []).filter((v) => String(v.key || "").trim());
  if (!editing.name.trim()) { $("#save-state").textContent = tt("Nom requis"); return; }
  try {
    const saved = await invoke("agent_save", { agent: editing });
    editing = structuredClone(saved);
    $("#save-state").textContent = tt("Enregistré ✓");
    await reloadAll();
  } catch (e) {
    const msg = String(e?.message || e);
    // Autorisation expirée entre le choix et l'enregistrement : on redemande.
    if (msg.startsWith("SESSION_LOCKED") && await askSessionPassword()) return saveAgent();
    $("#save-state").textContent = tt("Échec :") + " " + msg.replace(/^SESSION_LOCKED:\s*/, "");
  }
}

// ===== Sandbox & mot de passe de session ====================================
// Attribuer une sandbox ouvre à l'agent un espace de fichiers : bureau Lumen OS
// verrouillé, le choix exige le mot de passe de session. La vérification se
// fait côté Rust (`session_authorize_config`) et accorde une autorisation
// courte, sans déverrouiller le bureau ; `agent_save` la contrôle à nouveau.
async function onSandboxPick(e) {
  const next = e.target.value;
  const prev = editing.sandbox_id || "";
  if (next === prev) return;
  let unlocked = true;
  try { unlocked = await invoke("session_is_unlocked"); } catch { unlocked = true; }
  if (!unlocked && !(await askSessionPassword())) {
    e.target.value = prev;
    return;
  }
  editing.sandbox_id = next;
  updateSandboxBtn();
  $("#save-state").textContent = tt("Sandbox choisie — pense à Enregistrer");
}

let pwResolve = null;
function askSessionPassword() {
  return new Promise((resolve) => {
    pwResolve = resolve;
    $("#pw-input").value = "";
    $("#pw-error").hidden = true;
    $("#pw-modal").hidden = false;
    paintIcons($("#pw-modal"));
    setTimeout(() => $("#pw-input").focus(), 0);
  });
}
function closeSessionPassword(ok) {
  $("#pw-modal").hidden = true;
  $("#pw-input").value = "";
  const r = pwResolve; pwResolve = null;
  r?.(ok);
}
async function submitSessionPassword() {
  const password = $("#pw-input").value;
  if (!password) { $("#pw-input").focus(); return; }
  const btn = $("#pw-ok");
  btn.disabled = true;
  try {
    await invoke("session_authorize_config", { password });
    closeSessionPassword(true);
  } catch (err) {
    const box = $("#pw-error");
    box.hidden = false;
    box.textContent = tt(String(err?.message || err));
    $("#pw-input").select();
  } finally { btn.disabled = false; }
}

async function deleteAgent() {
  if (!editing.id) { editing = null; showEmpty(); renderSidebar(); return; }
  const ok = await confirmDelete(editing.name);
  if (!ok) return;
  try {
    await invoke("agent_delete", { id: editing.id });
    editing = null;
    await reloadAll();
    showEmpty();
  } catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
}

async function runNow() {
  if (!editing.id) { $("#save-state").textContent = tt("Enregistre l'agent d'abord"); return; }
  $("#save-state").textContent = tt("Exécution…");
  try {
    await invoke("agent_run_now", { id: editing.id });
    $("#save-state").textContent = tt("Tick exécuté ✓");
    await reloadAll(); // reflète la tâche passée à « faite »
  } catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
}

async function publishToServer() {
  if (!editing.name.trim()) { $("#save-state").textContent = tt("Nom requis"); return; }
  if (!editing.id) await saveAgent();
  if (!editing?.id) return;
  $("#save-state").textContent = "Publication sur Lumen Server…";
  try {
    await invoke("agent_publish_server", { id: editing.id });
    $("#save-state").textContent = "Publié sur Lumen Server ✓";
  } catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
}

async function queueOnServer() {
  if (!editing?.id) { $("#save-state").textContent = tt("Enregistre l'agent d'abord"); return; }
  const input = await promptSheet({ title: tt("Quelle tâche confier à l'exécuteur Lumen connecté à ce serveur ?"), multiline: true, confirm: tt("Ajouter"), cancel: tt("Annuler") });
  if (input == null || !input.trim()) return;
  $("#save-state").textContent = "Ajout à la file du serveur…";
  try {
    const result = await invoke("agent_queue_server", { id: editing.id, input: input.trim() });
    $("#save-state").textContent = `Tâche ${result.run} ajoutée à la file serveur.`;
  } catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
}

async function cancelRun() {
  if (!editing?.id) return;
  try {
    const cancelled = await invoke("agent_cancel_run", { agentId: editing.id });
    $("#save-state").textContent = cancelled ? tt("Annulation demandée…") : tt("Aucun run actif");
  } catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
}

// ===== Escalade (garde-fous tokens/itérations) =====
// Le backend met la boucle en pause quand un budget est épuisé : on affiche la
// bannière avec la raison, et l'utilisateur tranche (reprendre ou abandonner).
async function refreshEscalation() {
  const banner = $("#escalation");
  if (!banner) return;
  banner.hidden = true;
  if (!editing || !editing.id || !invoke) return;
  try {
    const st = await invoke("agent_run_state", { id: editing.id });
    if (st && st.status === "escalated") {
      $("#esc-reason").textContent = st.reason || tt("budget épuisé");
      $("#esc-task").textContent = `${tt("Tâche")} : ${st.task || ""} · ${st.iterations} ${tt("itérations")} · ${st.tokens_used} tokens`;
      banner.hidden = false;
    }
  } catch (e) { /* pas d'état d'exécution */ }
}

async function decideEscalation(approve) {
  if (!editing || !editing.id) return;
  const banner = $("#escalation");
  banner.hidden = true;
  $("#save-state").textContent = approve ? tt("Reprise de la tâche…") : tt("Abandon…");
  try {
    const out = await invoke("agent_escalation_decide", { id: editing.id, approve });
    $("#save-state").textContent = out || tt("Fait ✓");
    await reloadAll();
  } catch (e) {
    $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e);
    refreshEscalation();
  }
}

// Événements live : ne rendre que s'ils concernent l'agent affiché (la persistance
// est gérée côté backend, donc rien à stocker ici).
function addActivity(p) {
  if (!editing || p.agent_id !== editing.id) return;
  renderReport(p);
}
function addStep(p) {
  if (!editing || p.agent_id !== editing.id) return;
  if (p.kind === "thought") renderThought(p);
  else renderStep(p);
}

function renderReport(p) {
  const list = $("#activity");
  const item = document.createElement("div");
  item.className = "activity-item" + (p.success ? "" : " fail");
  const when = new Date((p.ts || 0) * 1000).toLocaleString();
  // La coche disait « fait » même sur un échec : le liseré rouge était le seul
  // indice, et il se perdait dans la liste.
  item.innerHTML =
    `<div class="at">${p.success ? "✓" : "✗"} ${when} · ${escapeHtml(tt(p.success ? "compte rendu" : "compte rendu (refusé)"))} — ${escapeHtml(p.task || "")}</div>` +
    `<div class="out">${escapeHtml(p.output || "")}</div>`;
  list.prepend(item);
}

// Affiche un appel de skill intermédiaire (skill, entrée, résultat).
function renderStep(p) {
  const list = $("#activity");
  const item = document.createElement("div");
  item.className = "activity-item step";
  const when = new Date((p.ts || 0) * 1000).toLocaleString();
  item.innerHTML =
    `<div class="at">↳ ${when} · skill <b>${escapeHtml(p.skill || "")}</b></div>` +
    `<div class="out"><span class="step-label">entrée</span> ${escapeHtml(clip(p.input))}\n<span class="step-label">résultat</span> ${escapeHtml(clip(p.result))}</div>`;
  list.prepend(item);
}
// Raisonnement du modèle entre deux outils : l'itération, ce qu'il s'apprête à
// appeler, et ce qu'il s'est dit. C'est la moitié manquante de la timeline —
// sans elle on ne voyait que les outils, jamais pourquoi.
function renderThought(p) {
  const list = $("#activity");
  const item = document.createElement("div");
  item.className = "activity-item thought";
  const when = new Date((p.ts || 0) * 1000).toLocaleString();
  const planned = String(p.input || "").trim();
  const head = p.kind === "thought" && planned
    ? `${tt("prépare")} <b>${escapeHtml(planned)}</b>`
    : tt("réflexion");
  item.innerHTML =
    `<div class="at">◇ ${when} · ${escapeHtml(String(p.skill || ""))} · ${head}</div>` +
    (String(p.result || "").trim()
      ? `<div class="out">${escapeHtml(clip(p.result, 1200))}</div>`
      : `<div class="out muted">${escapeHtml(tt("Pas de raisonnement explicite pour cette itération."))}</div>`);
  list.prepend(item);
}

function clip(s, n = 600) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; }

// ===== Vue calendrier des tâches =====
function openCalendar() {
  if (!editing) return;
  calCursor = new Date();
  $("#calendar-modal").hidden = false;
  renderCalendar();
}

function renderCalendar() {
  const grid = $("#cal-grid");
  const wd = $("#cal-weekdays");
  if (!grid) return;
  const tasks = (editing && editing.tasks) || [];

  // Regroupe les tâches datées par jour (clé YYYY-MM-DD).
  const byDay = {};
  for (const t of tasks) {
    if (t.due == null) continue;
    const key = dueToDate(t.due);
    (byDay[key] ||= []).push(t);
  }

  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  $("#cal-title").textContent = calCursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  // En-têtes de jours (semaine commençant lundi).
  const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  wd.innerHTML = days.map((d) => `<div class="cal-wd">${d}</div>`).join("");

  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // lundi = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dueToDate(Math.floor(Date.now() / 1000));

  grid.innerHTML = "";
  for (let i = 0; i < offset; i++) {
    const cell = document.createElement("div");
    cell.className = "cal-cell empty";
    grid.appendChild(cell);
  }
  const p = (n) => String(n).padStart(2, "0");
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${p(month + 1)}-${p(d)}`;
    const cell = document.createElement("div");
    cell.className = "cal-cell" + (key === todayKey ? " today" : "");
    const items = byDay[key] || [];
    const dots = items.map((t) => `<span class="cal-dot${t.done ? " done" : ""}"></span>`).join("");
    cell.innerHTML = `<span class="cal-num">${d}</span><div class="cal-dots">${dots}</div>`;
    if (items.length) {
      cell.classList.add("has-tasks");
      cell.title = items.map((t) => `• ${t.text}${t.done ? " (faite)" : ""}`).join("\n");
    }
    grid.appendChild(cell);
  }
}

// ===== Modale =====
function confirmDelete(name) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    $("#modal-title").textContent = `Supprimer « ${name} » ?`;
    $("#modal-msg").textContent = "L'agent et sa configuration seront supprimés. Sa sandbox n'est pas touchée.";
    modal.hidden = false;
    const done = (v) => { cleanup(); resolve(v); };
    const onOk = () => done(true), onCancel = () => done(false);
    function cleanup() {
      modal.hidden = true;
      $("#modal-ok").removeEventListener("click", onOk);
      $("#modal-cancel").removeEventListener("click", onCancel);
    }
    $("#modal-ok").addEventListener("click", onOk);
    $("#modal-cancel").addEventListener("click", onCancel);
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ===========================================================================
// Progression — auto-amélioration mesurée (evolution.rs)
// ===========================================================================
// Trois choses à montrer, et une seule qui compte vraiment : est-ce que l'agent
// fait mieux qu'avant ? D'où l'ordre — les cas d'abord (la mesure), puis ce
// qu'on optimise, puis les taux réels par version (le verdict).

const pct = (v) => (v == null || v < 0 ? "—" : `${Math.round(v * 100)} %`);

async function loadEvolution() {
  if (!editing || !editing.id) {
    $("#evo-stats").innerHTML = `<p class="hint">${tt("Enregistre l'agent pour suivre sa progression.")}</p>`;
    $("#evo-cases").innerHTML = "";
    $("#evo-skills").innerHTML = "";
    $("#evo-instruction-versions").innerHTML = "";
    return;
  }
  let overview = null;
  try { overview = await invoke("evolution_overview", { agentId: editing.id }); }
  catch (e) { $("#evo-stats").innerHTML = `<p class="hint">${tt("Échec :")} ${e?.message || e}</p>`; return; }

  const tile = (icon, value, label, tone = "") =>
    `<div class="stat ${tone}"><span class="stat-ic" data-ic="${icon}"></span>
       <span class="stat-v">${value}</span><span class="stat-k">${tt(label)}</span></div>`;
  $("#evo-stats").innerHTML = [
    tile("tasklist", overview.corpus_agent, "cas d'évaluation"),
    tile("warn", overview.corpus_failed, "échecs à corriger", overview.corpus_failed ? "alert" : ""),
    tile("workflow", (overview.skills || []).length, "skills suivis"),
    tile("history", overview.instruction_versions, "versions d'instruction"),
  ].join("");

  renderSkillScores(overview.skills || []);
  await renderInstructionVersions();
  await renderCases();
  paintIcons();
}

function renderSkillScores(skills) {
  const host = $("#evo-skills");
  if (!skills.length) {
    host.innerHTML = `<p class="hint">${tt("Aucun skill attribué à cet agent.")}</p>`;
    return;
  }
  host.innerHTML = "";
  for (const s of skills) {
    const card = document.createElement("div");
    card.className = "skill-score";
    const versions = (s.versions || []).slice(-6);
    const bars = versions.map((v) => {
      const rate = v.rate;
      const height = rate < 0 ? 6 : Math.max(6, Math.round(rate * 46));
      const cls = rate < 0 ? "unknown" : rate >= 0.8 ? "good" : rate >= 0.5 ? "mid" : "bad";
      const title = `v${v.version} — ${v.runs} ${tt("exécution(s)")}, ${pct(rate)} ${tt("de succès")}` +
        (v.judge_score != null ? ` · ${tt("juge")} ${pct(v.judge_score)}` : "") +
        (v.origin ? ` · ${v.origin}` : "");
      return `<span class="vbar ${cls}${v.version === s.current ? " current" : ""}" style="height:${height}px" title="${escapeAttr(title)}"><i>v${v.version}</i></span>`;
    }).join("");
    const active = versions.find((v) => v.version === s.current);
    card.innerHTML = `
      <div class="ss-head">
        <b>${escapeHtml(s.name)}</b>
        <span class="ss-v">v${s.current}</span>
        <span class="ss-rate">${active ? `${pct(active.rate)} · ${active.runs} ${tt("exéc.")}` : tt("jamais exécuté")}</span>
        <button class="btn-soft" data-opt="${escapeAttr(s.name)}" title="${tt("Générer des variantes, les noter, promouvoir la meilleure")}"><span data-ic="sparkles"></span> ${tt("Optimiser")}</button>
      </div>
      <div class="ss-bars">${bars || `<span class="hint">${tt("aucune version mesurée")}</span>`}</div>
      ${s.auto_rollback ? `<div class="ss-note">${tt("Retour arrière automatique")} v${s.auto_rollback.from} → v${s.auto_rollback.to_source} (${s.auto_rollback.reason === "taux_inferieur" ? tt("taux inférieur à la version précédente") : tt("trois échecs consécutifs")})</div>` : ""}`;
    card.querySelector("[data-opt]").addEventListener("click", () => optimizeSkill(s.name));
    host.appendChild(card);
  }
  paintIcons(host);
}

async function renderInstructionVersions() {
  const host = $("#evo-instruction-versions");
  let list = [];
  try { list = await invoke("agent_instruction_versions", { agentId: editing.id }); } catch { list = []; }
  if (!list.length) {
    host.innerHTML = `<p class="hint">${tt("Aucune version antérieure — l'instruction actuelle est la première.")}</p>`;
    return;
  }
  host.innerHTML = "";
  for (const v of list.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "version-row";
    row.innerHTML = `<span class="vr-v">v${v.version}</span>
      <span class="vr-score">${v.score >= 0 ? pct(v.score) : "—"}</span>
      <span class="vr-origin">${escapeHtml(v.origin || "")}</span>
      <span class="vr-text" title="${escapeAttr(v.instruction)}">${escapeHtml(v.instruction.slice(0, 90))}${v.instruction.length > 90 ? "…" : ""}</span>
      <button class="btn-soft">${tt("Restaurer")}</button>`;
    row.querySelector("button").addEventListener("click", async () => {
      try {
        await invoke("agent_instruction_rollback", { agentId: editing.id, version: v.version });
        editing.instruction = (await invoke("agents_list")).find((a) => a.id === editing.id)?.instruction || editing.instruction;
        $("#agent-instruction").value = editing.instruction;
        $("#save-state").textContent = tt("Instruction restaurée.");
        loadEvolution();
      } catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
    });
    host.appendChild(row);
  }
}

async function renderCases() {
  const host = $("#evo-cases");
  let list = [];
  try { list = await invoke("eval_corpus_list", { agentId: editing.id }); } catch { list = []; }
  if (!list.length) {
    host.innerHTML = `<p class="hint">${tt("Corpus vide. Lance quelques tâches, puis clique « Construire ».")}</p>`;
    return;
  }
  host.innerHTML = "";
  for (const c of list.slice(0, 40)) {
    const row = document.createElement("div");
    row.className = "case-row" + (c.success ? "" : " failed");
    row.innerHTML = `<span class="case-dot"></span>
      <span class="case-kind">${c.skill ? escapeHtml(c.skill) : tt("tâche")}</span>
      <span class="case-input" title="${escapeAttr(c.input)}">${escapeHtml(c.input.slice(0, 110))}</span>
      <span class="case-src">${c.source === "manual" ? tt("manuel") : tt("trace")}</span>
      <button class="case-del" title="${tt("Retirer ce cas")}">✕</button>`;
    row.querySelector(".case-del").addEventListener("click", async () => {
      try { await invoke("eval_case_delete", { id: c.id }); loadEvolution(); } catch { /* déjà retiré */ }
    });
    host.appendChild(row);
  }
}

async function buildCorpus() {
  if (!editing?.id) return;
  const btn = $("#btn-corpus-build");
  btn.disabled = true;
  try {
    const r = await invoke("eval_corpus_build", { agentId: editing.id });
    $("#save-state").textContent = `${r.added} ${tt("cas ajouté(s)")} — ${r.total} ${tt("au total")}`;
    await loadEvolution();
  } catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
  finally { btn.disabled = false; }
}

async function addManualCase() {
  if (!editing?.id) return;
  const input = await promptSheet({ title: tt("Énoncé du cas (la tâche telle qu'elle serait donnée) :"), multiline: true, confirm: tt("Suivant"), cancel: tt("Annuler") });
  if (!input) return;
  const expected = (await promptSheet({ title: tt("Résultat attendu (ce qui vaudrait réussite) :"), multiline: true, confirm: tt("Suivant"), cancel: tt("Annuler") })) || "";
  const skill = (await promptSheet({ title: tt("Skill concerné (laisser vide pour une tâche générale) :"), confirm: tt("Ajouter"), cancel: tt("Annuler") })) || "";
  try {
    await invoke("eval_case_add", { agentId: editing.id, skill, input, expected, criteria: [] });
    await loadEvolution();
  } catch (e) { $("#save-state").textContent = tt("Échec :") + " " + (e?.message || e); }
}

/** Affiche le rapport d'une optimisation : score de référence, variantes, verdict. */
function renderOptimizationReport(title, report) {
  const host = $("#evo-report");
  host.hidden = false;
  const variants = (report.variants || []).map((v) => {
    if (v.rejected) return `<div class="ov rejected"><b>${tt("Variante")} ${v.variant}</b> — ${escapeHtml(v.rejected)}</div>`;
    const win = report.promoted && Math.abs((report.promoted.score ?? -1) - v.score) < 1e-9;
    return `<div class="ov${win ? " winner" : ""}"><b>${tt("Variante")} ${v.variant}</b>
      <span class="ov-score">${pct(v.score)}</span>
      ${v.steps ? `<span class="ov-meta">${v.steps} ${tt("étapes")}</span>` : ""}
      ${win ? `<span class="ov-badge">${tt("promue")}</span>` : ""}</div>`;
  }).join("");
  host.innerHTML = `
    <div class="ovr-head"><b>${escapeHtml(title)}</b>
      <span class="ovr-base">${tt("Référence")} ${pct(report.baseline)} · ${report.cases} ${tt("cas")}</span></div>
    ${variants || `<p class="hint">${tt("Aucune variante exploitable.")}</p>`}
    <p class="hint">${report.promoted
      ? `${tt("Promue en")} v${report.promoted.version}. ${tt("Le taux de succès réel décidera : une version qui retombe sous la précédente est révoquée automatiquement.")}`
      : tt("Aucune variante n'a dépassé la version en place — rien n'a été changé.")}</p>`;
}

async function optimizeSkill(name) {
  const host = $("#evo-report");
  host.hidden = false;
  host.innerHTML = `<p class="hint">${tt("Génération et notation des variantes…")}</p>`;
  try {
    const report = await invoke("skill_optimize", { name, variants: 3 });
    renderOptimizationReport(`${tt("Skill")} « ${name} »`, report);
    await loadEvolution();
  } catch (e) { host.innerHTML = `<p class="hint">${tt("Échec :")} ${escapeHtml(String(e?.message || e))}</p>`; }
}

async function optimizeInstruction() {
  if (!editing?.id) return;
  const host = $("#evo-report");
  host.hidden = false;
  host.innerHTML = `<p class="hint">${tt("Génération et notation des variantes…")}</p>`;
  try {
    const report = await invoke("agent_instruction_optimize", { agentId: editing.id, variants: 3 });
    renderOptimizationReport(tt("Instruction de l'agent"), report);
    if (report.promoted) {
      editing.instruction = report.promoted.instruction;
      $("#agent-instruction").value = report.promoted.instruction;
    }
    await loadEvolution();
  } catch (e) { host.innerHTML = `<p class="hint">${tt("Échec :")} ${escapeHtml(String(e?.message || e))}</p>`; }
}

function escapeAttr(s) { return escapeHtml(String(s ?? "")).replace(/"/g, "&quot;"); }

// ===========================================================================
// Assistant de création d'agent personnel
// ===========================================================================
// Créer un agent utile demandait de remplir une instruction, de choisir des
// outils, un rythme et un niveau de permission — six décisions avant d'avoir vu
// l'agent faire quoi que ce soit. L'assistant renverse l'ordre : on décrit ce
// qu'on veut en une phrase, il propose l'ensemble, puis on relit UNE décision à
// la fois. Le bouton « + » reste : il sert quand on sait déjà ce qu'on veut.
//
// Trois règles tenues ici :
//  - une étape = une question. Le rail de gauche montre où on en est et ce qui
//    reste ; on peut revenir sur une étape déjà vue, jamais sauter en avant.
//  - la revue est obligatoire. Une IA locale de 350M se trompe de nom, de rythme
//    et d'outils ; la proposition est un brouillon, jamais un fait.
//  - le LLM n'est jamais un point de passage obligé. S'il est absent, lent ou
//    incohérent, on retombe sur une proposition déduite du texte (`draftFrom`)
//    et l'assistant marche quand même, sans IA.

// Les étapes, dans l'ordre. `think` n'y figure pas : c'est un temps d'attente,
// pas une décision — l'afficher dans le rail ferait croire à une étape de plus.
const WIZ_STEPS = [
  {
    id: "mission", label: "Mission", icon: "wand-sparkles",
    title: "Que doit faire cet agent pour vous ?",
    hint: "Décrivez-le comme à un collègue. Tout le reste en découlera.",
    next: "Proposer un agent",
  },
  {
    id: "identity", label: "Identité", icon: "user",
    title: "Comment s'appelle-t-il ?",
    hint: "Son nom et son avatar : c'est ainsi qu'il apparaîtra partout, jusque dans vos discussions.",
  },
  {
    id: "behavior", label: "Comportement", icon: "brain",
    title: "Comment doit-il travailler ?",
    hint: "Son instruction permanente, et ce qu'il a le droit de faire seul.",
  },
  {
    id: "tools", label: "Outils", icon: "pocket-knife",
    title: "De quoi a-t-il besoin ?",
    hint: "Les outils qu'il pourra appeler pendant ses tâches.",
  },
  {
    id: "plan", label: "Rythme & tâches", icon: "calendar",
    title: "Quand travaille-t-il, et sur quoi ?",
    hint: "Sa planification et sa todo de départ.",
  },
  {
    id: "review", label: "Récapitulatif", icon: "circle-check",
    title: "Tout est en ordre ?",
    hint: "Dernière lecture avant que l'agent existe.",
    next: "Créer l'agent",
  },
];

// Rythmes proposés. Volontairement peu nombreux : le vrai éditeur CRON reste
// disponible sur l'agent créé, ici on ne veut qu'un premier choix évident.
const WIZ_CRONS = [
  { cron: "", label: "À la demande", sub: "Il ne travaille que si vous le lancez", icon: "play" },
  { cron: localCronToUtc("0 8 * * *"), label: "Chaque matin", sub: "Tous les jours à 8 h", icon: "sun" },
  { cron: localCronToUtc("0 18 * * *"), label: "Chaque soir", sub: "Tous les jours à 18 h", icon: "moon" },
  { cron: localCronToUtc("0 * * * *"), label: "Toutes les heures", sub: "En continu, à chaque heure pleine", icon: "clock" },
  { cron: localCronToUtc("0 9 * * 1"), label: "Chaque lundi", sub: "En début de semaine, à 9 h", icon: "calendar" },
  { cron: localCronToUtc("0 9 1 * *"), label: "Chaque mois", sub: "Le 1er du mois, à 9 h", icon: "calendar" },
];

const WIZ_PERMISSIONS = [
  { id: "strict", label: "Strict", sub: "Jamais d'action destructive ; il demande avant d'écrire ou d'agir sur quelque chose de sensible.", icon: "lock" },
  { id: "balanced", label: "Équilibré", sub: "Les réglages par défaut de Lumen. Convient à la plupart des agents.", icon: "circle-check" },
  { id: "trusted", label: "De confiance", sub: "Il n'interrompt que pour ce qui est risqué ou destructeur.", icon: "unlock" },
];


// État de l'assistant. `wizDraft` est la proposition en cours de revue — une
// forme intermédiaire (tâches en simples chaînes), convertie en agent seulement
// au moment de créer.
let wizDraft = null;
let wizBusy = false;
let wizAt = 0;      // index dans WIZ_STEPS
let wizSeen = 0;    // étape la plus avancée atteinte (borne du retour arrière)

function wireWizard() {
  bind("#btn-wizard", "click", openWizard);
  bind("#wiz-close", "click", closeWizard);
  bind("#wiz", "click", (e) => { if (e.target.id === "wiz") closeWizard(); });
  bind("#wiz-next", "click", wizardNext);
  bind("#wiz-back", "click", wizardBack);
  bind("#wiz-brief", "keydown", (e) => {
    // ⌘/Ctrl+Entrée : le texte est multi-ligne, Entrée seule doit rester Entrée.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); wizardNext(); }
  });
  bind("#wiz-name", "input", (e) => { wizDraft.name = e.target.value; });
  bind("#wiz-desc", "input", (e) => { wizDraft.description = e.target.value; });
  bind("#wiz-instruction", "input", (e) => { wizDraft.instruction = e.target.value; });
  bind("#wiz-task-add", "click", addWizardTask);
  bind("#wiz-task-input", "keydown", (e) => {
    // Entrée ajoute la tâche : sans ça, elle déclenchait l'étape suivante et la
    // saisie en cours était perdue.
    if (e.key === "Enter") { e.preventDefault(); addWizardTask(); }
  });
  bind("#wiz", "keydown", (e) => { if (e.key === "Escape") closeWizard(); });
}

function openWizard() {
  wizDraft = null;
  wizAt = 0;
  wizSeen = 0;
  $("#wiz-brief").value = "";
  $("#wiz-error").hidden = true;
  renderWizardRail();
  renderTemplates($("#wiz-tpl-cats"), $("#wiz-templates"), startFromTemplate);
  $("#wiz").hidden = false;
  paintWizardStep();
  setTimeout(() => $("#wiz-brief").focus(), 0);
}

function closeWizard() {
  // Une génération en cours n'est pas annulable côté modèle ; on ferme quand
  // même la fenêtre, et `wizBusy` empêche la réponse tardive de la rouvrir.
  wizBusy = false;
  $("#wiz").hidden = true;
}

// ----- Navigation -----------------------------------------------------------

function wizardNext() {
  const step = WIZ_STEPS[wizAt];
  if (step.id === "mission") { runWizard(); return; }
  if (step.id === "review") { createFromWizard(); return; }
  // Avancer, c'est franchir : sans lever la borne ici, `wizardGo` refusait sa
  // propre cible et le bouton « Continuer » restait sans effet passé l'étape 2.
  wizSeen = Math.max(wizSeen, wizAt + 1);
  wizardGo(wizAt + 1);
}

function wizardBack() {
  if (wizAt > 0) wizardGo(wizAt - 1);
}

// Saut direct vers une étape DÉJÀ franchie (clic sur le rail). L'avancée, elle,
// passe par `wizardNext`, qui lève la borne : on ne saute jamais vers une étape
// que l'on n'a pas encore relue.
function wizardGo(index) {
  const target = Math.max(0, Math.min(index, WIZ_STEPS.length - 1));
  if (target > wizSeen) return;
  wizAt = target;
  paintWizardStep();
}

// Peint TOUT ce qui dépend de l'étape : panneau visible, en-tête, rail, pied.
// Une seule fonction, parce qu'éparpiller ces quatre choses est le plus sûr
// moyen de laisser un « Créer l'agent » actif pendant la génération.
function paintWizardStep(forced) {
  const id = forced || WIZ_STEPS[wizAt].id;
  const step = WIZ_STEPS.find((s) => s.id === id);
  const thinking = id === "think";

  document.querySelectorAll("#wiz .wiz-step").forEach((el) => { el.hidden = el.dataset.step !== id; });
  $("#wiz-scroll").scrollTop = 0;

  $("#wiz-step-title").textContent = thinking ? tt("Un instant…") : tt(step.title);
  $("#wiz-step-hint").textContent = thinking
    ? tt("L'assistant assemble une proposition à partir de votre description.")
    : tt(step.hint);

  $("#wiz-back").disabled = thinking || wizAt === 0;
  $("#wiz-next").disabled = thinking;
  $("#wiz-next .wiz-next-lb").textContent = thinking ? tt("…") : tt(step.next || "Continuer");
  // Le chevron dit « il y a une suite ». À la dernière étape il n'y en a pas :
  // la coche dit que ce clic conclut.
  $("#wiz-next .wiz-next-ic").innerHTML = lumenIcon(id === "review" ? "check" : "chevron-right");
  $("#wiz-count").textContent = thinking ? "" : `${wizAt + 1} / ${WIZ_STEPS.length}`;
  $("#wiz-error").hidden = true;

  renderWizardRail(thinking);
  if (id === "review") renderWizardRecap();
}

// Rail de gauche. Une étape franchie est cochée et redevient cliquable : on peut
// corriger un nom sans repartir de zéro.
function renderWizardRail(thinking = false) {
  const list = $("#wiz-steps");
  if (!list) return;
  list.innerHTML = "";
  WIZ_STEPS.forEach((step, i) => {
    const done = i < wizAt;
    const active = i === wizAt && !thinking;
    const reachable = i <= wizSeen;
    const li = document.createElement("li");
    li.className = "wiz-stepitem"
      + (done ? " done" : "") + (active ? " active" : "") + (reachable ? "" : " locked");
    li.innerHTML =
      `<span class="wiz-stepdot">${done ? lumenIcon("check") : (reachable ? lumenIcon(step.icon) : `<b>${i + 1}</b>`)}</span>`
      + `<span class="wiz-steptx"><b>${escapeHtml(tt(step.label))}</b></span>`;
    if (reachable && !thinking) {
      li.tabIndex = 0;
      li.addEventListener("click", () => wizardGo(i));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); wizardGo(i); } });
    }
    list.appendChild(li);
  });
}

// ----- Étape 1 : mission ----------------------------------------------------

// Proposition de repli, sans IA : elle ne devine rien, elle réutilise ce que
// l'utilisateur a écrit. C'est volontairement plat — mieux vaut un brouillon
// honnête qu'une invention.
function draftFrom(brief) {
  const clean = brief.trim().replace(/\s+/g, " ");
  const firstWords = clean.split(/[,.;:]/)[0].split(" ").slice(0, 4).join(" ");
  return {
    name: firstWords ? firstWords.charAt(0).toUpperCase() + firstWords.slice(1) : tt("Nouvel agent"),
    description: clean.slice(0, 120),
    instruction: `Tu es un agent personnel. Ta mission : ${clean}\n\nTravaille par petites étapes, écris tes résultats dans ta sandbox, et signale ce que tu n'as pas pu faire plutôt que de l'inventer.`,
    avatar: randomAvatar(),
    native_tools: [],
    permission_mode: "balanced",
    cron: "",
    tasks: [clean.slice(0, 160)],
  };
}

async function runWizard() {
  const brief = $("#wiz-brief").value.trim();
  if (!brief) { $("#wiz-brief").focus(); return; }
  wizBusy = true;
  paintWizardStep("think");

  let generated = null;
  let note = "";
  try {
    generated = await askModelForAgent(brief);
  } catch (e) {
    note = tt("Proposition établie sans IA (modèle indisponible) — à compléter à la main.");
    console.warn("[assistant agent] génération LLM échouée :", e);
  }
  if (!wizBusy) return; // fenêtre fermée entre-temps
  wizBusy = false;

  const fallback = draftFrom(brief);
  if (!generated) {
    if (!note) note = tt("Proposition établie sans IA — à compléter à la main.");
    wizDraft = fallback;
  } else {
    // Fusion et non remplacement : un modèle peut renvoyer un champ vide ou
    // aberrant, le repli comble alors le trou plutôt que de créer un agent muet.
    wizDraft = { ...fallback, ...generated };
    // Le modèle ne choisit que la couleur et l'humeur : le reste de l'avatar
    // (forme, mains) vient du tirage du repli.
    wizDraft.avatar = { ...fallback.avatar, ...(generated.avatar || {}) };
  }
  wizDraft.brief = brief;
  wizDraft.note = note;

  renderWizardIdentity();
  renderWizardBehavior();
  renderWizardTools();
  renderWizardPlan();
  wizSeen = 1;
  wizardGo(1);
}

// Interrogation du modèle. Sortie contrainte par un schéma JSON : les outils et
// l'icône sont des `enum` fermés sur les catalogues réels, sinon un modèle local
// invente des noms d'outils qui ne seront jamais résolus au premier tick.
async function askModelForAgent(brief) {
  if (!nativeToolCatalog) {
    try { nativeToolCatalog = await invoke("native_tool_catalog"); } catch { nativeToolCatalog = []; }
  }
  const tools = nativeToolCatalog || [];
  const toolIds = tools.map((t) => t.id);
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      instruction: { type: "string" },
      color: { type: "string", enum: AVATAR_COLORS.map((c) => c.key) },
      face: { type: "string", enum: AVATAR_FACES.map((f) => f.key) },
      native_tools: { type: "array", items: toolIds.length ? { type: "string", enum: toolIds } : { type: "string" } },
      permission_mode: { type: "string", enum: WIZ_PERMISSIONS.map((p) => p.id) },
      cron: { type: "string", enum: WIZ_CRONS.map((c) => c.cron) },
      tasks: { type: "array", items: { type: "string" } },
    },
    required: ["name", "description", "instruction", "color", "face", "native_tools", "permission_mode", "cron", "tasks"],
    additionalProperties: false,
  };
  const { messages, opts } = PROMPTS["app.agents.wizard"].build({
    brief, schema,
    tools: tools.map((t) => `- ${t.id} : ${t.description}${t.effect === "external" ? " (sort de la machine)" : ""}`).join("\n") || "(aucun)",
    rhythms: WIZ_CRONS.map((c) => `- "${c.cron}" : ${c.label} — ${c.sub}`).join("\n"),
    faces: AVATAR_FACES.map((f) => `${f.key} = ${f.label}`).join(", "),
  });
  const { content } = await llmChat(messages, { ...opts, rawSystem: true });
  const parsed = JSON.parse(content);
  return sanitizeDraft(parsed, toolIds);
}

// Le schéma est appliqué côté serveur quand le backend le supporte — pas
// partout. On revalide donc ici : tout champ hors catalogue est jeté plutôt que
// propagé jusqu'à `agent_save`.
function sanitizeDraft(raw, toolIds) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const draft = {};
  const name = str(raw.name, 60);
  if (name) draft.name = name;
  const description = str(raw.description, 200);
  if (description) draft.description = description;
  const instruction = str(raw.instruction, 4000);
  if (instruction) draft.instruction = instruction;
  const avatar = {};
  if (AVATAR_COLORS.some((c) => c.key === raw.color)) avatar.color = raw.color;
  if (AVATAR_FACES.some((f) => f.key === raw.face)) avatar.face = raw.face;
  if (Object.keys(avatar).length) draft.avatar = avatar;
  if (WIZ_PERMISSIONS.some((p) => p.id === raw.permission_mode)) draft.permission_mode = raw.permission_mode;
  if (WIZ_CRONS.some((c) => c.cron === raw.cron)) draft.cron = raw.cron;
  if (Array.isArray(raw.native_tools)) {
    draft.native_tools = raw.native_tools.filter((id) => toolIds.includes(id));
  }
  if (Array.isArray(raw.tasks)) {
    const tasks = raw.tasks.map((t) => str(t, 200)).filter(Boolean).slice(0, 6);
    if (tasks.length) draft.tasks = tasks;
  }
  return Object.keys(draft).length ? draft : null;
}

// ----- Étape 2 : identité ---------------------------------------------------

let wizStudio = null;
function renderWizardIdentity() {
  $("#wiz-name").value = wizDraft.name || "";
  $("#wiz-desc").value = wizDraft.description || "";
  if (!wizDraft.avatar) wizDraft.avatar = randomAvatar();
  const host = $("#wiz-avatar-studio");
  if (!wizStudio) wizStudio = mountAvatarStudio(host, { value: wizDraft.avatar, compact: true, onChange: (a) => { wizDraft.avatar = a; } });
  else wizStudio.set(wizDraft.avatar);
}

// ----- Étape 3 : comportement ----------------------------------------------

function renderWizardBehavior() {
  $("#wiz-instruction").value = wizDraft.instruction || "";
  renderWizardPermissions();
}

function renderWizardPermissions() {
  const wrap = $("#wiz-permission");
  wrap.innerHTML = "";
  for (const mode of WIZ_PERMISSIONS) {
    wrap.appendChild(choiceCard({
      icon: mode.icon, label: mode.label, sub: mode.sub,
      on: (wizDraft.permission_mode || "balanced") === mode.id,
      onPick: () => { wizDraft.permission_mode = mode.id; renderWizardPermissions(); },
    }));
  }
}

// Carte de choix exclusif, réutilisée par les permissions et les rythmes : même
// forme, donc même geste, et une seule règle de style à tenir.
function choiceCard({ icon, label, sub, on, onPick }) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "wiz-choice" + (on ? " on" : "");
  el.setAttribute("aria-pressed", on ? "true" : "false");
  el.innerHTML =
    `<span class="wiz-choice-ic">${lumenIcon(icon)}</span>`
    + `<span class="wiz-choice-tx"><b>${escapeHtml(tt(label))}</b><i>${escapeHtml(tt(sub))}</i></span>`
    + `<span class="wiz-choice-mark">${lumenIcon("check")}</span>`;
  el.addEventListener("click", onPick);
  return el;
}

// ----- Étape 4 : outils -----------------------------------------------------

function renderWizardTools() {
  const wrap = $("#wiz-tools");
  wrap.innerHTML = "";
  const tools = nativeToolCatalog || [];
  if (!tools.length) {
    wrap.innerHTML = `<span class="wiz-empty">${tt("Aucun outil natif disponible.")}</span>`;
    return;
  }
  if (!Array.isArray(wizDraft.native_tools)) wizDraft.native_tools = [];
  // Groupés comme dans l'éditeur : la même carte mentale d'un écran à l'autre.
  for (const group of [...new Set(tools.map((t) => t.group))]) {
    const head = document.createElement("div");
    head.className = "wiz-sub";
    head.textContent = tt(NATIVE_GROUPS[group] || group);
    wrap.appendChild(head);
    const row = document.createElement("div");
    row.className = "wiz-chips";
    for (const tool of tools.filter((t) => t.group === group)) {
      const on = wizDraft.native_tools.includes(tool.id);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "wiz-chip" + (on ? " on" : "");
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.title = tool.description;
      chip.innerHTML = `<span class="wiz-chip-box">${on ? lumenIcon("check") : ""}</span><span>${escapeHtml(tool.label)}${tool.effect === "external" ? " ↗" : ""}</span>`;
      chip.addEventListener("click", () => {
        wizDraft.native_tools = on
          ? wizDraft.native_tools.filter((id) => id !== tool.id)
          : [...wizDraft.native_tools, tool.id];
        renderWizardTools();
      });
      row.appendChild(chip);
    }
    wrap.appendChild(row);
  }
}

// ----- Étape 5 : rythme & tâches -------------------------------------------

function renderWizardPlan() {
  renderWizardCron();
  renderWizardTasks();
}

function renderWizardCron() {
  const wrap = $("#wiz-cron");
  wrap.innerHTML = "";
  // Un modèle peut apporter un rythme hors des choix proposés (« 8 h, 13 h et
  // 18 h », « les jours ouvrés ») : on le montre comme une carte à part entière
  // plutôt que de l'écraser ou de le faire passer pour « À la demande ».
  const choices = wizDraft.cron && !WIZ_CRONS.some((c) => c.cron === wizDraft.cron)
    ? [{ cron: wizDraft.cron, label: "Rythme du modèle", sub: wizDraft.cron, icon: "sparkles" }, ...WIZ_CRONS]
    : WIZ_CRONS;
  for (const choice of choices) {
    wrap.appendChild(choiceCard({
      icon: choice.icon, label: choice.label, sub: choice.sub,
      on: (wizDraft.cron || "") === choice.cron,
      onPick: () => { wizDraft.cron = choice.cron; renderWizardCron(); },
    }));
  }
}

function renderWizardTasks() {
  const wrap = $("#wiz-tasks");
  wrap.innerHTML = "";
  if (!Array.isArray(wizDraft.tasks)) wizDraft.tasks = [];
  if (!wizDraft.tasks.length) {
    wrap.innerHTML = `<span class="wiz-empty">${tt("Aucune tâche — l'agent démarrera à vide.")}</span>`;
    return;
  }
  wizDraft.tasks.forEach((text, i) => {
    const row = document.createElement("div");
    row.className = "wiz-task";
    row.innerHTML =
      `<span class="wiz-task-n">${i + 1}</span>`
      + `<span class="wiz-task-tx">${escapeHtml(text)}</span>`
      + `<button type="button" class="wiz-task-rm" aria-label="Retirer">${lumenIcon("x")}</button>`;
    row.querySelector(".wiz-task-rm").addEventListener("click", () => { wizDraft.tasks.splice(i, 1); renderWizardTasks(); });
    wrap.appendChild(row);
  });
}

function addWizardTask() {
  const input = $("#wiz-task-input");
  const text = input.value.trim();
  if (!text) return;
  wizDraft.tasks.push(text);
  input.value = "";
  renderWizardTasks();
  input.focus();
}

// ----- Étape 6 : récapitulatif ---------------------------------------------

// En lecture seule, et volontairement : c'est le moment de VÉRIFIER, pas de
// modifier. Chaque ligne renvoie à l'étape qui la produit.
function renderWizardRecap() {
  const wrap = $("#wiz-recap");
  const tools = nativeToolCatalog || [];
  const toolLabels = (wizDraft.native_tools || [])
    .map((id) => tools.find((t) => t.id === id)?.label || id);
  const cron = WIZ_CRONS.find((c) => c.cron === (wizDraft.cron || ""));
  const perm = WIZ_PERMISSIONS.find((p) => p.id === (wizDraft.permission_mode || "balanced"));

  wrap.innerHTML = "";
  if (wizDraft.note) {
    const note = document.createElement("p");
    note.className = "wiz-banner";
    note.innerHTML = `<span data-ic="triangle-alert"></span><span>${escapeHtml(wizDraft.note)}</span>`;
    wrap.appendChild(note);
  }

  const head = document.createElement("div");
  head.className = "wiz-recap-head";
  head.innerHTML =
    `<span class="wiz-recap-av">${av(wizDraft.avatar, 64, { state: "done" })}</span>`
    + `<span class="wiz-recap-id"><b>${escapeHtml(wizDraft.name || tt("Sans nom"))}</b>`
    + `<i>${escapeHtml(wizDraft.description || tt("Sans description"))}</i></span>`;
  wrap.appendChild(head);

  const rows = [
    { step: "behavior", icon: "brain", label: "Instruction", value: clipText(wizDraft.instruction, 220) || tt("Aucune") },
    { step: "behavior", icon: perm?.icon || "circle-check", label: "Permissions", value: tt(perm?.label || "Équilibré") },
    { step: "tools", icon: "pocket-knife", label: "Outils", value: toolLabels.length ? toolLabels.join(", ") : tt("Aucun") },
    { step: "plan", icon: "calendar", label: "Rythme", value: cron ? tt(cron.label) : (wizDraft.cron ? `${tt("Rythme du modèle")} (${wizDraft.cron})` : tt("À la demande")) },
    { step: "plan", icon: "list-checks", label: "Tâches", value: (wizDraft.tasks || []).length ? `${wizDraft.tasks.length}` : tt("Aucune") },
  ];
  for (const row of rows) {
    const index = WIZ_STEPS.findIndex((s) => s.id === row.step);
    const el = document.createElement("button");
    el.type = "button";
    el.className = "wiz-recap-row";
    el.title = tt("Revenir à cette étape");
    el.innerHTML =
      `<span class="wiz-recap-ic">${lumenIcon(row.icon)}</span>`
      + `<span class="wiz-recap-lb">${escapeHtml(tt(row.label))}</span>`
      + `<span class="wiz-recap-va">${escapeHtml(row.value)}</span>`
      + `<span class="wiz-recap-go">${lumenIcon("pencil")}</span>`;
    el.addEventListener("click", () => wizardGo(index));
    wrap.appendChild(el);
  }

  if (wizDraft.cron) {
    const on = document.createElement("p");
    on.className = "wiz-hint-row";
    on.innerHTML = `<span data-ic="info"></span><span>${tt("La planification sera activée : l'agent démarrera au prochain créneau.")}</span>`;
    wrap.appendChild(on);
  }
  paintIcons(wrap);
}

function clipText(s, max) {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// Création réelle. On passe par le même chemin que l'éditeur (`agent_save`), on
// charge l'agent créé dans l'éditeur et on ferme : l'utilisateur atterrit sur sa
// fiche, pas sur une liste où il devrait le retrouver.
async function createFromWizard() {
  const err = $("#wiz-error");
  const name = (wizDraft.name || "").trim();
  if (!name) {
    err.hidden = false;
    err.textContent = tt("Un nom est requis — revenez à l'étape Identité.");
    return;
  }
  err.hidden = true;

  const btn = $("#wiz-next");
  btn.disabled = true;
  const nowSec = Math.floor(Date.now() / 1000);
  editing = blankAgent();
  editing.name = name;
  editing.description = wizDraft.description || "";
  editing.instruction = wizDraft.instruction || "";
  editing.avatar = { ...(wizDraft.avatar || randomAvatar()) };
  editing.native_tools = [...(wizDraft.native_tools || [])];
  editing.cron = wizDraft.cron || "";
  // Un agent programmé qui n'est pas actif ne fera rien et ressemblera à un bug.
  // Le rythme choisi vaut donc activation ; sans rythme, on reste au manuel.
  editing.enabled = !!editing.cron;
  editing.tasks = (wizDraft.tasks || []).map((text, i) => ({
    id: `t-${nowSec}-${i}`, text, done: false, due: null, acceptance_criteria: [], priority: 0,
  }));
  applyPermissionMode(wizDraft.permission_mode || "balanced");

  try {
    const saved = await invoke("agent_save", { agent: editing });
    editing = structuredClone(saved);
    await reloadAll();
    renderEditor();
    closeWizard();
    $("#save-state").textContent = tt("Agent créé ✓");
  } catch (e) {
    err.hidden = false;
    err.textContent = tt("Échec :") + " " + (e?.message || e);
  } finally {
    btn.disabled = false;
  }
}
