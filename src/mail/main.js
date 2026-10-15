// App Email — logique front.
//
// Le backend (src-tauri/src/mail.rs) fait tout le réseau : IMAP pour relever,
// SMTP pour envoyer. Cette page ne connaît ni mot de passe ni socket ; elle
// lit `mail.json`, écrit les drapeaux locaux, et déclenche les commandes.
//
// Ce qui la distingue d'un client de courrier ordinaire : l'IA de Lumen est là
// où elle sert — résumer un message long, préparer une réponse — et jamais
// entre vous et le texte reçu, qui s'affiche tel qu'il est arrivé.
import { autoTranslate, tt } from "../apps-i18n.js";
import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { loadContacts, parseAddress, upsertContact, saveContacts, identityKey } from "../lib/contacts-store.js";
import { receive, toText } from "../lib/interop.js";
import { renderMailHtml } from "../lib/mail-html.js";
import { openExternal } from "../lib/open-external.js";

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let messages = [];
let drafts = [];      // brouillons, dont ceux écrits par les agents
let contacts = [];
let account = null;
let currentId = null;
let filter = "all";
let needle = "";
let replyTo = null;      // message auquel on répond (pour l'objet et l'IA)

// ===== Chargement ==========================================================

async function loadAll() {
  try {
    const raw = await invoke("mail_load");
    messages = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(messages)) messages = [];
  } catch { messages = []; }
  messages.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  await loadDrafts();
  contacts = await loadContacts();
  renderList();
}

/// Brouillons : les vôtres, et ceux qu'un agent a écrits pour vous.
///
/// Un agent PEUT lire le courrier et rédiger ; il ne peut ni envoyer ni
/// supprimer — le catalogue d'outils ne contient tout simplement pas ces
/// verbes (cf. src-tauri/src/native_tools.rs). Un brouillon qui arrive ici
/// attend donc forcément une relecture humaine, et c'est ce que dit le
/// bandeau du lecteur.
async function loadDrafts() {
  try {
    const raw = await invoke("mail_drafts_load");
    drafts = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(drafts)) drafts = [];
  } catch { drafts = []; }
  drafts.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const badge = $("drafts-count");
  if (badge) {
    badge.textContent = drafts.length ? String(drafts.length) : "";
    badge.hidden = !drafts.length;
  }
}

async function persistDrafts() {
  try { await invoke("mail_drafts_save", { data: JSON.stringify(drafts) }); } catch {}
  await loadDrafts();
}

async function loadAccount() {
  try { account = await invoke("mail_account_get"); } catch { account = null; }
  const hint = $("empty-hint");
  if (hint) {
    hint.textContent = account?.configured
      ? tt("Choisissez un message, ou relevez le courrier.")
      : tt("Configurez votre compte, puis relevez le courrier.");
  }
  $("btn-sync").disabled = !account?.configured;
}

async function persist() {
  try { await invoke("mail_save", { data: JSON.stringify(messages) }); } catch {}
}

function status(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "side-foot" + (kind ? " " + kind : "");
}

// ===== Liste ===============================================================

function visibleMessages() {
  // Un brouillon n'est pas un message reçu : il a son propre filtre, sa propre
  // liste, et il ne se mélange pas à la boîte de réception.
  const source = filter === "drafts"
    ? drafts.map((d) => ({ ...d, __draft: true, from: d.author || tt("Vous"), read: true }))
    : messages;
  return source.filter((m) => {
    if (filter === "unread" && m.read) return false;
    if (!needle) return true;
    const hay = `${m.subject} ${m.from} ${m.body}`.toLowerCase();
    return hay.includes(needle);
  });
}

function shortDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function renderList() {
  const list = $("msg-list");
  const shown = visibleMessages();
  const unread = messages.filter((m) => !m.read).length;
  $("unread").textContent = unread ? String(unread) : "";
  list.innerHTML = "";
  if (!shown.length) {
    const empty = filter === "drafts" ? tt("Aucun brouillon.") : (messages.length ? tt("Aucun message ne correspond.") : tt("Boîte vide."));
    list.innerHTML = `<div class="side-foot">${esc(empty)}</div>`;
    return;
  }
  for (const m of shown) {
    const el = document.createElement("div");
    el.className = "msg-item" + (m.id === currentId ? " active" : "")
      + (m.read ? " is-read" : "") + (m.__draft ? " draft" : "");
    const who = m.__draft
      ? { name: `${tt("Brouillon")} · ${m.from}`, email: m.to }
      : parseAddress(m.from);
    el.innerHTML =
      `<span class="dot${m.read ? " read" : ""}"></span>` +
      `<span class="msg-main">` +
        `<span class="msg-from"><span>${esc(who.name || who.email || tt("(inconnu)"))}</span><time>${esc(shortDate(m.ts))}</time></span>` +
        `<div class="msg-subject">${esc(m.subject || tt("(sans objet)"))}</div>` +
        `<div class="msg-preview">${esc(String(m.body || "").slice(0, 120))}</div>` +
      `</span>`;
    el.addEventListener("click", () => openMessage(m.id));
    list.appendChild(el);
  }
}

// ===== Lecture =============================================================

function current() {
  return messages.find((m) => m.id === currentId)
    || drafts.find((d) => d.id === currentId)
    || null;
}
const isDraftId = (id) => drafts.some((d) => d.id === id);

function openMessage(id) {
  currentId = id;
  const m = current();
  if (!m) return;
  if (isDraftId(id)) { openDraft(m); return; }
  if (!m.read) { m.read = true; persist(); }
  $("reader-empty").hidden = true;
  $("reader-content").hidden = false;
  $("r-subject").textContent = m.subject || tt("(sans objet)");
  $("r-from").textContent = m.from || tt("(inconnu)");
  $("r-date").textContent = m.ts ? new Date(m.ts * 1000).toLocaleString() : m.date || "";
  $("r-to").textContent = m.to ? `${tt("À")} : ${m.to}` : "";
  $("r-attach").hidden = !m.has_attachments;
  renderBody(m);
  showReaderNote("");
  setReaderActions("message");
  renderList();
}

// Corps du message : la version HTML mise en forme quand il y en a une
// (assainie puis isolée dans une iframe sans script ni réseau, cf.
// lib/mail-html.js), sinon — ou sur demande — le texte brut. Le choix
// « Mise en forme / Texte » est mémorisé.
// Images autorisées message par message (comme Outlook) : jamais par défaut,
// mémorisé pour ce seul message (identifiant), 500 derniers au plus.
const IMG_KEY = "mailImagesAllowed";
const imagesAllowed = (id) => { try { return (JSON.parse(localStorage.getItem(IMG_KEY) || "[]")).includes(String(id)); } catch { return false; } };
function setImagesAllowed(id, on) {
  try {
    const list = (JSON.parse(localStorage.getItem(IMG_KEY) || "[]")).filter((x) => x !== String(id));
    if (on) list.push(String(id));
    localStorage.setItem(IMG_KEY, JSON.stringify(list.slice(-500)));
  } catch {}
}
const viewPref = () => { try { return localStorage.getItem("mailView") || "html"; } catch { return "html"; } };
function renderBody(m) {
  const body = $("r-body");
  const hasHtml = Boolean(m.html && m.html.trim());
  const mode = hasHtml ? viewPref() : "text";
  $("r-view").hidden = !hasHtml;
  $("r-view").querySelectorAll("button").forEach((b) => b.classList.toggle("is-on", b.dataset.view === mode));
  body.classList.toggle("is-html", mode === "html");
  if (mode === "html") {
    const allowImages = imagesAllowed(m.id);
    const { blockedImages } = renderMailHtml(body, m.html, { openLink: (url) => openExternal(url), allowImages });
    const safe = $("r-safe");
    safe.hidden = false;
    safe.replaceChildren();
    const note = document.createElement("span");
    note.textContent = allowImages
      ? tt("Images affichées pour ce message. Scripts et formulaires restent bloqués.")
      : blockedImages
        ? tt("Affichage protégé : scripts, formulaires et {n} image(s) bloqués, aucun contenu distant chargé.", { n: blockedImages })
        : tt("Affichage protégé : scripts et contenus distants bloqués.");
    safe.appendChild(note);
    if (allowImages || blockedImages) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "reader-safe-btn";
      btn.textContent = allowImages ? tt("Masquer les images") : tt("Afficher les images");
      btn.title = allowImages ? "" : tt("Charger les images de ce message uniquement. L'expéditeur pourra savoir que vous l'avez ouvert.");
      btn.addEventListener("click", () => { setImagesAllowed(m.id, !allowImages); renderBody(m); });
      safe.appendChild(btn);
    }
  } else {
    // `textContent` et non `innerHTML` : le corps vient de l'extérieur. Le CSS
    // (`white-space: pre-wrap`) lui rend ses retours à la ligne sans lui rendre
    // la possibilité d'exécuter quoi que ce soit.
    body.textContent = m.body || tt("(message vide)");
    $("r-safe").hidden = true;
  }
}
$("r-view")?.addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.view;
  if (!v) return;
  try { localStorage.setItem("mailView", v); } catch {}
  const m = current();
  if (m && !isDraftId(m.id)) renderBody(m);
});

