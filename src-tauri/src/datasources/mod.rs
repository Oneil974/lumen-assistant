//! **Centre de sources de données** — registre de connexions et mise à
//! disposition de leur contenu, *en lecture seule*, pour les applications de
//! l'édition Pro et pour les modèles.
//!
//! # Pourquoi un module à part
//!
//! Lumen sait déjà lire ses propres tables (`tables.rs`), ses documents
//! (`rag.rs`) et sa sandbox (`sandbox.rs`). Ce qui manquait, c'est le *dehors* :
//! le PostgreSQL métier, le partage SharePoint, le bucket MinIO, le dépôt
//! GitHub. Ce module les déclare une fois, au même endroit, et les expose
//! ensuite par une seule porte.
//!
//! # La règle qui structure tout : lecture seule par construction
//!
//! L'écriture n'est pas « interdite par une vérification » — elle **n'existe
//! pas**. Il n'y a aucune fonction d'écriture dans ce module, donc rien à
//! contourner :
//!
//!   1. Le vocabulaire est fermé (`Op`) : lister, décrire, lire des lignes, lire
//!      un objet. Un modèle ne peut pas inventer un cinquième verbe.
//!   2. Côté HTTP, seul `GET` est routé pour les données ; les autres méthodes
//!      renvoient 405. La seule exception est `POST /v1/sources/:id/query`, qui
//!      transporte un SQL trop long pour une URL — et ce SQL passe par
//!      `is_read_only` (un unique SELECT/WITH, sans mot-clé d'écriture), la même
//!      garde que le NL→SQL de `tables.rs` et de `pro_db.rs`.
//!   3. Vers les connecteurs distants, seuls `GET`/`PROPFIND` (WebDAV) sont
//!      émis. Aucun `PUT`, `POST`, `DELETE`, `MKCOL` n'est construit nulle part.
//!   4. `allow_sql` est faux par défaut : sans geste explicite de
//!      l'utilisateur dans l'interface, même un SELECT libre est refusé et il ne
//!      reste que les opérations cataloguées.
//!
//! # Secrets
//!
//! Mots de passe, jetons et clés vivent dans `secrets`, jamais renvoyés à
//! l'interface (masqués par `redact`) ni au modèle. Le fichier est en 0600, à
//! côté de `mcp.json`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::Manager;

mod files;
mod remote;
pub mod server;
mod sql;

/// Longueur maximale d'une page de résultats. Une source distante ne doit pas
/// pouvoir faire exploser la mémoire de Lumen parce qu'un modèle a demandé
/// « toutes les lignes ».
pub const MAX_LIMIT: i64 = 5_000;
pub const DEFAULT_LIMIT: i64 = 200;
/// Taille maximale d'un objet lu (fichier, blob, réponse REST) : 16 Mio.
pub const MAX_OBJECT_BYTES: usize = 16 * 1024 * 1024;

// ===================== Modèle =====================

