// Rendu Markdown du rapport de Recherche profonde.
//
// Volontairement minimal — c'est un rapport, pas un éditeur — mais il doit
// couvrir ce qu'un modèle produit spontanément. La version précédente ne
// reconnaissait que `##` et `###` : un titre de niveau 1, une liste numérotée
// ou du code sortaient tels quels, dièses compris, au milieu du rapport.
//
// Les citations `[n]` sont converties en `.cite` cliquables : c'est la seule
// syntaxe propre à cette app, et elle doit survivre à l'échappement.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

/// Formatage intra-ligne, appliqué APRÈS échappement : gras, italique, code,
/// liens et citations. L'ordre compte — le code brut est neutralisé en premier
/// pour que `**` à l'intérieur d'un `code` ne devienne pas du gras.
export function inlineMd(text) {
  const codes = [];
  // Sentinelle en zone à usage privé, écrite en échappement : un simple numéro
  // entre espaces aurait fait remplacer « il y a 3 vis » par un code inexistant.
  let out = esc(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\uE000${codes.length - 1}\uE000`;
  });
  out = out
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italique : on exige un non-espace de part et d'autre pour ne pas
    // transformer une multiplication ou une puce égarée en balise.
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, "$1<em>$2</em>")
    // Citation de passage : [3] ou [3, 5] → une pastille par numéro.
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, list) => list
      .split(",")
      .map((n) => `<span class="cite" data-n="${n.trim()}">[${n.trim()}]</span>`)
      .join(""));
  return out.replace(/\uE000(\d+)\uE000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

/// Markdown → HTML. Gère titres 1-4, listes à puces et numérotées, blocs de
/// code, citations en bloc, filets et paragraphes.
export function mdToHtml(md) {
  const lines = String(md ?? "").split("\n");
  let html = "";
  let list = null; // "ul" | "ol" | null
  let fence = null; // langage du bloc de code en cours, ou null
  let code = [];

  const closeList = () => {
    if (list) { html += `</${list}>`; list = null; }
  };
  const openList = (kind) => {
    if (list !== kind) { closeList(); html += `<${kind}>`; list = kind; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Bloc de code : tout est pris à la lettre jusqu'à la clôture.
    if (/^\s*```/.test(line)) {
      if (fence === null) {
        closeList();
        fence = line.replace(/^\s*```/, "").trim();
        code = [];
      } else {
        html += `<pre class="md-code"${fence ? ` data-lang="${esc(fence)}"` : ""}><code>${esc(code.join("\n"))}</code></pre>`;
        fence = null;
      }
      continue;
    }
    if (fence !== null) { code.push(raw); continue; }

    if (!line.trim()) { closeList(); continue; }

    // Filet horizontal.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList();
      html += "<hr>";
      continue;
    }

    // Titres : de `#` à `####`. C'est le niveau 1 qui manquait, et c'est
    // justement celui qu'un modèle met en tête de rapport.
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const lvl = heading[1].length;
      html += `<h${lvl}>${inlineMd(heading[2].replace(/\s*#+\s*$/, ""))}</h${lvl}>`;
      continue;
    }

    // Citation en bloc.
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      html += `<blockquote>${inlineMd(quote[1])}</blockquote>`;
      continue;
    }

    // Liste numérotée. Le numéro d'origine est conservé (`value`) : un modèle
    // qui repart de 1 au milieu d'une énumération le fait rarement par hasard.
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ordered) {
      openList("ol");
      html += `<li value="${Number(ordered[1])}">${inlineMd(ordered[2])}</li>`;
      continue;
    }

    // Liste à puces (`-`, `*`, `+` ou `•`).
    const bullet = line.match(/^\s*[-*+•]\s+(.*)$/);
    if (bullet) {
      openList("ul");
      html += `<li>${inlineMd(bullet[1])}</li>`;
      continue;
    }

    closeList();
    html += `<p>${inlineMd(line)}</p>`;
  }

  // Bloc de code laissé ouvert par une réponse tronquée : on le rend quand même.
  if (fence !== null && code.length) {
    html += `<pre class="md-code"><code>${esc(code.join("\n"))}</code></pre>`;
  }
  closeList();
  return html;
}
