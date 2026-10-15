// Vue du matin : l'écran de la journée qui commence.
//
// Pourquoi elle existe : tout ce qu'elle montre était déjà dans Lumen, mais
// réparti dans dix endroits. Un matin, on ne va pas ouvrir dix apps pour
// savoir si quelque chose s'est passé — on regarde un écran, dix secondes,
// puis on travaille. C'est le seul but de celui-ci.
//
// Règles qu'elle s'impose :
//   * une fois par jour, au premier démarrage du bureau, et jamais autrement ;
//   * désactivable d'un clic depuis l'écran lui-même ET dans les Réglages ;
//   * aucune donnée qui lui soit propre : tout vient des apps, rien n'est
//     dupliqué, rien n'est écrit ;
//   * si une source ne répond pas, sa carte le dit et le reste s'affiche —
//     un agenda indisponible ne doit pas retenir la matinée.

import { tt } from "../apps-i18n.js";
import { icon as lumenIcon } from "../lib/icons.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const KEY_ENABLED = "morningView";     // "false" = désactivé
const KEY_SHOWN = "morningShownOn";    // AAAA-MM-JJ du dernier affichage

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function morningEnabled() {
  return localStorage.getItem(KEY_ENABLED) !== "false";
}

/** Affichage automatique : activé, et pas encore vu aujourd'hui. */
export function shouldShowMorning() {
  return morningEnabled() && localStorage.getItem(KEY_SHOWN) !== dayKey();
}

// ---------------------------------------------------------------------------
// Collecte — chaque source est indépendante et ne peut pas faire tomber l'écran
// ---------------------------------------------------------------------------

/// Coffre unifié (datahub.rs) : Agenda, Tableau, Notes, iPhone… déjà indexés.
/// Matin LIT ces sources ; il n'a ni stockage ni copie des tâches à lui.
async function hub(args) {
  try { return (await invoke("datahub_query", { args })) || []; } catch { return []; }
}
const sameItem = (a, b) => a.title.trim().toLowerCase() === b.title.trim().toLowerCase() && Math.abs(a.at - b.at) < 60000;

async function collectAgenda() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const end = start + 86400000;
  const items = [];
  try {
    const raw = await invoke("reminders_load");
    for (const r of (raw ? JSON.parse(raw) : [])) {
      if (r?.done || typeof r.due_at !== "number") continue;
      if (r.due_at < start || r.due_at >= end) continue;
      items.push({ at: r.due_at, title: r.title || "(rappel)" });
    }
  } catch { /* calendrier indisponible */ }
  try {
    for (const a of (await invoke("agent_list")) || []) {
      for (const t of a.tasks || []) {
        if (t.done || t.due == null) continue;
        const at = t.due * 1000;
        if (at < start || at >= end) continue;
        items.push({ at, title: t.text || "(tâche)" });
      }
    }
  } catch { /* agents absents */ }
  // Évènements et échéances du jour venus des apps (Agenda, Tableau, iPhone…).
  for (const r of await hub({ types: ["event", "task"], from: start, to: end, order: "start", limit: 40 })) {
    if (!r.start || /^fait|done/i.test(r.status || "")) continue;
    const item = { at: r.start, title: r.title || "(sans titre)", app: r.app || "" };
    if (!items.some((i) => sameItem(i, item))) items.push(item);
  }
  return items.sort((a, b) => a.at - b.at);
}

async function collectInbox() {
  try {
    const raw = await invoke("inbox_load");
    const list = raw ? JSON.parse(raw) : [];
    const all = Array.isArray(list) ? list : [];
    return { unread: all.filter((m) => !m.read).length, last: all[0] || null };
  } catch { return { unread: 0, last: null }; }
}

async function collectMail() {
  try {
    const raw = await invoke("mail_load");
    const list = raw ? JSON.parse(raw) : [];
    const all = Array.isArray(list) ? list : [];
    const unread = all.filter((m) => !m.read);
    return { unread: unread.length, last: unread[0] || all[0] || null };
  } catch { return { unread: 0, last: null }; }
}

/// Ce que les agents ont fait depuis hier. On lit le journal LLM plutôt que
/// l'activité par agent : il porte déjà l'heure et la nature de chaque action,
/// et une seule commande suffit.
async function collectOvernight() {
  const since = Date.now() / 1000 - 16 * 3600;
  try {
    const entries = (await invoke("llm_log_list", { kind: null })) || [];
    const recent = entries.filter((e) => (e.ts || 0) >= since);
    return {
      count: recent.length,
      tokens: recent.reduce((n, e) => n + (e.prompt_tokens || 0) + (e.gen_tokens || 0), 0),
      last: recent[0] || null,
    };
  } catch { return { count: 0, tokens: 0, last: null }; }
}

