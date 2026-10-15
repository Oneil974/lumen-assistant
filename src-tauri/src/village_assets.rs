//! Bibliothèque d'assets du Village des agents. L'utilisateur importe ses propres
//! images (avatars, maisons, tuiles, décors, props) ; elles sont persistées et
//! réutilisables. Le front envoie directement une **dataURL** (lue via FileReader),
//! on la stocke telle quelle dans `village_assets.json` — pas de décodage côté Rust.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct Asset {
    pub id: String,
    pub name: String,
    /// "avatar" | "house" | "tile" | "decor" | "prop"
    pub kind: String,
    /// Image encodée en dataURL (data:image/png;base64,…).
    pub data: String,
    #[serde(default)]
    pub w: u32,
    #[serde(default)]
    pub h: u32,
    #[serde(default)]
    pub created: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn assets_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("village_assets.json"))
}

fn read_assets(app: &tauri::AppHandle) -> Vec<Asset> {
    assets_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_assets(app: &tauri::AppHandle, list: &[Asset]) -> Result<(), String> {
    let p = assets_path(app)?;
    let s = serde_json::to_string(list).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}

/// Liste tous les assets importés.
#[tauri::command]
pub fn village_assets_list(app: tauri::AppHandle) -> Vec<Asset> {
    read_assets(&app)
}

/// Importe (ou met à jour) un asset. `data` est une dataURL. Renvoie l'asset créé.
#[tauri::command]
pub fn village_asset_import(
    app: tauri::AppHandle,
    name: String,
    kind: String,
    data: String,
    w: Option<u32>,
    h: Option<u32>,
) -> Result<Asset, String> {
    if data.trim().is_empty() {
        return Err("Image vide.".into());
    }
    // Garde-fou taille (~6 Mo de dataURL).
    if data.len() > 6_000_000 {
        return Err("Image trop lourde (max ~4 Mo).".into());
    }
    let mut list = read_assets(&app);
    let asset = Asset {
        id: format!("ast-{}-{}", now_secs(), list.len()),
        name: if name.trim().is_empty() {
            "Sans nom".into()
        } else {
            name
        },
        kind,
        data,
        w: w.unwrap_or(0),
        h: h.unwrap_or(0),
        created: now_secs(),
    };
    list.push(asset.clone());
    write_assets(&app, &list)?;
    let _ = app.emit("village-assets-updated", ());
    Ok(asset)
}

/// Supprime un asset par id.
#[tauri::command]
pub fn village_asset_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut list = read_assets(&app);
    list.retain(|a| a.id != id);
    write_assets(&app, &list)?;
    let _ = app.emit("village-assets-updated", ());
    Ok(())
}

// ===================== Plan du village (layout) =====================
// Blob JSON générique : le front possède le schéma (taille du monde, zone de
// travail, objets placés, positions de maisons…). On ne fait que persister.

fn layout_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("village_layout.json"))
}

/// Charge le plan du village (objet JSON, ou `null` si jamais sauvegardé).
#[tauri::command]
pub fn village_layout_load(app: tauri::AppHandle) -> serde_json::Value {
    layout_path(&app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// Sauvegarde le plan du village (best-effort, taille plafonnée).
#[tauri::command]
pub fn village_layout_save(app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    let s = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    if s.len() > 4_000_000 {
        return Err("Plan trop volumineux.".into());
    }
    let p = layout_path(&app)?;
    fs::write(p, s).map_err(|e| e.to_string())?;
    let _ = app.emit("village-layout-updated", ());
    Ok(())
}
