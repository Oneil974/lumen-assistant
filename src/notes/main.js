// Notes — logique front. Modèle = tableau de notes { id, title, body, ts }
// persisté en localStorage. Génération et réécriture de contenu par l'IA via le
// backend unifié llmChat (Ollama ou API cloud).

import { translatePage, tt, observeTranslations } from "../apps-i18n.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { llmChat } from "../llm.js";
import { renderMarkdown } from "../sandbox/render.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";
import { describe, makeObject, receive, toText } from "../lib/interop.js";
import { share } from "../lib/share-menu.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { createStore } from "../lib/app-state.js";
import { mountCreativeBar } from "../lib/creative-kit.js";
import { mountMicButton } from "../lib/mic-button.js";
import { registerTranslations } from "../apps-i18n.js";
import { NOTES_EN } from "./i18n.js";
import { mountNotesLiving, decoratePreview } from "./living.js";
import { listAgents } from "../lib/living-docs.js";
import { icon } from "../lib/icons.js";
import { IMG_SCHEME, allTags, backlinks, findByTitle, linkGraph, outgoingLinks, renderNote, tagsOf, unlinkedMentions } from "./links.js";

registerTranslations(NOTES_EN);

// État sur DISQUE (app-state/notes.json) : un carnet grossit sans limite, et le
// stockage du navigateur est un budget partagé par toutes les fenêtres.
const store = createStore("notes");
const KEY = "notes.data";
let notes = load();
let currentId = notes[0]?.id || null;
let saveTimer = null;
let previewOn = false;
let splitOn = false;
let tagFilter = "";

const $ = (id) => document.getElementById(id);

function load() {
  try { const a = JSON.parse(store.get(KEY) || "[]"); if (Array.isArray(a)) return a; } catch {}
  return [];
}
function persist() { store.set(KEY, JSON.stringify(notes)); }

// ===== Historique des versions =====
// Chaque note garde ses états passés dans `history` : [{ ts, title, body }],
// du plus récent au plus ancien. Une version est prise :
//   • au début d'une rafale de frappe, si la dernière remonte à plus d'une
//     minute (on n'archive pas chaque caractère, mais chaque « séance ») ;
//   • AVANT toute modification faite par l'IA (réécriture, outils, fusion) —
//     c'est là qu'on a le plus besoin de pouvoir revenir en arrière.
// Restaurer une version archive d'abord l'état courant : un retour en arrière
// n'est jamais une perte.
const HISTORY_MAX = 40;
const HISTORY_GAP_MS = 60_000;
function recordVersion(n, { force = false } = {}) {
  if (!n) return;
  n.history ||= [];
  const last = n.history[0];
  if (last && last.title === n.title && last.body === n.body) return;
  if (!force && last && Date.now() - last.ts < HISTORY_GAP_MS) return;
  if (!(n.title || "").trim() && !(n.body || "").trim()) return; // rien à garder
  n.history.unshift({ ts: n.ts || Date.now(), title: n.title || "", body: n.body || "" });
  if (n.history.length > HISTORY_MAX) n.history.length = HISTORY_MAX;
}
function restoreVersion(n, index) {
  const v = n?.history?.[index];
  if (!v) return false;
  recordVersion(n, { force: true });
  n.title = v.title; n.body = v.body; n.ts = Date.now();
  persist();
  return true;
}
function openHistory() {
  const n = current();
  if (!n) return;
  const versions = n.history || [];
  const list = $("hist-list");
  list.innerHTML = versions.length ? "" : `<div class="hist-empty">${tt("Aucune version archivée pour cette note. Les versions sont prises à chaque séance d'écriture et avant chaque modification par l'IA.")}</div>`;
  versions.forEach((v, i) => {
    const el = document.createElement("button");
    el.className = "hist-item" + (i === 0 ? " on" : "");
    el.innerHTML = `<b></b><span></span><small></small>`;
    el.querySelector("b").textContent = new Date(v.ts).toLocaleString();
    el.querySelector("span").textContent = v.title || tt("Sans titre");
    el.querySelector("small").textContent = `${(v.body || "").length} ${tt("caractères")} · ${(v.body || "").replace(/\s+/g, " ").slice(0, 70)}`;
    el.addEventListener("click", () => showVersion(i));
    list.appendChild(el);
  });
  $("hist-overlay").hidden = false;
  if (versions.length) showVersion(0); else { $("hist-view").textContent = ""; $("hist-restore").disabled = true; }
}
let histIndex = 0;
function showVersion(i) {
  const n = current();
  const v = n?.history?.[i];
  histIndex = i;
  $("hist-list").querySelectorAll(".hist-item").forEach((el, j) => el.classList.toggle("on", j === i));
  $("hist-view").innerHTML = v ? renderMarkdown(v.body || "") : "";
  $("hist-restore").disabled = !v;
}
function current() { return notes.find((n) => n.id === currentId) || null; }
function uid() { return "note-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ===== Rendu de la liste =====
function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const list = $("note-list");
  list.textContent = "";
  const items = notes
    .filter((n) => !q || (n.title + " " + n.body).toLowerCase().includes(q))
    .filter((n) => !tagFilter || tagsOf(n.body).includes(tagFilter))
    .sort((a, b) => b.ts - a.ts);
  renderTags();
  for (const n of items) {
    const el = document.createElement("div");
    el.className = "note-item" + (n.id === currentId ? " active" : "");
    const preview = (n.body || "").replace(/!\[[^\]]*\]\([^)]*\)/g, "🖼").replace(/\s+/g, " ").slice(0, 60) || tt("Aucun texte");
    el.innerHTML = `<div class="nt"></div><div class="np"></div><div class="nw"></div>`;
    el.querySelector(".nt").textContent = n.title || tt("Sans titre");
    el.querySelector(".np").textContent = preview;
    el.querySelector(".nw").textContent = new Date(n.ts).toLocaleDateString();
    el.addEventListener("click", () => selectNote(n.id));
    list.appendChild(el);
  }
}

