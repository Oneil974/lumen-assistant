// Volet « Connaissances » d'un projet (dossier de discussions) pour le mode
// application : instructions + documents servis en contexte complet ou par
// recherche RAG. Même stockage et même ingestion que la fenêtre Assistant du
// bureau (lib/projects.js, sandbox « Projets », source project:<id>).
import { icon } from "./icons.js";
import {
  PROJECT_SANDBOX, getProject, setProjectInstructions, addProjectFile, removeProjectFile,
  projectStats, projectServedInFull, projectSource,
} from "./projects.js";

const DOC_EXTS = ["pdf", "docx", "doc", "txt", "md", "csv", "tsv", "json", "log", "rtf", "xlsx", "pptx", "html", "htm", "odt", "ods", "odp", "py", "js", "ts", "yaml", "yml"];
const FULL_CHARS = 10000;
const ext = (n) => String(n).split(".").pop().toLowerCase();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

const L = {
  fr: { title: "Connaissances", instr: "Instructions", instrPh: "Contexte, ton, contraintes… appliqués à toutes les discussions du projet.",
    full: "contexte complet", rag: "recherche RAG", add: "Ajouter des documents", drop: "Ajoute des documents : PDF, Word, Excel, texte… L'assistant les consulte à chaque question.",
    docs: (n) => `${n} document(s)`, chunks: (n) => `${n} extraits indexés`, busy: (n) => `Indexation de ${n} fichier(s)…`, rm: "Retirer du projet",
    none: "Choisis un dossier de discussions pour lui donner des documents.", bad: "Format non pris en charge.", added: "ajouté au projet.",
    noIdx: "non indexé (encodeur indisponible), servi en contexte complet." },
  en: { title: "Knowledge", instr: "Instructions", instrPh: "Context, tone, constraints… applied to every chat in the project.",
    full: "full context", rag: "RAG search", add: "Add documents", drop: "Add documents: PDF, Word, Excel, text… The assistant reads them for every question.",
    docs: (n) => `${n} document(s)`, chunks: (n) => `${n} indexed excerpts`, busy: (n) => `Indexing ${n} file(s)…`, rm: "Remove from project",
    none: "Pick a chat folder to give it documents.", bad: "Unsupported format.", added: "added to the project.",
    noIdx: "not indexed (no encoder), served as full context." },
};

let busy = 0;
let sandboxId = null;

function injectCss() {
  if (document.getElementById("pkb-css")) return;
  const st = document.createElement("style");
  st.id = "pkb-css";
  st.textContent = `
.pkb { position: absolute; top: 0; right: 0; bottom: 0; width: min(340px, 90vw); z-index: 40; display: flex; flex-direction: column; gap: 14px; padding: 16px; overflow: auto;
  background: var(--background, #fff); color: var(--foreground, #111); border-left: 1px solid var(--border, #e5e5e5); box-shadow: var(--shadow-3, 0 8px 30px rgba(0,0,0,.12)); }
.pkb[hidden] { display: none; }
.pkb-head { display: flex; align-items: center; gap: 10px; }
.pkb-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--chip-color, var(--primary)); flex: none; }
.pkb-head div { flex: 1; min-width: 0; } .pkb-head b { display: block; font-size: 15px; } .pkb-head small { color: var(--muted-foreground, #777); font-size: 12px; }
.pkb button { font: inherit; cursor: pointer; }
.pkb-x, .pkb-mini { border: 0; background: none; color: var(--muted-foreground, #777); padding: 4px; border-radius: 6px; display: inline-flex; }
.pkb-x:hover, .pkb-mini:hover { background: var(--muted, #f2f2f2); color: var(--foreground, #111); }
.pkb-x svg, .pkb-mini svg { width: 16px; height: 16px; }
.pkb-sec-head { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground, #777); margin-bottom: 8px; }
.pkb-sec-head svg { width: 14px; height: 14px; } .pkb-sp { flex: 1; }
.pkb-mode { text-transform: none; letter-spacing: 0; font-weight: 500; font-size: 11.5px; padding: 1px 8px; border-radius: 999px; background: color-mix(in oklch, var(--primary, #e55) 14%, transparent); color: var(--primary, #e55); }
.pkb textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 70px; padding: 10px 12px; border: 1px solid var(--border, #e5e5e5); border-radius: 10px; background: transparent; color: inherit; font: inherit; font-size: 13.5px; }
.pkb-file { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px; }
.pkb-file:hover { background: var(--muted, #f6f6f6); }
.pkb-file-ic { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; background: color-mix(in oklch, var(--primary, #e55) 12%, transparent); color: var(--primary, #e55); flex: none; }
.pkb-file-ic svg { width: 16px; height: 16px; }
.pkb-file div { flex: 1; min-width: 0; } .pkb-file b { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkb-file small { font-size: 11.5px; color: var(--muted-foreground, #777); }
.pkb-drop { border: 1px dashed var(--border, #ddd); border-radius: 12px; padding: 18px; text-align: center; font-size: 12.5px; color: var(--muted-foreground, #777); cursor: pointer; }
.pkb-drop.over, .pkb-drop:hover { border-color: var(--primary, #e55); color: var(--foreground, #111); }
.pkb-busy, .pkb-none { font-size: 12.5px; color: var(--muted-foreground, #777); }`;
  document.head.appendChild(st);
}

