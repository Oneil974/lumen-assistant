//! **API du centre de sources** : un serveur HTTP local, de style REST, doublé
//! d'un point d'entrée MCP.
//!
//! # Pourquoi REST plutôt qu'un outil libre
//!
//! Un modèle à qui l'on donne « une base de données » finit par écrire du SQL
//! arbitraire. Ici il ne reçoit pas une base : il reçoit **des URL**, et l'API
//! n'expose que des lectures. Le vocabulaire est fini et lisible :
//!
//! ```text
//! GET  /v1/sources                                  liste des sources activées
//! GET  /v1/sources/:id                              détail et capacités
//! GET  /v1/sources/:id/datasets                     tables, feuilles, endpoints
//! GET  /v1/sources/:id/datasets/:name/schema        colonnes et types
//! GET  /v1/sources/:id/datasets/:name/rows          lignes (limit/offset/select/order)
//! GET  /v1/sources/:id/objects?path=                dossiers et fichiers
//! GET  /v1/sources/:id/object?path=                 contenu d'un objet
//! POST /v1/sources/:id/query                        un SELECT, si la source l'autorise
//! GET  /v1/openapi.json                             description lisible par un agent
//! POST /mcp                                         même surface, en JSON-RPC MCP
//! ```
//!
//! Toute autre méthode répond **405**. Il n'existe aucune route d'écriture :
//! ce n'est pas un filtre que l'on pourrait contourner, c'est l'absence de code.
//! `POST` sur `/query` et `/mcp` transporte une charge utile trop grosse pour
//! une URL ; les deux retombent sur les mêmes fonctions de lecture.
//!
//! # Accès
//!
//! Écoute sur `127.0.0.1` uniquement (pas d'exposition réseau) et exige
//! `Authorization: Bearer <jeton>`. Le jeton est tiré au sort à la première
//! activation et reste affichable dans l'application.

use super::{DataSource, ReadOpts, DEFAULT_LIMIT};
use axum::{
    extract::{Path as AxPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

pub const DEFAULT_PORT: u16 = 8771;
const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone)]
struct Ctx {
    app: tauri::AppHandle,
    token: String,
}

/// Port réellement en écoute, une fois le serveur démarré. Sert aussi de
/// verrou : un second démarrage ne relance rien.
static RUNNING: OnceLock<Mutex<Option<u16>>> = OnceLock::new();

fn running() -> &'static Mutex<Option<u16>> {
    RUNNING.get_or_init(|| Mutex::new(None))
}

// ===================== Jeton =====================

fn token_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("datasources-token"))
}

/// Jeton de l'API, créé au premier appel et conservé en 0600.
pub fn token(app: &tauri::AppHandle) -> Result<String, String> {
    let path = token_path(app)?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let mut raw = [0u8; 24];
    getrandom::getrandom(&mut raw).map_err(|e| e.to_string())?;
    let t = raw.iter().map(|b| format!("{b:02x}")).collect::<String>();
    std::fs::write(&path, &t).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(t)
}

fn authorized(ctx: &Ctx, headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_start_matches("Bearer ").trim() == ctx.token)
        .unwrap_or(false)
}

// ===================== Réponses =====================

type Reply = (StatusCode, Json<Value>);

fn ok(v: Value) -> Reply {
    (StatusCode::OK, Json(v))
}

fn fail(code: StatusCode, message: impl Into<String>) -> Reply {
    (code, Json(json!({ "error": message.into() })))
}

/// Traduit l'erreur métier en code HTTP. Une source désactivée ou inconnue est
/// un 404 : de l'extérieur, elle n'existe pas.
fn from_err(e: String) -> Reply {
    let code = if e.starts_with("Source inconnue") || e.starts_with("Source désactivée") {
        StatusCode::NOT_FOUND
    } else if e.contains("désactivé") || e.contains("refusée") || e.contains("refusé") {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::BAD_REQUEST
    };
    fail(code, e)
}

