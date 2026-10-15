// Pont TCP vers l'avatar Lumen physique (ESP32 + écran rond GC9A01).
//
// Le webview ne peut pas ouvrir de socket brut : ce module fait le pont.
//   - `orb_connect(host, port)` : ouvre la connexion vers l'orbe (serveur TCP),
//     lit les COMMANDES entrantes (lignes JSON, ex. {"cmd":"dictation"} sur
//     appui long) et les ré-émet au frontend via l'event "orb-command".
//   - `orb_send(line)` : envoie une ligne JSON d'ÉTAT à l'orbe (thème / mode /
//     niveau audio), poussée par le frontend (voir src/orb-bridge.js).
//   - `orb_disconnect()` : ferme la connexion.
//
// Protocole côté firmware : voir esp32-orb/netstate.py.

use base64::Engine as _;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

// Expéditeurs vers les tâches d'écriture, un par APPAREIL.
//
// L'orbe ESP32 et le Lumen Controller parlent le même protocole sur le même
// port, mais ce sont deux machines distinctes : une seule connexion globale
// obligeait à choisir entre les deux. La clé est un identifiant libre
// (« orb », « controller »), transmis par le frontend.
static TX: Mutex<Option<Vec<(String, mpsc::UnboundedSender<Vec<u8>>)>>> = Mutex::new(None);

const DEFAULT_DEVICE: &str = "orb";

fn device_name(device: Option<String>) -> String {
    device
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| DEFAULT_DEVICE.to_string())
}

/// Enregistre l'expéditeur d'un appareil, en remplaçant le précédent.
fn set_sender(device: &str, tx: Option<mpsc::UnboundedSender<Vec<u8>>>) {
    let mut guard = TX.lock().unwrap();
    let list = guard.get_or_insert_with(Vec::new);
    list.retain(|(name, _)| name != device);
    if let Some(tx) = tx {
        list.push((device.to_string(), tx));
    }
}

// Génération de connexion, par appareil.
//
// `set_sender(device, None)` ne coupait que l'écriture : la tâche de LECTURE de
// l'ancienne connexion, elle, restait bloquée sur `read_line` et continuait à
// vivre. Chaque reconnexion (bouton « Connecter les appareils », reconnexion
// automatique) empilait donc un lecteur de plus, et une même ligne du
// contrôleur était traitée autant de fois qu'il y avait de lecteurs vivants —
// d'où les workflows RFID lancés en double.
//
// Chaque connexion reçoit un numéro ; un lecteur qui n'est plus le courant
// s'arrête au lieu de réémettre.
static GENERATION: Mutex<Option<Vec<(String, u64)>>> = Mutex::new(None);

fn next_generation(device: &str) -> u64 {
    let mut guard = GENERATION.lock().unwrap();
    let list = guard.get_or_insert_with(Vec::new);
    match list.iter_mut().find(|(name, _)| name == device) {
        Some((_, gen)) => {
            *gen += 1;
            *gen
        }
        None => {
            list.push((device.to_string(), 1));
            1
        }
    }
}

fn current_generation(device: &str) -> u64 {
    GENERATION
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|list| list.iter().find(|(name, _)| name == device))
        .map(|(_, gen)| *gen)
        .unwrap_or(0)
}

fn sender(device: &str) -> Option<mpsc::UnboundedSender<Vec<u8>>> {
    TX.lock()
        .unwrap()
        .as_ref()
        .and_then(|list| list.iter().find(|(name, _)| name == device))
        .map(|(_, tx)| tx.clone())
}

// Fichiers firmware poussés en OTA. config.py est EXCLU : il contient le Wi-Fi
// et les réglages propres à la carte, on ne l'écrase pas.
// Les modules IMPORTÉS par orb.py passent AVANT lui : une OTA interrompue ne
// laisse jamais un orb.py qui importe un fichier absent (écran noir au boot).
// Tout nouveau .py du firmware DOIT être ajouté ici.
const OTA_FILES: &[&str] = &[
    "i18n.py",
    "wifi.py",
    "agents.py",
    "orb.py",
    "main.py",
    "netstate.py",
    "sensors.py",
    "ota.py",
    "themes.py",
    "leds.py",
    "tft_config.py",
    "backlight.py",
    "cst816.py",
    "qmi8658.py",
    // M5Stack Fire (m5fire-orb/) : audio, IMU « charm », boutons, écran.
    "audio.py",
    "imu.py",
    "buttons.py",
    "display.py",
    "prefs.py",
    "pages.py",
    "mic_native.py",
];

