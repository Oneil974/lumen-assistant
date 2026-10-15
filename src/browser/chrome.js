// Interface du navigateur complet : onglets natifs pilotés par Rust
// (src-tauri/src/browser.rs), favoris et historique locaux, téléchargements,
// extensions, et un assistant qui lit la page RÉELLEMENT affichée.

import { autoTranslate, registerTranslations, tt } from "../apps-i18n.js";
import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { streamTarget } from "../lib/stream-view.js";
import { markdownToHtml } from "../lib/markdown.js";
import { confirmSheet } from "../lib/confirm.js";
import { runAiTools, tool, T } from "../lib/ai-prompt.js?v=5";
import { CHROME_EN } from "./chrome-i18n.js";

registerTranslations(CHROME_EN);

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PANEL_W = 380;

let tabs = [];
let active = null;
let downloads = [];
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`browser.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`browser.${k}`, JSON.stringify(v)); } catch {} },
};

function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600); }
const cur = () => tabs.find((t) => t.id === active) || null;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// ===== Onglets ==============================================================
function renderTabs() {
  $("tabs").innerHTML = tabs.map((t) => `
    <div class="tab${t.id === active ? " is-on" : ""}${t.private ? " is-private" : ""}" data-id="${t.id}" title="${esc(t.title || t.url)}">
      <span class="fav">${t.loading ? '<i class="spin"></i>' : esc((hostOf(t.url)[0] || "•").toUpperCase())}</span>
      <span class="t">${esc(t.title || hostOf(t.url) || tt("Nouvel onglet"))}</span>
      <button class="x" data-close="${t.id}" title="${esc(tt("Fermer l'onglet"))}">✕</button>
    </div>`).join("") + `<button class="tab-new" id="tab-new" title="${esc(tt("Nouvel onglet (⌘T)"))}">＋</button>`;
  const c = cur();
  if (document.activeElement !== $("omni")) $("omni").value = c && c.url !== "about:blank" ? c.url : "";
  $("lock").textContent = c?.url?.startsWith("https://") ? "🔒" : c?.url?.startsWith("http://") ? "⚠︎" : "";
  $("b-star").textContent = isBookmarked(c?.url) ? "★" : "☆";
  $("placeholder").hidden = tabs.length > 0;
  document.title = c?.title ? `${c.title} — Lumen` : "Lumen — Navigateur";
}

function onTabs(payload) {
  tabs = payload.tabs || [];
  active = payload.active ?? null;
  for (const t of tabs) if (!t.private && !t.loading && t.url.startsWith("http")) recordHistory(t);
  renderTabs();
}

// ===== Favoris et historique =================================================
const bookmarks = () => LS.get("bookmarks", []);
const isBookmarked = (url) => !!url && bookmarks().some((b) => b.url === url);
function toggleBookmark() {
  const c = cur();
  if (!c || !c.url.startsWith("http")) return;
  let list = bookmarks();
  if (isBookmarked(c.url)) list = list.filter((b) => b.url !== c.url);
  else list.push({ url: c.url, title: c.title || hostOf(c.url) });
  LS.set("bookmarks", list);
  renderBookmarks(); renderTabs();
}
function renderBookmarks() {
  const list = bookmarks();
  $("bookmarks").innerHTML = list.length
    ? list.slice(0, 20).map((b) => `<button class="bm" data-url="${esc(b.url)}" title="${esc(b.url)}">${esc(b.title.slice(0, 28))}</button>`).join("")
    : `<span class="muted">${esc(tt("Vos favoris s'affichent ici (☆ dans la barre d'adresse)."))}</span>`;
}
function recordHistory(t) {
  const h = LS.get("history", []);
  if (h[0]?.url === t.url) { if (t.title && h[0].title !== t.title) { h[0].title = t.title; LS.set("history", h); } return; }
  h.unshift({ url: t.url, title: t.title || "", at: Date.now() });
  LS.set("history", h.slice(0, 800));
}

// ===== Volet latéral =========================================================
let panel = "";
async function openPanel(name) {
  if (panel === name) { closePanel(); return; }
  panel = name;
  $("panel").hidden = false;
  $("panel-title").textContent = tt({ assistant: "Assistant", downloads: "Téléchargements", history: "Historique et favoris", extensions: "Extensions" }[name]);
  document.querySelectorAll("[data-view]").forEach((s) => (s.hidden = s.dataset.view !== name));
  document.querySelectorAll("[data-panel]").forEach((b) => b.classList.toggle("is-on", b.dataset.panel === name));
  await invoke("browser_set_side", { px: PANEL_W });
  if (name === "downloads") { renderDownloads(); $("dl-dot").hidden = true; }
  if (name === "history") renderHistory();
  if (name === "extensions") renderExtensions();
}
async function closePanel() {
  panel = "";
  $("panel").hidden = true;
  document.querySelectorAll("[data-panel]").forEach((b) => b.classList.remove("is-on"));
  await invoke("browser_set_side", { px: 0 });
}

function renderDownloads() {
  $("downloads").innerHTML = downloads.length ? downloads.map((d, i) => `
    <div class="row">
      <span class="grow"><b>${esc(String(d.path || d.url).split(/[\\/]/).pop())}</b><small>${esc(tt(d.state === "done" ? "Terminé" : d.state === "failed" ? "Échec" : "En cours…"))}</small></span>
      ${d.state === "done" && d.path ? `<button class="btn" data-open="${i}">${esc(tt("Ouvrir"))}</button><button class="btn" data-reveal="${i}">${esc(tt("Afficher"))}</button>` : ""}
    </div>`).join("") : `<p class="muted">${esc(tt("Aucun téléchargement. Les fichiers vont dans votre dossier Téléchargements."))}</p>`;
}

function renderHistory() {
  const q = $("hist-filter").value.toLowerCase();
  $("bm-list").innerHTML = bookmarks().map((b, i) => `<div class="row"><a class="grow" data-url="${esc(b.url)}"><b>${esc(b.title)}</b><small>${esc(hostOf(b.url))}</small></a><button class="btn" data-bmdel="${i}">✕</button></div>`).join("") || `<p class="muted">—</p>`;
  const h = LS.get("history", []).filter((x) => !q || (x.title + x.url).toLowerCase().includes(q)).slice(0, 150);
  $("history").innerHTML = h.map((x) => `<a class="row" data-url="${esc(x.url)}"><span class="grow"><b>${esc(x.title || hostOf(x.url))}</b><small>${esc(new Date(x.at).toLocaleString())} · ${esc(hostOf(x.url))}</small></span></a>`).join("") || `<p class="muted">—</p>`;
}

let extensions = [];
async function renderExtensions() {
  try { extensions = await invoke("browser_extensions"); } catch { extensions = []; }
  $("ext-list").innerHTML = extensions.map((e, i) => `
    <div class="row">
      <label class="grow chk"><input type="checkbox" data-ext="${i}" ${e.enabled ? "checked" : ""}/> <span><b>${esc(tt(e.name))}</b><small>${esc(e.builtin ? tt("intégrée") : e.matches || "*")}</small></span></label>
      ${e.builtin ? "" : `<button class="btn" data-extdel="${i}">✕</button>`}
    </div>`).join("");
}
async function saveExtensions() {
  try { await invoke("browser_extensions_save", { list: extensions }); toast(tt("Extensions enregistrées : rechargez la page.")); }
  catch (e) { toast(String(e?.message || e)); }
}

// ===== Assistant =============================================================
async function pageText() {
  if (active == null) throw new Error(tt("Aucun onglet ouvert."));
  return invoke("browser_page_text", { id: active });
}
async function runAi(kind, question = "", given = null) {
  const out = $("ai-out");
  out.innerHTML = `<p class="muted">${esc(tt("Lecture de la page…"))}</p>`;
  try {
    // `given` : texte déjà fourni par le menu contextuel (sélection).
    const page = given || await pageText();
    const en = tt("Résumer la page") !== "Résumer la page";
    if (kind === "cards") {
      const { handoff, makeObject } = await import("../lib/interop.js");
      await handoff("studies", makeObject("text", { title: page.title, text: `${page.title}\n${page.url}\n\n${page.text}` }, { app: "browser", name: "Navigateur" }));
      out.innerHTML = `<p class="muted">${esc(tt("Page envoyée à Études : les fiches s'y génèrent."))}</p>`;
      return;
    }
    const source = kind === "selection" ? page.selection : page.text;
    if (!String(source || "").trim()) { out.innerHTML = `<p class="muted">${esc(tt(kind === "selection" ? "Sélectionnez d'abord du texte dans la page." : "Cette page ne contient pas de texte lisible."))}</p>`; return; }
    const code = en ? "en" : "fr";
    const text = source.slice(0, 30000);
    const { messages } = kind === "ask" ? PROMPTS["app.browser.qa"].build({ page: `« ${page.title} »\n${text}`, question, lang: code })
      : kind === "selection" ? PROMPTS["app.browser.selection"].build({ text, lang: code })
        : kind === "translate" ? PROMPTS["app.browser.translate"].build({ text, lang: code })
          : PROMPTS["app.browser.summary"].build({ page: `« ${page.title} »\n${text}`, lang: code });
    out.innerHTML = `<p class="muted">${esc(tt("Réflexion…"))}</p>`;
    const live = streamTarget(out, markdownToHtml);
    const { content } = await llmChat(messages, { rawSystem: true, onUpdate: live.onUpdate });
    live.done(markdownToHtml(String(content || "")));
  } catch (e) {
    out.innerHTML = `<p class="muted">${esc(String(e?.message || e))}</p>`;
  }
}

// ===== Agent « Fais-le pour moi » ============================================
// Boucle d'outils (lib/ai-prompt.js › runAiTools) sur l'onglet actif : le
// modèle lit un instantané de la page (éléments numérotés, browser.rs) et agit
// par numéro. Garde-fous : jamais de saisie dans un champ mot de passe ;
// accord explicite avant un clic qui engage (envoi, paiement, suppression…).
const RISKY = /(payer|paiement|acheter|achat|commander|commande|réserver|confirmer|valider|envoyer|publier|poster|supprimer|effacer|désinscri|souscri|s'abonner|pay|buy|order|checkout|purchase|book|confirm|submit|send|post|publish|delete|remove|unsubscribe|subscribe)/i;
let agentSnap = null;
let agentStop = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function snapshot() {
  if (active == null) throw new Error(tt("Aucun onglet ouvert."));
  agentSnap = await invoke("browser_agent_snapshot", { id: active });
  return agentSnap;
}
function describeSnap(sn) {
  const els = (sn.elements || []).map((e) => `[${e.ref}] ${e.tag}${e.type ? `(${e.type})` : ""} « ${e.text} »${e.value ? ` valeur=« ${e.value} »` : ""}${e.options ? ` options=${e.options.join(" | ")}` : ""}${e.href ? ` → ${e.href}` : ""}${e.disabled ? " (désactivé)" : ""}${e.offscreen ? " (hors écran)" : ""}`).join("\n");
  return `Page : ${sn.title}\nAdresse : ${sn.url}\nDéfilement : ${sn.scroll}/${sn.height}\n\nÉléments :\n${els || "(aucun)"}\n\nTexte visible (début) :\n${String(sn.text || "").slice(0, 3500)}`;
}
const elOf = (ref) => (agentSnap?.elements || []).find((e) => e.ref === Number(ref));

const AGENT_TOOLS = [
  tool("read_page", "Relit la page de l'onglet : éléments interactifs numérotés et texte visible. À appeler au début et après chaque navigation.", {}),
  tool("click", "Clique sur l'élément numéroté (lien, bouton, case…).", { ref: T.int("Numéro de l'élément") }, ["ref"]),
  tool("type", "Saisit du texte dans un champ numéroté (remplace son contenu si clear=true).", { ref: T.int("Numéro du champ"), text: T.str("Texte à saisir"), clear: { type: "boolean", description: "Vider le champ avant" } }, ["ref", "text"]),
  tool("select", "Choisit une option dans une liste déroulante numérotée.", { ref: T.int("Numéro de la liste"), option: T.str("Texte de l'option") }, ["ref", "option"]),
  tool("press_enter", "Valide le champ numéroté (touche Entrée), par ex. une recherche.", { ref: T.int("Numéro du champ") }, ["ref"]),
  tool("scroll", "Fait défiler la page.", { direction: T.enum(["down", "up"], "Sens") }, ["direction"]),
  tool("navigate", "Ouvre une adresse dans l'onglet.", { url: T.str("Adresse complète ou recherche") }, ["url"]),
  tool("back", "Revient à la page précédente.", {}),
];

async function agentExecute(name, a) {
  if (agentStop?.aborted) throw new Error("arrêté par l'utilisateur");
  const step = (msg) => { $("agent-steps").insertAdjacentHTML("beforeend", `<div class="agent-step">${esc(msg)}</div>`); $("agent-steps").scrollTop = 1e9; };
  const act = (action, extra = {}) => invoke("browser_agent_act", { id: active, action, ...extra });
  switch (name) {
    case "read_page": { step(tt("Lecture de la page…")); return describeSnap(await snapshot()); }
    case "click": {
      const el = elOf(a.ref);
      const label = el ? `${el.text}${el.type ? ` (${el.type})` : ""}` : `#${a.ref}`;
      if (el && (RISKY.test(el.text) || el.type === "submit")) {
        const ok = await confirmSheet({ title: tt("L'assistant veut cliquer sur « {l} »", { l: el.text || el.type }), body: `${agentSnap?.title || ""}\n${agentSnap?.url || ""}`, confirm: tt("Autoriser"), cancel: tt("Refuser") });
        if (!ok) { step(tt("Refusé : {l}", { l: label })); return "L'utilisateur a REFUSÉ cette action. N'insiste pas : propose une alternative ou arrête-toi."; }
      }
      step(tt("Clic : {l}", { l: label }));
      const r = await act("click", { ref: Number(a.ref) });
      await sleep(1200);
      return r?.ok ? "Clic effectué. Relis la page pour voir le résultat." : `Échec : ${r?.err || "inconnu"}`;
    }
    case "type": {
      const el = elOf(a.ref);
      if (el?.type === "password" || /mot de passe|password|passcode|code secret|cvv|cvc|iban|carte/i.test(el?.text || "")) {
        step(tt("Refusé : saisie d'un mot de passe ou de données bancaires"));
        return "Refusé : tu ne dois JAMAIS saisir de mot de passe, code ou donnée bancaire. Demande à l'utilisateur de le faire lui-même.";
      }
      step(tt("Saisie dans « {l} »", { l: el?.text || `#${a.ref}` }));
      const r = await act(a.clear ? "clear_type" : "type", { ref: Number(a.ref), text: String(a.text || "") });
      return r?.ok ? "Texte saisi." : `Échec : ${r?.err || "inconnu"}`;
    }
    case "select": { const r = await act("select", { ref: Number(a.ref), text: String(a.option || "") }); step(tt("Choix : {o}", { o: a.option })); return r?.ok ? `Option choisie : ${r.picked}` : `Échec : ${r?.err}`; }
    case "press_enter": { step(tt("Validation (Entrée)")); const r = await act("press_enter", { ref: Number(a.ref) }); await sleep(1500); return r?.ok ? "Validé. Relis la page." : "Échec."; }
    case "scroll": { const r = await act("scroll", { text: a.direction === "up" ? "up" : "down" }); return `Défilé (position ${r?.scroll ?? "?"}). Relis la page.`; }
    case "navigate": { step(tt("Ouverture : {u}", { u: a.url })); await invoke("browser_navigate", { id: active, url: String(a.url || "") }); await sleep(2200); return "Page en cours de chargement. Relis la page."; }
    case "back": { await invoke("browser_action", { id: active, action: "back" }); await sleep(1500); return "Retour effectué. Relis la page."; }
    default: return `Outil inconnu : ${name}`;
  }
}