function selectNote(id) {
  currentId = id;
  const n = current();
  $("title").value = n ? n.title : "";
  $("body").value = n ? n.body : "";
  $("ed-when").textContent = n ? "Modifié le " + new Date(n.ts).toLocaleString() : "";
  $("empty").hidden = !!n;
  $("title").disabled = $("body").disabled = !n;
  if (!n) setPreview(false);
  else { if (!splitOn) previewOn = !!(n.body || "").trim(); applyPreview(); }
  renderList();
  renderLinks();
}

// ===== Aperçu Markdown =====
// Bascule entre l'édition (textarea) et le rendu Markdown (renderMarkdown partagé).
function applyPreview() {
  const n = current();
  $("btn-preview").disabled = !n;
  $("btn-preview").classList.toggle("primary", previewOn);
  $("btn-preview").innerHTML = icon(previewOn ? "pencil" : "eye", { size: 16 });
  $("btn-preview").title = previewOn ? tt("Éditer") : tt("Aperçu");
  $("btn-split").classList.toggle("primary", splitOn);
  const showPreview = (previewOn || splitOn) && !!n;
  $("panes").classList.toggle("is-split", splitOn && !previewOn && !!n);
  if (showPreview) paintPreview();
  $("preview").hidden = !showPreview;
  $("body").hidden = previewOn && !!n;
}

// Aperçu enrichi : [[liens]], #tags, $formules$ (KaTeX) et images du carnet.
let paintSeq = 0;
async function paintPreview() {
  const n = current();
  if (!n) return;
  const seq = ++paintSeq;
  const agents = await listAgents().catch(() => []);
  const html = await renderNote(n.body || "", { notes, agents, render: renderMarkdown, image: (id) => store.get(`${IMG_PREFIX}${id}`) });
  if (seq !== paintSeq) return;
  $("preview").innerHTML = html;
  // Blocs vivants (en-tête avec l'agent) et fichiers de la suite intégrés.
  decoratePreview($("preview")).catch((e) => console.warn("[notes] décoration", e));
}
function toggleSplit() { splitOn = !splitOn; if (splitOn) previewOn = false; try { localStorage.setItem("notesSplit", splitOn ? "1" : ""); } catch {} applyPreview(); }
function setPreview(on) { previewOn = on; applyPreview(); }
function togglePreview() { if (current()) setPreview(!previewOn); }

function newNote() {
  const n = { id: uid(), title: "", body: "", ts: Date.now() };
  notes.unshift(n); persist(); previewOn = false; selectNote(n.id); $("title").focus();
}
function deleteNote() {
  if (!currentId) return;
  notes = notes.filter((n) => n.id !== currentId);
  persist(); currentId = notes[0]?.id || null; selectNote(currentId);
}

