// Publication des outils (function calling) — quels outils la barre expose au
// modèle en mode « Outils ».
//
// Principe : le catalogue d'outils est construit dans main.js (buildFluxoTools),
// puis FILTRÉ par ce module. Un outil décoché n'est pas simplement ignoré à
// l'exécution : il ne part pas du tout dans la requête, donc il ne coûte ni
// contexte ni risque de déclenchement intempestif.
//
// Le choix est stocké en liste NOIRE (`toolPublishOff`) : tout nouvel outil —
// workflow Fluxo fraîchement exposé, outil d'un connecteur MCP — est publié par
// défaut, sans réglage à refaire.

import { filterHybridTools } from "./hybrid.js";

const STORAGE_KEY = "toolPublishOff";

export function loadDisabledTools() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveDisabledTools(set) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
}

export function isToolPublished(name) {
  return !loadDisabledTools().has(String(name));
}

export function setToolPublished(name, published) {
  const set = loadDisabledTools();
  if (published) set.delete(String(name));
  else set.add(String(name));
  saveDisabledTools(set);
}

export function setToolsPublished(names, published) {
  const set = loadDisabledTools();
  for (const name of names) {
    if (published) set.delete(String(name));
    else set.add(String(name));
  }
  saveDisabledTools(set);
}

/** Filtre une liste de specs OpenAI/Ollama (`{ type, function: { name } }`). */
export function filterPublishedTools(tools) {
  // Piliers coupés de l'intelligence hybride (fichiers, actions) d'abord.
  tools = filterHybridTools(tools);
  const off = loadDisabledTools();
  if (!off.size) return tools;
  return (tools || []).filter((tool) => !off.has(String(tool?.function?.name || "")));
}

// Nom de fonction dérivé d'un nom de workflow Fluxo. Partagé avec main.js pour
// que l'écran de réglages coche exactement les mêmes identifiants que ceux
// envoyés au modèle.
export function sanitizeToolName(name) {
  const s = String(name).toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "workflow";
}

/// Nom de fonction de l'outil de délégation de chaque agent (« @agent_… »).
/// Partagé par lib/agent-delegation.js (catalogue du modèle) et la Boîte à
/// outils des Réglages : les deux doivent dériver EXACTEMENT les mêmes noms,
/// doublons compris, pour qu'une case décochée retire bien l'outil.
/// @param {{id:string,name:string}[]} agents
/// @returns {{fn:string, agent:object}[]}
export function agentToolNames(agents) {
  const seen = new Set();
  const out = [];
  for (const a of agents || []) {
    if (!a?.id || !a?.name) continue;
    let fn = `agent_${sanitizeToolName(a.name)}`.slice(0, 60);
    if (seen.has(fn)) fn = `${fn}_${out.length}`;
    seen.add(fn);
    out.push({ fn, agent: a });
  }
  return out;
}

