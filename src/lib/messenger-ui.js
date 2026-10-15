// Messages — l'interface « messagerie » de Lumen (compagnon web, fenêtre du
// bureau, app de Lumen OS). Une liste de discussions façon Messenger, un
// contact par discussion (Lumen ou un agent, avec son avatar), des bulles,
// les appels d'outils montrés sobrement, et la coupure de contexte.
//
// Le moteur vit dans l'ordinateur (src-tauri/src/messenger.rs) ; ce module ne
// fait qu'afficher. Il reçoit un TRANSPORT qui masque d'où viennent les
// données (HTTP pour le téléphone, invoke() sur le bureau) :
//
//   contacts() threads() thread(id) create(contact) send(thread, text, images)
//   cut(thread) stop(thread) remove(thread) update(thread, patch)
//   fileUrl(id) → Promise<string>        onEvent(cb) → désabonnement
//   voice? (facultatif) : { prepare?(onPct), listen({signal,onLevel,onPartial})
//          → Promise<texte>, speak(texte,{signal,voice}) → Promise, stop() }
//          `voice` = voix de l'agent (« local:<id> » | « system:<nom> » | "").
//   tools?(thread) → Promise<[{name, description}]> : menu « @ » (outils
//          imposés au tour, cf. messenger.rs::mentioned_tools).
//   update(thread, { orchestrate }) : bouton « forcer la réponse orchestrée ».
//          — présent = bouton « mode vocal » (cf. lib/voice-adapters.js).
//
// Aucune dépendance autre que les avatars, les icônes et le texte des étapes.

import { latestRender } from "./companion-performance.js";
import { confirmSheet, promptSheet } from "./confirm.js";
import { agentAvatarHTML } from "./agent-avatar.js";
import { icon } from "./icons.js";
import { humanStep } from "./agent-steps.js";

