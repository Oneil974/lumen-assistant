//! Transcription locale par whisper.cpp (`whisper-server`, embarqué comme
//! llama-server) : Metal sur Mac, tous les cœurs ailleurs — bien plus rapide
//! que la transcription transformers.js (WASM) qui reste le repli côté WebView.
//!
//! - Binaire : `resources/whisper-server/<plateforme>/whisper-server`
//!   (scripts/build-whisper-server.sh).
//! - Modèles ggml : téléchargés depuis huggingface.co/ggerganov/whisper.cpp
//!   dans `<données>/whisper-models/`.
//! - Serveur : démarré au premier besoin sur WHISPER_PORT, arrêté après
//!   10 min sans demande (poste à 8 Go : ne pas garder un modèle pour rien).
//! - `whisper_transcribe(wav_b64, lang, model)` : un WAV 16 kHz mono encodé
//!   par la WebView ; renvoie le texte.

use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub const WHISPER_PORT: u16 = 11440;
const IDLE: Duration = Duration::from_secs(10 * 60);

/// (id, fichier, libellé, taille approximative en octets)
const MODELS: &[(&str, &str, &str, u64)] = &[
    ("tiny", "ggml-tiny-q5_1.bin", "Whisper tiny (rapide)", 32_000_000),
    ("base", "ggml-base-q5_1.bin", "Whisper base (équilibré)", 60_000_000),
    ("small", "ggml-small-q5_1.bin", "Whisper small (précis)", 190_000_000),
    ("large-v3-turbo", "ggml-large-v3-turbo-q5_0.bin", "Whisper large-v3-turbo (le plus précis)", 574_000_000),
];
const DEFAULT_MODEL: &str = "base";

struct Server {
    child: Option<Child>,
    model: String,
    last_use: Instant,
}

fn server() -> &'static Mutex<Server> {
    static S: OnceLock<Mutex<Server>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Server { child: None, model: String::new(), last_use: Instant::now() }))
}

fn platform_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "x86_64") => Some("windows-x64"),
        _ => None,
    }
}

fn exe_name() -> &'static str {
    if cfg!(target_os = "windows") { "whisper-server.exe" } else { "whisper-server" }
}

/// Binaire embarqué (mêmes emplacements candidats que llama-server).
fn binary(app: &tauri::AppHandle) -> Option<PathBuf> {
    let target = platform_target()?;
    let mut roots = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        roots.push(res.join("resources").join("whisper-server").join(target));
        roots.push(res.join("whisper-server").join(target));
    }
    if cfg!(debug_assertions) {
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("whisper-server").join(target));
    }
    // Windows/Linux : sous-dossiers de variantes (cuda, cpu) comme llama-server ;
    // CUDA seulement si une carte NVIDIA répond, sinon le binaire ne démarre pas.
    let mut variants: Vec<&str> = Vec::new();
    if !cfg!(target_os = "macos") {
        if nvidia_present() { variants.push("cuda"); }
        variants.push("cpu");
    }
    for root in &roots {
        for v in &variants {
            let p = root.join(v).join(exe_name());
            // CUDA : seulement si ses DLL cuBLAS sont trouvables (à côté, ou
            // chez llama-server) ; sinon le processus ne démarrerait pas.
            if p.is_file() && (*v != "cuda" || has_cublas(root.join(v).as_path()) || shared_cuda_dir(app, &p).is_some()) {
                return Some(p);
            }
        }
        let p = root.join(exe_name());
        if p.is_file() { return Some(p); }
    }
    None
}

fn has_cublas(d: &std::path::Path) -> bool {
    fs::read_dir(d).ok().map_or(false, |rd| rd.flatten().any(|e| {
        e.file_name().to_string_lossy().to_ascii_lowercase().starts_with("cublas64_")
    }))
}

/// Dossier qui porte les DLL cuBLAS pour la variante CUDA de whisper-server :
/// celui de llama-server (même Toolkit, mêmes DLL). `None` hors variante CUDA
/// ou si le binaire a ses propres DLL à côté.
fn shared_cuda_dir(app: &tauri::AppHandle, bin: &std::path::Path) -> Option<PathBuf> {
    let parent = bin.parent()?;
    if parent.file_name()?.to_str()? != "cuda" {
        return None;
    }
    if has_cublas(parent) {
        return None;
    }
    let target = platform_target()?;
    let mut roots = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        roots.push(res.join("resources").join("llama-server").join(target).join("cuda"));
        roots.push(res.join("llama-server").join(target).join("cuda"));
    }
    if cfg!(debug_assertions) {
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("llama-server").join(target).join("cuda"));
    }
    roots.into_iter().find(|d| has_cublas(d.as_path()))
}

