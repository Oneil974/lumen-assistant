// Fluxo — designer d'automatisations. Le frontend édite un workflow (liste plate
// de pas, avec blocs de contrôle Si/Répéter) et délègue l'exécution au moteur
// Rust via les commandes Tauri.

import { icon } from "./icons.js";
import { t, applyI18n, catLabel, trBlock } from "./i18n.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { ollamaGetJson, ollamaPostJson } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { receive, takeHandoff, toText } from "../lib/interop.js";

// Fallback sur la fenêtre parente (intégration en iframe dans le bureau).
const { invoke } = (window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {}).core || {};

// ----- Blocs de contrôle (insérés en groupe, comme Apple Shortcuts) -----
const BLOCK_TEMPLATES = {
  if: ["if", "else", "endif"],
  repeat: ["repeat", "endrepeat"],
  repeat_each: ["repeat_each", "endrepeat_each"],
};
const OPENERS = new Set(["if", "repeat", "repeat_each"]);
const CLOSERS = new Set(["endif", "endrepeat", "endrepeat_each"]);
const MARKERS = new Set(["else", "endif", "endrepeat", "endrepeat_each"]);
const MARKER_LABEL_KEY = {
  else: "m_else",
  endif: "m_endif",
  endrepeat: "m_endrepeat",
  endrepeat_each: "m_endrepeat",
};
function markerLabel(action) {
  return MARKER_LABEL_KEY[action] ? t(MARKER_LABEL_KEY[action]) : action;
}
const MARKER_ICON = {
  else: "corner-down-right",
  endif: "git-branch",
  endrepeat: "repeat",
  endrepeat_each: "layers",
};

// ----- Routeur par défaut (équivalent du Action Router d'Apple) -----
// Déverrouillé (éditable), mais réinitialisable via le bouton « Réinitialiser ».
// Ce gabarit doit rester aligné avec le seeding de Lumen (FLUXO_ROUTER_JSON).
const DEFAULT_ROUTER_NAME = "default router";
function defaultRouterTemplate() {
  return {
    name: DEFAULT_ROUTER_NAME,
    trigger: { type: "manual" },
    steps: [
      { id: "p1", action: "lumen_progress", params: {
        message: { type: "text", value: "Routage de la demande via {{model}}…" },
        kind: { type: "text", value: "step" },
      }, name: null },
      { id: "gen", action: "ollama_generate", params: {
        prompt: { type: "text", value: "{{input}}" },
        system: { type: "text", value: "Tu es le routeur d'actions de Lumen, un agent local et privé. Analyse la demande et réponds de façon concise, claire et actionnable, dans la langue de la demande." },
        model: { type: "text", value: "{{model}}" },
        url: { type: "text", value: "{{ollama_url}}" },
      }, name: null },
    ],
  };
}

// ----- Thème clair / sombre -----
// Fluxo suit désormais le thème du bureau (Lumen Desktop). `dtTheme` (partagé via
// localStorage) prime ; sinon on retombe sur la préférence système. Plus de
// bascule intégrée : c'est le toggle de Lumen Desktop qui pilote.
function initTheme() {
  applyDtTheme();
  window.addEventListener("storage", (e) => { if (!e || e.key === "dtTheme") applyDtTheme(); });
}
function applyDtTheme() {
  const dt = localStorage.getItem("dtTheme");
  const light = dt === "light"
    || (dt !== "dark" && !!window.matchMedia?.("(prefers-color-scheme: light)").matches);
  document.body.classList.toggle("theme-light", light);
}

// ----- État -----
let SPECS = [];
let specById = {};
// Modèles réellement installés, proposés dans le bloc « Inférence LLM » :
// GGUF de llama.cpp d'un côté, modèles Ollama de l'autre. La saisie reste libre
// (variables `{{model}}`, modèle d'un serveur distant…) — ce n'est qu'une aide.
let llamaModels = [];
let ollamaModels = [];
let systemVoices = [];
let ttsVoices = [];
let workflow = { name: "", steps: [] };
// Blocs repliés (UI seulement, jamais envoyé au moteur) : ids de pas, persistés
// par workflow dans localStorage pour retrouver sa mise en page.
let collapsedIds = new Set();
let dragIndex = null;
let pendingDropIndex = null;
let lastFocusedField = null;

// ----- Éléments -----
let elWfList, elWfName, elCanvas, elLibList, elLibSearch, elRunLog, elRunLogBody;
let elTriggerType, elTriggerParam, elTriggerIc;

// Placeholders selon le type de déclencheur (traduits à la volée).
const TRIGGER_HINT_KEY = {
  cron: "hint_cron",
  interval: "hint_interval",
  file_change: "hint_file",
  webhook: "hint_webhook",
  rfid: "hint_rfid",
};
function triggerHint(type) {
  return TRIGGER_HINT_KEY[type] ? t(TRIGGER_HINT_KEY[type]) : "";
}

window.addEventListener("DOMContentLoaded", async () => {
  elWfList = document.querySelector("#wf-list");
  elWfName = document.querySelector("#wf-name");
  elCanvas = document.querySelector("#canvas");
  elLibList = document.querySelector("#lib-list");
  elLibSearch = document.querySelector("#lib-search");
  elRunLog = document.querySelector("#run-log");
  elRunLogBody = document.querySelector("#run-log-body");
  elTriggerType = document.querySelector("#trigger-type");
  elTriggerParam = document.querySelector("#trigger-param");
  elTriggerIc = document.querySelector("#trigger-ic");
  elTriggerIc.innerHTML = icon("clock", 15);
  elTriggerType.addEventListener("change", onTriggerChange);
  elTriggerParam.addEventListener("input", onTriggerChange);

  // Traductions statiques (data-i18n*) puis libellés dynamiques des boutons.
  applyI18n();
  document.querySelector("#btn-new").innerHTML = icon("plus", 15) + " " + t("new").replace(/^\+\s*/, "");
  document.querySelector("#btn-save").innerHTML = icon("save", 15) + " " + t("save");
  document.querySelector("#btn-run").innerHTML = icon("play", 15) + " " + t("run");
  document.querySelector("#btn-ai-compose").innerHTML = icon("sparkles", 15) + " " + t("ai_compose");

  document.querySelector("#btn-new").addEventListener("click", newWorkflow);
  document.querySelector("#btn-save").addEventListener("click", saveWorkflow);
  document.querySelector("#btn-run").addEventListener("click", runWorkflow);
  document.querySelector("#btn-close-log").addEventListener("click", () => { elRunLog.hidden = true; });
  document.querySelector("#btn-reset-router").addEventListener("click", resetDefaultRouter);
  document.querySelector("#btn-tool-toggle").addEventListener("click", toggleToolAvailability);
  initTestInputModal();
  initAiComposeModal();
  // « Créer une automatisation » depuis un texte sélectionné n'importe où
  // (outils d'écriture) : le texte arrive par le bus d'interop et pré-remplit
  // la composition IA — il ne reste qu'à valider.
  const composeFrom = (obj) => {
    const text = toText(obj).trim();
    if (!text || workflow.locked) return;
    const modal = document.querySelector("#ai-compose-modal");
    const prompt = document.querySelector("#ai-compose-prompt");
    prompt.value = text;
    modal.hidden = false;
    prompt.focus();
  };
  const queued = takeHandoff("fluxo");
  if (queued.length) composeFrom(queued[queued.length - 1]);
  receive("fluxo", composeFrom);
  initTheme();
  elWfName.addEventListener("input", () => { workflow.name = elWfName.value; });
  elLibSearch.addEventListener("input", () => renderLibrary(elLibSearch.value));

  // Notification quand un déclencheur lance un workflow.
  const evt = (window.__TAURI__ || window.parent?.__TAURI__)?.event;
  if (evt?.listen) evt.listen("workflow-triggered", (e) => showToast(e.payload));

  SPECS = await invoke("list_actions");
  specById = Object.fromEntries(SPECS.map(s => [s.id, s]));
  try { systemVoices = await invoke("system_voice_list"); if (!Array.isArray(systemVoices)) systemVoices = []; } catch { systemVoices = []; }
  try { const catalog = await invoke("tts_catalog"); ttsVoices = Array.isArray(catalog) ? catalog.filter(v => v.installed).map(v => ({ id: v.id, label: `${v.label || v.id} · ${v.engine}` })) : []; } catch { ttsVoices = []; }
  await refreshModelLists();
  renderLibrary("");
  await refreshWorkflowList();
  renderCanvas();
});

