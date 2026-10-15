// Prompts système personnalisables de Lumen.
//
// Les consignes système vivent au plus près de leur usage : le prompt du
// routeur est dans `lfm.js`, celui de l'analyste dans l'app Recherche, celui de
// l'agent dans `agents.rs`. Les centraliser ici les éloignerait du code qui
// leur donne du sens et les ferait diverger au premier refactor.
//
// Ce module ajoute donc une couche de REMPLACEMENT plutôt qu'un catalogue de
// textes : chaque point d'appel garde son défaut et le passe à
// `resolvePrompt(id, defaut)`. Sans remplacement enregistré, rien ne change.
//
//   - `PROMPTS` décrit les prompts exposés dans Paramètres → Modèles →
//     « Prompts système » : identifiant stable, groupe, libellé, explication.
//   - Les remplacements sont stockés en localStorage (`lumenPrompts`) pour la
//     WebView, et recopiés dans `prompts.json` côté Rust (prompts.rs) pour les
//     surfaces sans fenêtre : agents autonomes et passerelle Telegram.
//   - `resolvePrompt` mémorise au passage le DÉFAUT observé, ce qui permet à la
//     boîte de dialogue d'afficher le texte réellement en vigueur — y compris
//     pour les prompts assemblés dynamiquement (langue, profil, catalogue
//     d'outils), qu'aucune constante ne pourrait décrire fidèlement.
//
// Les libellés portent leur traduction anglaise ici plutôt que dans `i18n.js` :
// ils n'ont de sens qu'accompagnés de leur identifiant, et les séparer ferait
// diverger la description du prompt qu'elle décrit.

const OVERRIDES_KEY = "lumenPrompts";
const DEFAULTS_KEY = "lumenPromptDefaults";

