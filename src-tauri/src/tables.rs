//! Bases de données façon Baserow — SQLite local et portable (`app_data_dir/tables.db`).
//!
//! Modèle : une **base** regroupe des **tables** ; chaque table logique est adossée
//! à une vraie table physique SQLite `t_<table_id>` dont les colonnes physiques
//! sont `c_<col_id>` (+ `id` auto). Les métadonnées (noms conviviaux, types,
//! ordre) vivent dans `bases` / `tables` / `columns`. On garde de vraies tables
//! (et non un EAV/JSON) pour permettre du SQL réel, des exports CSV fidèles et un
//! NL→SQL fiable.
//!
//! Interrogation IA : `table_query` ouvre la base en **lecture seule**, recrée des
//! `TEMP VIEW` aux noms conviviaux (colonnes incluses) puis exécute un unique
//! `SELECT`/`WITH` validé. Aucune écriture possible par l'IA (cf. `is_read_only`).
//!
//! Le NL→SQL lui-même reste côté JS (réutilise le backend LLM actif via `llmChat`),
//! ce module ne dépend donc pas du LLM.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Manager;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("tables.db"))
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS bases(
            base_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER);
         CREATE TABLE IF NOT EXISTS tables(
            table_id TEXT PRIMARY KEY, base_id TEXT NOT NULL, name TEXT NOT NULL,
            created_at INTEGER);
         CREATE INDEX IF NOT EXISTS idx_tables_base ON tables(base_id);
         CREATE TABLE IF NOT EXISTS columns(
            col_id TEXT PRIMARY KEY, table_id TEXT NOT NULL, name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'text', ordinal INTEGER NOT NULL DEFAULT 0);
         CREATE INDEX IF NOT EXISTS idx_columns_table ON columns(table_id);",
    )
    .map_err(|e| e.to_string())?;
    // Métadonnées libres (JSON) posées par DB Studio : contrainte « requis »,
    // valeur par défaut, options d'une liste, cible d'une relation, ordre et
    // libellés du formulaire de saisie. Ajoutées après coup sur les bases déjà
    // créées — `ALTER TABLE` échoue si la colonne existe, l'erreur est donc
    // ignorée volontairement.
    let _ = conn.execute_batch("ALTER TABLE columns ADD COLUMN meta TEXT;");
    let _ = conn.execute_batch("ALTER TABLE tables ADD COLUMN meta TEXT;");
    Ok(conn)
}

/// Connexion **lecture seule** sur le fichier (les TEMP views/objets restent
/// permis car la base temporaire est distincte). Utilisée par `table_query`.
fn open_ro(app: &tauri::AppHandle) -> Result<Connection, String> {
    Connection::open_with_flags(
        db_path(app)?,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| e.to_string())
}

/// Identifiant court et sûr (hex) — pas de dépendance externe.
fn gen_id(conn: &Connection) -> Result<String, String> {
    conn.query_row("SELECT lower(hex(randomblob(8)))", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// Affinité SQLite physique selon le type convivial.
fn affinity(col_type: &str) -> &'static str {
    match col_type {
        "number" => "REAL",
        "bool" => "INTEGER",
        _ => "TEXT", // text, date, select
    }
}

/// Échappe un identifiant SQLite pour interpolation entre guillemets doubles.
fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn json_from_ref(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(_) => Value::Null,
    }
}

// ===================== Structures de sortie =====================

#[derive(Serialize)]
pub struct BaseInfo {
    // `pub` : les outils natifs des agents (`native_tools`) choisissent la base
    // à interroger par son nom et passent son id à `table_query`.
    pub base_id: String,
    pub name: String,
    created_at: u64,
    tables: usize,
}

#[derive(Serialize)]
pub struct TableInfo {
    table_id: String,
    base_id: String,
    name: String,
    created_at: u64,
    rows: i64,
}

