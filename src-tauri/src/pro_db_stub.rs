//! Doublure de `pro_db` pour les builds SANS la feature `pro`.
//!
//! Le moteur PostgreSQL (et sa dépendance `postgres`) n'est compilé qu'en
//! édition Pro. Les commandes existent quand même — la liste `generate_handler!`
//! est unique — mais elles refusent, en une phrase que l'interface peut
//! afficher telle quelle. Aucun code client PostgreSQL n'entre dans le binaire
//! standard.

use serde_json::Value;

const REFUS: &str = "Le moteur PostgreSQL fait partie de Lumen Pro (build avec --features pro).";

#[tauri::command]
pub fn prodb_pg_ping(url: String) -> Result<String, String> {
    let _ = url;
    Err(REFUS.into())
}

#[tauri::command]
pub fn prodb_pg_schema(url: String, schema: Option<String>) -> Result<Value, String> {
    let _ = (url, schema);
    Err(REFUS.into())
}

#[tauri::command]
pub fn prodb_pg_query(url: String, sql: String, limit: Option<i64>) -> Result<Value, String> {
    let _ = (url, sql, limit);
    Err(REFUS.into())
}

#[tauri::command]
pub fn prodb_pg_exec(url: String, sql: String, params: Option<Vec<Value>>) -> Result<u64, String> {
    let _ = (url, sql, params);
    Err(REFUS.into())
}

#[tauri::command]
pub fn prodb_pg_migrate(url: String, statements: Vec<String>) -> Result<usize, String> {
    let _ = (url, statements);
    Err(REFUS.into())
}
