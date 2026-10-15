//! Lumen comme SERVEUR MCP (Model Context Protocol).
//!
//! Lumen consommait déjà des serveurs MCP ; ici il en devient un : Claude
//! Desktop, Claude Code, Cursor ou tout client MCP peuvent utiliser les outils
//! natifs de Lumen — coffre de données, agenda, tâches, mémoire, domotique,
//! courrier (lecture), données en direct, fichiers des sandboxes.
//!
//! Transport « Streamable HTTP » (réponses JSON) sur la boucle locale :
//! `POST http://127.0.0.1:8765/mcp`, avec `Authorization: Bearer <jeton>`.
//! Pour les clients qui ne parlent que stdio : `Lumen --mcp-stdio` relaie
//! stdin/stdout vers cette route (cf. `run_stdio_bridge`).
//!
//! Sécurité :
//!   - désactivé par défaut, jeton aléatoire obligatoire (même en local : un
//!     autre programme de la machine ne doit pas piocher dans le coffre) ;
//!   - lecture seule par défaut : les outils qui écrivent (effect != "read")
//!     ne sont exposés que si l'utilisateur l'autorise dans les Réglages ;
//!   - chaque appel est journalisé et signalé dans la capsule.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;

const PROTOCOL: &str = "2025-06-18";

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct McpServerConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub token: String,
    /// Expose aussi les outils qui écrivent (rappels, coffre, mémoire, domotique…).
    #[serde(default)]
    pub allow_write: bool,
    /// Outils exclus explicitement par l'utilisateur.
    #[serde(default)]
    pub disabled: Vec<String>,
}

fn config_path_from(dir: PathBuf) -> PathBuf {
    dir.join("mcp_server.json")
}

fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::paths::shared_data_dir(app.path()).ok().map(config_path_from)
}

fn new_token() -> String {
    let mut b = [0u8; 24];
    getrandom::getrandom(&mut b).expect("source d'entropie indisponible");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn read_config(app: &tauri::AppHandle) -> McpServerConfig {
    config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &tauri::AppHandle, cfg: &McpServerConfig) -> Result<(), String> {
    let path = config_path(app).ok_or("dossier de données introuvable")?;
    let txt = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Outils exposés : catalogue natif, filtré (lecture seule sauf accord).
fn exposed(cfg: &McpServerConfig) -> Vec<&'static crate::native_tools::NativeTool> {
    crate::native_tools::CATALOG
        .iter()
        .filter(|t| cfg.allow_write || t.effect == "read")
        .filter(|t| !cfg.disabled.iter().any(|d| d == t.id))
        // La recherche web sort de la machine : elle garde ses propres réglages.
        .filter(|t| !matches!(t.id, "duckduckgo" | "brave" | "mojeek" | "wikipedia"))
        .collect()
}

#[derive(Serialize)]
pub struct McpServerView {
    pub enabled: bool,
    pub token: String,
    pub allow_write: bool,
    pub url: String,
    pub tools: Vec<Value>,
    /// Commande stdio à copier dans la configuration d'un client.
    pub stdio_command: String,
}

#[tauri::command]
pub fn mcp_server_get(app: tauri::AppHandle) -> McpServerView {
    let cfg = read_config(&app);
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    McpServerView {
        enabled: cfg.enabled,
        token: cfg.token.clone(),
        allow_write: cfg.allow_write,
        url: format!("http://127.0.0.1:{}/mcp", crate::companion::LOCAL_PORT),
        tools: crate::native_tools::CATALOG
            .iter()
            .filter(|t| !matches!(t.id, "duckduckgo" | "brave" | "mojeek" | "wikipedia"))
            .map(|t| json!({
                "id": t.id, "label": t.label_fr, "effect": t.effect,
                "enabled": !cfg.disabled.iter().any(|d| d == t.id) && (cfg.allow_write || t.effect == "read"),
            }))
            .collect(),
        stdio_command: format!("{exe} --mcp-stdio"),
    }
}

#[tauri::command]
pub fn mcp_server_set(app: tauri::AppHandle, enabled: bool, allow_write: bool, disabled: Vec<String>, regenerate: Option<bool>) -> Result<McpServerView, String> {
    let mut cfg = read_config(&app);
    cfg.enabled = enabled;
    cfg.allow_write = allow_write;
    cfg.disabled = disabled;
    if cfg.token.is_empty() || regenerate.unwrap_or(false) {
        cfg.token = new_token();
    }
    write_config(&app, &cfg)?;
    Ok(mcp_server_get(app))
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}
fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Traite UN message JSON-RPC. `None` = notification (pas de réponse).
pub async fn handle(app: &tauri::AppHandle, msg: Value) -> Option<Value> {
    let cfg = read_config(app);
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let is_notification = msg.get("id").is_none();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let out = match method {
        "initialize" => {
            let version = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL).to_string();
            rpc_result(&id, json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "lumen", "title": "Lumen", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Outils personnels de l'utilisateur, servis par Lumen sur sa machine : agenda, tâches, coffre de données, mémoire, notes et documents, courrier (lecture), domotique, météo et données en direct. Les données restent locales ; n'en divulgue que ce qui est utile à la demande.",
            }))
        }
        "ping" => rpc_result(&id, json!({})),
        "tools/list" => {
            let tools: Vec<Value> = exposed(&cfg)
                .into_iter()
                .map(|t| {
                    let spec = crate::native_tools::specs(&[t.id.to_string()], false);
                    let schema = spec.first().and_then(|s| s.pointer("/function/parameters")).cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
                    json!({
                        "name": t.id,
                        "title": t.label_fr,
                        "description": t.desc_fr,
                        "inputSchema": schema,
                        "annotations": { "readOnlyHint": t.effect == "read", "idempotentHint": t.idempotent, "openWorldHint": false },
                    })
                })
                .collect();
            rpc_result(&id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if !exposed(&cfg).iter().any(|t| t.id == name) {
                rpc_error(&id, -32602, &format!("Outil non exposé par Lumen : {name}"))
            } else {
                let client = msg.pointer("/_meta/client").and_then(|v| v.as_str()).unwrap_or("client MCP").to_string();
                let (text, ok) = crate::native_tools::exec(app, &name, &args, "").await;
                crate::emit_center(app, json!({
                    "shortcut": format!("MCP · {name}"),
                    "output": format!("Appelé par {client}{}", if ok { "" } else { " (échec)" }),
                    "success": ok,
                    "source": "mcp",
                    "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
                }));
                rpc_result(&id, json!({ "content": [{ "type": "text", "text": text }], "isError": !ok }))
            }
        }
        m if m.starts_with("notifications/") => return None,
        _ => rpc_error(&id, -32601, &format!("Méthode inconnue : {method}")),
    };
    if is_notification { None } else { Some(out) }
}

