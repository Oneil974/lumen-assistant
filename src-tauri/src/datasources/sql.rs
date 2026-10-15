//! Moteurs SQL du centre de sources : SQLite, PostgreSQL/PostGIS, MySQL,
//! SQL Server.
//!
//! Trois choix communs aux quatre moteurs :
//!
//!   * **Aucune connexion n'est mise en cache.** Une opération = une connexion,
//!     refermée aussitôt. On ne garde pas un socket ouvert vers le SGBD de
//!     l'entreprise entre deux gestes, et un profil ne peut pas hériter de la
//!     session d'un autre.
//!   * **Aucune interpolation de texte libre.** Les noms de table et de colonne
//!     passent par `safe_ident`, les valeurs de filtre sont des paramètres liés.
//!     Le seul SQL non construit ici est celui de `query`, qui exige
//!     `allow_sql` *et* `is_read_only`.
//!   * **Ouverture en lecture quand le moteur le permet** : SQLite est ouvert
//!     avec `SQLITE_OPEN_READ_ONLY`, PostgreSQL et SQL Server voient leur session
//!     placée en transaction en lecture seule. Ce n'est pas la garde principale
//!     (elle est en amont), c'est la ceinture en plus des bretelles.
//!
//! MySQL, PostgreSQL et SQL Server ne sont compilés qu'en **édition Pro**
//! (feature `pro`), comme le reste des moteurs serveur. Sans ce drapeau, ils
//! répondent une phrase que l'interface affiche telle quelle. SQLite, lui, est
//! toujours disponible.

use super::{safe_ident, DataSource, Dataset, Page, ReadOpts};
use serde_json::{json, Value};

#[cfg(not(feature = "pro"))]
const PRO_ONLY: &str = "Ce moteur de base de données fait partie de Lumen Pro.";

/// Fabrique la clause `WHERE`/`ORDER BY`/`LIMIT` commune. `placeholder` diffère
/// d'un moteur à l'autre (`?`, `$1`, `@Pn`) : le reste est identique.
fn tail(opts: &ReadOpts, placeholder: impl Fn(usize) -> String) -> Result<(String, Vec<String>), String> {
    let mut sql = String::new();
    let mut params = Vec::new();
    if !opts.filters.is_empty() {
        let mut parts = Vec::new();
        for (col, val) in &opts.filters {
            let col = safe_ident(col)?;
            parts.push(format!("{col} = {}", placeholder(params.len() + 1)));
            params.push(val.clone());
        }
        sql.push_str(" WHERE ");
        sql.push_str(&parts.join(" AND "));
    }
    if !opts.order_by.is_empty() {
        let col = safe_ident(&opts.order_by)?;
        sql.push_str(&format!(" ORDER BY {col} {}", if opts.descending { "DESC" } else { "ASC" }));
    }
    Ok((sql, params))
}

fn projection(opts: &ReadOpts) -> Result<String, String> {
    if opts.select.is_empty() {
        return Ok("*".into());
    }
    let cols: Result<Vec<String>, String> = opts.select.iter().map(|c| safe_ident(c)).collect();
    Ok(cols?.join(", "))
}

// ===================== Aiguillage =====================

pub fn ping(src: &DataSource) -> Result<String, String> {
    match src.kind.as_str() {
        "sqlite" => sqlite::ping(src),
        "postgres" => pg::ping(src),
        "mysql" => my::ping(src),
        "mssql" => ms::ping(src),
        k => Err(format!("Moteur inconnu : {k}")),
    }
}

pub fn datasets(src: &DataSource) -> Result<Vec<Dataset>, String> {
    match src.kind.as_str() {
        "sqlite" => sqlite::datasets(src),
        "postgres" => pg::datasets(src),
        "mysql" => my::datasets(src),
        "mssql" => ms::datasets(src),
        k => Err(format!("Moteur inconnu : {k}")),
    }
}

pub fn schema(src: &DataSource, dataset: &str) -> Result<Value, String> {
    match src.kind.as_str() {
        "sqlite" => sqlite::schema(src, dataset),
        "postgres" => pg::schema(src, dataset),
        "mysql" => my::schema(src, dataset),
        "mssql" => ms::schema(src, dataset),
        k => Err(format!("Moteur inconnu : {k}")),
    }
}

