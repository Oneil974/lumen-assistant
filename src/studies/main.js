// Études — l'espace de révision de Lumen.
//
// Données (magasin d'app « studies », app-state sur disque) :
//   courses  [{ id, name, color }]
//   sources  [{ id, courseId, title, text, origin, added }]   — le cours lui-même
//   cards    [{ …fiche SM-2 (srs.js), courseId, sourceId }]
//   quizzes  [{ id, courseId, title, questions, created }]
//   results  [{ quizId, at, correct, total }]
//   exams    [{ id, courseId, title, at, chapters, reminderIds }]
//   podcasts [{ id, courseId, title, turns, style, created }]   — podcasts de révision
//   (une source importée de la bibliothèque libre porte `credit` : licence + lien)
//   stats    { streak, lastDay, today, reviewed }
// Rien n'est envoyé ailleurs que vers le modèle choisi dans Lumen.

import { autoTranslate, registerTranslations, tt } from "../apps-i18n.js";
import { createStore } from "../lib/app-state.js";
import { icon } from "../lib/icons.js";
import { markdownToHtml } from "../lib/markdown.js";
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { receive, toText, describe } from "../lib/interop.js";
import { STUDIES_EN } from "./i18n.js";
import { newCard, review, preview, revisionPlan, score20, startOfDay, isDue } from "./srs.js";
import { generateCards, generateQuiz, correctHomework, explain, isLocalModel, backendLabel } from "./ai.js";
import { extractText, COURSE_EXT } from "./extract.js";
import { mountOcrControls } from "./ocr.js";
import { writeEpisode, voicesFor, onVoicesReady, createPlayer, STYLES } from "./podcast.js";
import { PROVIDERS, search as libSearch, fetchCourse, creditLine } from "./library.js";
import { mountCalculator } from "../lib/calc-widget.js";
import { appLang } from "../apps-i18n.js";

registerTranslations(STUDIES_EN);

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const store = createStore("studies");
const COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#16b8a6", "#5e5ce6", "#d8a31f"];
const LANG = () => (tt("Aujourd'hui") === "Today" ? "en" : "fr");
const DAY = 86_400_000;

const db = {
  get: (k) => store.getJSON(k, k === "stats" ? {} : []) || (k === "stats" ? {} : []),
  set: (k, v) => store.set(k, v),
};
let view = "today";
let courseId = null;

function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3200); }
function paintIcons(root = document) { root.querySelectorAll("[data-ic]").forEach((n) => { if (!n.firstChild) n.innerHTML = icon(n.dataset.ic) || ""; }); }
const courseOf = (id) => db.get("courses").find((c) => c.id === id);
// Markdown + formules : les $…$ sont mis à l'abri AVANT le Markdown (qui
// mangerait les « _ » d'indice), rendus ensuite par KaTeX (typesetMath).
function md(src) {
  const math = [];
  const text = String(src || "")
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => { math.push([t, true]); return `\uE000${math.length - 1}\uE001`; })
    .replace(/\$([^$\n]+?)\$/g, (_, t) => { math.push([t, false]); return `\uE000${math.length - 1}\uE001`; });
  return markdownToHtml(text).replace(/\uE000(\d+)\uE001/g, (_, i) => {
    const [tex, display] = math[Number(i)];
    return `<span class="tex" data-display="${display ? 1 : 0}" data-tex="${esc(tex)}">${esc(tex)}</span>`;
  });
}
let katexMod = null;
async function typesetMath(root = document) {
  const spans = root.querySelectorAll("span.tex:not([data-done])");
  if (!spans.length) return;
  if (!katexMod) {
    katexMod = (await import("../lib/vendor/katex/katex.js")).default;
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = new URL("../lib/vendor/katex/katex.min.css", import.meta.url).href;
    document.head.appendChild(l);
  }
  for (const sp of spans) {
    sp.dataset.done = "1";
    try { sp.innerHTML = katexMod.renderToString(sp.dataset.tex, { displayMode: sp.dataset.display === "1", throwOnError: false }); } catch {}
  }
}
new MutationObserver(() => typesetMath()).observe(document.documentElement, { childList: true, subtree: true });

// ===== Barre latérale ========================================================
function renderSide() {
  const courses = db.get("courses");
  const cards = db.get("cards");
  const now = Date.now();
  $("course-list").innerHTML = courses.map((c) => {
    const due = cards.filter((k) => k.courseId === c.id && isDue(k, now)).length;
    return `<button class="course-item${c.id === courseId && view === "course" ? " is-on" : ""}" data-course="${c.id}"><span class="dot" style="background:${esc(c.color)}"></span><span class="grow">${esc(c.name)}</span>${due ? `<i class="badge">${due}</i>` : ""}</button>`;
  }).join("") || `<p class="muted">${esc(tt("Créez votre première matière."))}</p>`;
  const totalDue = cards.filter((k) => isDue(k, now)).length;
  $("due-badge").textContent = totalDue || "";
  $("due-badge").hidden = !totalDue;
  const local = isLocalModel();
  $("privacy").innerHTML = local
    ? `<span class="ok">● ${esc(tt("100 % local"))}</span><small>${esc(backendLabel())}</small>`
    : `<span class="warn">● ${esc(tt("Modèle en ligne"))}</span><small>${esc(tt("Vos cours partent vers l'API choisie dans les Réglages."))}</small>`;
  document.querySelectorAll(".nav [data-view]").forEach((b) => b.classList.toggle("is-on", b.dataset.view === view));
}

function go(v, id = null) {
  view = v;
  if (id) courseId = id;
  // Chaque vue pose ses propres gestionnaires : on n'hérite pas de la précédente.
  $("main").onclick = null;
  renderSide();
  ({ today: renderToday, courses: renderCourses, course: renderCourse, review: () => renderReview(), quizzes: renderQuizzes, podcast: renderPodcast, exams: renderExams, correct: renderCorrect, calc: renderCalc })[v]?.();
  $("calc-fab").hidden = v === "calc";
  paintIcons($("main"));
  $("main").scrollTop = 0;
}

