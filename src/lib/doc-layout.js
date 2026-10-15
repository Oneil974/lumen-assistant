// Mise en page automatique des documents produits par le harnais de rédaction
// (lib/doc-harness.js) au format des éditeurs Opus :
//   • Markdown → document A4 paginé (.lumenpages) : titres, paragraphes,
//     listes, citations et tableaux posés sur la grille de l'éditeur (marges
//     90 px, 614 px utiles), avec saut de page quand un bloc ne tient plus ;
//   • plan de diaporama → présentation 16:9 (.lumenkey) : une mise en page par
//     type de diapositive, un thème de couleurs cohérent, notes de l'orateur.
// Les éléments ont exactement la forme de sandbox/creative-editor.js : les
// fichiers s'ouvrent, se retouchent et s'exportent en .docx/.pptx comme les
// autres. Module pur (aucun DOM) : testable sous Node.

let seq = 0;
const uid = () => `el-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
const SERIF = "ui-serif, Georgia, 'Times New Roman', serif";

/** Gras/italique/code Markdown → HTML (le texte est échappé d'abord). */
export function inlineMd(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
const plain = (s) => String(s ?? "").replace(/\*\*|__|`/g, "").replace(/(^|\s)\*([^*]+)\*/g, "$1$2");

export function textEl(o = {}) {
  return {
    id: uid(), type: "text", x: o.x ?? 60, y: o.y ?? 60, w: o.w ?? 360, h: o.h ?? 80, rotation: 0,
    html: o.html ?? "", fontSize: o.fontSize ?? 17, fontFamily: o.fontFamily ?? SANS,
    color: o.color ?? "#1d1d1f", align: o.align ?? "left", weight: o.weight ?? 400, lineHeight: o.lineHeight ?? 1.5,
    letterSpacing: o.letterSpacing ?? 0, bg: o.bg ?? "transparent", opacity: 1, padding: o.padding ?? 4, style: o.style ?? "",
  };
}
export function tableEl(o = {}) {
  const rows = o.rows || [[""]];
  return {
    id: uid(), type: "table", x: o.x ?? 90, y: o.y ?? 90, w: o.w ?? 614, h: o.h ?? (o.rowH ?? 30) * rows.length + 12, rotation: 0,
    rows, header: true, opacity: 1, fontSize: o.fontSize ?? 13, color: o.color ?? "#1d1d1f",
    headerBg: o.headerBg ?? "#f2f2f7", borderColor: o.borderColor ?? "#d1d1d6", zebra: true, align: "left",
  };
}
export function shapeEl(o = {}) {
  return { id: uid(), type: "shape", shape: o.shape ?? "rect", x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 100, h: o.h ?? 100, rotation: 0, fill: o.fill ?? "#0a84ff", stroke: "transparent", strokeWidth: 0, radius: o.radius ?? 16, opacity: o.opacity ?? 1 };
}

// ---- Markdown → blocs ----------------------------------------------------------------
export function mdBlocks(md) {
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push({ t: "p", text: para.join(" ") }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { flush(); out.push({ t: `h${Math.min(3, h[1].length)}`, text: h[2].trim() }); continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells.map(plain));
        i++;
      }
      i--;
      if (rows.length) out.push({ t: "table", rows });
      continue;
    }
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      flush();
      const items = [li[1]];
      while (i + 1 < lines.length && /^\s*(?:[-*•]|\d+[.)])\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""));
      out.push({ t: "ul", items });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(l);
    if (q) { flush(); out.push({ t: "quote", text: q[1] }); continue; }
    if (!l.trim()) { flush(); continue; }
    para.push(l.trim());
  }
  flush();
  return out;
}

// ---- Document A4 ---------------------------------------------------------------------
const A4 = { w: 794, h: 1123, m: 90, cw: 614 };
const estimateH = (text, size, lh, width = A4.cw) => {
  const cpl = Math.max(10, Math.floor(width / (size * 0.52)));
  const lines = String(text).split("\n").reduce((a, s) => a + Math.max(1, Math.ceil(plain(s).length / cpl)), 0);
  return Math.ceil(lines * size * lh + 10);
};

/**
 * Markdown → document Opus paginé. `accent` colore le sur-titre et les filets.
 * @returns {{ kind: "document", title: string, pages: object[] }}
 */