#[derive(Serialize)]
pub struct ColumnInfo {
    col_id: String,
    name: String,
    #[serde(rename = "type")]
    col_type: String,
    ordinal: i64,
    /// JSON libre (chaîne) : contraintes et présentation du champ. `null` tant
    /// qu'aucune app ne l'a renseigné — les apps historiques l'ignorent.
    meta: Option<String>,
}

// ===================== Bases =====================

#[tauri::command]
pub fn table_base_list(app: tauri::AppHandle) -> Result<Vec<BaseInfo>, String> {
    let conn = open(&app)?;
    let mut stmt = conn
        .prepare("SELECT base_id, name, created_at FROM bases ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        let (base_id, name, created_at) = r.map_err(|e| e.to_string())?;
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tables WHERE base_id=?1",
                [&base_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        out.push(BaseInfo {
            base_id,
            name,
            created_at: created_at as u64,
            tables: n as usize,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn table_base_create(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let conn = open(&app)?;
    let id = gen_id(&conn)?;
    let name = name.trim();
    let name = if name.is_empty() {
        "Nouvelle base"
    } else {
        name
    };
    conn.execute(
        "INSERT INTO bases(base_id, name, created_at) VALUES(?1,?2,?3)",
        rusqlite::params![id, name, now_ms() as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn table_base_rename(
    app: tauri::AppHandle,
    base_id: String,
    name: String,
) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute(
        "UPDATE bases SET name=?1 WHERE base_id=?2",
        rusqlite::params![name.trim(), base_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn table_base_delete(app: tauri::AppHandle, base_id: String) -> Result<(), String> {
    let conn = open(&app)?;
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT table_id FROM tables WHERE base_id=?1")
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([&base_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        it.filter_map(|r| r.ok()).collect()
    };
    for tid in &ids {
        let _ = conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS {};",
            quote_ident(&format!("t_{tid}"))
        ));
        let _ = conn.execute("DELETE FROM columns WHERE table_id=?1", [tid]);
    }
    conn.execute("DELETE FROM tables WHERE base_id=?1", [&base_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM bases WHERE base_id=?1", [&base_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===================== Tables =====================

#[tauri::command]
pub fn table_list(app: tauri::AppHandle, base_id: String) -> Result<Vec<TableInfo>, String> {
    let conn = open(&app)?;
    let mut stmt = conn
        .prepare("SELECT table_id, base_id, name, created_at FROM tables WHERE base_id=?1 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&base_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        let (table_id, base_id, name, created_at) = r.map_err(|e| e.to_string())?;
        let n: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM {}",
                    quote_ident(&format!("t_{table_id}"))
                ),
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        out.push(TableInfo {
            table_id,
            base_id,
            name,
            created_at: created_at as u64,
            rows: n,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn table_create(
    app: tauri::AppHandle,
    base_id: String,
    name: String,
    columns: Option<Vec<Value>>,
) -> Result<String, String> {
    let conn = open(&app)?;
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM bases WHERE base_id=?1",
            [&base_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Err("Base introuvable".into());
    }
    let table_id = gen_id(&conn)?;
    let name = name.trim();
    let name = if name.is_empty() { "Table" } else { name };
    // Colonnes par défaut si non fournies : un simple champ « Nom ».
    let cols: Vec<(String, String)> = match columns {
        Some(list) if !list.is_empty() => list
            .into_iter()
            .map(|c| {
                let n = c
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Colonne")
                    .to_string();
                let t = c
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("text")
                    .to_string();
                (n, t)
            })
            .collect(),
        _ => vec![("Nom".into(), "text".into())],
    };
    let mut defs = vec!["id INTEGER PRIMARY KEY AUTOINCREMENT".to_string()];
    let mut meta: Vec<(String, String, String)> = Vec::new(); // (col_id, name, type)
    for (n, t) in cols {
        let cid = gen_id(&conn)?;
        defs.push(format!(
            "{} {}",
            quote_ident(&format!("c_{cid}")),
            affinity(&t)
        ));
        meta.push((cid, n, t));
    }
    conn.execute_batch(&format!(
        "CREATE TABLE {} ({});",
        quote_ident(&format!("t_{table_id}")),
        defs.join(", ")
    ))
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO tables(table_id, base_id, name, created_at) VALUES(?1,?2,?3,?4)",
        rusqlite::params![table_id, base_id, name, now_ms() as i64],
    )
    .map_err(|e| e.to_string())?;
    for (i, (cid, n, t)) in meta.into_iter().enumerate() {
        conn.execute(
            "INSERT INTO columns(col_id, table_id, name, type, ordinal) VALUES(?1,?2,?3,?4,?5)",
            rusqlite::params![cid, table_id, n, t, i as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(table_id)
}

#[tauri::command]
pub fn table_rename(app: tauri::AppHandle, table_id: String, name: String) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute(
        "UPDATE tables SET name=?1 WHERE table_id=?2",
        rusqlite::params![name.trim(), table_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn table_delete(app: tauri::AppHandle, table_id: String) -> Result<(), String> {
    let conn = open(&app)?;
    let _ = conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS {};",
        quote_ident(&format!("t_{table_id}"))
    ));
    conn.execute("DELETE FROM columns WHERE table_id=?1", [&table_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tables WHERE table_id=?1", [&table_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn schema_cols(conn: &Connection, table_id: &str) -> Result<Vec<ColumnInfo>, String> {
    let mut stmt = conn
        .prepare("SELECT col_id, name, type, ordinal, meta FROM columns WHERE table_id=?1 ORDER BY ordinal, rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([table_id], |r| {
            Ok(ColumnInfo {
                col_id: r.get(0)?,
                name: r.get(1)?,
                col_type: r.get(2)?,
                ordinal: r.get(3)?,
                meta: r.get(4).ok(),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn table_schema(app: tauri::AppHandle, table_id: String) -> Result<Vec<ColumnInfo>, String> {
    let conn = open(&app)?;
    schema_cols(&conn, &table_id)
}

/// Schéma textuel de toute la base — sert au prompt NL→SQL côté JS.
#[tauri::command]
pub fn table_base_schema(app: tauri::AppHandle, base_id: String) -> Result<Value, String> {
    let conn = open(&app)?;
    let tables = table_list(app.clone(), base_id)?;
    let mut out = Vec::new();
    for t in tables {
        let cols = schema_cols(&conn, &t.table_id)?;
        out.push(json!({
            "table_id": t.table_id,
            "name": t.name,
            "rows": t.rows,
            "columns": cols.iter().map(|c| json!({"name": c.name, "type": c.col_type})).collect::<Vec<_>>(),
        }));
    }
    Ok(json!({ "tables": out }))
}

// ===================== Colonnes =====================

#[tauri::command]
pub fn table_column_add(
    app: tauri::AppHandle,
    table_id: String,
    name: String,
    col_type: Option<String>,
) -> Result<String, String> {
    let conn = open(&app)?;
    let t = col_type.unwrap_or_else(|| "text".into());
    let cid = gen_id(&conn)?;
    conn.execute_batch(&format!(
        "ALTER TABLE {} ADD COLUMN {} {};",
        quote_ident(&format!("t_{table_id}")),
        quote_ident(&format!("c_{cid}")),
        affinity(&t)
    ))
    .map_err(|e| e.to_string())?;
    let ord: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(ordinal),-1)+1 FROM columns WHERE table_id=?1",
            [&table_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO columns(col_id, table_id, name, type, ordinal) VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![cid, table_id, name.trim(), t, ord],
    )
    .map_err(|e| e.to_string())?;
    Ok(cid)
}

#[tauri::command]
pub fn table_column_rename(
    app: tauri::AppHandle,
    col_id: String,
    name: String,
) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute(
        "UPDATE columns SET name=?1 WHERE col_id=?2",
        rusqlite::params![name.trim(), col_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn table_column_retype(
    app: tauri::AppHandle,
    col_id: String,
    col_type: String,
) -> Result<(), String> {
    // On met à jour seulement la métadonnée de type (SQLite étant typé
    // dynamiquement, l'affinité physique n'a pas besoin d'être recréée pour les
    // usages courants ; les valeurs existantes restent lisibles).
    let conn = open(&app)?;
    conn.execute(
        "UPDATE columns SET type=?1 WHERE col_id=?2",
        rusqlite::params![col_type, col_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Pose (ou efface avec `null`) les métadonnées JSON d'une colonne.
#[tauri::command]
pub fn table_column_meta(
    app: tauri::AppHandle,
    col_id: String,
    meta: Option<String>,
) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute(
        "UPDATE columns SET meta=?1 WHERE col_id=?2",
        rusqlite::params![meta, col_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Métadonnées JSON d'une table (formulaire de saisie, libellés, couleur…).
#[tauri::command]
pub fn table_meta_set(
    app: tauri::AppHandle,
    table_id: String,
    meta: Option<String>,
) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute(
        "UPDATE tables SET meta=?1 WHERE table_id=?2",
        rusqlite::params![meta, table_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn table_meta_get(app: tauri::AppHandle, table_id: String) -> Result<Option<String>, String> {
    let conn = open(&app)?;
    conn.query_row(
        "SELECT meta FROM tables WHERE table_id=?1",
        [&table_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Réordonne les colonnes d'une table (ordre d'affichage et du formulaire).
#[tauri::command]
pub fn table_column_reorder(app: tauri::AppHandle, col_ids: Vec<String>) -> Result<(), String> {
    let conn = open(&app)?;
    for (i, id) in col_ids.iter().enumerate() {
        conn.execute(
            "UPDATE columns SET ordinal=?1 WHERE col_id=?2",
            rusqlite::params![i as i64, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn table_column_delete(app: tauri::AppHandle, col_id: String) -> Result<(), String> {
    let conn = open(&app)?;
    let table_id: String = conn
        .query_row(
            "SELECT table_id FROM columns WHERE col_id=?1",
            [&col_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute_batch(&format!(
        "ALTER TABLE {} DROP COLUMN {};",
        quote_ident(&format!("t_{table_id}")),
        quote_ident(&format!("c_{col_id}"))
    ))
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM columns WHERE col_id=?1", [&col_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===================== Lignes =====================

#[tauri::command]
pub fn table_rows(
    app: tauri::AppHandle,
    table_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Value, String> {
    let conn = open(&app)?;
    let cols = schema_cols(&conn, &table_id)?;
    let select_phys: Vec<String> = std::iter::once("id".to_string())
        .chain(cols.iter().map(|c| quote_ident(&format!("c_{}", c.col_id))))
        .collect();
    let lim = limit.unwrap_or(500).clamp(1, 5000);
    let off = offset.unwrap_or(0).max(0);
    let sql = format!(
        "SELECT {} FROM {} ORDER BY id LIMIT {} OFFSET {}",
        select_phys.join(", "),
        quote_ident(&format!("t_{table_id}")),
        lim,
        off
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let ncol = cols.len();
    let rows = stmt
        .query_map([], move |r| {
            let mut obj = serde_json::Map::new();
            obj.insert("_id".into(), json!(r.get::<_, i64>(0)?));
            for (i, c) in cols.iter().enumerate() {
                obj.insert(c.col_id.clone(), json_from_ref(r.get_ref(i + 1)?));
            }
            Ok(Value::Object(obj))
        })
        .map_err(|e| e.to_string())?;
    let data: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(json!({ "rows": data, "columns": ncol }))
}

#[tauri::command]
pub fn table_row_insert(
    app: tauri::AppHandle,
    table_id: String,
    values: Value,
) -> Result<i64, String> {
    let conn = open(&app)?;
    let cols = schema_cols(&conn, &table_id)?;
    let mut names = Vec::new();
    let mut placeholders = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for c in &cols {
        if let Some(v) = values.get(&c.col_id) {
            names.push(quote_ident(&format!("c_{}", c.col_id)));
            placeholders.push(format!("?{}", params.len() + 1));
            params.push(json_to_sql(v));
        }
    }
    let sql = if names.is_empty() {
        format!(
            "INSERT INTO {} DEFAULT VALUES",
            quote_ident(&format!("t_{table_id}"))
        )
    } else {
        format!(
            "INSERT INTO {} ({}) VALUES ({})",
            quote_ident(&format!("t_{table_id}")),
            names.join(", "),
            placeholders.join(", ")
        )
    };
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, refs.as_slice())
        .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn table_row_update(
    app: tauri::AppHandle,
    table_id: String,
    row_id: i64,
    values: Value,
) -> Result<(), String> {
    let conn = open(&app)?;
    let cols = schema_cols(&conn, &table_id)?;
    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for c in &cols {
        if let Some(v) = values.get(&c.col_id) {
            sets.push(format!(
                "{}=?{}",
                quote_ident(&format!("c_{}", c.col_id)),
                params.len() + 1
            ));
            params.push(json_to_sql(v));
        }
    }
    if sets.is_empty() {
        return Ok(());
    }
    params.push(Box::new(row_id));
    let sql = format!(
        "UPDATE {} SET {} WHERE id=?{}",
        quote_ident(&format!("t_{table_id}")),
        sets.join(", "),
        params.len()
    );
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, refs.as_slice())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn table_row_delete(
    app: tauri::AppHandle,
    table_id: String,
    row_id: i64,
) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute(
        &format!(
            "DELETE FROM {} WHERE id=?1",
            quote_ident(&format!("t_{table_id}"))
        ),
        [row_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn json_to_sql(v: &Value) -> Box<dyn rusqlite::ToSql> {
    match v {
        Value::Null => Box::new(Option::<String>::None),
        Value::Bool(b) => Box::new(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else {
                Box::new(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => Box::new(s.clone()),
        other => Box::new(other.to_string()),
    }
}

// ===================== Requête lecture seule (IA / API) =====================

/// Vrai si `sql` est une **unique** requête de lecture (`SELECT`/`WITH`), sans
/// mot-clé d'écriture ni second statement. Défense en profondeur : la connexion
/// est de toute façon ouverte en lecture seule.
fn is_read_only(sql: &str) -> bool {
    // Retire les commentaires de ligne pour l'analyse.
    let cleaned: String = sql
        .lines()
        .map(|l| match l.find("--") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = cleaned.trim().trim_end_matches(';');
    if trimmed.is_empty() || trimmed.contains(';') {
        return false; // statement unique seulement
    }
    let lower = trimmed.to_lowercase();
    if !(lower.starts_with("select") || lower.starts_with("with")) {
        return false;
    }
    const FORBIDDEN: [&str; 12] = [
        "insert", "update", "delete", "drop", "alter", "create", "attach", "detach", "pragma",
        "replace", "vacuum", "reindex",
    ];
    let bytes = lower.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    for kw in FORBIDDEN {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(kw) {
            let s = from + pos;
            let e = s + kw.len();
            let before_ok = s == 0 || !is_word(bytes[s - 1]);
            let after_ok = e >= bytes.len() || !is_word(bytes[e]);
            if before_ok && after_ok {
                return false;
            }
            from = e;
        }
    }
    true
}

/// Crée des TEMP views aux noms conviviaux pour toutes les tables de la base, de
/// sorte que le SQL utilisateur/IA puisse référencer « MaTable » et « MaColonne ».
fn install_friendly_views(conn: &Connection, base_id: &str) -> Result<(), String> {
    let tables = {
        let mut stmt = conn
            .prepare("SELECT table_id, name FROM tables WHERE base_id=?1")
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([base_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        it.filter_map(|r| r.ok()).collect::<Vec<_>>()
    };
    for (table_id, tname) in tables {
        let cols = schema_cols(conn, &table_id)?;
        let mut projs = vec!["id".to_string()];
        for c in &cols {
            projs.push(format!(
                "{} AS {}",
                quote_ident(&format!("c_{}", c.col_id)),
                quote_ident(&c.name)
            ));
        }
        let sql = format!(
            "CREATE TEMP VIEW {} AS SELECT {} FROM {};",
            quote_ident(&tname),
            projs.join(", "),
            quote_ident(&format!("t_{table_id}"))
        );
        conn.execute_batch(&sql).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Exécute un `SELECT` lecture seule contre les tables d'une base (noms
/// conviviaux). Renvoie `{ columns: [..], rows: [[..]] }`. Cœur de l'interrogation IA.
#[tauri::command]
pub fn table_query(app: tauri::AppHandle, base_id: String, sql: String) -> Result<Value, String> {
    if !is_read_only(&sql) {
        return Err(
            "Requête refusée : seules les requêtes de lecture (SELECT) sont autorisées.".into(),
        );
    }
    let conn = open_ro(&app)?;
    install_friendly_views(&conn, &base_id)?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let ncol = col_names.len();
    let rows = stmt
        .query_map([], |r| {
            let mut arr = Vec::with_capacity(ncol);
            for i in 0..ncol {
                arr.push(json_from_ref(r.get_ref(i)?));
            }
            Ok(Value::Array(arr))
        })
        .map_err(|e| e.to_string())?;
    let data: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(json!({ "columns": col_names, "rows": data }))
}

// ===================== CSV =====================

fn csv_escape(s: &str) -> String {
    if s.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn value_to_csv(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => csv_escape(s),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => csv_escape(&other.to_string()),
    }
}

#[tauri::command]
pub fn table_export_csv(app: tauri::AppHandle, table_id: String) -> Result<String, String> {
    let conn = open(&app)?;
    let cols = schema_cols(&conn, &table_id)?;
    let header = cols
        .iter()
        .map(|c| csv_escape(&c.name))
        .collect::<Vec<_>>()
        .join(",");
    let select_phys: Vec<String> = cols
        .iter()
        .map(|c| quote_ident(&format!("c_{}", c.col_id)))
        .collect();
    if select_phys.is_empty() {
        return Ok(header);
    }
    let sql = format!(
        "SELECT {} FROM {} ORDER BY id",
        select_phys.join(", "),
        quote_ident(&format!("t_{table_id}"))
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let ncol = cols.len();
    let rows = stmt
        .query_map([], move |r| {
            let mut cells = Vec::with_capacity(ncol);
            for i in 0..ncol {
                cells.push(value_to_csv(&json_from_ref(r.get_ref(i)?)));
            }
            Ok(cells.join(","))
        })
        .map_err(|e| e.to_string())?;
    let mut out = String::from(&header);
    for r in rows {
        out.push('\n');
        out.push_str(&r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Parse CSV simple (gère les guillemets) en lignes de champs.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut field = String::new();
    let mut row = Vec::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => {
                    row.push(std::mem::take(&mut field));
                }
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                '\r' => {}
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

#[tauri::command]
pub fn table_import_csv(
    app: tauri::AppHandle,
    base_id: String,
    name: String,
    csv: String,
) -> Result<String, String> {
    let rows = parse_csv(&csv);
    if rows.is_empty() {
        return Err("CSV vide".into());
    }
    let header = &rows[0];
    let columns: Vec<Value> = header
        .iter()
        .map(|h| json!({ "name": h.trim(), "type": "text" }))
        .collect();
    let table_id = table_create(app.clone(), base_id, name, Some(columns))?;
    let conn = open(&app)?;
    let cols = schema_cols(&conn, &table_id)?;
    for line in rows.iter().skip(1) {
        if line.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let mut obj = serde_json::Map::new();
        for (i, c) in cols.iter().enumerate() {
            if let Some(val) = line.get(i) {
                obj.insert(c.col_id.clone(), json!(val));
            }
        }
        let _ = table_row_insert(app.clone(), table_id.clone(), Value::Object(obj));
    }
    Ok(table_id)
}
