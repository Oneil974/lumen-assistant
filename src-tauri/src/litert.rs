//! Runtime LiteRT-LM (Google AI Edge), embarqué dans le build Raspberry Pi.
//!
//! LiteRT-LM ne se distribue pas en binaire autonome : c'est un CLI Python posé
//! sur une roue native. `scripts/build-litert-runtime.sh` en fabrique un venv
//! complet, copié dans `resources/litert/<cible>/venv` à la construction du
//! bundle. Ce module se contente de piloter ce venv.
//!
//! Le CLI expose un serveur HTTP compatible OpenAI (`litert-lm serve`). Lumen
//! s'y branche exactement comme sur llama-server : même contrat de commandes
//! (`*_status`, `*_start`, `*_stop`, `*_post_json`), pour que le routeur LLM du
//! front n'ait pas à connaître deux façons de parler à un serveur local.
//!
//! Ce qui diffère de llama.cpp, et explique la forme du code plus bas :
//! - un modèle doit être **importé** dans un registre interne au CLI avant que
//!   `serve` puisse l'exposer — le télécharger ne suffit pas ;
//! - le serveur ne prend pas de modèle au lancement : chaque requête nomme le
//!   sien, donc un seul processus couvre toute la session.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

/// Port par défaut de `litert-lm serve`. Conservé tel quel : il ne chevauche ni
/// llama-server (11435/11436) ni Ollama (11434).
pub const PORT: u16 = 9379;

/// Extension des modèles LiteRT-LM. Rien d'autre n'est accepté à l'écriture.
const MODEL_EXT: &str = "litertlm";

#[derive(Default)]
pub struct LitertState {
    child: Mutex<Option<Child>>,
    /// Drapeaux d'annulation des téléchargements en cours, par id de catalogue.
    downloads: Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
    /// Identifiants déjà importés dans le registre du CLI pendant cette session.
    /// `litert-lm import` est idempotent mais lent (il recopie le fichier) :
    /// sans ce cache, chaque message paierait la vérification.
    imported: Mutex<std::collections::HashSet<String>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct LitertRuntime {
    /// Vrai si le venv est présent ET démarrable sur cette machine.
    pub available: bool,
    /// Version de `litert-lm` empaquetée, lue dans le fichier VERSION.
    pub version: Option<String>,
    /// Dossier où Lumen dépose les `.litertlm` téléchargés.
    pub models_dir: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LitertModel {
    pub filename: String,
    /// Identifiant utilisé dans le registre du CLI et dans le champ `model` des
    /// requêtes OpenAI : le nom de fichier sans son extension.
    pub id: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct LitertStatus {
    pub running: bool,
    pub url: String,
    pub models_dir: String,
}

#[derive(Debug, Deserialize)]
pub struct LitertDownloadRequest {
    pub id: String,
    pub url: String,
    pub filename: String,
}

/// Nom de dossier de plateforme sous `resources/litert/`.
///
/// Volontairement limité à Linux : le venv embarque des roues natives
/// construites sur la machine de build, et le seul build qui les fabrique est
/// celui du Raspberry Pi. Ailleurs, `runtime_root` renvoie None et toute l'UI
/// LiteRT disparaît d'elle-même.
fn platform_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        _ => None,
    }
}

/// Racine du runtime embarqué. Mêmes candidats que `llama::binary_roots` : Tauri
/// conserve le préfixe `resources/` dans certains bundles et l'aplatit dans
/// d'autres.
fn runtime_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let target = platform_target()?;
    let mut roots = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        roots.push(resource.join("resources").join("litert").join(target));
        roots.push(resource.join("litert").join(target));
    }
    if cfg!(debug_assertions) {
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("litert").join(target));
        if let Ok(cwd) = std::env::current_dir() {
            roots.push(cwd.join("src-tauri/resources/litert").join(target));
        }
    }
    roots.into_iter().find(|root| root.join("venv/bin/python").is_file())
}

