import { inLang } from "../lib/prompt-lang.js";
// Listes embarquées du Catalogue de Lumen.
//
// Deux familles de contenus n'ont pas de catalogue ailleurs dans l'app :
//   - les **workflows Fluxo** : ils sont écrits ici en entier (mêmes objets que
//     ceux qu'enregistre le designer, cf. `save_workflow`), donc installables
//     hors ligne, sans dépendre d'un serveur ;
//   - les **avatars GLB** : eux ne peuvent pas être embarqués (25 Mo pièce), le
//     Catalogue les prend par URL — soit saisie à la main, soit listée par un
//     manifeste distant (cf. MANIFEST_DOC).
//
// Les modèles GGUF et les voix, eux, ont déjà leur catalogue de référence
// (`llama-models.js` et `tts_catalog`) : le Catalogue les affiche, il ne les
// duplique pas.

/** Valeur de paramètre au format attendu par le moteur Fluxo. */
const txt = (value) => ({ type: "text", value });
const num = (value) => ({ type: "number", value });
const bool = (value) => ({ type: "bool", value });

// Consigne système commune : les workflows du Catalogue doivent rester utilisables
// avec un petit modèle local, d'où des instructions courtes et fermées.
// Figé dans le workflow à l'installation : la langue est celle de l'interface à ce moment-là.
const CONCISE = `Tu es un assistant précis et concis. Réponds ${inLang()}, sans préambule ni formule de politesse.`;

