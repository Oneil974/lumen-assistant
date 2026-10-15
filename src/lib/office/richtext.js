// Texte riche intermédiaire entre le HTML d'Opus et les formats Office.
//
//   HTML (élément texte d'Opus)  ⇄  [paragraphe { align, list, heading, runs[] }]
//
// Un « run » est un morceau de texte à mise en forme constante (gras, couleur,
// taille…) : c'est l'unité commune à Word (w:r) et PowerPoint (a:r). Passer par
// ce modèle évite d'écrire deux convertisseurs HTML différents.

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE", "TR", "SECTION", "ARTICLE", "HEADER", "FOOTER"]);

function cssPx(v) {
  const s = String(v || "").trim();
  let m = s.match(/^([\d.]+)px$/); if (m) return parseFloat(m[1]);
  m = s.match(/^([\d.]+)pt$/); if (m) return parseFloat(m[1]) / 0.75;
  m = s.match(/^([\d.]+)em$/); if (m) return null; // relatif : laissé au défaut
  return null;
}

/**
 * HTML → paragraphes.
 * @param {string} html
 * @param {object} base mise en forme par défaut ({ sizePx, color, font, b, align })
 */
export function htmlToParagraphs(html, base = {}) {
  const doc = new DOMParser().parseFromString(`<body>${html || ""}</body>`, "text/html");
  const paras = [];
  let cur = null;
  const open = (extra = {}) => { cur = { align: base.align || "left", list: null, heading: 0, runs: [], ...extra }; paras.push(cur); };
  const ensure = () => { if (!cur) open(); return cur; };

  const walk = (node, fmt, ctx) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        const text = n.nodeValue.replace(/\s+/g, " ");
        if (!text) continue;
        if (text === " " && (!cur || !cur.runs.length)) continue;
        ensure().runs.push({ ...fmt, text });
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === "BR") { ensure().runs.push({ ...fmt, br: true, text: "" }); continue; }
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      const f = { ...fmt };
      if (tag === "B" || tag === "STRONG") f.b = true;
      if (tag === "I" || tag === "EM") f.i = true;
      if (tag === "U") f.u = true;
      if (tag === "S" || tag === "STRIKE" || tag === "DEL") f.s = true;
      if (tag === "SUP") f.sup = true;
      if (tag === "SUB") f.sub = true;
      if (tag === "CODE") f.font = "Menlo";
      if (tag === "A" && n.getAttribute("href")) f.href = n.getAttribute("href");
      if (tag === "MARK") f.highlight = "FFF59D";
      if (tag === "FONT" && n.getAttribute("color")) f.color = n.getAttribute("color");
      const st = n.style;
      if (st) {
        if (st.fontWeight && (st.fontWeight === "bold" || parseInt(st.fontWeight, 10) >= 600)) f.b = true;
        if (st.fontStyle === "italic") f.i = true;
        if (/underline/.test(st.textDecoration || st.textDecorationLine || "")) f.u = true;
        if (/line-through/.test(st.textDecoration || st.textDecorationLine || "")) f.s = true;
        if (st.color) f.color = st.color;
        if (st.backgroundColor) f.highlight = st.backgroundColor;
        const px = cssPx(st.fontSize); if (px) f.sizePx = px;
        if (st.fontFamily) f.font = st.fontFamily.split(",")[0].replace(/["']/g, "").trim();
      }
      if (BLOCKS.has(tag) || tag === "UL" || tag === "OL") {
        if (tag === "UL" || tag === "OL") {
          walk(n, f, { ...ctx, list: { ordered: tag === "OL", level: (ctx.list ? ctx.list.level + 1 : 0) } });
          cur = null;
          continue;
        }
        const heading = /^H[1-6]$/.test(tag) ? Number(tag[1]) : 0;
        const align = (st && st.textAlign) || n.getAttribute("align") || ctx.align || base.align || "left";
        open({ align, heading, list: tag === "LI" ? ctx.list : null, quote: tag === "BLOCKQUOTE" });
        if (heading) f.b = true;
        walk(n, f, { ...ctx, align });
        cur = null;
        continue;
      }
      walk(n, f, ctx);
    }
  };
  walk(doc.body, { b: !!base.b, i: false, u: false, color: base.color, sizePx: base.sizePx, font: base.font }, {});
  // Paragraphes vides en fin (souvent un <br> terminal) : retirés.
  while (paras.length && !paras[paras.length - 1].runs.some((r) => r.text.trim() || r.br)) paras.pop();
  for (const p of paras) {
    if (p.runs.length) p.runs[0].text = p.runs[0].text.replace(/^\s+/, "");
  }
  return paras.length ? paras : [{ align: base.align || "left", list: null, heading: 0, runs: [] }];
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/// Runs → HTML en ligne (styles en ligne : c'est ce que conserve Opus).
export function runsToHtml(runs, base = {}) {
  let out = "";
  for (const r of runs) {
    if (r.br) { out += "<br>"; continue; }
    if (!r.text) continue;
    let s = esc(r.text);
    const css = [];
    if (r.color && r.color.toUpperCase() !== String(base.color || "").replace("#", "").toUpperCase()) css.push(`color:#${r.color}`);
    if (r.sizePx && Math.abs(r.sizePx - (base.sizePx || 0)) > 0.6) css.push(`font-size:${Math.round(r.sizePx * 10) / 10}px`);
    if (r.font && r.font !== base.font) css.push(`font-family:'${r.font.replace(/'/g, "")}'`);
    if (r.highlight) css.push(`background:#${r.highlight}`);
    if (css.length) s = `<span style="${css.join(";")}">${s}</span>`;
    if (r.b && !base.b) s = `<b>${s}</b>`;
    if (r.i) s = `<i>${s}</i>`;
    if (r.u) s = `<u>${s}</u>`;
    if (r.s) s = `<s>${s}</s>`;
    if (r.sup) s = `<sup>${s}</sup>`;
    if (r.sub) s = `<sub>${s}</sub>`;
    if (r.href) s = `<a href="${esc(r.href)}">${s}</a>`;
    out += s;
  }
  return out;
}

/// Paragraphes → HTML de bloc (listes regroupées en <ul>/<ol>).
export function paragraphsToHtml(paras, base = {}) {
  let html = "";
  let listOpen = null;
  for (const p of paras) {
    const inner = runsToHtml(p.runs, base) || "<br>";
    const style = p.align && p.align !== "left" && p.align !== "start" ? ` style="text-align:${p.align}"` : "";
    if (p.list) {
      const tag = p.list.ordered ? "ol" : "ul";
      if (listOpen !== tag) { if (listOpen) html += `</${listOpen}>`; html += `<${tag}>`; listOpen = tag; }
      html += `<li${style}>${inner}</li>`;
      continue;
    }
    if (listOpen) { html += `</${listOpen}>`; listOpen = null; }
    html += p.quote ? `<blockquote${style}>${inner}</blockquote>` : `<p${style}>${inner}</p>`;
  }
  if (listOpen) html += `</${listOpen}>`;
  return html;
}

/// Texte brut d'un paragraphe (estimation de hauteur, recherche).
export function paraText(p) {
  return p.runs.map((r) => (r.br ? "\n" : r.text)).join("");
}
