use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

// ===== Moteur Bonsai embarqué =================================================
//
// Le moteur PrismML Bonsai Image (mflux + fork MLX sur Apple Silicon, gemlite +
// Triton sur GPU NVIDIA) est un empilement Python : il n'existe pas de binaire
// natif à la manière de llama-server. Lumen l'embarque donc sous la même
// convention que llama.cpp — un dossier PAR plateforme, produit par
// `scripts/build-bonsai-engine.sh` (ou .ps1) dans
// `src-tauri/resources/bonsai/<cible>/` :
//
//   python/                  CPython autonome (python-build-standalone) avec
//                            mflux, mlx (fork PrismML), prism-image-studio…
//   lumen_bonsai_server.py   serveur HTTP de Lumen (contrat /backends, /generate)
//   VERSION
//
// Seule la cible de l'OS de compilation est produite, comme pour llama-server :
// une build macOS n'embarque que macos-arm64. Les MODÈLES ne sont jamais dans
// le bundle : ils se téléchargent depuis Hugging Face (dépôts `prism-ml/…`)
// vers le dossier de données de Lumen, par le Catalogue ou les Réglages.

const DEFAULT_PORT: u16 = 8800;
const OFFICIAL_PORT: u16 = 8000;
const DOWNLOAD_CHUNK: usize = 1024 * 1024;
/// Marqueur d'annulation, aligné sur celui des GGUF (`llama::CANCELLED`) pour
/// que l'interface le reconnaisse de la même façon.
const CANCELLED: &str = "download-cancelled";

#[derive(Default)]
pub struct BonsaiState {
    child: Mutex<Option<Child>>,
    /// URL de base personnalisée pour l'API Bonsai (ex. backend distant).
    /// `None` => détection automatique du port local 127.0.0.1.
    custom_url: Mutex<Option<String>>,
    /// Téléchargements de modèles en cours : id → drapeau d'annulation.
    downloads: Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
    /// Variante servie par le processus enfant courant (« ternary »/« binary »).
    variant: Mutex<Option<String>>,
}

/// Exécution silencieuse sous Windows (pas de fenêtre console pour Python).
fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Normalise une URL saisie par l'utilisateur : trim, retrait du slash final,
/// et renvoie `None` si vide.
fn normalize_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Vérifie qu'une API Bonsai répond à l'URL de base donnée.
async fn url_alive(base: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(650))
        .build()
    else {
        return false;
    };
    client
        .get(format!("{base}/backends"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .is_ok()
}

// ---------------------------------------------------------------------------
//  Plateforme et moteur
// ---------------------------------------------------------------------------

/// Noyau de calcul du moteur sur cette machine : `mlx` (Apple Silicon) ou
/// `gemlite` (CUDA sous Linux/Windows). Les modèles Hugging Face sont
/// empaquetés par noyau — un modèle MLX ne sert à rien sur un PC NVIDIA.
pub fn platform_kind() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("mlx"),
        ("linux", "x86_64") | ("windows", "x86_64") => Some("gemlite"),
        _ => None,
    }
}

/// Nom du dossier de plateforme sous `resources/bonsai/` (mêmes libellés que
/// llama-server). Aucun pour macOS Intel : mflux exige Apple Silicon.
fn platform_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "x86_64") => Some("windows-x64"),
        _ => None,
    }
}

/// Dossier du moteur embarqué pour cette plateforme, s'il a été produit.
/// Mêmes candidats que `llama::binary_roots` : Tauri garde le préfixe
/// `resources/` dans certains bundles et l'aplatit dans d'autres ; les chemins
/// du workspace ne servent qu'en développement.
fn engine_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let target = platform_target()?;
    let mut roots = Vec::new();
    // Moteur TÉLÉCHARGÉ (Catalogue) : c'est le cas nominal, l'app ne l'embarque
    // pas. Les copies de resources/ ne servent qu'au développement.
    if let Some(dir) = downloaded_engine_dir(app) {
        roots.push(dir);
    }
    if let Ok(resource) = app.path().resource_dir() {
        roots.push(resource.join("resources").join("bonsai").join(target));
        roots.push(resource.join("bonsai").join(target));
    }
    if cfg!(debug_assertions) {
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("bonsai").join(target));
        if let Ok(cwd) = std::env::current_dir() {
            roots.push(cwd.join("src-tauri/resources/bonsai").join(target));
        }
    }
    roots.into_iter().find(|dir| engine_python(dir).is_file() && dir.join("lumen_bonsai_server.py").is_file())
}

/// Serveur HTTP de Lumen, embarqué dans le binaire. Le zip du moteur en
/// contient une copie datant de sa construction ; c'est celle de l'app qui
/// fait foi : un correctif du serveur (chargeur économe en RAM, détail des
/// erreurs 500…) suit ainsi une mise à jour de Lumen sans republier 3 Go.
const SERVER_SCRIPT: &str = include_str!("../bonsai/lumen_bonsai_server.py");

/// Aligne `lumen_bonsai_server.py` du moteur sur la version embarquée. Un
/// dossier en lecture seule (ressources signées) garde sa copie : on ne
/// bloque jamais le démarrage pour cela.
fn sync_server_script(engine: &Path) {
    let target = engine.join("lumen_bonsai_server.py");
    if fs::read_to_string(&target).map(|cur| cur == SERVER_SCRIPT).unwrap_or(false) {
        return;
    }
    if let Err(e) = fs::write(&target, SERVER_SCRIPT) {
        eprintln!("[bonsai] serveur non resynchronisé dans {} : {e}", target.display());
    }
}

/// Emplacement du moteur téléchargé : `<données>/bonsai/engine/<cible>`.
fn downloaded_engine_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let target = platform_target()?;
    Some(app_data(app).ok()?.join("bonsai").join("engine").join(target))
}

/// Interpréteur Python autonome du moteur.
fn engine_python(engine: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        engine.join("python").join("python.exe")
    } else {
        engine.join("python").join("bin").join("python3")
    }
}

fn engine_version(engine: &Path) -> Option<String> {
    fs::read_to_string(engine.join("VERSION")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Dossier des modèles Bonsai : `<données>/bonsai/models`. L'ancienne
/// intégration (clone du dépôt de démo) rangeait les siens sous
/// `bonsai-image-demo/models` : on continue de les reconnaître, sans les
/// déplacer, pour ne pas faire retélécharger 3,5 Go.
fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("bonsai").join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn legacy_models_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app_data(app).ok()?.join("bonsai-image-demo").join("models");
    dir.is_dir().then_some(dir)
}

fn log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_log_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("bonsai-server.log"))
}

// ---------------------------------------------------------------------------
//  Catalogue des modèles (dépôts Hugging Face de PrismML)
// ---------------------------------------------------------------------------

/// Un modèle du catalogue. `dir` est le nom du dossier local, identique à
/// celui du dépôt de démo officiel (`bonsai-image-4B-<variante>-<noyau>`), ce
/// qui garde les modèles déjà téléchargés par l'ancienne intégration.
#[derive(Debug, Clone, Serialize)]
pub struct BonsaiModelSpec {
    pub id: &'static str,
    pub variant: &'static str,
    pub kind: &'static str,
    pub repo: &'static str,
    pub dir: &'static str,
    pub label: &'static str,
    /// Taille approximative du dépôt (affichage avant téléchargement).
    pub size_bytes: u64,
    /// Sous-dossier dont la présence prouve que le transformeur est là.
    pub marker: &'static str,
}

const CATALOG: &[BonsaiModelSpec] = &[
    BonsaiModelSpec {
        id: "ternary-mlx", variant: "ternary", kind: "mlx",
        repo: "prism-ml/bonsai-image-ternary-4B-mlx-2bit",
        dir: "bonsai-image-4B-ternary-mlx",
        label: "Bonsai Image 4B · Ternary (1,58 bit, MLX)",
        size_bytes: 3_900_000_000, marker: "transformer-packed-mflux",
    },
    BonsaiModelSpec {
        id: "binary-mlx", variant: "binary", kind: "mlx",
        repo: "prism-ml/bonsai-image-binary-4B-mlx-1bit",
        dir: "bonsai-image-4B-binary-mlx",
        label: "Bonsai Image 4B · Binary (1 bit, MLX)",
        size_bytes: 3_450_000_000, marker: "transformer-packed-mflux",
    },
    BonsaiModelSpec {
        id: "ternary-gemlite", variant: "ternary", kind: "gemlite",
        repo: "prism-ml/bonsai-image-ternary-4B-gemlite-2bit",
        dir: "bonsai-image-4B-ternary-gemlite",
        label: "Bonsai Image 4B · Ternary (1,58 bit, CUDA)",
        size_bytes: 3_900_000_000, marker: "transformer-gemlite-int2",
    },
    BonsaiModelSpec {
        id: "binary-gemlite", variant: "binary", kind: "gemlite",
        repo: "prism-ml/bonsai-image-binary-4B-gemlite-1bit",
        dir: "bonsai-image-4B-binary-gemlite",
        label: "Bonsai Image 4B · Binary (1 bit, CUDA)",
        size_bytes: 3_450_000_000, marker: "transformer-gemlite-int1",
    },
];

/// Modèles pertinents pour cette machine (même noyau que le moteur).
fn platform_catalog() -> Vec<&'static BonsaiModelSpec> {
    let kind = platform_kind();
    CATALOG.iter().filter(|m| Some(m.kind) == kind).collect()
}

fn spec_by_id(id: &str) -> Result<&'static BonsaiModelSpec, String> {
    CATALOG
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Modèle Bonsai inconnu : {id}"))
}