function onEdit() {
  const n = current(); if (!n) return;
  // L'état d'AVANT la frappe est archivé si la dernière version est ancienne.
  recordVersion(n);
  n.title = $("title").value; n.body = $("body").value; n.ts = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persist(); renderList(); renderLinks(); $("ed-when").textContent = tt("Modifié le") + " " + new Date(n.ts).toLocaleString(); }, 400);
  if (splitOn) { clearTimeout(onEdit._p); onEdit._p = setTimeout(paintPreview, 250); }
  linkAutocomplete();
}

// ===== Carnet relié : tags, rétroliens, [[autocomplétion]] =====
function renderTags() {
  const bar = $("tag-bar");
  const tags = allTags(notes).slice(0, 30);
  bar.hidden = !tags.length;
  bar.innerHTML = tags.map(([t, c]) => `<button class="tag-chip${t === tagFilter ? " on" : ""}" data-tag="${t}">#${t}<small>${c}</small></button>`).join("");
}

function linkRow(n) {
  return `<button class="link-row" data-open="${n.id}">${escHtml(n.title || tt("Sans titre"))}</button>`;
}
const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderLinks() {
  const n = current();
  const panel = $("links-panel");
  if (!n) { panel.hidden = true; return; }
  const back = backlinks(notes, n);
  const mentions = unlinkedMentions(notes, n);
  const outs = outgoingLinks(n.body);
  panel.hidden = !back.length && !mentions.length && !outs.length;
  $("backlinks").innerHTML = back.length ? back.map(linkRow).join("") : `<span class="muted">${tt("Aucune note ne renvoie ici.")}</span>`;
  $("mentions").innerHTML = mentions.length
    ? mentions.map((m) => `<span class="mention">${linkRow(m)}<button class="link-fix" data-link="${m.id}" title="${tt("Transformer la mention en lien")}">${tt("Lier")}</button></span>`).join("")
    : `<span class="muted">—</span>`;
  $("outlinks").innerHTML = outs.length
    ? outs.map((t) => { const target = findByTitle(notes, t); return target ? linkRow(target) : `<button class="link-row is-missing" data-create="${escHtml(t)}">${escHtml(t)} <small>(${tt("à créer")})</small></button>`; }).join("")
    : `<span class="muted">—</span>`;
}

/// Ouvre la note citée par un lien, ou la crée si elle n'existe pas encore.
function openByTitle(title) {
  let target = findByTitle(notes, title);
  if (!target) {
    target = { id: uid(), title: String(title).trim(), body: "", ts: Date.now() };
    notes.unshift(target);
    persist();
    toast(tt("Note « {t} » créée.", { t: target.title }));
  }
  selectNote(target.id);
}

function linkMention(id) {
  const n = current();
  const m = notes.find((x) => x.id === id);
  if (!n || !m) return;
  const re = new RegExp(`(?<!\\[\\[)(${n.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?!\\]\\])`, "i");
  recordVersion(m, { force: true });
  m.body = m.body.replace(re, "[[$1]]");
  m.ts = Date.now();
  persist();
  renderLinks();
  toast(tt("Lien ajouté dans « {t} ».", { t: m.title }));
}

// Autocomplétion après « [[ » : les titres du carnet qui commencent comme ce
// qui est tapé, puis ceux qui le contiennent.
function linkAutocomplete() {
  const ta = $("body");
  const menu = $("link-menu");
  const before = ta.value.slice(0, ta.selectionStart);
  const m = /\[\[([^\]\n]{0,60})$/.exec(before);
  if (!m) { menu.hidden = true; return; }
  const q = m[1].toLowerCase();
  const cur = current();
  const hits = notes.filter((n) => n.id !== cur?.id && n.title)
    .map((n) => ({ n, t: n.title.toLowerCase() }))
    .filter(({ t }) => t.includes(q))
    .sort((a, b) => (b.t.startsWith(q) - a.t.startsWith(q)) || a.t.localeCompare(b.t))
    .slice(0, 8);
  const items = hits.map(({ n }) => n.title);
  if (q && !items.some((t) => t.toLowerCase() === q)) items.push(`${m[1]}`);
  if (!items.length) { menu.hidden = true; return; }
  menu.innerHTML = items.map((t, i) => `<button class="${i === 0 ? "on" : ""}" data-pick="${escHtml(t)}">${escHtml(t)}${findByTitle(notes, t) ? "" : ` <small>${tt("nouvelle note")}</small>`}</button>`).join("");
  const r = ta.getBoundingClientRect();
  menu.style.left = `${r.left + 24}px`;
  menu.style.top = `${Math.min(window.innerHeight - 220, r.top + 40)}px`;
  menu.hidden = false;
}
function pickLink(title) {
  const ta = $("body");
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos).replace(/\[\[[^\]\n]*$/, `[[${title}]]`);
  const after = ta.value.slice(pos).replace(/^[^\]\n]*\]\]/, "");
  ta.value = before + after;
  ta.selectionStart = ta.selectionEnd = before.length;
  $("link-menu").hidden = true;
  ta.focus();
  onEdit();
}