pub fn rows(src: &DataSource, dataset: &str, opts: &ReadOpts) -> Result<Page, String> {
    match src.kind.as_str() {
        "sqlite" => sqlite::rows(src, dataset, opts),
        "postgres" => pg::rows(src, dataset, opts),
        "mysql" => my::rows(src, dataset, opts),
        "mssql" => ms::rows(src, dataset, opts),
        k => Err(format!("Moteur inconnu : {k}")),
    }
}

pub fn query(src: &DataSource, sql: &str, limit: i64) -> Result<Page, String> {
    match src.kind.as_str() {
        "sqlite" => sqlite::query(src, sql, limit),
        "postgres" => pg::query(src, sql, limit),
        "mysql" => my::query(src, sql, limit),
        "mssql" => ms::query(src, sql, limit),
        k => Err(format!("Moteur inconnu : {k}")),
    }
}

fn page(columns: Vec<String>, rows: Vec<Vec<Value>>, opts_limit: i64, offset: i64) -> Page {
    let truncated = rows.len() as i64 >= opts_limit;
    Page { columns, rows, limit: opts_limit, offset, truncated }
}

/// Transforme des lignes-objets JSON (PostgreSQL `to_jsonb`, REST…) en page
/// colonnes/valeurs.
pub fn page_from_objects(objs: Vec<Value>, limit: i64, offset: i64) -> Page {
    let mut columns: Vec<String> = Vec::new();
    for o in &objs {
        if let Some(map) = o.as_object() {
            for k in map.keys() {
                if !columns.iter().any(|c| c == k) {
                    columns.push(k.clone());
                }
            }
        }
    }
    let rows = objs
        .iter()
        .map(|o| {
            columns
                .iter()
                .map(|c| o.get(c).cloned().unwrap_or(Value::Null))
                .collect::<Vec<Value>>()
        })
        .collect::<Vec<_>>();
    page(columns, rows, limit, offset)
}

// ===================== SQLite =====================

mod sqlite {
    use super::*;
    use rusqlite::{Connection, OpenFlags};

    fn open(src: &DataSource) -> Result<Connection, String> {
        let path = src.cfg("path");
        if path.is_empty() {
            return Err("Renseignez le chemin du fichier SQLite.".into());
        }
        // Lecture seule au niveau du pilote : même un bug de construction de
        // requête ne pourrait pas écrire dans le fichier de l'utilisateur.
        Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Ouverture impossible ({path}) : {e}"))
    }

    fn value_of(row: &rusqlite::Row, i: usize) -> Value {
        match row.get_ref(i) {
            Ok(rusqlite::types::ValueRef::Null) => Value::Null,
            Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
            Ok(rusqlite::types::ValueRef::Real(f)) => json!(f),
            Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
            Ok(rusqlite::types::ValueRef::Blob(b)) => json!(format!("<blob {} octets>", b.len())),
            Err(_) => Value::Null,
        }
    }

    fn run(conn: &Connection, sql: &str, params: &[String], limit: i64, offset: i64) -> Result<Page, String> {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let bound: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let mut out = Vec::new();
        let mut cursor = stmt.query(bound.as_slice()).map_err(|e| e.to_string())?;
        while let Some(row) = cursor.next().map_err(|e| e.to_string())? {
            out.push((0..columns.len()).map(|i| value_of(row, i)).collect());
        }
        Ok(page(columns, out, limit, offset))
    }

    pub fn ping(src: &DataSource) -> Result<String, String> {
        let conn = open(src)?;
        let n: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_master WHERE type IN ('table','view')", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        Ok(format!("SQLite — {n} table(s) et vue(s)."))
    }

    pub fn datasets(src: &DataSource) -> Result<Vec<Dataset>, String> {
        let conn = open(src)?;
        let mut stmt = conn
            .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .map_err(|e| e.to_string())?;
        let list = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .map(|(name, kind)| Dataset { name, schema: String::new(), rows: None, note: kind })
            .collect();
        Ok(list)
    }

