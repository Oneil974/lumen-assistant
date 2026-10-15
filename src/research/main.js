import { autoTranslate, tt } from "../apps-i18n.js";
// Recherche profonde — agent multi-étapes 100 % local. (1) l'IA décompose la
// question en sous-requêtes ; (2) chacune interroge la base RAG (rag_search) ;
// (3) on agrège/dédoublonne les passages ; (4) l'IA rédige un rapport sourcé avec
// citations [n] reliées aux passages réels. Tout passe par llmChat + rag_search.
import { llmChat } from "../llm.js";
import * as tablesDb from "../tables/client.js";
import { PROMPTS } from "./prompts.js";
import { replyLang } from "../lib/prompt-lang.js";
import { mdToHtml } from "./markdown.js";
import { receive, toText } from "../lib/interop.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const $ = (id) => document.getElementById(id);

let running = false;
// Dernier rapport rendu, conservé pour l'export Markdown (corps + annexes).
let lastReport = null; // { question, md, sources }
// Dernier résultat de requête sur la base de données (si une base a été utilisée).
let lastDbResult = null; // { sql, columns, rows }
let currentTablesBaseId = "";

async function checkKb() {
  if (!invoke) { $("kb-status").textContent = tt("Hors application"); return; }
  try {
    const st = await invoke("rag_status");
    const n = st?.documents ?? st?.docs ?? st?.count ?? 0;
    $("kb-status").textContent = n ? tt("{n} document(s) indexé(s)", { n }) : tt("Base vide — ajoutez des documents via Connaissances");
  } catch { $("kb-status").textContent = tt("Base de connaissances indisponible"); }
}

function step(text, done = false) {
  const li = document.createElement("li");
  li.innerHTML = text + (done ? "" : ` <span class="spin-dot"></span>`);
  if (done) li.classList.add("done");
  $("steps-list").appendChild(li);
  return li;
}
function finishStep(li, text) { li.classList.add("done"); li.innerHTML = text; }

