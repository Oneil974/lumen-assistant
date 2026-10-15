//! Sauvegarde automatique chiffrée.
//!
//! Toutes les N heures, Lumen écrit une archive `.lumenbackup` (même contenu
//! que l'export manuel de backup.rs) puis la chiffre vers le dossier choisi —
//! typiquement un disque externe ou un dossier synchronisé (iCloud, NAS).
//! On garde les K plus récentes.
//!
//! ## Chiffrement
//!
//! Clé AES-256 dérivée d'une phrase secrète par PBKDF2-HMAC-SHA256
//! (310 000 itérations, sel aléatoire). Seule la clé dérivée est gardée sur
//! cette machine (`autobackup.json`, 0600) : les archives parties sur un disque
//! externe ou un cloud sont illisibles sans la phrase, qu'il faudra redonner
//! pour restaurer ailleurs.
//!
//! Format (`.lumenbackup.enc`) : `LUMENENC1` ‖ sel(16) ‖ préfixe de nonce(8)
//! ‖ blocs. Chaque bloc = longueur(4, BE) ‖ AES-GCM(1 Mio max), nonce =
//! préfixe ‖ compteur(4, BE) ; le dernier bloc est marqué par le bit de poids
//! fort du compteur, ce qui empêche de tronquer l'archive sans que ça se voie.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAGIC: &[u8] = b"LUMENENC1";
const CHUNK: usize = 1 << 20;
const PBKDF2_ROUNDS: u32 = 310_000;
const LAST: u32 = 0x8000_0000;

#[derive(Clone, Default, Serialize, Deserialize)]
struct Config {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    dir: String,
    #[serde(default = "default_every")]
    every_hours: u64,
    #[serde(default = "default_keep")]
    keep: usize,
    #[serde(default)]
    last_run: u64,
    #[serde(default)]
    last_error: String,
    #[serde(default)]
    salt: String,
    #[serde(default)]
    key: String,
}

fn default_every() -> u64 { 24 }
fn default_keep() -> usize { 7 }

#[derive(Serialize)]
pub struct AutoBackupStatus {
    pub enabled: bool,
    pub dir: String,
    pub every_hours: u64,
    pub keep: usize,
    pub last_run: u64,
    pub last_error: String,
    pub has_passphrase: bool,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cfg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    Ok(dir.join("autobackup.json"))
}

fn read_cfg(app: &tauri::AppHandle) -> Config {
    cfg_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Config { every_hours: 24, keep: 7, ..Default::default() })
}

fn write_cfg(app: &tauri::AppHandle, c: &Config) -> Result<(), String> {
    let p = cfg_path(app)?;
    fs::write(&p, serde_json::to_string_pretty(c).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn status(c: &Config) -> AutoBackupStatus {
    AutoBackupStatus {
        enabled: c.enabled,
        dir: c.dir.clone(),
        every_hours: c.every_hours,
        keep: c.keep,
        last_run: c.last_run,
        last_error: c.last_error.clone(),
        has_passphrase: !c.key.is_empty(),
    }
}

// ===== Cryptographie =====

/// PBKDF2-HMAC-SHA256, un seul bloc de sortie (32 octets = clé AES-256).
fn pbkdf2(pass: &[u8], salt: &[u8], rounds: u32) -> [u8; 32] {
    type H = Hmac<Sha256>;
    let mut mac = <H as Mac>::new_from_slice(pass).expect("HMAC accepte toute clé");
    mac.update(salt);
    mac.update(&1u32.to_be_bytes());
    let mut u: [u8; 32] = mac.finalize().into_bytes().into();
    let mut out = u;
    for _ in 1..rounds {
        let mut mac = <H as Mac>::new_from_slice(pass).expect("HMAC accepte toute clé");
        mac.update(&u);
        u = mac.finalize().into_bytes().into();
        for (o, x) in out.iter_mut().zip(u.iter()) {
            *o ^= x;
        }
    }
    out
}

fn nonce_for(prefix: &[u8; 8], counter: u32) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..8].copy_from_slice(prefix);
    n[8..].copy_from_slice(&counter.to_be_bytes());
    n
}