/// Un brouillon s'affiche en lecture, avec le rappel qu'il n'est pas parti et
/// les deux seules actions qui le concernent : le reprendre, ou l'écarter.
function openDraft(d) {
  $("reader-empty").hidden = true;
  $("reader-content").hidden = false;
  $("r-subject").textContent = d.subject || tt("(sans objet)");
  $("r-from").textContent = d.author ? `${tt("Rédigé par")} ${d.author}` : tt("Brouillon");
  $("r-date").textContent = d.ts ? new Date(d.ts * 1000).toLocaleString() : "";
  $("r-to").textContent = d.to ? `${tt("À")} : ${d.to}` : tt("Destinataire à compléter.");
  $("r-attach").hidden = true;
  $("r-body").classList.remove("is-html");
  $("r-view").hidden = true;
  $("r-safe").hidden = true;
  $("r-body").textContent = d.body || "";
  showReaderNote(tt("Ce brouillon n'a pas été envoyé. Les agents de Lumen peuvent lire votre courrier et préparer des réponses ; l'envoi et la suppression restent des gestes que vous seul pouvez faire."));
  setReaderActions("draft");
  renderList();
}

function showReaderNote(text) {
  let note = document.querySelector(".reader-note");
  if (!text) { note?.remove(); return; }
  if (!note) {
    note = document.createElement("p");
    note.className = "reader-note";
    $("reader-content").insertBefore(note, $("r-body"));
  }
  note.textContent = text;
}

/// Les actions du lecteur ne sont pas les mêmes selon ce qu'on lit : on répond
/// à un message reçu, on REPREND un brouillon.
function setReaderActions(mode) {
  const draft = mode === "draft";
  $("btn-reply").hidden = draft;
  $("btn-summarize").hidden = draft;
  $("btn-draft").hidden = draft;
  $("btn-unread").hidden = draft;
  $("btn-resume").hidden = !draft;
  $("btn-delete").textContent = draft ? tt("Jeter le brouillon") : tt("Retirer de la liste");
}

// ===== Relève ==============================================================

async function sync() {
  if (!account?.configured) { openAccount(); return; }
  $("btn-sync").disabled = true;
  status(tt("Relève en cours…"));
  try {
    const count = await invoke("mail_sync", { limit: 50 });
    await loadAll();
    status(`${count} ${tt("message(s) dans la boîte.")}`);
  } catch (e) {
    status(String(e?.message || e), "err");
  } finally {
    $("btn-sync").disabled = false;
  }
}

// ===== Rédaction ===========================================================

let composingDraftId = null;   // brouillon repris : il disparaît une fois envoyé

function openCompose({ to = "", subject = "", body = "", replySource = null, draftId = null } = {}) {
  replyTo = replySource;
  composingDraftId = draftId;
  $("compose-title").textContent = replySource ? tt("Répondre") : tt("Nouveau message");
  $("c-to").value = to;
  $("c-cc").value = "";
  $("c-subject").value = subject;
  $("c-body").value = body;
  $("c-status").textContent = "";
  $("c-status").className = "sheet-status";
  $("compose-overlay").hidden = false;
  $("c-to").focus();
}

function closeCompose() {
  $("compose-overlay").hidden = true;
  $("c-suggest").hidden = true;
  replyTo = null;
  composingDraftId = null;
}

