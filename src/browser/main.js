// Navigateur de Lumen — logique front.
// Deux vues :
//  - Lecture (défaut, fiable) : le backend `web_fetch` récupère la page (contourne
//    le CORS et l'interdiction d'iframe des sites), la convertit en Markdown avec
//    liens/images absolus, qu'on rend via renderMarkdown. Marche pour tout site.
//  - Live (iframe) : proposée seulement si le site autorise l'embedding (champ
//    `embeddable` renvoyé par le backend d'après les en-têtes X-Frame-Options / CSP).
// Le contenu récupéré alimente aussi le volet IA (résumé, points clés, traduction,
// questions, enregistrement RAG) — indépendant de la CSP.
import { translatePage, tt, observeTranslations } from "../apps-i18n.js";
import { llmChat } from "../llm.js";
import { streamTarget } from "../lib/stream-view.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { renderMarkdown } from "../sandbox/render.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";

// Dans une fenêtre intégrée (iframe même-origine du bureau), `__TAURI__` est
// injecté sur la fenêtre parente. On tente les deux (comme les autres apps).
const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const $ = (id) => document.getElementById(id);

const frame = $("wb-frame");
const reader = $("wb-reader");
const readerInner = $("wb-reader-inner");
const urlInput = $("wb-url");
const home = $("wb-home");
const spin = $("wb-spin");
const aiLog = $("wb-ai-log");
const aiEmpty = $("wb-ai-empty");
const aiPage = $("wb-ai-page");
const segLive = $("wb-seg-live");

// ===== Onglets =====
// Chaque onglet porte son propre historique (l'iframe cross-origin ne donne pas
// accès au sien), sa page récupérée et sa vue courante. Les vues live sont des
// iframes distinctes gardées en vie par onglet ; la vue lecture est rendue à la
// demande depuis `page`, il n'y a donc rien à conserver côté DOM.
let tabs = [];
let activeId = null;
let seq = 0;
let busy = false;

const newTabState = () => ({ id: `t${++seq}`, history: [], hpos: -1, page: null, view: "reader", title: "" });
const tab = () => tabs.find((t) => t.id === activeId) || null;

// Moteurs de recherche retenus : tous rendent des résultats exploitables en vue
// lecture, c'est-à-dire du HTML servi tel quel, sans exiger l'exécution de leur
// JavaScript. Un moteur « moderne » (Google, Bing) renverrait une page vide ici.
const SEARCH_ENGINES = {
  ddg: { label: "DuckDuckGo", url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}` },
  wikipedia: { label: "Wikipédia", url: (q) => `https://fr.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}` },
  marginalia: { label: "Marginalia", url: (q) => `https://search.marginalia.nu/search?query=${encodeURIComponent(q)}` },
};
const engineId = () => (SEARCH_ENGINES[localStorage.getItem("wb.engine")] ? localStorage.getItem("wb.engine") : "ddg");

const START_LINKS = [
  { label: "Hacker News", url: "https://news.ycombinator.com" },
  { label: "Wikipédia", url: "https://fr.wikipedia.org/wiki/Intelligence_artificielle" },
  { label: "NPR (texte)", url: "https://text.npr.org" },
  { label: "Premier site web (CERN)", url: "https://info.cern.ch" },
];

// ===== Navigation =====
function normalizeUrl(raw) {
  let s = (raw || "").trim();
  if (!s) return "";
  const looksUrl = /^[a-z]+:\/\//i.test(s) || /^[^\s]+\.[^\s]{2,}(\/|$|\?|#)/.test(s) || s.startsWith("localhost");
  if (looksUrl) {
    if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;
    return s;
  }
  // Recherche : moteur choisi par l'utilisateur, rendu lisible avec liens
  // cliquables en vue lecture (les pages de résultats classiques interdisent
  // l'iframe, et beaucoup n'affichent rien sans JavaScript).
  return SEARCH_ENGINES[engineId()].url(s);
}

function navigate(raw, { push = true, refresh = false } = {}) {
  const t = tab();
  if (!t) return;
  const url = normalizeUrl(raw);
  if (!url) return;
  if (push) {
    t.history = t.history.slice(0, t.hpos + 1);
    t.history.push(url);
    t.hpos = t.history.length - 1;
  }
  urlInput.value = url;
  home.hidden = true;
  updateNavButtons();
  loadPage(url, refresh);
}