export const WORKFLOW_PACKS = [
  {
    id: "clipboard-summary",
    category: "Productivité",
    title: "Résumer le presse-papier",
    description: "Lit le presse-papier, en fait un résumé en trois points et l'affiche en notification.",
    descriptionEn: "Reads the clipboard, summarizes it in three bullets and shows it as a notification.",
    needs: ["Un modèle local ou une clé API"],
    workflow: {
      name: "Résumer le presse-papier",
      description: "Résume le texte présent dans le presse-papier.",
      available_as_tool: true,
      trigger: { type: "manual" },
      steps: [
        { id: "get_clipboard1", action: "get_clipboard", params: {}, name: null },
        {
          id: "llm_infer1",
          action: "llm_infer",
          params: {
            prompt: txt("Résume ce texte en trois points maximum :\n\n{{get_clipboard1}}"),
            system: txt(CONCISE),
            backend: txt("auto"),
            model: txt(""),
            think: bool(false),
            context_size: num(0),
          },
          name: null,
        },
        {
          id: "lumen_notification1",
          action: "lumen_notification",
          params: {
            kind: txt("info"),
            title: txt("Résumé du presse-papier"),
            body: txt("{{llm_infer1}}"),
            icon: txt("clipboard"),
            color: txt(""),
            actions: txt(""),
            timeout: num(0),
          },
          name: null,
        },
        { id: "copy_clipboard1", action: "copy_clipboard", params: { text: txt("{{llm_infer1}}") }, name: null },
      ],
    },
  },
  {
    id: "news-digest",
    category: "Veille",
    title: "Revue de presse du matin",
    description: "Chaque jour à 8 h, récupère les actualités du sujet suivi et en publie une synthèse dans le centre de notifications.",
    descriptionEn: "Every day at 8am, fetches news on the tracked topic and posts a digest to the notification center.",
    needs: ["Connexion internet", "Un modèle local ou une clé API"],
    setup: "Ouvrez le bloc « Requête HTTP » pour remplacer le sujet suivi (intelligence artificielle) par le vôtre.",
    workflow: {
      name: "Revue de presse du matin",
      description: "Synthèse quotidienne des actualités d'un sujet suivi.",
      available_as_tool: false,
      trigger: { type: "cron", expr: "0 0 8 * * *" },
      steps: [
        {
          id: "http_get1",
          action: "http_get",
          params: {
            url: txt("https://news.google.com/rss/search?q=intelligence+artificielle&hl=fr&gl=FR&ceid=FR:fr"),
            headers: txt(""),
          },
          name: null,
        },
        {
          id: "llm_infer1",
          action: "llm_infer",
          params: {
            prompt: txt("Voici un flux RSS. Donne les cinq titres les plus importants, un par ligne, sans commentaire :\n\n{{http_get1}}"),
            system: txt(CONCISE),
            backend: txt("auto"),
            model: txt(""),
            think: bool(false),
            context_size: num(0),
          },
          name: null,
        },
        {
          id: "notify_center1",
          action: "notify_center",
          params: { title: txt("Revue de presse"), body: txt("{{llm_infer1}}") },
          name: null,
        },
      ],
    },
  },
  {
    id: "rag-question",
    category: "Connaissances",
    title: "Question à mes documents",
    description: "Cherche dans le corpus indexé (RAG) puis répond à la question posée en entrée, sources à l'appui.",
    descriptionEn: "Searches the indexed corpus (RAG), then answers the question given as input, with its sources.",
    needs: ["Des documents indexés dans Corpus"],
    workflow: {
      name: "Question à mes documents",
      description: "Répond à une question à partir des documents indexés dans Lumen.",
      available_as_tool: true,
      trigger: { type: "manual" },
      steps: [
        {
          id: "lumen_rag_search1",
          action: "lumen_rag_search",
          params: { query: txt("{{input}}"), k: txt("5") },
          name: null,
        },
        {
          id: "llm_infer1",
          action: "llm_infer",
          params: {
            prompt: txt("Question : {{input}}\n\nExtraits de mes documents :\n{{lumen_rag_search1}}\n\nRéponds uniquement à partir de ces extraits. Si l'information n'y est pas, dis-le."),
            system: txt(CONCISE),
            backend: txt("auto"),
            model: txt(""),
            think: bool(false),
            context_size: num(0),
          },
          name: null,
        },
        {
          id: "lumen_notification1",
          action: "lumen_notification",
          params: {
            kind: txt("info"),
            title: txt("Réponse de vos documents"),
            body: txt("{{llm_infer1}}"),
            icon: txt("search"),
            color: txt(""),
            actions: txt(""),
            timeout: num(0),
          },
          name: null,
        },
      ],
    },
  },
  {
    id: "text-to-card",
    category: "Productivité",
    title: "Transformer un texte en tâche",
    description: "Extrait l'action à faire d'un texte libre et crée la carte correspondante dans le tableau Tempo.",
    descriptionEn: "Extracts the action to take from free text and creates the matching card in the Tempo board.",
    needs: ["Un modèle local ou une clé API"],
    workflow: {
      name: "Texte en tâche",
      description: "Crée une carte Kanban à partir d'un texte libre.",
      available_as_tool: true,
      trigger: { type: "manual" },
      steps: [
        {
          id: "llm_infer1",
          action: "llm_infer",
          params: {
            prompt: txt("Extrais de ce texte l'action à faire, en une phrase à l'impératif, sans ponctuation finale :\n\n{{input}}"),
            system: txt(CONCISE),
            backend: txt("auto"),
            model: txt(""),
            think: bool(false),
            context_size: num(0),
          },
          name: null,
        },
        {
          id: "kanban_add_card1",
          action: "kanban_add_card",
          params: { title: txt("{{llm_infer1}}"), description: txt("{{input}}"), column: txt("À faire") },
          name: null,
        },
      ],
    },
  },
  {
    id: "remember-decision",
    category: "Mémoire",
    title: "Mémoriser une décision",
    description: "Reformule une décision en une phrase durable et l'inscrit dans la mémoire cognitive de Lumen.",
    descriptionEn: "Rewrites a decision as one lasting sentence and stores it in Lumen's cognitive memory.",
    needs: ["Un modèle local ou une clé API"],
    workflow: {
      name: "Mémoriser une décision",
      description: "Enregistre une décision reformulée dans la mémoire de Lumen.",
      available_as_tool: true,
      trigger: { type: "manual" },
      steps: [
        {
          id: "llm_infer1",
          action: "llm_infer",
          params: {
            prompt: txt("Reformule cette décision en une seule phrase, au présent, compréhensible dans six mois :\n\n{{input}}"),
            system: txt(CONCISE),
            backend: txt("auto"),
            model: txt(""),
            think: bool(false),
            context_size: num(0),
          },
          name: null,
        },
        {
          id: "lumen_memory_remember1",
          action: "lumen_memory_remember",
          params: {
            text: txt("{{llm_infer1}}"),
            kind: txt("semantic"),
            context: txt("agent"),
            tags: txt("décision"),
          },
          name: null,
        },
        {
          id: "notify_center1",
          action: "notify_center",
          params: { title: txt("Décision mémorisée"), body: txt("{{llm_infer1}}") },
          name: null,
        },
      ],
    },
  },
  {
    id: "read-aloud",
    category: "Voix",
    title: "Me lire un texte, simplement",
    description: "Simplifie un texte en français courant puis le lit à voix haute avec la voix active.",
    descriptionEn: "Simplifies a text into plain French, then reads it aloud with the active voice.",
    needs: ["Une voix installée (onglet Voix)"],
    workflow: {
      name: "Me lire un texte",
      description: "Simplifie un texte puis le lit à voix haute.",
      available_as_tool: true,
      trigger: { type: "manual" },
      steps: [
        {
          id: "llm_infer1",
          action: "llm_infer",
          params: {
            prompt: txt("Réécris ce texte en français courant, en phrases courtes, pour être lu à voix haute :\n\n{{input}}"),
            system: txt(CONCISE),
            backend: txt("auto"),
            model: txt(""),
            think: bool(false),
            context_size: num(0),
          },
          name: null,
        },
        { id: "speak1", action: "speak", params: { text: txt("{{llm_infer1}}"), voice: txt("") }, name: null },
      ],
    },
  },
];

