import { appleFmBackendState, ollamaGetJson } from "../../llm.js";
import { inferenceOptions } from "./ai-nodes.js";
import { icon } from "../../lib/icons.js";
import { desktopAI } from "./ai-desktop.js";
import { openEmbed } from "../embed.js";
// Éditeur de graphe du Canevas (mode « Nœuds ») — l'ergonomie de ComfyUI :
//   • nœuds à ports typés et colorés, widgets dans le corps, aperçu du résultat ;
//   • liens tirés d'une sortie vers une entrée compatible ; lâché dans le vide,
//     le lien ouvre la recherche de nœuds filtrée et branche le nouveau nœud ;
//   • double-clic = recherche, clic droit = menus (ajouter, contourner, sourdine,
//     couleur, exécuter jusqu'ici…), groupes colorés, sélection multiple,
//     copier/coller, annuler/rétablir, mini-carte, glisser une image = nœud ;
//   • file d'exécution (×N), cache des nœuds inchangés, progression par nœud,
//     historique des images produites ; modèles de workflows prêts à l'emploi.
//
// Le graphe vit dans `project.graph` (canevas/<slug>/project.json) ; les images
// produites sont écrites dans le dossier du projet (outputs/, cache/).

import { CATEGORIES, NODE_DEFS, TYPES, compatible, nodeDef, loadImg, nodeIcon, nodeColor } from "./nodes.js";
import { runGraph, advanceControls, upstream } from "./engine.js";
import { TEMPLATES } from "./templates.js";
import { normalizeMusicSpec, playMusic, stopMusic } from "../../canvas/music.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = (p = "n") => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const NODE_W = 300;
const COLORS = { "": "Par défaut", "#3b82f6": "Bleu", "#10b981": "Vert", "#f59e0b": "Ambre", "#ef4444": "Rouge", "#8b5cf6": "Violet", "#ec4899": "Rose", "#64748b": "Ardoise" };
const SEED_CTL = { fixed: "fixe", increment: "+1", decrement: "−1", randomize: "aléatoire" };

export function blankGraph() {
  return { v: 1, nodes: [], links: [], groups: [], view: { x: 80, y: 60, scale: 1 } };
}