/// Chiffre `src` vers `dest` (flux, blocs de 1 Mio).
pub fn encrypt_file(src: &Path, dest: &Path, key: &[u8; 32], salt: &[u8; 16]) -> Result<(), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut prefix = [0u8; 8];
    getrandom::getrandom(&mut prefix).map_err(|e| e.to_string())?;
    let mut input = fs::File::open(src).map_err(|e| e.to_string())?;
    let total = input.metadata().map_err(|e| e.to_string())?.len() as usize;
    let tmp = dest.with_extension("enc.part");
    let mut out = std::io::BufWriter::new(fs::File::create(&tmp).map_err(|e| e.to_string())?);
    out.write_all(MAGIC).and_then(|_| out.write_all(salt)).and_then(|_| out.write_all(&prefix)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK];
    let (mut done, mut counter) = (0usize, 0u32);
    loop {
        let want = CHUNK.min(total - done);
        input.read_exact(&mut buf[..want]).map_err(|e| e.to_string())?;
        done += want;
        let last = done >= total;
        let ctr = if last { counter | LAST } else { counter };
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce_for(&prefix, ctr)), &buf[..want])
            .map_err(|_| "chiffrement impossible".to_string())?;
        out.write_all(&(ct.len() as u32).to_be_bytes()).and_then(|_| out.write_all(&ct)).map_err(|e| e.to_string())?;
        if last {
            break;
        }
        counter += 1;
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

pub fn is_encrypted(path: &Path) -> bool {
    let mut head = [0u8; 9];
    fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && head == MAGIC
}

/// Déchiffre une archive `.lumenbackup.enc` avec la phrase secrète.
pub fn decrypt_file(src: &Path, dest: &Path, passphrase: &str) -> Result<(), String> {
    let mut input = std::io::BufReader::new(fs::File::open(src).map_err(|e| e.to_string())?);
    let mut head = [0u8; 9 + 16 + 8];
    input.read_exact(&mut head).map_err(|_| "archive chiffrée tronquée".to_string())?;
    if &head[..9] != MAGIC {
        return Err("ce n'est pas une sauvegarde chiffrée Lumen".into());
    }
    let salt: [u8; 16] = head[9..25].try_into().unwrap();
    let prefix: [u8; 8] = head[25..33].try_into().unwrap();
    let key = pbkdf2(passphrase.as_bytes(), &salt, PBKDF2_ROUNDS);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut out = std::io::BufWriter::new(fs::File::create(dest).map_err(|e| e.to_string())?);
    let mut counter = 0u32;
    loop {
        let mut len = [0u8; 4];
        input.read_exact(&mut len).map_err(|_| "archive chiffrée tronquée".to_string())?;
        let mut ct = vec![0u8; u32::from_be_bytes(len) as usize];
        input.read_exact(&mut ct).map_err(|_| "archive chiffrée tronquée".to_string())?;
        // On essaie « bloc courant » puis « dernier bloc » : seul le bon passe
        // l'authentification GCM.
        if let Ok(pt) = cipher.decrypt(Nonce::from_slice(&nonce_for(&prefix, counter)), ct.as_slice()) {
            out.write_all(&pt).map_err(|e| e.to_string())?;
            counter += 1;
            continue;
        }
        let pt = cipher
            .decrypt(Nonce::from_slice(&nonce_for(&prefix, counter | LAST)), ct.as_slice())
            .map_err(|_| "phrase secrète incorrecte ou archive altérée".to_string())?;
        out.write_all(&pt).map_err(|e| e.to_string())?;
        break;
    }
    out.flush().map_err(|e| e.to_string())
}

// ===== Exécution =====

fn run(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut c = read_cfg(app);
    if c.dir.trim().is_empty() || c.key.is_empty() {
        return Err("dossier ou phrase secrète manquants".into());
    }
    let dir = PathBuf::from(c.dir.trim());
    fs::create_dir_all(&dir).map_err(|e| format!("dossier inaccessible : {e}"))?;
    let key: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(&c.key)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "clé invalide".to_string())?;
    let salt: [u8; 16] = base64::engine::general_purpose::STANDARD
        .decode(&c.salt)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "sel invalide".to_string())?;

    let tmp_dir = std::env::temp_dir().join("lumen-autobackup");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let plain = tmp_dir.join("current.lumenbackup");
    let result = crate::backup::export_to(app, &plain).and_then(|_| {
        let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M");
        let dest = dir.join(format!("Lumen_auto_{stamp}.lumenbackup.enc"));
        encrypt_file(&plain, &dest, &key, &salt).map(|_| dest)
    });
    let _ = fs::remove_file(&plain);

    match &result {
        Ok(_) => {
            c.last_run = now();
            c.last_error.clear();
            prune(&dir, c.keep);
        }
        Err(e) => c.last_error = e.clone(),
    }
    let _ = write_cfg(app, &c);
    result
}