/// Mises en avant du carrousel, par rayon. Chaque entrée pointe vers un élément
/// réel du catalogue (`target`) : si l'élément n'existe pas — modèle retiré,
/// voix absente du backend — la lame est simplement ignorée, jamais affichée à
/// vide. Un manifeste distant peut en ajouter (clé `featured`).
///
/// VISUEL : `art` est le nom de fichier attendu dans `src/market/art/`. Il est
/// préfixé `hero-` par convention : une bannière de carrousel (large) et une
/// vignette de fiche (carrée) ne sont pas la même image, et sans ce préfixe un
/// pack et sa mise en avant réclameraient le même fichier. S'il
/// n'existe pas encore, la lame s'affiche en surface neutre avec l'accent de
/// l'app — pas de couleur arbitraire, et on peut déposer les images plus tard
/// sans toucher au code.
export const FEATURED = [
  {
    id: "feat-lfm-350",
    section: "models",
    target: "lfm2.5-350m-q4km",
    eyebrow: "À la une",
    title: "LFM2.5 350M",
    subtitle: "Le modèle qui tient partout : idéal pour vérifier votre installation, router des outils, ou faire tourner Lumen sur une petite machine.",
  },
  {
    id: "feat-bonsai",
    section: "models",
    target: "bonsai-27b-binary-q1-0",
    eyebrow: "Multimodal",
    title: "Bonsai 27B Binary",
    subtitle: "27 milliards de paramètres compressés en poids binaires, projecteur vision inclus : il lit vos images sans quitter votre machine.",
  },
  {
    id: "feat-voices",
    section: "voices",
    eyebrow: "Donnez une voix à Lumen",
    title: "Voix locales Piper & Kokoro",
    subtitle: "Des voix synthétiques qui tournent hors ligne, en quelques dizaines de mégaoctets. Téléchargez, écoutez, adoptez.",
  },
  {
    id: "feat-clipboard",
    section: "workflows",
    target: "clipboard-summary",
    eyebrow: "Workflow prêt à l'emploi",
    title: "Résumer le presse-papier",
    subtitle: "Copiez un texte, lancez le workflow : Lumen le résume en trois points et vous le remet dans le presse-papier.",
  },
  {
    id: "feat-news",
    section: "workflows",
    target: "news-digest",
    eyebrow: "Automatisation",
    title: "Revue de presse du matin",
    subtitle: "Chaque jour à 8 h, votre sujet suivi arrive résumé dans le centre de notifications.",
  },
  {
    id: "feat-avatar",
    section: "avatars",
    eyebrow: "Incarnez Lumen",
    title: "Un avatar 3D à votre image",
    subtitle: "Installez un GLB animé et Lumen quitte son orbe. Quatre animations suffisent.",
  },
];

