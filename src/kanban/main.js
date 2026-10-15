// Tableau Kanban collaboratif. Le modèle vit ici et est persisté en JSON via
// kanban.rs (kanban_load / kanban_save). L'IA traite les cartes de la (des)
// colonne(s) marquée(s) « à traiter » via Ollama, exactement comme l'explorateur
// de sandboxes. Le drag&drop est en HTML5 natif (la fenêtre désactive le handler
// de drop de Tauri côté Rust).
// Fallback sur la fenêtre parente : permet de tourner intégré en iframe dans le
// bureau (même origine), où window.__TAURI__ n'est pas injecté.
const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const { listen } = __TAURI.event || {};
import { autoTranslate, translatePage, tt } from "../apps-i18n.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { receive, toText } from "../lib/interop.js";
import { icon } from "../lib/icons.js?v=3";
import { confirmSheet, promptSheet } from "../lib/confirm.js";
autoTranslate({ observe: true });

// Icônes Lucide des boutons statiques : posées une fois, avant le premier rendu.
document.querySelectorAll("[data-ic]").forEach((el) => { el.outerHTML = icon(el.dataset.ic); });

const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
const STD_COL_FR = {
  "To do": "À faire",
  "To process": "À traiter",
  "In review": "En revue",
  "Done": "Fait",
};
function processCardsLabel(n) {
  return tt("Traiter cette carte avec l'IA")
    .replace("cette", String(n))
    .replace("this", String(n))
    .replace("card", `card${n > 1 ? "s" : ""}`);
}
// Identifiant de cette fenêtre : permet d'ignorer l'écho de ses propres
// enregistrements lors de la diffusion collaborative (event kanban-updated).
const ME = uid();

const PALETTE = ["#0a84ff", "#ff9f0a", "#34c759", "#ff375f", "#bf5af2", "#5ac8fa", "#ffd60a", "#8e8e93"];

// ===== Modèle =====
let board = null;
let dragCardId = null;
let agents = [];     // agents IA assignables (chargés via agent_list)
let sandboxes = [];  // sandboxes disponibles pour lier un fichier
const fileCache = {}; // id sandbox → liste de fichiers (mémoïsé)

function agentById(id) { return agents.find((a) => a.id === id) || null; }
function taskIdFor(cardId) { return `kanban-${cardId}`; }
// Convertit une date <input type=date> (YYYY-MM-DD) en epoch **secondes** (début
// de journée, locale) — format attendu par le champ `due` des tâches d'agent.
function dateToDueSecs(ymd) {
  if (!ymd) return null;
  const d = new Date(ymd + "T00:00:00");
  return Math.floor(d.getTime() / 1000);
}
function dueSecsToDate(secs) {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultBoard() {
  const me = { id: uid(), name: "Moi", color: PALETTE[0] };
  return {
    name: "Tableau",
    members: [me],
    aiInstruction: "Analyse cette tâche et propose un plan d'action concret et actionnable. Sois bref et précis.",
    columns: [
      { id: uid(), title: "À faire", ai: false },
      { id: uid(), title: "À traiter", ai: true },
      { id: uid(), title: "En revue", ai: false },
      { id: uid(), title: "Fait", ai: false },
    ],
    cards: [],
  };
}

// Colonne « Fait » = dernière colonne du tableau : destination des cartes une
// fois traitées par l'IA.
function doneColumnId() {
  return board.columns.length ? board.columns[board.columns.length - 1].id : null;
}
function memberById(id) { return board.members.find((m) => m.id === id) || null; }
function cardsIn(colId) {
  return board.cards.filter((c) => c.colId === colId).sort((a, b) => a.order - b.order);
}

// ===== Persistance + collaboration =====
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await invoke("kanban_save", { data: JSON.stringify(board), origin: ME }); }
    catch (e) { toast(tt("Échec :") + " " + (e?.message || e), true); }
  }, 250);
}

async function load() {
  try {
    const raw = await invoke("kanban_load");
    board = raw ? JSON.parse(raw) : defaultBoard();
  } catch { board = defaultBoard(); }
  // Garde-fous si le fichier est partiel.
  if (!board.members?.length) board.members = defaultBoard().members;
  if (!board.columns?.length) board.columns = defaultBoard().columns;
  board.cards ||= [];
  board.aiInstruction ||= defaultBoard().aiInstruction;
}

// ===== Rendu =====
function render() {
  $("#board-name").value = tt(board.name);
  renderMembers();
  const root = $("#board");
  root.innerHTML = "";
  for (const col of board.columns) root.appendChild(renderColumn(col));
  translatePage();  // traduit l'UI statique (si langue anglaise)
}