/// Où vit (ou vivra) un modèle : le dossier courant, sinon l'emplacement hérité
/// s'il contient déjà ce modèle.
fn model_path(app: &tauri::AppHandle, spec: &BonsaiModelSpec) -> Result<PathBuf, String> {
    let current = models_dir(app)?.join(spec.dir);
    if current.join(spec.marker).is_dir() {
        return Ok(current);
    }
    if let Some(legacy) = legacy_models_dir(app) {
        let old = legacy.join(spec.dir);
        if old.join(spec.marker).is_dir() {
            return Ok(old);
        }
    }
    Ok(current)
}

fn model_installed(app: &tauri::AppHandle, spec: &BonsaiModelSpec) -> bool {
    model_path(app, spec).map(|p| p.join(spec.marker).is_dir()).unwrap_or(false)
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(m) = entry.metadata() {
                total += m.len();
            }
        }
    }
    total
}

#[derive(Serialize)]
pub struct BonsaiModelInfo {
    pub id: String,
    pub variant: String,
    pub kind: String,
    pub repo: String,
    pub label: String,
    pub installed: bool,
    /// Octets sur le disque si installé, sinon estimation du catalogue.
    pub size_bytes: u64,
    pub path: String,
    /// Un téléchargement est en cours pour ce modèle.
    pub downloading: bool,
}

async fn model_infos(app: &tauri::AppHandle, state: &BonsaiState) -> Vec<BonsaiModelInfo> {
    let downloads = state.downloads.lock().await;
    platform_catalog()
        .into_iter()
        .map(|spec| {
            let path = model_path(app, spec).unwrap_or_default();
            let installed = path.join(spec.marker).is_dir();
            BonsaiModelInfo {
                id: spec.id.into(),
                variant: spec.variant.into(),
                kind: spec.kind.into(),
                repo: spec.repo.into(),
                label: spec.label.into(),
                installed,
                size_bytes: if installed { dir_size(&path) } else { spec.size_bytes },
                path: path.display().to_string(),
                downloading: downloads.contains_key(spec.id),
            }
        })
        .collect()
}

/// Catalogue des modèles Bonsai pour cette plateforme, avec leur état local.
#[tauri::command]
pub async fn bonsai_models(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
) -> Result<Vec<BonsaiModelInfo>, String> {
    Ok(model_infos(&app, &state).await)
}

// ---------------------------------------------------------------------------
//  Téléchargement depuis Hugging Face
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct HfSibling {
    rfilename: String,
    size: Option<u64>,
}

#[derive(Deserialize)]
struct HfModelInfo {
    siblings: Vec<HfSibling>,
}

/// Liste des fichiers d'un dépôt (avec tailles) via l'API du Hub.
fn hf_files(client: &reqwest::blocking::Client, repo: &str) -> Result<Vec<HfSibling>, String> {
    let url = format!("https://huggingface.co/api/models/{repo}?blobs=true");
    let info: HfModelInfo = client
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Catalogue Hugging Face injoignable : {e}"))?
        .json()
        .map_err(|e| format!("Réponse Hugging Face illisible : {e}"))?;
    Ok(info
        .siblings
        .into_iter()
        // `.gitattributes` et consorts n'intéressent pas le moteur.
        .filter(|s| !s.rfilename.starts_with('.') && !s.rfilename.contains("/."))
        .collect())
}

/// Chemin relatif d'un dépôt : refuse toute remontée (`..`) ou chemin absolu.
fn safe_relative(rel: &str) -> Result<PathBuf, String> {
    let path = Path::new(rel);
    if path.is_absolute()
        || path.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(format!("Nom de fichier refusé : {rel}"));
    }
    Ok(path.to_path_buf())
}

/// Télécharge un fichier vers `part_path` puis le renomme en `final_path`, avec
/// reprise (`Range`) et annulation, en publiant la progression GLOBALE du
/// modèle (tous fichiers confondus) sous `bonsai-download-progress`.
#[allow(clippy::too_many_arguments)]
fn download_one(
    app: &tauri::AppHandle,
    client: &reqwest::blocking::Client,
    url: &str,
    part_path: &Path,
    final_path: &Path,
    id: &str,
    filename: &str,
    cancel: &Arc<AtomicBool>,
    done_before: u64,
    total_all: u64,
) -> Result<u64, String> {
    let resume_from = fs::metadata(part_path).map(|m| m.len()).unwrap_or(0);
    let mut request = client.get(url);
    if resume_from > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let mut response = request
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Téléchargement impossible ({filename}) : {e}"))?;
    let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT && resume_from > 0;
    let mut downloaded = if resumed { resume_from } else { 0 };
    let mut file = if resumed {
        fs::OpenOptions::new().append(true).open(part_path).map_err(|e| e.to_string())?
    } else {
        File::create(part_path).map_err(|e| e.to_string())?
    };
    let mut buf = vec![0_u8; DOWNLOAD_CHUNK];
    let mut last_emit = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            file.flush().map_err(|e| e.to_string())?;
            return Err(CANCELLED.into());
        }
        let count = response.read(&mut buf).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        file.write_all(&buf[..count]).map_err(|e| e.to_string())?;
        downloaded += count as u64;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = std::time::Instant::now();
            let done = done_before + downloaded;
            let percent = if total_all > 0 { (done as f64 / total_all as f64 * 100.0) as u8 } else { 0 };
            let _ = app.emit(
                "bonsai-download-progress",
                serde_json::json!({
                    "id": id, "filename": filename, "downloaded": done,
                    "total": total_all, "percent": percent.min(99)
                }),
            );
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    fs::rename(part_path, final_path).map_err(|e| e.to_string())?;
    Ok(downloaded)
}

/// Télécharge un modèle du catalogue (tous les fichiers du dépôt Hugging Face)
/// dans le dossier de modèles de Lumen. Reprise fichier par fichier : les
/// fichiers déjà complets (même taille) sont sautés, un `.part` est repris.
#[tauri::command]
pub async fn bonsai_download_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
    id: String,
) -> Result<BonsaiModelInfo, String> {
    let spec = spec_by_id(&id)?;
    if Some(spec.kind) != platform_kind() {
        return Err(format!(
            "« {} » est empaqueté pour {} ; cette machine attend un modèle {}.",
            spec.label,
            spec.kind,
            platform_kind().unwrap_or("non pris en charge")
        ));
    }
    if state.downloads.lock().await.contains_key(spec.id) {
        return Err("Ce modèle est déjà en cours de téléchargement.".into());
    }
    let dest = models_dir(&app)?.join(spec.dir);
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.downloads.lock().await.insert(spec.id.to_string(), cancel.clone());

    let app2 = app.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Pas d'échéance globale : un dépôt de 3,5 Go sur une ligne lente
        // dépasserait n'importe quel délai raisonnable (cf. llama.rs).
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(None)
            .user_agent("lumen-bonsai/1.0")
            .build()
            .map_err(|e| e.to_string())?;
        let files = hf_files(&client, spec.repo)?;
        if files.is_empty() {
            return Err("Le dépôt Hugging Face ne liste aucun fichier.".into());
        }
        let total_all: u64 = files.iter().map(|f| f.size.unwrap_or(0)).sum();
        let mut done: u64 = 0;
        for file in &files {
            let rel = safe_relative(&file.rfilename)?;
            let final_path = dest.join(&rel);
            if let Some(parent) = final_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let expected = file.size.unwrap_or(0);
            if let Ok(meta) = fs::metadata(&final_path) {
                if expected == 0 || meta.len() == expected {
                    done += expected;
                    continue;
                }
            }
            let name = rel.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let part_path = final_path.with_file_name(format!(".{name}.part"));
            let url = format!("https://huggingface.co/{}/resolve/main/{}", spec.repo, file.rfilename);
            let got = download_one(
                &app2, &client, &url, &part_path, &final_path, spec.id, &name, &cancel, done, total_all,
            )?;
            done += got.max(expected);
        }
        let _ = app2.emit(
            "bonsai-download-progress",
            serde_json::json!({ "id": spec.id, "downloaded": total_all, "total": total_all, "percent": 100 }),
        );
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;

    state.downloads.lock().await.remove(spec.id);
    result?;
    if !model_installed(&app, spec) {
        return Err(format!(
            "Téléchargement terminé mais le dossier « {} » est absent : le dépôt a peut-être changé de forme.",
            spec.marker
        ));
    }
    let _ = app.emit("bonsai-download-done", spec.id);
    model_infos(&app, &state)
        .await
        .into_iter()
        .find(|m| m.id == spec.id)
        .ok_or_else(|| "Modèle introuvable après installation".into())
}

/// Demande l'arrêt d'un téléchargement ; les fichiers déjà complets et le
/// `.part` en cours restent en place pour reprendre plus tard.
#[tauri::command]
pub async fn bonsai_cancel_download(
    state: tauri::State<'_, BonsaiState>,
    id: String,
) -> Result<bool, String> {
    Ok(match state.downloads.lock().await.get(&id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    })
}

