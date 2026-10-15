//! Ressources de la machine : mémoire vive totale et espace disque disponible
//! là où Lumen stocke ses modèles.
//!
//! Sert à guider l'utilisateur au lieu de le laisser télécharger 9 Go sur un
//! portable de 8 Go de RAM ou un disque plein : l'assistant et les Paramètres
//! recommandent un palier (« Rapide » / « Équilibré » / « Puissant ») et
//! bloquent un téléchargement qui ne tiendrait pas sur le disque.
//!
//! Volontairement sans dépendance supplémentaire : chaque plateforme expose
//! déjà l'information via un appel système simple.

use serde::Serialize;
use std::path::Path;
use tauri::Manager;

#[derive(Serialize, Clone)]
pub struct SystemResources {
    /// Mémoire vive totale en octets (0 si indéterminée).
    pub total_memory: u64,
    /// Espace libre en octets sur le volume des modèles (0 si indéterminé).
    pub free_disk: u64,
    /// Palier conseillé : "fast" | "balanced" | "powerful".
    pub tier: String,
}

/// Palier conseillé d'après la RAM totale. Les seuils suivent ceux affichés dans
/// le catalogue (`ramHint`) : un modèle « Puissant » demande ~16 Go.
fn tier_for_memory(total_memory: u64) -> &'static str {
    const GB: u64 = 1024 * 1024 * 1024;
    match total_memory {
        0 => "balanced", // inconnue : on ne surprend pas l'utilisateur
        m if m < 9 * GB => "fast",
        m if m < 17 * GB => "balanced",
        _ => "powerful",
    }
}

#[cfg(target_os = "macos")]
fn total_memory() -> u64 {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn total_memory() -> u64 {
    // /proc/meminfo : « MemTotal:       16337012 kB »
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|content| {
            content
                .lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<u64>().ok())
        })
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
fn total_memory() -> u64 {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn total_memory() -> u64 {
    0
}

#[cfg(unix)]
fn free_disk(path: &Path) -> u64 {
    // `df -k <dir>` : la dernière ligne porte « Available » en 4ᵉ colonne.
    std::process::Command::new("df")
        .arg("-k")
        .arg(path)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|out| {
            out.lines()
                .nth(1)
                .and_then(|line| line.split_whitespace().nth(3))
                .and_then(|kb| kb.parse::<u64>().ok())
        })
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

#[cfg(windows)]
fn free_disk(path: &Path) -> u64 {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let drive = path
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .unwrap_or_else(|| "C:".into());
    let letter = drive.trim_end_matches(['\\', ':']).to_string();
    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("(Get-PSDrive -Name '{letter}').Free"),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Mémoire et espace disque disponibles pour guider le choix d'un modèle.
// `(async)` : sous Windows, mémoire et espace disque passent par deux appels
// à PowerShell, dont le démarrage coûte à lui seul plus d'une seconde. Sur le
// fil principal, cela se voyait comme un gel de la fenêtre.
#[tauri::command(async)]
pub fn system_resources(app: tauri::AppHandle) -> SystemResources {
    let total_memory = total_memory();
    let models_dir = crate::paths::shared_data_dir(app.path())
        .map(|dir| dir.join("models"))
        .unwrap_or_else(|_| std::env::temp_dir());
    // Le dossier peut ne pas exister au tout premier lancement : on interroge
    // alors le premier parent existant, qui est sur le même volume.
    let mut probe = models_dir.as_path();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    SystemResources {
        total_memory,
        free_disk: free_disk(probe),
        tier: tier_for_memory(total_memory).into(),
    }
}
