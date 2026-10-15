// DB Studio (édition Pro) — modéliser une base de données, façon Strapi.
//
// Trois idées tiennent l'app :
//   1. On modélise des OBJETS MÉTIER, pas du SQL : un champ est « un e-mail »,
//      « un montant », « un lien vers un client ». Le moteur (SQLite local ou
//      PostgreSQL d'entreprise, cf. engines.js) traduit — et peut changer sans
//      que le modèle bouge.
//   2. Le formulaire de saisie est ENGENDRÉ par le modèle : un champ obligatoire
//      l'est dans le formulaire comme dans les écritures de l'assistant, parce
//      que c'est la même fonction de validation (fields.js) qui tranche.
//   3. Tout ce que l'utilisateur peut faire à la souris, l'assistant peut le
//      faire par outil — créer un modèle, ajouter une relation, saisir des
//      enregistrements — et rien d'autre.

import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { autoTranslate } from "../apps-i18n.js";
import { mountShell, avatar, kpi, emptyState, progress } from "../lib/app-shell.js";
import { requireProPage } from "../lib/pro-edition.js";
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import {
  FIELD_KINDS, KIND_IDS, CARDINALITIES, blankField, coerceValue, kindLabel, slug, validateValue,
} from "./fields.js";
import { selectRows, csvText, downloadText } from "../lib/pro-data.js";
import { ENGINES, createEngine, readEngineConfig, saveEngineConfig } from "./engines.js";

// Icônes de la coquille (nav, en-têtes) : posées avant le premier rendu.
mountShell();

// Le partage entre profils parle directement au Rust (droits vérifiés côté
// serveur) : il ne passe pas par le moteur, qui ne connaît que les données.
const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke
  || (() => Promise.reject(new Error("Ouvrez cette application depuis Lumen.")));

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  view: "spaces",
  cfg: readEngineConfig(),
  engine: null,
  models: [],
  selected: "",     // modèle en cours d'édition
  dataModel: "",    // modèle affiché dans la vue Données
  rows: [],
  page: 0, pageSize: 25, sort: "", direction: 1, hiddenColumns: new Map(), rowsModel: "", hasMore: false, loading: false,
  fieldCtx: null,   // champ en cours d'édition
  recordCtx: null,  // enregistrement en cours de saisie
  cardRows: new Map(), // modelId → lignes lues pour calculer le résumé des cartes
  cardCtx: null,    // carte dont on règle le résumé
  shareCtx: null,   // espace en cours de partage
  shares: [],       // espaces partagés depuis cette machine
  profiles: [],     // profils Lumen, pour choisir avec qui partager
  me: "",           // profil actif
};

const modelById = (id) => state.models.find((m) => m.id === id);
const current = () => modelById(state.selected) || state.models[0] || null;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3400);
}

/** Étiquette lisible d'un enregistrement : son premier champ texte. */
/**
 * Comment nommer une ligne dans un menu ou un tableau.
 *
 * `displayId` est le champ désigné sur la relation qui pointe vers ce modèle :
 * c'est la vérité quand il existe, parce que seul l'auteur de la liaison sait
 * ce qui identifie un parent (une référence, un code, un nom). À défaut, on
 * retombe sur le premier champ texte — une supposition, pas une règle — puis
 * sur `#12`, qui a au moins le mérite d'être exact.
 */
function rowLabel(model, row, displayId = "") {
  const chosen = displayId ? model.fields.find((f) => f.id === displayId) : null;
  const field = chosen || model.fields.find((f) => f.kind === "text" || f.kind === "longtext") || model.fields[0];
  const value = field ? row.values[field.id] : "";
  return String(value ?? "").trim() || `#${row._id}`;
}

// ============================ Chargement ============================

async function reload() {
  state.models = await state.engine.listModels();
  if (!modelById(state.selected)) state.selected = state.models[0]?.id || "";
  if (!modelById(state.dataModel)) state.dataModel = state.selected;
}

let rowsRequest = 0;
async function loadRows(model, append = false) {
  const request = ++rowsRequest;
  state.loading = true;
  if (state.rowsModel !== model?.id) {
    state.rows = []; state.page = 0; state.sort = ""; state.hasMore = false;
    $("data-search").value = "";
  }
  if (state.view === "data") renderData();
  try {
    if (model) await primeRelations(model);
    const rows = model ? await state.engine.rows(model, 500, append ? state.rows.length : 0) : [];
    if (request !== rowsRequest) return;
    state.rows = append ? [...state.rows, ...rows] : rows;
    state.rowsModel = model?.id || "";
    state.hasMore = rows.length === 500;
    if (!append) state.page = 0;
  } catch (error) {
    if (request === rowsRequest) toast(`Chargement impossible : ${error.message || error}`);
  } finally {
    if (request === rowsRequest) state.loading = false;
  }
}

// ============================ Vues ============================

const VIEW_META = {
  spaces: ["Espaces", "Vos tables, d'un coup d'œil"],
  models: ["Modèles", "Vos tables, leurs champs et leurs relations"],
  schema: ["Schéma", "La carte de votre base, relations comprises"],
  data: ["Données", "Consulter et saisir, avec le formulaire du modèle"],
  settings: ["Moteur", "Où vivent les données : SQLite local ou PostgreSQL"],
};

function showView(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const [title, sub] = VIEW_META[view] || ["", ""];
  $("view-title").textContent = title;
  $("view-sub").textContent = sub;
  $("scroll").scrollTop = 0;
  $("top-actions").innerHTML = view === "models" || view === "spaces"
    ? `<button class="btn primary" data-act="new-model">+ Modèle</button>`
    : view === "data" ? `<button class="btn primary" data-act="new-record">+ Enregistrement</button>` : "";
  render();
}

function render() {
  if (state.view === "spaces") renderCards();
  if (state.view === "models") renderModels();
  if (state.view === "schema") renderSchema();
  if (state.view === "data") renderData();
  if (state.view === "settings") renderSettings();
  $("engine-badge").textContent = state.engine?.label || "—";
}

// ---------- Espaces : une carte par table ----------
//
// C'est l'écran d'accueil, et il répond à une question simple : « où en sont
// mes données ? ». Une carte par table, avec UN chiffre choisi par vous —
// le nombre d'entrées, une somme, une moyenne — et la dernière entrée reçue.
// Rien ne se calcule dans la base : on lit les lignes une fois, puis on
// agrège en mémoire. Une table de démonstration n'a pas besoin d'un moteur
// d'agrégation, et une grosse table est de toute façon bornée à 500 lignes.

/** Les métriques proposées. Chacune sait se calculer et se nommer. */
const METRICS = {
  count: { label: "Nombre d'entrées", needsField: false, run: (rows) => rows.length },
  sum: { label: "Somme", needsField: true, run: (rows, f) => nums(rows, f).reduce((a, b) => a + b, 0) },
  avg: { label: "Moyenne", needsField: true, run: (rows, f) => { const n = nums(rows, f); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : 0; } },
  min: { label: "Minimum", needsField: true, run: (rows, f) => Math.min(...nums(rows, f), Infinity) },
  max: { label: "Maximum", needsField: true, run: (rows, f) => Math.max(...nums(rows, f), -Infinity) },
  filled: { label: "Entrées renseignées", needsField: true, run: (rows, f) => rows.filter((r) => String(r.values[f] ?? "").trim() !== "").length },
};

const nums = (rows, fieldId) => rows
  .filter(r => r.values[fieldId] != null && String(r.values[fieldId]).trim() !== "")
  .map((r) => Number(r.values[fieldId]))
  .filter((n) => Number.isFinite(n));

const NUMERIC_KINDS = ["number", "integer", "money"];
const numericFields = (model) => model.fields.filter((f) => NUMERIC_KINDS.includes(f.kind));

