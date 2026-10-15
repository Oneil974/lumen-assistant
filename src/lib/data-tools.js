// Outils d'accès aux DONNÉES de l'utilisateur pour l'IA du chat (barre et
// bureau) : ses sandboxes (fichiers) et ses données personnelles (courrier,
// contacts, rappels, messagerie des agents).
//
// Règles d'accès, appliquées ici et non par le modèle :
//   • session verrouillée → l'utilisateur est invité à la déverrouiller ;
//   • une sandbox n'est lue qu'avec l'ACCORD de l'utilisateur (une fois, ou
//     toujours — cf. lib/user-gate.js) ; lister les sandboxes n'expose que
//     leurs noms ;
//   • la recherche ne porte que sur les sandboxes autorisées.
// Les documents indexés (search_documents) et les bases (query_tables) restent
// des outils à part ; les descriptions ci-dessous aident le modèle à choisir.

export const DATA_TOOL_NAMES = new Set([
  "sandbox_list", "sandbox_search", "sandbox_read", "search_personal_data",
  // Notes de l'app Notes (app-state/notes.json : ni sandbox ni « données
  // personnelles » — aucun outil ne les voyait) et bases de données.
  "notes_search", "notes_read", "tables_list",
  // Question à l'utilisateur quand la demande est ambiguë.
  "ask_user",
]);
// Outils que la barre fournit déjà elle-même (cartes de sources, etc.) ; le
// bureau les prend ici (options de buildDataTools).
export const DATA_TOOL_NAMES_EXTRA = new Set(["query_tables", "search_documents"]);

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export function buildDataTools(lang = "fr", { tables = false, corpus = false } = {}) {
  const en = lang === "en";
  const extra = [];
  if (tables) extra.push(fn("query_tables", en
    ? "Queries the user's structured databases (Databases app) in natural language, read-only. The right database is picked automatically unless `base` is given (see tables_list)."
    : "Interroge les bases de données structurées de l'utilisateur (app « Bases de données ») en langage naturel, en lecture seule. La bonne base est choisie automatiquement sauf si `base` est donné (voir tables_list).",
  {
    question: { type: "string", description: en ? "The question about the tabular data" : "La question sur les données tabulaires" },
    base: { type: "string", description: en ? "Optional database name" : "Nom de base facultatif" },
  }, ["question"]));
  if (corpus) extra.push(fn("search_documents", en
    ? "Semantic search in the user's indexed documents (Corpus). Returns numbered excerpts."
    : "Recherche sémantique dans les documents indexés de l'utilisateur (Corpus). Renvoie des extraits numérotés.",
  { query: { type: "string", description: en ? "What to look for" : "Ce qu'il faut chercher" } }, ["query"]));
  return [
    ...extra,
    fn("ask_user", en
      ? "Asks the user a multiple-choice question when the request is AMBIGUOUS (which file, which date, which person…) instead of guessing. 2 to 6 short options."
      : "Pose à l'utilisateur une question à choix quand la demande est AMBIGUË (quel fichier, quelle date, quelle personne…) au lieu de deviner. 2 à 6 options courtes.",
    {
      question: { type: "string", description: en ? "The question" : "La question" },
      options: { type: "array", items: { type: "string" }, description: en ? "The possible answers" : "Les réponses possibles" },
    }, ["question", "options"]),
    fn("notes_search", en
      ? "Searches the user's notes written in the Notes app (titles, text, #tags). Empty query = most recent notes. Use it whenever the user mentions their notes."
      : "Cherche dans les notes écrites par l'utilisateur dans l'app Notes (titres, texte, #tags). Requête vide = notes les plus récentes. À utiliser dès que l'utilisateur parle de ses notes.",
    { query: { type: "string", description: en ? "Keywords (may be empty)" : "Mots-clés (peut être vide)" } }),
    fn("notes_read", en
      ? "Reads the full text of one note from the Notes app, by title (or id), usually after notes_search."
      : "Lit le texte complet d'une note de l'app Notes, par son titre (ou id), en général après notes_search.",
    { title: { type: "string", description: en ? "Note title or id" : "Titre ou id de la note" } }, ["title"]),
    fn("tables_list", en
      ? "Lists the user's databases with their tables and columns, to know what can be queried with query_tables."
      : "Liste les bases de données de l'utilisateur avec leurs tables et colonnes, pour savoir quoi interroger avec query_tables."),
    fn("sandbox_list", en
      ? "Lists the user's sandboxes (file spaces) by name, and whether Lumen may already read them. Use it to know where files may be."
      : "Liste les sandboxes (espaces de fichiers) de l'utilisateur par nom, et indique si Lumen peut déjà les lire. À utiliser pour savoir où peuvent se trouver des fichiers."),
    fn("sandbox_search", en
      ? "Searches the user's FILES (sandboxes) by keywords, in names AND content (text, PDF, Word, Excel, PowerPoint). Returns sandbox, exact path and an excerpt. Asks the user's permission when needed."
      : "Cherche dans les FICHIERS de l'utilisateur (sandboxes) par mots-clés, dans les noms ET le contenu (texte, PDF, Word, Excel, PowerPoint). Renvoie sandbox, chemin exact et extrait. Demande l'accord de l'utilisateur si nécessaire.",
    {
      query: { type: "string", description: en ? "Keywords (names, subjects, dates…)" : "Mots-clés (noms, sujets, dates…)" },
      sandbox: { type: "string", description: en ? "Optional sandbox name to limit the search" : "Nom de sandbox facultatif pour limiter la recherche" },
    }, ["query"]),
    fn("sandbox_read", en
      ? "Reads the TEXT of one file of a sandbox, including PDF, Word, Excel, PowerPoint and OpenDocument (e.g. a CV). Copy the path from sandbox_search; an approximate name is tolerated."
      : "Lit le TEXTE d'un fichier d'une sandbox, y compris PDF, Word, Excel, PowerPoint et OpenDocument (ex. un CV). Recopie le chemin donné par sandbox_search ; un nom approximatif est toléré.",
    {
      sandbox: { type: "string", description: en ? "Sandbox name (or id)" : "Nom (ou id) de la sandbox" },
      path: { type: "string", description: en ? "File path inside the sandbox, as returned by sandbox_search" : "Chemin du fichier dans la sandbox, tel que renvoyé par sandbox_search" },
    }, ["sandbox", "path"]),
    fn("search_personal_data", en
      ? "Searches the user's personal data kept by Lumen: received mail, contacts, reminders, agent messages and the saved content of apps (Kanban, calendar…), by keywords. For notes prefer notes_search."
      : "Cherche dans les données personnelles gardées par Lumen : courriels reçus, contacts, rappels, messages des agents et contenu enregistré des apps (Kanban, agenda…), par mots-clés. Pour les notes, préférer notes_search.",
    { query: { type: "string", description: en ? "Keywords" : "Mots-clés" } }, ["query"]),
  ];
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

/** Retrouve des sandboxes par nom (exact, puis partiel) ou id ; toutes si vide. */
function pickSandboxes(list, wanted) {
  if (!wanted) return list;
  const w = norm(wanted);
  const exact = list.filter((s) => norm(s.name) === w || s.id === wanted);
  if (exact.length) return exact;
  return list.filter((s) => norm(s.name).includes(w) || w.includes(norm(s.name)));
}

/**
 * Exécute un outil de données.
 * @param {Function} invoke
 * @param {string} name
 * @param {object} args
 * @param {{ gate: ReturnType<import("./user-gate.js").createUserGate>, lang?: string, query?: string }} ctx
 *   `query` : la demande de l'utilisateur, montrée comme motif dans la carte d'accord.
 */
export async function callDataTool(invoke, name, args = {}, ctx = {}) {
  const en = ctx.lang === "en";
  // Notes, bases et Corpus ne sont pas gardés par la session : pas de mot de
  // passe ni d'accord à demander pour les lire.
  if (name === "notes_search" || name === "notes_read") return notesTool(invoke, name, args, en);
  if (name === "tables_list" || name === "query_tables") return tablesTool(invoke, name, args, en);
  if (name === "search_documents") {
    const hits = await invoke("rag_search", { query: String(args.query || ""), k: 6 }).catch(() => []);
    if (!hits?.length) return en ? "Nothing found in the indexed documents (Corpus)." : "Rien trouvé dans les documents indexés (Corpus).";
    return hits.map((h, i) => `[${i + 1}] (${h.title}) ${String(h.text || "").trim()}`).join("\n\n");
  }

  const gate = ctx.gate;
  if (!gate) throw new Error("accès aux données indisponible ici");
  if (name === "ask_user") {
    const opts = (Array.isArray(args.options) ? args.options : String(args.options || "").split(/[|;\n]/))
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 6);
    if (!args.question || opts.length < 2) return en ? "ask_user needs a question and at least 2 options." : "ask_user demande une question et au moins 2 options.";
    const pick = await gate.choose({ title: String(args.question), options: opts.map((o, i) => ({ id: String(i), label: o })), allowOther: true });
    if (pick == null) return en ? "The user did not answer." : "L'utilisateur n'a pas répondu.";
    const { otherAnswer } = await import("./user-gate.js");
    const free = otherAnswer(pick);
    if (free != null) return en ? `None of the options: the user answered “${free}”.` : `Aucune des options : l'utilisateur a répondu « ${free} ».`;
    return en ? `The user chose: ${opts[Number(pick)]}` : `L'utilisateur a choisi : ${opts[Number(pick)]}`;
  }

  if (!(await gate.ensureUnlocked())) {
    return en ? "Access refused: the session is locked and the user did not unlock it." : "Accès refusé : la session est verrouillée et l'utilisateur ne l'a pas déverrouillée.";
  }
  const reason = ctx.query ? `« ${String(ctx.query).slice(0, 140)} »` : "";

  if (name === "search_personal_data") {
    const hits = await invoke("data_search", { query: String(args.query || ""), sandboxIds: [], includeData: true, limit: 12 });
    if (!hits?.length) return en ? "No matching personal data." : "Aucune donnée personnelle correspondante.";
    return hits.map((h, i) => `[${i + 1}] ${h.kind} — ${h.title}${h.snippet && h.snippet !== h.title ? ` : ${h.snippet}` : ""}`).join("\n");
  }

  let list = [];
  try { list = (await invoke("sandbox_list")) || []; } catch (e) { return `Erreur : ${e?.message || e}`; }
  if (!list.length) return en ? "The user has no sandbox." : "L'utilisateur n'a aucune sandbox.";

  if (name === "sandbox_list") {
    const { sandboxAllowed } = await import("./user-gate.js");
    return list.map((s) => `- ${s.name}${sandboxAllowed(s.id) ? (en ? " (readable)" : " (lecture autorisée)") : (en ? " (permission will be asked)" : " (accord à demander)")}`).join("\n");
  }

  const targets = pickSandboxes(list, args.sandbox);
  if (!targets.length) {
    return (en ? `No sandbox named “${args.sandbox}”. Available: ` : `Aucune sandbox nommée « ${args.sandbox} ». Disponibles : `) + list.map((s) => s.name).join(", ");
  }

  if (name === "sandbox_search") {
    const allowed = await gate.authorizeSandboxes(targets, reason);
    if (!allowed.length) return en ? "The user refused access to these sandboxes. Say so and do not guess their content." : "L'utilisateur a refusé l'accès à ces sandboxes. Dis-le et n'invente pas leur contenu.";
    const hits = await invoke("data_search", { query: String(args.query || ""), sandboxIds: allowed, includeData: false, limit: 12 });
    const skipped = targets.filter((s) => !allowed.includes(s.id)).map((s) => s.name);
    const tail = skipped.length ? (en ? `\n(Not searched, access refused: ${skipped.join(", ")})` : `\n(Non consultées, accès refusé : ${skipped.join(", ")})`) : "";
    if (!hits?.length) return (en ? "No matching file." : "Aucun fichier correspondant.") + tail;
    return hits.map((h, i) => `[${i + 1}] ${h.source_name}/${h.path} — ${String(h.snippet || "").replace(/\s+/g, " ").slice(0, 200)}`).join("\n")
      + (en ? "\nUse sandbox_read to open a file." : "\nUtilise sandbox_read pour ouvrir un fichier.") + tail;
  }

  if (name === "sandbox_read") {
    // Le modèle écrit souvent « Sandbox/chemin » dans `path` : on retire ce préfixe.
    const rawPath = String(args.path || "").replace(/^\/+/, "");
    const strip = (sb, p) => {
      const n = norm(sb.name);
      const first = p.split("/")[0];
      return first && norm(first) === n ? p.slice(first.length + 1) : p;
    };
    // Sandboxes consultables : celle(s) nommée(s) (accord demandé si besoin),
    // puis les autres déjà autorisées — un fichier listé ailleurs que là où le
    // modèle le croit reste lisible.
    const { sandboxAllowed } = await import("./user-gate.js");
    const named = args.sandbox ? targets : targets.filter((s) => sandboxAllowed(s.id));
    const asked = named.length ? named : [targets[0]];
    const allowed = await gate.authorizeSandboxes(asked, reason);
    const pool = [...list.filter((s) => allowed.includes(s.id)), ...list.filter((s) => !allowed.includes(s.id) && sandboxAllowed(s.id))];
    if (!pool.length) return en ? `The user refused access to “${asked[0].name}”.` : `L'utilisateur a refusé l'accès à « ${asked[0].name} ».`;

    // Plusieurs fichiers DIFFÉRENTS répondent à ce nom ? On demande plutôt que
    // de deviner (des copies identiques — même taille — ne comptent qu'une fois).
    let chosen = null;
    try {
      const cands = (await invoke("sandbox_file_candidates", { ids: pool.map((s) => s.id), name: rawPath })) || [];
      const exactPath = cands.find((c) => norm(c.path) === norm(strip(pool.find((s) => s.id === c.id) || { name: "" }, rawPath)));
      const distinct = [];
      for (const c of cands) if (!distinct.some((d) => d.size === c.size && d.path.split("/").pop() === c.path.split("/").pop())) distinct.push(c);
      if (exactPath) chosen = exactPath;
      else if (distinct.length === 1) chosen = distinct[0];
      else if (distinct.length > 1) {
        const date = (ms) => (ms ? new Date(ms).toLocaleDateString(en ? "en-GB" : "fr-FR") : "");
        const pick = await gate.choose({
          title: en ? `Several files match “${rawPath.split("/").pop()}”: which one?` : `Plusieurs fichiers correspondent à « ${rawPath.split("/").pop()} » : lequel ?`,
          spoken: en ? "I found several files with that name. Which one do you mean?" : "J'ai trouvé plusieurs fichiers à ce nom. Lequel veux-tu ?",
          options: distinct.slice(0, 6).map((c, i) => ({ id: String(i), label: `${c.sandbox}/${c.path}${c.modified ? ` (${date(c.modified)})` : ""}` })),
        });
        if (pick == null) return en ? "The user did not choose a file. Ask them which one they mean." : "L'utilisateur n'a pas choisi de fichier. Demande-lui lequel il veut.";
        chosen = distinct[Number(pick)];
      }
    } catch { /* ancienne version sans candidats : lecture directe ci-dessous */ }

    const attempts = chosen ? [{ sb: pool.find((s) => s.id === chosen.id), path: chosen.path }]
      : pool.map((sb) => ({ sb, path: strip(sb, rawPath) }));
    let lastErr = "";
    for (const { sb, path } of attempts) {
      if (!sb) continue;
      try {
        // Extraction PDF / Word / Excel / PowerPoint / OpenDocument, et nom
        // de fichier tolérant (casse, accents, espaces, « _ », dossier oublié).
        const doc = await invoke("sandbox_read_document", { id: sb.id, path });
        const text = String(doc?.content || "");
        if (!text.trim()) throw new Error("scanné : aucun texte");
        const note = doc.path !== strip(sb, rawPath) ? (en ? ` (actual path: ${doc.path})` : ` (chemin réel : ${doc.path})`) : "";
        return `${sb.name}/${doc.path}${note}${doc.truncated ? (en ? " — truncated" : " — tronqué") : ""} :\n${text.slice(0, 20000)}${text.length > 20000 ? "\n…" : ""}`;
      } catch (e) {
        lastErr = String(e?.message || e);
        // PDF scanné ou image : reconnaissance du texte par le modèle de vision.
        if (/scann|aucun texte|Image :/i.test(lastErr)) {
          const real = chosen?.path || path;
          try {
            const { ocrSandboxFile, ocrUsable } = await import("./ocr.js");
            ctx.onOcr?.(real);
            const ocr = await ocrSandboxFile(invoke, { id: sb.id, path: real }, { lang: ctx.lang });
            if (ocrUsable(ocr.text)) {
              const more = ocr.total > ocr.pages ? (en ? ` (first ${ocr.pages} of ${ocr.total} pages)` : ` (${ocr.pages} premières pages sur ${ocr.total})`) : "";
              return `${sb.name}/${real} — ${en ? "text recognized by OCR" : "texte reconnu par OCR"}${more} :\n${ocr.text.slice(0, 20000)}`;
            }
            return en ? `${sb.name}/${real}: scanned document, and the current model could not read it (a vision-capable model is needed).` : `${sb.name}/${real} : document scanné, et le modèle actuel n'a pas pu le lire (il faut un modèle qui accepte les images).`;
          } catch (err) {
            lastErr = `${lastErr} — OCR : ${err?.message || err}`;
          }
        }
      }
    }
    return (en ? "Could not read the file: " : "Lecture impossible : ") + lastErr
      + (en ? " Use sandbox_search to find the exact path." : " Utilise sandbox_search pour retrouver le chemin exact.");
  }
  throw new Error(`Outil de données inconnu : ${name}`);
}


