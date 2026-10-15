//! Reranking des passages (base de connaissances, coffre, projets).
//!
//! La recherche hybride (BM25 + vecteurs, rag.rs) ramène des candidats ; un
//! petit modèle « cross-encoder » les relit en entier face à la question et les
//! reclasse. C'est l'étape qui améliore le plus la qualité des réponses
//! documentées, pour un coût faible (quelques dizaines de passages).
//!
//! Moteur : llama-server en mode `--reranking` (endpoint /v1/rerank), sur
//! RERANK_PORT, démarré au premier besoin et arrêté après 10 min d'inactivité.
//! Modèles GGUF multilingues téléchargés dans `<données>/rerank-models/`.
//! Sans modèle installé, la recherche garde son classement hybride.

use serde::Serialize;
use serde_json::json;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub const RERANK_PORT: u16 = 11441;
const IDLE: Duration = Duration::from_secs(10 * 60);

/// (id, fichier, URL, libellé, taille)
const MODELS: &[(&str, &str, &str, &str, u64)] = &[
    ("bge-m3", "bge-reranker-v2-m3-Q4_K_M.gguf",
     "https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q4_K_M.gguf",
     "BGE reranker v2 m3 (multilingue, recommandé)", 438_376_864),
    ("qwen3-0.6b", "qwen3-reranker-0.6b-q8_0.gguf",
     "https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/main/qwen3-reranker-0.6b-q8_0.gguf",
     "Qwen3 Reranker 0.6B (multilingue)", 639_153_184),
];

struct Server { child: Option<Child>, model: String, last_use: Instant }
fn server() -> &'static Mutex<Server> {
    static S: OnceLock<Mutex<Server>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Server { child: None, model: String::new(), last_use: Instant::now() }))
}

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?.join("rerank-models");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}
fn model_path(app: &tauri::AppHandle, id: &str) -> Option<PathBuf> {
    let m = MODELS.iter().find(|m| m.0 == id)?;
    let p = models_dir(app).ok()?.join(m.1);
    p.is_file().then_some(p)
}
fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::paths::shared_data_dir(app.path()).ok().map(|d| d.join("rerank.json"))
}
#[derive(Serialize, serde::Deserialize, Default, Clone)]
pub struct RerankConfig {
    #[serde(default = "yes")] pub enabled: bool,
    #[serde(default)] pub model: String,
}
fn yes() -> bool { true }
pub fn read_config(app: &tauri::AppHandle) -> RerankConfig {
    config_path(app).and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(RerankConfig { enabled: true, model: String::new() })
}

/// Modèle actif : celui choisi s'il est installé, sinon le premier installé.
fn active_model(app: &tauri::AppHandle) -> Option<String> {
    let cfg = read_config(app);
    if !cfg.enabled { return None; }
    if !cfg.model.is_empty() && model_path(app, &cfg.model).is_some() { return Some(cfg.model); }
    MODELS.iter().find(|m| model_path(app, m.0).is_some()).map(|m| m.0.to_string())
}

/// Reranking disponible (réglage actif + modèle installé + binaire llama-server) ?
pub fn available(app: &tauri::AppHandle) -> bool {
    active_model(app).is_some() && crate::llama::server_binary(app).is_ok()
}

fn is_running(s: &mut Server) -> bool {
    match s.child.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true,
        Some(_) => { s.child = None; false }
        None => false,
    }
}
fn stop(s: &mut Server) {
    if let Some(mut c) = s.child.take() { let _ = c.kill(); let _ = c.wait(); }
    s.model.clear();
}
pub fn shutdown() { if let Ok(mut s) = server().lock() { stop(&mut s); } }

