// Carnet relié façon Obsidian : liens [[Titre]], rétroliens, tags #mot,
// formules LaTeX ($…$ et $$…$$) et images collées ou capturées.
//
// Fonctions pures sur le tableau de notes { id, title, body } — l'interface
// (main.js) ne fait que les brancher sur l'éditeur et l'aperçu.

import { extractContainers, containerHTML, replaceFileRefs, replaceAgentMentions, finishRich, ensureRichStyles } from "../lib/rich-blocks.js";

const LINK_RE = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_/-]{2,40})/gu;
export const IMG_SCHEME = "lumen-img:";

const norm = (s) => String(s || "").trim().toLowerCase();

/** Titres cités par une note, dans l'ordre, sans doublon. */
export function outgoingLinks(body) {
  const out = [];
  for (const m of String(body || "").matchAll(LINK_RE)) {
    const t = m[1].trim();
    // [[file:…]] cite un fichier de la suite, pas une note du carnet.
    if (/^file:/i.test(t)) continue;
    if (t && !out.some((x) => norm(x) === norm(t))) out.push(t);
  }
  return out;
}

/** Notes qui citent `note` par son titre. */
export function backlinks(notes, note) {
  const t = norm(note?.title);
  if (!t) return [];
  return notes.filter((n) => n.id !== note.id && outgoingLinks(n.body).some((l) => norm(l) === t));
}

/** Notes qui MENTIONNENT le titre sans lien (suggestions de liens). */
export function unlinkedMentions(notes, note) {
  const t = norm(note?.title);
  if (!t || t.length < 3) return [];
  const linked = new Set(backlinks(notes, note).map((n) => n.id));
  return notes.filter((n) => n.id !== note.id && !linked.has(n.id) && norm(n.body).includes(t));
}

export function tagsOf(body) {
  const out = new Set();
  // Les titres Markdown (« # Titre ») et le code ne sont pas des tags.
  const text = String(body || "").replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  for (const m of text.matchAll(TAG_RE)) out.add(m[2].toLowerCase());
  return [...out];
}

export function allTags(notes) {
  const count = new Map();
  for (const n of notes) for (const t of tagsOf(n.body)) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function findByTitle(notes, title) {
  const t = norm(title);
  return notes.find((n) => norm(n.title) === t) || null;
}

/** Graphe du carnet : nœuds = notes, arêtes = liens résolus. */
export function linkGraph(notes) {
  const nodes = notes.map((n) => ({ id: n.id, title: n.title || "Sans titre" }));
  const edges = [];
  for (const n of notes) {
    for (const t of outgoingLinks(n.body)) {
      const target = findByTitle(notes, t);
      if (target && target.id !== n.id) edges.push([n.id, target.id]);
    }
  }
  return { nodes, edges };
}

// ---- Rendu de l'aperçu -----------------------------------------------------

let katex = null;
async function loadKatex() {
  if (katex) return katex;
  katex = (await import("../lib/vendor/katex/katex.js")).default;
  if (!document.querySelector("link[data-katex]")) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = new URL("../lib/vendor/katex/katex.min.css", import.meta.url).href;
    l.dataset.katex = "1";
    document.head.appendChild(l);
  }
  return katex;
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Markdown du carnet → HTML d'aperçu.
 * Les formules sont retirées AVANT le Markdown (qui abîmerait `_` et `*`) et
 * remplacées par des jetons, rendus ensuite par KaTeX.
 * @param {string} body
 * @param {{ notes: object[], render: (md:string)=>string, image: (id:string)=>string|null }} ctx
 */
export async function renderNote(body, ctx) {
  ensureRichStyles();
  // Le rendu Markdown de Lumen échappe tout HTML : liens, tags, images et
  // formules sont donc remplacés par des jetons (caractères d'usage privé,
  // intouchés par l'échappement et le Markdown), puis réinjectés APRÈS rendu.
  const tokens = [];
  const put = (html) => { tokens.push(html); return `\uE000${tokens.length - 1}\uE001`; };
  // Jeton de BLOC (encadré, aperçu…) : les sauts de ligne qui l'entourent
  // sont retirés après rendu, sinon chaque bloc traînerait des lignes vides.
  const putBlock = (html) => { tokens.push(html); return `\uE005${tokens.length - 1}\uE006`; };
  const math = [];
  // Blocs façon Notion (`:::note`, `:::toggle`, `:::columns`, `:::live`…) :
  // leur contenu est rendu par ce même moteur, puis posé comme un jeton.
  let src = await extractContainers(String(body || ""), async (type, args, inner) => {
    if (type === "columns" || type === "cols") {
      const parts = await Promise.all(inner.split(/^\+\+\+\s*$/m).map((p) => renderNote(p, ctx)));
      return putBlock(containerHTML(type, args, parts.join('<hr class="nb-colsep">'), ctx));
    }
    return putBlock(containerHTML(type, args, await renderNote(inner, ctx), ctx));
  });
  const code = [];
  src = src.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => { code.push(m); return `\uE002${code.length - 1}\uE003`; });
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => { math.push({ tex, display: true }); return put(`\uE004${math.length - 1}`); });
  src = src.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/g, (_, pre, tex) => { math.push({ tex, display: false }); return pre + put(`\uE004${math.length - 1}`); });
  src = src.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${IMG_SCHEME}([\\w-]+)\\)`, "g"), (_, alt, id) => {
    const url = ctx.image(id);
    return put(url ? `<img class="note-img" alt="${escHtml(alt)}" src="${escHtml(url)}" />` : `<span class="note-img-missing">[${escHtml(alt || "image")}]</span>`);
  });
  // Fichiers de la suite : pastille [[file:…]] ou aperçu ![[file:…]] — avant
  // les liens [[Titre]] du carnet, qui les prendraient pour des notes.
  src = replaceFileRefs(src, (html, block) => (block ? putBlock(html) : put(html)));
  src = src.replace(LINK_RE, (_, title, alias) => {
    const target = findByTitle(ctx.notes, title);
    const label = escHtml((alias || title).trim());
    return put(`<a href="#" class="wikilink${target ? "" : " is-missing"}" data-title="${escHtml(title.trim())}">${label}</a>`);
  });
  src = src.replace(TAG_RE, (_, pre, tag) => pre + put(`<a href="#" class="tag" data-tag="${escHtml(tag.toLowerCase())}">#${escHtml(tag)}</a>`));
  src = replaceAgentMentions(src, ctx.agents, put);
  src = src.replace(/\uE002(\d+)\uE003/g, (_, i) => code[Number(i)]);

  let html = finishRich(ctx.render(src));
  html = html
    .replace(/(?:<br>\s*)*<p>\s*(\uE005\d+\uE006)\s*<\/p>(?:\s*<br>)*/g, "$1")
    .replace(/(?:<br>\s*)*(\uE005\d+\uE006)(?:\s*<br>)*/g, "$1")
    .replace(/\uE005(\d+)\uE006/g, (_, i) => tokens[Number(i)]);
  let k = null;
  if (math.length) k = await loadKatex();
  html = html.replace(/\uE000(\d+)\uE001/g, (_, i) => {
    const t = tokens[Number(i)];
    const m = /^\uE004(\d+)$/.exec(t);
    if (!m) return t;
    const { tex, display } = math[Number(m[1])];
    try { return k.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" }); }
    catch { return `<code>${escHtml(tex)}</code>`; }
  });
  return html;
}