// Couleur d'icône par catégorie (teintes ancrées sur le bleu Lumen).
const CATEGORY_COLORS = {
  "Contrôle": "#6c8cff",
  "Web": "#0ea5e9",
  "Système": "#a86bff",
  "Texte": "#22c55e",
  "Nombres": "#f59e0b",
  "Listes": "#ec4899",
  "Fichiers": "#14b8a6",
  "Variables": "#a855f7",
  "Scripts": "#94a3b8",
  "IA": "#6c8cff",
  "Lumen": "#a86bff",
  "Données": "#0a84ff",
  "MCP": "#22c55e",
  "Raspberry Pi": "#c51a4a",
  "Domotique": "#2aa98f",
  "Apps": "#ff7a45",
};
function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || "var(--accent)";
}

// ===== Bibliothèque d'actions =====
// Recherche insensible aux ACCENTS : « Generer » doit trouver « Générer ». On
// décompose en NFD puis on retire les diacritiques des deux côtés (requête et
// texte du bloc), sinon taper « e » au lieu de « é » ne renvoyait rien.
function foldAccents(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function renderLibrary(filter) {
  const q = foldAccents(filter).trim();
  const matches = SPECS.filter(s =>
    !q || foldAccents(s.name).includes(q) || foldAccents(s.description).includes(q) || foldAccents(s.category).includes(q)
      || foldAccents(trBlock(s.name)).includes(q) || foldAccents(trBlock(s.description)).includes(q) || foldAccents(catLabel(s.category)).includes(q)
  );
  const byCat = {};
  for (const s of matches) (byCat[s.category] ||= []).push(s);
  // Catégorie « Contrôle » en tête.
  const cats = Object.keys(byCat).sort((a, b) => (a === "Contrôle" ? -1 : b === "Contrôle" ? 1 : a.localeCompare(b)));

  elLibList.innerHTML = "";
  for (const cat of cats) {
    const head = document.createElement("div");
    head.className = "lib-cat";
    head.textContent = catLabel(cat);
    elLibList.appendChild(head);
    for (const s of byCat[cat]) {
      const item = document.createElement("div");
      item.className = "lib-item";
      item.innerHTML = `
        <span class="ic" style="color:${categoryColor(s.category)}">${icon(s.icon, 17)}</span>
        <span class="meta">
          <span class="name">${escapeHtml(trBlock(s.name))}</span>
          <span class="desc">${escapeHtml(trBlock(s.description))}</span>
        </span>`;
      item.addEventListener("click", () => addStep(s.id));
      elLibList.appendChild(item);
    }
  }
}

// ===== Édition du workflow =====
function addStep(actionId) {
  if (workflow.locked) return; // workflow système : pas d'édition
  if (BLOCK_TEMPLATES[actionId]) {
    for (const a of BLOCK_TEMPLATES[actionId]) workflow.steps.push(makeStep(a));
  } else {
    workflow.steps.push(makeStep(actionId));
  }
  renderCanvas();
}

function makeStep(actionId) {
  const spec = specById[actionId];
  const step = { id: uniqueStepId(actionId), action: actionId, params: {} };
  if (spec) for (const p of spec.params) step.params[p.key] = defaultValue(p);
  return step;
}

function uniqueStepId(actionId) {
  const used = new Set(workflow.steps.map(s => s.id));
  let n = 1, id = `${actionId}${n}`;
  while (used.has(id)) { n++; id = `${actionId}${n}`; }
  return id;
}

function defaultValue(param) {
  if (param.default) return param.default;
  switch (param.kind) {
    case "number": return { type: "number", value: 0 };
    case "bool": return { type: "bool", value: false };
    case "matrix8": return { type: "text", value: JSON.stringify(Array(64).fill(null)) };
    case "select": return { type: "text", value: (param.options && param.options[0]) || "" };
    default: return { type: "text", value: "" };
  }
}

// ===== Composition IA de workflows =====
function initAiComposeModal() {
  const modal = document.querySelector("#ai-compose-modal");
  const prompt = document.querySelector("#ai-compose-prompt");
  const status = document.querySelector("#ai-compose-status");
  const close = () => { modal.hidden = true; status.textContent = ""; };
  document.querySelector("#btn-ai-compose").addEventListener("click", () => {
    if (workflow.locked) return;
    modal.hidden = false;
    prompt.focus();
  });
  document.querySelector("#btn-close-ai-compose").addEventListener("click", close);
  document.querySelector("#btn-cancel-ai-compose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.querySelector("#btn-generate-ai-compose").addEventListener("click", async () => {
    const ask = prompt.value.trim();
    if (!ask) { prompt.focus(); return; }
    status.textContent = t("ai_compose_running");
    try {
      const draft = await requestWorkflowDraft(ask);
      workflow = buildWorkflowFromDraft(draft, ask);
      collapsedIds = new Set();
      elRunLog.hidden = true;
      renderCanvas();
      refreshWorkflowList();
      modal.hidden = true;
      status.textContent = "";
    } catch (e) {
      status.textContent = t("ai_compose_failed", { err: e?.message || e });
    }
  });
}

