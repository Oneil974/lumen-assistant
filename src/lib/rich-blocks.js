// Blocs « façon Notion » pour le Markdown des documents Lumen (Notes d'abord).
//
// Syntaxe (tout reste du texte lisible, exportable tel quel) :
//
//   :::note Titre facultatif          encadrés : note · info · tip · success ·
//   contenu **Markdown**              warning · danger · question · callout
//   :::                               (« :::callout 🚀 Titre » choisit l'émoji)
//
//   :::toggle Titre du dépliant       bloc repliable
//   :::columns … +++ … :::            colonnes (séparées par une ligne « +++ »)
//   :::live <id>                      bloc vivant tenu à jour par un agent
//   :::agent <Nom>                    texte écrit par un agent (@mention)
//   > [!NOTE] / [!TIP] / [!WARNING]…  alertes façon GitHub
//   ==surligné==   - [ ] tâche cochable   @Agent (pastille avec avatar)
//   [[file:Sandbox/chemin.lumensheet]]   pastille de fichier (icône + nom)
//   ![[file:Sandbox/chemin.lumenkey]]    intégration visuelle (aperçu)
//
// Les blocs s'imbriquent ; leur contenu est rendu par le même moteur. Aucun
// HTML brut de l'auteur ne passe : seules nos balises sortent.

import { icon } from "./icons.js";
import { agentAvatarHTML } from "./agent-avatar.js";
import { fileChipHTML, embedHTML } from "./lumen-files.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export const CALLOUTS = {
  note: { emoji: "📝", color: "#5b8def", fr: "Note", en: "Note" },
  info: { emoji: "ℹ️", color: "#4a9fe8", fr: "Info", en: "Info" },
  tip: { emoji: "💡", color: "#30a46c", fr: "Astuce", en: "Tip" },
  success: { emoji: "✅", color: "#30a46c", fr: "Réussi", en: "Success" },
  important: { emoji: "📌", color: "#8e5be0", fr: "Important", en: "Important" },
  warning: { emoji: "⚠️", color: "#e8a13a", fr: "Attention", en: "Warning" },
  caution: { emoji: "🛑", color: "#e0545f", fr: "Prudence", en: "Caution" },
  danger: { emoji: "🔥", color: "#e0545f", fr: "Danger", en: "Danger" },
  question: { emoji: "❓", color: "#8e5be0", fr: "Question", en: "Question" },
  callout: { emoji: "💬", color: "#8e8e93", fr: "", en: "" },
};
const isEn = () => String(localStorage.getItem("lang") || "fr").startsWith("en");

/**
 * Extrait les blocs `:::type …` de premier niveau (hors code) et les remplace
 * par ce que renvoie `render(type, args, inner)` (async). Les alertes
 * `> [!TYPE]` sont converties en blocs `:::type` au passage.
 */
