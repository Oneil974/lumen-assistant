//! Associations badge RFID → action, stockées CÔTÉ BACKEND.
//!
//! Même traitement que la clé API : le fichier vit dans `app_data_dir`, en
//! 0600 sous Unix, et l'UID n'est **jamais** renvoyé à une webview. L'interface
//! ne reçoit qu'une forme masquée (`••••B3C4`) et un identifiant opaque pour
//! pouvoir supprimer une entrée.
//!
//! La résolution badge → action se fait donc entièrement ici : le frontend
//! envoie l'UID lu par le contrôleur et reçoit l'action, sans jamais manipuler
//! la table.
//!
//! À ne pas confondre avec le badge d'ouverture de session (`session.rs`), qui
//! est un secret d'authentification et se trouve, lui, haché avec sel.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
pub struct Binding {
    uid: String,
    #[serde(default)]
    label: String,
    action: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    bindings: Vec<Binding>,
}

/// Ce que voit l'interface : ni UID en clair, ni moyen de le reconstituer.
#[derive(Serialize)]
pub struct PublicBinding {
    id: String,
    uid_masked: String,
    label: String,
    action: String,
    params: serde_json::Value,
}

/// Ce que reçoit le frontend au moment d'exécuter l'action.
#[derive(Serialize)]
pub struct ResolvedBinding {
    label: String,
    action: String,
    params: serde_json::Value,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("rfid_bindings.json"))
}