async function requestWorkflowDraft(userPrompt) {
  // Bascule sur l'API cloud (OpenAI-compatible) quand la source « api » est active.
  // SÉCURITÉ : la clé n'est plus côté front ; l'activation ne dépend donc que de
  // `aiSource`, et l'appel passe par le proxy backend `llm_api_request`.
  const isApi = localStorage.getItem("aiSource") === "api";
  const url = isApi
    ? (localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1").replace(/\/+$/, "")
    : (localStorage.getItem("ollamaUrl") || "http://localhost:11434");
  const model = isApi
    ? (localStorage.getItem("apiModel") || "gpt-4o-mini")
    : (localStorage.getItem("selectedModel") || "");
  const actions = SPECS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    params: (s.params || []).map((p) => ({ key: p.key, kind: p.kind, default: p.default, options: p.options || [] })),
  }));
  const { messages } = PROMPTS["app.fluxo.compose"].build({ request: userPrompt, actions });
  const body = { model, messages, stream: false };
  // Côté API, on demande une réponse JSON stricte (OpenAI). Côté Ollama on garde
  // le comportement d'origine (le prompt impose déjà le JSON).
  if (isApi) body.response_format = { type: "json_object" };
  let data;
  if (isApi) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error("Backend indisponible");
    data = await invoke("llm_api_request", { path: "chat/completions", body });
  } else {
    data = await ollamaPostJson("api/chat", body, url);
  }
  recordOllamaUsage(data, "fluxo-compose");
  const content = isApi
    ? (data?.choices?.[0]?.message?.content || "")
    : (data?.message?.content || "");
  return parseJsonObject(content);
}

