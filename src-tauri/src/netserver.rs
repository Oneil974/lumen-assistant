//! Liaison de ce poste à un **Lumen Server**.
//!
//! # Le jeton ne monte jamais dans la webview
//!
//! Tout passe par ici : `netserver_api` porte le jeton d'appareil côté Rust, et
//! l'interface ne manipule que des chemins et des charges utiles. Une page qui
//! n'a jamais eu le jeton ne peut pas le laisser fuir — ni dans un
//! `localStorage`, ni dans un journal, ni dans une capture d'écran.
//!
//! # La clé privée non plus, sauf pour déchiffrer
//!
//! Le chiffrement de bout en bout se fait dans la page (WebCrypto). La clé
//! privée est donc remise à la page au démarrage — mais elle vit ici, dans un
//! fichier 0600, et **ne part jamais sur le réseau** : aucune commande ne
//! l'envoie au serveur, et le serveur n'a aucune route pour la recevoir.
//!
//! # Sans serveur, rien ne change
//!
//! Tant qu'aucun serveur n'est lié, ces commandes répondent « non lié » et les
//! applications réseau restent invisibles. Lumen Pro doit rester entier seul.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Link {
    #[serde(default)]
    pub url: String,
    /// Jeton d'appareil. Jamais renvoyé à l'interface.
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub handle: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub server_name: String,
    /// Paire de clés de cet appareil, au format JWK. La privée ne sort d'ici
    /// que vers la page qui déchiffre, jamais vers le réseau.
    #[serde(default)]
    pub public_jwk: String,
    #[serde(default)]
    pub private_jwk: String,
}

impl Link {
    fn linked(&self) -> bool {
        !self.url.is_empty() && !self.token.is_empty()
    }
    /// Ce que l'interface a le droit de voir.
    fn public(&self) -> Value {
        json!({
            "linked": self.linked(),
            "url": self.url,
            "serverName": self.server_name,
            "account": { "id": self.account_id, "handle": self.handle, "displayName": self.display_name },
            "deviceId": self.device_id,
        })
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("lumen_server_link.json"))
}