async function collectTodo() {
  const open = [];
  try {
    for (const a of (await invoke("agent_list")) || []) {
      for (const t of a.tasks || []) {
        if (!t.done) open.push({ text: t.text || "", agent: a.name || "" });
      }
    }
  } catch { /* agents absents */ }
  // Tâches ouvertes des apps (Tableau, Relia, iPhone…) : lues, jamais recopiées.
  for (const r of await hub({ types: ["task"], status: "open", order: "start", limit: 50 })) {
    const text = r.title || "";
    if (text && !open.some((t) => t.text.trim().toLowerCase() === text.trim().toLowerCase())) open.push({ text, app: r.app || "" });
  }
  return open;
}

/// Météo de la ville choisie (Réglages › Appareils › Zone météo, ou saisie
/// ici). Une requête au plus toutes les 15 minutes.
async function collectWeather() {
  const place = (localStorage.getItem("morningWeatherPlace") || localStorage.getItem("orbWeatherPlace") || "").trim();
  if (!place) return { place: "" };
  try {
    const cache = JSON.parse(localStorage.getItem("morningWeatherCache") || "null");
    if (cache && cache.place === place && Date.now() - cache.at < 15 * 60000) return cache.data;
  } catch { /* cache illisible */ }
  try {
    const data = await invoke("live_weather_data", { place });
    const out = { ...data, place };
    localStorage.setItem("morningWeatherCache", JSON.stringify({ place, at: Date.now(), data: out }));
    return out;
  } catch (e) { return { place, error: String(e?.message || e) }; }
}

// ---------------------------------------------------------------------------
// Rendu — composants shadcn/ui (cartes, badges, boutons), jetons de tokens.css
// ---------------------------------------------------------------------------

