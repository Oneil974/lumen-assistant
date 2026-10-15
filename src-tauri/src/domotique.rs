//! Domotique — protocole local sécurisé « Lumen Local Device » (LLD).
//!
//! Pensé comme un équivalent d'ESP-NOW mais adapté à la plateforme (Wi-Fi /
//! réseau local IP, sans appairage radio propriétaire). Deux temps :
//!
//!   1. Découverte : le bureau envoie un datagramme UDP en *broadcast* sur le
//!      port [`DISCOVERY_PORT`]. Chaque carte (ESP32 / Pico W flashée avec le
//!      firmware MicroPython de Lumen) répond par une annonce JSON
//!      `{id, name, type, ip, port, caps}`.
//!   2. Contrôle : le bureau émet des requêtes HTTP signées vers la carte. La
//!      signature `HMAC-SHA256(clé, ts.nonce.METHODE path\nbody)` empêche le
//!      rejeu et garantit que seul Lumen (qui détient la clé partagée) pilote
//!      l'objet. La clé n'est jamais transmise sur le réseau.
//!
//! Tout reste sur le LAN : aucune dépendance cloud, aucun broker à installer.
//! La génération des firmwares se fait côté front (templates MicroPython).

use std::net::UdpSocket;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

type HmacSha256 = Hmac<Sha256>;

/// Port UDP de découverte (probe en broadcast + réponses des cartes).
const DISCOVERY_PORT: u16 = 50001;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Signature des requêtes de contrôle. Format figé, identique côté firmware :
/// `HMAC-SHA256(clé, "<ts>.<nonce>.<METHODE> <path>\n<body>")` en hexadécimal.
fn sign(secret: &str, ts: u64, nonce: &str, method: &str, path: &str, body: &str) -> String {
    let msg = format!("{ts}.{nonce}.{method} {path}\n{body}");
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("clé HMAC valide");
    mac.update(msg.as_bytes());
    hex(&mac.finalize().into_bytes())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn rand_nonce() -> String {
    let mut buf = [0u8; 8];
    let _ = getrandom::getrandom(&mut buf);
    hex(&buf)
}

#[derive(Serialize, Deserialize)]
struct Announce {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    ip: String,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    caps: serde_json::Value,
}

/// Diffuse une sonde de découverte et collecte les annonces reçues pendant
/// `timeout_ms` (défaut 1500 ms). Renvoie un tableau JSON de cartes détectées.
///
/// Commande **async** : le travail bloquant (boucle UDP jusqu'au timeout) part
/// sur un thread dédié via `spawn_blocking`, pour ne JAMAIS figer le thread UI.
#[tauri::command]
pub async fn domotique_discover(timeout_ms: Option<u64>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || discover_blocking(timeout_ms))
        .await
        .map_err(|e| e.to_string())?
}