/// Autocomplétion du champ « À » sur le carnet d'adresses.
function suggestRecipients() {
  const box = $("c-suggest");
  const raw = $("c-to").value;
  // Seul le dernier destinataire en cours de frappe est complété.
  const term = raw.split(/[,;]/).pop().trim().toLowerCase();
  if (term.length < 2) { box.hidden = true; return; }
  const hits = contacts
    .filter((c) => c.email && `${c.name} ${c.email} ${c.company}`.toLowerCase().includes(term))
    .slice(0, 6);
  if (!hits.length) { box.hidden = true; return; }
  box.innerHTML = "";
  for (const c of hits) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `${esc(c.name || c.email)}<small>${esc(c.email)}</small>`;
    b.addEventListener("click", () => {
      const parts = raw.split(/[,;]/);
      parts[parts.length - 1] = ` ${c.email}`;
      $("c-to").value = parts.join(",").replace(/^[\s,]+/, "");
      box.hidden = true;
      $("c-to").focus();
    });
    box.appendChild(b);
  }
  box.hidden = false;
}

async function send() {
  const to = $("c-to").value.trim();
  if (!to) { $("c-status").textContent = tt("Indiquez au moins un destinataire."); $("c-status").className = "sheet-status err"; return; }
  $("c-send").disabled = true;
  $("c-status").textContent = tt("Envoi…");
  $("c-status").className = "sheet-status";
  try {
    await invoke("mail_send", {
      to,
      cc: $("c-cc").value.trim() || null,
      subject: $("c-subject").value.trim(),
      body: $("c-body").value,
    });
    $("c-status").textContent = tt("Message envoyé.");
    $("c-status").className = "sheet-status ok";
    // Le brouillon a rempli son office : il sort de la liste.
    if (composingDraftId) {
      drafts = drafts.filter((d) => d.id !== composingDraftId);
      await persistDrafts();
      if (currentId === composingDraftId) {
        currentId = null;
        $("reader-content").hidden = true;
        $("reader-empty").hidden = false;
      }
      renderList();
    }
    // Écrire à quelqu'un, c'est le connaître : la fiche se crée toute seule.
    await rememberRecipients(to);
    setTimeout(closeCompose, 700);
  } catch (e) {
    $("c-status").textContent = String(e?.message || e);
    $("c-status").className = "sheet-status err";
  } finally {
    $("c-send").disabled = false;
  }
}

async function rememberRecipients(raw) {
  let next = contacts;
  for (const part of raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const { name, email } = parseAddress(part);
    if (!email) continue;
    if (next.some((c) => identityKey(c) === email.toLowerCase())) continue;
    next = upsertContact(next, { name: name || email, email, origin: "mail" });
  }
  if (next !== contacts) {
    contacts = next;
    try { await saveContacts(contacts); } catch {}
  }
}

// ===== IA ==================================================================

// `onDelta(texte)` : réponse en flux (résumé, brouillon affichés au fil de l'eau).
async function ask(messages, label, onDelta) {
  const { content, data } = await llmChat(messages, { source: "mail", rawSystem: true, ...(onDelta ? { onDelta } : {}) });
  if (data) recordOllamaUsage(data, "mail");
  void label;
  return content;
}

async function summarize() {
  const m = current();
  if (!m) return;
  const btn = $("btn-summarize");
  btn.disabled = true;
  const original = $("r-body").textContent;
  $("r-body").textContent = tt("Lecture du message…");
  try {
    const out = await ask(
      PROMPTS["app.mail.summary"].build({ mail: `${tt("Objet")} : ${m.subject}\n${tt("De")} : ${m.from}\n\n${m.body}`, lang: replyLang() }).messages,
      "summary",
      (txt) => { if (txt) $("r-body").textContent = `${tt("RÉSUMÉ")}\n${txt}\n\n———\n\n${original}`; },
    );
    $("r-body").textContent = `${tt("RÉSUMÉ")}\n${out}\n\n———\n\n${original}`;
  } catch (e) {
    $("r-body").textContent = original;
    status(String(e?.message || e), "err");
  } finally {
    btn.disabled = false;
  }
}

async function draftReply() {
  const m = current();
  if (!m) return;
  const btn = $("btn-draft");
  btn.disabled = true;
  status(tt("Rédaction du brouillon…"));
  try {
    const out = await ask(
      PROMPTS["app.mail.draft"].build({ mail: `${tt("Objet")} : ${m.subject}\n${tt("De")} : ${m.from}\n\n${m.body}` }).messages,
      "draft",
    );
    openCompose({
      to: parseAddress(m.from).email || m.from,
      subject: replySubject(m.subject),
      body: out,
      replySource: m,
    });
    status("");
  } catch (e) {
    status(String(e?.message || e), "err");
  } finally {
    btn.disabled = false;
  }
}

