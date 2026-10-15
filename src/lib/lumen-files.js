// Fichiers de la suite Lumen (documents et présentations Opus, classeurs Calc,
// et leurs équivalents Office) cités ou intégrés dans un document.
//
// Deux façons de les montrer, au choix de l'auteur :
//   [[file:Sandbox/chemin/Budget.lumensheet]]   → pastille : icône + nom, clic = ouvrir
//   ![[file:Sandbox/chemin/Budget.lumensheet]]  → intégration visuelle : aperçu
//                                                  (tableau, 1re page, 1re diapo)
//
// La référence nomme la SANDBOX par son nom (lisible, stable pour l'humain) ;
// l'identifiant est accepté aussi. Le contenu est lu côté Rust
// (`living_file_preview`) : le HTML d'un document est celui qu'Opus enregistre,
// affiché dans une iframe `sandbox` SANS script.

import { icon } from "./icons.js";

const T = (window.__TAURI__ || window.parent?.__TAURI__) || null;
const invoke = T?.core?.invoke;

export const FILE_KINDS = {
  lumenpages: { kind: "document", icon: "pages", label: "Document", color: "#0a84ff" },
  docx: { kind: "document", icon: "file-text", label: "Word", color: "#2b5cd6" },
  lumenkey: { kind: "presentation", icon: "presentation", label: "Présentation", color: "#f28b1d" },
  pptx: { kind: "presentation", icon: "presentation", label: "PowerPoint", color: "#d24726" },
  lumensheet: { kind: "sheet", icon: "table", label: "Classeur", color: "#30a46c" },
  xlsx: { kind: "sheet", icon: "table", label: "Excel", color: "#1d7a46" },
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const extOf = (p) => String(p || "").split(".").pop().toLowerCase();
export const fileKindOf = (p) => FILE_KINDS[extOf(p)] || { kind: "file", icon: "file", label: "Fichier", color: "#8e8e93" };
const baseName = (p) => String(p || "").split("/").pop().replace(/\.[^.]+$/, "");

/** « Sandbox/chemin » → { sandbox, path }. */
export function parseFileRef(ref) {
  const s = String(ref || "").trim().replace(/^file:/, "");
  const i = s.indexOf("/");
  return i < 0 ? { sandbox: "", path: s } : { sandbox: s.slice(0, i), path: s.slice(i + 1) };
}
export const fileRefOf = (f) => `file:${f.sandbox}/${f.path}`;

// ---- Données -----------------------------------------------------------------

let listCache = null;
export async function listOfficeFiles(force = false) {
  if (!invoke) return [];
  if (!force && listCache && Date.now() - listCache.at < 30_000) return listCache.items;
  const items = await invoke("living_office_files").catch(() => []);
  listCache = { at: Date.now(), items: Array.isArray(items) ? items : [] };
  return listCache.items;
}

const previewCache = new Map();
export async function filePreview(sandbox, path) {
  const key = `${sandbox}/${path}`;
  const hit = previewCache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return hit.value;
  const value = invoke ? await invoke("living_file_preview", { sandbox, path }) : null;
  previewCache.set(key, { at: Date.now(), value });
  return value;
}
export function forgetPreview(path) {
  for (const k of [...previewCache.keys()]) if (!path || k.endsWith(`/${path}`)) previewCache.delete(k);
}

/** Ouvre le fichier dans son app (Opus, Calc…), depuis n'importe quelle fenêtre. */
export async function openLumenFile(sandbox, path) {
  let sb = sandbox;
  const files = await listOfficeFiles().catch(() => []);
  const f = files.find((x) => x.path === path && (x.sandbox === sandbox || x.sandboxId === sandbox));
  if (f) sb = f.sandboxId;
  if (window.lumen?.apps?.openFile) return window.lumen.apps.openFile(sb, path);
  try { return window.top?.LumenOpenFile?.(path, sb); } catch { return false; }
}

// ---- Rendu -------------------------------------------------------------------

export function fileChipHTML(ref, label = "") {
  const { sandbox, path } = parseFileRef(ref);
  const k = fileKindOf(path);
  return `<a href="#" class="lx-chip" data-sb="${esc(sandbox)}" data-path="${esc(path)}" style="--lx-c:${k.color}" title="${esc(`${k.label} · ${sandbox}/${path}`)}">`
    + `<span class="lx-chip-ic">${icon(k.icon)}</span><span>${esc(label || baseName(path))}</span></a>`;
}

export function embedHTML(ref) {
  const { sandbox, path } = parseFileRef(ref);
  const k = fileKindOf(path);
  return `<div class="lx-embed" data-sb="${esc(sandbox)}" data-path="${esc(path)}" data-kind="${k.kind}" style="--lx-c:${k.color}">`
    + `<div class="lx-embed-head"><span class="lx-chip-ic">${icon(k.icon)}</span><b>${esc(baseName(path))}</b><i>${esc(k.label)} · ${esc(sandbox)}</i>`
    + `<button type="button" class="lx-embed-open">${esc(tr("Ouvrir"))}</button></div>`
    + `<div class="lx-embed-body"><div class="lx-embed-wait">${esc(tr("Chargement de l'aperçu…"))}</div></div></div>`;
}

const tr = (fr) => (String(localStorage.getItem("lang") || "fr").startsWith("en") ? ({
  "Ouvrir": "Open", "Chargement de l'aperçu…": "Loading preview…", "Aperçu indisponible": "Preview unavailable",
  "feuilles": "sheets", "pages": "pages", "diapositives": "slides",
}[fr] || fr) : fr);

/** Remplit les aperçus `.lx-embed` et câble pastilles + boutons « Ouvrir ». */
export async function hydrateFiles(root) {
  if (!root) return;
  ensureFileStyles(root.ownerDocument);
  root.querySelectorAll(".lx-chip, .lx-embed-open").forEach((el) => {
    if (el.dataset.wired) return;
    el.dataset.wired = "1";
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const host = el.closest("[data-path]");
      openLumenFile(host.dataset.sb, host.dataset.path);
    });
  });
  await Promise.all([...root.querySelectorAll(".lx-embed:not([data-ready])")].map(async (box) => {
    box.dataset.ready = "1";
    const body = box.querySelector(".lx-embed-body");
    try {
      const p = await filePreview(box.dataset.sb, box.dataset.path);
      body.innerHTML = previewBody(p);
      const frame = body.querySelector("iframe");
      if (frame) frame.srcdoc = frameDoc(p);
    } catch (e) {
      body.innerHTML = `<div class="lx-embed-wait">${esc(tr("Aperçu indisponible"))} — ${esc(e?.message || e)}</div>`;
    }
  }));
}

