//! Journal global des agissements des LLM. Chaque appel de modèle, appel
//! d'outil (skill), délégation à un sous-agent, création/amélioration de skill
//! ou escalade de budget y laisse une trace — quel que soit le point d'entrée
//! (boucle agentique, chat de la barre, routeur, apps du bureau via
//! `llm_log_push`). Consulté par l'app « Journal LLM » et son widget de bureau.
//!
//! Stockage : `app_data_dir/llm_log.json`, liste plafonnée (plus récent en
//! tête). Chaque ajout émet l'événement `llm-log` pour les vues en direct.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

const MAX_ENTRIES: usize = 1000;

/// Une entrée du journal. `kind` structure le filtrage côté UI :
/// - "call"       : appel LLM (une requête au modèle)
/// - "tool"       : exécution d'un outil/skill par un agent
/// - "delegation" : délégation d'une tâche à un sous-agent
/// - "skill"      : création/amélioration/rollback d'un skill par un agent
/// - "escalation" : budget épuisé, escalade vers l'utilisateur
/// - "compaction" : compaction du contexte d'une boucle agentique
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct LogEntry {
    pub ts: u64,
    pub kind: String,
    /// Origine humaine ("Agent Veille", "Chat Lumen", "Routeur"…).
    pub source: String,
    /// Id machine de l'origine (agent id, "chat", "router"…), pour filtrer.
    #[serde(default)]
    pub source_id: String,
    /// Modèle utilisé (vide si non applicable).
    #[serde(default)]
    pub model: String,
    /// Détail lisible (tâche, nom d'outil + entrée, raison d'escalade…).
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub gen_tokens: u64,
    #[serde(default)]
    pub success: bool,
}

/// Poignée globale, posée au `setup` : les appels LLM natifs (boucle
/// agentique, Telegram, routeur, distillation…) passent par des fonctions
/// bloquantes sans `AppHandle`, et doivent pourtant remonter leurs jetons au
/// compteur journalier du front.
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// Jetons d'une réponse (prompt, générés), contrats Ollama et OpenAI confondus.
pub fn usage_of_response(resp: &serde_json::Value) -> (u64, u64) {
    let u = resp.get("usage");
    let prompt = resp
        .get("prompt_eval_count")
        .and_then(|v| v.as_u64())
        .or_else(|| u.and_then(|u| u.get("prompt_tokens")).and_then(|v| v.as_u64()))
        .unwrap_or(0);
    let gen = resp
        .get("eval_count")
        .and_then(|v| v.as_u64())
        .or_else(|| u.and_then(|u| u.get("completion_tokens")).and_then(|v| v.as_u64()))
        .unwrap_or(0);
    (prompt, gen)
}

/// Signale au front une génération faite NATIVEMENT (sans passer par la
/// WebView) pour qu'elle rejoigne le compteur « Tokens du jour ». Événement
/// `llm-usage`, distinct de `llm-log` : il ne touche pas au Journal, que les
/// sites concernés alimentent déjà quand c'est pertinent.
pub fn emit_native_usage(resp: &serde_json::Value, source: &str) {
    let (prompt_tokens, gen_tokens) = usage_of_response(resp);
    if prompt_tokens == 0 && gen_tokens == 0 {
        return;
    }
    let Some(app) = APP.get() else { return; };
    let model = resp.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // Ciblé sur la fenêtre principale UNIQUEMENT : le compteur vit dans le
    // localStorage partagé, un émetteur par fenêtre compterait N fois.
    let _ = app.emit_to(
        "main",
        "llm-usage",
        serde_json::json!({
            "source": source,
            "model": model,
            "prompt_tokens": prompt_tokens,
            "gen_tokens": gen_tokens,
        }),
    );
}

fn log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("llm_log.json"))
}

fn read_log(app: &tauri::AppHandle) -> Vec<LogEntry> {
    log_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_log(app: &tauri::AppHandle, list: &[LogEntry]) -> Result<(), String> {
    let s = serde_json::to_string(list).map_err(|e| e.to_string())?;
    fs::write(log_path(app)?, s).map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Tronque sur frontières de caractères (les détails peuvent être verbeux).
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// Ajoute une entrée (best-effort : le journal ne doit jamais faire échouer
/// l'action journalisée). Émet `llm-log` pour les vues en direct.
pub fn log(app: &tauri::AppHandle, mut entry: LogEntry) {
    static LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let Ok(_guard) = LOG_LOCK.lock() else { return; };
    if entry.ts == 0 {
        entry.ts = now_secs();
    }
    entry.detail = clip(&entry.detail, 800);
    let mut list = read_log(app);
    list.insert(0, entry.clone());
    list.truncate(MAX_ENTRIES);
    let _ = write_log(app, &list);
    let _ = app.emit("llm-log", &entry);
}

/// Liste le journal (plus récent en tête), éventuellement filtré par `kind`.
#[tauri::command]
pub fn llm_log_list(app: tauri::AppHandle, kind: Option<String>) -> Vec<LogEntry> {
    let list = read_log(&app);
    match kind.filter(|k| !k.is_empty()) {
        Some(k) => list.into_iter().filter(|e| e.kind == k).collect(),
        None => list,
    }
}

/// Vide le journal.
#[tauri::command]
pub fn llm_log_clear(app: tauri::AppHandle) -> Result<(), String> {
    write_log(&app, &[])?;
    let _ = app.emit("llm-log-cleared", ());
    Ok(())
}

/// Point d'entrée pour le frontend (chat de la barre, apps du bureau) : les
/// appels LLM faits côté WebView sont poussés ici pour rejoindre le journal
/// global. cf. `src/ollama-usage.js` (recordOllamaUsage).
#[tauri::command]
pub fn llm_log_push(
    app: tauri::AppHandle,
    kind: String,
    source: String,
    source_id: Option<String>,
    model: Option<String>,
    detail: Option<String>,
    prompt_tokens: Option<u64>,
    gen_tokens: Option<u64>,
    success: Option<bool>,
) {
    log(
        &app,
        LogEntry {
            ts: 0,
            kind,
            source,
            source_id: source_id.unwrap_or_default(),
            model: model.unwrap_or_default(),
            detail: detail.unwrap_or_default(),
            prompt_tokens: prompt_tokens.unwrap_or(0),
            gen_tokens: gen_tokens.unwrap_or(0),
            success: success.unwrap_or(true),
        },
    );
}