/// Supprime un modèle installé (arrête d'abord le serveur s'il le sert).
#[tauri::command]
pub async fn bonsai_delete_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
    id: String,
) -> Result<(), String> {
    let spec = spec_by_id(&id)?;
    if state.downloads.lock().await.contains_key(spec.id) {
        return Err("Téléchargement en cours : annule-le d'abord.".into());
    }
    if state.variant.lock().await.as_deref() == Some(spec.variant) {
        stop_child(&state).await;
    }
    let path = model_path(&app, spec)?;
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Suppression impossible : {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
//  Cycle de vie du serveur
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct BonsaiStatus {
    /// Le moteur (runtime Python) est embarqué pour cette plateforme.
    engine_bundled: bool,
    engine_target: Option<&'static str>,
    engine_version: Option<String>,
    /// Le moteur peut être téléchargé/supprimé (dossier de données), par
    /// opposition à une copie de développement dans resources/.
    engine_downloaded: bool,
    engine_downloading: bool,
    /// Noyau attendu sur cette machine (`mlx`, `gemlite`) ou `None`.
    kind: Option<&'static str>,
    /// Compatibilité : au moins un modèle installé.
    model_present: bool,
    installed: bool,
    running: bool,
    /// Variante servie par le processus lancé par Lumen, si connue.
    active_variant: Option<String>,
    port: u16,
    url: String,
    models_dir: String,
    log_path: String,
    models: Vec<BonsaiModelInfo>,
}

async fn is_running(state: &BonsaiState) -> bool {
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

async fn api_alive(port: u16) -> bool {
    url_alive(&format!("http://127.0.0.1:{port}")).await
}

async fn active_api_port() -> Option<u16> {
    if api_alive(DEFAULT_PORT).await {
        Some(DEFAULT_PORT)
    } else if api_alive(OFFICIAL_PORT).await {
        Some(OFFICIAL_PORT)
    } else {
        None
    }
}

async fn stop_child(state: &BonsaiState) {
    let mut guard = state.child.lock().await;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *state.variant.lock().await = None;
}

/// Arrêt synchrone à la fermeture de Lumen (`RunEvent::Exit`) : un serveur
/// Bonsai orphelin garderait 4 Go de mémoire unifiée et le port 8800.
pub fn shutdown(state: &BonsaiState) {
    if let Ok(mut guard) = state.child.try_lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
pub async fn bonsai_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
) -> Result<BonsaiStatus, String> {
    let engine = engine_dir(&app);
    let models = model_infos(&app, &state).await;
    let model_present = models.iter().any(|m| m.installed);
    let owned_running = is_running(&state).await;
    let active_variant = state.variant.lock().await.clone();
    let custom = state.custom_url.lock().await.clone();
    let models_dir = models_dir(&app).map(|p| p.display().to_string()).unwrap_or_default();
    let log_path = log_path(&app).map(|p| p.display().to_string()).unwrap_or_default();
    let downloaded = downloaded_engine_dir(&app).filter(|d| engine_python(d).is_file());
    let base = BonsaiStatus {
        engine_bundled: engine.is_some(),
        engine_downloaded: downloaded.is_some(),
        engine_downloading: state.downloads.lock().await.contains_key(ENGINE_DOWNLOAD_ID),
        engine_target: platform_target(),
        engine_version: engine.as_deref().and_then(engine_version),
        kind: platform_kind(),
        model_present,
        installed: engine.is_some(),
        running: owned_running,
        active_variant: if owned_running { active_variant } else { None },
        port: DEFAULT_PORT,
        url: format!("http://127.0.0.1:{DEFAULT_PORT}"),
        models_dir,
        log_path,
        models,
    };
    if let Some(url) = custom {
        let running = url_alive(&url).await;
        return Ok(BonsaiStatus { running: owned_running || running, port: 0, url, ..base });
    }
    let active_port = active_api_port().await;
    let port = active_port.unwrap_or(DEFAULT_PORT);
    Ok(BonsaiStatus {
        running: owned_running || active_port.is_some(),
        port,
        url: format!("http://127.0.0.1:{port}"),
        ..base
    })
}

/// Définit (ou efface si vide) l'URL de base de l'API Bonsai à utiliser.
#[tauri::command]
pub async fn bonsai_set_url(
    state: tauri::State<'_, BonsaiState>,
    url: Option<String>,
) -> Result<(), String> {
    *state.custom_url.lock().await = url.as_deref().and_then(normalize_url);
    Ok(())
}

/// Renvoie l'URL de base personnalisée actuelle (chaîne vide si non définie).
#[tauri::command]
pub async fn bonsai_get_url(state: tauri::State<'_, BonsaiState>) -> Result<String, String> {
    Ok(state.custom_url.lock().await.clone().unwrap_or_default())
}

/// Démarre le serveur Bonsai embarqué sur la variante demandée (« ternary » par
/// défaut, sinon la seule installée). Un serveur déjà lancé sur une AUTRE
/// variante est remplacé : le moteur ne charge qu'un transformeur à la fois.
#[tauri::command]
pub async fn bonsai_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
    variant: Option<String>,
) -> Result<BonsaiStatus, String> {
    start_inner(&app, &state, variant.as_deref()).await?;
    bonsai_status(app, state).await
}

/// Cœur du démarrage, partagé par la commande et par le démarrage automatique
/// à la première génération (`resolve_base`). Ne renvoie rien : l'état se lit
/// ensuite par `bonsai_status`.
async fn start_inner(app: &tauri::AppHandle, state: &BonsaiState, variant: Option<&str>) -> Result<(), String> {
    let app = app.clone();
    let kind = platform_kind().ok_or_else(|| {
        "Bonsai n'est pas disponible sur cette plateforme (Apple Silicon ou GPU NVIDIA requis).".to_string()
    })?;
    let engine = engine_dir(&app).ok_or_else(|| {
        "Moteur Bonsai non installé : télécharge-le depuis le Catalogue (Modèles → Image) ou les Réglages.".to_string()
    })?;
    let installed: Vec<&BonsaiModelSpec> = platform_catalog()
        .into_iter()
        .filter(|s| model_installed(&app, s))
        .collect();
    if installed.is_empty() {
        return Err("Aucun modèle Bonsai installé : télécharge-en un depuis le Catalogue.".into());
    }
    let wanted = variant
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.trim_start_matches("bonsai-").split('-').next().unwrap_or(v).to_string());
    let spec = match wanted {
        Some(v) => installed
            .iter()
            .find(|s| s.variant == v)
            .copied()
            .ok_or_else(|| format!("Le modèle Bonsai « {v} » n'est pas installé."))?,
        None => installed
            .iter()
            .find(|s| s.variant == "ternary")
            .or_else(|| installed.first())
            .copied()
            .ok_or_else(|| "Aucun modèle Bonsai installé.".to_string())?,
    };
    if is_running(state).await {
        if state.variant.lock().await.as_deref() == Some(spec.variant) {
            return Ok(());
        }
        stop_child(state).await;
    } else if active_api_port().await == Some(DEFAULT_PORT) {
        // Un serveur étranger occupe déjà notre port (démo officielle lancée à
        // la main, orphelin d'une session précédente…) : on l'utilise tel quel
        // plutôt que d'échouer au bind, mais on ne prétend pas le piloter.
        return Ok(());
    }

    let log_path = log_path(&app)?;
    let log_file = File::create(&log_path).map_err(|e| format!("Journal Bonsai impossible : {e}"))?;
    let stderr_file = log_file.try_clone().map_err(|e| e.to_string())?;
    let python = engine_python(&engine);
    sync_server_script(&engine);
    let model_root = model_path(&app, spec)?;
    // Les deux variantes peuvent cohabiter : on annonce celles présentes, le
    // serveur en charge une et bascule à la demande.
    let families: Vec<String> = installed.iter().map(|s| format!("bonsai-{}", s.variant)).collect();
    let mut command = Command::new(&python);
    quiet(&mut command);
    command
        .arg(engine.join("lumen_bonsai_server.py"))
        .arg("--port")
        .arg(DEFAULT_PORT.to_string())
        .env("LUMEN_BONSAI_KIND", kind)
        .env("LUMEN_BONSAI_VARIANT", spec.variant)
        .env("LUMEN_BONSAI_MODEL_DIR", &model_root)
        .env("LUMEN_BONSAI_MODELS_DIR", models_dir(&app)?)
        .env("LUMEN_BONSAI_FAMILIES", families.join(","))
        .env("LUMEN_BONSAI_CACHE_DIR", app_data(&app)?.join("bonsai").join("cache"))
        // Le runtime est autonome : aucune variable Python de l'hôte ne doit
        // le détourner vers un autre site-packages.
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONUNBUFFERED", "1")
        .env("HF_HUB_OFFLINE", "1")
        .current_dir(&engine)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr_file));
    if let Some(legacy) = legacy_models_dir(&app) {
        command.env("LUMEN_BONSAI_LEGACY_MODELS_DIR", legacy);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Impossible de démarrer le moteur Bonsai : {e}"))?;
    // Un interpréteur qui ne trouve pas ses modules meurt tout de suite : le
    // dire ici, journal à l'appui, plutôt qu'un vague « API non démarrée ».
    tokio::time::sleep(Duration::from_millis(400)).await;
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
        let detail = fs::read_to_string(&log_path).unwrap_or_default();
        let detail = detail.trim().chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect::<String>();
        return Err(format!(
            "Le moteur Bonsai s'est arrêté au démarrage ({status}). {}",
            if detail.is_empty() { format!("Journal : {}", log_path.display()) } else { detail }
        ));
    }
    // Attendre que l'API réponde (chargement du transformeur : ~2 s en MLX,
    // bien plus sur CUDA avec la compilation Triton) pour que l'appelant puisse
    // générer dès le retour. Borné : au-delà, on rend la main et l'interface
    // continue de sonder. Une mort prématurée est remontée avec le journal.
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    loop {
        if api_alive(DEFAULT_PORT).await {
            break;
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let detail = fs::read_to_string(&log_path).unwrap_or_default();
            let detail = detail.trim().chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect::<String>();
            return Err(format!("Le moteur Bonsai s'est arrêté ({status}). {detail}"));
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    *state.child.lock().await = Some(child);
    *state.variant.lock().await = Some(spec.variant.to_string());
    Ok(())
}

#[tauri::command]
pub async fn bonsai_stop(state: tauri::State<'_, BonsaiState>) -> Result<(), String> {
    stop_child(&state).await;
    Ok(())
}

/// Résout l'URL de base de l'API Bonsai (personnalisée ou port local détecté).
/// Sans serveur, le moteur embarqué est DÉMARRÉ à la demande sur la variante
/// suggérée par `backend` (« bonsai-binary-mlx », « binary »…) ou la variante
/// par défaut — comme llama-server au premier message : aucune surface (Studio,
/// Planche, Opus, agents…) n'a à envoyer l'utilisateur dans les Réglages.
async fn resolve_base(app: &tauri::AppHandle, state: &BonsaiState, backend: Option<&str>) -> Result<String, String> {
    if let Some(url) = state.custom_url.lock().await.clone() {
        return Ok(url);
    }
    if !is_running(state).await {
        if let Some(port) = active_api_port().await {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
        start_inner(app, state, backend).await?;
    }
    let port = active_api_port().await.unwrap_or(DEFAULT_PORT);
    Ok(format!("http://127.0.0.1:{port}"))
}

#[derive(Deserialize)]
struct OpenAiImageData {
    b64_json: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiImageResponse {
    data: Vec<OpenAiImageData>,
}

/// Modèle d'image Ollama par défaut si les réglages n'en désignent aucun.
pub const DEFAULT_OLLAMA_IMAGE_MODEL: &str = "flux";

/// URL de l'API compatible OpenAI d'Ollama, à partir de l'URL du serveur
/// renseignée dans les réglages. Ollama sert la génération d'images sous
/// `/v1/images/generations` : on complète le suffixe `/v1` s'il manque, et on
/// force l'IPv4 (sous Windows `localhost` se résout en `::1`, où Ollama
/// n'écoute pas).
fn ollama_image_base(raw: Option<&str>) -> String {
    let base = crate::normalize_ollama_url(raw.unwrap_or("").trim());
    if base.ends_with("/v1") {
        base
    } else {
        format!("{base}/v1")
    }
}

/// Résolutions acceptées par l'API OpenAI, PAR MODÈLE. Envoyer autre chose est
/// une erreur 400 : on ramène donc la taille demandée sur la plus proche
/// autorisée, en privilégiant le même rapport largeur/hauteur.
fn openai_size(model: &str, width: u32, height: u32) -> String {
    let allowed: &[(u32, u32)] = if model.starts_with("dall-e-3") {
        &[(1024, 1024), (1792, 1024), (1024, 1792)]
    } else if model.starts_with("dall-e-2") {
        &[(256, 256), (512, 512), (1024, 1024)]
    } else {
        &[(1024, 1024), (1536, 1024), (1024, 1536)]
    };
    let (w, h) = (width.max(1) as f32, height.max(1) as f32);
    let ratio = w / h;
    let best = allowed
        .iter()
        .min_by(|a, b| {
            let score = |(aw, ah): &(u32, u32)| {
                let (aw, ah) = (*aw as f32, *ah as f32);
                (aw / ah - ratio).abs() * 1000.0 + (aw * ah - w * h).abs() / 1e5
            };
            score(a).partial_cmp(&score(b)).unwrap_or(std::cmp::Ordering::Equal)
        })
        .copied()
        .unwrap_or((1024, 1024));
    format!("{}x{}", best.0, best.1)
}

/// Extrait un message lisible du corps d'une réponse d'erreur. OpenAI et
/// Ollama renvoient tous deux du JSON, mais pas sous la même forme
/// (`{"error":{"message":…}}` contre `{"error":"…"}`) ; en dernier recours on
/// rend le texte brut, tronqué.
fn detail_of(body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        return "réponse vide".into();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        let msg = v
            .get("error")
            .and_then(|e| e.get("message").and_then(|m| m.as_str()).or_else(|| e.as_str()))
            .or_else(|| v.get("message").and_then(|m| m.as_str()))
            // FastAPI (serveur Bonsai) : `{"detail": "..."}`.
            .or_else(|| v.get("detail").and_then(|m| m.as_str()));
        if let Some(msg) = msg {
            if !msg.trim().is_empty() {
                return msg.trim().chars().take(400).collect();
            }
        }
    }
    body.chars().take(400).collect()
}

async fn generate_openai_bytes(
    prompt: String,
    size: String,
    api_base: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
) -> Result<Vec<u8>, String> {
    use base64::Engine;
    // La clé est OPTIONNELLE : ce chemin sert aussi à Ollama, qui expose le
    // même endpoint `/images/generations` en local et n'authentifie rien. Un
    // OpenAI sans clé échouera de toute façon côté serveur, avec son message.
    let key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let base = api_base
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/')
        .to_string();
    let model = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("gpt-image-1")
        .to_string();
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(240))
        .build()
        .map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let payload = serde_json::json!({
            "model": model,
            "prompt": prompt,
            "size": size,
            "n": 1
        });
        let mut req = client.post(format!("{base}/images/generations"));
        if let Some(key) = key {
            req = req.bearer_auth(key);
        }
        let resp = req.json(&payload).send().map_err(|e| e.to_string())?;
        // `error_for_status()` jetait le CORPS de la réponse : sur une erreur
        // 500 on n'apprenait rien d'autre que « 500 », alors que le serveur
        // explique presque toujours ce qui ne va pas (paramètre refusé,
        // modèle qui ne sait pas générer d'image…).
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            return Err(format!("{status} — {}", detail_of(&body)));
        }
        let parsed: OpenAiImageResponse = resp.json().map_err(|e| e.to_string())?;
        let first = parsed
            .data
            .into_iter()
            .next()
            .ok_or_else(|| "Réponse du moteur d'image sans image.".to_string())?;
        if let Some(b64) = first.b64_json {
            return base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("Image reçue invalide : {e}"));
        }
        if let Some(url) = first.url {
            return client
                .get(url)
                .send()
                .and_then(|r| r.error_for_status())
                .and_then(|r| r.bytes())
                .map(|b| b.to_vec())
                .map_err(|e| e.to_string());
        }
        Err("Réponse du moteur d'image sans image exploitable.".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Génération d'image par l'API **native** d'Ollama (`/api/generate`), utilisée
/// en repli quand l'endpoint compatible OpenAI refuse la demande : selon la
/// version d'Ollama et le modèle, seule l'une des deux routes répond. Les
/// images arrivent en base64 dans le champ `images`.
async fn generate_ollama_native_bytes(
    root: String,
    prompt: String,
    model: String,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(240))
        .build()
        .map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let payload = serde_json::json!({
            "model": model,
            "prompt": prompt,
            "stream": false,
            "options": { "width": width, "height": height },
        });
        let resp = client
            .post(format!("{root}/api/generate"))
            .json(&payload)
            .send()
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body = resp.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{status} — {}", detail_of(&body)));
        }
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let b64 = v
            .get("images")
            .and_then(|i| i.as_array())
            .and_then(|a| a.first())
            .and_then(|s| s.as_str())
            // Certaines versions rendent une seule image sous `image`.
            .or_else(|| v.get("image").and_then(|s| s.as_str()))
            .ok_or_else(|| {
                "réponse sans image : ce modèle ne génère probablement pas d'images".to_string()
            })?;
        base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("Image reçue invalide : {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Appelle l'API Bonsai et renvoie les octets PNG de l'image générée.
async fn generate_bonsai_bytes(
    base: String,
    prompt: String,
    width: Option<u32>,
    height: Option<u32>,
    seed: Option<u64>,
    steps: Option<u32>,
    backend: Option<String>,
) -> Result<Vec<u8>, String> {
    // Stable Diffusion exige des dimensions multiples de 64 : on arrondit au plus
    // proche (min. 64) pour ne jamais envoyer une taille rejetée (ex. 512×341).
    let round64 = |v: u32| -> u32 { (((v + 32) / 64) * 64).max(64) };
    let w = round64(width.unwrap_or(512).max(32));
    let h = round64(height.unwrap_or(512).max(32));
    let steps = steps.unwrap_or(4).clamp(1, 64);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(240))
        .build()
        .map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let advertised = || {
            client
                .get(format!("{base}/backends"))
                .send()
                .and_then(|r| r.error_for_status())
                .and_then(|r| r.json::<serde_json::Value>())
                .ok()
        };
        let advertised_backends = advertised();
        // L'API attend un identifiant COMPLET « {famille}-{noyau} »
        // (bonsai-ternary-mlx). Les surfaces envoient tantôt ce nom, tantôt la
        // famille nue (« bonsai-ternary » quand le noyau n'a pas encore été
        // détecté), tantôt la seule variante (« ternary », blocs Fluxo,
        // Telegram) : on ramène tout à la forme canonique d'après ce que le
        // serveur annonce, sinon il répondait « Unknown backend » — c'est
        // exactement pourquoi la génération marchait dans le Canvas (qui
        // mémorise le noyau) et nulle part ailleurs.
        let normalize_backend = |v: &serde_json::Value, req: &str| -> Option<String> {
            let kind = v.get("kind").and_then(|s| s.as_str()).unwrap_or("");
            let families: Vec<&str> = v
                .get("supported_families")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|f| f.as_str()).collect())
                .unwrap_or_default();
            if v.get("default").and_then(|s| s.as_str()) == Some(req) {
                return Some(req.to_string());
            }
            let mut core = req.trim().to_lowercase();
            for suffix in ["-mlx", "-gemlite", "-diffusers"] {
                if let Some(stripped) = core.strip_suffix(suffix) {
                    core = stripped.to_string();
                }
            }
            let family = if core.starts_with("bonsai-") { core } else { format!("bonsai-{core}") };
            if !families.iter().any(|f| *f == family) {
                return None;
            }
            Some(if kind.is_empty() { family } else { format!("{family}-{kind}") })
        };
        let default_backend = |v: &serde_json::Value| {
            v.get("default")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    let family = v.get("default_family")?.as_str()?;
                    let kind = v.get("kind")?.as_str()?;
                    Some(format!("{family}-{kind}"))
                })
        };
        let requested_backend = backend.filter(|s| !s.trim().is_empty());
        let backend = match (requested_backend, advertised_backends.as_ref()) {
            (Some(req), Some(v)) => normalize_backend(v, &req).or_else(|| default_backend(v)),
            (Some(req), None) => Some(req),
            (None, Some(v)) => default_backend(v),
            _ => None,
        };
        let mut payload = serde_json::json!({
            "prompt": prompt,
            "width": w,
            "height": h,
            "steps": steps,
            "seed": seed.unwrap_or_else(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u64 & 0x7fff_ffff)
                    .unwrap_or(42)
            })
        });
        if let Some(backend) = backend {
            payload["backend"] = serde_json::Value::String(backend);
        }
        // Même logique que les autres moteurs : sur une erreur on remonte le
        // CORPS (le serveur Lumen renvoie `{"detail": "<exception>"}`), sinon
        // l'utilisateur ne voyait que « 500 » sans la cause (CUDA à court de
        // mémoire, noyau Triton en échec…).
        let resp = client
            .post(format!("{base}/generate"))
            .json(&payload)
            .send()
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            return Err(format!("{status} — {}", detail_of(&body)));
        }
        resp.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_image_bytes(
    app: &tauri::AppHandle,
    state: &BonsaiState,
    prompt: String,
    width: Option<u32>,
    height: Option<u32>,
    seed: Option<u64>,
    steps: Option<u32>,
    backend: Option<String>,
    provider: Option<String>,
    api_base: Option<String>,
    api_key: Option<String>,
    api_model: Option<String>,
) -> Result<Vec<u8>, String> {
    let provider_name = provider.as_deref().unwrap_or("bonsai");
    if provider_name.eq_ignore_ascii_case("ollama") {
        // Ollama expose l'endpoint OpenAI `/v1/images/generations` pour ses
        // modèles d'image : même dialogue que le cloud, mais en local et sans
        // clé. Le modèle (`api_model`) doit être un modèle d'image installé.
        let base = ollama_image_base(api_base.as_deref());
        let model = api_model
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_OLLAMA_IMAGE_MODEL.to_string());
        // Ollama ne contraint pas les tailles : on transmet celle demandée.
        let (w, h) = (width.unwrap_or(1024), height.unwrap_or(1024));
        let size = format!("{w}x{h}");
        let compat = generate_openai_bytes(
            prompt.clone(),
            size,
            Some(base.clone()),
            None,
            Some(model.clone()),
        )
        .await;
        let compat_err = match compat {
            Ok(bytes) => return Ok(bytes),
            Err(e) => e,
        };
        // Les deux routes coexistent selon les versions d'Ollama. On ne
        // retente en natif que si la route compatible est ABSENTE : sur toute
        // autre erreur (mémoire insuffisante, modèle inadapté…) le natif
        // échouerait pareil, et rejouer masquerait le vrai message.
        let route_missing = compat_err.starts_with("404")
            || compat_err.starts_with("405")
            || compat_err.starts_with("501");
        if !route_missing {
            return Err(compat_err);
        }
        let root = base.trim_end_matches("/v1").trim_end_matches('/').to_string();
        return generate_ollama_native_bytes(root, prompt, model, w, h)
            .await
            .map_err(|native_err| {
                format!("Ollama n'a pas généré d'image (/api/generate) : {native_err}")
            });
    }
    if provider_name.eq_ignore_ascii_case("playground") {
        // Image Playground (Apple Intelligence) : feuille système interactive,
        // `api_model` désigne le STYLE (any / illustration / animation / sketch).
        return crate::imageplayground::generate_bytes(
            app,
            prompt,
            width.unwrap_or(1024),
            height.unwrap_or(1024),
            api_model,
            None,
        )
        .await;
    }
    if provider_name.eq_ignore_ascii_case("openai") {
        // SÉCURITÉ : la clé n'est plus persistée côté front. Si le front n'en
        // fournit pas, on lit les identifiants stockés côté backend.
        let (api_base, api_key) = match api_key.as_deref().map(str::trim) {
            Some(k) if !k.is_empty() => (api_base, api_key),
            _ => {
                let (base, key) = crate::agents::openai_image_creds(app);
                (
                    api_base.filter(|s| !s.trim().is_empty()).or(Some(base)),
                    Some(key),
                )
            }
        };
        let model = api_model.unwrap_or_else(|| "gpt-image-1".to_string());
        let size = openai_size(&model, width.unwrap_or(1024), height.unwrap_or(1024));
        generate_openai_bytes(prompt, size, api_base, api_key, Some(model)).await
    } else {
        let base = resolve_base(app, state, backend.as_deref()).await?;
        generate_bonsai_bytes(base, prompt, width, height, seed, steps, backend).await
    }
}