function parseJsonObject(text) {
  const raw = String(text || "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error(t("ai_compose_bad_json"));
}

function buildWorkflowFromDraft(draft, userPrompt) {
  const steps = [];
  const proposed = Array.isArray(draft?.steps) ? draft.steps : [];
  for (const item of proposed) {
    const action = String(item?.action || "");
    const spec = specById[action];
    if (!spec) continue;
    const step = makeStep(action);
    const params = item.params || {};
    for (const p of spec.params || []) {
      if (Object.prototype.hasOwnProperty.call(params, p.key)) {
        step.params[p.key] = coerceParamValue(params[p.key], p);
      }
    }
    steps.push(step);
  }
  if (!steps.length) {
    const gen = specById.ollama_generate ? makeStep("ollama_generate") : null;
    if (gen) {
      if (gen.params.prompt) gen.params.prompt = { type: "text", value: "{{input}}" };
      if (gen.params.system) gen.params.system = { type: "text", value: userPrompt };
      if (gen.params.model) gen.params.model = { type: "text", value: "{{model}}" };
      if (gen.params.url) gen.params.url = { type: "text", value: "{{ollama_url}}" };
      steps.push(gen);
    }
  }
  return {
    name: String(draft?.name || userPrompt || t("untitled")).slice(0, 48),
    trigger: { type: "manual" },
    steps,
  };
}

function coerceParamValue(value, param) {
  if (value && typeof value === "object" && value.type) return value;
  if (param.kind === "number") return { type: "number", value: Number(value) || 0 };
  if (param.kind === "bool") return { type: "bool", value: value === true || value === "true" };
  if (param.kind === "matrix8") {
    const pixels = Array.isArray(value) ? value : parseMatrix8Pixels(String(value ?? ""));
    return { type: "text", value: JSON.stringify(pixels) };
  }
  return { type: "text", value: String(value ?? "") };
}

// Supprime un pas — un bloc entier si c'est un ouvreur.
function removeStep(index) {
  if (workflow.locked) return;
  const id = workflow.steps[index].action;
  if (OPENERS.has(id)) {
    const end = matchingClose(index);
    workflow.steps.splice(index, end - index + 1);
  } else {
    workflow.steps.splice(index, 1);
  }
  renderCanvas();
}

// Index du marqueur de fermeture correspondant à l'ouvreur en `open`.
function matchingClose(open) {
  let depth = 0;
  for (let i = open; i < workflow.steps.length; i++) {
    const a = workflow.steps[i].action;
    if (OPENERS.has(a)) depth++;
    else if (CLOSERS.has(a)) { depth--; if (depth === 0) return i; }
  }
  return workflow.steps.length - 1;
}

function renderCanvas() {
  elWfName.value = workflow.name;
  renderTrigger();

  // Bouton « Réinitialiser » : visible seulement pour le routeur par défaut.
  const resetBtn = document.querySelector("#btn-reset-router");
  if (resetBtn) resetBtn.hidden = workflow.name !== DEFAULT_ROUTER_NAME;

  // État verrouillé (workflow système) : lecture seule.
  const locked = !!workflow.locked;
  document.querySelector(".editor").classList.toggle("locked", locked);
  elWfName.readOnly = locked;
  document.querySelector("#btn-save").disabled = locked;
  document.querySelector("#btn-ai-compose").disabled = locked;
  const toolBtn = document.querySelector("#btn-tool-toggle");
  if (toolBtn) toolBtn.disabled = locked;
  updateToolToggleBtn();
  elTriggerType.disabled = locked;
  elTriggerParam.disabled = locked;

  elCanvas.innerHTML = "";

  if (locked) {
    const banner = document.createElement("div");
    banner.className = "locked-banner";
    banner.innerHTML = `${icon("lock", 14)} ${t("locked_banner")}`;
    elCanvas.appendChild(banner);
  }

  if (!workflow.steps.length) {
    const empty = document.createElement("div");
    empty.className = "canvas-empty";
    empty.textContent = t("canvas_empty");
    elCanvas.appendChild(empty);
    return;
  }

  let depth = 0;
  workflow.steps.forEach((step, index) => {
    const id = step.action;
    // `cardDepth` = indentation du marqueur/pas. `gapDepth` = indentation de
    // l'interstice qui le PRÉCÈDE. Pour un fermeur (endrepeat/endif) et `else`,
    // la position « avant » est À L'INTÉRIEUR du bloc : on indente donc cet
    // interstice au niveau INTERNE, distinct de l'interstice d'APRÈS la boucle
    // (qui, lui, est au niveau externe) → on peut viser « dans » vs « après ».
    let cardDepth, gapDepth;
    if (id === "else") {
      cardDepth = Math.max(0, depth - 1);
      gapDepth = depth; // fin de la branche courante : interne
    } else if (CLOSERS.has(id)) {
      gapDepth = depth; // dernière position dans le corps : interne
      depth = Math.max(0, depth - 1);
      cardDepth = depth; // le marqueur de fin s'aligne au niveau externe
    } else {
      cardDepth = depth;
      gapDepth = depth;
    }

    // Interstice de dépôt AVANT chaque pas : insère à `index` (déterministe, et
    // atteignable partout — y compris avant le tout premier pas).
    if (!locked) elCanvas.appendChild(makeGap(index, gapDepth));

    const card = MARKERS.has(id)
      ? renderMarker(step, index)
      : renderStepCard(step, index);
    card.style.marginLeft = `${cardDepth * 22}px`;
    elCanvas.appendChild(card);

    if (OPENERS.has(id)) depth++;
  });
  // Interstice final : insère après le dernier pas (fin du workflow).
  if (!locked) elCanvas.appendChild(makeGap(workflow.steps.length, 0));
}

// Réordonnancement par Pointer Events plutôt que par drag&drop HTML5 : ce dernier
// est non fiable dans WKWebView (Tauri) — `clientY` souvent nul sur l'event `drag`,
// `dragover` capricieux, interférence du handler de drop natif. Les pointer events
// fonctionnent à l'identique partout. Le drag démarre depuis la poignée (.step-drag)
// uniquement, après un petit seuil de déplacement, pour ne pas gêner les clics.
const DRAG_THRESHOLD = 4; // px avant d'activer le glissement
let pointerDrag = null;

function startPointerDrag(e, index, card, handle) {
  if (workflow.locked || e.button !== 0) return;
  e.preventDefault();
  pointerDrag = {
    index,
    card,
    handle,
    pointerId: e.pointerId,
    startY: e.clientY,
    active: false,
    onMove: (ev) => onPointerDragMove(ev),
    onUp: (ev) => endPointerDrag(ev),
  };
  // Capture sur la poignée : on reçoit move/up même hors de l'élément.
  try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  handle.addEventListener("pointermove", pointerDrag.onMove);
  handle.addEventListener("pointerup", pointerDrag.onUp);
  handle.addEventListener("pointercancel", pointerDrag.onUp);
}

function onPointerDragMove(e) {
  if (!pointerDrag) return;
  if (!pointerDrag.active) {
    if (Math.abs(e.clientY - pointerDrag.startY) < DRAG_THRESHOLD) return;
    // Seuil franchi : on entre réellement en mode glissement.
    pointerDrag.active = true;
    dragIndex = pointerDrag.index;
    pendingDropIndex = null;
    elCanvas.classList.add("drag-active");
    pointerDrag.card.classList.add("dragging");
    document.body.style.cursor = "grabbing";
  }
  autoScrollCanvas(e.clientY);
  updatePendingDropFromPoint(e.clientY);
}

function endPointerDrag(e) {
  if (!pointerDrag) return;
  const { handle, pointerId, card } = pointerDrag;
  handle.removeEventListener("pointermove", pointerDrag.onMove);
  handle.removeEventListener("pointerup", pointerDrag.onUp);
  handle.removeEventListener("pointercancel", pointerDrag.onUp);
  try { handle.releasePointerCapture(pointerId); } catch (_) {}
  const wasActive = pointerDrag.active;
  const insertAt = pendingDropIndex;
  pointerDrag = null;

  card.classList.remove("dragging");
  elCanvas.classList.remove("drag-active");
  document.body.style.cursor = "";
  clearDropTargets();
  pendingDropIndex = null;

  // Pas de glissement réel (simple clic sur la poignée) → on ne touche à rien.
  if (wasActive && e.type !== "pointercancel" && insertAt !== null) {
    moveStep(dragIndex, insertAt);
  }
  dragIndex = null;
}

// Fait défiler le canvas quand le pointeur approche d'un bord pendant un glissement,
// pour pouvoir déposer hors de la zone visible.
function autoScrollCanvas(clientY) {
  const rect = elCanvas.getBoundingClientRect();
  const margin = 40;
  if (clientY < rect.top + margin) {
    elCanvas.scrollTop -= Math.ceil((rect.top + margin - clientY) / 4);
  } else if (clientY > rect.bottom - margin) {
    elCanvas.scrollTop += Math.ceil((clientY - (rect.bottom - margin)) / 4);
  }
}

function updatePendingDropFromPoint(clientY) {
  if (dragIndex === null) return;
  const gaps = [...elCanvas.querySelectorAll(".drop-gap")];
  if (!gaps.length) return;

  let bestGap = gaps[0];
  let bestDistance = Infinity;
  for (const gap of gaps) {
    const rect = gap.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const distance = Math.abs(clientY - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestGap = gap;
    }
  }

  pendingDropIndex = Number(bestGap.dataset.insertIndex);
  clearDropTargets(bestGap);
  bestGap.classList.add("over");
}

// Crée un interstice de dépôt qui insère le pas glissé AVANT la position
// `insertIndex` (dans le tableau courant). Fin et visible uniquement au survol
// d'un drag — il sépare deux pas et permet de viser n'importe quelle position,
// bords du bloc inclus.
function makeGap(insertIndex, depth) {
  const gap = document.createElement("div");
  gap.className = "drop-gap";
  gap.dataset.insertIndex = String(insertIndex);
  gap.style.marginLeft = `${depth * 22}px`;
  return gap;
}

// ----- Repli des blocs (petite flèche : seul l'intitulé + badges restent) -----
function collapseKey() { return `fluxoCollapsed:${workflow.name || "(nouveau)"}`; }
function loadCollapsed() {
  try { collapsedIds = new Set(JSON.parse(localStorage.getItem(collapseKey()) || "[]")); }
  catch { collapsedIds = new Set(); }
}
function saveCollapsed() {
  try { localStorage.setItem(collapseKey(), JSON.stringify([...collapsedIds])); } catch {}
}
function toggleCollapsed(step, all = false) {
  const on = !collapsedIds.has(step.id);
  if (all) {
    // Alt-clic : replie/déplie tous les pas d'un coup.
    collapsedIds = on
      ? new Set(workflow.steps.filter((s) => !MARKERS.has(s.action)).map((s) => s.id))
      : new Set();
  } else {
    collapsedIds[on ? "add" : "delete"](step.id);
  }
  saveCollapsed();
  renderCanvas();
}

// Résumé d'un paramètre pour l'affichage replié (mini badge).
function paramBadge(step, p) {
  const v = step.params[p.key];
  if (v == null) return null;
  let text;
  if (p.kind === "bool") text = v.value ? t("yes") : t("no");
  else if (p.kind === "matrix8") text = t("badge_drawing");
  else {
    text = String(v.value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (text.length > 26) text = text.slice(0, 25) + "…";
  }
  return `<span class="p-badge" title="${escapeHtml(trBlock(p.label) + " : " + String(v.value ?? ""))}"><b>${escapeHtml(trBlock(p.label))}</b>${escapeHtml(text)}</span>`;
}

function renderMarker(step, index) {
  const card = document.createElement("div");
  card.className = "marker-card";
  card.innerHTML = `<span class="marker-ic">${icon(MARKER_ICON[step.action] || "corner-down-right", 14)}</span><span>${markerLabel(step.action)}</span>`;
  return card;
}

function renderStepCard(step, index) {
  const spec = specById[step.action];
  const isControl = OPENERS.has(step.action);
  const hasParams = !!(spec && spec.params.length);
  const isCollapsed = hasParams && collapsedIds.has(step.id);
  const card = document.createElement("div");
  card.className = "step-card" + (isControl ? " control" : "") + (isCollapsed ? " collapsed" : "");
  card.dataset.index = index;

  // Les blocs de contrôle sont traduits localement ; les actions ordinaires
  // gardent le nom fourni par le moteur.
  const title = step.name || (isControl ? labelForControl(step.action) : (spec ? trBlock(spec.name) : step.action));
  const produces = spec && spec.produces_output;

  const head = document.createElement("div");
  head.className = "step-head";
  head.innerHTML = `
    ${isControl ? "" : `<span class="step-drag" title="${escapeHtml(t("drag_handle"))}">${icon("grip", 16)}</span>`}
    ${hasParams ? `<button type="button" class="step-fold" title="${escapeHtml(t(isCollapsed ? "unfold_title" : "fold_title"))}">${icon("chevron-down", 14)}</button>` : ""}
    <span class="step-ic" style="color:${spec ? categoryColor(spec.category) : "var(--accent)"}">${icon(spec ? spec.icon : "disc", 16)}</span>
    <span class="step-title">${escapeHtml(title)}</span>
    ${index > 0 ? `<span class="step-var step-var-last" title="${escapeHtml(t("insert_last"))}">{{last}}</span>` : ""}
    ${produces ? `<span class="step-var" title="${escapeHtml(t("insert_var"))}">{{${step.id}}}</span>` : ""}
    <span class="step-del" title="${escapeHtml(t("delete"))}">${icon("x", 15)}</span>`;
  card.appendChild(head);

  head.querySelector(".step-del").addEventListener("click", () => removeStep(index));
  const foldBtn = head.querySelector(".step-fold");
  if (foldBtn) foldBtn.addEventListener("click", (e) => toggleCollapsed(step, e.altKey));
  // Double-clic sur l'en-tête = même bascule (hors éléments interactifs).
  head.addEventListener("dblclick", (e) => {
    if (!hasParams || e.target.closest(".step-var, .step-del, .step-drag, .step-fold")) return;
    toggleCollapsed(step, e.altKey);
  });
  const lastChip = head.querySelector(".step-var-last");
  if (lastChip) lastChip.addEventListener("click", () => insertVariable("{{last}}"));
  const varChip = head.querySelector(".step-var:not(.step-var-last)");
  if (varChip) varChip.addEventListener("click", () => insertVariable(`{{${step.id}}}`));

  if (hasParams && isCollapsed) {
    // Replié : les paramètres sont résumés en mini badges (lecture seule).
    const badges = spec.params.map((p) => paramBadge(step, p)).filter(Boolean);
    if (badges.length) {
      const row = document.createElement("div");
      row.className = "step-badges";
      row.innerHTML = badges.join("");
      card.appendChild(row);
    }
  } else if (hasParams) {
    const params = document.createElement("div");
    params.className = "step-params";
    for (const p of spec.params) params.appendChild(renderParam(step, p));
    card.appendChild(params);
  }

  if (!isControl) {
    const handle = head.querySelector(".step-drag");
    if (handle) handle.addEventListener("pointerdown", (e) => startPointerDrag(e, index, card, handle));
  }
  return card;
}

/// Recharge la liste des modèles installés (llama.cpp + Ollama). Les deux
/// sources sont indépendantes : l'absence de l'une ne doit pas priver l'autre de
/// suggestions.
async function refreshModelLists() {
  try {
    const list = await invoke("llama_list_models");
    llamaModels = (Array.isArray(list) ? list : []).map((m) => m.filename).filter(Boolean);
  } catch { llamaModels = []; }
  try {
    const data = await ollamaGetJson("api/tags");
    // En source llama.cpp, `api/tags` renvoie déjà les GGUF : sans ce filtre,
    // chaque modèle apparaîtrait deux fois dans la liste.
    ollamaModels = (data?.models || []).map((m) => m.name)
      .filter((name) => name && !llamaModels.includes(name));
  } catch { ollamaModels = []; }
}

/// Champ « Modèle » du bloc d'inférence : saisie libre + liste des modèles
/// installés (`<datalist>`). Un `<select>` fermé ne conviendrait pas — le champ
/// accepte aussi les variables du workflow (`{{model}}`).
function modelDatalistField(step, p, current) {
  const field = document.createElement("input");
  field.className = "param-input";
  field.type = "text";
  field.setAttribute("list", "llm-model-suggestions");
  field.value = current.value ?? "";
  field.placeholder = p.placeholder || "";
  bindText(field, step, p);
  ensureModelDatalist();
  return field;
}

/// Datalist partagée des modèles installés. Reconstruite à chaque rendu : un
/// modèle téléchargé pendant que le designer est ouvert doit apparaître.
function ensureModelDatalist() {
  let dl = document.getElementById("llm-model-suggestions");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "llm-model-suggestions";
    document.body.appendChild(dl);
  }
  const options = [
    ...llamaModels.map((m) => [m, "llama.cpp"]),
    ...ollamaModels.map((m) => [m, "Ollama"]),
  ];
  dl.innerHTML = options
    .map(([value, source]) => `<option value="${escapeAttr(value)}">${escapeAttr(source)}</option>`)
    .join("");
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderParam(step, p) {
  const row = document.createElement("div");
  row.className = "param-row";
  const current = step.params[p.key] || defaultValue(p);

  if (p.kind === "bool") {
    const wrap = document.createElement("label");
    wrap.className = "param-bool";
    const field = document.createElement("input");
    field.type = "checkbox";
    field.checked = !!current.value;
    field.addEventListener("change", () => { step.params[p.key] = { type: "bool", value: field.checked }; });
    wrap.appendChild(field);
    const span = document.createElement("span");
    span.className = "param-label";
    span.textContent = trBlock(p.label) + (p.required ? " *" : "");
    wrap.appendChild(span);
    row.appendChild(wrap);
    return row;
  }

  const label = document.createElement("label");
  label.className = "param-label";
  label.textContent = trBlock(p.label) + (p.required ? " *" : "");
  row.appendChild(label);

  let field;
  if (step.action === "speak" && p.key === "voice" && (systemVoices.length || ttsVoices.length)) {
    field = document.createElement("select");
    field.className = "param-select";
    const empty = document.createElement("option"); empty.value = ""; empty.textContent = "Voix par défaut du système"; field.appendChild(empty);
    for (const voice of [...systemVoices.map(id => ({ id, label: `${id} · système` })), ...ttsVoices]) { const o = document.createElement("option"); o.value = voice.id; o.textContent = voice.label; o.selected = voice.id === current.value; field.appendChild(o); }
    field.addEventListener("change", () => { step.params[p.key] = { type: "text", value: field.value }; });
  } else if (p.key === "model" && (step.action === "llm_infer" || step.action === "ollama_generate" || step.action === "ollama_chat")) {
    field = modelDatalistField(step, p, current);
  } else if (p.kind === "multiline") {
    field = document.createElement("textarea");
    field.className = "param-textarea";
    field.value = current.value ?? "";
    field.placeholder = p.placeholder || "";
    bindText(field, step, p);
  } else if (p.kind === "number") {
    field = document.createElement("input");
    field.className = "param-input";
    field.type = "number";
    field.value = current.value ?? 0;
    field.addEventListener("input", () => { step.params[p.key] = { type: "number", value: parseFloat(field.value) || 0 }; });
  } else if (p.kind === "select") {
    field = document.createElement("select");
    field.className = "param-select";
    for (const opt of (p.options || [])) {
      const o = document.createElement("option");
      o.value = opt; o.textContent = opt;
      if (opt === current.value) o.selected = true;
      field.appendChild(o);
    }
    field.addEventListener("change", () => { step.params[p.key] = { type: "text", value: field.value }; });
  } else if (p.kind === "matrix8") {
    field = matrix8ParamEditor(step, p, current);
  } else if (p.key === "color") {
    // Param couleur : pastille native + bouton « Auto » (valeur vide = couleur du type).
    field = document.createElement("div");
    field.className = "param-color";
    field.style.display = "flex";
    field.style.alignItems = "center";
    field.style.gap = "8px";
    const hex = String(current.value || "").trim();
    const valid = /^#[0-9a-fA-F]{6}$/.test(hex);
    const sw = document.createElement("input");
    sw.type = "color";
    sw.className = "param-color-swatch";
    sw.value = valid ? hex : "#9961ff";
    const auto = document.createElement("button");
    auto.type = "button";
    auto.className = "param-color-auto";
    const syncAuto = () => {
      const isAuto = !/^#[0-9a-fA-F]{6}$/.test(String(step.params[p.key]?.value || ""));
      auto.textContent = isAuto ? "Auto (couleur du type)" : "Réinitialiser";
      sw.style.opacity = isAuto ? "0.5" : "1";
    };
    sw.addEventListener("input", () => { step.params[p.key] = { type: "text", value: sw.value }; syncAuto(); });
    auto.addEventListener("click", () => { step.params[p.key] = { type: "text", value: "" }; syncAuto(); });
    field.appendChild(sw);
    field.appendChild(auto);
    syncAuto();
    row.appendChild(field);
    return row;
  } else if (p.key === "icon") {
    // Param d'icône : champ libre (saisie manuelle) avec suggestions (datalist).
    field = document.createElement("input");
    field.className = "param-input";
    field.type = "text";
    field.setAttribute("list", "icon-suggestions");
    field.value = current.value ?? "";
    field.placeholder = p.placeholder || "bell, check, sparkles…";
    bindText(field, step, p);
    ensureIconDatalist();
  } else {
    field = document.createElement("input");
    field.className = "param-input";
    field.type = "text";
    field.value = current.value ?? "";
    field.placeholder = p.placeholder || "";
    bindText(field, step, p);
  }
  row.appendChild(field);
  return row;
}

// Noms d'icônes proposés pour les notifications (doivent correspondre aux clés
// de `ICONS` dans island.js). La saisie reste libre : ce n'est qu'une aide.
const ICON_NAMES = [
  "bell", "sparkles", "check", "warn", "error", "chat", "heart", "bolt",
  "info", "star", "clock", "calendar", "mail", "download", "upload", "trash",
  "gear", "user", "pin", "flag", "folder", "doc", "music", "moon",
];
// Crée une seule fois la <datalist> partagée pour les champs d'icône.
function ensureIconDatalist() {
  if (document.getElementById("icon-suggestions")) return;
  const dl = document.createElement("datalist");
  dl.id = "icon-suggestions";
  dl.innerHTML = ICON_NAMES.map((n) => `<option value="${n}"></option>`).join("");
  document.body.appendChild(dl);
}

function bindText(field, step, p) {
  field.addEventListener("input", () => { step.params[p.key] = { type: "text", value: field.value }; });
  field.addEventListener("focus", () => { lastFocusedField = field; });
}

function parseMatrix8Pixels(raw) {
  const empty = Array(64).fill(null);
  const txt = String(raw || "").trim();
  if (!txt) return empty;
  try {
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) {
      return Array.from({ length: 64 }, (_, i) => normalizePixel(parsed[i]));
    }
  } catch {}
  const rows = txt.split(/\r?\n/).map((r) => r.trim()).filter(Boolean).slice(0, 8);
  if (!rows.length) return empty;
  const pixels = [];
  for (const row of rows) {
    for (const ch of row.slice(0, 8)) pixels.push(ch === "." || ch === "0" ? null : "#40b4ff");
    while (pixels.length % 8) pixels.push(null);
  }
  while (pixels.length < 64) pixels.push(null);
  return pixels.slice(0, 64);
}

function normalizePixel(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length >= 3) {
    const hex = v.slice(0, 3).map((n) => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, "0")).join("");
    return "#" + hex;
  }
  const s = String(v).trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s : null;
}

