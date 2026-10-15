import { autoTranslate, tt } from "../apps-i18n.js";
// App « Mémoire » — gestion des 4 types de souvenirs de Lumen (cf. recall.rs) :
// session, sémantique, procédurale, épisodique.
// S'identifie auprès du backend avec le contexte gestionnaire « app:memory »,
// ce qui lui ouvre la lecture/écriture de tous les types ET l'édition de la
// politique d'accès. Toute la sécurité (cloisonnement) est appliquée côté Rust ;
// cette UI ne fait que présenter et piloter.

const __TAURI = window.__TAURI__ || window.parent?.__TAURI__ || {};
const invoke = __TAURI.core?.invoke;
const listen = __TAURI.event?.listen;

const CTX = "app:memory";

// ===== Jeu d'icônes SVG (style Lucide, monochrome, suit currentColor) =====
const ICONS = {
  brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.1-2.1z"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A4.5 4.5 0 0 0 12 6 4.5 4.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l3-4 3 2 4-7"/>',
  scroll: '<path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M16 3h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2z"/><path d="M8 7h6M8 11h8M8 15h8"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.8V4h6v6.8a2 2 0 0 0 .4 1.2l1.6 2.1a1 1 0 0 1-.8 1.6H7.8a1 1 0 0 1-.8-1.6l1.6-2.1a2 2 0 0 0 .4-1.2z"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
};
const svg = (name, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;

// Les 4 types (architecture d'agent : Session / Semantic / Procedural / Episodic).
const KINDS = [
  { id: "session",    label: "Session",      icon: "clock",  desc: "Mémoire de travail de la conversation en cours : contexte, décisions du moment. Oubliée au bout de 24 h, sauf si vous la promouvez." },
  { id: "semantic",   label: "Sémantique",   icon: "book",   desc: "Faits stables : vos préférences, vos goûts, vos proches, vos projets, le monde." },
  { id: "procedural", label: "Procédurale",  icon: "wrench", desc: "Comment un travail se fait : méthodes, routines, habitudes, étapes qui ont marché (agents, workflows)." },
  { id: "episodic",   label: "Épisodique",   icon: "scroll", desc: "Ce qui s'est passé (et ce qui est prévu) : événements datés, tâches terminées, échanges marquants." },
];
// Qui lit / écrit la mémoire (contextes de la politique), en clair.
const CONTEXT_LABELS = {
  bar: "Discussion (barre, application, bureau)", agent: "Agents", messenger: "Messages", telegram: "Passerelles (Telegram, Slack)",
  domotique: "Domotique", studio: "Studio d'images", moodboard: "Planche", notes: "Notes", mindmap: "Carte mentale",
  studies: "Études", calendar: "Agenda", mail: "Email", fluxo: "Fluxo (blocs mémoire)", consolidation: "Consolidation (IA)",
};
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]));

import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";

import { receive, toText } from "../lib/interop.js";
const $ = (id) => document.getElementById(id);
let currentKind = "semantic";
let currentView = "overview";
let policyState = null; // { kinds:[], policy:{ table:{} } }