/// Vérifie le jeton porteur d'une requête HTTP.
pub fn authorized(app: &tauri::AppHandle, auth_header: Option<&str>) -> Result<(), &'static str> {
    let cfg = read_config(app);
    if !cfg.enabled {
        return Err("Le serveur MCP de Lumen est désactivé (Réglages › Connecteurs).");
    }
    let given = auth_header.and_then(|h| h.strip_prefix("Bearer ")).unwrap_or("").trim();
    if cfg.token.is_empty() || given != cfg.token {
        return Err("Jeton MCP invalide.");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pont stdio : `Lumen --mcp-stdio`
// ---------------------------------------------------------------------------

/// Dossier de données sans AppHandle (le pont tourne AVANT Tauri) : même
/// convention que `paths::shared_data_dir` (data_dir de l'OS + com.lumen.app).
fn data_dir_without_app() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
    }?;
    Some(base.join(crate::paths::SHARED_DIR))
}

/// Relaie les messages JSON-RPC (une ligne par message) de stdin vers la
/// route MCP de Lumen, et les réponses vers stdout. Lumen doit être lancé.
pub fn run_stdio_bridge() -> i32 {
    use std::io::{BufRead, Write};
    let token = data_dir_without_app()
        .map(config_path_from)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<McpServerConfig>(&s).ok())
        .map(|c| c.token)
        .unwrap_or_default();
    let url = format!("http://127.0.0.1:{}/mcp", crate::companion::LOCAL_PORT);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .expect("client HTTP");
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let id = serde_json::from_str::<Value>(&line).ok().and_then(|v| v.get("id").cloned());
        let resp = client.post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("Authorization", format!("Bearer {token}"))
            .body(line)
            .send();
        let out = match resp {
            Ok(r) if r.status().as_u16() == 202 => None,
            Ok(r) => {
                let status = r.status();
                let body = r.text().unwrap_or_default();
                if status.is_success() && !body.trim().is_empty() { Some(body) }
                else if let Some(id) = id.clone() {
                    Some(rpc_error(&id, -32000, &format!("Lumen a répondu {status} : {}", body.trim())).to_string())
                } else { None }
            }
            Err(e) => id.clone().map(|id| rpc_error(&id, -32000, &format!("Lumen injoignable (l'application est-elle lancée ?) : {e}")).to_string()),
        };
        if let Some(text) = out {
            let _ = writeln!(stdout, "{}", text.trim());
            let _ = stdout.flush();
        }
    }
    0
}
