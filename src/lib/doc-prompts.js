// Prompts des outils @doc et du harnais de rédaction (lib/doc-harness.js) :
// cadrage → plan → rédaction section par section (ou diapositive par lot) →
// révision factuelle. Lus aussi par le banc `npm run bench`.
import { buildPrompt } from "./prompt-kit.js";

export const PROMPTS = {
  "tool.doc.write": {
    kind: "write",
    label: "Chat @doc — rédiger un document",
    role: "Tu es un rédacteur professionnel. Tu t'appuies UNIQUEMENT sur la demande et les sources fournies pour les faits (noms, dates, chiffres, expériences, prix) ; une information absente s'écrit [à compléter].",
    build: ({ kindName, plan, tone = "", today, brief, sources = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.doc.write", kind: "write", lang, role: PROMPTS["tool.doc.write"].role,
        data: { "TYPE DE DOCUMENT": kindName, "PLAN ATTENDU": plan, TON: tone || "professionnel, clair, naturel ; pas de formules creuses", "DATE DU JOUR": today,
          "SOURCES (fichiers, Corpus et bases de l'utilisateur)": sources || "aucune" },
        request: brief, format: "le document seul, en Markdown (titres, listes, tableaux), sans préambule ni bloc ``` autour." }),
    }),
    bench: [{ vars: { kindName: "lettre de motivation", plan: "accroche, parcours, motivation, conclusion", today: "2 octobre 2026",
      brief: "Lettre de motivation pour un poste de développeur Rust chez Acme.",
      sources: "CV_2026.pdf : 5 ans d'expérience en Rust et Swift ; projet Lumen (assistant IA local) ; Master informatique Université de Lyon." },
      expect: { re: ["Acme", "Rust", "Lumen|Lyon|5 ans"], not: ["^```", "^voici"], lang: "fr" } }],
  },
  // ---- Harnais de rédaction (lib/doc-harness.js) --------------------------
  "tool.doc.brief": {
    kind: "json",
    label: "Harnais @doc — cadrage de la demande",
    role: "Tu cadres une demande de document : tu en tires le titre, le public, l'objectif, le ton, la longueur et les faits DONNÉS par l'utilisateur. Tu n'inventes aucun fait.",
    build: ({ kindName, brief, lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.doc.brief", kind: "json", lang, role: PROMPTS["tool.doc.brief"].role,
        data: { "TYPE DE DOCUMENT": kindName }, request: brief,
        example: { title: "Titre court", audience: "à qui s'adresse le document", objective: "ce que le document doit obtenir", tone: "professionnel", length: "moyen", facts: ["fait donné par l'utilisateur"], keywords: ["mot-clé"] } }),
    }),
  },
  "tool.doc.outline": {
    kind: "json",
    label: "Harnais @doc — plan du document",
    role: "Tu construis le plan d'un document à partir de la demande, d'un plan type et des sources numérotées [S1], [S2]… Chaque section cite les sources qui la nourrissent.",
    build: ({ kindName, plan, frame, sources = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.doc.outline", kind: "json", lang, role: PROMPTS["tool.doc.outline"].role,
        data: { "TYPE DE DOCUMENT": kindName, "PLAN TYPE": plan, CADRAGE: frame, "SOURCES DISPONIBLES": sources || "aucune" },
        request: "Propose 4 à 8 sections dans l'ordre de lecture. « points » = ce que la section doit dire (sans inventer de chiffres). « sources » = identifiants [S…] utiles, ou liste vide.",
        example: { sections: [{ title: "Titre de section", goal: "rôle de la section", points: ["idée 1", "idée 2"], sources: ["S1"], table: false }] } }),
    }),
  },
  "tool.doc.section": {
    kind: "write",
    label: "Harnais @doc — rédaction d'une section",
    role: "Tu rédiges UNE section d'un document professionnel. Les faits (noms, dates, chiffres, prix, expériences) viennent UNIQUEMENT de la demande et des sources fournies ; une information absente s'écrit [à compléter].",
    build: ({ section, frame, sources = "", previous = "", tone = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.doc.section", kind: "write", lang, role: PROMPTS["tool.doc.section"].role,
        data: { CADRAGE: frame, "SECTION À RÉDIGER": section, "SECTIONS DÉJÀ RÉDIGÉES (titres)": previous || "aucune", TON: tone || "professionnel, clair, naturel", SOURCES: sources || "aucune" },
        request: "Rédige cette section seulement, sans répéter les autres.",
        format: "Markdown : commence par « ## <titre de la section> », puis paragraphes courts, listes ou tableau Markdown si utile. Pas de préambule, pas de bloc ```." }),
    }),
    bench: [{ vars: { section: "Expérience — 5 ans en Rust", frame: "Lettre de motivation, développeur Rust chez Acme", sources: "[S1] CV : 5 ans de Rust, projet Lumen." }, expect: { re: ["^##", "Rust"], not: ["^```"], lang: "fr" } }],
  },
  "tool.doc.deck": {
    kind: "json",
    label: "Harnais @doc — plan de diaporama",
    role: "Tu conçois le déroulé d'une présentation : une idée par diapositive, une progression claire (accroche, problème, solution, preuves, appel à l'action). Tu n'inventes aucun chiffre : les chiffres viennent des sources.",
    build: ({ kindName, plan, frame, sources = "", count = 10, lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.doc.deck", kind: "json", lang, role: PROMPTS["tool.doc.deck"].role,
        data: { "TYPE": kindName, "DÉROULÉ TYPE": plan, CADRAGE: frame, "SOURCES DISPONIBLES": sources || "aucune" },
        request: `Propose ${count} diapositives environ. layout ∈ title, section, bullets, two_columns, table, quote, kpis, closing. La 1re est « title », la dernière « closing ». « kpis » seulement avec des chiffres présents dans les sources.`,
        example: { subtitle: "sous-titre de la présentation", slides: [{ layout: "title", title: "Titre", goal: "ce que la diapositive doit faire passer", sources: ["S1"] }] } }),
    }),
  },
  "tool.doc.slides": {
    kind: "json",
    label: "Harnais @doc — contenu des diapositives",
    role: "Tu rédiges le contenu de diapositives : puces courtes (12 mots maximum, 5 puces maximum), notes de l'orateur de 2 à 4 phrases. Les faits viennent UNIQUEMENT de la demande et des sources ; sinon [à compléter].",
    build: ({ frame, slides, sources = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.doc.slides", kind: "json", lang, role: PROMPTS["tool.doc.slides"].role,
        data: { CADRAGE: frame, "DIAPOSITIVES À RÉDIGER": slides, SOURCES: sources || "aucune" },
        request: "Pour CHAQUE diapositive listée, dans le même ordre, remplis les champs utiles à son layout : bullets (bullets/kpis/closing), left/right {title, bullets} (two_columns), table (tableau de lignes, la 1re = en-têtes) (table), quote + author (quote), kpis [{value, label}] (kpis), subtitle (title/section/closing), notes (toujours).",
        example: { slides: [{ title: "Titre", subtitle: "", bullets: ["puce courte"], notes: "Ce que l'orateur dit." }] } }),
    }),
  },
  "tool.doc.revise": {
    kind: "write",
    label: "Harnais @doc — révision factuelle",
    role: "Tu relis un passage et tu corriges les faits non étayés : chaque chiffre, nom ou date absent de la demande et des sources est remplacé par [à compléter]. Tu ne changes rien d'autre.",
    build: ({ text, unsupported, sources = "", brief = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.doc.revise", kind: "write", lang, role: PROMPTS["tool.doc.revise"].role,
        data: { "PASSAGE": text, "ÉLÉMENTS NON ÉTAYÉS": unsupported, "DEMANDE": brief, SOURCES: sources || "aucune" },
        request: "Rends le passage corrigé.",
        format: "le passage complet corrigé, même structure Markdown, sans commentaire." }),
    }),
  },
};
