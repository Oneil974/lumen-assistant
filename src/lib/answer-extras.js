// Sous une réponse de l'IA (barre et bureau) :
//   • SOURCES cliquables : d'où viennent les informations (fichier, note,
//     Kanban, Agenda, base, page web…) — un clic ouvre l'élément dans Lumen ;
//   • SUITES proposées en un clic : « Ajouter au Kanban », « Créer un rappel »
//     (seulement si la réponse contient une date), « Envoyer au téléphone ».
// Les sources sont déduites des appels d'outils réellement faits : ce ne sont
// pas des citations que le modèle pourrait inventer.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const APP_IDS = {
  kanban: "kanban", tableau: "kanban", agenda: "calendar", calendrier: "calendar", calendar: "calendar",
  messagerie: "inbox", inbox: "inbox", contacts: "contacts", notes: "notes", agents: "agents",
  taches_planifiees: "scheduler", scheduler: "scheduler", studies: "studies", etudes: "studies",
  moodboard: "moodboard", podcast: "podcast", carte: "carte", media: "media", photos: "photos",
};
const APP_LABELS = {
  fr: { kanban: "Kanban", calendar: "Agenda", inbox: "Messagerie", contacts: "Contacts", notes: "Notes", agents: "Agents", scheduler: "Tâches planifiées", studies: "Études", moodboard: "Moodboard", podcast: "Podcast", tables: "Bases de données", knowledge: "Corpus", carte: "Carte", media: "Médias", photos: "Photos" },
  en: { kanban: "Kanban", calendar: "Calendar", inbox: "Messages", contacts: "Contacts", notes: "Notes", agents: "Agents", scheduler: "Scheduled tasks", studies: "Studies", moodboard: "Moodboard", podcast: "Podcast", tables: "Databases", knowledge: "Corpus", carte: "Map", media: "Media", photos: "Photos" },
};
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/**
 * Sources d'une réponse d'après ses appels d'outils ({ name, args, input, result }).
 * @returns {Array<{ icon:string, label:string, open:object }>}
 */