function b64Of(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function ensureSandbox(invoke) {
  if (sandboxId) return sandboxId;
  const list = await invoke("sandbox_list").catch(() => []);
  let sb = (list || []).find((s) => s.name === PROJECT_SANDBOX);
  if (!sb) sb = await invoke("sandbox_create", { name: PROJECT_SANDBOX, maxMb: 2048 });
  sandboxId = sb.id;
  return sb.id;
}

/// Ingestion d'un document (copie dans la sandbox « Projets » + index RAG).
/// Les images restent l'affaire du bureau (description par le modèle vision).
async function ingest(o, projectId, file) {
  const t = L[o.lang()] || L.fr;
  const proj = getProject(projectId);
  if (!proj) return;
  if (!DOC_EXTS.includes(ext(file.name))) { o.toast(`${file.name} : ${t.bad}`); return; }
  busy++; render(o);
  try {
    const b64 = await b64Of(file);
    const sb = await ensureSandbox(o.invoke);
    const path = `${projectId}/${file.name}`;
    await o.invoke("sandbox_import_file", { id: sb, path, dataB64: b64 });
    const previous = proj.files.find((f) => f.name === file.name);
    if (previous?.docId) { try { await o.invoke("rag_delete", { docId: previous.docId }); } catch {} }
    const entry = { name: file.name, kind: "doc", size: file.size, path, sandboxId: sb, added: Date.now(), chars: 0, chunks: 0, docId: "" };
    const extracted = await o.invoke("doc_extract_text", { title: file.name, b64 });
    const text = String(extracted?.text || "");
    entry.chars = extracted?.chars || text.length;
    if (entry.chars <= FULL_CHARS) entry.text = text;
    try {
      const res = await o.invoke("rag_add_file_bytes", { title: file.name, b64, source: projectSource(projectId) });
      entry.docId = res?.doc_id || ""; entry.chunks = res?.chunks || 0;
    } catch (e) {
      if (!entry.text) throw e;
      o.toast(`${file.name} — ${t.noIdx}`);
    }
    addProjectFile(projectId, entry);
    o.toast(`${file.name} — ${t.added}`);
  } catch (e) {
    o.toast(`${file.name} : ${e?.message || e}`);
  } finally {
    busy--; render(o);
  }
}

function pick(o, projectId) {
  const input = document.createElement("input");
  input.type = "file"; input.multiple = true;
  input.accept = DOC_EXTS.map((e) => "." + e).join(",");
  input.addEventListener("change", async () => { for (const f of input.files || []) await ingest(o, projectId, f); });
  input.click();
}

function render(o) {
  const el = o.el;
  if (!el || el.hidden) return;
  const t = L[o.lang()] || L.fr;
  const proj = o.project();
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "pkb-head";
  head.innerHTML = `<span class="pkb-dot"></span><div><b></b><small></small></div><button class="pkb-x" title="×">${icon("x")}</button>`;
  head.querySelector(".pkb-x").addEventListener("click", () => { el.hidden = true; o.onToggle?.(false); });
  el.appendChild(head);
  if (!proj) {
    head.querySelector("b").textContent = t.title;
    el.insertAdjacentHTML("beforeend", `<div class="pkb-none">${esc(t.none)}</div>`);
    return;
  }
  head.style.setProperty("--chip-color", proj.color || "");
  head.querySelector("b").textContent = proj.name;
  const st = projectStats(proj);
  head.querySelector("small").textContent = [t.docs(st.docs), st.chunks ? t.chunks(st.chunks) : ""].filter(Boolean).join(" · ");

  const instr = document.createElement("section");
  instr.innerHTML = `<div class="pkb-sec-head">${icon("sparkles")}<span>${esc(t.instr)}</span></div><textarea rows="3" placeholder="${esc(t.instrPh)}"></textarea>`;
  const ta = instr.querySelector("textarea");
  ta.value = proj.instructions || "";
  let timer = null;
  ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => setProjectInstructions(proj.id, ta.value), 400); });
  ta.addEventListener("blur", () => { clearTimeout(timer); setProjectInstructions(proj.id, ta.value); });
  el.appendChild(instr);

  const files = document.createElement("section");
  files.innerHTML = `<div class="pkb-sec-head">${icon("library")}<span>${esc(t.title)}</span>
    ${proj.files.length ? `<span class="pkb-mode">${esc(projectServedInFull(proj) ? t.full : t.rag)}</span>` : ""}<span class="pkb-sp"></span>
    <button class="pkb-mini" data-act="add" title="${esc(t.add)}">${icon("plus")}</button></div><div class="pkb-list"></div>`;
  files.querySelector('[data-act="add"]').addEventListener("click", () => pick(o, proj.id));
  const list = files.querySelector(".pkb-list");
  for (const f of proj.files.filter((x) => x.kind !== "image").sort((a, b) => b.added - a.added)) {
    const row = document.createElement("div");
    row.className = "pkb-file";
    row.innerHTML = `<span class="pkb-file-ic">${icon(["xlsx", "csv", "tsv", "ods"].includes(ext(f.name)) ? "table" : "file-text")}</span><div><b></b><small></small></div>
      <button class="pkb-mini" title="${esc(t.rm)}">${icon("x")}</button>`;
    row.querySelector("b").textContent = f.name;
    row.querySelector("small").textContent = [f.size ? size(f.size) : "", f.chunks ? `${f.chunks} extraits` : f.chars ? `${f.chars} car.` : ""].filter(Boolean).join(" · ");
    row.querySelector("button").addEventListener("click", async () => {
      removeProjectFile(proj.id, f.name);
      if (f.docId) { try { await o.invoke("rag_delete", { docId: f.docId }); } catch {} }
      if (f.sandboxId && f.path) { try { await o.invoke("sandbox_delete_path", { id: f.sandboxId, path: f.path }); } catch {} }
      render(o);
    });
    list.appendChild(row);
  }
  const drop = document.createElement("div");
  drop.className = "pkb-drop";
  drop.textContent = t.drop;
  drop.addEventListener("click", () => pick(o, proj.id));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault(); drop.classList.remove("over");
    for (const f of e.dataTransfer?.files || []) await ingest(o, proj.id, f);
  });
  list.appendChild(drop);
  if (busy > 0) list.insertAdjacentHTML("beforeend", `<div class="pkb-busy">${esc(t.busy(busy))}</div>`);
  el.appendChild(files);
  o.onChange?.();
}

/**
 * Monte le volet dans `host` (position: relative).
 * @param {{ host: HTMLElement, invoke: Function, project: () => object|null, lang: () => string, toast: (msg: string) => void, onToggle?: Function, onChange?: Function }} opts
 */
export function mountProjectKb(opts) {
  injectCss();
  const el = document.createElement("aside");
  el.className = "pkb";
  el.hidden = true;
  opts.host.appendChild(el);
  const o = { ...opts, el };
  return {
    toggle(force) { el.hidden = force === undefined ? !el.hidden : !force; render(o); opts.onToggle?.(!el.hidden); },
    refresh() { render(o); },
    get open() { return !el.hidden; },
  };
}