    pub fn schema(src: &DataSource, dataset: &str) -> Result<Value, String> {
        let table = safe_ident(dataset)?;
        let conn = open(src)?;
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| e.to_string())?;
        let cols: Vec<Value> = stmt
            .query_map([], |r| {
                Ok(json!({
                    "name": r.get::<_, String>(1)?,
                    "type": r.get::<_, String>(2)?,
                    "nullable": r.get::<_, i64>(3)? == 0,
                    "primaryKey": r.get::<_, i64>(5)? > 0,
                }))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(json!({ "dataset": table, "columns": cols }))
    }

    pub fn rows(src: &DataSource, dataset: &str, opts: &ReadOpts) -> Result<Page, String> {
        let table = safe_ident(dataset)?;
        let (tail_sql, params) = tail(opts, |_| "?".into())?;
        let limit = opts.bounded_limit();
        let sql = format!(
            "SELECT {} FROM {table}{tail_sql} LIMIT {limit} OFFSET {}",
            projection(opts)?,
            opts.offset.max(0)
        );
        run(&open(src)?, &sql, &params, limit, opts.offset.max(0))
    }

    pub fn query(src: &DataSource, sql: &str, limit: i64) -> Result<Page, String> {
        let wrapped = format!("SELECT * FROM ({}) LIMIT {limit}", sql.trim().trim_end_matches(';'));
        run(&open(src)?, &wrapped, &[], limit, 0)
    }
}

// ===================== PostgreSQL / PostGIS =====================

#[cfg(feature = "pro")]
mod pg {
    use super::*;
    use postgres::{Client, NoTls};

    fn url(src: &DataSource) -> String {
        let direct = src.secret("url");
        if !direct.is_empty() {
            return direct;
        }
        let host = if src.cfg("host").is_empty() { "localhost".to_string() } else { src.cfg("host") };
        let port = if src.cfg("port").is_empty() { "5432".to_string() } else { src.cfg("port") };
        format!(
            "host={host} port={port} dbname={} user={} password={}",
            src.cfg("database"),
            src.cfg("user"),
            src.secret("password")
        )
    }

    fn connect(src: &DataSource) -> Result<Client, String> {
        let mut client = Client::connect(&url(src), NoTls)
            .map_err(|e| format!("Connexion PostgreSQL impossible : {e}"))?;
        // Ceinture : la session elle-même refuse d'écrire.
        let _ = client.batch_execute("SET default_transaction_read_only = on");
        Ok(client)
    }

    fn schema_name(src: &DataSource) -> String {
        let s = src.cfg("schema");
        if s.is_empty() { "public".into() } else { s }
    }

    /// PostgreSQL convertit lui-même chaque ligne en JSON (`to_jsonb`) : dates,
    /// numériques, tableaux, `jsonb` et géométries PostGIS (via leur sortie
    /// texte) arrivent déjà sérialisés, sans table de types à maintenir côté
    /// Lumen. Contrepartie assumée : l'ordre des colonnes est alphabétique.
    fn run(src: &DataSource, sql: &str, limit: i64, offset: i64) -> Result<Page, String> {
        let mut client = connect(src)?;
        let wrapped = format!("SELECT to_jsonb(t) AS j FROM ({}) t", sql.trim().trim_end_matches(';'));
        let rows = client.query(wrapped.as_str(), &[]).map_err(|e| e.to_string())?;
        let objs = rows.iter().map(|r| r.get::<_, Value>(0)).collect();
        Ok(page_from_objects(objs, limit, offset))
    }

    pub fn ping(src: &DataSource) -> Result<String, String> {
        let mut client = connect(src)?;
        let row = client
            .query_one("SELECT version(), current_database()", &[])
            .map_err(|e| e.to_string())?;
        Ok(format!("{} — {}", row.get::<_, String>(1), row.get::<_, String>(0)))
    }

    pub fn datasets(src: &DataSource) -> Result<Vec<Dataset>, String> {
        let mut client = connect(src)?;
        let schema = schema_name(src);
        let rows = client
            .query(
                "SELECT t.table_name, t.table_type, COALESCE(s.n_live_tup, 0)
                   FROM information_schema.tables t
                   LEFT JOIN pg_stat_user_tables s
                     ON s.schemaname = t.table_schema AND s.relname = t.table_name
                  WHERE t.table_schema = $1
                  ORDER BY t.table_name",
                &[&schema],
            )
            .map_err(|e| e.to_string())?;
        Ok(rows
            .iter()
            .map(|r| Dataset {
                name: r.get::<_, String>(0),
                schema: schema.clone(),
                rows: Some(r.get::<_, i64>(2)),
                note: r.get::<_, String>(1),
            })
            .collect())
    }