function matrix8ParamEditor(step, p, current) {
  const wrap = document.createElement("div");
  wrap.className = "matrix8-param";
  let pixels = parseMatrix8Pixels(current.value ?? "");
  let paintColor = "#40b4ff";
  let erasing = false;
  let drawing = false;

  const save = () => { step.params[p.key] = { type: "text", value: JSON.stringify(pixels) }; };
  wrap.innerHTML =
    `<div class="matrix8-tools">` +
    `<input type="color" value="${paintColor}" title="Couleur du pinceau">` +
    `<button type="button" class="matrix8-tool">Gomme</button>` +
    `<button type="button" class="matrix8-tool">Effacer</button>` +
    `</div><div class="matrix8-canvas" role="grid" aria-label="Dessin matrice 8 par 8"></div>`;

  const color = wrap.querySelector("input");
  const [eraseBtn, clearBtn] = wrap.querySelectorAll(".matrix8-tool");
  const grid = wrap.querySelector(".matrix8-canvas");

  const paint = (idx) => {
    pixels[idx] = erasing ? null : paintColor;
    const cell = grid.children[idx];
    cell.style.background = pixels[idx] || "";
    cell.classList.toggle("on", !!pixels[idx]);
    save();
  };

  for (let i = 0; i < 64; i++) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "matrix8-cell";
    cell.style.background = pixels[i] || "";
    cell.classList.toggle("on", !!pixels[i]);
    cell.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      drawing = true;
      cell.setPointerCapture?.(e.pointerId);
      paint(i);
    });
    cell.addEventListener("pointerenter", () => { if (drawing) paint(i); });
    cell.addEventListener("pointerup", () => { drawing = false; });
    grid.appendChild(cell);
  }
  document.addEventListener("pointerup", () => { drawing = false; });

  color.addEventListener("change", (e) => {
    paintColor = e.target.value;
    erasing = false;
    eraseBtn.classList.remove("active");
  });
  eraseBtn.addEventListener("click", () => {
    erasing = !erasing;
    eraseBtn.classList.toggle("active", erasing);
  });
  clearBtn.addEventListener("click", () => {
    pixels = Array(64).fill(null);
    [...grid.children].forEach((cell) => { cell.style.background = ""; cell.classList.remove("on"); });
    save();
  });
  save();
  return wrap;
}

