// Génération de documents depuis les barres de chat : « @doc_lettre_motivation
// pour le poste de… », « @doc_presentation_produit pour notre gourde… ».
//
// Chaque type de document est un outil du catalogue « @ ». L'outil ne se
// contente pas de rédiger : il va d'abord CHERCHER la matière de
// l'utilisateur, dans l'ordre —
//   1. ses sandboxes (CV, fiche produit, notes… : `doc_gather_context` côté
//      Rust, extraction PDF/Word/tableurs comprise) ;
//   2. le Corpus indexé (`rag_search`) ;
//   3. ses bases de données (NL→SQL en lecture seule, tables/client.js) pour
//      les documents qui vivent de chiffres (présentation produit, rapport,
//      proposition commerciale).
// Puis il rédige en Markdown avec le modèle courant (`llmChat`), enregistre le
// fichier dans une sandbox (Markdown, et PDF sur demande) et affiche une carte
// dans la bulle : étapes animées, sources utilisées, aperçu, gestes.
//
// Partagé par la barre principale (main.js) et le bureau (sandbox/desktop.js).

import { icon } from "./icons.js";
import { llmChat } from "../llm.js";
import { markdownToHtml } from "./markdown.js";
import * as tablesDb from "../tables/client.js";
import { ensureRunStyles } from "./agent-delegation.js";
import { runDocHarness, parseJsonLoose } from "./doc-harness.js";

// ===== Types de documents ==================================================
// `keys` : mots cherchés dans les sandboxes EN PLUS de ceux du brief.
// `tables` : le document vit de données chiffrées → on interroge les bases.
const KINDS = [
  {
    name: "doc_lettre_motivation",
    fr: "Lettre de motivation", en: "Cover letter", ic: "mail",
    keys: ["cv", "resume", "curriculum", "experience", "competences", "parcours", "profil", "diplome", "linkedin"],
    tables: false,
    plan: "En-tête (coordonnées du candidat si connues, destinataire, lieu et date), objet, accroche personnalisée liée à l'entreprise, deux ou trois paragraphes qui relient des expériences RÉELLES du candidat aux besoins du poste, motivation pour l'entreprise, conclusion avec demande d'entretien, formule de politesse, signature. Une page maximum.",
  },
  {
    name: "doc_cv",
    fr: "CV", en: "Résumé / CV", ic: "user",
    keys: ["cv", "resume", "curriculum", "experience", "competences", "formation", "diplome", "projets"],
    tables: false,
    plan: "Nom et titre, coordonnées, accroche de 2 lignes, expériences (poste, entreprise, dates, 2 à 4 réalisations chiffrées), formation, compétences groupées, langues, centres d'intérêt si pertinents.",
  },
  {
    name: "doc_presentation_produit",
    fr: "Présentation de produit", en: "Product presentation", ic: "presentation",
    keys: ["produit", "product", "fiche", "catalogue", "tarif", "prix", "specs", "caracteristiques", "gamme"],
    tables: true, deck: true,
    plan: "Titre et promesse en une phrase, le problème du client, la solution, 3 à 5 fonctionnalités clés avec leur bénéfice, caractéristiques techniques (tableau), prix / offres si connus, preuves (chiffres, clients, témoignages RÉELS uniquement), appel à l'action.",
  },
  {
    name: "doc_presentation",
    fr: "Présentation (diaporama)", en: "Slide deck", ic: "presentation",
    keys: ["presentation", "projet", "bilan", "strategie", "plan", "resultats", "equipe"],
    tables: true, deck: true,
    plan: "Diapositive de titre, ordre du jour ou accroche, contexte, sections claires (une idée par diapositive), chiffres clés si les sources en contiennent, tableau de synthèse si utile, prochaines étapes, conclusion avec appel à l'action.",
  },
  {
    name: "doc_proposition_commerciale",
    fr: "Proposition commerciale", en: "Business proposal", ic: "wallet",
    keys: ["devis", "offre", "client", "tarif", "prix", "prestation", "catalogue", "contrat"],
    tables: true, annex: true,
    plan: "Contexte et besoin du client, solution proposée, périmètre et livrables, planning, tarifs (tableau), conditions, prochaines étapes.",
  },
  {
    name: "doc_rapport",
    fr: "Rapport / synthèse", en: "Report / summary", ic: "chart",
    keys: ["rapport", "bilan", "resultats", "chiffres", "ventes", "analyse", "statistiques", "kpi"],
    tables: true, annex: true,
    plan: "Résumé exécutif (5 lignes), contexte, analyse chiffrée (tableaux Markdown à partir des données FOURNIES), points d'attention, recommandations, annexes/sources.",
  },
  {
    name: "doc_email",
    fr: "E-mail professionnel", en: "Professional e-mail", ic: "send",
    keys: ["client", "contact", "projet", "reunion", "devis"],
    tables: false,
    plan: "Ligne « Objet : … », salutation, message en 3 paragraphes courts maximum, action attendue claire, formule de clôture, signature.",
  },
  {
    name: "doc_compte_rendu",
    fr: "Compte rendu de réunion", en: "Meeting minutes", ic: "notes",
    keys: ["reunion", "notes", "compte", "rendu", "meeting", "ordre", "jour"],
    tables: false,
    plan: "Date, participants, ordre du jour, points discutés, décisions (liste), actions (tableau : action / responsable / échéance), prochaine réunion.",
  },
  {
    name: "doc_rediger",
    fr: "Document libre", en: "Free-form document", ic: "file-text",
    keys: [],
    tables: false,
    plan: "Structure adaptée à la demande : titre, introduction, sections titrées, conclusion.",
  },
];
const KIND_BY_NAME = new Map(KINDS.map((k) => [k.name, k]));
export const DOC_TOOL_NAMES = new Set(KINDS.map((k) => k.name));