// ===== Images : collées, déposées ou capturées =====
// Rangées dans le magasin du carnet (une entrée par image, JPEG réduit) et
// citées dans le texte par ![…](lumen-img:ID) : la note reste lisible, légère
// à sauvegarder, et l'image ne dépend d'aucun fichier externe.
const IMG_PREFIX = "notes.img.";
async function storeImage(dataUrl) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const id = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  store.set(`${IMG_PREFIX}${id}`, c.toDataURL("image/jpeg", 0.85));
  return id;
}
function insertAtCursor(text) {
  const ta = $("body");
  if (!current()) newNote();
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  onEdit();
}
async function insertImageFile(file) {
  const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  const id = await storeImage(url);
  insertAtCursor(`\n![${file.name || tt("image")}](${IMG_SCHEME}${id})\n`);
}
async function captureScreen() {
  const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
  if (!invoke) { toast(tt("Capture indisponible hors de Lumen.")); return; }
  try {
    const shot = await invoke("capture_screen", { maxWidth: 1600 });
    const id = await storeImage(`data:${shot.mime || "image/jpeg"};base64,${shot.image}`);
    insertAtCursor(`\n![${tt("capture")} ${new Date().toLocaleString()}](${IMG_SCHEME}${id})\n`);
    toast(tt("Capture insérée."));
  } catch (e) { toast(`${tt("Capture impossible")} : ${e?.message || e}`); }
}

// ===== Graphe =====
function openGraph() {
  $("graph-overlay").hidden = false;
  const canvas = $("graph");
  const ctx = canvas.getContext("2d");
  const { nodes, edges } = linkGraph(notes);
  const W = canvas.width, H = canvas.height;
  const deg = new Map();
  for (const [a, b] of edges) { deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); }
  const pts = nodes.map((n, i) => ({ ...n, x: W / 2 + Math.cos(i * 2.4) * (60 + i * 6), y: H / 2 + Math.sin(i * 2.4) * (60 + i * 6), vx: 0, vy: 0 }));
  const byId = new Map(pts.map((p) => [p.id, p]));
  const style = getComputedStyle(document.body);
  const fg = style.color || "#222", accent = style.getPropertyValue("--primary").trim() || "#0a84ff";
  let frame = 0;
  const step = () => {
    // Répulsion entre toutes les notes, attraction le long des liens.
    for (const a of pts) {
      for (const b of pts) {
        if (a === b) continue;
        const dx = a.x - b.x, dy = a.y - b.y, d2 = Math.max(80, dx * dx + dy * dy);
        a.vx += (dx / d2) * 900; a.vy += (dy / d2) * 900;
      }
      a.vx += (W / 2 - a.x) * 0.002; a.vy += (H / 2 - a.y) * 0.002;
    }
    for (const [ia, ib] of edges) {
      const a = byId.get(ia), b = byId.get(ib);
      const dx = b.x - a.x, dy = b.y - a.y;
      a.vx += dx * 0.01; a.vy += dy * 0.01; b.vx -= dx * 0.01; b.vy -= dy * 0.01;
    }
    for (const p of pts) { p.vx *= 0.82; p.vy *= 0.82; p.x = Math.max(20, Math.min(W - 20, p.x + p.vx)); p.y = Math.max(20, Math.min(H - 20, p.y + p.vy)); }
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(127,127,127,.45)"; ctx.lineWidth = 1;
    for (const [ia, ib] of edges) { const a = byId.get(ia), b = byId.get(ib); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    for (const p of pts) {
      const r = 4 + Math.min(8, (deg.get(p.id) || 0) * 1.5);
      ctx.fillStyle = p.id === currentId ? accent : fg;
      ctx.globalAlpha = deg.get(p.id) ? 0.95 : 0.45;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.font = "12px -apple-system, sans-serif"; ctx.fillStyle = fg;
      ctx.fillText(p.title.slice(0, 28), p.x + r + 4, p.y + 4);
    }
    if (++frame < 240 && !$("graph-overlay").hidden) requestAnimationFrame(step);
  };
  step();
  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * H / r.height;
    const hit = pts.find((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < 14 * 14);
    if (hit) { $("graph-overlay").hidden = true; selectNote(hit.id); }
  };
}