/// Exécute une lecture (bloquante par nature : pilotes SQL, requêtes HTTP) hors
/// de la boucle asynchrone.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn opts_from_query(q: &HashMap<String, String>) -> ReadOpts {
    let reserved = ["limit", "offset", "select", "order_by", "desc", "path", "sql"];
    ReadOpts {
        limit: q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_LIMIT),
        offset: q.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0),
        select: q
            .get("select")
            .map(|s| s.split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect())
            .unwrap_or_default(),
        // Tout paramètre non réservé devient un filtre d'égalité : `?ville=Paris`.
        filters: q
            .iter()
            .filter(|(k, _)| !reserved.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        order_by: q.get("order_by").cloned().unwrap_or_default(),
        descending: q.get("desc").map(|v| v == "1" || v == "true").unwrap_or(false),
    }
}

// ===================== Routes =====================

async fn list_sources(State(ctx): State<Ctx>, headers: HeaderMap) -> Reply {
    if !authorized(&ctx, &headers) {
        return fail(StatusCode::UNAUTHORIZED, "Jeton manquant ou invalide.");
    }
    let list: Vec<Value> = super::read_sources(&ctx.app)
        .iter()
        .filter(|s| s.enabled)
        .map(|s| s.redacted())
        .collect();
    ok(json!({ "sources": list, "readOnly": true }))
}

/// Résout la source et applique la lecture demandée. Toutes les routes de
/// données passent par ici : un seul endroit vérifie le jeton et l'activation.
async fn with_source<F>(ctx: &Ctx, headers: &HeaderMap, id: String, f: F) -> Reply
where
    F: FnOnce(DataSource) -> Result<Value, String> + Send + 'static,
{
    if !authorized(ctx, headers) {
        return fail(StatusCode::UNAUTHORIZED, "Jeton manquant ou invalide.");
    }
    let app = ctx.app.clone();
    match blocking(move || {
        let src = super::find_enabled(&app, &id)?;
        f(src)
    })
    .await
    {
        Ok(v) => ok(v),
        Err(e) => from_err(e),
    }
}

async fn get_source(State(ctx): State<Ctx>, headers: HeaderMap, AxPath(id): AxPath<String>) -> Reply {
    with_source(&ctx, &headers, id, |src| Ok(src.redacted())).await
}

async fn get_datasets(State(ctx): State<Ctx>, headers: HeaderMap, AxPath(id): AxPath<String>) -> Reply {
    with_source(&ctx, &headers, id, |src| Ok(json!({ "datasets": super::list_datasets(&src)? }))).await
}

async fn get_schema(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    AxPath((id, name)): AxPath<(String, String)>,
) -> Reply {
    with_source(&ctx, &headers, id, move |src| super::schema(&src, &name)).await
}