function insertVariable(token) {
  if (lastFocusedField) {
    const f = lastFocusedField;
    const start = f.selectionStart ?? f.value.length;
    const end = f.selectionEnd ?? f.value.length;
    f.value = f.value.slice(0, start) + token + f.value.slice(end);
    f.dispatchEvent(new Event("input"));
    f.focus();
    const pos = start + token.length;
    f.setSelectionRange(pos, pos);
  } else {
    navigator.clipboard?.writeText(token);
  }
}

// Déplace le pas `from` pour qu'il s'insère AVANT la position `insertAt` (indices
// dans le tableau courant, avant retrait). On corrige l'index après le retrait du
// pas déplacé : ainsi le résultat est le même quel que soit le sens du glissement
// (haut→bas ou bas→haut), ce qui supprime le comportement « des fois bon des fois
// pas » de l'ancien reorder.
function moveStep(from, insertAt) {
  if (from === null || insertAt === null || workflow.locked) return;
  if (from === insertAt || from + 1 === insertAt) return;
  const [moved] = workflow.steps.splice(from, 1);
  const adj = from < insertAt ? insertAt - 1 : insertAt;
  workflow.steps.splice(adj, 0, moved);
  renderCanvas();
}

function clearDropTargets(except = null) {
  document.querySelectorAll(".drop-gap.over").forEach((e) => {
    if (e !== except) e.classList.remove("over");
  });
}