#[tauri::command]
pub async fn bonsai_generate_to_sandbox(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
    id: String,
    prompt: String,
    path: String,
    width: Option<u32>,
    height: Option<u32>,
    seed: Option<u64>,
    steps: Option<u32>,
    backend: Option<String>,
    provider: Option<String>,
    api_base: Option<String>,
    api_key: Option<String>,
    api_model: Option<String>,
) -> Result<String, String> {
    let bytes = generate_image_bytes(
        &app, &state, prompt, width, height, seed, steps, backend, provider, api_base, api_key,
        api_model,
    )
    .await?;
    crate::sandbox::sandbox_write_binary(app, id, path.clone(), bytes)?;
    Ok(path)
}

/// Génère une image pour un bloc Fluxo (« Générer une image ») et l'écrit dans une
/// sandbox désignée par son **nom**. Le backend « openai » réutilise les
/// identifiants cloud configurés dans Lumen ; « bonsai » passe par l'API locale.
/// Renvoie le chemin (relatif) du fichier créé dans la sandbox.
pub async fn generate_for_fluxo(
    app: &tauri::AppHandle,
    state: &BonsaiState,
    sandbox_name: &str,
    prompt: String,
    path: String,
    backend: Option<String>,
    model: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<String, String> {
    let id = crate::sandbox::id_for_name(app, sandbox_name)
        .ok_or_else(|| format!("Sandbox « {sandbox_name} » introuvable"))?;
    // Sans backend explicite (ou « auto »), c'est le moteur des réglages de
    // Lumen qui sert — et son modèle, si le bloc n'en impose pas.
    let cfg = read_image_config(app);
    let explicit = backend.filter(|s| !s.trim().is_empty() && !s.trim().eq_ignore_ascii_case("auto"));
    let provider = explicit.clone().unwrap_or_else(|| cfg.provider.clone());
    let model = model.filter(|s| !s.trim().is_empty()).or_else(|| {
        if explicit.is_some() { return None; }
        match provider.as_str() {
            "ollama" => Some(cfg.ollama_model.clone()).filter(|s| !s.is_empty()),
            "openai" => Some(cfg.openai_model.clone()).filter(|s| !s.is_empty()),
            "playground" => Some(cfg.playground_style.clone()).filter(|s| !s.is_empty()),
            _ => Some(cfg.bonsai_model.clone()).filter(|s| !s.is_empty()),
        }
    });
    // Ollama tourne en local : ni clé ni URL cloud. `generate_image_bytes`
    // retombe sur l'URL Ollama par défaut et le modèle d'image par défaut.
    let (api_base, api_key) = if provider.eq_ignore_ascii_case("ollama") {
        (None, None)
    } else if provider.eq_ignore_ascii_case("openai") {
        let (base, key) = crate::agents::openai_image_creds(app);
        if key.trim().is_empty() {
            return Err("Clé API OpenAI absente : configure-la dans les réglages de Lumen.".into());
        }
        (Some(base), Some(key))
    } else {
        (None, None)
    };
    // Pour Bonsai, `model` désigne un BACKEND (« bonsai-ternary-mlx ») et non un
    // modèle d'API : les deux paramètres ne vont donc pas au même endroit.
    let is_bonsai = !provider.eq_ignore_ascii_case("ollama")
        && !provider.eq_ignore_ascii_case("openai")
        && !provider.eq_ignore_ascii_case("playground");
    let (bonsai_backend, api_model) = if is_bonsai {
        (model.filter(|s| !s.trim().is_empty()), None)
    } else {
        (None, model)
    };
    let bytes = generate_image_bytes(
        app,
        state,
        prompt,
        width,
        height,
        None,
        None,
        bonsai_backend,
        Some(provider),
        api_base,
        api_key,
        api_model,
    )
    .await?;
    crate::sandbox::sandbox_write_binary(app.clone(), id, path.clone(), bytes)?;
    Ok(path)
}

/// Enregistre une image (data URL ou base64 brut) dans le dossier Téléchargements.
/// Renvoie le chemin final. Utilisé par le bouton « Enregistrer » du Studio.
#[tauri::command]
pub fn bonsai_save_png(
    app: tauri::AppHandle,
    data_url: String,
    name: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let b64 = data_url
        .split_once("base64,")
        .map(|(_, d)| d)
        .unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Image invalide : {e}"))?;
    let dl = app.path().download_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dl).map_err(|e| e.to_string())?;
    let mut base = name.unwrap_or_else(|| "bonsai".into());
    base.retain(|c| c.is_alphanumeric() || c == '-' || c == '_');
    if base.is_empty() {
        base = "bonsai".into();
    }
    base.truncate(48);
    let mut dest = dl.join(format!("{base}.png"));
    for i in 1.. {
        if !dest.exists() {
            break;
        }
        dest = dl.join(format!("{base}-{i}.png"));
        if i > 9999 {
            break;
        }
    }
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct BonsaiBackends {
    /// Backend par défaut annoncé par l'API (peut servir d'option « Automatique »).
    default: Option<String>,
    /// Liste des backends/modèles sélectionnables.
    available: Vec<String>,
    /// Périphérique de calcul rapporté par l'API (info, ex. « mps »).
    device: Option<String>,
}

/// Interroge l'API Bonsai (`/backends`) et renvoie la liste normalisée des
/// backends disponibles. Le wrapper local n'en expose qu'un ; un backend distant
/// (URL personnalisée) peut en proposer plusieurs.
#[tauri::command]
pub async fn bonsai_backends(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
) -> Result<BonsaiBackends, String> {
    let base = resolve_base(&app, &state, None).await?;
    let v = tokio::task::spawn_blocking(move || {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .build()
            .map_err(|e| e.to_string())?
            .get(format!("{base}/backends"))
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json::<serde_json::Value>())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    // Le « kind » (ex. « mlx ») se combine avec une famille pour former l'id de
    // backend attendu par /generate : « {famille}-{kind} » (ex. bonsai-binary-mlx).
    let kind = v.get("kind").and_then(|s| s.as_str());
    let with_kind = |family: &str| match kind {
        Some(k) if !family.ends_with(&format!("-{k}")) => format!("{family}-{k}"),
        _ => family.to_string(),
    };

    let default = v
        .get("default")
        .and_then(|s| s.as_str())
        .map(String::from)
        .or_else(|| {
            v.get("default_family")
                .and_then(|s| s.as_str())
                .map(|f| with_kind(f))
        });

    // Forme officielle Bonsai : « supported_families » × « kind ». Sinon on
    // retombe sur les champs tableau génériques (chaînes ou objets {id|name}).
    let mut available: Vec<String> = Vec::new();
    if let Some(arr) = v.get("supported_families").and_then(|x| x.as_array()) {
        for item in arr {
            if let Some(f) = item.as_str() {
                let id = with_kind(f);
                if !available.contains(&id) {
                    available.push(id);
                }
            }
        }
    }
    if available.is_empty() {
        for key in ["backends", "available", "models", "families"] {
            if let Some(arr) = v.get(key).and_then(|x| x.as_array()) {
                for item in arr {
                    let name = item.as_str().map(String::from).or_else(|| {
                        item.get("id")
                            .and_then(|x| x.as_str())
                            .or_else(|| item.get("name").and_then(|x| x.as_str()))
                            .map(String::from)
                    });
                    if let Some(name) = name {
                        if !available.contains(&name) {
                            available.push(name);
                        }
                    }
                }
                if !available.is_empty() {
                    break;
                }
            }
        }
    }
    if available.is_empty() {
        if let Some(d) = &default {
            available.push(d.clone());
        }
    }

    let device = v.get("device").and_then(|s| s.as_str()).map(String::from);
    Ok(BonsaiBackends {
        default,
        available,
        device,
    })
}

/// Nom de la sandbox dédiée où le Studio dépose ses images quand aucune sandbox
/// cible n'est fournie (ouverture autonome depuis la boîte à outils).
const STUDIO_SANDBOX: &str = "Studio d'images";

/// Trouve (ou crée) la sandbox dédiée du Studio et renvoie son id.
fn ensure_studio_sandbox(app: &tauri::AppHandle) -> Result<String, String> {
    let list = crate::sandbox::sandbox_list_unchecked(&app)?;
    if let Some(m) = list.iter().find(|m| m.name == STUDIO_SANDBOX) {
        return Ok(m.id.clone());
    }
    let meta = crate::sandbox::sandbox_create_unchecked(app.clone(), STUDIO_SANDBOX.into(), 256)?;
    Ok(meta.id)
}

#[derive(Serialize)]
pub struct GeneratedImage {
    sandbox_id: String,
    path: String,
    data_url: String,
}

/// Génère une image, l'écrit dans une sandbox et renvoie le data URL pour
/// affichage immédiat dans la galerie du Studio. Si `id` est absent, la sandbox
/// dédiée « Studio d'images » est utilisée (créée au besoin).
#[tauri::command]
pub async fn bonsai_generate_to_sandbox_url(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
    id: Option<String>,
    path: String,
    prompt: String,
    width: Option<u32>,
    height: Option<u32>,
    seed: Option<u64>,
    steps: Option<u32>,
    backend: Option<String>,
    provider: Option<String>,
    api_base: Option<String>,
    api_key: Option<String>,
    api_model: Option<String>,
) -> Result<GeneratedImage, String> {
    use base64::Engine;
    let sandbox_id = match id.filter(|s| !s.trim().is_empty()) {
        Some(id) => id,
        None => ensure_studio_sandbox(&app)?,
    };
    let bytes = generate_image_bytes(
        &app, &state, prompt, width, height, seed, steps, backend, provider, api_base, api_key,
        api_model,
    )
    .await?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    crate::sandbox::sandbox_write_binary(app, sandbox_id.clone(), path.clone(), bytes)?;
    Ok(GeneratedImage {
        sandbox_id,
        path,
        data_url: format!("data:image/png;base64,{b64}"),
    })
}

/// Génère une image et renvoie uniquement son data URL, sans l'écrire sur disque.
/// Utilisé par le Studio quand la destination est « Mémoire seule » : l'image
/// n'existe alors que dans la galerie en mémoire (perdue si non téléchargée).
#[tauri::command]
pub async fn bonsai_generate_data_url(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
    prompt: String,
    width: Option<u32>,
    height: Option<u32>,
    seed: Option<u64>,
    steps: Option<u32>,
    backend: Option<String>,
    provider: Option<String>,
    api_base: Option<String>,
    api_key: Option<String>,
    api_model: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let bytes = generate_image_bytes(
        &app, &state, prompt, width, height, seed, steps, backend, provider, api_base, api_key,
        api_model,
    )
    .await?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

// ===========================================================================
//  Moteur par défaut partagé avec le backend + outil « generate_image »
// ===========================================================================
//
// Le choix du moteur d'image (et du modèle par moteur) vit dans le localStorage
// de la barre. Les surfaces sans fenêtre — boucle agentique, Telegram, blocs
// Fluxo sans backend explicite — n'y ont pas accès : la barre et les Réglages
// poussent donc une copie dans `image.json` (`image_set_config`), comme
// `ollama.json` pour le modèle de texte.

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageConfig {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub bonsai_model: String,
    #[serde(default)]
    pub ollama_model: String,
    #[serde(default)]
    pub openai_model: String,
    #[serde(default)]
    pub playground_style: String,
    #[serde(default)]
    pub ollama_url: String,
}
fn default_provider() -> String { "bonsai".into() }
impl Default for ImageConfig {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            bonsai_model: String::new(),
            ollama_model: String::new(),
            openai_model: String::new(),
            playground_style: String::new(),
            ollama_url: String::new(),
        }
    }
}

fn image_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("image.json"))
}