fn discover_blocking(timeout_ms: Option<u64>) -> Result<String, String> {
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.set_broadcast(true).map_err(|e| e.to_string())?;
    sock.set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| e.to_string())?;

    let probe = br#"{"lumen":"discover","v":1}"#;
    // 255.255.255.255 (broadcast global) couvre la plupart des LAN domestiques.
    let _ = sock.send_to(probe, ("255.255.255.255", DISCOVERY_PORT));

    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(1500));
    let mut buf = [0u8; 2048];
    let mut found: Vec<Announce> = Vec::new();

    while std::time::Instant::now() < deadline {
        match sock.recv_from(&mut buf) {
            Ok((n, src)) => {
                if let Ok(mut a) = serde_json::from_slice::<Announce>(&buf[..n]) {
                    if a.id.is_empty() {
                        continue;
                    }
                    // L'IP source fait foi si la carte ne l'a pas renseignée.
                    if a.ip.is_empty() {
                        a.ip = src.ip().to_string();
                    }
                    if a.port == 0 {
                        a.port = 80;
                    }
                    if !found.iter().any(|d| d.id == a.id) {
                        found.push(a);
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    serde_json::to_string(&found).map_err(|e| e.to_string())
}

/// Envoie une commande HTTP signée à une carte. `method` = GET/POST,
/// `path` ex. « /cmd », `body` = JSON (vide pour un GET). Renvoie le corps de
/// la réponse de la carte. Le timeout court évite de figer l'UI si l'objet
/// est hors-ligne.
///
/// Commande **async** : la requête HTTP bloquante (reqwest blocking, timeout
/// court) part sur un thread dédié via `spawn_blocking` — le thread UI ne se
/// fige jamais, même si la carte ne répond pas.
#[tauri::command]
pub async fn domotique_call(
    ip: String,
    port: Option<u16>,
    method: Option<String>,
    path: String,
    body: Option<String>,
    secret: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        call_blocking(ip, port, method, path, body, secret)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn call_blocking(
    ip: String,
    port: Option<u16>,
    method: Option<String>,
    path: String,
    body: Option<String>,
    secret: String,
) -> Result<String, String> {
    let port = port.unwrap_or(80);
    let method = method.unwrap_or_else(|| "POST".into()).to_uppercase();
    let body = body.unwrap_or_default();
    let ts = now_secs();
    let nonce = rand_nonce();
    let sig = sign(&secret, ts, &nonce, &method, &path, &body);

    let url = format!("http://{ip}:{port}{path}");
    // Timeouts courts : un objet hors-ligne échoue vite (pas d'attente longue).
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_millis(1200))
        // Mise à jour OTA (écriture en flash) et photo de sonnette : plus longs.
        .timeout(Duration::from_secs(if path == "/ota" { 40 } else if body.contains("\"snapshot\"") { 12 } else { 3 }))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = match method.as_str() {
        "GET" => client.get(&url),
        _ => client.post(&url).body(body.clone()),
    };
    req = req
        .header("X-Lumen-Ts", ts.to_string())
        .header("X-Lumen-Nonce", &nonce)
        .header("X-Lumen-Sig", &sig)
        .header("Content-Type", "application/json");

    let resp = req.send().map_err(|e| format!("Carte injoignable : {e}"))?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Carte a refusé ({status}) : {text}"));
    }
    Ok(text)
}

// ===== Persistance de la liste des objets connus (blob JSON opaque) =====

fn devices_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("domotique.json"))
}

#[tauri::command]
pub fn domotique_devices_load(app: tauri::AppHandle) -> Result<String, String> {
    Ok(fs::read_to_string(devices_path(&app)?).unwrap_or_default())
}

// ===== Helpers partagés (loopback /domotique/*, blocs Fluxo) =====

#[derive(Serialize, Deserialize, Clone)]
pub struct DeviceRec {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub ip: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub room: String,
    /// Composants hébergés par la carte : `[{key,type,name,pins}]`. Forme opaque
    /// (le front en est propriétaire) ; vide pour les objets mono-type hérités.
    #[serde(default)]
    pub components: serde_json::Value,
}

/// Charge la liste des objets enregistrés (domotique.json).
pub fn load_devices(app: &tauri::AppHandle) -> Vec<DeviceRec> {
    devices_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Résout une référence (id, nom exact, ou nom contenant le texte) en objet.
/// La correspondance par nom est insensible à la casse — pratique pour le langage
/// naturel (« lampe salon »).
pub fn resolve(app: &tauri::AppHandle, reference: &str) -> Option<DeviceRec> {
    let r = reference.trim().to_lowercase();
    let list = load_devices(app);
    list.iter()
        .find(|d| d.id == reference)
        .cloned()
        .or_else(|| list.iter().find(|d| d.name.to_lowercase() == r).cloned())
        .or_else(|| {
            list.iter()
                .find(|d| !r.is_empty() && d.name.to_lowercase().contains(&r))
                .cloned()
        })
}

/// Résumé JSON des objets (sans les secrets) — pour l'IA et le bloc « lister ».
/// Inclut les composants (clé + type) pour que l'IA sache lesquels piloter et
/// avec quelle clé sur un objet multi-composants.
pub fn devices_summary(app: &tauri::AppHandle) -> String {
    let list: Vec<_> = load_devices(app)
        .into_iter()
        .map(|d| {
            let comps: Vec<serde_json::Value> = d
                .components
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .map(|c| {
                            serde_json::json!({
                                "key": c.get("key"),
                                "type": c.get("type"),
                                "name": c.get("name"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            serde_json::json!({
                "id": d.id, "name": d.name, "type": d.kind, "room": d.room,
                "ip": d.ip, "components": comps,
            })
        })
        .collect();
    serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())
}

#[tauri::command]
pub fn domotique_devices_summary(app: tauri::AppHandle) -> String {
    devices_summary(&app)
}

fn ensure_addressable(d: &DeviceRec) -> Result<(), String> {
    if d.ip.is_empty() {
        return Err(format!(
            "« {} » n'a pas d'IP connue (lancez la découverte).",
            d.name
        ));
    }
    Ok(())
}

/// Lit l'état d'un objet (GET /state signé).
pub fn device_state(app: &tauri::AppHandle, reference: &str) -> Result<String, String> {
    let d =
        resolve(app, reference).ok_or_else(|| format!("Objet introuvable : « {reference} »"))?;
    ensure_addressable(&d)?;
    call_blocking(
        d.ip,
        Some(d.port),
        Some("GET".into()),
        "/state".into(),
        None,
        d.secret,
    )
}

#[tauri::command]
pub fn domotique_device_state(app: tauri::AppHandle, reference: String) -> Result<String, String> {
    device_state(&app, &reference)
}

/// Actionne / paramètre un objet (POST /cmd signé). `params` = objet JSON.
/// `component` cible un composant précis (clé) sur une carte multi-composants ;
/// `None` laisse le firmware choisir (objet mono-composant / hérité).
pub fn device_cmd(
    app: &tauri::AppHandle,
    reference: &str,
    component: Option<&str>,
    action: &str,
    params: serde_json::Value,
) -> Result<String, String> {
    let d =
        resolve(app, reference).ok_or_else(|| format!("Objet introuvable : « {reference} »"))?;
    ensure_addressable(&d)?;
    let mut payload = serde_json::json!({ "action": action, "params": params });
    if let Some(key) = component.filter(|k| !k.is_empty()) {
        payload["component"] = serde_json::Value::String(key.to_string());
    }
    call_blocking(
        d.ip,
        Some(d.port),
        Some("POST".into()),
        "/cmd".into(),
        Some(payload.to_string()),
        d.secret,
    )
}

#[tauri::command]
pub fn domotique_device_cmd(
    app: tauri::AppHandle,
    reference: String,
    component: Option<String>,
    action: String,
    params: serde_json::Value,
) -> Result<String, String> {
    device_cmd(&app, &reference, component.as_deref(), &action, params)
}

#[tauri::command]
pub fn domotique_devices_save(app: tauri::AppHandle, data: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&data).map_err(|e| format!("JSON invalide : {e}"))?;
    fs::write(devices_path(&app)?, &data).map_err(|e| e.to_string())?;
    Ok(())
}