/** Réglage du résumé, avec ses valeurs par défaut. */
function cardConfig(model) {
  const saved = model.form?.card || {};
  const firstNum = numericFields(model)[0]?.id || "";
  return {
    metric: saved.metric || "count",
    field: saved.field ?? firstNum,
    format: saved.format || (saved.metric && saved.metric !== "count" ? "number" : "raw"),
    ...saved,
  };
}

function formatMetric(value, format) {
  if (!Number.isFinite(value)) return "—";
  if (format === "money") return value.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  if (format === "percent") return `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;
  return value.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
}

/** Dégradé stable dérivé du nom : deux tables ne se confondent pas, et la même
 *  table garde sa couleur d'une session à l'autre. */
function modelHue(model) {
  let h = 0;
  for (const ch of model.id || model.name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Lit les lignes d'une table pour ses statistiques, une seule fois par vue. */
async function primeCards() {
  for (const model of state.models) {
    if (state.cardRows.has(model.id)) continue;
    try { state.cardRows.set(model.id, await state.engine.rows(model, 500)); }
    catch { state.cardRows.set(model.id, []); }
  }
}

function renderCards() {
  const host = $("cards");
  if (!state.models.length) {
    host.innerHTML = `<div class="card empty-card">
      <div class="empty-title">Aucune table pour l'instant</div>
      <div class="empty-sub">Créez un modèle, ou décrivez-le à l'assistant : « une table de clients avec nom, e-mail et ville ».</div>
      <button class="btn primary" data-act="new-model">+ Modèle</button></div>`;
    return;
  }
  host.innerHTML = state.models.map((model) => {
    const rows = state.cardRows.get(model.id) || [];
    const cfg = cardConfig(model);
    const metric = METRICS[cfg.metric] || METRICS.count;
    const partial = rows.length >= 500;
    const value = cfg.metric === "count" && Number.isFinite(model.rows) ? model.rows : metric.needsField && !cfg.field ? NaN : metric.run(rows, cfg.field);
    const fieldName = model.fields.find((f) => f.id === cfg.field)?.name || "";
    const last = rows[rows.length - 1];
    const shared = state.shares.filter((sh) => sh.tableId === model.id);
    const hue = modelHue(model);
    return `
    <article class="tile" style="--h:${hue}">
      <header class="tile-head">
        <div class="tile-id">
          <span class="tile-dot"></span>
          <div><div class="tile-name">${esc(model.name)}</div>
            <div class="tile-meta">${model.fields.length} champ(s) · ${model.rows ?? rows.length} entrée(s)</div></div>
        </div>
        ${shared.length ? `<span class="tile-share" title="${esc(shared.map((x) => x.name).join(", "))}">partagée</span>` : ""}
      </header>

      <div class="tile-kpi">
        <div class="kpi-value">${esc(cfg.metric === "count" || cfg.format === "raw" ? formatMetric(value, "number") : formatMetric(value, cfg.format))}</div>
        <div class="kpi-label">${esc(metric.label)}${partial && (metric.needsField || !Number.isFinite(model.rows)) ? " · 500 premières lignes" : ""}${fieldName && metric.needsField ? ` · ${fieldName}` : ""}</div>
      </div>

      <div class="tile-last">
        ${last
          ? `<span class="last-k">${partial ? "Dernière entrée chargée" : "Dernière entrée"}</span><span class="last-v">${esc(rowLabel(model, last))}</span>`
          : `<span class="last-k">Aucune entrée</span>`}
      </div>

      <footer class="tile-foot">
        <button class="btn tiny primary" data-act="open-data" data-id="${esc(model.id)}">Ouvrir</button>
        <button class="btn tiny" data-act="open-structure" data-id="${esc(model.id)}">Structure</button>
        <span class="spacer"></span>
        <button class="mini" data-act="config-card" data-id="${esc(model.id)}" title="Régler le résumé">◔</button>
        <button class="mini" data-act="share-model" data-id="${esc(model.id)}" title="Partager en application">⇪</button>
      </footer>
    </article>`;
  }).join("");
}

// ---------- Résumé paramétrable d'une carte ----------

function openCardModal(model) {
  state.cardCtx = { model };
  const cfg = cardConfig(model);
  const nums = numericFields(model);
  $("card-title").textContent = `Résumé — ${model.name}`;
  $("card-body").innerHTML = `
    <div class="form-grid">
      <label>Chiffre mis en avant<select id="c-metric">
        ${Object.entries(METRICS).map(([k, m]) => `<option value="${k}" ${k === cfg.metric ? "selected" : ""}>${esc(m.label)}</option>`).join("")}
      </select></label>
      <label>Champ<select id="c-field">
        <option value="">—</option>
        ${model.fields.map((f) => `<option value="${esc(f.id)}" ${f.id === cfg.field ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
      </select><small class="hint">${nums.length ? "" : "Aucun champ numérique : seules « Nombre d'entrées » et « Entrées renseignées » ont un sens ici."}</small></label>
      <label>Format<select id="c-format">
        <option value="number" ${cfg.format === "number" ? "selected" : ""}>Nombre</option>
        <option value="money" ${cfg.format === "money" ? "selected" : ""}>Montant (€)</option>
        <option value="percent" ${cfg.format === "percent" ? "selected" : ""}>Pourcentage</option>
      </select></label>
    </div>`;
  $("card-modal").hidden = false;
}

async function saveCardConfig() {
  const { model } = state.cardCtx;
  await state.engine.setForm(model.id, {
    ...(model.form || {}),
    card: { metric: $("c-metric").value, field: $("c-field").value, format: $("c-format").value },
  });
  $("card-modal").hidden = true;
  await reload();
  render();
  toast("Résumé enregistré.");
}

// ---------- Partage : publier une table comme application ----------

async function loadShares() {
  try {
    state.shares = await invoke("dbshare_list");
    const data = await invoke("session_profiles");
    state.profiles = data?.profiles || [];
    state.me = data?.active_id || "";
  } catch {
    // Édition sans profils, ou commande absente : le partage se contente de ne
    // pas s'afficher, l'app reste utilisable.
    state.shares = []; state.profiles = [];
  }
}

const KIND_LABEL = {
  both: ["Saisie et consultation", "Les bénéficiaires voient les entrées et peuvent en ajouter."],
  form: ["Saisie seule", "Un formulaire, sans accès aux entrées déjà présentes."],
  view: ["Consultation seule", "Un tableau en lecture, sans formulaire."],
};

function openShareModal(model) {
  const existing = state.shares.find((sh) => sh.tableId === model.id && sh.mine);
  state.shareCtx = { model, share: existing || null };
  const share = existing || { name: model.name, description: "", kind: "both", grants: {} };
  const others = state.profiles.filter((p) => p.id !== state.me);

  $("share-title").textContent = existing ? `Partage — ${model.name}` : `Partager « ${model.name} »`;
  $("share-error").textContent = "";
  $("share-remove").hidden = !existing;
  $("share-save").textContent = existing ? "Mettre à jour" : "Partager";
  $("share-body").innerHTML = `
    <p class="hint">L'espace apparaît comme une <strong>application autonome</strong> dans le menu des profils choisis. Ils n'ouvrent pas DB Studio : ils ouvrent leur écran.</p>
    <div class="form-grid">
      <label>Nom de l'application<input id="s-name" value="${esc(share.name)}" placeholder="Saisie des interventions" /></label>
      <label class="wide">Sous-titre<input id="s-desc" value="${esc(share.description || "")}" placeholder="Ce que la personne vient y faire" /></label>
    </div>
    <div class="share-kinds">
      ${Object.entries(KIND_LABEL).map(([k, [label, hint]]) => `
        <label class="kind-card ${k === share.kind ? "on" : ""}">
          <input type="radio" name="s-kind" value="${k}" ${k === share.kind ? "checked" : ""} />
          <span class="k-name">${esc(label)}</span><span class="k-sample">${esc(hint)}</span>
        </label>`).join("")}
    </div>
    <div class="share-people">
      <div class="sp-head">Qui y a accès</div>
      ${others.length ? others.map((p) => `
        <div class="sp-row">
          <span class="sp-name">${esc(p.name)}</span>
          <select class="sp-access" data-profile="${esc(p.id)}">
            <option value="">Aucun accès</option>
            <option value="read" ${share.grants?.[p.id] === "read" ? "selected" : ""}>Lecture</option>
            <option value="write" ${share.grants?.[p.id] === "write" ? "selected" : ""}>Lecture et écriture</option>
          </select>
        </div>`).join("")
      : `<div class="empty">Ce Lumen n'a qu'un profil. Ajoutez-en d'autres dans Paramètres → Session pour partager.</div>`}
      <p class="hint">Le droit est vérifié côté Rust à chaque appel : un espace en lecture n'a aucun chemin d'écriture. Il décrit ce que l'ESPACE autorise — pas ce que la personne peut faire si elle ouvre DB Studio elle-même.</p>
    </div>`;
  $("share-body").querySelectorAll('input[name="s-kind"]').forEach((el) =>
    el.addEventListener("change", () => {
      $("share-body").querySelectorAll(".kind-card").forEach((c) => c.classList.toggle("on", c.contains(el) && el.checked));
    }));
  $("share-modal").hidden = false;
}

async function saveShare() {
  const { model, share } = state.shareCtx;
  const grants = {};
  $("share-body").querySelectorAll(".sp-access").forEach((el) => {
    if (el.value) grants[el.dataset.profile] = el.value;
  });
  const kind = $("share-body").querySelector('input[name="s-kind"]:checked')?.value || "both";
  const name = $("s-name").value.trim();
  if (!name) { $("share-error").textContent = "Donnez un nom à l'application."; return; }
  try {
    await invoke("dbshare_save", {
      id: share?.id || null,
      name,
      description: $("s-desc").value.trim(),
      kind,
      baseId: state.engine.baseId ? state.engine.baseId() : "",
      tableId: model.id,
      tableName: model.name,
      grants,
      grad: [`hsl(${modelHue(model)} 70% 55%)`, `hsl(${(modelHue(model) + 40) % 360} 70% 45%)`],
    });
    $("share-modal").hidden = true;
    await loadShares();
    render();
    toast(Object.keys(grants).length ? "Espace partagé." : "Espace enregistré (personne n'y a encore accès).");
  } catch (e) { $("share-error").textContent = String(e?.message || e); }
}

async function removeShare() {
  const { share } = state.shareCtx;
  if (!share) return;
  if (!await confirmSheet({ title: "Ne plus partager cet espace ?", body: "L'application disparaît du menu des personnes concernées. La table et ses données ne bougent pas.", confirm: "Ne plus partager", danger: true })) return;
  await invoke("dbshare_delete", { id: share.id });
  $("share-modal").hidden = true;
  await loadShares();
  render();
  toast("Partage retiré.");
}

// ---------- Modèles ----------

function renderModels() {
  $("models-list").innerHTML = state.models.map((m) => `
    <div class="list-row ${m.id === state.selected ? "on" : ""}" data-act="select-model" data-id="${esc(m.id)}">
      <div class="l-main"><div class="l-title">${esc(m.name)}</div>
      <div class="l-sub">${m.fields.length} champ(s) · ${m.rows ?? 0} ligne(s)</div></div>
    </div>`).join("") || `<div class="empty">Aucun modèle. Créez-en un, ou décrivez-le à l'assistant.</div>`;

  const model = current();
  const host = $("model-editor");
  if (!model) {
    host.innerHTML = `<div class="card"><div class="empty">Créez un premier modèle : une table, ses champs, et le formulaire qui va avec.</div></div>`;
    return;
  }
  const rel = (f) => f.kind === "relation"
    ? `<span class="badge">${esc(CARDINALITIES[f.cardinality]?.label || "")} → ${esc(modelById(f.target)?.name || f.target || "?")}</span>` : "";
  host.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>${esc(model.name)}</h2>
        <div class="row-actions">
          <button class="btn tiny ghost" data-act="rename-model">Renommer</button>
          <button class="btn tiny ghost danger" data-act="delete-model">Supprimer</button>
          <button class="btn tiny primary" data-act="new-field">+ Champ</button>
        </div>
      </div>
      <div class="table-card">
      <table class="grid fields-grid">
        <thead><tr><th></th><th>Champ</th><th>Type</th><th>Contraintes</th><th>Formulaire</th><th></th></tr></thead>
        <tbody>${model.fields.map((f, i) => `<tr>
          <td class="handle">
            <button class="mini" data-act="move-field" data-id="${esc(f.id)}" data-dir="-1" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="mini" data-act="move-field" data-id="${esc(f.id)}" data-dir="1" ${i === model.fields.length - 1 ? "disabled" : ""}>↓</button>
          </td>
          <td><strong>${esc(f.name)}</strong>${f.help ? `<div class="l-sub">${esc(f.help)}</div>` : ""}</td>
          <td><span class="kind">${esc(kindLabel(f.kind))}</span> ${rel(f)}</td>
          <td>${[f.required ? `<span class="badge warn">obligatoire</span>` : "", f.unique ? `<span class="badge">unique</span>` : "",
                 f.kind === "select" && f.options?.length ? `<span class="badge">${esc(f.options.join(" · "))}</span>` : "",
                 f.def ? `<span class="badge">défaut : ${esc(f.def)}</span>` : ""].filter(Boolean).join(" ") || "—"}</td>
          <td>${f.inForm === false ? `<span class="badge">masqué</span>` : `<span class="badge ok">visible</span>`}</td>
          <td><div class="row-actions">
            <button class="btn tiny ghost" data-act="edit-field" data-id="${esc(f.id)}">Modifier</button>
            <button class="btn tiny ghost danger" data-act="delete-field" data-id="${esc(f.id)}">Suppr.</button>
          </div></td></tr>`).join("") || `<tr><td colspan="6"><div class="empty">Ce modèle n'a pas encore de champ.</div></td></tr>`}</tbody>
      </table>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Formulaire de saisie</h2><span class="hint">Ce que verra la personne qui remplit.</span></div>
      <div class="form-grid form-designer">
        <label>Titre du formulaire<input id="form-title" value="${esc(model.form?.title || model.name)}" /></label>
        <label>Texte du bouton<input id="form-submit" value="${esc(model.form?.submitLabel || "Enregistrer")}" /></label>
        <label class="wide">Introduction<textarea id="form-intro" rows="2" placeholder="Phrase affichée en haut du formulaire">${esc(model.form?.intro || "")}</textarea></label>
      </div>
      <div class="form-actions"><button class="btn" data-act="save-form">Enregistrer le formulaire</button><button class="btn ghost" data-act="preview-form">Aperçu</button></div>
    </section>`;
}

// ---------- Schéma ----------
//
// Un diagramme dessiné à la main plutôt qu'une bibliothèque : les boîtes sont
// posées sur une grille, les relations reliées par une courbe. L'objectif est de
// VOIR les liens, pas de produire un diagramme UML complet.

function renderSchema() {
  const host = $("schema-host");
  if (!state.models.length) { host.innerHTML = `<div class="empty">Rien à dessiner : commencez par créer un modèle.</div>`; return; }
  const W = 230, H0 = 46, LINE = 20, GAP_X = 90, GAP_Y = 50, COLS = Math.min(3, state.models.length);
  const box = (m, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const shown = m.fields.slice(0, 8);
    const h = H0 + shown.length * LINE + (m.fields.length > 8 ? LINE : 0);
    return { m, x: 20 + col * (W + GAP_X), y: 20 + row * 260, w: W, h, shown };
  };
  const boxes = state.models.map(box);
  const byId = new Map(boxes.map((b) => [b.m.id, b]));
  const width = 40 + COLS * (W + GAP_X);
  const height = 40 + Math.ceil(state.models.length / COLS) * 260;

  const links = [];
  for (const b of boxes) {
    for (const f of b.m.fields) {
      if (f.kind !== "relation" || !f.target) continue;
      const t = byId.get(f.target) || boxes.find((x) => x.m.name === f.target);
      if (!t || t === b) continue;
      // La flèche part du bord le plus proche de la cible : sinon elle
      // traverserait les deux boîtes pour rejoindre une table située à gauche.
      const toLeft = t.x < b.x;
      const x1 = toLeft ? b.x : b.x + b.w;
      const x2 = toLeft ? t.x + t.w : t.x;
      const y1 = b.y + 30, y2 = t.y + 30;
      const mid = (x1 + x2) / 2;
      links.push(`<path d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" class="link" marker-end="url(#arrow)"/>
        <text x="${mid}" y="${(y1 + y2) / 2 - 6}" class="link-label" text-anchor="middle">${esc(f.name)}${f.cardinality === "many" ? " (n–n)" : ""}</text>`);
    }
  }

  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="schema" role="img" aria-label="Schéma de la base">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head"/></marker></defs>
    ${links.join("")}
    ${boxes.map((b) => `<g class="node" transform="translate(${b.x},${b.y})">
      <rect width="${b.w}" height="${b.h}" rx="10"/>
      <text x="12" y="24" class="node-title">${esc(b.m.name)}</text>
      <line x1="0" y1="34" x2="${b.w}" y2="34"/>
      ${b.shown.map((f, j) => `<text x="12" y="${52 + j * 20}" class="node-field">${esc(f.name)}<tspan class="node-type"> · ${esc(kindLabel(f.kind))}</tspan></text>`).join("")}
      ${b.m.fields.length > 8 ? `<text x="12" y="${52 + b.shown.length * 20}" class="node-more">+ ${b.m.fields.length - 8} autre(s)</text>` : ""}
    </g>`).join("")}
  </svg>`;
}

// ---------- Données ----------

function filteredRows(model) {
  return selectRows(state.rows, model.fields, {
    search: $("data-search").value, sort: state.sort, direction: state.direction,
  }, (field, value) => displayValue(model, field, value));
}

function renderData() {
  $("data-model").innerHTML = state.models.map(m => `<option value="${esc(m.id)}" ${m.id === state.dataModel ? "selected" : ""}>${esc(m.name)}</option>`).join("");
  const model = modelById(state.dataModel);
  const hidden = state.hiddenColumns.get(state.dataModel) || new Set();
  const shown = (model?.fields || []).filter(f => !hidden.has(f.id));
  $("data-columns").innerHTML = (model?.fields || []).map(f => `<label><input type="checkbox" aria-label="${esc(f.name)}" data-column="${esc(f.id)}" ${hidden.has(f.id) ? "" : "checked"}> ${esc(f.name)}</label>`).join("");
  const rows = model ? filteredRows(model) : [];
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.page = Math.min(state.page, pages - 1);
  const page = rows.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
  $("data-table").innerHTML = `<thead><tr><th>ID</th>${shown.map(f => `<th aria-sort="${state.sort === f.id ? (state.direction === 1 ? "ascending" : "descending") : "none"}"><button class="sort-button" data-act="sort-data" data-id="${esc(f.id)}">${esc(f.name)} <span>${state.sort === f.id ? (state.direction === 1 ? "↑" : "↓") : "↕︎"}</span></button></th>`).join("")}<th>Actions</th></tr></thead>
    <tbody>${page.map(r => `<tr><td class="hint">${esc(r._id)}</td>${shown.map(f => `<td>${esc(displayValue(model, f, r.values[f.id]))}</td>`).join("")}<td><div class="row-actions"><button class="btn tiny ghost" data-act="edit-record" data-id="${esc(r._id)}">Ouvrir</button><button class="btn tiny ghost danger" data-act="delete-record" data-id="${esc(r._id)}">Suppr.</button></div></td></tr>`).join("") || `<tr><td colspan="${shown.length + 2}"><div class="empty">${state.loading ? "Chargement…" : !model ? "Créez un modèle pour commencer à saisir vos données." : state.rows.length ? "Aucun résultat. Modifiez votre recherche." : "Aucun enregistrement. Ajoutez votre première entrée."}</div></td></tr>`}</tbody>`;
  $("data-count").textContent = `${rows.length} résultat(s) sur ${state.rows.length} lignes chargées${state.hasMore ? " · Chargement partiel" : ""}${state.loading ? " · Chargement…" : ""}`;
  $("data-page").textContent = `${state.page + 1} / ${pages}`;
  document.querySelector('[data-act="previous-page"]').disabled = state.page === 0;
  document.querySelector('[data-act="next-page"]').disabled = state.page >= pages - 1;
  $("data-more").hidden = !state.hasMore;
  $("data-more").disabled = state.loading;
  document.querySelector('[data-act="export-data"]').disabled = !rows.length || state.loading;
}

/** Rendu d'une valeur en tableau : une relation montre le NOM de sa cible. */
function displayValue(model, field, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (field.kind === "bool") return value ? "oui" : "non";
  if (field.kind === "money") return Number(value).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  if (field.kind === "number") return Number(value).toLocaleString("fr-FR", { maximumFractionDigits: 4 });
  if (field.kind !== "relation") return String(value);
  const target = modelById(field.target);
  const ids = field.cardinality === "many" ? safeIds(value) : [Number(value)];
  if (!target) return ids.join(", ");
  const labels = ids.map((id) => {
    const row = (relationCache.get(target.id) || []).find((r) => r._id === id);
    return row ? rowLabel(target, row, field.display) : `#${id}`;
  });
  return labels.join(", ");
}

const safeIds = (value) => { try { return JSON.parse(value) || []; } catch { return []; } };

// Enregistrements des tables cibles, pour afficher un nom au lieu d'un id.
//
// Ce cache a deux règles, apprises d'un menu de sélection désespérément vide :
//   * il n'enregistre QUE les lectures réussies. Mémoriser un échec revenait à
//     retenir « cette table n'a aucune ligne » pour toute la session ;
//   * il se relit (`refresh`) à chaque ouverture du formulaire et s'oublie après
//     une écriture. Le parent que l'on vient de créer doit être proposé tout de
//     suite, pas au prochain lancement.
const relationCache = new Map();
async function primeRelations(model, { refresh = false } = {}) {
  for (const f of model.fields) {
    if (f.kind !== "relation" || !f.target) continue;
    if (!refresh && relationCache.has(f.target)) continue;
    const target = modelById(f.target);
    if (!target) continue;
    try {
      relationCache.set(target.id, await state.engine.rows(target, 300));
    } catch {
      // Lecture impossible : on laisse le cache tel quel plutôt que d'y poser
      // une liste vide qui ne serait jamais retentée.
      if (!relationCache.has(target.id)) relationCache.set(target.id, []);
    }
  }
}

/** Oublie les lignes mises en cache pour ce modèle : il vient d'être écrit. */
function invalidateRelations(modelId) {
  relationCache.delete(modelId);
}

// ---------- Moteur ----------

function renderSettings() {
  const cfg = state.cfg;
  $("engine-choice").innerHTML = Object.entries(ENGINES).map(([id, e]) => `
    <label class="engine-card ${cfg.engine === id ? "on" : ""}">
      <input type="radio" name="engine" value="${id}" ${cfg.engine === id ? "checked" : ""} />
      <div><div class="e-title">${esc(e.label)}</div><div class="e-hint">${esc(e.hint)}</div></div>
    </label>`).join("");
  // Le moteur serveur ne se règle pas ici : la liaison se fait une fois, dans
  // l'Annuaire, et vaut pour toutes les applications réseau.
  $("engine-fields").innerHTML = cfg.engine === "server"
    ? `<p class="hint wide">Les tables vivent sur le Lumen Server auquel ce poste est lié. La liaison se règle dans
         l'application <strong>Annuaire</strong> ; les droits (lecture, écriture) se donnent table par table,
         et c'est le serveur qui les vérifie à chaque appel.</p>`
    : cfg.engine === "postgres"
    ? `<label class="wide">URL de connexion<input id="pg-url" value="${esc(cfg.url)}" placeholder="postgresql://utilisateur:motdepasse@serveur:5432/base" /></label>
       <label>Schéma<input id="pg-schema" value="${esc(cfg.schema || "public")}" /></label>
       <p class="hint wide">L'URL n'est pas envoyée ailleurs qu'à votre serveur : c'est le processus Lumen qui se connecte, en direct.</p>`
    : `<label>Nom de la base locale<input id="sq-base" value="${esc(cfg.base || "Studio")}" /></label>
       <p class="hint wide">Cette base apparaît telle quelle dans Prisme → Tables, dans le NL→SQL et pour les agents.</p>`;
}

// ============================ Édition d'un champ ============================

function openField(field, isNew) {
  state.fieldCtx = { field: { ...blankField(), ...field }, isNew };
  const f = state.fieldCtx.field;
  $("field-title").textContent = isNew ? "Nouveau champ" : `Champ « ${f.name} »`;
  const targets = state.models.filter((m) => m.id !== current()?.id);
  $("field-body").innerHTML = `
    <div class="form-grid">
      <label class="wide">Nom du champ<input id="f-name" value="${esc(f.name)}" placeholder="Ex. : Raison sociale" /></label>
      <label class="wide">Type
        <div class="kind-grid">${KIND_IDS.map((k) => `
          <button type="button" class="kind-card ${k === f.kind ? "on" : ""}" data-kind="${k}">
            <span class="k-name">${esc(FIELD_KINDS[k].label)}</span>
            <span class="k-sample">${esc(FIELD_KINDS[k].sample)}</span>
          </button>`).join("")}</div>
      </label>
      <div class="wide" id="f-extra"></div>
      <label class="check-field"><input type="checkbox" id="f-required" ${f.required ? "checked" : ""} /> Obligatoire</label>
      <label class="check-field"><input type="checkbox" id="f-unique" ${f.unique ? "checked" : ""} /> Valeur unique</label>
      <label class="check-field"><input type="checkbox" id="f-inform" ${f.inForm !== false ? "checked" : ""} /> Afficher dans le formulaire</label>
      <label>Valeur par défaut<input id="f-def" value="${esc(f.def || "")}" /></label>
      <label class="wide">Aide affichée<input id="f-help" value="${esc(f.help || "")}" placeholder="Phrase montrée sous le champ" /></label>
    </div>`;
  renderFieldExtra(targets);
  $("field-modal").hidden = false;
  $("f-name").focus();
}

function renderFieldExtra(targets) {
  const f = state.fieldCtx.field;
  const host = $("f-extra");
  if (f.kind === "select") {
    host.innerHTML = `<label>Choix possibles (un par ligne)<textarea id="f-options" rows="3">${esc((f.options || []).join("\n"))}</textarea></label>`;
  } else if (f.kind === "relation") {
    // La cible affichée par défaut est la première de la liste : sans cela, le
    // menu « champ affiché » resterait vide tant qu'on n'a pas touché la cible.
    const targetId = f.target || targets[0]?.id || "";
    const target = modelById(targetId);
    const shown = (target?.fields || []).filter((x) => x.kind !== "relation");
    host.innerHTML = `<div class="form-grid">
      <label>Table cible<select id="f-target">${targets.map((m) => `<option value="${esc(m.id)}" ${m.id === targetId ? "selected" : ""}>${esc(m.name)}</option>`).join("") || `<option value="">Créez d'abord une autre table</option>`}</select></label>
      <label>Cardinalité<select id="f-card">${Object.entries(CARDINALITIES).map(([k, c]) => `<option value="${k}" ${k === f.cardinality ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select></label>
      <label class="wide">Champ affiché<select id="f-display">
        <option value="">Deviné (premier champ texte)</option>
        ${shown.map((x) => `<option value="${esc(x.id)}" ${x.id === f.display ? "selected" : ""}>${esc(x.name)}</option>`).join("")}
      </select><small class="hint">Ce que vous lirez dans le menu de sélection et dans les tableaux — un nom, une référence, un code — plutôt que l'identifiant.</small></label>
      <p class="hint wide">${esc(CARDINALITIES[f.cardinality]?.hint || "")}</p></div>`;
  } else {
    host.innerHTML = "";
  }
}

function readFieldForm() {
  const f = state.fieldCtx.field;
  f.name = $("f-name").value.trim();
  f.required = $("f-required").checked;
  f.unique = $("f-unique").checked;
  f.inForm = $("f-inform").checked;
  f.def = $("f-def").value;
  f.help = $("f-help").value.trim();
  if (f.kind === "select") f.options = ($("f-options")?.value || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (f.kind === "relation") {
    f.target = $("f-target")?.value || "";
    f.cardinality = $("f-card")?.value || "one";
    f.display = $("f-display")?.value || "";
  }
  return f;
}

async function saveField() {
  const model = current();
  const { field, isNew } = state.fieldCtx;
  readFieldForm();
  if (!field.name) { toast("Donnez un nom au champ."); return; }
  if (field.kind === "relation" && !field.target) { toast("Choisissez la table cible de la relation."); return; }
  if (isNew && model.fields.some((f) => f.name.toLowerCase() === field.name.toLowerCase())) {
    toast("Ce modèle a déjà un champ portant ce nom."); return;
  }
  if (isNew) await state.engine.addField(model.id, field);
  else await state.engine.updateField(model.id, field.id, field);
  $("field-modal").hidden = true;
  await reload();
  render();
  toast(isNew ? `Champ « ${field.name} » ajouté.` : "Champ mis à jour.");
}

// ============================ Formulaire de saisie ============================

function widgetHtml(model, field, value) {
  const id = `w-${field.id}`;
  const common = `id="${id}" data-field="${esc(field.id)}"`;
  switch (field.kind) {
    case "longtext":
      return `<textarea ${common} rows="3">${esc(value ?? "")}</textarea>`;
    case "bool":
      return `<label class="check"><input type="checkbox" ${common} ${value ? "checked" : ""} /> Oui</label>`;
    case "select":
      return `<select ${common}><option value=""></option>${(field.options || []).map((o) => `<option ${String(value) === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    case "relation": {
      const target = modelById(field.target);
      const rows = relationCache.get(field.target) || [];
      const label = (r) => esc(rowLabel(target, r, field.display));
      if (field.cardinality === "many") {
        const chosen = safeIds(value);
        return `<select ${common} multiple size="4">${rows.map((r) => `<option value="${r._id}" ${chosen.includes(r._id) ? "selected" : ""}>${label(r)}</option>`).join("")}</select>`;
      }
      // Un menu vide n'est pas une absence de choix, c'est une table cible sans
      // ligne : on le dit, plutôt que de laisser l'utilisateur chercher.
      if (!rows.length) {
        return `<select ${common} disabled><option value="">Aucun enregistrement dans « ${esc(target?.name || "la table cible")} »</option></select>`;
      }
      const options = rows.map((r) => `<option value="${r._id}" ${String(value) === String(r._id) ? "selected" : ""}>${label(r)}</option>`).join("");
      return `<select ${common}><option value=""></option>${options}</select>`;
    }
    case "number": case "integer": case "money":
      return `<input ${common} type="number" step="${field.kind === "integer" ? "1" : "0.01"}" value="${esc(value ?? "")}" />`;
    case "date": return `<input ${common} type="date" value="${esc(value ?? "")}" />`;
    case "datetime": return `<input ${common} type="datetime-local" value="${esc(String(value ?? "").replace(" ", "T").slice(0, 16))}" />`;
    default:
      return `<input ${common} type="${FIELD_KINDS[field.kind]?.widget === "input" ? "text" : FIELD_KINDS[field.kind]?.widget}" value="${esc(value ?? "")}" />`;
  }
}

async function openRecord(model, row) {
  await primeRelations(model, { refresh: true });
  state.recordCtx = { model, row };
  const form = model.form || {};
  $("record-title").textContent = row ? `${form.title || model.name} — modification` : (form.title || model.name);
  const fields = model.fields.filter((f) => f.inForm !== false);
  $("record-body").innerHTML = `
    ${form.intro ? `<p class="hint">${esc(form.intro)}</p>` : ""}
    <div class="form-grid">${fields.map((f) => `
      <label class="${["longtext", "relation"].includes(f.kind) ? "wide" : ""}">
        ${esc(f.name)}${f.required ? ` <span class="req">*</span>` : ""}
        ${widgetHtml(model, f, row?.values?.[f.id])}
        ${f.help ? `<small class="hint">${esc(f.help)}</small>` : ""}
      </label>`).join("")}</div>`;
  $("record-error").textContent = "";
  $("record-save").textContent = form.submitLabel || "Enregistrer";
  $("record-modal").hidden = false;
}

/** Lit le formulaire et renvoie { values, error }. */
function readRecordForm(model) {
  const values = {};
  for (const f of model.fields) {
    if (f.inForm === false) continue;
    const el = document.querySelector(`[data-field="${CSS.escape(f.id)}"]`);
    if (!el) continue;
    let raw;
    if (f.kind === "bool") raw = el.checked;
    else if (f.kind === "relation" && f.cardinality === "many") raw = [...el.selectedOptions].map((o) => Number(o.value));
    else raw = el.value;
    const problem = validateValue(f, raw);
    if (problem) return { error: problem };
    values[f.id] = coerceValue(f, raw);
  }
  return { values };
}

async function saveRecord() {
  const { model, row } = state.recordCtx;
  const { values, error } = readRecordForm(model);
  if (error) { $("record-error").textContent = error; return; }
  if (row) await state.engine.updateRow(model, row._id, values);
  else await state.engine.insertRow(model, values);
  invalidateRelations(model.id);
  state.cardRows.delete(model.id);
  $("record-modal").hidden = true;
  await reload();
  await loadRows(modelById(state.dataModel));
  await primeCards();
  render();
  toast(row ? "Enregistrement mis à jour." : "Enregistrement créé.");
}

// ============================ Assistant ============================

const KIND_ENUM = KIND_IDS;

const DB_TOOLS = [
  tool("list_models", "Liste les modèles (tables) avec leurs champs, types et relations.", {}),
  tool("create_model", "Crée un modèle : une table et ses champs.",
    { nom: T.str("Nom du modèle, au singulier ou au pluriel selon l'usage métier"),
      champs: { type: "array", description: "Champs du modèle, dans l'ordre du formulaire",
        items: { type: "object", properties: {
          nom: T.str(""), type: T.enum(KIND_ENUM, "Type de champ"), obligatoire: T.bool(""),
          options: T.list("Choix possibles pour un champ de type select"),
          cible: T.str("Nom du modèle visé, pour un champ de type relation"),
          cardinalite: T.enum(["one", "many"], "Un seul enregistrement lié, ou plusieurs"),
          aide: T.str("Phrase affichée sous le champ"),
        }, required: ["nom", "type"] } } },
    ["nom", "champs"]),
  tool("add_field", "Ajoute un champ à un modèle existant.",
    { modele: T.str("Nom du modèle"), nom: T.str(""), type: T.enum(KIND_ENUM, ""), obligatoire: T.bool(""),
      options: T.list("Pour un select"), cible: T.str("Pour une relation : nom du modèle visé"),
      cardinalite: T.enum(["one", "many"], ""), aide: T.str("") },
    ["modele", "nom", "type"]),
  tool("delete_field", "Supprime un champ d'un modèle (et ses données).",
    { modele: T.str(""), champ: T.str("Nom du champ") }, ["modele", "champ"]),
  tool("set_form", "Règle le formulaire de saisie d'un modèle.",
    { modele: T.str(""), titre: T.str(""), intro: T.str("Phrase d'introduction"), bouton: T.str("Libellé du bouton"),
      champs_masques: T.list("Noms des champs à retirer du formulaire") }, ["modele"]),
  tool("create_record", "Crée un enregistrement. Les valeurs sont données par NOM de champ.",
    { modele: T.str(""), valeurs: { type: "object", description: "Objet { \"Nom du champ\": valeur }. Pour une relation, donner le libellé ou l'identifiant de la ligne visée.", additionalProperties: true } },
    ["modele", "valeurs"]),
  tool("list_records", "Liste les enregistrements d'un modèle.",
    { modele: T.str(""), limite: T.int("Défaut 20") }, ["modele"]),
  tool("query", "Requête SQL de LECTURE sur la base courante (SELECT uniquement).",
    { sql: T.str("SELECT complet") }, ["sql"]),
];

/** Retrouve un modèle par nom, avec tolérance de casse et d'accents. */
function findModel(name) {
  const want = slug(name);
  return state.models.find((m) => slug(m.name) === want)
    || state.models.find((m) => m.id === name)
    || state.models.find((m) => slug(m.name).startsWith(want));
}

const findField = (model, name) => {
  const want = slug(name);
  return model.fields.find((f) => slug(f.name) === want) || model.fields.find((f) => f.id === name);
};

/** Convertit une description de champ venue de l'assistant en champ du modèle. */
function fieldFromArgs(a) {
  const field = blankField(KIND_ENUM.includes(a.type) ? a.type : "text", String(a.nom || "").trim());
  field.required = !!a.obligatoire;
  field.options = Array.isArray(a.options) ? a.options : [];
  field.help = a.aide || "";
  field.cardinality = a.cardinalite === "many" ? "many" : "one";
  if (field.kind === "relation") field.target = findModel(a.cible)?.id || "";
  return field;
}

async function runDbTool(name, a) {
  switch (name) {
    case "list_models": {
      if (!state.models.length) return "Aucun modèle pour l'instant.";
      return state.models.map((m) => `${m.name} (${m.rows ?? 0} ligne(s)) : ${m.fields.map((f) =>
        `${f.name} [${f.kind}${f.required ? ", obligatoire" : ""}${f.kind === "relation" ? ` → ${modelById(f.target)?.name || f.target}` : ""}]`).join(", ") || "aucun champ"}`).join("\n");
    }
    case "create_model": {
      if (findModel(a.nom)) return `Le modèle « ${a.nom} » existe déjà — utilise add_field pour le compléter.`;
      const fields = (a.champs || []).map(fieldFromArgs).filter((f) => f.name);
      if (!fields.length) return "Donne au moins un champ.";
      // Une relation vers un modèle pas encore créé est posée après coup : on
      // crée d'abord la table, puis on relie, sinon l'ordre des demandes de
      // l'utilisateur imposerait le sien.
      const pending = fields.filter((f) => f.kind === "relation" && !f.target);
      await state.engine.createModel(String(a.nom).trim(), fields.filter((f) => !pending.includes(f)));
      await reload();
      const created = findModel(a.nom);
      state.selected = created?.id || state.selected;
      for (const f of pending) {
        const target = findModel(f.target || "");
        if (target) { f.target = target.id; await state.engine.addField(created.id, f); }
      }
      await reload(); render();
      return `Modèle « ${a.nom} » créé avec ${fields.length} champ(s)${pending.length ? ` (dont ${pending.length} relation(s) laissée(s) de côté faute de cible)` : ""}.`;
    }
    case "add_field": {
      const model = findModel(a.modele);
      if (!model) return `Modèle « ${a.modele} » introuvable.`;
      if (findField(model, a.nom)) return `Le champ « ${a.nom} » existe déjà sur ${model.name}.`;
      const field = fieldFromArgs(a);
      if (field.kind === "relation" && !field.target) return `Table cible « ${a.cible} » introuvable : crée-la d'abord.`;
      await state.engine.addField(model.id, field);
      await reload(); render();
      return `Champ « ${field.name} » (${kindLabel(field.kind)}) ajouté à ${model.name}.`;
    }
    case "delete_field": {
      const model = findModel(a.modele);
      const field = model && findField(model, a.champ);
      if (!field) return `Champ introuvable.`;
      await state.engine.deleteField(model.id, field.id);
      await reload(); render();
      return `Champ « ${field.name} » supprimé de ${model.name}.`;
    }
    case "set_form": {
      const model = findModel(a.modele);
      if (!model) return `Modèle « ${a.modele} » introuvable.`;
      const form = { ...(model.form || {}) };
      if (a.titre) form.title = a.titre;
      if (a.intro !== undefined) form.intro = a.intro;
      if (a.bouton) form.submitLabel = a.bouton;
      await state.engine.setForm(model.id, form);
      for (const name of a.champs_masques || []) {
        const f = findField(model, name);
        if (f) await state.engine.updateField(model.id, f.id, { ...f, inForm: false });
      }
      await reload(); render();
      return `Formulaire de ${model.name} mis à jour.`;
    }
    case "create_record": {
      const model = findModel(a.modele);
      if (!model) return `Modèle « ${a.modele} » introuvable.`;
      await primeRelations(model);
      const values = {};
      const problems = [];
      for (const [key, raw] of Object.entries(a.valeurs || {})) {
        const field = findField(model, key);
        if (!field) { problems.push(`champ inconnu « ${key} » ignoré`); continue; }
        let value = raw;
        if (field.kind === "relation") value = resolveRelation(field, raw);
        const problem = validateValue(field, value);
        if (problem) return problem;
        values[field.id] = coerceValue(field, value);
      }
      for (const f of model.fields) {
        if (f.required && values[f.id] === undefined) return `« ${f.name} » est obligatoire : demande la valeur avant de créer.`;
      }
      await state.engine.insertRow(model, values);
      invalidateRelations(model.id);
      await reload();
      if (state.dataModel === model.id) await loadRows(model);
      render();
      return `Enregistrement créé dans ${model.name}.${problems.length ? " (" + problems.join(", ") + ")" : ""}`;
    }
    case "list_records": {
      const model = findModel(a.modele);
      if (!model) return `Modèle « ${a.modele} » introuvable.`;
      await primeRelations(model);
      const rows = await state.engine.rows(model, Math.min(Number(a.limite) || 20, 200));
      if (!rows.length) return `${model.name} ne contient aucun enregistrement.`;
      return rows.map((r) => `#${r._id} — ` + model.fields.slice(0, 6)
        .map((f) => `${f.name}: ${displayValue(model, f, r.values[f.id])}`).join(" · ")).join("\n");
    }
    case "query": {
      const res = await state.engine.query(a.sql);
      return JSON.stringify(res).slice(0, 6000);
    }
    default: return `Outil inconnu : ${name}`;
  }
}

/** Une relation donnée par libellé (« Dupont SAS ») devient un identifiant. */
function resolveRelation(field, raw) {
  const target = modelById(field.target);
  if (!target) return null;
  const rows = relationCache.get(target.id) || [];
  const one = (v) => {
    if (typeof v === "number" || /^\d+$/.test(String(v))) return Number(v);
    // Le modèle compare le libellé QU'IL VOIT : celui du champ désigné sur la
    // relation, pas un autre.
    const found = rows.find((r) => rowLabel(target, r, field.display).toLowerCase() === String(v).toLowerCase());
    return found ? found._id : null;
  };
  return field.cardinality === "many" ? (Array.isArray(raw) ? raw : [raw]).map(one).filter(Boolean) : one(raw);
}

function mountAi() {
  mountAiPrompt(null, {
    app: "DB Studio",
    title: "Assistant",
    intro: "Tu modélises la base de données de l'utilisateur : tables (« modèles »), champs typés, relations, formulaires de saisie et enregistrements.",
    rules: [
      "- Commence toujours par list_models : ne recrée jamais un modèle ou un champ qui existe.",
      "- Crée les tables AVANT les relations qui les visent, sinon la cible est introuvable.",
      "- Choisis le type le plus précis : un e-mail n'est pas un texte, un montant n'est pas un nombre quelconque — c'est ce qui rend le formulaire et les contrôles utiles.",
      "- Ne mets « obligatoire » que si l'utilisateur l'a demandé ou si le métier l'impose de façon évidente.",
      "- Pour saisir des données, passe par create_record : c'est lui qui valide les contraintes du modèle.",
    ].join("\n"),
    placeholder: "Ex. : modélise une base de gestion de flotte : véhicules, conducteurs, interventions…",
    suggestions: [
      { label: "Modéliser une base", prompt: "Aide-moi à modéliser une base pour mon métier : pose-moi les questions utiles, puis crée les modèles et leurs relations." },
      { label: "Ajouter une relation", prompt: "Ajoute une relation entre deux de mes modèles et explique-moi ce qu'elle change à la saisie." },
      { label: "Générer un formulaire", prompt: "Règle le formulaire de saisie d'un de mes modèles pour qu'il soit clair et court." },
      { label: "Contrôler le modèle", prompt: "Relis mon modèle : champs mal typés, contraintes manquantes, relations douteuses." },
      { label: "Jeu d'essai", prompt: "Crée trois enregistrements d'exemple cohérents dans chacun de mes modèles." },
    ],
    tools: DB_TOOLS,
    context: async () => [
      `Moteur : ${state.engine?.label || "—"}.`,
      `Modèles : ${state.models.map((m) => `${m.name} (${m.fields.length} champs, ${m.rows ?? 0} lignes)`).join(" | ") || "aucun"}.`,
      await state.engine.schemaPrompt().catch(() => "(schéma indisponible)"),
    ].join("\n"),
    execute: runDbTool,
    onApplied: async () => { await reload(); render(); },
  });
}

// ============================ Câblage ============================

function wire() {
  $("nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) showView(b.dataset.view);
  });

  document.querySelectorAll(".backdrop").forEach((bd) => bd.addEventListener("click", (e) => {
    if (e.target === bd || e.target.closest("[data-close]")) bd.hidden = true;
  }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".backdrop:not([hidden])").forEach((bd) => { bd.hidden = true; });
  });

  $("field-save").addEventListener("click", saveField);
  $("record-save").addEventListener("click", saveRecord);

  // Palette de types : changer de type recompose la partie variable du panneau.
  $("field-body").addEventListener("click", (e) => {
    const card = e.target.closest("[data-kind]");
    if (!card) return;
    readFieldForm();
    state.fieldCtx.field.kind = card.dataset.kind;
    document.querySelectorAll("#field-body .kind-card").forEach((c) => c.classList.toggle("on", c === card));
    renderFieldExtra(state.models.filter((m) => m.id !== current()?.id));
  });
  $("field-body").addEventListener("change", (e) => {
    if (e.target.id === "f-card") {
      state.fieldCtx.field.cardinality = e.target.value;
      renderFieldExtra(state.models.filter((m) => m.id !== current()?.id));
    }
    if (e.target.id === "f-target") {
      // La cible change : les champs affichables aussi. Le libellé retenu
      // appartenait à l'ancienne table, il ne veut plus rien dire.
      state.fieldCtx.field.target = e.target.value;
      state.fieldCtx.field.display = "";
      renderFieldExtra(state.models.filter((m) => m.id !== current()?.id));
    }
  });

  $("data-model").addEventListener("change", async (e) => {
    state.dataModel = e.target.value;
    const model = modelById(state.dataModel);
    await primeRelations(model);
    await loadRows(model);
    render();
  });
  $("data-search").addEventListener("input", () => { state.page = 0; renderData(); });
  $("data-size").addEventListener("change", e => { state.pageSize = Number(e.target.value); state.page = 0; renderData(); });
  $("data-columns").addEventListener("change", e => {
    if (!e.target.dataset.column) return;
    const hidden = state.hiddenColumns.get(state.dataModel) || new Set();
    e.target.checked ? hidden.delete(e.target.dataset.column) : hidden.add(e.target.dataset.column);
    state.hiddenColumns.set(state.dataModel, hidden); renderData();
  });

  $("engine-choice").addEventListener("change", (e) => {
    if (e.target.name !== "engine") return;
    state.cfg = { ...state.cfg, engine: e.target.value };
    renderSettings();
  });
  $("engine-save").addEventListener("click", async () => {
    readEngineFields();
    saveEngineConfig(state.cfg);
    $("engine-status").textContent = "Connexion…";
    try {
      const engine = createEngine(state.cfg);
      await engine.ready();
      state.engine = engine;
      relationCache.clear();
      await reload();
      await loadRows(modelById(state.dataModel));
      render();
      $("engine-status").textContent = "Moteur actif.";
      toast(`Moteur : ${engine.label}`);
    } catch (err) {
      $("engine-status").textContent = String(err.message || err);
    }
  });
  $("engine-test").addEventListener("click", async () => {
    readEngineFields();
    $("engine-status").textContent = "Test en cours…";
    try {
      await createEngine(state.cfg).ready();
      $("engine-status").textContent = "Connexion établie.";
    } catch (err) {
      $("engine-status").textContent = String(err.message || err);
    }
  });

  $("card-save").addEventListener("click", saveCardConfig);
  $("share-save").addEventListener("click", saveShare);
  $("share-remove").addEventListener("click", removeShare);

  document.body.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const model = current();
    switch (btn.dataset.act) {
      case "sort-data":
        state.direction = state.sort === id ? -state.direction : 1;
        state.sort = id; state.page = 0; renderData(); break;
      case "previous-page": state.page = Math.max(0, state.page - 1); renderData(); break;
      case "next-page": state.page++; renderData(); break;
      case "load-more":
      case "reload-data":
        if (state.loading) return;
        await loadRows(modelById(state.dataModel), btn.dataset.act === "load-more"); renderData(); break;
      case "export-data": {
        const target = modelById(state.dataModel);
        if (!target) return;
        const fields = target.fields.filter(f => !state.hiddenColumns.get(target.id)?.has(f.id));
        const rows = filteredRows(target);
        downloadText(`${slug(target.name)}.csv`, csvText(["ID", ...fields.map(f => f.name)], rows.map(r => [r._id, ...fields.map(f => r.values[f.id])])));
        toast(`${rows.length} lignes exportées · colonnes visibles, filtre et tri actuels.`); break;
      }
      case "open-data":
        state.dataModel = id;
        await loadRows(modelById(id));
        showView("data");
        break;
      case "open-structure":
        state.selected = id;
        showView("models");
        break;
      case "config-card":
        openCardModal(modelById(id));
        break;
      case "share-model": {
        if (state.cfg.engine === "server") {
          toast("Sur le moteur Lumen Server, les droits se donnent par compte réseau, dans les réglages de la table.");
          return;
        }
        if (state.cfg.engine !== "sqlite") {
          toast("Le partage entre profils ne vaut que pour le moteur SQLite local de Lumen.");
          return;
        }
        openShareModal(modelById(id));
        break;
      }
      case "select-model":
        state.selected = id;
        render();
        break;
      case "new-model": {
        const name = await promptSheet({
          title: "Nouveau modèle",
          body: "Le nom d'une table, au singulier ou au pluriel selon votre usage.",
          placeholder: "Clients, Véhicules, Interventions…",
          confirm: "Créer",
        });
        if (!name?.trim()) return;
        await state.engine.createModel(name.trim(), [blankField("text", "Nom")]);
        await reload();
        state.selected = state.models.find((m) => m.name === name.trim())?.id || state.selected;
        showView("models");
        toast(`Modèle « ${name.trim()} » créé.`);
        break;
      }
      case "rename-model": {
        const name = await promptSheet({ title: "Renommer le modèle", value: model.name, confirm: "Renommer" });
        if (!name?.trim()) return;
        await state.engine.renameModel(model.id, name.trim());
        await reload(); render();
        break;
      }
      case "delete-model":
        if (!await confirmSheet({ title: `Supprimer « ${model.name} » ?`, body: "Le modèle et toutes ses données seront perdus.", confirm: "Supprimer", danger: true })) return;
        await state.engine.deleteModel(model.id);
        state.selected = "";
        await reload(); render();
        toast("Modèle supprimé.");
        break;
      case "new-field": openField(blankField(), true); break;
      case "edit-field": openField(model.fields.find((f) => f.id === id), false); break;
      case "delete-field": {
        const field = model.fields.find((f) => f.id === id);
        if (!await confirmSheet({ title: `Supprimer le champ « ${field.name} » ?`, body: "Les valeurs déjà saisies dans ce champ seront perdues.", confirm: "Supprimer", danger: true })) return;
        await state.engine.deleteField(model.id, field.id);
        await reload(); render();
        break;
      }
      case "move-field": {
        const dir = Number(btn.dataset.dir);
        const ids = model.fields.map((f) => f.id);
        const i = ids.indexOf(id);
        if (i + dir < 0 || i + dir >= ids.length) return;
        [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
        await state.engine.reorderFields(model.id, ids);
        await reload(); render();
        break;
      }
      case "save-form":
        await state.engine.setForm(model.id, {
          ...(model.form || {}),
          title: $("form-title").value.trim(),
          submitLabel: $("form-submit").value.trim() || "Enregistrer",
          intro: $("form-intro").value.trim(),
        });
        await reload(); render();
        toast("Formulaire enregistré.");
        break;
      case "preview-form": await openRecord(model, null); break;
      case "new-record": {
        const target = modelById(state.dataModel) || model;
        if (!target) { toast("Créez d'abord un modèle."); return; }
        await openRecord(target, null);
        break;
      }
      case "edit-record": {
        const target = modelById(state.dataModel);
        await openRecord(target, state.rows.find((r) => String(r._id) === String(id)));
        break;
      }
      case "delete-record": {
        const target = modelById(state.dataModel);
        if (!await confirmSheet({ title: "Supprimer cet enregistrement ?", confirm: "Supprimer", danger: true })) return;
        await state.engine.deleteRow(target, Number(id));
        invalidateRelations(target.id);
        state.cardRows.delete(target.id);
        await loadRows(target);
        await reload(); await primeCards(); render();
        break;
      }
      default: break;
    }
  });
}

function readEngineFields() {
  if (state.cfg.engine === "server") return; // rien à saisir : la liaison est ailleurs
  if (state.cfg.engine === "postgres") {
    state.cfg.url = $("pg-url")?.value.trim() || "";
    state.cfg.schema = $("pg-schema")?.value.trim() || "public";
  } else {
    state.cfg.base = $("sq-base")?.value.trim() || "Studio";
  }
}

// ============================ Démarrage ============================

async function init() {
  if (!(await requireProPage({ appName: "DB Studio" }))) return;
  state.engine = createEngine(state.cfg);
  wire();
  try {
    await state.engine.ready();
    await reload();
    await loadRows(modelById(state.dataModel));
    await loadShares();
    await primeCards();
  } catch (err) {
    // Un moteur PostgreSQL mal réglé ne doit pas condamner l'app : on ouvre sur
    // l'écran qui permet justement de le corriger.
    showView("settings");
    $("engine-status").textContent = String(err.message || err);
    mountAi();
    autoTranslate({ observe: true });
    return;
  }
  showView("spaces");
  mountAi();
  $("brand-sub").textContent = { postgres: "PostgreSQL", server: "Lumen Server" }[state.cfg.engine] || "SQLite local";
  autoTranslate({ observe: true });
}

init();