async fn get_rows(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    AxPath((id, name)): AxPath<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> Reply {
    let opts = opts_from_query(&q);
    with_source(&ctx, &headers, id, move |src| Ok(json!(super::rows(&src, &name, &opts)?))).await
}

async fn get_objects(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    AxPath(id): AxPath<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Reply {
    let path = q.get("path").cloned().unwrap_or_default();
    with_source(&ctx, &headers, id, move |src| Ok(json!({ "entries": super::objects(&src, &path)? }))).await
}

async fn get_object(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    AxPath(id): AxPath<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Reply {
    let Some(path) = q.get("path").cloned() else {
        return fail(StatusCode::BAD_REQUEST, "Paramètre « path » requis.");
    };
    with_source(&ctx, &headers, id, move |src| super::object(&src, &path)).await
}

/// Le seul `POST` de données : un SELECT, trop long pour une URL. Il n'ouvre
/// aucune capacité nouvelle — `super::query` exige `allow_sql` puis
/// `is_read_only`.
async fn post_query(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    AxPath(id): AxPath<String>,
    Json(body): Json<Value>,
) -> Reply {
    let sql = body.get("sql").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let limit = body.get("limit").and_then(|v| v.as_i64()).unwrap_or(DEFAULT_LIMIT);
    if sql.trim().is_empty() {
        return fail(StatusCode::BAD_REQUEST, "Champ « sql » requis.");
    }
    with_source(&ctx, &headers, id, move |src| Ok(json!(super::query(&src, &sql, limit)?))).await
}

async fn openapi() -> Json<Value> {
    Json(openapi_doc())
}

/// Description OpenAPI, servie telle quelle. Elle dit explicitement que l'API
/// est en lecture seule : c'est la première chose que lit un agent qui la
/// découvre, et cela évite qu'il cherche une route d'écriture.
fn openapi_doc() -> Value {
    let source_id = json!({ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } });
    let dataset = json!({ "name": "name", "in": "path", "required": true, "schema": { "type": "string" } });
    let path_q = json!({ "name": "path", "in": "query", "schema": { "type": "string" } });
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Lumen — Centre de sources de données",
            "version": "1.0.0",
            "description": "API de LECTURE SEULE sur les sources connectées (bases, fichiers, stockages, API). \
                            Aucune route d'écriture n'existe : toute méthode autre que GET (et le POST de /query, \
                            qui n'accepte qu'un SELECT) répond 405.",
        },
        "servers": [{ "url": format!("http://127.0.0.1:{DEFAULT_PORT}") }],
        "components": {
            "securitySchemes": { "bearer": { "type": "http", "scheme": "bearer" } }
        },
        "security": [{ "bearer": [] }],
        "paths": {
            "/v1/sources": { "get": { "summary": "Sources activées et leurs capacités" } },
            "/v1/sources/{id}": { "get": { "summary": "Détail d'une source", "parameters": [source_id] } },
            "/v1/sources/{id}/datasets": { "get": { "summary": "Jeux de données", "parameters": [source_id] } },
            "/v1/sources/{id}/datasets/{name}/schema": { "get": { "summary": "Colonnes et types", "parameters": [source_id, dataset] } },
            "/v1/sources/{id}/datasets/{name}/rows": {
                "get": {
                    "summary": "Lignes paginées",
                    "parameters": [source_id, dataset,
                        { "name": "limit", "in": "query", "schema": { "type": "integer", "maximum": super::MAX_LIMIT } },
                        { "name": "offset", "in": "query", "schema": { "type": "integer" } },
                        { "name": "select", "in": "query", "schema": { "type": "string" } },
                        { "name": "order_by", "in": "query", "schema": { "type": "string" } }],
                }
            },
            "/v1/sources/{id}/objects": { "get": { "summary": "Dossiers et fichiers", "parameters": [source_id, path_q] } },
            "/v1/sources/{id}/object": { "get": { "summary": "Contenu d'un objet", "parameters": [source_id, path_q] } },
            "/v1/sources/{id}/query": { "post": { "summary": "Un SELECT unique, si la source l'autorise", "parameters": [source_id] } },
        },
    })
}

async fn method_not_allowed() -> impl IntoResponse {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(json!({ "error": "API en lecture seule : seules les lectures (GET) sont routées." })),
    )
}

// ===================== MCP =====================

