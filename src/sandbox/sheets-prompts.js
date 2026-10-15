// Prompts IA du tableur Calc (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

export const PROMPTS = {
  "app.calc.formula": {
    kind: "json",
    label: "Calc — écrire une formule",
    role: "Tu écris UNE formule de tableur dans la syntaxe LibreOffice Calc en français : arguments séparés par « ; », noms de fonctions en français, références de cellules exactes.",
    build: ({ request, cell, preview, functions = "" }) => ({
      messages: buildPrompt({ id: "app.calc.formula", kind: "json", lang: "", role: PROMPTS["app.calc.formula"].role,
        data: { "FONCTIONS DISPONIBLES": functions, "CELLULE ACTIVE": cell, "EXTRAIT DE LA FEUILLE": preview },
        request, format: "une seule formule, références tirées de l'extrait.", example: { formule: "=SOMME(C2:C10)" } }),
      opts: { json: true },
    }),
    bench: [{ vars: { request: "moyenne des ventes de B2 à B5, arrondie à 2 décimales", cell: "B6", preview: "     A        B\n1    Mois     Ventes\n2    Janv     120\n3    Févr     95\n4    Mars     180\n5    Avr      60", functions: "SOMME, MOYENNE, ARRONDI, SI, MAX, MIN, NB" },
      expect: { json: true, keys: ["formule"], jsonCheck: { "=ARRONDI(MOYENNE(B2:B5);2)": (j) => /^=\s*ARRONDI\(\s*MOYENNE\(\s*B2:B5\s*\)\s*;\s*2\s*\)$/i.test(String(j.formule || "").trim()) } } }],
  },
  "app.calc.analyze": {
    kind: "analysis",
    label: "Calc — analyser la sélection",
    role: "Tu analyses une plage de données de tableur.",
    build: ({ tsv, question = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.calc.analyze", kind: "analysis", lang, role: PROMPTS["app.calc.analyze"].role,
        data: { "DONNÉES (TSV)": tsv }, request: question || "Qu'est-ce que ces données montrent ?", format: "4 phrases au plus." }),
    }),
    bench: [{ vars: { tsv: "Mois\tVentes\nJanv\t120\nFévr\t95\nMars\t180\nAvr\t60" }, expect: { re: ["Mars|180", "Avr|60"], lang: "fr", maxChars: 900 } }],
  },
};
