//! Avatar 3D personnalisé de Lumen.
//!
//! Le GLB est validé avant d'être conservé dans les données de l'application.
//! Les noms de clips constituent l'API entre Blender et la machine d'états de
//! Lumen : ils sont volontairement stricts et sensibles à la casse.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const REQUIRED_CLIPS: [&str; 4] = [
    "Lumen_Idle",
    "Lumen_Thinking",
    "Lumen_Speaking",
    "Lumen_Action",
];
pub const OPTIONAL_CLIPS: [&str; 1] = ["Lumen_Heartbeat"];
const MAX_GLB_BYTES: usize = 25 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarGlbInfo {
    pub name: String,
    pub size: usize,
    pub animations: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarGlbPayload {
    pub info: AvatarGlbInfo,
    pub data: String,
}

fn avatar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::paths::shared_data_dir(app.path())
        .map(|p| p.join("avatar"))
        .map_err(|e| e.to_string())
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(avatar_dir(app)?.join("custom-avatar.glb"))
}

fn info_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(avatar_dir(app)?.join("custom-avatar.json"))
}

fn u32_le(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "GLB tronqué.".to_string())?;
    Ok(u32::from_le_bytes(
        value.try_into().map_err(|_| "GLB invalide.")?,
    ))
}

fn inspect_glb(bytes: &[u8], name: String) -> Result<AvatarGlbInfo, String> {
    if bytes.len() > MAX_GLB_BYTES {
        return Err("Le GLB dépasse la limite de 25 Mo.".into());
    }
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return Err("Le fichier n'est pas un GLB binaire valide.".into());
    }
    if u32_le(bytes, 4)? != 2 {
        return Err("Seuls les GLB glTF 2.0 sont pris en charge.".into());
    }
    if u32_le(bytes, 8)? as usize != bytes.len() {
        return Err("La taille déclarée du GLB est invalide.".into());
    }
    let json_len = u32_le(bytes, 12)? as usize;
    if u32_le(bytes, 16)? != 0x4e4f_534a || 20 + json_len > bytes.len() {
        return Err("Le chunk JSON du GLB est absent ou invalide.".into());
    }
    let json: serde_json::Value = serde_json::from_slice(&bytes[20..20 + json_len])
        .map_err(|e| format!("JSON glTF invalide : {e}"))?;
    let animations: Vec<String> = json
        .get("animations")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(|v| v.as_str()))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let available: HashSet<&str> = animations.iter().map(String::as_str).collect();
    let missing: Vec<&str> = REQUIRED_CLIPS
        .iter()
        .copied()
        .filter(|clip| !available.contains(clip))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Animations Lumen manquantes : {}. Les noms sont sensibles à la casse ; {} reste optionnelle.",
            missing.join(", "),
            OPTIONAL_CLIPS[0]
        ));
    }
    Ok(AvatarGlbInfo {
        name,
        size: bytes.len(),
        animations,
    })
}

#[tauri::command]
pub fn avatar_glb_import(
    app: AppHandle,
    name: String,
    data: String,
) -> Result<AvatarGlbInfo, String> {
    let bytes = STANDARD
        .decode(data.trim())
        .map_err(|_| "Le contenu Base64 du GLB est invalide.".to_string())?;
    let clean_name = PathBuf::from(name.trim())
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("avatar.glb")
        .to_string();
    let info = inspect_glb(&bytes, clean_name)?;
    let dir = avatar_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let temporary = dir.join("custom-avatar.glb.tmp");
    let backup = dir.join("custom-avatar.glb.bak");
    let destination = model_path(&app)?;
    fs::write(&temporary, &bytes).map_err(|e| e.to_string())?;
    // `rename` n'écrase pas une destination existante sous Windows. On garde
    // donc l'ancien avatar en sauvegarde jusqu'à ce que le nouveau soit en place.
    if destination.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|e| e.to_string())?;
        }
        fs::rename(&destination, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, &destination);
        }
        return Err(error.to_string());
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    fs::write(
        info_path(&app)?,
        serde_json::to_vec_pretty(&info).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
pub fn avatar_glb_status(app: AppHandle) -> Option<AvatarGlbInfo> {
    let raw = fs::read(info_path(&app).ok()?).ok()?;
    serde_json::from_slice(&raw).ok()
}

#[tauri::command]
pub fn avatar_glb_load(app: AppHandle) -> Result<Option<AvatarGlbPayload>, String> {
    let Some(info) = avatar_glb_status(app.clone()) else {
        return Ok(None);
    };
    let bytes = fs::read(model_path(&app)?).map_err(|e| e.to_string())?;
    Ok(Some(AvatarGlbPayload {
        info,
        data: STANDARD.encode(bytes),
    }))
}

#[tauri::command]
pub fn avatar_glb_delete(app: AppHandle) -> Result<(), String> {
    for path in [model_path(&app)?, info_path(&app)?] {
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glb_with_animations(names: &[&str]) -> Vec<u8> {
        let animations: Vec<_> = names
            .iter()
            .map(|name| serde_json::json!({ "name": name }))
            .collect();
        let mut json = serde_json::to_vec(&serde_json::json!({
            "asset": { "version": "2.0" },
            "animations": animations
        }))
        .unwrap();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let total = 20 + json.len();
        let mut glb = Vec::with_capacity(total);
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&(total as u32).to_le_bytes());
        glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x4e4f_534au32.to_le_bytes());
        glb.extend_from_slice(&json);
        glb
    }

    #[test]
    fn accepts_the_lumen_contract() {
        let glb = glb_with_animations(&REQUIRED_CLIPS);
        assert!(inspect_glb(&glb, "avatar.glb".into()).is_ok());
    }

    #[test]
    fn reports_missing_required_clips() {
        let glb = glb_with_animations(&["Lumen_Idle"]);
        let err = inspect_glb(&glb, "avatar.glb".into()).unwrap_err();
        assert!(err.contains("Lumen_Thinking"));
        assert!(err.contains("Lumen_Action"));
    }
}