// La demande porte-t-elle sur la PRODUCTION d'un document ? Les outils doc_*
// cherchent eux-mêmes dans les sandboxes : pour un petit modèle, « Résume mon
// CV » ressemble alors à « doc_rapport » ou « doc_cv » bien plus qu'à « lis ce
// fichier ». Résultat : un document écrit à la place d'une réponse. Sans verbe
// de production explicite, on ne les propose donc pas (une mention « @doc_… »
// reste prioritaire, cf. appelants).
const WRITE_INTENT = new RegExp([
  "\\b(redige|rediger|redigez|ecris|ecrire|ecrivez|cree|creer|creez|genere|generer|produis|produire|compose|composer|prepare|preparer)\\b",
  "\\b(fais|fait|faites|fais-moi|faire)[- ](moi |nous )?(un|une|le|la|mon|ma)\\s+(lettre|cv|document|rapport|presentation|diaporama|deck|proposition|compte[- ]rendu|mail|e-mail|courriel|dossier)",
  "\\b(mets a jour|mettre a jour|modifie|modifier|ameliore|ameliorer|reecris|reecrire|refais|refaire) (mon|ma|le|la|ce|cette) (cv|lettre|document|rapport|presentation)",
  "\\b(enregistre|enregistrer|sauvegarde|sauvegarder|exporte|exporter)\\b",
  "\\b(write|draft|compose|create|generate|produce|prepare|save|export)\\b",
  "\\ben (pdf|docx|word)\\b",
].join("|"));
export function wantsDocument(text) {
  const t = String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return WRITE_INTENT.test(t);
}
/** Retire les outils doc_* d'un catalogue quand la demande n'en produit pas. */
export function withoutDocToolsUnlessWriting(tools, text) {
  if (wantsDocument(text)) return tools;
  return (tools || []).filter((t) => !DOC_TOOL_NAMES.has(t?.function?.name));
}