export function createGraphEditor(root, { store, invoke, toast, ask, onChange }) {
  root.innerHTML = `
    <div class="g-toolbar">
      <button class="g-btn primary" data-g="run" title="Exécuter la file (⌘⏎)">▶ Exécuter</button>
      <select class="g-sel" data-g="batch" title="Nombre d'exécutions">${[1, 2, 3, 4, 6, 8].map((n) => `<option value="${n}">×${n}</option>`).join("")}</select>
      <button class="g-btn" data-g="stop" title="Interrompre" disabled>■</button>
      <span class="g-sep"></span>
      <button class="g-btn" data-g="add" title="Ajouter un nœud (double-clic)">＋ Nœud</button>
      <button class="g-btn" data-g="group" title="Grouper la sélection (⌘G)">▭ Groupe</button>
      <div class="g-menu-wrap"><button class="g-btn" data-g="templates">Modèles ▾</button><div class="g-menu" data-g-menu="templates" hidden></div></div>
      <span class="g-sep"></span>
      <button class="g-btn" data-g="undo" title="Annuler (⌘Z)">↶</button>
      <button class="g-btn" data-g="redo" title="Rétablir (⇧⌘Z)">↷</button>
      <button class="g-btn" data-g="fit" title="Tout afficher (.)">⤢</button>
      <span class="g-grow"></span>
      <span class="g-status" data-g="status"></span>
      <button class="g-btn" data-g="embed" title="Exporter un assistant sécurisé">${icon("code")} Embed</button>
      <button class="g-btn" data-g="export" title="Exporter le workflow (JSON)">⭳ JSON</button>
      <button class="g-btn" data-g="import" title="Importer un workflow (JSON)">⭱ JSON</button>
      <button class="g-btn" data-g="queue" title="File et historique">File <b data-g="qcount">0</b></button>
    </div>
    <div class="g-stage" tabindex="0">
      <div class="g-world">
        <div class="g-groups"></div>
        <svg class="g-links"></svg>
        <div class="g-nodes"></div>
      </div>
      <div class="g-box" hidden></div>
      <canvas class="g-minimap" width="180" height="120"></canvas>
      <div class="g-empty" hidden><b>Graphe vide</b><span>Double-cliquez pour ajouter un nœud, ou partez d'un modèle.</span><button class="g-btn primary" data-g="starter">Charger le modèle « Image simple »</button></div>
    </div>
    <aside class="g-queue" hidden>
      <div class="g-q-head"><b>File d'exécution</b><span class="g-grow"></span><button class="g-btn sm" data-g="qclear">Vider</button><button class="g-btn sm" data-g="qclose">✕</button></div>
      <div class="g-q-list"></div>
      <div class="g-q-head"><b>Images produites</b></div>
      <div class="g-gallery"></div>
    </aside>
    <div class="g-search" hidden><input placeholder="Rechercher un nœud…" /><div class="g-search-list"></div></div>
    <div class="g-ctx" hidden></div>
    <div class="g-light" hidden><img alt="" /><div class="g-light-bar"><button class="g-btn" data-g="lsave">Enregistrer dans le projet</button><button class="g-btn" data-g="lclose">Fermer</button></div></div>
    <input type="file" class="g-file" accept="image/*" hidden />
    <input type="file" class="g-json" accept=".json,application/json" hidden />`;

  root.insertAdjacentHTML('beforeend', '<datalist id="g-model-list"></datalist><datalist id="g-workflow-list"></datalist>');
  let appleState = { available: false, models: [] };
  root.insertAdjacentHTML('beforeend', '<datalist id="g-model-ollama"></datalist><datalist id="g-model-applefm"></datalist>');
  if (invoke) {
    Promise.allSettled([invoke('llm_api_models'), invoke('list_fluxo_workflows'), invoke('llama_list_models'), ollamaGetJson('api/tags', undefined, { source: 'ollama' }), appleFmBackendState()]).then(([models, workflows, local, ollama, apple]) => {
      appleState = apple.status === 'fulfilled' ? apple.value : appleState;
      const ollamaModels = ollama.status === 'fulfilled' && Array.isArray(ollama.value?.models) ? ollama.value.models.map(m => m.name) : [];
      const appleModels = (appleState.models || []).filter(m => m.available).map(m => m.id);
      root.querySelector('#g-model-ollama').innerHTML = ollamaModels.map(m => `<option value="${esc(m)}"></option>`).join('');
      root.querySelector('#g-model-applefm').innerHTML = appleModels.map(m => `<option value="${esc(m)}"></option>`).join('');
      const active = localStorage.getItem('selectedModel');
      root.querySelector('#g-model-list').innerHTML = [...new Set([active, ...ollamaModels, ...appleModels, ...(local.status === 'fulfilled' && Array.isArray(local.value) ? local.value.map(m => m.filename) : []), ...(models.status === 'fulfilled' && Array.isArray(models.value) ? models.value : [])].filter(Boolean))].map(m => `<option value="${esc(m)}"></option>`).join('');
      root.querySelector('#g-workflow-list').innerHTML = (workflows.status === 'fulfilled' && Array.isArray(workflows.value) ? workflows.value : []).map(m => `<option value="${esc(m)}"></option>`).join('');
      if (G) render();
    });
  }
  const $ = (s) => root.querySelector(s);
  const stage = $(".g-stage"), world = $(".g-world"), nodesEl = $(".g-nodes"), linksEl = $(".g-links"), groupsEl = $(".g-groups");
  let project = null;
  let G = null;                      // project.graph
  const cache = new Map();           // id → { key, outputs }
  const status = new Map();          // id → { state, error, ms, preview, outputs }
  const sel = new Set();
  let clipboard = null;
  const undoStack = [], redoStack = [];
  const gallery = [];
  let queue = [], running = null, abort = null, jobSeq = 0;

  const V = () => G.view;
  const node = (id) => G.nodes.find((n) => n.id === id);
  const save = () => { onChange?.(); drawMinimap(); };
  function snapshot() { undoStack.push(JSON.stringify({ nodes: G.nodes, links: G.links, groups: G.groups })); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
  function restore(json) { const s = JSON.parse(json); G.nodes = s.nodes; G.links = s.links; G.groups = s.groups; sel.clear(); render(); save(); }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify({ nodes: G.nodes, links: G.links, groups: G.groups })); restore(undoStack.pop()); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify({ nodes: G.nodes, links: G.links, groups: G.groups })); restore(redoStack.pop()); }

  // ===== Création ===============================================================
  function makeNode(type, x, y, widgets = {}) {
    const d = nodeDef(type);
    const w = {};
    for (const wd of d.widgets) { w[wd.name] = wd.default ?? ""; if (wd.kind === "seed") w[`${wd.name}__ctl`] = "randomize"; if (wd.control) w[`${wd.name}__ctl`] = "fixed"; }
    return { id: uid(), type, x: Math.round(x), y: Math.round(y), mode: "", color: "", collapsed: false, title: "", widgets: { ...w, ...widgets } };
  }
  function addNode(type, x, y, widgets) {
    snapshot();
    const n = makeNode(type, x, y, widgets);
    G.nodes.push(n);
    sel.clear(); sel.add(n.id);
    render(); save();
    return n;
  }
  function connect(from, out, to, inp) {
    const a = node(from), b = node(to);
    if (!a || !b || from === to) return false;
    const ot = nodeDef(a.type).outputs[out]?.type, it = nodeDef(b.type).inputs[inp]?.type;
    if (!ot || !it || !compatible(ot, it)) { toast?.(`Types incompatibles : ${TYPES[ot]?.label || ot} → ${TYPES[it]?.label || it}`); return false; }
    if (upstream(G, from).has(to)) { toast?.("Ce lien créerait une boucle."); return false; }
    G.links = G.links.filter((l) => !(l.to === to && l.in === inp));
    G.links.push({ id: uid("l"), from, out, to, in: inp });
    return true;
  }
  function removeNodes(ids) {
    if (!ids.size) return;
    snapshot();
    G.nodes = G.nodes.filter((n) => !ids.has(n.id));
    G.links = G.links.filter((l) => !ids.has(l.from) && !ids.has(l.to));
    ids.forEach((id) => { cache.delete(id); status.delete(id); });
    sel.clear();
    render(); save();
  }

  // ===== Rendu ====================================================================
  function applyView() {
    const v = V();
    world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
    stage.style.backgroundPosition = `${v.x}px ${v.y}px`;
    stage.style.backgroundSize = `${24 * v.scale}px ${24 * v.scale}px`;
    drawMinimap();
  }
  const linkedInputs = (id) => new Set(G.links.filter((l) => l.to === id).map((l) => l.in));

  function widgetHtml(n, wd, d, linked) {
    // Widget jumeau d'une entrée reliée : masqué (le lien l'emporte).
    const twin = d.inputs.findIndex((i) => i.widget === wd.name);
    if (!n.widgets?.asTool && twin >= 0 && linked.has(twin)) return `<div class="gw gw-linked"><span>${esc(wd.label || wd.name)}</span><em>⇠ ${esc(d.inputs[twin].name)}</em></div>`;
    const modelPort = d.inputs.findIndex(p => p.type === 'MODEL');
    if (modelPort >= 0 && linked.has(modelPort) && ['backend','model','maxTokens'].includes(wd.name)) return wd.name === 'backend' ? '<div class="gw gw-linked"><span>Configuration IA</span><em>⇠ modèle relié</em></div>' : '';
    const v = n.widgets?.[wd.name] ?? wd.default ?? "";
    const lab = wd.label ? `<span>${esc(wd.label)}</span>` : "";
    switch (wd.kind) {
      case "model": return `<label class="gw">${lab}<input data-w="${wd.name}" value="${esc(v)}" list="${['ollama','applefm'].includes(n.widgets?.backend) ? `g-model-${n.widgets.backend}` : 'g-model-list'}" placeholder="Modèle actif" /></label>`;
      case "workflow": return `<label class="gw">${lab}<input data-w="${wd.name}" value="${esc(v)}" list="g-workflow-list" placeholder="Nom du workflow Fluxo" /></label>`;
      case "textarea": return `<label class="gw">${lab}<textarea data-w="${wd.name}" rows="3" spellcheck="false">${esc(v)}</textarea></label>`;
      case "number": return `<label class="gw gw-row">${lab}<input type="number" data-w="${wd.name}" value="${esc(v)}" step="${wd.step ?? 1}"${wd.min != null ? ` min="${wd.min}"` : ""}/>${wd.control ? ctlSelect(n, wd) : ""}</label>`;
      case "slider": return `<label class="gw">${lab.replace("</span>", ` <em data-sv="${wd.name}">${esc(v)}</em></span>`)}<input type="range" data-w="${wd.name}" value="${esc(v)}" min="${wd.min}" max="${wd.max}" step="${wd.step}"/></label>`;
      case "select": if (wd.name === 'backend' && wd.options.some(([id]) => id === 'applefm')) return `<label class="gw gw-row">${lab}<select data-w="${wd.name}">${inferenceOptions(appleState.available, v).map(o => `<option value="${o.id}"${o.id === v ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
        return `<label class="gw gw-row">${lab}<select data-w="${wd.name}">${wd.options.map(([val, l]) => `<option value="${esc(val)}"${String(val) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
      case "toggle": return `<label class="gw gw-chk"><input type="checkbox" data-w="${wd.name}"${v ? " checked" : ""}/>${esc(wd.label)}</label>`;
      case "color": return `<label class="gw gw-row">${lab}<input type="color" data-w="${wd.name}" value="${esc(v || "#000000")}"/></label>`;
      case "seed": return `<label class="gw gw-row">${lab}<input type="number" data-w="${wd.name}" value="${esc(v)}" step="1" min="0"/>${ctlSelect(n, wd)}</label>`;
      case "file": return `<div class="gw gw-file">${lab}<button class="g-btn sm" data-pick="${wd.name}">${v ? esc(String(v).split("/").pop()) : "Choisir une image…"}</button></div>`;
      default: return `<label class="gw">${lab}<input type="text" data-w="${wd.name}" value="${esc(v)}"/></label>`;
    }
  }
  const ctlSelect = (n, wd) => `<select class="gw-ctl" data-w="${wd.name}__ctl" title="Après chaque exécution">${Object.entries(SEED_CTL).map(([k, l]) => `<option value="${k}"${(n.widgets?.[`${wd.name}__ctl`] || (wd.kind === "seed" ? "randomize" : "fixed")) === k ? " selected" : ""}>${l}</option>`).join("")}</select>`;

  function previewHtml(n, st) {
    const d = nodeDef(n.type);
    const vals = st?.preview !== undefined ? [st.preview] : (st?.outputs || []);
    const parts = [];
    for (const v of vals) {
      if (v == null) continue;
      if (typeof v === "object" && v.url && !v.kind) parts.push(`<img class="gn-img" src="${v.url}" alt="" data-full="${n.id}"/>${v.w ? `<small class="gn-dim">${v.w}×${v.h}${v.backend ? ` · ${v.backend}` : ""}</small>` : ""}`);
      else if (typeof v === "object" && v.kind === "wav") parts.push(`<audio controls src="${v.url}"></audio>`);
      else if (typeof v === "object" && v.kind === "spec") parts.push(`<button class="g-btn sm" data-play="${n.id}">▶ Écouter (${esc(v.spec.tempo)} BPM, ${esc(v.spec.key)})</button>`);
      else if (typeof v === "object" && v.palette) parts.push(`<div class="gn-charte"><div class="gn-pal">${v.palette.map((c) => `<i style="background:${esc(c.hex)}" title="${esc(c.name)} ${esc(c.hex)}"></i>`).join("")}</div><small>${esc(v.fonts?.heading || "")} / ${esc(v.fonts?.body || "")}</small></div>`);
      else if (typeof v === "object") parts.push(`<pre class="gn-text">${esc(JSON.stringify(v, null, 2).slice(0, 1500))}</pre>`);
      else if (typeof v === "number") parts.push(`<div class="gn-num">${v.toLocaleString("fr-FR")}</div>`);
      else if (typeof v === "string" && v && d.type !== "text") parts.push(`<div class="gn-text">${esc(v.length > 900 ? `${v.slice(0, 900)}…` : v)}</div>`);
      if (d.output || parts.length >= 2) break;
    }
    return parts.join("");
  }

  function nodeHtml(n) {
    const d = nodeDef(n.type);
    if (!d) return `<div class="gn gn-error-type" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px"><div class="gn-head"><span class="gn-title">Type inconnu : ${esc(n.type)}</span></div></div>`;
    const st = status.get(n.id);
    const linked = linkedInputs(n.id);
    const cls = ["gn", sel.has(n.id) ? "is-sel" : "", n.mode ? `is-${n.mode}` : "", st ? `st-${st.state}` : "", n.collapsed ? "is-collapsed" : "", d.compact ? "is-compact" : "", n.type === "note" ? "is-note" : ""].filter(Boolean).join(" ");
    const ins = d.inputs.map((p, k) => `<div class="gp in" data-k="${k}" data-type="${p.type}" title="${esc(TYPES[p.type]?.label)}"><i class="dot" style="--pc:${TYPES[p.type].color}"></i><span>${esc(p.name)}${p.optional ? "" : ""}</span></div>`).join("");
    const outs = d.outputs.map((p, k) => `<div class="gp out" data-k="${k}" data-type="${p.type}" title="${esc(TYPES[p.type]?.label)}"><span>${esc(p.name)}</span><i class="dot" style="--pc:${TYPES[p.type].color}"></i></div>`).join("");
    const badge = st?.state === "cached" ? `<span class="gn-badge">cache</span>` : st?.state === "done" && st.ms != null ? `<span class="gn-badge">${st.ms < 1000 ? `${st.ms} ms` : `${(st.ms / 1000).toFixed(1)} s`}</span>` : n.mode === "bypass" ? `<span class="gn-badge">contourné</span>` : n.mode === "mute" ? `<span class="gn-badge">sourdine</span>` : "";
    return `<div class="${cls}" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px;width:${n.w || (d.compact ? 90 : NODE_W)}px;--nc:${n.color || nodeColor(d)};">
      <div class="gn-head"><button class="gn-col" data-collapse title="Réduire">${n.collapsed ? "▸" : "▾"}</button><span class="gn-icon">${icon(nodeIcon(d))}</span><span class="gn-title">${esc(n.title || d.title)}</span>${badge}${d.heavy ? `<button class="gn-run" data-runto title="Exécuter jusqu'ici">▶</button>` : ""}</div>
      ${n.collapsed ? "" : `<div class="gn-ports"><div class="gn-ins">${ins}</div><div class="gn-outs">${outs}</div></div>
      ${d.widgets.length ? `<div class="gn-widgets">${d.widgets.map((wd) => widgetHtml(n, wd, d, linked)).join("")}</div>` : ""}
      <div class="gn-preview">${previewHtml(n, st)}</div>
      ${st?.state === "error" ? `<div class="gn-err">${esc(st.error)}</div>` : ""}`}
      ${st?.state === "running" ? `<div class="gn-progress"><i></i></div>` : ""}
      <i class="gn-resize"></i>
    </div>`;
  }

  function render() {
    if (!G) return;
    groupsEl.innerHTML = (G.groups || []).map((g) => `<div class="gg" data-gid="${g.id}" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px;--gc:${g.color || "#64748b"}"><div class="gg-head">${esc(g.title)}</div><i class="gg-resize"></i></div>`).join("");
    nodesEl.innerHTML = G.nodes.map(nodeHtml).join("");
    $(".g-empty").hidden = G.nodes.length > 0;
    applyView();
    requestAnimationFrame(() => drawLinks());
  }
  function rerenderNode(id) {
    const n = node(id);
    const old = nodesEl.querySelector(`.gn[data-id="${id}"]`);
    if (!n || !old) return render();
    const tmp = document.createElement("div");
    tmp.innerHTML = nodeHtml(n);
    old.replaceWith(tmp.firstElementChild);
    requestAnimationFrame(() => drawLinks());
  }

  function portPos(id, dir, k) {
    const el = nodesEl.querySelector(`.gn[data-id="${id}"] .gp.${dir}[data-k="${k}"] .dot`) || nodesEl.querySelector(`.gn[data-id="${id}"] .gn-head`);
    if (!el) return null;
    const r = el.getBoundingClientRect(), w = world.getBoundingClientRect(), s = V().scale;
    const collapsed = !el.classList.contains("dot");
    return { x: (r.left - w.left) / s + (collapsed ? (dir === "out" ? r.width / s : 0) : r.width / (2 * s)), y: (r.top - w.top) / s + r.height / (2 * s) };
  }
  /** Port compatible le plus proche du pointeur (rayon ~20 px) : un lien
   *  lâché « à côté » d'un port s'y accroche quand même. */
  function portNear(cx, cy, dir, type) {
    const direct = document.elementFromPoint(cx, cy)?.closest?.(".gp");
    if (direct && direct.classList.contains(dir)) return direct;
    let best = null, bd = 22;
    nodesEl.querySelectorAll(`.gp.${dir}`).forEach((el) => {
      const ok = dir === "in" ? compatible(type, el.dataset.type) : compatible(el.dataset.type, type);
      if (!ok) return;
      const r = el.querySelector(".dot").getBoundingClientRect();
      const d = Math.hypot(cx - (r.left + r.width / 2), cy - (r.top + r.height / 2));
      if (d < bd) { bd = d; best = el; }
    });
    return best;
  }
  const curve = (a, b) => { const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };
  function drawLinks(temp = null) {
    if (!G) return;
    let svg = "";
    for (const l of G.links) {
      const a = portPos(l.from, "out", l.out), b = portPos(l.to, "in", l.in);
      if (!a || !b) continue;
      const t = nodeDef(node(l.from)?.type)?.outputs[l.out]?.type || "ANY";
      const running = status.get(l.to)?.state === "running";
      svg += `<path class="gl${running ? " flow" : ""}" d="${curve(a, b)}" style="--lc:${TYPES[t].color}"/><path class="gl-hit" data-link="${l.id}" d="${curve(a, b)}"/>`;
    }
    if (temp) svg += `<path class="gl temp" d="${temp.d}" style="--lc:${temp.color}"/>`;
    linksEl.innerHTML = svg;
  }

  // ===== Mini-carte ======================================================================
  function drawMinimap() {
    const c = $(".g-minimap");
    if (!c || !G) return;
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    if (!G.nodes.length) { c.hidden = true; return; }
    c.hidden = false;
    const xs = G.nodes.map((n) => n.x), ys = G.nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 100, minY = Math.min(...ys) - 100, maxX = Math.max(...xs) + 400, maxY = Math.max(...ys) + 400;
    const s = Math.min(c.width / (maxX - minX), c.height / (maxY - minY));
    c._map = { minX, minY, s };
    for (const n of G.nodes) { g.fillStyle = n.color || "rgba(120,120,140,.75)"; g.fillRect((n.x - minX) * s, (n.y - minY) * s, Math.max(3, NODE_W * s), Math.max(2, 140 * s)); }
    const v = V(), r = stage.getBoundingClientRect();
    g.strokeStyle = "rgba(94,92,230,.9)"; g.lineWidth = 1.5;
    g.strokeRect((-v.x / v.scale - minX) * s, (-v.y / v.scale - minY) * s, (r.width / v.scale) * s, (r.height / v.scale) * s);
  }
  $(".g-minimap").addEventListener("pointerdown", (e) => {
    const c = e.currentTarget, m = c._map;
    if (!m) return;
    const r = c.getBoundingClientRect(), st = stage.getBoundingClientRect(), v = V();
    const wx = (e.clientX - r.left) / m.s + m.minX, wy = (e.clientY - r.top) / m.s + m.minY;
    v.x = st.width / 2 - wx * v.scale; v.y = st.height / 2 - wy * v.scale;
    applyView(); requestAnimationFrame(() => drawLinks()); save();
  });

  // ===== Vue : pan, zoom, ajustement =====================================================
  const toWorld = (cx, cy) => { const r = stage.getBoundingClientRect(), v = V(); return { x: (cx - r.left - v.x) / v.scale, y: (cy - r.top - v.y) / v.scale }; };
  function fit() {
    if (!G.nodes.length) return;
    const r = stage.getBoundingClientRect();
    const minX = Math.min(...G.nodes.map((n) => n.x)) - 40, minY = Math.min(...G.nodes.map((n) => n.y)) - 40;
    const maxX = Math.max(...G.nodes.map((n) => n.x + (n.w || NODE_W))) + 40, maxY = Math.max(...G.nodes.map((n) => n.y + 320)) + 40;
    const s = clamp(Math.min(r.width / (maxX - minX), r.height / (maxY - minY)), 0.2, 1.4);
    Object.assign(V(), { scale: s, x: (r.width - (maxX - minX) * s) / 2 - minX * s, y: (r.height - (maxY - minY) * s) / 2 - minY * s });
    applyView(); requestAnimationFrame(() => drawLinks()); save();
  }
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const v = V();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2 && !e.shiftKey) {
      const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const ns = clamp(v.scale * Math.exp(-e.deltaY * 0.0015), 0.15, 2.5);
      v.x = mx - ((mx - v.x) * ns) / v.scale; v.y = my - ((my - v.y) * ns) / v.scale; v.scale = ns;
    } else { v.x -= e.deltaX; v.y -= e.deltaY; }
    applyView(); requestAnimationFrame(() => drawLinks());
    clearTimeout(stage._wt); stage._wt = setTimeout(save, 300);
  }, { passive: false });

  // ===== Pointeur : glisser nœuds/groupes/liens, sélection =====================================
  let drag = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    hidePopups();
    const t = e.target;
    if (t.closest("input, textarea, select, button, audio, .g-minimap")) return;
    stage.focus({ preventScroll: true });
    const port = t.closest(".gp");
    const nEl = t.closest(".gn");
    const gEl = t.closest(".gg");
    const p = toWorld(e.clientX, e.clientY);
    if (port && nEl) {
      const id = nEl.dataset.id, k = Number(port.dataset.k);
      if (port.classList.contains("in")) {
        const l = G.links.find((x) => x.to === id && x.in === k);
        if (l) { snapshot(); G.links = G.links.filter((x) => x !== l); drag = { kind: "link", from: l.from, out: l.out, type: nodeDef(node(l.from).type).outputs[l.out].type }; }
        else drag = { kind: "link-rev", to: id, in: k, type: port.dataset.type };
      } else drag = { kind: "link", from: id, out: k, type: port.dataset.type };
      if (drag.kind === "link" && !drag.snap) snapshot();
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (nEl) {
      const id = nEl.dataset.id;
      if (t.classList.contains("gn-resize")) { snapshot(); drag = { kind: "resize", id, x0: e.clientX, w0: node(id).w || NODE_W }; stage.setPointerCapture(e.pointerId); return; }
      if (e.shiftKey || e.metaKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
      else if (!sel.has(id)) { sel.clear(); sel.add(id); }
      nodesEl.querySelectorAll(".gn").forEach((el) => el.classList.toggle("is-sel", sel.has(el.dataset.id)));
      if (t.closest(".gn-head") || t.closest(".gn-preview") || nEl.classList.contains("is-compact") || nEl.classList.contains("is-collapsed")) {
        drag = { kind: "nodes", p0: p, start: [...sel].map((sid) => ({ n: node(sid), x: node(sid).x, y: node(sid).y })), moved: false };
        stage.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (gEl) {
      const g = G.groups.find((x) => x.id === gEl.dataset.gid);
      if (t.classList.contains("gg-resize")) { snapshot(); drag = { kind: "gresize", g, p0: p, w0: g.w, h0: g.h }; }
      else if (t.closest(".gg-head")) {
        const inside = G.nodes.filter((n) => n.x >= g.x && n.y >= g.y && n.x < g.x + g.w && n.y < g.y + g.h);
        drag = { kind: "group", g, p0: p, gx: g.x, gy: g.y, start: inside.map((n) => ({ n, x: n.x, y: n.y })), moved: false };
      } else { drag = null; }
      if (drag) { stage.setPointerCapture(e.pointerId); return; }
    }
    if (e.shiftKey || e.metaKey) { drag = { kind: "box", p0: p, c0: { x: e.clientX, y: e.clientY } }; stage.setPointerCapture(e.pointerId); return; }
    sel.clear();
    nodesEl.querySelectorAll(".gn.is-sel").forEach((el) => el.classList.remove("is-sel"));
    drag = { kind: "pan", c0: { x: e.clientX, y: e.clientY }, v0: { ...V() } };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toWorld(e.clientX, e.clientY);
    if (drag.kind === "pan") { V().x = drag.v0.x + e.clientX - drag.c0.x; V().y = drag.v0.y + e.clientY - drag.c0.y; applyView(); return; }
    if (drag.kind === "nodes" || drag.kind === "group") {
      const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (!drag.moved && Math.hypot(dx, dy) > 2) { drag.moved = true; snapshot(); }
      if (!drag.moved) return;
      for (const s of drag.start) { s.n.x = Math.round(s.x + dx); s.n.y = Math.round(s.y + dy); const el = nodesEl.querySelector(`.gn[data-id="${s.n.id}"]`); if (el) { el.style.left = `${s.n.x}px`; el.style.top = `${s.n.y}px`; } }
      if (drag.kind === "group") { drag.g.x = Math.round(drag.gx + dx); drag.g.y = Math.round(drag.gy + dy); const el = groupsEl.querySelector(`[data-gid="${drag.g.id}"]`); if (el) { el.style.left = `${drag.g.x}px`; el.style.top = `${drag.g.y}px`; } }
      drawLinks(); return;
    }
    if (drag.kind === "resize") { const n = node(drag.id); n.w = clamp(drag.w0 + (e.clientX - drag.x0) / V().scale, 160, 700); nodesEl.querySelector(`.gn[data-id="${n.id}"]`).style.width = `${n.w}px`; drawLinks(); return; }
    if (drag.kind === "gresize") { drag.g.w = Math.max(160, drag.w0 + p.x - drag.p0.x); drag.g.h = Math.max(100, drag.h0 + p.y - drag.p0.y); const el = groupsEl.querySelector(`[data-gid="${drag.g.id}"]`); el.style.width = `${drag.g.w}px`; el.style.height = `${drag.g.h}px`; return; }
    if (drag.kind === "box") {
      const b = $(".g-box"), r = stage.getBoundingClientRect();
      b.hidden = false;
      const x = Math.min(e.clientX, drag.c0.x) - r.left, y = Math.min(e.clientY, drag.c0.y) - r.top;
      Object.assign(b.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - drag.c0.x)}px`, height: `${Math.abs(e.clientY - drag.c0.y)}px` });
      drag.p1 = p; return;
    }
    if (drag.kind === "link" || drag.kind === "link-rev") {
      const a = drag.kind === "link" ? portPos(drag.from, "out", drag.out) : p;
      const b = drag.kind === "link" ? p : portPos(drag.to, "in", drag.in);
      drawLinks({ d: curve(a, b), color: TYPES[drag.type]?.color || "#999" });
      nodesEl.querySelectorAll(".gp").forEach((el) => el.classList.remove("drop-ok"));
      const over = portNear(e.clientX, e.clientY, drag.kind === "link" ? "in" : "out", drag.type);
      if (over && compatible(drag.kind === "link" ? drag.type : over.dataset.type, drag.kind === "link" ? over.dataset.type : drag.type)) over.classList.add("drop-ok");
    }
  });
  stage.addEventListener("pointerup", (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "pan") { save(); return; }
    if (d.kind === "nodes" || d.kind === "group" || d.kind === "resize" || d.kind === "gresize") { if (d.moved !== false) save(); return; }
    if (d.kind === "box") {
      $(".g-box").hidden = true;
      if (d.p1) {
        const x0 = Math.min(d.p0.x, d.p1.x), x1 = Math.max(d.p0.x, d.p1.x), y0 = Math.min(d.p0.y, d.p1.y), y1 = Math.max(d.p0.y, d.p1.y);
        for (const n of G.nodes) if (n.x + 40 > x0 && n.x < x1 && n.y + 20 > y0 && n.y < y1) sel.add(n.id);
        nodesEl.querySelectorAll(".gn").forEach((el) => el.classList.toggle("is-sel", sel.has(el.dataset.id)));
      }
      return;
    }
    if (d.kind === "link" || d.kind === "link-rev") {
      nodesEl.querySelectorAll(".gp").forEach((el) => el.classList.remove("drop-ok"));
      const over = portNear(e.clientX, e.clientY, d.kind === "link" ? "in" : "out", d.type);
      const nEl = over?.closest(".gn");
      if (over && nEl) {
        const k = Number(over.dataset.k);
        if (d.kind === "link" && over.classList.contains("in")) connect(d.from, d.out, nEl.dataset.id, k);
        else if (d.kind === "link-rev" && over.classList.contains("out")) { snapshot(); connect(nEl.dataset.id, k, d.to, d.in); }
        render(); save();
        return;
      }
      // Lâché dans le vide : recherche filtrée, puis branchement automatique.
      const p = toWorld(e.clientX, e.clientY);
      openSearch(e.clientX, e.clientY, p, d.kind === "link" ? { wantIn: d.type, from: d.from, out: d.out } : { wantOut: d.type, to: d.to, in: d.in });
      render(); save();
    }
  });

  // ===== Widgets ===========================================================================
  nodesEl.addEventListener("input", (e) => {
    const t = e.target, w = t.dataset.w;
    if (!w) return;
    const id = t.closest(".gn").dataset.id, n = node(id);
    n.widgets[w] = t.type === "checkbox" ? t.checked : t.type === "number" || t.type === "range" ? Number(t.value) : t.value;
    const sv = t.closest(".gn").querySelector(`[data-sv="${w}"]`);
    if (sv) sv.textContent = t.value;
    clearTimeout(nodesEl._t); nodesEl._t = setTimeout(save, 400);
  });
  nodesEl.addEventListener("change", (e) => {
    if (!e.target.dataset.w) return;
    if (e.target.dataset.w === 'backend') {
      const n = node(e.target.closest('.gn').dataset.id);
      n.widgets.model = '';
      rerenderNode(n.id);
    }
    save();
  });
  nodesEl.addEventListener("click", async (e) => {
    const nEl = e.target.closest(".gn");
    if (!nEl) return;
    const id = nEl.dataset.id, n = node(id);
    if (e.target.closest("[data-collapse]")) { n.collapsed = !n.collapsed; rerenderNode(id); save(); return; }
    if (e.target.closest("[data-runto]")) { enqueue({ only: upstream(G, id) }); return; }
    if (e.target.closest("[data-pick]")) { pickImage(n, e.target.closest("[data-pick]").dataset.pick); return; }
    const play = e.target.closest("[data-play]");
    if (play) { const v = (status.get(id)?.outputs || [])[0]; if (v?.spec) { stopMusic(); playMusic(normalizeMusicSpec(v.spec)); } return; }
    const img = e.target.closest(".gn-img");
    if (img) { openLight(img.src); }
  });
  nodesEl.addEventListener("dblclick", async (e) => {
    const title = e.target.closest(".gn-title");
    if (!title) return;
    const n = node(title.closest(".gn").dataset.id);
    const name = await ask?.("Renommer le nœud", n.title || nodeDef(n.type).title);
    if (name != null) { n.title = name; rerenderNode(n.id); save(); }
  });
  linksEl.addEventListener("click", (e) => {
    const h = e.target.closest("[data-link]");
    if (!h) return;
    snapshot();
    G.links = G.links.filter((l) => l.id !== h.dataset.link);
    render(); save();
  });

  // ===== Recherche de nœuds ===================================================================
  let searchCtx = null;
  function openSearch(cx, cy, worldPos, filter = null) {
    const box = $(".g-search"), r = root.getBoundingClientRect();
    searchCtx = { pos: worldPos, filter };
    box.hidden = false;
    box.style.left = `${clamp(cx - r.left, 8, r.width - 330)}px`;
    box.style.top = `${clamp(cy - r.top, 8, r.height - 380)}px`;
    const input = box.querySelector("input");
    input.value = "";
    fillSearch("");
    setTimeout(() => input.focus(), 10);
  }
  function fillSearch(q) {
    const f = searchCtx?.filter;
    const qn = q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const items = Object.values(NODE_DEFS).filter((d) => {
      if (f?.wantIn && !d.inputs.some((i) => compatible(f.wantIn, i.type))) return false;
      if (f?.wantOut && !d.outputs.some((o) => compatible(o.type, f.wantOut))) return false;
      const hay = `${d.title} ${d.type} ${CATEGORIES.find((c) => c.id === d.cat)?.label}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      return !qn || hay.includes(qn);
    });
    const list = $(".g-search-list");
    list.innerHTML = CATEGORIES.map((c) => {
      const its = items.filter((d) => d.cat === c.id);
      return its.length ? `<div class="gs-cat">${esc(c.label)}</div>${its.map((d) => `<button class="gs-item" data-type="${d.type}"><span class="gn-icon" style="color:${nodeColor(d)}">${icon(nodeIcon(d))}</span><span>${esc(d.title)}</span><small>${[...d.inputs.map((i) => TYPES[i.type].label), "→", ...d.outputs.map((o) => TYPES[o.type].label)].join(" ")}</small></button>`).join("")}` : "";
    }).join("") || `<p class="gs-none">Aucun nœud.</p>`;
    list.querySelector(".gs-item")?.classList.add("is-on");
  }
  $(".g-search input").addEventListener("input", (e) => fillSearch(e.target.value));
  $(".g-search input").addEventListener("keydown", (e) => {
    const items = [...root.querySelectorAll(".gs-item")];
    const i = items.findIndex((x) => x.classList.contains("is-on"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[i]?.classList.remove("is-on"); const n = items[clamp(i + (e.key === "ArrowDown" ? 1 : -1), 0, items.length - 1)]; n?.classList.add("is-on"); n?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter") { e.preventDefault(); items[i]?.click(); }
    else if (e.key === "Escape") hidePopups();
  });
  $(".g-search-list").addEventListener("click", (e) => {
    const b = e.target.closest(".gs-item");
    if (!b || !searchCtx) return;
    const { pos, filter } = searchCtx;
    hidePopups();
    const n = addNode(b.dataset.type, pos.x, pos.y - 20);
    const d = nodeDef(n.type);
    if (filter?.wantIn) { const k = d.inputs.findIndex((i) => compatible(filter.wantIn, i.type)); if (k >= 0) connect(filter.from, filter.out, n.id, k); }
    if (filter?.wantOut) { const k = d.outputs.findIndex((o) => compatible(o.type, filter.wantOut)); if (k >= 0) connect(n.id, k, filter.to, filter.in); n.x -= NODE_W + 40; }
    render(); save();
  });

  // ===== Menus contextuels =====================================================================
  function hidePopups() { $(".g-search").hidden = true; $(".g-ctx").hidden = true; root.querySelectorAll(".g-menu").forEach((m) => { m.hidden = true; }); searchCtx = null; }
  function showCtx(cx, cy, items) {
    const m = $(".g-ctx"), r = root.getBoundingClientRect();
    m.innerHTML = items.map((it) => (it === "-" ? `<div class="gc-sep"></div>` : it.sub ? `<div class="gc-sub"><span>${esc(it.label)} ▸</span><div class="gc-subm">${it.sub.map((s) => `<button data-c="${s.id}">${esc(s.label)}</button>`).join("")}</div></div>` : `<button data-c="${it.id}"${it.danger ? ' class="danger"' : ""}>${esc(it.label)}${it.kbd ? `<kbd>${it.kbd}</kbd>` : ""}</button>`)).join("");
    m.hidden = false;
    m.style.left = `${clamp(cx - r.left, 4, r.width - 230)}px`;
    m.style.top = `${clamp(cy - r.top, 4, r.height - 300)}px`;
    return new Promise((resolve) => { m.onclick = (e) => { const b = e.target.closest("[data-c]"); if (b) { m.hidden = true; resolve(b.dataset.c); } }; });
  }
  stage.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    hidePopups();
    const nEl = e.target.closest(".gn"), gEl = e.target.closest(".gg");
    const p = toWorld(e.clientX, e.clientY);
    if (nEl) {
      const id = nEl.dataset.id, n = node(id);
      if (!sel.has(id)) { sel.clear(); sel.add(id); }
      const c = await showCtx(e.clientX, e.clientY, [
        { id: "runto", label: "Exécuter jusqu'ici" },
        "-",
        { id: "dup", label: "Dupliquer", kbd: "⌘D" },
        { id: "copy", label: "Copier", kbd: "⌘C" },
        { id: "rename", label: "Renommer" },
        { id: "collapse", label: n.collapsed ? "Déplier" : "Réduire" },
        { id: "bypass", label: n.mode === "bypass" ? "Réactiver" : "Contourner", kbd: "⌘B" },
        { id: "mute", label: n.mode === "mute" ? "Réactiver" : "Sourdine", kbd: "⌘M" },
        { label: "Couleur", sub: Object.entries(COLORS).map(([k, l]) => ({ id: `color:${k}`, label: l })) },
        { id: "clearcache", label: "Vider le cache du nœud" },
        "-",
        { id: "del", label: "Supprimer", kbd: "⌫", danger: true },
      ]);
      if (c === "runto") enqueue({ only: upstream(G, id) });
      else if (c === "dup") duplicate();
      else if (c === "copy") copy();
      else if (c === "rename") { const name = await ask?.("Renommer le nœud", n.title || nodeDef(n.type).title); if (name != null) { n.title = name; rerenderNode(id); save(); } }
      else if (c === "collapse") { n.collapsed = !n.collapsed; rerenderNode(id); save(); }
      else if (c === "bypass" || c === "mute") toggleMode(c);
      else if (c?.startsWith("color:")) { snapshot(); for (const sid of sel) node(sid).color = c.slice(6); render(); save(); }
      else if (c === "clearcache") { cache.delete(id); status.delete(id); rerenderNode(id); }
      else if (c === "del") removeNodes(new Set(sel));
      return;
    }
    if (gEl) {
      const g = G.groups.find((x) => x.id === gEl.dataset.gid);
      const c = await showCtx(e.clientX, e.clientY, [{ id: "rename", label: "Renommer le groupe" }, { label: "Couleur", sub: Object.entries(COLORS).filter(([k]) => k).map(([k, l]) => ({ id: `color:${k}`, label: l })) }, { id: "rung", label: "Exécuter le groupe" }, "-", { id: "del", label: "Supprimer le groupe (garder les nœuds)", danger: true }]);
      if (c === "rename") { const t = await ask?.("Nom du groupe", g.title); if (t != null) { g.title = t; render(); save(); } }
      else if (c?.startsWith("color:")) { g.color = c.slice(6); render(); save(); }
      else if (c === "rung") { const ids = new Set(); G.nodes.filter((n) => n.x >= g.x && n.y >= g.y && n.x < g.x + g.w && n.y < g.y + g.h).forEach((n) => upstream(G, n.id).forEach((x) => ids.add(x))); enqueue({ only: ids }); }
      else if (c === "del") { snapshot(); G.groups = G.groups.filter((x) => x !== g); render(); save(); }
      return;
    }
    const c = await showCtx(e.clientX, e.clientY, [
      { label: "Ajouter un nœud", sub: Object.values(NODE_DEFS).map((d) => ({ id: `add:${d.type}`, label: `${CATEGORIES.find((x) => x.id === d.cat)?.label} › ${d.title}` })) },
      { id: "search", label: "Rechercher un nœud…", kbd: "double-clic" },
      { id: "group", label: "Nouveau groupe ici" },
      ...(clipboard ? [{ id: "paste", label: "Coller", kbd: "⌘V" }] : []),
      "-",
      { id: "run", label: "Exécuter", kbd: "⌘⏎" },
      { id: "fit", label: "Tout afficher", kbd: "." },
      { id: "clear", label: "Vider tout le cache" },
    ]);
    if (c?.startsWith("add:")) addNode(c.slice(4), p.x, p.y);
    else if (c === "search") openSearch(e.clientX, e.clientY, p);
    else if (c === "group") { snapshot(); G.groups.push({ id: uid("g"), title: "Groupe", x: Math.round(p.x), y: Math.round(p.y), w: 560, h: 360, color: "#3b82f6" }); render(); save(); }
    else if (c === "paste") paste(p);
    else if (c === "run") enqueue();
    else if (c === "fit") fit();
    else if (c === "clear") { cache.clear(); status.clear(); render(); toast?.("Cache vidé : la prochaine exécution recalcule tout."); }
  });
  // Dépôt d'un nœud depuis la bibliothèque latérale (Studio Nodal).
  stage.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("text/nodal-node")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  stage.addEventListener("drop", (e) => {
    const type = e.dataTransfer?.getData("text/nodal-node");
    if (!type || !nodeDef(type) || !G) return;
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    addNode(type, p.x - 20, p.y - 14);
  });
  stage.addEventListener("dblclick", (e) => {
    if (e.target.closest(".gn, .gg, .g-minimap")) return;
    openSearch(e.clientX, e.clientY, toWorld(e.clientX, e.clientY));
  });

  // ===== Édition : copier, coller, dupliquer, grouper, modes ======================================
  function copy() {
    const ids = new Set(sel);
    if (!ids.size) return;
    clipboard = { nodes: G.nodes.filter((n) => ids.has(n.id)).map((n) => structuredClone(n)), links: G.links.filter((l) => ids.has(l.from) && ids.has(l.to)).map((l) => ({ ...l })) };
    toast?.(`${ids.size} nœud(s) copié(s).`);
  }
  function paste(at = null) {
    if (!clipboard) return;
    snapshot();
    const map = new Map();
    const minX = Math.min(...clipboard.nodes.map((n) => n.x)), minY = Math.min(...clipboard.nodes.map((n) => n.y));
    const base = at || { x: minX + 40, y: minY + 40 };
    sel.clear();
    for (const n of clipboard.nodes) { const c = { ...structuredClone(n), id: uid(), x: Math.round(base.x + n.x - minX), y: Math.round(base.y + n.y - minY) }; map.set(n.id, c.id); G.nodes.push(c); sel.add(c.id); }
    for (const l of clipboard.links) G.links.push({ ...l, id: uid("l"), from: map.get(l.from), to: map.get(l.to) });
    render(); save();
  }
  function duplicate() { copy(); paste(); }
  function groupSelection() {
    const ns = G.nodes.filter((n) => sel.has(n.id));
    if (!ns.length) { toast?.("Sélectionnez des nœuds (⇧-clic ou ⇧-glisser)."); return; }
    snapshot();
    const x = Math.min(...ns.map((n) => n.x)) - 20, y = Math.min(...ns.map((n) => n.y)) - 44;
    const x2 = Math.max(...ns.map((n) => n.x + (n.w || NODE_W))) + 20;
    const y2 = Math.max(...ns.map((n) => { const el = nodesEl.querySelector(`.gn[data-id="${n.id}"]`); return n.y + (el ? el.offsetHeight : 200); })) + 20;
    G.groups.push({ id: uid("g"), title: "Groupe", x, y, w: x2 - x, h: y2 - y, color: "#3b82f6" });
    render(); save();
  }
  function toggleMode(mode) {
    if (!sel.size) return;
    snapshot();
    const all = [...sel].every((id) => node(id).mode === mode);
    for (const id of sel) node(id).mode = all ? "" : mode;
    render(); save();
  }

  // ===== Clavier ===============================================================================
  stage.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter") { e.preventDefault(); enqueue(); }
    else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); copy(); }
    else if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); paste(); }
    else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); }
    else if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); groupSelection(); }
    else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toggleMode("bypass"); }
    else if (mod && e.key.toLowerCase() === "m") { e.preventDefault(); toggleMode("mute"); }
    else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); G.nodes.forEach((n) => sel.add(n.id)); render(); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeNodes(new Set(sel)); }
    else if (e.key === ".") fit();
    else if (e.key === "Escape") { hidePopups(); sel.clear(); render(); }
  });

  // ===== Images : choix, dépôt, visionneuse =========================================================
  async function importImageFile(file) {
    const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(file); });
    const rel = `inputs/${Date.now().toString(36)}-${file.name.replace(/[^\w.-]+/g, "_")}`;
    await store.importBinary(project.slug, rel, b64);
    return rel;
  }
  let pickTarget = null;
  function pickImage(n, w) { pickTarget = { n, w }; $(".g-file").click(); }
  $(".g-file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !pickTarget) return;
    try { const rel = await importImageFile(f); pickTarget.n.widgets[pickTarget.w] = rel; cache.delete(pickTarget.n.id); rerenderNode(pickTarget.n.id); save(); } catch (err) { toast?.(`Import impossible : ${err?.message || err}`); }
  });
  stage.addEventListener("dragover", (e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) e.preventDefault(); });
  stage.addEventListener("drop", async (e) => {
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    let p = toWorld(e.clientX, e.clientY);
    for (const f of files) { try { const rel = await importImageFile(f); addNode("image_load", p.x, p.y, { file: rel }); p = { x: p.x + 30, y: p.y + 30 }; } catch (err) { toast?.(String(err?.message || err)); } }
  });
  let lightUrl = "";
  function openLight(url) { lightUrl = url; $(".g-light img").src = url; $(".g-light").hidden = false; }
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-g]");
    if (!b) { if (!e.target.closest(".g-menu-wrap")) root.querySelectorAll(".g-menu").forEach((m) => { m.hidden = true; }); return; }
    const a = b.dataset.g;
    if (a === "lclose") { $(".g-light").hidden = true; return; }
    if (a === "lsave") { await ctxSaveImage({ url: lightUrl }, "image"); $(".g-light").hidden = true; return; }
    if (a === "run") enqueue();
    else if (a === "stop") abort?.abort();
    else if (a === "add") { const r = stage.getBoundingClientRect(); openSearch(r.left + r.width / 2 - 150, r.top + 80, toWorld(r.left + r.width / 2, r.top + r.height / 2)); }
    else if (a === "group") groupSelection();
    else if (a === "undo") undo();
    else if (a === "redo") redo();
    else if (a === "fit") fit();
    else if (a === "queue") { $(".g-queue").hidden = !$(".g-queue").hidden; renderQueue(); }
    else if (a === "qclose") $(".g-queue").hidden = true;
    else if (a === "qclear") { queue = queue.filter((j) => j === running); renderQueue(); }
    else if (a === "templates") { const m = root.querySelector('[data-g-menu="templates"]'); m.innerHTML = TEMPLATES.map((t, i) => `<button data-tpl="${i}"><b>${esc(t.title)}</b><small>${esc(t.hint)}</small></button>`).join(""); m.hidden = !m.hidden; }
    else if (a === "starter") loadTemplate(TEMPLATES[0]);
    else if (a === "embed") openEmbed(G, project, toast);
    else if (a === "export") exportJson();
    else if (a === "import") $(".g-json").click();
  });
  root.addEventListener("click", (e) => { const t = e.target.closest("[data-tpl]"); if (t) { root.querySelector('[data-g-menu="templates"]').hidden = true; loadTemplate(TEMPLATES[Number(t.dataset.tpl)]); } });
  $(".g-json").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try { const g = JSON.parse(await f.text()); insertGraph(g.graph || g); } catch (err) { toast?.(`Workflow illisible : ${err?.message || err}`); }
  });
  function exportJson() {
    const blob = new Blob([JSON.stringify({ kind: "lumen-canvas-workflow", v: 1, graph: { nodes: G.nodes, links: G.links, groups: G.groups } }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${project?.slug || "workflow"}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function insertGraph(g, at = null) {
    if (!Array.isArray(g?.nodes)) throw new Error("pas de nœuds");
    snapshot();
    const r = stage.getBoundingClientRect();
    const center = at || toWorld(r.left + 120, r.top + 120);
    const minX = Math.min(...g.nodes.map((n) => n.x)), minY = Math.min(...g.nodes.map((n) => n.y));
    const map = new Map();
    for (const n of g.nodes) { if (!nodeDef(n.type)) continue; const c = { ...makeNode(n.type, 0, 0), ...structuredClone(n), id: uid(), x: Math.round(center.x + n.x - minX), y: Math.round(center.y + n.y - minY) }; map.set(n.id, c.id); G.nodes.push(c); }
    for (const l of g.links || []) if (map.has(l.from) && map.has(l.to)) G.links.push({ ...l, id: uid("l"), from: map.get(l.from), to: map.get(l.to) });
    for (const gr of g.groups || []) G.groups.push({ ...gr, id: uid("g"), x: Math.round(center.x + gr.x - minX), y: Math.round(center.y + gr.y - minY) });
    render(); save();
    setTimeout(fit, 50);
  }
  function loadTemplate(t) {
    const nodes = t.nodes.map((n, i) => ({ ...makeNode(n.type, n.x, n.y, n.widgets || {}), id: `t${i}`, title: n.title || "", color: n.color || "" }));
    insertGraph({ nodes, links: t.links.map(([a, o, b, k]) => ({ from: `t${a}`, out: o, to: `t${b}`, in: k })), groups: t.groups || [] });
    toast?.(`Modèle « ${t.title} » ajouté. ⌘⏎ pour l'exécuter.`);
  }

  // ===== Exécution et file ==============================================================================
  const ctxSaveImage = async (img, prefix) => {
    const b64 = String(img.url).split(",")[1];
    const rel = `outputs/${prefix.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${Math.random().toString(36).slice(2, 5)}.png`;
    await store.importBinary(project.slug, rel, b64);
    toast?.(`Image enregistrée : ${rel}`);
    return rel;
  };
  const execCtx = () => ({
    invoke, ...desktopAI(invoke), sandboxId: store.currentSandboxId(),
    outPath: (name) => `canevas/${project.slug}/outputs/${name}`,
    loadImageFile: async (rel) => { const b64 = await store.readBinaryB64(project.slug, rel); const ext = String(rel).split(".").pop().toLowerCase(); const url = `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${b64}`; const im = await loadImg(url); return { url, path: rel, w: im.width, h: im.height }; },
    saveImage: (img, prefix) => ctxSaveImage(img, prefix),
    saveText: async (text, name) => { const rel = `outputs/${name.replace(/[^\w.-]+/g, "_")}-${Date.now().toString(36)}.md`; await store.writeFile(`canevas/${project.slug}/${rel}`, text); toast?.(`Texte enregistré : ${rel}`); },
  });

  function enqueue({ only = null } = {}) {
    if (!G.nodes.length) { toast?.("Le graphe est vide."); return; }
    const n = Number(root.querySelector('[data-g="batch"]').value) || 1;
    for (let i = 0; i < n; i++) queue.push({ id: ++jobSeq, only, state: "pending", at: Date.now(), images: [] });
    renderQueue();
    pump();
  }
  async function pump() {
    if (running) return;
    const job = queue.find((j) => j.state === "pending");
    if (!job) return;
    running = job; job.state = "running"; job.t0 = performance.now();
    abort = new AbortController();
    root.querySelector('[data-g="stop"]').disabled = false;
    renderQueue();
    const onNode = (id, state, info = {}) => {
      status.set(id, { state, ...info });
      if (state === "done" || state === "cached") for (const v of [info.preview, ...(info.outputs || [])]) if (v?.url && !v.kind && !job.images.includes(v.url)) job.images.push(v.url);
      rerenderNode(id);
      setStatus(state === "running" ? `Exécution : ${node(id)?.title || nodeDef(node(id)?.type)?.title || ""}…` : "");
    };
    try {
      const res = await runGraph(G, cache, { onNode, signal: abort.signal, ctx: execCtx(), only: job.only });
      job.state = res.errors.length ? "error" : "done";
      job.summary = `${res.ran} exécuté(s), ${res.cached} en cache${res.errors.length ? `, ${res.errors.length} erreur(s)` : ""}`;
      if (advanceControls(G)) { render(); }
      persistOutputs();
    } catch (e) {
      job.state = "error"; job.summary = String(e?.message || e);
      toast?.(job.summary);
    }
    job.ms = Math.round(performance.now() - job.t0);
    for (const u of job.images) if (!gallery.includes(u)) gallery.unshift(u);
    gallery.splice(60);
    running = null; abort = null;
    root.querySelector('[data-g="stop"]').disabled = true;
    setStatus(job.summary || "");
    renderQueue(); save();
    pump();
  }
  function setStatus(t) { root.querySelector('[data-g="status"]').textContent = t; }
  function renderQueue() {
    root.querySelector('[data-g="qcount"]').textContent = String(queue.filter((j) => j.state === "pending" || j.state === "running").length);
    if ($(".g-queue").hidden) return;
    const label = { pending: "en attente", running: "en cours…", done: "terminé", error: "erreur" };
    $(".g-q-list").innerHTML = queue.slice().reverse().slice(0, 30).map((j) => `<div class="gq st-${j.state}"><b>#${j.id}</b><span>${label[j.state]}${j.ms ? ` · ${(j.ms / 1000).toFixed(1)} s` : ""}</span><small>${esc(j.summary || (j.only ? "partiel" : "graphe complet"))}</small>${j.images.length ? `<div class="gq-imgs">${j.images.slice(0, 4).map((u) => `<img src="${u}" alt=""/>`).join("")}</div>` : ""}</div>`).join("") || `<p class="gs-none">Rien dans la file.</p>`;
    $(".g-gallery").innerHTML = gallery.map((u) => `<img src="${u}" alt=""/>`).join("") || `<p class="gs-none">Aucune image pour l'instant.</p>`;
  }
  $(".g-gallery").addEventListener("click", (e) => { if (e.target.tagName === "IMG") openLight(e.target.src); });
  $(".g-q-list").addEventListener("click", (e) => { if (e.target.tagName === "IMG") openLight(e.target.src); });

  // Les sorties survivent à la fermeture : textes, nombres, chartes en clair,
  // images comme chemins dans le dossier du projet (écrites au besoin).
  async function persistOutputs() {
    for (const n of G.nodes) {
      const c = cache.get(n.id);
      if (!c) continue;
      const outs = [];
      let lossy = false; // une sortie impossible à garder (audio) : pas de reprise
      for (let k = 0; k < c.outputs.length; k++) {
        const v = c.outputs[k];
        if (v && typeof v === "object" && v.url && !v.kind) {
          if (!v.path) {
            try { const rel = `cache/${n.id}-${k}.png`; await store.importBinary(project.slug, rel, String(v.url).split(",")[1]); v.path = rel; } catch { lossy = true; break; }
          }
          outs.push({ img: v.path.startsWith("canevas/") ? v.path.split("/").slice(2).join("/") : v.path, w: v.w, h: v.h });
        } else if (v && typeof v === "object" && v.kind) { lossy = true; break; }
        else outs.push(typeof v === "string" ? v.slice(0, 20000) : v);
      }
      if (lossy) { delete n.saved; continue; }
      n.saved = { key: c.key, outputs: outs };
    }
    save();
  }
  async function restoreOutputs() {
    for (const n of G.nodes) {
      if (!n.saved) continue;
      const outputs = [];
      let ok = true;
      for (const o of n.saved.outputs) {
        if (o && typeof o === "object" && o.img) {
          try { const b64 = await store.readBinaryB64(project.slug, o.img); outputs.push({ url: `data:image/png;base64,${b64}`, path: o.img, w: o.w, h: o.h }); } catch { ok = false; break; }
        } else outputs.push(o);
      }
      if (!ok) continue;
      cache.set(n.id, { key: n.saved.key, outputs });
      status.set(n.id, { state: "cached", outputs });
    }
    render();
  }

  return {
    open(p) {
      project = p;
      p.graph ||= blankGraph();
      G = p.graph;
      G.nodes ||= []; G.links ||= []; G.groups ||= []; G.view ||= { x: 80, y: 60, scale: 1 };
      cache.clear(); status.clear(); sel.clear(); undoStack.length = 0; redoStack.length = 0;
      render();
      restoreOutputs();
      if (!G.nodes.length) setTimeout(() => stage.focus({ preventScroll: true }), 50);
    },
    insertGraph, loadTemplate, fit,
    /** Ajoute un nœud au centre de la vue (bibliothèque, clic simple). */
    addNodeAtCenter(type) {
      if (!G || !nodeDef(type)) return null;
      const r = stage.getBoundingClientRect();
      const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      const k = G.nodes.length % 6;
      return addNode(type, p.x - 120 + k * 24, p.y - 80 + k * 24);
    },
    get graph() { return G; },
  };
}