export function markdownToCreativeDoc(md, { title = "", accent = "#0a84ff", eyebrow = "" } = {}) {
  const pages = [];
  let page = null, y = 0;
  const newPage = () => { page = { w: A4.w, h: A4.h, background: "#ffffff", elements: [] }; pages.push(page); y = A4.m; };
  const room = (h) => { if (!page || y + h > A4.h - A4.m) newPage(); };
  newPage();
  if (eyebrow) { page.elements.push(textEl({ x: A4.m, y, w: A4.cw, h: 24, html: esc(eyebrow.toUpperCase()), fontSize: 12.5, weight: 800, color: accent, letterSpacing: 2, style: "caption" })); y += 30; }
  for (const b of mdBlocks(md)) {
    if (b.t === "h1") {
      const h = estimateH(b.text, 40, 1.15);
      room(h + 20);
      page.elements.push(textEl({ x: A4.m, y, w: A4.cw, h, html: inlineMd(b.text), fontSize: 40, weight: 800, lineHeight: 1.15, letterSpacing: -0.5, style: "h1" }));
      y += h + 18;
    } else if (b.t === "h2") {
      const h = estimateH(b.text, 26, 1.2);
      room(h + 70); // un titre ne reste jamais seul en bas de page
      page.elements.push(shapeEl({ x: A4.m, y: y + 4, w: 36, h: 4, radius: 2, fill: accent }));
      page.elements.push(textEl({ x: A4.m, y: y + 12, w: A4.cw, h, html: inlineMd(b.text), fontSize: 26, weight: 700, lineHeight: 1.2, style: "h2" }));
      y += h + 22;
    } else if (b.t === "h3") {
      const h = estimateH(b.text, 19, 1.25);
      room(h + 50);
      page.elements.push(textEl({ x: A4.m, y, w: A4.cw, h, html: inlineMd(b.text), fontSize: 19, weight: 700, lineHeight: 1.25, style: "h3" }));
      y += h + 8;
    } else if (b.t === "p") {
      const h = estimateH(b.text, 15.5, 1.6);
      room(Math.min(h, 200));
      page.elements.push(textEl({ x: A4.m, y, w: A4.cw, h, html: inlineMd(b.text), fontSize: 15.5, color: "#3a3a3c", lineHeight: 1.6, style: "body" }));
      y += h + 10;
    } else if (b.t === "ul") {
      for (const it of b.items) {
        const h = estimateH(`• ${it}`, 15.5, 1.55, A4.cw - 18);
        room(h);
        page.elements.push(textEl({ x: A4.m + 14, y, w: A4.cw - 14, h, html: `• ${inlineMd(it)}`, fontSize: 15.5, color: "#3a3a3c", lineHeight: 1.55, style: "body" }));
        y += h + 2;
      }
      y += 8;
    } else if (b.t === "quote") {
      const h = estimateH(b.text, 17, 1.55, A4.cw - 30);
      room(h + 10);
      page.elements.push(shapeEl({ x: A4.m, y, w: 3, h, radius: 2, fill: accent }));
      page.elements.push(textEl({ x: A4.m + 18, y, w: A4.cw - 18, h, html: inlineMd(b.text), fontSize: 17, color: "#3a3a3c", lineHeight: 1.55, fontFamily: SERIF, style: "quote" }));
      y += h + 14;
    } else if (b.t === "table") {
      const rows = b.rows.slice(0, 30);
      const h = 30 * rows.length + 12;
      room(h + 12);
      page.elements.push(tableEl({ x: A4.m, y, w: A4.cw, rows }));
      y += h + 16;
    }
  }
  return { kind: "document", title: title || mdBlocks(md).find((b) => b.t === "h1")?.text || "Document", pages };
}