function greeting(hour) {
  if (hour < 5) return "Bonne nuit";
  if (hour < 12) return "Bonjour";
  if (hour < 18) return "Bon après-midi";
  return "Bonsoir";
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const ic = (n) => lumenIcon(n) || "";

function card(title, iconName, inner, { cls = "", action = "" } = {}) {
  return `<section class="mn-card ${cls}">
    <header class="mn-card-head"><span class="mn-card-ic">${ic(iconName)}</span><h2>${esc(tt(title))}</h2>${action}</header>
    <div class="mn-card-body">${inner}</div>
  </section>`;
}
function kpi(label, value, iconName, tone = "") {
  return `<div class="mn-kpi ${tone}"><span class="mn-kpi-ic">${ic(iconName)}</span><div><div class="mn-kpi-v">${esc(String(value))}</div><div class="mn-kpi-l">${esc(tt(label))}</div></div></div>`;
}
const empty = (text) => `<div class="mn-empty">${esc(tt(text))}</div>`;
const badge = (text, tone = "") => (text ? `<span class="mn-badge ${tone}">${esc(text)}</span>` : "");

/**
 * Ouvre la vue du matin.
 * @param {{ openApp?: (id: string) => void, profileName?: string, embedded?: boolean }} ctx
 */
export async function showMorning(ctx = {}) {
  // `embedded` : rendue comme page d'une app (paquet « Matin ») plutôt qu'en
  // voile sur le bureau — on ne la ferme pas, on l'actualise, et l'ouvrir à
  // la demande ne compte pas comme l'affichage automatique du jour.
  const embedded = Boolean(ctx.embedded);
  if (!embedded && document.querySelector(".mn-ov")) return;
  document.querySelector(".mn-ov")?.remove();
  const now = new Date();
  if (!embedded) localStorage.setItem(KEY_SHOWN, dayKey(now));

  const ov = document.createElement("div");
  ov.className = embedded ? "mn-ov mn-embedded" : "mn-ov";
  ov.setAttribute("role", embedded ? "main" : "dialog");
  if (!embedded) ov.setAttribute("aria-modal", "true");
  const name = ctx.profileName ? `, ${ctx.profileName}` : "";
  ov.innerHTML = `
    <div class="mn-wrap">
      <header class="mn-head">
        <div class="mn-head-tx">
          <p class="mn-date">${esc(now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</p>
          <h1 class="mn-hello">${esc(tt(greeting(now.getHours())))}<em>${esc(name)}</em></h1>
          <p class="mn-line" data-role="line">${esc(tt("Lecture de votre journée…"))}</p>
        </div>
        <div class="mn-head-act">
          <button class="mn-btn outline" data-act="refresh" title="${esc(tt("Actualiser"))}">${ic("refresh-cw")}<span>${esc(tt("Actualiser"))}</span></button>
          ${embedded ? "" : `<button class="mn-btn primary" data-act="start">${esc(tt("Commencer la journée"))}${ic("arrow-right")}</button>`}
        </div>
      </header>
      <div class="mn-kpis" data-role="kpis">${[0, 1, 2, 3].map(() => `<div class="mn-kpi mn-skel"></div>`).join("")}</div>
      <div class="mn-grid" data-role="grid">${[0, 1, 2, 3].map(() => `<section class="mn-card mn-skel"></section>`).join("")}</div>
      <section class="mn-news" data-role="news">
        <div class="mn-news-head">
          <h2>${ic("newspaper")}<span>${esc(tt("Actualités"))}</span></h2>
          <div class="mn-topics" data-role="topics"></div>
          <form class="mn-topic-form" data-role="topic-form"><input class="mn-input" name="topic" placeholder="${esc(tt("Ajouter un thème (ex. Intelligence artificielle)"))}" maxlength="60" /><button class="mn-btn outline sm" type="submit">${ic("plus")}</button></form>
        </div>
        <div class="mn-news-grid" data-role="news-grid"><div class="mn-empty">${esc(tt("Chargement des actualités…"))}</div></div>
      </section>
      ${embedded ? "" : `<footer class="mn-foot">
        <button class="mn-btn ghost sm" data-act="off">${esc(tt("Ne plus afficher cet écran"))}</button>
        <span class="mn-hint"><kbd>Échap</kbd> ${esc(tt("pour fermer"))}</span>
      </footer>`}
    </div>`;
  document.body.appendChild(ov);

  const close = () => {
    if (embedded) return;
    ov.classList.add("out");
    setTimeout(() => ov.remove(), 220);
    document.removeEventListener("keydown", onKey);
  };
  function onKey(e) { if (e.key === "Escape") close(); }
  ov.querySelector('[data-act="refresh"]').addEventListener("click", () => {
    localStorage.removeItem("morningWeatherCache");
    if (embedded) showMorning(ctx);
    else { ov.remove(); document.removeEventListener("keydown", onKey); showMorning({ ...ctx, _again: true }); }
  });
  if (!embedded) {
    document.addEventListener("keydown", onKey);
    ov.querySelector('[data-act="start"]').addEventListener("click", close);
    ov.querySelector('[data-act="off"]').addEventListener("click", () => {
      localStorage.setItem(KEY_ENABLED, "false");
      close();
    });
  }

  // Actualités : chargées à part (réseau, parfois lent) pour ne pas retenir
  // le reste de la page.
  renderNews(ov, ctx).catch(() => {});

  const [agenda, inbox, mail, overnight, todo, weather] = await Promise.all([
    collectAgenda(), collectInbox(), collectMail(), collectOvernight(), collectTodo(), collectWeather(),
  ]);
  if (!ov.isConnected) return;

  // La phrase d'accroche dit L'ESSENTIEL, pas un décompte de tout : le premier
  // rendez-vous s'il y en a un, sinon la charge du jour, sinon rien à signaler.
  const nowMs = Date.now();
  const next = agenda.find((i) => i.at >= nowMs);
  const line = next
    ? tt("Prochain point à {time} : {title}.", { time: hhmm(next.at), title: next.title })
    : agenda.length
      ? tt("Plus rien de planifié aujourd'hui.")
      : todo.length
        ? tt("Rien de planifié — {n} tâche(s) attendent malgré tout.", { n: todo.length })
        : tt("Journée libre, et aucune tâche en attente.");
  ov.querySelector('[data-role="line"]').textContent = line;

  const unread = mail.unread + inbox.unread;
  ov.querySelector('[data-role="kpis"]').innerHTML =
    kpi("rendez-vous aujourd'hui", agenda.length, "calendar") +
    kpi("tâche(s) ouverte(s)", todo.length, "list-checks", todo.length > 8 ? "warn" : "") +
    kpi("message(s) non lu(s)", unread, "inbox", unread ? "info" : "") +
    kpi("action(s) des agents cette nuit", overnight.count, "sparkles");

  // Agenda : frise du jour, avec le repère « maintenant ».
  let agendaRows = "";
  if (agenda.length) {
    let nowPlaced = false;
    for (const i of agenda.slice(0, 7)) {
      if (!nowPlaced && i.at >= nowMs) { agendaRows += `<li class="mn-now"><span>${esc(tt("Maintenant"))} · ${esc(hhmm(nowMs))}</span></li>`; nowPlaced = true; }
      agendaRows += `<li class="mn-ev${i.at < nowMs ? " past" : ""}${i === next ? " next" : ""}"><time>${esc(hhmm(i.at))}</time><span class="mn-ev-t">${esc(i.title)}</span>${badge(i.app)}</li>`;
    }
    if (!nowPlaced) agendaRows += `<li class="mn-now"><span>${esc(tt("Maintenant"))} · ${esc(hhmm(nowMs))}</span></li>`;
    agendaRows = `<ol class="mn-timeline">${agendaRows}</ol>`;
    if (agenda.length > 7) agendaRows += `<p class="mn-more">+ ${agenda.length - 7} ${esc(tt("autre(s)"))}</p>`;
  } else agendaRows = empty("Aucune échéance aujourd'hui.");

  const todoRows = todo.length
    ? `<ul class="mn-list">${todo.slice(0, 6).map((t) => `<li><span class="mn-dot"></span><span class="mn-li-t">${esc(t.text)}</span>${badge(t.app || t.agent)}</li>`).join("")}</ul>${todo.length > 6 ? `<p class="mn-more">+ ${todo.length - 6} ${esc(tt("autre(s)"))}</p>` : ""}`
    : empty("Aucune tâche en attente.");

  const mailRows = unread || mail.last
    ? `<div class="mn-split"><div><b>${mail.unread}</b><small>${esc(tt("courriel(s)"))}</small></div><div><b>${inbox.unread}</b><small>${esc(tt("du Fil"))}</small></div></div>
       <ul class="mn-list">${mail.last ? `<li><span class="mn-li-ic">${ic("mail")}</span><span class="mn-li-t">${esc(mail.last.subject || tt("(sans objet)"))}</span>${badge(String(mail.last.from || "").replace(/<.*>/, "").trim().slice(0, 24))}</li>` : ""}
       ${inbox.last ? `<li><span class="mn-li-ic">${ic("inbox")}</span><span class="mn-li-t">${esc(inbox.last.subject || inbox.last.title || "")}</span>${badge(inbox.last.from || "")}</li>` : ""}</ul>`
    : empty("Aucun message en attente.");

  const nightRows = overnight.count
    ? `<div class="mn-split"><div><b>${overnight.count}</b><small>${esc(tt("action(s)"))}</small></div><div><b>${overnight.tokens.toLocaleString()}</b><small>${esc(tt("jetons"))}</small></div></div>
       ${overnight.last ? `<ul class="mn-list"><li><span class="mn-li-ic">${ic("bot")}</span><span class="mn-li-t">${esc(String(overnight.last.detail || overnight.last.source || "").slice(0, 90))}</span>${badge(overnight.last.source || "")}</li></ul>` : ""}`
    : empty("Rien ne s'est passé pendant votre absence.");

  let weatherRows;
  if (weather.temp != null && !weather.error) {
    weatherRows = `<div class="mn-weather"><span class="mn-wglyph">${esc(weather.glyph || "")}</span><div><div class="mn-wtemp">${esc(String(weather.temp))}</div><div class="mn-wlabel">${esc(weather.label || "")}</div></div></div>
      <div class="mn-wmeta">${weather.min != null ? `<span>${esc(tt("Min"))} <b>${esc(String(weather.min))}</b></span>` : ""}${weather.max != null ? `<span>${esc(tt("Max"))} <b>${esc(String(weather.max))}</b></span>` : ""}${weather.rain != null ? `<span>${esc(tt("Pluie"))} <b>${esc(String(weather.rain))}</b></span>` : ""}${weather.wind != null ? `<span>${esc(tt("Vent"))} <b>${esc(String(weather.wind))}</b></span>` : ""}</div>
      <p class="mn-more">${esc(weather.city || weather.place)}</p>`;
  } else {
    weatherRows = `${weather.error ? `<div class="mn-empty">${esc(tt("Météo indisponible pour « {p} ».", { p: weather.place }))}</div>` : `<div class="mn-empty">${esc(tt("Indiquez votre ville pour voir la météo du jour."))}</div>`}
      <form class="mn-wform" data-role="wform"><input class="mn-input" name="place" placeholder="${esc(tt("Ville (ex. Lyon)"))}" value="${esc(weather.place || "")}" /><button class="mn-btn outline sm" type="submit">${esc(tt("OK"))}</button></form>`;
  }

  const link = (app, label) => (typeof ctx.openApp === "function" ? `<button class="mn-btn ghost xs" data-open="${app}">${esc(tt(label))}${ic("arrow-right")}</button>` : "");
  const grid = ov.querySelector('[data-role="grid"]');
  grid.innerHTML =
    card("Aujourd'hui", "calendar", agendaRows, { cls: "tall", action: link("calendar", "Agenda") }) +
    card("À faire", "list-checks", todoRows, { action: link("kanban", "Tableau") }) +
    card("Messages", "inbox", mailRows, { action: link("mail", "Email") }) +
    card("Pendant la nuit", "sparkles", nightRows, { action: link("agents", "Agents") }) +
    card("Météo", "sun", weatherRows);

  grid.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { close(); ctx.openApp(b.dataset.open); }));
  grid.querySelector('[data-role="wform"]')?.addEventListener("submit", (e) => {
    e.preventDefault();
    const place = new FormData(e.target).get("place")?.toString().trim();
    if (!place) return;
    localStorage.setItem("morningWeatherPlace", place);
    localStorage.removeItem("morningWeatherCache");
    if (embedded) showMorning(ctx);
    else { ov.remove(); document.removeEventListener("keydown", onKey); showMorning({ ...ctx }); }
  });
}


