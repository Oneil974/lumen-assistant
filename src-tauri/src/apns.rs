//! Notifications push de l'app iOS native du compagnon (APNs).
//!
//! La PWA passe par Web Push (push.rs) ; l'app native, elle, ne peut recevoir
//! que des notifications APNs. Même politique : une notification est un
//! bonus, jamais bloquante, et on n'y met que l'essentiel (titre + phrase),
//! jamais le détail d'une conversation — Apple achemine le contenu en clair.
//!
//! ## Configuration (une fois, dans Réglages › Compagnon mobile)
//!
//! Une clé d'authentification APNs (.p8) créée sur developer.apple.com ›
//! Certificates, IDs & Profiles › Keys, avec son Key ID et le Team ID. Le
//! fichier `apns.json` qui la garde est en 0600 et la clé n'est jamais
//! renvoyée à l'interface.
//!
//! ## Jeton JWT
//!
//! ES256 signé avec la clé .p8 (même courbe P-256 que VAPID), valable une
//! heure côté Apple : on le régénère toutes les 50 minutes.

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use p256::ecdsa::signature::Signer;

const B64URL: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Identifiant de l'app iOS (ios-companion/project.yml).
const DEFAULT_BUNDLE_ID: &str = "io.github.oneil974.lumen.companion";

#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    pub profile_id: String,
    pub token: String,
    /// Build de développement (Xcode) → serveur sandbox d'Apple.
    #[serde(default)]
    pub sandbox: bool,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    key_id: String,
    #[serde(default)]
    team_id: String,
    /// Scalaire privé P-256 extrait du .p8, base64.
    #[serde(default)]
    key: String,
    #[serde(default)]
    bundle_id: String,
    #[serde(default)]
    devices: Vec<Device>,
}

/// État renvoyé aux Réglages (jamais la clé elle-même).
#[derive(Serialize)]
pub struct ApnsStatus {
    pub configured: bool,
    pub key_id: String,
    pub team_id: String,
    pub bundle_id: String,
    pub devices: usize,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("apns.json"))
}

