//! Messagerie interne « façon e-mail ». Les agents y postent des messages quand
//! ils terminent une tâche (voir `agents.rs`), et l'utilisateur peut y répondre :
//! une réponse crée une tâche dans la todo de l'agent concerné (côté front, via
//! `agent_add_task`), avec l'historique utile du message + la demande.
//!
//! Persistance « opaque » comme `kanban.rs` : un blob JSON (tableau de messages)
//! dans `app_data_dir/inbox.json`, rediffusé via l'évènement `inbox-updated`
//! pour garder les fenêtres ouvertes synchronisées.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[derive(Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub ts: u64,
    pub from: String,
    #[serde(default, rename = "fromId")]
    pub from_id: String,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub read: bool,
    /// Contexte de la tâche d'origine (pour reconstituer une todo à la réponse).
    #[serde(default)]
    pub task: serde_json::Value,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn inbox_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("inbox.json"))
}

fn read_all(app: &tauri::AppHandle) -> Vec<Message> {
    inbox_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_all(app: &tauri::AppHandle, msgs: &[Message]) -> Result<(), String> {
    let data = serde_json::to_string(msgs).map_err(|e| e.to_string())?;
    fs::write(inbox_path(app)?, &data).map_err(|e| e.to_string())?;
    let _ = app.emit("inbox-updated", ());
    Ok(())
}

/// Poste un message dans la boîte (helper interne, appelé par les agents). Borne
/// la boîte à 500 messages pour ne pas grossir indéfiniment.
pub fn post(
    app: &tauri::AppHandle,
    from: &str,
    from_id: &str,
    subject: &str,
    body: &str,
    task: serde_json::Value,
) {
    let mut msgs = read_all(app);
    msgs.insert(
        0,
        Message {
            id: format!("msg-{}", now_ms()),
            ts: now_ms() / 1000,
            from: from.to_string(),
            from_id: from_id.to_string(),
            subject: subject.to_string(),
            body: body.to_string(),
            read: false,
            task,
        },
    );
    msgs.truncate(500);
    let _ = write_all(app, &msgs);
}

/// Charge la boîte (JSON brut). Vide si rien encore.
#[tauri::command]
pub fn inbox_load(app: tauri::AppHandle) -> Result<String, String> {
    Ok(fs::read_to_string(inbox_path(&app)?).unwrap_or_default())
}

/// Remplace l'intégralité de la boîte (le front gère lu/non-lu, suppression…).
#[tauri::command]
pub fn inbox_save(app: tauri::AppHandle, data: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&data).map_err(|e| format!("JSON invalide : {e}"))?;
    fs::write(inbox_path(&app)?, &data).map_err(|e| e.to_string())?;
    let _ = app.emit("inbox-updated", ());
    Ok(())
}

/// Poste un message depuis le front (compose manuel ou tests).
#[tauri::command]
pub fn inbox_post(
    app: tauri::AppHandle,
    from: String,
    from_id: Option<String>,
    subject: String,
    body: String,
) -> Result<(), String> {
    post(
        &app,
        &from,
        &from_id.unwrap_or_default(),
        &subject,
        &body,
        serde_json::Value::Null,
    );
    Ok(())
}