export async function extractContainers(src, render) {
  const lines = alertsToContainers(String(src ?? "")).split("\n");
  const out = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) fence = !fence;
    const open = !fence && line.match(/^:::\s*([a-zA-Z]+)\s*(.*)$/);
    if (!open) { out.push(line); continue; }
    // Recherche de la fermeture correspondante (imbrication comprise).
    let depth = 1;
    let j = i + 1;
    let innerFence = false;
    for (; j < lines.length; j++) {
      if (/^\s*```/.test(lines[j])) innerFence = !innerFence;
      if (innerFence) continue;
      if (/^:::\s*[a-zA-Z]+/.test(lines[j])) depth++;
      else if (/^:::\s*$/.test(lines[j])) { depth--; if (!depth) break; }
    }
    const inner = lines.slice(i + 1, j).join("\n");
    out.push("", await render(open[1].toLowerCase(), open[2].trim(), inner), "");
    i = j; // saute la fermeture (ou la fin si le bloc n'est pas fermé)
  }
  return out.join("\n");
}

function alertsToContainers(src) {
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^>\s*\[!(\w+)\]\s*(.*)$/);
    if (!m) { out.push(lines[i]); continue; }
    const body = [];
    while (i + 1 < lines.length && /^>/.test(lines[i + 1])) body.push(lines[++i].replace(/^>\s?/, ""));
    out.push(`:::${m[1].toLowerCase()} ${m[2]}`.trimEnd(), ...body, ":::");
  }
  return out.join("\n");
}

/** HTML d'un bloc, `innerHtml` déjà rendu. */
export function containerHTML(type, args, innerHtml, ctx = {}) {
  if (type === "toggle" || type === "details") {
    return `<details class="nb-toggle"><summary>${esc(args || (isEn() ? "Details" : "Détails"))}</summary><div class="nb-toggle-body">${innerHtml}</div></details>`;
  }
  if (type === "columns" || type === "cols") {
    const cols = innerHtml.split(/<p>\s*\+\+\+\s*<\/p>|<hr class="nb-colsep">/);
    return `<div class="nb-columns" style="--nb-cols:${cols.length}">${cols.map((c) => `<div class="nb-col">${c}</div>`).join("")}</div>`;
  }
  if (type === "live") {
    const id = args.split(/\s+/)[0] || "";
    return `<section class="nb-live" data-live="${esc(id)}"><div class="nb-live-slot" data-live-id="${esc(id)}"></div><div class="nb-live-body">${innerHtml || `<p class="nb-muted">${esc(isEn() ? "Waiting for the first update…" : "En attente de la première mise à jour…")}</p>`}</div></section>`;
  }
  if (type === "working") {
    // L'agent choisi dans le menu @ garde son visage pendant qu'il écrit.
    const agent = (ctx.agents || []).find((a) => a.name.toLowerCase() === args.toLowerCase()) || null;
    const face = agent ? agentAvatarHTML(agent, { size: 26, hands: false, state: "work" }) : "⏳";
    const req = innerHtml.replace(/<[^>]+>/g, "").trim();
    return `<section class="nb-by-agent is-working"><div class="nb-by">${face}<span><b>${esc(args)}</b> ${esc(isEn() ? "is writing…" : "écrit…")}</span></div><p class="nb-muted">${esc(req)}</p></section>`;
  }
  if (type === "agent") {
    const agent = (ctx.agents || []).find((a) => a.name.toLowerCase() === args.toLowerCase()) || null;
    const face = agent ? agentAvatarHTML(agent, { size: 22, hands: false, animate: false }) : "";
    return `<section class="nb-by-agent"><div class="nb-by">${face}<span>${esc(isEn() ? `Written by ${args}` : `Écrit par ${args}`)}</span></div>${innerHtml}</section>`;
  }
  const c = CALLOUTS[type] || (type === "callout" ? CALLOUTS.callout : null);
  if (c) {
    // « :::callout 🚀 Titre » : un émoji en tête remplace l'icône par défaut.
    const em = args.match(/^(\p{Extended_Pictographic}️?)\s*(.*)$/u);
    const emoji = em ? em[1] : c.emoji;
    const title = em ? em[2] : (args || (isEn() ? c.en : c.fr));
    return `<aside class="nb-callout nb-${type}" style="--nb-c:${c.color}"><span class="nb-callout-ic">${emoji}</span><div class="nb-callout-body">${title ? `<b class="nb-callout-t">${esc(title)}</b>` : ""}${innerHtml}</div></aside>`;
  }
  return innerHtml; // type inconnu : le contenu, sans décor
}

/** Références de fichiers (à traiter AVANT les liens [[Titre]] du carnet). */
export function replaceFileRefs(src, put) {
  return src
    .replace(/^!\[\[(file:[^\]\n|]+)\]\]\s*$/gm, (_, ref) => put(embedHTML(ref.trim()), true))
    .replace(/\[\[(file:[^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_, ref, label) => put(fileChipHTML(ref.trim(), (label || "").trim())));
}

/** `@Nom` d'un agent connu → pastille avec son avatar. */
export function replaceAgentMentions(src, agents, put) {
  const names = (agents || []).map((a) => a).filter((a) => a.name).sort((a, b) => b.name.length - a.name.length);
  let out = src;
  for (const a of names) {
    const re = new RegExp(`(^|[\\s(])@${a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, (_, lead) => lead + put(`<span class="nb-mention">${agentAvatarHTML(a, { size: 16, hands: false, animate: false })}${esc(a.name)}</span>`));
  }
  return out;
}

/** Post-traitement du HTML rendu : ==surligné== et tâches cochables. */
export function finishRich(html) {
  let n = 0;
  return html
    .replace(/==([^=\n<>]{1,200})==/g, "<mark>$1</mark>")
    .replace(/<span class="md-task( done)?">[☑☐]<\/span>|(<li[^>]*>)\s*\[([ xX])\]/g, (m, done, li, mark) => {
      const on = li ? mark !== " " : !!done;
      return `${li || ""}<input type="checkbox" class="nb-task" data-task="${n++}"${on ? " checked" : ""}>`;
    });
}

/** Bascule la n-ième case `- [ ]` du texte source. */
export function toggleTaskInSource(src, index) {
  let n = -1;
  let fence = false;
  return String(src).split("\n").map((line) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return line;
    const m = line.match(/^(\s*[-*+•]\s+)\[([ xX])\](.*)$/);
    if (!m) return line;
    n++;
    return n === index ? `${m[1]}[${m[2] === " " ? "x" : " "}]${m[3]}` : line;
  }).join("\n");
}