function previewBody(p) {
  if (!p) return `<div class="lx-embed-wait">${esc(tr("Aperçu indisponible"))}</div>`;
  if (p.kind === "sheet" && Array.isArray(p.rows) && p.rows.length) {
    const [head, ...rows] = p.rows;
    return `<div class="lx-sheet"><table><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>`
      + `<tbody>${rows.map((r) => `<tr>${head.map((_, i) => `<td>${esc(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
      + (p.sheets?.length > 1 ? `<div class="lx-embed-foot">${p.sheets.length} ${esc(tr("feuilles"))}</div>` : "");
  }
  if ((p.kind === "document" || p.kind === "presentation") && p.html) {
    const n = p.pages || 1;
    return `<div class="lx-doc lx-doc-${p.kind}"><iframe sandbox="" referrerpolicy="no-referrer" loading="lazy" title=""></iframe></div>`
      + `<div class="lx-embed-foot">${n} ${esc(tr(p.kind === "presentation" ? "diapositives" : "pages"))}</div>`;
  }
  return `<div class="lx-embed-wait">${esc(tr("Aperçu indisponible"))}</div>`;
}

// Document isolé : aucun script (iframe `sandbox=""`), mis à l'échelle pour
// montrer la première page / diapositive entière.
function frameDoc(p) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff;overflow:hidden}</style></head><body>${p.html}</body></html>`;
}

export function ensureFileStyles(doc = document) {
  if (!doc || doc.getElementById("lx-files-css")) return;
  const st = doc.createElement("style");
  st.id = "lx-files-css";
  st.textContent = `
.lx-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px 1px 4px;margin:0 1px;border-radius:7px;text-decoration:none;
  font-weight:560;color:inherit;background:color-mix(in oklab,var(--lx-c) 11%,transparent);border:1px solid color-mix(in oklab,var(--lx-c) 28%,transparent);vertical-align:baseline;line-height:1.5}
.lx-chip:hover{background:color-mix(in oklab,var(--lx-c) 18%,transparent)}
.lx-chip-ic{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:5px;color:#fff;background:var(--lx-c);flex:none}
.lx-chip-ic svg{width:11px;height:11px}
.lx-embed{margin:12px 0;max-width:640px;border:1px solid var(--border,rgba(127,127,127,.25));border-radius:14px;overflow:hidden;background:var(--card,transparent)}
.lx-embed-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border,rgba(127,127,127,.2));
  background:color-mix(in oklab,var(--lx-c) 6%,transparent)}
.lx-embed-head b{font-size:13px;font-weight:620}
.lx-embed-head i{font-style:normal;font-size:11.5px;color:var(--muted-foreground,#888);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lx-embed-open{font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--border,rgba(127,127,127,.3));background:transparent;color:inherit;cursor:pointer}
.lx-embed-open:hover{background:color-mix(in oklab,var(--lx-c) 12%,transparent)}
.lx-embed-body{position:relative}
.lx-embed-wait{padding:18px;font-size:12.5px;color:var(--muted-foreground,#888);text-align:center}
.lx-embed-foot{padding:5px 10px;font-size:11px;color:var(--muted-foreground,#888);border-top:1px solid var(--border,rgba(127,127,127,.15))}
.lx-sheet{overflow:auto;max-height:260px}
.lx-sheet table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
.lx-sheet th,.lx-sheet td{border:1px solid var(--border,rgba(127,127,127,.2));padding:4px 8px;text-align:left;white-space:nowrap}
.lx-sheet th{background:color-mix(in oklab,var(--lx-c) 9%,transparent);font-weight:620}
.lx-doc{position:relative;overflow:hidden;background:#fff}
.lx-doc-document{height:300px}
.lx-doc-presentation{aspect-ratio:16/9}
.lx-doc iframe{border:0;position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none}
.lx-doc-document iframe{width:794px;height:1123px}
.lx-doc-presentation iframe{width:1280px;height:720px}
`;
  (doc.head || doc.documentElement).appendChild(st);
}

// L'iframe ignore la largeur de son hôte : on règle l'échelle depuis dehors.
if (typeof window !== "undefined" && !window.__lxScaleWatch) {
  window.__lxScaleWatch = true;
  const fit = () => document.querySelectorAll(".lx-doc iframe").forEach((f) => {
    const deck = f.parentElement.classList.contains("lx-doc-presentation");
    const k = (f.parentElement.clientWidth || 400) / (deck ? 1280 : 794);
    f.style.transform = `scale(${k})`;
  });
  window.addEventListener("resize", fit);
  new MutationObserver(() => requestAnimationFrame(fit)).observe(document.documentElement, { childList: true, subtree: true });
}

// ---- Sélecteur ---------------------------------------------------------------

/**
 * Choisir un fichier de la suite. Résout { ref, file, mode } — `mode` :
 * « chip » (pastille nommée) ou « embed » (intégration visuelle) — ou null.
 */
export function pickOfficeFile({ title = "" } = {}) {
  ensureFileStyles();
  return new Promise(async (resolve) => {
    const en = String(localStorage.getItem("lang") || "fr").startsWith("en");
    const L = en
      ? { title: "Insert a Lumen file", search: "Search a document, presentation or workbook…", chip: "Insert as a link", embed: "Embed a preview", none: "No document, presentation or workbook in your sandboxes.", all: "All", cancel: "Cancel" }
      : { title: "Insérer un fichier Lumen", search: "Chercher un document, une présentation, un classeur…", chip: "Insérer en lien", embed: "Intégrer un aperçu", none: "Aucun document, présentation ni classeur dans vos sandboxes.", all: "Tous", cancel: "Annuler" };
    const ov = document.createElement("div");
    ov.className = "lx-pick-ov";
    ov.innerHTML = `<style>
.lx-pick-ov{position:fixed;inset:0;z-index:5000;display:grid;place-items:center;background:rgba(0,0,0,.32)}
.lx-pick{width:min(620px,94vw);max-height:82vh;display:flex;flex-direction:column;background:var(--card,var(--background,#fff));color:var(--foreground,#111);
  border:1px solid var(--border,rgba(127,127,127,.25));border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.25);overflow:hidden;font:13px system-ui,-apple-system,sans-serif}
.lx-pick header{padding:14px 16px 10px;display:grid;gap:10px}
.lx-pick header b{font-size:15px}
.lx-pick input{font:inherit;padding:9px 12px;border-radius:10px;border:1px solid var(--border,rgba(127,127,127,.3));background:var(--background,transparent);color:inherit}
.lx-pick-f{display:flex;gap:5px}
.lx-pick-f button{font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--border,rgba(127,127,127,.3));background:transparent;color:inherit;cursor:pointer}
.lx-pick-f button.on{background:var(--foreground,#111);color:var(--background,#fff);border-color:transparent}
.lx-pick-list{overflow:auto;padding:0 8px 8px;min-height:120px}
.lx-pick-row{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;cursor:pointer}
.lx-pick-row:hover,.lx-pick-row.on{background:color-mix(in oklab,var(--foreground,#000) 6%,transparent)}
.lx-pick-row .lx-chip-ic{width:28px;height:28px;border-radius:8px}.lx-pick-row .lx-chip-ic svg{width:15px;height:15px}
.lx-pick-row span{flex:1;min-width:0;display:grid}.lx-pick-row small{color:var(--muted-foreground,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lx-pick footer{display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;border-top:1px solid var(--border,rgba(127,127,127,.2))}
.lx-pick footer button{font:inherit;padding:7px 13px;border-radius:10px;border:1px solid var(--border,rgba(127,127,127,.3));background:transparent;color:inherit;cursor:pointer}
.lx-pick footer button.pri{background:var(--primary,#111);color:var(--primary-foreground,#fff);border-color:transparent}
.lx-pick footer button:disabled{opacity:.45;cursor:default}
.lx-pick-empty{padding:26px;text-align:center;color:var(--muted-foreground,#888)}
</style>
<div class="lx-pick" role="dialog" aria-modal="true">
  <header><b>${esc(title || L.title)}</b><input type="search" placeholder="${esc(L.search)}"><div class="lx-pick-f"></div></header>
  <div class="lx-pick-list"></div>
  <footer><button type="button" data-a="cancel">${esc(L.cancel)}</button><button type="button" data-a="chip" disabled>${esc(L.chip)}</button><button type="button" class="pri" data-a="embed" disabled>${esc(L.embed)}</button></footer>
</div>`;
    document.body.appendChild(ov);
    const list = ov.querySelector(".lx-pick-list");
    const input = ov.querySelector("input");
    const filt = ov.querySelector(".lx-pick-f");
    let files = [];
    let kind = "all";
    let chosen = null;
    const done = (v) => { ov.remove(); resolve(v); };
    const kinds = [["all", L.all], ["document", en ? "Documents" : "Documents"], ["presentation", en ? "Presentations" : "Présentations"], ["sheet", en ? "Workbooks" : "Classeurs"]];
    filt.innerHTML = kinds.map(([k, l]) => `<button type="button" data-k="${k}" class="${k === kind ? "on" : ""}">${esc(l)}</button>`).join("");
    filt.addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (!b) return; kind = b.dataset.k; filt.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); paint(); });
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      const rows = files.filter((f) => (kind === "all" || fileKindOf(f.path).kind === kind) && (!q || `${f.name} ${f.sandbox} ${f.path}`.toLowerCase().includes(q)));
      list.innerHTML = rows.length ? "" : `<div class="lx-pick-empty">${esc(L.none)}</div>`;
      rows.slice(0, 200).forEach((f) => {
        const k = fileKindOf(f.path);
        const row = document.createElement("div");
        row.className = "lx-pick-row" + (chosen === f ? " on" : "");
        row.style.setProperty("--lx-c", k.color);
        row.innerHTML = `<span class="lx-chip-ic" style="--lx-c:${k.color}">${icon(k.icon)}</span><span><b>${esc(baseName(f.path))}</b><small>${esc(k.label)} · ${esc(f.sandbox)}/${esc(f.path)}</small></span>`;
        row.addEventListener("click", () => { chosen = f; ov.querySelectorAll("footer button[data-a=chip],footer button[data-a=embed]").forEach((b) => { b.disabled = false; }); paint(); });
        row.addEventListener("dblclick", () => done({ ref: fileRefOf(f), file: f, mode: "embed" }));
        list.appendChild(row);
      });
    };
    ov.addEventListener("click", (e) => {
      if (e.target === ov) return done(null);
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "cancel") done(null);
      else if ((a === "chip" || a === "embed") && chosen) done({ ref: fileRefOf(chosen), file: chosen, mode: a });
    });
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
    input.addEventListener("input", paint);
    list.innerHTML = `<div class="lx-pick-empty">…</div>`;
    input.focus();
    files = await listOfficeFiles(true);
    paint();
  });
}