// ---- Présentation 16:9 ----------------------------------------------------------------
export const DECK_THEMES = {
  nuit: { bg: "#0b1020", alt: "#101a2e", title: "#ffffff", text: "#c7cdea", muted: "#8a93b8", accent: "#0a84ff", card: "rgba(255,255,255,0.06)", tableHead: "rgba(255,255,255,0.12)", tableBorder: "rgba(255,255,255,0.25)" },
  clair: { bg: "#ffffff", alt: "#f5f5f7", title: "#1d1d1f", text: "#3a3a3c", muted: "#6e6e73", accent: "#0a84ff", card: "#f2f2f7", tableHead: "#e8e8ed", tableBorder: "#d1d1d6" },
  corail: { bg: "#1f1311", alt: "#2a1714", title: "#fff5f2", text: "#f3c9bf", muted: "#c58f83", accent: "#ff6b4a", card: "rgba(255,255,255,0.07)", tableHead: "rgba(255,255,255,0.12)", tableBorder: "rgba(255,255,255,0.25)" },
  foret: { bg: "#0f1a14", alt: "#13241a", title: "#f1fbf4", text: "#bfe0ca", muted: "#86b096", accent: "#30d158", card: "rgba(255,255,255,0.06)", tableHead: "rgba(255,255,255,0.12)", tableBorder: "rgba(255,255,255,0.25)" },
  sable: { bg: "#faf6ef", alt: "#f3ece0", title: "#2b2118", text: "#5a4a3a", muted: "#8c7a66", accent: "#c8782a", card: "#efe6d6", tableHead: "#e9dcc6", tableBorder: "#d9c8ab" },
};
const W = 1280, H = 720;
const bullets = (items) => (items || []).filter(Boolean).slice(0, 6).map((b) => `<p>• ${inlineMd(b)}</p>`).join("");

/**
 * Plan de diaporama → présentation Opus.
 * slide = { layout, title, subtitle?, bullets?, left?, right?, table?, quote?, author?, kpis?, notes? }
 */
