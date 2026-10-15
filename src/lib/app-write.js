// ÉCRITURE dans les applications, toujours avec la confirmation de
// l'utilisateur (même carte que la domotique, cf. lib/user-gate.js) :
//   kanban_add_card   — une carte dans une colonne du Kanban ;
//   agenda_add_event  — un rendez-vous / rappel daté dans l'Agenda ;
//   notes_create      — une nouvelle note dans Notes ;
//   notes_append      — un ajout à la fin d'une note existante.
// Les apps ouvertes se mettent à jour d'elles-mêmes : le Kanban par son
// évènement `kanban-updated`, Notes par `app-state-changed`.

const tauri = () => window.__TAURI__ || window.parent?.__TAURI__;
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const APP_WRITE_TOOL_NAMES = new Set(["kanban_add_card", "agenda_add_event", "notes_create", "notes_append"]);

export function buildAppWriteTools(lang = "fr") {
  const en = lang === "en";
  const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
  return [
    fn("kanban_add_card", en
      ? "Adds a card to the user's Kanban board (asks for confirmation). Use only when the user asks to add/create a task or card."
      : "Ajoute une carte au tableau Kanban de l'utilisateur (demande confirmation). À utiliser seulement quand l'utilisateur demande d'ajouter / créer une tâche ou une carte.",
    {
      title: { type: "string", description: en ? "Card title" : "Titre de la carte" },
      column: { type: "string", description: en ? "Column name (default: the first one)" : "Nom de la colonne (défaut : la première)" },
      description: { type: "string", description: en ? "Optional details" : "Détails facultatifs" },
      due: { type: "string", description: en ? "Optional due date (ISO)" : "Échéance facultative (ISO)" },
      labels: { type: "string", description: en ? "Optional labels, comma-separated" : "Étiquettes facultatives, séparées par des virgules" },
    }, ["title"]),
    fn("agenda_add_event", en
      ? "Adds a dated event / reminder to the user's Calendar (asks for confirmation). Compute the date from today's date."
      : "Ajoute un rendez-vous / rappel daté à l'Agenda de l'utilisateur (demande confirmation). Calcule la date à partir de la date du jour.",
    {
      title: { type: "string", description: en ? "Event title" : "Intitulé" },
      start: { type: "string", description: en ? "Date and time, ISO 8601 local (e.g. 2026-10-02T14:30)" : "Date et heure, ISO 8601 locale (ex. 2026-10-02T14:30)" },
      note: { type: "string", description: en ? "Optional details (place, people…)" : "Détails facultatifs (lieu, personnes…)" },
      recur: { type: "string", enum: ["none", "daily", "weekly", "monthly"], description: en ? "Recurrence" : "Récurrence" },
    }, ["title", "start"]),
    fn("notes_create", en
      ? "Creates a new note in the Notes app (asks for confirmation)."
      : "Crée une nouvelle note dans l'app Notes (demande confirmation).",
    {
      title: { type: "string", description: en ? "Note title" : "Titre de la note" },
      body: { type: "string", description: en ? "Note content (Markdown)" : "Contenu de la note (Markdown)" },
    }, ["title", "body"]),
    fn("notes_append", en
      ? "Appends text at the end of an existing note of the Notes app (asks for confirmation)."
      : "Ajoute du texte à la fin d'une note existante de l'app Notes (demande confirmation).",
    {
      title: { type: "string", description: en ? "Title of the existing note" : "Titre de la note existante" },
      text: { type: "string", description: en ? "Text to append" : "Texte à ajouter" },
    }, ["title", "text"]),
  ];
}