#[tauri::command]
pub async fn orb_connect(
    app: AppHandle,
    host: String,
    port: u16,
    device: Option<String>,
) -> Result<(), String> {
    let device = device_name(device);
    // Coupe une éventuelle connexion précédente VERS CET APPAREIL uniquement :
    // son expéditeur ET sa tâche de lecture (via la génération).
    set_sender(&device, None);
    let generation = next_generation(&device);

    let stream = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| {
            // EHOSTUNREACH (65) alors que l'appareil répond au ping : c'est le
            // blocage « Réseau local » de macOS, pas l'adresse.
            if e.raw_os_error() == Some(65) && cfg!(target_os = "macos") {
                format!("connexion {device}: accès au réseau local refusé par macOS — Réglages Système › Confidentialité et sécurité › Réseau local › active Lumen")
            } else {
                format!("connexion {device}: {e}")
            }
        })?;
    let (read_half, mut write_half) = stream.into_split();

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    set_sender(&device, Some(tx));

    // Tâche d'écriture : draine le canal -> socket.
    tauri::async_runtime::spawn(async move {
        while let Some(data) = rx.recv().await {
            if write_half.write_all(&data).await.is_err() {
                break;
            }
        }
    });

    // Tâche de lecture : lignes JSON -> event "orb-command".
    let app2 = app.clone();
    let source = device.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(read_half);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    // Une connexion plus récente a pris la main : ce lecteur est
                    // un survivant d'une connexion remplacée, il doit se taire
                    // (sans quoi chaque ligne serait traitée en double).
                    if current_generation(&source) != generation {
                        break;
                    }
                    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&line) {
                        // Le frontend doit pouvoir distinguer l'émetteur : les
                        // deux appareils parlent le même protocole.
                        if let Some(obj) = v.as_object_mut() {
                            obj.insert(
                                "device".into(),
                                serde_json::Value::String(source.clone()),
                            );
                        }
                        if let Some(size) = v
                            .get("mic_binary")
                            .and_then(|m| m.get("size"))
                            .and_then(|n| n.as_u64())
                        {
                            if size == 0 || size > 2_000_000 {
                                continue;
                            }
                            let mut audio = vec![0u8; size as usize];
                            if reader.read_exact(&mut audio).await.is_err() {
                                break;
                            }
                            let _ = app2.emit("orb-mic-audio", audio);
                            continue;
                        }
                        if v.get("cmd").and_then(|x| x.as_str()) == Some("open_app") {
                            let result = v
                                .get("app")
                                .and_then(|x| x.as_str())
                                .ok_or_else(|| "identifiant app manquant".to_string())
                                .and_then(|id| crate::open_orb_app(app2.clone(), id));
                            let payload = match result {
                                Ok(()) => serde_json::json!({"ok": true, "app": v.get("app")}),
                                Err(error) => serde_json::json!({"ok": false, "error": error}),
                            };
                            let _ = app2.emit("orb-app-result", payload);
                            continue;
                        }
                        // Badges RFID du Lumen Controller. Le firmware ne
                        // signale que les TRANSITIONS (pose / retrait), il n'y
                        // a donc pas de répétition à filtrer ici.
                        match v.get("cmd").and_then(|x| x.as_str()) {
                            Some("rfid") => {
                                if let Some(uid) = v.get("uid").and_then(|x| x.as_str()) {
                                    // record_badge écarte les badges d'ouverture
                                    // de session : ceux-là ne déclenchent rien.
                                    if let Some(uid) = crate::rfid_store::record_badge(&app2, uid) {
                                        crate::dispatch_rfid_triggers(&app2, uid);
                                    }
                                }
                            }
                            Some("rfid_removed") => crate::rfid_store::record_badge_removed(),
                            _ => {}
                        }
                        let _ = app2.emit("orb-command", v);
                    }
                }
            }
        }
        // Ne pas débrancher l'appareil si une connexion plus récente a pris la
        // relève : ce lecteur-ci est simplement périmé.
        if current_generation(&source) == generation {
            set_sender(&source, None);
            let _ = app2.emit("orb-disconnected", serde_json::json!({"device": source}));
        }
    });

    // Toutes les fenêtres apprennent la connexion, quelle que soit celle qui
    // l'a ouverte : sinon, relié depuis Réglages, l'orbe restait « non
    // connecté » pour la fenêtre principale, qui ne lui envoyait plus rien.
    let _ = app.emit("orb-connected", serde_json::json!({"device": device, "host": host}));
    Ok(())
}