export function deckToCreativeDoc(deck, { theme = "nuit" } = {}) {
  const T = DECK_THEMES[theme] || DECK_THEMES.nuit;
  const pages = (deck.slides || []).map((s, i) => {
    const p = { w: W, h: H, background: i % 2 && s.layout !== "title" && s.layout !== "closing" ? T.alt : T.bg, elements: [], notes: String(s.notes || "") };
    const E = p.elements;
    const head = (txt, y = 84) => E.push(textEl({ x: 110, y, w: 1060, h: 86, html: inlineMd(txt), fontSize: 46, weight: 800, color: T.title, lineHeight: 1.12, style: "h2" }));
    const bar = () => E.push(shapeEl({ x: 110, y: 66, w: 56, h: 6, radius: 3, fill: T.accent }));
    switch (s.layout) {
      case "title":
        E.push(shapeEl({ x: 0, y: 0, w: 14, h: H, radius: 0, fill: T.accent }));
        E.push(textEl({ x: 120, y: 230, w: 1040, h: 170, html: inlineMd(s.title), fontSize: 72, weight: 800, color: T.title, lineHeight: 1.08, letterSpacing: -1, style: "h1" }));
        if (s.subtitle) E.push(textEl({ x: 124, y: 420, w: 940, h: 90, html: inlineMd(s.subtitle), fontSize: 28, color: T.text, lineHeight: 1.4, style: "lead" }));
        break;
      case "section":
        E.push(textEl({ x: 120, y: 250, w: 200, h: 40, html: esc(String(s.number || "").padStart(2, "0")), fontSize: 28, weight: 800, color: T.accent }));
        E.push(textEl({ x: 120, y: 300, w: 1040, h: 130, html: inlineMd(s.title), fontSize: 60, weight: 800, color: T.title, lineHeight: 1.1, style: "h1" }));
        if (s.subtitle) E.push(textEl({ x: 124, y: 440, w: 940, h: 60, html: inlineMd(s.subtitle), fontSize: 24, color: T.muted, style: "lead" }));
        break;
      case "two_columns": {
        bar(); head(s.title);
        const col = (c, x) => {
          if (!c) return;
          E.push(shapeEl({ x, y: 210, w: 510, h: 420, radius: 18, fill: T.card }));
          E.push(textEl({ x: x + 30, y: 236, w: 450, h: 44, html: inlineMd(c.title || ""), fontSize: 26, weight: 700, color: T.title, style: "h3" }));
          E.push(textEl({ x: x + 30, y: 292, w: 450, h: 320, html: bullets(c.bullets), fontSize: 21, color: T.text, lineHeight: 1.55, style: "body" }));
        };
        col(s.left, 110); col(s.right, 660);
        break;
      }
      case "table":
        bar(); head(s.title);
        if (s.table?.length) E.push(tableEl({ x: 110, y: 210, w: 1060, rows: s.table.slice(0, 9).map((r) => r.slice(0, 6).map((c) => plain(c))), fontSize: 19, color: T.title, headerBg: T.tableHead, borderColor: T.tableBorder, rowH: 46 }));
        if (s.bullets?.length) E.push(textEl({ x: 110, y: 640, w: 1060, h: 50, html: inlineMd(s.bullets[0]), fontSize: 18, color: T.muted }));
        break;
      case "quote":
        E.push(textEl({ x: 140, y: 150, w: 120, h: 120, html: "“", fontSize: 160, weight: 800, color: T.accent, lineHeight: 1 }));
        E.push(textEl({ x: 160, y: 250, w: 960, h: 230, html: inlineMd(s.quote || s.title), fontSize: 40, weight: 600, color: T.title, lineHeight: 1.3, fontFamily: SERIF, style: "quote" }));
        if (s.author) E.push(textEl({ x: 160, y: 500, w: 960, h: 40, html: `— ${inlineMd(s.author)}`, fontSize: 22, color: T.muted }));
        break;
      case "kpis": {
        bar(); head(s.title);
        const ks = (s.kpis || []).slice(0, 4);
        const n = Math.max(1, ks.length), gap = 24, w = (1060 - gap * (n - 1)) / n;
        ks.forEach((k, j) => {
          const x = 110 + j * (w + gap);
          E.push(shapeEl({ x, y: 240, w, h: 260, radius: 22, fill: T.card }));
          E.push(textEl({ x: x + 26, y: 290, w: w - 52, h: 100, html: esc(k.value), fontSize: n > 3 ? 48 : 60, weight: 800, color: T.accent, lineHeight: 1 }));
          E.push(textEl({ x: x + 26, y: 400, w: w - 52, h: 80, html: inlineMd(k.label), fontSize: 20, color: T.text, lineHeight: 1.35 }));
        });
        if (s.bullets?.length) E.push(textEl({ x: 110, y: 560, w: 1060, h: 90, html: bullets(s.bullets.slice(0, 2)), fontSize: 20, color: T.muted, lineHeight: 1.5 }));
        break;
      }
      case "closing":
        E.push(shapeEl({ x: 0, y: H - 14, w: W, h: 14, radius: 0, fill: T.accent }));
        E.push(textEl({ x: 120, y: 240, w: 1040, h: 130, html: inlineMd(s.title || "Merci"), fontSize: 68, weight: 800, color: T.title, align: "center", style: "h1" }));
        if (s.subtitle || s.bullets?.length) E.push(textEl({ x: 160, y: 390, w: 960, h: 140, html: s.subtitle ? inlineMd(s.subtitle) : bullets(s.bullets), fontSize: 26, color: T.text, align: "center", lineHeight: 1.5 }));
        break;
      default: // bullets
        bar(); head(s.title);
        E.push(textEl({ x: 110, y: 210, w: 1060, h: 440, html: bullets(s.bullets), fontSize: (s.bullets || []).length > 4 ? 25 : 29, color: T.text, lineHeight: 1.6, style: "body" }));
    }
    return p;
  });
  return { kind: "presentation", title: deck.title || pages[0]?.elements?.[1]?.html || "Présentation", pages };
}

/** Plan de diaporama → Markdown (aperçu, PDF, réponse du chat). */
export function deckToMarkdown(deck) {
  const out = [`# ${deck.title || "Présentation"}`];
  if (deck.subtitle) out.push(`_${deck.subtitle}_`);
  (deck.slides || []).forEach((s, i) => {
    out.push("", `## ${i + 1}. ${s.title || s.quote || ""}`);
    if (s.subtitle && s.layout !== "title") out.push(`_${s.subtitle}_`);
    for (const b of s.bullets || []) out.push(`- ${b}`);
    for (const c of [s.left, s.right].filter(Boolean)) { out.push(`**${c.title || ""}**`); for (const b of c.bullets || []) out.push(`- ${b}`); }
    if (s.table?.length) { out.push(`| ${s.table[0].join(" | ")} |`, `| ${s.table[0].map(() => "---").join(" | ")} |`, ...s.table.slice(1).map((r) => `| ${r.join(" | ")} |`)); }
    if (s.quote && s.layout === "quote") out.push(`> ${s.quote}${s.author ? ` — ${s.author}` : ""}`);
    for (const k of s.kpis || []) out.push(`- **${k.value}** ${k.label}`);
    if (s.notes) out.push("", `> Notes : ${s.notes}`);
  });
  return out.join("\n");
}