export function sourcesFromToolNotes(notes = [], lang = "fr") {
  const L = APP_LABELS[lang === "en" ? "en" : "fr"];
  const out = [];
  const add = (s) => { if (!out.some((x) => x.label === s.label)) out.push(s); };
  for (const n of notes || []) {
    const a = n.args || {};
    const r = String(n.result || "");
    if (/^(Erreur|Error|L'utilisateur a refusé|Accès refusé)/.test(r.trim())) continue;
    switch (n.name) {
      case "sandbox_read": {
        // Première ligne : « Sandbox/chemin (…) : »
        const m = r.match(/^([^/\n]+)\/([^\n]+?)(?: \(|\s—| :)/);
        if (m) add({ icon: "file-text", label: `${m[1]}/${m[2]}`, open: { kind: "file", sandbox: m[1], path: m[2] } });
        break;
      }
      case "notes_read": {
        const t = r.match(/^# (.+?) —/)?.[1] || a.title;
        if (t) add({ icon: "notes", label: `${L.notes} · ${t}`, open: { kind: "note", title: t } });
        break;
      }
      case "notes_search": add({ icon: "notes", label: L.notes, open: { kind: "app", app: "notes" } }); break;
      case "app_data": {
        const id = APP_IDS[norm(a.app).replace(/^l.?app(lication)?\s+/, "").replace(/[^a-z_]/g, "")] || norm(a.app);
        add({ icon: id === "kanban" ? "kanban" : id === "calendar" ? "calendar" : "layout-grid", label: L[id] || a.app, open: { kind: "app", app: id } });
        break;
      }
      case "apps_search": {
        for (const m of r.matchAll(/\[([^\]]+)\]/g)) {
          const id = Object.entries(L).find(([, v]) => v === m[1])?.[0];
          if (id) add({ icon: "layout-grid", label: L[id], open: { kind: "app", app: id } });
        }
        break;
      }
      case "query_tables": case "tables_list": {
        const base = r.match(/Base « ([^»]+) »/)?.[1] || a.base;
        add({ icon: "database", label: base ? `${L.tables} · ${base}` : L.tables, open: { kind: "app", app: "tables" } });
        break;
      }
      case "search_documents": add({ icon: "book-open-text", label: L.knowledge, open: { kind: "app", app: "knowledge" } }); break;
      case "web_read_page": if (a.url) add({ icon: "globe", label: String(a.url).replace(/^https?:\/\/(www\.)?/, "").slice(0, 60), open: { kind: "url", url: a.url } }); break;
      case "web_search": {
        for (const m of r.matchAll(/https?:\/\/[^\s)\]]+/g)) {
          if (out.length > 6) break;
          add({ icon: "globe", label: m[0].replace(/^https?:\/\/(www\.)?/, "").split("/")[0], open: { kind: "url", url: m[0] } });
        }
        break;
      }
      case "weather_now": add({ icon: "cloud-sun", label: lang === "en" ? `Weather · ${a.place || ""}` : `Météo · ${a.place || ""}`, open: null }); break;
      default: break;
    }
  }
  return out.slice(0, 8);
}

// La réponse parle-t-elle d'une date / heure (pour proposer un rappel) ?
const DATE_RE = /\b(\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?|\d{1,2}\s?h(\d{2})?|\d{1,2}:\d{2}|(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|apres-demain|janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|january|february|march|april|june|july|august|september|october|november|december))\b/;

// La réponse locale a-t-elle échoué ? Sert au mode hybride : proposer l'API
// cloud plutôt que des suites (« Ajouter au Kanban ») sur une réponse qui n'a
// rien donné. Échec =
//   • réponse vide ;
//   • un appel d'outil en ERREUR (exception, outil inconnu, JSON `error`,
//     arguments invalides) — un refus de l'utilisateur n'en est pas un ;
//   • toutes les recherches (fichiers, notes, données, web…) revenues VIDES ;
//   • aveu d'échec du modèle dans une réponse courte.
const FAIL_RE = /\b(je n.ai (pas|rien) (pu|reussi|trouve)|je ne (peux|parviens|suis pas en mesure|trouve (pas|aucun))|impossible de|aucun (resultat|fichier|document|element)|une erreur (s.est produite|est survenue)|desole|i (could ?n.t|cannot|can.t|was unable|am unable|did ?n.t find)|unable to|no (results?|matching|files?) (found|for)|an error occurred|sorry)\b/;
const TOOL_ERR_RE = /^(erreur|error|echec|failed|failure|exception|outil inconnu|unknown tool|tool not found|invalid arguments?|arguments? invalides?|timeout|delai depasse|panicked)\b|"error"\s*:|\b(erreur|error)\s*:/;
const TOOL_REFUSED_RE = /^(l.utilisateur a refuse|acces refuse|the user (declined|refused)|access denied)/;
const TOOL_EMPTY_RE = /^(\[\s*\]|\{\s*\})$|^(null|none|aucun|aucune|rien|0 (resultat|fichier|element|ligne)|pas de (resultat|fichier|correspondance)|introuvable|no (results?|match|matches|files?|records?|rows?|entries)|nothing found|not found|empty)\b|(aucun|aucune) (resultat|fichier|document|correspondance|element|ligne|note|message|enregistrement) (trouve|ne correspond)|\b(introuvable|not found|0 results?)\b/;
const SEARCH_TOOL_RE = /(search|recherch|find|query|lookup|recall|_list|list_|read|lire|data_|tables|files?|grep|glob|web_)/;

/** Résultat d'un appel d'outil : "error" | "empty" | "refused" | "ok". */
export function toolOutcome(note) {
  const r = norm(typeof note?.result === "string" ? note.result : JSON.stringify(note?.result ?? ""));
  if (note?.error || note?.ok === false) return "error";
  if (TOOL_REFUSED_RE.test(r)) return "refused";
  if (!r || r === '""') return "empty";
  if (TOOL_ERR_RE.test(r.slice(0, 300))) return "error";
  if (r.length < 300 && TOOL_EMPTY_RE.test(r)) return "empty";
  return "ok";
}

export function looksFailed(text, notes = []) {
  const t = norm(String(text || "").replace(/<[^>]+>/g, " "));
  if (!t || t === "(reponse vide)") return true;
  const outcomes = (notes || []).map((n) => ({ n, o: toolOutcome(n) }));
  if (outcomes.some((x) => x.o === "error")) return true;
  const searches = outcomes.filter((x) => SEARCH_TOOL_RE.test(String(x.n?.name || "")) && x.o !== "refused");
  if (searches.length && searches.every((x) => x.o === "empty")) return true;
  // Un aveu d'échec dans une réponse courte ; une longue réponse qui s'excuse
  // en passant a, elle, livré quelque chose.
  return t.length < 400 && FAIL_RE.test(t);
}

const TXT = {
  fr: { sources: "Sources", escalate: "Réessayer avec l'API cloud", escalateHint: "La réponse locale n'a pas abouti : le modèle API reprend la demande.", kanban: "Ajouter au Kanban", reminder: "Créer un rappel", phone: "Envoyer au téléphone", sent: "Envoyé ✓",
    pKanban: "Ajoute au Kanban les tâches ou actions qui ressortent de ta dernière réponse.", pReminder: "Crée dans l'Agenda un rappel pour ce qui est daté dans ta dernière réponse." },
  en: { sources: "Sources", escalate: "Retry with the cloud API", escalateHint: "The local answer fell short: the API model takes the request again.", kanban: "Add to Kanban", reminder: "Create a reminder", phone: "Send to phone", sent: "Sent ✓",
    pKanban: "Add to the Kanban the tasks or actions from your last answer.", pReminder: "Create a Calendar reminder for what is dated in your last answer." },
};

/**
 * Pose sources + suites sous une réponse.
 * @param {HTMLElement} host
 * @param {{ text:string, notes?:Array, lang?:string, icon?:(name:string)=>string,
 *   onOpen:(open:object)=>void, onPrompt:(text:string)=>void, onPhone?:(text:string)=>Promise<void> }} o
 */
function ensureCss(doc) {
  if (doc.getElementById("lm-stream-css")) return;
  const link = doc.createElement("link");
  link.id = "lm-stream-css";
  link.rel = "stylesheet";
  link.href = new URL("./stream-view.css", import.meta.url).href;
  doc.head.appendChild(link);
}

export function renderAnswerExtras(host, o) {
  if (!host || (!o?.text && !o?.onEscalate)) return;
  o = { ...o, text: String(o.text || "") };
  ensureCss(host.ownerDocument || document);
  const lang = o.lang === "en" ? "en" : "fr";
  const T = TXT[lang];
  const icon = o.icon || (() => "");
  host.querySelector(":scope > .ax-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "ax-wrap";
  const sources = sourcesFromToolNotes(o.notes, lang);
  if (sources.length) {
    const row = document.createElement("div");
    row.className = "ax-sources";
    row.innerHTML = `<span class="ax-cap">${esc(T.sources)}</span>`;
    sources.forEach((s) => {
      const b = document.createElement(s.open ? "button" : "span");
      b.className = "ax-src";
      b.innerHTML = `${icon(s.icon)}<span>${esc(s.label)}</span>`;
      if (s.open) { b.type = "button"; b.title = s.label; b.addEventListener("click", () => o.onOpen(s.open)); }
      row.appendChild(b);
    });
    wrap.appendChild(row);
  }
  // Mode hybride : échec local + API configurée → une seule suite, l'escalade.
  if (o.onEscalate) {
    const row = document.createElement("div");
    row.className = "ax-next";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ax-chip ax-escalate";
    b.title = T.escalateHint;
    b.innerHTML = `${icon("cloud")}<span>${esc(T.escalate)}</span>`;
    b.addEventListener("click", () => { b.disabled = true; o.onEscalate(); });
    row.appendChild(b);
    wrap.appendChild(row);
  } else if (o.text.length > 60) {
  // Suites : seulement pour une vraie réponse (pas une salutation).
    const row = document.createElement("div");
    row.className = "ax-next";
    const chip = (label, ic, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ax-chip";
      b.innerHTML = `${icon(ic)}<span>${esc(label)}</span>`;
      b.addEventListener("click", () => fn(b));
      row.appendChild(b);
    };
    chip(T.kanban, "kanban", () => o.onPrompt(T.pKanban));
    if (DATE_RE.test(norm(o.text))) chip(T.reminder, "calendar", () => o.onPrompt(T.pReminder));
    if (o.onPhone) chip(T.phone, "smartphone", async (b) => {
      b.disabled = true;
      try { await o.onPhone(o.text); b.querySelector("span").textContent = T.sent; } catch { b.disabled = false; }
    });
    wrap.appendChild(row);
  }
  if (wrap.childElementCount) host.appendChild(wrap);
}
