// Harnais de rédaction de documents et de présentations.
//
// Un document en une seule passe, c'est ce qu'un petit modèle local fait le
// plus mal : il perd le plan en route, recopie les sources ou invente des
// chiffres. Le harnais découpe le travail en étapes courtes, chacune vérifiable :
//
//   1. CADRAGE      titre, public, objectif, ton, faits donnés (JSON) ;
//   2. COLLECTE     fichiers des sandboxes, Corpus, bases → sources [S1]… ;
//   3. PLAN         sections (document) ou diapositives et leur mise en page ;
//   4. RÉDACTION    section par section (ou diapositives par lots de 4), avec
//                   SEULEMENT les sources citées par la section ;
//   5. VÉRIFICATION chaque chiffre doit figurer dans la demande ou les sources ;
//                   sinon révision ciblée par le modèle, puis [à compléter] ;
//   6. MISE EN FORME Markdown + fichier Opus (.lumenpages / .lumenkey, lui-même
//                   exportable en .docx / .pptx) ;
//   7. ENREGISTREMENT dans la sandbox choisie.
//
// Module PUR : le modèle (`complete`, `completeJson`), la collecte (`gather`)
// et l'enregistrement (`save`) sont injectés — le banc `npm run eval:docs`
// rejoue le vrai harnais avec des réponses scriptées ou un vrai modèle.

import { PROMPTS } from "./doc-prompts.js";
import { markdownToCreativeDoc, deckToCreativeDoc, deckToMarkdown } from "./doc-layout.js";

const LAYOUTS = new Set(["title", "section", "bullets", "two_columns", "table", "quote", "kpis", "closing"]);
const clean = (s) => String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();
const clip = (s, n) => (String(s || "").length > n ? `${String(s).slice(0, n)}…` : String(s || ""));
const strArr = (a, n = 8) => (Array.isArray(a) ? a : a ? [a] : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, n);

/** JSON robuste : bloc ```json, texte autour, objet ou tableau. */
export function parseJsonLoose(text) {
  const t = clean(text).replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch {}
  const m = t.match(/[{[][\s\S]*[}\]]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ---- Vérification des chiffres -------------------------------------------------------
const NUM_RE = /(?<![\w.,])(\d{1,3}(?:[  .]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)(\s?(?:%|€|k€|M€|\$|ans?|mois|jours?|h\b))?/g;
const normNum = (s) => String(s).replace(/[  .](?=\d{3}\b)/g, "").replace(",", ".");
/** Chiffres significatifs d'un texte (≥ 2 chiffres, ou suivis d'une unité). */
export function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || "").replace(/\[S\d+\]/g, "").matchAll(NUM_RE)) {
    const n = normNum(m[1]);
    if (n.replace(/\D/g, "").length >= 2 || m[2]) out.add(n);
  }
  return out;
}
/** Chiffres du texte absents de la référence (demande + sources + date). */
export function unsupportedNumbers(text, reference) {
  const ref = numbersIn(reference);
  const refRaw = String(reference || "");
  return [...numbersIn(text)].filter((n) => !ref.has(n) && !refRaw.includes(n));
}
function blankOut(text, nums) {
  let t = String(text);
  for (const n of nums) {
    const pat = n.replace(/\./g, "[.,]").replace(/\d(?=(\d{3})+(?!\d))/g, "$&[  .]?");
    t = t.replace(new RegExp(`(?<![\\w.,])${pat}(\\s?(?:%|€|k€|M€|\\$))?`, "g"), "[à compléter]");
  }
  return t;
}

