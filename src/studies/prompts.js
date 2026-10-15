// Prompts IA de l'app Études (fiches, QCM, correction, explication, podcast de
// révision). Lus aussi par le banc `npm run bench`.
import { buildPrompt } from "../lib/prompt-kit.js";

export const CARDS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["cards"],
  properties: { cards: { type: "array", items: { type: "object", additionalProperties: false, required: ["q", "a"], properties: { q: { type: "string" }, a: { type: "string" } } } } },
};
export const QUIZ_SCHEMA = {
  type: "object", additionalProperties: false, required: ["questions"],
  properties: { questions: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["question", "choices", "answer", "explanation"],
    properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" } }, answer: { type: "integer" }, explanation: { type: "string" } } } } },
};
export const CORRECTION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "grade", "points", "advice"],
  properties: {
    summary: { type: "string" },
    grade: { type: "string" },
    points: { type: "array", items: { type: "object", additionalProperties: false, required: ["excerpt", "problem", "explanation", "fix"],
      properties: { excerpt: { type: "string" }, problem: { type: "string" }, explanation: { type: "string" }, fix: { type: "string" } } } },
    advice: { type: "array", items: { type: "string" } },
  },
};
export const PODCAST_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "turns"],
  properties: {
    title: { type: "string" },
    turns: { type: "array", items: { type: "object", additionalProperties: false, required: ["speaker", "text"],
      properties: { speaker: { type: "integer", enum: [0, 1] }, text: { type: "string" } } } },
  },
};
export const PODCAST_STYLES = {
  lesson: "un professeur explique le cours à un élève curieux qui pose les questions naïves qu'on se pose vraiment",
  revision: "deux étudiants révisent ensemble la veille de l'examen : ils résument, se testent et relèvent les pièges classiques",
  quiz: "un animateur pose des questions de cours à l'auditeur, laisse un court silence (« … ») puis donne et explique la réponse",
};

const COURSE = "La photosynthèse se déroule dans les chloroplastes. Phase claire : la lumière est captée par la chlorophylle, l'eau est décomposée et du dioxygène (O2) est libéré. Phase sombre (cycle de Calvin) : le CO2 est fixé pour produire du glucose. Équation bilan : 6 CO2 + 6 H2O → C6H12O6 + 6 O2.";

