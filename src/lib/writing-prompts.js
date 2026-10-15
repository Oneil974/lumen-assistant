// Outils d'écriture (menu sur sélection) vus comme des prompts du catalogue :
// les consignes restent dans writing-tools.js, ce module y ajoute les cas de
// test du banc `npm run bench`.
import { WRITING_OPS, writingMessages } from "./writing-tools.js";

const SAMPLE = "Hier, les équipe de Lumen ont présenté le nouveau tableau de bord. Il affiche les ventes par région, les stocks et les retards de livraison. Les commerciaux l'utiliseront chaque lundi pour préparer la réunion hebdomadaire, et la direction le consultera en fin de mois.";

const CASES = {
  proofread: [{ text: "Je pense que il ont raison, mais les résultat ne sont pas encore validé." }, { re: ["ils ont", "résultats", "validés"], not: ["^voici", "corrig[ée] :"] }],
  rewrite: [{ text: SAMPLE }, { re: ["tableau de bord"], lang: "fr" }],
  friendly: [{ text: "Merci de m'envoyer le rapport avant vendredi." }, { re: ["rapport", "vendredi"], lang: "fr" }],
  professional: [{ text: "Salut, t'as pas oublié le truc pour demain ?" }, { lang: "fr", not: ["\\bt'as\\b", "\\btruc\\b"] }],
  concise: [{ text: SAMPLE }, { shorterThan: SAMPLE.length, re: ["tableau de bord|ventes"] }],
  describe: [{ text: SAMPLE, instruction: "mets tout au futur" }, { re: ["présentera|présenteront|affichera"] }],
  summarize: [{ text: SAMPLE }, { shorterThan: SAMPLE.length, lang: "fr" }],
  keypoints: [{ text: SAMPLE }, { re: ["^\\s*[-*•] ", "ventes|stocks"] }],
  list: [{ text: SAMPLE }, { re: ["^\\s*[-*•] "] }],
  table: [{ text: "Paris : 12 ventes, 3 retards. Lyon : 8 ventes, 1 retard. Lille : 5 ventes, 0 retard." }, { re: ["\\|", "Lyon", "8"] }],
  to_en: [{ text: SAMPLE }, { lang: "en", re: ["dashboard|board"] }],
  to_fr: [{ text: "The meeting is moved to Thursday at 10 am. Please bring the sales figures." }, { lang: "fr", re: ["jeudi", "10"] }],
  // La langue du TEXTE est conservée : un texte anglais relu reste anglais.
};

export const PROMPTS = Object.fromEntries(Object.keys(WRITING_OPS).map((op) => [`writing.${op}`, {
  kind: WRITING_OPS[op].markdown && !WRITING_OPS[op].replaces ? "summary" : "transform",
  label: `Outils d'écriture — ${op}`,
  role: WRITING_OPS[op].fr,
  build: ({ text, instruction = "" }) => ({ messages: writingMessages(op, text, instruction), opts: { think: false } }),
  bench: CASES[op] ? [{ vars: CASES[op][0], expect: { ...CASES[op][1], not: [...(CASES[op][1].not || []), "<think>", "^\"\"\""] } }] : [],
}]));

PROMPTS["writing.proofread"].bench.push({
  vars: { text: "I has two cat and they doesn't like the rain." },
  expect: { re: ["have two cats", "don't|do not"], lang: "en" },
});