/// Familles de connecteurs. La liste est **fermée** : ajouter un connecteur est
/// un geste de développement, jamais une donnée que le modèle fournit.
pub const KINDS: [&str; 14] = [
    "postgres",   // PostgreSQL / PostGIS
    "mysql",      // MySQL / MariaDB
    "sqlite",     // fichier .db / .sqlite
    "mssql",      // SQL Server
    "excel",      // .xlsx / .xls / .ods (un classeur = un jeu de données par feuille)
    "csv",        // un fichier ou un dossier de fichiers
    "rest",       // API REST tierce (endpoints déclarés)
    "webdav",     // WebDAV générique
    "s3",         // S3 / MinIO
    "sharepoint", // SharePoint (Microsoft Graph)
    "onedrive",   // OneDrive (Microsoft Graph)
    "gdrive",     // Google Drive
    "nextcloud",  // Nextcloud (WebDAV + jeton d'app)
    "github",     // dépôt GitHub (contenu et métadonnées)
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataSource {
    pub id: String,
    pub name: String,
    /// L'une des valeurs de [`KINDS`].
    pub kind: String,
    /// Une source désactivée n'est ni interrogeable par l'API, ni visible du
    /// modèle : c'est le même principe que les serveurs MCP dormants.
    #[serde(default)]
    pub enabled: bool,
    /// Réglages non secrets (hôte, base, chemin, région, préfixe…).
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    /// Mots de passe, jetons, clés. Jamais renvoyés en clair.
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
    /// Autorise `POST /query` (un unique SELECT). Faux par défaut.
    #[serde(default)]
    pub allow_sql: bool,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub updated_at: u64,
}

impl DataSource {
    pub fn cfg(&self, key: &str) -> String {
        self.config.get(key).cloned().unwrap_or_default()
    }
    pub fn secret(&self, key: &str) -> String {
        self.secrets.get(key).cloned().unwrap_or_default()
    }
    /// Copie sans secrets, pour l'interface et pour l'API.
    pub fn redacted(&self) -> Value {
        let keys: Vec<&String> = self.secrets.keys().filter(|k| !self.secret(k).is_empty()).collect();
        json!({
            "id": self.id, "name": self.name, "kind": self.kind,
            "enabled": self.enabled, "config": self.config,
            "secretKeys": keys, "allowSql": self.allow_sql,
            "note": self.note, "updatedAt": self.updated_at,
            "capabilities": capabilities(&self.kind),
        })
    }
}

/// Ce qu'un connecteur sait faire. Sert à l'interface (griser un bouton) et à
/// l'API (`GET /v1/sources` le publie) — donc à ce que le modèle sache
/// d'emblée qu'il ne peut pas demander autre chose.
pub fn capabilities(kind: &str) -> Value {
    let tabular = matches!(kind, "postgres" | "mysql" | "sqlite" | "mssql" | "excel" | "csv" | "rest");
    let objects = matches!(
        kind,
        "webdav" | "s3" | "sharepoint" | "onedrive" | "gdrive" | "nextcloud" | "github" | "csv" | "excel"
    );
    let sql = matches!(kind, "postgres" | "mysql" | "sqlite" | "mssql");
    json!({ "datasets": tabular, "objects": objects, "sql": sql, "readOnly": true })
}

/// Un « jeu de données » : table SQL, feuille de classeur, fichier CSV, ou
/// point d'entrée REST déclaré.
#[derive(Debug, Clone, Serialize)]
pub struct Dataset {
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub schema: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<i64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// Une entrée de « système de fichiers » : dossier ou objet.
#[derive(Debug, Clone, Serialize)]
pub struct ObjectEntry {
    pub path: String,
    pub name: String,
    pub dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub modified: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mime: String,
}

/// Page de lignes renvoyée par toutes les sources tabulaires, quelle que soit
/// leur nature : une seule forme à apprendre côté applications Pro.
#[derive(Debug, Clone, Serialize)]
pub struct Page {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub limit: i64,
    pub offset: i64,
    pub truncated: bool,
}

/// Options de lecture. Volontairement pauvres : pagination, projection,
/// égalités simples, tri. Rien qui puisse exprimer un effet de bord.
#[derive(Debug, Clone, Default)]
pub struct ReadOpts {
    pub limit: i64,
    pub offset: i64,
    pub select: Vec<String>,
    pub filters: Vec<(String, String)>,
    pub order_by: String,
    pub descending: bool,
}

impl ReadOpts {
    pub fn bounded_limit(&self) -> i64 {
        if self.limit <= 0 { DEFAULT_LIMIT } else { self.limit.min(MAX_LIMIT) }
    }
}

// ===================== Garde lecture seule =====================

/// Vrai si `sql` est une lecture unique. Même politique que `pro_db::is_read_only`
/// et que le NL→SQL de `tables.rs` : un seul ordre, commençant par SELECT ou
/// WITH, sans point-virgule intermédiaire, sans aucun mot-clé d'écriture — un
/// CTE `WITH x AS (INSERT …)` est donc refusé lui aussi.
pub fn is_read_only(sql: &str) -> bool {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() || trimmed.contains(';') {
        return false;
    }
    let head = trimmed.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    if !(head == "select" || head == "with") {
        return false;
    }
    let lower = format!(" {} ", trimmed.to_ascii_lowercase().replace(['(', ')', '\n', '\t', ','], " "));
    const FORBIDDEN: [&str; 20] = [
        " insert ", " update ", " delete ", " drop ", " alter ", " create ", " truncate ",
        " grant ", " revoke ", " copy ", " call ", " do ", " merge ", " replace ", " attach ",
        " pragma ", " vacuum ", " exec ", " execute ", " into ",
    ];
    !FORBIDDEN.iter().any(|k| lower.contains(k))
}

/// Identifiant SQL sûr (table, colonne) : lettres, chiffres, `_`, et un point
/// pour `schema.table`. Tout le reste est refusé — aucune concaténation de SQL
/// ne reçoit donc jamais de texte libre.
pub fn safe_ident(ident: &str) -> Result<String, String> {
    let ok = !ident.is_empty()
        && ident.len() <= 128
        && ident.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '$');
    if ok { Ok(ident.to_string()) } else { Err(format!("Identifiant refusé : {ident}")) }
}

/// Normalise un chemin d'objet : pas de `..`, pas de racine absolue. Vaut pour
/// les connecteurs fichiers locaux comme pour les distants.
pub fn safe_path(path: &str) -> Result<String, String> {
    let p = path.trim().trim_start_matches('/').to_string();
    if p.split('/').any(|seg| seg == "..") {
        return Err("Chemin refusé".into());
    }
    Ok(p)
}

// ===================== Stockage =====================

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("datasources.json"))
}

