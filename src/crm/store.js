// Couche données de Relia (CRM · Projets & tâches · Devis · Factures).
//
// TOUT vit dans la base SQLite locale des « Bases de données » (tables.rs) :
// une base nommée « ERP » avec des tables typées. Ce choix est délibéré — les
// données ne sont pas enfermées dans l'app : elles apparaissent telles quelles
// dans Prisme (Tables, Analyse), dans le NL→SQL, dans Fluxo et pour les agents,
// sans passerelle ni copie.
//
// Le backend `table_*` adresse les colonnes par identifiant (`c_<col_id>`). Ce
// module fait donc la traduction « nom convivial ⇄ col_id » une fois pour
// toutes, et expose des objets JS lisibles au reste de l'app.
import * as db from "../tables/client.js";

export const hasBackend = db.hasBackend;
export const BASE_NAME = "ERP";

// Schéma déclaratif. Ajouter une colonne ici suffit : elle est créée au
// prochain démarrage sur les installations existantes (cf. ensureSchema).
export const SCHEMA = {
  societe: {
    name: "Société",
    columns: [
      ["Raison sociale", "text"], ["Forme juridique", "text"], ["Capital", "text"],
      ["SIREN", "text"], ["SIRET", "text"], ["RCS", "text"], ["Code APE", "text"],
      ["TVA intracom", "text"], ["Adresse", "text"], ["Code postal", "text"],
      ["Ville", "text"], ["Pays", "text"], ["Email", "text"], ["Téléphone", "text"],
      ["IBAN", "text"], ["BIC", "text"], ["Mode paiement", "text"],
      ["Conditions paiement", "text"], ["Taux pénalités", "number"],
      ["Indemnité recouvrement", "number"], ["Escompte", "text"],
      ["Régime TVA", "text"], ["TVA sur les débits", "bool"],
      ["Profil Factur-X", "text"], ["Identifiant PDP", "text"], ["Mentions", "text"],
    ],
  },
  articles: {
    name: "Articles",
    columns: [
      ["Référence", "text"], ["Désignation", "text"], ["Description", "text"],
      ["Catégorie", "text"], ["Unité", "text"], ["Prix HT", "number"],
      ["TVA", "number"], ["Coût achat", "number"], ["Stock", "number"],
      ["Stock alerte", "number"], ["Suivi stock", "bool"], ["Actif", "bool"],
      ["Tags", "text"],
    ],
  },
  clients: {
    name: "Clients",
    columns: [
      ["Code", "text"], ["Nom", "text"], ["Type", "select"], ["SIREN", "text"],
      ["SIRET", "text"], ["TVA intracom", "text"], ["Contact", "text"],
      ["Email", "text"], ["Téléphone", "text"], ["Adresse", "text"],
      ["Code postal", "text"], ["Ville", "text"], ["Pays", "text"],
      ["Adresse livraison", "text"], ["Référence acheteur", "text"],
      ["Code routage", "text"], ["Conditions paiement", "text"], ["Tags", "text"],
      ["Notes", "text"],
    ],
  },
  projets: {
    name: "Projets",
    columns: [
      ["Nom", "text"], ["Client", "text"], ["Client id", "number"],
      ["Statut", "select"], ["Début", "date"], ["Fin", "date"],
      ["Budget", "number"], ["Taux horaire", "number"], ["Avancement", "number"],
      ["Tags", "text"], ["Notes", "text"],
    ],
  },
  taches: {
    name: "Tâches",
    columns: [
      ["Titre", "text"], ["Projet", "text"], ["Projet id", "number"],
      ["Statut", "select"], ["Priorité", "select"], ["Assigné", "text"],
      ["Début", "date"], ["Échéance", "date"], ["Estimé h", "number"],
      ["Passé h", "number"], ["Avancement", "number"], ["Facturable", "bool"],
      ["Facturé", "text"], ["Rang", "number"], ["Tags", "text"], ["Notes", "text"],
    ],
  },
  devis: {
    name: "Devis",
    columns: [
      ["Numéro", "text"], ["Date", "date"], ["Validité", "date"], ["Client", "text"],
      ["Client id", "number"], ["Statut", "select"], ["Objet", "text"],
      ["Remise", "number"], ["Total HT", "number"], ["Total TVA", "number"],
      ["Total TTC", "number"], ["Facture", "text"], ["Projet", "text"],
      ["Projet id", "number"], ["Tags", "text"], ["Notes", "text"],
    ],
  },
  lignesDevis: {
    name: "Lignes devis",
    columns: [
      ["Document", "text"], ["Rang", "number"], ["Référence", "text"],
      ["Désignation", "text"], ["Quantité", "number"], ["Unité", "text"],
      ["Prix HT", "number"], ["Remise", "number"], ["TVA", "number"],
      ["Total HT", "number"],
    ],
  },
  factures: {
    name: "Factures",
    columns: [
      ["Numéro", "text"], ["Date", "date"], ["Échéance", "date"], ["Type", "select"],
      ["Client", "text"], ["Client id", "number"], ["Statut", "select"],
      ["Objet", "text"], ["Devis", "text"], ["Référence acheteur", "text"],
      ["Bon de commande", "text"], ["Nature opération", "select"],
      ["Adresse livraison", "text"], ["Date livraison", "date"],
      ["TVA sur les débits", "bool"], ["Remise", "number"], ["Total HT", "number"],
      ["Total TVA", "number"], ["Total TTC", "number"], ["Payé", "number"],
      ["Mode paiement", "text"], ["Facture rectifiée", "text"],
      ["Profil Factur-X", "text"], ["Projet", "text"], ["Projet id", "number"],
      ["Tags", "text"], ["Notes", "text"],
    ],
  },
  lignesFactures: {
    name: "Lignes facture",
    columns: [
      ["Document", "text"], ["Rang", "number"], ["Référence", "text"],
      ["Désignation", "text"], ["Quantité", "number"], ["Unité", "text"],
      ["Prix HT", "number"], ["Remise", "number"], ["TVA", "number"],
      ["Total HT", "number"],
    ],
  },
  stock: {
    name: "Mouvements stock",
    columns: [
      ["Date", "date"], ["Référence", "text"], ["Désignation", "text"],
      ["Sens", "select"], ["Quantité", "number"], ["Stock après", "number"],
      ["Motif", "text"], ["Document", "text"],
    ],
  },
};