function renderMembers() {
  const box = $("#members");
  box.innerHTML = "";
  for (const m of board.members) {
    const av = document.createElement("div");
    av.className = "member-av"; av.style.background = m.color;
    av.textContent = initials(m.name); av.title = m.name;
    box.appendChild(av);
  }
}

function renderColumn(col) {
  const el = document.createElement("section");
  el.className = "column" + (col.ai ? " ai-col" : "");
  el.dataset.col = col.id;

  const cards = cardsIn(col.id);
  const head = document.createElement("div");
  head.className = "col-head";
  const title = document.createElement("input");
  title.className = "col-title"; title.value = tt(STD_COL_FR[col.title] || col.title); title.spellcheck = false;
  title.addEventListener("change", () => { col.title = title.value.trim() || "Colonne"; save(); });
  const count = document.createElement("span");
  count.className = "col-count"; count.textContent = cards.length;
  head.appendChild(title);
  if (col.ai) { const b = document.createElement("span"); b.className = "col-ai-badge"; b.textContent = "IA"; head.appendChild(b); }
  head.appendChild(count);
  const menu = document.createElement("span");
  menu.className = "col-menu"; menu.innerHTML = icon("ellipsis"); menu.title = tt("Options de la colonne");
  menu.addEventListener("click", () => columnMenu(col, menu));
  head.appendChild(menu);
  el.appendChild(head);

  if (col.ai) {
    const bar = document.createElement("div");
    bar.className = "col-aibar";
    const btn = document.createElement("button");
    btn.className = "btn-soft primary";
    btn.innerHTML = icon("sparkles") + "<span></span>"; btn.lastChild.textContent = processCardsLabel(cards.length);
    btn.disabled = cards.length === 0;
    btn.addEventListener("click", () => processColumn(col));
    bar.appendChild(btn);
    el.appendChild(bar);
  }

  const list = document.createElement("div");
  list.className = "col-cards"; list.dataset.col = col.id;
  for (const card of cards) list.appendChild(renderCard(card));
  wireDropZone(list, col);
  el.appendChild(list);

  // Ajout rapide d'une carte.
  const add = document.createElement("div");
  add.className = "col-add";
  const input = document.createElement("input");
  input.placeholder = tt("+ Ajouter une carte");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) { addCard(col.id, input.value.trim()); input.value = ""; }
  });
  add.appendChild(input);
  el.appendChild(add);
  return el;
}

