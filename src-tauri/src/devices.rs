//! Appareils de confiance + journal de sécurité.
//!
//! Chaque appairage (compagnon web, app iOS, Lumen XR) crée un APPAREIL, dont
//! l'identifiant est inscrit dans le jeton (`<profil>~<appareil>.<exp>.<sig>`).
//! Révoquer un appareil coupe ce seul appareil — avant, il fallait régénérer le
//! secret du profil et réappairer tout le monde.
//!
//! Un appareil iOS peut aussi déposer une clé publique P-256 dont la clé privée
//! vit dans la Secure Enclave et n'est utilisable qu'après Face ID : c'est le
//! déverrouillage biométrique (`/unlock/challenge` puis `/unlock`). La
//! signature prouve « ce téléphone-là, avec le visage de son propriétaire ».
//!
//! Le journal (`security-log.jsonl`, 500 dernières lignes) trace appairages,
//! déverrouillages, échecs et révocations : qui, quel appareil, quand, d'où.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    /// "ios" | "web" | "xr" | "other"
    pub kind: String,
    pub created_at: u64,
    #[serde(default)]
    pub last_seen: u64,
    #[serde(default)]
    pub last_ip: String,
    /// Clé publique P-256 (SEC1 non compressée, base64) protégée par Face ID.
    #[serde(default)]
    pub bio_key: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    devices: Vec<Device>,
    /// Déverrouillage à distance : `false` (défaut) = un geste suffit depuis
    /// un appareil appairé (il a déjà prouvé le TOTP à l'appairage) ;
    /// `true` = le code TOTP est redemandé à chaque fois.
    #[serde(default)]
    require_code: bool,
}

struct Registry {
    path: PathBuf,
    log_path: PathBuf,
    store: Store,
    /// Défis de déverrouillage biométrique : appareil → (nonce, émis à).
    challenges: HashMap<String, (String, u64)>,
}

static REG: OnceLock<Mutex<Registry>> = OnceLock::new();

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// À appeler une fois au démarrage (setup de l'app).
pub fn init(app: &tauri::AppHandle) {
    let Ok(dir) = crate::paths::shared_data_dir(app.path()) else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("companion_devices.json");
    let store = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let _ = REG.set(Mutex::new(Registry {
        path,
        log_path: dir.join("security-log.jsonl"),
        store,
        challenges: HashMap::new(),
    }));
}

fn with<R>(f: impl FnOnce(&mut Registry) -> R) -> Option<R> {
    let reg = REG.get()?;
    let mut g = reg.lock().ok()?;
    Some(f(&mut g))
}

