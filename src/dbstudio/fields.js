// Vocabulaire commun de DB Studio : les TYPES DE CHAMP.
//
// Un type de champ est une idée métier (« un e-mail », « une date », « un lien
// vers un client »), pas un type SQL. Chaque moteur — SQLite local, PostgreSQL
// d'entreprise — le traduit ensuite dans ce qu'il sait faire. C'est ce qui
// permet de modéliser une fois et de choisir le moteur ensuite, sans réécrire
// le modèle.
//
// Chaque type déclare :
//   sql      : type SQLite convivial (celui de tables.rs) pour rester lisible
//              par Prisme, Calc, le NL→SQL et les agents ;
//   pg       : type PostgreSQL ;
//   widget   : le contrôle de saisie du formulaire généré ;
//   sample   : exemple montré dans la palette.

export const FIELD_KINDS = {
  text:      { label: "Texte court",   sql: "text",   pg: "TEXT",              widget: "input",    icon: "type",        sample: "Dupont SAS" },
  longtext:  { label: "Texte long",    sql: "text",   pg: "TEXT",              widget: "textarea", icon: "scroll-text", sample: "Description, notes…" },
  number:    { label: "Nombre",        sql: "number", pg: "DOUBLE PRECISION",  widget: "number",   icon: "hash",        sample: "1 250,50" },
  integer:   { label: "Entier",        sql: "number", pg: "BIGINT",            widget: "number",   icon: "hash",        sample: "42" },
  money:     { label: "Montant",       sql: "number", pg: "NUMERIC(14,2)",     widget: "number",   icon: "coins",       sample: "1 250,00 €" },
  bool:      { label: "Oui / non",     sql: "bool",   pg: "BOOLEAN",           widget: "checkbox", icon: "check",       sample: "Actif" },
  date:      { label: "Date",          sql: "date",   pg: "DATE",              widget: "date",     icon: "calendar",    sample: "2026-09-06" },
  datetime:  { label: "Date et heure", sql: "date",   pg: "TIMESTAMPTZ",       widget: "datetime", icon: "clock",       sample: "2026-09-06 14:30" },
  select:    { label: "Liste de choix",sql: "select", pg: "TEXT",              widget: "select",   icon: "list",        sample: "Prospect / Client" },
  email:     { label: "E-mail",        sql: "text",   pg: "TEXT",              widget: "email",    icon: "mail",        sample: "contact@exemple.fr" },
  url:       { label: "Lien web",      sql: "text",   pg: "TEXT",              widget: "url",      icon: "globe",       sample: "https://exemple.fr" },
  phone:     { label: "Téléphone",     sql: "text",   pg: "TEXT",              widget: "tel",      icon: "smartphone",  sample: "01 23 45 67 89" },
  relation:  { label: "Relation",      sql: "number", pg: "BIGINT",            widget: "relation", icon: "waypoints",   sample: "→ Clients" },
};

export const KIND_IDS = Object.keys(FIELD_KINDS);
export const kindLabel = (kind) => FIELD_KINDS[kind]?.label || kind;

/** Cardinalité d'une relation : un seul enregistrement lié, ou plusieurs. */
export const CARDINALITIES = {
  one: { label: "Un seul (n–1)", hint: "Chaque ligne pointe vers un enregistrement de la table cible." },
  many: { label: "Plusieurs (n–n)", hint: "Chaque ligne peut pointer vers plusieurs enregistrements." },
};

/** Champ vierge — les valeurs par défaut d'un nouveau champ. */
export function blankField(kind = "text", name = "") {
  return {
    name, kind,
    required: false,
    unique: false,
    def: "",            // valeur par défaut
    options: [],        // pour `select`
    target: "",         // table cible d'une `relation`
    display: "",        // champ de la cible servant de libellé (vide = deviné)
    cardinality: "one",
    help: "",           // aide affichée sous le champ du formulaire
    inForm: true,       // le champ apparaît-il dans le formulaire de saisie
  };
}

/**
 * Valide une valeur saisie. Renvoie un message d'erreur, ou "" si tout va bien.
 * La même fonction sert au formulaire ET aux écritures de l'assistant : une
 * contrainte qui ne vaudrait que pour l'interface ne serait pas une contrainte.
 */
export function validateValue(field, value) {
  const empty = value === "" || value === null || value === undefined
    || (Array.isArray(value) && value.length === 0);
  if (field.required && empty && field.kind !== "bool") return `« ${field.name} » est obligatoire.`;
  if (empty) return "";
  switch (field.kind) {
    case "number": case "money":
      return Number.isFinite(Number(value)) ? "" : `« ${field.name} » attend un nombre.`;
    case "integer":
      return Number.isInteger(Number(value)) ? "" : `« ${field.name} » attend un entier.`;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)) ? "" : `« ${field.name} » n'est pas une adresse e-mail.`;
    case "url":
      return /^https?:\/\/\S+$/i.test(String(value)) ? "" : `« ${field.name} » attend une URL commençant par http(s)://`;
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? "" : `« ${field.name} » attend une date AAAA-MM-JJ.`;
    case "select":
      return !field.options?.length || field.options.includes(String(value))
        ? "" : `« ${field.name} » : valeur hors de la liste (${field.options.join(", ")}).`;
    default:
      return "";
  }
}

/** Normalise une valeur avant écriture (types stricts côté base). */
export function coerceValue(field, value) {
  if (value === "" || value === null || value === undefined) {
    return field.kind === "bool" ? false : null;
  }
  switch (field.kind) {
    case "number": case "money": return Number(value);
    case "integer": return Math.trunc(Number(value));
    case "bool": return !!value && value !== "false" && value !== "0";
    case "relation":
      return field.cardinality === "many"
        ? JSON.stringify((Array.isArray(value) ? value : [value]).map(Number).filter(Boolean))
        : Number(value) || null;
    default: return String(value);
  }
}

/** Identifiant SQL sûr dérivé d'un nom convivial (moteur PostgreSQL). */
export function slug(name, fallback = "champ") {
  const out = String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return out || fallback;
}
