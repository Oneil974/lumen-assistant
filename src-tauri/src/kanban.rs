//! Tableau Kanban collaboratif. Persistance volontairement « opaque » : le front
//! détient le modèle (colonnes, cartes, assignés, commentaires) et envoie/reçoit
//! le tableau sous forme de JSON brut. Le backend ne fait que stocker le blob
//! dans `app_data_dir/kanban.json` (comme `agents.rs` pour les agents) et le
//! rediffuser aux autres fenêtres/appareils pour la dimension collaborative.
//!
//! L'IA (traitement des cartes de la colonne « à traiter ») est gérée côté front
//! via Ollama, exactement comme l'explorateur de sandboxes : aucun secret ni
//! appel réseau n'est nécessaire ici.

use std::fs;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

fn kanban_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("kanban.json"))
}

/// Charge le tableau (JSON brut). Renvoie une chaîne vide si rien n'est encore
/// enregistré : le front initialise alors un tableau par défaut.
#[tauri::command]
pub fn kanban_load(app: tauri::AppHandle) -> Result<String, String> {
    let p = kanban_path(&app)?;
    Ok(fs::read_to_string(p).unwrap_or_default())
}

/// Enregistre le tableau et le rediffuse à toutes les fenêtres ouvertes (event
/// `kanban-updated`) pour que les vues déjà ouvertes restent synchronisées —
/// socle de la collaboration multi-fenêtres (et multi-appareils via le companion).
#[tauri::command]
pub fn kanban_save(
    app: tauri::AppHandle,
    data: String,
    origin: Option<String>,
) -> Result<(), String> {
    // Validation légère : on refuse d'écrire un JSON corrompu.
    serde_json::from_str::<serde_json::Value>(&data).map_err(|e| format!("JSON invalide : {e}"))?;
    fs::write(kanban_path(&app)?, &data).map_err(|e| e.to_string())?;
    // `origin` identifie l'émetteur pour qu'il ignore son propre echo côté front.
    let payload = serde_json::json!({ "data": data, "origin": origin.unwrap_or_default() });
    let _ = app.emit("kanban-updated", payload);
    Ok(())
}

/// Ajoute une carte au tableau (outil des agents `kanban_add_card`). La colonne
/// est retrouvée par son nom (sans casse ; créée si absente, « À faire » par
/// défaut) et le projet devient l'étiquette de la carte — c'est ce que lit le
/// rituel du matin pour l'avancement des projets.
pub fn add_card(app: &tauri::AppHandle, title: &str, desc: &str, column: &str, project: &str) -> Result<String, String> {
    use serde_json::{json, Value};
    let p = kanban_path(app)?;
    let mut board: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap_or_default())
        .unwrap_or_else(|_| json!({ "name": "Tableau", "members": [], "columns": [], "cards": [] }));
    if !board.is_object() { board = json!({ "name": "Tableau", "members": [], "columns": [], "cards": [] }); }
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let col_name = if column.trim().is_empty() { "À faire" } else { column.trim() };
    if !board["columns"].is_array() { board["columns"] = json!([]); }
    if !board["cards"].is_array() { board["cards"] = json!([]); }
    let existing = board["columns"].as_array().unwrap().iter()
        .find(|c| c["title"].as_str().map(|t| t.to_lowercase() == col_name.to_lowercase()).unwrap_or(false))
        .and_then(|c| c["id"].as_str().map(String::from));
    let col_id = match existing {
        Some(id) => id,
        None => {
            let id = format!("col{ms:x}");
            board["columns"].as_array_mut().unwrap().push(json!({ "id": id, "title": col_name, "ai": false }));
            id
        }
    };
    let assignee = board["members"].get(0).and_then(|m| m["id"].as_str()).unwrap_or("").to_string();
    let labels: Vec<&str> = if project.trim().is_empty() { vec![] } else { vec![project.trim()] };
    let n = board["cards"].as_array().map(|a| a.len()).unwrap_or(0);
    board["cards"].as_array_mut().unwrap().push(json!({
        "id": format!("c{ms:x}{n}"),
        "colId": col_id, "title": title, "desc": desc, "assignee": assignee, "labels": labels,
        "comments": [], "aiProcessed": false, "created": ms,
    }));
    let data = board.to_string();
    fs::write(&p, &data).map_err(|e| e.to_string())?;
    let _ = app.emit("kanban-updated", json!({ "data": data, "origin": "agent" }));
    Ok(col_name.to_string())
}
