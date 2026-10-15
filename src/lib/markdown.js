// Rendu Markdown partagé — pour tout ce qu'un modèle écrit dans une bulle.
//
// Volontairement petit et SÛR : le texte est échappé AVANT toute mise en
// forme, et seules les balises que nous produisons nous-mêmes sortent. Aucun
// HTML brut du modèle ne passe. Les liens ne prennent que http(s) et mailto.
//
// Couvre ce qu'un modèle produit spontanément : titres, listes (à puces,
// numérotées, imbriquées d'un niveau), gras/italique/barré, code en ligne et en
// bloc, tableaux, citations, filets, liens. Le reste sort en paragraphe.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const safeHref = (url) => (/^(https?:\/\/|mailto:)/i.test(String(url || "").trim()) ? String(url).trim() : "");

/** Mise en forme intra-ligne, appliquée sur du texte déjà échappé. */
export function inlineMarkdown(text) {
  const codes = [];
  // Le code brut est mis de côté en premier : un `**` dans un `code` n'est
  // pas du gras. Sentinelle en zone privée Unicode, jamais tapée par un humain.
  let out = esc(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `${codes.length - 1}`;
  });
  out = out
    // Liens [texte](url) — l'URL a été échappée, on la rétablit pour le test.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeHref(url.replace(/&amp;/g, "&"));
      return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
    })
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    // Italique : un non-espace de part et d'autre, pour ne pas transformer une
    // multiplication ou une puce égarée en balise.
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, "$1<em>$2</em>")
    // URL nues → lien.
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (m, lead, url) =>
      `${lead}<a href="${esc(url.replace(/&amp;/g, "&"))}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  return out.replace(/(\d+)/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const splitCells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Markdown → HTML. */
export function markdownToHtml(md) {
  const lines = String(md ?? "").replace(/\r/g, "").split("\n");
  let html = "";
  // Pile de listes ouvertes : [{ kind, indent }]. Un seul niveau d'imbrication
  // suffit à ce qu'un modèle produit ; on en accepte davantage sans les vérifier.
  const lists = [];
  let fence = null;
  let code = [];
  let para = [];

  const flushPara = () => {
    if (para.length) { html += `<p>${inlineMarkdown(para.join(" "))}</p>`; para = []; }
  };
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) {
      html += `</li></${lists.pop().kind}>`;
    }
  };
  const openItem = (kind, indent, body) => {
    flushPara();
    const top = lists[lists.length - 1];
    if (top && top.indent === indent && top.kind === kind) {
      html += `</li><li>${body}`;
      return;
    }
    if (top && top.indent === indent) {
      html += `</li></${lists.pop().kind}>`;
    } else if (top && top.indent > indent) {
      closeLists(indent);
      const now = lists[lists.length - 1];
      if (now && now.indent === indent) {
        if (now.kind === kind) { html += `</li><li>${body}`; return; }
        html += `</li></${lists.pop().kind}>`;
      }
    }
    html += `<${kind}><li>${body}`;
    lists.push({ kind, indent });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (/^\s*```/.test(line)) {
      if (fence === null) {
        flushPara(); closeLists();
        fence = line.replace(/^\s*```/, "").trim();
        code = [];
      } else {
        html += `<pre class="md-code"${fence ? ` data-lang="${esc(fence)}"` : ""}><code>${esc(code.join("\n"))}</code></pre>`;
        fence = null;
      }
      continue;
    }
    if (fence !== null) { code.push(raw); continue; }

    if (!line.trim()) { flushPara(); closeLists(); continue; }

    // Tableau : une ligne de cellules suivie d'une ligne de séparation.
    if (isTableRow(line) && isTableSep(lines[i + 1] || "")) {
      flushPara(); closeLists();
      const head = splitCells(line);
      const aligns = splitCells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : ""));
      let body = "";
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = splitCells(lines[i]);
        body += `<tr>${head.map((_, j) => `<td${aligns[j] ? ` style="text-align:${aligns[j]}"` : ""}>${inlineMarkdown(cells[j] ?? "")}</td>`).join("")}</tr>`;
        i++;
      }
      i--;
      html += `<table class="md-table"><thead><tr>${head.map((h, j) => `<th${aligns[j] ? ` style="text-align:${aligns[j]}"` : ""}>${inlineMarkdown(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); closeLists(); html += "<hr>"; continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara(); closeLists();
      const lvl = heading[1].length;
      html += `<h${lvl}>${inlineMarkdown(heading[2].replace(/\s*#+\s*$/, ""))}</h${lvl}>`;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushPara(); closeLists();
      // Les lignes de citation consécutives forment UN bloc.
      const parts = [quote[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) parts.push(lines[++i].replace(/^>\s?/, ""));
      html += `<blockquote>${inlineMarkdown(parts.join(" "))}</blockquote>`;
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) { openItem("ol", ordered[1].length, inlineMarkdown(ordered[3])); continue; }

    const bullet = line.match(/^(\s*)[-*+•]\s+(.*)$/);
    if (bullet) {
      const task = bullet[2].match(/^\[([ xX])\]\s+(.*)$/);
      const body = task
        ? `<span class="md-task${task[1] !== " " ? " done" : ""}">${task[1] !== " " ? "☑" : "☐"}</span> ${inlineMarkdown(task[2])}`
        : inlineMarkdown(bullet[2]);
      openItem("ul", bullet[1].length, body);
      continue;
    }

    // Ligne ordinaire : dans un élément de liste indenté, elle le prolonge ;
    // sinon elle rejoint le paragraphe en cours.
    if (lists.length && /^\s{2,}/.test(raw)) { html += ` ${inlineMarkdown(line.trim())}`; continue; }
    closeLists();
    para.push(line.trim());
  }

  if (fence !== null && code.length) html += `<pre class="md-code"><code>${esc(code.join("\n"))}</code></pre>`;
  flushPara();
  closeLists();
  return html;
}

/** Vrai si le texte contient une syntaxe qui mérite un rendu (sinon : texte brut). */
export function looksLikeMarkdown(text) {
  const s = String(text ?? "");
  return /(^|\n)\s*(#{1,6}\s|[-*+•]\s|\d+[.)]\s|>\s|```|\|.*\|)/.test(s) || /\*\*|`|\[[^\]]+\]\(/.test(s);
}