// Outils intégrés de la barre, décrits ici pour l'écran de réglages. Les
// définitions réelles (schémas JSON) restent dans main.js ; on ne duplique que
// le nom, le groupe et un libellé lisible.
// Chaque outil porte son libellé et sa description dans les deux langues : ce
// sont ces textes courts (et non la description longue envoyée au modèle, qui
// reste en français) que voient l'utilisateur dans le menu « @ » des barres de
// chat et dans Réglages › Boîte à outils. `toolHint()` choisit la langue.
export const BUILTIN_TOOL_CATALOG = [
  { name: "memory_recall", group: "memory", label: "Retrouver un souvenir", labelEn: "Recall a memory", desc: "Cherche dans la mémoire cognitive ce qui a déjà été dit ou noté.", descEn: "Searches the cognitive memory for what was already said or noted." },
  { name: "memory_remember", group: "memory", label: "Mémoriser", labelEn: "Remember", desc: "Enregistre un souvenir ; l'utilisateur peut l'annuler depuis la note affichée.", descEn: "Stores a memory; the user can undo it from the note shown." },
  { name: "create_reminder", group: "memory", label: "Créer un rappel", labelEn: "Create a reminder", desc: "Programme un rappel daté, éventuellement récurrent.", descEn: "Schedules a dated reminder, optionally recurring." },
  { name: "search_lumen_docs", group: "knowledge", label: "Documentation Lumen", labelEn: "Lumen documentation", desc: "Cherche une réponse dans la documentation intégrée.", descEn: "Looks for an answer in the built-in documentation." },
  { name: "search_documents", group: "knowledge", label: "Base de connaissances", labelEn: "Knowledge base", desc: "Recherche dans les documents indexés (RAG).", descEn: "Searches the indexed documents (RAG)." },
  { name: "query_tables", group: "knowledge", label: "Bases de données", labelEn: "Databases", desc: "Interroge les tables en langage naturel (lecture seule).", descEn: "Queries the tables in natural language (read-only)." },
  { name: "domotique_list_devices", group: "home", label: "Lister les objets", labelEn: "List devices", desc: "Inventaire des objets domotiques enregistrés.", descEn: "Inventory of the registered smart-home devices." },
  { name: "domotique_get_state", group: "home", label: "Lire un état", labelEn: "Read a state", desc: "État réel d'un objet domotique.", descEn: "Actual state of a smart-home device." },
  { name: "domotique_command", group: "home", label: "Commander un objet", labelEn: "Control a device", desc: "Allume, éteint, règle un objet domotique.", descEn: "Turns on, turns off or adjusts a smart-home device.", effect: "write" },
  { name: "export_pdf", group: "documents", label: "Générer un PDF", labelEn: "Generate a PDF", desc: "Rédige un document et l'enregistre en PDF dans vos Téléchargements.", descEn: "Writes a document and saves it as a PDF in your Downloads.", effect: "write" },
  // Rédaction de documents (lib/doc-generator.js) : l'outil va chercher la
  // matière dans les sandboxes, le Corpus et (si utile) les bases de données.
  { name: "doc_lettre_motivation", group: "documents", label: "Lettre de motivation", labelEn: "Cover letter", desc: "Rédige une lettre de motivation à partir de ton CV et de tes fichiers.", descEn: "Writes a cover letter from your résumé and files.", effect: "write" },
  { name: "doc_cv", group: "documents", label: "CV", labelEn: "Résumé / CV", desc: "Met en forme un CV à partir de tes fichiers.", descEn: "Builds a résumé from your files.", effect: "write" },
  { name: "doc_presentation_produit", group: "documents", label: "Présentation de produit", labelEn: "Product presentation", desc: "Diaporama de produit (.lumenkey + .pptx) nourri par tes fiches et tes bases de données.", descEn: "Product slide deck (.lumenkey + .pptx) fed by your sheets and databases.", effect: "write" },
  { name: "doc_presentation", group: "documents", label: "Présentation (diaporama)", labelEn: "Slide deck", desc: "Diaporama complet (.lumenkey + .pptx) : plan, diapositives, notes de l'orateur, chiffres vérifiés.", descEn: "Full slide deck (.lumenkey + .pptx): outline, slides, speaker notes, checked figures.", effect: "write" },
  { name: "doc_proposition_commerciale", group: "documents", label: "Proposition commerciale", labelEn: "Business proposal", desc: "Proposition commerciale avec tarifs tirés de tes données.", descEn: "Business proposal with prices taken from your data.", effect: "write" },
  { name: "doc_rapport", group: "documents", label: "Rapport / synthèse", labelEn: "Report / summary", desc: "Rapport chiffré à partir de tes bases et de tes documents.", descEn: "Figures-based report from your databases and documents.", effect: "write" },
  { name: "doc_email", group: "documents", label: "E-mail professionnel", labelEn: "Professional e-mail", desc: "Rédige un e-mail soigné, contexte tiré de tes fichiers.", descEn: "Writes a polished e-mail, context taken from your files.", effect: "write" },
  { name: "doc_compte_rendu", group: "documents", label: "Compte rendu de réunion", labelEn: "Meeting minutes", desc: "Met au propre des notes de réunion : décisions et actions.", descEn: "Turns meeting notes into decisions and actions.", effect: "write" },
  { name: "doc_rediger", group: "documents", label: "Rédiger un document", labelEn: "Write a document", desc: "Document libre, enrichi par tes fichiers et le Corpus.", descEn: "Free-form document, enriched by your files and the Corpus.", effect: "write" },
  // Courrier (lib/mail-tools.js) : lecture et brouillons, jamais d'envoi.
  { name: "mail_boite", group: "mail", label: "Boîte de réception", labelEn: "Inbox", desc: "Liste les derniers e-mails, ou les non lus.", descEn: "Lists the latest e-mails, or the unread ones." },
  { name: "mail_rechercher", group: "mail", label: "Rechercher un e-mail", labelEn: "Search e-mails", desc: "Retrouve des messages par mot, expéditeur ou sujet.", descEn: "Finds messages by word, sender or subject." },
  { name: "mail_lire", group: "mail", label: "Lire un e-mail", labelEn: "Read an e-mail", desc: "Lit un message en entier.", descEn: "Reads a whole message." },
  { name: "mail_resumer", group: "mail", label: "Résumer le courrier", labelEn: "Summarize mail", desc: "Résume un message ou les derniers reçus (priorités, actions).", descEn: "Summarizes a message or the latest ones (priorities, actions)." },
  { name: "mail_trouver_info", group: "mail", label: "Trouver une info dans les e-mails", labelEn: "Find info in e-mails", desc: "Répond à une question (n° de commande, date, adresse…) en citant le message.", descEn: "Answers a question (order number, date, address…) citing the message." },
  { name: "mail_brouillon", group: "mail", label: "Brouillon d'e-mail", labelEn: "E-mail draft", desc: "Rédige une réponse ou un nouveau message, rangé dans les brouillons.", descEn: "Writes a reply or a new message, saved to drafts.", effect: "write" },
  // Données en direct (lib/live-tools.js) et web (lib/web-tools.js) : absents
  // du catalogue des Réglages (ils y ont leurs propres réglages), mais
  // affichés dans le menu « @ ».
  { name: "weather_now", group: "live", label: "Météo", labelEn: "Weather", desc: "Météo actuelle et prévisions pour un lieu (Open-Meteo).", descEn: "Current weather and forecast for a place (Open-Meteo)." },
  { name: "sport_score", group: "live", label: "Score sportif", labelEn: "Sports score", desc: "Score en direct ou résultat d'un match.", descEn: "Live score or result of a match." },
  { name: "market_quote", group: "live", label: "Cours de bourse", labelEn: "Market quote", desc: "Cours d'une action, d'un indice ou d'une cryptomonnaie.", descEn: "Price of a stock, an index or a cryptocurrency." },
  { name: "exchange_rate", group: "live", label: "Taux de change", labelEn: "Exchange rate", desc: "Conversion entre deux devises au taux du jour.", descEn: "Conversion between two currencies at today's rate." },
  { name: "air_quality", group: "live", label: "Qualité de l'air", labelEn: "Air quality", desc: "Indice de qualité de l'air et polluants pour un lieu.", descEn: "Air-quality index and pollutants for a place." },
  { name: "news_headlines", group: "live", label: "Actualités", labelEn: "News headlines", desc: "Titres récents sur un sujet.", descEn: "Recent headlines on a topic." },
  { name: "generate_image", group: "live", label: "Générer une image", labelEn: "Generate an image", desc: "Crée une image avec le moteur d'image des Réglages.", descEn: "Creates an image with the image engine from Settings.", effect: "write" },
  { name: "calculate", group: "live", label: "Calculatrice scientifique", labelEn: "Scientific calculator", desc: "Calcul exact (trigonométrie, puissances, logarithmes, factorielles, combinaisons…).", descEn: "Exact computation (trigonometry, powers, logarithms, factorials, combinations…)." },
  { name: "statistics", group: "live", label: "Statistiques", labelEn: "Statistics", desc: "Moyenne, médiane, quartiles, écart-type d'une série de nombres.", descEn: "Mean, median, quartiles, standard deviation of a series of numbers." },
  { name: "convert_units", group: "live", label: "Conversion d'unités", labelEn: "Unit conversion", desc: "Longueurs, masses, volumes, températures, énergie, données…", descEn: "Lengths, masses, volumes, temperatures, energy, data…" },
  { name: "skills_list", group: "knowledge", label: "Skills disponibles", labelEn: "Available skills", desc: "Liste les modes d'emploi (SKILL.md) installés.", descEn: "Lists installed how-to guides (SKILL.md)." },
  { name: "skill_read", group: "knowledge", label: "Lire un skill", labelEn: "Read a skill", desc: "Lit les instructions d'un skill pour les suivre.", descEn: "Reads a skill's instructions to follow them." },
  { name: "skill_file", group: "knowledge", label: "Fichier de skill", labelEn: "Skill file", desc: "Lit un modèle ou un exemple fourni par un skill.", descEn: "Reads a template or example provided by a skill." },
  { name: "web_search", group: "web", label: "Rechercher sur le web", labelEn: "Search the web", desc: "Recherche web (le seul outil qui sorte de la machine).", descEn: "Web search (the only tool that leaves the machine)." },
  { name: "web_read_page", group: "web", label: "Lire une page web", labelEn: "Read a web page", desc: "Lit le contenu texte d'une adresse web.", descEn: "Reads the text content of a web address." },
  { name: "project_list_conversations", group: "project", label: "Discussions du projet", labelEn: "Project conversations", desc: "Liste les autres discussions du projet courant.", descEn: "Lists the other conversations of the current project." },
  { name: "project_read_conversation", group: "project", label: "Lire une discussion", labelEn: "Read a conversation", desc: "Lit une autre discussion du projet.", descEn: "Reads another conversation of the project." },
  { name: "sandbox_read_file", group: "project", label: "Lire un fichier", labelEn: "Read a file", desc: "Lit un fichier de la sandbox (PDF, Word, tableur, image…).", descEn: "Reads a sandbox file (PDF, Word, spreadsheet, image…)." },
];

