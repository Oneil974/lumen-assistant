// Relia — CRM de Lumen : articles & stock, clients, devis, factures Factur-X.
//
// Trois principes tiennent l'app :
//   1. Les données vivent dans la base SQLite « ERP » (store.js), pas dans un
//      localStorage privé : Prisme, Fluxo et les agents les voient nativement.
//   2. Un devis basculé en facture DÉBITE le stock, une seule fois, et laisse
//      une trace dans « Mouvements stock » — un stock qui bouge sans document
//      est un stock que personne ne sait expliquer trois mois plus tard.
//   3. Le PDF et le XML Factur-X sont produits à partir des MÊMES totaux
//      calculés une fois (facturx.js) : ils ne peuvent pas diverger.
import * as store from "./store.js";
import * as fx from "./facturx.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { autoTranslate } from "../apps-i18n.js";
import { mountShell, avatar, kpi, emptyState, progress } from "../lib/app-shell.js";
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { formatMoney } from "../lib/money.js";

// Icônes de la coquille (nav, en-têtes) : posées avant le premier rendu.
mountShell();

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => formatMoney(n);
const qty = (n) => (Number(n) || 0).toLocaleString("fr-FR", { maximumFractionDigits: 3 });
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, days) => { const d = new Date(iso || today()); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const dateFr = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—");

const UNITS = Object.keys(fx.UNIT_CODES);
// Taux de TVA proposés. 8,5 % est le taux normal des départements d'outre-mer
// (Guadeloupe, Martinique, La Réunion) : sans lui, une facture ultramarine
// devait passer par une saisie hors liste.
const VAT_RATES = [20, 10, 8.5, 5.5, 2.1, 0];
const QUOTE_STATUS = ["Brouillon", "Envoyé", "Accepté", "Refusé", "Facturé"];
const INVOICE_STATUS = ["Brouillon", "Émise", "Partiellement payée", "Payée", "Annulée"];
// Projets & tâches. Les colonnes du kanban SONT les statuts de tâche : une
// seule liste, sinon glisser une carte et changer un statut divergeraient.
const PROJECT_STATUS = ["Prospect", "En cours", "En pause", "Terminé", "Annulé"];
const TASK_STATUS = ["À faire", "En cours", "En revue", "Terminé"];
const TASK_PRIORITY = ["Basse", "Normale", "Haute", "Urgente"];

// ============================ Tags ============================
//
// Un tag est une chaîne libre, mais la valeur d'un tag vient de sa RÉUTILISATION :
// « client-fidele » et « Client Fidèle » côte à côte ne filtrent plus rien. D'où
// la saisie par jetons avec autocomplétion sur les tags déjà employés, plutôt
// qu'un champ texte libre. Le stockage reste une simple chaîne « a, b, c »,
// lisible depuis Prisme et interrogeable en SQL (LIKE '%tag%').
const splitTags = (v) => String(v || "").split(",").map((t) => t.trim()).filter(Boolean);
const joinTags = (list) => [...new Set(list.map((t) => t.trim()).filter(Boolean))].join(", ");

/** Tous les tags déjà utilisés, triés par fréquence décroissante. */
function knownTags(kinds = ["articles", "clients", "quotes", "invoices"]) {
  const source = {
    articles: state.articles, clients: state.clients, quotes: state.quotes,
    invoices: state.invoices, projects: state.projects, tasks: state.tasks,
  };
  const counts = new Map();
  for (const kind of kinds) {
    for (const row of source[kind] || []) {
      for (const tag of splitTags(row["Tags"])) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr")).map(([tag]) => tag);
}

/** Catégories d'articles déjà saisies (autocomplétion de la fiche article). */
const knownCategories = () => [...new Set(state.articles.map((a) => a["Catégorie"]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));

const datalistHtml = (id, values) => `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;

/** Champ de saisie de tags : jetons + suggestions sur l'existant. */
function tagsFieldHtml(values, listId, suggestions) {
  return `<div class="tags-field">
    <div class="tag-chips">${values.map((t) => `<span class="tag-chip" data-tag="${esc(t)}">${esc(t)}<button type="button" class="tag-x" aria-label="Retirer">×</button></span>`).join("")}</div>
    <input class="tag-input" list="${listId}" placeholder="Ajouter un tag…" autocomplete="off" />
    ${datalistHtml(listId, suggestions)}
  </div>`;
}

/** Lit les jetons d'un champ de tags, y compris le texte encore en cours. */
function readTagsField(field) {
  if (!field) return "";
  const chips = [...field.querySelectorAll(".tag-chip")].map((c) => c.dataset.tag);
  const pending = field.querySelector(".tag-input")?.value || "";
  return joinTags(chips.concat(splitTags(pending)));
}

function addTagChip(field, value) {
  const tag = String(value || "").trim().replace(/,/g, "");
  if (!tag) return;
  const chips = field.querySelector(".tag-chips");
  if ([...chips.querySelectorAll(".tag-chip")].some((c) => c.dataset.tag.toLowerCase() === tag.toLowerCase())) return;
  const el = document.createElement("span");
  el.className = "tag-chip";
  el.dataset.tag = tag;
  el.innerHTML = `${esc(tag)}<button type="button" class="tag-x" aria-label="Retirer">×</button>`;
  chips.appendChild(el);
}

/** Barre de filtres : un tag cliquable par tag connu de la vue. */
function tagBarHtml(kind) {
  const tags = knownTags([kind]);
  if (!tags.length) return "";
  const active = state.tagFilter[kind];
  return tags.map((t) => `<button type="button" class="tag-pill ${active.includes(t) ? "on" : ""}" data-tag-filter="${kind}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")
    + (active.length ? `<button type="button" class="tag-pill clear" data-tag-filter="${kind}" data-tag="">Tout afficher</button>` : "");
}

/** Un enregistrement passe le filtre s'il porte TOUS les tags sélectionnés. */
function matchTagFilter(kind, row) {
  const active = state.tagFilter[kind];
  if (!active.length) return true;
  const tags = splitTags(row["Tags"]).map((t) => t.toLowerCase());
  return active.every((t) => tags.includes(t.toLowerCase()));
}

const state = {
  view: "dashboard",
  societe: null,
  articles: [],
  clients: [],
  quotes: [],
  invoices: [],
  moves: [],
  projects: [],
  tasks: [],
  taskMode: "list", // list | kanban | gantt
  doc: null,        // document en cours d'édition
  tagFilter: { articles: [], clients: [], quotes: [], invoices: [], projects: [], tasks: [] },
};

// ============================ Utilitaires ============================

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

/**
 * Numérotation séquentielle, continue et sans trou : exigence fiscale
 * (art. 242 nonies A CGI). On repart du plus grand numéro de l'année en cours
 * plutôt que d'un compteur stocké, qui se désynchroniserait d'une suppression.
 */
function nextNumber(kind) {
  const year = new Date().getFullYear();
  const prefix = kind === "quote" ? `D${year}-` : `F${year}-`;
  const rows = kind === "quote" ? state.quotes : state.invoices;
  const max = rows
    .map((r) => String(r["Numéro"] || ""))
    .filter((n) => n.startsWith(prefix))
    .map((n) => parseInt(n.slice(prefix.length), 10) || 0)
    .reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

const clientOf = (doc) => state.clients.find((c) => c._id === doc["Client id"])
  || state.clients.find((c) => c["Nom"] === doc["Client"])
  || { Nom: doc["Client"] || "", Type: "Entreprise", Pays: "FR" };

const articleByRef = (ref) => state.articles.find((a) => String(a["Référence"]).toLowerCase() === String(ref || "").toLowerCase());

const statusBadge = (status) => {
  const cls = { "Payée": "ok", "Accepté": "ok", "Émise": "warn", "Envoyé": "warn", "Partiellement payée": "warn", "Refusé": "bad", "Annulée": "bad", "Facturé": "ok", "Terminé": "ok", "En cours": "warn", "En revue": "warn", "En pause": "warn" }[status] || "";
  return `<span class="badge ${cls}">${esc(status || "Brouillon")}</span>`;
};

// ============================ Chargement ============================

async function reload() {
  const [societe, articles, clients, quotes, invoices, moves, projects, tasks] = await Promise.all([
    store.list("societe"), store.list("articles"), store.list("clients"),
    store.list("devis"), store.list("factures"), store.list("stock"),
    store.list("projets"), store.list("taches"),
  ]);
  state.societe = societe[0] || null;
  if (!state.societe) {
    // Première ouverture : une fiche société vide, avec les valeurs que la loi
    // fixe elle-même (indemnité de recouvrement de 40 €).
    const id = await store.insert("societe", {
      "Raison sociale": "", "Pays": "FR", "Mode paiement": "Virement",
      "Conditions paiement": "Paiement à 30 jours", "Taux pénalités": 10.85,
      "Indemnité recouvrement": 40, "Régime TVA": "Réel normal",
      "Profil Factur-X": "EN 16931", "TVA sur les débits": false,
    });
    state.societe = (await store.list("societe")).find((r) => r._id === id) || null;
  }
  state.articles = articles;
  state.clients = clients;
  state.quotes = quotes.slice().reverse();
  state.invoices = invoices.slice().reverse();
  state.moves = moves;
  state.projects = projects;
  // Le rang porte l'ordre voulu par l'utilisateur (glisser-déposer du kanban) ;
  // à rang égal on retombe sur l'ordre d'insertion.
  state.tasks = tasks.slice().sort((a, b) => (Number(a["Rang"]) || 0) - (Number(b["Rang"]) || 0) || a._id - b._id);
}

// ============================ Vues ============================

const VIEW_META = {
  dashboard: ["Tableau de bord", "Votre activité en un coup d'œil"],
  articles: ["Articles & stock", "Catalogue, prix et niveaux de stock"],
  clients: ["Clients", "Coordonnées et identifiants de facturation"],
  projects: ["Projets", "Un projet par mission : tâches, avancement et facturation"],
  tasks: ["Tâches", "Liste, kanban et Gantt sur les mêmes tâches"],
  quotes: ["Devis", "Propositions commerciales, converties en un clic"],
  invoices: ["Factures", "Émission, encaissement et Factur-X"],
  settings: ["Société & conformité", "Mentions obligatoires et paramètres d'émission"],
};

function showView(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const [title, sub] = VIEW_META[view] || ["", ""];
  $("view-title").textContent = title;
  $("view-sub").textContent = sub;
  $("scroll").scrollTop = 0;
  renderTopActions();
  render();
}

function renderTopActions() {
  const actions = {
    articles: `<button class="btn primary" data-act="new-article">+ Article</button>`,
    clients: `<button class="btn primary" data-act="new-client">+ Client</button>`,
    projects: `<button class="btn primary" data-act="new-project">+ Projet</button>`,
    tasks: `<button class="btn primary" data-act="new-task">+ Tâche</button>`,
    quotes: `<button class="btn primary" data-act="new-quote">+ Devis</button>`,
    invoices: `<button class="btn primary" data-act="new-invoice">+ Facture</button>`,
    dashboard: `<button class="btn" data-act="new-quote">+ Devis</button><button class="btn primary" data-act="new-invoice">+ Facture</button>`,
    settings: "",
  };
  $("top-actions").innerHTML = actions[state.view] || "";
}

function render() {
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "articles") renderArticles();
  if (state.view === "clients") renderClients();
  if (state.view === "projects") renderProjects();
  if (state.view === "tasks") renderTasks();
  if (state.view === "quotes") renderQuotes();
  if (state.view === "invoices") renderInvoices();
  if (state.view === "settings") fillSettings();
}

// ---------- Tableau de bord ----------

function renderDashboard() {
  const month = today().slice(0, 7);
  const issued = state.invoices.filter((f) => f["Statut"] !== "Brouillon" && f["Statut"] !== "Annulée");
  const caMonth = issued.filter((f) => String(f["Date"]).startsWith(month)).reduce((s, f) => s + (Number(f["Total HT"]) || 0), 0);
  const due = issued.filter((f) => f["Statut"] !== "Payée").reduce((s, f) => s + ((Number(f["Total TTC"]) || 0) - (Number(f["Payé"]) || 0)), 0);
  const late = issued.filter((f) => f["Statut"] !== "Payée" && f["Échéance"] && f["Échéance"] < today());
  const pending = state.quotes.filter((d) => d["Statut"] === "Envoyé" || d["Statut"] === "Brouillon");
  const low = state.articles.filter((a) => a["Suivi stock"] && Number(a["Stock"]) <= Number(a["Stock alerte"] || 0));
  const openTasks = state.tasks.filter((t) => !taskDone(t));
  const lateTasks = openTasks.filter(taskLate);

  $("kpis").innerHTML = [
    { label: "CA HT du mois", value: money(caMonth), icon: "chart-line", tone: "good", sub: `${issued.filter((f) => String(f["Date"]).startsWith(month)).length} facture(s) émise(s)` },
    { label: "Encours client", value: money(due), icon: "wallet", sub: `${late.length} facture(s) en retard`, tone: late.length > 0 ? "alert" : "" },
    { label: "Devis en attente", value: String(pending.length), icon: "square-pen", sub: money(pending.reduce((s, d) => s + (Number(d["Total HT"]) || 0), 0)) },
    { label: "Tâches en retard", value: String(lateTasks.length), icon: "list-checks", sub: `${openTasks.length} tâche(s) ouverte(s) · ${state.projects.filter((p) => p["Statut"] === "En cours").length} projet(s) en cours`, tone: lateTasks.length > 0 ? "alert" : "" },
    { label: "Articles sous seuil", value: String(low.length), icon: "layout-grid", sub: `${state.articles.length} référence(s)`, tone: low.length > 0 ? "alert" : "" },
  ].map(kpi).join("");

  const rowsHtml = (rows, kind) => rows.slice(0, 6).map((r) => `
    <div class="list-row" data-open="${kind}" data-id="${r._id}">
      <div class="l-main"><div class="l-title">${esc(r["Numéro"])} · ${esc(r["Client"] || "—")}</div>
      <div class="l-sub">${dateFr(r["Date"])} — ${esc(r["Objet"] || "sans objet")}</div></div>
      ${statusBadge(r["Statut"])}<span class="l-amount">${money(r["Total TTC"])}</span>
    </div>`).join("") || `<div class="empty">Rien pour l'instant.</div>`;
  $("recent-quotes").innerHTML = rowsHtml(state.quotes, "quote");
  $("recent-invoices").innerHTML = rowsHtml(state.invoices, "invoice");

  const soon = openTasks
    .filter((t) => t["Échéance"])
    .sort((a, b) => String(a["Échéance"]).localeCompare(String(b["Échéance"])))
    .slice(0, 6);
  $("task-focus").innerHTML = soon.map((t) => `
    <div class="list-row" data-act="edit-task" data-id="${t._id}">
      <div class="l-main"><div class="l-title">${esc(t["Titre"])}</div>
      <div class="l-sub">${esc(t["Projet"] || "Sans projet")} — ${esc(t["Statut"] || "À faire")}</div></div>
      ${priorityBadge(t["Priorité"])}
      <span class="l-amount ${taskLate(t) ? "warn-txt" : ""}">${dateFr(t["Échéance"])}</span>
    </div>`).join("") || `<div class="empty">Aucune tâche datée en cours.</div>`;

  $("stock-alerts").innerHTML = low.length
    ? low.map((a) => `<div class="list-row" data-open="article" data-id="${a._id}">
        <div class="l-main"><div class="l-title">${esc(a["Désignation"])}</div><div class="l-sub">Réf. ${esc(a["Référence"])} — seuil ${qty(a["Stock alerte"])}</div></div>
        <span class="badge ${Number(a["Stock"]) <= 0 ? "bad" : "warn"}">${qty(a["Stock"])} ${esc(a["Unité"] || "")}</span></div>`).join("")
    : `<div class="empty">Aucun article sous son seuil d'alerte.</div>`;

  renderCompliance();
}

function renderCompliance() {
  const s = state.societe || {};
  const checks = [
    ["SIREN de l'émetteur", !!s["SIREN"], "Identifiant de routage du dispositif français : sans lui, aucune facture ne peut être adressée par une plateforme."],
    ["Adresse complète", !!(s["Adresse"] && s["Code postal"] && s["Ville"]), "Mention obligatoire sur toute facture."],
    ["TVA intracommunautaire", s["Régime TVA"] === "Franchise en base" || !!s["TVA intracom"], "Obligatoire hors franchise en base (art. 293 B du CGI)."],
    ["Pénalités de retard", Number(s["Taux pénalités"]) > 0, "Taux et indemnité forfaitaire de 40 € : mentions imposées par l'article L441-10 du code de commerce."],
    ["Plateforme (PDP)", !!s["Identifiant PDP"], "À partir du 1ᵉʳ septembre 2026, l'émission et la réception passent par une plateforme agréée."],
    ["Coordonnées bancaires", !!s["IBAN"], "L'IBAN alimente le bloc de paiement du XML (BT-84)."],
  ];
  $("compliance").innerHTML = `
    <p>Réforme française : depuis le <strong>1ᵉʳ septembre 2026</strong>, toute entreprise assujettie à la TVA doit pouvoir <strong>recevoir</strong> une facture électronique ; l'obligation d'<strong>émettre</strong> s'applique aux grandes entreprises et ETI à cette même date, puis aux PME et TPE au 1ᵉʳ septembre 2027. Lumen produit du Factur-X (PDF/A-3 + XML CII au profil EN 16931), l'un des formats du socle commun, et le XML CII exportable seul pour dépôt sur votre plateforme.</p>
    ${checks.map(([label, ok, why]) => `<div class="c-row"><span class="badge ${ok ? "ok" : "bad"}">${ok ? "OK" : "À faire"}</span><div><strong>${esc(label)}</strong><p>${esc(why)}</p></div></div>`).join("")}
    <p>Les factures et leurs pièces doivent être conservées <strong>10 ans</strong> (art. L123-22 c. com.). Exportez-les dans une sandbox dédiée et incluez-la dans vos sauvegardes.</p>`;
}

// ---------- Articles ----------

const tagCell = (row) => splitTags(row["Tags"]).map((t) => `<span class="tag-dot">${esc(t)}</span>`).join(" ") || "";


function renderArticles() {
  const q = $("article-search").value.trim().toLowerCase();
  const lowOnly = $("article-low").checked;
  const rows = state.articles.filter((a) => {
    const hay = `${a["Référence"]} ${a["Désignation"]} ${a["Catégorie"]} ${a["Tags"] || ""}`.toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (lowOnly && !(a["Suivi stock"] && Number(a["Stock"]) <= Number(a["Stock alerte"] || 0))) return false;
    return matchTagFilter("articles", a);
  });
  $("article-tagbar").innerHTML = tagBarHtml("articles");
  $("articles-table").innerHTML = `
    <thead><tr><th>Référence</th><th>Désignation</th><th>Catégorie</th><th>Tags</th><th class="num">Prix HT</th><th class="num">TVA</th><th class="num">Stock</th><th></th></tr></thead>
    <tbody>${rows.map((a) => {
      const tracked = !!a["Suivi stock"];
      const low = tracked && Number(a["Stock"]) <= Number(a["Stock alerte"] || 0);
      return `<tr>
        <td><code>${esc(a["Référence"])}</code></td>
        <td><strong>${esc(a["Désignation"])}</strong>${a["Actif"] === false || a["Actif"] === 0 ? ` <span class="badge">inactif</span>` : ""}</td>
        <td>${esc(a["Catégorie"] || "—")}</td>
        <td>${tagCell(a)}</td>
        <td class="num">${money(a["Prix HT"])}</td>
        <td class="num">${qty(a["TVA"])} %</td>
        <td class="num">${tracked ? `<span class="badge ${low ? (Number(a["Stock"]) <= 0 ? "bad" : "warn") : "ok"}">${qty(a["Stock"])} ${esc(a["Unité"] || "")}</span>` : `<span class="badge">non suivi</span>`}</td>
        <td><div class="row-actions">
          <button class="btn tiny ghost" data-act="stock-move" data-id="${a._id}">Stock</button>
          <button class="btn tiny ghost" data-act="edit-article" data-id="${a._id}">Modifier</button>
          <button class="btn tiny ghost danger" data-act="del-article" data-id="${a._id}">Suppr.</button>
        </div></td></tr>`;
    }).join("") || `<tr><td colspan="8"><div class="empty">Aucun article. Créez votre catalogue, ou demandez-le à l'assistant.</div></td></tr>`}</tbody>`;
}

// ---------- Clients ----------

function renderClients() {
  const q = $("client-search").value.trim().toLowerCase();
  const rows = state.clients.filter((c) => `${c["Nom"]} ${c["Ville"]} ${c["SIREN"]} ${c["Email"]} ${c["Tags"] || ""}`.toLowerCase().includes(q) && matchTagFilter("clients", c));
  $("client-tagbar").innerHTML = tagBarHtml("clients");
  $("clients-table").innerHTML = `
    <thead><tr><th>Client</th><th>Type</th><th>SIREN / SIRET</th><th>Ville</th><th>Tags</th><th>Contact</th><th class="num">Facturé HT</th><th></th></tr></thead>
    <tbody>${rows.map((c) => {
      const total = state.invoices.filter((f) => f["Client id"] === c._id && f["Statut"] !== "Brouillon" && f["Statut"] !== "Annulée")
        .reduce((s, f) => s + (Number(f["Total HT"]) || 0), 0);
      const missing = c["Type"] !== "Particulier" && !c["SIREN"];
      return `<tr>
        <td><div class="cell-id">${avatar(c["Nom"])}<div><strong>${esc(c["Nom"])}</strong>${c["Contact"] ? `<div class="mut">${esc(c["Contact"])}</div>` : ""}</div>${c["Code"] ? ` <span class="tag">${esc(c["Code"])}</span>` : ""}</div></td>
        <td>${esc(c["Type"] || "Entreprise")}</td>
        <td>${missing ? `<span class="badge bad">SIREN manquant</span>` : `<code>${esc(c["SIRET"] || c["SIREN"] || "—")}</code>`}</td>
        <td>${esc(c["Ville"] || "—")}</td>
        <td>${tagCell(c)}</td>
        <td>${esc(c["Email"] || c["Téléphone"] || "—")}</td>
        <td class="num">${money(total)}</td>
        <td><div class="row-actions">
          <button class="btn tiny ghost" data-act="new-quote" data-client="${c._id}">Devis</button>
          <button class="btn tiny ghost" data-act="edit-client" data-id="${c._id}">Modifier</button>
          <button class="btn tiny ghost danger" data-act="del-client" data-id="${c._id}">Suppr.</button>
        </div></td></tr>`;
    }).join("") || `<tr><td colspan="8"><div class="empty">Aucun client enregistré.</div></td></tr>`}</tbody>`;
}

// ---------- Projets & tâches ----------
//
// Un projet regroupe des tâches ET les documents commerciaux qui les paient :
// c'est le même écran qui répond à « où en est le chantier ? » et à « combien
// en a-t-on déjà facturé ? ». Les trois vues (liste, kanban, Gantt) lisent les
// MÊMES lignes de la table « Tâches » — changer de vue ne change pas la donnée,
// seulement la façon de la regarder.

const projectClient = (project) => state.clients.find((c) => c._id === project["Client id"])
  || state.clients.find((c) => c["Nom"] === project["Client"]) || null;

const projectById = (id) => state.projects.find((p) => p._id === Number(id)) || null;
const tasksOf = (project) => state.tasks.filter((t) => t["Projet id"] === project._id);
const taskDone = (t) => t["Statut"] === "Terminé";
const taskLate = (t) => !taskDone(t) && t["Échéance"] && t["Échéance"] < today();

/** Avancement d'un projet : moyenne des avancements, une tâche terminée valant 100. */
function projectProgress(project) {
  const rows = tasksOf(project);
  if (!rows.length) return Number(project["Avancement"]) || 0;
  const sum = rows.reduce((s, t) => s + (taskDone(t) ? 100 : Number(t["Avancement"]) || 0), 0);
  return Math.round(sum / rows.length);
}

/** Devis et factures rattachés à un projet (par identifiant, pas par nom). */
const docsOfProject = (project) => ({
  quotes: state.quotes.filter((d) => d["Projet id"] === project._id),
  invoices: state.invoices.filter((f) => f["Projet id"] === project._id),
});

function projectStats(project) {
  const rows = tasksOf(project);
  const { quotes, invoices } = docsOfProject(project);
  const billed = invoices.filter((f) => f["Statut"] !== "Brouillon" && f["Statut"] !== "Annulée");
  return {
    tasks: rows.length,
    done: rows.filter(taskDone).length,
    late: rows.filter(taskLate).length,
    progress: projectProgress(project),
    estimated: rows.reduce((s, t) => s + (Number(t["Estimé h"]) || 0), 0),
    spent: rows.reduce((s, t) => s + (Number(t["Passé h"]) || 0), 0),
    quotes: quotes.length,
    quotesHt: quotes.reduce((s, d) => s + (Number(d["Total HT"]) || 0), 0),
    invoicedHt: billed.reduce((s, f) => s + (Number(f["Total HT"]) || 0), 0),
    dueTtc: billed.filter((f) => f["Statut"] !== "Payée").reduce((s, f) => s + ((Number(f["Total TTC"]) || 0) - (Number(f["Payé"]) || 0)), 0),
    billable: rows.filter((t) => t["Facturable"] && !t["Facturé"]),
  };
}

const progressBar = (pct, cls = "") => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, Math.round(pct)))}%"></span></div>`;