/// Les outils MCP sont la projection exacte des routes REST — mêmes fonctions,
/// mêmes gardes. Un modèle branché en MCP n'a donc pas plus de pouvoir qu'un
/// client HTTP : il ne peut que lire.
fn mcp_tools() -> Value {
    let src_arg = json!({ "type": "string", "description": "Identifiant de la source (voir datasources_list)." });
    let read_only = json!({ "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true });
    json!([
        { "name": "datasources_list", "description": "Liste les sources de données connectées et activées.",
          "inputSchema": { "type": "object", "properties": {} }, "annotations": read_only },
        { "name": "datasources_datasets", "description": "Liste les jeux de données (tables, feuilles, points d'entrée) d'une source.",
          "inputSchema": { "type": "object", "properties": { "source": src_arg }, "required": ["source"] }, "annotations": read_only },
        { "name": "datasources_schema", "description": "Colonnes et types d'un jeu de données.",
          "inputSchema": { "type": "object", "properties": { "source": src_arg, "dataset": { "type": "string" } }, "required": ["source", "dataset"] }, "annotations": read_only },
        { "name": "datasources_rows", "description": "Lit des lignes paginées d'un jeu de données.",
          "inputSchema": { "type": "object", "properties": { "source": src_arg, "dataset": { "type": "string" },
              "limit": { "type": "integer" }, "offset": { "type": "integer" } }, "required": ["source", "dataset"] }, "annotations": read_only },
        { "name": "datasources_objects", "description": "Liste dossiers et fichiers d'une source de stockage.",
          "inputSchema": { "type": "object", "properties": { "source": src_arg, "path": { "type": "string" } }, "required": ["source"] }, "annotations": read_only },
        { "name": "datasources_object", "description": "Lit le contenu d'un fichier ou objet.",
          "inputSchema": { "type": "object", "properties": { "source": src_arg, "path": { "type": "string" } }, "required": ["source", "path"] }, "annotations": read_only },
        { "name": "datasources_select", "description": "Exécute un SELECT unique, uniquement si la source l'autorise.",
          "inputSchema": { "type": "object", "properties": { "source": src_arg, "sql": { "type": "string" }, "limit": { "type": "integer" } }, "required": ["source", "sql"] }, "annotations": read_only },
    ])
}

fn mcp_call(app: &tauri::AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    let arg = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let num = |k: &str| args.get(k).and_then(|v| v.as_i64());
    if name == "datasources_list" {
        let list: Vec<Value> = super::read_sources(app).iter().filter(|s| s.enabled).map(|s| s.redacted()).collect();
        return Ok(json!({ "sources": list }));
    }
    let src = super::find_enabled(app, &arg("source"))?;
    match name {
        "datasources_datasets" => Ok(json!({ "datasets": super::list_datasets(&src)? })),
        "datasources_schema" => super::schema(&src, &arg("dataset")),
        "datasources_rows" => {
            let opts = ReadOpts {
                limit: num("limit").unwrap_or(DEFAULT_LIMIT),
                offset: num("offset").unwrap_or(0),
                ..Default::default()
            };
            Ok(json!(super::rows(&src, &arg("dataset"), &opts)?))
        }
        "datasources_objects" => Ok(json!({ "entries": super::objects(&src, &arg("path"))? })),
        "datasources_object" => super::object(&src, &arg("path")),
        "datasources_select" => Ok(json!(super::query(&src, &arg("sql"), num("limit").unwrap_or(DEFAULT_LIMIT))?)),
        other => Err(format!("Outil inconnu : {other}")),
    }
}

async fn mcp_endpoint(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> Reply {
    if !authorized(&ctx, &headers) {
        return fail(StatusCode::UNAUTHORIZED, "Jeton manquant ou invalide.");
    }
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or_default().to_string();
    let params = body.get("params").cloned().unwrap_or(json!({}));
    let reply = |result: Value| ok(json!({ "jsonrpc": "2.0", "id": id, "result": result }));

    match method.as_str() {
        "initialize" => reply(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "lumen-datasources", "version": "1.0.0" },
            "instructions": "Sources de données de Lumen, en LECTURE SEULE. Aucun outil n'écrit, ne supprime \
                             ni ne modifie quoi que ce soit ; il est inutile d'en chercher un.",
        })),
        "notifications/initialized" | "ping" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": mcp_tools() })),
        "tools/call" => {
            let app = ctx.app.clone();
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match blocking(move || mcp_call(&app, &name, &args)).await {
                Ok(v) => reply(json!({
                    "content": [{ "type": "text", "text": serde_json::to_string(&v).unwrap_or_default() }],
                    "isError": false,
                })),
                Err(e) => reply(json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
            }
        }
        other => ok(json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("Méthode inconnue : {other}") }
        })),
    }
}