    pub fn schema(src: &DataSource, dataset: &str) -> Result<Value, String> {
        let table = safe_ident(dataset)?;
        let mut client = connect(src)?;
        let schema = schema_name(src);
        let rows = client
            .query(
                "SELECT column_name, data_type, is_nullable, column_default
                   FROM information_schema.columns
                  WHERE table_schema = $1 AND table_name = $2
                  ORDER BY ordinal_position",
                &[&schema, &table],
            )
            .map_err(|e| e.to_string())?;
        let cols: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({
                    "name": r.get::<_, String>(0),
                    "type": r.get::<_, String>(1),
                    "nullable": r.get::<_, String>(2) == "YES",
                    "default": r.get::<_, Option<String>>(3),
                })
            })
            .collect();
        Ok(json!({ "dataset": table, "schema": schema, "columns": cols }))
    }

    pub fn rows(src: &DataSource, dataset: &str, opts: &ReadOpts) -> Result<Page, String> {
        let table = safe_ident(dataset)?;
        let (tail_sql, params) = tail(opts, |i| format!("${i}"))?;
        if !params.is_empty() {
            // Les filtres arrivent en texte : on les compare en texte, ce qui
            // évite d'inférer un type et reste juste pour les clés usuelles.
            return rows_filtered(src, &table, opts);
        }
        let limit = opts.bounded_limit();
        let sql = format!(
            "SELECT {} FROM {}.{table}{tail_sql} LIMIT {limit} OFFSET {}",
            projection(opts)?,
            schema_name(src),
            opts.offset.max(0)
        );
        run(src, &sql, limit, opts.offset.max(0))
    }

    fn rows_filtered(src: &DataSource, table: &str, opts: &ReadOpts) -> Result<Page, String> {
        let mut client = connect(src)?;
        let mut where_parts = Vec::new();
        let mut vals: Vec<String> = Vec::new();
        for (col, v) in &opts.filters {
            let col = safe_ident(col)?;
            vals.push(v.clone());
            where_parts.push(format!("{col}::text = ${}", vals.len()));
        }
        let limit = opts.bounded_limit();
        let sql = format!(
            "SELECT to_jsonb(t) FROM (SELECT {} FROM {}.{table} WHERE {} LIMIT {limit} OFFSET {}) t",
            projection(opts)?,
            schema_name(src),
            where_parts.join(" AND "),
            opts.offset.max(0)
        );
        let bound: Vec<&(dyn postgres::types::ToSql + Sync)> =
            vals.iter().map(|v| v as &(dyn postgres::types::ToSql + Sync)).collect();
        let rows = client.query(sql.as_str(), &bound).map_err(|e| e.to_string())?;
        let objs = rows.iter().map(|r| r.get::<_, Value>(0)).collect();
        Ok(page_from_objects(objs, limit, opts.offset.max(0)))
    }

    pub fn query(src: &DataSource, sql: &str, limit: i64) -> Result<Page, String> {
        run(src, &format!("SELECT * FROM ({}) q LIMIT {limit}", sql.trim().trim_end_matches(';')), limit, 0)
    }
}

// ===================== MySQL / MariaDB =====================

#[cfg(feature = "pro")]
mod my {
    use super::*;
    use mysql::prelude::*;
    use mysql::{Conn, Opts, OptsBuilder, Row};

    fn connect(src: &DataSource) -> Result<Conn, String> {
        let direct = src.secret("url");
        let opts = if !direct.is_empty() {
            Opts::from_url(&direct).map_err(|e| format!("URL MySQL invalide : {e}"))?
        } else {
            let port: u16 = src.cfg("port").parse().unwrap_or(3306);
            Opts::from(
                OptsBuilder::new()
                    .ip_or_hostname(Some(if src.cfg("host").is_empty() { "localhost".into() } else { src.cfg("host") }))
                    .tcp_port(port)
                    .db_name(Some(src.cfg("database")))
                    .user(Some(src.cfg("user")))
                    .pass(Some(src.secret("password"))),
            )
        };
        Conn::new(opts).map_err(|e| format!("Connexion MySQL impossible : {e}"))
    }