/** Catalogue affiché dans les réglages. `scope` : où le prompt est consommé. */
export const PROMPTS = [
  {
    group: "Cœur de Lumen", groupEn: "Lumen's core",
    items: [
      {
        id: "core.intro", scope: "js",
        label: "Identité de l'assistant", labelEn: "Assistant identity",
        hint: "Première ligne du prompt système global : qui est Lumen et à qui il répond. Envoyée avant chaque conversation, dans toutes les apps.",
        hintEn: "First line of the global system prompt: who Lumen is and who it answers. Sent before every conversation, in every app.",
      },
      {
        id: "core.rules", scope: "js",
        label: "Règles de comportement", labelEn: "Behaviour rules",
        hint: "Consignes de ton, de concision et de sûreté ajoutées en fin de prompt système global.",
        hintEn: "Tone, concision and safety instructions appended to the global system prompt.",
      },
      {
        id: "router.lfm", scope: "js",
        label: "Routeur d'outils (LFM2.5)", labelEn: "Tool router (LFM2.5)",
        hint: "Consigne du petit modèle qui décide s'il faut appeler un outil. Doit rester TRÈS courte : sa fiche officielle l'exige, et l'allonger casse son JSON.",
        hintEn: "Instruction for the small model deciding whether to call a tool. Must stay VERY short: its official card requires it, and lengthening it breaks its JSON.",
      },
      {
        id: "tools.lfm", scope: "js",
        label: "Mode Outils (LFM2.5)", labelEn: "Tools mode (LFM2.5)",
        hint: "Consigne courte utilisée en mode Outils quand le modèle actif est un LFM : le prompt Lumen complet noie ces petits modèles et les fait répondre à côté.",
        hintEn: "Short instruction used in Tools mode when the active model is an LFM: the full Lumen prompt drowns these small models and makes them answer off-target.",
      },
      {
        id: "desktop.docs", scope: "js",
        label: "Assistant de documentation", labelEn: "Documentation assistant",
        hint: "Mode « documentation » de la barre : répond uniquement à partir des pages de doc trouvées.",
        hintEn: "The bar's documentation mode: answers only from the doc pages it found.",
      },
      {
        id: "memory.inject", scope: "js",
        label: "Injection de mémoire", labelEn: "Memory injection",
        hint: "Bloc qui présente au modèle ce que Lumen se rappelle de vous, juste après le prompt système.",
        hintEn: "Block introducing what Lumen remembers about you, right after the system prompt.",
      },
    ],
  },
  {
    group: "Agents autonomes", groupEn: "Autonomous agents",
    items: [
      {
        id: "agent.base", scope: "rust",
        label: "Agent sans consigne propre", labelEn: "Agent without its own instruction",
        hint: "Utilisé quand un agent n'a pas d'instruction personnalisée.",
        hintEn: "Used when an agent has no custom instruction of its own.",
      },
      {
        id: "agent.tools", scope: "rust",
        label: "Usage des outils", labelEn: "Tool usage",
        hint: "Explique à l'agent comment enchaîner ses skills et conclure.",
        hintEn: "Tells the agent how to chain its skills and wrap up.",
      },
      {
        id: "agent.orchestrator", scope: "rust",
        label: "Orchestrateur", labelEn: "Orchestrator",
        hint: "Consigne de découpage et de délégation aux sous-agents.",
        hintEn: "Instruction for breaking work down and delegating to sub-agents.",
      },
      {
        id: "agent.skills", scope: "rust",
        label: "Forge de skills", labelEn: "Skill forge",
        hint: "Autorise l'agent à créer ou améliorer ses propres workflows Fluxo.",
        hintEn: "Allows the agent to create or improve its own Fluxo workflows.",
      },
      {
        id: "agent.completion", scope: "rust",
        label: "Protocole de fin", labelEn: "Completion protocol",
        hint: "Impose le compte rendu final en JSON (succès, preuves, artefacts). Modifier ce texte peut empêcher Lumen de relire les résultats des agents.",
        hintEn: "Requires the final report as JSON (success, evidence, artifacts). Changing this text can stop Lumen from reading agent results back.",
      },
      {
        id: "telegram.chat", scope: "rust",
        label: "Telegram — conversation", labelEn: "Telegram — conversation",
        hint: "Consigne appliquée aux messages reçus par la passerelle Telegram.",
        hintEn: "Instruction applied to messages received through the Telegram gateway.",
      },
      {
        id: "telegram.tools", scope: "rust",
        label: "Telegram — outils", labelEn: "Telegram — tools",
        hint: "Consigne appliquée quand un message Telegram peut déclencher un outil.",
        hintEn: "Instruction applied when a Telegram message may trigger a tool.",
      },
      { id: "slack.chat", scope: "rust", label: "Slack — conversation", labelEn: "Slack — conversation",
        hint: "Consigne appliquée aux messages reçus par la passerelle Slack.", hintEn: "Instruction applied to messages received through the Slack gateway." },
      { id: "slack.tools", scope: "rust", label: "Slack — outils", labelEn: "Slack — tools",
        hint: "Consigne quand un message Slack peut déclencher un outil.", hintEn: "Instruction when a Slack message may trigger a tool." },
      { id: "messenger.lumen", scope: "rust", label: "Messages — Lumen", labelEn: "Messages — Lumen",
        hint: "Consigne de Lumen dans l'app Messages (fils avec Lumen).", hintEn: "Lumen's instruction in the Messages app (threads with Lumen)." },
      { id: "messenger.planner.fr", scope: "rust", label: "Messages — planificateur (FR)", labelEn: "Messages — planner (FR)",
        hint: "Découpe une demande complexe en étapes avant d'utiliser les outils. Doit répondre en JSON.", hintEn: "Splits a complex request into steps before using tools. Must answer in JSON." },
      { id: "messenger.planner.en", scope: "rust", label: "Messages — planificateur (EN)", labelEn: "Messages — planner (EN)",
        hint: "Même consigne, en anglais.", hintEn: "Same instruction, in English." },
      { id: "messenger.checker.fr", scope: "rust", label: "Messages — vérificateur (FR)", labelEn: "Messages — checker (FR)",
        hint: "Relit le brouillon : répond OK ou la réponse corrigée.", hintEn: "Reviews the draft: answers OK or the corrected answer." },
      { id: "messenger.checker.en", scope: "rust", label: "Messages — vérificateur (EN)", labelEn: "Messages — checker (EN)",
        hint: "Même consigne, en anglais.", hintEn: "Same instruction, in English." },
      { id: "memory.consolidate", scope: "rust", label: "Consolidation de la mémoire", labelEn: "Memory consolidation",
        hint: "Transforme la session et les épisodes récents en faits (sémantique) et méthodes (procédurale). Doit répondre en JSON.", hintEn: "Turns the session and recent episodes into facts (semantic) and methods (procedural). Must answer in JSON." },
      { id: "notify.summary.fr", scope: "rust", label: "Résumé des notifications (FR)", labelEn: "Notification summary (FR)",
        hint: "Résumé en une phrase des notifications (capsule Halo, montre).", hintEn: "One-sentence notification summary (Halo capsule, watch)." },
      { id: "notify.summary.en", scope: "rust", label: "Résumé des notifications (EN)", labelEn: "Notification summary (EN)",
        hint: "Même consigne, en anglais.", hintEn: "Same instruction, in English." },
    ],
  },
  {
    group: "Applications", groupEn: "Applications",
    items: [
      {
        id: "app.dataanalysis", scope: "js",
        label: "Analyse de données", labelEn: "Data analysis",
        hint: "Ton et prudence de l'analyste dans l'onglet Analyse.",
        hintEn: "Tone and caution of the analyst in the Analysis tab.",
      },
      {
        id: "app.research.subqueries", scope: "js",
        label: "Recherche — décomposition", labelEn: "Research — decomposition",
        hint: "Découpe une question en sous-requêtes documentaires.",
        hintEn: "Splits a question into documentary sub-queries.",
      },
      {
        id: "app.research.analyst", scope: "js",
        label: "Recherche — synthèse sourcée", labelEn: "Research — sourced synthesis",
        hint: "Impose de ne répondre qu'à partir des passages fournis, avec citations.",
        hintEn: "Requires answering only from the supplied passages, with citations.",
      },
      {
        id: "app.notes.rewrite", scope: "js",
        label: "Notes — réécriture", labelEn: "Notes — rewriting",
        hint: "Réécrit un passage sans préambule.",
        hintEn: "Rewrites a passage with no preamble.",
      },
      {
        id: "app.notes.write", scope: "js",
        label: "Notes — rédaction", labelEn: "Notes — writing",
        hint: "Rédige un contenu de note structuré.",
        hintEn: "Writes structured note content.",
      },
      {
        id: "app.editor.chat", scope: "js",
        label: "Éditeur de code — assistance", labelEn: "Code editor — assistance",
        hint: "Aide à comprendre et améliorer du code.",
        hintEn: "Helps understand and improve code.",
      },
      {
        id: "app.editor.explain", scope: "js",
        label: "Éditeur de code — explication", labelEn: "Code editor — explanation",
        hint: "Résume brièvement ce que fait un fichier.",
        hintEn: "Briefly summarises what a file does.",
      },
      {
        id: "app.browser.summary", scope: "js",
        label: "Navigateur — résumé de page", labelEn: "Browser — page summary",
        hint: "Ton et format du résumé produit par le volet IA du navigateur.",
        hintEn: "Tone and format of the summary produced by the browser's AI pane.",
      },
      {
        id: "app.browser.qa", scope: "js",
        label: "Navigateur — questions sur la page", labelEn: "Browser — questions about the page",
        hint: "Cadre les réponses aux questions posées sur la page consultée.",
        hintEn: "Frames answers to questions asked about the page being viewed.",
      },
      {
        id: "app.ml", scope: "js",
        label: "Atelier ML", labelEn: "ML workshop",
        hint: "Conseille sur l'entraînement et l'évaluation des modèles locaux.",
        hintEn: "Advises on training and evaluating local models.",
      },
    ],
  },
  {
    group: "Outils d'écriture", groupEn: "Writing tools",
    items: [
      {
        id: "writing.proofread", scope: "js",
        label: "Relire", labelEn: "Proofread",
        hint: "Consigne de l'outil d'écriture « Relire » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Proofread” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.rewrite", scope: "js",
        label: "Réécrire", labelEn: "Rewrite",
        hint: "Consigne de l'outil d'écriture « Réécrire » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Rewrite” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.friendly", scope: "js",
        label: "Ton amical", labelEn: "Friendly tone",
        hint: "Consigne de l'outil d'écriture « Ton amical » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Friendly tone” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.professional", scope: "js",
        label: "Ton professionnel", labelEn: "Professional tone",
        hint: "Consigne de l'outil d'écriture « Ton professionnel » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Professional tone” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.concise", scope: "js",
        label: "Concis", labelEn: "Concise",
        hint: "Consigne de l'outil d'écriture « Concis » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Concise” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.describe", scope: "js",
        label: "Modification décrite", labelEn: "Described change",
        hint: "Consigne de l'outil d'écriture « Modification décrite » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Described change” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.summarize", scope: "js",
        label: "Résumer", labelEn: "Summarize",
        hint: "Consigne de l'outil d'écriture « Résumer » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Summarize” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.keypoints", scope: "js",
        label: "Points clés", labelEn: "Key points",
        hint: "Consigne de l'outil d'écriture « Points clés » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Key points” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.list", scope: "js",
        label: "Liste", labelEn: "List",
        hint: "Consigne de l'outil d'écriture « Liste » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “List” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.table", scope: "js",
        label: "Tableau", labelEn: "Table",
        hint: "Consigne de l'outil d'écriture « Tableau » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Table” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.to_en", scope: "js",
        label: "Traduire en anglais", labelEn: "Translate to English",
        hint: "Consigne de l'outil d'écriture « Traduire en anglais » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Translate to English” writing tool (menu on selected text). The model must answer with the text only.",
      },
      {
        id: "writing.to_fr", scope: "js",
        label: "Traduire en français", labelEn: "Translate to French",
        hint: "Consigne de l'outil d'écriture « Traduire en français » (menu sur texte sélectionné). Le modèle doit répondre avec le texte seul.",
        hintEn: "Instruction for the “Translate to French” writing tool (menu on selected text). The model must answer with the text only.",
      },
    ],
  },
  {
    group: "Harness (orchestration et règles)", groupEn: "Harness (orchestration and rules)",
    items: [
      { id: "harness.analyze", scope: "js", label: "Analyse de la demande", labelEn: "Request analysis",
        hint: "Étape 1 de la réponse orchestrée : décide s'il faut des outils (la date du jour est ajoutée devant).", hintEn: "Step 1 of the orchestrated answer: decides whether tools are needed (today's date is prepended)." },
      { id: "harness.route", scope: "js", label: "Choix des familles d'outils", labelEn: "Tool family routing",
        hint: "Choisit 1 à 3 familles d'outils pour la demande. Doit répondre en JSON.", hintEn: "Picks 1 to 3 tool families for the request. Must answer in JSON." },
      { id: "harness.pick", scope: "js", label: "Choix de l'outil", labelEn: "Tool pick",
        hint: "Choisit l'outil exact et ses arguments quand le planificateur hésite. Doit répondre en JSON.", hintEn: "Picks the exact tool and its arguments when the planner hesitates. Must answer in JSON." },
      { id: "harness.tools", scope: "js", label: "Boucle d'outils", labelEn: "Tool loop",
        hint: "Consigne du tour où le modèle appelle ses outils avant de rédiger (suivie de l'outil probable et des points à couvrir).", hintEn: "Instruction for the round where the model calls its tools before writing (followed by the likely tool and points to cover)." },
      { id: "harness.split", scope: "js", label: "Découpage en sous-questions", labelEn: "Sub-question split",
        hint: "Découpe une demande complexe en 2 à 4 sous-questions. Doit répondre en JSON.", hintEn: "Splits a complex request into 2 to 4 sub-questions. Must answer in JSON." },
      { id: "harness.subquestion.fr", scope: "js", label: "Réponse à une sous-question (FR)", labelEn: "Sub-question answer (FR)",
        hint: "Réponse courte à chaque sous-question, en français.", hintEn: "Short answer to each sub-question, in French." },
      { id: "harness.subquestion.en", scope: "js", label: "Réponse à une sous-question (EN)", labelEn: "Sub-question answer (EN)",
        hint: "Réponse courte à chaque sous-question, en anglais.", hintEn: "Short answer to each sub-question, in English." },
      { id: "harness.condense.fr", scope: "js", label: "Condensation des données (FR)", labelEn: "Data condensing (FR)",
        hint: "Résume les résultats d'outils trop longs avant la rédaction (le nombre de mots est fixé par le code).", hintEn: "Condenses overly long tool results before writing (the word count is set by the code)." },
      { id: "harness.condense.en", scope: "js", label: "Condensation des données (EN)", labelEn: "Data condensing (EN)",
        hint: "Résume les résultats d'outils trop longs avant la rédaction.", hintEn: "Condenses overly long tool results before writing." },
      { id: "harness.answer.fr", scope: "js", label: "Rédaction de la réponse finale (FR)", labelEn: "Final answer writing (FR)",
        hint: "Consigne de rédaction finale ; les sources [n], points à couvrir et souvenirs sont ajoutés après.", hintEn: "Final writing instruction; sources [n], points to cover and memories are appended." },
      { id: "harness.answer.en", scope: "js", label: "Rédaction de la réponse finale (EN)", labelEn: "Final answer writing (EN)",
        hint: "Consigne de rédaction finale, en anglais.", hintEn: "Final writing instruction, in English." },
      { id: "harness.verify", scope: "js", label: "Relecture / vérification", labelEn: "Review / verification",
        hint: "Relecteur qui vérifie que chaque affirmation s'appuie sur les données. Doit répondre en JSON.", hintEn: "Reviewer checking every claim is backed by the data. Must answer in JSON." },
      { id: "harness.small.fr", scope: "js", label: "Réponse des petits modèles (FR)", labelEn: "Small-model answer (FR)",
        hint: "Consigne courte utilisée par les petits modèles locaux pour répondre.", hintEn: "Short instruction used by small local models to answer." },
      { id: "harness.small.en", scope: "js", label: "Réponse des petits modèles (EN)", labelEn: "Small-model answer (EN)",
        hint: "Consigne courte des petits modèles, en anglais.", hintEn: "Short small-model instruction, in English." },
      { id: "harness.decision", scope: "js", label: "Moteur de décision (Tev1)", labelEn: "Decision engine (Tev1)",
        hint: "Consigne du modèle de décision qui aiguille entre réponse directe, outils et orchestration.", hintEn: "Instruction of the decision model that routes between direct answer, tools and orchestration." },
      { id: "harness.kind.transform", scope: "js", label: "Règle « Transformer un texte »", labelEn: "Rule “Transform a text”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.summary", scope: "js", label: "Règle « Résumer »", labelEn: "Rule “Summarize”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.grounded", scope: "js", label: "Règle « Répondre d'après des documents »", labelEn: "Rule “Grounded answer”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.json", scope: "js", label: "Règle « Produire du JSON »", labelEn: "Rule “Produce JSON”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.write", scope: "js", label: "Règle « Rédiger »", labelEn: "Rule “Write”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.creative", scope: "js", label: "Règle « Créatif »", labelEn: "Rule “Creative”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.code", scope: "js", label: "Règle « Code »", labelEn: "Rule “Code”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.explain", scope: "js", label: "Règle « Expliquer »", labelEn: "Rule “Explain”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.analysis", scope: "js", label: "Règle « Analyser des chiffres »", labelEn: "Rule “Analyze figures”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.persona", scope: "js", label: "Règle « Personnage »", labelEn: "Rule “Persona”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.vision", scope: "js", label: "Règle « Image »", labelEn: "Rule “Vision”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
      { id: "harness.kind.agent", scope: "js", label: "Règle « Agent fichiers »", labelEn: "Rule “File agent”",
        hint: "Règle ajoutée à tous les prompts d'apps de ce type d'usage (prompt-kit).", hintEn: "Rule appended to every app prompt of this usage type (prompt-kit)." },
    ],
  },
];

/** Libellé, explication ou nom de groupe dans la langue demandée. */
export function promptText(entry, field, language) {
  const en = language === "en";
  return (en && entry[`${field}En`]) || entry[field] || "";
}

/** Tous les identifiants connus, à plat. */
export function promptIds() {
  return PROMPTS.flatMap((group) => group.items.map((item) => item.id));
}

function readJson(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Remplacements enregistrés (id → texte). */
export function getOverrides() {
  if (typeof localStorage === "undefined") return {};
  return readJson(OVERRIDES_KEY);
}

/** Défauts observés à l'exécution (id → texte), pour l'affichage des réglages. */
export function getObservedDefaults() {
  if (typeof localStorage === "undefined") return {};
  return readJson(DEFAULTS_KEY);
}

/**
 * Texte à utiliser pour ce prompt : le remplacement de l'utilisateur s'il
 * existe, sinon le défaut du point d'appel.
 *
 * Fonctionne hors WebView (tests, workers) : sans localStorage, on renvoie le
 * défaut sans jamais lever.
 */
export function resolvePrompt(id, defaultText) {
  const text = String(defaultText ?? "");
  if (typeof localStorage === "undefined") return text;
  try {
    // Mémorise le défaut courant pour que les réglages puissent l'afficher et
    // proposer « revenir au défaut » sur un texte exact, pas approximatif.
    const defaults = readJson(DEFAULTS_KEY);
    if (text && defaults[id] !== text) {
      defaults[id] = text;
      localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults));
    }
    const custom = readJson(OVERRIDES_KEY)[id];
    return typeof custom === "string" && custom.trim() ? custom : text;
  } catch {
    return text;
  }
}

