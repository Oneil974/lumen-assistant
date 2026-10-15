//! Apple Foundation Models (macOS 27) comme backend d'inférence.
//!
//! Le framework FoundationModels n'a pas d'API réseau : Lumen embarque une
//! passerelle Swift (`src-tauri/applefm/main.swift`, compilée par
//! `scripts/build-applefm.sh` dans `resources/applefm/<cible>/lumen-applefm`)
//! qui l'expose en API OpenAI sur la boucle locale, port 11437. Ce module la
//! lance à la demande et la surveille ; tout le reste de Lumen la voit comme
//! une API cloud ordinaire, via la résolution de `backend = "applefm"` dans
//! `agents::resolve_virtual_backends` (même mécanique que Lumen Server).
//!
//! Deux modèles : `apple-on-device` (Apple Intelligence local) et
//! `apple-private-cloud` (Private Cloud Compute, réservé aux builds porteurs de
//! l'entitlement `com.apple.developer.private-cloud-compute`). La passerelle
//! n'annonce que ceux qui peuvent réellement répondre.

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// Port de la passerelle. Ne chevauche ni Ollama (11434) ni les deux
/// llama-server (11435 chat, 11436 embeddings).
pub const PORT: u16 = 11437;

/// Modèle proposé par défaut quand l'utilisateur choisit la source.
pub const DEFAULT_MODEL: &str = "apple-on-device";

/// Valeur non vide posée dans `api_key` à la résolution : `is_api()` exige une
/// clé, et la passerelle ignore l'en-tête Authorization. Rien de secret.
pub const PLACEHOLDER_KEY: &str = "apple-foundation-models";

pub fn base_url() -> String {
    format!("http://127.0.0.1:{PORT}/v1")
}

#[derive(Default)]
pub struct AppleFmState {
    child: Mutex<Option<Child>>,
    /// Dernière sonde `--probe`, pour ne pas relancer un processus à chaque
    /// rafraîchissement des Réglages. L'état d'Apple Intelligence bouge peu.
    probe: Mutex<Option<(Instant, AppleFmProbe)>>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct AppleFmModel {
    pub id: String,
    pub available: bool,
    pub reason: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Fenêtre de contexte (jetons) annoncée par le framework — elle dépend du
    /// Mac (4 096 ici, 8 192 sur d'autres) ; 0 si inconnue.
    #[serde(default)]
    pub context_size: u64,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct AppleFmProbe {
    /// Vrai si la passerelle est embarquée ET qu'au moins un modèle répond.
    pub available: bool,
    /// Passerelle compilée et trouvée sur cette machine.
    pub bundled: bool,
    /// Explication quand `available` est faux : `not_bundled`,
    /// `unsupported_platform`, ou la raison renvoyée par le framework
    /// (`apple_intelligence_not_enabled`, `device_not_eligible`, `model_not_ready`).
    pub reason: Option<String>,
    pub models: Vec<AppleFmModel>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AppleFmStatus {
    pub running: bool,
    pub url: String,
    #[serde(flatten)]
    pub probe: AppleFmProbe,
}

fn platform_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        _ => None,
    }
}

/// Exécutable de la passerelle. Mêmes candidats que `llama::binary_roots` :
/// Tauri garde le préfixe `resources/` dans certains bundles et l'aplatit
/// dans d'autres ; les chemins du workspace ne servent qu'en développement.
fn binary_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let target = platform_target()?;
    let mut roots = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        roots.push(resource.join("resources").join("applefm").join(target));
        roots.push(resource.join("applefm").join(target));
    }
    if cfg!(debug_assertions) {
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("applefm").join(target));
        if let Ok(cwd) = std::env::current_dir() {
            roots.push(cwd.join("src-tauri/resources/applefm").join(target));
        }
    }
    roots.into_iter().map(|r| r.join("lumen-applefm")).find(|p| p.is_file())
}

