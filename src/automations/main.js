import { translatePage, observeTranslations } from "../apps-i18n.js";
import { delegateExternalLinks } from "../lib/open-external.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";

const tauri = window.__TAURI__ || window.parent?.__TAURI__ || {};
const invoke = tauri.core?.invoke;
const $ = (selector) => document.querySelector(selector);
const PALETTE = ["#0a84ff", "#6b6ff0", "#16b8a6", "#e88438", "#d75c92"];

// La couleur d'un bloc dépend UNIQUEMENT de sa catégorie, et l'ordre des
// catégories est celui du catalogue complet (pas celui de la liste filtrée) :
// la pastille d'un bloc est donc la même dans la palette et sur le canevas,
// quelle que soit la recherche en cours ou l'ordre d'ajout des nœuds.
function categoryColor(category) {
  const key = String(category || "");
  const all = [...new Set(specs.map(s => String(s.category || "")))].sort((a, b) => a.localeCompare(b, "fr"));
  const index = all.indexOf(key);
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length];
}
const LAYOUT_PREFIX = "lumen.automations.layout.";
let specs = [], specById = {}, domotiqueDevices = [], systemVoices = [], ttsVoices = [], graph = freshGraph(), selectedId = null, view = { x: 80, y: 90, scale: 1 };
let dragging = null, connecting = null, toastTimer, spacePressed = false;
let lastParamKey = null;
let runState = { active: false, statuses: {}, outputs: {}, durations: {}, logs: [], startedAt: 0, elapsed: 0, timer: null };
let loadedWorkflowSnapshot = null;

function freshGraph(name = "") { return { name, nodes: [], edges: [], trigger: { type: "manual" } }; }
function id(prefix = "node") { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function semanticVariableBase(node) { const source = node.label || nodeSpec(node).name || node.action || "resultat"; const slug = source.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 42); return slug || "resultat"; }
function rewriteNamedReference(value, from, to) { if (Array.isArray(value)) return value.map(item => rewriteNamedReference(item, from, to)); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteNamedReference(item, from, to)])); if (typeof value !== "string") return value; const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return value.replace(new RegExp(`{{\\s*${escaped}(?=\\.|\\s*}})`, "g"), `{{${to}`); }
function ensureFluxoIds() {
  const used = new Set(), migrations = [];
  // Tous les blocs, y compris ceux importés depuis Fluxo, reçoivent une seule
  // fois un identifiant sémantique. Le marqueur de version le rend ensuite
  // stable même si l'utilisateur renomme visuellement le bloc.
  graph.nodes.forEach(node => {
    if (node.variableIdVersion === 1 && node.fluxoId && !used.has(node.fluxoId)) { used.add(node.fluxoId); return; }
    const previous = node.fluxoId || "", base = semanticVariableBase(node); let next = base, suffix = 2;
    while (used.has(next)) next = `${base}_${suffix++}`;
    node.fluxoId = next; node.variableIdVersion = 1; used.add(next); if (previous && previous !== next) migrations.push([previous, next]);
  });
  if (migrations.length) graph.nodes.forEach(node => { migrations.forEach(([from, to]) => { node.params = rewriteNamedReference(node.params || {}, from, to); }); });
}
function esc(value = "") { const d = document.createElement("div"); d.textContent = String(value); return d.innerHTML; }
function defaultValue(param) { if (param.default) return param.default; if (param.kind === "number") return { type: "number", value: 0 }; if (param.kind === "bool") return { type: "bool", value: false }; return { type: "text", value: param.kind === "select" ? (param.options?.[0] || "") : "" }; }
function nodeSpec(node) { return specById[node.action] || { id: node.action, name: node.label || node.action, category: "Fluxo", description: "Bloc Fluxo" }; }
function notify(message) { const el = $("#toast"); el.textContent = message; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 3200); }
function outputText(value) { if (value == null) return ""; if (typeof value === "string") return value; if (value?.value != null) return typeof value.value === "string" ? value.value : JSON.stringify(value.value); try { return JSON.stringify(value); } catch { return String(value); } }
function outputKind(value) { if (value?.value != null) value = value.value; if (typeof value === "string") { try { return outputKind(JSON.parse(value)); } catch { return "text"; } } if (Array.isArray(value)) return "list"; if (value && typeof value === "object") return "object"; if (typeof value === "boolean") return "bool"; if (typeof value === "number") return "number"; return "empty"; }
function prettyOutput(value) { if (value?.value != null) value = value.value; if (typeof value === "string") { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } } try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ""); } }
function safeMediaUrl(value) { const url = String(value || "").trim(); return /^(https?:\/\/|data:image\/|blob:)/i.test(url) ? url : ""; }
function inlineMarkdown(value) {
  const source = String(value ?? "");
  const token = /(!?\[[^\]]*\]\([^\)]+\)|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`)/g;
  let html = "", last = 0, match;
  while ((match = token.exec(source))) {
    html += esc(source.slice(last, match.index));
    const part = match[0];
    if (part.startsWith("![")) {
      const parsed = part.match(/^!\[([^\]]*)\]\(([^\)]+)\)$/); const url = safeMediaUrl(parsed?.[2]);
      html += url ? `<img class="rich-image" src="${esc(url)}" alt="${esc(parsed?.[1] || "Image")}" loading="lazy">` : esc(part);
    } else if (part.startsWith("[")) {
      const parsed = part.match(/^\[([^\]]+)\]\(([^\)]+)\)$/); const url = safeMediaUrl(parsed?.[2]);
      html += url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(parsed[1])}</a>` : esc(part);
    } else if (part.startsWith("**") || part.startsWith("__")) html += `<strong>${esc(part.slice(2, -2))}</strong>`;
    else html += `<code>${esc(part.slice(1, -1))}</code>`;
    last = token.lastIndex;
  }
  html += esc(source.slice(last));
  return html.replace(/(^|\s)(https?:\/\/[^\s<]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s<]+)?)(?=\s|$)/gi, (_m, lead, url) => `${lead}<img class="rich-image" src="${esc(url)}" alt="Image" loading="lazy">`);
}
function markdownToHtml(value) {
  const lines = String(value ?? "").replace(/\r/g, "").split("\n"), out = []; let list = null, codeFence = false;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) { closeList(); if (codeFence) { out.push("</code></pre>"); codeFence = false; } else { out.push("<pre><code>"); codeFence = true; } continue; }
    if (codeFence) { out.push(`${esc(raw)}\n`); continue; }
    if (!line) { closeList(); continue; }
    const imageOnly = line.match(/^!\[([^\]]*)\]\(([^\)]+)\)$/); const bareImage = safeMediaUrl(line) && /\.(?:png|jpe?g|gif|webp)(?:\?.*)?$/i.test(line);
    if (imageOnly || bareImage) { closeList(); out.push(imageOnly ? inlineMarkdown(line) : `<img class="rich-image" src="${esc(line)}" alt="Image" loading="lazy">`); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/); if (heading) { closeList(); const level = heading[1].length; out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    const bullet = line.match(/^[-*+]\s+(.+)$/); if (bullet) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inlineMarkdown(bullet[1])}</li>`); continue; }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/); if (ordered) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inlineMarkdown(ordered[1])}</li>`); continue; }
    closeList(); out.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList(); if (codeFence) out.push("</code></pre>"); return out.join("") || "<p class=\"rich-empty\">Aucune donnée</p>";
}
function richOutput(value) {
  let raw = value?.value != null ? value.value : value;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const media = safeMediaUrl(raw.image || raw.image_url || raw.src || raw.url);
    if (media) return `<img class="rich-image rich-image-standalone" src="${esc(media)}" alt="Image" loading="lazy"><pre>${esc(prettyOutput(raw))}</pre>`;
    raw = prettyOutput(raw);
  } else if (Array.isArray(raw)) raw = prettyOutput(raw);
  return markdownToHtml(raw);
}
function runStatusLabel(status) { return ({ pending: "En attente", running: "Exécution…", success: "Terminé", error: "Échec", skipped: "Non exécuté" })[status] || ""; }
function updateRunHud(text, done = false) { const hud = $("#run-hud"); hud.hidden = !runState.active && !done; $("#run-status").textContent = text; if (done) $("#run-title").textContent = "Flow Theater · résultat"; }
function tickRunClock() { if (!runState.startedAt) return; const elapsed = runState.active ? Date.now() - runState.startedAt : runState.elapsed; $("#run-time").textContent = `${(elapsed / 1000).toFixed(1)} s`; }
function renderLogs() { const list = $("#run-log-list"); if (!list) return; if (!runState.logs.length) { list.innerHTML = '<div class="log-empty">Aucune exécution à afficher.</div>'; return; } list.innerHTML = runState.logs.map(log => `<article data-node-id="${esc(log.nodeId)}" class="log-entry ${esc(log.status)}"><div class="log-entry-head"><span class="log-dot"></span><strong>${esc(log.label)}</strong><span class="log-status">${esc(runStatusLabel(log.status))}</span><span class="log-entry-meta">${esc(log.time)}${log.duration != null ? ` · ${log.duration} ms` : ""}</span></div>${log.output ? `<pre class="log-entry-output">${esc(outputText(log.output))}</pre>` : ""}</article>`).join(""); list.scrollTop = list.scrollHeight; }
function addRunLog(node, status, output = null, duration = null) { runState.logs.push({ nodeId: node.id, label: node.label || node.action, status, output, duration, startedAt: Date.now(), time: new Date().toLocaleTimeString("fr-FR") }); renderLogs(); }
function openDataDetails(node) { const value = runState.outputs[node.id]; if (value == null) return notify("Aucune donnée produite par ce bloc."); $("#data-modal-title").textContent = `${node.label || node.action} · données`; $("#data-modal-body").innerHTML = richOutput(value); $("#data-modal").hidden = false; }
function focusNodeLog(node) { $("#run-log-panel").hidden = false; renderLogs(); const target = document.querySelector(`#run-log-list .log-entry[data-node-id="${CSS.escape(node.id)}"]`); target?.classList.add("selected"); target?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }

