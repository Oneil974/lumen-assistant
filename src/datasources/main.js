// Sources de données (édition Pro) — le centre de connexions.
//
// L'app tient en trois écrans, et en une promesse qu'elle doit rendre visible :
//
//   1. « Connexions » : déclarer une source. Le formulaire est engendré depuis
//      kinds.js — l'app ne connaît aucun connecteur en particulier.
//   2. « Explorer » : voir ce que la source contient AVANT de l'ouvrir aux
//      applications. On ne partage pas ce qu'on n'a pas regardé.
//   3. « API & MCP » : la porte de sortie. On y lit, noir sur blanc, la liste
//      complète des routes — toutes en lecture — et de quoi brancher un client.
//
// Rien ici ne peut écrire dans une source : le backend n'expose aucune commande
// d'écriture. L'interface n'a donc pas à s'en garder, elle a à le DIRE.

import { autoTranslate } from "../apps-i18n.js";
import { mountShell, avatar, kpi, emptyState, progress } from "../lib/app-shell.js";
import { requireProPage } from "../lib/pro-edition.js";
import { confirmSheet } from "../lib/confirm.js";
import { KINDS, KIND_IDS, byFamily, kindLabel } from "./kinds.js";

// Icônes de la coquille (nav, en-têtes) : posées avant le premier rendu.
mountShell();

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const call = (cmd, args) => {
  if (!invoke) return Promise.reject(new Error("Ouvrez cette application depuis Lumen."));
  return invoke(cmd, args);
};

const state = {
  view: "sources",
  sources: [],
  selected: "",
  draft: null,        // source en cours d'édition (null = aucune)
  server: { running: false, port: 8771, baseUrl: "", token: "" },
  explore: { id: "", datasets: [], entries: [], path: "", page: null, dataset: "" },
};

const current = () => state.sources.find((s) => s.id === state.selected) || null;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3200);
}

const fail = (e) => toast(String(e?.message || e));

// ===================== Connexions =====================

function renderSourceList() {
  const host = $("source-list");
  if (!state.sources.length) {
    host.innerHTML = `<div class="empty">Aucune source. « Ajouter » pour brancher une base, un partage ou une API.</div>`;
    return;
  }
  host.innerHTML = state.sources
    .map((s) => `
      <button class="row ${s.id === state.selected ? "on" : ""}" data-id="${esc(s.id)}">
        <span class="row-main">
          <span class="row-name">${esc(s.name)}</span>
          <span class="row-sub">${esc(kindLabel(s.kind))}</span>
        </span>
        <span class="pill ${s.enabled ? "ok" : ""}">${s.enabled ? "exposée" : "hors ligne"}</span>
      </button>`)
    .join("");
  host.querySelectorAll(".row").forEach((el) =>
    el.addEventListener("click", () => {
      state.selected = el.dataset.id;
      state.draft = null;
      renderSources();
    }));
}

