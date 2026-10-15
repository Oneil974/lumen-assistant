#!/usr/bin/env node
/**
 * Banc du harnais de rédaction (src/lib/doc-harness.js).
 *
 *   npm run eval:docs            # réponses scriptées : logique du harnais
 *   npm run eval:docs -- --live  # vrai modèle OpenAI-compatible
 *        LUMEN_EVAL_URL (défaut http://127.0.0.1:11435/v1), LUMEN_EVAL_MODEL, LUMEN_EVAL_KEY
 *
 * Chaque cas vérifie la structure produite (sections / diapositives, mise en
 * page Opus) et surtout qu'AUCUN chiffre absent de la demande et des sources
 * ne survit à la vérification.
 */
import { runDocHarness, unsupportedNumbers } from "../src/lib/doc-harness.js";

const live = process.argv.includes("--live");
const sys = (m) => String(m[0]?.content || "");
const stageOf = (m) => {
  const s = sys(m);
  if (/cadres une demande/.test(s)) return "brief";
  if (/construis le plan/.test(s)) return "outline";
  if (/conçois le déroulé/.test(s)) return "deck";
  if (/contenu de diapositives/.test(s)) return "slides";
  if (/relis un passage/.test(s)) return "revise";
  if (/UNE section/.test(s)) return "section";
  return "?";
};

async function liveComplete(messages) {
  const url = (process.env.LUMEN_EVAL_URL || "http://127.0.0.1:11435/v1").replace(/\/$/, "");
  const r = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.LUMEN_EVAL_KEY ? { authorization: `Bearer ${process.env.LUMEN_EVAL_KEY}` } : {}) },
    body: JSON.stringify({ model: process.env.LUMEN_EVAL_MODEL || "local", messages: messages.map(({ role, content }) => ({ role, content })), temperature: 0.3 }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).choices?.[0]?.message?.content || "";
}