/// Moteur d'image par défaut tel que réglé dans Lumen (repli : Bonsai).
pub fn read_image_config(app: &tauri::AppHandle) -> ImageConfig {
    image_config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn image_set_config(app: tauri::AppHandle, config: ImageConfig) -> Result<(), String> {
    let path = image_config_path(&app)?;
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn image_get_config(app: tauri::AppHandle) -> Result<ImageConfig, String> {
    Ok(read_image_config(&app))
}

/// Libellé « Moteur · modèle » pour les cartes et les comptes rendus.
fn provider_label(provider: &str, model: &str) -> String {
    let engine = match provider {
        "ollama" => "Ollama",
        "openai" => "OpenAI",
        "playground" => "Image Playground",
        _ => "Bonsai",
    };
    let model = model.trim().trim_start_matches("bonsai-");
    if model.is_empty() { engine.to_string() } else { format!("{engine} · {model}") }
}

/// Paramètres de génération explicites (ceux de la barre, qui connaît le
/// localStorage) ; à défaut, `read_image_config` fait foi.
#[derive(Deserialize, Default, Clone)]
pub struct GenerationOverride {
    pub provider: Option<String>,
    pub api_base: Option<String>,
    pub api_key: Option<String>,
    pub api_model: Option<String>,
    pub backend: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ImageToolResult {
    pub text: String,
    pub data_url: String,
    pub path: String,
    pub sandbox_id: String,
    pub sandbox_name: String,
    pub provider: String,
}

fn slug_of(prompt: &str) -> String {
    let mut s: String = prompt
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    while s.contains("--") { s = s.replace("--", "-"); }
    let s = s.trim_matches('-').chars().take(40).collect::<String>();
    if s.is_empty() { "image".into() } else { s }
}

/// Vignette JPEG (≤ 360 px) en data URL pour la capsule : un PNG 1024² pèse
/// plus d'un mégaoctet, trop pour un évènement relayé jusqu'aux téléphones.
fn thumbnail_data_url(png: &[u8]) -> Option<String> {
    use base64::Engine;
    let img = image::load_from_memory(png).ok()?;
    let thumb = img.thumbnail(360, 360).to_rgb8();
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82);
    enc.encode(thumb.as_raw(), thumb.width(), thumb.height(), image::ExtendedColorType::Rgb8).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

/// Outil de génération d'image : moteur par défaut (ou surcharge de la barre),
/// image rangée dans la sandbox de l'appelant (sinon « Studio d'images »),
/// carte poussée dans la capsule Halo. Partagé par la commande de la barre et
/// par la boucle agentique (`native_tools::exec`).
pub async fn generate_image_tool(
    app: &tauri::AppHandle,
    state: &BonsaiState,
    prompt: &str,
    width: Option<u32>,
    height: Option<u32>,
    sandbox_id: &str,
    over: Option<GenerationOverride>,
) -> Result<ImageToolResult, String> {
    use base64::Engine;
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Décris l'image à générer (prompt vide).".into());
    }
    let cfg = read_image_config(app);
    let over = over.unwrap_or_default();
    let provider = over
        .provider
        .clone()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| cfg.provider.clone());
    let (api_base, api_model, backend) = match provider.as_str() {
        "ollama" => (
            over.api_base.clone().filter(|s| !s.trim().is_empty()).or_else(|| Some(cfg.ollama_url.clone()).filter(|s| !s.is_empty())),
            over.api_model.clone().filter(|s| !s.trim().is_empty()).or_else(|| Some(cfg.ollama_model.clone()).filter(|s| !s.is_empty())),
            None,
        ),
        "openai" => (
            over.api_base.clone().filter(|s| !s.trim().is_empty()),
            over.api_model.clone().filter(|s| !s.trim().is_empty()).or_else(|| Some(cfg.openai_model.clone()).filter(|s| !s.is_empty())),
            None,
        ),
        "playground" => (
            None,
            over.api_model.clone().filter(|s| !s.trim().is_empty()).or_else(|| Some(cfg.playground_style.clone()).filter(|s| !s.is_empty())),
            None,
        ),
        _ => (
            None,
            None,
            over.backend.clone().filter(|s| !s.trim().is_empty()).or_else(|| {
                let v = if cfg.bonsai_model.trim().is_empty() { "ternary" } else { cfg.bonsai_model.trim() };
                Some(format!("bonsai-{v}"))
            }),
        ),
    };
    // Tailles par défaut : celles que chaque moteur digère le mieux.
    let (dw, dh) = if provider == "bonsai" { (768, 768) } else { (1024, 1024) };
    let w = width.filter(|v| *v >= 64).unwrap_or(dw);
    let h = height.filter(|v| *v >= 64).unwrap_or(dh);
    let bytes = generate_image_bytes(
        app,
        state,
        prompt.to_string(),
        Some(w),
        Some(h),
        None,
        None,
        backend.clone(),
        Some(provider.clone()),
        api_base,
        over.api_key.clone(),
        api_model.clone(),
    )
    .await?;

    // Rangement : sandbox de l'appelant, sinon celle du Studio d'images.
    let sandbox_id = if sandbox_id.trim().is_empty() {
        ensure_studio_sandbox(app)?
    } else {
        sandbox_id.to_string()
    };
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let path = format!("images/{}_{stamp}.png", slug_of(prompt));
    crate::sandbox::sandbox_write_binary(app.clone(), sandbox_id.clone(), path.clone(), bytes.clone())?;
    let sandbox_name = crate::sandbox::sandbox_list_unchecked(app)
        .ok()
        .and_then(|l| l.into_iter().find(|m| m.id == sandbox_id).map(|m| m.name))
        .unwrap_or_default();

    let label = provider_label(&provider, api_model.as_deref().or(backend.as_deref()).unwrap_or(""));
    let thumb = thumbnail_data_url(&bytes)
        .unwrap_or_else(|| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
    let title: String = prompt.chars().take(48).collect::<String>() + if prompt.chars().count() > 48 { "…" } else { "" };
    crate::push_notification(
        app,
        serde_json::json!({
            "kind": "info",
            "icon": "image",
            "layout": "image",
            "title": title,
            "body": label,
            "data": {
                "src": thumb,
                "prompt": prompt,
                "path": path,
                "sandbox": sandbox_name,
                "sandbox_id": sandbox_id,
                "provider": label,
                "width": w,
                "height": h,
            },
        }),
    );
    let text = format!(
        "Image générée avec {label} ({w}×{h}) et enregistrée dans la sandbox « {sandbox_name} » : {path}. \
         Elle est affichée à l'utilisateur dans la conversation et dans la capsule : ne la décris pas en détail, \
         confirme simplement en une phrase."
    );
    Ok(ImageToolResult {
        text,
        data_url: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
        path,
        sandbox_id,
        sandbox_name,
        provider: label,
    })
}

/// Commande de la barre et du bureau (outil `generate_image` via « @ »).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn live_generate_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
    prompt: String,
    width: Option<u32>,
    height: Option<u32>,
    sandbox_id: Option<String>,
    provider: Option<String>,
    api_base: Option<String>,
    api_key: Option<String>,
    api_model: Option<String>,
    backend: Option<String>,
) -> Result<ImageToolResult, String> {
    let over = GenerationOverride { provider, api_base, api_key, api_model, backend };
    generate_image_tool(&app, &state, &prompt, width, height, sandbox_id.as_deref().unwrap_or(""), Some(over)).await
}

// ===========================================================================
//  Moteur téléchargeable (Release GitHub + manifeste sur lumen-apps)
// ===========================================================================
//
// Le runtime (~400 Mo sur macOS, plusieurs Go en CUDA) n'est pas dans l'app :
// `scripts/build-bonsai-engine.sh` produit une archive par plateforme, publiée
// par `scripts/publish-bonsai-engine.sh` dans la Release « bonsai-engine » de
// Oneil974/lumen-app, et un manifeste `bonsai-engine.json` sur GitHub
// Pages (dépôt lumen-apps), avec taille et SHA-256 par cible.

const ENGINE_MANIFEST_URL: &str = "https://oneil974.github.io/lumen-apps/bonsai-engine.json";
const ENGINE_DOWNLOAD_ID: &str = "engine";

#[derive(Serialize, Clone, Default)]
pub struct BonsaiEngineRemote {
    /// Une archive existe pour cette plateforme.
    pub available: bool,
    pub target: Option<&'static str>,
    pub version: Option<String>,
    pub url: Option<String>,
    /// Archive publiée en tranches (GitHub refuse un asset ≥ 2 Gio : le cas
    /// CUDA). Téléchargées dans l'ordre puis recollées ; `size`/`sha256`
    /// décrivent l'archive entière.
    pub parts: Vec<BonsaiEnginePart>,
    pub size: u64,
    pub sha256: Option<String>,
    /// Version installée (dossier téléchargé), si présente.
    pub installed_version: Option<String>,
    pub installed: bool,
    /// Une version plus récente que celle installée est publiée.
    pub update_available: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Default)]