async function run(question) {
  if (running) return;
  if (!invoke) {
    $("intro").hidden = true;
    $("report").hidden = false;
    $("report").innerHTML = `<p class="empty-note">${tt("Backend indisponible : ouvrez cette app depuis Lumen Desktop (le bureau), pas dans un navigateur isolé.")}</p>`;
    return;
  }
  running = true; $("ask-go").disabled = true;
  $("intro").hidden = true;
  $("steps").hidden = false; $("steps-list").innerHTML = "";
  $("report").hidden = true; $("report").innerHTML = "";
  $("sources").hidden = true; $("sources-list").innerHTML = "";
  $("export-btn").hidden = true; lastReport = null;
  $("db-result").hidden = true; $("db-result-table").innerHTML = ""; $("db-result-sql").textContent = ""; lastDbResult = null;

  try {
    const sourceMode = $("source-mode").value;
    const useDocuments = sourceMode === "documents" || sourceMode === "documents-db";
    const useDatabase = sourceMode === "documents-db" || sourceMode === "db";
    const baseId = $("research-base").value;
    const tableIds = selectedTableIds();

    if (useDatabase && !baseId) {
      $("report").hidden = false;
      $("report").innerHTML = `<p class="empty-note">${tt("Choisissez une base de données, ou repassez les sources sur Documents uniquement.")}</p>`;
      return;
    }

    // 1) Décomposition. La question TELLE QUELLE reste le premier angle : les
    // sous-requêtes sont des reformulations produites par le modèle, et elles
    // perdent souvent les mots exacts du document — or c'est précisément sur
    // ces mots-là que la recherche par mot-clé est imbattable.
    let subs = [question];
    if (useDocuments) {
      let s = step(tt("Décomposition de la question en angles de recherche"));
      const extra = (await decompose(question)).filter((q) => q.trim() && q.trim() !== question.trim());
      subs = [question, ...extra];
      finishStep(s, tt("Décomposé en {n} angle(s) de recherche", { n: `<b>${subs.length}</b>` }));
    }

    // 2) Recherche RAG par angle
    const sources = []; // {title, doc_id, text}
    const seen = new Set();
    if (useDocuments) {
      for (const sub of subs) {
        const li = step(tt("Recherche documents : « {query} »", { query: esc(sub) }));
        let hits = [];
        try { hits = await invoke("rag_search", { query: sub, k: 8 }); } catch {}
        let added = 0;
        for (const h of hits || []) {
          const key = (h.doc_id || "") + "|" + (h.text || "").slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);
          // Le score de pertinence suit le passage jusqu'au rapport : un lecteur
          // doit pouvoir juger sur quoi repose chaque citation.
          sources.push({
            title: h.title || "Document",
            doc_id: h.doc_id,
            text: h.text || "",
            score: typeof h.score === "number" ? h.score : null,
          });
          added++;
        }
        finishStep(li, tt("Documents : « {query} » → {n} passage(s)", { query: esc(sub), n: `<b>${added}</b>` }));
      }
    }

    // 2b) Base de données optionnelle : l'agent NL-interroge la base choisie et
    // replie les lignes trouvées dans les sources (citées + exportées en annexe).
    if (useDatabase && baseId && tablesDb.hasBackend) {
      const li = step(tt("Interrogation de la base de données"));
      try {
        const { sql, columns, rows } = await tablesDb.askAi(baseId, question, tableIds);
        lastDbResult = { sql, columns, rows };
        let added = 0;
        for (const r of rows.slice(0, 20)) {
          const text = columns.map((c, i) => `${c}: ${r[i] == null ? "" : r[i]}`).join(" · ");
          sources.push({ title: "Base de données", doc_id: sql, text });
          added++;
        }
        finishStep(li, tt("Base de données → {n} ligne(s)", { n: `<b>${added}</b>` }));
      } catch (e) {
        finishStep(li, `Base de données : ${esc(e?.message || e)}`);
      }
    }

    if (!sources.length) {
      renderDbResult();
      $("report").hidden = false;
      const hasDbResult = lastDbResult && lastDbResult.columns?.length;
      $("report").innerHTML = hasDbResult
        ? `<p class="empty-note">${tt("La requête sur la base a été exécutée, mais aucune source exploitable n'a été trouvée pour rédiger un rapport.")}</p>`
        : `<p class="empty-note">${tt("Aucune source exploitable trouvée avec le périmètre choisi.")}</p>`;
      return;
    }

    // 3) Synthèse sourcée. On trie par pertinence et on ne garde que ce qui
    // tient VRAIMENT dans le contexte : la version précédente tronquait le
    // contexte à l'aveugle tout en affichant et numérotant tous les passages,
    // si bien que le modèle pouvait se voir réclamer une citation [12] dont le
    // texte avait été coupé avant de lui parvenir.
    const kept = rankAndFit(sources);
    const li = step(tt("Rédaction du rapport sourcé"));
    // Le rapport s'affiche au fil de la rédaction ; les citations deviennent
    // cliquables au rendu final.
    const report = await synthesize(question, kept, (txt) => {
      if (!txt) return;
      $("report").hidden = false;
      $("report").innerHTML = mdToHtml(txt);
    });
    finishStep(li, tt("Rapport rédigé ✓"));

    lastReport = { question, md: report, sources: kept };
    renderReport(report, kept);
    renderDbResult();
    renderSources(kept);
    $("export-btn").hidden = false;
  } catch (e) {
    $("report").hidden = false;
    $("report").innerHTML = `<p class="empty-note">${tt("L'agent n'a pas pu aboutir :")} ${esc(e?.message || e)}.<br>${tt("Vérifiez le moteur IA (Ollama / clé API) et la base de connaissances.")}</p>`;
  } finally {
    running = false; $("ask-go").disabled = false;
  }
}

async function decompose(question) {
  const { messages, opts } = PROMPTS["app.research.subqueries"].build({ question, lang: replyLang() });
  try {
    const { content } = await llmChat(messages, { ...opts, rawSystem: true });
    const j = JSON.parse(content);
    const arr = Array.isArray(j.subqueries) ? j.subqueries.filter(Boolean).slice(0, 4) : [];
    return arr.length ? arr : [question];
  } catch { return [question]; }
}

/// Budget de contexte des passages, en caractères. Généreux mais borné : au
/// delà, un petit modèle local perd le fil et cite de travers.
const CTX_BUDGET = 12000;

/// Trie les passages par pertinence décroissante et ne garde que ceux qui
/// tiennent dans le budget. Les lignes de base de données (sans score) restent
/// en tête : elles répondent à une requête exacte, pas à une similarité.
function rankAndFit(sources) {
  const db = sources.filter((s) => s.score == null);
  const docs = sources.filter((s) => s.score != null).sort((a, b) => b.score - a.score);
  const out = [];
  let used = 0;
  for (const s of [...db, ...docs]) {
    const cost = (s.text || "").length + 40;
    if (out.length && used + cost > CTX_BUDGET) continue;
    out.push(s);
    used += cost;
  }
  return out;
}

async function synthesize(question, sources, onDelta) {
  const passages = sources.map((s, i) => `[${i + 1}] (${s.title}) ${s.text}`).join("\n\n");
  const { messages } = PROMPTS["app.research.analyst"].build({ question, passages, lang: replyLang() });
  const { content } = await llmChat(messages, { rawSystem: true, ...(onDelta ? { onDelta } : {}) });
  return content || "";
}