async function runAgent(goal, startUrl = "") {
  if (!goal.trim()) return "";
  if (active == null) { await invoke("browser_new_tab", startUrl ? { url: startUrl } : {}); await sleep(1500); }
  else if (startUrl) { await invoke("browser_navigate", { id: active, url: startUrl }); await sleep(2000); }
  openPanel("assistant");
  const steps = $("agent-steps"), out = $("ai-out"), btn = $("agent-go");
  steps.innerHTML = ""; out.innerHTML = "";
  agentStop = new AbortController();
  btn.textContent = tt("Arrêter"); btn.dataset.running = "1";
  try {
    const answer = await runAiTools({
      app: "Navigateur",
      intro: "Tu pilotes le navigateur de l'utilisateur pour accomplir sa demande, étape par étape, comme une personne le ferait.",
      rules: [
        "- Commence par read_page ; relis la page après chaque clic, validation ou navigation.",
        "- Désigne les éléments UNIQUEMENT par leur numéro [n] tiré de la dernière lecture.",
        "- Ne saisis JAMAIS de mot de passe, de code, ni de donnée bancaire ; ne crée pas de compte.",
        "- Avant d'envoyer, payer, réserver ou supprimer quoi que ce soit, l'utilisateur est consulté automatiquement : s'il refuse, arrête-toi.",
        "- Si une connexion, un captcha ou une information manquante bloque, arrête-toi et explique ce qu'il faut faire.",
        "- Termine par un compte rendu court de ce que tu as fait et de ce que tu as trouvé.",
      ].join("\n"),
      tools: AGENT_TOOLS,
      execute: agentExecute,
      maxTurns: 24,
      context: async () => (active != null ? `Onglet actif : ${cur()?.title || ""} — ${cur()?.url || ""}` : "Aucun onglet."),
    }, goal);
    out.innerHTML = markdownToHtml(String(answer || ""));
    return String(answer || "");
  } catch (e) {
    out.innerHTML = `<p class="muted">${esc(String(e?.message || e))}</p>`;
    return `Échec : ${e?.message || e}`;
  } finally {
    btn.textContent = tt("Lancer"); delete btn.dataset.running; agentStop = null;
  }
}