pub struct BonsaiEnginePart {
    pub file: String,
    pub url: String,
    pub size: u64,
    pub sha256: Option<String>,
}

async fn fetch_engine_manifest() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("lumen-bonsai/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    // `LUMEN_BONSAI_MANIFEST_URL` : manifeste de test (serveur local) en dev.
    let url = std::env::var("LUMEN_BONSAI_MANIFEST_URL").unwrap_or_else(|_| ENGINE_MANIFEST_URL.to_string());
    client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("manifeste du moteur injoignable : {e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("manifeste du moteur illisible : {e}"))
}

/// Ce que le dépôt propose pour cette plateforme, comparé à l'installation.
#[tauri::command]
pub async fn bonsai_engine_remote(app: tauri::AppHandle) -> Result<BonsaiEngineRemote, String> {
    let target = platform_target();
    let installed_dir = downloaded_engine_dir(&app).filter(|d| engine_python(d).is_file());
    let installed_version = installed_dir.as_deref().and_then(engine_version);
    let mut out = BonsaiEngineRemote {
        target,
        installed: installed_dir.is_some(),
        installed_version: installed_version.clone(),
        ..Default::default()
    };
    let Some(target) = target else {
        out.error = Some("unsupported_platform".into());
        return Ok(out);
    };
    match fetch_engine_manifest().await {
        Ok(manifest) => {
            if let Some(entry) = manifest.get("targets").and_then(|t| t.get(target)) {
                out.version = entry.get("version").and_then(|v| v.as_str()).map(String::from);
                out.url = entry.get("url").and_then(|v| v.as_str()).map(String::from);
                out.parts = entry
                    .get("parts")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|p| {
                                Some(BonsaiEnginePart {
                                    file: p.get("file")?.as_str()?.to_string(),
                                    url: p.get("url")?.as_str()?.to_string(),
                                    size: p.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                                    sha256: p.get("sha256").and_then(|v| v.as_str()).map(String::from),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                out.available = out.url.is_some() || !out.parts.is_empty();
                out.size = entry.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                out.sha256 = entry.get("sha256").and_then(|v| v.as_str()).map(String::from);
                out.update_available = match (&installed_version, &out.version) {
                    (Some(have), Some(want)) => have != want,
                    _ => false,
                };
            }
        }
        Err(e) => out.error = Some(e),
    }
    Ok(out)
}

fn sha256_of_file(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0_u8; DOWNLOAD_CHUNK];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Dézippe l'archive du moteur sous `root`. L'archive contient un dossier
/// `<cible>/` à sa racine ; les droits d'exécution Unix sont restaurés (python,
/// lanceur, .so), ce que `zip` conserve et que le crate expose par `unix_mode`.
fn extract_engine(archive: &Path, root: &Path, progress: &dyn Fn(usize, usize)) -> Result<(), String> {
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("archive illisible : {e}"))?;
    let total = zip.len().max(1);
    let mut last_emit = std::time::Instant::now();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!("chemin refusé dans l'archive : {}", entry.name()));
        };
        let target = root.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
        }
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = std::time::Instant::now();
            progress(i, total);
        }
    }
    Ok(())
}