/**
 * Enregistre l'ensemble des remplacements et les propage au backend Rust, qui
 * sert les agents et Telegram. Une entrée vide vaut « revenir au défaut ».
 */
export async function saveOverrides(overrides) {
  const cleaned = Object.fromEntries(
    Object.entries(overrides || {}).filter(([, value]) => String(value || "").trim())
  );
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(cleaned));
  const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
  if (invoke) {
    // Best-effort : les prompts côté WebView doivent s'appliquer même si le
    // backend est indisponible (ils viennent d'être écrits en localStorage).
    try { await invoke("prompt_overrides_set", { overrides: cleaned }); }
    catch { /* les prompts Rust resteront sur leur valeur précédente */ }
  }
  return cleaned;
}

/**
 * Défauts observés, WebView et backend réunis. Les prompts des agents et de
 * Telegram vivent dans le code Rust : sans ce relais, la boîte de dialogue ne
 * pourrait jamais montrer le texte qu'on propose de remplacer.
 */
export async function loadDefaults() {
  const local = getObservedDefaults();
  const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
  if (!invoke) return local;
  try {
    const remote = await invoke("prompt_defaults_get");
    return remote && typeof remote === "object" ? { ...local, ...remote } : local;
  } catch {
    return local;
  }
}

/** Recharge les remplacements depuis le backend (source de vérité au démarrage). */
export async function loadOverridesFromBackend() {
  const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
  if (!invoke) return getOverrides();
  try {
    const remote = await invoke("prompt_overrides_get");
    if (remote && typeof remote === "object") {
      localStorage.setItem(OVERRIDES_KEY, JSON.stringify(remote));
      return remote;
    }
  } catch { /* on garde la copie locale */ }
  return getOverrides();
}