pub fn read_link(app: &tauri::AppHandle) -> Link {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_link(app: &tauri::AppHandle, link: &Link) -> Result<(), String> {
    let path = config_path(app)?;
    std::fs::write(&path, serde_json::to_string_pretty(link).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Lumen-Pro")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

// ===================== Commandes =====================

#[tauri::command]
pub fn netserver_state(app: tauri::AppHandle) -> Value {
    read_link(&app).public()
}

/// Appaire ce poste. La paire de clés est **produite par la page** (WebCrypto)
/// et déposée ici : seule la publique part vers le serveur.
#[tauri::command]
pub fn netserver_link(
    app: tauri::AppHandle,
    url: String,
    code: String,
    device_name: String,
    public_jwk: String,
    private_jwk: String,
) -> Result<Value, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("L'adresse du serveur doit commencer par http:// ou https://".into());
    }
    let resp = client()?
        .post(format!("{base}/v1/pair"))
        .json(&json!({ "code": code, "device_name": device_name, "public_key": public_jwk }))
        .send()
        .map_err(|e| format!("Serveur injoignable : {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body.get("error").and_then(|e| e.as_str()).unwrap_or("Appairage refusé.").to_string());
    }
    let account = body.get("account").cloned().unwrap_or(json!({}));
    let link = Link {
        url: base,
        token: body.get("token").and_then(|t| t.as_str()).unwrap_or_default().into(),
        device_id: body.get("device_id").and_then(|d| d.as_str()).unwrap_or_default().into(),
        account_id: account.get("id").and_then(|v| v.as_str()).unwrap_or_default().into(),
        handle: account.get("handle").and_then(|v| v.as_str()).unwrap_or_default().into(),
        display_name: account.get("display_name").and_then(|v| v.as_str()).unwrap_or_default().into(),
        server_name: body.get("server_name").and_then(|v| v.as_str()).unwrap_or_default().into(),
        public_jwk,
        private_jwk,
    };
    write_link(&app, &link)?;
    Ok(link.public())
}

/// Délie ce poste. La clé privée est effacée **avec** le reste : garder une clé
/// dont on n'a plus l'historique n'aurait aucun usage, et un secret sans usage
/// est un secret qui traîne.
#[tauri::command]
pub fn netserver_unlink(app: tauri::AppHandle) -> Result<(), String> {
    write_link(&app, &Link::default())
}

/// Appel REST au serveur, jeton posé ici. C'est la seule porte : l'interface
/// n'a pas d'autre moyen d'atteindre le serveur, et n'a donc pas besoin du
/// jeton.
#[tauri::command]
pub fn netserver_api(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let link = read_link(&app);
    if !link.linked() {
        return Err("Ce poste n'est lié à aucun Lumen Server.".into());
    }
    if !path.starts_with('/') {
        return Err("Chemin invalide.".into());
    }
    let url = format!("{}{}", link.url, path);
    let c = client()?;
    let req = match method.to_uppercase().as_str() {
        "GET" => c.get(&url),
        "POST" => c.post(&url),
        "PUT" => c.put(&url),
        "DELETE" => c.delete(&url),
        other => return Err(format!("Méthode refusée : {other}")),
    };
    let req = req.bearer_auth(&link.token);
    let req = match body { Some(b) => req.json(&b), None => req };
    let resp = req.send().map_err(|e| format!("Serveur injoignable : {e}"))?;
    let status = resp.status();
    let value: Value = resp.json().unwrap_or(json!({}));
    if !status.is_success() {
        return Err(value.get("error").and_then(|e| e.as_str()).unwrap_or("Refusé par le serveur.").to_string());
    }
    Ok(value)
}

/// Rend les clés de cet appareil à la page qui chiffre et déchiffre.
///
/// La privée est ici, et nulle part ailleurs : ni sur le serveur, ni dans un
/// stockage de webview qu'un vidage de cache emporterait.
#[tauri::command]
pub fn netserver_keys(app: tauri::AppHandle) -> Result<Value, String> {
    let link = read_link(&app);
    if !link.linked() {
        return Err("Ce poste n'est lié à aucun Lumen Server.".into());
    }
    Ok(json!({ "publicJwk": link.public_jwk, "privateJwk": link.private_jwk }))
}

// ===================== Socket =====================

/// Une seule socket par poste, quel que soit le nombre d'applications ouvertes.
/// Les évènements sont réémis en `netserver-event`, que chaque page écoute.
static SOCKET: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
static RUNNING: Mutex<bool> = Mutex::new(false);

fn running() -> bool {
    RUNNING.lock().map(|g| *g).unwrap_or(false)
}

/// Ouvre la socket si elle ne l'est pas déjà. Idempotent : trois applications
/// qui s'ouvrent n'ouvrent pas trois sockets.
#[tauri::command]
pub fn netserver_connect(app: tauri::AppHandle) -> Result<(), String> {
    if running() {
        return Ok(());
    }
    let link = read_link(&app);
    if !link.linked() {
        return Err("Ce poste n'est lié à aucun Lumen Server.".into());
    }
    *RUNNING.lock().map_err(|e| e.to_string())? = true;

    let handle = std::thread::spawn(move || {
        // Reconnexion à intervalle croissant : un serveur qui redémarre ne doit
        // pas être bombardé, et une coupure réseau se répare toute seule.
        let mut delay = 2u64;
        loop {
            if !running() {
                break;
            }
            match pump(&app) {
                Ok(()) => delay = 2,
                Err(e) => {
                    let _ = app.emit("netserver-event", json!({ "t": "error", "p": { "message": e } }));
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(delay));
            delay = (delay * 2).min(60);
        }
    });
    *SOCKET.lock().map_err(|e| e.to_string())? = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn netserver_disconnect() -> Result<(), String> {
    *RUNNING.lock().map_err(|e| e.to_string())? = false;
    Ok(())
}

/// Boucle de lecture de la socket. Chaque enveloppe reçue est réémise telle
/// quelle : le Rust ne l'interprète pas, il la transporte.
fn pump(app: &tauri::AppHandle) -> Result<(), String> {
    let link = read_link(app);
    let ws_url = link
        .url
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let url = format!("{ws_url}/ws?token={}", link.token);
    let (mut socket, _) = tungstenite::connect(&url).map_err(|e| format!("socket : {e}"))?;
    let _ = app.emit("netserver-event", json!({ "t": "open", "p": {} }));
    loop {
        if !running() {
            let _ = socket.close(None);
            return Ok(());
        }
        match socket.read() {
            Ok(tungstenite::Message::Text(text)) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    let _ = app.emit("netserver-event", value);
                }
            }
            Ok(tungstenite::Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(e) => return Err(format!("socket fermée : {e}")),
        }
    }
}

/// Envoie une enveloppe sur la socket. Réouvre une connexion courte : les
/// envois par socket sont rares (frappe, signalisation), et une connexion
/// partagée entre threads coûterait plus de verrous que de temps gagné.
#[tauri::command]
pub fn netserver_send(app: tauri::AppHandle, envelope: Value) -> Result<(), String> {
    let link = read_link(&app);
    if !link.linked() {
        return Err("Ce poste n'est lié à aucun Lumen Server.".into());
    }
    let ws_url = link.url.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    let (mut socket, _) = tungstenite::connect(format!("{ws_url}/ws?token={}", link.token))
        .map_err(|e| format!("socket : {e}"))?;
    socket
        .send(tungstenite::Message::Text(envelope.to_string()))
        .map_err(|e| e.to_string())?;
    let _ = socket.close(None);
    Ok(())
}