pub fn read_sources(app: &tauri::AppHandle) -> Vec<DataSource> {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_sources(app: &tauri::AppHandle, list: &[DataSource]) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn find(app: &tauri::AppHandle, id: &str) -> Result<DataSource, String> {
    read_sources(app)
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Source inconnue : {id}"))
}

/// Source **utilisable** : elle existe et elle est activée. Toute l'API passe
/// par ici, jamais par `find` : une source désactivée est invisible du dehors.
pub fn find_enabled(app: &tauri::AppHandle, id: &str) -> Result<DataSource, String> {
    let src = find(app, id)?;
    if !src.enabled {
        return Err(format!("Source désactivée : {}", src.name));
    }
    Ok(src)
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ===================== Aiguillage des opérations =====================

pub fn list_datasets(src: &DataSource) -> Result<Vec<Dataset>, String> {
    match src.kind.as_str() {
        "postgres" | "mysql" | "sqlite" | "mssql" => sql::datasets(src),
        "excel" | "csv" => files::datasets(src),
        "rest" => remote::rest_datasets(src),
        _ => Err(format!("« {} » n'expose pas de jeux de données tabulaires ; utilisez /objects.", src.kind)),
    }
}

pub fn schema(src: &DataSource, dataset: &str) -> Result<Value, String> {
    match src.kind.as_str() {
        "postgres" | "mysql" | "sqlite" | "mssql" => sql::schema(src, dataset),
        "excel" | "csv" => files::schema(src, dataset),
        "rest" => remote::rest_schema(src, dataset),
        _ => Err(format!("Pas de schéma pour « {} ».", src.kind)),
    }
}

pub fn rows(src: &DataSource, dataset: &str, opts: &ReadOpts) -> Result<Page, String> {
    match src.kind.as_str() {
        "postgres" | "mysql" | "sqlite" | "mssql" => sql::rows(src, dataset, opts),
        "excel" | "csv" => files::rows(src, dataset, opts),
        "rest" => remote::rest_rows(src, dataset, opts),
        _ => Err(format!("« {} » ne renvoie pas de lignes ; utilisez /objects.", src.kind)),
    }
}

pub fn objects(src: &DataSource, path: &str) -> Result<Vec<ObjectEntry>, String> {
    match src.kind.as_str() {
        "excel" | "csv" => files::objects(src, path),
        "webdav" | "nextcloud" => remote::webdav_list(src, path),
        "s3" => remote::s3_list(src, path),
        "sharepoint" | "onedrive" => remote::graph_list(src, path),
        "gdrive" => remote::gdrive_list(src, path),
        "github" => remote::github_list(src, path),
        _ => Err(format!("« {} » n'expose pas d'objets.", src.kind)),
    }
}

pub fn object(src: &DataSource, path: &str) -> Result<Value, String> {
    match src.kind.as_str() {
        "excel" | "csv" => files::object(src, path),
        "webdav" | "nextcloud" => remote::webdav_get(src, path),
        "s3" => remote::s3_get(src, path),
        "sharepoint" | "onedrive" => remote::graph_get(src, path),
        "gdrive" => remote::gdrive_get(src, path),
        "github" => remote::github_get(src, path),
        _ => Err(format!("« {} » n'expose pas d'objets.", src.kind)),
    }
}

/// SELECT libre. Deux verrous, tous deux nécessaires : la source doit
/// l'autoriser (`allow_sql`, faux par défaut), et le texte doit passer
/// `is_read_only`.
pub fn query(src: &DataSource, sql_text: &str, limit: i64) -> Result<Page, String> {
    if !src.allow_sql {
        return Err(format!(
            "Le SQL libre est désactivé sur « {} ». Utilisez les jeux de données catalogués.",
            src.name
        ));
    }
    if !is_read_only(sql_text) {
        return Err("Requête refusée : seule une lecture unique (SELECT / WITH) est acceptée.".into());
    }
    sql::query(src, sql_text, if limit <= 0 { DEFAULT_LIMIT } else { limit.min(MAX_LIMIT) })
}

/// Vérifie qu'une source répond, et décrit ce qu'elle a trouvé. C'est le premier
/// geste de l'interface après la saisie des réglages.
pub fn ping(src: &DataSource) -> Result<String, String> {
    match src.kind.as_str() {
        "postgres" | "mysql" | "sqlite" | "mssql" => sql::ping(src),
        "excel" | "csv" => files::ping(src),
        "rest" => remote::rest_ping(src),
        _ => {
            let n = objects(src, "")?.len();
            Ok(format!("Connecté — {n} entrée(s) à la racine."))
        }
    }
}

// ===================== Commandes Tauri =====================

#[tauri::command]
pub fn datasources_kinds() -> Value {
    json!(KINDS
        .iter()
        .map(|k| json!({ "kind": k, "capabilities": capabilities(k) }))
        .collect::<Vec<_>>())
}

#[tauri::command]
pub fn datasources_list(app: tauri::AppHandle) -> Vec<Value> {
    read_sources(&app).iter().map(|s| s.redacted()).collect()
}

/// Crée ou met à jour une source. Les secrets absents de la charge utile sont
/// **conservés** : l'interface n'a jamais à les relire pour les réécrire.
#[tauri::command]
pub fn datasources_save(
    app: tauri::AppHandle,
    id: Option<String>,
    name: String,
    kind: String,
    config: Option<BTreeMap<String, String>>,
    secrets: Option<BTreeMap<String, String>>,
    enabled: Option<bool>,
    allow_sql: Option<bool>,
    note: Option<String>,
) -> Result<Value, String> {
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("Type de source inconnu : {kind}"));
    }
    if name.trim().is_empty() {
        return Err("Donnez un nom à la source.".into());
    }
    let mut list = read_sources(&app);
    let id = id.filter(|s| !s.is_empty()).unwrap_or_else(|| format!("ds_{}", now()));
    let existing = list.iter().position(|s| s.id == id);
    let mut src = match existing {
        Some(i) => list[i].clone(),
        None => DataSource {
            id: id.clone(),
            name: name.clone(),
            kind: kind.clone(),
            enabled: false,
            config: BTreeMap::new(),
            secrets: BTreeMap::new(),
            allow_sql: false,
            note: String::new(),
            updated_at: 0,
        },
    };
    src.name = name;
    src.kind = kind;
    if let Some(c) = config {
        src.config = c;
    }
    if let Some(s) = secrets {
        for (k, v) in s {
            if v.is_empty() {
                src.secrets.remove(&k);
            } else {
                src.secrets.insert(k, v);
            }
        }
    }
    if let Some(e) = enabled {
        src.enabled = e;
    }
    if let Some(a) = allow_sql {
        src.allow_sql = a;
    }
    if let Some(n) = note {
        src.note = n;
    }
    src.updated_at = now();
    let out = src.redacted();
    match existing {
        Some(i) => list[i] = src,
        None => list.push(src),
    }
    write_sources(&app, &list)?;
    Ok(out)
}

