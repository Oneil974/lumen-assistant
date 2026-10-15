//! Moteur d'image « Image Playground » (Apple Intelligence, macOS 27).
//!
//! Depuis macOS 27, l'API programmatique `ImageCreator` n'existe plus : la
//! génération passe par la feuille système, présentée par la passerelle
//! Swift `lumen-imageplayground` (src-tauri/imageplayground/main.swift,
//! compilée par `scripts/build-imageplayground.sh` dans
//! `resources/imageplayground/<cible>/`). Chaque génération lance la
//! passerelle avec le prompt : la feuille s'ouvre, l'utilisateur valide,
//! l'image revient en PNG. Ce moteur est donc INTERACTIF — les surfaces qui
//! l'appellent (Studio, Canvas, blocs Fluxo) reçoivent une erreur
//! `cancelled` si la feuille est refermée.
//!
//! Même squelette que `applefm.rs` : sonde cachée 60 s, option masquée dans
//! l'interface tant que `available` est faux.

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// Style par défaut : « any » (macOS 27) laisse Image Playground choisir,
/// photoréalisme compris.
pub const DEFAULT_STYLE: &str = "any";
const PROBE_TTL: Duration = Duration::from_secs(60);
/// Marqueur d'annulation reconnu par le front (`imageErrorMessage`).
pub const CANCELLED: &str = "playground-cancelled";

#[derive(Default)]
pub struct ImagePlaygroundState {
    probe: Mutex<Option<(Instant, Probe)>>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct Probe {
    pub available: bool,
    pub bundled: bool,
    pub reason: Option<String>,
    pub styles: Vec<String>,
    pub os: Option<String>,
}

fn platform_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        _ => None,
    }
}

/// Exécutable de la passerelle (mêmes candidats que `llama::binary_roots`).
fn binary_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let target = platform_target()?;
    let mut roots = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        roots.push(resource.join("resources").join("imageplayground").join(target));
        roots.push(resource.join("imageplayground").join(target));
    }
    if cfg!(debug_assertions) {
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("imageplayground").join(target));
        if let Ok(cwd) = std::env::current_dir() {
            roots.push(cwd.join("src-tauri/resources/imageplayground").join(target));
        }
    }
    roots.into_iter().map(|r| r.join("lumen-imageplayground")).find(|p| p.is_file())
}

fn run_probe(app: &tauri::AppHandle) -> Probe {
    if platform_target().is_none() {
        return Probe { reason: Some("unsupported_platform".into()), ..Default::default() };
    }
    let Some(bin) = binary_path(app) else {
        return Probe { reason: Some("not_bundled".into()), ..Default::default() };
    };
    let output = Command::new(&bin).arg("--probe").stdin(Stdio::null()).stderr(Stdio::null()).output();
    let Ok(output) = output else {
        return Probe { bundled: true, reason: Some("probe_failed".into()), ..Default::default() };
    };
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    let available = parsed.get("available").and_then(|v| v.as_bool()).unwrap_or(false);
    Probe {
        available,
        bundled: true,
        reason: if available {
            None
        } else {
            Some(
                parsed
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("image_playground_unavailable")
                    .to_string(),
            )
        },
        styles: parsed
            .get("styles")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        os: parsed.get("os").and_then(|v| v.as_str()).map(String::from),
    }
}

pub fn probe(app: &tauri::AppHandle, force: bool) -> Probe {
    let state = app.state::<ImagePlaygroundState>();
    if !force {
        if let Ok(cache) = state.probe.lock() {
            if let Some((at, probe)) = cache.as_ref() {
                if at.elapsed() < PROBE_TTL {
                    return probe.clone();
                }
            }
        }
    }
    let probe = run_probe(app);
    if let Ok(mut cache) = state.probe.lock() {
        *cache = Some((Instant::now(), probe.clone()));
    }
    probe
}

/// Disponibilité d'Image Playground sur cette machine (sonde cachée 60 s).
#[tauri::command]
pub async fn imageplayground_status(app: tauri::AppHandle, force: Option<bool>) -> Result<Probe, String> {
    let app2 = app.clone();
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || probe(&app2, force))
        .await
        .map_err(|e| e.to_string())
}

/// Ouvre la feuille Image Playground avec le prompt et renvoie le PNG validé
/// par l'utilisateur. `style` : any | illustration | animation | sketch.
pub async fn generate_bytes(
    app: &tauri::AppHandle,
    prompt: String,
    width: u32,
    height: u32,
    style: Option<String>,
    source: Option<PathBuf>,
) -> Result<Vec<u8>, String> {
    let bin = binary_path(app).ok_or_else(|| {
        "Image Playground n'est pas embarqué dans cette version de Lumen (macOS 27 requis).".to_string()
    })?;
    let data = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    let tmp = data.join("imageplayground");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = tmp.join(format!("playground-{stamp}.png"));
    let style = style
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_STYLE.to_string());
    let out2 = out.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut command = Command::new(&bin);
        command
            .arg("--prompt").arg(&prompt)
            .arg("--style").arg(&style)
            .arg("--width").arg(width.max(64).to_string())
            .arg("--height").arg(height.max(64).to_string())
            .arg("--out").arg(&out2)
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        if let Some(source) = source {
            command.arg("--source").arg(source).arg("--strategy").arg("edit");
        }
        // Pas de délai : la feuille attend l'utilisateur.
        let output = command.output().map_err(|e| format!("Image Playground n'a pas pu démarrer : {e}"))?;
        let text = String::from_utf8_lossy(&output.stdout);
        let last = text.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
        let parsed: serde_json::Value = serde_json::from_str(last).unwrap_or_default();
        if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            let path = parsed
                .get("path")
                .and_then(|v| v.as_str())
                .map(PathBuf::from)
                .unwrap_or_else(|| out2.clone());
            let bytes = std::fs::read(&path).map_err(|e| format!("Image Playground : fichier illisible ({e})"))?;
            let _ = std::fs::remove_file(&path);
            return Ok(bytes);
        }
        if parsed.get("cancelled").and_then(|v| v.as_bool()) == Some(true) {
            return Err(CANCELLED.into());
        }
        let error = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("Image Playground s'est arrêté ({})", output.status));
        Err(error)
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out);
    result
}