let baseId = "";
// key logique → { tableId, cols: { "Nom convivial": col_id } }
const meta = {};

export const getBaseId = () => baseId;
export const tableIdOf = (key) => meta[key]?.tableId || "";

/** Crée la base et les tables manquantes, et complète les colonnes ajoutées. */
export async function ensureSchema() {
  const bases = await db.listBases();
  baseId = bases.find((b) => b.name === BASE_NAME)?.base_id || "";
  if (!baseId) baseId = await db.createBase(BASE_NAME);
  const tables = await db.listTables(baseId);
  for (const [key, def] of Object.entries(SCHEMA)) {
    let t = tables.find((x) => x.name === def.name);
    if (!t) {
      const id = await db.createTable(baseId, def.name, def.columns.map(([name, type]) => ({ name, type })));
      t = { table_id: id, name: def.name };
    }
    let cols = await db.tableSchema(t.table_id);
    // Migration douce : une colonne ajoutée au SCHEMA apparaît sur les bases
    // déjà créées, sans toucher aux données existantes.
    for (const [name, type] of def.columns) {
      if (!cols.some((c) => c.name === name)) await db.addColumn(t.table_id, name, type);
    }
    cols = await db.tableSchema(t.table_id);
    meta[key] = { tableId: t.table_id, cols: Object.fromEntries(cols.map((c) => [c.name, c.col_id])) };
  }
  return baseId;
}

const toRow = (key, obj) => {
  const { cols } = meta[key];
  const out = {};
  for (const [name, value] of Object.entries(obj)) {
    const id = cols[name];
    if (id !== undefined) out[id] = value === undefined ? null : value;
  }
  return out;
};

const fromRow = (key, row) => {
  const { cols } = meta[key];
  const out = { _id: row._id };
  for (const [name, id] of Object.entries(cols)) out[name] = row[id] ?? null;
  return out;
};

/** Lit une table entière, dans l'ordre d'insertion. */
export async function list(key) {
  const res = await db.rows(meta[key].tableId, 5000, 0);
  return (res?.rows || []).map((r) => fromRow(key, r));
}

export async function insert(key, obj) {
  return db.insertRow(meta[key].tableId, toRow(key, obj));
}

export async function update(key, rowId, obj) {
  return db.updateRow(meta[key].tableId, rowId, toRow(key, obj));
}

export async function remove(key, rowId) {
  return db.deleteRow(meta[key].tableId, rowId);
}

/** Lignes d'un devis / d'une facture, triées par rang. */
export async function linesOf(key, docNumber) {
  const all = await list(key);
  return all.filter((l) => l.Document === docNumber).sort((a, b) => (a.Rang || 0) - (b.Rang || 0));
}

/** Remplace toutes les lignes d'un document (édition d'un devis, par ex.). */
export async function replaceLines(key, docNumber, lines) {
  const existing = await linesOf(key, docNumber);
  for (const l of existing) await remove(key, l._id);
  let rang = 1;
  for (const l of lines) await insert(key, { ...l, Document: docNumber, Rang: rang++ });
}

/** Requête SQL de lecture sur la base ERP (garde lecture seule côté Rust). */
export const query = (sql) => db.query(baseId, sql);
export const schemaPrompt = () => db.schemaPrompt(baseId);