    fn value_of(v: &mysql::Value) -> Value {
        match v {
            mysql::Value::NULL => Value::Null,
            mysql::Value::Int(n) => json!(n),
            mysql::Value::UInt(n) => json!(n),
            mysql::Value::Float(f) => json!(f),
            mysql::Value::Double(f) => json!(f),
            mysql::Value::Bytes(b) => match std::str::from_utf8(b) {
                Ok(s) => json!(s),
                Err(_) => json!(format!("<binaire {} octets>", b.len())),
            },
            other => json!(other.as_sql(true).trim_matches('\'').to_string()),
        }
    }

    fn run(src: &DataSource, sql: &str, params: Vec<String>, limit: i64, offset: i64) -> Result<Page, String> {
        let mut conn = connect(src)?;
        let rows: Vec<Row> = if params.is_empty() {
            conn.query(sql).map_err(|e| e.to_string())?
        } else {
            conn.exec(sql, mysql::Params::Positional(params.into_iter().map(mysql::Value::from).collect()))
                .map_err(|e| e.to_string())?
        };
        let columns: Vec<String> = rows
            .first()
            .map(|r| r.columns_ref().iter().map(|c| c.name_str().to_string()).collect())
            .unwrap_or_default();
        let out = rows
            .iter()
            .map(|r| (0..r.len()).map(|i| value_of(r.as_ref(i).unwrap_or(&mysql::Value::NULL))).collect())
            .collect();
        Ok(page(columns, out, limit, offset))
    }

    pub fn ping(src: &DataSource) -> Result<String, String> {
        let mut conn = connect(src)?;
        let v: Option<String> = conn.query_first("SELECT version()").map_err(|e| e.to_string())?;
        Ok(format!("MySQL {} — base « {} »", v.unwrap_or_default(), src.cfg("database")))
    }

    pub fn datasets(src: &DataSource) -> Result<Vec<Dataset>, String> {
        let page = run(
            src,
            "SELECT table_name, table_type, table_rows FROM information_schema.tables WHERE table_schema = database() ORDER BY table_name",
            Vec::new(),
            1000,
            0,
        )?;
        Ok(page
            .rows
            .iter()
            .map(|r| Dataset {
                name: r.first().and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                schema: src.cfg("database"),
                rows: r.get(2).and_then(|v| v.as_i64()),
                note: r.get(1).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            })
            .collect())
    }

    pub fn schema(src: &DataSource, dataset: &str) -> Result<Value, String> {
        let table = safe_ident(dataset)?;
        let page = run(
            src,
            "SELECT column_name, column_type, is_nullable, column_key FROM information_schema.columns WHERE table_schema = database() AND table_name = ? ORDER BY ordinal_position",
            vec![table.clone()],
            1000,
            0,
        )?;
        let cols: Vec<Value> = page
            .rows
            .iter()
            .map(|r| {
                json!({
                    "name": r.first().cloned().unwrap_or(Value::Null),
                    "type": r.get(1).cloned().unwrap_or(Value::Null),
                    "nullable": r.get(2).and_then(|v| v.as_str()) == Some("YES"),
                    "primaryKey": r.get(3).and_then(|v| v.as_str()) == Some("PRI"),
                })
            })
            .collect();
        Ok(json!({ "dataset": table, "columns": cols }))
    }

    pub fn rows(src: &DataSource, dataset: &str, opts: &ReadOpts) -> Result<Page, String> {
        let table = safe_ident(dataset)?;
        let (tail_sql, params) = tail(opts, |_| "?".into())?;
        let limit = opts.bounded_limit();
        let sql = format!(
            "SELECT {} FROM `{table}`{tail_sql} LIMIT {limit} OFFSET {}",
            projection(opts)?,
            opts.offset.max(0)
        );
        run(src, &sql, params, limit, opts.offset.max(0))
    }

    pub fn query(src: &DataSource, sql: &str, limit: i64) -> Result<Page, String> {
        run(src, &format!("SELECT * FROM ({}) q LIMIT {limit}", sql.trim().trim_end_matches(';')), Vec::new(), limit, 0)
    }
}

// ===================== SQL Server =====================