// ---- Étapes ------------------------------------------------------------------------
function frameText(f) {
  return [
    `Titre : ${f.title}`, f.audience && `Public : ${f.audience}`, f.objective && `Objectif : ${f.objective}`,
    f.tone && `Ton : ${f.tone}`, f.length && `Longueur : ${f.length}`,
    f.facts?.length ? `Faits donnés par l'utilisateur :\n${f.facts.map((x) => `- ${x}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

function sourcesList(g) {
  const out = [];
  (g.files || []).forEach((f) => out.push({ kind: "file", label: String(f.path || "").split("/").pop() || "fichier", detail: `${f.sandbox_name || ""}/${f.path || ""}`, text: String(f.text || "") }));
  (g.corpus || []).forEach((h) => out.push({ kind: "corpus", label: h.title || "Corpus", detail: "", text: String(h.text || "").trim() }));
  (g.tables || []).forEach((t) => {
    const head = `| ${t.columns.join(" | ")} |\n|${t.columns.map(() => "---").join("|")}|`;
    const body = t.rows.map((r) => `| ${r.map((v) => String(v ?? "").replace(/\|/g, "/")).join(" | ")} |`).join("\n");
    out.push({ kind: "table", label: t.base, detail: t.sql, text: `${head}\n${body}` });
  });
  return out.map((s, i) => ({ ...s, id: `S${i + 1}` }));
}
const sourcesBlock = (list, ids = null, per = 2400) => {
  const pick = ids?.length ? list.filter((s) => ids.includes(s.id)) : list;
  return (pick.length ? pick : list).map((s) => `[${s.id}] ${s.label}\n${clip(s.text, per)}`).join("\n\n");
};

function fallbackSections(plan) {
  return String(plan || "Introduction, Développement, Conclusion").split(/[,.;]\s*/).map((t) => t.trim()).filter((t) => t.length > 3).slice(0, 7)
    .map((t) => ({ title: t.replace(/\(.*?\)/g, "").trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 70), goal: t, points: [], sources: [], table: false }));
}

function normalizeSlides(plan, count) {
  let slides = (Array.isArray(plan?.slides) ? plan.slides : []).map((s) => ({
    layout: LAYOUTS.has(s?.layout) ? s.layout : "bullets",
    title: String(s?.title || "").trim().slice(0, 90),
    goal: String(s?.goal || s?.title || "").slice(0, 200),
    sources: strArr(s?.sources, 4).map((x) => x.replace(/[[\]]/g, "")),
  })).filter((s) => s.title || s.goal);
  if (!slides.length) slides = [{ layout: "title", title: "", goal: "Titre et promesse" }, { layout: "bullets", title: "Le contexte", goal: "contexte" }, { layout: "bullets", title: "La proposition", goal: "solution" }, { layout: "closing", title: "Merci", goal: "appel à l'action" }];
  if (slides[0].layout !== "title") slides.unshift({ layout: "title", title: "", goal: "Titre", sources: [] });
  if (slides.at(-1).layout !== "closing") slides.push({ layout: "closing", title: "Merci", goal: "Conclusion et appel à l'action", sources: [] });
  const max = Math.max(4, Math.min(18, count + 2));
  if (slides.length > max) slides = [...slides.slice(0, max - 1), slides.at(-1)];
  let sec = 0;
  for (const s of slides) if (s.layout === "section") s.number = ++sec;
  return slides;
}

function mergeSlide(base, got = {}) {
  const s = { ...base };
  if (got.title && (!s.title || s.layout !== "title")) s.title = String(got.title).slice(0, 100);
  if (!s.title && got.title) s.title = String(got.title).slice(0, 100);
  if (got.subtitle) s.subtitle = String(got.subtitle).slice(0, 160);
  s.bullets = strArr(got.bullets, 6).map((b) => clip(b, 110));
  for (const k of ["left", "right"]) if (got[k]) s[k] = { title: String(got[k].title || "").slice(0, 60), bullets: strArr(got[k].bullets, 5).map((b) => clip(b, 90)) };
  if (Array.isArray(got.table) && got.table.length) s.table = got.table.filter(Array.isArray).slice(0, 9).map((r) => r.slice(0, 6).map((c) => String(c ?? "")));
  if (got.quote) { s.quote = String(got.quote).slice(0, 240); s.author = String(got.author || "").slice(0, 80); }
  if (Array.isArray(got.kpis)) s.kpis = got.kpis.slice(0, 4).map((k) => ({ value: String(k?.value ?? "").slice(0, 14), label: String(k?.label ?? "").slice(0, 60) })).filter((k) => k.value);
  s.notes = String(got.notes || "").slice(0, 600);
  // Une mise en page sans son contenu se replie sur des puces.
  if (s.layout === "two_columns" && !(s.left && s.right)) s.layout = "bullets";
  if (s.layout === "table" && !s.table?.length) s.layout = "bullets";
  if (s.layout === "kpis" && !s.kpis?.length) s.layout = "bullets";
  if (s.layout === "quote" && !s.quote) s.layout = "bullets";
  return s;
}

/**
 * Exécute le harnais.
 * req  = { kind: {name, fr, plan, tables, deck, annex}, brief, title?, tone?, keywords?, lang?, theme?, slides?, deck? }
 * deps = {
 *   complete(messages) → texte,        completeJson(messages) → objet|null,
 *   gather({ keywords, brief, tables }) → { files, corpus, tables },
 *   save({ title, folder, markdown, creative, deck }) → { sandbox, files }|null,
 *   stage(label, icon) → done(note, ok),  today: "8 octobre 2026",  signal,
 * }
 */
export async function runDocHarness(req, deps) {
  const kind = req.kind;
  const lang = req.lang || "fr";
  const isDeck = !!(req.deck ?? kind.deck);
  const stage = deps.stage || (() => () => {});
  const trace = [];
  const step = async (id, label, ic, fn) => {
    if (deps.signal?.aborted) throw new Error("Rédaction interrompue.");
    const done = stage(label, ic);
    const t0 = Date.now();
    try {
      const { value, note } = await fn();
      trace.push({ id, ms: Date.now() - t0, ok: true, note });
      done(note || "", true);
      return value;
    } catch (e) {
      trace.push({ id, ms: Date.now() - t0, ok: false, note: String(e?.message || e) });
      done(String(e?.message || e), false);
      throw e;
    }
  };
  const L = lang === "en"
    ? { brief: "Framing the request", collect: "Gathering your sources", outline: isDeck ? "Designing the slides" : "Building the outline", write: isDeck ? "Writing the slides" : "Writing section by section", verify: "Checking the facts", layout: "Laying out", save: "Saving" }
    : { brief: "Cadre la demande", collect: "Rassemble tes sources", outline: isDeck ? "Conçoit le déroulé" : "Construit le plan", write: isDeck ? "Rédige les diapositives" : "Rédige section par section", verify: "Vérifie les faits", layout: "Met en forme", save: "Enregistre" };

  // 1. Cadrage
  const frame = await step("brief", L.brief, "compass", async () => {
    const msgs = PROMPTS["tool.doc.brief"].build({ kindName: kind.fr, brief: req.brief, lang }).messages;
    const raw = (await deps.completeJson(msgs)) || {};
    const f = {
      title: String(req.title || raw.title || "").trim().slice(0, 90) || `${kind.fr} — ${req.brief.slice(0, 40)}`,
      audience: String(raw.audience || "").slice(0, 160), objective: String(raw.objective || "").slice(0, 200),
      tone: String(req.tone || raw.tone || "").slice(0, 80), length: String(raw.length || "").slice(0, 20),
      facts: strArr(raw.facts, 12), keywords: strArr(raw.keywords, 10),
    };
    return { value: f, note: f.title };
  });
  const frameTxt = frameText(frame);

  // 2. Collecte
  const sources = await step("collect", L.collect, "folderOpen", async () => {
    const g = await deps.gather({ keywords: [...new Set([...strArr(req.keywords, 12), ...frame.keywords])], brief: req.brief, tables: !!kind.tables });
    const list = sourcesList(g || {});
    return { value: list, note: list.length ? `${list.length} source(s)` : (lang === "en" ? "no source" : "aucune source") };
  });
  const reference = [req.brief, frameTxt, deps.today || "", ...sources.map((s) => s.text)].join("\n");
  const srcIndex = sources.map((s) => `[${s.id}] ${s.label} — ${clip(s.text.replace(/\s+/g, " "), 160)}`).join("\n");

  // 3. Plan
  const outline = await step("outline", L.outline, isDeck ? "presentation" : "list", async () => {
    if (isDeck) {
      const count = Math.max(5, Math.min(16, Number(req.slides) || 10));
      const msgs = PROMPTS["tool.doc.deck"].build({ kindName: kind.fr, plan: kind.plan, frame: frameTxt, sources: srcIndex, count, lang }).messages;
      const raw = await deps.completeJson(msgs);
      const slides = normalizeSlides(raw, count);
      if (!slides[0].title) slides[0].title = frame.title;
      return { value: { subtitle: String(raw?.subtitle || frame.objective || "").slice(0, 160), slides }, note: `${slides.length} ${lang === "en" ? "slides" : "diapositives"}` };
    }
    const msgs = PROMPTS["tool.doc.outline"].build({ kindName: kind.fr, plan: kind.plan, frame: frameTxt, sources: srcIndex, lang }).messages;
    const raw = await deps.completeJson(msgs);
    let sections = (Array.isArray(raw?.sections) ? raw.sections : []).map((s) => ({ title: String(s?.title || "").trim().slice(0, 90), goal: String(s?.goal || "").slice(0, 240), points: strArr(s?.points, 6), sources: strArr(s?.sources, 4).map((x) => x.replace(/[[\]]/g, "")), table: !!s?.table })).filter((s) => s.title);
    if (sections.length < 2) sections = fallbackSections(kind.plan);
    sections = sections.slice(0, 9);
    return { value: { sections }, note: `${sections.length} sections` };
  });

  // 4. Rédaction
  let parts = [];
  let deck = null;
  await step("write", L.write, "pencil", async () => {
    if (isDeck) {
      const slides = outline.slides.map((s) => ({ ...s }));
      for (let i = 0; i < slides.length; i += 4) {
        const batch = slides.slice(i, i + 4);
        const ids = [...new Set(batch.flatMap((s) => s.sources || []))];
        const desc = batch.map((s, k) => `${k + 1}. [${s.layout}] ${s.title || "(titre à trouver)"} — ${s.goal}`).join("\n");
        const msgs = PROMPTS["tool.doc.slides"].build({ frame: frameTxt, slides: desc, sources: sourcesBlock(sources, ids, 1600), lang }).messages;
        const raw = await deps.completeJson(msgs);
        const got = Array.isArray(raw?.slides) ? raw.slides : Array.isArray(raw) ? raw : [];
        batch.forEach((s, k) => { slides[i + k] = mergeSlide(s, got[k] || {}); });
      }
      if (!slides[0].subtitle && outline.subtitle) slides[0].subtitle = outline.subtitle;
      deck = { title: frame.title, subtitle: outline.subtitle, slides };
      return { note: `${slides.length} ${lang === "en" ? "slides" : "diapositives"}` };
    }
    const done = [];
    for (const sec of outline.sections) {
      const section = [`Titre : ${sec.title}`, sec.goal && `Rôle : ${sec.goal}`, sec.points.length && `Points :\n${sec.points.map((p) => `- ${p}`).join("\n")}`, sec.table && "Un tableau Markdown est attendu si les sources le permettent."].filter(Boolean).join("\n");
      const msgs = PROMPTS["tool.doc.section"].build({ section, frame: frameTxt, sources: sourcesBlock(sources, sec.sources), previous: done.join(" · "), tone: frame.tone, lang }).messages;
      let md = clean(await deps.complete(msgs));
      if (!md) md = `## ${sec.title}\n\n[à compléter]`;
      if (!/^##\s/.test(md)) md = `## ${sec.title}\n\n${md.replace(/^#+\s*.*\n/, "")}`;
      md = md.replace(/^#\s/m, "## ");
      parts.push({ title: sec.title, md, sources: sec.sources });
      done.push(sec.title);
    }
    return { note: `${parts.length} sections` };
  });

  // 5. Vérification et révision
  let corrections = 0;
  await step("verify", L.verify, "search-check", async () => {
    if (isDeck) {
      for (const s of deck.slides) {
        const text = JSON.stringify({ t: s.title, s: s.subtitle, b: s.bullets, l: s.left, r: s.right, tb: s.table, q: s.quote, k: s.kpis });
        const bad = unsupportedNumbers(text, reference);
        if (!bad.length) continue;
        corrections += bad.length;
        const fix = (x) => (x == null ? x : blankOut(x, bad));
        s.title = fix(s.title); s.subtitle = fix(s.subtitle);
        s.bullets = (s.bullets || []).map(fix);
        for (const k of ["left", "right"]) if (s[k]) s[k] = { ...s[k], bullets: s[k].bullets.map(fix) };
        if (s.table) s.table = s.table.map((r) => r.map(fix));
        if (s.quote) s.quote = fix(s.quote);
        if (s.kpis) s.kpis = s.kpis.map((k) => ({ ...k, value: fix(k.value), label: fix(k.label) }));
      }
      return { note: corrections ? `${corrections} ${lang === "en" ? "unsupported figure(s) blanked" : "chiffre(s) non étayé(s) retiré(s)"}` : (lang === "en" ? "all figures sourced" : "chiffres tous sourcés") };
    }
    for (const p of parts) {
      let bad = unsupportedNumbers(p.md, reference);
      if (!bad.length) continue;
      try {
        const msgs = PROMPTS["tool.doc.revise"].build({ text: p.md, unsupported: bad.join(", "), sources: sourcesBlock(sources, p.sources, 1600), brief: req.brief, lang }).messages;
        const revised = clean(await deps.complete(msgs));
        if (revised && /^##\s/.test(revised)) p.md = revised;
      } catch { /* révision impossible : on retombe sur le remplacement */ }
      bad = unsupportedNumbers(p.md, reference);
      if (bad.length) p.md = blankOut(p.md, bad);
      corrections += bad.length || 1;
    }
    return { note: corrections ? `${corrections} ${lang === "en" ? "correction(s)" : "correction(s)"}` : (lang === "en" ? "all figures sourced" : "chiffres tous sourcés") };
  });

  // 6. Mise en forme
  const { markdown, creative } = await step("layout", L.layout, isDeck ? "presentation" : "file-text", async () => {
    if (isDeck) {
      const md = deckToMarkdown(deck);
      return { value: { markdown: md, creative: deckToCreativeDoc(deck, { theme: req.theme || "nuit" }) }, note: lang === "en" ? "16:9 deck" : "diaporama 16:9" };
    }
    let md = `# ${frame.title}\n\n${parts.map((p) => p.md).join("\n\n")}`;
    if (kind.annex && sources.length) md += `\n\n## Sources\n\n${sources.map((s) => `- [${s.id}] ${s.label}${s.detail ? ` (${s.detail})` : ""}`).join("\n")}`;
    return { value: { markdown: md, creative: markdownToCreativeDoc(md, { title: frame.title, eyebrow: kind.fr }) }, note: `${creativePages(md)} page(s)` };
  });
  const creativeDoc = { ...creative, title: frame.title };

  // 7. Enregistrement
  let saved = null;
  if (deps.save) {
    saved = await step("save", L.save, "save", async () => {
      const r = await deps.save({ title: frame.title, folder: isDeck ? (lang === "en" ? "Presentations" : "Présentations") : "Documents", markdown, creative: creativeDoc, deck });
      return { value: r, note: r ? `${r.sandbox?.name || ""} · ${(r.files || []).map((f) => f.path.split("/").pop()).join(", ")}` : (lang === "en" ? "not saved" : "non enregistré") };
    });
  }

  const words = markdown.split(/\s+/).filter(Boolean).length;
  return { title: frame.title, frame, markdown, deck, creative: creativeDoc, sources, corrections, words, slides: deck?.slides.length || 0, saved, trace, isDeck };
}
function creativePages(md) { return markdownToCreativeDoc(md).pages.length; }