/** Champ de formulaire, dessiné depuis sa description dans kinds.js. */
function fieldHtml(field, value, { secret = false } = {}) {
  const id = `${secret ? "sec" : "cfg"}-${field.key}`;
  const cls = field.wide || field.type === "textarea" ? "f wide" : "f";
  const hint = field.hint ? `<span class="f-hint">${esc(field.hint)}</span>` : "";
  if (field.type === "toggle") {
    return `<label class="${cls} f-toggle"><input type="checkbox" id="${id}" ${value === "true" ? "checked" : ""} /><span>${esc(field.label)}</span>${hint}</label>`;
  }
  if (field.type === "select") {
    const opts = (field.options || []).map((o) => `<option value="${esc(o)}" ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("");
    return `<label class="${cls}"><span class="f-label">${esc(field.label)}</span><select class="select" id="${id}">${opts}</select>${hint}</label>`;
  }
  if (field.type === "textarea") {
    return `<label class="${cls}"><span class="f-label">${esc(field.label)}</span><textarea class="input" id="${id}" rows="4" placeholder="${esc(field.placeholder || "")}">${esc(value)}</textarea>${hint}</label>`;
  }
  const type = field.type === "password" ? "password" : "text";
  return `<label class="${cls}"><span class="f-label">${esc(field.label)}</span><input class="input" id="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(field.placeholder || "")}" ${secret ? 'autocomplete="new-password"' : ""} />${hint}</label>`;
}

function kindOptions(selected) {
  let html = "";
  for (const [family, ids] of byFamily()) {
    html += `<optgroup label="${esc(family)}">`;
    html += ids.map((id) => `<option value="${id}" ${id === selected ? "selected" : ""}>${esc(KINDS[id].label)}</option>`).join("");
    html += `</optgroup>`;
  }
  return html;
}

function renderEditor() {
  const host = $("source-editor");
  const src = state.draft || current();
  if (!src) {
    host.innerHTML = `<div class="card"><div class="card-body empty">
      Sélectionnez une source, ou ajoutez-en une.<br />
      Une source déclarée ici devient lisible — et seulement lisible — par les applications Pro et par les modèles.
    </div></div>`;
    return;
  }
  const spec = KINDS[src.kind] || { config: [], secrets: [], hint: "" };
  const config = src.config || {};
  const known = new Set((src.secretKeys || []));
  const isNew = !src.id;

  host.innerHTML = `
    <div class="card">
      <div class="card-head"><span>${isNew ? "Nouvelle source" : esc(src.name)}</span>
        <span class="head-actions">
          ${isNew ? "" : `<button class="btn tiny" id="ping">Tester</button>`}
          ${isNew ? "" : `<button class="btn tiny danger" id="delete">Supprimer</button>`}
        </span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <label class="f"><span class="f-label">Nom</span><input class="input" id="fld-name" value="${esc(src.name || "")}" placeholder="Base clients" /></label>
          <label class="f"><span class="f-label">Connecteur</span><select class="select" id="fld-kind">${kindOptions(src.kind)}</select></label>
          <div class="f wide kind-hint">${esc(spec.hint || "")}</div>
          ${spec.config.map((f) => fieldHtml(f, config[f.key] ?? "")).join("")}
          ${spec.secrets.length ? `<div class="f wide sec-head">Secrets — conservés chiffrés côté disque, jamais renvoyés à l'écran ni au modèle.</div>` : ""}
          ${spec.secrets.map((f) => fieldHtml({ ...f, placeholder: known.has(f.key) ? "•••••••• (enregistré)" : f.placeholder || "" }, "", { secret: true })).join("")}
          <label class="f wide"><span class="f-label">Note</span><input class="input" id="fld-note" value="${esc(src.note || "")}" placeholder="À quoi sert cette source, pour ceux qui la liront" /></label>
        </div>

        <div class="switches">
          <label class="sw"><input type="checkbox" id="fld-enabled" ${src.enabled ? "checked" : ""} />
            <span><b>Exposer aux applications</b><i>Tant que c'est décoché, la source n'existe ni pour l'API, ni pour les modèles.</i></span></label>
          <label class="sw"><input type="checkbox" id="fld-sql" ${src.allowSql ? "checked" : ""} ${spec.config.some(() => true) && ["postgres","mysql","sqlite","mssql"].includes(src.kind) ? "" : "disabled"} />
            <span><b>Autoriser un SELECT libre</b><i>Sinon, seuls les jeux de données catalogués sont lisibles. Même autorisé, un SELECT reste la seule forme acceptée.</i></span></label>
        </div>

        <div class="form-actions">
          <button class="btn ghost" id="cancel">Annuler</button>
          <button class="btn primary" id="save">${isNew ? "Créer" : "Enregistrer"}</button>
        </div>
        <div class="err" id="editor-err" hidden></div>
      </div>
    </div>`;

  $("fld-kind").addEventListener("change", (e) => {
    state.draft = { ...readForm(src), kind: e.target.value, id: src.id || "" };
    renderEditor();
  });
  $("save").addEventListener("click", saveSource);
  $("cancel").addEventListener("click", () => { state.draft = null; renderSources(); });
  $("ping")?.addEventListener("click", pingSource);
  $("delete")?.addEventListener("click", deleteSource);
}

/** Relit le formulaire. Les secrets vides sont OMIS : le backend garde alors la
 *  valeur déjà enregistrée, ce qui évite de la faire transiter pour rien. */
function readForm(src) {
  const spec = KINDS[$("fld-kind").value] || { config: [], secrets: [] };
  const config = {};
  for (const f of spec.config) {
    const el = $(`cfg-${f.key}`);
    if (!el) continue;
    config[f.key] = f.type === "toggle" ? String(el.checked) : el.value.trim();
  }
  const secrets = {};
  for (const f of spec.secrets) {
    const el = $(`sec-${f.key}`);
    if (el && el.value) secrets[f.key] = el.value;
  }
  return {
    id: src.id || "",
    name: $("fld-name").value.trim(),
    kind: $("fld-kind").value,
    config,
    secrets,
    enabled: $("fld-enabled").checked,
    allowSql: $("fld-sql").checked,
    note: $("fld-note").value.trim(),
    secretKeys: src.secretKeys || [],
  };
}

async function saveSource() {
  const src = state.draft || current();
  const form = readForm(src);
  if (!form.name) { $("editor-err").hidden = false; $("editor-err").textContent = "Donnez un nom à la source."; return; }
  if (form.kind === "rest" && form.config.endpoints) {
    try { JSON.parse(form.config.endpoints); }
    catch { $("editor-err").hidden = false; $("editor-err").textContent = "Les points d'entrée ne sont pas un JSON valide."; return; }
  }
  try {
    const saved = await call("datasources_save", {
      id: form.id || null, name: form.name, kind: form.kind,
      config: form.config, secrets: form.secrets,
      enabled: form.enabled, allowSql: form.allowSql, note: form.note,
    });
    state.selected = saved.id;
    state.draft = null;
    await refresh();
    toast("Source enregistrée.");
  } catch (e) { fail(e); }
}

async function pingSource() {
  const src = current();
  if (!src) return;
  toast("Test en cours…");
  try { toast(await call("datasources_ping", { id: src.id })); }
  catch (e) { fail(e); }
}

async function deleteSource() {
  const src = current();
  if (!src) return;
  const ok = await confirmSheet({
    title: `Supprimer « ${src.name} » ?`,
    body: "La connexion et ses secrets sont effacés de Lumen. La source elle-même n'est pas touchée : Lumen n'a jamais eu le droit d'y écrire.",
    confirm: "Supprimer",
    danger: true,
  });
  if (!ok) return;
  try {
    await call("datasources_delete", { id: src.id });
    state.selected = "";
    await refresh();
    toast("Source supprimée.");
  } catch (e) { fail(e); }
}

function renderSources() {
  renderSourceList();
  renderEditor();
}

// ===================== Explorer =====================

function renderExploreSelect() {
  const sel = $("explore-source");
  const usable = state.sources.filter((s) => s.enabled);
  sel.innerHTML = usable.length
    ? usable.map((s) => `<option value="${esc(s.id)}" ${s.id === state.explore.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")
    : `<option value="">Aucune source exposée</option>`;
  if (!state.explore.id && usable.length) state.explore.id = usable[0].id;
}

function table(page) {
  if (!page || !page.columns.length) return `<div class="empty">Aucune donnée.</div>`;
  const head = page.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = page.rows
    .map((r) => `<tr>${r.map((v) => `<td>${esc(v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : v)}</td>`).join("")}</tr>`)
    .join("");
  const more = page.truncated ? `<div class="hint">Aperçu limité à ${page.limit} lignes — les applications paginent avec limit et offset.</div>` : "";
  return `<div class="grid-scroll"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

async function loadExplore() {
  const host = $("explore");
  const src = state.sources.find((s) => s.id === state.explore.id);
  if (!src) { host.innerHTML = `<div class="empty">Exposez au moins une source pour la parcourir.</div>`; return; }
  host.innerHTML = `<div class="empty">Lecture…</div>`;
  const caps = src.capabilities || {};
  try {
    if (caps.datasets) {
      state.explore.datasets = await call("datasources_datasets", { id: src.id });
      renderExplore();
    } else {
      state.explore.entries = await call("datasources_objects", { id: src.id, path: state.explore.path });
      renderExplore();
    }
  } catch (e) {
    host.innerHTML = `<div class="err">${esc(e?.message || e)}</div>`;
  }
}

function renderExplore() {
  const src = state.sources.find((s) => s.id === state.explore.id);
  const host = $("explore");
  const caps = src?.capabilities || {};
  if (caps.datasets) {
    const list = state.explore.datasets
      .map((d) => `<button class="row ${d.name === state.explore.dataset ? "on" : ""}" data-name="${esc(d.name)}">
        <span class="row-main"><span class="row-name">${esc(d.name)}</span>
        <span class="row-sub">${esc(d.note || "")}${d.rows != null ? ` · ~${d.rows} lignes` : ""}</span></span></button>`)
      .join("") || `<div class="empty">Aucun jeu de données.</div>`;
    host.innerHTML = `<div class="explore-split"><div class="list">${list}</div>
      <div class="preview" id="preview">${state.explore.page ? table(state.explore.page) : `<div class="empty">Choisissez un jeu de données pour en voir un aperçu.</div>`}</div></div>`;
    host.querySelectorAll(".row").forEach((el) =>
      el.addEventListener("click", async () => {
        state.explore.dataset = el.dataset.name;
        $("preview").innerHTML = `<div class="empty">Lecture…</div>`;
        try {
          state.explore.page = await call("datasources_rows", { id: src.id, dataset: el.dataset.name, limit: 50 });
        } catch (e) {
          state.explore.page = null;
          $("preview").innerHTML = `<div class="err">${esc(e?.message || e)}</div>`;
          renderExploreSelect();
          return;
        }
        renderExplore();
      }));
    return;
  }

  const up = state.explore.path
    ? `<button class="row up" data-path="${esc(state.explore.path.split("/").slice(0, -1).join("/"))}"><span class="row-main"><span class="row-name">← Dossier parent</span></span></button>`
    : "";
  const rows = state.explore.entries
    .map((e) => `<button class="row" data-path="${esc(e.path)}" data-dir="${e.dir ? "1" : ""}">
      <span class="row-main"><span class="row-name">${e.dir ? "📁 " : "📄 "}${esc(e.name)}</span>
      <span class="row-sub">${esc(e.path)}${e.size != null ? ` · ${e.size} o` : ""}</span></span></button>`)
    .join("") || `<div class="empty">Dossier vide.</div>`;
  host.innerHTML = `<div class="explore-split"><div class="list">${up}${rows}</div>
    <div class="preview" id="preview"><div class="empty">Choisissez un fichier pour en voir le début.</div></div></div>`;
  host.querySelectorAll(".row").forEach((el) =>
    el.addEventListener("click", async () => {
      if (el.classList.contains("up") || el.dataset.dir) {
        state.explore.path = el.dataset.path;
        await loadExplore();
        return;
      }
      $("preview").innerHTML = `<div class="empty">Lecture…</div>`;
      try {
        const obj = await call("datasources_object", { id: src.id, path: el.dataset.path });
        const body = obj.encoding === "text"
          ? `<pre class="peek">${esc(String(obj.content).slice(0, 4000))}</pre>`
          : `<div class="hint">Contenu binaire (${obj.size} octets) — transmis en base64 aux applications.</div>`;
        $("preview").innerHTML = `<div class="peek-head">${esc(obj.path)}</div>${body}`;
      } catch (e) { $("preview").innerHTML = `<div class="err">${esc(e?.message || e)}</div>`; }
    }));
}

// ===================== API & MCP =====================

const ROUTES = [
  ["GET", "/v1/sources", "Les sources exposées et leurs capacités"],
  ["GET", "/v1/sources/{id}", "Le détail d'une source"],
  ["GET", "/v1/sources/{id}/datasets", "Tables, feuilles ou points d'entrée"],
  ["GET", "/v1/sources/{id}/datasets/{nom}/schema", "Colonnes et types"],
  ["GET", "/v1/sources/{id}/datasets/{nom}/rows", "Lignes — limit, offset, select, order_by"],
  ["GET", "/v1/sources/{id}/objects?path=", "Dossiers et fichiers"],
  ["GET", "/v1/sources/{id}/object?path=", "Le contenu d'un objet"],
  ["POST", "/v1/sources/{id}/query", "Un SELECT unique, si la source l'autorise"],
  ["GET", "/v1/openapi.json", "La description de l'API, lisible par un agent"],
  ["POST", "/mcp", "La même surface, en JSON-RPC MCP"],
];

function renderApi() {
  const s = state.server;
  $("server-start").textContent = s.running ? "En marche" : "Démarrer";
  $("server-start").disabled = s.running;
  $("server-body").innerHTML = s.running
    ? `<div class="kv"><span>Adresse</span><code>${esc(s.baseUrl)}</code></div>
       <div class="kv"><span>Jeton</span><code class="tok" id="token">${esc(s.token)}</code>
         <button class="btn tiny" id="copy-token">Copier</button></div>
       <div class="hint">L'écoute est limitée à 127.0.0.1 : rien n'est joignable depuis le réseau. Le jeton est exigé sur toutes les routes.</div>`
    : `<div class="hint">Démarrez le serveur pour que les applications Pro et les clients MCP puissent lire vos sources.</div>`;
  $("copy-token")?.addEventListener("click", () => {
    navigator.clipboard?.writeText(s.token);
    toast("Jeton copié.");
  });

  $("routes").innerHTML = `
    <div class="ro-banner">Lecture seule : aucune route d'écriture n'existe. Toute autre méthode répond 405.</div>
    <table class="grid routes-grid"><tbody>${ROUTES.map(([m, p, d]) =>
      `<tr><td class="verb ${m.toLowerCase()}">${m}</td><td><code>${esc(p)}</code></td><td class="muted">${esc(d)}</td></tr>`).join("")}</tbody></table>`;

  const base = s.baseUrl || "http://127.0.0.1:8771";
  const token = s.token || "<jeton>";
  const example = state.sources.find((x) => x.enabled)?.id || "<id-source>";
  $("samples").innerHTML = `
    <div class="sample"><div class="sample-t">Lire des lignes</div>
      <pre class="peek">curl -H "Authorization: Bearer ${esc(token)}" \\
  "${esc(base)}/v1/sources/${esc(example)}/datasets/clients/rows?limit=100"</pre></div>
    <div class="sample"><div class="sample-t">Découvrir la surface</div>
      <pre class="peek">curl -H "Authorization: Bearer ${esc(token)}" ${esc(base)}/v1/openapi.json</pre></div>
    <div class="sample"><div class="sample-t">Brancher un client MCP</div>
      <pre class="peek">{ "transport": "http", "url": "${esc(base)}/mcp",
  "headers": { "Authorization": "Bearer ${esc(token)}" } }</pre>
      <div class="hint">Sept outils, tous annotés <code>readOnlyHint</code> : lister, décrire, lire. Aucun n'écrit.</div></div>`;
}

async function startServer() {
  try {
    state.server = await call("datasources_server_start", { port: null });
    renderApi();
    renderServerBadge();
    toast("API démarrée.");
  } catch (e) { fail(e); }
}

function renderServerBadge() {
  $("server-badge").textContent = state.server.running ? `API sur ${state.server.port}` : "API arrêtée";
  $("server-dot").classList.toggle("on", !!state.server.running);
}

// ===================== Navigation =====================

const VIEWS = {
  sources: ["Connexions", "Vos bases, partages et API, déclarés une fois"],
  explore: ["Explorer", "Voir ce qu'une source contient avant de l'ouvrir"],
  api: ["API & MCP", "La porte de sortie, en lecture seule"],
};

function setView(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${view}`));
  document.querySelectorAll("#nav button").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  const [title, sub] = VIEWS[view];
  $("view-title").textContent = title;
  $("view-sub").textContent = sub;
  if (view === "explore") { renderExploreSelect(); loadExplore(); }
  if (view === "api") renderApi();
}

async function refresh() {
  state.sources = await call("datasources_list");
  if (!state.selected && state.sources.length) state.selected = state.sources[0].id;
  renderSources();
  renderExploreSelect();
}

async function boot() {
  if (!(await requireProPage({ appName: "Sources de données" }))) return;
  autoTranslate({ observe: true });

  document.querySelectorAll("#nav button").forEach((el) =>
    el.addEventListener("click", () => setView(el.dataset.view)));
  $("add-source").addEventListener("click", () => {
    state.draft = { id: "", name: "", kind: KIND_IDS[0], config: {}, secretKeys: [], enabled: false, allowSql: false, note: "" };
    renderEditor();
  });
  $("explore-source").addEventListener("change", (e) => {
    state.explore = { id: e.target.value, datasets: [], entries: [], path: "", page: null, dataset: "" };
    loadExplore();
  });
  $("server-start").addEventListener("click", startServer);

  try {
    state.server = await call("datasources_server_status");
    renderServerBadge();
  } catch { /* l'API n'a jamais tourné : l'écran le dira. */ }
  try { await refresh(); } catch (e) { fail(e); }
}

boot();