/// Manifeste officiel, publié dans le dépôt de distribution de Lumen
/// (`Oneil974/lumen-app`, dossier `market/` — cf. son README). Il est
/// chargé au démarrage du Catalogue ; un manifeste personnel s'y AJOUTE (il ne le
/// remplace pas). Hors ligne, ou si le dépôt est injoignable, le Catalogue retombe
/// simplement sur son catalogue embarqué.
export const OFFICIAL_MANIFEST_URL =
  "https://raw.githubusercontent.com/Oneil974/lumen-app/main/market/manifest.json";

/// Format attendu d'un manifeste distant, affiché dans l'onglet « Source ».
export const MANIFEST_DOC = `{
  "workflows": [
    { "id": "mon-workflow", "title": "Mon workflow", "description": "…",
      "workflow": { "name": "…", "steps": [ … ] } }
  ],
  "avatars": [
    { "id": "mon-avatar", "title": "Mon avatar", "description": "…",
      "url": "https://exemple.com/avatar.glb", "sizeLabel": "≈ 8 Mo" }
  ]
}`;

/// Normalise un manifeste : on ne garde que ce qu'on sait installer, et chaque
/// entrée porte l'origine dont elle vient (« officielle » ou « personnelle »)
/// pour que l'interface le dise et que les deux sources puissent coexister.
export function parseManifest(raw, origin = "custom", sourceLabel = "Source distante") {
  const prefix = origin === "official" ? "official" : "custom";
  const source = raw && typeof raw === "object" ? raw : {};
  const workflows = (Array.isArray(source.workflows) ? source.workflows : [])
    .filter((entry) => entry && typeof entry === "object" && entry.workflow?.name)
    .map((entry, index) => ({
      id: `${prefix}:${entry.id || `workflow-${index}`}`,
      category: String(entry.category || sourceLabel),
      title: String(entry.title || entry.workflow.name),
      description: String(entry.description || ""),
      needs: Array.isArray(entry.needs) ? entry.needs.map(String) : [],
      setup: entry.setup ? String(entry.setup) : "",
      remote: true,
      origin,
      sourceLabel,
      workflow: entry.workflow,
    }));
  const avatars = (Array.isArray(source.avatars) ? source.avatars : [])
    .filter((entry) => entry && typeof entry === "object" && typeof entry.url === "string")
    .map((entry, index) => ({
      id: `${prefix}:${entry.id || `avatar-${index}`}`,
      title: String(entry.title || entry.url.split("/").pop() || "Avatar"),
      description: String(entry.description || ""),
      sizeLabel: String(entry.sizeLabel || ""),
      author: String(entry.author || ""),
      remote: true,
      origin,
      sourceLabel,
      url: entry.url,
    }));
  const featured = (Array.isArray(source.featured) ? source.featured : [])
    .filter((entry) => entry && typeof entry === "object" && entry.title)
    .map((entry, index) => ({
      id: `${prefix}:featured-${entry.id || index}`,
      section: ["models", "voices", "workflows", "avatars"].includes(entry.section) ? entry.section : "workflows",
      target: entry.target ? String(entry.target) : "",
      eyebrow: String(entry.eyebrow || sourceLabel),
      title: String(entry.title),
      subtitle: String(entry.subtitle || ""),
      origin,
    }));
  return { workflows, avatars, featured };
}