// --- Rendu Markdown minimal + citations cliquables ---
function renderReport(md, sources) {
  $("report").hidden = false;
  $("report").innerHTML = mdToHtml(md);
  $("report").querySelectorAll(".cite").forEach((c) => {
    c.addEventListener("click", () => openCiteModal(parseInt(c.dataset.n, 10)));
  });
}

// Affiche le résultat de la requête base de données sous forme de tableau.
function renderDbResult() {
  if (!lastDbResult || !lastDbResult.columns?.length) return;
  const { sql, columns, rows } = lastDbResult;
  $("db-result").hidden = false;
  $("db-result-sql").textContent = sql || "";
  const wrap = $("db-result-table");
  if (!rows.length) { wrap.innerHTML = `<p class="empty-note">${tt("Aucune ligne.")}</p>`; return; }
  const head = "<tr>" + columns.map((c) => `<th>${esc(c)}</th>`).join("") + "</tr>";
  const body = rows.slice(0, 200)
    .map((r) => "<tr>" + columns.map((_, i) => `<td>${esc(r?.[i] == null ? "" : String(r[i]))}</td>`).join("") + "</tr>")
    .join("");
  const more = rows.length > 200 ? `<p class="db-more">${tt("… {n} ligne(s) supplémentaire(s)", { n: rows.length - 200 })}</p>` : "";
  wrap.innerHTML = `<table class="db-table"><thead>${head}</thead><tbody>${body}</tbody></table>${more}`;
}

function renderSources(sources) {
  $("sources").hidden = false;
  const ol = $("sources-list"); ol.innerHTML = "";
  sources.forEach((s, i) => {
    const li = document.createElement("li");
    li.id = "src-" + (i + 1);
    const pct = typeof s.score === "number" ? `<span class="src-score">${Math.round(s.score * 100)} %</span>` : "";
    li.innerHTML = `<div class="src-title">${esc(s.title)}${pct}</div><div class="src-snippet">${esc(s.text)}</div>`;
    ol.appendChild(li);
  });
}

// --- Modal : citation cliquée → affiche la source complète sans quitter le rapport ---
function openModal(title, bodyEl) {
  $("modal-title").textContent = title;
  const body = $("modal-body");
  body.innerHTML = "";
  body.appendChild(bodyEl);
  $("modal").hidden = false;
}
let modalResolve = null; // résolveur en attente (sélecteur de sandbox)
function closeModal() {
  $("modal").hidden = true; $("modal-body").innerHTML = "";
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(null); }
}

function openCiteModal(n) {
  const s = lastReport?.sources?.[n - 1];
  if (!s) return;
  const wrap = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "modal-src-meta";
  meta.textContent = `Source [${n}]`;
  const text = document.createElement("div");
  text.textContent = s.text || tt("(passage vide)");
  wrap.append(meta, text);
  openModal(s.title || tt("Source"), wrap);
}

// --- Export Markdown vers une sandbox : rapport + sources en annexes ---
function slugify(s) {
  return String(s || "rapport").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "rapport";
}
function buildMarkdown({ question, md, sources }) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`# ${tt("Recherche profonde")} — ${question}`, "", `*${tt("Généré le {date} · {n} source(s)", { date, n: sources.length })}*`, "", md.trim()];
  // Tableau du résultat de la base de données, le cas échéant.
  if (lastDbResult && lastDbResult.columns?.length) {
    const { sql, columns, rows } = lastDbResult;
    lines.push("", "---", "", `## ${tt("Résultat de la base de données")}`, "", "```sql", String(sql || "").trim(), "```", "");
    const esc = (v) => String(v == null ? "" : v).replace(/\|/g, "\\|");
    lines.push("| " + columns.map(esc).join(" | ") + " |");
    lines.push("| " + columns.map(() => "---").join(" | ") + " |");
    for (const r of rows.slice(0, 200)) lines.push("| " + columns.map((_, i) => esc(r?.[i])).join(" | ") + " |");
    if (rows.length > 200) lines.push("", `_${rows.length - 200} ligne(s) supplémentaire(s) non incluses._`);
  }
  lines.push("", "---", "", `## ${tt("Annexes — Sources")}`);
  sources.forEach((s, i) => {
    lines.push("", `### [${i + 1}] ${s.title || tt("Document")}`);
    if (s.doc_id) lines.push(`*doc : ${s.doc_id}*`);
    lines.push("", String(s.text || "").trim() || `_${tt("(passage vide)")}_`);
  });
  return lines.join("\n") + "\n";
}