const fmtDate = (ms, en) => new Date(ms).toLocaleString(en ? "en-GB" : "fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

async function loadNotesState(invoke) {
  const raw = await invoke("app_state_load", { name: "notes" }).catch(() => "");
  const obj = raw ? JSON.parse(raw) : {};
  const list = typeof obj["notes.data"] === "string" ? JSON.parse(obj["notes.data"]) : (obj["notes.data"] || []);
  return { obj, list: Array.isArray(list) ? list : [] };
}
async function saveNotesState(invoke, obj, list) {
  obj["notes.data"] = JSON.stringify(list);
  await invoke("app_state_save", { name: "notes", data: JSON.stringify(obj) });
  // L'app Notes ouverte recharge ses notes (cf. lib/app-state.js).
  tauri()?.event?.emit?.("app-state-changed", { name: "notes" }).catch?.(() => {});
}

/**
 * @param {Function} invoke
 * @param {string} name
 * @param {object} args
 * @param {{ gate: object, lang?: string }} ctx
 */
export async function callAppWriteTool(invoke, name, args = {}, { gate, lang = "fr" } = {}) {
  const en = lang === "en";
  if (!gate) return en ? "Writing is not available here." : "Écriture indisponible ici.";
  const refused = en ? "The user declined. Nothing was changed; say so." : "L'utilisateur a refusé. Rien n'a été modifié ; dis-le.";

  if (name === "kanban_add_card") {
    const board = JSON.parse((await invoke("kanban_load").catch(() => "")) || "null");
    if (!board || !Array.isArray(board.columns) || !board.columns.length) return en ? "The Kanban board has no column yet." : "Le tableau Kanban n'a encore aucune colonne.";
    const w = norm(args.column);
    const col = (w && (board.columns.find((c) => norm(c.title) === w) || board.columns.find((c) => norm(c.title).includes(w) || w.includes(norm(c.title))))) || board.columns[0];
    const due = args.due ? Date.parse(args.due) : NaN;
    const labels = String(args.labels || "").split(",").map((x) => x.trim()).filter(Boolean);
    const ok = await gate.confirm({
      title: en ? `Add to Kanban (${col.title}): “${args.title}”` : `Ajouter au Kanban (${col.title}) : « ${args.title} »`,
      body: [args.description, Number.isFinite(due) ? `${en ? "Due" : "Échéance"} : ${fmtDate(due, en)}` : "", labels.length ? labels.join(", ") : ""].filter(Boolean).join(" · "),
      spoken: en ? `add “${args.title}” to your Kanban` : `ajouter « ${args.title} » à ton Kanban`,
    });
    if (!ok) return refused;
    board.cards = Array.isArray(board.cards) ? board.cards : [];
    board.cards.push({
      id: uid(), colId: col.id, title: String(args.title).trim(), desc: String(args.description || ""),
      assignee: "", agentId: "", due: Number.isFinite(due) ? due : null, file: null, labels, comments: [],
      aiProcessed: false, created: Date.now(), order: board.cards.filter((c) => c.colId === col.id).length,
    });
    await invoke("kanban_save", { data: JSON.stringify(board), origin: "lumen-ai" });
    return en ? `Card “${args.title}” added to the “${col.title}” column.` : `Carte « ${args.title} » ajoutée dans la colonne « ${col.title} ».`;
  }

  if (name === "agenda_add_event") {
    const due = Date.parse(String(args.start || ""));
    if (Number.isNaN(due)) return en ? "Invalid date: give start as ISO 8601 (e.g. 2026-10-02T14:30)." : "Date invalide : donne start au format ISO 8601 (ex. 2026-10-02T14:30).";
    const recur = ["daily", "weekly", "monthly"].includes(args.recur) ? args.recur : "none";
    const ok = await gate.confirm({
      title: en ? `Add to Calendar: “${args.title}” — ${fmtDate(due, en)}` : `Ajouter à l'Agenda : « ${args.title} » — ${fmtDate(due, en)}`,
      body: [args.note, recur !== "none" ? (en ? `repeats ${recur}` : `récurrence : ${recur}`) : ""].filter(Boolean).join(" · "),
      spoken: en ? `add “${args.title}” on ${fmtDate(due, en)}` : `ajouter « ${args.title} » le ${fmtDate(due, en)}`,
    });
    if (!ok) return refused;
    await invoke("reminder_add", { title: String(args.title).trim(), note: String(args.note || ""), dueAt: due, recur, source: "ai" });
    return en ? `Added to the Calendar: “${args.title}”, ${fmtDate(due, en)}.` : `Ajouté à l'Agenda : « ${args.title} », ${fmtDate(due, en)}.`;
  }

  if (name === "notes_create") {
    const ok = await gate.confirm({
      title: en ? `Create the note “${args.title}”` : `Créer la note « ${args.title} »`,
      body: String(args.body || "").slice(0, 280),
      spoken: en ? `create the note “${args.title}”` : `créer la note « ${args.title} »`,
    });
    if (!ok) return refused;
    const { obj, list } = await loadNotesState(invoke);
    list.unshift({ id: uid(), title: String(args.title).trim(), body: String(args.body || ""), ts: Date.now(), history: [] });
    await saveNotesState(invoke, obj, list);
    return en ? `Note “${args.title}” created.` : `Note « ${args.title} » créée.`;
  }

  if (name === "notes_append") {
    const { obj, list } = await loadNotesState(invoke);
    const w = norm(args.title);
    const note = list.find((n) => norm(n.title) === w) || list.find((n) => norm(n.title).includes(w) || (w && w.includes(norm(n.title)) && norm(n.title).length > 2));
    if (!note) return (en ? `No note titled “${args.title}”. Notes: ` : `Aucune note intitulée « ${args.title} ». Notes : `) + list.slice(0, 20).map((n) => n.title).join(", ");
    const ok = await gate.confirm({
      title: en ? `Append to the note “${note.title}”` : `Compléter la note « ${note.title} »`,
      body: String(args.text || "").slice(0, 280),
      spoken: en ? `add to the note “${note.title}”` : `compléter la note « ${note.title} »`,
    });
    if (!ok) return refused;
    // Version précédente gardée dans l'historique de la note (comme l'app).
    note.history = Array.isArray(note.history) ? note.history : [];
    note.history.unshift({ ts: note.ts || Date.now(), title: note.title || "", body: note.body || "" });
    if (note.history.length > 30) note.history.length = 30;
    note.body = `${String(note.body || "").replace(/\s+$/, "")}\n\n${String(args.text || "")}`;
    note.ts = Date.now();
    await saveNotesState(invoke, obj, list);
    return en ? `Text added to the note “${note.title}”.` : `Texte ajouté à la note « ${note.title} ».`;
  }
  throw new Error(`Outil inconnu : ${name}`);
}
