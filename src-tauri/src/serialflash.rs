//! Flash série des cartes MicroPython depuis Lumen (Raspberry Pi Pico W).
//!
//! Deux opérations, complémentaires au générateur de firmware de l'app Domotique
//! (qui produit un `main.py`) :
//!
//!   1. **Installer MicroPython** sur une carte vierge. Le Pico W placé en mode
//!      BOOTSEL (bouton maintenu au branchement) se monte comme une clé USB
//!      contenant `INFO_UF2.TXT`. On y copie le `.uf2` officiel de MicroPython :
//!      le bootloader le programme puis redémarre. C'est une simple copie de
//!      fichier — aucun outil externe.
//!   2. **Téléverser le `main.py`** sur une carte qui exécute déjà MicroPython,
//!      via le *raw REPL* sur le port série (CDC USB). C'est le protocole que
//!      `mpremote`/`ampy` utilisent : on interrompt le programme courant, on
//!      passe en mode brut, on écrit le fichier par morceaux, puis on redémarre.
//!
//! Volontairement sans WebSerial (indisponible sous WKWebView/WebKitGTK) : tout
//! passe par le backend natif, donc identique sur macOS / Linux / Windows.

use std::io::{self, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serialport::{SerialPort, SerialPortType, UsbPortInfo};

use espflash::connection::{Connection, ResetAfterOperation, ResetBeforeOperation};
use espflash::flasher::Flasher;
use espflash::target::ProgressCallbacks;
use tauri::Emitter;

/// VID Raspberry Pi (Pico / Pico W en CDC ou en BOOTSEL).
const RPI_VID: u16 = 0x2e8a;
/// Débit série. Le CDC USB du Pico l'ignore, mais il faut une valeur valide.
const BAUD: u32 = 115_200;
/// Taille des morceaux écrits par appel `f.write(...)` en raw REPL.
const CHUNK: usize = 256;

// ===== Énumération des ports série =====

#[derive(Serialize)]
struct PortInfo {
    port: String,
    label: String,
    likely_pico: bool,
}

/// Liste les ports série exploitables. Sur macOS on ne garde que les `cu.*`
/// (callout) et l'on écarte les `tty.*`. Marque les cartes Raspberry Pi.
#[tauri::command]
pub async fn domotique_serial_ports() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(list_ports)
        .await
        .map_err(|e| e.to_string())?
}

fn list_ports() -> Result<String, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let mut out: Vec<PortInfo> = Vec::new();
    for p in ports {
        // Sur macOS, /dev/tty.* est un doublon entrant de /dev/cu.* : on l'ignore.
        if cfg!(target_os = "macos") && p.port_name.contains("/tty.") {
            continue;
        }
        let (label, likely_pico) = match &p.port_type {
            serialport::SerialPortType::UsbPort(info) => {
                let pico = info.vid == RPI_VID;
                let prod = info.product.clone().unwrap_or_default();
                let suffix = if prod.is_empty() {
                    "USB".to_string()
                } else {
                    prod
                };
                (format!("{} — {}", p.port_name, suffix), pico)
            }
            _ => (p.port_name.clone(), false),
        };
        out.push(PortInfo {
            port: p.port_name.clone(),
            label,
            likely_pico,
        });
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

// ===== Téléversement du main.py (raw REPL) =====

/// Téléverse `code` en tant que `main.py` sur la carte branchée sur `port`,
/// puis la redémarre pour exécuter le nouveau programme.
///
/// Async + `spawn_blocking` : l'I/O série bloquant ne fige jamais l'UI.
#[tauri::command]
pub async fn domotique_pico_upload(port: String, code: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || upload_blocking(port, code))
        .await
        .map_err(|e| e.to_string())?
}