// ===== Entrée de test (modal) =====
// La valeur de test vit dans le textarea #run-input (à l'intérieur du modal) :
// runWorkflow() la lit directement. Un point sur le bouton signale qu'une entrée
// est définie.
function initTestInputModal() {
  const modal = document.querySelector("#test-input-modal");
  const field = document.querySelector("#run-input");
  const suggestionBtn = document.querySelector("#test-input-suggestion");
  if (!modal || !field) return;

  suggestionBtn.textContent = t("test_input_suggestion");
  suggestionBtn.addEventListener("click", () => { field.value = t("test_input_suggestion"); updateTestInputDot(); });

  const open = () => { modal.hidden = false; field.focus(); };
  const close = () => { modal.hidden = true; };
  document.querySelector("#btn-test-input").addEventListener("click", open);
  document.querySelector("#btn-close-test-input").addEventListener("click", close);
  document.querySelector("#btn-cancel-test-input").addEventListener("click", close);
  document.querySelector("#btn-run-from-modal").addEventListener("click", () => { close(); runWorkflow(); });
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
  field.addEventListener("input", updateTestInputDot);
  updateTestInputDot();
}

function updateTestInputDot() {
  const field = document.querySelector("#run-input");
  const dot = document.querySelector(".test-input-dot");
  if (dot) dot.hidden = !(field && field.value.trim());
}

// ===== Exécution =====
async function runWorkflow() {
  if (!workflow.steps.length) return;
  // Entrée de test saisie dans le modal → exposée aux blocs via {{input}}.
  // Vide → null, comportement rétro-compatible (pas d'entrée).
  const inputEl = document.querySelector("#run-input");
  const input = inputEl && inputEl.value ? inputEl.value : null;
  const result = await invoke("run_workflow", { workflow: engineWorkflow(), input });
  renderLog(result);
}

function renderLog(result) {
  elRunLog.hidden = false;
  elRunLogBody.innerHTML = "";
  const summary = document.createElement("div");
  summary.className = `log-summary ${result.success ? "ok" : "err"}`;
  summary.textContent = result.success ? t("run_ok") : t("run_err");
  elRunLogBody.appendChild(summary);

  for (const s of result.steps) {
    const spec = specById[s.action];
    const div = document.createElement("div");
    div.className = `log-step ${s.error ? "error" : ""}`;
    const out = s.error ? s.error : valueToText(s.output);
    const label = spec ? spec.name : labelForControl(s.action);
    div.innerHTML = `
      <span class="log-dot">${s.error ? "✕" : "●"}</span>
      <div>
        <div class="log-name">${escapeHtml(label)} <span class="log-id">{{${s.step}}}</span></div>
        ${out ? `<div class="log-out">${escapeHtml(out)}</div>` : ""}
      </div>`;
    elRunLogBody.appendChild(div);
  }
  // Le journal se trouve après tous les blocs. On le remonte dans la zone
  // centrale et on repart du début du résultat ; son corps possède ensuite son
  // propre scroll pour les sorties longues.
  requestAnimationFrame(() => {
    elRunLog.scrollIntoView({ behavior: "smooth", block: "start" });
    elRunLogBody.scrollTop = 0;
  });
}

function labelForControl(id) {
  return { if: t("c_if"), else: t("c_else"), endif: t("c_endif"), repeat: t("c_repeat"),
    endrepeat: t("c_endrepeat"), repeat_each: t("c_repeat_each"), endrepeat_each: t("c_endrepeat"),
    stop: t("c_stop") }[id] || id;
}

function engineWorkflow() {
  return {
    name: workflow.name || t("untitled"),
    steps: workflow.steps.map(s => ({ id: s.id, action: s.action, params: s.params, name: s.name ?? null })),
    trigger: workflow.trigger || { type: "manual" },
    // `undefined` (workflows hérités) compte comme exposé → `!== false`.
    available_as_tool: workflow.available_as_tool !== false,
  };
}

// Bascule l'exposition du workflow au function calling. Désactiver le retire de
// la liste d'outils proposée au modèle (skills d'agents, routeur) : moins d'outils
// = appels plus précis. Persiste immédiatement quand le workflow existe déjà.
async function toggleToolAvailability() {
  if (workflow.locked) return;
  workflow.available_as_tool = workflow.available_as_tool === false;
  updateToolToggleBtn();
  if (workflow.name.trim()) await saveWorkflow();
}

// Reflète l'état du flag sur le bouton (libellé, icône, classe active).
function updateToolToggleBtn() {
  const btn = document.querySelector("#btn-tool-toggle");
  if (!btn) return;
  const on = workflow.available_as_tool !== false;
  btn.classList.toggle("tool-on", on);
  btn.innerHTML = icon("cpu", 15) + " " + t(on ? "tool_on" : "tool_off");
  btn.title = t(on ? "tool_on_title" : "tool_off_title");
}