// ===== Aujourd'hui ===========================================================
function renderToday() {
  const cards = db.get("cards");
  const now = Date.now();
  const due = cards.filter((k) => isDue(k, now));
  const exams = db.get("exams").filter((e) => e.at > now).sort((a, b) => a.at - b.at);
  const stats = db.get("stats");
  const results = db.get("results").slice(-10);
  const avg = results.length ? Math.round(results.reduce((a, r) => a + score20(r.correct, r.total), 0) / results.length * 10) / 10 : null;
  $("main").innerHTML = `
    <h1>${esc(tt("Aujourd'hui"))}</h1>
    <div class="tiles">
      <div class="tile"><b>${due.length}</b><span>${esc(tt("fiches à réviser"))}</span></div>
      <div class="tile"><b>${stats.streak || 0} 🔥</b><span>${esc(tt("jours d'affilée"))}</span></div>
      <div class="tile"><b>${cards.length}</b><span>${esc(tt("fiches au total"))}</span></div>
      <div class="tile"><b>${avg ?? "—"}</b><span>${esc(tt("moyenne des derniers quiz (/20)"))}</span></div>
    </div>
    <div class="actions">
      <button class="btn-primary" data-go="review" ${due.length ? "" : "disabled"}>${esc(tt("Réviser maintenant"))}</button>
      <button class="btn-soft" data-go="courses">${esc(tt("Ajouter un cours"))}</button>
      <button class="btn-soft" data-go="correct">${esc(tt("Faire corriger un devoir"))}</button>
    </div>
    <h2>${esc(tt("Prochains examens"))}</h2>
    ${exams.length ? `<div class="list">${exams.slice(0, 5).map((e) => {
      const days = Math.ceil((startOfDay(e.at) - startOfDay(now)) / DAY);
      const c = courseOf(e.courseId);
      return `<div class="row"><span class="dot" style="background:${esc(c?.color || "#999")}"></span><span class="grow"><b>${esc(e.title)}</b><small>${esc(c?.name || "")} · ${new Date(e.at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</small></span><span class="pill${days <= 3 ? " hot" : ""}">${days === 0 ? esc(tt("aujourd'hui")) : `J-${days}`}</span></div>`;
    }).join("")}</div>` : `<p class="muted">${esc(tt("Aucun examen prévu. Ajoutez-en un dans « Examens » : Lumen planifie vos révisions dans l'Agenda."))}</p>`}
    <h2>${esc(tt("Comment ça marche"))}</h2>
    <ol class="how">
      <li>${esc(tt("Créez une matière et ajoutez vos cours (PDF, Word, notes, pages web…)."))}</li>
      <li>${esc(tt("Générez des fiches et des quiz : le modèle les écrit à partir de VOS cours."))}</li>
      <li>${esc(tt("Révisez chaque jour : les fiches reviennent juste avant d'être oubliées."))}</li>
      <li>${esc(tt("Ajoutez vos examens : les séances de révision se placent dans l'Agenda."))}</li>
    </ol>`;
}

// ===== Matières ==============================================================
async function newCourse() {
  const name = await promptSheet({ title: tt("Nouvelle matière"), placeholder: tt("Ex. : Biologie cellulaire"), value: "" });
  if (!name?.trim()) return null;
  const courses = db.get("courses");
  const c = { id: uid("m"), name: name.trim(), color: COLORS[courses.length % COLORS.length], created: Date.now() };
  db.set("courses", [...courses, c]);
  go("course", c.id);
  return c;
}

function renderCourses() {
  const courses = db.get("courses");
  const cards = db.get("cards"), sources = db.get("sources");
  $("main").innerHTML = `
    <h1>${esc(tt("Matières"))}</h1>
    <div class="grid">${courses.map((c) => `
      <button class="card-course" data-course="${c.id}" style="--c:${esc(c.color)}">
        <b>${esc(c.name)}</b>
        <small>${sources.filter((s) => s.courseId === c.id).length} ${esc(tt("cours"))} · ${cards.filter((k) => k.courseId === c.id).length} ${esc(tt("fiches"))}</small>
      </button>`).join("")}
      <button class="card-course add" id="add-course">＋ ${esc(tt("Nouvelle matière"))}</button>
    </div>`;
  $("add-course").onclick = newCourse;
}

