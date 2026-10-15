// Espace partagé — l'application autonome qu'un profil reçoit quand on lui
// partage une table de DB Studio.
//
// Elle est délibérément pauvre : un tableau, et un formulaire. Ce n'est pas une
// version réduite de DB Studio, c'est l'écran d'une personne qui vient saisir
// ou consulter, et qui n'a rien à savoir de la modélisation.
//
// La page n'appelle QUE les commandes `dbshare_*`. Elle ne touche jamais à
// `table_row_*` : le droit (lecture / écriture) est vérifié en Rust à chaque
// appel, et ce qu'affiche l'interface ne fait que refléter cette décision. Un
// espace en lecture n'a pas de bouton d'écriture — et n'aurait de toute façon
// aucun chemin pour en emprunter un.

import { autoTranslate } from "../apps-i18n.js";
import { requireProPage } from "../lib/pro-edition.js";
import { confirmSheet } from "../lib/confirm.js";
import { FIELD_KINDS, coerceValue, validateValue } from "./fields.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke
  || (() => Promise.reject(new Error("Ouvrez cette application depuis Lumen.")));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const shareId = new URLSearchParams(location.search).get("share") || "";

const state = {
  info: null,      // réponse de dbshare_open
  fields: [],      // colonnes, remises en forme de champs DB Studio
  rows: [],
  options: new Map(), // tableId cible → [{ id, label }] d'un champ relation
  editing: null,   // ligne en cours de modification (null = création)
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3200);
}

/** Une colonne du moteur redevient un champ DB Studio : c'est sa métadonnée
 *  qui porte la nature réelle (« un e-mail », « un lien vers un client »). */
function fieldOf(column) {
  let meta = {};
  try { meta = JSON.parse(column.meta || "{}"); } catch { meta = {}; }
  return {
    id: column.col_id,
    name: column.name,
    kind: meta.kind || "text",
    required: !!meta.required,
    options: meta.options || [],
    target: meta.target || "",
    display: meta.display || "",
    cardinality: meta.cardinality || "one",
    help: meta.help || "",
    inForm: meta.inForm !== false,
  };
}

// ===================== Affichage =====================

function renderHead() {
  const { share, access, canWrite, canRead } = state.info;
  const badge = canWrite ? "Lecture et écriture" : "Lecture seule";
  $("space-head").innerHTML = `
    <div class="space-title">
      <h1>${esc(share.name)}</h1>
      ${share.description ? `<p>${esc(share.description)}</p>` : ""}
    </div>
    <div class="space-actions">
      <span class="access-pill ${canWrite ? "rw" : "ro"}">${esc(badge)}</span>
      ${canWrite ? `<button class="btn primary" id="new-record">+ Nouvelle entrée</button>` : ""}
    </div>`;
  $("new-record")?.addEventListener("click", () => openRecord(null));
  document.title = `Lumen — ${share.name}`;
  return { access, canRead, canWrite };
}

function cellText(field, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (field.kind === "bool") return value ? "oui" : "non";
  if (field.kind === "money") return Number(value).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  if (field.kind === "relation") {
    const list = state.options.get(field.target) || [];
    const ids = field.cardinality === "many" ? safeIds(value) : [Number(value)];
    return ids.map((id) => list.find((o) => Number(o.id) === id)?.label || `#${id}`).join(", ");
  }
  return String(value);
}

const safeIds = (value) => { try { return JSON.parse(value) || []; } catch { return []; } };