#[tauri::command]
pub fn datasources_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut list = read_sources(&app);
    list.retain(|s| s.id != id);
    write_sources(&app, &list)
}

#[tauri::command]
pub fn datasources_ping(app: tauri::AppHandle, id: String) -> Result<String, String> {
    ping(&find(&app, &id)?)
}

#[tauri::command]
pub fn datasources_datasets(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    Ok(json!(list_datasets(&find_enabled(&app, &id)?)?))
}

#[tauri::command]
pub fn datasources_schema(app: tauri::AppHandle, id: String, dataset: String) -> Result<Value, String> {
    schema(&find_enabled(&app, &id)?, &dataset)
}

#[tauri::command]
pub fn datasources_rows(
    app: tauri::AppHandle,
    id: String,
    dataset: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Value, String> {
    let opts = ReadOpts {
        limit: limit.unwrap_or(DEFAULT_LIMIT),
        offset: offset.unwrap_or(0),
        ..Default::default()
    };
    Ok(json!(rows(&find_enabled(&app, &id)?, &dataset, &opts)?))
}

#[tauri::command]
pub fn datasources_objects(app: tauri::AppHandle, id: String, path: Option<String>) -> Result<Value, String> {
    Ok(json!(objects(&find_enabled(&app, &id)?, &path.unwrap_or_default())?))
}

#[tauri::command]
pub fn datasources_object(app: tauri::AppHandle, id: String, path: String) -> Result<Value, String> {
    object(&find_enabled(&app, &id)?, &path)
}

#[tauri::command]
pub fn datasources_query(
    app: tauri::AppHandle,
    id: String,
    sql: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    Ok(json!(query(&find_enabled(&app, &id)?, &sql, limit.unwrap_or(DEFAULT_LIMIT))?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_single_reads_pass() {
        assert!(is_read_only("SELECT * FROM t"));
        assert!(is_read_only("  with x as (select 1) select * from x  ;"));
        assert!(!is_read_only("SELECT 1; DROP TABLE t"));
        assert!(!is_read_only("WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x"));
        assert!(!is_read_only("UPDATE t SET a = 1"));
        assert!(!is_read_only("select * from t into outfile '/tmp/x'"));
        assert!(!is_read_only(""));
    }

    #[test]
    fn identifiers_and_paths_are_bounded() {
        assert!(safe_ident("public.clients").is_ok());
        assert!(safe_ident("clients; drop table x").is_err());
        assert!(safe_ident("").is_err());
        assert_eq!(safe_path("/a/b.csv").unwrap(), "a/b.csv");
        assert!(safe_path("../secrets").is_err());
    }

    #[test]
    fn secrets_never_leave_redacted() {
        let mut src = DataSource {
            id: "x".into(), name: "n".into(), kind: "postgres".into(), enabled: true,
            config: BTreeMap::new(), secrets: BTreeMap::new(), allow_sql: false,
            note: String::new(), updated_at: 0,
        };
        src.secrets.insert("password".into(), "hunter2".into());
        let text = src.redacted().to_string();
        assert!(!text.contains("hunter2"));
        assert!(text.contains("password"));
    }
}