fn read_store(app: &tauri::AppHandle) -> Store {
    store_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(app: &tauri::AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    let data = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    // Même précaution que pour la clé API : lisible du seul propriétaire.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Majuscules, sans séparateur : les lecteurs écrivent tantôt `04a2b3c4`,
/// tantôt `04:A2:B3:C4`.
fn normalize_uid(uid: &str) -> String {
    uid.chars()
        .filter(|c| c.is_ascii_hexdigit())
        .flat_map(|c| c.to_uppercase())
        .collect()
}

/// Identifiant opaque et stable, dérivé de l'UID sans le divulguer.
fn binding_id(uid: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"lumen-rfid-binding");
    h.update(uid.as_bytes());
    format!("{:x}", h.finalize())[..16].to_string()
}

fn mask(uid: &str) -> String {
    let tail: String = uid.chars().rev().take(4).collect::<Vec<_>>()
        .into_iter().rev().collect();
    format!("••••{tail}")
}

impl From<&Binding> for PublicBinding {
    fn from(b: &Binding) -> Self {
        Self {
            id: binding_id(&b.uid),
            uid_masked: mask(&b.uid),
            label: b.label.clone(),
            action: b.action.clone(),
            params: b.params.clone(),
        }
    }
}

/// Liste des badges associés, sous forme masquée.
#[tauri::command]
pub fn rfid_bindings_list(app: tauri::AppHandle) -> Vec<PublicBinding> {
    read_store(&app).bindings.iter().map(PublicBinding::from).collect()
}

/// État courant du lecteur du Lumen Controller, pour le bloc Fluxo « Badge
/// RFID » (`GET /rfid/last` sur le serveur loopback).
///
/// Le badge d'ouverture de session n'y entre JAMAIS (voir `record_badge`) : son
/// UID est un secret d'authentification, et le reste.
#[derive(Clone, Default)]
struct LastBadge {
    uid: String,
    label: String,
    present: bool,
    at: u64,
}

static LAST_BADGE: Mutex<Option<LastBadge>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Un badge vient d'être posé sur le lecteur. Renvoie l'UID normalisé s'il doit
/// être traité (déclencheurs, bloc Fluxo), `None` s'il faut l'ignorer.
///
/// Un badge d'ouverture de session est ignoré : un badge n'a qu'un usage, et
/// celui-là sert à s'authentifier — le laisser aussi lancer des automatisations
/// rendrait le geste « ouvrir ma session » imprévisible.
pub fn record_badge(app: &tauri::AppHandle, uid: &str) -> Option<String> {
    let uid = normalize_uid(uid);
    if uid.len() < 6 || crate::session::uid_opens_session(app, &uid) {
        return None;
    }
    // Garde-fou anti-doublon.
    //
    // Le firmware n'envoie qu'une pose, mais l'application peut recevoir la
    // MÊME ligne deux fois : deux liens ouverts vers le contrôleur (une adresse
    // renseignée à la fois dans le champ « orbe » et dans le champ
    // « contrôleur »), ou une reconnexion. Sans ce filtre, un badge posé une
    // fois lançait le workflow deux fois.
    //
    // La fenêtre reste courte : retirer puis reposer volontairement un badge
    // demande bien plus que ça, et doit continuer à rejouer l'action.
    const DEDUP_MS: u64 = 750;
    if let Ok(guard) = LAST_BADGE.lock() {
        if let Some(previous) = guard.as_ref() {
            if previous.uid == uid
                && previous.present
                && now_ms().saturating_sub(previous.at) < DEDUP_MS
            {
                return None;
            }
        }
    }
    let label = read_store(app)
        .bindings
        .iter()
        .find(|b| b.uid == uid)
        .map(|b| b.label.clone())
        .unwrap_or_default();
    if let Ok(mut guard) = LAST_BADGE.lock() {
        *guard = Some(LastBadge {
            uid: uid.clone(),
            label,
            present: true,
            at: now_ms(),
        });
    }
    Some(uid)
}

/// Le badge a quitté le lecteur. On garde le dernier UID lu (un workflow peut
/// le consulter après coup), mais `present` retombe à faux.
pub fn record_badge_removed() {
    if let Ok(mut guard) = LAST_BADGE.lock() {
        if let Some(badge) = guard.as_mut() {
            badge.present = false;
            badge.at = now_ms();
        }
    }
}

/// Ce que renvoie `GET /rfid/last` au moteur Fluxo.
pub fn last_badge_json() -> serde_json::Value {
    let badge = LAST_BADGE.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    serde_json::json!({
        "uid": badge.uid,
        "label": badge.label,
        "present": badge.present,
        "at": badge.at,
    })
}

/// Ce badge a-t-il déjà une action ? Utilisé par `session.rs` pour refuser d'en
/// faire en plus un badge d'ouverture de session.
pub fn uid_has_binding(app: &tauri::AppHandle, uid: &str) -> bool {
    let uid = normalize_uid(uid);
    !uid.is_empty() && read_store(app).bindings.iter().any(|b| b.uid == uid)
}

/// Associe (ou remplace) l'action d'un badge. Un badge = une action.
#[tauri::command]
pub fn rfid_bind(
    app: tauri::AppHandle,
    uid: String,
    label: String,
    action: String,
    params: Option<serde_json::Value>,
) -> Result<Vec<PublicBinding>, String> {
    let uid = normalize_uid(&uid);
    if uid.len() < 6 {
        return Err("UID de badge invalide.".into());
    }
    if action.trim().is_empty() {
        return Err("Action manquante.".into());
    }
    // Un badge = un usage. Un badge d'ouverture de session ne peut pas aussi
    // déclencher une action : posé pendant une session ouverte, il ferait les
    // deux, et l'utilisateur n'aurait plus de geste sûr pour se connecter.
    if crate::session::uid_opens_session(&app, &uid) {
        return Err(
            "Ce badge ouvre déjà une session. Utilisez un autre badge pour \
             cette action."
                .into(),
        );
    }
    let mut store = read_store(&app);
    store.bindings.retain(|b| b.uid != uid);
    store.bindings.push(Binding {
        uid,
        label,
        action,
        params: params.unwrap_or(serde_json::Value::Null),
    });
    write_store(&app, &store)?;
    Ok(store.bindings.iter().map(PublicBinding::from).collect())
}

/// Retire une association à partir de son identifiant opaque.
#[tauri::command]
pub fn rfid_unbind(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<PublicBinding>, String> {
    let mut store = read_store(&app);
    store.bindings.retain(|b| binding_id(&b.uid) != id);
    write_store(&app, &store)?;
    Ok(store.bindings.iter().map(PublicBinding::from).collect())
}

/// Action associée à un badge, ou `null`. L'UID ne fait qu'entrer.
#[tauri::command]
pub fn rfid_resolve(app: tauri::AppHandle, uid: String) -> Option<ResolvedBinding> {
    let uid = normalize_uid(&uid);
    read_store(&app)
        .bindings
        .iter()
        .find(|b| b.uid == uid)
        .map(|b| ResolvedBinding {
            label: b.label.clone(),
            action: b.action.clone(),
            params: b.params.clone(),
        })
}

/// Reprise des associations créées avant le passage au stockage backend
/// (elles vivaient en localStorage, en clair). Appelée une fois par le
/// frontend, qui efface ensuite sa copie.
#[tauri::command]
pub fn rfid_import_legacy(
    app: tauri::AppHandle,
    bindings: Vec<serde_json::Value>,
) -> Result<usize, String> {
    let mut store = read_store(&app);
    let mut added = 0;
    for entry in bindings {
        let uid = normalize_uid(entry.get("uid").and_then(|v| v.as_str()).unwrap_or(""));
        let action = entry.get("action").and_then(|v| v.as_str()).unwrap_or("");
        if uid.len() < 6 || action.is_empty() {
            continue;
        }
        if store.bindings.iter().any(|b| b.uid == uid) {
            continue;
        }
        // Même règle qu'à l'association manuelle : les tables d'avant pouvaient
        // contenir un badge devenu depuis badge d'ouverture de session.
        if crate::session::uid_opens_session(&app, &uid) {
            continue;
        }
        store.bindings.push(Binding {
            uid,
            label: entry.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            action: action.to_string(),
            params: entry.get("params").cloned().unwrap_or(serde_json::Value::Null),
        });
        added += 1;
    }
    if added > 0 {
        write_store(&app, &store)?;
    }
    Ok(added)
}