// ===== Démarrage =============================================================
async function init() {
  document.addEventListener("click", async (e) => {
    const close = e.target.closest("[data-close]");
    if (close) { e.stopPropagation(); await invoke("browser_close_tab", { id: Number(close.dataset.close) }); return; }
    const tab = e.target.closest(".tab[data-id]");
    if (tab) { await invoke("browser_activate", { id: Number(tab.dataset.id) }); return; }
    if (e.target.closest("#tab-new")) { await invoke("browser_new_tab", {}); $("omni").focus(); return; }
    const url = e.target.closest("[data-url]")?.dataset.url;
    if (url) { e.preventDefault(); if (active != null) await invoke("browser_navigate", { id: active, url }); else await invoke("browser_new_tab", { url }); return; }
    const p = e.target.closest("[data-panel]")?.dataset.panel;
    if (p) { openPanel(p); return; }
    const d = e.target.closest("[data-open]"); if (d) invoke("open_exported_file", { path: downloads[Number(d.dataset.open)].path }).catch((err) => toast(String(err)));
    const r = e.target.closest("[data-reveal]"); if (r) invoke("backup_reveal", { path: downloads[Number(r.dataset.reveal)].path }).catch(() => {});
    const bd = e.target.closest("[data-bmdel]"); if (bd) { const l = bookmarks(); l.splice(Number(bd.dataset.bmdel), 1); LS.set("bookmarks", l); renderBookmarks(); renderHistory(); }
    const xd = e.target.closest("[data-extdel]"); if (xd) { extensions.splice(Number(xd.dataset.extdel), 1); await saveExtensions(); renderExtensions(); }
    const ai = e.target.closest("[data-ai]")?.dataset.ai; if (ai) runAi(ai);
  });
  $("ext-list").addEventListener("change", async (e) => {
    const i = e.target.dataset.ext;
    if (i == null) return;
    extensions[Number(i)].enabled = e.target.checked;
    await saveExtensions();
  });
  $("x-add").onclick = async () => {
    const name = $("x-name").value.trim();
    if (!name || (!$("x-js").value.trim() && !$("x-css").value.trim())) { toast(tt("Donnez un nom et du CSS ou du JavaScript.")); return; }
    extensions.push({ id: `u${Date.now().toString(36)}`, name, matches: $("x-match").value.trim() || "*", css: $("x-css").value, code: $("x-js").value, enabled: true, builtin: false });
    await saveExtensions();
    ["x-name", "x-match", "x-css", "x-js"].forEach((id) => ($(id).value = ""));
    renderExtensions();
  };
  // Tâche déléguée par l'assistant (App Intent « browser_do », reçue par la
  // page du paquet puis relayée ici) : on l'exécute et on rend le compte rendu.
  listen("browser-agent-run", async (e) => {
    const { reqId, goal, url } = e.payload || {};
    $("agent-goal").value = String(goal || "");
    const text = await runAgent(String(goal || ""), String(url || ""));
    window.__TAURI__.event.emit("browser-agent-result", { reqId, text });
  });
  $("agent-form").onsubmit = (e) => {
    e.preventDefault();
    if ($("agent-go").dataset.running) { agentStop?.abort(); return; }
    runAgent($("agent-goal").value);
  };
  $("omni-form").onsubmit = async (e) => {
    e.preventDefault();
    const v = $("omni").value.trim();
    if (!v) return;
    try {
      if (active != null) await invoke("browser_navigate", { id: active, url: v });
      else await invoke("browser_new_tab", { url: v });
      $("omni").blur();
    } catch (err) { toast(String(err?.message || err)); }
  };
  $("omni").addEventListener("focus", () => $("omni").select());
  $("b-back").onclick = () => active != null && invoke("browser_action", { id: active, action: "back" });
  $("b-fwd").onclick = () => active != null && invoke("browser_action", { id: active, action: "forward" });
  $("b-reload").onclick = () => active != null && invoke("browser_action", { id: active, action: "reload" });
  $("b-star").onclick = toggleBookmark;
  $("b-private").onclick = () => invoke("browser_new_tab", { private: true });
  $("panel-close").onclick = closePanel;
  $("find").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && active != null) invoke("browser_find", { id: active, query: $("find").value, backwards: e.shiftKey });
  });
  $("hist-filter").oninput = renderHistory;
  $("hist-clear").onclick = async () => {
    if (await confirmSheet({ title: tt("Effacer l'historique ?"), confirm: tt("Effacer"), cancel: tt("Annuler"), danger: true })) { LS.set("history", []); renderHistory(); }
  };
  $("ask-form").onsubmit = (e) => { e.preventDefault(); const q = $("ask").value.trim(); if (q) runAi("ask", q); };
  document.addEventListener("keydown", async (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "t") { e.preventDefault(); await invoke("browser_new_tab", {}); $("omni").focus(); }
    else if (k === "w" && active != null) { e.preventDefault(); await invoke("browser_close_tab", { id: active }); }
    else if (k === "l") { e.preventDefault(); $("omni").focus(); }
    else if (k === "r" && active != null) { e.preventDefault(); invoke("browser_action", { id: active, action: "reload" }); }
    else if (k === "f") { e.preventDefault(); $("find").focus(); }
    else if (k === "d") { e.preventDefault(); toggleBookmark(); }
  });
  await listen("browser-tabs", (e) => onTabs(e.payload || {}));
  // Menu contextuel natif des pages (cf. show_context_menu, browser.rs) : les
  // entrées qui passent par l'assistant ou par une autre app arrivent ici.
  await listen("browser-ctx", async (e) => {
    const { action, text, url, title } = e.payload || {};
    const page = { title, url, text, selection: text };
    if (action === "explain" || action === "translate") {
      if (panel !== "assistant") await openPanel("assistant");
      runAi(action === "explain" ? "selection" : "translate", "", page);
    } else if (action === "summary") {
      if (panel !== "assistant") await openPanel("assistant");
      runAi("summary");
    } else if (action === "bookmark") {
      if (!isBookmarked(url)) toggleBookmark();
      toast(tt("Ajouté aux favoris."));
    } else if (action === "notes" || action === "studies") {
      const { handoff, makeObject } = await import("../lib/interop.js");
      handoff(action, makeObject("text", { title: title || url, text: `${text}\n\n— ${url}`, source: url }, { app: "browser", name: tt("Navigateur") }));
      toast(tt(action === "notes" ? "Envoyé vers Notes." : "Envoyé vers Études."));
    }
  });
  invoke("browser_set_lang", { lang: tt("Navigateur") === "Browser" ? "en" : "fr" }).catch(() => {});
  await listen("browser-download", (e) => {
    const d = e.payload || {};
    const i = downloads.findIndex((x) => x.url === d.url && x.state !== "done");
    if (i >= 0) downloads[i] = { ...downloads[i], ...d, path: d.path || downloads[i].path };
    else downloads.unshift(d);
    if (d.state === "done") toast(tt("Téléchargé : {n}", { n: String(downloads[Math.max(0, i)]?.path || d.url).split(/[\\/]/).pop() }));
    if (panel === "downloads") renderDownloads(); else $("dl-dot").hidden = false;
  });
  onTabs(await invoke("browser_tabs"));
  renderBookmarks();
  autoTranslate({ observe: true });
}

init();