fn read(app: &tauri::AppHandle) -> Store {
    path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(app: &tauri::AppHandle, store: &Store) -> Result<(), String> {
    let p = path(app)?;
    let txt = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&p, txt).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Extrait le scalaire privé d'une clé .p8 d'Apple (PEM PKCS#8, courbe P-256).
///
/// Plutôt que d'activer les fonctions pkcs8/pem de p256 (et leurs dépendances)
/// pour un seul format, on lit directement la structure ECPrivateKey imbriquée :
/// `INTEGER 1` puis `OCTET STRING` de 32 octets — c'est le scalaire.
fn parse_p8(pem: &str) -> Result<p256::SecretKey, String> {
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    let der = base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .map_err(|_| "clé .p8 illisible (base64)".to_string())?;
    let marker = [0x02, 0x01, 0x01, 0x04, 0x20];
    let at = der
        .windows(marker.len())
        .position(|w| w == marker)
        .ok_or("clé .p8 inattendue : ce n'est pas une clé EC P-256")?;
    let start = at + marker.len();
    let raw = der.get(start..start + 32).ok_or("clé .p8 tronquée")?;
    p256::SecretKey::from_slice(raw).map_err(|e| e.to_string())
}

// ===== Commandes Tauri (Réglages) =====

#[tauri::command]
pub fn apns_status(app: tauri::AppHandle) -> ApnsStatus {
    let s = read(&app);
    ApnsStatus {
        configured: !s.key.is_empty() && !s.key_id.is_empty() && !s.team_id.is_empty(),
        key_id: s.key_id,
        team_id: s.team_id,
        bundle_id: if s.bundle_id.is_empty() { DEFAULT_BUNDLE_ID.into() } else { s.bundle_id },
        devices: s.devices.len(),
    }
}

/// Enregistre la clé APNs. `key_p8` vide = on garde la clé déjà enregistrée
/// (pour ne modifier que le Key ID ou le bundle sans recoller le fichier).
#[tauri::command]
pub fn apns_configure(
    app: tauri::AppHandle,
    key_id: String,
    team_id: String,
    key_p8: String,
    bundle_id: Option<String>,
) -> Result<ApnsStatus, String> {
    let mut s = read(&app);
    let key_id = key_id.trim().to_uppercase();
    let team_id = team_id.trim().to_uppercase();
    if key_id.len() != 10 || team_id.len() != 10 {
        return Err("Key ID et Team ID font 10 caractères.".into());
    }
    if !key_p8.trim().is_empty() {
        let secret = parse_p8(&key_p8)?;
        s.key = base64::engine::general_purpose::STANDARD.encode(secret.to_bytes());
    }
    if s.key.is_empty() {
        return Err("Colle le contenu du fichier .p8.".into());
    }
    s.key_id = key_id;
    s.team_id = team_id;
    s.bundle_id = bundle_id
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| DEFAULT_BUNDLE_ID.into());
    write(&app, &s)?;
    *JWT_CACHE.lock().unwrap() = None;
    Ok(apns_status(app))
}

#[tauri::command]
pub fn apns_clear(app: tauri::AppHandle) -> Result<(), String> {
    let mut s = read(&app);
    s.key.clear();
    s.key_id.clear();
    s.team_id.clear();
    *JWT_CACHE.lock().unwrap() = None;
    write(&app, &s)
}

/// Notification d'essai vers tous les iPhone enregistrés. Rend un compte
/// rendu lisible (combien envoyées, première erreur d'Apple).
#[tauri::command]
pub async fn apns_test(app: tauri::AppHandle) -> Result<String, String> {
    let s = read(&app);
    if s.devices.is_empty() {
        return Err("Aucun iPhone enregistré : ouvre l'app Lumen sur l'iPhone et autorise les notifications.".into());
    }
    let (ok, errors) = send_all(&app, None, "Lumen", "Les notifications fonctionnent.", "", None).await;
    match errors.first() {
        Some(e) if ok == 0 => Err(e.clone()),
        Some(e) => Ok(format!("{ok} envoyée(s), une erreur : {e}")),
        None => Ok(format!("{ok} notification(s) envoyée(s).")),
    }
}

// ===== Appareils (routes du compagnon) =====

pub fn register(app: &tauri::AppHandle, profile_id: String, token: String, sandbox: bool) -> Result<(), String> {
    let token = token.trim().to_lowercase();
    if token.len() < 32 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("jeton APNs invalide".into());
    }
    let mut s = read(app);
    s.devices.retain(|d| d.token != token);
    s.devices.push(Device { profile_id, token, sandbox, created_at: now_secs() });
    write(app, &s)
}

pub fn unregister(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    let mut s = read(app);
    s.devices.retain(|d| d.token != token.trim().to_lowercase());
    write(app, &s)
}

// ===== Envoi =====

static JWT_CACHE: std::sync::Mutex<Option<(String, u64)>> = std::sync::Mutex::new(None);