function fmtDate(ms) {
  try { return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
  catch { return ""; }
}
function esc(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }

// ===== Navigation =====
function buildNav() {
  const nav = $("kind-nav");
  nav.innerHTML = "";
  for (const k of KINDS) {
    const b = document.createElement("button");
    b.className = "kind-btn";
    b.dataset.kind = k.id;
    b.innerHTML = `<span class="ki">${svg(k.icon)}</span><span class="kl">${k.label}</span><span class="kn" data-count="${k.id}">·</span>`;
    b.addEventListener("click", () => selectKind(k.id));
    nav.appendChild(b);
  }
  document.querySelectorAll(".nav-special").forEach((el) => {
    el.addEventListener("click", () => showView(el.dataset.view));
  });
}

function showView(view) {
  currentView = view;
  $("view-kind").hidden = view !== "kind";
  $("view-overview").hidden = view !== "overview";
  if (view === "overview") renderOverview();
  $("view-search").hidden = view !== "search";
  $("view-policy").hidden = view !== "policy";
  document.querySelectorAll(".nav-special").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  if (view !== "kind") document.querySelectorAll(".kind-btn").forEach((b) => b.classList.remove("active"));
  if (view === "policy") renderPolicy();
}

async function selectKind(kind) {
  currentKind = kind;
  showView("kind");
  const meta = KINDS.find((k) => k.id === kind);
  $("kind-title").innerHTML = `<span class="title-ic">${svg(meta.icon, 22)}</span>${esc(meta.label)}`;
  $("kind-desc").textContent = meta.desc;
  document.querySelectorAll(".kind-btn").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  await renderItems();
}

// ===== Liste d'un type =====
async function renderItems() {
  const box = $("items");
  let items = [];
  try { items = await invoke("mem_list", { context: CTX, kind: currentKind }); }
  catch (e) { box.innerHTML = `<div class="err">${esc(e?.message || e)}</div>`; return; }
  box.innerHTML = "";
  // Le type sémantique englobe les « souvenirs » du Profil (mémoire utilisateur
  // qui conditionne réellement les réponses, clé `user/memories`). On les affiche
  // ici pour unifier : modifier/supprimer écrit dans la même source.
  let profileCount = 0;
  if (currentKind === "semantic") profileCount = await renderProfileMemories(box);
  $("items-empty").hidden = (items.length + profileCount) > 0;
  for (const it of items) box.appendChild(itemCard(it));
}

// Souvenirs du Profil (clé KV `user/memories`, tableau de chaînes). Affichés en
// tête du type sémantique, avec un badge « Profil ». Source que l'IA injecte
// dans le system prompt — donc l'éditer ici se répercute sur les réponses.
async function renderProfileMemories(box) {
  let mems = [];
  try { const e = await invoke("memory_get", { key: "user/memories" }); mems = (e && e.value) || []; }
  catch { mems = []; }
  if (!Array.isArray(mems) || !mems.length) return 0;
  const save = async (arr) => { try { await invoke("memory_set", { key: "user/memories", value: arr }); } catch {} };
  // Les entrées sont soit des objets { text, source, ts }, soit (legacy) des chaînes.
  const textOf = (m) => (typeof m === "string" ? m : (m && m.text) || "");
  mems.forEach((m, i) => {
    const text = textOf(m);
    const card = document.createElement("div");
    card.className = "card profile";
    card.innerHTML = `
      <div class="card-main">
        <div class="card-text" contenteditable="false">${esc(text)}</div>
        <div class="card-meta"><span class="kind-badge profile-badge">Profil</span><span title="Source">Profil utilisateur</span></div>
      </div>
      <div class="card-actions">
        <button class="ic-btn edit" title="Modifier">${svg("pencil")}</button>
        <button class="ic-btn del" title="Oublier">${svg("trash")}</button>
      </div>`;
    const textEl = card.querySelector(".card-text");
    const editBtn = card.querySelector(".edit");
    editBtn.addEventListener("click", async () => {
      const editing = textEl.getAttribute("contenteditable") === "true";
      if (editing) {
        textEl.setAttribute("contenteditable", "false");
        editBtn.innerHTML = svg("pencil");
        const newText = textEl.textContent.trim();
        const cur = [...mems];
        // Préserve la forme objet (text/source/ts) ; ne casse pas le legacy chaîne.
        cur[i] = (typeof cur[i] === "string") ? newText : { ...cur[i], text: newText };
        mems = cur; await save(cur);
      } else {
        textEl.setAttribute("contenteditable", "true");
        editBtn.innerHTML = svg("save");
        textEl.focus();
      }
    });
    card.querySelector(".del").addEventListener("click", async (e) => {
      if (!armDelete(e.currentTarget)) return;
      const cur = mems.filter((_, j) => j !== i);
      mems = cur; await save(cur); await renderItems();
    });
    box.appendChild(card);
  });
  return mems.length;
}

function itemCard(it) {
  const card = document.createElement("div");
  card.className = "card" + (it.pinned ? " pinned" : "");
  const tags = (it.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  card.innerHTML = `
    <div class="card-main">
      <div class="card-text" contenteditable="false">${esc(it.text)}</div>
      <div class="card-meta">
        <span title="Source">${esc(it.source || "—")}</span> ·
        <span title="Mis à jour">${fmtDate(it.updated_at)}</span> ·
        <span title="Rappels">↺ ${it.access_count || 0}</span>
        ${it.expires_at ? `· <span class="expires" title="${esc(fmtDate(it.expires_at))}">${esc(expiresIn(it.expires_at))}</span>` : ""}
        ${tags ? `<span class="tags">${tags}</span>` : ""}
      </div>
      <div class="card-sal">
        <label>Saillance</label>
        <input type="range" min="0" max="100" value="${Math.round((it.salience ?? 0.5) * 100)}" class="sal" />
        <span class="sal-val">${Math.round((it.salience ?? 0.5) * 100)}</span>
      </div>
    </div>
    <div class="card-actions">
      <select class="move" title="Changer de type">${KINDS.map((k) => `<option value="${k.id}"${k.id === it.kind ? " selected" : ""}>${esc(k.label)}</option>`).join("")}</select>
      <button class="ic-btn pin${it.pinned ? " on" : ""}" title="Épingler">${svg("pin")}</button>
      <button class="ic-btn edit" title="Modifier">${svg("pencil")}</button>
      <button class="ic-btn del" title="Oublier">${svg("trash")}</button>
    </div>`;

  const textEl = card.querySelector(".card-text");
  const sal = card.querySelector(".sal");
  const salVal = card.querySelector(".sal-val");
  sal.addEventListener("input", () => { salVal.textContent = sal.value; });
  sal.addEventListener("change", () => update(it, { salience: Number(sal.value) / 100 }));

  card.querySelector(".pin").addEventListener("click", () => update(it, { pinned: !it.pinned }));
  card.querySelector(".move").addEventListener("change", (e) => moveItem(it, e.target.value));
  card.querySelector(".del").addEventListener("click", (e) => {
    if (armDelete(e.currentTarget)) forget(it);
  });
  const editBtn = card.querySelector(".edit");
  editBtn.addEventListener("click", async () => {
    const editing = textEl.getAttribute("contenteditable") === "true";
    if (editing) {
      textEl.setAttribute("contenteditable", "false");
      editBtn.innerHTML = svg("pencil");
      await update(it, { text: textEl.textContent.trim() });
    } else {
      textEl.setAttribute("contenteditable", "true");
      editBtn.innerHTML = svg("save");
      textEl.focus();
    }
  });
  return card;
}

function expiresIn(ms) {
  const h = Math.max(0, Math.round((ms - Date.now()) / 3600000));
  return h < 1 ? "expire bientôt" : h < 48 ? `expire dans ${h} h` : `expire dans ${Math.round(h / 24)} j`;
}

/// Change le type d'un souvenir (ex. une note de session promue en fait
/// durable) : réécrit dans le nouveau type, sans expiration, puis oublie l'ancien.
async function moveItem(it, kind) {
  if (!kind || kind === it.kind) return;
  try {
    await invoke("mem_remember", { context: CTX, kind, text: it.text, tags: it.tags || [], salience: it.salience, source: it.source || "Mémoire", meta: it.meta ?? null });
    await invoke("mem_forget", { context: CTX, kind: it.kind, id: it.id });
    await renderItems(); refreshCounts();
  } catch (e) { alert(e?.message || e); }
}

// ===== Vue d'ensemble =====
async function renderOverview() {
  const box = $("overview");
  let stats = {};
  try { stats = await invoke("mem_stats", { context: CTX }); } catch {}
  const counts = stats?.counts || stats || {};
  const recent = [];
  for (const k of KINDS) {
    try { for (const it of (await invoke("mem_list", { context: CTX, kind: k.id })).slice(0, 5)) recent.push(it); } catch {}
  }
  recent.sort((a, b) => b.updated_at - a.updated_at);
  if (!policyState) await loadPolicy();
  const tbl = policyState?.policy?.table || {};
  const users = Object.entries(tbl).map(([ctx, row]) => {
    const w = KINDS.filter((k) => row[k.id] === "write").map((k) => k.label);
    const r = KINDS.filter((k) => row[k.id] === "read").map((k) => k.label);
    return { ctx, w, r };
  }).filter((u) => u.w.length || u.r.length);
  box.innerHTML = `
    <div class="ov-tiles">${KINDS.map((k) => `<button class="ov-tile" data-kind="${k.id}"><span class="ki">${svg(k.icon, 20)}</span><b>${Number(counts[k.id] ?? 0)}</b><span>${esc(k.label)}</span></button>`).join("")}</div>
    <div class="ov-cols">
      <section class="ov-card"><h3>Appris récemment</h3>
        ${recent.slice(0, 10).map((it) => `<div class="ov-item"><span class="ov-kind k-${it.kind}">${esc(KIND_LABEL[it.kind] || it.kind)}</span><span class="ov-text">${esc(it.text)}</span><small>${esc(it.source || "")} · ${esc(fmtDate(it.updated_at))}</small></div>`).join("") || '<p class="muted">Rien pour l\'instant.</p>'}
      </section>
      <section class="ov-card"><h3>Qui utilise la mémoire</h3>
        ${users.map((u) => `<div class="ov-user"><b>${esc(CONTEXT_LABELS[u.ctx] || u.ctx)}</b><small>${u.w.length ? `écrit : ${esc(u.w.join(", "))}` : ""}${u.w.length && u.r.length ? " · " : ""}${u.r.length ? `lit : ${esc(u.r.join(", "))}` : ""}</small></div>`).join("")}
        <p class="muted small">Modifiable dans « Accès &amp; sécurité ». Le cloisonnement est appliqué par le moteur, pas par l'interface.</p>
      </section>
    </div>`;
  box.querySelectorAll(".ov-tile").forEach((b) => b.addEventListener("click", () => selectKind(b.dataset.kind)));
}

async function update(it, fields) {
  try {
    await invoke("mem_update", { context: CTX, kind: it.kind, id: it.id, ...fields });
    await renderItems();
    refreshCounts();
  } catch (e) { alert(e?.message || e); }
}
async function forget(it) {
  try { await invoke("mem_forget", { context: CTX, kind: it.kind, id: it.id }); await renderItems(); refreshCounts(); }
  catch (e) { alert(e?.message || e); }
}

function armDelete(btn) {
  if (!btn) return false;
  if (btn.dataset.armed === "1") {
    btn.dataset.armed = "0";
    btn.classList.remove("armed");
    btn.title = "Oublier";
    return true;
  }
  btn.dataset.armed = "1";
  btn.classList.add("armed");
  btn.title = "Confirmer la suppression";
  const prev = btn.innerHTML;
  btn.textContent = "!";
  setTimeout(() => {
    if (btn.dataset.armed === "1") {
      btn.dataset.armed = "0";
      btn.classList.remove("armed");
      btn.title = "Oublier";
      btn.innerHTML = prev;
    }
  }, 3000);
  return false;
}

async function addItem() {
  const text = $("add-text").value.trim();
  if (!text) return;
  const tags = $("add-tags").value.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    await invoke("mem_remember", { context: CTX, kind: currentKind, text, tags, source: "Saisie manuelle" });
    $("add-text").value = ""; $("add-tags").value = "";
    await renderItems(); refreshCounts();
  } catch (e) { alert(e?.message || e); }
}

async function wipeKind() {
  // confirm() inopérant sous WKWebView : on confirme via un double-clic visuel.
  const btn = $("btn-wipe");
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Confirmer la suppression ?";
    setTimeout(() => { btn.dataset.armed = "0"; btn.textContent = "Tout effacer"; }, 3000);
    return;
  }
  btn.dataset.armed = "0"; btn.textContent = "Tout effacer";
  try { await invoke("mem_wipe", { context: CTX, kind: currentKind }); await renderItems(); refreshCounts(); }
  catch (e) { alert(e?.message || e); }
}

