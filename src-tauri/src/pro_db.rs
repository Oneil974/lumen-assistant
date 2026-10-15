//! DB Studio (édition Pro) — moteur **PostgreSQL** optionnel.
//!
//! DB Studio modélise une base : tables, champs typés, relations, formulaires.
//! Par défaut il écrit dans le SQLite local de Lumen (`tables.rs`), ce qui garde
//! les données lisibles par Prisme, Fluxo et les agents. En entreprise, la même
//! modélisation doit parfois viser un PostgreSQL partagé : c'est ce que fait ce
//! module, et **seulement** en édition Pro (feature `pro`).
//!
//! Trois principes :
//!   1. Aucune connexion n'est mémorisée ici : l'URL vient de l'appelant à
//!      chaque commande (elle est stockée côté app, dans les réglages du
//!      profil). Le module reste sans état, donc sans fuite entre profils.
//!   2. La lecture est verrouillée : `prodb_pg_query` n'accepte qu'un unique
//!      `SELECT`/`WITH` (même garde que le NL→SQL de SQLite), pour qu'une
//!      requête écrite par le modèle ne puisse pas modifier la base.
//!   3. Les valeurs remontent en JSON produit par PostgreSQL lui-même
//!      (`to_jsonb`) : dates, numériques, tableaux et JSON arrivent déjà
//!      convertis, sans table de correspondance de types à maintenir.

use postgres::{Client, NoTls};
use serde_json::{json, Map, Value};

/// Ouvre une connexion. Volontairement sans cache : une commande = une
/// connexion, ce qui évite de garder un socket ouvert vers le SGBD de
/// l'entreprise entre deux gestes de l'utilisateur.
fn connect(url: &str) -> Result<Client, String> {
    Client::connect(url, NoTls).map_err(|e| format!("Connexion PostgreSQL impossible : {e}"))
}

/// Vrai si la requête est une lecture unique. Même politique que `table_query`
/// côté SQLite : un seul ordre, commençant par SELECT ou WITH, sans point-virgule
/// intermédiaire qui permettrait d'en enchaîner un second.
pub fn is_read_only(sql: &str) -> bool {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() || trimmed.contains(';') {
        return false;
    }
    let head = trimmed
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !(head == "select" || head == "with") {
        return false;
    }
    // Un CTE peut écrire (`WITH x AS (INSERT …)`) : on refuse tout mot-clé
    // d'écriture, où qu'il se trouve.
    let lower = format!(" {} ", trimmed.to_ascii_lowercase().replace(['(', ')', '\n', '\t'], " "));
    const FORBIDDEN: [&str; 12] = [
        " insert ", " update ", " delete ", " drop ", " alter ", " create ", " truncate ",
        " grant ", " revoke ", " copy ", " call ", " do ",
    ];
    !FORBIDDEN.iter().any(|k| lower.contains(k))
}

// ===================== Commandes =====================

/// Teste la connexion et renvoie la version du serveur — le premier geste de
/// l'écran de réglages.
#[tauri::command]
pub fn prodb_pg_ping(url: String) -> Result<String, String> {
    let mut client = connect(&url)?;
    let row = client
        .query_one("SELECT version(), current_database()", &[])
        .map_err(|e| e.to_string())?;
    let version: String = row.get(0);
    let db: String = row.get(1);
    Ok(format!("{db} — {version}"))
}

/// Schéma complet d'un schéma PostgreSQL : tables, colonnes (type, nullabilité,
/// défaut) et clés étrangères. C'est ce que DB Studio dessine.
#[tauri::command]
pub fn prodb_pg_schema(url: String, schema: Option<String>) -> Result<Value, String> {
    let schema = schema.unwrap_or_else(|| "public".into());
    let mut client = connect(&url)?;

    let cols = client
        .query(
            "SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default,
                    c.ordinal_position
               FROM information_schema.columns c
               JOIN information_schema.tables t
                 ON t.table_schema = c.table_schema AND t.table_name = c.table_name
              WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
              ORDER BY c.table_name, c.ordinal_position",
            &[&schema],
        )
        .map_err(|e| e.to_string())?;

    let fks = client
        .query(
            "SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table,
                    ccu.column_name AS ref_column, tc.constraint_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
               JOIN information_schema.constraint_column_usage ccu
                 ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
              WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1",
            &[&schema],
        )
        .map_err(|e| e.to_string())?;

    let counts = client
        .query(
            "SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname = $1",
            &[&schema],
        )
        .map_err(|e| e.to_string())?;

    let mut tables: Map<String, Value> = Map::new();
    for row in &cols {
        let table: String = row.get(0);
        let entry = tables.entry(table.clone()).or_insert_with(|| {
            json!({ "name": table, "columns": [], "relations": [], "rows": 0 })
        });
        let nullable: String = row.get(3);
        entry["columns"].as_array_mut().unwrap().push(json!({
            "name": row.get::<_, String>(1),
            "type": row.get::<_, String>(2),
            "nullable": nullable == "YES",
            "default": row.get::<_, Option<String>>(4),
            "position": row.get::<_, i32>(5),
        }));
    }
    for row in &fks {
        let table: String = row.get(0);
        if let Some(entry) = tables.get_mut(&table) {
            entry["relations"].as_array_mut().unwrap().push(json!({
                "column": row.get::<_, String>(1),
                "refTable": row.get::<_, String>(2),
                "refColumn": row.get::<_, String>(3),
                "constraint": row.get::<_, String>(4),
            }));
        }
    }
    for row in &counts {
        let table: String = row.get(0);
        if let Some(entry) = tables.get_mut(&table) {
            entry["rows"] = json!(row.get::<_, i64>(1));
        }
    }

    let mut list: Vec<Value> = tables.into_iter().map(|(_, v)| v).collect();
    list.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Ok(json!({ "schema": schema, "tables": list }))
}