// ===== Déclencheurs =====
function onTriggerChange() {
  const type = elTriggerType.value;
  if (type === "manual") {
    workflow.trigger = { type: "manual" };
    elTriggerParam.hidden = true;
  } else {
    elTriggerParam.hidden = false;
    elTriggerParam.placeholder = triggerHint(type);
    workflow.trigger = buildTrigger(type, elTriggerParam.value.trim());
  }
}

function buildTrigger(type, raw) {
  if (type === "cron") return { type: "cron", expr: raw };
  if (type === "interval") return { type: "interval", seconds: parseInt(raw, 10) || 0 };
  if (type === "file_change") return { type: "file_change", path: raw };
  // Badge RFID : UID vide = n'importe quel badge. On normalise comme le Rust
  // (majuscules, sans séparateur) pour que « 04:a2:b3:c4 » et « 04A2B3C4 »
  // désignent bien le même badge.
  if (type === "rfid") return { type: "rfid", uid: raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase() };
  if (type === "webhook") return { type: "webhook", path: raw };
  return { type: "manual" };
}

function renderTrigger() {
  const t = workflow.trigger || { type: "manual" };
  elTriggerType.value = t.type || "manual";
  if (t.type && t.type !== "manual") {
    elTriggerParam.hidden = false;
    elTriggerParam.placeholder = triggerHint(t.type);
    elTriggerParam.value = t.type === "cron" ? (t.expr || "")
      : t.type === "interval" ? (t.seconds ?? "")
      : (t.type === "file_change" || t.type === "webhook") ? (t.path || "")
      : t.type === "rfid" ? (t.uid || "") : "";
  } else {
    elTriggerParam.hidden = true;
    elTriggerParam.value = "";
  }
}

let toastTimer = null;
function showToast(payload) {
  if (!payload) return;
  let toast = document.querySelector("#toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  const out = (payload.output || "").slice(0, 80);
  toast.className = "toast visible" + (payload.success ? "" : " error");
  toast.innerHTML = `${icon("clock", 14)}<div><strong>${escapeHtml(payload.workflow)}</strong> · ${escapeHtml(payload.trigger)}<br><span class="toast-out">${payload.success ? escapeHtml(out) || t("executed") : t("failed")}</span></div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 5000);
}

function valueToText(v) {
  if (!v) return "";
  if (v.type === "text" || v.type === "number" || v.type === "file") return String(v.value);
  if (v.type === "bool") return v.value ? t("yes") : t("no");
  if (v.type === "null") return "";
  return JSON.stringify(v.value);
}

// ===== Persistance =====
async function refreshWorkflowList() {
  let metas = [];
  try { metas = await invoke("list_workflows"); } catch (e) { console.error(e); }
  // Compat : ancienne API renvoyait des chaînes.
  metas = metas.map(m => typeof m === "string" ? { name: m, locked: false } : m);
  elWfList.innerHTML = "";
  if (!metas.length) {
    const empty = document.createElement("div");
    empty.className = "wf-empty";
    empty.textContent = t("no_workflows");
    elWfList.appendChild(empty);
    return;
  }
  for (const { name, locked } of metas) {
    const item = document.createElement("div");
    item.className = "wf-item" + (name === workflow.name ? " active" : "");
    const right = locked
      ? `<span class="wf-lock" title="${escapeHtml(t("locked_wf"))}">${icon("lock", 13)}</span>`
      : `<span class="del" title="${escapeHtml(t("delete"))}">${icon("trash", 14)}</span>`;
    item.innerHTML = `<span class="wf-name-txt">${escapeHtml(name)}</span>${right}`;
    // Toute la ligne est cliquable (et pas seulement le texte) : l'espace vide
    // créé par `justify-content: space-between` avalait sinon le clic.
    item.addEventListener("click", () => openWorkflow(name));
    const del = item.querySelector(".del");
    if (del) del.addEventListener("click", (e) => { e.stopPropagation(); deleteWorkflow(name); });
    elWfList.appendChild(item);
  }
}

async function openWorkflow(name) {
  try {
    workflow = await invoke("load_workflow", { name });
    if (!Array.isArray(workflow.steps)) workflow.steps = [];
    loadCollapsed();
    renderCanvas();
    refreshWorkflowList();
    elRunLog.hidden = true;
  } catch (e) { console.error(e); }
}

async function saveWorkflow() {
  if (!workflow.name.trim()) { workflow.name = t("untitled"); elWfName.value = workflow.name; }
  try {
    await invoke("save_workflow", { workflow: engineWorkflow() });
    await refreshWorkflowList();
    await invoke("reload_triggers"); // prend en compte le déclencheur enregistré
  } catch (e) { console.error(e); }
}

function newWorkflow() {
  workflow = { name: "", steps: [] };
  collapsedIds = new Set();
  elRunLog.hidden = true;
  renderCanvas();
  refreshWorkflowList();
  elWfName.focus();
}

// Restaure le routeur par défaut à son gabarit d'origine (avec confirmation).
async function resetDefaultRouter() {
  const ok = await confirmDialog(t("confirm_reset"));
  if (!ok) return;
  workflow = defaultRouterTemplate();
  elWfName.value = workflow.name;
  elRunLog.hidden = true;
  renderCanvas();
  await saveWorkflow();
}

async function deleteWorkflow(name) {
  if (!(await confirmDialog(t("confirm_delete", { name })))) return;
  try {
    await invoke("delete_workflow", { name });
    if (workflow.name === name) newWorkflow(); else await refreshWorkflowList();
    await invoke("reload_triggers");
  } catch (e) { console.error(e); }
}

// ===== Confirmation (modale in-app) =====
// window.confirm() ne s'affiche pas dans la webview Tauri (WKWebView sans délégué
// de panneau JS) : il renvoie false sans rien montrer. On utilise donc une modale
// maison qui résout une promesse selon le bouton cliqué.
function confirmDialog(message) {
  return new Promise((resolve) => {
    const modal = document.querySelector("#confirm-modal");
    const msg = document.querySelector("#confirm-message");
    const okBtn = document.querySelector("#btn-confirm-ok");
    const cancelBtn = document.querySelector("#btn-confirm-cancel");
    // Repli si la modale n'existe pas (sécurité) : on annule.
    if (!modal || !msg || !okBtn || !cancelBtn) { resolve(false); return; }

    msg.textContent = message;
    msg.style.whiteSpace = "pre-line"; // les messages contiennent des \n
    document.querySelector("#confirm-title").textContent = t("confirm_title");
    modal.hidden = false;
    okBtn.focus();

    const cleanup = (result) => {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
      else if (e.key === "Enter") cleanup(true);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}

// ===== Util =====
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