const T = {
  fr: {
    title: "Messages", search: "Rechercher", newChat: "Nouvelle discussion", contacts: "Démarrer avec…",
    empty: "Aucune discussion pour l'instant.", emptyHint: "Choisis Lumen ou un agent ci-dessus pour commencer.",
    you: "Vous", typing: "écrit…", online: "Assistant", agent: "Agent",
    placeholder: "Message", send: "Envoyer", stop: "Arrêter", photo: "Photo",
    cut: "Couper le contexte", cutDone: "Contexte coupé — la suite repart de zéro",
    cutHint: "Lumen ne tiendra plus compte de ce qui précède.",
    rename: "Renommer", pin: "Épingler", unpin: "Désépingler", del: "Supprimer la discussion",
    delConfirm: "Supprimer cette discussion ?", renamePrompt: "Nom de la discussion",
    back: "Retour", more: "Plus", failed: "Échec", done: "fait", running: "en cours…",
    now: "à l'instant", yesterday: "hier", locked: "Une autre session est ouverte sur l'ordinateur : lecture seule.",
    starters: ["Quel temps fait-il ?", "Qu'ai-je au programme aujourd'hui ?", "Résume mes derniers mails", "Rappelle-moi d'appeler Léa demain à 10 h"],
    agentStarters: ["Que sais-tu faire ?", "Au travail !", "Fais le point"],
    close: "Fermer",
    voice: "Mode vocal", vListen: "Je vous écoute…", vThink: "Réflexion…", vSpeak: "Touchez pour interrompre",
    vLoad: "Préparation de la voix…", vMuted: "Micro coupé", vMute: "Couper le micro", vUnmute: "Réactiver le micro",
    vEnd: "Terminer", vErr: "Micro indisponible",
    orchOn: "Réponse orchestrée forcée (cliquer pour laisser le routeur décider)",
    orchOff: "Routeur automatique — cliquer pour forcer la réponse orchestrée",
    plan: "Plan de la réponse", check: "Vérification de la réponse", atHead: "Outils — ↑↓ puis Entrée",
  },
  en: {
    title: "Messages", search: "Search", newChat: "New chat", contacts: "Start with…",
    empty: "No chats yet.", emptyHint: "Pick Lumen or an agent above to start.",
    you: "You", typing: "typing…", online: "Assistant", agent: "Agent",
    placeholder: "Message", send: "Send", stop: "Stop", photo: "Photo",
    cut: "Cut context", cutDone: "Context cut — what follows starts fresh",
    cutHint: "Lumen will ignore everything above.",
    rename: "Rename", pin: "Pin", unpin: "Unpin", del: "Delete chat",
    delConfirm: "Delete this chat?", renamePrompt: "Chat name",
    back: "Back", more: "More", failed: "Failed", done: "done", running: "running…",
    now: "now", yesterday: "yesterday", locked: "Another session is open on the computer: read only.",
    starters: ["What's the weather?", "What's on my plate today?", "Summarize my latest emails", "Remind me to call Lea tomorrow at 10"],
    agentStarters: ["What can you do?", "Get to work!", "Give me an update"],
    close: "Close",
    voice: "Voice mode", vListen: "Listening…", vThink: "Thinking…", vSpeak: "Tap to interrupt",
    vLoad: "Getting the voice ready…", vMuted: "Mic muted", vMute: "Mute mic", vUnmute: "Unmute mic",
    vEnd: "End", vErr: "Microphone unavailable",
    orchOn: "Orchestrated answer forced (click to let the router decide)",
    orchOff: "Automatic router — click to force an orchestrated answer",
    plan: "Answer plan", check: "Answer check", atHead: "Tools — ↑↓ then Enter",
  },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Markdown minimal et sûr (gras, italique, code, liens, listes, titres). */
export function miniMarkdown(src) {
  const blocks = [];
  let text = esc(src || "").replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/^\w*\n/, "")}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = [];
  let list = null;
  for (const line of text.split("\n")) {
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) {
      if (!list) { list = /^\s*\d/.test(line) ? "ol" : "ul"; out.push(`<${list}>`); }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push(`<p><b>${inline(h[1])}</b></p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

/** Visage d'un contact : l'orbe de Lumen ou l'avatar de l'agent. */
function faceHTML(contact, size, state = "idle") {
  if (!contact || !contact.id) {
    return `<span class="mx-orb" style="--s:${size}px"><i></i></span>`;
  }
  return agentAvatarHTML(contact, { size, hands: size >= 44, state, ring: true });
}

function timeLabel(ms, s) {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return s.now;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return s.yesterday;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * Monte la messagerie dans `root`.
 * @param {HTMLElement} root
 * @param {object} transport  voir l'en-tête du fichier
 * @param {{lang?:string, onClose?:()=>void, openThread?:string, readOnly?:boolean}} [opts]
 */
export function mountMessenger(root, transport, opts = {}) {
  ensureStyles();
  const s = T[String(opts.lang || "fr").startsWith("en") ? "en" : "fr"];
  const lang = s === T.en ? "en" : "fr";
  root.classList.add("mx");
  root.innerHTML = `
    <section class="mx-list">
      <header class="mx-head">
        ${opts.onClose ? `<button class="mx-ic" data-act="close" aria-label="${s.close}">${icon("x")}</button>` : ""}
        <h1>${s.title}</h1>${opts.onVault?`<button class="mx-ic" data-act="vault" aria-label="Coffre personnel">${icon("database")}</button>`:""}
        <span class="mx-sp"></span>
        <button class="mx-ic" data-act="new" aria-label="${s.newChat}" title="${s.newChat}">${icon("pencil")}</button>
      </header>
      <div class="mx-search"><span>${icon("search")}</span><input type="search" placeholder="${s.search}"></div>
      <div class="mx-people" aria-label="${s.contacts}"></div>
      <div class="mx-threads"></div>
    </section>
    <section class="mx-chat" hidden>
      <header class="mx-head mx-chat-head">
        <button class="mx-ic" data-act="back" aria-label="${s.back}">${icon("chevron-left")}</button>
        <span class="mx-who"></span>
        <span class="mx-sp"></span>
        ${opts.onVault?`<button class="mx-ic" data-act="vault" aria-label="Coffre personnel">${icon("database")}</button>`:""}
        <button class="mx-ic mx-orch" data-act="orch" aria-pressed="false">${icon("list-checks")}</button>
        <button class="mx-ic" data-act="cut" aria-label="${s.cut}" title="${s.cut}">${icon("scissors")}</button>
        <button class="mx-ic" data-act="menu" aria-label="${s.more}">${icon("ellipsis")}</button>
      </header>
      <div class="mx-menu" hidden>
        <button data-menu="cut">${icon("scissors")}<span>${s.cut}</span></button>
        <button data-menu="rename">${icon("pencil")}<span>${s.rename}</span></button>
        <button data-menu="pin">${icon("pin")}<span class="mx-pin-label">${s.pin}</span></button>
        <button data-menu="delete" class="danger">${icon("trash-2")}<span>${s.del}</span></button>
      </div>
      <div class="mx-scroll"><div class="mx-msgs"></div></div>
      <div class="mx-starters"></div>
      <div class="mx-at" hidden role="listbox"></div>
      <form class="mx-compose">
        <button type="button" class="mx-ic" data-act="photo" aria-label="${s.photo}">${icon("image")}</button>
        <input type="file" accept="image/*" multiple hidden>
        <div class="mx-field">
          <div class="mx-thumbs"></div>
          <textarea rows="1" placeholder="${s.placeholder}"></textarea>
        </div>
        ${transport.voice ? `<button type="button" class="mx-ic mx-voice-btn" data-act="voice" aria-label="${s.voice}" title="${s.voice}">${icon("audio-lines")}</button>` : ""}
        <button type="submit" class="mx-send" aria-label="${s.send}">${icon("send")}</button>
      </form>
      <div class="mx-voice" hidden role="dialog" aria-label="${s.voice}">
        <div class="mx-voice-who"></div>
        <button type="button" class="mx-voice-stage" data-act="v-tap" aria-label="${s.vSpeak}">
          <span class="mx-voice-ring"></span><span class="mx-voice-face"></span>
        </button>
        <div class="mx-voice-state"></div>
        <div class="mx-voice-caption"></div>
        <div class="mx-voice-bar">
          <button type="button" class="mx-voice-ctl" data-act="v-mute" aria-label="${s.vMute}">${icon("mic")}</button>
          <button type="button" class="mx-voice-ctl end" data-act="v-end" aria-label="${s.vEnd}">${icon("x")}</button>
        </div>
      </div>
    </section>`;

  const $ = (sel) => root.querySelector(sel);
  const listEl = $(".mx-list");
  const chatEl = $(".mx-chat");
  const threadsEl = $(".mx-threads");
  const peopleEl = $(".mx-people");
  const msgsEl = $(".mx-msgs");
  const scrollEl = $(".mx-scroll");
  const input = $("textarea");
  const fileInput = $('input[type="file"]');
  const sendBtn = $(".mx-send");
  let contacts = [];
  let threads = [];
  let filter = "";
  let current = null;          // discussion ouverte (objet complet)
  let busy = false;
  let pendingImages = [];      // data URLs
  let readOnly = !!opts.readOnly;
  const fileUrls = new Map();

  const contactOf = (id) => contacts.find((c) => (c.id || "") === (id || "")) || { id: id || "", name: id ? s.agent : "Lumen" };

  // ---------- Liste ----------
  let listRequest=null;
  async function refreshList() {
    if(listRequest)return listRequest;
    listRequest=loadList();
    try{return await listRequest;}finally{listRequest=null;}
  }
  async function loadList() {
    try {
      const [c, t] = await Promise.all([transport.contacts(), transport.threads()]);
      contacts = c || [];
      threads = t?.items || t || [];
      if (t && t.active === false) readOnly = true;
    } catch (e) { console.warn("[messages]", e); }
    renderPeople();
    renderThreads();
  }

  function renderPeople() {
    peopleEl.innerHTML = contacts.map((c) => `
      <button class="mx-person" data-contact="${esc(c.id || "")}" title="${esc(c.description || "")}">
        ${faceHTML(c, 54)}
        <span>${esc(c.name)}</span>
      </button>`).join("");
  }

  function renderThreads() {
    const q = filter.toLowerCase();
    const rows = threads.filter((t) => !q || `${t.title} ${contactOf(t.contact).name} ${t.preview}`.toLowerCase().includes(q));
    if (!rows.length) {
      threadsEl.innerHTML = `<div class="mx-empty"><b>${s.empty}</b><span>${s.emptyHint}</span></div>`;
      return;
    }
    threadsEl.innerHTML = rows.map((t) => {
      const c = contactOf(t.contact);
      const who = t.preview_role === "user" ? `${s.you} : ` : "";
      // Aperçu en texte simple : pas d'astérisques ni de dièses de Markdown.
      const plain = String(t.preview || "").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
      return `
        <button class="mx-row${t.unread ? " unread" : ""}" data-thread="${esc(t.id)}">
          ${faceHTML(c, 50, t.busy ? "work" : "idle")}
          <span class="mx-row-main">
            <span class="mx-row-top"><b>${esc(t.title || c.name)}</b>${t.pinned ? `<i class="mx-pinned">${icon("pin")}</i>` : ""}<time>${timeLabel(t.updated, s)}</time></span>
            <span class="mx-row-sub">${t.busy ? `<em>${esc(c.name)} ${s.typing}</em>` : esc(who + plain)}</span>
          </span>
          ${t.unread ? `<span class="mx-badge">${t.unread}</span>` : ""}
        </button>`;
    }).join("");
  }

  // ---------- Discussion ----------
  async function openThread(id) {
    let t;
    try { t = await transport.thread(id); } catch (e) { console.warn(e); return; }
    painter.clear();messageLimit=120;msgsEl.replaceChildren();
    current = t;
    busy = !!t.busy;
    listEl.hidden = true;
    chatEl.hidden = false;
    root.classList.add("in-chat");
    renderHeader();
    renderMessages();
    renderStarters();
    syncSend();
    if (t.unread) transport.update(id, { read: true }).catch(() => {});
    if (window.matchMedia("(min-width: 700px)").matches) input.focus();
  }

  function closeThread() {
    endVoice();
    current = null;
    chatEl.hidden = true;
    listEl.hidden = false;
    root.classList.remove("in-chat");
    refreshList();
  }

  function renderHeader() {
    const c = contactOf(current.contact);
    $(".mx-who").innerHTML = `${faceHTML(c, 36, busy ? "work" : "idle")}
      <span><b>${esc(current.title || c.name)}</b><small>${busy ? `${esc(c.name)} ${s.typing}` : esc(current.title && current.title !== c.name ? c.name : c.id ? s.agent : s.online)}</small></span>`;
    $(".mx-pin-label").textContent = current.pinned ? s.unpin : s.pin;
    const ob = $(".mx-orch");
    ob.classList.toggle("on", !!current.orchestrate);
    ob.setAttribute("aria-pressed", String(!!current.orchestrate));
    ob.title = current.orchestrate ? s.orchOn : s.orchOff;
    ob.setAttribute("aria-label", ob.title);
  }

  function renderStarters() {
    const el = $(".mx-starters");
    const empty = !(current?.messages || []).some((m) => m.role === "user");
    if (!empty || readOnly) { el.innerHTML = ""; return; }
    const list = current.contact ? s.agentStarters : s.starters;
    el.innerHTML = list.map((x) => `<button type="button">${esc(x)}</button>`).join("");
  }

  function toolHTML(m) {
    const tc = m.tool || {};
    const h = tc.name === "orchestrate_plan" ? { icon: "list-checks", text: s.plan }
      : tc.name === "orchestrate_check" ? { icon: "check", text: s.check }
      : humanStep({ skill: tc.name, input: JSON.stringify(tc.args || {}), result: tc.result, success: tc.ok }, lang);
    const state = tc.running ? "run" : tc.ok ? "ok" : "fail";
    return `<details class="mx-tool ${state}">
      <summary><span class="mx-tool-ic">${icon(h.icon) || icon("bolt")}</span><span class="mx-tool-t">${esc(h.text)}</span>
        <span class="mx-tool-s">${tc.running ? `<span class="mx-spin"></span>` : tc.ok ? icon("check") : icon("x")}</span></summary>
      ${tc.result ? `<div class="mx-tool-r">${esc(tc.result)}</div>` : ""}
    </details>`;
  }

  function msgHTML(m, next) {
    const c = contactOf(m.from && m.from !== "me" ? m.from : current.contact);
    const lastOfGroup = !next || next.role === "user" || next.role === "cut" || (next.from || "") !== (m.from || "") || (next.role !== m.role && next.role !== "assistant");
    switch (m.role) {
      case "cut":
        return `<div class="mx-cut" data-id="${esc(m.id)}"><span>${icon("scissors")} ${s.cutDone}</span></div>`;
      case "user":
        return `<div class="mx-line me" data-id="${esc(m.id)}"><div class="mx-bubble">${miniMarkdown(m.text)}</div></div>`;
      case "tool":
        return `<div class="mx-line ai tool" data-id="${esc(m.id)}"><span class="mx-face-slot"></span>${toolHTML(m)}</div>`;
      case "error":
        return `<div class="mx-line ai" data-id="${esc(m.id)}"><span class="mx-face-slot"></span><div class="mx-bubble err">${icon("triangle-alert")} ${esc(m.text)}</div></div>`;
      case "file": {
        const f = m.file || {};
        const mine = m.from === "me";
        const isImg = /^image\//.test(f.mime || "");
        const body = isImg
          ? `<img class="mx-img" data-file="${esc(f.id)}" alt="${esc(f.name)}">`
          : `<a class="mx-doc" data-file="${esc(f.id)}" href="#">${icon("file-text")}<span>${esc(f.name)}</span></a>`;
        return `<div class="mx-line ${mine ? "me" : "ai"}" data-id="${esc(m.id)}">${mine ? "" : `<span class="mx-face-slot">${lastOfGroup ? faceHTML(c, 28) : ""}</span>`}<div class="mx-bubble media">${body}</div></div>`;
      }
      default:
        return `<div class="mx-line ai" data-id="${esc(m.id)}"><span class="mx-face-slot">${lastOfGroup ? faceHTML(c, 28) : ""}</span><div class="mx-bubble">${miniMarkdown(m.text)}</div></div>`;
    }
  }

  let messageLimit=120;
  const painter=latestRender(paintMessages);
  const visibleAgain=()=>{if(document.hidden)painter.pause();else painter.resume();};
  document.addEventListener('visibilitychange',visibleAgain);
  function renderMessages(){painter.push(true);}
  function paintMessages() {
    const list=current?.messages||[];
    const follow=scrollEl.scrollHeight-scrollEl.scrollTop-scrollEl.clientHeight<100;
    const nodes=new Map([...msgsEl.querySelectorAll(':scope > [data-id]')].map(el=>[el.dataset.id,el]));
    const visible=list.slice(-messageLimit), kept=new Set(visible.map(m=>m.id));
    for(const [id,el] of nodes)if(!kept.has(id))el.remove();
    let older=msgsEl.querySelector('.mx-older');
    if(list.length>messageLimit){
      if(!older){older=document.createElement('button');older.className='mx-older mx-ic';msgsEl.prepend(older);}
      older.textContent=opts.lang==='en'?'Show earlier messages':'Afficher les messages précédents';
      older.onclick=()=>{messageLimit+=120;paintMessages();};
    }else older?.remove();
    const changed=[];
    visible.forEach((m,i)=>{
      const html=msgHTML(m,visible[i+1]);const old=nodes.get(m.id);
      if(old?.__messageHTML===html)return;
      const template=document.createElement('template');template.innerHTML=html;
      const el=template.content.firstElementChild;el.__messageHTML=html;
      if(old){
        const opened=[...old.querySelectorAll('details')].map(d=>d.open);
        el.querySelectorAll('details').forEach((d,i)=>{if(opened[i])d.open=true;});
        old.replaceWith(el);
      }else msgsEl.appendChild(el);
      changed.push(el);
    });
    msgsEl.querySelector('.mx-typing')?.remove();
    if(busy)msgsEl.insertAdjacentHTML('beforeend',typingHTML());
    for(const el of changed)hydrateFiles(el);
    if(follow)scrollDown();
  }

  function typingHTML() {
    if (!busy) return "";
    const c = contactOf(current.contact);
    return `<div class="mx-line ai mx-typing"><span class="mx-face-slot">${faceHTML(c, 28, "work")}</span><div class="mx-bubble"><i></i><i></i><i></i></div></div>`;
  }

  async function hydrateFiles(root=msgsEl) {
    for (const el of root.querySelectorAll("[data-file]")) {
      const id = el.dataset.file;
      try {
        if (!fileUrls.has(id)) fileUrls.set(id, Promise.resolve(transport.fileUrl(id)));
        const url = await fileUrls.get(id);
        if(!el.isConnected)continue;
        if (el.tagName === "IMG") { el.src = url; el.onload = () => {if(scrollEl.scrollHeight-scrollEl.scrollTop-scrollEl.clientHeight<160)scrollDown();}; } else el.href = url;
      } catch { fileUrls.delete(id); /* retry on the next paint */ }
    }
  }

  function scrollDown() {
    requestAnimationFrame(() => { scrollEl.scrollTop = scrollEl.scrollHeight; });
  }

  function syncSend() {
    sendBtn.classList.toggle("stop", busy);
    sendBtn.innerHTML = busy ? icon("square") : icon("send");
    sendBtn.setAttribute("aria-label", busy ? s.stop : s.send);
    const can = busy || input.value.trim() || pendingImages.length;
    sendBtn.disabled = readOnly || !can;
    input.disabled = readOnly;
    $(".mx-compose").classList.toggle("ro", readOnly);
    input.placeholder = readOnly ? s.locked : s.placeholder;
  }

  function renderThumbs() {
    $(".mx-thumbs").innerHTML = pendingImages.map((u, i) => `<span><img src="${u}" alt=""><button type="button" data-rm="${i}">${icon("x")}</button></span>`).join("");
    syncSend();
  }

  async function doSend(text, { force = false } = {}) {
    if (!current || readOnly) return;
    if (busy && !force) { transport.stop(current.id).catch(() => {}); return; }
    const body = (text ?? input.value).trim();
    if (!body && !pendingImages.length) return;
    const images = pendingImages;
    input.value = "";
    pendingImages = [];
    renderThumbs();
    autoGrow();
    busy = true;
    syncSend();
    try {
      await transport.send(current.id, body, images);
    } catch (e) {
      busy = false;
      syncSend();
      current.messages.push({ id: `local${Date.now()}`, role: "error", text: String(e?.message || e), ts: Date.now() });
      renderMessages();
    }
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }

  // ---------- Mode vocal (façon ChatGPT) ----------
  // Boucle : écoute → transcription → envoi → attente de la réponse complète
  // (fin de l'indicateur « écrit… ») → lecture → réécoute. Toucher l'orbe
  // pendant la lecture l'interrompt ; pendant l'écoute, il clôt la phrase.
  const voiceEl = $(".mx-voice");
  let vRun = null;              // { active, muted, abort, phase }
  let replyWaiter = null;

  const vSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function speechText(md) {
    return String(md || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_`#>|~]/g, "")
      .replace(/\s+\n/g, "\n")
      .trim();
  }
  function setVoice(phase, caption) {
    if (!vRun) return;
    vRun.phase = phase;
    voiceEl.dataset.phase = phase;
    const label = { loading: s.vLoad, listening: vRun.muted ? s.vMuted : s.vListen, thinking: s.vThink, speaking: s.vSpeak, error: s.vErr }[phase] || "";
    $(".mx-voice-state").textContent = label;
    if (caption !== undefined) $(".mx-voice-caption").textContent = caption;
    const face = phase === "thinking" ? "work" : "idle";
    if (vRun.face !== face) {   // re-créer l'avatar relancerait son animation
      vRun.face = face;
      $(".mx-voice-face").innerHTML = faceHTML(contactOf(current?.contact), 132, face);
    }
    if (phase !== "listening") setLevel(0);
  }
  function setLevel(v) { voiceEl.style.setProperty("--lvl", String(Math.max(0, Math.min(1, v || 0)))); }
  function sendAndWait(text) {
    return new Promise((resolve) => {
      const start = (current?.messages || []).length;
      let done = false;
      const finish = (v) => { if (done) return; done = true; replyWaiter = null; clearTimeout(to); resolve(v); };
      const to = setTimeout(() => finish(""), 5 * 60_000);
      replyWaiter = () => {
        const msgs = (current?.messages || []).slice(start).filter((m) => m.role === "assistant" || m.role === "error");
        finish(msgs.map((m) => m.text || "").join("\n\n"));
      };
      if (vRun) vRun.cancelWait = () => finish("");
      // `force` : un « écrit… » resté allumé (tour interrompu) ne doit pas
      // transformer l'envoi en « Arrêter ».
      doSend(text, { force: true }).then(() => { if (!busy) replyWaiter?.(); });
    });
  }
  async function startVoice() {
    if (!transport.voice || !current || readOnly || vRun) return;
    if (busy) transport.stop(current.id).catch(() => {});
    const run = vRun = { active: true, muted: false, abort: new AbortController(), phase: "" };
    voiceEl.hidden = false;
    chatEl.classList.add("voicing");
    const c = contactOf(current.contact);
    $(".mx-voice-who").textContent = current.title || c.name;
    try {
      setVoice("loading", "");
      await transport.voice.prepare?.((pct) => { if (run.active) setVoice("loading", pct != null ? `${pct} %` : ""); });
    } catch (e) {
      setVoice("error", String(e?.message || e));
      return;
    }
    let empties = 0;
    while (run.active) {
      if (run.muted) { setVoice("listening", ""); await vSleep(300); continue; }
      setVoice("listening", "");
      run.abort = new AbortController();
      let heard = "";
      try {
        heard = await transport.voice.listen({
          signal: run.abort.signal,
          onLevel: (v) => setLevel(v),
          onPartial: (t) => { if (run.active && run.phase === "listening") $(".mx-voice-caption").textContent = t; },
        });
      } catch (e) {
        if (!run.active) break;
        setVoice("error", String(e?.message || e));
        await vSleep(2500);
        if (++empties > 3) break;
        continue;
      }
      if (!run.active) break;
      if (run.muted || !String(heard || "").trim()) continue;
      empties = 0;
      setVoice("thinking", heard);
      const reply = speechText(await sendAndWait(heard));
      if (!run.active) break;
      if (!reply) continue;
      setVoice("speaking", reply.length > 280 ? reply.slice(0, 280) + "…" : reply);
      run.abort = new AbortController();
      // Un agent répond avec SA voix (agent.voice) ; Lumen avec la voix réglée.
      const speaker = contactOf(current?.contact);
      // Couper la parole : si l'utilisateur parle pendant la lecture, Lumen se
      // tait et réécoute aussitôt (comme une vraie conversation).
      let stopWatch = null;
      let bargeOk = true; try { bargeOk = localStorage.getItem("voiceBargeIn") !== "0"; } catch {}
      if (transport.voice.watchBargeIn && !run.muted && bargeOk) {
        stopWatch = await transport.voice.watchBargeIn({
          signal: run.abort.signal,
          onSpeech: () => { if (run.active && run.phase === "speaking") { try { transport.voice.stop?.(); } catch {} run.abort.abort(); } },
        }).catch(() => null);
      }
      try { await transport.voice.speak(reply, { signal: run.abort.signal, voice: speaker.voice || "" }); } catch { /* interrompu */ }
      try { stopWatch?.(); } catch {}
    }
    if (vRun === run) endVoice();
  }
  function endVoice() {
    const run = vRun;
    if (!run) return;
    vRun = null;
    run.active = false;
    run.abort?.abort();
    run.cancelWait?.();
    try { transport.voice?.stop?.(); } catch {}
    voiceEl.hidden = true;
    chatEl.classList.remove("voicing");
  }
  function toggleMute() {
    if (!vRun) return;
    vRun.muted = !vRun.muted;
    if (vRun.muted && vRun.phase === "listening") vRun.abort.abort();
    const b = $('[data-act="v-mute"]');
    b.innerHTML = icon(vRun.muted ? "mic-off" : "mic");
    b.classList.toggle("on", vRun.muted);
    b.setAttribute("aria-label", vRun.muted ? s.vUnmute : s.vMute);
    if (vRun.phase === "listening") setVoice("listening");
  }
  function voiceTap() {
    if (!vRun) return;
    if (vRun.phase === "speaking") { try { transport.voice.stop?.(); } catch {} vRun.abort.abort(); }
    else if (vRun.phase === "listening") vRun.abort.abort();   // fin de phrase anticipée
    else if (vRun.phase === "thinking" && current) transport.stop(current.id).catch(() => {});
  }

  // ---------- Menu « @ » : imposer un outil ----------
  const atEl = $(".mx-at");
  const toolsCache = new Map();   // fil → [{name, description}]
  let atItems = [], atActive = 0, atToken = null, atSeq = 0;
  function atClose() { atEl.hidden = true; atItems = []; atToken = null; }
  async function atUpdate() {
    if (!transport.tools || !current) return atClose();
    const caret = input.selectionStart ?? input.value.length;
    const m = /(^|\s)@([\w.-]*)$/.exec(input.value.slice(0, caret));
    if (!m) return atClose();
    atToken = { start: caret - m[2].length - 1, end: caret, query: m[2].toLowerCase() };
    const seq = ++atSeq;
    let list = toolsCache.get(current.id);
    if (!list) {
      try { list = await transport.tools(current.id); } catch { list = []; }
      toolsCache.set(current.id, list || []);
    }
    if (seq !== atSeq || !atToken) return;
    const q = atToken.query;
    atItems = (list || [])
      .map((t) => [t, !q ? 1 : t.name.toLowerCase().startsWith(q) ? 0 : t.name.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q) ? 1 : -1])
      .filter(([, sc]) => sc >= 0)
      .sort((a, b) => a[1] - b[1] || a[0].name.localeCompare(b[0].name))
      .slice(0, 30).map(([t]) => t);
    if (!atItems.length) return atClose();
    atActive = Math.min(atActive, atItems.length - 1);
    atEl.innerHTML = `<div class="mx-at-head">${s.atHead}</div>` + atItems.map((t, i) =>
      `<button type="button" role="option" class="mx-at-it${i === atActive ? " on" : ""}" data-at="${i}"><b>@${esc(t.name)}</b><small>${esc(t.description || "")}</small></button>`).join("");
    atEl.hidden = false;
    atEl.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }
  function atPick(i) {
    const t = atItems[i];
    if (!t || !atToken) return;
    const v = input.value;
    input.value = `${v.slice(0, atToken.start)}@${t.name} ${v.slice(atToken.end)}`;
    const pos = atToken.start + t.name.length + 2;
    atClose();
    input.focus();
    input.setSelectionRange(pos, pos);
    autoGrow();
    syncSend();
  }
  atEl.addEventListener("mousedown", (e) => e.preventDefault());   // garde le focus
  atEl.addEventListener("click", (e) => { const b = e.target.closest("[data-at]"); if (b) atPick(+b.dataset.at); });

  // ---------- Évènements en direct ----------
  let readTimer=null;
  const listPainter=latestRender(()=>refreshList(),{delay:400});
  const listVisibility=()=>{if(document.hidden)listPainter.pause();else listPainter.resume();};
  document.addEventListener("visibilitychange",listVisibility);
  const unsub = transport.onEvent?.((ev) => {
    if (!ev) return;
    if (ev.event === "threads" || !current || ev.thread !== current.id) {
      if (!current || listEl.hidden === false) listPainter.push(true);
      else if (ev.thread && ev.thread !== current.id) listPainter.push(true);
      return;
    }
    if (ev.event === "typing") {
      busy = !!ev.on;
      if (!busy) replyWaiter?.();
      renderHeader();
      renderMessages();
      syncSend();
      return;
    }
    if (ev.event === "message" && ev.message) {
      const list = current.messages || (current.messages = []);
      const i = list.findIndex((m) => m.id === ev.message.id);
      if (i >= 0) list[i] = ev.message; else list.push(ev.message);
      renderMessages();
      renderStarters();
      if (ev.message.role === "assistant") {
        clearTimeout(readTimer);const id=current.id;
        readTimer=setTimeout(()=>{if(current?.id===id)transport.update(id,{read:true}).catch(()=>{});},750);
      }
    }
  });

  // ---------- Interactions ----------
  root.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const menu = $(".mx-menu");
    if (!e.target.closest(".mx-menu") && act !== "menu") menu.hidden = true;
    if (act === "vault") {opts.onVault?.();return;}
    if (act === "close") { opts.onClose?.(); return; }
    if (act === "back") { closeThread(); return; }
    if (act === "new") { peopleEl.classList.add("pulse"); setTimeout(() => peopleEl.classList.remove("pulse"), 900); peopleEl.scrollIntoView({ behavior: "smooth" }); return; }
    if (act === "photo") { fileInput.click(); return; }
    if (act === "orch" && current && !readOnly) {
      current.orchestrate = !current.orchestrate;
      renderHeader();
      transport.update(current.id, { orchestrate: current.orchestrate }).catch(() => {});
      return;
    }
    if (act === "voice") { startVoice(); return; }
    if (act === "v-end") { endVoice(); return; }
    if (act === "v-mute") { toggleMute(); return; }
    if (act === "v-tap") { voiceTap(); return; }
    if (act === "menu") { menu.hidden = !menu.hidden; return; }
    if (act === "cut" && current) { transport.cut(current.id).catch(() => {}); return; }
    const person = e.target.closest("[data-contact]");
    if (person) {
      try {
        const t = await transport.create(person.dataset.contact);
        await openThread((t?.data || t).id);
      } catch (err) { console.warn(err); }
      return;
    }
    const row = e.target.closest("[data-thread]");
    if (row) { openThread(row.dataset.thread); return; }
    const m = e.target.closest("[data-menu]")?.dataset.menu;
    if (m && current) {
      menu.hidden = true;
      if (m === "cut") transport.cut(current.id).catch(() => {});
      if (m === "rename") {
        const name = await promptSheet({ title: s.renamePrompt, value: current.title || "" });
        if (name != null) { await transport.update(current.id, { title: name }); current.title = name; renderHeader(); }
      }
      if (m === "pin") { current.pinned = !current.pinned; await transport.update(current.id, { pinned: current.pinned }); renderHeader(); }
      if (m === "delete" && await confirmSheet({ title: s.delConfirm, danger: true })) { await transport.remove(current.id); closeThread(); }
      return;
    }
    const starter = e.target.closest(".mx-starters button");
    if (starter) { doSend(starter.textContent); return; }
    const rm = e.target.closest("[data-rm]");
    if (rm) { pendingImages.splice(+rm.dataset.rm, 1); renderThumbs(); }
  });
  $(".mx-search input").addEventListener("input", (e) => { filter = e.target.value; renderThreads(); });
  $(".mx-compose").addEventListener("submit", (e) => { e.preventDefault(); doSend(); });
  input.addEventListener("input", () => { autoGrow(); syncSend(); atUpdate(); });
  input.addEventListener("blur", () => setTimeout(atClose, 150));
  input.addEventListener("keydown", (e) => {
    if (!atEl.hidden && atItems.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        atActive = (atActive + (e.key === "ArrowDown" ? 1 : -1) + atItems.length) % atItems.length;
        atUpdate();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); atPick(atActive); return; }
      if (e.key === "Escape") { e.preventDefault(); atClose(); return; }
    }
    // Entrée envoie sur ordinateur ; sur téléphone le clavier garde son retour à la ligne.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer: fine)").matches) { e.preventDefault(); doSend(); }
  });
  fileInput.addEventListener("change", async () => {
    for (const f of [...fileInput.files].slice(0, 4)) pendingImages.push(await shrink(f));
    fileInput.value = "";
    renderThumbs();
  });

  refreshList().then(() => { if (opts.openThread) openThread(opts.openThread); });
  return {
    open: openThread,
    refresh: refreshList,
    destroy() { endVoice(); painter.clear();listPainter.clear();clearTimeout(readTimer);document.removeEventListener("visibilitychange",listVisibility);document.removeEventListener("visibilitychange",visibleAgain);unsub?.(); root.innerHTML = ""; },
  };
}