/// Sonde la disponibilité sans ouvrir de port (`lumen-applefm --probe`).
fn run_probe(app: &tauri::AppHandle) -> AppleFmProbe {
    if platform_target().is_none() {
        return AppleFmProbe { reason: Some("unsupported_platform".into()), ..Default::default() };
    }
    let Some(bin) = binary_path(app) else {
        return AppleFmProbe { reason: Some("not_bundled".into()), ..Default::default() };
    };
    let output = Command::new(&bin).arg("--probe").stdin(Stdio::null()).stderr(Stdio::null()).output();
    let Ok(output) = output else {
        return AppleFmProbe { bundled: true, reason: Some("probe_failed".into()), ..Default::default() };
    };
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    let models: Vec<AppleFmModel> = parsed
        .get("models")
        .and_then(|m| m.as_array())
        .map(|list| {
            list.iter()
                .map(|m| AppleFmModel {
                    id: m.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    available: m.get("available").and_then(|v| v.as_bool()).unwrap_or(false),
                    reason: m.get("reason").and_then(|v| v.as_str()).map(String::from),
                    capabilities: m
                        .get("capabilities")
                        .and_then(|v| v.as_array())
                        .map(|c| c.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                        .unwrap_or_default(),
                    context_size: m.get("context_size").and_then(|v| v.as_u64()).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    let available = models.iter().any(|m| m.available);
    // Raison du modèle local : c'est elle qui explique le mieux à l'utilisateur
    // quoi faire (activer Apple Intelligence, attendre le téléchargement…).
    let reason = if available {
        None
    } else {
        models
            .iter()
            .find(|m| m.id == DEFAULT_MODEL)
            .and_then(|m| m.reason.clone())
            .or_else(|| Some("unavailable".into()))
    };
    AppleFmProbe { available, bundled: true, reason, models }
}

/// Sonde avec cache (60 s). `force` relance la sonde, par exemple après un
/// passage dans Réglages Système → Apple Intelligence.
pub fn probe(app: &tauri::AppHandle, force: bool) -> AppleFmProbe {
    let state = app.state::<AppleFmState>();
    if !force {
        if let Ok(guard) = state.probe.lock() {
            if let Some((at, cached)) = guard.as_ref() {
                if at.elapsed() < Duration::from_secs(60) {
                    return cached.clone();
                }
            }
        }
    }
    let fresh = run_probe(app);
    if let Ok(mut guard) = state.probe.lock() {
        *guard = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

fn is_running(state: &AppleFmState) -> bool {
    let Ok(mut guard) = state.child.lock() else { return false };
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                false
            }
        },
        None => false,
    }
}

/// Vrai si quelqu'un répond déjà sur le port — une passerelle laissée par une
/// instance précédente de Lumen, ou lancée à la main.
fn port_answers() -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], PORT)),
        Duration::from_millis(150),
    )
    .is_ok()
}

/// Démarre la passerelle si elle ne tourne pas. Synchrone et rapide : on ne
/// fait que lancer le processus ; le premier appel attend l'écoute (cf.
/// `wait_ready`). Appelée depuis la résolution de config, donc à chaque
/// lecture — d'où la vérification bon marché avant tout.
pub fn ensure_running(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppleFmState>();
    if is_running(&state) || port_answers() {
        return Ok(());
    }
    let bin = binary_path(app).ok_or_else(|| {
        "La passerelle Apple Foundation Models n'est pas embarquée dans cette version de Lumen (scripts/build-applefm.sh).".to_string()
    })?;
    let child = Command::new(&bin)
        .arg("--port")
        .arg(PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Démarrage de lumen-applefm impossible : {e}"))?;
    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }
    Ok(())
}

/// Attend que le port réponde (démarrage < 1 s en pratique).
fn wait_ready(timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if port_answers() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    port_answers()
}

#[tauri::command]
pub async fn applefm_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppleFmState>,
    force: Option<bool>,
) -> Result<AppleFmStatus, String> {
    let app2 = app.clone();
    let force = force.unwrap_or(false);
    let probe = tauri::async_runtime::spawn_blocking(move || probe(&app2, force))
        .await
        .map_err(|e| e.to_string())?;
    Ok(AppleFmStatus { running: is_running(&state) || port_answers(), url: base_url(), probe })
}

#[tauri::command]
pub async fn applefm_start(app: tauri::AppHandle, state: tauri::State<'_, AppleFmState>) -> Result<AppleFmStatus, String> {
    ensure_running(&app)?;
    let ready = tauri::async_runtime::spawn_blocking(|| wait_ready(Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?;
    if !ready {
        return Err("La passerelle Apple Foundation Models ne répond pas sur le port 11437.".into());
    }
    applefm_status(app, state, None).await
}

#[tauri::command]
pub async fn applefm_stop(state: tauri::State<'_, AppleFmState>) -> Result<(), String> {
    shutdown(&state);
    Ok(())
}

/// Tue la passerelle à la fermeture de Lumen. Elle se termine aussi d'elle-même
/// quand son parent disparaît, mais autant ne pas attendre ce cycle.
pub fn shutdown(state: &AppleFmState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Modèles annoncés par la passerelle (`GET /v1/models`), démarrée au besoin.
/// Forme de `llama::llama_list_models` : une liste d'identifiants prêts pour
/// le champ `model` d'une requête.
pub async fn list_models(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    ensure_running(&app)?;
    let ready = tauri::async_runtime::spawn_blocking(|| wait_ready(Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?;
    if !ready {
        return Err("La passerelle Apple Foundation Models ne répond pas.".into());
    }
    let value: serde_json::Value = reqwest::Client::new()
        .get(format!("{}/models", base_url()))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Passerelle Apple Foundation Models : {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(value
        .get("data")
        .and_then(|d| d.as_array())
        .map(|list| list.iter().filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from)).collect())
        .unwrap_or_default())
}