function renderProjects() {
  const q = $("project-search").value.trim().toLowerCase();
  const status = $("project-status").value;
  const rows = state.projects.filter((p) => (!status || p["Statut"] === status)
    && `${p["Nom"]} ${p["Client"] || ""} ${p["Tags"] || ""}`.toLowerCase().includes(q)
    && matchTagFilter("projects", p));
  $("project-tagbar").innerHTML = tagBarHtml("projects");
  $("projects-grid").innerHTML = rows.map((p) => {
    const st = projectStats(p);
    const budget = Number(p["Budget"]) || 0;
    return `<article class="project-card" data-open="project" data-id="${p._id}">
      <div class="p-head">
        <div><div class="p-name">${esc(p["Nom"])}</div><div class="p-client">${esc(p["Client"] || "Sans client")}</div></div>
        ${statusBadge(p["Statut"])}
      </div>
      ${progressBar(st.progress)}
      <div class="p-meta">
        <span>${st.done}/${st.tasks} tâche(s)</span>
        ${st.late ? `<span class="warn-txt">${st.late} en retard</span>` : ""}
        <span>${qty(st.spent)} h / ${qty(st.estimated)} h</span>
      </div>
      <div class="p-dates">${dateFr(p["Début"])} → ${dateFr(p["Fin"])}</div>
      <div class="p-money">
        <span>Facturé <strong>${money(st.invoicedHt)}</strong>${budget ? ` / ${money(budget)}` : ""}</span>
        ${st.dueTtc ? `<span class="warn-txt">Reste dû ${money(st.dueTtc)}</span>` : ""}
      </div>
      ${tagCell(p)}
    </article>`;
  }).join("") || `<div class="empty">Aucun projet. Créez-en un pour suivre vos tâches et ce qu'elles rapportent.</div>`;
}

// --- Tâches : filtre commun aux trois vues ---

function filteredTasks() {
  const q = $("task-search").value.trim().toLowerCase();
  const project = $("task-project").value;
  const status = $("task-status").value;
  const late = $("task-late").checked;
  return state.tasks.filter((t) => {
    if (project && String(t["Projet id"] || "") !== project) return false;
    if (status && t["Statut"] !== status) return false;
    if (late && !taskLate(t)) return false;
    if (q && !`${t["Titre"]} ${t["Projet"] || ""} ${t["Assigné"] || ""} ${t["Tags"] || ""}`.toLowerCase().includes(q)) return false;
    return matchTagFilter("tasks", t);
  });
}

function fillTaskProjectFilter() {
  const sel = $("task-project");
  const current = sel.value;
  sel.innerHTML = `<option value="">Tous les projets</option>`
    + state.projects.map((p) => `<option value="${p._id}">${esc(p["Nom"])}</option>`).join("");
  sel.value = current;
}

