// Données des APPLICATIONS de Lumen pour l'IA du chat : Kanban, Agenda
// (rappels, évènements synchronisés iCal/Google, tâches datées des agents,
// workflows planifiés), Messagerie des agents, Contacts, Notes, Études,
// Tâches planifiées, Moodboard… et, par défaut, tout état d'app enregistré
// dans `app-state/`.
//
// Chaque app range ses données à sa façon (fichier dédié, app-state avec du
// JSON en chaîne, commandes Rust) : un LECTEUR par app les transforme en
// enregistrements lisibles { title, text, date?, when? }. Trois outils en
// découlent :
//   apps_list    — quelles apps ont des données (et combien) ;
//   app_data     — les données d'UNE app, filtrées par mots-clés et/ou dates ;
//   apps_search  — une recherche par mots-clés dans TOUTES les apps.
// Lecture seule : aucun de ces outils ne modifie une app.

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const STOP = new Set("les des une dans pour avec sur que qui est sont mes mon ton tes quel quelle quels quelles the and for with my what when where".split(" "));
const terms = (q) => [...new Set(norm(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 8);

const parse = (raw, fallback = null) => {
  if (raw == null || raw === "") return fallback;
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
};
/** app-state : { clé: "<JSON en chaîne>" } → { clé: valeur } */
async function appState(invoke, name) {
  const obj = parse(await invoke("app_state_load", { name }).catch(() => ""), {}) || {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === "string" && /^[[{]/.test(v.trim()) ? parse(v, v) : v;
  return out;
}
const dateStr = (ms, lang) => {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang === "en" ? "en-GB" : "fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
const toMs = (v) => {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v; // secondes → ms
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
};

/* ------------------------------------------------------------- Lecteurs */

const READERS = {
  kanban: {
    label: { fr: "Kanban", en: "Kanban" },
    hint: "tableau, cartes, colonnes, tâches, projet, assigné, étiquettes, échéance",
    async load(invoke) {
      const b = parse(await invoke("kanban_load").catch(() => ""), null);
      if (!b || !Array.isArray(b.cards)) return [];
      const col = new Map((b.columns || []).map((c) => [c.id, c.title]));
      const who = new Map((b.members || []).map((m) => [m.id, m.name]));
      return b.cards.map((c) => ({
        title: c.title || "(sans titre)",
        text: [
          `colonne : ${col.get(c.colId) || c.colId || "?"}`,
          c.assignee ? `assigné à : ${who.get(c.assignee) || c.assignee}` : "",
          (c.labels || []).length ? `étiquettes : ${c.labels.join(", ")}` : "",
          c.desc ? `description : ${c.desc}` : "",
          (c.comments || []).length ? `commentaires : ${c.comments.map((x) => x.text || x.body || x).join(" | ")}` : "",
        ].filter(Boolean).join(" · "),
        when: toMs(c.due),
        date: toMs(c.created),
      }));
    },
  },
  agenda: {
    label: { fr: "Agenda", en: "Calendar" },
    hint: "rendez-vous, évènements, rappels, planning, semaine, demain, date, heure, agendas synchronisés (iCal, Google)",
    async load(invoke) {
      const out = [];
      const rem = parse(await invoke("reminders_load").catch(() => ""), []) || [];
      for (const r of rem) {
        out.push({ title: r.title, text: ["rappel", r.note, r.recur && r.recur !== "none" ? `récurrence : ${r.recur}` : "", r.done ? "fait" : ""].filter(Boolean).join(" · "), when: toMs(r.due_at) });
      }
      // Évènements des agendas externes synchronisés (ext.events.<source>).
      const st = await appState(invoke, "calendar");
      const names = new Map((Array.isArray(st["ext.sources"]) ? st["ext.sources"] : []).map((s) => [s.id, s.name]));
      for (const [k, list] of Object.entries(st)) {
        if (!k.startsWith("ext.events.") || !Array.isArray(list)) continue;
        const src = names.get(k.slice(11)) || "agenda externe";
        for (const e of list) {
          out.push({ title: e.title || "(évènement)", text: [src, e.location ? `lieu : ${e.location}` : "", e.allDay ? "toute la journée" : "", e.end ? `fin : ${dateStr(toMs(e.end))}` : "", e.description ? String(e.description).slice(0, 300) : ""].filter(Boolean).join(" · "), when: toMs(e.start) });
        }
      }
      // Agenda et rappels de l'iPhone, rangés dans le coffre unifié.
      for (const r of (await invoke("datahub_query", { args: { apps: ["iphone"], types: ["event", "task"], limit: 200 } }).catch(() => [])) || []) {
        out.push({ title: r.title, text: [r.type === "task" ? "rappel de l'iPhone" : "agenda de l'iPhone", r.tags, r.place ? `lieu : ${r.place}` : ""].filter(Boolean).join(" · "), when: r.start });
      }
      // Tâches datées des agents (visibles dans l'Agenda).
      for (const a of (await invoke("agent_list").catch(() => [])) || []) {
        for (const t of a.tasks || []) {
          if (t.due && !t.done) out.push({ title: t.text, text: `tâche de l'agent ${a.name}`, when: toMs(t.due) });
        }
      }
      return out;
    },
  },
  messagerie: {
    label: { fr: "Messagerie des agents", en: "Agent messages" },
    hint: "messages, boîte de réception, comptes rendus des agents",
    async load(invoke) {
      const list = parse(await invoke("inbox_load").catch(() => ""), []) || [];
      return list.map((m) => ({ title: m.subject || "(message)", text: [m.from ? `de : ${m.from}` : "", m.read ? "" : "non lu", String(m.body || "").slice(0, 600)].filter(Boolean).join(" · "), date: toMs(m.ts) }));
    },
  },
  contacts: {
    label: { fr: "Contacts", en: "Contacts" },
    hint: "carnet d'adresses, e-mail, téléphone, entreprise",
    async load(invoke) {
      const list = parse(await invoke("contacts_load").catch(() => ""), []) || [];
      return (Array.isArray(list) ? list : []).map((c) => ({ title: c.name || c.email || "(contact)", text: ["email", "phone", "company", "role", "note"].map((k) => (c[k] ? `${k} : ${c[k]}` : "")).filter(Boolean).join(" · ") }));
    },
  },
  notes: {
    label: { fr: "Notes", en: "Notes" },
    hint: "notes écrites dans l'app Notes",
    async load(invoke) {
      const st = await appState(invoke, "notes");
      const list = Array.isArray(st["notes.data"]) ? st["notes.data"] : [];
      return list.map((n) => ({ title: n.title || "(sans titre)", text: String(n.body || "").slice(0, 1500), date: toMs(n.ts) }));
    },
  },
  agents: {
    label: { fr: "Agents", en: "Agents" },
    hint: "agents, rôles, liste de tâches des agents",
    async load(invoke) {
      return ((await invoke("agent_list").catch(() => [])) || []).map((a) => ({
        title: a.name,
        text: [a.role || a.description || "", (a.tasks || []).length ? `tâches : ${a.tasks.map((t) => `${t.done ? "✓" : "•"} ${t.text}`).join(" | ")}` : ""].filter(Boolean).join(" · "),
      }));
    },
  },
  taches_planifiees: {
    label: { fr: "Tâches planifiées", en: "Scheduled tasks" },
    hint: "workflows planifiés, CRON, automatisations récurrentes",
    async load(invoke) {
      return ((await invoke("list_workflow_schedules").catch(() => [])) || []).map((w) => ({
        title: w.name || w.workflow || "(workflow)", text: [w.cron ? `CRON : ${w.cron}` : "", w.enabled === false ? "désactivé" : ""].filter(Boolean).join(" · "),
      }));
    },
  },
};

// Noms d'app-state déjà couverts par un lecteur dédié (ou sans intérêt).
const COVERED = new Set(["notes", "calendar", "scheduler"]);
const APP_LABELS = { studies: "Études", moodboard: "Moodboard", podcast: "Podcast", carte: "Carte", media: "Médias", pdf: "PDF", photos: "Photos", robotstudio: "Robot Studio", scheduler: "Tâches planifiées" };

/** Lecteur générique : tout objet JSON ayant un titre/nom/texte devient un enregistrement. */
async function genericLoad(invoke, name) {
  const st = await appState(invoke, name);
  const out = [];
  const seen = new Set();
  const walk = (v, path, depth) => {
    if (depth > 6 || out.length > 400 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path, depth + 1)); return; }
    if (typeof v !== "object") return;
    const title = v.title ?? v.name ?? v.label ?? v.subject ?? v.question ?? v.front;
    const body = v.text ?? v.body ?? v.content ?? v.description ?? v.desc ?? v.note ?? v.answer ?? v.back ?? v.brief ?? v.summary;
    if ((typeof title === "string" && title.trim()) || (typeof body === "string" && body.trim().length > 20)) {
      const key = `${title}|${String(body).slice(0, 40)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ title: String(title || path || name).slice(0, 160), text: typeof body === "string" ? body.slice(0, 800) : "", date: toMs(v.ts ?? v.updated ?? v.created ?? v.date), when: toMs(v.due ?? v.start ?? v.when) });
      }
    }
    for (const [k, x] of Object.entries(v)) if (x && typeof x === "object") walk(x, k, depth + 1);
  };
  for (const [k, v] of Object.entries(st)) walk(v, k, 0);
  return out;
}

/** Inventaire des sources : lecteurs dédiés + états d'app restants. */
async function sources(invoke, lang) {
  const l = lang === "en" ? "en" : "fr";
  const list = Object.entries(READERS).map(([id, r]) => ({ id, label: r.label[l], hint: r.hint, load: () => r.load(invoke) }));
  const states = ((await invoke("app_state_list").catch(() => [])) || []).filter((s) => !COVERED.has(s.name) && s.bytes > 2);
  for (const s of states) list.push({ id: s.name, label: APP_LABELS[s.name] || s.name, hint: "", load: () => genericLoad(invoke, s.name) });
  return list;
}

function findSource(list, wanted) {
  const w = norm(wanted).replace(/^l.?app(lication)?\s+/, "");
  if (!w) return null;
  const aliases = { calendrier: "agenda", calendar: "agenda", rappels: "agenda", rendezvous: "agenda", kanban: "kanban", tableau: "kanban", board: "kanban", taches: "kanban", inbox: "messagerie", messages: "messagerie", carnet: "contacts", etudes: "studies", cours: "studies" };
  const alias = aliases[w.replace(/[^a-z]/g, "")] || aliases[w.split(/\s+/)[0]];
  return list.find((s) => s.id === alias) || list.find((s) => norm(s.id) === w || norm(s.label) === w)
    || list.find((s) => norm(s.label).includes(w) || w.includes(norm(s.label)) || w.includes(norm(s.id)));
}

// Racine grossière : pluriels et terminaisons courantes tolérés (« réunions »
// trouve « réunion », « rendez-vous » trouve « rendez »), sans dictionnaire.
const stem = (t) => {
  let w = t;
  if (w.length > 4) w = w.replace(/(es|s|x)$/, "");
  if (w.length > 7) w = w.slice(0, w.length - 2);
  return w;
};
function score(rec, ts) {
  if (!ts.length) return 1;
  const title = norm(rec.title), text = norm(rec.text);
  let s = 0;
  for (const t of ts) {
    const r = stem(t);
    if (title.includes(t)) s += 3; else if (title.includes(r)) s += 2;
    if (text.includes(t)) s += 1; else if (text.includes(r)) s += 0.5;
  }
  return s;
}

function format(recs, lang, max = 40) {
  return recs.slice(0, max).map((r, i) => {
    const when = r.when ? ` — ${dateStr(r.when, lang)}` : r.date ? ` (${dateStr(r.date, lang)})` : "";
    return `[${i + 1}] ${r.title}${when}${r.text ? `\n    ${r.text.replace(/\s+/g, " ").slice(0, 400)}` : ""}`;
  }).join("\n") + (recs.length > max ? `\n… (${recs.length - max} de plus : précise ta recherche)` : "");
}

/* ------------------------------------------------------------- Outils */

export const APP_DATA_TOOL_NAMES = new Set(["apps_list", "app_data", "apps_search", "day_overview", "lumen_search"]);

export function buildAppDataTools(lang = "fr") {
  const en = lang === "en";
  const fn = (name, description, properties = {}, required = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
  return [
    fn("day_overview", en
      ? "Everything needed to PLAN a day in one call: calendar events and reminders of that day, overdue reminders, Kanban cards due or in progress, UNREAD e-mails, unread agent messages, pending intentions from memory, and the free time slots. Use it for “plan my day”, “what's on today/tomorrow”, “my agenda”, “what do I have to do”."
      : "Tout ce qu'il faut pour PLANIFIER une journée en un appel : évènements et rappels du jour, rappels en retard, cartes Kanban à échéance ou en cours, e-mails NON LUS, messages d'agents non lus, intentions en mémoire et créneaux libres. À utiliser pour « planifie ma journée », « qu'est-ce que j'ai aujourd'hui / demain », « mon programme », « qu'est-ce que je dois faire ».",
    { date: { type: "string", description: en ? "Day (ISO, e.g. 2026-09-26); default today. “tomorrow” accepted." : "Jour (ISO, ex. 2026-09-26) ; aujourd'hui par défaut. « demain » accepté." } }),
    fn("lumen_search", en
      ? "Searches EVERYWHERE in Lumen at once and never gives up early: all apps (Kanban, Calendar, Notes, Contacts, agents, Studies…), e-mails, memories, indexed documents (Corpus) and personal data / authorized files. Use it whenever the user asks to find something without saying where."
      : "Cherche PARTOUT dans Lumen à la fois : toutes les apps (Kanban, Agenda, Notes, Contacts, agents, Études…), e-mails, souvenirs, documents indexés (Corpus) et données personnelles / fichiers autorisés. À utiliser dès que l'utilisateur veut retrouver quelque chose sans dire où.",
    { query: { type: "string", description: en ? "What to find (names, subjects, dates…)" : "Ce qu'il faut retrouver (noms, sujets, dates…)" } }, ["query"]),
  ];
}

/* ------------------------------------------------ Journée & recherche globale */

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("délai dépassé")), ms))]);
const hm = (ms, lang) => new Date(ms).toLocaleTimeString(lang === "en" ? "en-GB" : "fr-FR", { hour: "2-digit", minute: "2-digit" });

function dayBounds(arg) {
  const a = norm(arg);
  const d = new Date();
  if (/^(demain|tomorrow)/.test(a)) d.setDate(d.getDate() + 1);
  else if (/^(apres.demain|day after)/.test(a)) d.setDate(d.getDate() + 2);
  else if (a && !/^(aujourd|today)/.test(a)) { const t = Date.parse(arg); if (!Number.isNaN(t)) d.setTime(t); }
  d.setHours(0, 0, 0, 0);
  return { start: d.getTime(), end: d.getTime() + 86400000 - 1 };
}

async function dayOverview(invoke, args, lang) {
  const en = lang === "en";
  const { start, end } = dayBounds(args.date);
  const label = new Date(start).toLocaleDateString(en ? "en-GB" : "fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const now = Date.now();
  const part = async (fn) => { try { return await withTimeout(fn(), 15000); } catch (e) { return { error: String(e?.message || e) }; } };
  const [agenda, kanban, mail, inbox, memo] = await Promise.all([
    part(() => READERS.agenda.load(invoke)),
    part(() => READERS.kanban.load(invoke)),
    part(() => invoke("mail_chat_tool", { action: "list", args: { limit: 12, unread_only: true } })),
    part(() => READERS.messagerie.load(invoke)),
    part(() => invoke("mem_recall", { context: "bar", query: en ? "to do intention plan" : "à faire intention prévu", kinds: ["episodic"], limit: 5 })),
  ]);
  const out = [`${en ? "Day" : "Journée"} : ${label}`];
  const failed = [];

  // Agenda : évènements du jour, triés, + rappels en retard.
  const busy = [];
  if (Array.isArray(agenda)) {
    const today = agenda.filter((r) => r.when >= start && r.when <= end).sort((a, b) => a.when - b.when);
    const late = agenda.filter((r) => r.when && r.when < Math.min(start, now) && r.when > start - 14 * 86400000 && /rappel/.test(r.text) && !/fait/.test(r.text));
    out.push(`\n## ${en ? "Calendar" : "Agenda"} (${today.length})`);
    out.push(today.length ? today.map((r) => {
      const allDay = /toute la journ/.test(r.text) || new Date(r.when).getHours() === 0 && new Date(r.when).getMinutes() === 0;
      if (!allDay) busy.push([r.when, r.when + 3600000]);
      return `- ${allDay ? (en ? "all day" : "journée") : hm(r.when, lang)} ${r.title}${r.text ? ` (${r.text.slice(0, 140)})` : ""}`;
    }).join("\n") : (en ? "- nothing scheduled" : "- rien de prévu"));
    if (late.length) out.push(`${en ? "Overdue reminders" : "Rappels en retard"} :\n${late.slice(0, 6).map((r) => `- ${r.title} (${dateStr(r.when, lang)})`).join("\n")}`);
  } else failed.push(en ? "calendar" : "agenda");

  // Kanban : échéances jusqu'à ce jour (hors colonnes terminées) + en cours.
  if (Array.isArray(kanban)) {
    const open = kanban.filter((c) => !/colonne : (termin|fait|done|finished|archiv)/i.test(norm(c.text)));
    const due = open.filter((c) => c.when && c.when <= end).sort((a, b) => a.when - b.when);
    const doing = open.filter((c) => !due.includes(c) && /colonne : (en cours|doing|in progress|a faire|todo|to do)/i.test(norm(c.text)));
    out.push(`\n## Kanban`);
    out.push(due.length ? `${en ? "Due" : "Échéances"} :\n${due.slice(0, 10).map((c) => `- ${c.title} — ${dateStr(c.when, lang)}${c.when < start ? (en ? " (LATE)" : " (EN RETARD)") : ""}`).join("\n")}` : (en ? "- no card due" : "- aucune carte à échéance"));
    if (doing.length) out.push(`${en ? "In progress / to do" : "En cours / à faire"} :\n${doing.slice(0, 8).map((c) => `- ${c.title}`).join("\n")}`);
  } else failed.push("Kanban");

  // Courrier non lu.
  out.push(`\n## ${en ? "Unread e-mails" : "E-mails non lus"}`);
  if (typeof mail === "string") out.push(mail.slice(0, 2500));
  else out.push(en ? "- mailbox unavailable (open the Email app to fetch mail)" : "- boîte indisponible (ouvre l'app Email pour relever le courrier)");

  if (Array.isArray(inbox)) {
    const unread = inbox.filter((m) => /non lu/.test(m.text));
    if (unread.length) out.push(`\n## ${en ? "Unread agent messages" : "Messages d'agents non lus"} (${unread.length})\n${unread.slice(0, 6).map((m) => `- ${m.title}`).join("\n")}`);
  }
  if (Array.isArray(memo) && memo.length) out.push(`\n## ${en ? "Intentions remembered" : "Intentions mémorisées"}\n${memo.map((m) => `- ${m.text}`).join("\n")}`);

  // Créneaux libres entre 8 h et 20 h (à partir de maintenant si c'est aujourd'hui).
  const dayFrom = Math.max(start + 8 * 3600000, now > start && now < end ? now : 0);
  const dayTo = start + 20 * 3600000;
  if (dayFrom < dayTo) {
    busy.sort((a, b) => a[0] - b[0]);
    const free = [];
    let cur = dayFrom;
    for (const [s0, e0] of busy) { if (s0 - cur >= 30 * 60000) free.push([cur, s0]); cur = Math.max(cur, e0); }
    if (dayTo - cur >= 30 * 60000) free.push([cur, dayTo]);
    if (free.length) out.push(`\n## ${en ? "Free slots" : "Créneaux libres"}\n${free.map(([a, b]) => `- ${hm(a, lang)} → ${hm(b, lang)}`).join("\n")}`);
  }
  if (failed.length) out.push(`\n(${en ? "Unavailable" : "Indisponible"} : ${failed.join(", ")})`);
  out.push(en
    ? "\nPropose a concrete time plan for the day from these data (priorities first, overdue items flagged). Offer to add items to the Calendar or Kanban."
    : "\nPropose un planning horaire concret à partir de ces données (priorités d'abord, retards signalés). Propose d'ajouter des éléments à l'Agenda ou au Kanban.");
  return out.join("\n");
}

async function lumenSearch(invoke, query, lang, list) {
  const en = lang === "en";
  const q = String(query || "").trim();
  if (!q) return en ? "Give what to look for." : "Dis ce qu'il faut chercher.";
  let ts = terms(q);
  // Question sans mot utile (« trouve ça ») : on garde les mots bruts.
  if (!ts.length) ts = norm(q).split(/[^a-z0-9@.]+/).filter((w) => w.length >= 2).slice(0, 6);
  const part = async (fn) => { try { return await withTimeout(fn(), 20000); } catch (e) { return { error: String(e?.message || e) }; } };
  const policy = (() => { try { return JSON.parse(localStorage.getItem("aiSandboxPolicy") || "{}") || {}; } catch { return {}; } })();
  const allowed = Object.entries(policy).filter(([, v]) => v === "always").map(([id]) => id);
  const [apps, mail, memo, corpus, personal] = await Promise.all([
    // Applications : coffre unifié (index plein texte de toutes les apps).
    part(async () => ((await invoke("datahub_query", { args: { text: q, limit: 20 } })) || [])
      .map((r) => ({ title: `[${r.app}] ${r.title}`, text: [r.status, r.people, r.place, r.text].filter(Boolean).join(" · "), when: r.start, date: r.updated }))),
    part(() => invoke("mail_chat_tool", { action: "search", args: { query: ts.join(" "), limit: 6 } })),
    part(() => invoke("mem_recall", { context: "bar", query: q, limit: 5 })),
    part(() => invoke("rag_search", { query: q, k: 4 })),
    part(() => invoke("data_search", { query: ts.join(" "), sandboxIds: allowed, includeData: true, limit: 10 })),
  ]);
  const out = [];
  const missing = [];
  if (Array.isArray(apps) && apps.length) out.push(`## ${en ? "Apps" : "Applications"} (${apps.length})\n${format(apps, lang, 15)}`);
  if (typeof mail === "string" && !/^Aucun message|^Requête vide/.test(mail)) out.push(`## E-mails\n${mail.slice(0, 2500)}`);
  else if (mail?.error) missing.push("e-mails");
  if (Array.isArray(memo) && memo.length) out.push(`## ${en ? "Memories" : "Souvenirs"}\n${memo.map((m) => `- [${m.kind}] ${m.text}`).join("\n")}`);
  if (Array.isArray(corpus) && corpus.length) out.push(`## ${en ? "Indexed documents" : "Documents indexés"}\n${corpus.map((h, i) => `[${i + 1}] (${h.title}) ${String(h.text || "").trim().slice(0, 500)}`).join("\n")}`);
  if (Array.isArray(personal) && personal.length) out.push(`## ${en ? "Files & personal data" : "Fichiers et données personnelles"}\n${personal.map((h, i) => `[${i + 1}] ${h.kind} — ${h.title}${h.snippet && h.snippet !== h.title ? ` : ${String(h.snippet).slice(0, 300)}` : ""}`).join("\n")}`);
  else if (personal?.error) missing.push(en ? "files (session locked: use sandbox_search)" : "fichiers (session verrouillée : utilise sandbox_search)");
  if (!out.length) {
    return (en ? `Nothing found for “${q}” in apps, e-mails, memories, documents or authorized files.` : `Rien trouvé pour « ${q} » dans les apps, e-mails, souvenirs, documents ni fichiers autorisés.`)
      + (missing.length ? ` (${en ? "not searched" : "non consulté"} : ${missing.join(", ")})` : "")
      + (en ? " Try other words, or sandbox_search for the other sandboxes." : " Essaie d'autres mots, ou sandbox_search pour les autres sandboxes.");
  }
  if (missing.length) out.push(`(${en ? "not searched" : "non consulté"} : ${missing.join(", ")})`);
  return out.join("\n\n");
}

export async function callAppDataTool(invoke, name, args = {}, { lang = "fr" } = {}) {
  const en = lang === "en";
  // Anciens outils (plus proposés au modèle) : redirigés vers le coffre unifié.
  if (name === "apps_list") return invoke("native_tool_exec", { name: "data_overview", args: {} });
  if (name === "apps_search") return invoke("native_tool_exec", { name: "data_search", args: { query: args.query || "" } });
  if (name === "app_data" && !args.from && !args.to) {
    const app = { calendrier: "agenda", calendar: "agenda", tableau: "kanban", inbox: "messagerie", carnet: "contacts", etudes: "studies" }[norm(args.app)] || norm(args.app);
    return invoke("native_tool_exec", { name: "data_search", args: { query: args.query || "", app } });
  }
  const list = await sources(invoke, lang);

  if (name === "apps_list") {
    const rows = await Promise.all(list.map(async (s) => ({ s, n: (await s.load().catch(() => [])).length })));
    return rows.filter((r) => r.n > 0).map((r) => `- ${r.s.id} (${r.s.label}) : ${r.n} ${en ? "item(s)" : "élément(s)"}${r.s.hint ? ` — ${r.s.hint}` : ""}`).join("\n")
      || (en ? "No app data yet." : "Aucune donnée d'application pour l'instant.");
  }

  if (name === "app_data") {
    const src = findSource(list, args.app);
    if (!src) return (en ? `Unknown app “${args.app}”. Available: ` : `Application « ${args.app} » inconnue. Disponibles : `) + list.map((s) => s.id).join(", ");
    let recs = await src.load().catch((e) => { throw new Error(`${src.label} : ${e?.message || e}`); });
    const from = toMs(args.from), to = toMs(args.to) ? toMs(args.to) + (String(args.to).length <= 10 ? 86399999 : 0) : 0;
    if (from || to) recs = recs.filter((r) => { const t = r.when || r.date; return t && (!from || t >= from) && (!to || t <= to); });
    const ts = terms(args.query);
    recs = recs.map((r) => ({ r, s: score(r, ts) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || ((a.r.when || 0) - (b.r.when || 0))).map((x) => x.r);
    // Agenda sans filtre : ordre chronologique à partir d'aujourd'hui d'abord.
    if (!ts.length && recs.some((r) => r.when)) {
      const now = Date.now() - 86400000;
      recs.sort((a, b) => ((a.when || 0) < now) - ((b.when || 0) < now) || (a.when || 0) - (b.when || 0));
    }
    if (!recs.length) return `${src.label} : ${en ? "nothing matches." : "rien ne correspond."}`;
    return `${src.label} (${recs.length}) :\n${format(recs, lang)}`;
  }

  if (name === "day_overview") return dayOverview(invoke, args, lang);
  if (name === "lumen_search") return lumenSearch(invoke, args.query, lang, list);

  if (name === "apps_search") {
    const ts = terms(args.query);
    if (!ts.length) return en ? "Give keywords." : "Donne des mots-clés.";
    const all = [];
    await Promise.all(list.map(async (s) => {
      for (const r of await s.load().catch(() => [])) {
        const sc = score(r, ts);
        if (sc > 0) all.push({ r: { ...r, title: `[${s.label}] ${r.title}` }, sc });
      }
    }));
    all.sort((a, b) => b.sc - a.sc);
    if (!all.length) return en ? "Nothing found in the apps." : "Rien trouvé dans les applications.";
    return format(all.map((x) => x.r), lang, 25);
  }
  throw new Error(`Outil inconnu : ${name}`);
}


/**
 * Données compactes d'une journée pour les petits écrans (orbe M5 Fire) :
 * { events:[{time,label,at}], mails:[{uid,from,subject}], due:[{label,late}] }.
 */
export async function collectDayItems(invoke, date) {
  const { start, end } = dayBounds(date);
  const safe = async (fn, fb) => { try { return await withTimeout(fn(), 15000); } catch { return fb; } };
  const [agenda, kanban, mailText] = await Promise.all([
    safe(() => READERS.agenda.load(invoke), []),
    safe(() => READERS.kanban.load(invoke), []),
    safe(() => invoke("mail_chat_tool", { action: "list", args: { limit: 10, unread_only: true } }), ""),
  ]);
  const p2 = (x) => String(x).padStart(2, "0");
  const events = agenda
    .filter((r) => r.when >= start && r.when <= end && !/fait/.test(r.text))
    .sort((a, b) => a.when - b.when)
    .slice(0, 10)
    .map((r) => { const d = new Date(r.when); return { time: `${p2(d.getHours())}:${p2(d.getMinutes())}`, label: r.title, at: r.when }; });
  const mails = [...String(mailText || "").matchAll(/^- uid (\d+) · [^·]* · de (.+?) · « (.+?) »/gm)]
    .map((m) => ({ uid: Number(m[1]), from: m[2].replace(/\s*<[^>]*>/, "").trim(), subject: m[3] }));
  const due = kanban
    .filter((c) => c.when && c.when <= end && !/colonne : (termin|fait|done|finished|archiv)/.test(norm(c.text)))
    .sort((a, b) => a.when - b.when)
    .slice(0, 8)
    .map((c) => ({ label: c.title, late: c.when < start }));
  return { events, mails, due };
}
