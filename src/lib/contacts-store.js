// Carnet d'adresses partagé : lecture, écriture et FUSION des sources.
//
// Le magasin de vérité est `contacts.json` (contacts.rs). Les autres sources —
// correspondants du courrier, clients de Relia, pairs Telegram — ne sont pas
// recopiées d'office : on les propose, et ce qui est retenu devient une fiche.
// Sans cela, le carnet se remplirait de tous les expéditeurs de newsletters.
//
// Utilisé par l'app Contacts et par l'app Email (autocomplétion du « À »).

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;

export const ORIGIN_LABELS = {
  manual: "Saisi à la main",
  mail: "Courrier",
  crm: "Relia",
  telegram: "Telegram",
  directory: "Annuaire",
};

// ---- Personne partagée entre Contacts, Annuaire et Relia -------------------
// L'`id` de la fiche est l'IDENTIFIANT COMMUN d'une personne. Chaque app qui la
// connaît y dépose un LIEN (`links: [{ app, ref }]`) plutôt qu'une copie, et un
// CONTEXTE dit à quel titre on la connaît. Les informations restent rangées
// par contexte (`fields.<contexte>`) : ce qui est commercial (Relia) ne se
// mélange pas au personnel, et l'app Contacts n'affiche un contexte qu'à qui
// y a droit.
export const CONTEXTS = {
  personal: "Personnel",
  team: "Équipe",
  client: "Client",
};
const CONTEXT_OF_ORIGIN = { manual: "personal", mail: "personal", telegram: "personal", crm: "client", directory: "team" };
const LINK_APP_OF_ORIGIN = { crm: "relia", directory: "directory", mail: "mail", telegram: "telegram" };

/** Contextes d'une fiche (les anciennes fiches n'en ont pas : on les déduit). */
export function contextsOf(c) {
  const list = Array.isArray(c?.contexts) && c.contexts.length ? c.contexts : [CONTEXT_OF_ORIGIN[c?.origin] || "personal"];
  return [...new Set(list)];
}

/** Fiche vue dans un contexte donné : les champs propres aux AUTRES contextes sont retirés. */
export function viewFor(c, allowed = Object.keys(CONTEXTS)) {
  const fields = c.fields || {};
  const visible = Object.fromEntries(Object.entries(fields).filter(([ctx]) => allowed.includes(ctx)));
  return { ...c, fields: visible, contexts: contextsOf(c).filter((x) => allowed.includes(x)) };
}

/** Retrouve la personne liée à une fiche d'une app (`relia`, `directory`…). */
export function findByLink(list, app, ref) {
  return list.find((c) => (c.links || []).some((l) => l.app === app && String(l.ref) === String(ref)));
}

/**
 * Doublons probables : mêmes adresse, numéro ou nom complet. Renvoie des
 * groupes d'au moins deux fiches, à fusionner par l'utilisateur (jamais
 * d'office : deux « Marie Martin » peuvent être deux personnes).
 */