#[tauri::command]
pub fn orb_send(line: String, device: Option<String>) -> Result<(), String> {
    let device = device_name(device);
    match sender(&device) {
        Some(tx) => {
            let mut data = line.into_bytes();
            if !data.ends_with(b"\n") {
                data.push(b'\n');
            }
            tx.send(data).map_err(|e| e.to_string())
        }
        None => Err(format!("{device} non connecté")),
    }
}

/// Envoie un WAV local au M5 par morceaux JSON base64.
#[tauri::command]
pub async fn orb_send_wav(path: String, device: Option<String>) -> Result<(), String> {
    let device = device_name(device);
    let data = std::fs::read(&path).map_err(|e| format!("lecture WAV: {e}"))?;
    let mut header = serde_json::json!({"audio_binary": {"size": data.len()}})
        .to_string()
        .into_bytes();
    header.push(b'\n');
    // En-tête et charge utile partent en UN SEUL message de canal. En deux
    // envois, un heartbeat ou un niveau audio poussé par le frontend pouvait
    // s'intercaler entre les deux : le pair lisait alors une ligne JSON là où
    // il attendait le début du binaire, et le flux se désynchronisait.
    header.extend_from_slice(&data);
    match sender(&device) {
        Some(tx) => tx.send(header).map_err(|e| e.to_string()),
        None => Err(format!("{device} non connecté")),
    }
}

/// Sprite d'agent (RGB565 brut, base64 côté front) pour la page « Agents » de
/// la M5 Fire : en-tête `{"sprite_binary": {..meta, size}}` puis les octets,
/// en UN SEUL message de canal (même raison que `orb_send_wav`).
#[tauri::command]
pub async fn orb_send_sprite(meta: serde_json::Value, b64: String, device: Option<String>) -> Result<(), String> {
    use base64::Engine;
    let device = device_name(device);
    let data = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("sprite base64: {e}"))?;
    if data.len() > 64 * 1024 {
        return Err("sprite trop gros".into());
    }
    let mut meta = if meta.is_object() { meta } else { serde_json::json!({}) };
    meta["size"] = serde_json::json!(data.len());
    let mut out = serde_json::json!({ "sprite_binary": meta }).to_string().into_bytes();
    out.push(b'\n');
    out.extend_from_slice(&data);
    match sender(&device) {
        Some(tx) => tx.send(out).map_err(|e| e.to_string()),
        None => Err(format!("{device} non connecté")),
    }
}

#[tauri::command]
pub fn orb_disconnect(device: Option<String>) {
    set_sender(&device_name(device), None);
}