fn ensure_server(app: &tauri::AppHandle, model: &str) -> Result<(), String> {
    let mut s = server().lock().unwrap();
    s.last_use = Instant::now();
    if is_running(&mut s) && s.model == model { return Ok(()); }
    stop(&mut s);
    crate::llama::free_port(RERANK_PORT);
    let (bin, backend) = crate::llama::server_binary(app)?;
    let path = model_path(app, model).ok_or("Modèle de reranking non installé.")?;
    let log_dir = crate::paths::shared_log_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log = File::create(log_dir.join("llama-rerank.log")).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(bin);
    crate::llama::quiet_command(&mut cmd);
    cmd.arg("--model").arg(&path)
        .arg("--host").arg("127.0.0.1")
        .arg("--port").arg(RERANK_PORT.to_string())
        .arg("--reranking")
        .arg("--ctx-size").arg("8192")
        .arg("--ubatch-size").arg("2048").arg("--batch-size").arg("2048");
    if backend != "cpu" { cmd.arg("--n-gpu-layers").arg("999"); }
    let child = cmd.stdout(Stdio::null()).stderr(Stdio::from(log)).spawn()
        .map_err(|e| format!("Impossible de démarrer le reranker : {e}"))?;
    s.child = Some(child);
    s.model = model.to_string();
    drop(s);
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(2)).build().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if client.get(format!("http://127.0.0.1:{RERANK_PORT}/health")).send().map(|r| r.status().is_success()).unwrap_or(false) { break; }
        { let mut s = server().lock().unwrap(); if !is_running(&mut s) { return Err("Le reranker s'est arrêté au démarrage (voir llama-rerank.log).".into()); } }
        if started.elapsed() > Duration::from_secs(90) { shutdown(); return Err("Le reranker ne répond pas.".into()); }
        std::thread::sleep(Duration::from_millis(250));
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(30));
        let mut s = match server().lock() { Ok(s) => s, Err(_) => return };
        if !is_running(&mut s) { return; }
        if s.last_use.elapsed() >= IDLE { stop(&mut s); return; }
    });
    Ok(())
}

/// Reclasse `docs` face à `query`. Renvoie les indices dans l'ordre de
/// pertinence avec leur score. Bloquant (appelé depuis spawn_blocking).
pub fn rerank_blocking(app: &tauri::AppHandle, query: &str, docs: &[String]) -> Result<Vec<(usize, f32)>, String> {
    let model = active_model(app).ok_or("aucun modèle de reranking")?;
    ensure_server(app, &model)?;
    // Passages tronqués : le cross-encoder n'a besoin que du début utile.
    let docs: Vec<String> = docs.iter().map(|d| d.chars().take(2000).collect()).collect();
    let resp = reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?
        .post(format!("http://127.0.0.1:{RERANK_PORT}/v1/rerank"))
        .json(&json!({ "query": query, "documents": docs, "top_n": docs.len() }))
        .send().and_then(|r| r.error_for_status()).map_err(|e| format!("reranker : {e}"))?;
    let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    if let Ok(mut s) = server().lock() { s.last_use = Instant::now(); }
    let mut out: Vec<(usize, f32)> = body.get("results").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|x| {
        Some((x.get("index")?.as_u64()? as usize, x.get("relevance_score")?.as_f64()? as f32))
    }).collect()).unwrap_or_default();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

// ---------------------------------------------------------------- Commandes
#[derive(Serialize)]
pub struct RerankStatus { enabled: bool, model: String, running: bool, binary: bool, models: Vec<serde_json::Value> }

#[tauri::command]
pub fn rerank_status(app: tauri::AppHandle) -> RerankStatus {
    let cfg = read_config(&app);
    let running = server().lock().map(|mut s| is_running(&mut s)).unwrap_or(false);
    RerankStatus {
        enabled: cfg.enabled,
        model: active_model(&app).unwrap_or_default(),
        running,
        binary: crate::llama::server_binary(&app).is_ok(),
        models: MODELS.iter().map(|(id, _, _, label, size)| json!({ "id": id, "label": label, "size": size, "installed": model_path(&app, id).is_some() })).collect(),
    }
}

#[tauri::command]
pub fn rerank_config_set(app: tauri::AppHandle, enabled: bool, model: String) -> Result<(), String> {
    let p = config_path(&app).ok_or("dossier de données introuvable")?;
    fs::write(p, serde_json::to_string_pretty(&RerankConfig { enabled, model }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if !enabled { shutdown(); }
    Ok(())
}

#[tauri::command]
pub async fn rerank_download_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let (_, file, url, _, _) = *MODELS.iter().find(|m| m.0 == id).ok_or("modèle inconnu")?;
    let dir = models_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let part = dir.join(format!(".{file}.part"));
        let mut resp = reqwest::blocking::Client::builder().timeout(None::<Duration>).build().map_err(|e| e.to_string())?
            .get(url).send().and_then(|r| r.error_for_status()).map_err(|e| format!("Téléchargement impossible : {e}"))?;
        let total = resp.content_length().unwrap_or(0);
        let mut out = File::create(&part).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 16];
        let (mut done, mut last) = (0u64, -1i64);
        loop {
            let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            let pct = if total > 0 { (done * 100 / total) as i64 } else { -1 };
            if pct != last { last = pct; let _ = app.emit("rerank-download", json!({ "id": id, "pct": pct })); }
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        fs::rename(&part, dir.join(file)).map_err(|e| e.to_string())?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn rerank_delete_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    shutdown();
    if let Some(p) = model_path(&app, &id) { fs::remove_file(p).map_err(|e| e.to_string())?; }
    Ok(())
}