/* ------------------------------------------------------------------ Notes */

const words = (q) => norm(q).split(/[^a-z0-9#]+/).filter((w) => w.length >= 3 && !["les", "des", "une", "dans", "pour", "mes", "notes", "note", "the", "and", "my"].includes(w));

async function loadNotes(invoke) {
  // app-state/notes.json = { "notes.data": "<tableau JSON en chaîne>" }
  const raw = await invoke("app_state_load", { name: "notes" }).catch(() => "");
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    const v = obj?.["notes.data"];
    const arr = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function excerpt(body, terms, size = 220) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  const low = norm(text);
  let at = -1;
  for (const t of terms) { at = low.indexOf(t.replace(/^#/, "")); if (at >= 0) break; }
  if (at < 0) return text.slice(0, size) + (text.length > size ? "…" : "");
  const start = Math.max(0, at - 60);
  return (start ? "…" : "") + text.slice(start, start + size) + (start + size < text.length ? "…" : "");
}

async function notesTool(invoke, name, args, en) {
  const notes = await loadNotes(invoke);
  if (!notes.length) return en ? "The Notes app contains no note." : "L'app Notes ne contient aucune note.";
  const date = (ts) => (ts ? new Date(ts).toLocaleDateString(en ? "en-GB" : "fr-FR") : "");
  if (name === "notes_read") {
    const want = String(args.title || "").trim();
    const w = norm(want);
    const note = notes.find((n) => n.id === want) || notes.find((n) => norm(n.title) === w)
      || notes.find((n) => norm(n.title).includes(w) || (w && w.includes(norm(n.title)) && norm(n.title).length > 2));
    if (!note) return (en ? `No note titled “${want}”. Notes: ` : `Aucune note intitulée « ${want} ». Notes : `) + notes.slice(0, 20).map((n) => n.title || "(sans titre)").join(", ");
    const body = String(note.body || "");
    return `# ${note.title || "(sans titre)"} — ${date(note.ts)}\n${body.slice(0, 12000)}${body.length > 12000 ? "\n…" : ""}`;
  }
  const terms = words(args.query);
  let ranked;
  if (!terms.length) {
    ranked = [...notes].sort((a, b) => (b.ts || 0) - (a.ts || 0)).map((n) => ({ n, score: 1 }));
  } else {
    ranked = notes.map((n) => {
      const title = norm(n.title), body = norm(n.body);
      let score = 0;
      for (const t of terms) {
        const bare = t.replace(/^#/, "");
        if (title.includes(bare)) score += 3;
        if (body.includes(t)) score += 1;
      }
      return { n, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (b.n.ts || 0) - (a.n.ts || 0));
  }
  if (!ranked.length) {
    // Recherche simple infructueuse (pluriel, accent, synonyme…) : le moteur
    // du coffre unifié (plein texte, classement, extraits) prend le relais.
    try {
      const hub = await invoke("native_tool_exec", { name: "data_search", args: { query: String(args.query || ""), type: "note" } });
      if (hub && !/^(Rien trouvé|Nothing found)/.test(hub)) return hub;
    } catch { /* ancienne version sans coffre unifié */ }
    return (en ? "No note matches. Existing notes: " : "Aucune note ne correspond. Notes existantes : ") + notes.slice(0, 20).map((n) => n.title || "(sans titre)").join(", ");
  }
  return ranked.slice(0, 8).map(({ n }, i) => `[${i + 1}] « ${n.title || "(sans titre)"} » (${date(n.ts)}) — ${excerpt(n.body, terms)}`).join("\n")
    + (en ? "\nUse notes_read to open a note." : "\nUtilise notes_read pour lire une note en entier.");
}

/* ------------------------------------------------------------- Bases */

async function tablesTool(invoke, name, args, en) {
  const db = await import("../tables/client.js");
  let bases = [];
  try { bases = (await db.listBases()) || []; } catch (e) { return `Erreur : ${e?.message || e}`; }
  if (!bases.length) return en ? "No database. Create one in the Databases app." : "Aucune base de données. Créez-en une dans l'app « Bases de données ».";
  // Schéma lisible de chaque base : sert à la liste ET au choix automatique.
  const schemas = await Promise.all(bases.map((b) => db.schemaPrompt(b.base_id).catch(() => "")));
  if (name === "tables_list") {
    return bases.map((b, i) => `## ${b.name}\n${String(schemas[i] || "").slice(0, 1500)}`).join("\n\n");
  }
  let idx = -1;
  if (args.base) {
    const w = norm(args.base);
    idx = bases.findIndex((b) => norm(b.name) === w);
    if (idx < 0) idx = bases.findIndex((b) => norm(b.name).includes(w) || w.includes(norm(b.name)));
  }
  if (idx < 0) {
    // Base dont le nom / les tables / les colonnes recoupent le plus la question.
    const terms = words(args.question);
    let best = 0;
    idx = 0;
    bases.forEach((b, i) => {
      const hay = norm(`${b.name} ${schemas[i]}`);
      const score = terms.filter((t) => hay.includes(t)).length;
      if (score > best) { best = score; idx = i; }
    });
  }
  const base = bases[idx];
  try {
    const { sql, columns, rows } = await db.askAi(base.base_id, String(args.question || ""));
    if (!rows.length) return `Base « ${base.name} » — requête : ${sql}\n${en ? "No result." : "Aucun résultat."}`;
    const head = columns.join(" | ");
    const body = rows.slice(0, 30).map((r) => r.map((v) => (v == null ? "" : v)).join(" | ")).join("\n");
    return `Base « ${base.name} » — requête : ${sql}\n${head}\n${body}${rows.length > 30 ? `\n… (${rows.length - 30} de plus)` : ""}`;
  } catch (e) {
    return `Erreur sur la base « ${base.name} » : ${e?.message || e}. ` + (en ? "Other databases: " : "Autres bases : ") + bases.map((b) => b.name).join(", ");
  }
}