/**
 * Catalogue complet pour les réglages : les entrées décrites ci-dessus, plus
 * TOUS les prompts des modules d'apps (lib/prompts-index.js), découverts à
 * l'ouverture. Chaque entrée d'app porte son texte d'origine (`role`) : on
 * peut le restaurer même si l'app n'a encore jamais tourné.
 */
export async function loadFullCatalog() {
  const known = new Set(promptIds());
  const groups = PROMPTS.map((g) => ({ ...g, items: [...g.items] }));
  // Défauts connus sans exécution : règles de prompt-kit et décision Tev1.
  try {
    const { KIND_RULES } = await import("./prompt-kit.js");
    for (const g of groups) for (const it of g.items) {
      const k = it.id.startsWith("harness.kind.") ? it.id.slice(13) : null;
      if (k && KIND_RULES[k]) it.default = KIND_RULES[k];
    }
  } catch { /* défauts observés seulement */ }
  try {
    const { DECISION_SYSTEM } = await import("./decisions.js");
    for (const g of groups) for (const it of g.items) if (it.id === "harness.decision") it.default = DECISION_SYSTEM;
  } catch { /* idem */ }
  let modules = {};
  try { modules = (await import("./prompts-index.js")).PROMPT_MODULES; } catch { return groups; }
  const loaded = await Promise.all(Object.entries(modules).map(async ([name, load]) => {
    try { return [name, (await load()).PROMPTS || {}]; } catch { return [name, {}]; }
  }));
  const byModule = new Map();
  for (const [name, table] of loaded) {
    for (const [id, p] of Object.entries(table)) {
      if (!p || typeof p.role !== "string") continue;
      if (known.has(id)) {
        for (const g of groups) for (const it of g.items) if (it.id === id) it.default ||= p.role;
        continue;
      }
      known.add(id);
      if (!byModule.has(name)) byModule.set(name, []);
      byModule.get(name).push({
        id, scope: "js", label: p.label || id, labelEn: p.labelEn || p.label || id,
        hint: `Rôle donné au modèle (${p.kind || "usage"}) ; la règle du type d'usage et la langue de réponse sont ajoutées après.`,
        hintEn: `Role given to the model (${p.kind || "usage"}); the usage-type rule and answer language are appended.`,
        default: p.role,
      });
    }
  }
  for (const [name, items] of byModule) {
    groups.push({ group: `App — ${name}`, groupEn: `App — ${name}`, items });
  }
  return groups;
}