function renderCourse() {
  const c = courseOf(courseId);
  if (!c) { go("courses"); return; }
  const sources = db.get("sources").filter((s) => s.courseId === c.id);
  const cards = db.get("cards").filter((k) => k.courseId === c.id);
  const quizzes = db.get("quizzes").filter((q) => q.courseId === c.id);
  const due = cards.filter((k) => isDue(k)).length;
  $("main").innerHTML = `
    <div class="head"><span class="dot big" style="background:${esc(c.color)}"></span><h1 class="grow">${esc(c.name)}</h1>
      <button class="btn-soft" id="rename">${esc(tt("Renommer"))}</button><button class="btn-soft danger" id="del-course">${esc(tt("Supprimer"))}</button></div>
    <div class="actions">
      <button class="btn-primary" id="review-course" ${due ? "" : "disabled"}>${esc(tt("Réviser ({n} fiches)", { n: due }))}</button>
      <button class="btn-soft" id="gen-cards" ${sources.length ? "" : "disabled"}>✦ ${esc(tt("Générer des fiches"))}</button>
      <button class="btn-soft" id="gen-quiz" ${sources.length ? "" : "disabled"}>✦ ${esc(tt("Générer un quiz"))}</button>
      <button class="btn-soft" id="add-card">＋ ${esc(tt("Fiche manuelle"))}</button>
    </div>
    <div class="progress" id="gen-progress" hidden><i></i><span></span></div>
    <h2>${esc(tt("Cours"))} <small class="muted">${sources.length}</small></h2>
    <div class="actions">
      <button class="btn-soft" id="add-file">${esc(tt("Depuis mes fichiers…"))}</button>
      <button class="btn-soft" id="add-paste">${esc(tt("Coller du texte"))}</button>
      <button class="btn-soft" id="add-lib">${esc(tt("Bibliothèque libre…"))}</button>
    </div>
    <div class="list">${sources.map((s) => `
      <div class="row"><span data-ic="file-text"></span><span class="grow"><b>${esc(s.title)}</b><small>${Math.round(s.text.length / 1000)} k ${esc(tt("caractères"))} · ${new Date(s.added).toLocaleDateString()}</small>${s.credit ? `<small class="credit">© ${esc(creditLine(s.credit))} — <a href="${esc(s.credit.url)}" target="_blank" rel="noopener">${esc(tt("source"))}</a></small>` : ""}</span>
      <button class="btn-ico" data-srcpod="${s.id}" title="${esc(tt("Podcast de ce cours"))}">🎧</button>
      <label class="chk"><input type="checkbox" data-src="${s.id}" checked /> ${esc(tt("utiliser"))}</label>
      <button class="btn-ico" data-srcdel="${s.id}" title="${esc(tt("Retirer"))}">✕</button></div>`).join("") || `<p class="muted">${esc(tt("Ajoutez un cours : un PDF, un document Word ou PowerPoint, vos notes, ou collez du texte."))}</p>`}</div>
    <h2>${esc(tt("Quiz"))} <small class="muted">${quizzes.length}</small></h2>
    <div class="list">${quizzes.map((q) => `<div class="row"><span data-ic="circle-help"></span><span class="grow"><b>${esc(q.title)}</b><small>${q.questions.length} ${esc(tt("questions"))}${bestOf(q.id)}</small></span><button class="btn-soft" data-quiz="${q.id}">${esc(tt("Commencer"))}</button><button class="btn-ico" data-quizdel="${q.id}">✕</button></div>`).join("") || `<p class="muted">—</p>`}</div>
    <h2>${esc(tt("Fiches"))} <small class="muted">${cards.length}</small></h2>
    <div class="cards-table">${cards.slice().sort((a, b) => a.due - b.due).map((k) => `
      <div class="k"><div class="kq">${md(k.front)}</div><div class="ka">${md(k.back)}</div>
      <small class="muted">${isDue(k) ? esc(tt("à réviser")) : esc(tt("prochaine : {d}", { d: new Date(k.due).toLocaleDateString() }))}</small>
      <button class="btn-ico" data-carddel="${k.id}" title="${esc(tt("Supprimer"))}">✕</button></div>`).join("") || `<p class="muted">${esc(tt("Pas encore de fiches : générez-les à partir d'un cours."))}</p>`}</div>`;

  const selected = () => [...document.querySelectorAll("[data-src]")].filter((x) => x.checked).map((x) => sources.find((s) => s.id === x.dataset.src)).filter(Boolean);
  $("rename").onclick = async () => {
    const name = await promptSheet({ title: tt("Renommer la matière"), value: c.name });
    if (name?.trim()) { db.set("courses", db.get("courses").map((x) => (x.id === c.id ? { ...x, name: name.trim() } : x))); go("course"); }
  };
  $("del-course").onclick = async () => {
    if (!(await confirmSheet({ title: tt("Supprimer « {n} » ?", { n: c.name }), body: tt("Les cours, fiches et quiz de cette matière seront effacés."), confirm: tt("Supprimer"), cancel: tt("Annuler"), danger: true }))) return;
    for (const k of ["sources", "cards", "quizzes", "exams"]) db.set(k, db.get(k).filter((x) => x.courseId !== c.id));
    db.set("courses", db.get("courses").filter((x) => x.id !== c.id));
    go("courses");
  };
  $("review-course").onclick = () => { view = "review"; renderSide(); renderReview(c.id); };
  $("add-paste").onclick = async () => {
    const text = await promptSheet({ title: tt("Coller un cours"), multiline: true, value: "", placeholder: tt("Collez ici le texte du cours…") });
    if (!text?.trim()) return;
    addSource(c.id, text.split("\n")[0].slice(0, 60) || tt("Texte collé"), text, "paste");
  };
  $("add-file").onclick = () => pickCourseFile(c.id);
  $("add-lib").onclick = () => openLibrary(c.id);
  $("add-card").onclick = async () => {
    const front = await promptSheet({ title: tt("Question (recto)"), multiline: true });
    if (!front?.trim()) return;
    const back = await promptSheet({ title: tt("Réponse (verso)"), multiline: true });
    if (!back?.trim()) return;
    db.set("cards", [...db.get("cards"), newCard(front.trim(), back.trim(), { courseId: c.id })]);
    go("course");
  };
  $("gen-cards").onclick = () => runGeneration("cards", c, selected());
  $("gen-quiz").onclick = () => runGeneration("quiz", c, selected());
  $("main").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.srcpod) { podcastPre = { courseId: c.id, sourceIds: [b.dataset.srcpod] }; go("podcast"); return; }
    if (b.dataset.srcdel) { db.set("sources", db.get("sources").filter((s) => s.id !== b.dataset.srcdel)); go("course"); }
    if (b.dataset.carddel) { db.set("cards", db.get("cards").filter((k) => k.id !== b.dataset.carddel)); go("course"); }
    if (b.dataset.quizdel) { db.set("quizzes", db.get("quizzes").filter((q) => q.id !== b.dataset.quizdel)); go("course"); }
    if (b.dataset.quiz) startQuiz(b.dataset.quiz);
  };
}

function bestOf(quizId) {
  const r = db.get("results").filter((x) => x.quizId === quizId);
  if (!r.length) return "";
  const best = Math.max(...r.map((x) => score20(x.correct, x.total)));
  return ` · ${tt("meilleure note")} ${best}/20`;
}

function addSource(cid, title, text, origin, credit = null) {
  db.set("sources", [...db.get("sources"), { id: uid("s"), courseId: cid, title, text: String(text).slice(0, 500000), origin, added: Date.now(), ...(credit ? { credit } : {}) }]);
  toast(tt("Cours ajouté : {t}", { t: title }));
  if (view === "course") go("course");
}

/// Sélecteur de fichier de cours ; `onText(title, text, origin)` reçoit le texte extrait.
async function pickCourseFile(cid, onText = (title, text, origin) => addSource(cid, title, text, origin)) {
  let sandboxes = [];
  try { sandboxes = (await invoke("sandbox_list")) || []; } catch {}
  const files = [];
  const walk = async (sb, path, depth) => {
    let entries = [];
    try { entries = (await invoke("sandbox_read_dir", { id: sb.id, path })) || []; } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.is_dir) { if (depth < 5) await walk(sb, p, depth + 1); }
      else if (COURSE_EXT.includes(e.name.split(".").pop().toLowerCase())) files.push({ sb, path: p, name: e.name });
    }
  };
  for (const sb of sandboxes) await walk(sb, "", 0);
  const main = $("main");
  const box = document.createElement("div");
  box.className = "picker";
  box.innerHTML = `<div class="picker-card"><h3>${esc(tt("Choisir un cours"))}</h3><input class="input" id="pk-filter" placeholder="${esc(tt("Filtrer…"))}" /><details class="ocr-settings"><summary>${esc(tt("Numérisation locale (OCR)"))}</summary><p class="muted">${esc(tt("PDF scannés et images : modèle GGUF local, téléchargé depuis Hugging Face."))}</p><div class="actions"><select class="input" data-ocr-select aria-label="Modèle OCR"></select><button class="btn-soft" data-ocr-install>${esc(tt("Télécharger"))}</button></div><small data-ocr-status role="status"></small></details><div class="list" id="pk-list"></div><p id="pk-progress" role="status"></p><div class="actions"><span class="grow"></span><button class="btn-soft" id="pk-close">${esc(tt("Annuler"))}</button></div></div>`;
  main.appendChild(box);
  let reading = false;
  const controller = new AbortController();
  const controls = mountOcrControls(box, invoke, (name, callback) => (window.__TAURI__ || window.parent?.__TAURI__)?.event?.listen?.(name, callback), tt);
  const close = () => { controller.abort(); controls.dispose(); box.remove(); };
  const render = () => {
    const q = box.querySelector("#pk-filter").value.toLowerCase();
    box.querySelector("#pk-list").innerHTML = files.filter((f) => !q || f.name.toLowerCase().includes(q)).slice(0, 200).map((f, i) => `<button class="row" data-pick="${files.indexOf(f)}"><span class="grow"><b>${esc(f.name)}</b><small>${esc(f.sb.name)} · ${esc(f.path)}</small></span></button>`).join("") || `<p class="muted">${esc(tt("Aucun PDF, document ou note dans vos sandboxes."))}</p>`;
  };
  render();
  box.querySelector("#pk-filter").oninput = render;
  box.querySelector("#pk-close").onclick = close;
  box.querySelector("#pk-list").onclick = async (e) => {
    const b = e.target.closest("[data-pick]");
    if (!b || reading || controls.busy) return;
    const f = files[Number(b.dataset.pick)];
    reading = true; controls.disable();
    box.querySelector("#pk-list").hidden = true;
    box.querySelector("#pk-filter").disabled = true;
    toast(tt("Lecture de « {n} »…", { n: f.name }));
    try {
      const text = await extractText(invoke, f.sb.id, f.path, {
        signal: controller.signal,
        onProgress: (page, total, ocr) => { box.querySelector("#pk-progress").textContent = `${tt(ocr ? "Numérisation locale…" : "Lecture…")} ${page}/${total}`; },
      });
      if (controller.signal.aborted) return;
      if (!text.trim()) { toast(tt("Aucun texte lisible dans ce fichier.")); close(); return; }
      close();
      onText(f.name.replace(/\.[^.]+$/, ""), text, { sandboxId: f.sb.id, path: f.path });
    } catch (err) {
      if (err.name !== 'AbortError' && !controller.signal.aborted) toast(String(err?.message || err));
      close();
    }
  };
}