fn jwt(store: &Store) -> Result<String, String> {
    if let Some((token, at)) = JWT_CACHE.lock().unwrap().as_ref() {
        if now_secs().saturating_sub(*at) < 50 * 60 {
            return Ok(token.clone());
        }
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(&store.key)
        .map_err(|e| e.to_string())?;
    let secret = p256::SecretKey::from_slice(&raw).map_err(|e| e.to_string())?;
    let iat = now_secs();
    let header = B64URL.encode(format!(r#"{{"alg":"ES256","kid":"{}"}}"#, store.key_id));
    let claims = B64URL.encode(format!(r#"{{"iss":"{}","iat":{iat}}}"#, store.team_id));
    let input = format!("{header}.{claims}");
    // JWS veut la signature brute r||s (64 octets), pas DER.
    let sig: p256::ecdsa::Signature = p256::ecdsa::SigningKey::from(&secret).sign(input.as_bytes());
    let token = format!("{input}.{}", B64URL.encode(sig.to_bytes()));
    *JWT_CACHE.lock().unwrap() = Some((token.clone(), iat));
    Ok(token)
}

/// Envoie aux iPhone d'un profil (ou à tous). Silencieux si APNs n'est pas
/// configuré. Rend (envoyées, erreurs).
async fn send_all(
    app: &tauri::AppHandle,
    profile_id: Option<&str>,
    title: &str,
    body: &str,
    url: &str,
    extra: Option<serde_json::Value>,
) -> (usize, Vec<String>) {
    let store = read(app);
    if store.key.is_empty() || store.key_id.is_empty() || store.team_id.is_empty() {
        return (0, vec![]);
    }
    let targets: Vec<Device> = store
        .devices
        .iter()
        .filter(|d| profile_id.is_none_or(|p| d.profile_id == p))
        .cloned()
        .collect();
    if targets.is_empty() {
        return (0, vec![]);
    }
    let jwt = match jwt(&store) {
        Ok(j) => j,
        Err(e) => return (0, vec![e]),
    };
    let bundle = if store.bundle_id.is_empty() { DEFAULT_BUNDLE_ID } else { &store.bundle_id };
    // APNs n'accepte QUE HTTP/2.
    let client = match reqwest::Client::builder()
        .http2_prior_knowledge()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => return (0, vec![e.to_string()]),
    };
    let mut payload = serde_json::json!({
        "aps": { "alert": { "title": title, "body": body }, "sound": "default" },
        "url": url,
    });
    if let Some(serde_json::Value::Object(extra)) = extra {
        for (k, v) in extra {
            if k == "category" {
                // Catégorie iOS → boutons d'action ; demande urgente → sonne
                // même en mode Concentration « time-sensitive ».
                payload["aps"]["category"] = v;
                payload["aps"]["interruption-level"] = "time-sensitive".into();
            } else {
                payload[k] = v;
            }
        }
    }

    let (mut ok, mut errors) = (0, Vec::new());
    for d in targets {
        let host = if d.sandbox { "api.sandbox.push.apple.com" } else { "api.push.apple.com" };
        let resp = client
            .post(format!("https://{host}/3/device/{}", d.token))
            .header("authorization", format!("bearer {jwt}"))
            .header("apns-topic", bundle)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .json(&payload)
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => ok += 1,
            Ok(r) => {
                let status = r.status();
                let reason = r
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("reason").and_then(|x| x.as_str()).map(String::from))
                    .unwrap_or_default();
                // 410 / BadDeviceToken : app désinstallée ou jeton périmé.
                if status == 410 || reason == "BadDeviceToken" || reason == "Unregistered" {
                    let _ = unregister(app, &d.token);
                }
                errors.push(format!("APNs {status} {reason}"));
            }
            Err(e) => errors.push(e.to_string()),
        }
    }
    for e in &errors {
        eprintln!("apns : {e}");
    }
    (ok, errors)
}

/// Point d'entrée appelé par push::notify, à côté de Web Push.
pub async fn notify(
    app: &tauri::AppHandle,
    profile_id: Option<&str>,
    title: &str,
    body: &str,
    url: &str,
    extra: Option<serde_json::Value>,
) {
    let _ = send_all(app, profile_id, title, body, url, extra).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une clé P-256 encodée en PKCS#8 comme les .p8 d'Apple doit rendre le
    /// même scalaire.
    #[test]
    fn parses_pkcs8_p256() {
        let mut raw = [0u8; 32];
        raw[31] = 7;
        raw[0] = 0x11;
        // PKCS#8 minimal : SEQ { INT 0, SEQ { OID ecPublicKey, OID prime256v1 },
        //   OCTET STRING { SEQ { INT 1, OCTET STRING(32) scalaire } } }
        let mut ec = vec![0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20];
        ec.extend_from_slice(&raw);
        let mut der = vec![0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
            0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27];
        der.extend_from_slice(&ec);
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(&der)
        );
        let key = parse_p8(&pem).unwrap();
        assert_eq!(key.to_bytes().as_slice(), &raw);
    }
}