/// Commande prête à lancer : `venv/bin/python venv/bin/litert-lm <args…>`.
///
/// On passe par l'interpréteur plutôt que par le console script parce qu'un venv
/// grave son chemin absolu de construction dans le shebang de chaque script.
/// Après empaquetage ce chemin n'existe plus, et l'exécution directe échouerait
/// en « bad interpreter » — une erreur qui ne dit rien de la vraie cause.
fn cli(app: &tauri::AppHandle) -> Result<Command, String> {
    let root = runtime_root(app).ok_or("Le runtime LiteRT-LM n'est pas embarqué dans cette version de Lumen")?;
    let python = root.join("venv/bin/python");
    let script = root.join("venv/bin/litert-lm");
    if !script.is_file() {
        return Err("Runtime LiteRT-LM incomplet : le CLI est absent du venv".into());
    }
    let mut command = Command::new(python);
    command.arg(script);
    // Le CLI écrit son registre et sa config sous $HOME. Laisser l'environnement
    // tel quel est volontaire : l'utilisateur doit pouvoir inspecter et purger
    // ~/.litert-lm avec les commandes documentées par Google.
    command.stdin(Stdio::null());
    Ok(command)
}

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("models")
        .join("litert");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Refuse tout ce qui n'est pas un simple nom de fichier `.litertlm` : le nom
/// vient du catalogue côté front, donc d'un fichier modifiable.
fn safe_filename(filename: &str) -> Result<&Path, String> {
    let trimmed = filename.trim();
    let path = Path::new(trimmed);
    if path.file_name().and_then(|v| v.to_str()) != Some(trimmed)
        || path.extension().and_then(|v| v.to_str()) != Some(MODEL_EXT)
    {
        return Err("Nom de modèle LiteRT-LM invalide".into());
    }
    Ok(path)
}

/// Identifiant de registre d'un modèle : son nom de fichier sans extension.
///
/// Déduit plutôt que stocké, pour qu'un fichier déposé à la main dans le dossier
/// des modèles se comporte comme un modèle téléchargé depuis Lumen.
fn model_id(filename: &str) -> String {
    filename.trim_end_matches(&format!(".{MODEL_EXT}")).to_string()
}

#[tauri::command]
pub fn litert_runtime(app: tauri::AppHandle) -> Result<LitertRuntime, String> {
    let root = runtime_root(&app);
    let version = root
        .as_ref()
        .and_then(|root| fs::read_to_string(root.join("VERSION")).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    Ok(LitertRuntime {
        available: root.is_some(),
        version,
        models_dir: models_dir(&app).map(|d| d.display().to_string()).unwrap_or_default(),
    })
}

#[tauri::command]
pub fn litert_list_models(app: tauri::AppHandle) -> Result<Vec<LitertModel>, String> {
    let dir = models_dir(&app)?;
    let mut models = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|v| v.to_str()) != Some(MODEL_EXT) {
            continue;
        }
        let filename = match path.file_name().and_then(|v| v.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        models.push(LitertModel {
            id: model_id(&filename),
            filename,
            path: path.display().to_string(),
            size: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
    models.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(models)
}

#[tauri::command]
pub async fn litert_download_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, LitertState>,
    request: LitertDownloadRequest,
) -> Result<LitertModel, String> {
    safe_filename(&request.filename)?;
    let dir = models_dir(&app)?;
    let final_path = dir.join(&request.filename);
    let part_path = dir.join(format!(".{}.part", request.filename));

    let cancel = Arc::new(AtomicBool::new(false));
    state.downloads.lock().await.insert(request.id.clone(), cancel.clone());
    let id_for_cleanup = request.id.clone();

    let app_for_download = app.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<LitertModel, String> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(None)
            .build()
            .map_err(|e| e.to_string())?;
        // Même fonction que les GGUF : reprise sur `.part`, annulation, et les
        // événements `llama-download-progress` que l'interface sait déjà rendre.
        crate::llama::download_file(
            &app_for_download,
            &client,
            &request.url,
            &part_path,
            &final_path,
            &request.id,
            &request.filename,
            &cancel,
        )?;
        let size = fs::metadata(&final_path).map_err(|e| e.to_string())?.len();
        let model = LitertModel {
            id: model_id(&request.filename),
            filename: request.filename,
            path: final_path.display().to_string(),
            size,
        };
        let _ = app_for_download.emit("llama-download-done", &model);
        Ok(model)
    })
    .await
    .map_err(|e| e.to_string())?;

    state.downloads.lock().await.remove(&id_for_cleanup);
    result
}