// Consolidation : session + épisodique récents → sémantique/procédural (via l'IA).
async function consolidate(e) {
  const btn = e?.currentTarget || $("btn-consolidate");
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "Consolidation…";
  try {
    const r = await invoke("mem_consolidate", { context: CTX });
    const n = (r && r.consolidated) || 0;
    btn.textContent = n ? `✓ ${n} souvenir(s) digéré(s)` : "Rien à consolider";
    if (currentView === "overview") renderOverview(); else await renderItems();
    refreshCounts();
  } catch (e) {
    btn.textContent = "Échec";
    alert(e?.message || e);
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 2200);
}

// ===== Compteurs =====
async function refreshCounts() {
  try {
    const stats = await invoke("mem_stats", { context: CTX });
    document.querySelectorAll("[data-count]").forEach((el) => {
      const n = stats[el.getAttribute("data-count")] ?? 0;
      el.textContent = n;
    });
  } catch { /* non bloquant */ }
}

// ===== Recherche =====
async function runSearch() {
  const q = $("search-q").value.trim();
  const box = $("search-results");
  box.innerHTML = "";
  try {
    const res = await invoke("mem_recall", { context: CTX, query: q || null, limit: 25 });
    if (!res.length) { box.innerHTML = `<div class="empty">Aucun souvenir pertinent.</div>`; return; }
    for (const r of res) {
      const card = itemCard(r);
      const badge = document.createElement("span");
      badge.className = "kind-badge";
      badge.textContent = `${KIND_LABEL[r.kind] || r.kind} · score ${(r.score ?? 0).toFixed(2)}`;
      card.querySelector(".card-meta").prepend(badge);
      box.appendChild(card);
    }
  } catch (e) { box.innerHTML = `<div class="err">${esc(e?.message || e)}</div>`; }
}