// ===== IA =====
let aiMode = "generate";
function openAI(mode) {
  aiMode = mode;
  if (mode === "rewrite") {
    const n = current();
    if (!n || !n.body.trim()) { toast("La note est vide."); return; }
    $("ai-title").textContent = "Réécrire / améliorer la note";
    $("ai-prompt").value = "Améliore la clarté et la structure, corrige les fautes.";
    $("ai-replace").checked = true;
  } else {
    $("ai-title").textContent = "Générer du contenu avec l'IA";
    $("ai-prompt").value = "";
    $("ai-replace").checked = false;
  }
  $("ai-state").textContent = "";
  $("ai-overlay").hidden = false; $("ai-prompt").focus();
}
async function runAI() {
  const prompt = $("ai-prompt").value.trim();
  if (!prompt) { toast("Décrivez ce que vous voulez."); return; }
  if (!current()) newNote();
  $("ai-state").textContent = "Génération…";
  try {
    const { messages } = aiMode === "rewrite"
      ? PROMPTS["app.notes.rewrite"].build({ instruction: prompt, note: current().body, lang: replyLang() })
      : PROMPTS["app.notes.write"].build({ request: prompt, lang: replyLang() });
    // Progression en direct : le début du texte s'affiche pendant la rédaction.
    const { content, data } = await llmChat(messages, {
      rawSystem: true,
      onUpdate: (st) => {
        const txt = st.answer.trim();
        $("ai-state").textContent = st.thinking ? "Réflexion…" : `Rédaction… ${txt.split(/\s+/).filter(Boolean).length} mots`;
      },
    });
    recordOllamaUsage(data, "notes");
    const text = content.trim();
    const n = current();
    recordVersion(n, { force: true });
    if ($("ai-replace").checked) n.body = text;
    else n.body = (n.body ? n.body + "\n\n" : "") + text;
    if (!n.title) n.title = deriveTitle(text);
    n.ts = Date.now();
    persist(); selectNote(n.id);
    $("ai-overlay").hidden = true;
  } catch (e) { $("ai-state").textContent = ""; toast("Échec IA : " + (e.message || e)); }
}
function deriveTitle(text) {
  const first = text.split("\n").find((l) => l.trim()) || "Note";
  return first.replace(/^#+\s*/, "").slice(0, 50);
}

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ===== Assistant IA (boîte de prompt partagée) =====
// L'IA agit sur le carnet par outils : elle lit, crée, complète, réécrit,
// renomme, fusionne. Le texte qu'elle produit est celui qu'elle écrit
// elle-même dans l'appel d'outil — pas un second aller-retour au modèle.
const findNote = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return notes.find((n) => n.id === ref)
    || notes.find((n) => (n.title || "").toLowerCase() === r)
    || notes.find((n) => (n.title || "").toLowerCase().includes(r));
};
const noteLine = (n) => `${n.id} · « ${n.title || "Sans titre"} » (${(n.body || "").length} car., ${new Date(n.ts).toLocaleDateString()})`;

const NOTES_TOOLS = [
  tool("list_notes", "Liste les notes du carnet (identifiant, titre, taille).", { query: T.str("Filtre texte optionnel") }),
  tool("read_note", "Lit le contenu complet d'une note.", { note: T.str("Identifiant ou titre") }, ["note"]),
  tool("create_note", "Crée une note avec son contenu (Markdown accepté).",
    { title: T.str("Titre"), body: T.str("Contenu complet de la note") }, ["title", "body"]),
  tool("append_note", "Ajoute du texte à la fin d'une note existante.",
    { note: T.str("Identifiant ou titre"), text: T.str("Texte à ajouter") }, ["note", "text"]),
  tool("replace_note", "Remplace intégralement le contenu d'une note (réécriture, correction, restructuration).",
    { note: T.str("Identifiant ou titre"), body: T.str("Nouveau contenu complet") }, ["note", "body"]),
  tool("rename_note", "Change le titre d'une note.", { note: T.str("Identifiant ou titre"), title: T.str("Nouveau titre") }, ["note", "title"]),
  tool("delete_note", "Supprime une note.", { note: T.str("Identifiant ou titre") }, ["note"]),
  tool("merge_notes", "Fusionne plusieurs notes en une seule (les sources sont supprimées).",
    { notes: T.list("Identifiants ou titres des notes à fusionner"), title: T.str("Titre de la note fusionnée") }, ["notes"]),
  tool("open_note", "Ouvre une note dans l'éditeur, sous les yeux de l'utilisateur.", { note: T.str("Identifiant ou titre") }, ["note"]),
];

