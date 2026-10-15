// Planificateur d'outils SANS modèle, pour les petits modèles.
//
// Mesuré au banc (03/10/2026, LFM2.5-1.2B-Thinking, 14 cas réels) : laissé
// libre, le 1.2B choisit le premier outil de la liste (la météo pour une photo
// ou un rapport) ou n'en appelle aucun — 5 cas réussis sur 14. Ici, le choix
// des outils et de leurs arguments est fait par des règles : chaque INTENTION
// (météo, rappel, mails, agenda, fichier…) reconnaît la demande ET l'outil qui
// la sert, d'après son nom ou sa description (les vrais outils de Lumen
// s'appellent `mail_rechercher`, `data_agenda`… ; ceux d'un MCP sont inconnus).
// Le modèle n'intervient plus que pour remplir un argument obligatoire que les
// règles n'ont pas trouvé, sous un schéma imposé.

/** Minuscules, sans accents (même règle que orchestrator.js). */
export function normalizeText(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// --------------------------------------------------------------- Intentions
// `q` : motif sur la demande (normalisée : minuscules, sans accents).
// `tools` : motifs sur « nom description » de l'outil, par ordre de préférence.
// `args` : arguments fixes ou déduits de la demande.
// `action` : l'outil agit (création, envoi) — jamais choisi sur un indice faible.
// `covers` : intentions rendues inutiles quand celle-ci est retenue.
export const INTENTS = [
  { id: "weather", q: /\b(meteo|quel temps|temps (qu.il )?(fait|fera|fera.t.il)|il (fera|fait) (comment|quel|beau|chaud|froid)|pleu(t|voir|vra)|parapluie|neige|temperature|previsions?|canicule|orage|soleil demain|weather|forecast|rain|umbrella)\b/, tools: [/^weather|meteo|forecast/] },
  { id: "reminder", action: true, q: /\b(rappelle.moi (de |d.|dans |demain|ce soir|cette |lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|a \d|qu)|remind me|(cree|ajoute|mets|programme)(.moi)? (un |une )?(rappel|alarme)|set a reminder)\b/, tools: [/create_reminder|reminder_(create|add)|rappel/] },
  { id: "remember", action: true, q: /\b(retiens|memorise|n.oublie pas que|souviens.toi (que|de)|garde en (tete|memoire)|remember (that|this))\b/, tools: [/memory_remember|remember/] },
  { id: "recall", q: /\b(tu te souviens|te rappelles.tu|qu.est.ce que (je t.ai dit|tu sais de moi)|do you remember|what do you know about me)\b/, tools: [/memory_recall|recall/] },
  { id: "day", q: /\b(ma journee|mon programme|ma matinee|mon apres.midi|qu.est.ce que j.ai aujourd.hui|my day|today.s schedule)\b/, tools: [/day_overview|overview.*(jour|day)/, /data_agenda/], covers: ["agenda"] },
  { id: "metrics", q: /\b(sommeil|dormi|combien de pas|mes pas|pas (aujourd.hui|hier|cette semaine)|frequence cardiaque|cardiaque|calories|mon poids|compteur|sleep|steps|heart rate)\b/, tools: [/data_metrics|metrics|mesures?/, /data_search/] },
  { id: "agenda", q: /\b(agenda|calendrier|de prevu|planning|emploi du temps|rendez.vous|rdv|reunions?|anniversaires?|evenements?|cette semaine|semaine prochaine|ce week.end|schedule|calendar|appointments?)\b/, tools: [/data_agenda|agenda|planning/, /app_data/], args: { app: "agenda" } },
  { id: "tasks", q: /\b(kanban|mes taches|mes cartes|cartes? (en cours|a faire)|en cours sur|tableau de taches|to.?do|my tasks)\b/, tools: [/app_data/, /data_tasks|tasks?/, /kanban/], args: { app: "kanban" } },
  { id: "mail", q: /\b(e-?mails?|mails?|courriels?|boite (mail|de reception)|inbox|m.a (ecrit|repondu|envoye)|(a|t.a) ecrit|messages? recus?)\b/, tools: [/^mail_(search|rechercher|find)/, /^mail_(boite|inbox|list)/, /^mail_/, /search_personal_data/] },
  { id: "news", q: /\b(actualites?|news|derniere(s)? (nouvelles|infos|version)|quand (sort|sortira|est sorti)|date de (sortie|lancement)|release date|(est|sont) (sorti|annonce)e?s?|latest|prix (actuel|du|de la|des)|combien coute|qui a gagne|resultat du match|cherche sur (internet|le web)|sur internet|search the web)\b/, tools: [/web_search|search_web|news/, /news_headlines/] },
  { id: "markets", q: /\b(bourse|cours (de|du) |action [a-z]|cac ?40|nasdaq|bitcoin|crypto|stock price)\b/, tools: [/market_quote|stock|bourse/] },
  { id: "fx", q: /\b(taux de change|convertis? .* (euros?|dollars?)|exchange rate)\b/, tools: [/exchange_rate|change/] },
  { id: "air", q: /\b(qualite de l.air|pollution|pollen|air quality)\b/, tools: [/air_quality/] },
  { id: "sport", q: /\b(score|classement|match (de|du)|ligue|champions)\b/, tools: [/sport_score|sport/] },
  { id: "image", action: true, q: /\b(genere (une|un) image|dessine.moi|cree une image|generate an image|draw me)\b/, tools: [/generate_image|image_gen/] },
  { id: "home", action: true, q: /\b(allume|eteins|lampe|lumiere du|prise connectee|thermostat|volet|chauffage|turn (on|off))\b/, tools: [/domotique_command|home_command/, /domotique/] },
  { id: "file", generic: true, q: /\b(photos?|images?|pdf|devis|factures?|contrats?|\bcv\b|curriculum|fichiers?|documents?|captures? d.ecran|scan|ma note|mes notes|une note sur|le rapport|mon rapport|dans le rapport|compte.rendu)\b/, tools: [/data_search/, /search_documents/, /search_personal_data/, /sandbox_search/, /notes_search/] },
];

// Demandes qui portent sur la conversation elle-même : aucun outil.
const ABOUT_CHAT = /\b(recapitule|reformule|resume (ta|ce que|notre)|ta reponse|ta derniere reponse|ce que tu (viens de dire|as dit)|traduis|corrige (ce|mon|cette) (texte|phrase)|explique.moi|rephrase|translate|summari[sz]e (what|our))\b/;
const REFERS_TO_CHAT = /\b(recapitule|recap|(donc|alors),? (au final|finalement)|au final|finalement|ce qu.on a (dit|convenu|decide)|comme (on|je) (l.a|t.ai) dit|ce que je t.ai dit|what we (said|agreed|decided)|so in the end)\b|\b(final|definitif|retenu)e?\b.*\?$/;
// Relances qui héritent du sujet précédent (« et demain ? », « non, à Marseille »).
const FOLLOW_UP = /^(et|non|plutot|pas|ou|mais|sinon|and|no|what about)\b|\b(la.bas|je voulais dire|je parlais de|pareil|meme chose|over there|i meant)\b/;
// Une action soumise à une condition (« si oui, crée un rappel ») n'est
// exécutée que si les lectures ont trouvé quelque chose.
const CONDITIONAL = /\b(si oui|si c.est le cas|si (elle|il|c.est) |le cas echeant|if so|if yes)\b/;

// ---------------------------------------------------------------- Découpage

const ACTION_VERBS = "rappelle|retiens|memorise|cree|ajoute|note|mets|programme|envoie|regarde|cherche|trouve|montre|donne|dis|allume|eteins|remind|remember|create|add|send|show|find|tell";
/** Propositions d'une demande composée (« rappelle-moi X et retiens que Y »). */
export function splitClauses(query) {
  const re = new RegExp(`\\s*(?:,|;|\\bet\\b|\\bpuis\\b|\\bensuite\\b|\\band\\b|\\bthen\\b|\\?)\\s*(?=(?:(?:si oui|si c'est le cas|if so),?\\s*)?(?:${ACTION_VERBS})\\w*)`, "i");
  return String(query).split(re).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- Arguments

const CAP_WORD = "[A-ZÀ-ÖØ-Þ][\\wÀ-ÿ'’-]+";
const NOT_PLACES = new Set(["Lumen", "Je", "Il", "Elle", "On", "Non", "Oui", "Et", "Quel", "Quelle", "Le", "La", "Les", "Est", "Demain", "Aujourd'hui", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche", "PDF"]);

/** Lieu cité dans un texte (« à Lyon », « pour Saint-Denis »), sinon "". */
export function extractPlace(text) {
  const t = String(text || "");
  // Pas de \b avant « à » : en JavaScript, une lettre accentuée n'est pas un caractère de mot.
  const prep = new RegExp(`(?:^|[\\s,(])(?:à|a|au|aux|en|sur|pour|vers|dans|de|in|at|for)\\s+(${CAP_WORD}(?:[\\s-]${CAP_WORD})*)`, "g");
  for (const m of t.matchAll(prep)) {
    const p = m[1].split(/\s+/).filter((w) => !NOT_PLACES.has(w)).join(" ");
    if (p) return p;
  }
  // Correction : « Non, je voulais dire Marseille, pas Lyon. »
  const said = t.match(new RegExp(`\\b(?:dire|plutôt|plutot|meant)\\s+(${CAP_WORD})`));
  if (said && !NOT_PLACES.has(said[1])) return said[1];
  return "";
}

/** Moment d'un rappel (« demain à 9h », « jeudi », « dans 2 heures »), sinon "". */
export function extractWhen(text) {
  const t = String(text || "");
  const m = t.match(/\b((?:demain|après-demain|apres-demain|aujourd'hui|ce soir|ce matin|cet après-midi|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:prochain|matin|soir|midi))?(?:\s+(?:(?:à|a|at|vers)\s+)?\d{1,2}\s?(?:h|:)\s?\d{0,2})?|dans\s+\d+\s+(?:minutes?|heures?|jours?)|in\s+\d+\s+(?:minutes?|hours?|days?)|(?:à|a|at|vers)\s+\d{1,2}\s?(?:h|:)\s?\d{0,2})\b/i);
  return m ? m[1].trim() : "";
}

/** Texte d'un rappel ou d'un souvenir, sans la formule ni le moment. */
function extractBody(text, kind) {
  let t = String(text || "").trim();
  if (kind === "reminder") t = t.replace(/^.*?\b(?:rappelle[- ]moi|remind me|rappel)\s*(?:de |d'|d’|pour |to |que |qu')?/i, "");
  if (kind === "remember") t = t.replace(/^.*?\b(?:retiens|mémorise|memorise|n'oublie pas|souviens-toi|garde en (?:tête|mémoire)|remember)\s*(?:bien\s*)?(?:que |qu'|qu’|de |d'|that )?/i, "");
  const when = extractWhen(t);
  if (when && kind === "reminder") t = t.replace(when, "");
  t = t.replace(/\s+/g, " ").replace(/^(?:pour|de|d'|à|a)\s+/i, "").replace(/[\s,.;!?]+$/, "").trim();
  // « un rappel pour jeudi 10h » : il ne reste rien d'utile, le modèle complètera.
  return (t.match(/[a-zà-ÿ]{3,}/gi) || []).length >= 1 ? t : "";
}

/** Mots utiles d'une recherche : sans les formules (« montre-moi », « regarde dans… »). */
export function searchQuery(text) {
  return String(text || "")
    .replace(/^(?:\s*(?:(?:est-ce que|peux-tu|tu peux|pourrais-tu|je veux|j'aimerais|je voudrais)\s+)?(?:regarde|cherche|trouve|retrouve|montre|donne|affiche|ouvre|envoie|dis|lis|sors)(?:[- ]moi)?(?:\s+(?:dans|sur)\s+(?:le|la|les|mon|ma|mes)\s+\w+)?\s*)/i, "")
    .replace(/\b(?:s'il te plaît|stp|svp|please)\b/gi, "")
    .replace(/[?!.]+$/, "")
    .replace(/\s+/g, " ").trim() || String(text || "").trim();
}

const today = (now) => now.toISOString().slice(0, 10);

/**
 * Arguments d'un outil déduits du texte, par NOM de paramètre (place, query,
 * text, when, app, type, period…). Ce qui n'est pas trouvé reste absent.
 */
export function extractArgs(tool, clause, { intent, previous = "", now = new Date() } = {}) {
  const props = tool?.function?.parameters?.properties || {};
  const args = {};
  const n = normalizeText(clause);
  for (const [key, p] of Object.entries(props)) {
    const k = key.toLowerCase();
    let v;
    if (/^(place|city|location|lieu|ville|where)$/.test(k)) v = extractPlace(clause) || extractPlace(previous);
    else if (/^(when|due|at|time|date_heure|quand)$/.test(k)) v = extractWhen(clause);
    else if (/^(text|content|note|fact|body|texte)$/.test(k)) v = extractBody(clause, intent?.id === "remember" ? "remember" : "reminder");
    else if (/^(query|q|search|question|terms|recherche|requete|keywords?)$/.test(k)) v = searchQuery(clause);
    else if (k === "app" && intent?.args?.app) v = intent.args.app;
    else if (k === "type" && /\b(photo|image|capture)/.test(n)) v = "image";
    else if (/^(period|range|periode)$/.test(k)) v = /semaine prochaine|next week/.test(n) ? "next_week" : /semaine|week/.test(n) ? "week" : /demain|tomorrow/.test(n) ? "tomorrow" : /aujourd|today/.test(n) ? "today" : undefined;
    else if (k === "days") v = /semaine|week/.test(n) ? 7 : undefined;
    else if (k === "date") v = /demain|tomorrow/.test(n) ? today(new Date(now.getTime() + 864e5)) : /aujourd|today|journee/.test(n) ? today(now) : undefined;
    if (v === undefined || v === "") continue;
    // Respect du type et de l'énumération déclarés.
    if (p.enum && !p.enum.includes(v)) continue;
    if ((p.type === "integer" || p.type === "number") && typeof v !== "number") continue;
    args[key] = p.type === "string" && typeof v === "number" ? String(v) : v;
  }
  return args;
}

// ------------------------------------------------------------------ Planner

const hay = (t) => normalizeText(`${(t?.function?.name || "").replace(/_/g, " ")} ${t?.function?.name || ""} ${t?.function?.description || ""}`);

function toolFor(intent, tools) {
  // Le NOM d'abord : la description de day_overview cite « rappels », ce
  // n'est pas pour autant l'outil qui en crée.
  for (const re of intent.tools) {
    const t = tools.find((x) => re.test(x.function.name));
    if (t) return t;
  }
  for (const re of intent.tools) {
    const t = tools.find((x) => re.test(hay(x)));
    if (t) return t;
  }
  return null;
}

const STOPWORDS = new Set("avec alors aussi autre avoir bonjour comment dans donne donner elle elles entre faire leurs mais meme notre nous pour pourquoi quand quelle quelles quels sans selon sont sous tout toute tres votre vous quel quoi est-ce cette celui celle montre regarde cherche trouve about there their these those which would could should please merci".split(" "));

/** Outil dont le nom ou la description reprend un mot rare de la demande (outils inconnus : MCP, workflows…). */
function lexicalScore(query, t) {
  const words = [...new Set(normalizeText(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 6 && !STOPWORDS.has(w)))];
  const h = hay(t);
  return words.filter((w) => h.includes(w)).length;
}

function lexicalTool(query, tools) {
  const words = [...new Set(normalizeText(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 6 && !STOPWORDS.has(w)))];
  let best = null, score = 0;
  for (const t of tools) {
    const h = hay(t);
    const s = words.filter((w) => h.includes(w)).length;
    if (s > score) { best = t; score = s; }
  }
  return best;
}

/**
 * Plan d'appels pour une demande.
 * @param {string} query
 * @param {Array} tools  outils au format function-calling
 * @param {object} [o]
 * @param {string} [o.previous]  demande précédente de l'utilisateur (relances)
 * @param {(name:string)=>boolean} [o.isAction]  l'outil agit-il ? (tool-meta)
 * @returns {{ calls: Array<{tool, name, args, intent, clause, conditional}>, reason: string, aboutChat: boolean }}
 */
export function planTools(query, tools, { previous = "", isAction = () => false, now = new Date() } = {}) {
  const available = (tools || []).filter((t) => t?.function?.name && t.function.name !== "ask_user");
  const nq = normalizeText(query);
  if (ABOUT_CHAT.test(nq) && !INTENTS.some((i) => i.id !== "file" && i.q.test(nq))) return { calls: [], reason: "conversation", aboutChat: true };
  // Renvoi explicite à la CONVERSATION (« récapitule le rendez-vous final »,
  // « ce qu'on a dit ») : la réponse est dans l'historique, pas dans un outil.
  if (previous && REFERS_TO_CHAT.test(nq)) return { calls: [], reason: "conversation", aboutChat: true };

  const clauses = splitClauses(query);
  const calls = [];
  const seen = new Set();
  const covered = new Set();
  const add = (intent, tool, clause, prevText = "") => {
    if (!tool || covered.has(intent.id)) return;
    // Recherche générique (fichiers, documents) : un outil SPÉCIALISÉ dont la
    // description reprend les mots de la demande passe devant (« le rapport »
    // → l'outil des rapports ; un MCP Notion pour « dans Notion »).
    if (intent.generic) {
      const special = lexicalTool(clause, available.filter((x) => !isAction(x.function.name)));
      if (special && lexicalScore(clause, special) > lexicalScore(clause, tool) && lexicalScore(clause, special) >= 2) tool = special;
    }
    const args = extractArgs(tool, clause, { intent, previous: prevText, now });
    // Le même outil peut servir deux fois avec des arguments différents
    // (app_data pour l'agenda PUIS pour le Kanban).
    const key = `${tool.function.name}:${intent.args ? JSON.stringify(intent.args) : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const c of intent.covers || []) covered.add(c);
    // Remplaçants : les autres outils de la même intention, dans l'ordre, si
    // celui-ci échoue ou revient sans rapport avec la demande.
    const alternates = intent.tools.flatMap((re) => available.filter((x) => re.test(x.function.name))).map((x) => x.function.name)
      .filter((n, i, arr) => n !== tool.function.name && arr.indexOf(n) === i && !isAction(n));
    calls.push({
      tool, name: tool.function.name, intent: intent.id, clause, args, alternates,
      conditional: !!intent.action && CONDITIONAL.test(normalizeText(query)),
    });
  };
  const matchIntents = (text) => INTENTS.filter((i) => i.q.test(normalizeText(text)));

  // « covers » s'applique quel que soit l'ordre : la vue de la journée rend
  // l'agenda inutile même s'il est cité avant.
  for (const clause of clauses) {
    const found = matchIntents(clause);
    for (const i of found) for (const c of i.covers || []) if (found.some((x) => x.id !== i.id)) covered.add(c);
    for (const intent of found) add(intent, toolFor(intent, available), clause, previous);
  }
  // Relance courte : le sujet vient de la demande précédente (« et demain ? »).
  if (!calls.length && previous && (FOLLOW_UP.test(nq) || nq.length < 40) && !ABOUT_CHAT.test(nq)) {
    // Arguments tirés de la RELANCE d'abord (« je voulais dire Marseille »),
    // puis de la demande précédente (« là-bas » = Lyon).
    for (const intent of matchIntents(previous)) add(intent, toolFor(intent, available), query, previous);
  }
  // Outil inconnu dont la description reprend un mot rare de la demande.
  if (!calls.length) {
    const t = lexicalTool(query, available.filter((x) => !isAction(x.function.name)));
    if (t) add({ id: "lexical", tools: [] }, t, query, previous);
  }
  // Données personnelles non classées (« mon passeport », « mes factures ») :
  // la recherche générale dans le coffre.
  if (!calls.length && /\b(mon|ma|mes|my)\s+(?!avis|reponse|question|texte|phrase|message precedent|idee)\w{3,}/.test(nq) && !/\b(je|j.)\b.{0,20}\b(prefere|aime|suis)\b/.test(nq)) {
    const t = toolFor({ tools: [/data_search/, /search_personal_data/, /sandbox_search/] }, available);
    if (t) add({ id: "personal", tools: [] }, t, query, previous);
  }
  return { calls, reason: calls.map((c) => `${c.intent}→${c.name}`).join(", "), aboutChat: false };
}

/**
 * Outil inconnu (MCP, workflow) qui se présente comme une LECTURE : nom ou
 * description de consultation, et aucun verbe d'action dans le nom.
 */
export function readLike(tool) {
  const name = normalizeText(tool?.function?.name || "");
  if (!tool?.function) return false;
  if (/(create|add|send|delete|remove|update|write|set|post|put|envoi|cree|ajout|suppr|modif|ecri|command|run|exec)/.test(name)) return false;
  return /\b(search|get|list|read|lire|consulte|cherche|recherche|report|rapport|overview|query|find|show|status|etat|meteo|weather)\w*/.test(hay(tool));
}

/** Champs obligatoires restés vides après extraction. */
export function missingRequired(call) {
  return (call.tool.function.parameters?.required || []).filter((k) => call.args[k] === undefined || call.args[k] === "");
}
