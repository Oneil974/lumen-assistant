// Mindmap (carte mentale) — logique front. Modèle simple { name, nodes, edges }
// persisté en localStorage. Rendu : nœuds en <div> positionnés dans un calque
// transformé (pan/zoom), liens en <path> SVG. L'IA (composition d'une carte ou
// développement d'un nœud) passe par le backend unifié llmChat (Ollama ou API
// cloud OpenAID-compatible), exactement comme les autres mini-apps du workspace.

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};

import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { translatePage, tt, observeTranslations } from "../apps-i18n.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";

import { receive, toText } from "../lib/interop.js";
import { mountCreativeBar } from "../lib/creative-kit.js";
// Dossier des cartes dans une sandbox + extension dédiée.
const SB_DIR = "mindmaps";
const SB_EXT = ".mindmap.json";

const STORE_KEY = "mindmap.data";
const NODE_COLORS = ["#0a84ff", "#34c759", "#ff9f0a", "#ff375f", "#bf5af2", "#30d1c8", "#ff6482"];

// ===== État =====
// NB : NODE_COLORS doit être défini AVANT cet appel — load() y référence la
// couleur du nœud par défaut (sinon ReferenceError en zone morte temporelle).
let model = load();
let view = { x: 0, y: 0, z: 1 };   // pan + zoom du calque
let selectedId = null;
let uid = Math.max(0, ...model.nodes.map((n) => n.id)) + 1;

// ===== DOM =====
const wrap = document.getElementById("canvas-wrap");
const nodesLayer = document.getElementById("nodes");
const edgesLayer = document.getElementById("edges");
const hint = document.getElementById("hint");

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (raw && Array.isArray(raw.nodes)) return raw;
  } catch {}
  return {
    name: "Carte mentale",
    nodes: [{ id: 0, text: "Idée centrale", x: 0, y: 0, root: true, color: NODE_COLORS[0] }],
    edges: [],
  };
}
function save() {
  model.name = document.getElementById("map-name").value || "Carte mentale";
  localStorage.setItem(STORE_KEY, JSON.stringify(model));
}

/** La carte en plan Markdown (racine → branches), pour l'export et Opus. */
function mapOutline() {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const kids = (id) => model.edges.filter((e) => e.from === id).map((e) => byId.get(e.to)).filter(Boolean);
  const root = model.nodes.find((n) => n.root) || model.nodes[0];
  const seen = new Set();
  const walk = (n, depth) => {
    if (!n || seen.has(n.id)) return "";
    seen.add(n.id);
    const line = depth === 0 ? `## ${n.text}\n` : `${"  ".repeat(depth - 1)}- ${n.text}\n`;
    return line + kids(n.id).map((k) => walk(k, depth + 1)).join("");
  };
  let out = walk(root, 0);
  for (const n of model.nodes) if (!seen.has(n.id)) out += walk(n, 1);
  return out.trim();
}

// ===== Conversion coordonnées écran <-> monde =====
function screenToWorld(sx, sy) {
  const r = wrap.getBoundingClientRect();
  return { x: (sx - r.left - view.x) / view.z, y: (sy - r.top - view.y) / view.z };
}
function applyTransform() {
  const t = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  nodesLayer.style.transform = t;
  edgesLayer.style.transform = t;
}

// ===== Rendu =====
function render() {
  hint.hidden = model.nodes.length > 1;
  // Nœuds
  nodesLayer.textContent = "";
  for (const n of model.nodes) {
    const el = document.createElement("div");
    el.className = "node" + (n.root ? " root" : "") + (n.id === selectedId ? " selected" : "");
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    el.style.borderColor = n.color || "var(--border)";
    el.dataset.id = n.id;

    const txt = document.createElement("div");
    txt.className = "txt";
    txt.textContent = n.text;
    el.appendChild(txt);

    const handle = document.createElement("div");
    handle.className = "handle";
    handle.title = "Glisser pour relier à un autre nœud";
    el.appendChild(handle);

    if (!n.root) {
      const del = document.createElement("button");
      del.className = "del"; del.textContent = "✕"; del.title = "Supprimer";
      del.addEventListener("pointerdown", (e) => e.stopPropagation());
      del.addEventListener("click", (e) => { e.stopPropagation(); deleteNode(n.id); });
      el.appendChild(del);
    }

    wireNode(el, n, txt, handle);
    nodesLayer.appendChild(el);
  }
  renderEdges();
}