export function duplicateGroups(list) {
  const groups = new Map();
  const add = (key, c) => { if (!key) return; const g = groups.get(key) || []; if (!g.includes(c)) g.push(c); groups.set(key, g); };
  for (const c of list) {
    add(normEmail(c.email) && `e:${normEmail(c.email)}`, c);
    add(normPhone(c.phone).length >= 6 && `p:${normPhone(c.phone)}`, c);
    add(String(c.name || "").trim().toLowerCase().split(/\s+/).length >= 2 && `n:${String(c.name).trim().toLowerCase()}`, c);
  }
  const seen = new Set();
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const key = g.map((c) => c.id).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/** Fusionne `other` dans `keep` (liens, contextes, champs non vides). */
export function mergePeople(list, keepId, otherId) {
  const keep = list.find((c) => c.id === keepId);
  const other = list.find((c) => c.id === otherId);
  if (!keep || !other || keep === other) return list;
  const merged = { ...keep };
  for (const [k, v] of Object.entries(other)) {
    if (["id", "links", "contexts", "fields"].includes(k)) continue;
    if ((merged[k] === "" || merged[k] == null) && v !== "" && v != null) merged[k] = v;
  }
  merged.links = unionLinks(keep.links, other.links);
  merged.contexts = [...new Set([...contextsOf(keep), ...contextsOf(other)])];
  merged.fields = mergeFields(keep.fields, other.fields);
  merged.updated_at = Date.now();
  return list.filter((c) => c.id !== otherId).map((c) => (c.id === keepId ? merged : c));
}

function unionLinks(a = [], b = []) {
  const out = [...a];
  for (const l of b) if (!out.some((x) => x.app === l.app && String(x.ref) === String(l.ref))) out.push(l);
  return out;
}
function mergeFields(a = {}, b = {}) {
  const out = { ...a };
  for (const [ctx, f] of Object.entries(b)) out[ctx] = { ...(f || {}), ...(out[ctx] || {}) };
  return out;
}

/** Normalise une adresse pour la comparaison (c'est la clé de dédoublonnage). */
export function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

/** Normalise un numéro : seuls les chiffres comptent pour comparer. */
export function normPhone(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

/** Clé d'identité d'une fiche : l'adresse, sinon le numéro, sinon le nom. */
export function identityKey(c) {
  return normEmail(c.email) || normPhone(c.phone) || String(c.name || "").trim().toLowerCase();
}

/**
 * Sépare « Nom Prénom <a@b.c> » en { name, email }. C'est la forme que
 * renvoient les en-têtes de courrier, et celle que les gens tapent.
 */
export function parseAddress(raw) {
  const s = String(raw || "").trim();
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
  if (m) return { name: m[1].replace(/^["']|["']$/g, "").trim(), email: m[2].trim() };
  if (s.includes("@")) return { name: "", email: s };
  return { name: s, email: "" };
}

export async function loadContacts() {
  try {
    const raw = await invoke("contacts_load");
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export async function saveContacts(list) {
  await invoke("contacts_save", { data: JSON.stringify(list) });
}

/** Ajoute ou met à jour une fiche, en fusionnant sur la clé d'identité. */
export function upsertContact(list, incoming) {
  const key = identityKey(incoming);
  if (!key) return list;
  const at = list.findIndex((c) => identityKey(c) === key);
  const now = Date.now();
  const origin = incoming.origin || "manual";
  const ctx = CONTEXT_OF_ORIGIN[origin] || "personal";
  const link = incoming.ref != null && LINK_APP_OF_ORIGIN[origin] ? [{ app: LINK_APP_OF_ORIGIN[origin], ref: String(incoming.ref) }] : [];
  const { ref: _ref, ...data } = incoming;
  if (at < 0) {
    return [...list, { id: "ct-" + now.toString(36) + Math.random().toString(36).slice(2, 6), origin: "manual", ...data, contexts: [ctx], links: link, updated_at: now }];
  }
  // Fusion conservatrice : on ne remplace jamais une valeur renseignée par un
  // vide. Une fiche enrichie par le courrier ne doit pas perdre son téléphone.
  // L'origine d'une fiche existante ne change pas : on AJOUTE un contexte.
  const merged = { ...list[at] };
  for (const [k, v] of Object.entries(data)) {
    if (k === "origin" && merged.origin) continue;
    if (v !== "" && v != null && v !== false) merged[k] = v;
  }
  merged.contexts = [...new Set([...contextsOf(list[at]), ctx])];
  merged.links = unionLinks(list[at].links, link);
  merged.updated_at = now;
  const next = list.slice();
  next[at] = merged;
  return next;
}

/**
 * Personnes rencontrées dans le courrier reçu, telles quelles — sans écrire
 * quoi que ce soit. L'app Contacts les présente comme des suggestions.
 */
export async function suggestionsFromMail() {
  let messages = [];
  try {
    const raw = await invoke("mail_load");
    messages = raw ? JSON.parse(raw) : [];
  } catch { return []; }
  const seen = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    const { name, email } = parseAddress(m.from);
    const key = normEmail(email);
    if (!key || seen.has(key)) continue;
    seen.set(key, { name: name || email, email, origin: "mail", note: "" });
  }
  return [...seen.values()];
}

/** Membres de l'équipe (Annuaire d'un Lumen Server lié), s'il y en a un. */
export async function suggestionsFromDirectory() {
  try {
    const { directory, serverState } = await import("./netserver.js");
    const st = await serverState?.();
    if (st && !(st.linked ?? st.url)) return [];
    return ((await directory()) || []).map((p) => ({
      ref: p.id,
      name: p.display_name || p.name || "",
      email: p.email || "",
      phone: "",
      role: p.role || "",
      origin: "directory",
    })).filter((c) => identityKey(c));
  } catch { return []; }
}

/**
 * Clients de Relia. L'import est DYNAMIQUE : le carnet ne doit
 * pas dépendre d'une app qui n'existe pas dans toutes les éditions, ni charger
 * la couche Tables quand personne ne le demande.
 */
export async function suggestionsFromCrm() {
  try {
    const crm = await import("../crm/store.js");
    if (!crm.hasBackend?.()) return [];
    await crm.ensureSchema();
    const rows = await crm.list("clients");
    return (rows || []).map((r) => ({
      // Le contact nommé de la fiche prime sur la raison sociale : c'est à lui
      // qu'on écrit.
      ref: r._id ?? r.id ?? r["Nom"],
      name: r["Contact"] || r["Nom"] || "",
      email: r["Email"] || "",
      phone: r["Téléphone"] || "",
      company: r["Nom"] || "",
      role: r["Type"] || "",
      origin: "crm",
    })).filter((c) => identityKey(c));
  } catch { return []; }
}

/** Correspondants Telegram appairés (liste blanche de la passerelle). */
export async function suggestionsFromTelegram() {
  try {
    const st = await invoke("telegram_status");
    return (st?.chats || []).map((p) => ({
      name: p.name || String(p.id || ""),
      email: "", phone: "",
      note: "Telegram #" + (p.id ?? ""),
      origin: "telegram",
    })).filter((c) => identityKey(c));
  } catch { return []; }
}

/**
 * Toutes les suggestions, dédoublonnées entre elles ET contre le carnet.
 * Renvoie uniquement ce qui n'y figure pas encore.
 */
export async function gatherSuggestions(existing) {
  const known = new Set(existing.map(identityKey).filter(Boolean));
  const all = (await Promise.all([
    suggestionsFromMail(), suggestionsFromCrm(), suggestionsFromTelegram(), suggestionsFromDirectory(),
  ])).flat();
  const out = new Map();
  for (const c of all) {
    const key = identityKey(c);
    if (!key || known.has(key) || out.has(key)) continue;
    out.set(key, c);
  }
  return [...out.values()];
}
