//! Clés API chiffrées au repos.
//!
//! Les fichiers de configuration (`ollama.json`, `api-profiles.json`) ne
//! contiennent plus de clé en clair : chaque clé y est scellée (AES-256-GCM)
//! sous la forme `enc:v1:<base64(nonce ‖ chiffré)>`.
//!
//! La clé maîtresse (32 octets aléatoires) vit :
//!   • sous macOS, dans le **Trousseau** (élément générique « com.lumen.app.secrets ») :
//!     un autre programme — un script lancé par un workflow, par exemple — doit
//!     passer par l'autorisation du Trousseau pour la lire ;
//!   • ailleurs, dans `secrets.key` (0600) à côté de la configuration.
//!
//! Elle est lue une fois par lancement puis gardée en mémoire. Une valeur sans
//! préfixe est une clé héritée en clair : elle reste lisible, et sera scellée à
//! la prochaine écriture.
//!
//! Objectif : qu'aucune IA (outil, bloc Fluxo, agent, script) ne puisse obtenir
//! une clé API en lisant un fichier ou l'environnement du processus.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use std::path::PathBuf;
use std::sync::OnceLock;

const PREFIX: &str = "enc:v1:";
static MASTER: OnceLock<Option<[u8; 32]>> = OnceLock::new();
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// À appeler au démarrage : dossier où ranger `secrets.key` hors macOS.
pub fn init(data_dir: PathBuf) {
    let _ = DATA_DIR.set(data_dir);
}

fn random_key() -> [u8; 32] {
    let mut k = [0u8; 32];
    getrandom::getrandom(&mut k).expect("source d'entropie indisponible");
    k
}

#[cfg(target_os = "macos")]
fn load_or_create_master() -> Option<[u8; 32]> {
    use security_framework::passwords::{get_generic_password, set_generic_password};
    const SERVICE: &str = "com.lumen.app.secrets";
    const ACCOUNT: &str = "master-key";
    if let Ok(bytes) = get_generic_password(SERVICE, ACCOUNT) {
        if let Ok(k) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Some(k);
        }
    }
    let k = random_key();
    set_generic_password(SERVICE, ACCOUNT, &k).ok()?;
    Some(k)
}

#[cfg(not(target_os = "macos"))]
fn load_or_create_master() -> Option<[u8; 32]> {
    let dir = DATA_DIR.get()?;
    let path = dir.join("secrets.key");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(k) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Some(k);
        }
    }
    let _ = std::fs::create_dir_all(dir);
    let k = random_key();
    std::fs::write(&path, k).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Some(k)
}

fn master() -> Option<[u8; 32]> {
    *MASTER.get_or_init(load_or_create_master)
}

fn seal_with(key: &[u8; 32], plain: &str) -> Option<String> {
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).ok()?;
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), plain.as_bytes()).ok()?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Some(format!("{PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

fn open_with(key: &[u8; 32], sealed: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::STANDARD.decode(sealed.strip_prefix(PREFIX)?).ok()?;
    if raw.len() < 13 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let plain = cipher.decrypt(Nonce::from_slice(&raw[..12]), &raw[12..]).ok()?;
    String::from_utf8(plain).ok()
}

/// Scelle une clé pour l'écrire sur disque. Vide reste vide. Sans clé
/// maîtresse disponible (Trousseau refusé), on n'écrit RIEN plutôt que du clair.
pub fn seal(plain: &str) -> String {
    if plain.is_empty() || plain.starts_with(PREFIX) {
        return plain.to_string();
    }
    master().and_then(|k| seal_with(&k, plain)).unwrap_or_default()
}

/// Ouvre une valeur lue sur disque (clair hérité accepté).
pub fn open(stored: &str) -> String {
    if !stored.starts_with(PREFIX) {
        return stored.to_string();
    }
    master().and_then(|k| open_with(&k, stored)).unwrap_or_default()
}

/// serde : champ secret scellé à l'écriture, ouvert à la lecture.
pub mod field {
    use serde::{Deserialize, Deserializer, Serializer};
    #[allow(clippy::ptr_arg)]
    pub fn serialize<S: Serializer>(v: &String, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::seal(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
        let raw = String::deserialize(d)?;
        Ok(super::open(&raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scelle_et_ouvre() {
        let k = random_key();
        let s = seal_with(&k, "sk-test-123456").unwrap();
        assert!(s.starts_with(PREFIX));
        assert!(!s.contains("sk-test"));
        assert_eq!(open_with(&k, &s).as_deref(), Some("sk-test-123456"));
        // Deux scellements du même texte diffèrent (nonce aléatoire).
        assert_ne!(s, seal_with(&k, "sk-test-123456").unwrap());
    }

    #[test]
    fn mauvaise_cle_ou_valeur_alteree() {
        let k = random_key();
        let s = seal_with(&k, "secret").unwrap();
        assert_eq!(open_with(&random_key(), &s), None);
        let mut bad = s.clone();
        bad.pop();
        bad.push('A');
        assert!(open_with(&k, &bad).is_none() || open_with(&k, &bad).as_deref() != Some("secret"));
    }

    #[test]
    fn clair_herite_conserve() {
        assert_eq!(open("sk-legacy"), "sk-legacy");
        assert_eq!(open(""), "");
    }
}