function updateNavButtons() {
  const t = tab();
  $("wb-back").disabled = !t || t.hpos <= 0;
  $("wb-fwd").disabled = !t || t.hpos >= t.history.length - 1;
}
function goBack() { const t = tab(); if (t && t.hpos > 0) { t.hpos--; navigate(t.history[t.hpos], { push: false }); } }
function goForward() { const t = tab(); if (t && t.hpos < t.history.length - 1) { t.hpos++; navigate(t.history[t.hpos], { push: false }); } }
// Le rechargement court-circuite le cache backend : c'est tout l'intérêt du
// bouton, sans quoi il rejouerait la copie mémoire pendant cinq minutes.
function reload() { const t = tab(); if (t?.history[t.hpos]) navigate(t.history[t.hpos], { push: false, refresh: true }); }

// ===== Gestion des onglets =====
function renderTabs() {
  const strip = $("wb-tabs");
  strip.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("button");
    el.className = "wb-tab" + (t.id === activeId ? " active" : "");
    el.title = t.page?.finalUrl || t.title || tt("Nouvel onglet");
    const label = t.title || t.page?.title || (t.history[t.hpos] ? shortHost(t.history[t.hpos]) : tt("Nouvel onglet"));
    el.innerHTML = `<span class="wb-tab-lb">${escapeText(label)}</span>`;
    el.addEventListener("click", () => selectTab(t.id));
    if (tabs.length > 1) {
      const x = document.createElement("span");
      x.className = "wb-tab-x"; x.textContent = "✕"; x.title = tt("Fermer l'onglet");
      x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
      el.appendChild(x);
    }
    strip.appendChild(el);
  }
  // Un seul onglet : la barre n'apporte rien, on la masque.
  document.body.classList.toggle("wb-single-tab", tabs.length <= 1);
  updateScopeAvailability();
}
function shortHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
function newTab({ url = "", select = true } = {}) {
  const t = newTabState();
  tabs.push(t);
  if (select) activeId = t.id;
  renderTabs();
  if (select) paintTab();
  if (url) { if (!select) { const prev = activeId; activeId = t.id; navigate(url); activeId = prev; } else navigate(url); }
  else if (select) urlInput.focus();
  return t;
}
function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0 || tabs.length <= 1) return;
  tabs.splice(i, 1);
  if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)].id;
  renderTabs();
  paintTab();
}
function selectTab(id) {
  if (id === activeId) return;
  activeId = id;
  closeFind();
  renderTabs();
  paintTab();
}
// Réaffiche l'onglet actif à partir de son état, sans refaire de requête.
function paintTab() {
  const t = tab();
  if (!t) return;
  updateNavButtons();
  const url = t.history[t.hpos] || "";
  urlInput.value = t.page?.finalUrl || url;
  home.hidden = !!url;
  setLiveAvailable(!!t.page?.embeddable);
  if (!t.page) {
    readerInner.innerHTML = "";
    reader.hidden = false; frame.hidden = true;
    aiPage.textContent = tt("Aucune page chargée");
    return;
  }
  aiPage.textContent = t.page.title || t.page.finalUrl || url;
  if (t.view === "live" && t.page.embeddable) showLive(t.page.finalUrl || url);
  else showReader(t.page);
  syncSaveButton();
}