// ===== Politique d'accès =====
const ACCESS_CYCLE = ["none", "read", "write"];
const ACCESS_LABEL = { none: "—", read: "Lecture", write: "Écriture" };

async function loadPolicy() {
  try { policyState = await invoke("mem_policy_get", { context: CTX }); }
  catch (e) { policyState = { kinds: KINDS.map((k) => k.id), policy: { table: {} } }; }
}

function policyContexts() {
  // Contextes connus (défauts) + ceux déjà présents dans la table.
  const base = Object.keys(CONTEXT_LABELS);
  const fromTable = Object.keys(policyState?.policy?.table || {});
  return Array.from(new Set([...base, ...fromTable]));
}

function renderPolicy() {
  if (!policyState) { loadPolicy().then(renderPolicy); return; }
  const table = $("policy-table");
  const kinds = policyState.kinds || KINDS.map((k) => k.id);
  const ctxs = policyContexts();
  const tbl = policyState.policy.table || (policyState.policy.table = {});

  let html = "<thead><tr><th>Contexte</th>";
  for (const k of kinds) html += `<th>${esc(KIND_LABEL[k] || k)}</th>`;
  html += "</tr></thead><tbody>";
  for (const ctx of ctxs) {
    html += `<tr><td class="ctx" title="${esc(ctx)}">${esc(CONTEXT_LABELS[ctx] || ctx)}</td>`;
    for (const k of kinds) {
      const a = (tbl[ctx] && tbl[ctx][k]) || "none";
      html += `<td><button class="acc acc-${a}" data-ctx="${esc(ctx)}" data-kind="${k}">${ACCESS_LABEL[a]}</button></td>`;
    }
    html += "</tr>";
  }
  html += "</tbody>";
  table.innerHTML = html;
  table.querySelectorAll(".acc").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ctx = btn.dataset.ctx, k = btn.dataset.kind;
      tbl[ctx] = tbl[ctx] || {};
      const cur = tbl[ctx][k] || "none";
      const next = ACCESS_CYCLE[(ACCESS_CYCLE.indexOf(cur) + 1) % ACCESS_CYCLE.length];
      tbl[ctx][k] = next;
      btn.className = `acc acc-${next}`;
      btn.textContent = ACCESS_LABEL[next];
    });
  });
}