/// Carte NVIDIA utilisable (pilote présent) ; mémorisé pour la session.
fn nvidia_present() -> bool {
    static NV: OnceLock<bool> = OnceLock::new();
    *NV.get_or_init(|| {
        let mut cmd = Command::new("nvidia-smi");
        cmd.args(["--query-gpu=name", "--format=csv,noheader"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.output().map(|o| o.status.success() && !o.stdout.is_empty()).unwrap_or(false)
    })
}

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?.join("whisper-models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_entry(id: &str) -> Option<&'static (&'static str, &'static str, &'static str, u64)> {
    MODELS.iter().find(|m| m.0 == id)
}

fn model_path(app: &tauri::AppHandle, id: &str) -> Option<PathBuf> {
    let (_, file, _, _) = model_entry(id)?;
    let p = models_dir(app).ok()?.join(file);
    p.is_file().then_some(p)
}

#[derive(Serialize)]
pub struct ModelView {
    id: &'static str,
    label: &'static str,
    size: u64,
    installed: bool,
}

#[derive(Serialize)]
pub struct WhisperStatus {
    /// Binaire whisper-server présent dans cette build de Lumen.
    binary: bool,
    /// Au moins un modèle installé : la transcription native est possible.
    ready: bool,
    running: bool,
    running_model: String,
    default_model: &'static str,
    models: Vec<ModelView>,
}

fn is_running(s: &mut Server) -> bool {
    match s.child.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true,
        Some(_) => { s.child = None; false }
        None => false,
    }
}

#[tauri::command]
pub fn whisper_native_status(app: tauri::AppHandle) -> WhisperStatus {
    let models: Vec<ModelView> = MODELS
        .iter()
        .map(|(id, _, label, size)| ModelView { id, label, size: *size, installed: model_path(&app, id).is_some() })
        .collect();
    let mut s = server().lock().unwrap();
    let running = is_running(&mut s);
    let binary = binary(&app).is_some();
    WhisperStatus {
        binary,
        ready: binary && models.iter().any(|m| m.installed),
        running,
        running_model: if running { s.model.clone() } else { String::new() },
        default_model: DEFAULT_MODEL,
        models,
    }
}

/// Télécharge un modèle ggml (progression : évènement `whisper-download`).
#[tauri::command]
pub async fn whisper_download_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let (_, file, _, _) = *model_entry(&id).ok_or_else(|| format!("Modèle inconnu : {id}"))?;
    let dir = models_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}");
        let part = dir.join(format!(".{file}.part"));
        let mut resp = reqwest::blocking::Client::builder()
            .timeout(None::<Duration>)
            .build()
            .map_err(|e| e.to_string())?
            .get(&url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Téléchargement impossible : {e}"))?;
        let total = resp.content_length().unwrap_or(0);
        let mut out = File::create(&part).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 16];
        let (mut done, mut last_pct) = (0u64, -1i64);
        loop {
            let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            let pct = if total > 0 { (done * 100 / total) as i64 } else { -1 };
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit("whisper-download", serde_json::json!({ "id": id, "pct": pct, "done": done, "total": total }));
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        fs::rename(&part, dir.join(file)).map_err(|e| e.to_string())?;
        let _ = app.emit("whisper-download", serde_json::json!({ "id": id, "pct": 100, "finished": true }));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn whisper_delete_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut s = server().lock().unwrap();
    if s.model == id {
        stop(&mut s);
    }
    if let Some(p) = model_path(&app, &id) {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn stop(s: &mut Server) {
    if let Some(mut c) = s.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    s.model.clear();
}

/// Arrêt à la fermeture de Lumen (aucun orphelin sur WHISPER_PORT).
pub fn shutdown() {
    if let Ok(mut s) = server().lock() {
        stop(&mut s);
    }
}

/// Modèle à utiliser : celui demandé s'il est installé, sinon le plus gros installé.
fn resolve_model(app: &tauri::AppHandle, wanted: &str) -> Option<String> {
    if !wanted.is_empty() && model_path(app, wanted).is_some() {
        return Some(wanted.to_string());
    }
    MODELS.iter().rev().find(|m| model_path(app, m.0).is_some()).map(|m| m.0.to_string())
}

/// Démarre (ou réutilise) le serveur sur ce modèle ; bloquant.
fn ensure_server(app: &tauri::AppHandle, model: &str) -> Result<(), String> {
    let mut s = server().lock().unwrap();
    s.last_use = Instant::now();
    if is_running(&mut s) && s.model == model {
        return Ok(());
    }
    stop(&mut s);
    let bin = binary(app).ok_or("whisper-server n'est pas embarqué dans cette build de Lumen.")?;
    let path = model_path(app, model).ok_or("Modèle Whisper non installé.")?;
    let log_dir = crate::paths::shared_log_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log = File::create(log_dir.join("whisper-server.log")).map_err(|e| e.to_string())?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    let mut cmd = Command::new(&bin);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    // Variante CUDA : les DLL cuBLAS (~500 Mo) ne sont livrées qu'une fois, à
    // côté de llama-server. Windows cherche les DLL dans le dossier de
    // l'exécutable puis dans le PATH : on y ajoute le dossier CUDA de llama.
    if let Some(dir) = shared_cuda_dir(app, &bin) {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs = vec![dir];
        dirs.extend(std::env::split_paths(&path));
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
    let child = cmd
        .arg("--model").arg(&path)
        .arg("--host").arg("127.0.0.1")
        .arg("--port").arg(WHISPER_PORT.to_string())
        .arg("--threads").arg(threads.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("Impossible de démarrer whisper-server : {e}"))?;
    s.child = Some(child);
    s.model = model.to_string();
    drop(s);
    // Prêt quand le port accepte une connexion (chargement du modèle : quelques secondes).
    let started = Instant::now();
    loop {
        if std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], WHISPER_PORT).into(), Duration::from_millis(300)).is_ok() {
            break;
        }
        let mut s = server().lock().unwrap();
        if !is_running(&mut s) {
            return Err("whisper-server s'est arrêté au démarrage (voir whisper-server.log).".into());
        }
        drop(s);
        if started.elapsed() > Duration::from_secs(60) {
            shutdown();
            return Err("whisper-server ne répond pas après 60 s.".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Surveillance d'inactivité : une tâche par démarrage.
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(30));
        let mut s = match server().lock() { Ok(s) => s, Err(_) => return };
        if !is_running(&mut s) { return; }
        if s.last_use.elapsed() >= IDLE { stop(&mut s); return; }
    });
    Ok(())
}