async function runGeneration(kind, course, sources) {
  if (!sources.length) { toast(tt("Cochez au moins un cours.")); return; }
  const count = Number(await promptSheet({ title: tt(kind === "cards" ? "Combien de fiches ?" : "Combien de questions ?"), value: kind === "cards" ? "20" : "10", type: "number" }));
  if (!count) return;
  const text = sources.map((s) => `# ${s.title}\n\n${s.text}`).join("\n\n");
  const bar = $("gen-progress");
  bar.hidden = false;
  const setP = (done, total) => { bar.querySelector("i").style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`; bar.querySelector("span").textContent = tt("Génération… {d}/{t}", { d: done, t: total }); };
  setP(0, 1);
  try {
    if (kind === "cards") {
      const out = await generateCards(text, { count, lang: LANG(), onProgress: setP });
      const cards = out.map((c) => newCard(c.q, c.a, { courseId: course.id, sourceId: sources[0].id }));
      db.set("cards", [...db.get("cards"), ...cards]);
      toast(tt("{n} fiches créées.", { n: cards.length }));
    } else {
      const questions = await generateQuiz(text, { count, lang: LANG(), onProgress: setP });
      if (!questions.length) throw new Error(tt("Le modèle n'a produit aucune question exploitable."));
      const q = { id: uid("q"), courseId: course.id, title: `${tt("Quiz")} — ${sources.map((s) => s.title).join(", ").slice(0, 60)}`, questions, created: Date.now() };
      db.set("quizzes", [...db.get("quizzes"), q]);
      toast(tt("Quiz de {n} questions prêt.", { n: questions.length }));
    }
    go("course");
  } catch (e) {
    bar.hidden = true;
    toast(`${tt("Échec de la génération")} : ${e?.message || e}`);
  }
}

// ===== Révision (répétition espacée) ===========================================
let session = null;
function renderReview(onlyCourse = null) {
  const now = Date.now();
  const queue = db.get("cards").filter((k) => isDue(k, now) && (!onlyCourse || k.courseId === onlyCourse)).sort((a, b) => a.due - b.due).slice(0, 60);
  session = { queue, done: 0, total: queue.length, flipped: false, onlyCourse };
  showCard();
}

function showCard() {
  const k = session.queue[0];
  if (!k) {
    $("main").innerHTML = `<div class="done"><h1>🎉 ${esc(tt("Révision terminée"))}</h1><p class="muted">${esc(session.total ? tt("{n} fiches revues. Revenez demain : les suivantes arriveront au bon moment.", { n: session.done }) : tt("Aucune fiche à réviser pour l'instant."))}</p><button class="btn-soft" data-go="today">${esc(tt("Retour"))}</button></div>`;
    renderSide();
    return;
  }
  const c = courseOf(k.courseId);
  const labels = preview(k);
  $("main").innerHTML = `
    <div class="review">
      <div class="review-top"><span class="dot" style="background:${esc(c?.color || "#999")}"></span> ${esc(c?.name || "")}<span class="grow"></span><span class="muted">${session.done + 1} / ${session.total}</span></div>
      <div class="flash${session.flipped ? " flipped" : ""}" id="flash">
        <div class="face front">${md(k.front)}</div>
        <div class="face back">${md(k.front)}<hr/>${md(k.back)}</div>
      </div>
      ${session.flipped ? `
        <div class="grades">
          <button class="g g0" data-grade="0">${esc(tt("À revoir"))}<small>${labels[0]}</small></button>
          <button class="g g1" data-grade="1">${esc(tt("Difficile"))}<small>${labels[1]}</small></button>
          <button class="g g2" data-grade="2">${esc(tt("Bien"))}<small>${labels[2]}</small></button>
          <button class="g g3" data-grade="3">${esc(tt("Facile"))}<small>${labels[3]}</small></button>
        </div>
        <button class="btn-soft" id="why">🤔 ${esc(tt("Je ne comprends pas"))}</button>
        <div class="explain" id="explain"></div>` : `<button class="btn-primary big" id="flip">${esc(tt("Voir la réponse"))} <small>(${esc(tt("Espace"))})</small></button>`}
    </div>`;
  if (!session.flipped) $("flip").onclick = flip;
  else {
    document.querySelectorAll("[data-grade]").forEach((b) => (b.onclick = () => grade(Number(b.dataset.grade))));
    $("why").onclick = async () => {
      $("explain").innerHTML = `<p class="muted">${esc(tt("Réflexion…"))}</p>`;
      try { $("explain").innerHTML = md(await explain(k.front, k.back, LANG(), (txt) => { if (txt) $("explain").innerHTML = md(txt); })); } catch (e) { $("explain").textContent = String(e?.message || e); }
    };
  }
}
function flip() { session.flipped = true; showCard(); }
function grade(g) {
  const k = session.queue.shift();
  const next = review(k, g);
  db.set("cards", db.get("cards").map((x) => (x.id === k.id ? next : x)));
  if (g === 0) session.queue.push(next); else session.done += 1;
  session.flipped = false;
  bumpStats();
  showCard();
  renderSide();
}
function bumpStats() {
  const s = db.get("stats");
  const today = startOfDay(Date.now());
  if (s.lastDay !== today) {
    s.streak = s.lastDay === today - DAY ? (s.streak || 0) + 1 : 1;
    s.lastDay = today;
    s.reviewed = 0;
  }
  s.reviewed = (s.reviewed || 0) + 1;
  db.set("stats", s);
}

// ===== Quiz ====================================================================
function renderQuizzes() {
  const quizzes = db.get("quizzes");
  $("main").innerHTML = `<h1>${esc(tt("Quiz"))}</h1>
    <div class="list">${quizzes.map((q) => { const c = courseOf(q.courseId); return `<div class="row"><span class="dot" style="background:${esc(c?.color || "#999")}"></span><span class="grow"><b>${esc(q.title)}</b><small>${esc(c?.name || "")} · ${q.questions.length} ${esc(tt("questions"))}${bestOf(q.id)}</small></span><button class="btn-soft" data-quiz="${q.id}">${esc(tt("Commencer"))}</button></div>`; }).join("") || `<p class="muted">${esc(tt("Aucun quiz. Ouvrez une matière et générez-en un à partir de vos cours."))}</p>`}</div>`;
  $("main").onclick = (e) => { const b = e.target.closest("[data-quiz]"); if (b) startQuiz(b.dataset.quiz); };
}

let quiz = null;
function startQuiz(id) {
  const q = db.get("quizzes").find((x) => x.id === id);
  if (!q) return;
  quiz = { q, i: 0, correct: 0, answered: null };
  view = "quizzes"; renderSide();
  showQuestion();
}
function showQuestion() {
  const { q, i } = quiz;
  const item = q.questions[i];
  if (!item) {
    const s = score20(quiz.correct, q.questions.length);
    db.set("results", [...db.get("results"), { quizId: q.id, at: Date.now(), correct: quiz.correct, total: q.questions.length }]);
    // Mémoire épisodique : les résultats de révision servent à l'assistant
    // (« où j'en suis en histoire ? ») et aux agents de suivi.
    try {
      const c = courseOf(q.courseId);
      __TAURI.core?.invoke?.("mem_remember", { context: "studies", kind: "episodic", text: `Études — quiz « ${q.title} »${c ? ` (${c.name})` : ""} : ${quiz.correct}/${q.questions.length}.`, tags: ["études", c?.name || ""].filter(Boolean), source: "Études" })?.catch?.(() => {});
    } catch {}
    $("main").innerHTML = `<div class="done"><h1>${s}/20</h1><p>${esc(tt("{c} bonnes réponses sur {t}.", { c: quiz.correct, t: q.questions.length }))}</p><p class="muted">${esc(s >= 16 ? tt("Excellent : ce chapitre est acquis.") : s >= 10 ? tt("Bien : relisez les explications des erreurs, puis refaites le quiz dans quelques jours.") : tt("À retravailler : révisez les fiches de ce chapitre avant de refaire le quiz."))}</p><div class="actions"><button class="btn-soft" data-quiz="${q.id}">${esc(tt("Recommencer"))}</button><button class="btn-soft" data-go="quizzes">${esc(tt("Retour"))}</button></div></div>`;
    $("main").onclick = (e) => { const b = e.target.closest("[data-quiz]"); if (b) startQuiz(b.dataset.quiz); };
    return;
  }
  const a = quiz.answered;
  $("main").innerHTML = `
    <div class="quiz">
      <div class="review-top"><b>${esc(q.title)}</b><span class="grow"></span><span class="muted">${i + 1} / ${q.questions.length} · ${quiz.correct} ✓</span></div>
      <div class="qtext">${md(item.question)}</div>
      <div class="choices">${item.choices.map((ch, j) => `<button class="choice${a == null ? "" : j === item.answer ? " right" : j === a ? " wrong" : ""}" data-ch="${j}" ${a == null ? "" : "disabled"}><b>${"ABCDE"[j]}</b> ${md(ch)}</button>`).join("")}</div>
      ${a == null ? "" : `<div class="explain ${a === item.answer ? "ok" : "ko"}"><b>${esc(a === item.answer ? tt("Bonne réponse !") : tt("Réponse attendue : {r}", { r: "ABCDE"[item.answer] }))}</b>${md(item.explanation)}</div><button class="btn-primary" id="next">${esc(tt(i + 1 < q.questions.length ? "Question suivante" : "Voir le résultat"))}</button>`}
    </div>`;
  document.querySelectorAll("[data-ch]").forEach((b) => (b.onclick = () => {
    quiz.answered = Number(b.dataset.ch);
    if (quiz.answered === item.answer) quiz.correct += 1;
    showQuestion();
  }));
  if (a != null) $("next").onclick = () => { quiz.i += 1; quiz.answered = null; showQuestion(); };
}

// ===== Bibliothèque libre (cours sous licence ouverte, crédités) ===============
function openLibrary(cid) {
  const box = document.createElement("div");
  box.className = "picker";
  box.innerHTML = `<div class="picker-card"><h3>${esc(tt("Bibliothèque libre"))}</h3>
    <p class="muted">${esc(tt("Cours et manuels sous licence ouverte. La licence et les auteurs sont conservés avec le cours et affichés sous son titre."))}</p>
    <div class="actions"><select class="input" id="lb-prov" style="width:auto">${PROVIDERS.map((p) => `<option value="${p.id}">${esc(p.label)} — ${esc(tt(p.license))}</option>`).join("")}</select>
    <input class="input grow" id="lb-q" placeholder="${esc(tt("Rechercher un cours (ex. thermodynamique)"))}" /><button class="btn-primary" id="lb-go">${esc(tt("Chercher"))}</button></div>
    <div class="list" id="lb-list"></div><div class="actions"><span class="grow"></span><button class="btn-soft" id="lb-close">${esc(tt("Fermer"))}</button></div></div>`;
  $("main").appendChild(box);
  let hits = [];
  const q = box.querySelector("#lb-q");
  const list = box.querySelector("#lb-list");
  const run = async () => {
    if (!q.value.trim()) return;
    list.innerHTML = `<p class="muted">${esc(tt("Recherche…"))}</p>`;
    try {
      hits = await libSearch(box.querySelector("#lb-prov").value, q.value.trim(), LANG());
      list.innerHTML = hits.map((h, i) => `<button class="row" data-hit="${i}"><span class="grow"><b>${esc(h.title)}</b><small>${esc(h.snippet)}</small></span></button>`).join("") || `<p class="muted">${esc(tt("Aucun résultat."))}</p>`;
    } catch (e) { list.innerHTML = `<p class="muted">${esc(String(e?.message || e))}</p>`; }
  };
  box.querySelector("#lb-go").onclick = run;
  q.onkeydown = (e) => { if (e.key === "Enter") run(); };
  box.querySelector("#lb-close").onclick = () => box.remove();
  list.onclick = async (e) => {
    const b = e.target.closest("[data-hit]");
    if (!b) return;
    b.disabled = true;
    try {
      const r = await fetchCourse(hits[Number(b.dataset.hit)], LANG());
      box.remove();
      addSource(cid, r.title, r.text, "library", r.credit);
    } catch (err) { b.disabled = false; toast(String(err?.message || err)); }
  };
  setTimeout(() => q.focus(), 30);
}

// ===== Podcast de révision =====================================================
let podcastPre = null;       // pré-sélection venue du bouton 🎧 d'un cours
let podcastCur = null;       // épisode ouvert
const player = createPlayer({
  onTurn: (i) => document.querySelectorAll(".pturn").forEach((n) => { const on = Number(n.dataset.t) === i; n.classList.toggle("is-on", on); if (on) n.scrollIntoView({ block: "nearest", behavior: "smooth" }); }),
  onState: (on) => { const b = $("p-play"); if (b) b.textContent = on ? `⏸ ${tt("Pause")}` : `▶ ${tt("Écouter")}`; },
  getVoice: (sp) => { const sel = $(sp ? "p-vb" : "p-va"); return voicesFor(LANG()).find((v) => v.name === sel?.value) || null; },
  getRate: () => Number($("p-rate")?.value) || 1,
});

function renderPodcast() {
  player.stop();
  const courses = db.get("courses");
  const pre = podcastPre; podcastPre = null;
  const cid = pre?.courseId || courseId || courses[0]?.id;
  const eps = db.get("podcasts").slice().sort((a, b) => b.created - a.created);
  $("main").innerHTML = `
    <h1>${esc(tt("Podcast de révision"))}</h1>
    <p class="muted">${esc(tt("Vos cours deviennent une discussion à deux voix, à écouter dans les transports. Le script est écrit à partir de VOS cours."))}</p>
    ${courses.length ? `<div class="pform">
      <select class="input" id="p-course">${courses.map((c) => `<option value="${c.id}" ${c.id === cid ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <select class="input" id="p-style">${Object.keys(STYLES).map((k) => `<option value="${k}">${esc(tt({ lesson: "Leçon (prof ↔ élève)", revision: "Révision à deux", quiz: "Quiz audio" }[k]))}</option>`).join("")}</select>
      <select class="input" id="p-len"><option value="short">${esc(tt("Court (~3 min)"))}</option><option value="medium" selected>${esc(tt("Moyen (~6 min)"))}</option><option value="long">${esc(tt("Long (~10 min)"))}</option></select>
      <div class="wide" id="p-srcs"></div>
      <button class="btn-primary" id="p-gen">✦ ${esc(tt("Générer le podcast"))}</button>
    </div>` : `<p class="muted">${esc(tt("Créez d'abord une matière."))}</p>`}
    <div class="progress" id="p-progress" hidden><i style="width:60%"></i><span>${esc(tt("Écriture du script…"))}</span></div>
    <div id="p-player"></div>
    <h2>${esc(tt("Épisodes"))} <small class="muted">${eps.length}</small></h2>
    <div class="list">${eps.map((e) => `<div class="row"><span>🎧</span><span class="grow"><b>${esc(e.title)}</b><small>${esc(courseOf(e.courseId)?.name || "")} · ${e.turns.length} ${esc(tt("répliques"))} · ${new Date(e.created).toLocaleDateString()}</small></span><button class="btn-soft" data-ep="${e.id}">${esc(tt("Ouvrir"))}</button><button class="btn-ico" data-epdel="${e.id}">✕</button></div>`).join("") || `<p class="muted">—</p>`}</div>`;
  const paintSources = () => {
    const id = $("p-course")?.value;
    const srcs = db.get("sources").filter((s) => s.courseId === id);
    $("p-srcs").innerHTML = srcs.map((s) => `<label class="chk"><input type="checkbox" data-psrc="${s.id}" ${!pre?.sourceIds || pre.sourceIds.includes(s.id) ? "checked" : ""}/> ${esc(s.title)}</label>`).join(" ") || `<span class="muted">${esc(tt("Cette matière n'a pas encore de cours."))}</span>`;
  };
  if (courses.length) {
    paintSources();
    $("p-course").onchange = () => { pre && (pre.sourceIds = null); paintSources(); };
    $("p-gen").onclick = async () => {
      const ids = [...document.querySelectorAll("[data-psrc]")].filter((x) => x.checked).map((x) => x.dataset.psrc);
      const srcs = db.get("sources").filter((s) => ids.includes(s.id));
      if (!srcs.length) { toast(tt("Cochez au moins un cours.")); return; }
      $("p-progress").hidden = false; $("p-gen").disabled = true;
      try {
        const lang = LANG();
        const ep = await writeEpisode(srcs.map((s) => `# ${s.title}\n\n${s.text}`).join("\n\n"), {
          style: $("p-style").value, length: $("p-len").value, lang, names: ["Claire", "Hugo"] });
        const rec = { id: uid("p"), courseId: $("p-course").value, style: $("p-style").value, ...ep, created: Date.now(),
          credits: srcs.filter((s) => s.credit).map((s) => s.credit) };
        db.set("podcasts", [...db.get("podcasts"), rec]);
        podcastCur = rec.id;
        renderPodcast();
        player.play();
      } catch (e) { toast(`${tt("Échec de la génération")} : ${e?.message || e}`); $("p-progress").hidden = true; $("p-gen").disabled = false; }
    };
  }
  $("main").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.ep) { podcastCur = b.dataset.ep; renderPodcast(); }
    if (b.dataset.epdel) { if (podcastCur === b.dataset.epdel) podcastCur = null; db.set("podcasts", db.get("podcasts").filter((x) => x.id !== b.dataset.epdel)); renderPodcast(); }
  };
  const ep = db.get("podcasts").find((x) => x.id === podcastCur);
  if (ep) mountEpisode(ep);
}

function mountEpisode(ep) {
  const names = ["Claire", "Hugo"];
  $("p-player").innerHTML = `<div class="pplayer">
    <div class="actions"><b class="grow">${esc(ep.title)}</b>
      <button class="btn-primary" id="p-play">▶ ${esc(tt("Écouter"))}</button><button class="btn-soft" id="p-stop">⏹</button></div>
    <div class="actions"><label class="chk">${names[0]} <select class="input" id="p-va" style="width:auto"></select></label>
      <label class="chk">${names[1]} <select class="input" id="p-vb" style="width:auto"></select></label>
      <label class="chk">${esc(tt("Vitesse"))} <input type="range" id="p-rate" min="0.7" max="1.6" step="0.05" value="1.05" /></label></div>
    <div class="pturns">${ep.turns.map((t, i) => `<div class="pturn s${t.speaker}" data-t="${i}"><b>${names[t.speaker]}</b> ${esc(t.text)}</div>`).join("")}</div>
    ${(ep.credits || []).length ? `<small class="credit">${esc(tt("D'après"))} : ${ep.credits.map((c) => esc(creditLine(c))).join(" ; ")}</small>` : ""}
  </div>`;
  const fill = () => {
    const vs = voicesFor(LANG());
    for (const [id, idx] of [["p-va", 0], ["p-vb", Math.min(1, vs.length - 1)]]) {
      const sel = $(id); if (!sel) continue;
      const prev = sel.value;
      sel.innerHTML = vs.map((v) => `<option>${esc(v.name)}</option>`).join("");
      sel.value = prev && vs.some((v) => v.name === prev) ? prev : vs[idx]?.name || "";
    }
  };
  fill(); onVoicesReady(fill);
  player.load(ep);
  $("p-play").onclick = () => (player.playing ? player.pause() : player.play());
  $("p-stop").onclick = () => player.stop();
  document.querySelectorAll(".pturn").forEach((n) => (n.onclick = () => player.play(Number(n.dataset.t))));
}

// ===== Examens =================================================================
function renderExams() {
  const courses = db.get("courses");
  const exams = db.get("exams").sort((a, b) => a.at - b.at);
  const now = Date.now();
  $("main").innerHTML = `
    <h1>${esc(tt("Examens"))}</h1>
    <form class="exam-form" id="exam-form">
      <select class="input" id="ex-course" required>${courses.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <input class="input" id="ex-title" placeholder="${esc(tt("Intitulé (ex. Partiel de mi-semestre)"))}" required />
      <input class="input" id="ex-date" type="date" required />
      <input class="input" id="ex-time" type="time" value="09:00" />
      <input class="input wide" id="ex-chapters" placeholder="${esc(tt("Chapitres au programme, séparés par des virgules"))}" />
      <label class="chk"><input type="checkbox" id="ex-cal" checked /> ${esc(tt("Placer les séances de révision dans l'Agenda"))}</label>
      <button class="btn-primary">${esc(tt("Ajouter l'examen"))}</button>
    </form>
    ${courses.length ? "" : `<p class="muted">${esc(tt("Créez d'abord une matière."))}</p>`}
    <div class="list">${exams.map((e) => {
      const c = courseOf(e.courseId);
      const plan = revisionPlan(e.at, e.chapters, now);
      const days = Math.ceil((startOfDay(e.at) - startOfDay(now)) / DAY);
      return `<div class="exam${e.at < now ? " past" : ""}">
        <div class="row"><span class="dot" style="background:${esc(c?.color || "#999")}"></span><span class="grow"><b>${esc(e.title)}</b><small>${esc(c?.name || "")} · ${new Date(e.at).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}</small></span>
        <span class="pill${days <= 3 && days >= 0 ? " hot" : ""}">${days < 0 ? esc(tt("passé")) : days === 0 ? esc(tt("aujourd'hui")) : `J-${days}`}</span><button class="btn-ico" data-exdel="${e.id}">✕</button></div>
        ${plan.length && e.at > now ? `<div class="plan">${plan.map((p) => `<span class="step ${p.kind}">${new Date(p.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${esc(tt(p.chapter))}</span>`).join("")}</div>` : ""}
      </div>`;
    }).join("") || `<p class="muted">${esc(tt("Aucun examen."))}</p>`}</div>`;
  $("exam-form").onsubmit = async (e) => {
    e.preventDefault();
    const at = new Date(`${$("ex-date").value}T${$("ex-time").value || "09:00"}`).getTime();
    if (!at || Number.isNaN(at)) return;
    const exam = { id: uid("e"), courseId: $("ex-course").value, title: $("ex-title").value.trim(), at, chapters: $("ex-chapters").value.split(",").map((s) => s.trim()).filter(Boolean), reminderIds: [] };
    if ($("ex-cal").checked) {
      try { exam.reminderIds = await addToAgenda(exam); toast(tt("Examen et {n} séance(s) de révision ajoutés à l'Agenda.", { n: exam.reminderIds.length - 1 })); }
      catch (err) { toast(`${tt("Agenda indisponible")} : ${err?.message || err}`); }
    }
    db.set("exams", [...db.get("exams"), exam]);
    renderExams();
  };
  $("main").onclick = async (e) => {
    const b = e.target.closest("[data-exdel]");
    if (!b) return;
    const ex = db.get("exams").find((x) => x.id === b.dataset.exdel);
    if (ex?.reminderIds?.length) await removeFromAgenda(ex.reminderIds).catch(() => {});
    db.set("exams", db.get("exams").filter((x) => x.id !== b.dataset.exdel));
    renderExams();
  };
}

/** Examen + séances de révision → rappels de l'Agenda (catégories « examen » et « révision »). */
async function addToAgenda(exam) {
  const c = courseOf(exam.courseId);
  const raw = await invoke("reminders_load");
  const list = raw ? JSON.parse(raw) : [];
  const ids = [];
  const mk = (title, at, category, duration, note) => {
    const id = `rem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    ids.push(id);
    list.push({ id, title, note, due_at: at, recur: "none", done: false, fired: false, source: "ai", created_at: Date.now(), category, duration_min: duration, project: c?.name });
  };
  mk(`${exam.title}${c ? ` — ${c.name}` : ""}`, exam.at, "examen", 120, tt("Examen ajouté depuis Études."));
  for (const p of revisionPlan(exam.at, exam.chapters)) {
    const what = p.kind === "mock" ? tt("Examen blanc") : p.kind === "learn" ? tt("Apprendre : {c}", { c: tt(p.chapter) }) : tt("Réviser : {c}", { c: tt(p.chapter) });
    mk(`${what} (${c?.name || exam.title})`, p.at, "revision", p.kind === "mock" ? 90 : 45, tt("Séance planifiée par Études avant « {e} ». Fiches et quiz de la matière dans l'app Études.", { e: exam.title }));
  }
  await invoke("reminders_save", { data: JSON.stringify(list) });
  return ids;
}
async function removeFromAgenda(ids) {
  const raw = await invoke("reminders_load");
  const list = (raw ? JSON.parse(raw) : []).filter((r) => !ids.includes(r.id));
  await invoke("reminders_save", { data: JSON.stringify(list) });
}

// ===== Correction de devoir ======================================================
function renderCorrect() {
  $("main").innerHTML = `
    <h1>${esc(tt("Correction expliquée"))}</h1>
    <p class="muted">${esc(tt("Collez votre devoir (ou importez-le) : chaque erreur est citée, expliquée, puis corrigée. En mode « indices », Lumen vous met sur la voie sans donner la réponse."))}</p>
    <div class="form">
      <input class="input" id="c-subject" placeholder="${esc(tt("Matière (ex. philosophie, maths, anglais)"))}" />
      <textarea class="input" id="c-statement" rows="3" placeholder="${esc(tt("Énoncé ou consigne (facultatif, mais utile pour noter)"))}"></textarea>
      <textarea class="input" id="c-work" rows="12" placeholder="${esc(tt("Votre travail…"))}"></textarea>
      <div class="actions">
        <button class="btn-soft" id="c-import">${esc(tt("Importer depuis mes fichiers…"))}</button>
        <label class="chk"><input type="checkbox" id="c-hints" /> ${esc(tt("Mode indices (sans donner la correction)"))}</label>
        <span class="grow"></span>
        <button class="btn-primary" id="c-run">${esc(tt("Corriger"))}</button>
      </div>
    </div>
    <div id="c-out"></div>`;
  $("c-import").onclick = () => pickCourseFile(null, (_title, text) => { $("c-work").value = text; });
  $("c-run").onclick = async () => {
    const work = $("c-work").value.trim();
    if (!work) { toast(tt("Collez d'abord votre travail.")); return; }
    const out = $("c-out");
    out.innerHTML = `<p class="muted">${esc(tt("Correction en cours… (quelques dizaines de secondes avec un modèle local)"))}</p>`;
    try {
      const r = await correctHomework({ subject: $("c-subject").value, statement: $("c-statement").value, work, hintsOnly: $("c-hints").checked, lang: LANG() });
      out.innerHTML = `
        <div class="verdict"><b class="grade">${esc(r.grade || "")}</b><div>${md(r.summary)}</div></div>
        ${(r.points || []).map((p, i) => `<div class="point"><div class="pn">${i + 1}</div><div class="grow">
          ${p.excerpt ? `<blockquote>${esc(p.excerpt)}</blockquote>` : ""}
          <b>${esc(p.problem)}</b>${md(p.explanation)}
          ${p.fix ? `<div class="fix"><span>${esc(tt($("c-hints").checked ? "Indice" : "Correction"))}</span>${md(p.fix)}</div>` : ""}
        </div></div>`).join("") || `<p>${esc(tt("Aucune erreur relevée."))}</p>`}
        ${(r.advice || []).length ? `<h2>${esc(tt("Pour progresser"))}</h2><ul>${r.advice.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}`;
    } catch (e) { out.innerHTML = `<p class="muted">${esc(String(e?.message || e))}</p>`; }
  };
}

// ===== Calculatrice ==========================================================
// Même moteur que l'app Calculatrice et que l'outil `calculate` de l'IA :
// l'historique est partagé avec le panneau d'appoint.
function renderCalc() {
  $("main").innerHTML = `<h1>${esc(tt("Calculatrice"))}</h1><div class="calc-host"></div>`;
  $("calc-drawer").hidden = true;
  mountCalculator($("main").querySelector(".calc-host"), { lang: appLang(), storageKey: "studiesCalc" }).focus();
}
function toggleCalcDrawer() {
  const d = $("calc-drawer");
  d.hidden = !d.hidden;
  if (!d.hidden) mountCalculator(d, { lang: appLang(), compact: true, storageKey: "studiesCalc" }).focus();
}

// ===== Démarrage ===================================================================
async function init() {
  paintIcons();
  await store.ready();
  document.addEventListener("click", (e) => {
    const nav = e.target.closest(".nav [data-view]");
    if (nav) { go(nav.dataset.view); return; }
    const g = e.target.closest("[data-go]");
    if (g) { go(g.dataset.go); return; }
    const c = e.target.closest("[data-course]");
    if (c) go("course", c.dataset.course);
  });
  $("btn-new-course").onclick = newCourse;
  $("calc-fab").onclick = toggleCalcDrawer;
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select") || !session || view !== "review") return;
    if (e.code === "Space" && !session.flipped) { e.preventDefault(); flip(); }
    else if (session.flipped && ["1", "2", "3", "4"].includes(e.key)) grade(Number(e.key) - 1);
  });
  // Un cours envoyé par une autre app (PDF, Navigateur, Notes, explorateur).
  receive("studies", async (obj) => {
    let text = "";
    let title = obj.title || describe(obj).slice(0, 60);
    if (obj.kind === "file" && obj.path) {
      try { text = await extractText(invoke, obj.sandboxId, obj.path); title = obj.path.split("/").pop().replace(/\.[^.]+$/, ""); } catch (e) { toast(String(e?.message || e)); return; }
    } else text = toText(obj);
    if (!text.trim()) return;
    let cid = courseId || db.get("courses")[0]?.id;
    if (!cid) { const c = { id: uid("m"), name: tt("Mes cours"), color: COLORS[0], created: Date.now() }; db.set("courses", [c]); cid = c.id; }
    addSource(cid, title, text, "interop");
    go("course", cid);
    toast(tt("Cours reçu : générez maintenant fiches ou quiz."));
  });
  registerIntents();
  go(db.get("cards").some((k) => isDue(k)) ? "today" : db.get("courses").length ? "today" : "courses");
  autoTranslate({ observe: true });
}

// ===== App Intents : l'assistant de Lumen peut piloter Études =====================
function registerIntents() {
  const api = window.lumen?.intents;
  if (!api) return;
  api.on("studies_due", async () => {
    const due = db.get("cards").filter((k) => isDue(k));
    const by = {};
    for (const k of due) by[courseOf(k.courseId)?.name || "?"] = (by[courseOf(k.courseId)?.name || "?"] || 0) + 1;
    return due.length ? `${due.length} fiches à réviser : ${Object.entries(by).map(([n, c]) => `${n} (${c})`).join(", ")}.` : "Aucune fiche à réviser aujourd'hui.";
  }).catch(() => {});
  api.on("studies_add_course", async ({ course, title, text }) => {
    let c = db.get("courses").find((x) => x.name.toLowerCase() === String(course || "").toLowerCase());
    if (!c) { c = { id: uid("m"), name: String(course || tt("Mes cours")), color: COLORS[db.get("courses").length % COLORS.length], created: Date.now() }; db.set("courses", [...db.get("courses"), c]); }
    addSource(c.id, String(title || tt("Cours")), String(text || ""), "assistant");
    return `Cours « ${title} » ajouté à ${c.name}.`;
  }).catch(() => {});
  api.on("studies_exams", async () => {
    const ex = db.get("exams").filter((e) => e.at > Date.now()).sort((a, b) => a.at - b.at);
    return ex.length ? ex.map((e) => `${e.title} (${courseOf(e.courseId)?.name || ""}) le ${new Date(e.at).toLocaleString()}`).join("\n") : "Aucun examen à venir.";
  }).catch(() => {});
}

init();