async function init() {
  if (!invoke) return notify("Le backend Lumen est indisponible.");
  try { specs = await invoke("list_actions"); } catch (error) { notify(`Blocs indisponibles : ${error}`); }
  try {
    const raw = await invoke("domotique_devices_summary");
    domotiqueDevices = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw || []);
    if (!Array.isArray(domotiqueDevices)) domotiqueDevices = [];
  } catch { domotiqueDevices = []; }
  try { systemVoices = await invoke("system_voice_list"); if (!Array.isArray(systemVoices)) systemVoices = []; } catch { systemVoices = []; }
  try { const catalog = await invoke("tts_catalog"); ttsVoices = Array.isArray(catalog) ? catalog.filter(v => v.installed).map(v => ({ id: v.id, label: `${v.label || v.id} · ${v.engine}` })) : []; } catch { ttsVoices = []; }
  specById = Object.fromEntries(specs.map(s => [s.id, s]));
  renderPalette(); bind(); render();
}

// Recherche insensible aux ACCENTS : taper « Generer » doit trouver
// « Générer ». On replie les diacritiques des deux côtés (requête et libellés).
function foldAccents(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function renderPalette() {
  const search = foldAccents($("#action-search").value).trim();
  const ordered = [...specs].sort((a, b) => `${a.category}${a.name}`.localeCompare(`${b.category}${b.name}`, "fr"));
  const grouped = ordered.filter(s => !search || foldAccents(`${s.name} ${s.description} ${s.category}`).includes(search)).reduce((acc, spec) => { (acc[spec.category] ||= []).push(spec); return acc; }, {});
  const list = $("#action-list"); list.innerHTML = ""; $("#action-count").textContent = `${specs.length} actions`;
  // Toutes les actions retournées par Fluxo sont affichées ici. Les blocs qui
  // pilotent les autres applications Lumen (agents, calendrier, mémoire,
  // connaissances, tables, image, ML, domotique…) restent donc dans le même
  // catalogue, avec leurs permissions et leur exécution confinée.
  Object.entries(grouped).forEach(([category, items], index) => {
    const head = document.createElement("div"); head.className = "category-label"; head.textContent = category; list.append(head);
    items.forEach(spec => {
      const color = categoryColor(category); const item = document.createElement("button"); item.className = "action-item";
      item.innerHTML = `<span class="action-icon" style="--action-color:${color}22;--action-text:${color}">${esc((spec.name || "?").slice(0, 1))}</span><span><span class="action-title">${esc(spec.name)}</span><span class="action-desc">${esc(spec.description || "")}</span></span>`;
      item.onclick = () => addNode(spec.id); list.append(item);
    });
  });
}

function addNode(action, x, y) {
  const spec = specById[action]; if (!spec) return;
  const center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const node = { id: id("step"), action, label: spec.name, x: x ?? center.x, y: y ?? center.y, params: {} };
  (spec.params || []).forEach(param => node.params[param.key] = defaultValue(param));
  graph.nodes.push(node); ensureFluxoIds(); selectedId = node.id; render(); saveLayout();
}

// ===== Assistant IA (boîte de prompt partagée) =====
// Construire une automatisation en la décrivant : l'IA cherche les blocs
// disponibles, les pose, les relie, règle leurs paramètres, choisit le
// déclencheur, teste et enregistre dans Fluxo.
const AUTO_TOOLS = [
  tool("list_blocks", "Cherche les blocs disponibles (nom, description, paramètres). À appeler AVANT de construire.",
    { query: T.str("Filtre sur le nom ou la description"), category: T.str("Catégorie") }),
  tool("describe_block", "Détail d'un bloc : ses paramètres, leurs types et valeurs possibles.", { action: T.str("Identifiant du bloc") }, ["action"]),
  tool("describe_workflow", "État de l'automatisation en cours : nom, déclencheur, blocs, liaisons.", {}),
  tool("add_block", "Pose un bloc sur le canevas et renvoie son identifiant.",
    { action: T.str("Identifiant du bloc"), label: T.str("Nom affiché"),
      params: { type: "object", description: "Paramètres { clé: valeur texte }" } }, ["action"]),
  tool("set_params", "Règle les paramètres d'un bloc déjà posé.",
    { block: T.str("Identifiant ou nom du bloc"), params: { type: "object", description: "{ clé: valeur }" } }, ["block", "params"]),
  tool("connect_blocks", "Relie deux blocs (la sortie du premier alimente le second).",
    { from: T.str(""), to: T.str("") }, ["from", "to"]),
  tool("delete_block", "Retire un bloc du canevas.", { block: T.str("") }, ["block"]),
  tool("set_trigger", "Choisit le déclencheur : manuel, CRON ou badge RFID.",
    { type: T.enum(["manual", "cron", "rfid"], ""), cron: T.str("Expression CRON à 6 champs"), rfid: T.str("UID du badge") }, ["type"]),
  tool("rename_workflow", "Nomme l'automatisation.", { name: T.str("") }, ["name"]),
  tool("run_test", "Exécute l'automatisation une fois pour la tester.", { input: T.str("Valeur de {{input}}") }),
  tool("save_workflow", "Enregistre l'automatisation dans Fluxo.", {}),
  tool("list_workflows", "Liste les automatisations Fluxo enregistrées.", {}),
  tool("open_workflow", "Ouvre une automatisation existante.", { name: T.str("") }, ["name"]),
];

const nodeByRef = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return graph.nodes.find((n) => n.id === ref || n.fluxoId === ref)
    || graph.nodes.find((n) => String(n.label || "").toLowerCase() === r)
    || graph.nodes.find((n) => String(n.label || "").toLowerCase().includes(r));
};