fn upload_blocking(port_name: String, code: String) -> Result<String, String> {
    let mut port = serialport::new(&port_name, BAUD)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| format!("Port « {port_name} » inaccessible : {e}"))?;

    enter_raw_repl(&mut *port)?;

    let bytes = code.as_bytes();
    exec_raw(&mut *port, "f=open('main.py','wb')")?;
    for chunk in bytes.chunks(CHUNK) {
        let cmd = format!("f.write({})", py_bytes_literal(chunk));
        exec_raw(&mut *port, &cmd)?;
    }
    exec_raw(&mut *port, "f.close()")?;

    // Sortie du mode brut (Ctrl-B) puis soft-reset (Ctrl-D) pour relancer main.py.
    let _ = port.write_all(b"\r\x02");
    std::thread::sleep(Duration::from_millis(120));
    let _ = port.write_all(b"\x04");

    Ok(format!(
        "main.py téléversé ({} octets) et carte redémarrée.",
        bytes.len()
    ))
}

/// Interrompt le programme courant et bascule en *raw REPL*.
fn enter_raw_repl(port: &mut dyn SerialPort) -> Result<(), String> {
    // \r puis deux Ctrl-C : stoppe toute boucle en cours.
    port.write_all(b"\r\x03\x03").map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(120));
    drain(port);
    // Ctrl-A : entre en mode brut. La carte répond par sa bannière + invite « > ».
    port.write_all(b"\r\x01").map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(3);
    read_until(port, b"raw REPL; CTRL-B to exit\r\n>", deadline).map_err(|e| {
        format!("Pas de réponse MicroPython sur ce port ({e}). La carte exécute-t-elle bien MicroPython ?")
    })?;
    Ok(())
}

/// Exécute une commande en raw REPL et échoue si la carte renvoie une exception.
///
/// Protocole : on envoie la commande puis Ctrl-D ; la carte répond
/// `OK<stdout>\x04<stderr>\x04>`. Un `<stderr>` non vide = traceback Python.
fn exec_raw(port: &mut dyn SerialPort, cmd: &str) -> Result<(), String> {
    port.write_all(cmd.as_bytes()).map_err(|e| e.to_string())?;
    port.write_all(b"\x04").map_err(|e| e.to_string())?;

    let deadline = Instant::now() + Duration::from_secs(4);
    let resp = read_until(port, b"\x04>", deadline)?;

    if !resp.starts_with(b"OK") {
        return Err(format!(
            "Réponse REPL inattendue : {}",
            String::from_utf8_lossy(&resp)
        ));
    }
    // Retire « OK » au début et « > » à la fin → reste « <stdout>\x04<stderr>\x04 ».
    let inner = &resp[2..resp.len() - 1];
    let parts: Vec<&[u8]> = inner.split(|&b| b == 0x04).collect();
    let stderr = parts.get(1).copied().unwrap_or(&[]);
    if !stderr.is_empty() {
        return Err(format!(
            "Erreur MicroPython : {}",
            String::from_utf8_lossy(stderr).trim()
        ));
    }
    Ok(())
}