/// Lecture seule. Renvoie `{ columns: [...], rows: [ {col: valeur} ] }`.
///
/// La conversion des valeurs est déléguée à PostgreSQL (`to_jsonb`) : une date,
/// un numérique, un tableau ou un JSONB arrivent déjà dans le bon type JSON,
/// sans table de correspondance d'OID à tenir à jour côté Rust.
#[tauri::command]
pub fn prodb_pg_query(url: String, sql: String, limit: Option<i64>) -> Result<Value, String> {
    if !is_read_only(&sql) {
        return Err("Seules les requêtes de lecture (SELECT / WITH) sont autorisées ici.".into());
    }
    let mut client = connect(&url)?;
    let clean = sql.trim().trim_end_matches(';').to_string();
    // L'ordre des colonnes se lit sur la requête préparée : un objet JSON, lui,
    // ne garantit aucun ordre.
    let stmt = client.prepare(&clean).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt.columns().iter().map(|c| c.name().to_string()).collect();
    let wrapped = format!(
        "WITH __q AS ({clean}) SELECT to_jsonb(__q) FROM __q LIMIT {}",
        limit.unwrap_or(1000).clamp(1, 100_000)
    );
    let rows = client.query(wrapped.as_str(), &[]).map_err(|e| e.to_string())?;
    let out: Vec<Value> = rows.iter().map(|r| r.get::<_, Value>(0)).collect();
    Ok(json!({ "columns": columns, "rows": out }))
}

/// Écriture (DDL et DML). Les valeurs passent en paramètres `$1…$n` : le
/// contenu d'un formulaire ne peut donc pas être interprété comme du SQL.
///
/// Les paramètres sont transmis dans le type JSON reçu — texte, nombre, booléen
/// ou NULL. Les conversions particulières (date, uuid, json) se déclarent dans
/// la requête elle-même, par un `$1::date` explicite, ce que l'app sait faire
/// puisqu'elle connaît le type de chaque champ.
#[tauri::command]
pub fn prodb_pg_exec(url: String, sql: String, params: Option<Vec<Value>>) -> Result<u64, String> {
    let mut client = connect(&url)?;
    let values = params.unwrap_or_default();
    // Chaque paramètre doit vivre aussi longtemps que l'appel : on matérialise
    // les valeurs converties AVANT de construire le tableau de références.
    let owned: Vec<Box<dyn postgres::types::ToSql + Sync>> = values
        .into_iter()
        .map(|v| -> Box<dyn postgres::types::ToSql + Sync> {
            match v {
                Value::Null => Box::new(Option::<String>::None),
                Value::Bool(b) => Box::new(b),
                Value::Number(n) => match n.as_i64() {
                    Some(i) => Box::new(i),
                    None => Box::new(n.as_f64().unwrap_or(0.0)),
                },
                Value::String(s) => Box::new(s),
                other => Box::new(other.to_string()),
            }
        })
        .collect();
    let refs: Vec<&(dyn postgres::types::ToSql + Sync)> =
        owned.iter().map(|b| b.as_ref()).collect();
    client
        .execute(sql.as_str(), &refs)
        .map_err(|e| format!("PostgreSQL : {e}"))
}

/// Exécute plusieurs ordres dans UNE transaction — la migration produite par le
/// modélisateur (créer une table, ses colonnes, ses contraintes) doit passer
/// entièrement ou pas du tout.
#[tauri::command]
pub fn prodb_pg_migrate(url: String, statements: Vec<String>) -> Result<usize, String> {
    let mut client = connect(&url)?;
    let mut tx = client.transaction().map_err(|e| e.to_string())?;
    let mut done = 0usize;
    for sql in &statements {
        if sql.trim().is_empty() {
            continue;
        }
        tx.batch_execute(sql)
            .map_err(|e| format!("PostgreSQL sur « {} » : {e}", sql.trim()))?;
        done += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::is_read_only;

    #[test]
    fn accepte_une_lecture_simple() {
        assert!(is_read_only("SELECT * FROM clients"));
        assert!(is_read_only("  select id from t;  "));
        assert!(is_read_only("WITH x AS (SELECT 1) SELECT * FROM x"));
    }

    #[test]
    fn refuse_les_ecritures_et_les_enchainements() {
        assert!(!is_read_only("DELETE FROM clients"));
        assert!(!is_read_only("SELECT 1; DROP TABLE clients"));
        assert!(!is_read_only("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"));
        assert!(!is_read_only("UPDATE t SET a=1"));
        assert!(!is_read_only(""));
    }
}