function renderEdges() {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  let d = "";
  for (const e of model.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    d += edgePath(a.x, a.y, b.x, b.y);
  }
  edgesLayer.innerHTML = d;
}
function edgePath(x1, y1, x2, y2, cls = "") {
  const mx = (x1 + x2) / 2;
  return `<path class="${cls}" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" />`;
}

// ===== Interactions nœud =====
function wireNode(el, n, txt, handle) {
  // Déplacement du nœud
  el.addEventListener("pointerdown", (e) => {
    if (e.target === handle) return;       // géré ci-dessous
    if (txt.isContentEditable) return;
    e.stopPropagation();
    select(n.id);
    const start = screenToWorld(e.clientX, e.clientY);
    const ox = n.x - start.x, oy = n.y - start.y;
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = screenToWorld(ev.clientX, ev.clientY);
      n.x = Math.round(w.x + ox); n.y = Math.round(w.y + oy);
      el.style.left = n.x + "px"; el.style.top = n.y + "px";
      renderEdges();
    };
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      save();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });

  // Édition au double-clic
  el.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    txt.setAttribute("contenteditable", "true");
    txt.focus();
    document.getSelection().selectAllChildren(txt);
  });
  txt.addEventListener("blur", () => {
    txt.removeAttribute("contenteditable");
    n.text = txt.textContent.trim() || "…";
    txt.textContent = n.text;
    save();
  });
  txt.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); txt.blur(); }
  });

  // Création de lien par glisser depuis la poignée
  handle.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const tmp = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tmp.setAttribute("class", "tmp");
    edgesLayer.appendChild(tmp);
    const move = (ev) => {
      const w = screenToWorld(ev.clientX, ev.clientY);
      tmp.setAttribute("d", edgePath(n.x, n.y, w.x, w.y).match(/d="([^"]+)"/)[1]);
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      tmp.remove();
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".node");
      if (target && +target.dataset.id !== n.id) {
        connect(n.id, +target.dataset.id);
      } else {
        // Lâcher dans le vide : créer un nœud enfant relié
        const w = screenToWorld(ev.clientX, ev.clientY);
        const child = addNode("Nouvelle idée", w.x, w.y, n.color);
        connect(n.id, child.id);
        render();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

function select(id) {
  selectedId = id;
  nodesLayer.querySelectorAll(".node").forEach((el) =>
    el.classList.toggle("selected", +el.dataset.id === id));
}

// ===== Mutations du modèle =====
function addNode(text, x, y, color) {
  const n = { id: uid++, text, x: Math.round(x), y: Math.round(y), color: color || pickColor() };
  model.nodes.push(n);
  save();
  return n;
}
function pickColor() { return NODE_COLORS[model.nodes.length % NODE_COLORS.length]; }
function connect(from, to) {
  if (from === to) return;
  if (model.edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return;
  model.edges.push({ from, to });
  save(); render();
}
function deleteNode(id) {
  model.nodes = model.nodes.filter((n) => n.id !== id);
  model.edges = model.edges.filter((e) => e.from !== id && e.to !== id);
  if (selectedId === id) selectedId = null;
  save(); render();
}

// ===== Pan / zoom de la toile =====
wrap.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".node")) return;
  select(null);
  wrap.classList.add("panning");
  const sx = e.clientX - view.x, sy = e.clientY - view.y;
  const move = (ev) => { view.x = ev.clientX - sx; view.y = ev.clientY - sy; applyTransform(); };
  const up = () => {
    wrap.classList.remove("panning");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});
wrap.addEventListener("dblclick", (e) => {
  if (e.target.closest(".node")) return;
  const w = screenToWorld(e.clientX, e.clientY);
  const n = addNode("Nouvelle idée", w.x, w.y);
  render(); select(n.id);
});
wrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = wrap.getBoundingClientRect();
  const cx = e.clientX - r.left, cy = e.clientY - r.top;
  const before = { x: (cx - view.x) / view.z, y: (cy - view.y) / view.z };
  view.z = Math.min(2.5, Math.max(0.25, view.z * (e.deltaY < 0 ? 1.1 : 0.9)));
  view.x = cx - before.x * view.z; view.y = cy - before.y * view.z;
  applyTransform();
}, { passive: false });