async function runNotesTool(name, a) {
  const need = (ref) => { const n = findNote(ref); if (!n) throw new Error(`aucune note « ${ref} ». Appelle list_notes.`); return n; };
  switch (name) {
    case "list_notes": {
      const q = String(a.query || "").toLowerCase();
      const items = notes.filter((n) => !q || (n.title + " " + n.body).toLowerCase().includes(q));
      return items.length ? items.map(noteLine).join("\n") : "Carnet vide.";
    }
    case "read_note": { const n = need(a.note); return `« ${n.title} »\n\n${n.body || "(vide)"}`; }
    case "create_note": {
      const n = { id: uid(), title: String(a.title || "Sans titre"), body: String(a.body || ""), ts: Date.now() };
      notes.unshift(n); currentId = n.id;
      return `Note créée : ${noteLine(n)}`;
    }
    case "append_note": { const n = need(a.note); recordVersion(n, { force: true }); n.body = (n.body ? n.body + "\n\n" : "") + String(a.text || ""); n.ts = Date.now(); return `Complétée : ${noteLine(n)}`; }
    case "replace_note": { const n = need(a.note); recordVersion(n, { force: true }); n.body = String(a.body || ""); n.ts = Date.now(); return `Réécrite : ${noteLine(n)}`; }
    case "rename_note": { const n = need(a.note); recordVersion(n, { force: true }); n.title = String(a.title || n.title); n.ts = Date.now(); return `Renommée : ${noteLine(n)}`; }
    case "delete_note": { const n = need(a.note); notes = notes.filter((x) => x.id !== n.id); if (currentId === n.id) currentId = notes[0]?.id || null; return `Supprimée : « ${n.title} »`; }
    case "merge_notes": {
      const src = (a.notes || []).map(need);
      if (src.length < 2) throw new Error("indique au moins deux notes à fusionner.");
      const merged = { id: uid(), title: String(a.title || src[0].title || "Fusion"),
        body: src.map((n) => `## ${n.title || "Sans titre"}\n\n${n.body || ""}`).join("\n\n"), ts: Date.now() };
      const ids = new Set(src.map((n) => n.id));
      notes = notes.filter((n) => !ids.has(n.id));
      notes.unshift(merged); currentId = merged.id;
      return `Fusionnées en ${noteLine(merged)}`;
    }
    case "open_note": { const n = need(a.note); currentId = n.id; return `Ouverte : « ${n.title} »`; }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountNotesAI() {
  mountAiPrompt(null, {
    app: "Notes",
    intro: "Tu tiens le carnet de notes de l'utilisateur : rédaction, réécriture, classement, fusion, recherche.",
    rules: "- Quand on te demande d'écrire ou de réécrire, produis TOI-MÊME le texte final et passe-le dans l'outil (create_note/replace_note) : n'écris jamais le contenu dans ta réponse.\n- Lis la note (read_note) avant de la réécrire.",
    placeholder: "Ex. : rédige un compte-rendu de la réunion d'hier, puis range mes notes…",
    suggestions: [
      { label: "Rédiger", prompt: "Crée une note : compte-rendu de réunion structuré (contexte, décisions, points d'action)." },
      { label: "Améliorer", prompt: "Réécris la note ouverte : clarté, structure, orthographe. Garde le sens." },
      { label: "Résumer", prompt: "Résume la note ouverte en 5 points, et ajoute le résumé en tête de la note." },
      { label: "Ranger", prompt: "Liste mes notes, repère les doublons ou les notes vides et propose un rangement. N'agis qu'ensuite." },
    ],
    tools: NOTES_TOOLS,
    context: () => {
      const n = current();
      return `Note ouverte : ${n ? noteLine(n) : "(aucune)"}\n${notes.length} note(s) au total :\n` +
        notes.slice(0, 25).map(noteLine).join("\n");
    },
    execute: runNotesTool,
    onApplied: () => { persist(); selectNote(currentId); },
  });
}

// ===== Interop : recevoir et envoyer =====
// Notes est une destination naturelle pour à peu près tout : on convertit
// l'objet reçu en texte (une table devient du Markdown) et on en fait une note.
// Cf. src/lib/interop.js — la recette est la même pour toute autre app.
function initInterop() {
  receive("notes", (obj) => {
    const n = {
      id: uid(),
      title: obj.title || describe(obj).slice(0, 60),
      body: toText(obj),
      ts: Date.now(),
    };
    notes.unshift(n);
    persist();
    previewOn = false;
    selectNote(n.id);
    toast(`Reçu depuis ${obj.meta?.sourceTitle || obj.meta?.sourceApp || "Lumen"}`);
  });

  $("btn-share").addEventListener("click", async () => {
    const n = current();
    if (!n) { toast("Aucune note sélectionnée."); return; }
    const obj = makeObject("text", { title: n.title || "Note", text: n.body || "", markdown: true },
      { app: "notes", title: "Notes" });
    const target = await share(obj);
    if (target === "shelf") toast("Posé sur l'étagère.");
    else if (target) toast("Envoyé.");
  });
}

// ===== Démarrage =====
async function init() {
  await store.ready({ migrate: (k) => k === KEY });
  // Note créée / complétée par l'IA pendant que l'app est ouverte : on relit.
  store.onExternalChange(() => {
    notes = load();
    if (!notes.find((n) => n.id === currentId)) currentId = notes[0]?.id || null;
    renderList();
    if (currentId) selectNote(currentId);
  });
  notes = load();
  currentId = notes[0]?.id || null;
  translatePage();
  observeTranslations();
  // L'interop ne doit jamais empêcher l'app de démarrer : sans bus, on écrit
  // quand même des notes.
  try { initInterop(); } catch (e) { console.warn("Interop indisponible :", e); }
  $("btn-new").addEventListener("click", newNote);
  $("btn-del").addEventListener("click", deleteNote);
  $("btn-preview").addEventListener("click", togglePreview);
  $("btn-split").addEventListener("click", toggleSplit);
  try { splitOn = localStorage.getItem("notesSplit") === "1"; } catch {}
  $("btn-capture").addEventListener("click", captureScreen);
  $("btn-math").addEventListener("click", () => insertAtCursor("$$\n\\frac{a}{b}\n$$"));
  $("btn-graph").addEventListener("click", openGraph);
  // Espace Création : projets et exports communs aux éditeurs. Les versions
  // restent l'historique propre de Notes (plus fin : une par séance).
  mountCreativeBar($("creative-bar"), {
    app: "notes",
    current: () => { const n = current(); return n ? { ref: n.id, title: n.title } : null; },
    serialize: () => JSON.stringify({ title: current()?.title || "", body: current()?.body || "" }),
    restore: () => {},
    openVersions: openHistory,
    exportDoc: () => ({ title: current()?.title || "Note", markdown: current()?.body || "" }),
    formats: ["md", "html", "pdf", "txt"],
    toast,
  });
  $("graph-close").addEventListener("click", () => ($("graph-overlay").hidden = true));
  $("tag-bar").addEventListener("click", (e) => { const t = e.target.closest("[data-tag]")?.dataset.tag; if (t) { tagFilter = tagFilter === t ? "" : t; renderList(); } });
  $("preview").addEventListener("click", (e) => {
    const a = e.target.closest("a.wikilink, a.tag");
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains("wikilink")) openByTitle(a.dataset.title);
    else { tagFilter = a.dataset.tag; renderList(); }
  });
  $("links-panel").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.open) selectNote(b.dataset.open);
    else if (b.dataset.create) openByTitle(b.dataset.create);
    else if (b.dataset.link) linkMention(b.dataset.link);
  });
  $("link-menu").addEventListener("mousedown", (e) => { const t = e.target.closest("[data-pick]")?.dataset.pick; if (t) { e.preventDefault(); pickLink(t); } });
  $("body").addEventListener("keydown", (e) => {
    const menu = $("link-menu");
    if (menu.hidden) return;
    const items = [...menu.querySelectorAll("button")];
    const i = items.findIndex((b) => b.classList.contains("on"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((b, j) => b.classList.toggle("on", j === next));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault(); pickLink(items[Math.max(0, i)].dataset.pick);
    } else if (e.key === "Escape") menu.hidden = true;
  });
  $("body").addEventListener("blur", () => setTimeout(() => ($("link-menu").hidden = true), 150));
  $("body").addEventListener("paste", (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
    if (file) { e.preventDefault(); insertImageFile(file); }
  });
  $("body").addEventListener("drop", (e) => {
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
    if (file) { e.preventDefault(); insertImageFile(file); }
  });
  $("btn-ai").addEventListener("click", () => openAI("generate"));
  $("btn-rewrite").addEventListener("click", () => openAI("rewrite"));
  $("btn-history")?.addEventListener("click", openHistory);
  $("hist-close").addEventListener("click", () => ($("hist-overlay").hidden = true));
  $("hist-restore").addEventListener("click", () => {
    const n = current();
    if (restoreVersion(n, histIndex)) { $("hist-overlay").hidden = true; selectNote(n.id); toast(tt("Version restaurée. L'état précédent est lui aussi archivé.")); }
  });
  $("ai-cancel").addEventListener("click", () => ($("ai-overlay").hidden = true));
  $("ai-run").addEventListener("click", runAI);
  mountMicButton($("ai-prompt"), { before: $("ai-cancel") });
  // Documents vivants, @agent, menu « / » et fichiers de la suite.
  mountNotesLiving({
    $, current, onEdit, toast,
    repaint: () => { if (previewOn || splitOn) paintPreview(); },
    showRendered: () => { if (!splitOn && !previewOn) setPreview(true); },
    flush: async () => { persist(); await store.flush(); },
  });
  $("title").addEventListener("input", onEdit);
  $("body").addEventListener("input", onEdit);
  mountLiveEditing();
  mountToolbarIcons();
  $("search").addEventListener("input", renderList);
  mountNotesAI();
  registerIntents();
  selectNote(currentId);
}