// ---- Menu « / » (blocs à insérer) ----------------------------------------------

export const SLASH_ITEMS = [
  { id: "h1", icon: "list", fr: "Titre 1", en: "Heading 1", insert: "# " },
  { id: "h2", icon: "list", fr: "Titre 2", en: "Heading 2", insert: "## " },
  { id: "h3", icon: "list", fr: "Titre 3", en: "Heading 3", insert: "### " },
  { id: "todo", icon: "list-checks", fr: "Liste de tâches", en: "To-do list", insert: "- [ ] " },
  { id: "bullet", icon: "list", fr: "Liste à puces", en: "Bulleted list", insert: "- " },
  { id: "number", icon: "list", fr: "Liste numérotée", en: "Numbered list", insert: "1. " },
  { id: "quote", icon: "notes", fr: "Citation", en: "Quote", insert: "> " },
  { id: "callout", icon: "lightbulb", fr: "Encadré", en: "Callout", insert: ":::tip ${sel}\n\n:::", caret: 7 },
  { id: "warning", icon: "triangle-alert", fr: "Avertissement", en: "Warning", insert: ":::warning\n\n:::", caret: 12 },
  { id: "toggle", icon: "chevron-down", fr: "Bloc dépliant", en: "Toggle", insert: ":::toggle Titre\n\n:::", caret: 16 },
  { id: "columns", icon: "pages", fr: "Deux colonnes", en: "Two columns", insert: ":::columns\nColonne 1\n+++\nColonne 2\n:::", caret: 11 },
  { id: "table", icon: "table", fr: "Tableau", en: "Table", insert: "| Colonne | Colonne |\n| --- | --- |\n|  |  |\n" },
  { id: "code", icon: "code", fr: "Code", en: "Code", insert: "```\n\n```", caret: 4 },
  { id: "divider", icon: "minus", fr: "Séparateur", en: "Divider", insert: "---\n" },
  { id: "math", icon: "sparkles", fr: "Formule", en: "Formula", insert: "$$\n\n$$", caret: 3 },
  { id: "highlight", icon: "sparkles", fr: "Surligner", en: "Highlight", insert: "====", caret: 2 },
  { id: "file", icon: "file", fr: "Lien vers un fichier Lumen", en: "Link to a Lumen file", action: "file-chip" },
  { id: "embed", icon: "presentation", fr: "Intégrer doc / présentation / tableur", en: "Embed doc / slides / sheet", action: "file-embed" },
  { id: "live", icon: "refresh-cw", fr: "Bloc vivant (tenu à jour par un agent)", en: "Living block (kept up to date by an agent)", action: "live" },
  { id: "agent", icon: "agents", fr: "Demander à un agent (@)", en: "Ask an agent (@)", insert: "@" },
];