function applyParams(node, params) {
  const spec = nodeSpec(node);
  const known = new Set((spec.params || []).map((p) => p.key));
  const applied = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (known.size && !known.has(k)) continue;
    const param = (spec.params || []).find((p) => p.key === k);
    const kind = param?.kind || "text";
    node.params[k] = kind === "number" ? { type: "number", value: Number(v) || 0 }
      : kind === "bool" ? { type: "bool", value: !!v && v !== "false" }
      : { type: "text", value: String(v) };
    applied.push(k);
  }
  return applied;
}

async function runAutoTool(name, a) {
  const need = (ref) => { const n = nodeByRef(ref); if (!n) throw new Error(`bloc « ${ref} » introuvable ; appelle describe_workflow.`); return n; };
  switch (name) {
    case "list_blocks": {
      const q = String(a.query || "").toLowerCase();
      const items = specs.filter((sp) => (!q || `${sp.id} ${sp.name} ${sp.description || ""}`.toLowerCase().includes(q))
        && (!a.category || String(sp.category || "").toLowerCase() === String(a.category).toLowerCase()));
      if (!items.length) return "Aucun bloc ne correspond.";
      return items.slice(0, 60).map((sp) => `${sp.id} · ${sp.name} [${sp.category || "-"}] — ${String(sp.description || "").slice(0, 90)}`).join("\n");
    }
    case "describe_block": {
      const sp = specById[a.action];
      if (!sp) throw new Error("bloc inconnu ; appelle list_blocks.");
      return `${sp.id} · ${sp.name}\n${sp.description || ""}\nParamètres : `
        + ((sp.params || []).map((p) => `${p.key} (${p.kind}${p.options ? " : " + p.options.join("|") : ""})`).join(", ") || "aucun");
    }
    case "describe_workflow": {
      if (!graph.nodes.length) return "Canevas vide. Déclencheur : " + (graph.trigger?.type || "manual");
      const edges = graph.edges.map((e) => {
        const f = graph.nodes.find((n) => n.id === e.from), t = graph.nodes.find((n) => n.id === e.to);
        return `${f?.label || e.from} → ${t?.label || e.to}`;
      });
      return `Nom : ${$("#workflow-name").value || "(sans titre)"} · déclencheur : ${graph.trigger?.type || "manual"}\n`
        + graph.nodes.map((n) => `${n.fluxoId || n.id} · ${n.label} (${n.action}) — `
          + Object.entries(n.params || {}).map(([k, v]) => `${k}=${outputText(v)}`).join(", ")).join("\n")
        + (edges.length ? `\nLiaisons : ${edges.join(" ; ")}` : "");
    }
    case "add_block": {
      if (!specById[a.action]) throw new Error(`bloc « ${a.action} » inconnu ; appelle list_blocks.`);
      addNode(a.action);
      const node = graph.nodes[graph.nodes.length - 1];
      if (a.label) node.label = String(a.label);
      if (a.params) applyParams(node, a.params);
      ensureFluxoIds();
      return `Bloc posé : ${node.fluxoId} · ${node.label}`;
    }
    case "set_params": {
      const node = need(a.block);
      const applied = applyParams(node, a.params);
      return applied.length ? `Paramètres réglés sur « ${node.label} » : ${applied.join(", ")}` : "Aucun paramètre reconnu pour ce bloc.";
    }
    case "connect_blocks": {
      const f = need(a.from), t = need(a.to);
      if (graph.edges.some((e) => e.to === t.id)) throw new Error("ce bloc a déjà un parent ; utilise une référence {{bloc}} dans ses paramètres.");
      graph.edges.push({ id: id("edge"), from: f.id, to: t.id });
      if (hasCycle()) { graph.edges.pop(); throw new Error("cette liaison créerait une boucle."); }
      return `Relié : « ${f.label} » → « ${t.label} »`;
    }
    case "delete_block": {
      const n = need(a.block);
      graph.nodes = graph.nodes.filter((x) => x.id !== n.id);
      graph.edges = graph.edges.filter((e) => e.from !== n.id && e.to !== n.id);
      if (selectedId === n.id) selectedId = null;
      return `Bloc « ${n.label} » retiré.`;
    }
    case "set_trigger": {
      const type = ["manual", "cron", "rfid"].includes(a.type) ? a.type : "manual";
      graph.trigger = { type, ...(type === "cron" ? { cron: String(a.cron || "0 0 9 * * *") } : {}), ...(type === "rfid" ? { uid: String(a.rfid || "") } : {}) };
      $("#trigger-type").value = type;
      if (type === "cron") $("#trigger-cron").value = graph.trigger.cron;
      if (type === "rfid") $("#trigger-rfid").value = graph.trigger.uid;
      syncTriggerUi();
      return `Déclencheur : ${type}${graph.trigger.cron ? " (" + graph.trigger.cron + ")" : ""}`;
    }
    case "rename_workflow": { $("#workflow-name").value = String(a.name); graph.name = String(a.name); return `Nommée « ${a.name} ».`; }
    case "run_test": {
      if (a.input != null) $("#run-input").value = String(a.input);
      await runWorkflow();
      const logs = (runState.logs || []).slice(-6).map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
      return `Exécution terminée.\n${logs || "(pas de journal)"}`;
    }
    case "save_workflow": { await saveWorkflow(); return "Automatisation enregistrée dans Fluxo."; }
    case "list_workflows": {
      const metas = await invoke("list_workflows");
      const names = (metas || []).map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean);
      return names.length ? names.join("\n") : "Aucune automatisation enregistrée.";
    }
    case "open_workflow": {
      const workflow = await invoke("load_workflow", { name: String(a.name) });
      $("#workflow-name").value = String(a.name);
      restoreLayout(String(a.name), workflow);
      selectedId = null;
      return `Ouverte : « ${a.name} » (${graph.nodes.length} blocs).`;
    }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountAutomationsAI() {
  mountAiPrompt(null, {
    app: "Automatisations",
    intro: "Tu construis des automatisations Fluxo : blocs, liaisons, paramètres, déclencheur.",
    rules: "- Commence TOUJOURS par list_blocks (puis describe_block) : n'invente jamais un identifiant de bloc ni un paramètre.\n- Construis dans l'ordre : poser les blocs, les relier, régler les paramètres, choisir le déclencheur.\n- Propose un test (run_test) avant d'enregistrer, et n'enregistre que si l'utilisateur le demande.",
    placeholder: "Ex. : chaque matin à 8 h, résume mes mails et envoie-moi une notification…",
    suggestions: [
      { label: "Construire", prompt: "Construis une automatisation à partir de ce que je vais décrire. Commence par regarder les blocs disponibles." },
      { label: "Quels blocs ?", prompt: "Quels blocs sont disponibles et que peuvent-ils faire ? Regroupe-les par catégorie." },
      { label: "Expliquer", prompt: "Explique ce que fait l'automatisation actuellement posée sur le canevas, étape par étape." },
      { label: "Programmer", prompt: "Fais tourner cette automatisation tous les matins à 8 h." },
    ],
    tools: AUTO_TOOLS,
    context: () => `${specs.length} blocs disponibles. Canevas : ${graph.nodes.length} bloc(s), déclencheur ${graph.trigger?.type || "manual"}.`,
    execute: runAutoTool,
    onApplied: () => { render(); saveLayout(); },
  });
}

function render() {
  ensureFluxoIds();
  const world = $("#world"), links = $("#links"); world.innerHTML = ""; links.innerHTML = "";
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`; links.style.transform = "none";
  graph.nodes.forEach((node, index) => {
    const spec = nodeSpec(node), color = categoryColor(spec.category); const el = document.createElement("article");
    const runStatus = runState.statuses[node.id] || "";
    const duration = runState.durations[node.id]; const durationLabel = duration != null ? `· ${(duration / 1000).toFixed(1)} s` : "";
    const runtime = `<div class="node-runtime"><span class="status-dot"></span><span>${runStatus ? runStatusLabel(runStatus) : "Prêt"}</span><span class="node-duration">${durationLabel}</span><span class="node-runtime-spacer"></span><button class="node-info" title="Dernier log de ce bloc">i</button></div>${runState.outputs[node.id] != null ? `<div class="node-preview type-${outputKind(runState.outputs[node.id])}"><div class="node-preview-head"><span>Aperçu · ${esc(outputKind(runState.outputs[node.id]))}</span><button class="node-expand" title="Agrandir les données">↗</button></div><pre class="node-output">${esc(prettyOutput(runState.outputs[node.id]))}</pre></div>` : ""}`;
    el.className = `node${selectedId === node.id ? " selected" : ""}`; el.dataset.id = node.id; el.dataset.run = runStatus; el.style.left = `${node.x}px`; el.style.top = `${node.y}px`;
    el.innerHTML = `<button class="port in" aria-label="Entrée"></button><div class="node-head"><span class="node-icon" style="--node-bg:${color}22;--node-color:${color}">${esc((spec.name || "?")[0])}</span><span class="node-title">${esc(node.label || spec.name)}</span><button class="node-ref" title="Référence de sortie : cliquez pour copier">{{${esc(node.fluxoId)}}}</button><span class="node-category">${esc(spec.category || "")}</span></div><div class="node-body">${esc(spec.description || "Action Fluxo")}</div>${runtime}<button class="port out" aria-label="Sortie"></button>`;
    el.addEventListener("pointerdown", event => onNodePointerDown(event, node));
    el.querySelector(".out").addEventListener("pointerdown", event => beginConnection(event, node));
    el.querySelector(".node-ref").addEventListener("pointerdown", event => event.stopPropagation());
    el.querySelector(".node-ref").addEventListener("click", event => { event.stopPropagation(); navigator.clipboard?.writeText(`{{${node.fluxoId}}}`).catch(() => {}); notify(`Référence {{${node.fluxoId}}} copiée.`); });
    el.querySelector(".node-info").addEventListener("pointerdown", event => event.stopPropagation());
    el.querySelector(".node-info").addEventListener("click", event => { event.stopPropagation(); focusNodeLog(node); });
    el.querySelector(".node-expand")?.addEventListener("pointerdown", event => { event.stopPropagation(); openDataDetails(node); });
    el.querySelector(".in").addEventListener("pointerup", event => endConnection(event, node)); world.append(el);
  });
  graph.edges.forEach(edge => drawEdge(edge, links));
  $("#empty-state").hidden = graph.nodes.length > 0; renderInspector(); tickRunClock();
}

function pointFor(nodeId, output) { const port = document.querySelector(`.node[data-id="${CSS.escape(nodeId)}"] .port.${output ? "out" : "in"}`); const stage = $("#stage"); if (!port || !stage) return null; const portRect = port.getBoundingClientRect(), stageRect = stage.getBoundingClientRect(); return { x: portRect.left + portRect.width / 2 - stageRect.left, y: portRect.top + portRect.height / 2 - stageRect.top }; }
function path(a, b) { const dx = Math.max(50, Math.abs(b.x - a.x) * .5); return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`; }
function drawEdge(edge, svg) { const a = pointFor(edge.from, true), b = pointFor(edge.to, false); if (!a || !b) return; const e = document.createElementNS("http://www.w3.org/2000/svg", "path"); e.setAttribute("d", path(a, b)); e.setAttribute("class", "edge"); svg.append(e); }
function drawLiveEdge(clientX, clientY) { const svg = $("#links"), stage = $("#stage"); svg.querySelector(".edge-live")?.remove(); if (!connecting || !stage) return; const rect = stage.getBoundingClientRect(), a = pointFor(connecting, true), b = { x: clientX - rect.left, y: clientY - rect.top }; if (!a) return; const e = document.createElementNS("http://www.w3.org/2000/svg", "path"); e.setAttribute("d", path(a, b)); e.setAttribute("class", "edge-live"); svg.append(e); }

function onNodePointerDown(event, node) { if (event.target.closest(".port")) return; event.preventDefault(); selectedId = node.id; const p = screenToWorld(event.clientX, event.clientY); dragging = { node, dx: p.x - node.x, dy: p.y - node.y }; render(); }
function beginConnection(event, node) { event.preventDefault(); event.stopPropagation(); connecting = node.id; drawLiveEdge(event.clientX, event.clientY); }
function endConnection(event, node) { if (!connecting || connecting === node.id) return; event.preventDefault(); event.stopPropagation(); if (!graph.edges.some(e => e.from === connecting && e.to === node.id)) { if (graph.edges.some(e => e.to === node.id)) { connecting = null; notify("Un bloc ne peut avoir qu’un seul parent direct. Utilisez les références {{bloc}} pour combiner plusieurs sorties."); return render(); } graph.edges.push({ id: id("edge"), from: connecting, to: node.id }); if (hasCycle()) { graph.edges.pop(); notify("Une automatisation ne peut pas contenir de boucle de connexions."); } else saveLayout(); } connecting = null; render(); }
function hasCycle() { const incoming = Object.fromEntries(graph.nodes.map(n => [n.id, 0])); graph.edges.forEach(e => incoming[e.to]++); const queue = Object.keys(incoming).filter(k => !incoming[k]); let seen = 0; while (queue.length) { const current = queue.shift(); seen++; graph.edges.filter(e => e.from === current).forEach(e => { if (!--incoming[e.to]) queue.push(e.to); }); } return seen !== graph.nodes.length; }
function screenToWorld(x, y) { const rect = $("#stage").getBoundingClientRect(); return { x: (x - rect.left - view.x) / view.scale, y: (y - rect.top - view.y) / view.scale }; }

function renderInspector() {
  const node = graph.nodes.find(n => n.id === selectedId); $("#inspector-empty").hidden = !!node; $("#node-form").hidden = !node; $("#delete-node").disabled = !node; if (!node) return;
  const spec = nodeSpec(node), form = $("#node-form");
  const parentIds = graph.edges.filter(edge => edge.to === node.id).map(edge => edge.from);
  const parents = parentIds.map(parentId => graph.nodes.find(candidate => candidate.id === parentId)).filter(Boolean);
  const executionOrder = topologicalNodes(), nodeIndex = executionOrder.findIndex(candidate => candidate.id === node.id);
  const available = executionOrder.slice(0, Math.max(0, nodeIndex));
  const chips = [`<button type="button" class="variable-chip" data-variable="{{input}}">{{input}}</button>`, ...available.map(candidate => `<button type="button" class="variable-chip${parentIds.includes(candidate.id) ? " parent" : ""}" data-variable="{{${esc(candidate.fluxoId)}}}" title="Sortie de ${esc(candidate.label || candidate.action)}">{{${esc(candidate.fluxoId)}}}</button>`)].join("");
  const alias = parents.length === 1 ? `<div class="variable-alias"><code>{{last}}</code> désigne automatiquement le parent relié <code>{{${esc(parents[0].fluxoId)}}}</code>.</div>` : `<div class="variable-alias"><code>{{input}}</code> désigne uniquement l’entrée initiale du workflow.</div>`;
  form.innerHTML = `<div class="field"><label>Nom du bloc</label><input data-label value="${esc(node.label)}" /></div><div class="variables-panel"><strong>Données disponibles</strong><p class="variables-help">Cliquez sur un badge pour l’insérer dans le champ actif. Les badges bleus sont les parents directement reliés.</p><div class="variable-chips">${chips}</div>${alias}</div>` + (spec.params || []).map(param => {
    const value = node.params[param.key] || defaultValue(param), raw = value.value ?? "";
    const isDeviceField = param.key === "device" && node.action.startsWith("domotique_");
    const isSystemVoiceField = node.action === "speak" && param.key === "voice";
    const deviceOptions = domotiqueDevices.map(device => {
      const reference = device.name || device.id;
      return `<option value="${esc(reference)}" ${String(reference) === String(raw) ? "selected" : ""}>${esc(device.name || device.id)}${device.id && device.name ? ` · ${esc(device.id)}` : ""}</option>`;
    }).join("");
    const options = (param.options || []).map(o => `<option value="${esc(o)}" ${String(o) === String(raw) ? "selected" : ""}>${esc(o)}</option>`).join("");
    const voiceOptions = [...systemVoices.map(voice => ({ id: voice, label: `${voice} · système` })), ...ttsVoices].map(voice => `<option value="${esc(voice.id)}" ${String(voice.id) === String(raw) ? "selected" : ""}>${esc(voice.label)}</option>`).join("");
    const control = isDeviceField && domotiqueDevices.length ? `<select data-param="${esc(param.key)}"><option value="">Choisir un appareil…</option>${deviceOptions}</select>` : isSystemVoiceField && (systemVoices.length || ttsVoices.length) ? `<select data-param="${esc(param.key)}"><option value="">Voix par défaut</option>${voiceOptions}</select>` : param.kind === "bool" ? `<select data-param="${esc(param.key)}"><option value="true" ${raw === true ? "selected" : ""}>Oui</option><option value="false" ${raw !== true ? "selected" : ""}>Non</option></select>` : param.kind === "select" ? `<select data-param="${esc(param.key)}">${options}</select>` : (["text", "multiline"].includes(param.kind) || !param.kind) ? `<textarea data-param="${esc(param.key)}" placeholder="${esc(isDeviceField ? "Aucun appareil enregistré : saisissez un nom ou un identifiant" : param.placeholder || "")}">${esc(raw)}</textarea>` : `<input type="${param.kind === "number" ? "number" : "text"}" data-param="${esc(param.key)}" value="${esc(raw)}" />`;
    const hint = isDeviceField ? (domotiqueDevices.length ? `${domotiqueDevices.length} appareil(s) disponible(s)` : "Aucun appareil enregistré dans Domotique") : isSystemVoiceField ? ((systemVoices.length + ttsVoices.length) ? `${systemVoices.length + ttsVoices.length} voix disponibles (système, Piper/Kokoro)` : "Aucune voix détectée : installez Piper/Kokoro ou saisissez un identifiant") : (param.description || param.placeholder || "");
    return `<div class="field"><label>${esc(param.label || param.key)}</label>${control}${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
  }).join("");
  form.querySelector("[data-label]").oninput = e => { node.label = e.target.value; render(); saveLayout(); };
  form.querySelectorAll("[data-param]").forEach(control => { control.addEventListener("focus", () => { lastParamKey = control.dataset.param; }); control.oninput = e => { const key = e.target.dataset.param, param = (spec.params || []).find(p => p.key === key), current = node.params[key] || defaultValue(param); let value = e.target.value; if (param.kind === "number") value = Number(value); if (param.kind === "bool") value = value === "true"; node.params[key] = { ...current, value }; saveLayout(); }; });
  form.querySelectorAll("[data-variable]").forEach(chip => chip.addEventListener("mousedown", event => { event.preventDefault(); const controls = [...form.querySelectorAll("[data-param]")].filter(control => !["SELECT"].includes(control.tagName)); const control = form.querySelector(`[data-param="${CSS.escape(lastParamKey || "")}"]`) || controls[0]; if (!control) return notify("Sélectionnez d’abord un champ texte."); const token = chip.dataset.variable; const start = control.selectionStart ?? control.value.length, end = control.selectionEnd ?? start; control.value = control.value.slice(0, start) + token + control.value.slice(end); control.focus(); control.setSelectionRange?.(start + token.length, start + token.length); control.dispatchEvent(new Event("input", { bubbles: true })); }));
}

function layoutKey(name = graph.name) { return LAYOUT_PREFIX + (name || "untitled"); }
function saveLayout() { try { localStorage.setItem(layoutKey(), JSON.stringify({ nodes: graph.nodes, edges: graph.edges, view, trigger: graph.trigger })); } catch {} }
function restoreLayout(name, workflow) {
  graph = freshGraph(name);
  const saved = (() => { try { return JSON.parse(localStorage.getItem(layoutKey(name))); } catch { return null; } })();
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  graph.trigger = workflow.trigger || saved?.trigger || { type: "manual" };
  const savedByRef = new Map((saved?.nodes || []).map(node => [node.fluxoId || node.action, node]));
  graph.nodes = steps.map((step, i) => {
    const old = savedByRef.get(step.id) || savedByRef.get(step.action);
    return { id: old?.id || id("step"), fluxoId: step.id, action: step.action, label: step.name || specById[step.action]?.name || step.action, params: step.params || {}, x: old?.x ?? (i * 300 + 50), y: old?.y ?? 180, variableIdVersion: old?.variableIdVersion };
  });
  const validIds = new Set(graph.nodes.map(node => node.id));
  const oldEdges = (saved?.edges || []).filter(edge => validIds.has(edge.from) && validIds.has(edge.to));
  graph.edges = oldEdges.length ? oldEdges : graph.nodes.slice(1).map((node, i) => ({ id: id("edge"), from: graph.nodes[i].id, to: node.id }));
  view = saved?.view || { x: 60, y: 75, scale: 1 };
  ensureFluxoIds();
  syncTriggerUi();
  loadedWorkflowSnapshot = JSON.stringify({ trigger: graph.trigger, steps: engineWorkflow().steps });
}

async function syncCurrentWorkflow() {
  if (!graph.name || runState.active || !invoke) return;
  try {
    const latest = await invoke("load_workflow", { name: graph.name });
    const current = engineWorkflow();
    if (loadedWorkflowSnapshot && JSON.stringify({ trigger: current.trigger, steps: current.steps }) !== loadedWorkflowSnapshot) return;
    if (JSON.stringify({ trigger: current.trigger, steps: current.steps }) !== JSON.stringify({ trigger: latest.trigger, steps: latest.steps })) {
      restoreLayout(graph.name, latest);
      selectedId = null;
      render();
      notify("Projet Fluxo actualisé.");
    }
  } catch { /* Le projet peut avoir été renommé ou supprimé dans Fluxo. */ }
}
// Même normalisation que le Rust : majuscules, sans séparateur, pour que
// « 04:a2:b3:c4 » et « 04A2B3C4 » désignent le même badge.
function rfidUid(raw) { return String(raw || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase(); }
function topologicalNodes() { const degrees = Object.fromEntries(graph.nodes.map(n => [n.id, 0])); graph.edges.forEach(e => degrees[e.to]++); const queue = graph.nodes.filter(n => !degrees[n.id]).sort((a,b) => a.x - b.x); const ordered = []; while (queue.length) { const node = queue.shift(); ordered.push(node); graph.edges.filter(e => e.from === node.id).forEach(e => { if (!--degrees[e.to]) { queue.push(graph.nodes.find(n => n.id === e.to)); queue.sort((a,b) => a.x - b.x); } }); } return ordered.length === graph.nodes.length ? ordered : graph.nodes; }
// Trois modes ici : manuel, CRON et badge RFID. Un workflow enregistré dans le
// designer Fluxo avec un autre déclencheur (webhook, fichier…) retombe sur
// « manuel » dans cet éditeur — il faut le rouvrir dans Fluxo pour le régler.
function syncTriggerUi() {
  const type = ["cron", "rfid"].includes(graph.trigger?.type) ? graph.trigger.type : "manual";
  $("#trigger-type").value = type;
  $("#trigger-cron").hidden = type !== "cron";
  $("#trigger-cron").value = type === "cron" ? (graph.trigger.expr || "") : "";
  $("#trigger-rfid").hidden = type !== "rfid";
  $("#trigger-rfid").value = type === "rfid" ? (graph.trigger.uid || "") : "";
}
function rewriteParentReferences(value, parentRef) { if (Array.isArray(value)) return value.map(item => rewriteParentReferences(item, parentRef)); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteParentReferences(item, parentRef)])); if (typeof value !== "string" || !parentRef) return value; return value.replace(/{{\s*(?:last|previous)(\.[^}]*)?\s*}}/g, (_match, path = "") => `{{${parentRef}${path.trim()}}}`); }
function engineWorkflow() { ensureFluxoIds(); const name = $("#workflow-name").value.trim() || "Automatisation sans titre"; graph.name = name; return { name, trigger: graph.trigger || { type: "manual" }, steps: topologicalNodes().map(node => { const incoming = graph.edges.filter(edge => edge.to === node.id); const parent = incoming.length === 1 ? graph.nodes.find(candidate => candidate.id === incoming[0].from) : null; return { id: node.fluxoId, action: node.action, params: rewriteParentReferences(node.params || {}, parent?.fluxoId), name: node.label || null }; }) }; }

async function saveWorkflow() { const workflow = engineWorkflow(); if (!workflow.steps.length) return notify("Ajoutez au moins un bloc."); try { await invoke("save_workflow", { workflow }); await invoke("reload_triggers"); loadedWorkflowSnapshot = JSON.stringify({ trigger: workflow.trigger, steps: workflow.steps }); saveLayout(); notify("Automatisation enregistrée dans Fluxo."); } catch (error) { notify(`Enregistrement impossible : ${error}`); } }
async function runWorkflow() {
  const workflow = engineWorkflow(); if (!workflow.steps.length) return notify("Ajoutez au moins un bloc.");
  const ordered = topologicalNodes(); runState = { active: true, statuses: {}, outputs: {}, durations: {}, logs: [], startedAt: Date.now(), elapsed: 0, timer: setInterval(tickRunClock, 100) };
  const usesInput = JSON.stringify(workflow.steps).includes("{{input}}");
  // Une chaîne basée sur {{last}} ne doit jamais être amorcée par le champ
  // d'entrée : celui-ci ne sert qu'à la variable initiale {{input}}.
  const runInput = usesInput ? ($("#run-input")?.value.trim() || null) : null;
  if (!runInput && usesInput) notify("Ce workflow utilise {{input}} sans entrée de test. Utilisez le champ d’entrée ou {{last}} pour la sortie précédente.");
  ordered.forEach(node => { runState.statuses[node.id] = "pending"; }); updateRunHud("Préparation du workflow…"); render();
  try {
    await saveWorkflow();
    const resultPromise = invoke("run_workflow", { workflow, input: runInput });
    let previousTurn = null;
    for (const node of ordered) { if (previousTurn) runState.statuses[previousTurn.id] = "pending"; runState.statuses[node.id] = "running"; addRunLog(node, "pending"); previousTurn = node; updateRunHud(`Exécution de ${node.label || node.action}…`); render(); await new Promise(resolve => setTimeout(resolve, 260)); }
    const result = await resultPromise;
    const engineIds = new Map(ordered.map((node, index) => [node.id, node.fluxoId || `automation_${index + 1}`]));
    (result?.steps || []).forEach((step, index) => { const node = ordered.find(n => engineIds.get(n.id) === step.step) || ordered[index]; if (node) { const status = step.error ? "error" : "success"; runState.statuses[node.id] = status; runState.outputs[node.id] = step.error || step.output; const log = runState.logs.find(item => item.nodeId === node.id); if (log) { log.status = status; log.output = step.error || step.output; log.duration = Date.now() - log.startedAt; runState.durations[node.id] = log.duration; } } });
    ordered.forEach(node => { if (!runState.statuses[node.id] || runState.statuses[node.id] === "running" || runState.statuses[node.id] === "pending") { const status = result?.success === false ? "skipped" : "success"; runState.statuses[node.id] = status; const log = runState.logs.find(item => item.nodeId === node.id); if (log) { log.status = status; log.output = status === "skipped" ? "Étape non exécutée : le workflow s’est arrêté sur l’erreur précédente." : log.output; log.duration = Date.now() - log.startedAt; if (status !== "skipped") runState.durations[node.id] = log.duration; } } });
    renderLogs();
    if (result?.success === false) $("#run-log-panel").hidden = false;
    updateRunHud(result?.success === false ? "Le workflow a échoué" : "Workflow terminé", true); notify(result?.success === false ? "Le workflow a échoué." : "Workflow exécuté."); render();
  } catch (error) { ordered.forEach((node, index) => { if (runState.statuses[node.id] === "running") { const status = index === 0 ? "error" : "skipped"; runState.statuses[node.id] = status; const log = runState.logs.find(item => item.nodeId === node.id); if (log) { log.status = status; log.output = status === "error" ? String(error) : "Étape non exécutée : le workflow s’est arrêté."; log.duration = Date.now() - log.startedAt; runState.durations[node.id] = log.duration; } } }); $("#run-log-panel").hidden = false; renderLogs(); updateRunHud("Erreur d'exécution", true); notify(`Exécution impossible : ${error}`); render(); }
  finally { runState.elapsed = Date.now() - runState.startedAt; clearInterval(runState.timer); runState.active = false; tickRunClock(); }
}
async function importWorkflow() { try { const metas = await invoke("list_workflows"); const names = metas.map(item => typeof item === "string" ? item : item.name).filter(Boolean); if (!names.length) return notify("Aucun workflow Fluxo à importer."); openDialog({ title: "Ouvrir un projet Fluxo", text: "Saisissez un nom ou choisissez une suggestion. Le projet restera compatible avec Fluxo.", options: names, input: true, onOk: async name => { const chosen = String(name || "").trim(); if (!chosen) return notify("Saisissez le nom d’un projet Fluxo."); const workflow = await invoke("load_workflow", { name: chosen }); $("#workflow-name").value = chosen; restoreLayout(chosen, workflow); selectedId = null; render(); } }); } catch (error) { notify(`Import impossible : ${error}`); } }
function newWorkflow() { graph = freshGraph(""); selectedId = null; view = { x: 80, y: 90, scale: 1 }; $("#workflow-name").value = ""; syncTriggerUi(); render(); }
function openDialog({ title, text, options = [], input = false, onOk }) { $("#dialog-title").textContent = title; $("#dialog-text").textContent = text || ""; const select = $("#dialog-select"), field = $("#dialog-input"), datalist = $("#dialog-options"); select.hidden = input || !options.length; field.hidden = !input; select.innerHTML = options.map(o => `<option>${esc(o)}</option>`).join(""); datalist.innerHTML = options.map(o => `<option value="${esc(o)}"></option>`).join(""); field.value = ""; $("#dialog").hidden = false; if (input) setTimeout(() => field.focus(), 0); $("#dialog-cancel").onclick = () => $("#dialog").hidden = true; $("#dialog-ok").onclick = async () => { $("#dialog").hidden = true; await onOk(input ? field.value : (options.length ? select.value : field.value)); }; }

function bind() {
  $("#action-search").oninput = renderPalette; $("#new-workflow").onclick = newWorkflow; $("#import-workflow").onclick = importWorkflow; $("#save-workflow").onclick = saveWorkflow; $("#run-workflow").onclick = runWorkflow;
  $("#toggle-logs").onclick = () => { $("#run-log-panel").hidden = false; renderLogs(); }; $("#close-logs").onclick = () => { $("#run-log-panel").hidden = true; };
  $("#data-modal-close").onclick = () => { $("#data-modal").hidden = true; }; $("#data-modal").onclick = event => { if (event.target.id === "data-modal") $("#data-modal").hidden = true; };
  $("#trigger-type").onchange = event => {
    const type = event.target.value;
    // UID vide = n'importe quel badge : c'est le cas d'usage le plus courant
    // (un seul workflow qui aiguille lui-même selon {{input}}).
    graph.trigger = type === "cron" ? { type: "cron", expr: $("#trigger-cron").value.trim() || "0 0 9 * * *" }
      : type === "rfid" ? { type: "rfid", uid: rfidUid($("#trigger-rfid").value) }
      : { type: "manual" };
    syncTriggerUi(); saveLayout();
  };
  $("#trigger-cron").oninput = event => { graph.trigger = { type: "cron", expr: event.target.value.trim() }; saveLayout(); };
  $("#trigger-rfid").oninput = event => { graph.trigger = { type: "rfid", uid: rfidUid(event.target.value) }; saveLayout(); };
  $("#add-agent-starter").onclick = () => { const queue = specById.agent_add_task ? "agent_add_task" : "run_agent"; addNode(queue, 80, 140); if (specById.run_agent && queue !== "run_agent") { addNode("run_agent", 400, 140); graph.edges.push({ id: id("edge"), from: graph.nodes[0].id, to: graph.nodes[1].id }); render(); } };
  $("#delete-node").onclick = () => { if (!selectedId) return; graph.nodes = graph.nodes.filter(n => n.id !== selectedId); graph.edges = graph.edges.filter(e => e.from !== selectedId && e.to !== selectedId); selectedId = null; saveLayout(); render(); };
  $("#zoom-in").onclick = () => { view.scale = Math.min(1.6, view.scale + .1); render(); }; $("#zoom-out").onclick = () => { view.scale = Math.max(.45, view.scale - .1); render(); }; $("#zoom-reset").onclick = () => { view = { x:80,y:90,scale:1 }; render(); };
  const stage = $("#stage"); stage.addEventListener("pointerdown", event => { const onNode = event.target.closest(".node"); const onControl = event.target.closest(".canvas-controls,.run-hud,.run-log-panel,.empty-state"); const blankCanvas = !onNode && !onControl; if (!(event.button === 1 || event.shiftKey || spacePressed || blankCanvas)) return; dragging = { pan: true, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }; stage.setPointerCapture?.(event.pointerId); stage.classList.add("panning"); });
  window.addEventListener("pointermove", event => { if (connecting) drawLiveEdge(event.clientX, event.clientY); if (!dragging) return; if (dragging.pan) { view.x = dragging.vx + event.clientX - dragging.x; view.y = dragging.vy + event.clientY - dragging.y; render(); return; } const p = screenToWorld(event.clientX, event.clientY); dragging.node.x = p.x - dragging.dx; dragging.node.y = p.y - dragging.dy; render(); });
  window.addEventListener("pointerup", () => { if (dragging && !dragging.pan) saveLayout(); dragging = null; stage.classList.remove("panning"); if (connecting) connecting = null; $("#links").querySelector(".edge-live")?.remove(); if (!dragging) render(); });
  window.addEventListener("pointercancel", () => { dragging = null; connecting = null; stage.classList.remove("panning"); $("#links").querySelector(".edge-live")?.remove(); render(); });
  stage.addEventListener("wheel", event => { event.preventDefault(); if (event.ctrlKey || event.metaKey) { view.scale = Math.max(.45, Math.min(1.6, view.scale + (event.deltaY > 0 ? -.08 : .08))); } else { view.x -= event.deltaX; view.y -= event.deltaY; } render(); }, { passive: false });
  window.addEventListener("keydown", event => { if (event.code === "Space" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { spacePressed = true; stage.classList.add("panning"); event.preventDefault(); } if ((event.key === "Backspace" || event.key === "Delete") && selectedId && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) $("#delete-node").click(); });
  window.addEventListener("keyup", event => { if (event.code === "Space") { spacePressed = false; if (!dragging) stage.classList.remove("panning"); } });
}
init();
mountAutomationsAI();
translatePage(document); observeTranslations(document.body);
window.addEventListener("focus", syncCurrentWorkflow);
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncCurrentWorkflow(); });

// Les liens sortants (fiches, docs des connecteurs, markdown) ouvrent le
// navigateur du système : `target="_blank"` est inerte dans la WebView.
delegateExternalLinks(document);