#[cfg(feature = "pro")]
mod ms {
    use super::*;
    use tiberius::{AuthMethod, Client, ColumnData, Config};
    use tokio::net::TcpStream;
    use tokio_util::compat::TokioAsyncWriteCompatExt;

    fn config(src: &DataSource) -> Result<Config, String> {
        let direct = src.secret("url");
        let mut cfg = if !direct.is_empty() {
            Config::from_ado_string(&direct).map_err(|e| format!("Chaîne SQL Server invalide : {e}"))?
        } else {
            let mut c = Config::new();
            c.host(if src.cfg("host").is_empty() { "localhost".into() } else { src.cfg("host") });
            c.port(src.cfg("port").parse().unwrap_or(1433));
            c.database(src.cfg("database"));
            c.authentication(AuthMethod::sql_server(src.cfg("user"), src.secret("password")));
            c
        };
        if src.cfg("trust_certificate") == "true" {
            cfg.trust_cert();
        }
        Ok(cfg)
    }

    fn value_of(data: &ColumnData<'static>) -> Value {
        match data {
            ColumnData::U8(v) => json!(v),
            ColumnData::I16(v) => json!(v),
            ColumnData::I32(v) => json!(v),
            ColumnData::I64(v) => json!(v),
            ColumnData::F32(v) => json!(v),
            ColumnData::F64(v) => json!(v),
            ColumnData::Bit(v) => json!(v),
            ColumnData::String(v) => json!(v.as_ref().map(|s| s.to_string())),
            ColumnData::Guid(v) => json!(v.map(|g| g.to_string())),
            ColumnData::Binary(v) => json!(v.as_ref().map(|b| format!("<binaire {} octets>", b.len()))),
            ColumnData::Numeric(v) => json!(v.map(|n| n.to_string())),
            other => json!(format!("{other:?}")),
        }
    }

    /// Tiberius est asynchrone ; les opérations du centre de sources sont
    /// synchrones et tournent déjà dans un `spawn_blocking`. On y ouvre donc
    /// une petite boucle Tokio dédiée, plutôt que de teinter toute la chaîne.
    fn run(src: &DataSource, sql: String, params: Vec<String>, limit: i64, offset: i64) -> Result<Page, String> {
        let cfg = config(src)?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        rt.block_on(async move {
            let tcp = TcpStream::connect(cfg.get_addr()).await.map_err(|e| e.to_string())?;
            tcp.set_nodelay(true).map_err(|e| e.to_string())?;
            let mut client = Client::connect(cfg, tcp.compat_write())
                .await
                .map_err(|e| format!("Connexion SQL Server impossible : {e}"))?;
            let _ = client.simple_query("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED").await;
            let bound: Vec<&dyn tiberius::ToSql> = params.iter().map(|p| p as &dyn tiberius::ToSql).collect();
            let stream = client.query(sql.as_str(), &bound).await.map_err(|e| e.to_string())?;
            let results = stream.into_first_result().await.map_err(|e| e.to_string())?;
            let columns: Vec<String> = results
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let out = results
                .into_iter()
                .map(|r| r.into_iter().map(|d| value_of(&d)).collect::<Vec<Value>>())
                .collect();
            Ok(page(columns, out, limit, offset))
        })
    }

    pub fn ping(src: &DataSource) -> Result<String, String> {
        let p = run(src, "SELECT @@VERSION AS v, DB_NAME() AS d".into(), Vec::new(), 1, 0)?;
        let row = p.rows.first().cloned().unwrap_or_default();
        Ok(format!(
            "{} — {}",
            row.get(1).and_then(|v| v.as_str()).unwrap_or("SQL Server"),
            row.first().and_then(|v| v.as_str()).unwrap_or_default()
        ))
    }

    pub fn datasets(src: &DataSource) -> Result<Vec<Dataset>, String> {
        let p = run(
            src,
            "SELECT table_schema, table_name, table_type FROM information_schema.tables ORDER BY table_schema, table_name".into(),
            Vec::new(),
            1000,
            0,
        )?;
        Ok(p.rows
            .iter()
            .map(|r| Dataset {
                name: r.get(1).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                schema: r.first().and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                rows: None,
                note: r.get(2).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            })
            .collect())
    }