function renderCard(card) {
  const el = document.createElement("div");
  el.className = "card"; el.draggable = true; el.dataset.card = card.id;
  el.addEventListener("dragstart", (e) => { dragCardId = card.id; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  // Le commit se fait sur dragend (et non sur `drop`) : ainsi le déplacement est
  // toujours enregistré, même si la carte est relâchée hors d'une zone de dépôt
  // (où l'évènement `drop` ne se déclencherait pas) après avoir été déplacée
  // visuellement dans une colonne pendant le survol.
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    document.querySelectorAll(".drop-target").forEach((c) => c.classList.remove("drop-target"));
    const list = el.closest(".col-cards");
    if (list && dragCardId) commitColumnOrder(list, list.dataset.col);
    dragCardId = null;
  });
  el.addEventListener("click", () => openCard(card.id));

  const t = document.createElement("div");
  t.className = "card-title"; t.textContent = card.title;
  el.appendChild(t);
  if (card.desc) { const d = document.createElement("div"); d.className = "card-desc"; d.textContent = card.desc; el.appendChild(d); }

  // Méta visibles : étiquettes, fichier lié, échéance, agent IA assigné.
  const meta = document.createElement("div");
  meta.className = "card-meta";
  for (const l of card.labels || []) { const c = document.createElement("span"); c.className = "label-chip"; c.textContent = l; meta.appendChild(c); }
  if (card.file) { const f = document.createElement("span"); f.className = "card-file"; f.innerHTML = icon("paperclip") + "<span></span>"; f.lastChild.textContent = card.file.path.split("/").pop(); f.title = `${card.file.sandboxName} : ${card.file.path}`; meta.appendChild(f); }
  if (card.due) {
    const overdue = card.due * 1000 < Date.now() && !card.aiProcessed;
    const d = document.createElement("span"); d.className = "card-due" + (overdue ? " overdue" : "");
    d.innerHTML = icon("calendar") + "<span></span>"; d.lastChild.textContent = new Date(card.due * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    meta.appendChild(d);
  }
  if (meta.childNodes.length) el.appendChild(meta);

  const foot = document.createElement("div");
  foot.className = "card-foot";
  const left = document.createElement("div"); left.className = "card-labels";
  if ((card.comments || []).length) { const c = document.createElement("span"); c.className = "card-badge"; c.innerHTML = icon("message-circle") + `<span>${card.comments.length}</span>`; left.appendChild(c); }
  if (card.aiProcessed) { const a = document.createElement("span"); a.className = "card-ai-tag"; a.innerHTML = icon("sparkles") + "<span>IA</span>"; left.appendChild(a); }
  foot.appendChild(left);
  // Avatar agent IA (prioritaire) ou membre humain.
  const ag = agentById(card.agentId);
  if (ag) { const av = document.createElement("div"); av.className = "card-av agent-av"; av.innerHTML = icon("sparkles"); av.title = "Agent : " + ag.name; foot.appendChild(av); }
  const m = memberById(card.assignee);
  if (m) { const av = document.createElement("div"); av.className = "card-av"; av.style.background = m.color; av.textContent = initials(m.name); av.title = m.name; foot.appendChild(av); }
  el.appendChild(foot);
  return el;
}

// ===== Drag & drop =====
function wireDropZone(list, col) {
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    list.parentElement.classList.add("drop-target");
    const after = afterElement(list, e.clientY);
    const dragging = list.parentElement.parentElement.querySelector(".dragging");
    // Visuel temporaire : on déplace l'élément en cours de drag dans la liste.
    if (dragging) {
      if (after == null) list.appendChild(dragging);
      else list.insertBefore(dragging, after);
    }
  });
  list.addEventListener("dragleave", (e) => { if (!list.contains(e.relatedTarget)) list.parentElement.classList.remove("drop-target"); });
  // `drop` doit appeler preventDefault pour être autorisé ; le commit réel a lieu
  // dans `dragend` (voir renderCard) afin de couvrir aussi les lâchers hors zone.
  list.addEventListener("drop", (e) => { e.preventDefault(); list.parentElement.classList.remove("drop-target"); });
}

function afterElement(list, y) {
  const els = [...list.querySelectorAll(".card:not(.dragging)")];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function commitColumnOrder(list, colId) {
  const ids = [...list.querySelectorAll(".card")].map((el) => el.dataset.card);
  const moved = board.cards.find((c) => c.id === dragCardId);
  if (moved) moved.colId = colId;
  ids.forEach((id, i) => { const c = board.cards.find((x) => x.id === id); if (c) { c.colId = colId; c.order = i; } });
  save();
  render();
}

// ===== Opérations cartes =====
function addCard(colId, title) {
  const order = cardsIn(colId).length;
  board.cards.push({ id: uid(), colId, title, desc: "", assignee: "", agentId: "", due: null, file: null, labels: [], comments: [], aiProcessed: false, created: Date.now(), order });
  save();
  render();
}

// ===== Assistant IA (boîte de prompt partagée) =====
// L'IA pilote le tableau par outils : créer/déplacer/assigner des cartes,
// découper un projet en tâches, faire le point sur ce qui bloque.
const colByRef = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return board.columns.find((c) => c.id === ref)
    || board.columns.find((c) => tt(c.title).toLowerCase() === r || c.title.toLowerCase() === r)
    || board.columns.find((c) => c.title.toLowerCase().includes(r));
};
const cardByRef = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return board.cards.find((c) => c.id === ref)
    || board.cards.find((c) => c.title.toLowerCase() === r)
    || board.cards.find((c) => c.title.toLowerCase().includes(r));
};
const memberByRef = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return board.members.find((m) => m.id === ref) || board.members.find((m) => m.name.toLowerCase().includes(r));
};
const cardLine = (c) => {
  const col = board.columns.find((x) => x.id === c.colId);
  const who = memberById(c.assignee);
  return `${c.id} · « ${c.title} » [${col ? col.title : "?"}]`
    + (who ? ` · ${who.name}` : "") + (c.due ? ` · échéance ${c.due}` : "")
    + ((c.labels || []).length ? ` · ${c.labels.join(", ")}` : "")
    + (c.comments?.length ? ` · ${c.comments.length} commentaire(s)` : "");
};