document.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    const active = document.activeElement;
    if (active && active.isContentEditable) return;
    if (selectedId != null) {
      const n = model.nodes.find((x) => x.id === selectedId);
      if (n && !n.root) deleteNode(selectedId);
    }
  }
});

// ===== Assistant IA (boîte de prompt partagée) =====
// La carte se manipule entièrement au prompt : ajouter une branche, développer
// un nœud, réorganiser, élaguer, renommer.
const nodeByRef = (ref) => {
  const r = String(ref ?? "").trim().toLowerCase();
  if (/^\d+$/.test(r)) { const byId = model.nodes.find((n) => n.id === Number(r)); if (byId) return byId; }
  return model.nodes.find((n) => n.text.toLowerCase() === r) || model.nodes.find((n) => n.text.toLowerCase().includes(r));
};
const nodeLine = (n) => {
  const kids = model.edges.filter((e) => e.from === n.id).map((e) => model.nodes.find((x) => x.id === e.to)?.text).filter(Boolean);
  return `#${n.id} « ${n.text} »${n.root ? " (racine)" : ""}${kids.length ? ` → ${kids.join(", ")}` : ""}`;
};

const MINDMAP_TOOLS = [
  tool("list_nodes", "Liste les nœuds de la carte et leurs liens.", {}),
  tool("add_node", "Ajoute un nœud, éventuellement relié à un nœud parent.",
    { text: T.str("Texte du nœud"), parent: T.str("Nœud parent (numéro ou texte)") }, ["text"]),
  tool("add_branch", "Ajoute plusieurs nœuds enfants d'un coup sous un même parent (branche complète).",
    { parent: T.str("Nœud parent"), children: T.list("Textes des nœuds enfants") }, ["parent", "children"]),
  tool("rename_node", "Change le texte d'un nœud.", { node: T.str(""), text: T.str("Nouveau texte") }, ["node", "text"]),
  tool("connect_nodes", "Relie deux nœuds existants.", { from: T.str(""), to: T.str("") }, ["from", "to"]),
  tool("delete_node", "Supprime un nœud et ses liens.", { node: T.str("") }, ["node"]),
  tool("build_map", "Construit (ou reconstruit) toute la carte : thème central et branches hiérarchiques.",
    { center: T.str("Thème central"), replace: T.bool("Vider la carte existante (défaut : oui)"),
      branches: { type: "array", description: "Branches principales et leurs sous-idées",
        items: { type: "object", properties: { title: T.str(""), children: T.list("Sous-idées") }, required: ["title"] } } },
    ["center", "branches"]),
  tool("arrange", "Réorganise automatiquement la carte (arbre radial).", {}),
];