async function writeWithAi() {
  const brief = prompt(tt("Que doit dire ce message ?"));
  if (!brief) return;
  const btn = $("c-ai");
  btn.disabled = true;
  const before = $("c-body").value;
  try {
    const out = await ask(
      PROMPTS["app.mail.compose"].build({ brief, draft: before, lang: replyLang() }).messages,
      "compose",
      (txt) => { if (txt) $("c-body").value = txt; },
    );
    $("c-body").value = out;
    if (!$("c-subject").value.trim()) {
      $("c-subject").value = out.split("\n")[0].slice(0, 70);
    }
  } catch (e) {
    $("c-status").textContent = String(e?.message || e);
    $("c-status").className = "sheet-status err";
  } finally {
    btn.disabled = false;
  }
}

function replySubject(subject) {
  const s = String(subject || "");
  return /^(re|rép?\.?)\s*:/i.test(s) ? s : `Re: ${s}`;
}

// ===== Compte ==============================================================

function openAccount() {
  const a = account || {};
  $("a-email").value = a.email || "";
  $("a-name").value = a.display_name || "";
  $("a-imap-host").value = a.imap_host || "";
  $("a-imap-port").value = a.imap_port || 993;
  $("a-smtp-host").value = a.smtp_host || "";
  $("a-smtp-port").value = a.smtp_port || 587;
  $("a-user").value = a.user || "";
  $("a-starttls").checked = a.smtp_starttls !== false;
  $("a-pass").value = "";
  $("a-pass").placeholder = a.has_password ? tt("inchangé") : tt("mot de passe d'application");
  $("a-status").textContent = "";
  $("a-status").className = "sheet-status";
  $("account-overlay").hidden = false;
}

/// Devine les serveurs d'après le domaine, pour les fournisseurs courants.
/// Ce n'est qu'une amorce : les champs restent modifiables.
const PROVIDERS = {
  "gmail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
  "googlemail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
  "outlook.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  "hotmail.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  "live.fr": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  "yahoo.fr": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  "yahoo.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  "free.fr": { imap: "imap.free.fr", smtp: "smtp.free.fr" },
  "orange.fr": { imap: "imap.orange.fr", smtp: "smtp.orange.fr" },
  "sfr.fr": { imap: "imap.sfr.fr", smtp: "smtp.sfr.fr" },
  "laposte.net": { imap: "imap.laposte.net", smtp: "smtp.laposte.net" },
  "icloud.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com" },
  "me.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com" },
  "proton.me": { imap: "127.0.0.1", smtp: "127.0.0.1" }, // pont Proton local
};

function guessServers() {
  const domain = ($("a-email").value.split("@")[1] || "").toLowerCase();
  const p = PROVIDERS[domain];
  if (!p) return;
  if (!$("a-imap-host").value) $("a-imap-host").value = p.imap;
  if (!$("a-smtp-host").value) $("a-smtp-host").value = p.smtp;
}

function accountFromForm() {
  return {
    email: $("a-email").value.trim(),
    display_name: $("a-name").value.trim(),
    imap_host: $("a-imap-host").value.trim(),
    imap_port: Number($("a-imap-port").value) || 993,
    smtp_host: $("a-smtp-host").value.trim(),
    smtp_port: Number($("a-smtp-port").value) || 587,
    user: $("a-user").value.trim(),
    smtp_starttls: $("a-starttls").checked,
  };
}

async function saveAccount({ silent = false } = {}) {
  await invoke("mail_account_set", {
    account: accountFromForm(),
    password: $("a-pass").value || null,
  });
  $("a-pass").value = "";
  await loadAccount();
  if (!silent) {
    $("a-status").textContent = tt("Compte enregistré.");
    $("a-status").className = "sheet-status ok";
  }
}

async function testAccount() {
  $("a-test").disabled = true;
  $("a-status").textContent = tt("Connexion…");
  $("a-status").className = "sheet-status";
  try {
    await saveAccount({ silent: true });   // on teste ce qui est à l'écran
    const msg = await invoke("mail_test");
    $("a-status").textContent = msg;
    $("a-status").className = "sheet-status ok";
  } catch (e) {
    $("a-status").textContent = String(e?.message || e);
    $("a-status").className = "sheet-status err";
  } finally {
    $("a-test").disabled = false;
  }
}