/**
 * Menu « / » en début de ligne d'un textarea : liste les blocs, filtre sur la
 * frappe, insère le gabarit ou déclenche une action (`onAction(id)`).
 */
export function attachSlashMenu(field, { onAction } = {}) {
  ensureRichStyles();
  const doc = field.ownerDocument;
  const menu = doc.createElement("div");
  menu.className = "nb-slash";
  menu.hidden = true;
  doc.body.appendChild(menu);
  let items = [];
  let active = 0;
  let tok = null;
  const close = () => { menu.hidden = true; tok = null; };
  const token = () => {
    const pos = field.selectionStart ?? 0;
    const lineStart = field.value.lastIndexOf("\n", pos - 1) + 1;
    const m = field.value.slice(lineStart, pos).match(/^\s*\/([\p{L}\d ]{0,24})$/u);
    return m ? { start: lineStart + field.value.slice(lineStart, pos).indexOf("/"), end: pos, q: m[1].toLowerCase().trim() } : null;
  };
  const choose = (i) => {
    const it = items[i];
    if (!it || !tok) return;
    const before = field.value.slice(0, tok.start);
    const after = field.value.slice(tok.end);
    if (it.action) {
      field.value = before + after;
      field.setSelectionRange(tok.start, tok.start);
      close();
      field.dispatchEvent(new Event("input", { bubbles: true }));
      onAction?.(it.action, tok.start);
      return;
    }
    const text = it.insert.replace("${sel}", "");
    field.value = before + text + after;
    const caret = tok.start + (it.caret ?? text.length);
    field.setSelectionRange(caret, caret);
    close();
    field.focus();
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const paint = () => {
    const en = isEn();
    menu.innerHTML = `<div class="nb-slash-head">${en ? "Blocks" : "Blocs"}</div>`;
    items.forEach((it, i) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "nb-slash-row" + (i === active ? " on" : "");
      b.innerHTML = `<span class="nb-slash-ic">${icon(it.icon)}</span><span>${esc(en ? it.en : it.fr)}</span>`;
      b.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
      menu.appendChild(b);
    });
    menu.hidden = !items.length;
    const r = field.getBoundingClientRect();
    menu.style.left = `${Math.max(8, r.left + 16)}px`;
    menu.style.top = `${Math.min(window.innerHeight - 330, r.top + 40)}px`;
    menu.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  };
  field.addEventListener("input", () => {
    tok = token();
    if (!tok) return close();
    const en = isEn();
    items = SLASH_ITEMS.filter((it) => !tok.q || (en ? it.en : it.fr).toLowerCase().includes(tok.q) || it.id.includes(tok.q));
    active = 0;
    paint();
  });
  field.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); choose(active); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  }, true);
  field.addEventListener("blur", () => setTimeout(close, 150));
}

