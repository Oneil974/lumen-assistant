// Index de TOUS les prompts IA de Lumen, par module. Chaque module exporte
// `PROMPTS` : { id: { kind, label, role, build(vars) → { messages, opts }, bench: [{ vars, expect }] } }.
//
// Le banc `npm run bench` parcourt cet index : un prompt sans cas de test est
// signalé, et un fichier qui appelle le LLM sans passer par un de ces modules
// fait échouer le contrôle de couverture (scripts/lumen-bench.mjs).

export const PROMPT_MODULES = {
  core: () => import("./core-prompts.js"),
  writing: () => import("./writing-prompts.js"),
  doc: () => import("./doc-prompts.js"),
  mail: () => import("../mail/prompts.js"),
  kanban: () => import("../kanban/prompts.js"),
  mindmap: () => import("../mindmap/prompts.js"),
  inbox: () => import("../inbox/prompts.js"),
  podcast: () => import("../podcast/prompts.js"),
  tables: () => import("../tables/prompts.js"),
  musicstudio: () => import("../musicstudio/prompts.js"),
  aipet: () => import("../aipet/prompts.js"),
  adventure: () => import("../adventure/prompts.js"),
  meet: () => import("../meet/prompts.js"),
  etl: () => import("../etl/prompts.js"),
  pdf: () => import("../pdf/prompts.js"),
  studies: () => import("../studies/prompts.js"),
  robotstudio: () => import("../robotstudio/prompts.js"),
  browser: () => import("../browser/prompts.js"),
  notes: () => import("../notes/prompts.js"),
  editor: () => import("../editor/prompts.js"),
  python: () => import("../python/prompts.js"),
  ml: () => import("../ml/prompts.js"),
  dataanalysis: () => import("../data-analysis/prompts.js"),
  budget: () => import("../budget/prompts.js"),
  calc: () => import("../sandbox/sheets-prompts.js"),
  research: () => import("../research/prompts.js"),
  moodboard: () => import("../moodboard/prompts.js"),
  canvas: () => import("../canvas/prompts.js"),
  fluxo: () => import("../fluxo/prompts.js"),
  games: () => import("../games/prompts.js"),
  files: () => import("../sandbox/prompts.js"),
  agents: () => import("../agents/prompts.js"),
};
