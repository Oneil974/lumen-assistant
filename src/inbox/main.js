// Messagerie interne — logique front. Charge les messages (inbox_load), gère
// lu/non-lu + suppression (inbox_save), et la réponse : créer une tâche dans la
// todo de l'agent expéditeur via agent_add_task, avec l'historique utile du
// message d'origine + la demande de l'utilisateur. Se rafraîchit sur l'évènement
// `inbox-updated` émis quand un agent poste un nouveau message.

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const { listen } = __TAURI.event || {};

import { translatePage, tt, observeTranslations } from "../apps-i18n.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";
import { agentAvatarHTML } from "../lib/agent-avatar.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";

let messages = [];
let currentId = null;
let filter = "all";
let agents = [];

const $ = (id) => document.getElementById(id);

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dateToDue(str) {
  if (!str) return null;
  const [y, m, d] = String(str).split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
}

function dueLabel(due) {
  if (due == null) return "";
  return new Date(due * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
}

// Coupe proprement : sur un blanc quand il y en a un près de la fin, pour ne pas
// laisser un mot tranché en deux.
function clip(s, max) {
  const str = String(s ?? "").trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.8 ? cut.slice(0, space) : cut) + "…";
}

function parseTaskPlan(raw) {
  try { return JSON.parse(raw); } catch {}
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return { task: String(raw || "").trim(), due: null };
}

// L'expéditeur d'un message est sérialisé `fromId` par le Rust (`#[serde(rename)]`
// sur `Message::from_id`), alors que ce front lisait `m.from_id` : la valeur
// était donc toujours `undefined`, et TOUTE réponse à un agent était refusée
// avec « Expéditeur non lié à un agent ». On normalise à la lecture, en
// acceptant les deux graphies — d'anciennes boîtes ont pu être écrites dans un
// sens comme dans l'autre — et `fromId` reste la clé écrite sur le disque.
function normalizeMessage(m) {
  const id = m.fromId || m.from_id || "";
  return { ...m, fromId: id, from_id: id };
}

async function loadInbox() {
  try {
    const raw = await invoke("inbox_load");
    messages = (raw ? JSON.parse(raw) : []).map(normalizeMessage);
  } catch { messages = []; }
  // Les fiches d'agents donnent leur avatar aux messages qu'ils ont envoyés.
  if (!agents.length) { try { agents = (await invoke("agent_list")) || []; } catch { agents = []; } }
  renderList();
  if (currentId && !messages.find((m) => m.id === currentId)) { currentId = null; showReader(); }
}
async function persist() { try { await invoke("inbox_save", { data: JSON.stringify(messages) }); } catch {} }

// ===== Assistant IA (boîte de prompt partagée) =====
// La boîte se traite au prompt : trier, résumer, marquer lu, supprimer, et
// surtout déléguer — chaque demande devient une tâche dans la todo d'un agent.
const msgByRef = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return messages.find((m) => m.id === ref)
    || messages.find((m) => String(m.subject || "").toLowerCase() === r)
    || messages.find((m) => String(m.subject || "").toLowerCase().includes(r));
};
const agentByRef = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return agents.find((a) => a.id === ref) || agents.find((a) => String(a.name || "").toLowerCase().includes(r));
};
const msgLine = (m) => `${m.id} · ${m.read ? "lu" : "NON LU"} · de ${m.from} — « ${m.subject || "(sans objet)"} »`;

const INBOX_TOOLS = [
  tool("list_messages", "Liste les messages de la boîte.", { unread_only: T.bool("Seulement les non lus"), query: T.str("Filtre texte") }),
  tool("read_message", "Lit un message en entier.", { message: T.str("Identifiant ou objet") }, ["message"]),
  tool("mark_read", "Marque un message comme lu ou non lu.", { message: T.str(""), read: T.bool("Défaut : lu") }, ["message"]),
  tool("delete_message", "Supprime un message.", { message: T.str("") }, ["message"]),
  tool("list_agents", "Liste les agents disponibles à qui déléguer.", {}),
  tool("delegate", "Crée une tâche dans la todo d'un agent (délégation).",
    { agent: T.str("Nom ou identifiant de l'agent"), task: T.str("Consigne claire et autonome"), due: T.str("Date d'exécution AAAA-MM-JJ (optionnel)") },
    ["agent", "task"]),
  tool("post_message", "Dépose un message dans la boîte (note, récapitulatif, synthèse).",
    { subject: T.str(""), body: T.str(""), from: T.str("Expéditeur affiché, défaut : Assistant") }, ["subject", "body"]),
];