const L = {
  fr: {
    desc: "Rédige un NOUVEAU document « {kind} » et l'ENREGISTRE comme fichier dans une sandbox. À n'utiliser QUE si l'utilisateur demande de rédiger / créer / enregistrer un tel document. Pour répondre à une question, résumer ou lire un fichier existant, utilise sandbox_search puis sandbox_read (ou notes_search), PAS cet outil. L'outil cherche lui-même les informations utiles dans les fichiers, le Corpus{db}. Passe dans brief TOUTE la demande (destinataire, poste, produit, contraintes, ton…).",
    db: " et les bases de données",
    brief: "La demande complète : à qui, pour quoi, contraintes, éléments donnés par l'utilisateur.",
    keywords: "Mots-clés pour retrouver les fichiers utiles (nom du produit, de l'entreprise, « cv »…).",
    format: "markdown (par défaut), pdf pour un PDF en plus, docx pour un fichier Word (documents).",
    slides: "Nombre de diapositives souhaité (8 à 12 par défaut).",
    theme: "Thème visuel du diaporama : nuit (défaut), clair, corail, foret, sable.",
    tone: "Ton souhaité (formel, chaleureux, percutant…).",
    title: "Titre court du document (sert de nom de fichier).",
    s_files: "Cherche dans tes fichiers",
    s_files_n: "{n} fichier(s) utile(s)",
    s_files_0: "Aucun fichier correspondant",
    s_corpus: "Consulte le Corpus",
    s_corpus_n: "{n} passage(s)",
    s_db: "Interroge les bases de données",
    s_db_n: "{n} ligne(s) de données",
    s_write: "Rédige le document",
    s_save: "Enregistre dans la sandbox",
    s_pdf: "Génère le PDF",
    sources: "Sources utilisées",
    no_source: "Aucune source trouvée : document rédigé à partir de ta demande seule.",
    copy: "Copier",
    copied: "Copié",
    open: "Ouvrir",
    files: "Fichiers créés",
    pdf: "PDF",
    expand: "Tout afficher",
    words: "{n} mots",
    result: "Document « {title} » rédigé ({words} mots) et enregistré dans la sandbox « {sb} » : {path}.{pdf} Sources utilisées : {src}. Le document est déjà affiché à l'utilisateur dans une carte : ne le recopie pas en entier. Réponds à sa demande en t'appuyant sur le CONTENU ci-dessous (faits exacts, pas d'invention) et signale les informations marquées [à compléter].\n\nCONTENU DU DOCUMENT :\n{content}",
    not_saved: "Non enregistré",
    no_sb: "Aucune sandbox : crée-en une dans Lumen Desktop pour enregistrer les documents.",
  },
  en: {
    desc: "Writes a NEW “{kind}” document and SAVES it as a file in a sandbox. Use it ONLY when the user asks to write / create / save such a document. To answer a question, summarize or read an existing file, use sandbox_search then sandbox_read (or notes_search), NOT this tool. The tool itself looks for useful information in the files, the Corpus{db}. Pass the WHOLE request in brief (recipient, position, product, constraints, tone…).",
    db: " and the databases",
    brief: "The complete request: for whom, what for, constraints, facts given by the user.",
    keywords: "Keywords to find the useful files (product or company name, “resume”…).",
    format: "markdown (default), pdf for an extra PDF, docx for a Word file (documents).",
    slides: "Desired number of slides (8 to 12 by default).",
    theme: "Deck visual theme: nuit (default), clair, corail, foret, sable.",
    tone: "Desired tone (formal, warm, punchy…).",
    title: "Short document title (used as the file name).",
    s_files: "Searching your files",
    s_files_n: "{n} useful file(s)",
    s_files_0: "No matching file",
    s_corpus: "Checking the Corpus",
    s_corpus_n: "{n} passage(s)",
    s_db: "Querying the databases",
    s_db_n: "{n} data row(s)",
    s_write: "Writing the document",
    s_save: "Saving to the sandbox",
    s_pdf: "Generating the PDF",
    sources: "Sources used",
    no_source: "No source found: written from your request only.",
    copy: "Copy",
    copied: "Copied",
    open: "Open",
    files: "Files created",
    pdf: "PDF",
    expand: "Show all",
    words: "{n} words",
    result: "Document “{title}” written ({words} words) and saved in sandbox “{sb}”: {path}.{pdf} Sources used: {src}. The document is already shown to the user in a card: do not copy it in full. Answer the request based on the CONTENT below (exact facts, no invention) and point out the facts marked [to be completed].\n\nDOCUMENT CONTENT:\n{content}",
    not_saved: "Not saved",
    no_sb: "No sandbox: create one in Lumen Desktop to save documents.",
  },
};
const lang = (l) => (String(l || "fr").startsWith("en") ? "en" : "fr");
const fmt = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => v?.[k] ?? "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Mots vides retirés du brief avant la recherche de fichiers.
const STOP = new Set(("les des une pour avec dans sur par que qui est son ses mon mes ton tes notre nos votre vos leur leurs "
  + "cette ces aux du de la le un et ou en au il elle je tu nous vous ils elles moi toi lui fait faire genere genère génère "
  + "rédige redige écris ecris lettre document présentation presentation the and for with from this that your our write "
  + "generate make create letter please stp merci").split(/\s+/));