const TOOL_BY_NAME = new Map(BUILTIN_TOOL_CATALOG.map((t) => [t.name, t]));

function uiLang() {
  try {
    const stored = localStorage.getItem("lang");
    if (stored === "en" || stored === "fr") return stored;
  } catch {}
  return ((typeof navigator !== "undefined" ? navigator.language : "fr") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
}

/**
 * Libellé et description courts d'un outil, dans la langue de l'interface.
 * Renvoie null pour un outil inconnu (workflow Fluxo, MCP, intention d'app) :
 * l'appelant retombe alors sur la description du schéma.
 * @param {string} name nom de fonction tel qu'envoyé au modèle
 * @param {"fr"|"en"} [lang]
 */
export function toolHint(name, lang = uiLang()) {
  const t = TOOL_BY_NAME.get(name);
  if (!t) return null;
  const en = lang === "en";
  return { label: (en && t.labelEn) || t.label, desc: (en && t.descEn) || t.desc, effect: t.effect || "" };
}

/** Le catalogue des Réglages ne montre que les groupes qu'il gère. */
export function settingsToolCatalog() {
  return BUILTIN_TOOL_CATALOG.filter((t) => !["live", "web", "project"].includes(t.group));
}

export const TOOL_GROUPS = [
  { id: "fluxo", label: "Workflows Fluxo", labelEn: "Fluxo workflows", hint: "Les workflows marqués « exposé au function calling » dans le designer.", hintEn: "Workflows marked “exposed to function calling” in the designer." },
  { id: "memory", label: "Mémoire et rappels", labelEn: "Memory and reminders", hint: "Lecture et écriture de la mémoire cognitive.", hintEn: "Reading and writing the cognitive memory." },
  { id: "knowledge", label: "Connaissances", labelEn: "Knowledge", hint: "Documentation, documents indexés, bases de données.", hintEn: "Documentation, indexed documents, databases." },
  { id: "home", label: "Domotique", labelEn: "Smart home", hint: "Pilotage des objets connectés.", hintEn: "Control of connected devices." },
  { id: "agents", label: "Agents", labelEn: "Agents", hint: "Un outil par agent : « @agent_… » lui confie une tâche. Décochez ceux qui ne doivent pas encombrer le contexte du modèle.", hintEn: "One tool per agent: “@agent_…” hands it a task. Uncheck the ones that should not take up the model's context." },
  { id: "mail", label: "Courrier", labelEn: "Mail", hint: "Lecture, recherche, résumé du courrier relevé et brouillons. Jamais d'envoi : il reste un geste de l'utilisateur.", hintEn: "Reading, searching and summarizing the fetched mail, and drafts. Never sends: sending stays the user's gesture." },
  { id: "documents", label: "Documents", labelEn: "Documents", hint: "Production de fichiers : le seul groupe qui écrive hors de Lumen, dans vos Téléchargements.", hintEn: "File production: the only group that writes outside Lumen, in your Downloads." },
  { id: "web", label: "Recherche web", labelEn: "Web search", hint: "Le seul outil qui sorte de la machine : réglé ci-dessus, désactivé par défaut.", hintEn: "The only tool that leaves the machine: configured above, off by default." },
  { id: "mcp", label: "Connecteurs MCP", labelEn: "MCP connectors", hint: "Outils des connecteurs activés et visibles dans la barre.", hintEn: "Tools from connectors that are enabled and visible in the bar." },
];

/** Libellé et aide d'un groupe de la boîte à outils, dans la langue de l'interface. */
export function toolGroupText(group, lang = uiLang()) {
  const en = lang === "en";
  return { label: (en && group.labelEn) || group.label, hint: (en && group.hintEn) || group.hint };
}