export function ensureRichStyles(doc = document) {
  if (!doc || doc.getElementById("nb-css")) return;
  const st = doc.createElement("style");
  st.id = "nb-css";
  st.textContent = `
.nb-callout{display:flex;gap:10px;margin:12px 0;padding:11px 13px;border-radius:12px;
  background:color-mix(in oklab,var(--nb-c) 10%,transparent);border:1px solid color-mix(in oklab,var(--nb-c) 25%,transparent)}
.nb-callout-ic{font-size:18px;line-height:1.35;flex:none}
.nb-callout-body{flex:1;min-width:0}.nb-callout-body>:first-child{margin-top:0}.nb-callout-body>:last-child{margin-bottom:0}
.nb-callout-t{display:block;margin-bottom:3px;color:color-mix(in oklab,var(--nb-c) 70%,var(--foreground,#111))}
.nb-toggle{margin:8px 0;border-radius:10px;padding:2px 6px}
.nb-toggle>summary{cursor:pointer;font-weight:600;padding:4px 2px;list-style:none;display:flex;align-items:center;gap:6px}
.nb-toggle>summary::-webkit-details-marker{display:none}
.nb-toggle>summary::before{content:"▸";display:inline-block;transition:transform .15s;color:var(--muted-foreground,#888)}
.nb-toggle[open]>summary::before{transform:rotate(90deg)}
.nb-toggle-body{padding:2px 0 4px 20px}
.nb-columns{display:grid;grid-template-columns:repeat(var(--nb-cols,2),minmax(0,1fr));gap:18px;margin:10px 0}
@media (max-width:640px){.nb-columns{grid-template-columns:1fr}}
.nb-col>:first-child{margin-top:0}
.nb-live{margin:14px 0;border:1px solid color-mix(in oklab,var(--primary,#7c6cf0) 30%,var(--border,rgba(127,127,127,.25)));border-radius:14px;overflow:hidden}
.nb-live-body{padding:4px 14px 10px}
.nb-by-agent.is-working{animation:nb-work 1.6s ease-in-out infinite}@keyframes nb-work{50%{background:color-mix(in oklab,var(--primary,#7c6cf0) 12%,transparent)}}@media (prefers-reduced-motion:reduce){.nb-by-agent.is-working{animation:none}}
.nb-by-agent{margin:12px 0;padding:8px 12px 6px;border-left:3px solid var(--primary,#7c6cf0);background:color-mix(in oklab,var(--primary,#7c6cf0) 5%,transparent);border-radius:0 10px 10px 0}
.nb-by{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted-foreground,#888);margin-bottom:2px}
.nb-mention{display:inline-flex;align-items:center;gap:4px;padding:0 7px 0 2px;border-radius:999px;font-weight:600;
  background:color-mix(in oklab,var(--primary,#7c6cf0) 12%,transparent);vertical-align:baseline}
.nb-muted{color:var(--muted-foreground,#888);font-style:italic}
mark{background:color-mix(in oklab,#ffd84d 55%,transparent);color:inherit;border-radius:3px;padding:0 2px}
.nb-task{margin:0 6px 0 0;vertical-align:-2px;cursor:pointer;accent-color:var(--primary,#7c6cf0)}
li:has(>.nb-task:checked){color:var(--muted-foreground,#888);text-decoration:line-through}
.nb-slash{position:fixed;z-index:5000;width:280px;max-height:320px;overflow:auto;padding:5px;border-radius:14px;background:var(--card,var(--background,#fff));
  color:var(--foreground,#111);border:1px solid var(--border,rgba(127,127,127,.25));box-shadow:0 16px 40px rgba(0,0,0,.2);font:13px system-ui,-apple-system,sans-serif}
.nb-slash-head{font-size:11px;color:var(--muted-foreground,#888);padding:4px 8px 6px}
.nb-slash-row{display:flex;align-items:center;gap:9px;width:100%;text-align:left;font:inherit;color:inherit;padding:6px 8px;border-radius:9px;border:0;background:transparent;cursor:pointer}
.nb-slash-row.on,.nb-slash-row:hover{background:color-mix(in oklab,var(--primary,#7c6cf0) 11%,transparent)}
.nb-slash-ic{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:7px;border:1px solid var(--border,rgba(127,127,127,.25))}
.nb-slash-ic svg{width:13px;height:13px}
`;
  (doc.head || doc.documentElement).appendChild(st);
}