// ===================== Démarrage =====================

fn router(ctx: Ctx) -> Router {
    Router::new()
        .route("/v1/sources", get(list_sources))
        .route("/v1/sources/:id", get(get_source))
        .route("/v1/sources/:id/datasets", get(get_datasets))
        .route("/v1/sources/:id/datasets/:name/schema", get(get_schema))
        .route("/v1/sources/:id/datasets/:name/rows", get(get_rows))
        .route("/v1/sources/:id/objects", get(get_objects))
        .route("/v1/sources/:id/object", get(get_object))
        .route("/v1/sources/:id/query", post(post_query))
        .route("/v1/openapi.json", get(openapi))
        .route("/mcp", post(mcp_endpoint))
        .fallback(method_not_allowed)
        .with_state(ctx)
}

/// Démarre le serveur si besoin, et renvoie le port. Idempotent : rappelée sur
/// une instance déjà en écoute, elle ne fait que renvoyer le port.
pub async fn ensure(app: tauri::AppHandle, port: u16) -> Result<u16, String> {
    if let Some(p) = *running().lock().map_err(|e| e.to_string())? {
        return Ok(p);
    }
    let ctx = Ctx { token: token(&app)?, app: app.clone() };
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Port {port} indisponible : {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
    *running().lock().map_err(|e| e.to_string())? = Some(bound);
    let router = router(ctx);
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router).await;
        if let Ok(mut guard) = running().lock() {
            *guard = None;
        }
    });
    Ok(bound)
}

// ===================== Commandes Tauri =====================

#[tauri::command]
pub async fn datasources_server_start(app: tauri::AppHandle, port: Option<u16>) -> Result<Value, String> {
    let bound = ensure(app.clone(), port.unwrap_or(DEFAULT_PORT)).await?;
    Ok(json!({ "running": true, "port": bound, "baseUrl": format!("http://127.0.0.1:{bound}"), "token": token(&app)? }))
}

#[tauri::command]
pub fn datasources_server_status(app: tauri::AppHandle) -> Result<Value, String> {
    let port = *running().lock().map_err(|e| e.to_string())?;
    Ok(json!({
        "running": port.is_some(),
        "port": port.unwrap_or(DEFAULT_PORT),
        "baseUrl": format!("http://127.0.0.1:{}", port.unwrap_or(DEFAULT_PORT)),
        "token": token(&app)?,
    }))
}

#[tauri::command]
pub fn datasources_openapi() -> Value {
    openapi_doc()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_params_split_into_options_and_filters() {
        let mut q = HashMap::new();
        q.insert("limit".into(), "50".into());
        q.insert("select".into(), "a, b".into());
        q.insert("ville".into(), "Paris".into());
        let opts = opts_from_query(&q);
        assert_eq!(opts.limit, 50);
        assert_eq!(opts.select, vec!["a", "b"]);
        assert_eq!(opts.filters, vec![("ville".to_string(), "Paris".to_string())]);
    }

    #[test]
    fn the_documented_surface_has_no_write_route() {
        let doc = openapi_doc();
        let paths = doc["paths"].as_object().unwrap().clone();
        for (route, ops) in paths {
            for verb in ops.as_object().unwrap().keys() {
                assert!(
                    verb == "get" || (verb == "post" && route.ends_with("/query")),
                    "route inattendue : {verb} {route}"
                );
            }
        }
    }

    #[test]
    fn every_mcp_tool_declares_itself_read_only() {
        for tool in mcp_tools().as_array().unwrap() {
            assert_eq!(tool["annotations"]["readOnlyHint"], json!(true));
        }
    }
}