function renderRows() {
  const { canRead, canWrite } = state.info;
  if (!canRead) {
    // Espace de saisie : la personne dépose une entrée sans voir celles des
    // autres. Le dire franchement vaut mieux qu'un tableau vide.
    $("space-main").innerHTML = `<div class="card empty-card">
      <div class="empty-title">Espace de saisie</div>
      <div class="empty-sub">Vous pouvez ajouter des entrées ; celles déjà enregistrées ne sont pas partagées avec vous.</div>
      <button class="btn primary" id="new-record-2">+ Nouvelle entrée</button></div>`;
    $("new-record-2")?.addEventListener("click", () => openRecord(null));
    return;
  }
  const shown = state.fields.slice(0, 8);
  $("space-main").innerHTML = `
    <div class="card table-card">
      <div class="card-head"><h2>${state.rows.length} entrée(s)</h2></div>
      <table class="grid">
        <thead><tr>${shown.map((f) => `<th>${esc(f.name)}</th>`).join("")}${canWrite ? "<th></th>" : ""}</tr></thead>
        <tbody>${state.rows.map((r) => `
          <tr>${shown.map((f) => `<td>${esc(cellText(f, r[f.id]))}</td>`).join("")}
          ${canWrite ? `<td class="handle">
            <button class="btn tiny ghost" data-edit="${r._id}">Ouvrir</button>
            <button class="btn tiny ghost danger" data-remove="${r._id}">Suppr.</button></td>` : ""}</tr>`).join("")
        || `<tr><td colspan="${shown.length + (canWrite ? 1 : 0)}"><div class="empty">Aucune entrée pour l'instant.</div></td></tr>`}</tbody>
      </table>
    </div>`;

  $("space-main").querySelectorAll("[data-edit]").forEach((el) =>
    el.addEventListener("click", () => openRecord(state.rows.find((r) => String(r._id) === el.dataset.edit))));
  $("space-main").querySelectorAll("[data-remove]").forEach((el) =>
    el.addEventListener("click", () => removeRow(Number(el.dataset.remove))));
}

// ===================== Formulaire =====================

function widgetHtml(field, value) {
  const common = `data-field="${esc(field.id)}" ${field.required ? "required" : ""}`;
  switch (field.kind) {
    case "longtext":
      return `<textarea ${common} rows="3">${esc(value ?? "")}</textarea>`;
    case "bool":
      return `<label class="check"><input type="checkbox" ${common} ${value ? "checked" : ""} /> Oui</label>`;
    case "select":
      return `<select ${common}><option value=""></option>${(field.options || [])
        .map((o) => `<option ${String(value) === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    case "relation": {
      const list = state.options.get(field.target) || [];
      if (!list.length) {
        return `<select ${common} disabled><option value="">Aucun enregistrement à lier</option></select>`;
      }
      if (field.cardinality === "many") {
        const chosen = safeIds(value);
        return `<select ${common} multiple size="4">${list.map((o) =>
          `<option value="${o.id}" ${chosen.includes(Number(o.id)) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
      }
      return `<select ${common}><option value=""></option>${list.map((o) =>
        `<option value="${o.id}" ${String(value) === String(o.id) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
    }
    case "number": case "integer": case "money":
      return `<input ${common} type="number" step="${field.kind === "integer" ? "1" : "0.01"}" value="${esc(value ?? "")}" />`;
    case "date": return `<input ${common} type="date" value="${esc(value ?? "")}" />`;
    case "datetime": return `<input ${common} type="datetime-local" value="${esc(String(value ?? "").replace(" ", "T").slice(0, 16))}" />`;
    default: {
      const widget = FIELD_KINDS[field.kind]?.widget;
      return `<input ${common} type="${!widget || widget === "input" ? "text" : widget}" value="${esc(value ?? "")}" />`;
    }
  }
}

function openRecord(row) {
  const form = state.info.meta?.form || state.info.meta || {};
  state.editing = row || null;
  $("record-title").textContent = row ? `${form.title || state.info.share.name} — modification` : (form.title || "Nouvelle entrée");
  $("record-error").textContent = "";
  $("record-save").textContent = form.submitLabel || "Enregistrer";
  $("record-body").innerHTML = `
    ${form.intro ? `<p class="hint">${esc(form.intro)}</p>` : ""}
    <div class="form-grid">${state.fields.filter((f) => f.inForm).map((f) => `
      <label class="${["longtext", "relation"].includes(f.kind) ? "wide" : ""}">
        ${esc(f.name)}${f.required ? ` <span class="req">*</span>` : ""}
        ${widgetHtml(f, row?.[f.id])}
        ${f.help ? `<small class="hint">${esc(f.help)}</small>` : ""}
      </label>`).join("")}</div>`;
  $("record-modal").hidden = false;
}

/** Lit le formulaire avec LES MÊMES règles que DB Studio : un champ obligatoire
 *  l'est ici comme là-bas, parce que c'est la même fonction qui tranche. */
function readForm() {
  const values = {};
  for (const f of state.fields) {
    if (!f.inForm) continue;
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
  const { values, error } = readForm();
  if (error) { $("record-error").textContent = error; return; }
  try {
    if (state.editing) await invoke("dbshare_update", { id: shareId, rowId: state.editing._id, values });
    else await invoke("dbshare_insert", { id: shareId, values });
    $("record-modal").hidden = true;
    await loadRows();
    renderRows();
    toast(state.editing ? "Entrée mise à jour." : "Entrée enregistrée.");
  } catch (e) {
    // Un refus vient du Rust (droit insuffisant) : on l'affiche tel quel plutôt
    // que de le traduire en « erreur inconnue ».
    $("record-error").textContent = String(e?.message || e);
  }
}

async function removeRow(rowId) {
  if (!await confirmSheet({ title: "Supprimer cette entrée ?", confirm: "Supprimer", danger: true })) return;
  try {
    await invoke("dbshare_delete_row", { id: shareId, rowId });
    await loadRows();
    renderRows();
    toast("Entrée supprimée.");
  } catch (e) { toast(String(e?.message || e)); }
}

// ===================== Chargement =====================

async function loadRows() {
  if (!state.info.canRead) { state.rows = []; return; }
  const page = await invoke("dbshare_rows", { id: shareId, limit: 500, offset: 0 });
  state.rows = page?.rows || [];
}

/** Les libellés des champs « relation » viennent du Rust, qui applique la même
 *  règle que DB Studio et refuse toute table qui n'est pas visée par l'espace. */
async function loadRelationOptions() {
  for (const f of state.fields) {
    if (f.kind !== "relation" || !f.target || state.options.has(f.target)) continue;
    try { state.options.set(f.target, await invoke("dbshare_relation_options", { id: shareId, targetId: f.target })); }
    catch { state.options.set(f.target, []); }
  }
}

function fatal(message) {
  $("space-head").innerHTML = "";
  $("space-main").innerHTML = `<div class="card empty-card">
    <div class="empty-title">Espace indisponible</div>
    <div class="empty-sub">${esc(message)}</div></div>`;
}

async function init() {
  if (!(await requireProPage({ appName: "Cet espace partagé" }))) return;
  document.body.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) $("record-modal").hidden = true;
  });
  $("record-save").addEventListener("click", saveRecord);

  if (!shareId) { fatal("Aucun espace n'est désigné dans l'adresse de cette fenêtre."); return; }
  try {
    state.info = await invoke("dbshare_open", { id: shareId });
  } catch (e) { fatal(String(e?.message || e)); return; }

  state.fields = (state.info.columns || []).map(fieldOf);
  renderHead();
  await loadRelationOptions();
  try { await loadRows(); } catch (e) { toast(String(e?.message || e)); }
  renderRows();
  autoTranslate({ observe: true });
}

init();
