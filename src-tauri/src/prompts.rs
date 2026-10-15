//! Prompts système personnalisables de Lumen.
//!
//! Les consignes système sont écrites en dur au plus près de leur usage — dans
//! les mini-apps (JS) comme dans les surfaces sans fenêtre (agents, passerelle
//! Telegram). Ce module ne les déplace pas : il ajoute une couche de
//! REMPLACEMENT, indexée par identifiant stable, que l'utilisateur alimente
//! depuis Paramètres → Modèles → « Prompts système ».
//!
//! Chaque point d'appel garde donc son texte par défaut et se contente de le
//! passer à `resolve()` : sans remplacement enregistré, rien ne change.
//!
//! Stockage : `app_data_dir/prompts.json` — un simple objet {id: texte}. Les
//! prompts côté WebView sont eux gardés en localStorage (`lumenPrompts`) ; les
//! Paramètres écrivent dans les deux pour que les deux mondes restent alignés.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Cache mémoire : `resolve()` est appelé à chaque tour d'agent, on ne relit
/// pas le disque à chaque fois. Invalidé par `prompt_overrides_set`.
static CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Défauts déjà observés, pour que la boîte de dialogue puisse afficher le
/// texte d'origine d'un prompt qu'elle ne peut pas lire (il vit dans le code
/// Rust, et dépend de la langue et du contexte de l'appel).
static DEFAULTS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    file(app, "prompts.json")
}

fn defaults_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    file(app, "prompt_defaults.json")
}

fn file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn read_map(path: Result<PathBuf, String>) -> HashMap<String, String> {
    path.ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn read(app: &tauri::AppHandle) -> HashMap<String, String> {
    read_map(path(app))
}

/// Mémorise le défaut observé pour cet identifiant. N'écrit que lorsqu'il
/// change réellement : `resolve()` est sur le chemin chaud des agents.
fn note_default(app: &tauri::AppHandle, id: &str, default: &str) {
    let Ok(mut guard) = DEFAULTS.lock() else { return };
    let map = guard.get_or_insert_with(|| read_map(defaults_path(app)));
    if map.get(id).map(String::as_str) == Some(default) {
        return;
    }
    map.insert(id.to_string(), default.to_string());
    if let (Ok(target), Ok(json)) = (defaults_path(app), serde_json::to_string_pretty(&*map)) {
        let _ = fs::write(target, json);
    }
}

/// Texte à utiliser pour ce prompt : le remplacement de l'utilisateur s'il en a
/// enregistré un et qu'il n'est pas vide, sinon le défaut du point d'appel.
pub fn resolve(app: &tauri::AppHandle, id: &str, default: &str) -> String {
    note_default(app, id, default);
    let mut cache = match CACHE.lock() {
        Ok(guard) => guard,
        // Un verrou empoisonné ne doit pas priver l'agent de sa consigne.
        Err(_) => return default.to_string(),
    };
    let map = cache.get_or_insert_with(|| read(app));
    match map.get(id).map(|s| s.trim()) {
        Some(custom) if !custom.is_empty() => custom.to_string(),
        _ => default.to_string(),
    }
}

/// Défauts observés côté Rust, pour l'affichage des réglages.
#[tauri::command]
pub fn prompt_defaults_get(app: tauri::AppHandle) -> HashMap<String, String> {
    read_map(defaults_path(&app))
}

/// Tous les remplacements enregistrés (pour peupler la boîte de dialogue).
#[tauri::command]
pub fn prompt_overrides_get(app: tauri::AppHandle) -> HashMap<String, String> {
    read(&app)
}

/// Remplace l'ensemble des remplacements. Le front envoie la carte complète :
/// un identifiant absent (ou vide) signifie « revenir au défaut ».
#[tauri::command]
pub fn prompt_overrides_set(
    app: tauri::AppHandle,
    overrides: HashMap<String, String>,
) -> Result<(), String> {
    let cleaned: HashMap<String, String> = overrides
        .into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .collect();
    let json = serde_json::to_string_pretty(&cleaned).map_err(|e| e.to_string())?;
    fs::write(path(&app)?, json).map_err(|e| e.to_string())?;
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some(cleaned);
    }
    Ok(())
}