export const PROMPTS = {
  "app.studies.cards": {
    kind: "json",
    label: "Études — fiches de révision",
    role: "Tu es un professeur qui prépare des fiches de révision « question → réponse » à partir d'un extrait de cours. Une seule notion par fiche ; question précise et compréhensible sans le cours ; réponse courte et exacte (1 à 3 phrases, formule ou définition). Couvre définitions, formules, dates, mécanismes et exemples. N'invente rien hors de l'extrait. Formules en LaTeX entre $…$.",
    build: ({ text, count = 5, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.studies.cards", kind: "json", lang, role: PROMPTS["app.studies.cards"].role,
        data: { "EXTRAIT DE COURS": text }, format: "exactement le nombre de fiches demandé.", example: { cards: [{ q: "En quelle année a eu lieu la prise de la Bastille ?", a: "En 1789, le 14 juillet." }] } }),
      opts: { schema: CARDS_SCHEMA, schemaName: "fiches", json: true },
    }),
    bench: [{ vars: { text: COURSE, count: 4 }, expect: { json: true, keys: ["cards"], jsonCheck: { "≥ 3 fiches": (j) => Array.isArray(j.cards) && j.cards.length >= 3, "fidèles au cours": (j) => /chloroplaste|Calvin|O2|glucose|chlorophylle/i.test(JSON.stringify(j.cards)) } } }],
  },
  "app.studies.quiz": {
    kind: "json",
    label: "Études — QCM",
    role: "Tu écris un QCM d'entraînement à partir d'un extrait de cours. Chaque question a 4 propositions plausibles dont UNE seule correcte ; « answer » est l'indice (0 à 3) de la bonne ; « explanation » dit en 1 à 3 phrases pourquoi c'est juste et pourquoi le piège principal est faux. Varie la position de la bonne réponse. N'invente rien hors de l'extrait.",
    build: ({ text, count = 3, level = "standard", lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.studies.quiz", kind: "json", lang, role: PROMPTS["app.studies.quiz"].role,
        data: { "EXTRAIT DE COURS": text }, request: `Niveau : ${level}.`,
        format: "exactement 4 choix par question ; answer = indice (0 à 3) du bon choix ; exactement le nombre de questions demandé.", example: { questions: [{ question: "Quelle est la capitale de l'Australie ?", choices: ["Sydney", "Canberra", "Melbourne", "Perth"], answer: 1, explanation: "Canberra a été choisie comme compromis entre Sydney et Melbourne ; Sydney est la plus grande ville, pas la capitale." }] } }),
      opts: { schema: QUIZ_SCHEMA, schemaName: "qcm", json: true },
    }),
    bench: [{ vars: { text: COURSE, count: 3 }, expect: { json: true, keys: ["questions"], jsonCheck: { "4 choix par question": (j) => (j.questions || []).length >= 2 && j.questions.every((q) => Array.isArray(q.choices) && q.choices.length === 4), "indice valide": (j) => (j.questions || []).every((q) => Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3) } } }],
  },
  "app.studies.correct": {
    kind: "json",
    label: "Études — correction expliquée",
    role: "Tu es un professeur bienveillant et exigeant qui corrige le travail d'un étudiant. Pour chaque erreur ou faiblesse : « excerpt » cite le passage exact, « problem » nomme le problème, « explanation » explique la règle ou le raisonnement attendu (le plus important), « fix » {fix}. « summary » : appréciation en 2 à 3 phrases, en commençant par ce qui est réussi. « grade » : une note indicative (ex. « 13/20 ») ou « non noté ». « advice » : 2 à 4 conseils concrets. Ne corrige que ce qui est réellement faux ou améliorable.",
    build: ({ subject = "", statement = "", work, hintsOnly = false, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.studies.correct", kind: "json", lang,
        role: PROMPTS["app.studies.correct"].role.replace("{fix}", hintsOnly ? "donne seulement un INDICE qui met sur la voie, jamais la réponse" : "propose la version corrigée"),
        data: { MATIÈRE: subject, ÉNONCÉ: statement, "TRAVAIL DE L'ÉTUDIANT": String(work).slice(0, 24000) },
        example: { summary: "Bonne démarche, mais une erreur de signe fausse le résultat.", grade: "12/20", points: [{ excerpt: "2x - 3 = 7 donc x = 2", problem: "Erreur de calcul", explanation: "Il faut ajouter 3 des deux côtés : 2x = 10, puis diviser par 2.", fix: "x = 5" }], advice: ["Vérifie chaque étape en remplaçant x dans l'équation."] } }),
      opts: { schema: CORRECTION_SCHEMA, schemaName: "correction", json: true },
    }),
    bench: [{ vars: { subject: "mathématiques", statement: "Calcule 3 × (4 + 2).", work: "3 × 4 + 2 = 14" },
      expect: { json: true, keys: ["summary", "points"], jsonCheck: { "repère l'erreur": (j) => (j.points || []).length >= 1, "bonne réponse 18": (j) => /18/.test(JSON.stringify(j)) } } }],
  },
  "app.studies.explain": {
    kind: "explain",
    label: "Études — « Je ne comprends pas »",
    role: "Tu es un tuteur patient : tu expliques pourquoi la réponse d'une fiche est celle-ci, avec une image mentale ou un exemple concret.",
    build: ({ question, answer, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.studies.explain", kind: "explain", lang, role: PROMPTS["app.studies.explain"].role,
        data: { FICHE: `Question : ${question}\nRéponse : ${answer}` }, format: "Markdown, 6 lignes au plus." }),
    }),
    bench: [{ vars: { question: "Où se déroule la photosynthèse ?", answer: "Dans les chloroplastes." }, expect: { re: ["chloroplaste"], lang: "fr", maxChars: 900 } }],
  },
  "app.studies.podcast": {
    kind: "creative",
    label: "Études — podcast de révision",
    role: "Tu écris le script d'un podcast de révision à deux voix, naturel et oral : pas de listes, pas de Markdown, pas de LaTeX (dis les formules en toutes lettres). Tu couvres les notions, définitions, dates et mécanismes importants DU COURS FOURNI, sans rien inventer, et tu termines par un récapitulatif des 3 à 5 points à retenir.",
    build: ({ text, style = "lesson", turns = 14, names = ["Claire", "Hugo"], lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.studies.podcast", kind: "creative", lang, role: PROMPTS["app.studies.podcast"].role,
        data: { COURS: String(text).slice(0, 14000) },
        request: `Format : ${PODCAST_STYLES[style] || PODCAST_STYLES.lesson}. Hôte 0 = ${names[0]}, hôte 1 = ${names[1]}. Environ ${turns} répliques.`,
        format: "autant de répliques que demandé, en alternant speaker 0 et 1.", example: { title: "La Révolution française en 5 minutes", turns: [{ speaker: 0, text: "On commence par 1789 ?" }, { speaker: 1, text: "Oui, avec la prise de la Bastille le 14 juillet." }] } }),
      opts: { schema: PODCAST_SCHEMA, schemaName: "podcast", json: true },
    }),
    bench: [{ vars: { text: COURSE, turns: 8 }, expect: { json: true, keys: ["turns"], jsonCheck: { "≥ 5 répliques": (j) => (j.turns || []).length >= 5, "parle du cours": (j) => /chloroplaste|Calvin|oxygène|glucose|chlorophylle/i.test(JSON.stringify(j.turns)) } } }],
  },
};