/// Garde les `keep` archives automatiques les plus récentes.
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut autos: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("Lumen_auto_") && n.ends_with(".lumenbackup.enc"))
                .unwrap_or(false)
        })
        .collect();
    autos.sort();
    while autos.len() > keep.max(1) {
        let _ = fs::remove_file(autos.remove(0));
    }
}

/// Boucle de fond : vérifie toutes les 30 minutes si une sauvegarde est due.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(90));
        let c = read_cfg(&app);
        if c.enabled && now().saturating_sub(c.last_run) >= c.every_hours.max(1) * 3600 {
            if let Err(e) = run(&app) {
                eprintln!("sauvegarde automatique : {e}");
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(30 * 60 - 90));
    });
}

// ===== Commandes =====

#[tauri::command]
pub fn autobackup_get(app: tauri::AppHandle) -> AutoBackupStatus {
    status(&read_cfg(&app))
}

#[tauri::command]
pub fn autobackup_set(
    app: tauri::AppHandle,
    enabled: bool,
    dir: String,
    every_hours: u64,
    keep: usize,
    passphrase: Option<String>,
) -> Result<AutoBackupStatus, String> {
    let mut c = read_cfg(&app);
    if let Some(p) = passphrase.filter(|p| !p.is_empty()) {
        if p.chars().count() < 8 {
            return Err("La phrase secrète doit faire au moins 8 caractères.".into());
        }
        let mut salt = [0u8; 16];
        getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
        let key = pbkdf2(p.as_bytes(), &salt, PBKDF2_ROUNDS);
        c.salt = base64::engine::general_purpose::STANDARD.encode(salt);
        c.key = base64::engine::general_purpose::STANDARD.encode(key);
    }
    if enabled && (dir.trim().is_empty() || c.key.is_empty()) {
        return Err("Choisis un dossier et une phrase secrète.".into());
    }
    c.enabled = enabled;
    c.dir = dir.trim().to_string();
    c.every_hours = every_hours.clamp(1, 24 * 30);
    c.keep = keep.clamp(1, 100);
    write_cfg(&app, &c)?;
    Ok(status(&c))
}

#[tauri::command]
pub async fn autobackup_run_now(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run(&app))
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_roundtrip_multi_chunk() {
        let dir = std::env::temp_dir().join(format!("lumen-enc-{}", now()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.bin");
        let data: Vec<u8> = (0..(CHUNK * 2 + 777)).map(|i| (i % 251) as u8).collect();
        fs::write(&src, &data).unwrap();
        let salt = [3u8; 16];
        // Peu d'itérations en test : on vérifie le format, pas la lenteur.
        let key = pbkdf2(b"phrase-secrete", &salt, PBKDF2_ROUNDS);
        let enc = dir.join("a.enc");
        encrypt_file(&src, &enc, &key, &salt).unwrap();
        assert!(is_encrypted(&enc));
        let out = dir.join("b.bin");
        decrypt_file(&enc, &out, "phrase-secrete").unwrap();
        assert_eq!(fs::read(&out).unwrap(), data);
        assert!(decrypt_file(&enc, &dir.join("c.bin"), "mauvaise").is_err());
        // Troncature (dernier bloc retiré) détectée.
        let bytes = fs::read(&enc).unwrap();
        fs::write(dir.join("t.enc"), &bytes[..bytes.len() - 100]).unwrap();
        assert!(decrypt_file(&dir.join("t.enc"), &dir.join("d.bin"), "phrase-secrete").is_err());
    }

    /// Vecteur de test RFC 7914 §11 (PBKDF2-HMAC-SHA256, « passwd »/« salt », 1 itération).
    #[test]
    fn pbkdf2_vector() {
        let k = pbkdf2(b"passwd", b"salt", 1);
        assert_eq!(&k[..8], &[0x55, 0xac, 0x04, 0x6e, 0x56, 0xe3, 0x08, 0x9f]);
    }
}