/// Précharge le modèle (appelé avant d'ouvrir le micro : pas d'attente au vol).
#[tauri::command]
pub async fn whisper_warmup(app: tauri::AppHandle, model: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let m = resolve_model(&app, model.as_deref().unwrap_or("")).ok_or("Aucun modèle Whisper installé.")?;
        ensure_server(&app, &m)?;
        Ok(m)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Transcrit un WAV (base64). `lang` : « fr », « en »… ou « auto ».
#[tauri::command]
pub async fn whisper_transcribe(app: tauri::AppHandle, wav_b64: String, lang: Option<String>, model: Option<String>) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let wav = STANDARD.decode(wav_b64.as_bytes()).map_err(|e| format!("audio invalide : {e}"))?;
    let lang = lang.unwrap_or_else(|| "auto".into());
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let m = resolve_model(&app, model.as_deref().unwrap_or("")).ok_or("Aucun modèle Whisper installé.")?;
        ensure_server(&app, &m)?;
        let form = reqwest::blocking::multipart::Form::new()
            .part("file", reqwest::blocking::multipart::Part::bytes(wav).file_name("audio.wav").mime_str("audio/wav").map_err(|e| e.to_string())?)
            .text("response_format", "json")
            .text("temperature", "0.0")
            .text("language", lang);
        let resp = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?
            .post(format!("http://127.0.0.1:{WHISPER_PORT}/inference"))
            .multipart(form)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("whisper-server : {e}"))?;
        let body: serde_json::Value = resp.json().map_err(|e| format!("réponse illisible : {e}"))?;
        if let Ok(mut s) = server().lock() { s.last_use = Instant::now(); }
        if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }
        Ok(body.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