// ===== Actualités ==============================================================
// Thèmes choisis ici par l'utilisateur (morning.json, partagé avec le casque) ;
// articles publiés par l'agent « Veilleur web » (morning_news_publish) ou, à
// défaut, titres récupérés en direct (src-tauri/src/morning.rs).
function timeAgo(ms) {
  const h = Math.round((Date.now() - ms) / 3_600_000);
  return h < 1 ? tt("à l'instant") : tt("il y a {h} h", { h });
}
async function openArticle(url, title) {
  if (!url) return;
  try {
    const { handoff, makeObject } = await import("../lib/interop.js");
    if (handoff("browser", makeObject("link", { url, title }))) return;
  } catch { /* repli ci-dessous */ }
  invoke?.("open_external", { url }).catch(() => {});
}
async function renderNews(ov, ctx) {
  const box = ov.querySelector('[data-role="news-grid"]');
  const chips = ov.querySelector('[data-role="topics"]');
  const form = ov.querySelector('[data-role="topic-form"]');
  if (!box || !invoke) { ov.querySelector('[data-role="news"]')?.remove(); return; }
  let data;
  try { data = await invoke("morning_news"); } catch (e) { box.innerHTML = `<div class="mn-empty">${esc(String(e?.message || e))}</div>`; return; }
  const topics = data?.topics || [];
  const saveTopics = async (list) => { try { await invoke("morning_topics_set", { topics: list }); } catch {} renderNews(ov, ctx); };
  chips.innerHTML = topics.map((t, i) => `<span class="mn-topic">${esc(t)}<button type="button" data-rm="${i}" title="${esc(tt("Retirer"))}">×</button></span>`).join("");
  chips.onclick = (e) => { const b = e.target.closest("[data-rm]"); if (b) saveTopics(topics.filter((_, i) => i !== Number(b.dataset.rm))); };
  form.onsubmit = (e) => {
    e.preventDefault();
    const t = new FormData(form).get("topic")?.toString().trim();
    if (t) saveTopics([...topics, t]);
  };
  if (!topics.length) {
    box.innerHTML = `<div class="mn-empty">${esc(tt("Ajoutez vos thèmes : l'agent « Veilleur web » prépare chaque matin une sélection d'articles résumés, aussi visible dans le casque."))}</div>`;
    return;
  }
  const news = data?.news || [];
  box.innerHTML = news.map((n) => {
    const items = (n.items || []).slice(0, 4);
    const by = n.curated ? `${esc(tt("Veille de l'agent"))} · ${esc(timeAgo(n.at))}` : esc(tt("Titres en direct"));
    return `<section class="mn-card mn-news-card">
      <div class="mn-card-head"><span class="mn-card-ic">${ic("newspaper")}</span><h3>${esc(n.topic)}</h3><span class="mn-news-by${n.curated ? " curated" : ""}">${by}</span></div>
      <div class="mn-news-items">${items.length ? items.map((it) => `<button type="button" class="mn-article" data-url="${esc(it.link || "")}" data-title="${esc(it.title || "")}">
          <b>${esc(it.title || "")}</b>${it.summary ? `<span>${esc(it.summary)}</span>` : ""}<small>${esc(it.source || "")}</small></button>`).join("")
        : `<div class="mn-empty">${esc(tt("Rien de neuf sur ce thème."))}</div>`}</div>
    </section>`;
  }).join("");
  box.onclick = (e) => { const a = e.target.closest(".mn-article"); if (a) openArticle(a.dataset.url, a.dataset.title); };
}