/// Télécharge et installe le moteur pour cette plateforme (reprise du
/// transfert, vérification SHA-256, extraction dans un dossier temporaire puis
/// bascule atomique). Remplace une version précédente ; arrête le serveur
/// s'il tournait dessus.
#[tauri::command]
pub async fn bonsai_download_engine(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
) -> Result<BonsaiStatus, String> {
    let target = platform_target().ok_or_else(|| {
        "Bonsai n'est pas disponible sur cette plateforme (Apple Silicon ou GPU NVIDIA requis).".to_string()
    })?;
    if state.downloads.lock().await.contains_key(ENGINE_DOWNLOAD_ID) {
        return Err("Le moteur est déjà en cours de téléchargement.".into());
    }
    let remote = bonsai_engine_remote(app.clone()).await?;
    if !remote.available {
        return Err(remote.error.clone().unwrap_or_else(|| format!("Aucun moteur Bonsai publié pour {target}.")));
    }
    // Archive d'un seul tenant (`url`) ou en tranches (`parts`) : dans les deux
    // cas on aboutit à `final_path`, l'archive complète, vérifiée par SHA-256.
    let pieces: Vec<BonsaiEnginePart> = if remote.parts.is_empty() {
        let url = remote.url.clone().unwrap_or_default();
        vec![BonsaiEnginePart {
            file: url.rsplit('/').next().unwrap_or("engine.zip").to_string(),
            url,
            size: remote.size,
            sha256: None,
        }]
    } else {
        remote.parts.clone()
    };
    let engine_root = app_data(&app)?.join("bonsai").join("engine");
    let dl_dir = engine_root.join(".download");
    fs::create_dir_all(&dl_dir).map_err(|e| e.to_string())?;
    let file_name = pieces[0]
        .file
        .trim_end_matches(|c: char| c.is_ascii_digit())
        .trim_end_matches(".part")
        .to_string();
    let final_path = dl_dir.join(&file_name);
    let cancel = Arc::new(AtomicBool::new(false));
    state.downloads.lock().await.insert(ENGINE_DOWNLOAD_ID.to_string(), cancel.clone());

    let app2 = app.clone();
    let expected_sha = remote.sha256.clone();
    let expected_size = remote.size;
    let split = !remote.parts.is_empty();
    let result = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        if !(final_path.is_file() && fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0) == expected_size) {
            let client = reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .timeout(None)
                .user_agent("lumen-bonsai/1.0")
                .build()
                .map_err(|e| e.to_string())?;
            // Chaque tranche se télécharge (et se reprend) comme un fichier à
            // part entière ; la progression est cumulée sur l'ensemble.
            let total_all: u64 = if split { pieces.iter().map(|p| p.size).sum() } else { expected_size };
            let mut done: u64 = 0;
            for piece in &pieces {
                let piece_path = if split { dl_dir.join(&piece.file) } else { final_path.clone() };
                let part_path = dl_dir.join(format!(".{}.part", piece.file));
                let already = fs::metadata(&piece_path).map(|m| m.len()).unwrap_or(0);
                if !(piece_path.is_file() && piece.size > 0 && already == piece.size) {
                    download_one(
                        &app2, &client, &piece.url, &part_path, &piece_path, ENGINE_DOWNLOAD_ID, &piece.file, &cancel,
                        done, total_all,
                    )?;
                }
                if let Some(expected) = piece.sha256.as_deref().filter(|s| !s.is_empty()) {
                    if !sha256_of_file(&piece_path)?.eq_ignore_ascii_case(expected) {
                        let _ = fs::remove_file(&piece_path);
                        return Err(format!(
                            "Tranche « {} » corrompue (empreinte SHA-256 différente) : relance le téléchargement.",
                            piece.file
                        ));
                    }
                }
                done += piece.size;
            }
            if split {
                // Recollage en flux : jamais plus d'un tampon en mémoire.
                let tmp = dl_dir.join(format!(".{file_name}.join"));
                {
                    let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
                    for piece in &pieces {
                        let mut input = fs::File::open(dl_dir.join(&piece.file)).map_err(|e| e.to_string())?;
                        std::io::copy(&mut input, &mut out).map_err(|e| format!("recollage de l'archive : {e}"))?;
                    }
                }
                fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
                for piece in &pieces {
                    let _ = fs::remove_file(dl_dir.join(&piece.file));
                }
            }
        }
        if let Some(expected) = expected_sha.as_deref().filter(|s| !s.is_empty()) {
            let got = sha256_of_file(&final_path)?;
            if !got.eq_ignore_ascii_case(expected) {
                let _ = fs::remove_file(&final_path);
                return Err("Archive du moteur corrompue (empreinte SHA-256 différente) : relance le téléchargement.".into());
            }
        }
        Ok(final_path)
    })
    .await
    .map_err(|e| e.to_string())?;
    let archive = match result {
        Ok(p) => p,
        Err(e) => {
            state.downloads.lock().await.remove(ENGINE_DOWNLOAD_ID);
            return Err(e);
        }
    };

    // Extraction hors du dossier final, puis bascule : un moteur à moitié
    // dézippé ne doit jamais passer pour installé.
    stop_child(&state).await;
    let staging = engine_root.join(format!(".staging-{target}"));
    let dest = engine_root.join(target);
    let app3 = app.clone();
    let staging2 = staging.clone();
    let archive2 = archive.clone();
    let extracted = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _ = fs::remove_dir_all(&staging2);
        fs::create_dir_all(&staging2).map_err(|e| e.to_string())?;
        extract_engine(&archive2, &staging2, &|done, total| {
            let _ = app3.emit(
                "bonsai-download-progress",
                serde_json::json!({
                    "id": ENGINE_DOWNLOAD_ID, "phase": "extract",
                    "downloaded": done, "total": total, "percent": (done * 100 / total).min(99)
                }),
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    state.downloads.lock().await.remove(ENGINE_DOWNLOAD_ID);
    extracted?;
    let inner = staging.join(target);
    let source = if engine_python(&inner).is_file() { inner } else { staging.clone() };
    let _ = fs::remove_dir_all(&dest);
    fs::rename(&source, &dest).map_err(|e| format!("installation du moteur impossible : {e}"))?;
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&archive);
    if !engine_python(&dest).is_file() {
        let _ = fs::remove_dir_all(&dest);
        return Err("L'archive ne contient pas de runtime Python : moteur non installé.".into());
    }
    let _ = app.emit("bonsai-download-progress", serde_json::json!({ "id": ENGINE_DOWNLOAD_ID, "percent": 100 }));
    let _ = app.emit("bonsai-download-done", ENGINE_DOWNLOAD_ID);
    bonsai_status(app, state).await
}

/// Supprime le moteur téléchargé (les modèles restent).
#[tauri::command]
pub async fn bonsai_delete_engine(
    app: tauri::AppHandle,
    state: tauri::State<'_, BonsaiState>,
) -> Result<(), String> {
    if state.downloads.lock().await.contains_key(ENGINE_DOWNLOAD_ID) {
        return Err("Téléchargement du moteur en cours : annule-le d'abord.".into());
    }
    stop_child(&state).await;
    if let Some(dir) = downloaded_engine_dir(&app) {
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("Suppression impossible : {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L'archive produite par scripts/build-bonsai-engine.sh doit se dézipper
    /// avec ses droits d'exécution et son interpréteur au bon endroit. Le test
    /// ne tourne que si une archive est présente dans dist/bonsai-engine.
    #[test]
    fn engine_archive_extracts_with_runtime() {
        let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/bonsai-engine");
        let Some(target) = platform_target() else { return };
        let Some(archive) = fs::read_dir(&dist).ok().and_then(|d| {
            d.flatten()
                .map(|e| e.path())
                .find(|p| p.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with(&format!("lumen-bonsai-engine-{target}-")) && n.ends_with(".zip")))
        }) else { return };
        let manifest: serde_json::Value = serde_json::from_str(&fs::read_to_string(dist.join("bonsai-engine.json")).unwrap()).unwrap();
        let expected = manifest["targets"][target]["sha256"].as_str().unwrap();
        assert_eq!(sha256_of_file(&archive).unwrap(), expected, "empreinte du manifeste");
        let root = std::env::temp_dir().join(format!("lumen-bonsai-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        extract_engine(&archive, &root, &|_, _| {}).unwrap();
        let engine = root.join(target);
        assert!(engine_python(&engine).is_file(), "python absent");
        assert!(engine.join("lumen_bonsai_server.py").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(engine_python(&engine)).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "python non exécutable ({mode:o})");
        }
        let _ = fs::remove_dir_all(&root);
    }
}
