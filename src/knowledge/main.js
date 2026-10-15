import { autoTranslate, tt } from "../apps-i18n.js";
import { EMBED_CATALOG, embedLabel, embedSize } from "../lib/embed-models.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { receive, toText, describe } from "../lib/interop.js";
// App Connaissances (RAG) — logique front. S'appuie sur les commandes backend
// rag_* (rag.rs) : statut, liste/suppression de documents, import (fichier en
// base64 ou texte collé), et test de recherche sémantique. Aucune dépendance
// réseau côté UI : tout passe par le backend (embeddings locaux ou API active).

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};

const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; };

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

function setStatus(msg) { $("status").textContent = msg; }

/// Volume de texte, en unité lisible (« 42 000 car. » → « 42 k car. »).
function fmtChars(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${Math.round(v / 1000)} k car.` : `${v} car.`;
}

async function refresh() {
  try {
    const st = await invoke("rag_status");
    const docs = st?.docs || 0, chunks = st?.chunks || 0;
    // Le bouton « Réindexer » sert aussi à changer d'encodeur : il doit donc
    // apparaître sur un conflit, pas seulement sur un index d'ancienne facture.
    const conflict = await refreshEmbed();
    const reindexBtn = $("btn-reindex");
    if (reindexBtn) reindexBtn.hidden = !st?.needs_reindex && !conflict;
    const cp = $("chunk-preset");
    if (cp && st?.chunk_preset) cp.value = st.chunk_preset;
    if (docs > 0 && st?.needs_reindex) {
      setStatus(`${docs} doc(s) · ${chunks} extrait(s) — ⚠ ancien index : cliquez « Réindexer » pour une recherche pertinente`);
    } else {
      setStatus(docs > 0
        ? `${docs} document(s) · ${chunks} extrait(s)${st.embed_model ? " · " + st.embed_model : ""}`
        : "Base vide — importez un document");
    }
  } catch { setStatus("Indisponible"); }
  await renderDocs();
}

// ===== Encodeur d'embedding =================================================
//
// Le même réglage que Réglages → Modèles, exposé là où on indexe. Changer
// d'encodeur ne suffit pas : les vecteurs existants ont été produits par
// l'ancien et ne sont pas comparables. `rag_reindex` repart des extraits déjà
// stockés et les ré-encode — c'est pour cela que le bouton « Réindexer »
// apparaît dès que le choix ne correspond plus à l'index.

let embedPref = "auto";
let embedIndexedWith = null;
let embedInstalled = [];

function fillEmbedSelect() {
  const sel = $("embed-model");
  if (!sel || sel.dataset.filled === "1") return;
  sel.dataset.filled = "1";
  for (const [filename, entry] of Object.entries(EMBED_CATALOG)) {
    sel.appendChild(new Option(entry.label, filename));
  }
}

async function refreshEmbed() {
  const sel = $("embed-model");
  if (!sel) return;
  fillEmbedSelect();
  try {
    const cfg = await invoke("rag_get_embed_pref");
    embedPref = cfg?.pref || "auto";
    embedIndexedWith = cfg?.indexed_with || null;
  } catch { embedPref = "auto"; embedIndexedWith = null; }
  let running = null;
  try {
    const st = await invoke("llama_embed_status");
    embedInstalled = st?.installed || [];
    running = st?.running ? st?.model : null;
  } catch { embedInstalled = []; }

  sel.value = embedPref;
  const chosen = sel.value;
  const isGguf = chosen !== "auto";
  const installed = isGguf && embedInstalled.includes(chosen);

  const dl = $("btn-embed-download");
  if (dl) dl.hidden = !isGguf || installed;

  const hint = $("embed-hint");
  if (hint) {
    if (isGguf && !installed) hint.textContent = `À télécharger (${embedSize(chosen)}).`;
    else if (running === chosen) hint.textContent = "En service, en local.";
    else if (isGguf) hint.textContent = "Prêt, servi en local sur un port privé.";
    else hint.textContent = "Suit la source d'IA ; encodeur local si aucun Ollama.";
  }

  // Index construit avec un autre encodeur : les vecteurs ne sont pas
  // comparables, l'import suivant échouerait sur une erreur de dimension.
  const conflict = isGguf && embedIndexedWith && embedIndexedWith !== chosen;
  const warn = $("embed-warning");
  if (warn) {
    warn.hidden = !conflict;
    if (conflict) {
      warn.textContent = `L'index a été construit avec « ${embedLabel(embedIndexedWith)} ». `
        + `Cliquez « Réindexer » pour tout ré-encoder avec « ${embedLabel(chosen)} » ; `
        + `sans cela, les prochains imports seront refusés.`;
    }
  }
  return conflict;
}