/// Lit octet par octet jusqu'à rencontrer `needle` ou expiration de `deadline`.
fn read_until(
    port: &mut dyn SerialPort,
    needle: &[u8],
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while Instant::now() < deadline {
        match port.read(&mut byte) {
            Ok(0) => {}
            Ok(_) => {
                buf.push(byte[0]);
                if buf.ends_with(needle) {
                    return Ok(buf);
                }
            }
            Err(ref e) if e.kind() == io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(format!(
        "délai dépassé (reçu : {:?})",
        String::from_utf8_lossy(&buf)
    ))
}

/// Vide tout octet en attente (court délai), pour repartir d'un état propre.
fn drain(port: &mut dyn SerialPort) {
    let mut byte = [0u8; 1];
    let deadline = Instant::now() + Duration::from_millis(150);
    while Instant::now() < deadline {
        match port.read(&mut byte) {
            Ok(n) if n > 0 => {}
            _ => break,
        }
    }
}

/// Encode un morceau d'octets en littéral `bytes` Python (`b'...'`), sûr à
/// injecter dans `f.write(...)` quel que soit le contenu (accents, binaire).
fn py_bytes_literal(chunk: &[u8]) -> String {
    let mut s = String::with_capacity(chunk.len() * 4 + 3);
    s.push_str("b'");
    for &b in chunk {
        match b {
            b'\\' => s.push_str("\\\\"),
            b'\'' => s.push_str("\\'"),
            b'\n' => s.push_str("\\n"),
            b'\r' => s.push_str("\\r"),
            b'\t' => s.push_str("\\t"),
            0x20..=0x7e => s.push(b as char),
            _ => s.push_str(&format!("\\x{b:02x}")),
        }
    }
    s.push('\'');
    s
}

// ===== Installation de MicroPython (.uf2 en mode BOOTSEL) =====

/// Cherche un volume RP2 monté (Pico en BOOTSEL) : on le reconnaît au fichier
/// `INFO_UF2.TXT` présent à sa racine, indépendamment du nom du volume.
fn bootsel_mount() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if cfg!(target_os = "macos") {
        candidates.extend(list_dir("/Volumes"));
    } else if cfg!(target_os = "windows") {
        for c in b'A'..=b'Z' {
            candidates.push(PathBuf::from(format!("{}:\\", c as char)));
        }
    } else {
        // Linux : montages automatiques sous /media, /run/media/<user>, /mnt.
        for base in ["/media", "/run/media", "/mnt"] {
            for d in list_dir(base) {
                candidates.push(d.clone());
                candidates.extend(list_dir(&d.to_string_lossy())); // /run/media/<user>/<label>
            }
        }
    }

    candidates
        .into_iter()
        .find(|p| p.join("INFO_UF2.TXT").exists())
}

fn list_dir(path: &str) -> Vec<PathBuf> {
    std::fs::read_dir(path)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

/// Indique si une carte Pico est actuellement en mode BOOTSEL (prête pour le
/// `.uf2`). Renvoie le chemin du volume, ou `null`.
#[tauri::command]
pub async fn domotique_pico_bootsel() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(bootsel_mount().map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installe MicroPython : copie le `.uf2` (fourni en base64) sur le volume
/// BOOTSEL détecté. La carte redémarre seule une fois la programmation finie —
/// la disparition du volume en cours d'écriture est donc un succès, pas une
/// erreur.
#[tauri::command]
pub async fn domotique_pico_flash_uf2(uf2_b64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = STANDARD
            .decode(uf2_b64.trim())
            .map_err(|e| format!("UF2 illisible (base64) : {e}"))?;
        // Garde-fou : un UF2 commence par la signature « UF2\n » (0x0A324655 LE).
        if data.len() < 512 || &data[0..4] != b"UF2\n" {
            return Err("Ce fichier n'est pas un firmware .uf2 valide.".into());
        }

        let mount = bootsel_mount().ok_or(
            "Aucune carte en mode BOOTSEL détectée. Débranchez le Pico W, maintenez le bouton BOOTSEL, puis rebranchez-le.",
        )?;

        let dest = mount.join("firmware.uf2");
        match std::fs::write(&dest, &data) {
            Ok(()) => Ok(format!(
                "MicroPython installé ({} Ko). La carte redémarre.",
                data.len() / 1024
            )),
            Err(e) => {
                // Volume disparu = la carte a fini et redémarré : succès.
                if !mount.join("INFO_UF2.TXT").exists() {
                    Ok("MicroPython installé. La carte a redémarré.".into())
                } else {
                    Err(format!("Échec de la copie du .uf2 : {e}"))
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== Flash de firmware ESP32 / ESP32-CAM (.bin via espflash) =====

/// Rapporteur de progression : relaie l'avancée du flash au front via l'évènement
/// `esp-flash-progress` (pourcentage 0..100).
struct EspProgress {
    app: tauri::AppHandle,
    total: usize,
}
impl ProgressCallbacks for EspProgress {
    fn init(&mut self, _addr: u32, total: usize) {
        self.total = total;
        let _ = self.app.emit("esp-flash-progress", 0u32);
    }
    fn update(&mut self, current: usize) {
        let pct = if self.total > 0 {
            ((current.min(self.total) * 100) / self.total) as u32
        } else {
            0
        };
        let _ = self.app.emit("esp-flash-progress", pct);
    }
    fn verifying(&mut self) {
        let _ = self.app.emit("esp-flash-progress", 100u32);
    }
    fn finish(&mut self, _skipped: bool) {
        let _ = self.app.emit("esp-flash-progress", 100u32);
    }
}

/// Flashe un firmware ESP32 / ESP32-CAM (`.bin` fourni en base64) à l'offset
/// donné (défaut 0x1000, image MicroPython combinée d'origine ESP32). Pur Rust
/// (espflash, stub RAM) : remplace `esptool`, aucune dépendance Python.
///
/// `auto_reset` : `true` (défaut) toggle DTR/RTS pour entrer en bootloader (cartes
/// type DevKit) ; `false` pour les cartes SANS auto-reset (ESP32-CAM AI-Thinker)
/// où l'utilisateur a déjà mis la carte en mode download (GPIO0→GND + reset).
#[tauri::command]
pub async fn domotique_esp_flash(
    app: tauri::AppHandle,
    port: String,
    firmware_b64: String,
    offset: Option<u32>,
    auto_reset: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        esp_flash_blocking(app, port, firmware_b64, offset, auto_reset)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn esp_flash_blocking(
    app: tauri::AppHandle,
    port_name: String,
    firmware_b64: String,
    offset: Option<u32>,
    auto_reset: Option<bool>,
) -> Result<String, String> {
    let data = STANDARD
        .decode(firmware_b64.trim())
        .map_err(|e| format!("Firmware illisible (base64) : {e}"))?;
    if data.len() < 1024 {
        return Err("Fichier .bin trop petit pour être un firmware valide.".into());
    }
    let offset = offset.unwrap_or(0x1000);
    let auto = auto_reset.unwrap_or(true);

    // Infos USB du port (VID/PID) — utile à espflash ; valeurs neutres si absent.
    let info = serialport::available_ports()
        .ok()
        .and_then(|ports| {
            ports
                .into_iter()
                .find(|p| p.port_name == port_name)
                .and_then(|p| match p.port_type {
                    SerialPortType::UsbPort(i) => Some(i),
                    _ => None,
                })
        })
        .unwrap_or(UsbPortInfo {
            vid: 0,
            pid: 0,
            serial_number: None,
            manufacturer: None,
            product: None,
        });

    // Port natif (TTYPort/COMPort) attendu par espflash::Flasher::connect.
    let serial = serialport::new(&port_name, 115_200)
        .timeout(Duration::from_secs(3))
        .open_native()
        .map_err(|e| format!("Port « {port_name} » inaccessible : {e}"))?;

    let before = if auto {
        ResetBeforeOperation::DefaultReset
    } else {
        ResetBeforeOperation::NoReset
    };

    let connection = Connection::new(
        serial,
        info,
        ResetAfterOperation::HardReset,
        before,
        115_200,
    );

    let mut flasher = Flasher::connect(
        connection,
        true,          // use_stub : stub RAM = flash rapide
        false,         // verify
        false,         // skip
        None,          // chip : auto-détection (ESP32 / ESP32-CAM)
        Some(460_800), // débit relevé après connexion (stub) pour aller plus vite
    )
    .map_err(|e| {
        format!(
            "Connexion à l'ESP impossible : {e}. Mets la carte en mode bootloader \
             (ESP32-CAM : GPIO0→GND puis reset, et décoche « auto-reset »)."
        )
    })?;

    let mut prog = EspProgress {
        app: app.clone(),
        total: data.len(),
    };
    flasher
        .write_bin_to_flash(offset, &data, &mut prog)
        .map_err(|e| format!("Échec du flash : {e}"))?;

    Ok(format!(
        "Firmware ESP32 écrit ({} Ko) à 0x{offset:x}. La carte redémarre.",
        data.len() / 1024
    ))
}