const KANBAN_TOOLS = [
  tool("list_board", "État du tableau : colonnes, cartes, assignations, échéances.", { column: T.str("Limiter à une colonne") }),
  tool("read_card", "Détail d'une carte : description, commentaires, étiquettes.", { card: T.str("Identifiant ou titre") }, ["card"]),
  tool("create_card", "Crée une carte dans une colonne.",
    { title: T.str("Titre de la carte"), column: T.str("Colonne (titre ou identifiant), défaut : la première"),
      desc: T.str("Description"), assignee: T.str("Membre assigné"), due: T.str("Échéance AAAA-MM-JJ"),
      labels: T.list("Étiquettes") }, ["title"]),
  tool("update_card", "Modifie une carte (titre, description, étiquettes, échéance, assignation).",
    { card: T.str("Identifiant ou titre"), title: T.str(""), desc: T.str(""), assignee: T.str("Membre"),
      due: T.str("AAAA-MM-JJ"), labels: T.list("Étiquettes") }, ["card"]),
  tool("move_card", "Déplace une carte vers une colonne.", { card: T.str(""), column: T.str("Colonne cible") }, ["card", "column"]),
  tool("delete_card", "Supprime une carte.", { card: T.str("") }, ["card"]),
  tool("comment_card", "Ajoute un commentaire à une carte (analyse, plan d'action, décision).",
    { card: T.str(""), text: T.str("Contenu du commentaire") }, ["card", "text"]),
  tool("add_column", "Ajoute une colonne au tableau.", { title: T.str("Titre de la colonne") }, ["title"]),
  tool("add_member", "Ajoute un membre au tableau.", { name: T.str("Nom du membre") }, ["name"]),
  tool("breakdown_project", "Découpe un projet en cartes : crée toutes les tâches d'un coup dans une colonne.",
    { project: T.str("Nom du projet"), column: T.str("Colonne cible"),
      tasks: { type: "array", description: "Tâches dans l'ordre",
        items: { type: "object", properties: { title: T.str(""), desc: T.str(""), assignee: T.str(""), due: T.str("AAAA-MM-JJ") }, required: ["title"] } } },
    ["project", "tasks"]),
  tool("board_report", "Bilan du tableau : répartition par colonne, cartes en retard, non assignées, sans échéance.", {}),
];