/** Réduit une photo (max 1600 px, JPEG) avant l'envoi. */
function shrink(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(""); };
    img.src = url;
  });
}

function ensureStyles() {
  if (document.getElementById("mx-css")) return;
  const st = document.createElement("style");
  st.id = "mx-css";
  st.textContent = `
.mx{--mx-bg:var(--background,#fff);--mx-fg:var(--foreground,#111);--mx-muted:var(--muted-foreground,#777);--mx-soft:var(--muted,#f1f1f4);
  --mx-line:var(--border,#e6e6ea);--mx-accent:var(--primary,#6d5cf0);--mx-accent-fg:var(--primary-foreground,#fff);
  position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--mx-bg);color:var(--mx-fg);
  font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;overflow:hidden}
.mx *{box-sizing:border-box}
.mx svg{width:20px;height:20px}
.mx-list,.mx-chat{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}
.mx-chat{position:relative}
.mx-list[hidden],.mx-chat[hidden]{display:none}
.mx-head{display:flex;align-items:center;gap:8px;padding:12px 14px 8px;padding-top:max(12px,env(safe-area-inset-top))}
.mx-head h1{margin:0;font-size:28px;font-weight:800;letter-spacing:-.5px}
.mx-sp{flex:1}
.mx-ic{width:38px;height:38px;border-radius:50%;border:0;background:var(--mx-soft);color:var(--mx-fg);display:inline-grid;place-items:center;cursor:pointer;flex:none}
.mx-ic:active{transform:scale(.94)}
.mx-search{display:flex;align-items:center;gap:8px;margin:2px 14px 6px;padding:0 12px;height:38px;border-radius:19px;background:var(--mx-soft);color:var(--mx-muted)}
.mx-search svg{width:17px;height:17px}
.mx-search input{flex:1;border:0;background:none;outline:none;font:inherit;color:var(--mx-fg);min-width:0}
.mx-people{display:flex;gap:14px;overflow-x:auto;padding:10px 14px 12px;scrollbar-width:none;border-radius:14px;transition:background .3s}
.mx-people::-webkit-scrollbar{display:none}
.mx-people.pulse{background:color-mix(in oklab,var(--mx-accent) 10%,transparent)}
.mx-person{display:flex;flex-direction:column;align-items:center;gap:6px;border:0;background:none;color:var(--mx-fg);cursor:pointer;width:64px;flex:none;padding:0;font:inherit}
.mx-person span:last-child{font-size:12px;max-width:64px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-threads{flex:1;overflow-y:auto;padding:0 6px calc(12px + env(safe-area-inset-bottom))}
.mx-row{display:flex;align-items:center;gap:12px;width:100%;padding:9px 8px;border:0;background:none;color:inherit;border-radius:14px;cursor:pointer;text-align:left;font:inherit}
.mx-row:hover{background:var(--mx-soft)}
.mx-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.mx-row-top{display:flex;align-items:center;gap:6px}
.mx-row-top b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-row-top time{margin-left:auto;font-size:12px;color:var(--mx-muted);flex:none}
.mx-pinned svg{width:13px;height:13px;color:var(--mx-muted)}
.mx-row-sub{font-size:13.5px;color:var(--mx-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-row-sub em{color:var(--mx-accent);font-style:normal}
.mx-row.unread b,.mx-row.unread .mx-row-sub{color:var(--mx-fg);font-weight:700}
.mx-badge{min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--mx-accent);color:var(--mx-accent-fg);font-size:12px;font-weight:700;display:grid;place-items:center}
.mx-empty{display:flex;flex-direction:column;gap:4px;align-items:center;text-align:center;padding:40px 20px;color:var(--mx-muted)}
.mx-empty b{color:var(--mx-fg)}
.mx-orb{--s:40px;width:var(--s);height:var(--s);border-radius:50%;flex:none;display:inline-block;position:relative;
  background:radial-gradient(circle at 30% 30%,#ffd6f0 0,transparent 45%),conic-gradient(from 200deg,#7c6cf0,#46c2ff,#56e0a8,#ff8ac2,#7c6cf0);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
.mx-orb i{position:absolute;inset:30% 32% 36%;background:
  radial-gradient(circle,#fff 0 55%,transparent 60%) 0 0/34% 100% no-repeat,radial-gradient(circle,#fff 0 55%,transparent 60%) 100% 0/34% 100% no-repeat}
.mx-chat-head{border-bottom:1px solid var(--mx-line);padding-bottom:10px}
.mx-who{display:flex;align-items:center;gap:10px;min-width:0}
.mx-who>span:last-child{display:flex;flex-direction:column;min-width:0}
.mx-who b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-who small{font-size:12px;color:var(--mx-muted)}
.mx-menu{position:absolute;right:12px;top:calc(max(12px,env(safe-area-inset-top)) + 48px);z-index:5;background:var(--popover,var(--mx-bg));border:1px solid var(--mx-line);
  border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.16);padding:6px;min-width:220px}
.mx-menu[hidden]{display:none}
.mx-menu button{display:flex;align-items:center;gap:10px;width:100%;padding:10px;border:0;background:none;color:inherit;font:inherit;border-radius:9px;cursor:pointer;text-align:left}
.mx-menu button:hover{background:var(--mx-soft)}
.mx-menu .danger{color:var(--destructive,#e5484d)}
.mx-scroll{flex:1;overflow-y:auto;padding:10px 10px 6px;overscroll-behavior:contain}
.mx-msgs{display:flex;flex-direction:column;gap:3px;max-width:760px;margin:0 auto}
.mx-line{display:flex;align-items:flex-end;gap:7px}
.mx-line.me{justify-content:flex-end}
.mx-face-slot{width:28px;flex:none;display:flex;align-items:flex-end}
.mx-bubble{max-width:min(78%,560px);padding:8px 13px;border-radius:20px;background:var(--mx-soft);word-wrap:break-word;overflow-wrap:anywhere}
.mx-line.me .mx-bubble{background:linear-gradient(135deg,var(--mx-accent),color-mix(in oklab,var(--mx-accent) 70%,#ff5fa2));color:var(--mx-accent-fg)}
.mx-line.me+.mx-line.me .mx-bubble{border-top-right-radius:6px}
.mx-line.ai+.mx-line.ai .mx-bubble{border-top-left-radius:6px}
.mx-line+.mx-line.me,.mx-line.me+.mx-line.ai{margin-top:8px}
.mx-bubble p{margin:0}
.mx-bubble p+p,.mx-bubble p+ul,.mx-bubble ul+p,.mx-bubble p+ol{margin-top:6px}
.mx-bubble ul,.mx-bubble ol{margin:2px 0;padding-left:20px}
.mx-bubble code{font:12.5px ui-monospace,Menlo,monospace;background:rgba(127,127,127,.16);padding:1px 4px;border-radius:5px}
.mx-bubble pre{margin:6px 0;white-space:pre-wrap;font:12.5px ui-monospace,Menlo,monospace}
.mx-bubble a{color:inherit;text-decoration:underline}
.mx-bubble.err{background:color-mix(in oklab,var(--destructive,#e5484d) 12%,transparent);color:var(--destructive,#e5484d);display:flex;gap:6px;align-items:center}
.mx-bubble.err svg{width:16px;height:16px;flex:none}
.mx-bubble.media{padding:3px;background:none}
.mx-img{display:block;max-width:260px;max-height:320px;border-radius:17px;background:var(--mx-soft)}
.mx-doc{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:16px;background:var(--mx-soft);color:inherit;text-decoration:none}
.mx-tool{max-width:min(78%,480px);border:1px solid var(--mx-line);border-radius:14px;background:var(--mx-bg);font-size:13px}
.mx-tool summary{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;list-style:none;color:var(--mx-muted)}
.mx-tool summary::-webkit-details-marker{display:none}
.mx-tool-ic svg{width:15px;height:15px}
.mx-tool-t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-tool-s svg{width:15px;height:15px}
.mx-tool.ok .mx-tool-s{color:var(--success,#30a46c)}
.mx-tool.fail .mx-tool-s{color:var(--destructive,#e5484d)}
.mx-tool-r{padding:0 10px 8px;color:var(--mx-muted);font-size:12px;white-space:pre-wrap;max-height:180px;overflow:auto}
.mx-spin{display:inline-block;width:13px;height:13px;border-radius:50%;border:2px solid var(--mx-line);border-top-color:var(--mx-accent);animation:mx-spin .8s linear infinite}
@keyframes mx-spin{to{transform:rotate(360deg)}}
.mx-cut{display:flex;align-items:center;gap:10px;margin:14px 0;color:var(--mx-muted);font-size:12px}
.mx-cut::before,.mx-cut::after{content:"";flex:1;border-top:1px dashed var(--mx-line)}
.mx-cut span{display:flex;align-items:center;gap:6px}
.mx-cut svg{width:14px;height:14px}
.mx-typing .mx-bubble{display:flex;gap:4px;padding:12px 14px}
.mx-typing i{width:7px;height:7px;border-radius:50%;background:var(--mx-muted);animation:mx-dot 1.2s infinite}
.mx-typing i:nth-child(2){animation-delay:.15s}.mx-typing i:nth-child(3){animation-delay:.3s}
@keyframes mx-dot{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-3px)}}
.mx-starters{display:flex;gap:8px;overflow-x:auto;padding:4px 12px 6px;scrollbar-width:none}
.mx-starters:empty{display:none}
.mx-starters button{flex:none;border:1px solid var(--mx-line);background:var(--mx-bg);color:var(--mx-fg);border-radius:18px;padding:7px 12px;font:inherit;font-size:13.5px;cursor:pointer}
.mx-compose{display:flex;align-items:flex-end;gap:8px;padding:8px 10px;padding-bottom:max(8px,env(safe-area-inset-bottom));border-top:1px solid var(--mx-line);background:var(--mx-bg)}
.mx-compose.ro{opacity:.7}
.mx-field{flex:1;min-width:0;border-radius:21px;background:var(--mx-soft);padding:0 14px}
.mx-field textarea{display:block;width:100%;border:0;background:none;resize:none;outline:none;font:inherit;color:var(--mx-fg);padding:9px 0;max-height:140px;line-height:1.4}
.mx-thumbs{display:flex;gap:6px;padding-top:8px}
.mx-thumbs:empty{display:none}
.mx-thumbs span{position:relative}
.mx-thumbs img{width:56px;height:56px;object-fit:cover;border-radius:12px;display:block}
.mx-thumbs button{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:0;background:#000a;color:#fff;display:grid;place-items:center;padding:0}
.mx-thumbs button svg{width:12px;height:12px}
.mx-send{width:40px;height:40px;border-radius:50%;border:0;background:var(--mx-accent);color:var(--mx-accent-fg);display:grid;place-items:center;cursor:pointer;flex:none;transition:transform .12s,opacity .2s}
.mx-send:disabled{opacity:.35;cursor:default}
.mx-orch.on{background:var(--mx-accent);color:var(--mx-accent-fg)}
.mx-at{position:absolute;left:10px;right:10px;bottom:72px;z-index:20;max-height:260px;overflow:auto;background:var(--mx-bg);border:1px solid var(--mx-line);
  border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:4px}
.mx-at[hidden]{display:none}
.mx-at-head{font-size:11px;color:var(--mx-muted);padding:6px 10px 4px}
.mx-at-it{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;border:0;background:none;text-align:left;padding:7px 10px;border-radius:10px;cursor:pointer;color:var(--mx-fg);font:inherit}
.mx-at-it b{font-size:14px;font-weight:600}
.mx-at-it small{font-size:12px;color:var(--mx-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.mx-at-it.on,.mx-at-it:hover{background:var(--mx-soft)}
.mx-voice{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px 20px calc(28px + env(safe-area-inset-bottom));
  background:color-mix(in oklch,var(--mx-bg) 94%,var(--mx-accent));text-align:center;--lvl:0}
.mx-voice[hidden]{display:none}
.mx-voice-who{position:absolute;top:calc(16px + env(safe-area-inset-top));left:0;right:0;font-weight:600;color:var(--mx-muted);font-size:14px}
.mx-voice-stage{position:relative;width:200px;height:200px;border:0;background:none;display:grid;place-items:center;cursor:pointer;padding:0}
.mx-voice-ring{position:absolute;inset:18px;border-radius:50%;background:color-mix(in oklch,var(--mx-accent) 22%,transparent);
  transform:scale(calc(1 + var(--lvl) * .35));transition:transform .08s linear}
.mx-voice[data-phase=thinking] .mx-voice-ring{animation:mxVPulse 1.4s ease-in-out infinite}
.mx-voice[data-phase=speaking] .mx-voice-ring{animation:mxVSpeak .9s ease-in-out infinite}
.mx-voice[data-phase=loading] .mx-voice-ring,.mx-voice[data-phase=error] .mx-voice-ring{opacity:.35}
.mx-voice-face{position:relative;display:grid;place-items:center}
.mx-voice-face .mx-orb{--s:132px}
@keyframes mxVPulse{0%,100%{transform:scale(.92);opacity:.6}50%{transform:scale(1.06);opacity:1}}
@keyframes mxVSpeak{0%,100%{transform:scale(1.02)}50%{transform:scale(1.18)}}
.mx-voice-state{font-weight:600;font-size:17px}
.mx-voice[data-phase=error] .mx-voice-state{color:var(--destructive,#d33)}
.mx-voice-caption{max-width:520px;min-height:3em;color:var(--mx-muted);font-size:15px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical}
.mx-voice-bar{position:absolute;bottom:calc(26px + env(safe-area-inset-bottom));display:flex;gap:28px}
.mx-voice-ctl{width:58px;height:58px;border-radius:50%;border:0;display:grid;place-items:center;cursor:pointer;background:var(--mx-soft);color:var(--mx-fg)}
.mx-voice-ctl svg{width:24px;height:24px}
.mx-voice-ctl.on{background:var(--mx-fg);color:var(--mx-bg)}
.mx-voice-ctl.end{background:var(--destructive,#e5484d);color:#fff}
@media (prefers-reduced-motion:reduce){.mx-voice-ring{animation:none!important;transition:none}}
.mx-send.stop{background:var(--mx-fg);color:var(--mx-bg)}
.mx-send svg{width:18px;height:18px}
.mx .ka-ring{flex:none}
@media (prefers-reduced-motion:reduce){.mx-typing i,.mx-spin{animation:none}}
`;
  document.head.appendChild(st);
}