#[tauri::command]
pub async fn litert_cancel_download(state: tauri::State<'_, LitertState>, id: String) -> Result<bool, String> {
    Ok(match state.downloads.lock().await.get(&id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    })
}

#[tauri::command]
pub async fn litert_delete_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, LitertState>,
    filename: String,
) -> Result<(), String> {
    let name = safe_filename(&filename)?.to_owned();
    let id = model_id(&filename);
    // Retirer d'abord du registre : sinon `serve` continue d'annoncer un modèle
    // dont le fichier source a disparu, et la requête échoue à l'usage.
    let mut command = cli(&app)?;
    let _ = command.arg("delete").arg(&id).output();
    state.imported.lock().await.remove(&id);
    let path = models_dir(&app)?.join(&name);
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Importe le modèle dans le registre du CLI si ce n'est pas déjà fait.
///
/// `serve` n'expose que les modèles du registre : sans cette étape, un fichier
/// pourtant téléchargé remonte en « model not found » à la première requête.
async fn ensure_imported(app: &tauri::AppHandle, state: &LitertState, id: &str) -> Result<(), String> {
    if state.imported.lock().await.contains(id) {
        return Ok(());
    }
    let dir = models_dir(app)?;
    let path = dir.join(format!("{id}.{MODEL_EXT}"));
    if !path.is_file() {
        return Err(format!("Modèle LiteRT-LM introuvable : {id}"));
    }
    let mut command = cli(app)?;
    command.arg("import").arg(&path).arg(id);
    let output = tauri::async_runtime::spawn_blocking(move || command.output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Import LiteRT-LM impossible : {e}"))?;
    // Un identifiant déjà présent n'est pas une erreur pour nous : c'est l'état
    // recherché. On ne distingue donc pas les deux cas, on revérifie le registre.
    if !output.status.success() && !registry_contains(app, id).await {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            format!("Import LiteRT-LM refusé pour {id}")
        } else {
            format!("Import LiteRT-LM refusé pour {id} : {}", detail.chars().take(300).collect::<String>())
        });
    }
    state.imported.lock().await.insert(id.to_string());
    Ok(())
}

/// Vrai si `litert-lm list` mentionne cet identifiant.
///
/// Recherche par sous-chaîne, sans analyser le tableau : son format est un
/// détail d'affichage du CLI, pas un contrat. Un faux positif se solderait par
/// une erreur claire à la requête suivante ; un parseur cassé par une mise à
/// jour bloquerait tout.
async fn registry_contains(app: &tauri::AppHandle, id: &str) -> bool {
    let Ok(mut command) = cli(app) else { return false };
    command.arg("list");
    let Ok(Ok(output)) = tauri::async_runtime::spawn_blocking(move || command.output()).await else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).contains(id)
}

async fn running(state: &LitertState) -> bool {
    let mut guard = state.child.lock().await;
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                false
            }
            Ok(None) => true,
            Err(_) => false,
        }
    } else {
        false
    }
}