async function runMindmapTool(name, a) {
  const need = (ref) => { const n = nodeByRef(ref); if (!n) throw new Error(`aucun nœud « ${ref} ». Appelle list_nodes.`); return n; };
  switch (name) {
    case "list_nodes":
      return model.nodes.length ? model.nodes.map(nodeLine).join("\n") : "Carte vide.";
    case "add_node": {
      const p = a.parent ? need(a.parent) : null;
      const n = addNode(String(a.text), (p?.x || 0) + 220, (p?.y || 0) + 60 * (model.nodes.length % 5));
      if (p) model.edges.push({ from: p.id, to: n.id });
      return `Ajouté : ${nodeLine(n)}`;
    }
    case "add_branch": {
      const p = need(a.parent);
      const kids = (a.children || []).map((txt, i) => {
        const n = addNode(String(txt), p.x + 240, p.y + (i - (a.children.length - 1) / 2) * 90);
        model.edges.push({ from: p.id, to: n.id });
        return n;
      });
      return `Branche sous « ${p.text} » : ${kids.map((n) => n.text).join(", ")}`;
    }
    case "rename_node": { const n = need(a.node); n.text = String(a.text); return `Renommé : ${nodeLine(n)}`; }
    case "connect_nodes": { const f = need(a.from), t2 = need(a.to); connect(f.id, t2.id); return `Relié : « ${f.text} » → « ${t2.text} »`; }
    case "delete_node": { const n = need(a.node); deleteNode(n.id); return `Supprimé : « ${n.text} »`; }
    case "build_map": {
      const branches = Array.isArray(a.branches) ? a.branches : [];
      if (!branches.length) throw new Error("fournis au moins une branche.");
      if (a.replace !== false) { model.nodes = []; model.edges = []; uid = 0; }
      const root = addNode(String(a.center), 0, 0, NODE_COLORS[0]);
      root.root = true;
      branches.forEach((b, i) => {
        const ang = (2 * Math.PI * i) / branches.length - Math.PI / 2;
        const bn = addNode(String(b.title), Math.cos(ang) * 240, Math.sin(ang) * 240);
        model.edges.push({ from: root.id, to: bn.id });
        (b.children || []).forEach((c, j) => {
          const cn = addNode(String(c), Math.cos(ang) * 460, Math.sin(ang) * 460 + (j - ((b.children.length - 1) / 2)) * 80);
          model.edges.push({ from: bn.id, to: cn.id });
        });
      });
      autoLayout();
      return `Carte « ${a.center} » construite : ${branches.length} branches, ${model.nodes.length} nœuds.`;
    }
    case "arrange": { autoLayout(); return "Carte réorganisée."; }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountMindmapAI() {
  mountAiPrompt(null, {
    app: "Carte mentale",
    intro: "Tu construis et remanies la carte mentale de l'utilisateur.",
    rules: "- Pour créer une carte entière, appelle build_map UNE fois avec toutes les branches.\n- Pour enrichir l'existant, add_branch sous le bon parent, puis arrange.",
    placeholder: "Ex. : construis une carte sur le lancement d'un SaaS…",
    suggestions: [
      { label: "Construire une carte", prompt: "Construis une carte mentale complète sur un sujet que je vais te donner. Demande-le si tu ne l'as pas." },
      { label: "Développer", prompt: "Développe le nœud sélectionné en 4 sous-idées concrètes." },
      { label: "Approfondir", prompt: "Regarde la carte et ajoute les branches manquantes pour qu'elle soit complète." },
      { label: "Réorganiser", prompt: "Réorganise la carte proprement." },
    ],
    tools: MINDMAP_TOOLS,
    context: () => {
      const sel = model.nodes.find((n) => n.id === selectedId);
      return `Carte « ${model.name} ». Nœud sélectionné : ${sel ? nodeLine(sel) : "(aucun)"}\n`
        + model.nodes.slice(0, 40).map(nodeLine).join("\n");
    },
    execute: runMindmapTool,
    onApplied: () => { save(); render(); },
  });
}

// ===== Agencement automatique (arbre radial autour du nœud racine) =====
function autoLayout() {
  const root = model.nodes.find((n) => n.root) || model.nodes[0];
  if (!root) return;
  const adj = new Map(model.nodes.map((n) => [n.id, []]));
  for (const e of model.edges) { adj.get(e.from)?.push(e.to); adj.get(e.to)?.push(e.from); }
  const seen = new Set([root.id]);
  root.x = 0; root.y = 0;
  // BFS par niveaux
  let level = [root.id], depth = 1;
  while (level.length) {
    const next = [];
    for (const id of level) for (const c of adj.get(id) || []) if (!seen.has(c)) { seen.add(c); next.push(c); }
    next.forEach((id, i) => {
      const ang = (2 * Math.PI * i) / next.length - Math.PI / 2;
      const radius = depth * 200;
      const n = model.nodes.find((x) => x.id === id);
      if (n) { n.x = Math.round(Math.cos(ang) * radius); n.y = Math.round(Math.sin(ang) * radius); }
    });
    level = next; depth++;
  }
  // Nœuds orphelins : grille en dessous
  let k = 0;
  for (const n of model.nodes) if (!seen.has(n.id)) { n.x = (k % 6) * 160 - 400; n.y = 400 + Math.floor(k / 6) * 120; k++; }
  save(); render(); fitView();
}

function fitView() {
  if (!model.nodes.length) return;
  const xs = model.nodes.map((n) => n.x), ys = model.nodes.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const r = wrap.getBoundingClientRect();
  const w = (maxX - minX) || 1, h = (maxY - minY) || 1;
  view.z = Math.min(1.2, Math.max(0.3, Math.min((r.width - 160) / w, (r.height - 160) / h)));
  view.x = r.width / 2 - ((minX + maxX) / 2) * view.z;
  view.y = r.height / 2 - ((minY + maxY) / 2) * view.z;
  applyTransform();
}

// ===== IA : composer / développer =====
let aiMode = "compose"; // "compose" | "expand"

function openAI(mode) {
  aiMode = mode;
  const ov = document.getElementById("ai-overlay");
  const title = document.getElementById("ai-title");
  const sub = document.getElementById("ai-sub");
  const ta = document.getElementById("ai-text");
  document.getElementById("ai-state").textContent = "";
  if (mode === "expand") {
    const n = model.nodes.find((x) => x.id === selectedId);
    if (!n) { toast("Sélectionnez d'abord un nœud."); return; }
    title.textContent = `Développer « ${n.text} »`;
    sub.textContent = "L'IA propose des sous-idées reliées à ce nœud.";
    ta.value = "";
    ta.placeholder = "Optionnel : précisez l'angle souhaité (ex. : risques, étapes concrètes…)";
  } else {
    title.textContent = "Composer une carte mentale avec l'IA";
    sub.textContent = "Décrivez le sujet : l'IA génère une carte structurée (thème central, branches et sous-idées).";
    ta.value = "";
    ta.placeholder = "Ex. : Lancer un produit SaaS — stratégie, équipe, marketing, finances…";
  }
  ov.hidden = false; ta.focus();
}

async function runAI() {
  const ta = document.getElementById("ai-text");
  const state = document.getElementById("ai-state");
  const prompt = ta.value.trim();
  if (aiMode === "compose" && !prompt) { toast("Décrivez un sujet."); return; }
  state.textContent = "Génération…";

  try {
    const lang = replyLang();
    const { messages, opts } = aiMode === "compose"
      ? PROMPTS["app.mindmap.compose"].build({ topic: prompt, lang })
      : PROMPTS["app.mindmap.expand"].build({ concept: model.nodes.find((x) => x.id === selectedId).text, angle: prompt, lang });
    const { content, data } = await llmChat(messages, { ...opts, rawSystem: true });
    recordOllamaUsage(data, "mindmap");
    const json = parseJSON(content);

    if (aiMode === "compose") buildFromCompose(json);
    else buildFromExpand(json);

    document.getElementById("ai-overlay").hidden = true;
  } catch (err) {
    state.textContent = "";
    toast("Échec IA : " + (err.message || err));
  }
}

function parseJSON(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error("réponse IA illisible");
}

function buildFromCompose(json) {
  model.nodes = []; model.edges = [];
  uid = 0;
  const root = addNode(json.central || "Idée centrale", 0, 0, NODE_COLORS[0]);
  root.root = true;
  (json.branches || []).forEach((br, i) => {
    const b = addNode(br.label || "Branche", 0, 0, NODE_COLORS[(i + 1) % NODE_COLORS.length]);
    connect(root.id, b.id);
    (br.children || []).forEach((c) => {
      const ch = addNode(String(c), 0, 0, b.color);
      model.edges.push({ from: b.id, to: ch.id });
    });
  });
  save(); autoLayout();
}

function buildFromExpand(json) {
  const parent = model.nodes.find((x) => x.id === selectedId);
  if (!parent) return;
  (json.children || []).forEach((c, i) => {
    const ang = (2 * Math.PI * i) / Math.max(1, json.children.length);
    const ch = addNode(String(c), parent.x + Math.cos(ang) * 180, parent.y + Math.sin(ang) * 180, parent.color);
    model.edges.push({ from: parent.id, to: ch.id });
  });
  save(); render();
}

// ===== Menu « plus » : import / export =====
function exportJSON() {
  const blob = new Blob([JSON.stringify(model, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (model.name || "carte-mentale") + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
}
function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try { applyModel(JSON.parse(reader.result)); toast("Carte importée."); }
    catch { toast("Fichier JSON invalide."); }
  };
  reader.readAsText(file);
}

// Applique une carte parsée (depuis fichier ou sandbox) à l'éditeur.
function applyModel(data) {
  if (!data || !Array.isArray(data.nodes)) throw new Error("format");
  model = data;
  uid = Math.max(0, ...model.nodes.map((n) => n.id)) + 1;
  document.getElementById("map-name").value = model.name || "Carte mentale";
  save(); render(); fitView();
}

// ===== Sandbox : enregistrer / ouvrir =====
function slug() {
  return (model.name || "carte-mentale").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "carte";
}
async function saveToSandbox() {
  if (!invoke) { toast("Sandbox indisponible."); return; }
  let boxes = [];
  try { boxes = await invoke("sandbox_list"); } catch {}
  if (!boxes.length) { toast("Aucune sandbox. Créez-en une dans l'explorateur."); return; }
  const box = boxes.length === 1 ? boxes[0] : await pickFromList("Enregistrer dans…", boxes.map((b) => ({ label: b.name || b.id, value: b })));
  if (!box) return;
  const path = `${SB_DIR}/${slug()}${SB_EXT}`;
  try {
    await invoke("sandbox_write_file", { id: box.id, path, content: JSON.stringify(model, null, 2) });
    toast(`Enregistré → ${box.name || box.id} / ${path}`);
  } catch (e) { toast("Échec : " + (e.message || e)); }
}
async function openFromSandbox() {
  if (!invoke) { toast("Sandbox indisponible."); return; }
  let boxes = [];
  try { boxes = await invoke("sandbox_list"); } catch {}
  if (!boxes.length) { toast("Aucune sandbox."); return; }
  // Rassemble toutes les cartes (.mindmap.json) de toutes les sandboxes.
  const found = [];
  for (const b of boxes) {
    for (const dir of [SB_DIR, ""]) {
      let entries = [];
      try { entries = await invoke("sandbox_read_dir", { id: b.id, path: dir }); } catch {}
      for (const e of entries) {
        if (!e.is_dir && e.name.endsWith(SB_EXT)) {
          found.push({ label: e.name.replace(SB_EXT, ""), sub: b.name || b.id, value: { id: b.id, path: e.path } });
        }
      }
    }
  }
  if (!found.length) { toast("Aucune carte enregistrée dans les sandboxes."); return; }
  const pick = await pickFromList("Ouvrir une carte", found);
  if (!pick) return;
  try {
    const fc = await invoke("sandbox_read_file", { id: pick.id, path: pick.path });
    applyModel(JSON.parse(fc.content));
    toast("Carte ouverte.");
  } catch (e) { toast("Ouverture impossible : " + (e.message || e)); }
}

// Petit sélecteur modal générique. Renvoie la `value` choisie (ou null).
function pickFromList(title, items) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `<div class="mini-modal"><h3></h3><div class="pick-list"></div>` +
      `<div class="mini-actions"><span class="spacer"></span><button class="btn-soft">Annuler</button></div></div>`;
    ov.querySelector("h3").textContent = title;
    const list = ov.querySelector(".pick-list");
    for (const it of items) {
      const b = document.createElement("button");
      b.className = "pick-item";
      b.innerHTML = `<span class="pi-label"></span>${it.sub ? `<span class="pi-sub"></span>` : ""}`;
      b.querySelector(".pi-label").textContent = it.label;
      if (it.sub) b.querySelector(".pi-sub").textContent = it.sub;
      b.addEventListener("click", () => { ov.remove(); resolve(it.value); });
      list.appendChild(b);
    }
    const close = () => { ov.remove(); resolve(null); };
    ov.querySelector("button.btn-soft").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    document.body.appendChild(ov);
  });
}