export function briefKeywords(text) {
  return [...new Set(String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))].slice(0, 12);
}

// ===== Catalogue ===========================================================
export function buildDocTools(uiLang) {
  const s = L[lang(uiLang)];
  return KINDS.map((k) => ({
    type: "function",
    function: {
      name: k.name,
      description: fmt(s.desc, { kind: k.fr, db: k.tables ? s.db : "" }),
      parameters: {
        type: "object",
        properties: {
          brief: { type: "string", description: s.brief },
          title: { type: "string", description: s.title },
          keywords: { type: "string", description: s.keywords },
          tone: { type: "string", description: s.tone },
          format: { type: "string", enum: ["markdown", "pdf", "docx", "pptx"], description: s.format },
          ...(k.deck ? {
            slides: { type: "integer", description: s.slides },
            theme: { type: "string", enum: ["nuit", "clair", "corail", "foret", "sable"], description: s.theme },
          } : {}),
        },
        required: ["brief"],
      },
    },
  }));
}

// ===== Carte de progression ================================================
function mountDocCard(bubble, kind, brief, uiLang) {
  ensureRunStyles();
  const s = L[lang(uiLang)];
  const card = document.createElement("div");
  card.className = "agent-run doc-run";
  card.dataset.state = "run";
  card.innerHTML = `
    <div class="agent-run-head">
      <span class="agent-run-av">${icon(kind.ic) || icon("file-text")}</span>
      <span class="agent-run-id"><b>${esc(lang(uiLang) === "en" ? kind.en : kind.fr)}</b><span title="${esc(brief)}">${esc(brief)}</span></span>
      <span class="agent-run-meta"><span class="agent-run-clock">0s</span></span>
    </div>
    <div class="agent-run-bar"><i></i></div>
    <ol class="agent-run-steps"></ol>`;
  bubble.appendChild(card);
  const list = card.querySelector(".agent-run-steps");
  const clockEl = card.querySelector(".agent-run-clock");
  const t0 = Date.now();
  const tick = setInterval(() => { clockEl.textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
  const scroll = () => bubble.closest(".messages, #messages, .chat-messages")?.scrollTo?.({ top: 1e9, behavior: "smooth" });

  /// Ouvre une étape vivante ; renvoie `done(note, ok)` pour la clore.
  function stage(label, ic) {
    const li = document.createElement("li");
    li.className = "agent-run-step is-live";
    li.dataset.tone = "ok";
    li.innerHTML = `<span class="agent-run-ic">${icon(ic)}</span>
      <span class="agent-run-tx"><b>${esc(label)}</b><small class="doc-run-note"></small></span>
      <span class="agent-run-ok"></span>`;
    list.appendChild(li);
    scroll();
    return (note = "", ok = true) => {
      li.classList.remove("is-live");
      li.dataset.tone = ok ? "ok" : "fail";
      li.querySelector(".doc-run-note").textContent = note;
      li.querySelector(".agent-run-ok").innerHTML = icon(ok ? "check" : "x");
    };
  }

  function finish(ok, doc) {
    clearInterval(tick);
    card.dataset.state = ok ? "ok" : "fail";
    const av = card.querySelector(".agent-run-av");
    if (ok) {
      const burst = document.createElement("span");
      burst.className = "agent-run-burst";
      av.appendChild(burst);
      setTimeout(() => burst.remove(), 800);
    }
    if (!doc) return;
    const src = doc.sources.length
      ? `<div class="doc-run-src"><span>${esc(s.sources)}</span>${doc.sources.map((x) =>
        `<i title="${esc(x.detail || "")}">${icon(x.ic)}${esc(x.label)}</i>`).join("")}</div>`
      : `<div class="doc-run-src is-empty">${esc(s.no_source)}</div>`;
    const wrap = document.createElement("div");
    wrap.className = "doc-run-body";
    wrap.innerHTML = `${src}
      <div class="doc-run-file">${icon(doc.deck ? "presentation" : "file-text")}<b>${esc(doc.name)}</b><i>${esc(doc.sandboxName)} · ${esc(doc.deck ? `${doc.slides} diapositives` : fmt(s.words, { n: doc.words }))}${doc.corrections ? ` · ${doc.corrections} correction(s) factuelles` : ""}</i>
        ${doc.openPath ? `<button type="button" data-act="open">${icon("external-link")} ${esc(s.open)}</button>` : ""}
        <button type="button" data-act="copy">${icon("copy")} ${esc(s.copy)}</button>
        ${doc.pdf ? "" : `<button type="button" data-act="pdf">${icon("pdf")} ${esc(s.pdf)}</button>`}
      </div>
      ${doc.files?.length > 1 ? `<div class="doc-run-src"><span>${esc(s.files)}</span>${doc.files.map((f) => `<i title="${esc(f.path)}">${icon(f.ic || "file")}${esc(f.path.split("/").pop())}</i>`).join("")}</div>` : ""}
      <div class="doc-run-preview is-clamped">${markdownToHtml(doc.markdown)}</div>
      <button type="button" class="doc-run-more" data-act="more">${esc(s.expand)}</button>`;
    wrap.querySelector('[data-act="open"]')?.addEventListener("click", () => {
      try { (window.top?.LumenOpenFile || window.LumenOpenFile)?.(doc.openPath, doc.sandboxId); } catch {}
    });
    wrap.querySelector('[data-act="copy"]').addEventListener("click", (e) => {
      navigator.clipboard?.writeText(doc.markdown).then(() => {
        e.currentTarget.innerHTML = `${icon("check")} ${esc(s.copied)}`;
      }).catch(() => {});
    });
    wrap.querySelector('[data-act="pdf"]')?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await doc.exportPdf();
        btn.innerHTML = `${icon("check")} ${esc(s.pdf)}`;
      } catch (err) {
        btn.disabled = false;
        btn.title = String(err?.message || err);
      }
    });
    wrap.querySelector('[data-act="more"]').addEventListener("click", (e) => {
      wrap.querySelector(".doc-run-preview").classList.remove("is-clamped");
      e.currentTarget.remove();
    });
    card.appendChild(wrap);
    scroll();
  }
  return { stage, finish, el: card };
}

