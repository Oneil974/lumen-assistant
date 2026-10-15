//! État d'alimentation de la machine : batterie et secteur.
//!
//! Pourquoi une commande Rust alors que le web expose `navigator.getBattery()` ?
//! Parce que cette API n'existe que sur les WebView Chromium. Lumen tourne sur
//! trois moteurs : WebView2 (Windows, Chromium — l'API est là), WKWebView
//! (macOS) et WebKitGTK (Linux, Raspberry Pi) — et WebKit a retiré la Battery
//! Status API. Sur deux plateformes sur trois, l'indicateur serait donc resté
//! vide. Le front essaie l'API standard d'abord et retombe ici.
//!
//! Aucune des lectures ci-dessous ne démarre de processus sous Windows : c'est
//! justement la plateforme où la WebView sait répondre seule.

use serde::Serialize;

#[derive(Serialize, Default, Clone)]
pub struct PowerStatus {
    /// Faux sur une machine de bureau : l'indicateur se masque alors.
    pub has_battery: bool,
    /// Charge restante, 0–100. `-1` quand elle n'a pas pu être lue.
    pub percent: i32,
    pub charging: bool,
}

/// Linux (dont Raspberry Pi) : sysfs, sans lancer un seul processus.
/// Un Pi n'a normalement pas de batterie — la fonction renvoie alors
/// `has_battery: false`, et l'indicateur disparaît de lui-même.
#[cfg(target_os = "linux")]
fn read_status() -> PowerStatus {
    let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") else {
        return PowerStatus::default();
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let kind = std::fs::read_to_string(dir.join("type")).unwrap_or_default();
        if kind.trim() != "Battery" {
            continue;
        }
        let percent = std::fs::read_to_string(dir.join("capacity"))
            .ok()
            .and_then(|s| s.trim().parse::<i32>().ok())
            .unwrap_or(-1);
        let state = std::fs::read_to_string(dir.join("status")).unwrap_or_default();
        let state = state.trim();
        return PowerStatus {
            has_battery: true,
            percent,
            // « Full » sur secteur compte comme branché : l'utilisateur veut
            // savoir s'il consomme la batterie, pas si le courant entre.
            charging: state == "Charging" || state == "Full",
        };
    }
    PowerStatus::default()
}

/// macOS : `pmset -g batt` — une ligne « 87%; discharging; 3:12 remaining ».
/// IOKit donnerait la même chose sans processus, au prix d'une dépendance
/// système complète pour trois nombres.
#[cfg(target_os = "macos")]
fn read_status() -> PowerStatus {
    let Ok(out) = std::process::Command::new("pmset").args(["-g", "batt"]).output() else {
        return PowerStatus::default();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    // Pas de ligne « InternalBattery » : Mac de bureau (Mac mini, Studio…).
    let Some(line) = text.lines().find(|l| l.contains("InternalBattery")) else {
        return PowerStatus::default();
    };
    let percent = line
        .split(';')
        .find_map(|part| part.trim().strip_suffix('%'))
        .and_then(|p| p.rsplit('\t').next())
        .and_then(|p| p.trim().parse::<i32>().ok())
        .unwrap_or(-1);
    // La première ligne dit d'où vient le courant : « Now drawing from 'AC
    // Power' » ou « 'Battery Power' ». Plus fiable que l'état de la cellule,
    // qui vaut « charged » aussi bien branché que juste après le débranchement.
    let charging = text.contains("AC Power");
    PowerStatus { has_battery: true, percent, charging }
}

/// Windows : la WebView (Chromium) répond déjà via `navigator.getBattery()`.
/// Lancer PowerShell pour la même information coûterait une seconde entière.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read_status() -> PowerStatus {
    PowerStatus::default()
}

/// `(async)` : la lecture macOS lance `pmset`. Sur le fil principal, cela
/// serait un micro-gel toutes les minutes.
#[tauri::command(async)]
pub fn power_status() -> PowerStatus {
    read_status()
}