fn save(r: &Registry) {
    if let Ok(txt) = serde_json::to_string_pretty(&r.store) {
        let _ = std::fs::write(&r.path, txt);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&r.path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

fn random_id() -> String {
    let mut b = [0u8; 9];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Nom lisible déduit du User-Agent quand l'appareil ne s'est pas nommé.
pub fn guess_kind_and_name(ua: &str, kind_hint: &str) -> (String, String) {
    let ua_l = ua.to_lowercase();
    let kind = if !kind_hint.is_empty() {
        kind_hint.to_string()
    } else if ua_l.contains("lumencompanion") {
        "ios".into()
    } else if ua_l.contains("oculus") || ua_l.contains("quest") {
        "xr".into()
    } else {
        "web".into()
    };
    let name = if ua_l.contains("iphone") {
        "iPhone"
    } else if ua_l.contains("ipad") {
        "iPad"
    } else if ua_l.contains("oculus") || ua_l.contains("quest") {
        "Meta Quest"
    } else if ua_l.contains("android") {
        "Android"
    } else if ua_l.contains("mac os") {
        "Mac"
    } else if ua_l.contains("windows") {
        "Windows"
    } else {
        "Appareil"
    };
    (kind, name.into())
}

/// Enregistre un nouvel appareil et renvoie son identifiant.
pub fn register(profile_id: &str, name: &str, kind: &str, ip: &str) -> Option<String> {
    let id = random_id();
    let t = now();
    with(|r| {
        r.store.devices.push(Device {
            id: id.clone(),
            profile_id: profile_id.into(),
            name: name.chars().take(60).collect(),
            kind: kind.into(),
            created_at: t,
            last_seen: t,
            last_ip: ip.into(),
            bio_key: String::new(),
        });
        save(r);
    })?;
    log("pair", profile_id, Some(&id), ip, true, name);
    Some(id)
}

/// Appareil valide (connu, non révoqué, du bon profil) ? Met à jour la date
/// de dernière activité (écrite au plus toutes les 5 minutes).
pub fn check(profile_id: &str, device_id: &str) -> bool {
    with(|r| {
        let t = now();
        let Some(d) = r.store.devices.iter_mut().find(|d| d.id == device_id) else { return false };
        if d.profile_id != profile_id {
            return false;
        }
        if t.saturating_sub(d.last_seen) > 300 {
            d.last_seen = t;
            save(r);
        }
        true
    })
    .unwrap_or(false)
}

pub fn get(device_id: &str) -> Option<Device> {
    with(|r| r.store.devices.iter().find(|d| d.id == device_id).cloned()).flatten()
}

pub fn set_bio_key(device_id: &str, key_b64: &str) -> Result<(), String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(key_b64.trim())
        .map_err(|_| "clé illisible".to_string())?;
    p256::ecdsa::VerifyingKey::from_sec1_bytes(&raw).map_err(|_| "clé P-256 invalide".to_string())?;
    with(|r| {
        let Some(d) = r.store.devices.iter_mut().find(|d| d.id == device_id) else {
            return Err("appareil inconnu".to_string());
        };
        d.bio_key = key_b64.trim().to_string();
        let profile = d.profile_id.clone();
        save(r);
        Ok(profile)
    })
    .ok_or("registre indisponible")?
    .map(|profile| log("bio-key", &profile, Some(device_id), "", true, "Face ID activé"))
}

/// Nouveau défi (30 octets aléatoires, base64) valable 2 minutes.
pub fn challenge(device_id: &str) -> Option<String> {
    let mut b = [0u8; 30];
    getrandom::getrandom(&mut b).ok()?;
    let nonce = base64::engine::general_purpose::STANDARD.encode(b);
    with(|r| {
        r.challenges.insert(device_id.to_string(), (nonce.clone(), now()));
    })?;
    Some(nonce)
}

/// Vérifie la signature ECDSA P-256/SHA-256 (DER, telle que la produit
/// `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)`) du dernier défi
/// émis pour cet appareil. Le défi est consommé dans tous les cas.
pub fn verify_bio(device_id: &str, nonce: &str, signature_b64: &str) -> Result<(), String> {
    use p256::ecdsa::signature::Verifier;
    let (expected, key) = with(|r| {
        let ch = r.challenges.remove(device_id);
        let key = r.store.devices.iter().find(|d| d.id == device_id).map(|d| d.bio_key.clone());
        (ch, key)
    })
    .ok_or("registre indisponible")?;
    let (expected, issued) = expected.ok_or("aucun défi en cours")?;
    if expected != nonce || now().saturating_sub(issued) > 120 {
        return Err("défi expiré".into());
    }
    let key = key.filter(|k| !k.is_empty()).ok_or("Face ID n'est pas activé sur cet appareil")?;
    let raw = base64::engine::general_purpose::STANDARD.decode(key).map_err(|e| e.to_string())?;
    let vk = p256::ecdsa::VerifyingKey::from_sec1_bytes(&raw).map_err(|e| e.to_string())?;
    let sig_raw = base64::engine::general_purpose::STANDARD
        .decode(signature_b64.trim())
        .map_err(|_| "signature illisible".to_string())?;
    let sig = p256::ecdsa::Signature::from_der(&sig_raw)
        .or_else(|_| p256::ecdsa::Signature::from_slice(&sig_raw))
        .map_err(|_| "signature illisible".to_string())?;
    vk.verify(nonce.as_bytes(), &sig).map_err(|_| "signature refusée".to_string())
}

/// Un appareil appairé peut-il déverrouiller d'un simple geste ?
pub fn tap_unlock_allowed() -> bool {
    with(|r| !r.store.require_code).unwrap_or(false)
}

#[tauri::command]
pub fn unlock_policy_get() -> bool {
    with(|r| r.store.require_code).unwrap_or(false)
}

#[tauri::command]
pub fn unlock_policy_set(require_code: bool) -> Result<(), String> {
    with(|r| {
        r.store.require_code = require_code;
        save(r);
    })
    .ok_or_else(|| "registre indisponible".to_string())
}

// ===== Journal de sécurité =====

#[derive(Serialize, Deserialize, Clone)]
pub struct LogEntry {
    pub ts: u64,
    pub event: String,
    pub profile_id: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub ip: String,
    pub ok: bool,
    #[serde(default)]
    pub detail: String,
}

/// `event` : pair, unlock-code, unlock-bio, unlock-local, revoke, bio-key…
pub fn log(event: &str, profile_id: &str, device_id: Option<&str>, ip: &str, ok: bool, detail: &str) {
    let device_name = device_id.and_then(get).map(|d| d.name).unwrap_or_default();
    let entry = LogEntry {
        ts: now(),
        event: event.into(),
        profile_id: profile_id.into(),
        device_id: device_id.unwrap_or_default().into(),
        device_name,
        ip: ip.into(),
        ok,
        detail: detail.chars().take(200).collect(),
    };
    let _ = with(|r| {
        let Ok(line) = serde_json::to_string(&entry) else { return };
        let mut lines: Vec<String> = std::fs::read_to_string(&r.log_path)
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect();
        lines.push(line);
        if lines.len() > 500 {
            lines.drain(0..lines.len() - 500);
        }
        let _ = std::fs::write(&r.log_path, lines.join("\n") + "\n");
    });
}

// ===== Commandes Tauri (Réglages › Compagnon mobile) =====

#[derive(Serialize)]
pub struct DeviceView {
    #[serde(flatten)]
    pub device: Device,
    pub profile_name: String,
    pub biometric: bool,
}

#[tauri::command]
pub fn devices_list(app: tauri::AppHandle) -> Vec<DeviceView> {
    let mut list = with(|r| r.store.devices.clone()).unwrap_or_default();
    list.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    list.into_iter()
        .map(|d| DeviceView {
            profile_name: crate::session::find_profile_identity(&app, &d.profile_id)
                .map(|p| p.name)
                .unwrap_or_else(|| d.profile_id.clone()),
            biometric: !d.bio_key.is_empty(),
            device: Device { bio_key: String::new(), ..d },
        })
        .collect()
}

#[tauri::command]
pub fn device_revoke(id: String) -> Result<(), String> {
    let removed = with(|r| {
        let pos = r.store.devices.iter().position(|d| d.id == id)?;
        let d = r.store.devices.remove(pos);
        r.challenges.remove(&id);
        save(r);
        Some(d)
    })
    .flatten()
    .ok_or("appareil inconnu")?;
    log("revoke", &removed.profile_id, None, "", true, &removed.name);
    Ok(())
}

#[tauri::command]
pub fn device_rename(id: String, name: String) -> Result<(), String> {
    with(|r| {
        if let Some(d) = r.store.devices.iter_mut().find(|d| d.id == id) {
            d.name = name.trim().chars().take(60).collect();
            save(r);
        }
    })
    .ok_or_else(|| "registre indisponible".to_string())
}

#[tauri::command]
pub fn security_log(limit: Option<usize>) -> Vec<LogEntry> {
    let path = with(|r| r.log_path.clone());
    let Some(path) = path else { return vec![] };
    let mut out: Vec<LogEntry> = std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    out.reverse();
    out.truncate(limit.unwrap_or(100));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;

    #[test]
    fn biometric_signature_roundtrip() {
        let dir = std::env::temp_dir().join(format!("lumen-dev-test-{}", random_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = REG.set(Mutex::new(Registry {
            path: dir.join("d.json"),
            log_path: dir.join("l.jsonl"),
            store: Store::default(),
            challenges: HashMap::new(),
        }));
        let id = register("p1", "iPhone", "ios", "127.0.0.1").unwrap();
        assert!(check("p1", &id));
        assert!(!check("p2", &id));

        let mut raw = [7u8; 32];
        raw[0] = 1;
        let sk = p256::ecdsa::SigningKey::from_slice(&raw).unwrap();
        let pk = sk.verifying_key().to_encoded_point(false);
        set_bio_key(&id, &base64::engine::general_purpose::STANDARD.encode(pk.as_bytes())).unwrap();

        let nonce = challenge(&id).unwrap();
        let sig: p256::ecdsa::Signature = sk.sign(nonce.as_bytes());
        let der = base64::engine::general_purpose::STANDARD.encode(sig.to_der().as_bytes());
        assert!(verify_bio(&id, &nonce, &der).is_ok());
        // Défi consommé : rejouer échoue.
        assert!(verify_bio(&id, &nonce, &der).is_err());

        device_revoke(id.clone()).unwrap();
        assert!(!check("p1", &id));
    }
}