// ===== Chargement d'une page =====
async function loadPage(url, refresh = false) {
  const t = tab();
  if (!t) return;
  const owner = t.id;                 // l'onglet peut changer pendant l'attente
  const isActive = () => activeId === owner;
  if (isActive()) {
    spin.hidden = false;
    aiPage.textContent = tt("Chargement…");
    reader.hidden = false; frame.hidden = true;
    readerInner.innerHTML = `<div class="wb-reader-status">${tt("Chargement…")}</div>`;
  }
  t.page = null;
  if (isActive()) setLiveAvailable(false);
  try {
    const res = await invoke("web_fetch", { url, refresh });
    t.page = res;
    t.title = res.title || shortHost(res.finalUrl || url);
    renderTabs();
    if (!isActive()) return;          // l'utilisateur est passé à un autre onglet
    aiPage.textContent = res.title || res.finalUrl || url;
    aiPage.title = res.finalUrl || url;
    if (res.finalUrl) urlInput.value = res.finalUrl;
    setLiveAvailable(!!res.embeddable);
    // Un PDF n'a pas de vue live : on force la lecture plutôt que d'afficher un
    // cadre vide si l'utilisateur était resté sur l'autre onglet.
    if (t.view === "live" && res.embeddable) showLive(res.finalUrl || url);
    else showReader(res);
    syncSaveButton();
  } catch (e) {
    const msg = String(e?.message || e || "");
    // web_fetch absent = backend pas reconstruit depuis l'ajout de la commande.
    const hint = /not found|unknown|missing|introuvable|command/i.test(msg)
      ? tt("La commande backend « web_fetch » est indisponible. Relancez l'app (rebuild) pour activer le navigateur.")
      : msg;
    if (!isActive()) return;
    readerInner.innerHTML = `<div class="wb-reader-status wb-err">${escapeText(tt("Impossible de charger la page : ") + hint)}</div>`;
    aiPage.textContent = tt("Contenu indisponible");
  } finally {
    if (isActive()) spin.hidden = true;
  }
}

function showReader(res) {
  const t = tab();
  if (t) t.view = "reader";
  syncSeg();
  $("wb-live-badge").hidden = true;
  reader.hidden = false; frame.hidden = true;
  const head = res.title ? `<h1 class="wb-reader-title">${escapeText(res.title)}</h1>` : "";
  const tags = [
    res.kind === "pdf" ? `<span class="wb-tag pdf">PDF</span>` : "",
    res.cached ? `<span class="wb-tag">${tt("cache")}</span>` : "",
  ].join("");
  const src = `<div class="wb-reader-src">${tags}${escapeText(res.finalUrl || res.url)}</div>`;
  const trunc = res.truncated ? `<div class="wb-reader-note">${tt("Contenu tronqué (page très longue).")}</div>` : "";
  const bodyHtml = res.text ? renderMarkdown(res.text) : `<p>${tt("Aucun contenu texte extrait de cette page.")}</p>`;
  readerInner.innerHTML = head + src + bodyHtml + trunc;
  reader.scrollTop = 0;
}

function showLive(url) {
  const t = tab();
  if (t) t.view = "live";
  syncSeg();
  frame.hidden = false; reader.hidden = true;
  $("wb-live-badge").hidden = false;
  if (url && frame.src !== url) frame.src = url;
}

// Demande la vue live avec avertissement de sécurité (une fois, sauf si l'utilisateur
// a coché « ne plus demander »). confirm() ne marche pas sous WKWebView → bannière.
function requestLive() {
  const t = tab();
  if (!t?.page) { if (t) t.view = "live"; syncSeg(); return; }
  if (localStorage.getItem("wb.liveAck") === "1") { showLive(t.page.finalUrl || t.history[t.hpos]); return; }
  $("wb-warn").hidden = false;
}

function setLiveAvailable(ok) {
  // La vue live reste activable même si le site déclare interdire l'iframe :
  // l'en-tête est parfois trompeur, on informe seulement via l'infobulle. Un PDF
  // fait exception — il n'y a rien à afficher, on désactive vraiment.
  const isPdf = tab()?.page?.kind === "pdf";
  segLive.disabled = isPdf;
  segLive.title = isPdf
    ? tt("Vue live indisponible pour un PDF")
    : ok
      ? tt("Vue live (site interactif, exécute son JavaScript)")
      : tt("Vue live — ce site interdit peut-être l'affichage intégré (peut rester blanc)");
}
function syncSeg() {
  const v = tab()?.view || "reader";
  document.querySelectorAll(".wb-seg").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
}

// Clic sur un lien dans la vue lecture → navigation interne (pas de sortie d'app).
readerInner.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href");
  if (href && !href.startsWith("#")) navigate(href);
});