const CASES = [
  {
    id: "lettre-chiffres-inventes",
    req: { kind: { name: "doc_lettre_motivation", fr: "Lettre de motivation", plan: "accroche, parcours, motivation, conclusion", tables: false }, brief: "Lettre de motivation pour un poste de développeur Rust chez Acme." },
    gather: { files: [{ path: "CV.pdf", sandbox_name: "Perso", text: "5 ans d'expérience en Rust. Projet Lumen, assistant IA local. Master Université de Lyon." }] },
    script: {
      brief: { title: "Candidature Rust — Acme", facts: ["poste de développeur Rust"], keywords: ["cv"] },
      outline: { sections: [{ title: "Accroche", sources: [] }, { title: "Parcours", sources: ["S1"] }, { title: "Motivation", sources: [] }, { title: "Conclusion", sources: [] }] },
      section: (m) => (/Parcours/.test(m[1].content) ? "## Parcours\n\nFort de 5 ans en Rust, j'ai mené 12 projets avec 98 % de satisfaction." : `## ${/Titre : (.+)/.exec(m[1].content)?.[1] || "Section"}\n\nTexte.`),
      revise: (m) => "## Parcours\n\nFort de 5 ans en Rust, j'ai mené [à compléter] projets avec [à compléter] de satisfaction.",
    },
    check: (r) => [["4 sections", (r.markdown.match(/^## /gm) || []).length === 4], ["chiffre inventé retiré", !/98/.test(r.markdown) && !/\b12 projets/.test(r.markdown)], ["fait sourcé gardé", /5 ans/.test(r.markdown)], ["pages Opus", r.creative.pages.length >= 1]],
  },
  {
    id: "rapport-revision-ratee",
    req: { kind: { name: "doc_rapport", fr: "Rapport", plan: "résumé, analyse, recommandations", tables: true, annex: true }, brief: "Rapport des ventes du trimestre." },
    gather: { tables: [{ base: "Ventes", sql: "SELECT …", columns: ["mois", "ca"], rows: [["juillet", "42 300"], ["août", "38 100"]] }] },
    script: {
      brief: { title: "Ventes T3" },
      outline: { sections: [{ title: "Résumé", sources: ["S1"] }, { title: "Analyse", sources: ["S1"] }] },
      section: (m) => (/Analyse/.test(m[1].content) ? "## Analyse\n\nJuillet : 42 300 €, en hausse de 15 % sur un an." : "## Résumé\n\nTrimestre stable."),
      revise: () => "désolé, je ne peux pas",
    },
    check: (r) => [["chiffre sourcé gardé", /42 300/.test(r.markdown)], ["15 % retiré (repli)", !/15 %/.test(r.markdown)], ["annexe Sources", /## Sources/.test(r.markdown)]],
  },
  {
    id: "diaporama-kpis",
    req: { kind: { name: "doc_presentation", fr: "Présentation", plan: "titre, chiffres, conclusion", tables: false, deck: true }, brief: "Présente notre atelier de céramique, ouvert depuis 5 ans.", slides: 6 },
    gather: {},
    script: {
      brief: { title: "L'atelier" },
      deck: { slides: [{ layout: "bullets", title: "Accroche" }, { layout: "two_columns", title: "Offre" }, { layout: "kpis", title: "Chiffres" }] },
      slides: { slides: [{ title: "L'atelier" }, { title: "Accroche", bullets: ["Un lieu chaleureux"] }, { title: "Offre", bullets: ["Cours"] }, { title: "Chiffres", kpis: [{ value: "5 ans", label: "d'existence" }, { value: "300 élèves", label: "formés" }] }, { title: "Merci", subtitle: "À bientôt" }] },
    },
    check: (r) => [["titre en tête", r.deck.slides[0].layout === "title"], ["conclusion en fin", r.deck.slides.at(-1).layout === "closing"], ["2 colonnes vides → puces", r.deck.slides.find((s) => s.title === "Offre")?.layout === "bullets"], ["300 élèves retiré", !JSON.stringify(r.deck).includes("300")], ["5 ans gardé", JSON.stringify(r.deck).includes("5 ans")], ["une page par diapositive", r.creative.pages.length === r.deck.slides.length]],
  },
  {
    id: "json-casse",
    req: { kind: { name: "doc_rediger", fr: "Document", plan: "Introduction, Développement, Conclusion", tables: false }, brief: "Note sur le télétravail." },
    gather: {},
    script: { brief: "pas du json", outline: "", section: (m) => `## ${/Titre : (.+)/.exec(m[1].content)?.[1]}\n\nContenu.` },
    check: (r) => [["plan de repli", (r.markdown.match(/^## /gm) || []).length >= 2], ["titre déduit", r.title.length > 0]],
  },
];

let pass = 0, total = 0;
for (const c of CASES) {
  const pick = (m) => { const v = c.script[stageOf(m)]; return typeof v === "function" ? v(m) : v; };
  const asText = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  const complete = live ? liveComplete : async (m) => asText(pick(m));
  const completeJson = async (m) => { const raw = live ? await liveComplete(m) : asText(pick(m)); try { return JSON.parse(String(raw).replace(/^```(?:json)?|```$/g, "")); } catch { return null; } };
  const t0 = Date.now();
  let r, err = "";
  try {
    r = await runDocHarness({ ...c.req, lang: "fr" }, { complete, completeJson, gather: async () => ({ files: [], corpus: [], tables: [], ...c.gather }), today: "8 octobre 2026" });
  } catch (e) { err = String(e?.message || e); }
  const checks = err ? [["exécution", false]] : live
    ? [["structure", r.isDeck ? r.deck.slides.length >= 4 : (r.markdown.match(/^## /gm) || []).length >= 2], ["aucun chiffre non étayé", unsupportedNumbers(r.isDeck ? JSON.stringify(r.deck) : r.markdown, [c.req.brief, ...(c.gather.files || []).map((f) => f.text), JSON.stringify(c.gather.tables || []), "8 octobre 2026"].join("\n")).length === 0]]
    : c.check(r);
  const ok = checks.every(([, v]) => v);
  total++; if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${c.id.padEnd(28)} ${String(Date.now() - t0).padStart(6)} ms  ${checks.map(([n, v]) => `${v ? "·" : "✗"} ${n}`).join("  ")}${err ? `  — ${err}` : ""}`);
}
console.log(`\n${pass}/${total} cas réussis${live ? " (live)" : ""}.`);
process.exit(pass === total ? 0 : 1);
