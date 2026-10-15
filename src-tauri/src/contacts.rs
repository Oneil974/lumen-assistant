//! Carnet d'adresses : le magasin unique des personnes que Lumen connaît.
//!
//! Avant lui, les mêmes gens vivaient dans trois endroits qui ne se parlaient
//! pas : les clients de Relia, les correspondants du courrier, les pairs
//! Telegram. Ce module ne fait qu'une chose — tenir le fichier — et laisse à
//! l'app le soin de FUSIONNER les sources, parce que c'est elle qui sait quoi
//! faire d'un doublon (deux adresses, un seul nom).
//!
//! `contacts.json` est aussi une source de la recherche globale (search.rs) :
//! chercher un nom depuis ⌘K trouve la fiche.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Contact {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub company: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub note: String,
    /// D'où vient la fiche : `manual` | `mail` | `crm` | `telegram` | `directory`.
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub updated_at: u64,
    /// Contextes où l'on connaît la personne : `personal` | `team` | `client`.
    #[serde(default)]
    pub contexts: Vec<String>,
    /// Liens vers les fiches des apps (`{ app: "relia"|"directory"|…, ref }`) :
    /// l'id de la fiche sert d'identifiant commun de la personne.
    #[serde(default)]
    pub links: Vec<serde_json::Value>,
    /// Informations rangées par contexte (`{ client: {...}, team: {...} }`),
    /// pour ne pas mélanger personnel, professionnel et commercial.
    #[serde(default)]
    pub fields: serde_json::Map<String, serde_json::Value>,
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("contacts.json"))
}

#[tauri::command]
pub fn contacts_load(app: tauri::AppHandle) -> Result<String, String> {
    Ok(fs::read_to_string(path(&app)?).unwrap_or_default())
}

#[tauri::command(async)]
pub fn contacts_save(app: tauri::AppHandle, data: String) -> Result<(), String> {
    // Validation avant écriture : un JSON cassé rendrait le carnet illisible
    // pour la recherche globale, qui le lit sans passer par l'app.
    serde_json::from_str::<Vec<Contact>>(&data)
        .map_err(|e| format!("Carnet d'adresses invalide : {e}"))?;
    fs::write(path(&app)?, data).map_err(|e| e.to_string())
}