// ===== Liste de lecture (favoris + archive hors-ligne) =====
// Une entrée conserve le texte extrait : la page reste consultable même hors
// ligne ou si le site disparaît. Le stockage est volontairement plafonné —
// localStorage n'est pas une base d'archives.
const RL_KEY = "wb.readlist";
const RL_MAX = 30;
const RL_TEXT_MAX = 20000;

function readList() {
  try { const v = JSON.parse(localStorage.getItem(RL_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeList(items) {
  try { localStorage.setItem(RL_KEY, JSON.stringify(items.slice(0, RL_MAX))); } catch {}
  renderReadList();
}
function saveCurrentToList() {
  const p = tab()?.page;
  if (!p) { toast(tt("Aucune page à enregistrer.")); return; }
  const url = p.finalUrl || p.url;
  const items = readList().filter((it) => it.url !== url);
  items.unshift({
    url,
    title: p.title || shortHost(url),
    kind: p.kind || "html",
    savedAt: Date.now(),
    text: String(p.text || "").slice(0, RL_TEXT_MAX),
  });
  writeList(items);
  toast(tt("Ajouté à la liste de lecture."));
  syncSaveButton();
}
function renderReadList() {
  const host = $("wb-rl-items");
  if (!host) return;
  const items = readList();
  host.innerHTML = "";
  if (!items.length) {
    host.innerHTML = `<div class="wb-rl-empty">${escapeText(tt("Rien encore. Gardez une page avec le signet de la barre d'adresse."))}</div>`;
  }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "wb-rl-item";
    const when = new Date(it.savedAt || Date.now()).toLocaleDateString();
    row.innerHTML = `<button class="wb-rl-open"><span class="wb-rl-t">${escapeText(it.title)}</span>`
      + `<span class="wb-rl-m">${escapeText(shortHost(it.url))} · ${escapeText(when)}${it.kind === "pdf" ? " · PDF" : ""}</span></button>`
      + `<button class="wb-rl-del" title="${escapeText(tt("Retirer"))}">✕</button>`;
    row.querySelector(".wb-rl-open").addEventListener("click", () => openArchived(it));
    row.querySelector(".wb-rl-del").addEventListener("click", () => writeList(readList().filter((x) => x.url !== it.url)));
    host.appendChild(row);
  }
  $("wb-rl-foot").textContent = items.length
    ? tt("Contenu conservé hors ligne · ") + items.length + "/" + RL_MAX
    : "";
}
// Ouvre une entrée depuis l'archive, sans réseau. Un bandeau le dit clairement,
// pour qu'on ne prenne pas une copie datée pour la page en direct.
function openArchived(it) {
  const t = tab();
  if (!t) return;
  t.page = { url: it.url, finalUrl: it.url, title: it.title, text: it.text, truncated: false, embeddable: false, kind: it.kind, cached: true, archived: it.savedAt };
  t.title = it.title;
  t.history = t.history.slice(0, t.hpos + 1).concat([it.url]);
  t.hpos = t.history.length - 1;
  home.hidden = true;
  urlInput.value = it.url;
  renderTabs();
  updateNavButtons();
  showReader(t.page);
  aiPage.textContent = it.title;
}
function syncSaveButton() {
  const p = tab()?.page;
  const url = p && (p.finalUrl || p.url);
  const on = !!url && readList().some((it) => it.url === url);
  $("wb-save")?.classList.toggle("active", on);
}
function toast(msg) {
  const el = document.createElement("div");
  el.className = "wb-toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ===== Recherche dans la page (⌘F) =====
let findHits = [];
let findIdx = 0;
function openFind() {
  $("wb-find").hidden = false;
  const input = $("wb-find-input");
  input.focus(); input.select();
}
function closeFind() {
  $("wb-find").hidden = true;
  clearFindMarks();
  findHits = []; findIdx = 0;
  $("wb-find-count").textContent = "0/0";
}
function clearFindMarks() {
  readerInner.querySelectorAll("mark.wb-hit").forEach((m) => {
    const parent = m.parentNode;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
}
function runFind(q) {
  clearFindMarks();
  findHits = []; findIdx = 0;
  const needle = String(q || "").trim().toLowerCase();
  if (needle.length < 2) { $("wb-find-count").textContent = "0/0"; return; }
  // Parcours des nœuds texte : on enveloppe chaque occurrence dans un <mark>,
  // ce qui évite de reconstruire le HTML de la page (et de perdre les images).
  const walker = document.createTreeWalker(readerInner, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentNode.nodeName === "MARK" ? NodeFilter.FILTER_REJECT
      : n.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const node of targets) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let i = 0;
    for (;;) {
      const at = text.toLowerCase().indexOf(needle, i);
      if (at < 0) break;
      if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)));
      const mark = document.createElement("mark");
      mark.className = "wb-hit";
      mark.textContent = text.slice(at, at + needle.length);
      frag.appendChild(mark);
      findHits.push(mark);
      i = at + needle.length;
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    node.parentNode.replaceChild(frag, node);
  }
  if (findHits.length) gotoHit(0);
  else $("wb-find-count").textContent = "0/0";
}
function gotoHit(i) {
  if (!findHits.length) return;
  findHits[findIdx]?.classList.remove("current");
  findIdx = (i + findHits.length) % findHits.length;
  const m = findHits[findIdx];
  m.classList.add("current");
  m.scrollIntoView({ block: "center", behavior: "smooth" });
  $("wb-find-count").textContent = `${findIdx + 1}/${findHits.length}`;
}

// ===== Fonctionnalités IA =====
// Portée de l'analyse : la page affichée, ou tous les onglets chargés.
let aiScope = "page";
function loadedTabs() { return tabs.filter((t) => t.page?.text); }
function updateScopeAvailability() {
  const many = loadedTabs().length > 1;
  $("wb-scope").hidden = !many;
  $("wb-chip-compare").hidden = !(many && aiScope === "all");
  if (!many && aiScope === "all") setScope("page");
}
function setScope(scope) {
  aiScope = scope;
  document.querySelectorAll(".wb-scope-btn").forEach((b) => b.classList.toggle("active", b.dataset.scope === scope));
  $("wb-chip-compare").hidden = !(loadedTabs().length > 1 && scope === "all");
}

// Rogne un texte pour tenir dans la fenêtre de contexte, en gardant début et fin.
function fitToContext(text, budget) {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.78);
  return `${text.slice(0, head)}\n\n[… contenu central tronqué pour respecter le contexte …]\n\n${text.slice(-(budget - head))}`;
}
// Budget de caractères disponible pour le contenu, tous documents confondus.
function contextBudget() {
  if (localStorage.getItem("aiSource") !== "llama") return 90000;
  // llama-server répond 400 au-delà de sa fenêtre : on garde une marge pour le
  // prompt système et la réponse plutôt que d'échouer après coup.
  const ctx = Math.max(2048, Number.parseInt(localStorage.getItem("llamaNumCtx") || "8192", 10) || 8192);
  return Math.max(12000, Math.min(90000, (ctx - 2500) * 4));
}
function pageContext() {
  const docs = aiScope === "all" ? loadedTabs() : [tab()].filter((t) => t?.page?.text);
  if (!docs.length) return null;
  // Le budget est partagé entre les documents : comparer quatre pages ne doit
  // pas faire exploser la fenêtre du modèle.
  const per = Math.floor(contextBudget() / docs.length);
  return docs.map((t, i) => {
    const p = t.page;
    const head = docs.length > 1 ? `[${i + 1}] ` : "";
    return `${head}URL : ${p.finalUrl || p.url}\n${head}Titre : ${p.title || "(sans titre)"}\n\nContenu :\n${fitToContext(String(p.text), per)}`;
  }).join("\n\n=====\n\n");
}
// Consigne commune : en multi-pages, l'IA doit citer la source de chaque fait.
function citationRule() {
  return aiScope === "all" && loadedTabs().length > 1
    ? " Plusieurs pages numérotées [1], [2]… te sont fournies : cite systématiquement la source de chaque information avec son numéro."
    : "";
}
function addBubble(role, html) {
  aiEmpty.hidden = true;
  const el = document.createElement("div");
  el.className = "wb-msg " + role;
  el.innerHTML = html;
  aiLog.appendChild(el);
  aiLog.scrollTop = aiLog.scrollHeight;
  return el;
}
function formatAIError(error) {
  const raw = String(error?.message || error || "");
  if (/exceed_context_size_error/i.test(raw)) {
    const prompt = raw.match(/n_prompt["']?\s*:\s*(\d+)/i)?.[1];
    const context = raw.match(/n_ctx["']?\s*:\s*(\d+)/i)?.[1];
    const detail = prompt && context ? ` (${Number(prompt).toLocaleString()} tokens demandés, ${Number(context).toLocaleString()} disponibles)` : "";
    return `Contexte trop petit pour cette page${detail}. Augmente la « Taille du contexte llama.cpp » dans les Paramètres, puis réessaie.`;
  }
  return raw;
}
async function runAI(id, vars = {}, { label } = {}) {
  if (busy) return;
  const ctx = pageContext();
  if (!ctx) { addBubble("assistant", tt("Aucune page chargée à analyser. Ouvrez d'abord une adresse.")); return; }
  busy = true;
  if (label) addBubble("user", escapeText(label));
  const thinking = addBubble("assistant", `<span class="wb-dots"><i></i><i></i><i></i></span>`);
  try {
    const live = streamTarget(thinking, renderMarkdown);
    const { messages } = PROMPTS[id].build({ page: ctx, lang: replyLang(), ...vars });
    messages[0].content += citationRule();
    const { content } = await llmChat(messages, { rawSystem: true, onUpdate: live.onUpdate });
    live.done(renderMarkdown(content || tt("(réponse vide)")));
    try { recordOllamaUsage?.(); } catch {}
  } catch (e) {
    thinking.innerHTML = `<span class="wb-err">${escapeText(tt("Échec IA : ") + formatAIError(e))}</span>`;
  } finally {
    busy = false;
    aiLog.scrollTop = aiLog.scrollHeight;
  }
}
const multi = () => aiScope === "all" && loadedTabs().length > 1;
function summarize() {
  runAI("app.browser.summary", {}, { label: multi() ? tt("Résumer les onglets") : tt("Résumer la page") });
}
function keypoints() {
  runAI("app.browser.keypoints", {}, { label: tt("Points clés") });
}
// Comparaison : n'a de sens qu'avec plusieurs onglets chargés.
function compare() {
  runAI("app.browser.compare", {}, { label: tt("Comparer les onglets") });
}
function translate() {
  const lang = $("wb-lang").value;
  runAI("app.browser.translate-to", { target: lang }, { label: tt("Traduire en ") + lang });
}
function ask(question) {
  runAI("app.browser.qa", { question }, { label: question });
}
// Les documents concernés par un export : la page seule ou tous les onglets,
// selon la portée choisie — cohérent avec ce que l'IA analyse.
function exportDocs() {
  return aiScope === "all" ? loadedTabs().map((t) => t.page) : [tab()?.page].filter((p) => p?.text);
}
async function saveToKnowledge() {
  if (busy) return;
  const docs = exportDocs();
  if (!docs.length) { addBubble("assistant", tt("Aucune page à enregistrer.")); return; }
  busy = true;
  const note = addBubble("assistant", tt("Enregistrement dans Connaissances…"));
  try {
    for (const p of docs) {
      await invoke("rag_add_text", {
        title: p.title || p.finalUrl || p.url,
        text: p.text,
        source: p.finalUrl || p.url,
      });
    }
    note.innerHTML = `✓ ${escapeText(docs.length > 1
      ? `${docs.length} ${tt("pages enregistrées dans Connaissances (RAG).")}`
      : tt("Page enregistrée dans Connaissances (RAG)."))}`;
  } catch (e) {
    note.innerHTML = `<span class="wb-err">${escapeText(tt("Échec de l'enregistrement : ") + (e?.message || e))}</span>`;
  } finally {
    busy = false;
  }
}
// Export Markdown dans une sandbox : le fichier devient exploitable par Muse,
// Opus ou Prisme sans quitter l'environnement confiné.
async function exportMarkdown() {
  if (busy) return;
  const docs = exportDocs();
  if (!docs.length) { addBubble("assistant", tt("Aucune page à exporter.")); return; }
  busy = true;
  const note = addBubble("assistant", tt("Export en cours…"));
  try {
    const sandboxes = await invoke("sandbox_list");
    const sb = sandboxes?.[0];
    if (!sb) throw new Error(tt("Aucune sandbox disponible"));
    const body = docs.map((p) => `# ${p.title || p.finalUrl}\n\nSource : ${p.finalUrl || p.url}\n\n${p.text}`).join("\n\n---\n\n");
    const stamp = new Date().toISOString().slice(0, 10);
    const base = slugify(docs.length > 1 ? `veille-${stamp}` : (docs[0].title || shortHost(docs[0].finalUrl || docs[0].url)));
    const path = `web/${base}.md`;
    await invoke("sandbox_write_file", { id: sb.id, path, content: body });
    note.innerHTML = `✓ ${escapeText(tt("Exporté dans ") + sb.name + " · " + path)}`;
  } catch (e) {
    note.innerHTML = `<span class="wb-err">${escapeText(tt("Échec de l'export : ") + (e?.message || e))}</span>`;
  } finally {
    busy = false;
  }
}
function slugify(s) {
  return String(s || "page").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
}

function escapeText(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

// ===== Câblage UI =====
function init() {
  $("wb-back").addEventListener("click", goBack);
  $("wb-fwd").addEventListener("click", goForward);
  $("wb-reload").addEventListener("click", reload);
  $("wb-urlform").addEventListener("submit", (e) => { e.preventDefault(); navigate(urlInput.value); });
  // Le site refuse l'iframe (ENT, Moodle, Teams, Docs…) ou demande une
  // connexion : on le rouvre dans le navigateur complet de Lumen (onglets
  // natifs). ⌥-clic garde l'ancien geste : le navigateur du système.
  $("wb-ext").addEventListener("click", (e) => {
    const t = tab();
    const u = t?.page?.finalUrl || t?.history[t.hpos];
    if (e.altKey) { if (u) invoke("open_external", { url: u }).catch(() => {}); return; }
    invoke("browser_open", { url: u || null }).catch(() => { if (u) invoke("open_external", { url: u }).catch(() => {}); });
  });
  document.querySelectorAll(".wb-seg").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.view;
    const t = tab();
    if (v === "live") requestLive();
    else if (t?.page) showReader(t.page);
    else { if (t) t.view = "reader"; syncSeg(); }
  }));
  // Avertissement de sécurité de la vue live.
  $("wb-warn-ok").addEventListener("click", () => {
    if ($("wb-warn-remember").checked) localStorage.setItem("wb.liveAck", "1");
    $("wb-warn").hidden = true;
    const t = tab();
    if (t?.page) showLive(t.page.finalUrl || t.history[t.hpos]);
  });
  $("wb-warn-cancel").addEventListener("click", () => { $("wb-warn").hidden = true; });
  $("wb-ai-toggle").addEventListener("click", (e) => {
    const on = document.body.classList.toggle("wb-ai-hidden");
    e.currentTarget.classList.toggle("active", !on);
  });
  document.querySelectorAll(".wb-chip").forEach((b) => b.addEventListener("click", () => {
    const act = b.dataset.act;
    if (act === "summarize") summarize();
    else if (act === "keypoints") keypoints();
    else if (act === "compare") compare();
    else if (act === "translate") translate();
    else if (act === "knowledge") saveToKnowledge();
    else if (act === "export") exportMarkdown();
  }));
  document.querySelectorAll(".wb-scope-btn").forEach((b) => b.addEventListener("click", () => setScope(b.dataset.scope)));

  // ===== Onglets, liste de lecture, recherche =====
  $("wb-tab-new").addEventListener("click", () => newTab());
  $("wb-save").addEventListener("click", saveCurrentToList);
  $("wb-readlist-toggle").addEventListener("click", () => {
    const el = $("wb-readlist");
    el.hidden = !el.hidden;
    if (!el.hidden) renderReadList();
  });
  $("wb-rl-close").addEventListener("click", () => { $("wb-readlist").hidden = true; });

  $("wb-find-input").addEventListener("input", (e) => runFind(e.target.value));
  $("wb-find-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); gotoHit(findIdx + (e.shiftKey ? -1 : 1)); }
    if (e.key === "Escape") closeFind();
  });
  $("wb-find-next").addEventListener("click", () => gotoHit(findIdx + 1));
  $("wb-find-prev").addEventListener("click", () => gotoHit(findIdx - 1));
  $("wb-find-close").addEventListener("click", closeFind);

  document.addEventListener("keydown", (e) => {
    const cmd = e.metaKey || e.ctrlKey;
    if (!cmd) return;
    const k = e.key.toLowerCase();
    if (k === "t") { e.preventDefault(); newTab(); }
    else if (k === "w" && tabs.length > 1) { e.preventDefault(); closeTab(activeId); }
    else if (k === "f") { e.preventDefault(); openFind(); }
    else if (k === "d") { e.preventDefault(); saveCurrentToList(); }
    else if (k === "l") { e.preventDefault(); urlInput.focus(); urlInput.select(); }
  });
  $("wb-ai-ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("wb-ai-input").value.trim();
    if (!q) return;
    $("wb-ai-input").value = "";
    ask(q);
  });

  // Taille du texte de la vue lecture, persistée (échelle 0.85 → 1.5).
  const applyZoom = () => {
    const z = Number(localStorage.getItem("wb.zoom") || "1") || 1;
    readerInner.style.fontSize = `${(z * 100).toFixed(0)}%`;
  };
  document.querySelectorAll(".wb-zoom-btn").forEach((b) => b.addEventListener("click", () => {
    const cur = Number(localStorage.getItem("wb.zoom") || "1") || 1;
    const next = Math.min(1.5, Math.max(0.85, cur + (b.dataset.zoom === "+" ? 0.1 : -0.1)));
    localStorage.setItem("wb.zoom", next.toFixed(2));
    applyZoom();
  }));
  applyZoom();

  const engineSel = $("wb-engine");
  for (const [id, e] of Object.entries(SEARCH_ENGINES)) {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = e.label;
    engineSel.appendChild(opt);
  }
  engineSel.value = engineId();
  engineSel.addEventListener("change", () => localStorage.setItem("wb.engine", engineSel.value));

  const quick = $("wb-quick");
  for (const l of START_LINKS) {
    const a = document.createElement("button");
    a.className = "wb-quick-link";
    a.textContent = l.label;
    a.addEventListener("click", () => navigate(l.url));
    quick.appendChild(a);
  }

  newTab({ select: true });
  // Recherche ou adresse envoyée par une autre app (recherche globale du
  // bureau, « Envoyer vers… ») : onglet courant s'il est vierge, sinon neuf.
  import("../lib/interop.js").then(({ receive }) => receive("browser", (obj) => {
    const q = String(obj?.url || obj?.text || "").trim();
    if (!q) return;
    const t = tab();
    if (t && !t.history.length) navigate(q);
    else newTab({ url: q, select: true });
  })).catch(() => {});
  renderReadList();
  translatePage(document.body);
  observeTranslations();
  urlInput.focus();
  registerBrowserIntent();
}

/// App Intent « browser_do » : la tâche est confiée à l'agent du navigateur
/// complet (fenêtre native browser/chrome.html), qui seul peut agir dans une
/// vraie page ; le compte rendu revient par évènement.
function registerBrowserIntent() {
  const intents = window.lumen?.intents;
  const ev = (window.__TAURI__ || window.parent?.__TAURI__)?.event;
  if (!intents || !ev || !invoke) return;
  intents.on("browser_do", async ({ goal, url }) => {
    const reqId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const result = new Promise((resolve) => {
      let un = null;
      const timer = setTimeout(() => { un?.(); resolve("Le navigateur n'a pas rendu de compte rendu à temps (tâche peut-être en cours)."); }, 8 * 60 * 1000);
      ev.listen("browser-agent-result", (e) => {
        if (e.payload?.reqId !== reqId) return;
        clearTimeout(timer); un?.(); resolve(String(e.payload.text || "C'est fait."));
      }).then((u) => { un = u; });
    });
    await invoke("browser_open", { url: null });
    // Laisse la fenêtre du navigateur se monter avant de lui confier la tâche.
    await new Promise((r) => setTimeout(r, 1500));
    await ev.emit("browser-agent-run", { reqId, goal: String(goal || ""), url: String(url || "") });
    return result;
  }).catch(() => {});
}

init();
