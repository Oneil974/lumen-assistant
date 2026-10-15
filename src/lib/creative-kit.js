// Espace Création — ce que Notes, Carte mentale, Planche, Canevas et Opus
// partagent au lieu de le réinventer chacun :
//
//   • PROJETS : un projet regroupe des documents de plusieurs éditeurs (une
//     note d'idée, la carte qui l'organise, la planche de références, le
//     document final). Registre unique `app-state/creative-projects.json`.
//   • VERSIONS : instantanés datés d'un document, restaurables, rangés par
//     éditeur (`app-state/creative-versions-<app>.json`, 20 par document).
//   • EXPORTS : Markdown, HTML, texte, JSON ou PDF dans une sandbox, ou
//     « Envoyer vers Opus » pour la mise en page finale.
//
// Chaque éditeur garde son format et son stockage ; il fournit seulement un
// ADAPTATEUR à `mountCreativeBar` (quel document est ouvert, comment le lire
// et le remplacer, en quels formats l'exporter).

const invoke = (...a) => (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke?.(...a);

// ---- Lecture-écriture directe (plusieurs fenêtres écrivent le même fichier) --
async function loadState(name) {
  try {
    const raw = await invoke("app_state_load", { name });
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
async function saveState(name, data) {
  await invoke("app_state_save", { name, data: JSON.stringify(data) });
}
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ============================ Projets ============================

const PROJECTS = "creative-projects";

/** @returns {Promise<Array<{id, name, createdAt, updatedAt, items: Array<{app, ref, title, addedAt}>}>>} */
export async function listProjects() {
  const st = await loadState(PROJECTS);
  return (Array.isArray(st.projects) ? st.projects : []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function createProject(name) {
  const st = await loadState(PROJECTS);
  const p = { id: uid("prj"), name: String(name || "Projet").trim().slice(0, 80) || "Projet", createdAt: Date.now(), updatedAt: Date.now(), items: [] };
  st.projects = [...(st.projects || []), p];
  await saveState(PROJECTS, st);
  return p;
}

export async function renameProject(id, name) {
  const st = await loadState(PROJECTS);
  const p = (st.projects || []).find((x) => x.id === id);
  if (!p) return;
  p.name = String(name).trim().slice(0, 80) || p.name;
  p.updatedAt = Date.now();
  await saveState(PROJECTS, st);
}

export async function deleteProject(id) {
  const st = await loadState(PROJECTS);
  st.projects = (st.projects || []).filter((x) => x.id !== id);
  await saveState(PROJECTS, st);
}

/** Rattache un document à un projet (idempotent ; met le titre à jour). */
export async function attachToProject(projectId, { app, ref, title }) {
  const st = await loadState(PROJECTS);
  const p = (st.projects || []).find((x) => x.id === projectId);
  if (!p || !app || ref == null) return;
  const key = String(ref);
  const it = p.items.find((i) => i.app === app && i.ref === key);
  if (it) it.title = title || it.title;
  else p.items.push({ app, ref: key, title: title || "", addedAt: Date.now() });
  p.updatedAt = Date.now();
  await saveState(PROJECTS, st);
}

export async function detachFromProject(projectId, app, ref) {
  const st = await loadState(PROJECTS);
  const p = (st.projects || []).find((x) => x.id === projectId);
  if (!p) return;
  p.items = p.items.filter((i) => !(i.app === app && i.ref === String(ref)));
  p.updatedAt = Date.now();
  await saveState(PROJECTS, st);
}

/** Projets qui contiennent ce document. */
export async function projectsOf(app, ref) {
  return (await listProjects()).filter((p) => p.items.some((i) => i.app === app && i.ref === String(ref)));
}

// ============================ Versions ============================

const VERSIONS_MAX = 20;
const versionsFile = (app) => `creative-versions-${String(app).replace(/[^\w-]/g, "")}`;

/** Instantanés d'un document, du plus récent au plus ancien. */
export async function listVersions(app, ref) {
  const st = await loadState(versionsFile(app));
  return Array.isArray(st[String(ref)]) ? st[String(ref)] : [];
}

/**
 * Enregistre un instantané. Ignoré s'il est identique au dernier.
 * @param {string} content contenu sérialisé par l'éditeur (texte ou JSON)
 */
export async function saveVersion(app, ref, { title = "", content = "", label = "" } = {}) {
  const st = await loadState(versionsFile(app));
  const key = String(ref);
  const list = Array.isArray(st[key]) ? st[key] : [];
  if (list[0]?.content === content) return list[0];
  const v = { id: uid("v"), ts: Date.now(), title, label, content };
  st[key] = [v, ...list].slice(0, VERSIONS_MAX);
  await saveState(versionsFile(app), st);
  return v;
}

export async function deleteVersions(app, ref) {
  const st = await loadState(versionsFile(app));
  delete st[String(ref)];
  await saveState(versionsFile(app), st);
}

// ============================ Exports ============================

export const EXPORT_LABELS = { md: "Markdown (.md)", html: "Page web (.html)", txt: "Texte (.txt)", json: "Données (.json)", pdf: "PDF" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const slug = (s) => String(s || "document").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";

/** Markdown minimal → HTML (titres, listes, gras, italique, paragraphes). */
export function markdownToHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/`(.+?)`/g, "<code>$1</code>");
  const out = [];
  let list = null;
  for (const line of String(md || "").split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (!li && list) { out.push(`</${list}>`); list = null; }
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (li) { if (!list) { out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(li[1])}</li>`); }
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join("\n");
}

function htmlPage(title, body) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1d1d1f}h1,h2,h3{line-height:1.25}img{max-width:100%}</style>
</head><body><h1>${esc(title)}</h1>
${body}
</body></html>`;
}

/**
 * Représentations d'un document, telles que l'éditeur les fournit :
 * `{ title, markdown?, html?, text?, json? }`. Chaque format se déduit des
 * autres quand l'éditeur n'en donne qu'un.
 */
export function renderAs(format, doc) {
  const title = doc.title || "Document";
  const md = doc.markdown ?? (doc.text != null ? doc.text : "");
  switch (format) {
    case "md": return `# ${title}\n\n${md}`.trim() + "\n";
    case "txt": return `${title}\n\n${doc.text ?? md.replace(/[#*`_>]/g, "")}`.trim() + "\n";
    case "json": return JSON.stringify(doc.json ?? { title, markdown: md }, null, 2);
    case "html":
    case "pdf": return htmlPage(title, doc.html ?? markdownToHtml(md));
    default: throw new Error(`Format inconnu : ${format}`);
  }
}

/** Écrit l'export dans une sandbox (dossier `exports/`) ; PDF via sandbox_export_pdf. */
export async function exportDocument(format, doc, sandboxId) {
  const base = `exports/${slug(doc.title)}`;
  if (format === "pdf") {
    const htmlPath = `${base}.html`;
    await invoke("sandbox_write_file", { id: sandboxId, path: htmlPath, content: renderAs("pdf", doc) });
    const pdf = await invoke("sandbox_export_pdf", { id: sandboxId, path: htmlPath });
    return typeof pdf === "string" && pdf ? pdf : `${base}.pdf`;
  }
  const path = `${base}.${format}`;
  await invoke("sandbox_write_file", { id: sandboxId, path, content: renderAs(format, doc) });
  return path;
}

// ============================ Barre commune ============================

const CSS = `
.ck-bar{display:inline-flex;gap:6px;align-items:center;position:relative}
.ck-btn{font:inherit;font-size:12px;border:1px solid var(--border,rgba(128,128,128,.3));background:var(--card,transparent);color:inherit;border-radius:8px;padding:4px 9px;cursor:pointer}
.ck-btn:hover{background:var(--muted,rgba(128,128,128,.12))}
.ck-pop{position:fixed;z-index:2147483000;min-width:260px;max-width:360px;max-height:60vh;overflow:auto;background:var(--popover,var(--card,#fff));color:var(--popover-foreground,inherit);border:1px solid var(--border,rgba(128,128,128,.3));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:8px;font-size:13px}
.ck-pop h5{margin:6px 6px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.6}
.ck-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;padding:7px 8px;border-radius:8px;cursor:pointer}
.ck-row:hover{background:var(--muted,rgba(128,128,128,.12))}
.ck-row small{margin-left:auto;opacity:.6;font-size:11px}
.ck-empty{padding:8px;opacity:.6}
.ck-in{width:100%;box-sizing:border-box;font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--border,rgba(128,128,128,.3));background:transparent;color:inherit;margin:4px 0}
`;
function injectCss() {
  if (document.getElementById("ck-css")) return;
  const st = document.createElement("style");
  st.id = "ck-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

/**
 * Pose la barre Projet · Versions · Exporter dans `host`.
 * @param {HTMLElement} host
 * @param {{
 *   app: string,                                  // identifiant de l'éditeur
 *   current: () => ({ ref: string, title: string } | null),
 *   serialize: () => string,                      // contenu à versionner
 *   restore: (content: string) => void|Promise<void>,
 *   exportDoc: () => ({ title, markdown?, html?, text?, json? }),
 *   formats?: string[],                           // défaut : md, html, pdf, txt
 *   openVersions?: () => void,                    // historique propre (Notes)
 *   toast?: (msg: string) => void,
 * }} adapter
 */
export function mountCreativeBar(host, adapter) {
  if (!host) return null;
  injectCss();
  const toast = adapter.toast || ((m) => console.info(m));
  const formats = adapter.formats || ["md", "html", "pdf", "txt"];
  const bar = document.createElement("span");
  bar.className = "ck-bar";
  bar.innerHTML = `<button type="button" class="ck-btn" data-ck="project" title="Ranger ce document dans un projet de l'espace Création">Projet</button>
    <button type="button" class="ck-btn" data-ck="versions" title="Instantanés datés, restaurables">Versions</button>
    <button type="button" class="ck-btn" data-ck="export" title="Exporter ou envoyer vers Opus">Exporter</button>`;
  host.appendChild(bar);
  let pop = null;
  const close = () => { pop?.remove(); pop = null; };
  document.addEventListener("pointerdown", (e) => { if (pop && !bar.contains(e.target) && !pop.contains(e.target)) close(); });
  window.addEventListener("resize", () => close());
  // Le menu vit dans <body>, en position fixe sous le bouton : posé dans la
  // barre, il était rogné par les conteneurs à débordement masqué (ruban de
  // Documents/Présentations) et n'apparaissait que comme un liseré.
  let anchor = null;
  const place = () => {
    if (!pop) return;
    const r = (anchor || bar).getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 8);
    left = Math.max(8, left);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
  };
  const open = (html) => {
    close();
    pop = document.createElement("div");
    pop.className = "ck-pop";
    pop.innerHTML = html;
    document.body.appendChild(pop);
    place();
    return pop;
  };
  const row = (label, sub = "", attrs = "") => `<button type="button" class="ck-row" ${attrs}><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</button>`;
  const need = () => {
    const c = adapter.current?.();
    if (!c || c.ref == null) { toast("Ouvrez d'abord un document."); return null; }
    return c;
  };

  async function showProjects() {
    const doc = need(); if (!doc) return;
    const [all, mine] = await Promise.all([listProjects(), projectsOf(adapter.app, doc.ref)]);
    const inIds = new Set(mine.map((p) => p.id));
    const p = open(`<h5>Projets</h5>${all.map((x) => row(`${inIds.has(x.id) ? "✓ " : ""}${x.name}`, `${x.items.length} élément(s)`, `data-p="${esc(x.id)}"`)).join("") || '<div class="ck-empty">Aucun projet.</div>'}
      <h5>Nouveau projet</h5><input class="ck-in" placeholder="Nom du projet" data-new />`);
    p.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.p;
      if (inIds.has(id)) await detachFromProject(id, adapter.app, doc.ref);
      else await attachToProject(id, { app: adapter.app, ref: doc.ref, title: doc.title });
      toast(inIds.has(id) ? "Retiré du projet." : "Ajouté au projet.");
      close();
    }));
    p.querySelector("[data-new]").addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !e.target.value.trim()) return;
      const prj = await createProject(e.target.value);
      await attachToProject(prj.id, { app: adapter.app, ref: doc.ref, title: doc.title });
      toast(`Projet « ${prj.name} » créé.`);
      close();
    });
  }

  async function showVersions() {
    if (adapter.openVersions) { adapter.openVersions(); return; }
    const doc = need(); if (!doc) return;
    const list = await listVersions(adapter.app, doc.ref);
    const p = open(`<h5>Versions de « ${esc(doc.title || "document")} »</h5>
      ${row("Enregistrer une version maintenant", "", 'data-save="1"')}
      ${list.map((v, i) => row(v.label || v.title || "Version", new Date(v.ts).toLocaleString(), `data-v="${i}"`)).join("") || '<div class="ck-empty">Aucune version enregistrée.</div>'}`);
    p.querySelector("[data-save]").addEventListener("click", async () => {
      await saveVersion(adapter.app, doc.ref, { title: doc.title, content: adapter.serialize() });
      toast("Version enregistrée.");
      close();
    });
    p.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", async () => {
      const v = list[Number(b.dataset.v)];
      // Restaurer n'est jamais une perte : l'état courant est gardé d'abord.
      await saveVersion(adapter.app, doc.ref, { title: doc.title, content: adapter.serialize(), label: "Avant restauration" });
      await adapter.restore(v.content);
      toast("Version restaurée.");
      close();
    }));
  }

  async function showExport() {
    const doc = need(); if (!doc) return;
    const p = open(`<h5>Exporter</h5>${formats.map((f) => row(EXPORT_LABELS[f] || f, "", `data-f="${f}"`)).join("")}
      <h5>Continuer ailleurs</h5>${row("Envoyer vers Opus (mise en page)", "", 'data-opus="1"')}`);
    p.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", async () => {
      close();
      try {
        const boxes = (await invoke("sandbox_list")) || [];
        if (!boxes.length) { toast("Aucune sandbox : créez-en une dans Fichiers."); return; }
        const path = await exportDocument(b.dataset.f, adapter.exportDoc(), boxes[0].id);
        toast(`Exporté → ${boxes[0].name || boxes[0].id} / ${path}`);
      } catch (e) { toast(`Export impossible : ${e?.message || e}`); }
    }));
    p.querySelector("[data-opus]").addEventListener("click", async () => {
      close();
      const d = adapter.exportDoc();
      const { handoff, makeObject } = await import("./interop.js");
      handoff("opus", makeObject("text", { title: d.title || "Document", text: d.markdown ?? d.text ?? "", markdown: true }, { app: adapter.app }));
    });
  }

  const wire = (k, fn) => {
    const b = bar.querySelector(`[data-ck="${k}"]`);
    b.addEventListener("click", () => {
      if (pop && anchor === b) { close(); return; } // second clic : referme
      anchor = b; fn();
    });
  };
  wire("project", showProjects);
  wire("versions", showVersions);
  wire("export", showExport);
  return bar;
}