// Sélecteur de sandbox via le modal (confirm()/prompt() non fiables sous WKWebView).
function pickSandbox(boxes) {
  return new Promise((resolve) => {
    modalResolve = resolve; // toute fermeture (✕, backdrop, Échap) résout à null
    const wrap = document.createElement("div");
    wrap.className = "modal-pick";
    boxes.forEach((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = b.name || b.id;
      btn.addEventListener("click", () => { modalResolve = null; closeModal(); resolve(b); });
      wrap.appendChild(btn);
    });
    openModal(tt("Exporter dans quelle sandbox ?"), wrap);
  });
}

async function exportReport() {
  if (!lastReport || !invoke) return;
  const btn = $("export-btn"); btn.disabled = true;
  try {
    let boxes = [];
    try { boxes = await invoke("sandbox_list"); } catch {}
    if (!boxes.length) {
      try { const created = await invoke("sandbox_create", { name: "Recherche profonde", maxMb: 256 }); if (created) boxes = [created]; } catch {}
    }
    if (!boxes.length) { toast(tt("Aucune sandbox disponible. Créez-en une dans l'explorateur.")); return; }
    const box = boxes.length === 1 ? boxes[0] : await pickSandbox(boxes);
    if (!box) return;
    const date = new Date().toISOString().slice(0, 10);
    const path = `recherche-profonde/${date}-${slugify(lastReport.question)}.md`;
    await invoke("sandbox_write_file", { id: box.id, path, content: buildMarkdown(lastReport) });
    try { window.parent && window.parent.LumenRefreshSandbox && window.parent.LumenRefreshSandbox(box.id); } catch {}
    toast(`Rapport exporté → ${box.name || box.id} / ${path}`);
  } catch (e) {
    toast(tt("Échec de l'export :") + " " + (e?.message || e));
  } finally { btn.disabled = false; }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2800);
}

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function selectedTableIds() {
  const values = Array.from($("research-tables").selectedOptions).map((o) => o.value).filter(Boolean);
  return values.length ? values : null;
}

function syncSourceControls() {
  const mode = $("source-mode").value;
  const needsDb = mode === "documents-db" || mode === "db";
  $("research-base").hidden = !needsDb;
  $("research-base").disabled = !needsDb;
  $("research-tables").hidden = !needsDb || !$("research-base").value;
  $("research-tables").disabled = !needsDb || !$("research-base").value;
  $("q").placeholder = mode === "db" ? tt("Posez une question sur la base sélectionnée…") : tt("Posez une question sur vos documents…");
}

async function populateTablesForBase(baseId) {
  const sel = $("research-tables");
  if (!baseId || !tablesDb.hasBackend) {
    currentTablesBaseId = "";
    sel.innerHTML = "";
    syncSourceControls();
    return;
  }
  if (currentTablesBaseId === baseId) {
    syncSourceControls();
    return;
  }
  currentTablesBaseId = baseId;
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = tt("Toutes les tables");
  all.selected = true;
  sel.appendChild(all);
  try {
    const tables = await tablesDb.listTables(baseId);
    for (const t of tables || []) {
      const o = document.createElement("option");
      o.value = t.table_id;
      o.textContent = t.name || t.table_id;
      sel.appendChild(o);
    }
  } catch {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = tt("Tables indisponibles");
    sel.appendChild(o);
  }
  syncSourceControls();
}

$("ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("q").value.trim();
  if (v) run(v);
});

// « Approfondir avec Enquête » (recherche globale, Envoyer vers…) : la
// question arrive en objet texte ; on la pose et on lance si rien ne tourne.
receive("research", (obj) => {
  const q = toText(obj).trim().slice(0, 500);
  if (!q) return;
  $("q").value = q;
  if (!running) run(q);
});

$("export-btn").addEventListener("click", exportReport);
$("source-mode").addEventListener("change", () => {
  syncSourceControls();
  populateTablesForBase($("research-base").value);
});
$("research-base").addEventListener("change", () => populateTablesForBase($("research-base").value));
$("research-tables").addEventListener("change", () => {
  const sel = $("research-tables");
  const pickedSpecific = Array.from(sel.selectedOptions).some((o) => o.value);
  if (pickedSpecific) Array.from(sel.options).forEach((o) => { if (!o.value) o.selected = false; });
  if (!sel.selectedOptions.length && sel.options[0]) sel.options[0].selected = true;
});
$("modal-close").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").hidden) closeModal(); });

async function populateBases() {
  if (!tablesDb.hasBackend) return;
  try {
    const bases = await tablesDb.listBases();
    const sel = $("research-base");
    for (const b of bases) {
      const o = document.createElement("option");
      o.value = b.base_id; o.textContent = `Base : ${b.name}`;
      sel.appendChild(o);
    }
    syncSourceControls();
  } catch {}
}

checkKb();
syncSourceControls();
populateBases();

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