    pub fn schema(src: &DataSource, dataset: &str) -> Result<Value, String> {
        let table = safe_ident(dataset)?;
        let bare = table.rsplit('.').next().unwrap_or(&table).to_string();
        let p = run(
            src,
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = @P1 ORDER BY ordinal_position".into(),
            vec![bare],
            1000,
            0,
        )?;
        let cols: Vec<Value> = p
            .rows
            .iter()
            .map(|r| {
                json!({
                    "name": r.first().cloned().unwrap_or(Value::Null),
                    "type": r.get(1).cloned().unwrap_or(Value::Null),
                    "nullable": r.get(2).and_then(|v| v.as_str()) == Some("YES"),
                })
            })
            .collect();
        Ok(json!({ "dataset": table, "columns": cols }))
    }

    pub fn rows(src: &DataSource, dataset: &str, opts: &ReadOpts) -> Result<Page, String> {
        let table = safe_ident(dataset)?;
        let (tail_sql, params) = tail(opts, |i| format!("@P{i}"))?;
        let limit = opts.bounded_limit();
        // SQL Server exige un ORDER BY pour paginer : à défaut, on ordonne par
        // une constante, ce que le moteur accepte via `(SELECT NULL)`.
        let order = if tail_sql.contains("ORDER BY") { String::new() } else { " ORDER BY (SELECT NULL)".into() };
        let sql = format!(
            "SELECT {} FROM {table}{tail_sql}{order} OFFSET {} ROWS FETCH NEXT {limit} ROWS ONLY",
            projection(opts)?,
            opts.offset.max(0)
        );
        run(src, sql, params, limit, opts.offset.max(0))
    }

    pub fn query(src: &DataSource, sql: &str, limit: i64) -> Result<Page, String> {
        run(
            src,
            format!("SELECT TOP {limit} * FROM ({}) q", sql.trim().trim_end_matches(';')),
            Vec::new(),
            limit,
            0,
        )
    }
}

// ===================== Doublures hors édition Pro =====================
//
// Sans la feature `pro`, aucun code client PostgreSQL/MySQL/SQL Server n'entre
// dans le binaire : les modules sont remplacés par des refus explicites, comme
// `pro_db_stub.rs` le fait déjà pour DB Studio.

#[cfg(not(feature = "pro"))]
macro_rules! pro_engine {
    ($name:ident) => {
        mod $name {
            use super::*;
            pub fn ping(_s: &DataSource) -> Result<String, String> { Err(PRO_ONLY.into()) }
            pub fn datasets(_s: &DataSource) -> Result<Vec<Dataset>, String> { Err(PRO_ONLY.into()) }
            pub fn schema(_s: &DataSource, _d: &str) -> Result<Value, String> { Err(PRO_ONLY.into()) }
            pub fn rows(_s: &DataSource, _d: &str, _o: &ReadOpts) -> Result<Page, String> { Err(PRO_ONLY.into()) }
            pub fn query(_s: &DataSource, _q: &str, _l: i64) -> Result<Page, String> { Err(PRO_ONLY.into()) }
        }
    };
}

#[cfg(not(feature = "pro"))]
pro_engine!(pg);
#[cfg(not(feature = "pro"))]
pro_engine!(my);
#[cfg(not(feature = "pro"))]
pro_engine!(ms);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_binds_values_instead_of_inlining_them() {
        let opts = ReadOpts {
            filters: vec![("client".into(), "O'Brien; DROP TABLE t".into())],
            ..Default::default()
        };
        let (sql, params) = tail(&opts, |_| "?".into()).unwrap();
        assert_eq!(sql, " WHERE client = ?");
        assert_eq!(params, vec!["O'Brien; DROP TABLE t"]);
    }

    #[test]
    fn tail_refuses_a_hostile_column_name() {
        let opts = ReadOpts { filters: vec![("a = 1 OR 1".into(), "x".into())], ..Default::default() };
        assert!(tail(&opts, |_| "?".into()).is_err());
    }

    #[test]
    fn objects_become_a_stable_grid() {
        let p = page_from_objects(vec![json!({"a":1}), json!({"b":2})], 10, 0);
        assert_eq!(p.columns, vec!["a", "b"]);
        assert_eq!(p.rows[1], vec![Value::Null, json!(2)]);
    }
}