function exportPNG() {
  // Rendu SVG autonome (nœuds en <foreignObject> simplifié → rectangles + texte).
  const xs = model.nodes.map((n) => n.x), ys = model.nodes.map((n) => n.y);
  const pad = 120;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
  const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  let edges = "";
  for (const e of model.edges) {
    const a = byId.get(e.from), b = byId.get(e.to); if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    edges += `<path d="M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}" fill="none" stroke="#888" stroke-width="2"/>`;
  }
  let nodes = "";
  for (const n of model.nodes) {
    const tw = Math.min(220, Math.max(80, n.text.length * 8 + 24));
    nodes += `<g transform="translate(${n.x - tw / 2},${n.y - 16})">` +
      `<rect width="${tw}" height="32" rx="10" fill="#fff" stroke="${n.color || "#ccc"}" stroke-width="2"/>` +
      `<text x="${tw / 2}" y="21" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#1c1c1e">${escapeXml(n.text)}</text></g>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX} ${minY} ${w} ${h}"><rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#f7f7fb"/>${edges}${nodes}</svg>`;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0);
    c.toBlob((b) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b); a.download = (model.name || "carte-mentale") + ".png"; a.click();
      URL.revokeObjectURL(a.href);
    });
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
function escapeXml(s) { return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ===== Câblage de l'UI =====
function bind() {
  document.getElementById("map-name").value = model.name || "Carte mentale";
  document.getElementById("map-name").addEventListener("change", save);
  document.getElementById("btn-add").addEventListener("click", () => {
    const r = wrap.getBoundingClientRect();
    const w = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
    const n = addNode("Nouvelle idée", w.x, w.y);
    render(); select(n.id);
  });
  document.getElementById("btn-layout").addEventListener("click", autoLayout);
  // Espace Création : projets, versions et exports communs aux éditeurs.
  mountCreativeBar(document.getElementById("creative-bar"), {
    app: "mindmap",
    current: () => ({ ref: (model.id ||= `map-${Date.now().toString(36)}`), title: model.name || "Carte mentale" }),
    serialize: () => JSON.stringify(model),
    restore: (content) => {
      const next = JSON.parse(content);
      if (!next || !Array.isArray(next.nodes)) return;
      model = next;
      uid = Math.max(0, ...model.nodes.map((n) => n.id)) + 1;
      document.getElementById("map-name").value = model.name || "Carte mentale";
      localStorage.setItem(STORE_KEY, JSON.stringify(model));
      render();
    },
    exportDoc: () => ({ title: model.name || "Carte mentale", markdown: mapOutline(), json: model }),
    formats: ["md", "html", "pdf", "json"],
    toast,
  });
  document.getElementById("btn-expand").addEventListener("click", () => openAI("expand"));
  document.getElementById("btn-compose").addEventListener("click", () => openAI("compose"));
  document.getElementById("ai-cancel").addEventListener("click", () => (document.getElementById("ai-overlay").hidden = true));
  document.getElementById("ai-run").addEventListener("click", runAI);

  const menu = document.getElementById("menu-pop");
  document.getElementById("btn-menu").addEventListener("click", (e) => {
    e.stopPropagation(); menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", () => (menu.hidden = true));
  menu.addEventListener("click", async (e) => {
    const act = e.target.dataset.act; if (!act) return;
    if (act === "new") {
      if (await confirmSheet({ title: tt("Effacer la carte actuelle ?"), confirm: tt("Effacer"), cancel: tt("Annuler"), danger: true })) {
        model = { name: "Carte mentale", nodes: [{ id: 0, text: "Idée centrale", x: 0, y: 0, root: true, color: NODE_COLORS[0] }], edges: [] };
        uid = 1; document.getElementById("map-name").value = model.name;
        save(); render(); fitView();
      }
    } else if (act === "save-sb") saveToSandbox();
    else if (act === "open-sb") openFromSandbox();
    else if (act === "export") exportJSON();
    else if (act === "import") document.getElementById("import-file").click();
    else if (act === "png") exportPNG();
  });
  document.getElementById("import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = "";
  });
}

// ===== Démarrage =====
translatePage();
observeTranslations();
bind();
mountMindmapAI();
// « Envoyer vers Carte mentale » : la première ligne devient un nœud, les
// suivantes ses enfants.
receive("mindmap", async (obj) => {
  const lines = toText(obj).split(/\n/).map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
  if (!lines.length) return;
  const head = (obj.title || lines[0]).slice(0, 80);
  const children = obj.title ? lines : lines.slice(1);
  await runMindmapTool("add_node", { text: head });
  if (children.length) await runMindmapTool("add_branch", { parent: head, children: children.slice(0, 12).map((c) => c.slice(0, 80)) });
  save(); render();
});
applyTransform();
render();
fitView();