async function runKanbanTool(name, a) {
  const needCard = (ref) => { const c = cardByRef(ref); if (!c) throw new Error(`aucune carte « ${ref} ». Appelle list_board.`); return c; };
  const applyFields = (card, a) => {
    if (a.title) card.title = String(a.title);
    if (a.desc != null) card.desc = String(a.desc);
    if (a.due != null) card.due = String(a.due) || null;
    if (Array.isArray(a.labels)) card.labels = a.labels.map(String);
    if (a.assignee != null) {
      const m = memberByRef(a.assignee);
      card.assignee = m ? m.id : "";
    }
  };
  switch (name) {
    case "list_board": {
      const cols = a.column ? [colByRef(a.column)].filter(Boolean) : board.columns;
      if (!cols.length) return "Colonne introuvable.";
      return cols.map((col) => {
        const cards = cardsIn(col.id);
        return `## ${col.title} (${cards.length})\n` + (cards.map(cardLine).join("\n") || "(vide)");
      }).join("\n");
    }
    case "read_card": {
      const c = needCard(a.card);
      return `${cardLine(c)}\n${c.desc || "(pas de description)"}\n`
        + (c.comments || []).map((m) => `— ${m.author} : ${m.text}`).join("\n");
    }
    case "create_card": {
      const col = a.column ? colByRef(a.column) : board.columns[0];
      if (!col) throw new Error("colonne introuvable.");
      const card = { id: uid(), colId: col.id, title: String(a.title), desc: "", assignee: "", agentId: "",
        due: null, file: null, labels: [], comments: [], aiProcessed: false, created: Date.now(), order: cardsIn(col.id).length };
      applyFields(card, a);
      board.cards.push(card);
      return `Carte créée : ${cardLine(card)}`;
    }
    case "update_card": { const c = needCard(a.card); applyFields(c, a); return `Mise à jour : ${cardLine(c)}`; }
    case "move_card": {
      const c = needCard(a.card);
      const col = colByRef(a.column);
      if (!col) throw new Error(`colonne « ${a.column} » introuvable.`);
      c.colId = col.id; c.order = cardsIn(col.id).length;
      return `Déplacée : ${cardLine(c)}`;
    }
    case "delete_card": { const c = needCard(a.card); board.cards = board.cards.filter((x) => x.id !== c.id); return `Supprimée : « ${c.title} »`; }
    case "comment_card": {
      const c = needCard(a.card);
      c.comments = c.comments || [];
      c.comments.push({ author: "IA", text: String(a.text || ""), ts: Date.now() });
      return `Commentaire ajouté à « ${c.title} ».`;
    }
    case "add_column": {
      const col = { id: uid(), title: String(a.title), ai: false };
      board.columns.push(col);
      return `Colonne « ${col.title} » ajoutée.`;
    }
    case "add_member": {
      const m = { id: uid(), name: String(a.name), color: PALETTE[board.members.length % PALETTE.length] };
      board.members.push(m);
      return `Membre « ${m.name} » ajouté.`;
    }
    case "breakdown_project": {
      const col = a.column ? colByRef(a.column) : board.columns[0];
      if (!col) throw new Error("colonne introuvable.");
      const tasks = Array.isArray(a.tasks) ? a.tasks : [];
      if (!tasks.length) throw new Error("aucune tâche fournie.");
      const made = tasks.map((t, i) => {
        const card = { id: uid(), colId: col.id, title: String(t.title || `Tâche ${i + 1}`), desc: String(t.desc || ""),
          assignee: "", agentId: "", due: t.due ? String(t.due) : null, file: null,
          labels: [String(a.project)], comments: [], aiProcessed: false, created: Date.now(), order: cardsIn(col.id).length + i };
        if (t.assignee) { const m = memberByRef(t.assignee); if (m) card.assignee = m.id; }
        board.cards.push(card);
        return card;
      });
      return `Projet « ${a.project} » découpé en ${made.length} cartes dans « ${col.title} » :\n` + made.map(cardLine).join("\n");
    }
    case "board_report": {
      const now = new Date().toISOString().slice(0, 10);
      const late = board.cards.filter((c) => c.due && c.due < now && c.colId !== doneColumnId());
      const unassigned = board.cards.filter((c) => !c.assignee);
      const noDue = board.cards.filter((c) => !c.due);
      return board.columns.map((c) => `${c.title} : ${cardsIn(c.id).length}`).join(" · ")
        + `\nEn retard (${late.length}) : ${late.map((c) => c.title).join(", ") || "aucune"}`
        + `\nNon assignées (${unassigned.length}) · Sans échéance (${noDue.length})`;
    }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountKanbanAI() {
  mountAiPrompt(null, {
    app: "Kanban",
    intro: "Tu pilotes le tableau de l'utilisateur : cartes, colonnes, assignations, échéances, suivi.",
    rules: "- Appelle list_board avant toute modification pour connaître colonnes et identifiants.\n- Pour un projet entier, utilise breakdown_project une seule fois plutôt que create_card en boucle.\n- Les analyses de carte se déposent en commentaire (comment_card), jamais seulement dans ta réponse.",
    placeholder: "Ex. : découpe la refonte du site en tâches et assigne-les…",
    suggestions: [
      { label: "Découper un projet", prompt: "Découpe un projet en tâches concrètes dans la première colonne. Demande-moi le projet si tu ne le connais pas." },
      { label: "Faire le point", prompt: "Fais le bilan du tableau : ce qui est en retard, non assigné, sans échéance, et ce qu'il faut faire en priorité." },
      { label: "Analyser les cartes", prompt: "Pour chaque carte de la première colonne, propose un plan d'action et dépose-le en commentaire." },
      { label: "Ranger", prompt: "Repère les cartes terminées ou en doublon et range le tableau." },
    ],
    tools: KANBAN_TOOLS,
    context: () => board.columns.map((col) => `${col.title} (${cardsIn(col.id).length}) : `
      + cardsIn(col.id).slice(0, 12).map((c) => c.title).join(", ")).join("\n")
      + `\nMembres : ${board.members.map((m) => m.name).join(", ")}`,
    execute: runKanbanTool,
    onApplied: () => { save(); render(); },
  });
}

// ===== Traitement IA =====
async function processColumn(col) {
  const cards = cardsIn(col.id);
  if (!cards.length) return;
  const target = doneColumnId();
  toast(`${tt("Traitement IA en cours…")} (${cards.length})`);
  for (const card of cards) {
    try {
      const out = await aiProcessCard(card);
      card.comments = card.comments || [];
      card.comments.push({ author: "IA", text: out, ts: Date.now() });
      card.aiProcessed = true;
      // Une fois traitée, la carte part dans « Fait » (sauf si elle y est déjà).
      if (target && card.colId !== target) { card.colId = target; card.order = cardsIn(target).length; }
      save(); render();
    } catch (e) {
      toast(tt("IA indisponible :") + " " + (e?.message || e), true);
      break;
    }
  }
  toast(tt("Traitement IA terminé."));
}

async function aiProcessCard(card) {
  const { messages } = PROMPTS["app.kanban.card"].build({ instruction: board.aiInstruction, title: card.title, desc: card.desc || "", lang: replyLang() });
  return (await ollama(messages)).trim();
}

// Appel LLM unifié (Ollama natif OU API cloud OpenAI, config partagée avec la barre).
async function ollama(messages) {
  const { content: out, data } = await llmChat(messages, { rawSystem: true });
  recordOllamaUsage(data, "kanban");
  return out || `(${tt("Réponse vide").toLowerCase()})`;
}

// ===== Détail d'une carte =====
let openCardId = null;
async function openCard(id) {
  const card = board.cards.find((c) => c.id === id);
  if (!card) return;
  openCardId = id;
  $("#cm-title").value = card.title;
  $("#cm-desc").value = card.desc || "";
  $("#cm-labels").value = (card.labels || []).join(", ");
  const sel = $("#cm-assignee");
  sel.innerHTML = `<option value="">${tt("— Personne —")}</option>` + board.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  sel.value = card.assignee || "";

  // Agent IA assignable.
  const agSel = $("#cm-agent");
  agSel.innerHTML = `<option value="">${tt("— Aucun agent —")}</option>` + agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
  agSel.value = card.agentId || "";
  $("#cm-due").value = dueSecsToDate(card.due);

  // Sélecteur sandbox + fichier.
  const sbSel = $("#cm-file-sandbox");
  sbSel.innerHTML = `<option value="">${tt("— Aucune —")}</option>` + sandboxes.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  sbSel.value = card.file?.sandboxId || "";
  await populateFileSelect(card.file?.sandboxId || "", card.file?.path || "");

  $("#cm-airesult").hidden = true;
  $("#cm-ai-state").textContent = "";
  renderComments(card);
  $("#card-overlay").hidden = false;
}

// Liste (à plat) les fichiers d'une sandbox pour le sélecteur de fichier lié.
// Récursif sur 2 niveaux pour rester léger ; mémoïsé par sandbox.
async function listSandboxFiles(id) {
  if (fileCache[id]) return fileCache[id];
  const out = [];
  async function walk(path, depth) {
    let entries = [];
    try { entries = await invoke("sandbox_read_dir", { id, path }); } catch { return; }
    for (const e of entries) {
      if (e.is_dir) { if (depth < 2) await walk(e.path, depth + 1); }
      else out.push(e.path);
    }
  }
  await walk("", 0);
  fileCache[id] = out;
  return out;
}

async function populateFileSelect(sandboxId, selected) {
  const sel = $("#cm-file-path");
  if (!sandboxId) { sel.innerHTML = `<option value="">${tt("— Aucun —")}</option>`; sel.disabled = true; return; }
  sel.disabled = false;
  const files = await listSandboxFiles(sandboxId);
  sel.innerHTML = `<option value="">${tt("— Aucun —")}</option>` + files.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  sel.value = selected || "";
}

function renderComments(card) {
  const box = $("#cm-comments");
  box.innerHTML = "";
  for (const c of card.comments || []) {
    const el = document.createElement("div");
    el.className = "comment";
    el.innerHTML = `<div class="comment-meta">${escapeHtml(c.author)} · ${fmtTime(c.ts)}</div><div class="comment-text"></div>`;
    el.querySelector(".comment-text").textContent = c.text;
    box.appendChild(el);
  }
}

function currentCard() { return board.cards.find((c) => c.id === openCardId); }

function commitCardModal() {
  const card = currentCard(); if (!card) return;
  const prevAgent = card.agentId;
  card.title = $("#cm-title").value.trim() || tt("Sans titre");
  card.desc = $("#cm-desc").value;
  card.assignee = $("#cm-assignee").value;
  card.labels = $("#cm-labels").value.split(",").map((s) => s.trim()).filter(Boolean);
  card.agentId = $("#cm-agent").value;
  card.due = dateToDueSecs($("#cm-due").value);
  const sbId = $("#cm-file-sandbox").value;
  const path = $("#cm-file-path").value;
  card.file = sbId && path ? { sandboxId: sbId, sandboxName: sandboxes.find((s) => s.id === sbId)?.name || "", path } : null;
  syncAgentTask(card, prevAgent);
  save(); render();
}

// Reflète l'assignation de la carte dans la todo de l'agent IA (création/maj/retrait).
async function syncAgentTask(card, prevAgent) {
  const tid = taskIdFor(card.id);
  // Agent changé → retire l'ancienne tâche.
  if (prevAgent && prevAgent !== card.agentId) {
    try { await invoke("agent_remove_task", { agentId: prevAgent, taskId: tid }); } catch {}
  }
  if (!card.agentId) return;
  // Texte de la tâche : titre, description et fichier à travailler (versionné).
  let text = card.title;
  if (card.desc) text += `\n${card.desc}`;
  if (card.file) text += `\n[Fichier à traiter — sandbox « ${card.file.sandboxName} » : ${card.file.path}]`;
  try {
    await invoke("agent_add_task", { agentId: card.agentId, taskId: tid, text, due: card.due ?? null });
    toast(`Tâche envoyée à l'agent « ${agentById(card.agentId)?.name || ""} ».`);
  } catch (e) { toast(tt("Échec :") + " " + (e?.message || e), true); }
}

function closeCard() { if (openCardId) commitCardModal(); openCardId = null; $("#card-overlay").hidden = true; }

// ===== Membres / colonnes =====
async function addMember() {
  const name = await promptSheet({ title: tt("Nom du membre :"), placeholder: tt("Prénom Nom") });
  if (!name || !name.trim()) return;
  board.members.push({ id: uid(), name: name.trim(), color: PALETTE[board.members.length % PALETTE.length] });
  save(); render();
}

/**
 * Menu d'une colonne : un vrai menu déroulant sous le bouton « ⋯ » (façon
 * DropdownMenu de shadcn), à la place de l'ancien `prompt()` « tapez 1 ou 2 »
 * — qui, dans la webview, ne s'affichait même pas.
 */
function columnMenu(col, anchor) {
  const pop = $("#col-popover");
  const close = () => { pop.hidden = true; document.removeEventListener("pointerdown", onOutside, true); document.removeEventListener("keydown", onKey, true); };
  const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  if (!pop.hidden && pop.dataset.col === col.id) { close(); return; }
  pop.dataset.col = col.id;
  pop.innerHTML = `
    <div class="pop-title">${escapeHtml(tt(STD_COL_FR[col.title] || col.title))}</div>
    <button class="pop-item" data-act="ai">${icon(col.ai ? "sparkles" : "wand-sparkles")}<span>${escapeHtml(col.ai ? tt("Retirer le rôle « à traiter par l'IA »") : tt("Définir comme colonne « à traiter par l'IA »"))}</span></button>
    <div class="pop-sep"></div>
    <button class="pop-item danger" data-act="delete">${icon("trash-2")}<span>${escapeHtml(tt("Supprimer la colonne"))}</span></button>`;
  const r = anchor.getBoundingClientRect();
  pop.hidden = false;
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.querySelector('[data-act="ai"]').addEventListener("click", () => { close(); col.ai = !col.ai; save(); render(); });
  pop.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    close();
    if (board.columns.length <= 1) return toast(tt("Impossible de supprimer la dernière colonne."), true);
    const n = board.cards.filter((c) => c.colId === col.id).length;
    const ok = await confirmSheet({
      title: `${tt("Supprimer la colonne")} « ${tt(STD_COL_FR[col.title] || col.title)} » ?`,
      body: n ? `${n} ${tt("carte(s) seront supprimées avec elle.")}` : "",
      confirm: tt("Supprimer"), danger: true,
    });
    if (!ok) return;
    board.cards = board.cards.filter((c) => c.colId !== col.id);
    board.columns = board.columns.filter((c) => c.id !== col.id);
    save(); render();
  });
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
}