function renderTasks() {
  fillTaskProjectFilter();
  $("task-tagbar").innerHTML = tagBarHtml("tasks");
  document.querySelectorAll("#task-mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.taskMode));
  const rows = filteredTasks();
  const host = $("tasks-host");
  if (state.taskMode === "kanban") host.innerHTML = taskKanbanHtml(rows);
  else if (state.taskMode === "gantt") host.innerHTML = taskGanttHtml(rows);
  else host.innerHTML = taskListHtml(rows);
}

const priorityBadge = (p) => `<span class="badge ${p === "Urgente" ? "bad" : p === "Haute" ? "warn" : ""}">${esc(p || "Normale")}</span>`;

function taskListHtml(rows) {
  return `<div class="card table-card"><table class="grid">
    <thead><tr><th></th><th>Tâche</th><th>Projet</th><th>Assigné</th><th>Échéance</th><th>Priorité</th><th>Statut</th><th class="num">Avancement</th><th class="num">h</th><th></th></tr></thead>
    <tbody>${rows.map((t) => `<tr class="${taskDone(t) ? "done" : ""}">
      <td><input type="checkbox" class="task-check" data-task-done="${t._id}" ${taskDone(t) ? "checked" : ""} /></td>
      <td><strong>${esc(t["Titre"])}</strong>${t["Facturé"] ? ` <span class="badge ok">${esc(t["Facturé"])}</span>` : t["Facturable"] ? ` <span class="badge">à facturer</span>` : ""} ${tagCell(t)}</td>
      <td>${esc(t["Projet"] || "—")}</td>
      <td>${esc(t["Assigné"] || "—")}</td>
      <td>${taskLate(t) ? `<span class="badge bad">${dateFr(t["Échéance"])}</span>` : dateFr(t["Échéance"])}</td>
      <td>${priorityBadge(t["Priorité"])}</td>
      <td>${statusBadge(t["Statut"] || "À faire")}</td>
      <td class="num" style="min-width:110px">${progressBar(taskDone(t) ? 100 : t["Avancement"])}</td>
      <td class="num">${qty(t["Passé h"])} / ${qty(t["Estimé h"])}</td>
      <td><div class="row-actions">
        <button class="btn tiny ghost" data-act="edit-task" data-id="${t._id}">Modifier</button>
        <button class="btn tiny ghost" data-act="log-time" data-id="${t._id}">+ Temps</button>
        <button class="btn tiny ghost danger" data-act="del-task" data-id="${t._id}">Suppr.</button>
      </div></td></tr>`).join("") || `<tr><td colspan="10"><div class="empty">Aucune tâche.</div></td></tr>`}</tbody></table></div>`;
}

function taskKanbanHtml(rows) {
  return `<div class="kanban">${TASK_STATUS.map((col) => {
    const cards = rows.filter((t) => (t["Statut"] || "À faire") === col);
    const hours = cards.reduce((s, t) => s + (Number(t["Estimé h"]) || 0), 0);
    return `<section class="k-col" data-col="${esc(col)}">
      <header class="k-head"><span>${esc(col)}</span><span class="badge">${cards.length}${hours ? ` · ${qty(hours)} h` : ""}</span></header>
      <div class="k-body">${cards.map((t) => `
        <article class="k-card" draggable="true" data-task="${t._id}">
          <div class="k-title">${esc(t["Titre"])}</div>
          <div class="k-sub">${esc(t["Projet"] || "Sans projet")}</div>
          ${progressBar(taskDone(t) ? 100 : t["Avancement"])}
          <div class="k-foot">
            ${priorityBadge(t["Priorité"])}
            ${t["Échéance"] ? `<span class="${taskLate(t) ? "warn-txt" : "mut"}">${dateFr(t["Échéance"])}</span>` : ""}
            ${t["Assigné"] ? `<span class="mut">${esc(t["Assigné"])}</span>` : ""}
          </div>
        </article>`).join("") || `<div class="k-empty">Déposez une tâche ici</div>`}</div>
    </section>`;
  }).join("")}</div>`;
}

/**
 * Gantt maison plutôt qu'une dépendance : une barre par tâche, positionnée en
 * pourcentage sur la fenêtre couverte par l'ensemble des tâches. Une tâche sans
 * date de début part de son échéance (durée d'un jour) — sinon elle disparaît
 * du planning au lieu d'y sauter aux yeux.
 */
function taskGanttHtml(rows) {
  const span = (t) => {
    const end = t["Échéance"] || t["Début"];
    const start = t["Début"] || t["Échéance"];
    return start && end ? { start: start < end ? start : end, end: end > start ? end : start } : null;
  };
  const dated = rows.filter((t) => span(t));
  if (!dated.length) return `<div class="card"><div class="empty">Aucune tâche datée : renseignez un début et une échéance pour les voir sur le planning.</div></div>`;
  const day = 86400000;
  const min = dated.reduce((m, t) => (span(t).start < m ? span(t).start : m), span(dated[0]).start);
  const max = dated.reduce((m, t) => (span(t).end > m ? span(t).end : m), span(dated[0]).end);
  const t0 = new Date(min).getTime() - day;
  const t1 = new Date(max).getTime() + day;
  const total = Math.max(day, t1 - t0);
  const pct = (iso) => ((new Date(iso).getTime() - t0) / total) * 100;

  // Graduation : un repère par semaine tant que la fenêtre reste courte,
  // un par mois au-delà — au-delà de ~20 repères l'échelle devient illisible.
  const weeks = total / (7 * day);
  const marks = [];
  const cur = new Date(t0);
  if (weeks <= 20) {
    cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
    while (cur.getTime() < t1) {
      const iso = cur.toISOString().slice(0, 10);
      if (cur.getTime() > t0) marks.push([pct(iso), cur.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })]);
      cur.setDate(cur.getDate() + 7);
    }
  } else {
    cur.setDate(1);
    while (cur.getTime() < t1) {
      const iso = cur.toISOString().slice(0, 10);
      if (cur.getTime() > t0) marks.push([pct(iso), cur.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" })]);
      cur.setMonth(cur.getMonth() + 1);
    }
  }
  const nowPct = pct(today());
  const grid = `${marks.map(([x]) => `<span class="g-line" style="left:${x}%"></span>`).join("")}${nowPct >= 0 && nowPct <= 100 ? `<span class="g-today" style="left:${nowPct}%"></span>` : ""}`;

  // Regroupement par projet : le planning se lit chantier par chantier.
  const groups = new Map();
  for (const t of dated) {
    const key = t["Projet"] || "Sans projet";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const rowsHtml = [...groups.entries()].map(([name, list]) => `
    <div class="g-group"><div class="g-label g-group-name">${esc(name)}</div><div class="g-track">${grid}</div></div>
    ${list.sort((a, b) => span(a).start.localeCompare(span(b).start)).map((t) => {
      const s = span(t);
      const left = pct(s.start);
      const width = Math.max(1.2, pct(s.end) - left);
      const cls = taskDone(t) ? "done" : taskLate(t) ? "late" : "";
      return `<div class="g-row" data-act="edit-task" data-id="${t._id}">
        <div class="g-label">${esc(t["Titre"])}</div>
        <div class="g-track">${grid}
          <span class="g-bar ${cls}" style="left:${left}%;width:${width}%" title="${esc(t["Titre"])} — ${dateFr(s.start)} → ${dateFr(s.end)}">
            <span class="g-fill" style="width:${taskDone(t) ? 100 : Math.max(0, Math.min(100, Number(t["Avancement"]) || 0))}%"></span>
            <span class="g-bar-txt">${esc(t["Titre"])}</span>
          </span>
        </div>
      </div>`;
    }).join("")}`).join("");

  return `<div class="card gantt">
    <div class="g-row g-scale"><div class="g-label"></div><div class="g-track">${grid}${marks.map(([x, label]) => `<span class="g-mark" style="left:${x}%">${esc(label)}</span>`).join("")}</div></div>
    ${rowsHtml}
  </div>`;
}

// --- Actions sur les tâches ---

async function setTaskStatus(task, status) {
  const patch = { "Statut": status };
  if (status === "Terminé") patch["Avancement"] = 100;
  else if (Number(task["Avancement"]) >= 100) patch["Avancement"] = 50;
  await store.update("taches", task._id, patch);
  await reload();
  render();
}

/** Pointage de temps : le suivi ne vaut que s'il coûte trois secondes. */
async function logTime(task) {
  const raw = await promptSheet({
    title: `Temps passé sur « ${task["Titre"]} »`,
    body: `Déjà pointé : ${qty(task["Passé h"])} h.`,
    value: "1", type: "number", confirm: "Pointer",
  });
  if (raw === null) return;
  const h = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(h) || h === 0) return;
  const total = Math.max(0, (Number(task["Passé h"]) || 0) + h);
  await store.update("taches", task._id, { "Passé h": total });
  await reload();
  render();
  toast(`${qty(total)} h pointées sur « ${task["Titre"]} ».`);
}

/** Réordonne les tâches d'une colonne après un dépôt (rang = ordre affiché). */
async function reorderTasks(ids) {
  let rang = 1;
  for (const id of ids) {
    const task = state.tasks.find((t) => t._id === id);
    if (task) await store.update("taches", task._id, { "Rang": rang });
    rang += 1;
  }
}

// --- Facturation des tâches ---

/**
 * Transforme les tâches facturables et non encore facturées d'un projet en un
 * devis : une ligne par tâche, en heures au taux du projet. Les tâches portent
 * ensuite le numéro du devis — la garde qui empêche de facturer deux fois.
 */
async function quoteFromTasks(project) {
  const st = projectStats(project);
  const rate = Number(project["Taux horaire"]) || 0;
  if (!st.billable.length) { toast("Aucune tâche facturable en attente sur ce projet."); return null; }
  if (!rate) { toast("Renseignez le taux horaire du projet avant de facturer ses tâches."); return null; }
  const client = projectClient(project);
  if (!client) { toast("Rattachez ce projet à un client pour le facturer."); return null; }
  const number = nextNumber("quote");
  const lines = st.billable.map((t) => {
    const hours = Number(t["Passé h"]) || Number(t["Estimé h"]) || 0;
    return {
      "Référence": "", "Désignation": t["Titre"], "Quantité": hours, "Unité": "heure",
      "Prix HT": rate, "Remise": 0, "TVA": 20, "Total HT": hours * rate,
    };
  }).filter((l) => l["Quantité"] > 0);
  if (!lines.length) { toast("Les tâches facturables n'ont ni temps passé ni temps estimé."); return null; }
  const totals = fx.computeTotals(lines, 0);
  await store.insert("devis", {
    "Numéro": number, "Date": today(), "Validité": addDays(today(), 30),
    "Client": client["Nom"], "Client id": client._id, "Statut": "Brouillon",
    "Objet": `Prestations — ${project["Nom"]}`, "Remise": 0,
    "Total HT": totals.totalHt, "Total TVA": totals.totalTva, "Total TTC": totals.totalTtc,
    "Projet": project["Nom"], "Projet id": project._id,
    "Tags": project["Tags"] || "", "Notes": "",
  });
  await store.replaceLines("lignesDevis", number, lines);
  for (const t of st.billable) await store.update("taches", t._id, { "Facturé": number });
  await reload();
  render();
  toast(`Devis ${number} créé depuis ${lines.length} tâche(s) — ${money(totals.totalHt)} HT.`);
  return number;
}

// --- Fiche projet (détail) ---

let projectCtx = null;

function openProject(project) {
  projectCtx = project;
  const st = projectStats(project);
  const { quotes, invoices } = docsOfProject(project);
  $("project-title").textContent = project["Nom"];
  $("project-client").textContent = project["Client"] || "Sans client";
  const docRow = (r, kind) => `<div class="list-row" data-open="${kind}" data-id="${r._id}">
    <div class="l-main"><div class="l-title">${esc(r["Numéro"])}</div><div class="l-sub">${dateFr(r["Date"])} — ${esc(r["Objet"] || "sans objet")}</div></div>
    ${statusBadge(r["Statut"])}<span class="l-amount">${money(r["Total TTC"])}</span></div>`;
  $("project-body").innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><span class="k-label">Avancement</span><span class="k-value">${st.progress} %</span><span class="k-sub">${st.done}/${st.tasks} tâche(s)</span></div>
      <div class="kpi ${st.late ? "alert" : ""}"><span class="k-label">En retard</span><span class="k-value">${st.late}</span><span class="k-sub">échéance dépassée</span></div>
      <div class="kpi"><span class="k-label">Temps</span><span class="k-value">${qty(st.spent)} h</span><span class="k-sub">estimé ${qty(st.estimated)} h</span></div>
      <div class="kpi"><span class="k-label">Facturé HT</span><span class="k-value">${money(st.invoicedHt)}</span><span class="k-sub">${Number(project["Budget"]) ? `budget ${money(project["Budget"])}` : "sans budget"}</span></div>
      <div class="kpi ${st.dueTtc ? "alert" : ""}"><span class="k-label">Reste dû</span><span class="k-value">${money(st.dueTtc)}</span><span class="k-sub">${invoices.length} facture(s)</span></div>
    </div>
    <div class="two-col">
      <section class="card"><div class="card-head"><h2>Devis</h2><span class="badge">${money(st.quotesHt)} HT</span></div>
        <div class="list">${quotes.map((d) => docRow(d, "quote")).join("") || `<div class="empty">Aucun devis lié.</div>`}</div></section>
      <section class="card"><div class="card-head"><h2>Factures</h2><span class="badge">${money(st.invoicedHt)} HT</span></div>
        <div class="list">${invoices.map((f) => docRow(f, "invoice")).join("") || `<div class="empty">Aucune facture liée.</div>`}</div></section>
    </div>
    <section class="card"><div class="card-head"><h2>Tâches facturables en attente</h2><span class="badge">${st.billable.length}</span></div>
      <div class="list">${st.billable.map((t) => `<div class="list-row" data-act="edit-task" data-id="${t._id}">
        <div class="l-main"><div class="l-title">${esc(t["Titre"])}</div><div class="l-sub">${esc(t["Statut"] || "À faire")} — ${qty(Number(t["Passé h"]) || Number(t["Estimé h"]) || 0)} h</div></div>
        <span class="l-amount">${money((Number(t["Passé h"]) || Number(t["Estimé h"]) || 0) * (Number(project["Taux horaire"]) || 0))}</span></div>`).join("")
        || `<div class="empty">Rien à facturer : cochez « Facturable » sur les tâches concernées.</div>`}</div></section>`;
  $("project-actions").innerHTML = `
    <button class="btn ghost" data-project="tasks">Voir les tâches</button>
    <button class="btn ghost" data-project="new-task">+ Tâche</button>
    <button class="btn" data-project="quote">Devis depuis les tâches</button>
    <span class="spacer"></span>
    <button class="btn ghost" data-project="edit">Modifier</button>
    <button class="btn primary" data-close>Fermer</button>`;
  $("project-modal").hidden = false;
}

// ---------- Devis & factures ----------

function renderQuotes() {
  const q = $("quote-search").value.trim().toLowerCase();
  const status = $("quote-status").value;
  const rows = state.quotes.filter((d) => (!status || d["Statut"] === status)
    && `${d["Numéro"]} ${d["Client"]} ${d["Objet"]} ${d["Tags"] || ""}`.toLowerCase().includes(q)
    && matchTagFilter("quotes", d));
  $("quote-tagbar").innerHTML = tagBarHtml("quotes");
  $("quotes-table").innerHTML = `
    <thead><tr><th>Numéro</th><th>Date</th><th>Client</th><th>Objet</th><th>Statut</th><th class="num">Total HT</th><th class="num">TTC</th><th></th></tr></thead>
    <tbody>${rows.map((d) => `<tr>
      <td><strong>${esc(d["Numéro"])}</strong></td><td>${dateFr(d["Date"])}</td>
      <td>${esc(d["Client"] || "—")}</td><td>${esc(d["Objet"] || "—")} ${tagCell(d)}</td>
      <td>${statusBadge(d["Statut"])}${d["Facture"] ? ` <span class="badge ok">${esc(d["Facture"])}</span>` : ""}</td>
      <td class="num">${money(d["Total HT"])}</td><td class="num">${money(d["Total TTC"])}</td>
      <td><div class="row-actions">
        <button class="btn tiny ghost" data-act="open-quote" data-id="${d._id}">Ouvrir</button>
        ${d["Facture"] ? "" : `<button class="btn tiny" data-act="convert" data-id="${d._id}">→ Facture</button>`}
        <button class="btn tiny ghost danger" data-act="del-quote" data-id="${d._id}">Suppr.</button>
      </div></td></tr>`).join("") || `<tr><td colspan="8"><div class="empty">Aucun devis.</div></td></tr>`}</tbody>`;
}

function renderInvoices() {
  const q = $("invoice-search").value.trim().toLowerCase();
  const status = $("invoice-status").value;
  const rows = state.invoices.filter((f) => (!status || f["Statut"] === status)
    && `${f["Numéro"]} ${f["Client"]} ${f["Objet"]} ${f["Tags"] || ""}`.toLowerCase().includes(q)
    && matchTagFilter("invoices", f));
  $("invoice-tagbar").innerHTML = tagBarHtml("invoices");
  $("invoices-table").innerHTML = `
    <thead><tr><th>Numéro</th><th>Date</th><th>Échéance</th><th>Client</th><th>Statut</th><th class="num">Total HT</th><th class="num">TTC</th><th class="num">Reste dû</th><th></th></tr></thead>
    <tbody>${rows.map((f) => {
      const rest = (Number(f["Total TTC"]) || 0) - (Number(f["Payé"]) || 0);
      const late = f["Statut"] !== "Payée" && f["Échéance"] && f["Échéance"] < today() && f["Statut"] !== "Brouillon";
      return `<tr>
      <td><strong>${esc(f["Numéro"])}</strong>${f["Type"] === "Avoir" ? ` <span class="badge">avoir</span>` : ""}</td>
      <td>${dateFr(f["Date"])}</td>
      <td>${late ? `<span class="badge bad">${dateFr(f["Échéance"])}</span>` : dateFr(f["Échéance"])}</td>
      <td>${esc(f["Client"] || "—")} ${tagCell(f)}</td><td>${statusBadge(f["Statut"])}</td>
      <td class="num">${money(f["Total HT"])}</td><td class="num">${money(f["Total TTC"])}</td>
      <td class="num">${money(rest)}</td>
      <td><div class="row-actions">
        <button class="btn tiny ghost" data-act="open-invoice" data-id="${f._id}">Ouvrir</button>
        <button class="btn tiny" data-act="export" data-id="${f._id}">Factur-X</button>
      </div></td></tr>`;
    }).join("") || `<tr><td colspan="9"><div class="empty">Aucune facture.</div></td></tr>`}</tbody>`;
}

// ---------- Réglages ----------

function fillSettings() {
  const form = $("settings-form");
  const s = state.societe || {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") el.checked = !!s[el.name];
    else el.value = s[el.name] ?? "";
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const form = $("settings-form");
  const values = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    values[el.name] = el.type === "checkbox" ? el.checked : (el.type === "number" ? Number(el.value) || 0 : el.value);
  }
  await store.update("societe", state.societe._id, values);
  await reload();
  $("settings-status").textContent = "Enregistré ✓";
  setTimeout(() => { $("settings-status").textContent = ""; }, 2500);
  renderCompliance();
}

// ============================ Fiches article / client ============================

const ARTICLE_FIELDS = [
  ["Référence", "text", true], ["Désignation", "text", true], ["Catégorie", "autocomplete"],
  ["Tags", "tags"], ["Description", "textarea"], ["Unité", "select", false, UNITS], ["Prix HT", "number"],
  ["TVA", "select", false, VAT_RATES.map(String)], ["Coût achat", "number"],
  ["Stock", "number"], ["Stock alerte", "number"], ["Suivi stock", "bool"], ["Actif", "bool"],
];

const CLIENT_FIELDS = [
  ["Nom", "text", true], ["Code", "text"], ["Type", "select", false, ["Entreprise", "Administration", "Particulier"]],
  ["SIREN", "text"], ["SIRET", "text"], ["TVA intracom", "text"], ["Contact", "text"],
  ["Email", "text"], ["Téléphone", "text"], ["Adresse", "text"], ["Code postal", "text"],
  ["Ville", "text"], ["Pays", "text"], ["Adresse livraison", "text"],
  ["Référence acheteur", "text"], ["Code routage", "text"], ["Conditions paiement", "text"],
  ["Tags", "tags"], ["Notes", "textarea"],
];

// Les champs projet/tâche dépendent de l'existant (liste des clients, des
// projets) : ils sont donc calculés à l'ouverture, pas figés dans une constante.
const PROJECT_FIELDS = () => [
  ["Nom", "text", true], ["Client", "select", false, ["", ...state.clients.map((c) => c["Nom"])]],
  ["Statut", "select", false, PROJECT_STATUS], ["Début", "date"], ["Fin", "date"],
  ["Budget", "number"], ["Taux horaire", "number"], ["Avancement", "number"],
  ["Tags", "tags"], ["Notes", "textarea"],
];

const TASK_FIELDS = () => [
  ["Titre", "text", true], ["Projet", "select", false, ["", ...state.projects.map((p) => p["Nom"])]],
  ["Statut", "select", false, TASK_STATUS], ["Priorité", "select", false, TASK_PRIORITY],
  ["Assigné", "text"], ["Début", "date"], ["Échéance", "date"],
  ["Estimé h", "number"], ["Passé h", "number"], ["Avancement", "number"],
  ["Facturable", "bool"], ["Tags", "tags"], ["Notes", "textarea"],
];

// Valeurs proposées à la création, par nom de champ.
const RECORD_DEFAULTS = { "Pays": "FR", "Unité": "unité", "TVA": "20", "Statut": "", "Priorité": "Normale" };

// kind → libellé, champs, tags proposés, et résolution des liens par nom.
const RECORD_DEFS = {
  articles: { label: "article", fields: () => ARTICLE_FIELDS, tags: ["articles"] },
  clients: { label: "client", fields: () => CLIENT_FIELDS, tags: ["clients"] },
  projets: {
    label: "projet", fields: PROJECT_FIELDS, tags: ["projects"],
    link: (v) => { v["Client id"] = state.clients.find((c) => c["Nom"] === v["Client"])?._id ?? null; },
  },
  taches: {
    label: "tâche", fields: TASK_FIELDS, tags: ["tasks"],
    link: (v, row) => {
      v["Projet id"] = state.projects.find((p) => p["Nom"] === v["Projet"])?._id ?? null;
      if (v["Statut"] === "Terminé") v["Avancement"] = 100;
      // Une tâche créée se pose en fin de colonne, pas en tête.
      if (!row) v["Rang"] = state.tasks.length + 1;
    },
  },
};

let recordCtx = null;

function openRecord(kind, row) {
  recordCtx = { kind, row };
  const def = RECORD_DEFS[kind];
  const fields = def.fields();
  const feminine = kind === "taches";
  $("record-title").textContent = `${row ? "Modifier" : feminine ? "Nouvelle" : "Nouveau"} ${def.label}`;
  $("record-form").innerHTML = `<div class="form-grid">${fields.map(([name, type, required, options]) => {
    const value = row?.[name] ?? RECORD_DEFAULTS[name] ?? "";
    const wide = type === "textarea" ? " wide" : "";
    if (type === "bool") return `<label class="check-field"><input type="checkbox" name="${esc(name)}" ${(row ? row[name] : true) ? "checked" : ""} /> ${esc(name)}</label>`;
    if (type === "tags") return `<label class="wide">${esc(name)}${tagsFieldHtml(splitTags(value), "dl-record-tags", knownTags(def.tags))}</label>`;
    if (type === "date") return `<label>${esc(name)}<input name="${esc(name)}" type="date" value="${esc(value)}" /></label>`;
    if (type === "autocomplete") return `<label>${esc(name)}<input name="${esc(name)}" list="dl-record-${esc(name.toLowerCase())}" autocomplete="off" value="${esc(value)}" />${datalistHtml(`dl-record-${esc(name.toLowerCase())}`, knownCategories())}</label>`;
    if (type === "textarea") return `<label class="${wide.trim()}">${esc(name)}<textarea name="${esc(name)}" rows="2">${esc(value)}</textarea></label>`;
    if (type === "select") return `<label>${esc(name)}<select name="${esc(name)}">${options.map((o) => `<option ${String(value) === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
    return `<label>${esc(name)}<input name="${esc(name)}" type="${type === "number" ? "number" : "text"}" step="0.01" ${required ? "required" : ""} value="${esc(value)}" /></label>`;
  }).join("")}</div>`;
  $("record-modal").hidden = false;
}

async function saveRecord() {
  const { kind, row } = recordCtx;
  const def = RECORD_DEFS[kind];
  const fields = def.fields();
  const form = $("record-form");
  const values = {};
  for (const [name, type] of fields) {
    if (type === "tags") { values[name] = readTagsField(form.querySelector(".tags-field")); continue; }
    const el = form.elements[name];
    if (!el) continue;
    values[name] = type === "bool" ? el.checked : type === "number" || (type === "select" && name === "TVA") ? Number(el.value) || 0 : el.value;
  }
  if (!values[fields[0][0]]) { toast("Le premier champ est obligatoire."); return; }
  def.link?.(values, row);
  if (row) await store.update(kind, row._id, values);
  else await store.insert(kind, values);
  $("record-modal").hidden = true;
  await reload();
  render();
  toast(row ? "Fiche mise à jour." : "Fiche créée.");
}

/** Entrée/sortie de stock manuelle (réception fournisseur, casse, inventaire). */
async function stockMove(article) {
  const raw = await promptSheet({
    title: `Mouvement de stock — ${article["Désignation"]}`,
    body: `Stock actuel : ${qty(article["Stock"])}. Une quantité négative est une sortie.`,
    value: "1", type: "number", confirm: "Enregistrer",
  });
  if (raw === null) return;
  const delta = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(delta) || delta === 0) return;
  const reason = (await promptSheet({
    title: "Motif du mouvement",
    placeholder: "Réception, inventaire, casse…",
    value: delta > 0 ? "Réception" : "Sortie",
  })) || "";
  const after = (Number(article["Stock"]) || 0) + delta;
  await store.update("articles", article._id, { "Stock": after });
  await store.insert("stock", {
    "Date": today(), "Référence": article["Référence"], "Désignation": article["Désignation"],
    "Sens": delta > 0 ? "Entrée" : "Sortie", "Quantité": Math.abs(delta), "Stock après": after,
    "Motif": reason, "Document": "",
  });
  await reload();
  render();
  toast(`Stock de ${article["Référence"]} : ${qty(after)}.`);
}

// ============================ Éditeur de document ============================

function blankLine(article) {
  return {
    "Référence": article?.["Référence"] || "",
    "Désignation": article?.["Désignation"] || "",
    "Quantité": 1,
    "Unité": article?.["Unité"] || "unité",
    "Prix HT": Number(article?.["Prix HT"]) || 0,
    "Remise": 0,
    "TVA": article ? Number(article["TVA"]) || 0 : 20,
  };
}

function openDoc(kind, row, presetClientId) {
  const isQuote = kind === "quote";
  state.doc = {
    kind,
    row: row || null,
    head: row ? { ...row } : {
      "Numéro": nextNumber(kind),
      "Date": today(),
      [isQuote ? "Validité" : "Échéance"]: addDays(today(), 30),
      "Client id": presetClientId || state.clients[0]?._id || null,
      "Projet id": null,
      "Statut": "Brouillon",
      "Objet": "",
      "Remise": 0,
      "Type": isQuote ? undefined : "Facture",
      "Nature opération": isQuote ? undefined : "Prestation de services",
      "Payé": isQuote ? undefined : 0,
      "Profil Factur-X": state.societe?.["Profil Factur-X"] || "EN 16931",
      "TVA sur les débits": state.societe?.["TVA sur les débits"] || false,
    },
    lines: [],
  };
  $("doc-title").textContent = isQuote ? "Devis" : (row?.["Type"] === "Avoir" ? "Avoir" : "Facture");
  $("doc-number").textContent = state.doc.head["Numéro"];
  $("doc-notes").value = row?.["Notes"] || "";
  $("doc-modal").hidden = false;
  renderDocHead();
  const lineKey = isQuote ? "lignesDevis" : "lignesFactures";
  (row ? store.linesOf(lineKey, row["Numéro"]) : Promise.resolve([])).then((lines) => {
    state.doc.lines = lines.map((l) => ({ ...l }));
    renderDocLines();
  });
}

function renderDocHead() {
  const d = state.doc;
  const isQuote = d.kind === "quote";
  const clientOptions = state.clients.map((c) => `<option value="${c._id}" ${c._id === d.head["Client id"] ? "selected" : ""}>${esc(c["Nom"])}</option>`).join("");
  const sel = (name, values, current) => `<select data-head="${name}">${values.map((v) => `<option ${String(current) === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
  $("doc-head").innerHTML = `
    <label>Client<select data-head="Client id">${clientOptions || `<option value="">Aucun client — créez-en un</option>`}</select></label>
    <label>Date<input type="date" data-head="Date" value="${esc(d.head["Date"] || today())}" /></label>
    <label>${isQuote ? "Valable jusqu'au" : "Échéance"}<input type="date" data-head="${isQuote ? "Validité" : "Échéance"}" value="${esc(d.head[isQuote ? "Validité" : "Échéance"] || "")}" /></label>
    <label>Objet<input data-head="Objet" value="${esc(d.head["Objet"] || "")}" placeholder="Prestation, chantier, commande…" /></label>
    ${state.projects.length ? `<label>Projet<select data-head="Projet id"><option value="">Aucun projet</option>${state.projects.map((p) => `<option value="${p._id}" ${p._id === d.head["Projet id"] ? "selected" : ""}>${esc(p["Nom"])}</option>`).join("")}</select></label>` : ""}
    <label class="wide">Tags${tagsFieldHtml(splitTags(d.head["Tags"]), "dl-doc-tags", knownTags(["quotes", "invoices"]))}</label>
    <label>Statut${sel("Statut", isQuote ? QUOTE_STATUS : INVOICE_STATUS, d.head["Statut"])}</label>
    <label>Remise globale (%)<input type="number" step="0.01" min="0" max="100" data-head="Remise" value="${esc(d.head["Remise"] || 0)}" /></label>
    ${isQuote ? "" : `
    <label>Type de document${sel("Type", Object.keys(fx.DOC_TYPES), d.head["Type"])}</label>
    <label>Nature de l'opération${sel("Nature opération", Object.keys(fx.OPERATION_NATURES), d.head["Nature opération"])}</label>
    <label>Référence acheteur<input data-head="Référence acheteur" value="${esc(d.head["Référence acheteur"] || "")}" /></label>
    <label>Bon de commande<input data-head="Bon de commande" value="${esc(d.head["Bon de commande"] || "")}" /></label>
    <label>Adresse de livraison<input data-head="Adresse livraison" value="${esc(d.head["Adresse livraison"] || "")}" placeholder="Si différente de l'adresse du client" /></label>
    <label>Date de livraison<input type="date" data-head="Date livraison" value="${esc(d.head["Date livraison"] || "")}" /></label>
    <label>Déjà payé (€)<input type="number" step="0.01" min="0" data-head="Payé" value="${esc(d.head["Payé"] || 0)}" /></label>
    <label>Facture rectifiée<input data-head="Facture rectifiée" value="${esc(d.head["Facture rectifiée"] || "")}" placeholder="Numéro d'origine (avoir)" /></label>
    <label class="check-field"><input type="checkbox" data-head="TVA sur les débits" ${d.head["TVA sur les débits"] ? "checked" : ""} /> TVA d'après les débits</label>`}`;
}

function renderDocLines() {
  const d = state.doc;
  $("doc-lines").innerHTML = `
    <thead><tr><th style="width:34%">Désignation</th><th>Réf.</th><th class="num">Qté</th><th>Unité</th><th class="num">P.U. HT</th><th class="num">Rem. %</th><th class="num">TVA %</th><th class="num">Total HT</th><th></th></tr></thead>
    <tbody>${d.lines.map((l, i) => `<tr>
      <td><input data-line="${i}" data-field="Désignation" value="${esc(l["Désignation"])}" /></td>
      <td><input data-line="${i}" data-field="Référence" value="${esc(l["Référence"] || "")}" /></td>
      <td><input class="num" type="number" step="0.001" data-line="${i}" data-field="Quantité" value="${esc(l["Quantité"])}" /></td>
      <td><select data-line="${i}" data-field="Unité">${UNITS.map((u) => `<option ${l["Unité"] === u ? "selected" : ""}>${esc(u)}</option>`).join("")}</select></td>
      <td><input class="num" type="number" step="0.01" data-line="${i}" data-field="Prix HT" value="${esc(l["Prix HT"])}" /></td>
      <td><input class="num" type="number" step="0.01" data-line="${i}" data-field="Remise" value="${esc(l["Remise"] || 0)}" /></td>
      <td><select data-line="${i}" data-field="TVA">${VAT_RATES.map((r) => `<option ${Number(l["TVA"]) === r ? "selected" : ""}>${r}</option>`).join("")}</select></td>
      <td class="line-total">${money(fx.lineTotal(l))}</td>
      <td><button class="btn tiny ghost danger" data-line-del="${i}" type="button">×</button></td>
    </tr>`).join("") || `<tr><td colspan="9"><div class="empty">Ajoutez une première ligne.<br><button class="btn" type="button" data-line-add>+ Ajouter une ligne</button></div></td></tr>`}</tbody>`;

  $("doc-article").innerHTML = `<option value="">Ajouter un article du catalogue…</option>`
    + state.articles.filter((a) => a["Actif"] !== false && a["Actif"] !== 0)
      .map((a) => `<option value="${a._id}">${esc(a["Référence"])} — ${esc(a["Désignation"])} (${money(a["Prix HT"])})</option>`).join("");

  renderDocTotals();
  renderDocActions();
}

function docTotals() {
  return fx.computeTotals(state.doc.lines, state.doc.head["Remise"]);
}

function renderDocTotals() {
  const t = docTotals();
  const paid = Number(state.doc.head["Payé"]) || 0;
  $("doc-totals").innerHTML = `
    <div class="t-row"><span>Sous-total lignes</span><span>${money(t.gross)}</span></div>
    ${t.discount ? `<div class="t-row"><span>Remise globale</span><span>− ${money(t.discount)}</span></div>` : ""}
    <div class="t-row"><span>Total HT</span><span>${money(t.totalHt)}</span></div>
    ${t.vat.map((v) => `<div class="t-vat"><span>TVA ${qty(v.rate)} % (${v.category}) sur ${money(v.base)}</span><span>${money(v.tax)}</span></div>`).join("")}
    <div class="t-row"><span>Total TVA</span><span>${money(t.totalTva)}</span></div>
    <div class="t-row grand"><span>Total TTC</span><span>${money(t.totalTtc)}</span></div>
    ${state.doc.kind === "invoice" && paid ? `<div class="t-row"><span>Reste dû</span><span>${money(t.totalTtc - paid)}</span></div>` : ""}`;
  renderDocIssues();
}

function renderDocIssues() {
  const host = $("doc-issues");
  if (state.doc.kind !== "invoice") { host.innerHTML = ""; return; }
  const issues = fx.validate(state.doc.head, state.societe || {}, clientOf(state.doc.head), state.doc.lines);
  host.innerHTML = issues.length
    ? issues.map((i) => `<div class="issue ${i.level}"><span class="i-tag">${i.level === "error" ? "bloquant" : "à vérifier"}</span><span>${esc(i.message)}</span></div>`).join("")
    : `<div class="issue"><span class="i-tag">conforme</span><span>Aucun contrôle en défaut : la facture peut être émise au format Factur-X.</span></div>`;
}

function renderDocActions() {
  const d = state.doc;
  const isQuote = d.kind === "quote";
  $("doc-actions").innerHTML = `
    ${d.row ? `<button class="btn ghost" data-doc="duplicate">Dupliquer</button>` : ""}
    ${isQuote && d.row && !d.row["Facture"] ? `<button class="btn" data-doc="convert">Basculer en facture</button>` : ""}
    ${!isQuote && d.row ? `<button class="btn" data-doc="paid">Marquer payée</button><button class="btn" data-doc="export">Exporter Factur-X</button>` : ""}
    <span class="spacer"></span>
    <button class="btn ghost" data-close>Fermer</button>
    <button class="btn primary" data-doc="save">Enregistrer</button>`;
}

async function saveDoc({ silent = false } = {}) {
  const d = state.doc;
  const isQuote = d.kind === "quote";
  const table = isQuote ? "devis" : "factures";
  const lineTable = isQuote ? "lignesDevis" : "lignesFactures";
  const t = docTotals();
  const client = state.clients.find((c) => c._id === d.head["Client id"]);
  const head = {
    ...d.head,
    "Client": client?.["Nom"] || d.head["Client"] || "",
    "Projet": projectById(d.head["Projet id"])?.["Nom"] || "",
    "Total HT": t.totalHt, "Total TVA": t.totalTva, "Total TTC": t.totalTtc,
    "Notes": $("doc-notes").value,
    "Tags": readTagsField($("doc-head").querySelector(".tags-field")),
  };
  delete head._id;
  if (d.row) await store.update(table, d.row._id, head);
  else {
    const id = await store.insert(table, head);
    d.row = { ...head, _id: id };
  }
  await store.replaceLines(lineTable, head["Numéro"], d.lines.map((l) => ({
    "Référence": l["Référence"], "Désignation": l["Désignation"], "Quantité": Number(l["Quantité"]) || 0,
    "Unité": l["Unité"], "Prix HT": Number(l["Prix HT"]) || 0, "Remise": Number(l["Remise"]) || 0,
    "TVA": Number(l["TVA"]) || 0, "Total HT": fx.lineTotal(l),
  })));
  await reload();
  render();
  if (!silent) toast(`${isQuote ? "Devis" : "Facture"} ${head["Numéro"]} enregistré.`);
  return head;
}

// ============================ Devis → facture (+ stock) ============================

/**
 * Débite le stock des lignes d'un document, une seule fois : la présence d'un
 * mouvement portant ce numéro de document sert de garde d'idempotence, ce qui
 * évite le double débit si l'utilisateur bascule deux fois le même devis.
 */
async function debitStock(lines, docNumber) {
  if (state.moves.some((m) => m["Document"] === docNumber)) return { moved: 0, negatives: [] };
  let moved = 0;
  const negatives = [];
  for (const l of lines) {
    const article = articleByRef(l["Référence"]);
    if (!article || !article["Suivi stock"]) continue;
    const q = Number(l["Quantité"]) || 0;
    if (q <= 0) continue;
    const after = (Number(article["Stock"]) || 0) - q;
    await store.update("articles", article._id, { "Stock": after });
    await store.insert("stock", {
      "Date": today(), "Référence": article["Référence"], "Désignation": article["Désignation"],
      "Sens": "Sortie", "Quantité": q, "Stock après": after,
      "Motif": "Facturation", "Document": docNumber,
    });
    moved += 1;
    if (after < 0) negatives.push(`${article["Référence"]} (${qty(after)})`);
  }
  return { moved, negatives };
}

/** Bascule un devis en facture : copie des lignes, débit du stock, liaison. */
async function convertQuote(quote) {
  if (quote["Facture"]) { toast(`Déjà facturé (${quote["Facture"]}).`); return null; }
  const lines = await store.linesOf("lignesDevis", quote["Numéro"]);
  if (!lines.length) { toast("Ce devis n'a aucune ligne."); return null; }
  const client = state.clients.find((c) => c._id === quote["Client id"]) || {};
  const number = nextNumber("invoice");
  const societe = state.societe || {};
  const terms = client["Conditions paiement"] || societe["Conditions paiement"] || "";
  const days = parseInt(String(terms).match(/(\d+)\s*jours?/i)?.[1] || "30", 10);
  const invoice = {
    "Numéro": number, "Date": today(), "Échéance": addDays(today(), days), "Type": "Facture",
    "Client": quote["Client"], "Client id": quote["Client id"], "Statut": "Émise",
    "Objet": quote["Objet"], "Devis": quote["Numéro"],
    "Référence acheteur": client["Référence acheteur"] || "",
    "Nature opération": "Prestation de services",
    "Adresse livraison": client["Adresse livraison"] || "",
    "TVA sur les débits": !!societe["TVA sur les débits"],
    "Remise": Number(quote["Remise"]) || 0,
    "Total HT": Number(quote["Total HT"]) || 0, "Total TVA": Number(quote["Total TVA"]) || 0,
    "Total TTC": Number(quote["Total TTC"]) || 0, "Payé": 0,
    "Mode paiement": societe["Mode paiement"] || "Virement",
    "Profil Factur-X": societe["Profil Factur-X"] || "EN 16931",
    "Projet": quote["Projet"] || "", "Projet id": quote["Projet id"] || null,
    "Tags": quote["Tags"] || "",
    "Notes": quote["Notes"] || "",
  };
  await store.insert("factures", invoice);
  await store.replaceLines("lignesFactures", number, lines.map((l) => ({
    "Référence": l["Référence"], "Désignation": l["Désignation"], "Quantité": l["Quantité"],
    "Unité": l["Unité"], "Prix HT": l["Prix HT"], "Remise": l["Remise"], "TVA": l["TVA"],
    "Total HT": l["Total HT"],
  })));
  await store.update("devis", quote._id, { "Statut": "Facturé", "Facture": number });
  const stock = await debitStock(lines, number);
  await reload();
  render();
  const warn = stock.negatives.length ? ` ⚠ stock négatif : ${stock.negatives.join(", ")}` : "";
  toast(`Facture ${number} créée — ${stock.moved} article(s) débité(s).${warn}`);
  return invoice;
}

// ============================ Export Factur-X ============================

/** Rassemble tout ce dont le PDF et le XML ont besoin, calculé une seule fois. */
async function invoicePayload(invoice) {
  const lines = await store.linesOf("lignesFactures", invoice["Numéro"]);
  const seller = state.societe || {};
  const buyer = clientOf(invoice);
  const totals = fx.computeTotals(lines, invoice["Remise"]);
  return { invoice, seller, buyer, lines, totals };
}

/** Descriptif de rendu du PDF (le Rust ne recalcule rien : mêmes chiffres). */
function pdfDoc({ invoice, seller, buyer, lines, totals }) {
  const paid = Number(invoice["Payé"]) || 0;
  const addr = (p) => [
    p["Raison sociale"] || p["Nom"],
    p["Adresse"], `${p["Code postal"] || ""} ${p["Ville"] || ""}`.trim(),
    p["Pays"] || "FR",
    p["SIRET"] ? `SIRET ${p["SIRET"]}` : (p["SIREN"] ? `SIREN ${p["SIREN"]}` : ""),
    p["TVA intracom"] ? `TVA ${p["TVA intracom"]}` : "",
    p["Email"] || "", p["Téléphone"] || "",
  ].filter(Boolean);
  const sellerLines = addr(seller).concat([
    seller["Forme juridique"] ? `${seller["Forme juridique"]}${seller["Capital"] ? ` au capital de ${seller["Capital"]}` : ""}` : "",
    seller["RCS"] || "",
  ].filter(Boolean));
  const notes = [
    `Conditions de paiement : ${invoice["Conditions paiement"] || seller["Conditions paiement"] || "paiement à réception"}. Échéance : ${dateFr(invoice["Échéance"])}.`,
    `Pénalités de retard : ${qty(seller["Taux pénalités"] || 0)} % par an. Indemnité forfaitaire pour frais de recouvrement : ${money(seller["Indemnité recouvrement"] || 40)}. ${seller["Escompte"] || "Pas d'escompte pour paiement anticipé."}`,
    invoice["Nature opération"] ? `Nature de l'opération : ${invoice["Nature opération"].toLowerCase()}.` : "",
    invoice["TVA sur les débits"] ? "Option pour le paiement de la TVA d'après les débits." : "",
    seller["Régime TVA"] === "Franchise en base" ? "TVA non applicable, article 293 B du CGI." : "",
    seller["IBAN"] ? `Règlement par ${(seller["Mode paiement"] || "virement").toLowerCase()} — IBAN ${seller["IBAN"]}${seller["BIC"] ? ` · BIC ${seller["BIC"]}` : ""}.` : "",
    invoice["Adresse livraison"] ? `Adresse de livraison : ${invoice["Adresse livraison"]}.` : "",
    invoice["Facture rectifiée"] ? `Avoir sur la facture ${invoice["Facture rectifiée"]}.` : "",
    seller["Mentions"] || "",
    invoice["Notes"] || "",
  ].filter(Boolean);
  return {
    title: `${invoice["Type"] === "Avoir" ? "Avoir" : "Facture"} ${invoice["Numéro"]}`,
    subtitle: `${seller["Raison sociale"] || ""} — émise le ${dateFr(invoice["Date"])}`,
    number: invoice["Numéro"],
    badge: money(totals.totalTtc),
    badge_sub: `Échéance ${dateFr(invoice["Échéance"])}`,
    profile: invoice["Profil Factur-X"] || "EN 16931",
    seller: sellerLines,
    buyer: addr(buyer),
    meta: [
      { label: "NUMÉRO", value: invoice["Numéro"] },
      { label: "DATE", value: dateFr(invoice["Date"]) },
      { label: "ÉCHÉANCE", value: dateFr(invoice["Échéance"]) },
      { label: "RÉF. ACHETEUR", value: invoice["Référence acheteur"] || "—" },
      { label: "DEVIS", value: invoice["Devis"] || "—" },
    ],
    lines: lines.map((l) => ({
      label: l["Désignation"] || "", ref: l["Référence"] || "",
      qty: qty(l["Quantité"]), unit: l["Unité"] || "",
      price: money(l["Prix HT"]), discount: Number(l["Remise"]) ? `${qty(l["Remise"])} %` : "—",
      vat: `${qty(l["TVA"])} %`, total: money(fx.lineTotal(l)),
    })),
    vat: totals.vat.map((v) => ({ base: money(v.base), rate: `${qty(v.rate)} %`, category: v.category, tax: money(v.tax) })),
    totals: [
      { label: "Total HT", value: money(totals.totalHt) },
      { label: "Total TVA", value: money(totals.totalTva) },
      { label: "Total TTC", value: money(totals.totalTtc), strong: true },
      ...(paid ? [{ label: "Déjà réglé", value: money(paid) }, { label: "Reste dû", value: money(totals.totalTtc - paid) }] : []),
    ],
    notes,
    footer: `${seller["Raison sociale"] || ""} · ${seller["Adresse"] || ""} ${seller["Code postal"] || ""} ${seller["Ville"] || ""} · ${seller["SIREN"] ? `SIREN ${seller["SIREN"]}` : ""} · Facture électronique conforme au socle commun (EN 16931).`,
  };
}

let exportCtx = null;

async function openExport(invoice) {
  exportCtx = invoice;
  const sel = $("export-sandbox");
  sel.innerHTML = `<option value="">Chargement…</option>`;
  $("export-status").textContent = "";
  $("export-modal").hidden = false;
  try {
    const sandboxes = await invoke("sandbox_list");
    const remembered = localStorage.getItem("crmExportSandbox");
    sel.innerHTML = sandboxes.length
      ? sandboxes.map((s) => `<option value="${esc(s.id)}" ${s.id === remembered ? "selected" : ""}>${esc(s.name || s.id)}</option>`).join("")
      : `<option value="">Aucune sandbox — créez-en une depuis Fichiers</option>`;
  } catch (e) {
    sel.innerHTML = `<option value="">Backend indisponible</option>`;
  }
}

async function runExport() {
  const invoice = exportCtx;
  const sandboxId = $("export-sandbox").value;
  if (!invoice || !sandboxId) return;
  const status = $("export-status");
  const payload = await invoicePayload(invoice);
  const issues = fx.validate(payload.invoice, payload.seller, payload.buyer, payload.lines);
  const blocking = issues.filter((i) => i.level === "error");
  if (blocking.length) {
    status.innerHTML = `<span style="color:var(--red)">Export refusé — ${blocking.length} contrôle(s) bloquant(s) :</span><br>${blocking.map((i) => esc(i.message)).join("<br>")}`;
    return;
  }
  const dir = ($("export-dir").value || "").replace(/[^A-Za-z0-9._/-]/g, "").replace(/^\/+|\/+$/g, "");
  const base = `${dir ? dir + "/" : ""}${invoice["Numéro"].replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const xml = fx.buildXml(payload);
  status.textContent = "Export en cours…";
  const written = [];
  try {
    if ($("export-xml").checked) {
      await invoke("sandbox_write_file", { id: sandboxId, path: `${base}.xml`, content: xml });
      written.push(`${base}.xml`);
    }
    if ($("export-pdf").checked) {
      const bytes = await invoke("facturx_pdf", { doc: pdfDoc(payload), xml });
      // `sandbox_write_binary` n'est pas une commande exposée : l'écriture
      // binaire passe par `sandbox_import_file` (base64). Le tableau d'octets
      // est converti par tranches pour ne pas saturer la pile sur un gros PDF.
      let bin = "";
      const arr = Uint8Array.from(bytes);
      for (let i = 0; i < arr.length; i += 0x8000) bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
      await invoke("sandbox_import_file", { id: sandboxId, path: `${base}.pdf`, dataB64: btoa(bin) });
      written.push(`${base}.pdf`);
    }
    localStorage.setItem("crmExportSandbox", sandboxId);
    const warnings = issues.filter((i) => i.level === "warn");
    status.innerHTML = `Exporté : ${written.map(esc).join(", ")} ✓`
      + (warnings.length ? `<br><span class="hint">${warnings.length} point(s) à vérifier : ${warnings.map((w) => esc(w.message)).join(" ")}</span>` : "");
    toast(`Facture ${invoice["Numéro"]} exportée.`);
  } catch (e) {
    status.textContent = `Échec de l'export : ${e}`;
  }
}

// ============================ Assistant IA ============================

const CRM_TOOLS = [
  tool("overview", "État de l'ERP : nombre d'articles, clients, devis, factures, encours, alertes de stock.", {}),
  tool("query", "Requête SQL de LECTURE sur la base ERP (tables « Articles », « Clients », « Projets », « Tâches », « Devis », « Lignes devis », « Factures », « Lignes facture », « Mouvements stock »).",
    { sql: T.str("SELECT complet, noms de tables entre guillemets doubles") }, ["sql"]),
  tool("list_tags", "Liste les tags déjà utilisés (à réutiliser plutôt que d'en inventer de nouveaux).", {}),
  tool("create_article", "Crée un article au catalogue.",
    { reference: T.str("Référence unique"), designation: T.str(""), prix_ht: T.num(""), tva: T.num("Taux en % (20, 10, 8.5 outre-mer, 5.5, 2.1, 0)"),
      unite: T.enum(UNITS, "Unité"), stock: T.num("Stock initial"), stock_alerte: T.num("Seuil d'alerte"), categorie: T.str("Catégorie — réutiliser une catégorie existante si elle convient"),
      tags: T.list("Tags — réutiliser ceux de list_tags quand c'est possible") },
    ["reference", "designation", "prix_ht"]),
  tool("update_article", "Modifie un article existant (prix, désignation, seuil, catégorie, tags…).",
    { reference: T.str("Référence de l'article"), prix_ht: T.num(""), tva: T.num(""), designation: T.str(""), stock_alerte: T.num(""),
      categorie: T.str(""), tags: T.list("Remplace les tags de l'article"), actif: T.bool("") }, ["reference"]),
  tool("adjust_stock", "Entrée ou sortie de stock manuelle (réception, casse, inventaire).",
    { reference: T.str(""), quantite: T.num("Positive pour une entrée, négative pour une sortie"), motif: T.str("") }, ["reference", "quantite"]),
  tool("create_client", "Crée une fiche client.",
    { nom: T.str(""), siren: T.str("9 chiffres — obligatoire pour un client assujetti"), siret: T.str(""), tva: T.str("N° TVA intracommunautaire"),
      email: T.str(""), telephone: T.str(""), adresse: T.str(""), code_postal: T.str(""), ville: T.str(""), type: T.enum(["Entreprise", "Administration", "Particulier"], ""),
      tags: T.list("Tags — réutiliser ceux de list_tags quand c'est possible") },
    ["nom"]),
  tool("find", "Recherche par tag, par catégorie ou par texte dans les articles, les clients, les devis et les factures.",
    { tag: T.str("Tag exact"), categorie: T.str("Catégorie d'article"), texte: T.str("Texte libre") }, []),
  tool("create_quote", "Crée un devis pour un client, avec ses lignes.",
    { client: T.str("Nom du client"), objet: T.str(""), validite_jours: T.int("Défaut 30"), tags: T.list("Tags du devis"),
      lignes: { type: "array", description: "Lignes du devis",
        items: { type: "object", properties: { reference: T.str("Référence catalogue (le prix et la TVA sont repris)"), designation: T.str(""), quantite: T.num(""), prix_ht: T.num(""), tva: T.num(""), remise: T.num("% de remise") }, required: ["quantite"] } } },
    ["client", "lignes"]),
  tool("convert_quote", "Bascule un devis en facture : copie les lignes, débite le stock et lie les deux documents.",
    { numero: T.str("Numéro du devis") }, ["numero"]),
  tool("create_project", "Crée un projet (mission, chantier) rattaché à un client.",
    { nom: T.str(""), client: T.str("Nom d'un client existant"), statut: T.enum(PROJECT_STATUS, ""),
      debut: T.str("Date de début AAAA-MM-JJ"), fin: T.str("Date de fin AAAA-MM-JJ"),
      budget: T.num("Budget HT"), taux_horaire: T.num("Taux horaire HT servant à facturer les tâches"),
      tags: T.list("Tags — réutiliser ceux de list_tags quand c'est possible") },
    ["nom"]),
  tool("create_task", "Crée une tâche, rattachée ou non à un projet.",
    { titre: T.str(""), projet: T.str("Nom du projet"), statut: T.enum(TASK_STATUS, ""),
      priorite: T.enum(TASK_PRIORITY, ""), assigne: T.str("Responsable"),
      debut: T.str("AAAA-MM-JJ"), echeance: T.str("AAAA-MM-JJ"), estime_h: T.num("Heures estimées"),
      facturable: T.bool("La tâche sera facturée au taux horaire du projet"), tags: T.list("") },
    ["titre"]),
  tool("update_task", "Met à jour une tâche : statut, avancement, temps passé, échéance, responsable.",
    { titre: T.str("Titre exact de la tâche"), statut: T.enum(TASK_STATUS, ""), avancement: T.num("0 à 100"),
      passe_h: T.num("Heures passées — remplace la valeur"), ajouter_h: T.num("Heures à AJOUTER au temps passé"),
      echeance: T.str("AAAA-MM-JJ"), assigne: T.str(""), priorite: T.enum(TASK_PRIORITY, ""), facturable: T.bool("") },
    ["titre"]),
  tool("list_tasks", "Liste les tâches, filtrables par projet, par statut ou en retard seulement.",
    { projet: T.str("Nom du projet"), statut: T.enum(TASK_STATUS, ""), en_retard: T.bool("Uniquement les tâches en retard") }, []),
  tool("project_report", "Point complet sur un projet : avancement, temps, tâches en retard, devis et factures liés.",
    { nom: T.str("Nom du projet") }, ["nom"]),
  tool("quote_from_tasks", "Crée un devis à partir des tâches facturables non encore facturées d'un projet (heures × taux horaire du projet).",
    { projet: T.str("Nom du projet") }, ["projet"]),
  tool("read_document", "Détail d'un devis ou d'une facture, lignes comprises.", { numero: T.str("") }, ["numero"]),
  tool("check_invoice", "Contrôles de conformité (facturation électronique française) d'une facture.", { numero: T.str("") }, ["numero"]),
  tool("mark_paid", "Enregistre un règlement sur une facture.", { numero: T.str(""), montant: T.num("Montant réglé — total si omis") }, ["numero"]),
];

async function runCrmTool(name, a) {
  const findDoc = (numero) => state.invoices.find((f) => f["Numéro"] === numero) || state.quotes.find((d) => d["Numéro"] === numero);
  switch (name) {
    case "overview": {
      const due = state.invoices.filter((f) => f["Statut"] !== "Payée" && f["Statut"] !== "Brouillon" && f["Statut"] !== "Annulée")
        .reduce((s, f) => s + ((Number(f["Total TTC"]) || 0) - (Number(f["Payé"]) || 0)), 0);
      const low = state.articles.filter((x) => x["Suivi stock"] && Number(x["Stock"]) <= Number(x["Stock alerte"] || 0));
      return `Articles : ${state.articles.length} (dont ${low.length} sous seuil : ${low.map((x) => x["Référence"]).join(", ") || "aucun"}). `
        + `Clients : ${state.clients.length}. Devis : ${state.quotes.length}. Factures : ${state.invoices.length}. Encours client : ${money(due)}.`;
    }
    case "query": {
      const res = await store.query(String(a.sql || ""));
      const rows = res?.rows || [];
      if (!rows.length) return "Aucune ligne.";
      return JSON.stringify(rows.slice(0, 40));
    }
    case "list_tags": {
      const tags = knownTags();
      const cats = knownCategories();
      return `Tags utilisés : ${tags.join(", ") || "aucun"}. Catégories d'articles : ${cats.join(", ") || "aucune"}.`;
    }
    case "find": {
      const tag = String(a.tag || "").toLowerCase();
      const cat = String(a.categorie || "").toLowerCase();
      const text = String(a.texte || "").toLowerCase();
      const keep = (row, hay) => (!tag || splitTags(row["Tags"]).some((t) => t.toLowerCase() === tag))
        && (!cat || String(row["Catégorie"] || "").toLowerCase() === cat)
        && (!text || hay.toLowerCase().includes(text));
      const out = {
        articles: state.articles.filter((x) => keep(x, `${x["Référence"]} ${x["Désignation"]} ${x["Catégorie"]}`)).map((x) => `${x["Référence"]} — ${x["Désignation"]} (${money(x["Prix HT"])})`),
        clients: state.clients.filter((x) => keep(x, `${x["Nom"]} ${x["Ville"]}`)).map((x) => x["Nom"]),
        devis: state.quotes.filter((x) => keep(x, `${x["Numéro"]} ${x["Client"]} ${x["Objet"]}`)).map((x) => `${x["Numéro"]} ${x["Client"]} ${x["Statut"]}`),
        factures: state.invoices.filter((x) => keep(x, `${x["Numéro"]} ${x["Client"]} ${x["Objet"]}`)).map((x) => `${x["Numéro"]} ${x["Client"]} ${x["Statut"]} ${money(x["Total TTC"])}`),
      };
      const total = Object.values(out).reduce((n, list) => n + list.length, 0);
      return total ? JSON.stringify(out) : "Aucun résultat pour ces critères.";
    }
    case "create_article": {
      if (articleByRef(a.reference)) return `La référence ${a.reference} existe déjà.`;
      await store.insert("articles", {
        "Référence": a.reference, "Désignation": a.designation || a.reference, "Catégorie": a.categorie || "",
        "Unité": a.unite || "unité", "Prix HT": Number(a.prix_ht) || 0, "TVA": a.tva == null ? 20 : Number(a.tva),
        "Stock": Number(a.stock) || 0, "Stock alerte": Number(a.stock_alerte) || 0,
        "Tags": joinTags(a.tags || []), "Suivi stock": true, "Actif": true,
      });
      return `Article ${a.reference} créé.`;
    }
    case "update_article": {
      const art = articleByRef(a.reference);
      if (!art) return `Article ${a.reference} introuvable.`;
      const patch = {};
      if (a.prix_ht != null) patch["Prix HT"] = Number(a.prix_ht);
      if (a.tva != null) patch["TVA"] = Number(a.tva);
      if (a.designation) patch["Désignation"] = a.designation;
      if (a.stock_alerte != null) patch["Stock alerte"] = Number(a.stock_alerte);
      if (a.categorie) patch["Catégorie"] = a.categorie;
      if (Array.isArray(a.tags)) patch["Tags"] = joinTags(a.tags);
      if (a.actif != null) patch["Actif"] = !!a.actif;
      await store.update("articles", art._id, patch);
      return `Article ${a.reference} mis à jour.`;
    }
    case "adjust_stock": {
      const art = articleByRef(a.reference);
      if (!art) return `Article ${a.reference} introuvable.`;
      const delta = Number(a.quantite) || 0;
      const after = (Number(art["Stock"]) || 0) + delta;
      await store.update("articles", art._id, { "Stock": after });
      await store.insert("stock", {
        "Date": today(), "Référence": art["Référence"], "Désignation": art["Désignation"],
        "Sens": delta >= 0 ? "Entrée" : "Sortie", "Quantité": Math.abs(delta), "Stock après": after,
        "Motif": a.motif || "Ajustement", "Document": "",
      });
      return `Stock de ${art["Référence"]} : ${qty(after)}.`;
    }
    case "create_client": {
      await store.insert("clients", {
        "Nom": a.nom, "Type": a.type || "Entreprise", "SIREN": a.siren || "", "SIRET": a.siret || "",
        "TVA intracom": a.tva || "", "Email": a.email || "", "Téléphone": a.telephone || "",
        "Adresse": a.adresse || "", "Code postal": a.code_postal || "", "Ville": a.ville || "", "Pays": "FR",
        "Tags": joinTags(a.tags || []),
      });
      return `Client « ${a.nom} » créé.${a.siren ? "" : " Attention : sans SIREN, ses factures seront refusées par les contrôles."}`;
    }
    case "create_quote": {
      const client = state.clients.find((c) => String(c["Nom"]).toLowerCase() === String(a.client).toLowerCase())
        || state.clients.find((c) => String(c["Nom"]).toLowerCase().includes(String(a.client).toLowerCase()));
      if (!client) return `Client « ${a.client} » introuvable — créez-le d'abord avec create_client.`;
      const lines = (a.lignes || []).map((l) => {
        const art = articleByRef(l.reference);
        return {
          "Référence": l.reference || "", "Désignation": l.designation || art?.["Désignation"] || l.reference || "Prestation",
          "Quantité": Number(l.quantite) || 1, "Unité": art?.["Unité"] || "unité",
          "Prix HT": l.prix_ht != null ? Number(l.prix_ht) : Number(art?.["Prix HT"]) || 0,
          "Remise": Number(l.remise) || 0,
          "TVA": l.tva != null ? Number(l.tva) : (art ? Number(art["TVA"]) || 0 : 20),
        };
      });
      const totals = fx.computeTotals(lines, 0);
      const number = nextNumber("quote");
      await store.insert("devis", {
        "Numéro": number, "Date": today(), "Validité": addDays(today(), Number(a.validite_jours) || 30),
        "Client": client["Nom"], "Client id": client._id, "Statut": "Brouillon", "Objet": a.objet || "",
        "Remise": 0, "Total HT": totals.totalHt, "Total TVA": totals.totalTva, "Total TTC": totals.totalTtc,
        "Tags": joinTags(a.tags || []),
      });
      await store.replaceLines("lignesDevis", number, lines.map((l) => ({ ...l, "Total HT": fx.lineTotal(l) })));
      return `Devis ${number} créé pour ${client["Nom"]} : ${money(totals.totalHt)} HT, ${money(totals.totalTtc)} TTC.`;
    }
    case "convert_quote": {
      const quote = state.quotes.find((d) => d["Numéro"] === a.numero);
      if (!quote) return `Devis ${a.numero} introuvable.`;
      const inv = await convertQuote(quote);
      return inv ? `Devis ${a.numero} basculé en facture ${inv["Numéro"]} ; le stock des articles suivis a été débité.` : `Le devis ${a.numero} n'a pas pu être facturé.`;
    }
    case "read_document": {
      const doc = findDoc(a.numero);
      if (!doc) return `Document ${a.numero} introuvable.`;
      const key = state.invoices.includes(doc) ? "lignesFactures" : "lignesDevis";
      const lines = await store.linesOf(key, doc["Numéro"]);
      return JSON.stringify({ entete: doc, lignes: lines });
    }
    case "check_invoice": {
      const inv = state.invoices.find((f) => f["Numéro"] === a.numero);
      if (!inv) return `Facture ${a.numero} introuvable.`;
      const payload = await invoicePayload(inv);
      const issues = fx.validate(payload.invoice, payload.seller, payload.buyer, payload.lines);
      return issues.length ? issues.map((i) => `[${i.level}] ${i.message}`).join("\n") : "Aucun contrôle en défaut : la facture est exportable en Factur-X.";
    }
    case "mark_paid": {
      const inv = state.invoices.find((f) => f["Numéro"] === a.numero);
      if (!inv) return `Facture ${a.numero} introuvable.`;
      const amount = a.montant != null ? Number(a.montant) : Number(inv["Total TTC"]) || 0;
      const paid = (Number(inv["Payé"]) || 0) + amount;
      const status = paid >= (Number(inv["Total TTC"]) || 0) - 0.005 ? "Payée" : "Partiellement payée";
      await store.update("factures", inv._id, { "Payé": paid, "Statut": status });
      return `Facture ${a.numero} : ${money(paid)} encaissé, statut « ${status} ».`;
    }
    case "create_project": {
      if (state.projects.some((p) => p["Nom"].toLowerCase() === String(a.nom).toLowerCase())) return `Le projet « ${a.nom} » existe déjà.`;
      const client = a.client ? state.clients.find((c) => c["Nom"].toLowerCase() === String(a.client).toLowerCase()) : null;
      if (a.client && !client) return `Client « ${a.client} » introuvable — créez-le d'abord avec create_client.`;
      await store.insert("projets", {
        "Nom": a.nom, "Client": client?.["Nom"] || "", "Client id": client?._id ?? null,
        "Statut": a.statut || "En cours", "Début": a.debut || today(), "Fin": a.fin || "",
        "Budget": Number(a.budget) || 0, "Taux horaire": Number(a.taux_horaire) || 0,
        "Avancement": 0, "Tags": joinTags(a.tags || []), "Notes": "",
      });
      return `Projet « ${a.nom} » créé${client ? ` pour ${client["Nom"]}` : ""}.`;
    }
    case "create_task": {
      const project = a.projet ? state.projects.find((p) => p["Nom"].toLowerCase() === String(a.projet).toLowerCase()) : null;
      if (a.projet && !project) return `Projet « ${a.projet} » introuvable — créez-le d'abord avec create_project.`;
      await store.insert("taches", {
        "Titre": a.titre, "Projet": project?.["Nom"] || "", "Projet id": project?._id ?? null,
        "Statut": a.statut || "À faire", "Priorité": a.priorite || "Normale", "Assigné": a.assigne || "",
        "Début": a.debut || "", "Échéance": a.echeance || "", "Estimé h": Number(a.estime_h) || 0,
        "Passé h": 0, "Avancement": 0, "Facturable": a.facturable !== false, "Facturé": "",
        "Rang": state.tasks.length + 1, "Tags": joinTags(a.tags || []), "Notes": "",
      });
      return `Tâche « ${a.titre} » créée${project ? ` sur le projet ${project["Nom"]}` : ""}.`;
    }
    case "update_task": {
      const task = state.tasks.find((t) => t["Titre"].toLowerCase() === String(a.titre).toLowerCase());
      if (!task) return `Tâche « ${a.titre} » introuvable.`;
      const patch = {};
      if (a.statut) { patch["Statut"] = a.statut; if (a.statut === "Terminé") patch["Avancement"] = 100; }
      if (a.avancement != null) patch["Avancement"] = Math.max(0, Math.min(100, Number(a.avancement) || 0));
      if (a.passe_h != null) patch["Passé h"] = Number(a.passe_h) || 0;
      if (a.ajouter_h != null) patch["Passé h"] = (Number(task["Passé h"]) || 0) + (Number(a.ajouter_h) || 0);
      if (a.echeance) patch["Échéance"] = a.echeance;
      if (a.assigne) patch["Assigné"] = a.assigne;
      if (a.priorite) patch["Priorité"] = a.priorite;
      if (a.facturable != null) patch["Facturable"] = !!a.facturable;
      await store.update("taches", task._id, patch);
      return `Tâche « ${task["Titre"]} » mise à jour : ${Object.entries(patch).map(([k, v]) => `${k} = ${v}`).join(", ") || "rien à changer"}.`;
    }
    case "list_tasks": {
      let rows = state.tasks;
      if (a.projet) rows = rows.filter((t) => String(t["Projet"] || "").toLowerCase() === String(a.projet).toLowerCase());
      if (a.statut) rows = rows.filter((t) => (t["Statut"] || "À faire") === a.statut);
      if (a.en_retard) rows = rows.filter(taskLate);
      if (!rows.length) return "Aucune tâche ne correspond.";
      return rows.map((t) => `${t["Titre"]} — ${t["Projet"] || "sans projet"} — ${t["Statut"] || "À faire"} — ${t["Priorité"] || "Normale"} — échéance ${t["Échéance"] || "aucune"} — ${qty(t["Passé h"])}/${qty(t["Estimé h"])} h${t["Facturé"] ? ` — facturé ${t["Facturé"]}` : t["Facturable"] ? " — à facturer" : ""}`).join("\n");
    }
    case "project_report": {
      const project = state.projects.find((p) => p["Nom"].toLowerCase() === String(a.nom).toLowerCase());
      if (!project) return `Projet « ${a.nom} » introuvable.`;
      const st = projectStats(project);
      const { quotes, invoices } = docsOfProject(project);
      return JSON.stringify({
        projet: project["Nom"], client: project["Client"], statut: project["Statut"],
        debut: project["Début"], fin: project["Fin"], avancement: `${st.progress} %`,
        taches: `${st.done}/${st.tasks}`, en_retard: st.late,
        heures: `${st.spent} passées / ${st.estimated} estimées`,
        budget: project["Budget"], facture_ht: st.invoicedHt, reste_du_ttc: st.dueTtc,
        taches_a_facturer: st.billable.map((t) => t["Titre"]),
        devis: quotes.map((d) => `${d["Numéro"]} ${d["Statut"]} ${d["Total HT"]}`),
        factures: invoices.map((f) => `${f["Numéro"]} ${f["Statut"]} ${f["Total HT"]}`),
      });
    }
    case "quote_from_tasks": {
      const project = state.projects.find((p) => p["Nom"].toLowerCase() === String(a.projet).toLowerCase());
      if (!project) return `Projet « ${a.projet} » introuvable.`;
      const number = await quoteFromTasks(project);
      return number ? `Devis ${number} créé depuis les tâches facturables de ${project["Nom"]}.` : "Aucun devis créé : vérifie qu'il reste des tâches facturables, un taux horaire et un client sur le projet.";
    }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountCrmAi() {
  mountAiPrompt(null, {
    app: "Relia",
    title: "Assistant",
    intro: "Tu tiens Relia, le CRM de l'utilisateur : catalogue, stock, clients, projets et tâches (liste, kanban, Gantt), devis, factures et conformité de la facturation électronique française.",
    rules: [
      "- Commence par overview ou query pour connaître l'existant : ne crée jamais un client ou un article qui existe déjà.",
      "- Avant de poser un tag ou une catégorie, appelle list_tags et réutilise ce qui existe : un tag mal réécrit ne filtre plus rien.",
      "- Les montants que tu annonces doivent venir des outils, jamais d'un calcul de tête.",
      "- Une facture ne se crée pas directement : crée un devis, fais-le valider, puis convert_quote (c'est cette bascule qui débite le stock).",
      "- Avant de parler d'envoi, passe check_invoice et rapporte les points bloquants tels quels.",
      "- Une tâche appartient à un projet : crée le projet d'abord, et rattache-lui ses devis et factures pour que le suivi financier tienne.",
      "- Ne facture jamais des tâches deux fois : quote_from_tasks ne prend que celles qui ne portent pas encore de numéro de devis.",
      "- Pour l'avancement d'un chantier, appelle project_report plutôt que d'additionner toi-même des tâches.",
    ].join("\n"),
    placeholder: "Ex. : crée un devis de 3 jours de formation pour Dupont SAS…",
    suggestions: [
      { label: "État de l'activité", prompt: "Fais le point : chiffre d'affaires facturé, encours, devis en attente et alertes de stock." },
      { label: "Créer un devis", prompt: "Crée un devis pour le client que je vais te nommer, avec les lignes que je te donne." },
      { label: "Contrôler une facture", prompt: "Vérifie la conformité de ma dernière facture pour la facturation électronique et dis-moi ce qui manque." },
      { label: "Relances", prompt: "Quelles factures sont en retard de paiement, et pour quel montant ?" },
      { label: "Point projet", prompt: "Fais le point sur mes projets en cours : avancement, tâches en retard et ce qui reste à facturer." },
      { label: "Planifier un projet", prompt: "Crée un projet pour le client que je vais te nommer et découpe-le en tâches avec des échéances." },
      { label: "Ranger par tags", prompt: "Regarde mes tags existants et propose-moi comment taguer les articles et clients qui n'en ont pas." },
    ],
    tools: CRM_TOOLS,
    context: async () => {
      const s = state.societe || {};
      return [
        `Émetteur : ${s["Raison sociale"] || "(non renseigné)"} — SIREN ${s["SIREN"] || "?"} — régime ${s["Régime TVA"] || "?"}.`,
        `Catalogue : ${state.articles.length} article(s). Clients : ${state.clients.length}.`,
        `Projets : ${state.projects.map((p) => `${p["Nom"]} (${p["Statut"]}, ${projectProgress(p)} %)`).join(" | ") || "aucun"}.`,
        `Tâches : ${state.tasks.filter((t) => !taskDone(t)).length} ouverte(s), ${state.tasks.filter(taskLate).length} en retard.`,
        `Devis : ${state.quotes.slice(0, 8).map((d) => `${d["Numéro"]} ${d["Client"]} ${d["Statut"]} ${money(d["Total TTC"])}`).join(" | ") || "aucun"}.`,
        `Factures : ${state.invoices.slice(0, 8).map((f) => `${f["Numéro"]} ${f["Client"]} ${f["Statut"]} ${money(f["Total TTC"])}`).join(" | ") || "aucune"}.`,
        await store.schemaPrompt(),
      ].join("\n");
    },
    execute: runCrmTool,
    onApplied: async () => { await reload(); render(); },
  });
}

// ============================ Câblage ============================

function wire() {
  $("nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) showView(b.dataset.view);
  });
  $("settings-form").addEventListener("submit", saveSettings);
  for (const id of ["article-search", "client-search", "quote-search", "invoice-search", "project-search", "task-search"]) $(id).addEventListener("input", render);
  for (const id of ["article-low", "quote-status", "invoice-status", "project-status", "task-project", "task-status", "task-late"]) $(id).addEventListener("change", render);

  // Bascule Liste / Kanban / Gantt : trois lectures des mêmes tâches.
  $("task-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    state.taskMode = b.dataset.mode;
    renderTasks();
  });

  // Kanban : le glisser-déposer écrit le statut ET le rang, pour que l'ordre
  // choisi survive au rechargement.
  let dragged = null;
  document.body.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".k-card");
    if (!card) return;
    dragged = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  document.body.addEventListener("dragend", () => { dragged?.classList.remove("dragging"); dragged = null; });
  document.body.addEventListener("dragover", (e) => {
    const body = e.target.closest(".k-body");
    if (!body || !dragged) return;
    e.preventDefault();
    const after = [...body.querySelectorAll(".k-card:not(.dragging)")]
      .find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
    body.querySelector(".k-empty")?.remove();
    if (after) body.insertBefore(dragged, after);
    else body.appendChild(dragged);
  });
  document.body.addEventListener("drop", async (e) => {
    const body = e.target.closest(".k-body");
    if (!body || !dragged) return;
    e.preventDefault();
    const card = dragged;
    dragged = null;
    card.classList.remove("dragging");
    const status = body.closest(".k-col").dataset.col;
    const task = state.tasks.find((t) => t._id === Number(card.dataset.task));
    if (!task) return;
    await reorderTasks([...body.querySelectorAll(".k-card")].map((c) => Number(c.dataset.task)));
    await setTaskStatus(task, status);
  });

  // Case à cocher « terminé » de la vue liste.
  document.body.addEventListener("change", async (e) => {
    const box = e.target.closest("[data-task-done]");
    if (!box) return;
    const task = state.tasks.find((t) => t._id === Number(box.dataset.taskDone));
    if (task) await setTaskStatus(task, box.checked ? "Terminé" : "À faire");
  });

  // Modales : fermeture par le fond, la croix et Échap.
  document.querySelectorAll(".backdrop").forEach((bd) => bd.addEventListener("click", (e) => {
    if (e.target === bd || e.target.closest("[data-close]")) bd.hidden = true;
  }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".backdrop:not([hidden])").forEach((bd) => { bd.hidden = true; });
  });
  $("record-save").addEventListener("click", saveRecord);

  // Champs de tags : Entrée, virgule ou Tab valident le jeton en cours ;
  // Retour arrière sur un champ vide retire le dernier. La sélection dans la
  // liste d'autocomplétion n'émet pas de `keydown` — d'où l'écouteur `change`.
  document.body.addEventListener("keydown", (e) => {
    const input = e.target.closest(".tag-input");
    if (!input) return;
    if (e.key === "Enter" || e.key === "," || (e.key === "Tab" && input.value.trim())) {
      e.preventDefault();
      addTagChip(input.closest(".tags-field"), input.value);
      input.value = "";
    } else if (e.key === "Backspace" && !input.value) {
      input.closest(".tags-field").querySelector(".tag-chips .tag-chip:last-child")?.remove();
    }
  });
  document.body.addEventListener("change", (e) => {
    const input = e.target.closest(".tag-input");
    if (!input || !input.value.trim()) return;
    addTagChip(input.closest(".tags-field"), input.value);
    input.value = "";
  });
  $("export-go").addEventListener("click", runExport);

  // Actions déléguées : un seul écouteur pour toutes les listes et tableaux.
  document.body.addEventListener("click", async (e) => {
    const chipX = e.target.closest(".tag-x");
    if (chipX) { chipX.closest(".tag-chip").remove(); return; }
    const pill = e.target.closest("[data-tag-filter]");
    if (pill) {
      const kind = pill.dataset.tagFilter;
      const tag = pill.dataset.tag;
      const active = state.tagFilter[kind];
      if (!tag) state.tagFilter[kind] = [];
      else if (active.includes(tag)) state.tagFilter[kind] = active.filter((t) => t !== tag);
      else active.push(tag);
      render();
      return;
    }
    const goto = e.target.closest("[data-goto]");
    if (goto) { showView(goto.dataset.goto); return; }
    const open = e.target.closest("[data-open]");
    if (open) {
      const id = Number(open.dataset.id);
      if (open.dataset.open === "quote" || open.dataset.open === "invoice") $("project-modal").hidden = true;
      if (open.dataset.open === "quote") openDoc("quote", state.quotes.find((d) => d._id === id));
      if (open.dataset.open === "invoice") openDoc("invoice", state.invoices.find((f) => f._id === id));
      if (open.dataset.open === "article") openRecord("articles", state.articles.find((a) => a._id === id));
      if (open.dataset.open === "project") openProject(projectById(id));
      return;
    }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    switch (btn.dataset.act) {
      case "new-article": openRecord("articles", null); break;
      case "edit-article": openRecord("articles", state.articles.find((a) => a._id === id)); break;
      case "del-article": if (await confirmSheet({ title: "Supprimer cet article ?", confirm: "Supprimer", danger: true })) { await store.remove("articles", id); await reload(); render(); } break;
      case "stock-move": await stockMove(state.articles.find((a) => a._id === id)); break;
      case "new-client": openRecord("clients", null); break;
      case "edit-client": openRecord("clients", state.clients.find((c) => c._id === id)); break;
      case "del-client": if (await confirmSheet({ title: "Supprimer ce client ?", confirm: "Supprimer", danger: true })) { await store.remove("clients", id); await reload(); render(); } break;
      case "new-project": openRecord("projets", null); break;
      case "edit-project": openRecord("projets", projectById(id)); break;
      case "del-project": if (await confirmSheet({ title: "Supprimer ce projet ?", body: "Ses tâches sont conservées.", confirm: "Supprimer", danger: true })) { await store.remove("projets", id); await reload(); render(); } break;
      case "new-task": openRecord("taches", null); break;
      case "edit-task": $("project-modal").hidden = true; openRecord("taches", state.tasks.find((t) => t._id === id)); break;
      case "del-task": if (await confirmSheet({ title: "Supprimer cette tâche ?", confirm: "Supprimer", danger: true })) { await store.remove("taches", id); await reload(); render(); } break;
      case "log-time": await logTime(state.tasks.find((t) => t._id === id)); break;
      case "new-quote": openDoc("quote", null, Number(btn.dataset.client) || null); break;
      case "open-quote": openDoc("quote", state.quotes.find((d) => d._id === id)); break;
      case "del-quote": if (await confirmSheet({ title: "Supprimer ce devis ?", confirm: "Supprimer", danger: true })) { await store.remove("devis", id); await reload(); render(); } break;
      case "convert": await convertQuote(state.quotes.find((d) => d._id === id)); break;
      case "new-invoice": openDoc("invoice", null); break;
      case "open-invoice": openDoc("invoice", state.invoices.find((f) => f._id === id)); break;
      case "export": await openExport(state.invoices.find((f) => f._id === id)); break;
      default: break;
    }
  });

  // Fiche projet : navigation vers ses tâches, création, facturation.
  $("project-actions").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-project]");
    if (!b || !projectCtx) return;
    const project = projectCtx;
    if (b.dataset.project === "tasks") {
      $("project-modal").hidden = true;
      showView("tasks");
      $("task-project").value = String(project._id);
      renderTasks();
    }
    if (b.dataset.project === "new-task") {
      $("project-modal").hidden = true;
      openRecord("taches", null);
      const sel = $("record-form").elements["Projet"];
      if (sel) sel.value = project["Nom"];
    }
    if (b.dataset.project === "edit") { $("project-modal").hidden = true; openRecord("projets", project); }
    if (b.dataset.project === "quote") {
      const number = await quoteFromTasks(project);
      if (number) {
        $("project-modal").hidden = true;
        openDoc("quote", state.quotes.find((d) => d["Numéro"] === number));
      }
    }
  });

  // Éditeur de document : en-tête, lignes, actions.
  $("doc-head").addEventListener("change", (e) => {
    const el = e.target.closest("[data-head]");
    if (!el) return;
    const field = el.dataset.head;
    let value = el.type === "checkbox" ? el.checked : el.value;
    if (field === "Client id" || field === "Remise" || field === "Payé") value = Number(value) || 0;
    if (field === "Projet id") value = Number(value) || null;
    state.doc.head[field] = value;
    if (field === "Remise" || field === "Payé") renderDocTotals();
    if (field === "Type" || field === "Nature opération" || field === "Client id") renderDocIssues();
  });
  $("doc-lines").addEventListener("input", (e) => {
    const el = e.target.closest("[data-line]");
    if (!el) return;
    const line = state.doc.lines[Number(el.dataset.line)];
    const field = el.dataset.field;
    line[field] = ["Quantité", "Prix HT", "Remise", "TVA"].includes(field) ? Number(el.value) || 0 : el.value;
    el.closest("tr").querySelector(".line-total").textContent = money(fx.lineTotal(line));
    renderDocTotals();
  });
  $("doc-lines").addEventListener("click", (e) => {
    const del = e.target.closest("[data-line-del]");
    if (!del) return;
    state.doc.lines.splice(Number(del.dataset.lineDel), 1);
    renderDocLines();
  });
  $("doc-article").addEventListener("change", (e) => {
    const article = state.articles.find((a) => a._id === Number(e.target.value));
    if (!article) return;
    state.doc.lines.push(blankLine(article));
    e.target.value = "";
    renderDocLines();
  });
  $("doc-add-free").addEventListener("click", () => { state.doc.lines.push(blankLine(null)); renderDocLines(); });
  // Bouton du message « Ajoutez une première ligne » (toujours visible).
  $("doc-lines").addEventListener("click", (e) => {
    if (!e.target.closest("[data-line-add]")) return;
    state.doc.lines.push(blankLine(null)); renderDocLines();
    $("doc-lines").querySelector('input[data-field="Désignation"]')?.focus();
  });
  $("doc-actions").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-doc]");
    if (!b) return;
    if (b.dataset.doc === "save") { await saveDoc(); $("doc-modal").hidden = true; }
    if (b.dataset.doc === "duplicate") {
      const kind = state.doc.kind;
      const lines = state.doc.lines.map((l) => ({ ...l }));
      openDoc(kind, null, state.doc.head["Client id"]);
      state.doc.lines = lines;
      renderDocLines();
      toast("Copie créée — enregistrez-la pour la conserver.");
    }
    if (b.dataset.doc === "convert") {
      const head = await saveDoc({ silent: true });
      const quote = state.quotes.find((d) => d["Numéro"] === head["Numéro"]);
      const inv = await convertQuote(quote);
      $("doc-modal").hidden = true;
      if (inv) openDoc("invoice", state.invoices.find((f) => f["Numéro"] === inv["Numéro"]));
    }
    if (b.dataset.doc === "paid") {
      const t = docTotals();
      state.doc.head["Payé"] = t.totalTtc;
      state.doc.head["Statut"] = "Payée";
      await saveDoc({ silent: true });
      renderDocHead();
      renderDocTotals();
      toast("Facture marquée payée.");
    }
    if (b.dataset.doc === "export") {
      const head = await saveDoc({ silent: true });
      await openExport(state.invoices.find((f) => f["Numéro"] === head["Numéro"]));
    }
  });
}

// ============================ Démarrage ============================

async function init() {
  if (!store.hasBackend) {
    $("brand-sub").textContent = "Hors application";
    $("scroll").innerHTML = `<div class="empty">Ouvrez cette application depuis Lumen Desktop (le bureau).</div>`;
    return;
  }
  try {
    await store.ensureSchema();
  } catch (e) {
    $("scroll").innerHTML = `<div class="empty">Base indisponible : ${esc(String(e))}</div>`;
    return;
  }
  await reload();
  wire();
  showView("dashboard");
  mountCrmAi();
  $("brand-sub").textContent = `Base « ${store.BASE_NAME} » · SQLite`;
}

init();
// Traduction de l'interface quand Lumen est en anglais, contenu rendu en JS
// compris (l'app peint ses tableaux après coup).
autoTranslate({ observe: true });