async function savePolicy() {
  try {
    await invoke("mem_policy_set", { context: CTX, policy: policyState.policy });
    const btn = $("btn-policy-save");
    btn.textContent = "Enregistré ✓";
    setTimeout(() => { btn.textContent = "Enregistrer"; }, 1500);
  } catch (e) { alert(e?.message || e); }
}

// ===== Init =====
// ===== Assistant IA (boîte de prompt partagée) =====
// La mémoire se tient au prompt : rappeler, mémoriser dans le bon type,
// corriger, oublier, consolider. Le cloisonnement reste appliqué côté Rust.
const KIND_IDS = KINDS.map((k) => k.id);

const MEMORY_TOOLS = [
  tool("recall", "Cherche dans tous les types de mémoire les souvenirs pertinents.",
    { query: T.str("Sujet ou question"), limit: T.int("Nombre de souvenirs (défaut 15)") }, ["query"]),
  tool("list_memories", "Liste les souvenirs d'un type donné.", { kind: T.enum(KIND_IDS, "Type de mémoire") }, ["kind"]),
  tool("remember", "Mémorise un souvenir dans le type qui convient.",
    { kind: T.enum(KIND_IDS, "Type de mémoire"), text: T.str("Le souvenir, en une phrase claire"), tags: T.list("Étiquettes") },
    ["kind", "text"]),
  tool("update_memory", "Corrige le texte ou les étiquettes d'un souvenir.",
    { kind: T.enum(KIND_IDS, ""), id: T.str("Identifiant du souvenir"), text: T.str(""), tags: T.list("") }, ["kind", "id"]),
  tool("forget", "Oublie (supprime) un souvenir.", { kind: T.enum(KIND_IDS, ""), id: T.str("") }, ["kind", "id"]),
  tool("consolidate", "Digère les souvenirs épisodiques récents en faits durables.", {}),
  tool("stats", "Statistiques de la mémoire : volume par type.", {}),
];