function addColumn() {
  board.columns.push({ id: uid(), title: "Nouvelle colonne", ai: false });
  save(); render();
}

// ===== Utilitaires =====
function initials(name) { return (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase(); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function fmtTime(ms) { try { return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }); } catch { return ""; } }
let toastTimer = null;
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (error ? " error" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ===== Câblage =====
function wire() {
  $("#board-name").addEventListener("change", (e) => { board.name = e.target.value.trim() || "Tableau"; save(); });
  $("#btn-add-column").addEventListener("click", addColumn);
  $("#btn-add-member").addEventListener("click", addMember);
  $("#btn-instruction").addEventListener("click", () => { $("#instr-text").value = board.aiInstruction; $("#instr-overlay").hidden = false; });

  $("#instr-cancel").addEventListener("click", () => $("#instr-overlay").hidden = true);
  $("#instr-save").addEventListener("click", () => { board.aiInstruction = $("#instr-text").value.trim() || defaultBoard().aiInstruction; save(); $("#instr-overlay").hidden = true; toast(tt("Consigne IA enregistrée.")); });

  $("#cm-close").addEventListener("click", closeCard);
  $("#card-overlay").addEventListener("click", (e) => { if (e.target.id === "card-overlay") closeCard(); });
  $("#cm-delete").addEventListener("click", async () => {
    const card = currentCard(); if (!card) return;
    if (!(await confirmSheet({ title: `${tt("Supprimer la carte")} « ${card.title} » ?`, confirm: tt("Supprimer"), danger: true }))) return;
    if (card.agentId) invoke("agent_remove_task", { agentId: card.agentId, taskId: taskIdFor(card.id) }).catch(() => {});
    board.cards = board.cards.filter((c) => c.id !== card.id);
    openCardId = null; $("#card-overlay").hidden = true; save(); render();
  });
  // Choisir un agent propose par défaut sa sandbox attribuée (ses écritures y
  // sont versionnées) si aucun fichier n'est encore lié.
  $("#cm-agent").addEventListener("change", async () => {
    const ag = agentById($("#cm-agent").value);
    if (ag?.sandbox_id && !$("#cm-file-sandbox").value) {
      $("#cm-file-sandbox").value = ag.sandbox_id;
      await populateFileSelect(ag.sandbox_id, "");
    }
  });
  $("#cm-file-sandbox").addEventListener("change", () => populateFileSelect($("#cm-file-sandbox").value, ""));
  $("#cm-comment-add").addEventListener("click", addComment);
  $("#cm-comment-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addComment(); });
  $("#cm-ai-run").addEventListener("click", async () => {
    const card = currentCard(); if (!card) return;
    commitCardModal();
    $("#cm-ai-state").textContent = tt("Réflexion…");
    try {
      const out = await aiProcessCard(card);
      card.comments = card.comments || [];
      card.comments.push({ author: "IA", text: out, ts: Date.now() });
      card.aiProcessed = true;
      const target = doneColumnId();
      if (target && card.colId !== target) { card.colId = target; card.order = cardsIn(target).length; }
      save();
      $("#cm-airesult").hidden = false; $("#cm-airesult").textContent = out;
      $("#cm-ai-state").textContent = "";
      renderComments(card); render();
    } catch (e) { $("#cm-ai-state").textContent = tt("Échec :") + " " + (e?.message || e); }
  });
}

function addComment() {
  const card = currentCard(); if (!card) return;
  const input = $("#cm-comment-input");
  const text = input.value.trim(); if (!text) return;
  const me = board.members[0];
  card.comments = card.comments || [];
  card.comments.push({ author: me?.name || "Moi", text, ts: Date.now() });
  input.value = "";
  save(); renderComments(card); render();
}

// ===== Démarrage + collaboration =====
async function loadAgentsAndSandboxes() {
  try { agents = await invoke("agent_list"); } catch { agents = []; }
  try { sandboxes = await invoke("sandbox_list"); } catch { sandboxes = []; }
}

async function init() {
  await load();
  await loadAgentsAndSandboxes();
  wire();
  render();
  mountKanbanAI();
  // « Envoyer vers Tempo » : une tâche ou un texte devient une carte.
  receive("kanban", async (obj) => {
    const text = toText(obj).trim();
    const [first, ...rest] = text.split(/\n/);
    await runKanbanTool("create_card", {
      title: (obj.kind === "task" ? obj.text : (obj.title || first)).slice(0, 120),
      desc: obj.kind === "task" ? "" : rest.join("\n").trim(),
      due: obj.due || "",
    });
    save(); render();
    toast(tt("Carte créée depuis {src}", { src: obj.meta?.sourceTitle || obj.meta?.sourceApp || "Lumen" }));
  });
  // Synchronisation collaborative : un autre fenêtre/appareil a enregistré → on
  // recharge (sauf si c'est notre propre écho).
  listen("kanban-updated", (e) => {
    const { data, origin } = e.payload || {};
    if (origin === ME || !data) return;
    try {
      board = JSON.parse(data);
      // Ne pas écraser une carte en cours d'édition visuelle de façon brutale :
      // on re-rend, et la modale ouverte se rafraîchira au prochain commit.
      render();
      if (openCardId && !board.cards.find((c) => c.id === openCardId)) { openCardId = null; $("#card-overlay").hidden = true; }
      toast(tt("Tableau mis à jour (collaboration)."));
    } catch {}
  });
}
init();