async function renderDocs() {
  const box = $("doc-list");
  let docs = [];
  try { docs = await invoke("rag_list"); } catch {}
  box.innerHTML = "";
  $("doc-empty").hidden = (docs || []).length > 0;
  $("doc-count").textContent = `Documents (${(docs || []).length})`;
  for (const d of docs || []) {
    const row = document.createElement("div");
    row.className = "doc";
    const when = d.created_at ? new Date(d.created_at).toLocaleDateString() : "";
    row.innerHTML = `
      <span class="doc-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
      <div class="doc-main">
        <div class="doc-title" title="${esc(d.source || d.title)}">${esc(d.title)}</div>
        <div class="doc-meta">${d.chunks} extrait(s)${d.chars ? " · " + fmtChars(d.chars) : ""}${when ? " · " + esc(when) : ""}</div>
      </div>`;
    const del = document.createElement("button");
    del.className = "doc-del";
    del.title = "Retirer ce document";
    del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
    del.addEventListener("click", async () => {
      del.disabled = true;
      try { await invoke("rag_delete", { docId: d.doc_id }); } catch (e) { toast("Échec : " + (e?.message || e)); }
      refresh();
    });
    row.appendChild(del);
    box.appendChild(row);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ""); resolve(s.slice(s.indexOf(",") + 1)); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function ingestFiles(files) {
  for (const file of files) {
    setStatus(`Indexation de « ${file.name} »…`);
    try {
      const b64 = await fileToBase64(file);
      const res = await invoke("rag_add_file_bytes", { title: file.name, b64 });
      // Le volume extrait est annoncé : c'est le seul indice immédiat qu'un PDF
      // n'a livré qu'une partie de son texte (page image, police exotique…).
      toast(`« ${file.name} » indexé — ${res?.chunks ?? "?"} extraits, ${fmtChars(res?.chars || 0)}`);
    } catch (e) {
      toast(`Échec « ${file.name} » : ${e?.message || e}`);
    }
  }
  await refresh();
}

async function search() {
  const q = $("search-input").value.trim();
  if (!q) return;
  const box = $("hits");
  box.innerHTML = `<p class="empty">Recherche…</p>`;
  $("hits-empty").hidden = true;
  let hits = [];
  try { hits = await invoke("rag_search", { query: q, k: 6 }); }
  catch (e) { box.innerHTML = ""; toast("Échec : " + (e?.message || e)); return; }
  box.innerHTML = "";
  $("hits-empty").hidden = (hits || []).length > 0;
  (hits || []).forEach((h, i) => {
    const el = document.createElement("div");
    el.className = "hit";
    // Pertinence en pourcentage : la distance cosinus brute ne parlait à
    // personne. La pastille « mot-clé » signale en plus que l'extrait a été
    // trouvé par correspondance exacte, ce qui n'est pas la même garantie.
    const pct = typeof h.score === "number" ? Math.round(h.score * 100) + " %" : "";
    const tag = h.lexical ? '<span class="hit-tag">mot-clé</span>' : "";
    el.innerHTML = `<div class="hit-head"><span class="hit-title">[${i + 1}] ${esc(h.title)}</span>${tag}<span class="hit-score">${pct}</span></div><div class="hit-text">${esc(h.text)}</div>`;
    box.appendChild(el);
  });
}

// ===== Assistant IA (boîte de prompt partagée) =====
// La base se pilote au prompt : interroger le contenu indexé (l'IA cite ses
// extraits), y ajouter des notes, faire l'inventaire, supprimer, réindexer.
const KNOWLEDGE_TOOLS = [
  tool("search_knowledge", "Cherche dans la base de connaissances et renvoie les extraits les plus pertinents. À appeler AVANT de répondre à une question de contenu.",
    { query: T.str("Question ou mots-clés"), k: T.int("Nombre d'extraits (défaut 6)") }, ["query"]),
  tool("list_documents", "Inventaire des documents indexés (titre, source, nombre d'extraits).", {}),
  tool("add_text", "Indexe un texte dans la base (note, synthèse, mémo rédigé par toi).",
    { title: T.str("Titre du document"), text: T.str("Contenu à mémoriser") }, ["title", "text"]),
  tool("delete_document", "Supprime un document de la base.", { document: T.str("Titre ou identifiant") }, ["document"]),
  tool("reindex", "Réindexe toute la base (après changement de modèle d'embedding).", {}),
];

async function runKnowledgeTool(name, a) {
  switch (name) {
    case "search_knowledge": {
      const hits = await invoke("rag_search", { query: String(a.query || ""), k: Math.min(12, Number(a.k) || 6) });
      if (!hits || !hits.length) return "Aucun extrait pertinent dans la base.";
      $("search-input").value = String(a.query || "");
      return hits.map((h, i) => `[${i + 1}] ${h.title}${typeof h.score === "number" ? ` (${Math.round(h.score * 100)} %)` : ""}\n${h.text}`).join("\n\n");
    }
    case "list_documents": {
      const list = await invoke("rag_list").catch(() => []);
      if (!list || !list.length) return "Base vide.";
      return list.map((d) => `${d.doc_id} · ${d.title}${d.source ? ` (${d.source})` : ""}${d.chunks ? ` — ${d.chunks} extraits` : ""}`).join("\n");
    }
    case "add_text": {
      await invoke("rag_add_text", { title: String(a.title || "Note"), text: String(a.text || ""), source: "Assistant" });
      return `Indexé : « ${a.title} ».`;
    }
    case "delete_document": {
      const list = await invoke("rag_list").catch(() => []);
      const ref = String(a.document || "").toLowerCase();
      const d = (list || []).find((x) => x.doc_id === a.document)
        || (list || []).find((x) => String(x.title || "").toLowerCase().includes(ref));
      if (!d) throw new Error("document introuvable ; appelle list_documents.");
      await invoke("rag_delete", { docId: d.doc_id });
      return `Supprimé : « ${d.title} ».`;
    }
    case "reindex": { const res = await invoke("rag_reindex"); return `Réindexation terminée. ${typeof res === "string" ? res : ""}`; }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountKnowledgeAI() {
  mountAiPrompt(null, {
    app: "Connaissances",
    intro: "Tu réponds à partir de la base de connaissances locale de l'utilisateur, et tu l'entretiens.",
    rules: "- Toute question de contenu commence par search_knowledge ; ne réponds jamais de mémoire sur le contenu de la base.\n- Cite les titres des extraits utilisés.\n- Si rien ne ressort, dis-le franchement plutôt que d'inventer.",
    placeholder: "Ex. : que disent mes documents sur la garantie ?",
    suggestions: [
      { label: "Interroger", prompt: "Cherche dans ma base ce qui répond à ma question et cite tes sources. Je précise juste après." },
      { label: "Inventaire", prompt: "Fais l'inventaire de ma base : documents indexés, doublons éventuels, trous manifestes." },
      { label: "Synthèse", prompt: "Cherche les extraits sur le thème principal de ma base et indexe une note de synthèse." },
    ],
    tools: KNOWLEDGE_TOOLS,
    context: async () => {
      try {
        const list = await invoke("rag_list");
        return `${(list || []).length} document(s) indexés : ` + (list || []).slice(0, 20).map((d) => d.title).join(", ");
      } catch { return "(base indisponible)"; }
    },
    execute: runKnowledgeTool,
    onApplied: () => refresh(),
  });
}

/// Affiche la progression d'un téléchargement de modèle dans la ligne d'état.
/// Renvoie la fonction d'arrêt de l'écoute (ou null si l'API n'est pas là).
async function listenDownloadProgress(filename, label) {
  const listen = __TAURI.event?.listen;
  if (!listen) return null;
  try {
    return await listen("llama-download-progress", (e) => {
      const p = e?.payload || {};
      if (p.filename && p.filename !== filename) return;
      setStatus(`Téléchargement de « ${label} » — ${p.percent || 0} %`);
    });
  } catch { return null; }
}

function wire() {
  $("btn-pick").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) ingestFiles(files);
    e.target.value = "";
  });

  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); if (ev !== "dragleave" || e.target === dz) dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) ingestFiles(files);
  });

  $("btn-add-text").addEventListener("click", async () => {
    const text = $("paste-text").value.trim();
    if (!text) return;
    const title = ($("paste-title").value.trim()) || (text.slice(0, 40).replace(/\s+/g, " ") + (text.length > 40 ? "…" : ""));
    setStatus("Indexation du texte…");
    try {
      await invoke("rag_add_text", { title, text, source: "Texte collé" });
      $("paste-text").value = ""; $("paste-title").value = "";
      toast("Texte indexé");
    } catch (e) { toast("Échec : " + (e?.message || e)); }
    await refresh();
  });

  $("btn-reindex").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; const prev = btn.textContent; btn.textContent = "Réindexation…";
    setStatus("Réindexation en cours (ré-encodage local)…");
    try {
      const res = await invoke("rag_reindex");
      toast(`Réindexé : ${res?.reindexed ?? 0} extrait(s)`);
    } catch (err) { toast("Échec : " + (err?.message || err)); }
    btn.textContent = prev; btn.disabled = false;
    await refresh();
  });
  $("embed-model")?.addEventListener("change", async (e) => {
    try {
      await invoke("rag_set_embed_pref", { model: e.target.value });
      toast("Encodeur mis à jour");
    } catch (err) { toast("Échec : " + (err?.message || err)); }
    await refresh();
  });

  $("btn-embed-download")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const filename = $("embed-model").value;
    const entry = EMBED_CATALOG[filename];
    if (!entry) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "Téléchargement…";
    setStatus(`Téléchargement de « ${entry.label} » (${embedSize(filename)})…`);
    // Plusieurs centaines de Mo : un bouton figé sans chiffre laisse croire à un
    // blocage. Le backend émet déjà la progression, on se contente de l'écouter.
    const stop = await listenDownloadProgress(filename, entry.label);
    try {
      await invoke("llama_download_model", {
        request: { id: entry.id, url: entry.url, filename, mmprojFilename: null, mmprojUrl: null },
      });
      toast("Encodeur téléchargé");
    } catch (err) { toast("Échec : " + (err?.message || err)); }
    stop?.();
    btn.textContent = prev; btn.disabled = false;
    await refresh();
  });

  $("chunk-preset").addEventListener("change", async (e) => {
    try { await invoke("rag_set_chunk_preset", { preset: e.target.value }); toast("Découpage mis à jour (prochains imports)"); }
    catch (err) { toast("Échec : " + (err?.message || err)); }
  });
  $("btn-search").addEventListener("click", search);
  $("search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });

  // Confirmation par double-clic (confirm() inopérant sous WKWebView).
  $("btn-clear").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      const prev = btn.textContent;
      btn.textContent = "Confirmer le vidage";
      setTimeout(() => { btn.dataset.armed = "0"; btn.textContent = prev; }, 3000);
      return;
    }
    btn.dataset.armed = "0"; btn.textContent = "Vider la base";
    try { await invoke("rag_clear"); } catch {}
    $("hits").innerHTML = "";
    refresh();
  });
}

wire();
mountKnowledgeAI();
// « Envoyer vers Corpus » : le contenu est indexé comme un document.
receive("knowledge", async (obj) => {
  // Un objet `file` ne se résume PAS à son chemin : `toText` renverrait la
  // chaîne « dossier/rapport.pdf » et on indexait ce texte-là. On lit les
  // octets dans SA sandbox (pas l'active) et on laisse le backend extraire
  // le contenu — PDF, Word, tableur compris.
  if (obj.kind === "file" && obj.path && obj.sandboxId) {
    try {
      const b64 = await invoke("sandbox_read_b64", { id: obj.sandboxId, path: obj.path });
      const title = obj.title || obj.path.split("/").pop() || "Document";
      await invoke("rag_add_file_bytes", { title, b64, source: "Envoyé vers Corpus" });
      refresh();
      return;
    } catch (e) {
      console.warn("[corpus] fichier illisible", e);
    }
  }
  const text = toText(obj).trim();
  if (!text) return;
  await runKnowledgeTool("add_text", { title: obj.title || describe(obj).slice(0, 80), text });
  refresh();
});
refresh();

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