async function runMemoryTool(name, a) {
  switch (name) {
    case "recall": {
      const res = await invoke("mem_recall", { context: CTX, query: String(a.query || ""), limit: Math.min(40, Number(a.limit) || 15) });
      const items = Array.isArray(res) ? res : (res?.items || []);
      return items.length ? items.map((r) => `[${r.kind}] ${r.id} · ${r.text}`).join("\n") : "Aucun souvenir sur ce sujet.";
    }
    case "list_memories": {
      const items = await invoke("mem_list", { context: CTX, kind: String(a.kind) });
      return (items || []).length ? items.map((r) => `${r.id} · ${r.text}${r.tags?.length ? ` [${r.tags.join(", ")}]` : ""}`).join("\n") : "Rien dans ce type.";
    }
    case "remember": {
      await invoke("mem_remember", { context: CTX, kind: String(a.kind), text: String(a.text),
        tags: Array.isArray(a.tags) ? a.tags : [], source: "Assistant" });
      return `Mémorisé en ${KIND_LABEL[a.kind] || a.kind} : « ${a.text} »`;
    }
    case "update_memory": {
      const fields = {};
      if (a.text != null) fields.text = String(a.text);
      if (Array.isArray(a.tags)) fields.tags = a.tags;
      await invoke("mem_update", { context: CTX, kind: String(a.kind), id: String(a.id), ...fields });
      return "Souvenir corrigé.";
    }
    case "forget": { await invoke("mem_forget", { context: CTX, kind: String(a.kind), id: String(a.id) }); return "Souvenir oublié."; }
    case "consolidate": { const r = await invoke("mem_consolidate", { context: CTX }); return `Consolidation : ${typeof r === "string" ? r : JSON.stringify(r)}`; }
    case "stats": { const st = await invoke("mem_stats", { context: CTX }); return JSON.stringify(st); }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountMemoryAI() {
  mountAiPrompt(null, {
    app: "Mémoire",
    intro: "Tu tiens la mémoire de Lumen : 8 types (épisodique, sémantique, procédurale, émotionnelle, prospective, narrative, partagée…).",
    rules: "- Cherche (recall) avant de mémoriser : ne crée pas de doublon, corrige plutôt l'existant.\n- Choisis le type avec soin : un fait stable est sémantique, un événement daté est épisodique, une intention future est prospective.\n- N'oublie un souvenir que si l'utilisateur le demande explicitement.",
    placeholder: "Ex. : retiens que je préfère les réponses courtes, et oublie mon ancienne adresse…",
    suggestions: [
      { label: "Que sais-tu de moi ?", prompt: "Fais la synthèse de ce que tu sais de moi, par type de mémoire." },
      { label: "Mémoriser", prompt: "Retiens ce que je vais te dire dans le bon type de mémoire." },
      { label: "Nettoyer", prompt: "Repère les souvenirs en double ou périmés et propose de les corriger ou de les oublier." },
      { label: "Consolider", prompt: "Consolide mes souvenirs épisodiques récents en faits durables." },
    ],
    tools: MEMORY_TOOLS,
    context: async () => { try { return JSON.stringify(await invoke("mem_stats", { context: CTX })); } catch { return "(statistiques indisponibles)"; } },
    execute: runMemoryTool,
    onApplied: async () => { await renderItems(); refreshCounts(); },
  });
}

function init() {
  buildNav();
  $("btn-add").addEventListener("click", addItem);
  $("add-text").addEventListener("keydown", (e) => { if (e.key === "Enter") addItem(); });
  $("btn-wipe").addEventListener("click", wipeKind);
  $("btn-consolidate").addEventListener("click", consolidate);
  $("btn-consolidate-ov")?.addEventListener("click", consolidate);
  $("btn-search").addEventListener("click", runSearch);
  $("search-q").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  $("btn-policy-save").addEventListener("click", savePolicy);

  mountMemoryAI();
  // « Mémoriser » depuis n'importe quel texte sélectionné.
  receive("memory", async (obj) => {
    const text = toText(obj).trim();
    if (!text) return;
    await runMemoryTool("remember", { kind: "episodic", text: text.slice(0, 2000), tags: [obj.meta?.sourceApp || "lumen"] });
    await renderItems(); refreshCounts();
  });
  showView("overview");
  refreshCounts();
  loadPolicy();

  // Rafraîchit quand un autre acteur (agent, barre…) écrit un souvenir.
  if (listen) listen("recall-changed", () => { if (currentView === "kind") renderItems(); refreshCounts(); });
}

if (invoke) init();
else document.body.innerHTML = "<p style='padding:24px'>Backend Tauri indisponible.</p>";

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