/// Démarre le serveur s'il ne tourne pas, et s'assure que le modèle demandé est
/// dans le registre. Un seul processus suffit pour toute la session : `serve` ne
/// se voit pas imposer de modèle, chaque requête nomme le sien.
pub(crate) async fn ensure_running(app: &tauri::AppHandle, state: &LitertState, model: &str) -> Result<(), String> {
    ensure_imported(app, state, model).await?;
    if running(state).await {
        return Ok(());
    }
    let mut command = cli(app)?;
    command
        .arg("serve")
        // 0.0.0.0 est le défaut du CLI : il exposerait le modèle à tout le
        // réseau local. Lumen ne s'en sert qu'en local.
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(PORT.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command.spawn().map_err(|e| format!("Démarrage de litert-lm impossible : {e}"))?;
    *state.child.lock().await = Some(child);
    Ok(())
}

#[tauri::command]
pub async fn litert_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, LitertState>,
    model: String,
) -> Result<LitertStatus, String> {
    ensure_running(&app, &state, &model).await?;
    litert_status(app.clone(), state).await
}

#[tauri::command]
pub async fn litert_stop(state: tauri::State<'_, LitertState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().await.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub async fn litert_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, LitertState>,
) -> Result<LitertStatus, String> {
    Ok(LitertStatus {
        running: running(&state).await,
        url: format!("http://127.0.0.1:{PORT}/v1"),
        models_dir: models_dir(&app)?.display().to_string(),
    })
}

/// Proxy des requêtes du front vers le serveur, sur le modèle de
/// `llama_post_json` : démarrage à la demande, et attente du serveur pendant sa
/// montée en charge plutôt qu'une erreur transitoire remontée à la conversation.
#[tauri::command]
pub async fn litert_post_json(
    app: tauri::AppHandle,
    state: tauri::State<'_, LitertState>,
    path: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if let Some(model) = payload.get("model").and_then(|m| m.as_str()) {
        // Ici, contrairement à llama.cpp, l'échec est remonté : un modèle absent
        // du registre produirait sinon un « model not found » du serveur, qui ne
        // dit pas que l'import est l'étape manquante.
        ensure_running(&app, &state, model).await?;
    }
    let path = path.trim_start_matches('/');
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let endpoint = format!("http://127.0.0.1:{PORT}/{path}");
    let mut last_error = "litert-lm indisponible".to_string();
    // Le chargement d'un modèle LiteRT prend plusieurs secondes sur un Pi ; le
    // serveur refuse les connexions tant qu'il n'écoute pas.
    for _ in 0..120 {
        match client.post(&endpoint).json(&payload).send().await {
            Ok(response) if response.status().is_success() => {
                return response.json().await.map_err(|e| e.to_string());
            }
            Ok(response) => {
                let status = response.status();
                let detail = response.text().await.unwrap_or_default();
                let detail = detail.trim();
                last_error = if detail.is_empty() {
                    format!("litert-lm HTTP {status}")
                } else {
                    format!("litert-lm HTTP {status}: {}", detail.chars().take(500).collect::<String>())
                };
                if status.as_u16() != 503 {
                    break;
                }
            }
            Err(error) => last_error = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(last_error)
}

#[tauri::command]
pub async fn litert_get_json(path: String) -> Result<serde_json::Value, String> {
    let path = path.trim_start_matches('/');
    reqwest::Client::new()
        .get(format!("http://127.0.0.1:{PORT}/{path}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("litert-lm indisponible : {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// Tue le serveur à la fermeture de Lumen. Sans ça, le processus Python survit à
/// l'application et garde le modèle en mémoire — 1,4 Go sur un Pi.
pub fn shutdown(state: &LitertState) {
    if let Ok(mut guard) = state.child.try_lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_id_drops_only_the_extension() {
        assert_eq!(model_id("gemma-4-E2B-it.litertlm"), "gemma-4-E2B-it");
        // Un point dans le nom ne doit pas être confondu avec l'extension.
        assert_eq!(model_id("gemma-4.1-E2B.litertlm"), "gemma-4.1-E2B");
    }

    #[test]
    fn safe_filename_rejects_paths_and_other_formats() {
        assert!(safe_filename("gemma.litertlm").is_ok());
        assert!(safe_filename("../gemma.litertlm").is_err());
        assert!(safe_filename("sub/gemma.litertlm").is_err());
        assert!(safe_filename("gemma.gguf").is_err());
    }
}
