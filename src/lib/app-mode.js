// Mode « application » de la fenêtre principale (style ChatGPT / Codex).
//
// Rien n'est réécrit : la barre garde TOUTE sa logique (main.js — outils,
// orchestration, @ et #, projets, pièces jointes, dictée, voix…). Ce module
// déplace simplement ses nœuds dans une coque d'application :
//   barre latérale  : marque, nouvelle discussion, navigation (Messages,
//                     agents, automatisations, notifications, bureau),
//                     recherche + liste des discussions (#conversations-list-
//                     container de main.js, déplacé), profil, réglages, mode ;
//   zone principale : barre de titre, accueil (orbe + cartes) quand le fil est
//                     vide, fil centré, compositeur en carte (#search-bar).
// Les panneaux de la barre (réglages, notifications…) deviennent des feuilles
// latérales (lib/app-mode.css). Quitter ce mode recharge la page
// (lib/shell-mode.js) : aucun nœud n'est à remettre en place à la main.

import { refreshInstalled, installedApps, openInstalledApp, onInstalledChange } from "./appkit/installed.js";
import { icon as lumenIcon } from "./icons.js";
import { appSpace } from "./app-taxonomy.js";
import { IS_MAC } from "./platform-flavor.js";
import { character } from "./orb-characters.js";


import { isSessionUnlocked, ensureSessionUnlocked } from "./session-unlock.js";
import { TOOLS, CATS, SUBTITLE, MARKET, FRAME_PERMS, TXT, svg } from "./app-navigation.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (id) => document.getElementById(id);

let mounted = false;

/**
 * @param {object} o
 *   invoke                API Tauri
 *   lang                  "fr" | "en"
 *   renderConversations() redessine #conversations-list-container
 *   currentConversationId() id de la discussion ouverte (surlignage)
 *   onChangeMode()        rouvre l'écran de choix
 *   userName()            nom affiché dans le pied de la barre latérale
 */