// ===== Câblage =============================================================

function bind() {
  $("btn-sync").addEventListener("click", sync);
  $("btn-account").addEventListener("click", openAccount);
  $("btn-compose").addEventListener("click", () => openCompose());

  document.querySelectorAll(".chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      filter = chip.dataset.filter;
      document.querySelectorAll(".chip[data-filter]").forEach((c) => c.classList.toggle("active", c === chip));
      renderList();
    });
  });
  $("search").addEventListener("input", (e) => { needle = e.target.value.trim().toLowerCase(); renderList(); });

  $("btn-reply").addEventListener("click", () => {
    const m = current();
    if (!m) return;
    const quoted = String(m.body || "").split("\n").map((l) => "> " + l).join("\n");
    openCompose({
      to: parseAddress(m.from).email || m.from,
      subject: replySubject(m.subject),
      body: `\n\n${tt("Le")} ${m.date || ""}, ${m.from} ${tt("a écrit :")}\n${quoted}`,
      replySource: m,
    });
  });
  $("btn-resume").addEventListener("click", () => {
    const d = current();
    if (!d) return;
    // Reprendre un brouillon, c'est l'ouvrir dans le composeur — pas l'envoyer.
    // Le geste d'envoi reste le vôtre, un clic plus loin, après relecture.
    openCompose({ to: d.to || "", subject: d.subject || "", body: d.body || "", draftId: d.id });
  });
  $("btn-summarize").addEventListener("click", summarize);
  $("btn-draft").addEventListener("click", draftReply);
  $("btn-unread").addEventListener("click", () => {
    const m = current();
    if (!m) return;
    m.read = false; persist(); renderList();
  });
  $("btn-delete").addEventListener("click", async () => {
    const m = current();
    if (!m) return;
    if (isDraftId(m.id)) {
      drafts = drafts.filter((d) => d.id !== m.id);
      currentId = null;
      $("reader-content").hidden = true;
      $("reader-empty").hidden = false;
      await persistDrafts();
      renderList();
      return;
    }
    // « Retirer de la liste » et non « Supprimer » : rien n'est effacé sur le
    // serveur. Le message revient à la prochaine relève, et c'est honnête.
    messages = messages.filter((x) => x.id !== m.id);
    currentId = null;
    $("reader-content").hidden = true;
    $("reader-empty").hidden = false;
    persist(); renderList();
  });

  $("c-cancel").addEventListener("click", closeCompose);
  $("c-send").addEventListener("click", send);
  $("c-ai").addEventListener("click", writeWithAi);
  $("c-to").addEventListener("input", suggestRecipients);

  $("a-cancel").addEventListener("click", () => { $("account-overlay").hidden = true; });
  $("a-save").addEventListener("click", () => saveAccount().catch((e) => {
    $("a-status").textContent = String(e?.message || e);
    $("a-status").className = "sheet-status err";
  }));
  $("a-test").addEventListener("click", testAccount);
  $("a-email").addEventListener("blur", guessServers);
  $("a-clear").addEventListener("click", async () => {
    if (!confirm(tt("Retirer ce compte et le courrier téléchargé de cette machine ?"))) return;
    await invoke("mail_account_clear");
    messages = []; currentId = null;
    $("reader-content").hidden = true; $("reader-empty").hidden = false;
    $("account-overlay").hidden = true;
    await loadAccount(); renderList();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("compose-overlay").hidden) closeCompose();
    else if (!$("account-overlay").hidden) $("account-overlay").hidden = true;
  });
}

// Un agent vient de déposer un brouillon : la liste doit le montrer sans
// qu'on ait à rouvrir l'app.
__TAURI.event?.listen?.("mail-drafts-updated", async () => {
  await loadDrafts();
  renderList();
});

// « Envoyer vers… Email » : une fiche du carnet ouvre la rédaction sur la
// bonne adresse ; un texte ou un fichier devient le corps du message.
receive("mail", (obj) => {
  if (!obj) return;
  if (obj.kind === "contact") {
    openCompose({ to: obj.email || "" });
    return;
  }
  openCompose({ subject: obj.title || "", body: toText(obj) });
});

autoTranslate({ observe: true });
bind();
loadAccount().then(loadAll);