// ===== Collecte de contexte ================================================
async function gatherFiles(invoke, keywords, sandboxIds) {
  try {
    return (await invoke("doc_gather_context", { keywords, maxFiles: 4, maxChars: 4000, ...(sandboxIds ? { sandboxIds } : {}) })) || [];
  } catch (e) {
    console.warn("[doc] sandbox", e);
    return [];
  }
}

async function gatherCorpus(invoke, query) {
  try {
    return ((await invoke("rag_search", { query, k: 4 })) || []).filter((h) => String(h?.text || "").trim());
  } catch {
    return [];   // Corpus vide ou modèle d'embedding absent : pas bloquant.
  }
}

async function gatherTables(brief) {
  let bases = [];
  try { bases = (await tablesDb.listBases()) || []; } catch { return []; }
  const out = [];
  for (const base of bases.slice(0, 2)) {
    try {
      const q = `Quelles données de cette base sont utiles pour : ${brief}`;
      const { sql, columns, rows } = await tablesDb.askAi(base.base_id, q);
      if (!rows?.length) continue;
      out.push({ base: base.name, sql, columns, rows: rows.slice(0, 25) });
    } catch (e) {
      console.warn("[doc] tables", base.name, e);
    }
  }
  return out;
}


function today(uiLang) {
  return new Date().toLocaleDateString(lang(uiLang) === "en" ? "en-GB" : "fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function safeName(s) {
  return String(s || "document").replace(/[\\/:*?"<>|#]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 70) || "document";
}

// ===== Exécution ===========================================================
/**
 * Exécute un outil `doc_*` par le harnais de rédaction (lib/doc-harness.js) :
 * cadrage → sources → plan → rédaction par section (ou diapositives) →
 * vérification des chiffres → mise en forme → enregistrement.
 * @param {Function} invoke   invoke Tauri
 * @param {string} name       nom de l'outil
 * @param {object} args       arguments du modèle
 * @param {{bubble?:HTMLElement, lang?:string, sandboxId?:string, complete?:Function,
 *   authorizeSandboxes?:Function, chooseSandbox?:Function}} opts
 *   `sandboxId` : sandbox où enregistrer (bureau : la sandbox ouverte) ;
 *   `complete(messages)` : rédaction (défaut : `llmChat` sur le backend courant).
 */
export async function callDocTool(invoke, name, args, opts = {}) {
  const kind = KIND_BY_NAME.get(name);
  if (!kind) return `Outil inconnu : ${name}`;
  const uiLang = opts.lang || "fr";
  const s = L[lang(uiLang)];
  const brief = String(args?.brief ?? args?.input ?? args?.text ?? args?.prompt ?? "").trim();
  if (!brief) return "Échec : brief vide. Passe la demande complète de l'utilisateur dans brief.";
  const format = String(args?.format || "").toLowerCase();
  const wantPdf = format === "pdf" || /\bpdf\b/i.test(brief);
  const wantDocx = format === "docx" || /\b(docx|word)\b/i.test(brief);
  const card = opts.bubble ? mountDocCard(opts.bubble, kind, brief, uiLang) : null;
  const stage = (label, ic) => card?.stage(label, ic) || (() => {});
  const complete = opts.complete || (async (msgs) => (await llmChat(msgs, { rawSystem: true })).content);
  const completeJson = async (msgs) => {
    try {
      const raw = opts.complete ? await opts.complete(msgs) : (await llmChat(msgs, { rawSystem: true, json: true })).content;
      return parseJsonLoose(raw);
    } catch (e) { console.warn("[doc] étape JSON", e); return null; }
  };

  let files = [];
  try {
    const result = await runDocHarness({
      kind, brief, title: args?.title, tone: args?.tone, keywords: String(args?.keywords || "").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean),
      lang: lang(uiLang), theme: args?.theme, slides: args?.slides,
    }, {
      complete, completeJson, stage,
      today: today(uiLang),
      gather: async ({ keywords, brief: b, tables: withTables }) => {
        const keys = [...new Set([...keywords, ...briefKeywords(b), ...kind.keys])].slice(0, 24);
        // Seulement les sandboxes que l'utilisateur autorise (accord demandé si besoin).
        let sandboxIds;
        if (opts.authorizeSandboxes) sandboxIds = await opts.authorizeSandboxes(b.slice(0, 140));
        const fs = sandboxIds && !sandboxIds.length ? [] : await gatherFiles(invoke, keys, sandboxIds);
        files = fs;
        return { files: fs, corpus: await gatherCorpus(invoke, b), tables: withTables ? await gatherTables(b) : [] };
      },
      save: async ({ title, folder, markdown, creative, deck }) => {
        let sb = null;
        if (opts.chooseSandbox) {
          // Surface sans sandbox ouverte (barre) : l'utilisateur choisit, après
          // déverrouillage de la session si besoin (cf. lib/sandbox-prompt.js).
          sb = await opts.chooseSandbox({ host: card?.el || opts.bubble, suggestedId: files[0]?.sandbox_id || "" });
          if (!sb) return null;
        } else {
          let sandboxes = [];
          try { sandboxes = (await invoke("sandbox_list")) || []; } catch {}
          sb = sandboxes.find((x) => x.id === opts.sandboxId) || sandboxes.find((x) => x.id === files[0]?.sandbox_id) || sandboxes[0];
        }
        if (!sb) return null;
        const base = `${folder}/${safeName(title)} (${new Date().toISOString().slice(0, 10)})`;
        const out = [];
        await invoke("sandbox_write_file", { id: sb.id, path: `${base}.md`, content: markdown });
        out.push({ path: `${base}.md`, ic: "file-text" });
        // Fichier Opus : s'ouvre, se retouche et s'exporte comme les autres.
        const ext = deck ? "lumenkey" : "lumenpages";
        await invoke("sandbox_write_file", { id: sb.id, path: `${base}.${ext}`, content: JSON.stringify({ kind: deck ? "presentation" : "document", title, doc: creative, html: "", updatedAt: Date.now() }, null, 2) });
        out.push({ path: `${base}.${ext}`, ic: deck ? "presentation" : "file-text", open: true });
        if (deck || wantDocx) {
          try {
            const { writeSandboxBytes } = await import("./office/ooxml.js");
            const bytes = deck ? await (await import("./office/pptx.js")).creativeToPptx(creative) : await (await import("./office/docx.js")).creativeToDocx(creative);
            await writeSandboxBytes(invoke, sb.id, `${base}.${deck ? "pptx" : "docx"}`, bytes);
            out.push({ path: `${base}.${deck ? "pptx" : "docx"}`, ic: deck ? "presentation" : "file-text" });
          } catch (e) { console.warn("[doc] export Office", e); }
        }
        if (wantPdf) {
          try { const pdf = await invoke("sandbox_write_pdf", { id: sb.id, title, content: markdown, path: `${base}.pdf` }); out.push({ path: pdf?.path || `${base}.pdf`, ic: "pdf" }); } catch (e) { console.warn("[doc] PDF", e); }
        }
        return { sandbox: sb, files: out };
      },
    });

    const saved = result.saved;
    const sources = [
      ...files.map((f) => ({ ic: "file-text", label: f.path.split("/").pop(), detail: `${f.sandbox_name}/${f.path}` })),
      ...result.sources.filter((x) => x.kind !== "file").map((x) => ({ ic: x.kind === "table" ? "database" : "book-open-text", label: x.label, detail: x.detail })),
    ];
    if (!saved) {
      card?.finish(true, { name: safeName(result.title), sandboxName: s.not_saved, words: result.words, markdown: result.markdown, sources, pdf: true, deck: result.isDeck, slides: result.slides, corrections: result.corrections });
      return `${s.not_saved}\n\n${result.markdown}`;
    }
    const main = saved.files.find((f) => f.open) || saved.files[0];
    const mdPath = saved.files[0].path;
    const exportPdf = async () => invoke("sandbox_write_pdf", { id: saved.sandbox.id, title: result.title, content: result.markdown, path: mdPath.replace(/\.md$/, ".pdf") });
    card?.finish(true, {
      name: main.path.split("/").pop(), sandboxName: saved.sandbox.name, sandboxId: saved.sandbox.id, openPath: main.path,
      words: result.words, markdown: result.markdown, sources, pdf: saved.files.some((f) => f.ic === "pdf"), exportPdf,
      files: saved.files, deck: result.isDeck, slides: result.slides, corrections: result.corrections,
    });
    const srcTxt = sources.length ? sources.map((x) => x.label).join(", ") : (lang(uiLang) === "en" ? "none" : "aucune");
    return fmt(s.result, {
      title: result.title, words: result.words, sb: saved.sandbox.name, path: saved.files.map((f) => f.path).join(", "),
      pdf: "",
      src: srcTxt,
      // Le modèle doit VOIR ce qui a été écrit : sans cela il répondait à
      // l'aveugle, alors que la carte affichait un contenu juste.
      content: result.markdown.length > 8000 ? `${result.markdown.slice(0, 8000)}\n…` : result.markdown,
    });
  } catch (e) {
    card?.finish(false, null);
    return `Échec de la génération du document : ${String(e?.message || e)}`;
  }
}