export function mountAppMode(o) {
  if (mounted) return;
  mounted = true;
  const lang = String(o.lang || "fr").startsWith("en") ? "en" : "fr";
  const s = TXT[lang];
  const root = document.documentElement;
  let currentView = "chat";
  root.dataset.asView = "chat";
  root.classList.add("shell-app");
  if (IS_MAC) root.classList.add("as-mac");
  try {
    const saved = localStorage.getItem("appSideCollapsed");
    if (saved === "true" || (saved == null && window.innerWidth <= 760)) root.classList.add("as-collapsed");
  } catch { if (window.innerWidth <= 760) root.classList.add("as-collapsed"); }

  const lights = `<div class="as-lights">
      <button type="button" data-as="close" aria-label="${s.close}" title="${s.close}"></button>
      <button type="button" data-as="min" aria-label="${s.min}" title="${s.min}"></button>
      <button type="button" data-as="max" aria-label="${s.max}" title="${s.max}"></button></div>`;
  const name = (o.userName?.() || "").trim();
  const initials = (name || "L").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  const shell = document.createElement("div");
  shell.className = "app-shell";
  shell.innerHTML = `
    <aside class="as-side" aria-label="Lumen">
      <div class="as-side-top" data-as-drag>${lights}<span class="as-sp"></span>
        <button type="button" class="as-ic" data-as="side" title="${s.side} (⌘B)" aria-label="${s.side}">${svg("side")}</button></div>
      <div class="as-body">
        <nav class="as-rail" aria-label="Lumen">
          ${CATS.map((c) => `<button type="button" class="as-rail-btn" data-cat="${c.id}" title="${esc(lang === "en" ? c.en : c.fr)}" aria-label="${esc(lang === "en" ? c.en : c.fr)}">${svg(c.icon)}${c.id === "comms" ? '<span class="as-rail-dot" hidden></span>' : ""}</button>`).join("")}
          <span class="as-sp"></span>
          <button type="button" class="as-rail-btn" data-view="market" title="${esc(lang === "en" ? MARKET.en : MARKET.fr)}" aria-label="${esc(lang === "en" ? MARKET.en : MARKET.fr)}">${svg("store")}</button>
          <button type="button" class="as-rail-btn" data-click="btn-lumen-os" title="${s.desktop}" aria-label="${s.desktop}">${svg("grid")}</button>
          <button type="button" class="as-rail-btn" data-as="mode" title="${s.mode}" aria-label="${s.mode}">${svg("layers")}</button>
          <button type="button" class="as-rail-btn" data-click="btn-theme-toggle" title="${s.theme}" aria-label="${s.theme}">${svg("moon")}</button>
          <button type="button" class="as-rail-btn" data-click="btn-settings" title="${s.settings}" aria-label="${s.settings}">${svg("gear")}</button>
          <button type="button" class="as-rail-me" data-click="btn-settings" title="${esc(name || s.me)}" aria-label="${esc(name || s.me)}"><span class="as-avatar">${esc(initials)}</span></button>
        </nav>
        <div class="as-panel">
          <section class="as-pane" data-pane="chats">
            <div class="as-brand"><span class="as-brand-mark"></span><b>Lumen</b></div>
            <button type="button" class="as-new" data-as="new">${svg("pen")}<span>${s.newChat}</span><span class="as-kbd">${IS_MAC ? "⌘" : "Ctrl+"}N</span></button>
            <label class="as-search">${svg("search")}<input type="search" placeholder="${s.search}" aria-label="${s.search}"></label>
            <div class="as-sec">${s.chats}</div>
            <div class="as-convs"></div>
          </section>
          ${CATS.filter((c) => c.id !== "chats").map((c) => `<section class="as-pane" data-pane="${c.id}" hidden>
            <div class="as-pane-head"><b>${esc(lang === "en" ? c.en : c.fr)}</b></div>
            <nav class="as-nav" data-cat-list="${c.id}"></nav>
          </section>`).join("")}
        </div>
      </div>
    </aside>
    <main class="as-main">
      <header class="as-top" data-as-drag>
        <span class="as-top-lights">${lights}</span>
        <button type="button" class="as-ic as-open-side" data-as="side" title="${s.side}" aria-label="${s.side}">${svg("side")}</button>
        <span class="as-top-title"></span>
        <span class="as-sp"></span>
        <div class="as-top-ctl">
          <button type="button" class="as-ic" data-as="min" aria-label="${s.min}">${svg("min")}</button>
          <button type="button" class="as-ic" data-as="max" aria-label="${s.max}">${svg("max")}</button>
          <button type="button" class="as-ic" data-as="close" aria-label="${s.close}">${svg("x")}</button>
        </div>
      </header>
    </main>
    <div class="as-scrim"></div>`;
  document.body.appendChild(shell);
  const main = shell.querySelector(".as-main");

  // ---- Déplacement des nœuds de la barre ----
  const barArea = $("bar-area");
  const orb = $("orb-wrap");
  const hero = document.createElement("section");
  hero.className = "as-hero";
  hero.innerHTML = `<div class="as-mascot" role="img" aria-label="Lumen"></div>
    <h1>${lang === "en" ? "What shall we work on?" : "Sur quoi allons-nous travailler ?"}</h1>
    <p>${s.sub}</p>
    <div class="as-cards">${s.cards.map((c, i) => `<button type="button" class="as-card" data-card="${i}" style="--tint:${c.tint}">
        <span class="as-card-ic">${svg(c.k)}</span><span><b>${esc(c.t)}</b><small>${esc(c.d)}</small></span></button>`).join("")}</div>`;
  const mascot = hero.querySelector(".as-mascot");
  if (orb) { orb.hidden = false; mascot.appendChild(orb); }
  const syncMascotState = () => {
    const state = $("orb-container")?.dataset.state || "idle";
    mascot.dataset.state = state;
    mascot.setAttribute("aria-label", `Lumen — ${state === "thinking" ? (lang === "en" ? "thinking" : "réfléchit") : state === "speaking" ? (lang === "en" ? "speaking" : "parle") : state === "listening" ? (lang === "en" ? "listening" : "écoute") : (lang === "en" ? "ready" : "prêt")}`);
  };
  if (orb) new MutationObserver(syncMascotState).observe(orb, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
  syncMascotState();

  const composer = document.createElement("div");
  composer.className = "as-composer";
  const context = document.createElement("div");
  context.className = "as-context";
  context.hidden = true;
  composer.appendChild(context);
  ["toolbar-overflow", "ollama-mode-menu", "backend-menu", "search-bar"].forEach((id) => { const n = $(id); if (n) composer.appendChild(n); });
  // Sélecteur de mode (Chat, Documents/RAG, Outils, Documentation…) sorti du
  // menu « … » : la RAG sur la base de connaissances est à portée, comme au bureau.
  const modeBtn = $("btn-ollama-mode"), leftCtl = composer.querySelector(".left-controls");
  if (modeBtn && leftCtl) leftCtl.insertBefore(modeBtn, $("btn-more") || null);
  const foot = document.createElement("div");
  foot.className = "as-foot";
  foot.textContent = s.foot;

  const messages = $("messages-container");
  barArea.prepend(hero);
  if (messages) hero.after(messages);
  (messages || hero).after(composer);
  composer.after(foot);
  main.appendChild(barArea);
  const viewsEl = document.createElement("div");
  viewsEl.className = "as-views";
  main.appendChild(viewsEl);

  const convs = $("conversations-list-container");
  if (convs) shell.querySelector(".as-convs").appendChild(convs);

  // ---- Orbe dans le fil (façon curseur de réponse) ----
  // Pendant le chargement (réflexion, outil en cours) : trois petits points
  // seuls. L'orbe — la même mascotte, mêmes yeux/bouche — n'apparaît que
  // pour ses animations : réponse vocale, humeurs (échec d'outil, fin de tour)
  // et repos sous la dernière réponse.
  const reply = document.createElement("div");
  reply.className = "as-reply";
  reply.setAttribute("aria-hidden", "true");
  reply.innerHTML = '<span class="as-reply-dots"><i></i><i></i><i></i></span>';
  const liveOrb = () => $("orb-container");
  const seenErr = new WeakSet();
  let lastOrbState = liveOrb()?.dataset.state || "idle";
  const placeReplyOrb = () => {
    const bubbles = list.querySelectorAll(":scope > .message-bubble.assistant");
    const bubble = bubbles[bubbles.length - 1];
    if (!bubble) { reply.remove(); return; }
    const host = bubble.querySelector(".msg-text-content") || bubble;
    if (reply.parentNode !== host || host.lastElementChild !== reply) host.appendChild(reply);
    if (mascot.parentElement !== reply) reply.appendChild(mascot);
    const st = liveOrb()?.dataset.state || "idle";
    const mood = liveOrb()?.dataset.mood || "";
    const answer = host.querySelector(".msg-answer");
    const writing = !!answer && answer.classList.contains("lm-streaming") && answer.textContent.trim().length > 0;
    let phase;
    if (st === "speaking" || st === "listening" || (mood && mood !== "sleep")) phase = "orb";
    else if (st === "thinking") phase = writing ? "write" : "wait";
    else phase = "orb";
    reply.dataset.phase = phase;
    const dot = dotColor();
    if (dot) reply.style.setProperty("--reply-dot", dot); else reply.style.removeProperty("--reply-dot");
  };
  // Points d'attente à la couleur d'accent de l'orbe quand il est coloré :
  // teinte foncée du personnage doux, ou première couleur de l'orbe de verre
  // (palette perso ou thème « accent »). Orbe blanc / neutre : couleur du texte.
  function dotColor() {
    const id = liveOrb()?.dataset.orbCharacter || localStorage.getItem("orbTheme") || "default";
    const preset = character(id);
    if (preset?.renderer !== "original") return id === "soft-white" ? "" : (preset?.shade || "");
    if (localStorage.getItem("orbTheme") === "accent") return window.LumenOrb?.accentPalette?.()?.[0] || "";
    try { const c = JSON.parse(localStorage.getItem("orbColors")); if (Array.isArray(c) && c[0]) return c[0]; } catch {}
    return window.LumenOrb?.DEFAULT_COLORS?.[0] || "";
  }
  const reactTo = () => {
    const st = liveOrb()?.dataset.state || "idle";
    if (lastOrbState === "thinking" && st === "idle" && !liveOrb()?.dataset.mood) window.LumenOrb?.setMood?.("joy", { ms: 1800, quiet: true });
    lastOrbState = st;
  };
  const watchErrors = () => {
    list?.querySelectorAll(".lm-tool.err").forEach((t) => {
      if (seenErr.has(t)) return;
      seenErr.add(t);
      if ((liveOrb()?.dataset.state || "idle") !== "idle") window.LumenOrb?.setMood?.("sad", { ms: 1600 });
    });
  };
  $("messages-list")?.querySelectorAll(".lm-tool.err").forEach((t) => seenErr.add(t));
  // orb.js peut recréer #orb-container après le montage : on le relit à
  // chaque fois et on observe tout #orb-wrap.
  if (orb) new MutationObserver(() => { reactTo(); if (!root.classList.contains("as-empty")) placeReplyOrb(); })
    .observe(orb, { subtree: true, attributes: true, attributeFilter: ["data-state", "data-mood"] });

  // ---- État vide / titre / discussion active ----
  const list = $("messages-list");
  const input = $("chat-input");
  const titleEl = shell.querySelector(".as-top-title");
  const sync = () => {
    const empty = !list || !list.querySelector(".message-bubble");
    root.classList.toggle("as-empty", empty);
    watchErrors();
    // Accueil : l'orbe trône au-dessus du titre. Discussion engagée : il
    // descend dans le fil, sous la dernière réponse (voir placeReplyOrb).
    if (empty) { if (mascot.parentElement !== hero) hero.prepend(mascot); reply.remove(); }
    else placeReplyOrb();
    const project = o.currentProject?.();
    context.hidden = !project;
    context.textContent = project?.name || "";
    hero.querySelector("h1").textContent = project
      ? (lang === "en" ? `What shall we work on in ${project.name}?` : `Sur quoi allons-nous travailler dans ${project.name} ?`)
      : (lang === "en" ? "What shall we work on?" : "Sur quoi allons-nous travailler ?");
    const firstUser = list?.querySelector(".message-bubble.user");
    if (currentView === "chat") titleEl.textContent = firstUser ? firstUser.textContent.trim().slice(0, 80) : "";
    const cur = o.currentConversationId?.();
    convs?.querySelectorAll(".conversation-history-item").forEach((it) => it.classList.toggle("as-active", !!cur && it.dataset.id === String(cur)));
  };
  let tick = 0;
  const schedule = () => { cancelAnimationFrame(tick); tick = requestAnimationFrame(sync); };
  // Les mutations dues au seul déplacement de l'orbe sont ignorées.
  const notOrb = (recs) => recs.some((r) => {
    if (r.target === reply || reply.contains(r.target)) return false;
    const nodes = [...r.addedNodes, ...r.removedNodes];
    return !(nodes.length && nodes.every((n) => n === reply));
  });
  if (list) new MutationObserver((r) => { if (notOrb(r)) schedule(); }).observe(list, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  if (convs) new MutationObserver(schedule).observe(convs, { childList: true });
  // La liste n'est redessinée par main.js qu'à l'ouverture de l'historique et
  // après certaines actions : on la rafraîchit aussi quand le fil change.
  let refreshTimer = 0;
  if (list) new MutationObserver((r) => { if (!notOrb(r)) return; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { o.renderConversations?.(); applyFilter(); }, 800); }).observe(list, { childList: true });
  o.renderConversations?.();
  sync();

  // ---- Recherche dans les discussions ----
  const searchInput = shell.querySelector(".as-search input");
  const applyFilter = () => {
    const q = searchInput.value.trim().toLowerCase();
    convs?.querySelectorAll(".conversation-history-item").forEach((it) => {
      it.classList.toggle("as-hide", !!q && !it.textContent.toLowerCase().includes(q));
    });
  };
  searchInput.addEventListener("input", applyFilter);

  // ---- Badge des notifications (miroir de celui de la barre) ----
  const srcBadge = $("notif-badge");
  function mirror() {
    if (!srcBadge) return;
    shell.querySelectorAll(".as-badge").forEach((b) => { b.hidden = srcBadge.hidden; b.textContent = srcBadge.textContent; });
    const dot = shell.querySelector(".as-rail-dot");
    if (dot) dot.hidden = srcBadge.hidden;
  }
  if (srcBadge) new MutationObserver(() => mirror()).observe(srcBadge, { attributes: true, childList: true, characterData: true, subtree: true });

  // ---- Feuilles latérales : voile + fermeture au clic extérieur ----
  const panels = [...barArea.querySelectorAll(":scope > .settings-panel")];
  const syncSheet = () => root.classList.toggle("as-sheet", panels.some((p) => p.classList.contains("active")));
  panels.forEach((p) => new MutationObserver(syncSheet).observe(p, { attributes: true, attributeFilter: ["class"] }));
  shell.querySelector(".as-scrim").addEventListener("click", () => { panels.forEach((p) => p.classList.remove("active")); syncSheet(); });

  // ---- Vues intégrées (Messages, Bibliothèque, apps…) ----
  // Chaque vue reste vivante une fois ouverte (comme les onglets des hubs) :
  // revenir dessus ne recharge rien. « chat » = la discussion de la barre.
  const views = new Map();
  const toolName = (t) => (lang === "en" ? t.en : t.fr);
  const pkgOf = (id) => (String(id).startsWith("pkg:") ? String(id).slice(4) : null);
  const nameOf = (id) => {
    const t = TOOLS.find((x) => x.id === id) || (id === "market" ? MARKET : null);
    if (t) return toolName(t);
    const pid = pkgOf(id) || id;
    return installedApps().find((a) => a.id === pid)?.name || pid;
  };
  function frameView(el, url) {
    const f = document.createElement("iframe");
    f.className = "as-frame";
    f.title = nameOf(currentView);
    f.allow = FRAME_PERMS;
    f.src = url;
    // Outils d'écriture (sélection → Relire, Réécrire…) aussi dans la vue.
    f.addEventListener("load", () => { try { window.LumenWritingTools?.attach(f.contentDocument); } catch {} });
    el.appendChild(f);
  }
  function packagedView(el, pkgId) {
    const manifest = installedApps().find((a) => a.id === pkgId);
    if (!manifest) {
      el.innerHTML = `<div class="as-missing"><div class="as-missing-ic">${svg("apps")}</div><b>${esc(nameOf(pkgId))}</b>
        <p>${s.missing}</p><button type="button" class="as-btn" data-install="${esc(pkgId)}">${svg("store")}<span>${s.install}</span></button></div>`;
      return false;
    }
    // openInstalledApp attend une « coquille » de bureau : on lui prête la vue.
    openInstalledApp(manifest, {
      createWindow: () => ({ body: el, setTitle: () => {}, onClose: () => {} }),
      focusWindow: () => {},
      openWindows: new Map(),
      framePermissions: FRAME_PERMS,
    });
    return true;
  }
  // Sandboxes gardées par la session : en mode application personne n'a encore
  // demandé le mot de passe. Une app ouverte verrouillée (ou sans aucune
  // sandbox) échouait en silence, et le déverrouillage fait ensuite dans la
  // Bibliothèque ne lui parvenait jamais. Désormais : mot de passe demandé
  // AVANT d'ouvrir l'app, et les vues montées sans accès se rechargent dès que
  // la session s'ouvre ou qu'une sandbox apparaît (événements Rust).
  async function openView(id, opt = {}) {
    if (id && id !== "chat" && !opt.background && !views.has(id) && !(await isSessionUnlocked(o.invoke))) {
      await ensureSessionUnlocked({ invoke: o.invoke, reason: nameOf(id) });
    }
    openViewNow(id, opt);
  }
  async function markAccess(el) {
    if (!(await isSessionUnlocked(o.invoke))) el.dataset.locked = "1";
    try { if (!(await o.invoke("sandbox_list_names")).length) el.dataset.noSandbox = "1"; } catch {}
  }
  function reloadViews(flag) {
    for (const [id, el] of [...views]) {
      if (!el.dataset[flag] || id === "library") continue;
      const visible = currentView === id;
      el.remove(); views.delete(id);
      if (visible) openViewNow(id);
    }
  }
  const tauriListen = window.__TAURI__?.event?.listen;
  tauriListen?.("lumen-session-unlocked", () => reloadViews("locked"));
  tauriListen?.("lumen-sandboxes-changed", () => reloadViews("noSandbox"));
  window.addEventListener("lumen-session-unlocked", () => reloadViews("locked"));
  if (o.invoke) isSessionUnlocked(o.invoke).then((ok) => { if (!ok) ensureSessionUnlocked({ invoke: o.invoke }); });

  function openViewNow(id, opt = {}) {
    if (!id || id === "chat") {
      currentView = "chat";
      root.dataset.asView = "chat";
      if (currentCat !== "chats") selectCat("chats", { keepView: true });
      viewsEl.querySelectorAll(".as-view").forEach((v) => (v.hidden = true));
      markNav();
      schedule();
      return;
    }
    let el = views.get(id);
    if (el && opt.reload) { el.remove(); views.delete(id); el = null; }
    if (!el) {
      el = document.createElement("section");
      el.className = "as-view";
      el.dataset.view = id;
      viewsEl.appendChild(el);
      const tool = TOOLS.find((t) => t.id === id) || (id === "market" ? MARKET : null);
      let ok = true;
      if (tool?.url) { frameView(el, opt.url || tool.url); el.querySelector("iframe").title = nameOf(id); }
      else ok = packagedView(el, pkgOf(id) || id);
      if (ok) views.set(id, el);
      else { views.set(id, el); el.dataset.missing = "1"; }
      markAccess(el);
      // Ouverture en coulisse (intention d'app lancée depuis la discussion) :
      // l'app se charge sans voler la vue courante.
      if (opt.background && currentView !== id) { el.hidden = true; return; }
    } else if (opt.background) return;
    currentView = id;
    root.dataset.asView = id;
    viewsEl.querySelectorAll(".as-view").forEach((v) => (v.hidden = v !== el));
    titleEl.textContent = nameOf(id);
    // Le rail suit la vue ouverte (ex. Messages ouvert depuis une notification).
    const cat = catOfView(id);
    if (cat) selectCat(cat, { keepView: true });
    markNav();
  }
  const markNav = () => {
    shell.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("as-on", b.dataset.view === currentView));
  };
  // ---- Rail (catégories) et panneaux (2e niveau) ----
  const notifLabel = s.notifs;
  const appsIn = (cat) => {
    const all = installedApps();
    const groups = [];
    const pinned = new Set(CATS.flatMap((x) => x.pkgs || []));
    if (cat.pkgs?.length) {
      const list = all.filter((a) => cat.pkgs.includes(a.id)).sort((a, b) => a.name.localeCompare(b.name));
      if (list.length) groups.push({ title: null, apps: list });
    }
    for (const c of cat.cats || []) {
      const list = all.filter((a) => appSpace(a) === c && !pinned.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
      const sub = lang === "en" ? SUBTITLE[c]?.en : SUBTITLE[c]?.fr;
      const catName = lang === "en" ? cat.en : cat.fr;
      // Sous-titre seulement s'il apporte quelque chose (≠ titre du panneau).
      const show = (cat.cats.length > 1 || cat.native || cat.pkgs) && sub && sub !== catName;
      if (list.length) groups.push({ title: show ? sub : null, apps: list });
    }
    return groups;
  };
  const itemHTML = (view, iconHTML, label, extra = "") =>
    `<button type="button" data-view="${esc(view)}">${iconHTML}<span>${esc(label)}</span>${extra}</button>`;
  function renderPanels() {
    for (const cat of CATS) {
      const list = shell.querySelector(`[data-cat-list="${cat.id}"]`);
      if (!list) continue;
      let html = "";
      for (const n of cat.native || []) {
        if (n === "@notifications") { html += `<button type="button" data-click="btn-notifications">${svg("bell")}<span>${esc(notifLabel)}</span><span class="as-badge" hidden></span></button>`; continue; }
        const t = TOOLS.find((x) => x.id === n);
        if (t) html += itemHTML(t.id, svg(t.icon), toolName(t));
      }
      for (const g of appsIn(cat)) {
        if (g.title) html += `<div class="as-sub">${esc(g.title)}</div>`;
        html += g.apps.map((a) => itemHTML(`pkg:${a.id}`, lumenIcon(a.icon || "app-window") || svg("apps"), a.name)).join("");
      }
      html += `<button type="button" class="as-add" data-view="market">${svg("store")}<span>${esc(lang === "en" ? "Add apps…" : "Ajouter des apps…")}</span></button>`;
      list.innerHTML = html;
    }
    mirror();
    markNav();
  }
  function catOfView(view) {
    if (view === "chat") return "chats";
    if (view === "market") return null;
    const pid = pkgOf(view);
    if (pid) {
      const pinnedIn = CATS.find((c) => c.pkgs?.includes(pid));
      if (pinnedIn) return pinnedIn.id;
      const cat = appSpace(installedApps().find((a) => a.id === pid));
      return CATS.find((c) => c.cats?.includes(cat))?.id || null;
    }
    return CATS.find((c) => c.native?.includes(view))?.id || null;
  }
  let currentCat = "chats";
  function selectCat(id, { keepView = false } = {}) {
    currentCat = id;
    shell.querySelectorAll(".as-rail-btn[data-cat]").forEach((b) => {
      const selected = b.dataset.cat === id;
      b.classList.toggle("as-on", selected);
      if (selected) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    shell.querySelectorAll(".as-pane").forEach((p) => (p.hidden = p.dataset.pane !== id));
    if (root.classList.contains("as-collapsed") && !keepView) toggleSide();
    if (id === "chats" && !keepView && currentView !== "chat") openView("chat");
  }
  refreshInstalled().then(renderPanels);
  renderPanels();
  onInstalledChange(() => {
    renderPanels();
    // Une app manquante vient d'être installée : on rouvre sa vue.
    views.forEach((el, id) => { if (el.dataset.missing && installedApps().some((a) => a.id === (pkgOf(id) || id))) { el.remove(); views.delete(id); if (currentView === id) openView(id); } });
  });
  // Au démarrage on est sur le chat : le rail commence sur Discussions.
  selectCat("chats", { keepView: true });
  viewsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-install]");
    if (b) openView("market", { reload: true, url: `${MARKET.url}?app=${encodeURIComponent(b.dataset.install)}` });
  });
  // Ouvrir Messages depuis la barre (bouton, notification) reste dans l'app.
  const msgBtn = $("btn-messages");
  if (msgBtn) msgBtn.addEventListener("click", (e) => { e.stopImmediatePropagation(); e.preventDefault(); openView("messages"); }, true);
  window.LumenAppMode = { openView };
  // Ouverture d'app demandée par une app (boutons des cartes du Matin,
  // `lumen.apps.open` de l'AppKit) : le bureau définit ce point d'entrée, la
  // coque du mode application doit le faire aussi, sinon rien ne s'ouvre.
  const NATIVE_ALIAS = { messenger: "messages", explorer: "library", sandbox: "library", files: "library", designer: "fluxo", crew: "agents", team: "agents", calc: "documents", opus: "documents" };
  window.LumenOpenApp = (id) => {
    const key = String(id || "").trim();
    if (!key) return false;
    const native = NATIVE_ALIAS[key] || key;
    if (TOOLS.some((t) => t.id === native)) { openView(native); return true; }
    if (installedApps().some((a) => a.id === key)) { openView(`pkg:${key}`); return true; }
    // App absente : la vue propose de l'installer depuis le Catalogue.
    openView(`pkg:${key}`);
    return false;
  };
  o.invoke("shell_start_view").then((v) => { if (v) openView(v); }).catch(() => {});

  // ---- Menu contextuel (clic droit) ----
  // Les outils d'écriture passent AVANT (sélection de texte, image) : ils
  // capturent l'évènement et l'arrêtent. Ce menu couvre le reste.
  let ctxEl = null;
  const closeCtx = () => { ctxEl?.remove(); ctxEl = null; };
  function openCtx(x, y, items) {
    closeCtx();
    ctxEl = document.createElement("div");
    ctxEl.className = "as-ctx";
    ctxEl.setAttribute("role", "menu");
    for (const it of items) {
      if (it === "-") { ctxEl.insertAdjacentHTML("beforeend", '<div class="as-ctx-sep"></div>'); continue; }
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.className = it.danger ? "danger" : "";
      b.innerHTML = `${it.icon ? svg(it.icon) : '<span class="as-ctx-sp"></span>'}<span>${esc(it.label)}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ""}`;
      b.addEventListener("click", () => { closeCtx(); it.run(); });
      ctxEl.appendChild(b);
    }
    document.body.appendChild(ctxEl);
    const r = ctxEl.getBoundingClientRect();
    ctxEl.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    ctxEl.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    ctxEl.querySelector("button")?.focus();
  }
  document.addEventListener("pointerdown", (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtx(); });
  window.addEventListener("blur", closeCtx);
  const mod = IS_MAC ? "⌘" : "Ctrl+";
  const generic = () => [
    { icon: "pen", label: s.newChat, kbd: `${mod}N`, run: newChat },
    { icon: "search", label: s.searchChats, kbd: `${mod}K`, run: () => { if (root.classList.contains("as-collapsed")) toggleSide(); searchInput.focus(); } },
    { icon: "side", label: s.side, kbd: `${mod}B`, run: toggleSide },
    "-",
    { icon: "layers", label: s.mode, run: () => o.onChangeMode?.() },
    { icon: "gear", label: s.settings, run: () => $("btn-settings")?.click() },
  ];
  document.addEventListener("contextmenu", (e) => {
    if (!root.classList.contains("shell-app")) return;
    const tgt = e.target instanceof Element ? e.target : null;
    if (!tgt || tgt.closest("input, textarea, select, [contenteditable='true'], .as-views, .as-ctx")) return;
    e.preventDefault();
    const conv = tgt.closest(".conversation-history-item");
    if (conv) {
      const click = (sel) => () => conv.querySelector(sel)?.click();
      const btns = conv.querySelectorAll(".btn-conv-icon");
      openCtx(e.clientX, e.clientY, [
        { icon: "chat", label: s.open, run: click(".conversation-history-main") },
        { icon: "pin", label: s.pin, run: () => btns[0]?.click() },
        { icon: "folders", label: s.folder, run: () => btns[1]?.click() },
        { icon: "doc", label: s.summarize, run: () => btns[2]?.click() },
        "-",
        { icon: "x", label: s.del, danger: true, run: click(".btn-delete-conv") },
      ]);
      return;
    }
    const bubble = tgt.closest(".message-bubble");
    if (bubble) {
      const text = (bubble.querySelector(".msg-answer") || bubble.querySelector(".msg-text-content") || bubble).innerText.trim();
      const items = [
        { icon: "doc", label: s.copy, run: () => navigator.clipboard?.writeText(text).catch(() => {}) },
        { icon: "quote", label: s.quote, run: () => {
          if (!input) return;
          const q = text.split("\n").slice(0, 6).map((l) => `> ${l}`).join("\n");
          input.value = `${q}\n\n${input.value}`;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
        } },
      ];
      if (bubble.classList.contains("assistant")) {
        const sp = bubble.querySelector(".msg-speak-btn");
        if (sp) items.push({ icon: "speaker", label: s.speak, run: () => sp.click() });
        const rt = bubble.querySelector(".msg-retry-btn");
        if (rt) items.push({ icon: "retry", label: s.retry, run: () => rt.click() });
      }
      openCtx(e.clientX, e.clientY, [...items, "-", ...generic()]);
      return;
    }
    openCtx(e.clientX, e.clientY, generic());
  });

  // ---- Actions ----
  const panel = shell.querySelector(".as-panel");
  const syncSidebarAccess = () => {
    const collapsed = root.classList.contains("as-collapsed");
    panel.inert = collapsed;
    panel.setAttribute("aria-hidden", String(collapsed));
    shell.querySelectorAll('[data-as="side"]').forEach((button) => button.setAttribute("aria-expanded", String(!collapsed)));
  };
  syncSidebarAccess();
  const toggleSide = () => {
    const on = root.classList.toggle("as-collapsed");
    syncSidebarAccess();
    try { localStorage.setItem("appSideCollapsed", String(on)); } catch {}
  };
  const newChat = () => { selectCat("chats", { keepView: true }); openView("chat"); $("btn-new-chat")?.click(); input?.focus(); schedule(); };
  shell.addEventListener("click", (e) => {
    const t = e.target.closest("[data-as],[data-click],[data-card],[data-view],[data-cat]");
    if (!t || t.closest(".as-views")) return;
    if (t.dataset.cat) { selectCat(t.dataset.cat); return; }
    if (t.dataset.view) { openView(t.dataset.view); return; }
    if (t.dataset.click) { $(t.dataset.click)?.click(); return; }
    if (t.dataset.card != null) {
      const c = s.cards[+t.dataset.card];
      if (!input) return;
      input.value = c.q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      if (c.send) $("send-btn")?.click();
      return;
    }
    switch (t.dataset.as) {
      case "new": newChat(); break;
      case "side": toggleSide(); break;
      case "mode": o.onChangeMode?.(); break;
      case "min": o.invoke("minimize_window").catch(() => {}); break;
      case "max": o.invoke("toggle_maximize").catch(() => {}); break;
      case "close": o.invoke("close_window").catch(() => {}); break;
    }
  });
  // Ouvrir une discussion depuis la liste : main.js ferme le panneau
  // d'historique ; ici on remet juste le focus dans le compositeur.
  convs?.addEventListener("click", (e) => { if (e.target.closest(".conversation-history-main")) { openView("chat"); setTimeout(() => { schedule(); input?.focus(); }, 60); } });

  // Déplacement de la fenêtre : barre de titre et haut de la barre latérale.
  shell.querySelectorAll("[data-as-drag]").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input, a")) return;
      o.invoke("start_drag").catch(() => {});
    });
    el.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) o.invoke("toggle_maximize").catch(() => {}); });
  });

  document.addEventListener("keydown", (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "n" && !e.shiftKey) { e.preventDefault(); newChat(); }
    else if (k === "b") { e.preventDefault(); toggleSide(); }
    else if (k === "k") { e.preventDefault(); if (root.classList.contains("as-collapsed")) toggleSide(); searchInput.focus(); }
  });

  // Fenêtre agrandie / plein écran : coins droits (sinon on verrait l'écran
  // derrière les arrondis).
  const syncMax = () => root.classList.toggle("as-max",
    window.innerWidth >= screen.availWidth - 2 && window.innerHeight >= screen.availHeight - 40);
  window.addEventListener("resize", syncMax);
  syncMax();

  setTimeout(() => input?.focus(), 120);
}
