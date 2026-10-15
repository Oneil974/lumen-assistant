// Carnet d'adresses — logique front.
//
// Un seul magasin (contacts.json, cf. contacts.rs) et une opération de fusion
// explicite : Lumen propose les personnes qu'il connaît déjà ailleurs, mais
// n'importe rien tout seul. Le carnet reste ce que l'utilisateur y a mis.
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { autoTranslate, tt } from "../apps-i18n.js";
import {
  loadContacts, saveContacts, upsertContact, gatherSuggestions,
  identityKey, ORIGIN_LABELS, CONTEXTS, contextsOf, duplicateGroups, mergePeople,
} from "../lib/contacts-store.js";
import { handoff, makeObject } from "../lib/interop.js";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let contacts = [];
let currentId = null;
let filter = "all";
let needle = "";
let suggestions = [];

const byName = (a, b) =>
  String(a.name || a.email || "").localeCompare(String(b.name || b.email || ""), undefined, { sensitivity: "base" });

function initials(c) {
  const src = String(c.name || c.email || "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

function status(text, kind = "") {
  $("status").textContent = text;
  $("status").className = "side-foot" + (kind ? " " + kind : "");
}

// ===== Liste ===============================================================

function visible() {
  return contacts
    .filter((c) => {
      if (filter === "favorite" && !c.favorite) return false;
      if (!needle) return true;
      return `${c.name} ${c.email} ${c.phone} ${c.company} ${c.role} ${c.note}`.toLowerCase().includes(needle);
    })
    .sort(byName);
}

function renderList() {
  const list = $("list");
  const shown = visible();
  $("count").textContent = contacts.length ? `${contacts.length}` : "";
  list.innerHTML = "";
  if (!shown.length) {
    list.innerHTML = `<div class="side-foot">${esc(contacts.length ? tt("Aucune fiche ne correspond.") : tt("Carnet vide."))}</div>`;
    return;
  }
  for (const c of shown) {
    const row = document.createElement("div");
    row.className = "row" + (c.id === currentId ? " active" : "");
    row.innerHTML =
      `<span class="mini">${esc(initials(c))}</span>` +
      `<span class="row-main"><b>${esc(c.name || c.email || tt("(sans nom)"))}</b>` +
      `<small>${esc(c.email || c.phone || c.company || "")}</small></span>` +
      (c.favorite ? `<span class="fav">★</span>` : "");
    row.addEventListener("click", () => select(c.id));
    list.appendChild(row);
  }
}

// ===== Fiche ===============================================================

function current() { return contacts.find((c) => c.id === currentId) || null; }

function select(id) {
  currentId = id;
  const c = current();
  if (!c) return;
  $("detail-empty").hidden = true;
  $("card").hidden = false;
  $("avatar").textContent = initials(c);
  $("f-name").value = c.name || "";
  $("f-email").value = c.email || "";
  $("f-phone").value = c.phone || "";
  $("f-company").value = c.company || "";
  $("f-role").value = c.role || "";
  $("f-note").value = c.note || "";
  // Une personne, plusieurs contextes (personnel, équipe, client) : on les
  // montre avec les apps qui la connaissent aussi.
  const ctx = contextsOf(c).map((x) => tt(CONTEXTS[x] || x)).join(" · ");
  const apps = [...new Set((c.links || []).map((l) => ({ relia: "Relia", directory: "Annuaire", mail: "Courrier", telegram: "Telegram" }[l.app] || l.app)))];
  $("f-origin").textContent = `${tt(ORIGIN_LABELS[c.origin] || ORIGIN_LABELS.manual)} — ${ctx}${apps.length ? ` · ${tt("liée à")} ${apps.join(", ")}` : ""}`;
  $("btn-fav").textContent = c.favorite ? "★" : "☆";
  $("btn-fav").classList.toggle("on", !!c.favorite);
  renderList();
}

function newContact() {
  const id = "ct-" + Date.now().toString(36);
  contacts = [...contacts, { id, name: "", email: "", phone: "", company: "", role: "", note: "", origin: "manual", favorite: false, updated_at: Date.now() }];
  select(id);
  $("f-name").focus();
}

async function save() {
  const c = current();
  if (!c) return;
  const email = $("f-email").value.trim();
  // Deux fiches pour la même adresse, c'est le début de la fin d'un carnet :
  // on refuse le doublon plutôt que de le créer en silence.
  if (email) {
    const clash = contacts.find((x) => x.id !== c.id && identityKey(x) === email.toLowerCase());
    if (clash) {
      status(`${tt("Cette adresse est déjà au carnet :")} ${clash.name || clash.email}`, "err");
      return;
    }
  }
  Object.assign(c, {
    name: $("f-name").value.trim(),
    email,
    phone: $("f-phone").value.trim(),
    company: $("f-company").value.trim(),
    role: $("f-role").value.trim(),
    note: $("f-note").value,
    updated_at: Date.now(),
  });
  await persist();
  $("avatar").textContent = initials(c);
  renderList();
  status(tt("Fiche enregistrée."));
}

async function persist() {
  try { await saveContacts(contacts); }
  catch (e) { status(String(e?.message || e), "err"); }
}

async function remove() {
  const c = current();
  if (!c) return;
  if (!(await confirmSheet({ title: tt("Supprimer cette fiche ?"), body: c.name || "", confirm: tt("Supprimer"), cancel: tt("Annuler"), danger: true }))) return;
  contacts = contacts.filter((x) => x.id !== c.id);
  currentId = null;
  $("card").hidden = true;
  $("detail-empty").hidden = false;
  await persist();
  renderList();
}

// ===== Fusion ==============================================================

async function openMerge() {
  $("btn-merge").disabled = true;
  status(tt("Recherche dans le courrier, Relia, l'Annuaire et Telegram…"));
  try {
    suggestions = await gatherSuggestions(contacts);
  } catch { suggestions = []; }
  status("");
  $("btn-merge").disabled = false;

  const box = $("merge-list");
  box.innerHTML = "";
  // Doublons probables DANS le carnet : proposés, jamais fusionnés d'office.
  for (const group of duplicateGroups(contacts)) {
    const row = document.createElement("div");
    row.className = "merge-row dup";
    row.innerHTML = `<b>${esc(tt("Doublon probable"))}</b><span>${group.map((c) => esc(c.name || c.email || c.phone)).join(" / ")}</span>`;
    const b = document.createElement("button");
    b.className = "btn-soft";
    b.textContent = tt("Fusionner");
    b.addEventListener("click", async () => {
      let next = contacts;
      for (const other of group.slice(1)) next = mergePeople(next, group[0].id, other.id);
      contacts = next;
      await persist();
      renderList();
      row.remove();
      status(tt("Fiches fusionnées."));
    });
    row.appendChild(b);
    box.appendChild(row);
  }
  if (!suggestions.length) {
    box.insertAdjacentHTML("beforeend", `<div class="merge-empty">${esc(tt("Rien de nouveau : le carnet connaît déjà tout le monde."))}</div>`);
  } else {
    suggestions.forEach((c, i) => {
      const row = document.createElement("label");
      row.className = "merge-row";
      row.innerHTML =
        `<input type="checkbox" data-i="${i}" checked />` +
        `<b>${esc(c.name || c.email)}</b>` +
        `<span>${esc(c.email || c.phone || c.note || "")}</span>` +
        `<span class="src">${esc(tt(ORIGIN_LABELS[c.origin] || c.origin))}</span>`;
      box.appendChild(row);
    });
  }
  $("merge-overlay").hidden = false;
}

async function doMerge() {
  const picked = [...document.querySelectorAll("#merge-list input:checked")]
    .map((el) => suggestions[Number(el.dataset.i)])
    .filter(Boolean);
  let next = contacts;
  for (const c of picked) next = upsertContact(next, c);
  contacts = next;
  await persist();
  renderList();
  $("merge-overlay").hidden = true;
  status(picked.length ? `${picked.length} ${tt("fiche(s) ajoutée(s).")}` : "");
}

// ===== Câblage =============================================================

function bind() {
  $("btn-new").addEventListener("click", newContact);
  $("btn-save").addEventListener("click", save);
  $("btn-delete").addEventListener("click", remove);
  $("btn-merge").addEventListener("click", openMerge);
  $("m-cancel").addEventListener("click", () => { $("merge-overlay").hidden = true; });
  $("m-all").addEventListener("click", () => {
    const boxes = [...document.querySelectorAll("#merge-list input")];
    const allOn = boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !allOn; });
  });
  $("m-import").addEventListener("click", doMerge);
  $("btn-fav").addEventListener("click", async () => {
    const c = current();
    if (!c) return;
    c.favorite = !c.favorite;
    $("btn-fav").textContent = c.favorite ? "★" : "☆";
    $("btn-fav").classList.toggle("on", c.favorite);
    await persist();
    renderList();
  });
  $("btn-mail").addEventListener("click", () => {
    const c = current();
    if (!c?.email) { status(tt("Cette fiche n'a pas d'adresse e-mail."), "err"); return; }
    // Le bus « Envoyer vers… » ouvre l'app Email avec le destinataire
    // prérempli (cf. lib/interop.js, nature « contact »).
    handoff("mail", makeObject("contact", { name: c.name, email: c.email, phone: c.phone },
      { app: "contacts", title: c.name || c.email }));
  });

  document.querySelectorAll(".chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      filter = chip.dataset.filter;
      document.querySelectorAll(".chip[data-filter]").forEach((c) => c.classList.toggle("active", c === chip));
      renderList();
    });
  });
  $("search").addEventListener("input", (e) => { needle = e.target.value.trim().toLowerCase(); renderList(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("merge-overlay").hidden) $("merge-overlay").hidden = true;
  });
}

autoTranslate({ observe: true });
bind();
loadContacts().then((list) => { contacts = list; renderList(); });