/// OTA : pousse les scripts .py de l'orbe (depuis `dir`) par morceaux base64,
/// puis demande un reset. `config.py` est préservé. Émet `orb-ota-progress` et
/// `orb-ota-done`. Renvoie le nombre de fichiers envoyés.
#[tauri::command]
pub async fn orb_ota(
    app: AppHandle,
    dir: String,
    device: Option<String>,
    kind: Option<String>,
) -> Result<u32, String> {
    // Deux firmwares partagent les mêmes noms de fichiers (orb.py, main.py) :
    // pousser esp32-orb/ sur la M5 Fire (ou l'inverse) la rend inutilisable.
    // On reconnaît le dossier par ses fichiers propres et on refuse s'il ne
    // correspond pas à l'appareil annoncé.
    {
        let base = std::path::Path::new(&dir);
        let is_m5 = base.join("buttons.py").exists() && base.join("display.py").exists();
        let is_round = base.join("tft_config.py").exists() || base.join("cst816.py").exists();
        match kind.as_deref() {
            Some("m5fire") if !is_m5 => {
                return Err("ce dossier n'est pas le firmware M5Stack Fire (choisis m5fire-orb)".into())
            }
            Some("round") if !is_round => {
                return Err("ce dossier n'est pas le firmware de l'orbe ronde (choisis esp32-orb)".into())
            }
            _ => {}
        }
        if !is_m5 && !is_round {
            return Err("dossier firmware non reconnu (m5fire-orb ou esp32-orb attendu)".into());
        }
    }
    // L'OTA ne concerne que l'orbe ESP32 : ses fichiers sont ceux de
    // esp32-orb/, le Lumen Controller se met à jour par mpremote.
    let device = device_name(device);
    if sender(&device).is_none() {
        return Err(format!("{device} non connecté"));
    }
    let base = Path::new(&dir);
    if !base.is_dir() {
        return Err(format!("dossier introuvable : {dir}"));
    }

    let chunk = 1200usize; // caractères base64 par message
    // Tout est lu d'abord : l'orbe reçoit le nombre TOTAL de morceaux et peut
    // afficher une vraie barre de progression (et suspendre le reste).
    let mut payloads: Vec<(&str, String)> = Vec::new();
    for name in OTA_FILES {
        if let Ok(d) = std::fs::read(base.join(name)) {
            payloads.push((name, base64::engine::general_purpose::STANDARD.encode(&d)));
        }
    }
    let grand_total: usize = payloads.iter().map(|(_, b)| ((b.len() + chunk - 1) / chunk).max(1)).sum();
    orb_send(
        serde_json::json!({"ota_begin": {"total": grand_total, "files": payloads.len()}}).to_string(),
        Some(device.clone()),
    )?;
    // Laisse l'orbe basculer en mode mise à jour avant le premier morceau.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let mut done = 0usize;
    let mut files = 0u32;
    for (name, b64) in &payloads {
        let name = *name;
        let total = ((b64.len() + chunk - 1) / chunk).max(1);
        let mut seq = 0usize;
        let mut start = 0usize;
        loop {
            let end = (start + chunk).min(b64.len());
            let is_final = end >= b64.len();
            let msg = serde_json::json!({
                "ota": {"name": name, "seq": seq, "b64": &b64[start..end], "final": is_final,
                        "done": done + 1, "total": grand_total}
            });
            done += 1;
            orb_send(msg.to_string(), Some(device.clone()))?;
            let _ = app.emit(
                "orb-ota-progress",
                serde_json::json!({"file": name, "chunk": seq + 1, "of": total}),
            );
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            if is_final {
                break;
            }
            seq += 1;
            start = end;
        }
        files += 1;
    }
    orb_send(serde_json::json!({"cmd": "reset"}).to_string(), Some(device))?;
    let _ = app.emit("orb-ota-done", serde_json::json!({"files": files}));
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une reconnexion périme le lecteur précédent : lui seul voit sa génération
    /// dépassée, l'autre appareil n'est pas affecté.
    #[test]
    fn generation_invalidates_previous_reader() {
        let first = next_generation("test-controller");
        assert_eq!(current_generation("test-controller"), first);

        let second = next_generation("test-controller");
        assert!(second > first, "la génération doit avancer");
        // L'ancien lecteur se sait périmé, le nouveau reste actif.
        assert_ne!(current_generation("test-controller"), first);
        assert_eq!(current_generation("test-controller"), second);

        // Compteurs indépendants d'un appareil à l'autre.
        let other = next_generation("test-orb");
        assert_eq!(current_generation("test-orb"), other);
        assert_eq!(current_generation("test-controller"), second);
    }
}