// ===== App Intents =====
// Les actions du carnet sont PROMUES à l'assistant de Lumen : déclarées dans le
// manifeste du paquet (Muse → intents), elles sont proposées au modèle même
// quand Notes est fermée — Lumen ouvre alors l'app et lui remet l'intention.
// Ce sont exactement les outils du volet IA local : une seule implémentation.
function registerIntents() {
  const api = window.lumen?.intents;
  if (!api) return;
  for (const t of NOTES_TOOLS) {
    const name = t.function.name;
    api.on(name, async (args) => {
      const out = await runNotesTool(name, args || {});
      persist();
      selectNote(currentId);
      return out;
    }).catch(() => {});
  }
}
init();

// ===== Rendu en direct =====
// La note s'affiche TOUJOURS rendue (blocs, agents, fichiers) ; un clic dans
// le rendu passe en édition à cet endroit, quitter le champ revient au rendu.
// Plus besoin de basculer « Aperçu » pour voir le résultat d'un agent.
function mountLiveEditing() {
  const body = $("body");
  const preview = $("preview");
  preview.addEventListener("click", (e) => {
    if (splitOn || !previewOn || !current()) return;
    if (e.target.closest("a, button, input, summary, iframe, select, textarea, .lv-card, .nb-file, .nb-embed")) return;
    if (getSelection()?.toString()) return; // sélection de texte : on lit
    setPreview(false);
    // Caret au plus près : le texte cliqué retrouvé dans la source.
    const hit = (e.target.textContent || "").trim().slice(0, 40);
    const at = hit ? body.value.indexOf(hit) : -1;
    const pos = at >= 0 ? at + hit.length : body.value.length;
    body.focus();
    body.setSelectionRange(pos, pos);
  });
  body.addEventListener("blur", (e) => {
    if (splitOn || !current()) return;
    // Barre d'outils, dialogues, menus @ et / : on reste en édition.
    if (e.relatedTarget?.closest?.(".ed-bar, .lv-ov, .ai-overlay, dialog")) return;
    setTimeout(() => {
      if (document.activeElement === body) return;
      if (document.querySelector(".nb-slash:not([hidden]), .lv-at-menu:not([hidden]), #link-menu:not([hidden]), .lv-ov")) return;
      if ((body.value || "").trim()) setPreview(true);
    }, 180);
  });
}

// Barre d'outils compacte : des icônes, le libellé passe en infobulle.
function mountToolbarIcons() {
  const ICONS = {
    "btn-capture": "camera", "btn-math": "∑", "btn-insert-file": "paperclip", "btn-live": "refresh-cw",
    "btn-split": "panel-left", "btn-ai": "sparkles", "btn-rewrite": "wand-sparkles", "btn-share": "upload", "btn-del": "trash-2",
  };
  if (!$("btn-ai").title) $("btn-ai").title = tt("Générer avec l'IA");
  for (const [id, name] of Object.entries(ICONS)) {
    const b = $(id);
    if (!b) continue;
    if (!b.title) b.title = b.textContent.trim();
    b.setAttribute("aria-label", b.title);
    b.classList.add("ed-ic");
    b.innerHTML = name.length === 1 ? `<span class="ed-glyph">${name}</span>` : icon(name, { size: 16 });
  }
}