async function runInboxTool(name, a) {
  const need = (ref) => { const m = msgByRef(ref); if (!m) throw new Error(`aucun message « ${ref} ». Appelle list_messages.`); return m; };
  switch (name) {
    case "list_messages": {
      const q = String(a.query || "").toLowerCase();
      const items = messages.filter((m) => (!a.unread_only || !m.read)
        && (!q || `${m.subject} ${m.from} ${m.body}`.toLowerCase().includes(q)));
      return items.length ? items.map(msgLine).join("\n") : "Boîte vide.";
    }
    case "read_message": { const m = need(a.message); m.read = true; return `De ${m.from} — « ${m.subject} »\n\n${m.body || "(vide)"}`; }
    case "mark_read": { const m = need(a.message); m.read = a.read !== false; return `${m.subject} : ${m.read ? "lu" : "non lu"}.`; }
    case "delete_message": { const m = need(a.message); messages = messages.filter((x) => x.id !== m.id); if (currentId === m.id) currentId = null; return `Supprimé : « ${m.subject} »`; }
    case "list_agents": {
      if (!agents.length) { try { agents = await invoke("agent_list"); } catch {} }
      return agents.length ? agents.map((x) => `${x.id} · ${x.name}`).join("\n") : "Aucun agent disponible.";
    }
    case "delegate": {
      if (!agents.length) { try { agents = await invoke("agent_list"); } catch {} }
      const ag = agentByRef(a.agent);
      if (!ag) throw new Error("agent introuvable ; appelle list_agents.");
      const due = a.due ? Math.floor(Date.parse(String(a.due) + "T09:00:00") / 1000) : null;
      await invoke("agent_add_task", { agentId: ag.id, taskId: "inbox-" + Date.now().toString(36), text: String(a.task), due });
      return `Tâche confiée à ${ag.name} : « ${a.task} »${a.due ? ` (pour le ${a.due})` : ""}`;
    }
    case "post_message": {
      await invoke("inbox_post", { from: String(a.from || "Assistant"), fromId: "", subject: String(a.subject), body: String(a.body) });
      return `Message déposé : « ${a.subject} »`;
    }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountInboxAI() {
  mountAiPrompt(null, {
    app: "Messagerie",
    intro: "Tu traites la boîte de réception : tri, lecture, synthèse, et délégation de tâches aux agents.",
    rules: "- Lis les messages concernés (read_message) avant de résumer ou de déléguer.\n- Une tâche déléguée doit être autonome : rappelle le contexte utile dans son texte.",
    placeholder: "Ex. : résume mes non-lus et confie le suivi à l'agent Veille…",
    suggestions: [
      { label: "Résumer les non-lus", prompt: "Résume mes messages non lus en une liste de points, et dis-moi ce qui demande une action." },
      { label: "Déléguer", prompt: "Pour chaque message qui demande un suivi, crée une tâche chez l'agent le plus pertinent." },
      { label: "Faire le ménage", prompt: "Marque comme lus les messages sans action et supprime les doublons." },
    ],
    tools: INBOX_TOOLS,
    context: () => `${messages.length} message(s), ${messages.filter((m) => !m.read).length} non lus :\n`
      + messages.slice(0, 20).map(msgLine).join("\n"),
    execute: runInboxTool,
    onApplied: async () => { await persist(); renderList(); },
  });
}

// ===== Liste =====
function renderList() {
  const list = $("msg-list");
  list.textContent = "";
  const items = messages.filter((m) => filter === "all" || !m.read);
  for (const m of items) {
    const el = document.createElement("div");
    el.className = "msg-item" + (m.id === currentId ? " active" : "");
    el.innerHTML =
      `<span class="dot ${m.read ? "read" : ""}"></span>` +
      `<div class="mi-main"><div class="mi-from"><span></span><span class="t"></span></div>` +
      `<div class="mi-subject"></div><div class="mi-prev"></div></div>`;
    el.querySelector(".mi-from span").textContent = m.from || "Agent";
    // Message d'un agent : son avatar devant son nom.
    const author = m.fromId && agents.find((a) => a.id === m.fromId);
    if (author) el.querySelector(".mi-from").insertAdjacentHTML("afterbegin", `<span class="mi-av" style="display:inline-grid;margin:-3px 6px -3px 0">${agentAvatarHTML(author, { size: 20, hands: false, animate: false })}</span>`);
    el.querySelector(".t").textContent = relTime(m.ts);
    el.querySelector(".mi-subject").textContent = m.subject || "(sans objet)";
    el.querySelector(".mi-prev").textContent = (m.body || "").replace(/\s+/g, " ").slice(0, 70);
    el.addEventListener("click", () => openMsg(m.id));
    list.appendChild(el);
  }
  const unread = messages.filter((m) => !m.read).length;
  $("unread").textContent = unread ? String(unread) : "";
  if (!items.length) list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted)">Aucun message.</div>`;
}

function openMsg(id) {
  currentId = id;
  const m = current();
  if (m && !m.read) { m.read = true; persist(); }
  showReader(); renderList();
}
function current() { return messages.find((m) => m.id === currentId) || null; }

function showReader() {
  const m = current();
  $("reader-empty").hidden = !!m;
  $("reader-content").hidden = !m;
  if (!m) return;
  $("rd-subject").textContent = m.subject || "(sans objet)";
  $("rd-meta").textContent = `De ${m.from || "Agent"} · ${new Date(m.ts * 1000).toLocaleString()}`;
  $("rd-body").textContent = m.body || "";
  $("reply-text").value = "";
  $("reply-date").value = "";
  $("reply-state").textContent = "";
  const canReply = !!m.fromId;
  $("btn-reply").disabled = !canReply;
  $("reply-date").disabled = !canReply;
  $("reply-state").textContent = canReply ? "" : "Expéditeur non lié à un agent — réponse impossible.";
}

async function deleteMsg() {
  if (!currentId) return;
  messages = messages.filter((m) => m.id !== currentId);
  currentId = null;
  await persist(); renderList(); showReader();
}

// ===== Réponse -> tâche d'agent =====
async function reply() {
  const m = current();
  if (!m || !m.fromId) return;
  const text = $("reply-text").value.trim();
  if (!text) { toast("Écrivez votre demande."); return; }
  const due = dateToDue($("reply-date").value);
  $("reply-state").textContent = "Création de la tâche…";

  // Contexte utile reconstitué pour l'agent : la demande D'ABORD, l'historique
  // ensuite. L'ordre inverse mettait le rappel du message en tête, si bien que
  // la tâche s'intitulait « Suite à ton message… » suivi de tout le compte rendu
  // précédent : illisible dans la todo, dans le Kanban et dans le journal, alors
  // que la seule chose à lire tient en une ligne.
  //
  // Le résultat précédent est tronqué : il peut faire plusieurs pages, et il
  // n'est là que pour rappeler de quoi on parle — l'agent a sa mémoire et sa
  // sandbox pour le reste.
  const t = m.task || {};
  const previous = clip(t.output || m.body || "", 1200);
  const context =
    `${text}\n\n---\nContexte — réponse à ton message « ${m.subject} ».` +
    (t.task ? `\nTâche d'origine : ${t.task}` : "") +
    (previous ? `\n${t.output ? "Ton résultat précédent" : "Message précédent"} :\n${previous}` : "");

  try {
    const taskId = "inbox-" + Date.now().toString(36);
    await invoke("agent_add_task", { agentId: m.fromId, taskId, text: context, due });
    $("reply-state").textContent = "";
    toast(due != null
      ? `Tâche créée pour ${m.from} — exécution le ${dueLabel(due)}.`
      : `Tâche créée pour ${m.from}.`);
    $("reply-text").value = "";
    $("reply-date").value = "";
  } catch (e) {
    $("reply-state").textContent = "";
    toast("Échec : " + (e.message || e));
  }
}

// ===== Composer : nouveau message -> tâche d'agent (via IA) =====
async function openCompose() {
  try { agents = await invoke("agent_list"); } catch { agents = []; }
  const sel = $("compose-agent");
  sel.innerHTML = "";
  if (!agents.length) {
    sel.innerHTML = `<option value="">Aucun agent — créez-en un d'abord</option>`;
  } else {
    for (const a of agents) {
      const o = document.createElement("option");
      o.value = a.id; o.textContent = a.name || a.id; sel.appendChild(o);
    }
  }
  $("compose-subject").value = "";
  $("compose-body").value = "";
  $("compose-state").textContent = "";
  $("compose-send").disabled = !agents.length;
  $("compose-overlay").hidden = false;
  $("compose-body").focus();
}

async function sendCompose() {
  const agentId = $("compose-agent").value;
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) { toast("Sélectionnez un agent."); return; }
  const subject = $("compose-subject").value.trim();
  const body = $("compose-body").value.trim();
  if (!body) { toast("Écrivez votre message."); return; }
  $("compose-state").textContent = "L'IA prépare la tâche…";

  let taskText = body;
  let due = null;
  try {
    // L'IA reformule la demande en une tâche claire et extrait une date
    // d'exécution si l'utilisateur en donne une explicitement ou relativement.
    const { messages, opts } = PROMPTS["app.inbox.task"].build({ request: (subject ? `Objet : ${subject}\n` : "") + body, today: todayIso(), lang: replyLang() });
    const { content, data } = await llmChat(messages, { ...opts, rawSystem: true });
    recordOllamaUsage(data, "inbox");
    const plan = parseTaskPlan(content);
    if (plan.task && String(plan.task).trim()) taskText = String(plan.task).trim();
    due = dateToDue(plan.due);
  } catch (e) {
    // Pas d'IA dispo : on retombe sur le texte brut (la tâche est quand même créée).
    taskText = (subject ? subject + " — " : "") + body;
  }

  try {
    const taskId = "inbox-" + Date.now().toString(36);
    await invoke("agent_add_task", { agentId, taskId, text: taskText, due });
    // Trace dans la boîte : un message « envoyé » récapitulant la tâche créée.
    try {
      await invoke("inbox_post", {
        from: "Vous → " + (agent.name || agentId),
        fromId: agentId,
        subject: subject || "Tâche envoyée",
        body: `Demande : ${body}\n\nTâche créée pour ${agent.name || agentId} :\n${taskText}${due != null ? `\n\nDate d'exécution : ${dueLabel(due)}` : ""}`,
      });
    } catch {}
    $("compose-overlay").hidden = true;
    toast(`Tâche envoyée à ${agent.name || agentId}.`);
    await loadInbox();
  } catch (e) {
    $("compose-state").textContent = "";
    toast("Échec : " + (e.message || e));
  }
}

// ===== Divers =====
function relTime(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "à l'instant";
  if (s < 3600) return Math.floor(s / 60) + " min";
  if (s < 86400) return Math.floor(s / 3600) + " h";
  return new Date(ts * 1000).toLocaleDateString();
}
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2800);
}

// ===== Démarrage =====
function init() {
  translatePage();
  observeTranslations();
  document.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => {
      filter = c.dataset.filter;
      document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("active", x === c));
      renderList();
    }));
  $("btn-del").addEventListener("click", deleteMsg);
  $("btn-reply").addEventListener("click", reply);
  $("btn-compose").addEventListener("click", openCompose);
  $("compose-cancel").addEventListener("click", () => ($("compose-overlay").hidden = true));
  $("compose-send").addEventListener("click", sendCompose);
  loadInbox();
  mountInboxAI();
  if (listen) listen("inbox-updated", loadInbox);
}
init();
