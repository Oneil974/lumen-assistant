// Prompts IA des bases de données (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

const SQL_RULES = "Lecture seule : uniquement SELECT (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, ATTACH sont interdits). Nomme tables et colonnes exactement comme dans le schéma, entre guillemets doubles.";

export const PROMPTS = {
  "app.tables.nl2sql": {
    kind: "json",
    label: "Bases — question → requête SQL",
    role: `Tu traduis une question en UNE requête SQL. ${SQL_RULES}`,
    build: ({ question, schema, dialect = "SQLite", lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.tables.nl2sql", kind: "json", lang, role: `${PROMPTS["app.tables.nl2sql"].role} Dialecte : ${dialect}.`,
        data: { "SCHÉMA DE LA BASE": schema },
        request: question,
        format: "une seule requête SELECT, sans explication.", example: { sql: "SELECT \"produit\", COUNT(*) AS \"nb\" FROM \"commandes\" GROUP BY \"produit\"" },
      }),
      opts: { json: true },
    }),
    bench: [{
      vars: { question: "Quel est le chiffre d'affaires total par ville ?", schema: 'Table "ventes" — colonnes : "id" (INTEGER), "ville" (TEXT), "montant" (REAL), "date" (TEXT)' },
      expect: { json: true, keys: ["sql"], jsonCheck: { "SELECT … GROUP BY ville": (j) => /^\s*select/i.test(j.sql || "") && /group by/i.test(j.sql) && /ville/i.test(j.sql) && /sum/i.test(j.sql), "lecture seule": (j) => !/insert|update|delete|drop/i.test(j.sql || "") } },
    }],
  },
  "app.tables.investigate": {
    kind: "json",
    label: "Bases — enquête en plusieurs requêtes",
    role: `Tu es un analyste de données qui répond à partir d'une base, en plusieurs étapes. ${SQL_RULES} Fais les requêtes utiles (agrégats, détails, vérifications), puis conclus par une réponse qui interprète les chiffres, sans se contenter de les répéter.`,
    build: ({ question, schema, dialect = "SQLite", lang = "fr" }) => ({
      messages: buildPrompt({
        id: "app.tables.investigate", kind: "json", lang, role: `${PROMPTS["app.tables.investigate"].role} Dialecte : ${dialect}.`,
        data: { "SCHÉMA DE LA BASE": schema },
        request: question,
        format: "à chaque tour, soit {\"sql\":\"SELECT …\"} pour interroger la base, soit {\"answer\":\"réponse complète\"} quand tu as assez d'éléments.", example: { sql: "SELECT \"produit\", COUNT(*) FROM \"commandes\" GROUP BY \"produit\"" },
      }),
      opts: { json: true },
    }),
    bench: [{
      vars: { question: "Quelle ville vend le plus ?", schema: 'Table "ventes" — colonnes : "id" (INTEGER), "ville" (TEXT), "montant" (REAL)' },
      expect: { json: true, jsonCheck: { "commence par une requête": (j) => /^\s*select/i.test(j.sql || "") } },
    }],
  },
};
