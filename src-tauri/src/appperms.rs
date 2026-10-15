//! Permissions des applications — le « à chaque première fois, on demande » de
//! Lumen.
//!
//! Depuis la 0.2, une application n'est plus un morceau du bureau : c'est un
//! paquet installé, qui déclare dans son manifeste les capacités dont il a
//! besoin (`ai`, `storage`, `tables`, `interop:<app>`, `network`…). Déclarer
//! n'est pas obtenir : à la PREMIÈRE utilisation effective d'une capacité,
//! l'interface pose la question à l'utilisateur, et la réponse est mémorisée
//! ici — révocable à tout moment depuis les Paramètres.
//!
//! Ce module ne fait que la mémoire et l'arbitrage. Il ne pose aucune question
//! lui-même : le dialogue est une affaire d'interface (cf. src/lib/appkit/), et
//! le faire remonter jusqu'ici transformerait chaque appel du SDK en aller-retour
//! bloquant. Le contrat est donc : le frontend demande [`perm_get`], et s'il
//! obtient `ask`, il pose la question puis enregistre par [`perm_set`].
//!
//! Le fichier est volontairement lisible (JSON) : quelqu'un doit pouvoir
//! vérifier, sans nous croire sur parole, ce que chaque app a le droit de faire.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Réponse à une demande de capacité.
///
/// `Ask` n'est jamais écrit sur le disque : c'est l'absence de décision. Le
/// distinguer d'un refus est essentiel — un refus ne doit plus jamais reposer la
/// question, une absence de décision doit la poser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Granted,
    Denied,
    Ask,
}

/// Capacités reconnues. Toute capacité inconnue est refusée sans discussion :
/// une app qui invente un nom ne doit pas obtenir un « on ne sait pas, donc oui ».
///
/// `interop` est le seul cas paramétré : `interop:notes` désigne le droit
/// d'envoyer un objet à l'app `notes`, pas un droit d'interop général.
pub const CAPABILITIES: &[&str] = &[
    "ai",            // inférence : chat, vision, embeddings
    "assistant",     // se greffer au mode assistant / se faire piloter par lui
    "tools",         // publier des outils appelables par les agents
    "storage",       // espace sandbox propre à l'app
    "files",         // lecture de fichiers d'un sandbox choisi par l'utilisateur
    "tables",        // bases de données locales
    "memory",        // mémoire cognitive
    "network",       // requêtes HTTP sortantes
    "notifications", // centre de notifications
    "clipboard",
    "interop",       // envoi vers une autre app (paramétré : interop:<appId>)
];

/// Vrai si `cap` est une capacité que Lumen sait arbitrer.
pub fn is_known(cap: &str) -> bool {
    match cap.split_once(':') {
        Some(("interop", target)) => !target.is_empty(),
        Some(_) => false,
        None => CAPABILITIES.contains(&cap) && cap != "interop",
    }
}

type Store = BTreeMap<String, BTreeMap<String, Decision>>;

static CACHE: Mutex<Option<Store>> = Mutex::new(None);

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_config_dir(app.path())
        .map_err(|e| format!("dossier de configuration introuvable : {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("app-permissions.json"))
}

fn load(app: &tauri::AppHandle) -> Store {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(store) = guard.as_ref() {
        return store.clone();
    }
    // Un fichier illisible ou corrompu ne doit pas ouvrir les vannes : on repart
    // d'un store vide, donc tout redemande, plutôt que de deviner.
    let store: Store = store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    *guard = Some(store.clone());
    store
}

fn save(app: &tauri::AppHandle, store: Store) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
    std::fs::write(store_path(app)?, json)
        .map_err(|e| format!("écriture des permissions impossible : {e}"))?;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(store);
    Ok(())
}

/// Décision enregistrée pour `(app_id, cap)`, ou `Ask` si personne n'a encore
/// tranché. Une capacité inconnue est un refus.
#[tauri::command]
pub fn perm_get(app: tauri::AppHandle, app_id: String, cap: String) -> Decision {
    if !is_known(&cap) {
        return Decision::Denied;
    }
    load(&app)
        .get(&app_id)
        .and_then(|caps| caps.get(&cap))
        .copied()
        .unwrap_or(Decision::Ask)
}

/// Toutes les décisions d'une app — ce que montrent les Paramètres.
#[tauri::command]
pub fn perm_list(app: tauri::AppHandle, app_id: Option<String>) -> Store {
    let store = load(&app);
    match app_id {
        Some(id) => store
            .get(&id)
            .map(|caps| BTreeMap::from([(id, caps.clone())]))
            .unwrap_or_default(),
        None => store,
    }
}

/// Enregistre la réponse de l'utilisateur. `Ask` efface la décision : c'est
/// ainsi que « redemander la prochaine fois » se dit, sans commande à part.
#[tauri::command]
pub fn perm_set(
    app: tauri::AppHandle,
    app_id: String,
    cap: String,
    decision: Decision,
) -> Result<(), String> {
    if !is_known(&cap) {
        return Err(format!("capacité inconnue : {cap}"));
    }
    let mut store = load(&app);
    let caps = store.entry(app_id.clone()).or_default();
    match decision {
        Decision::Ask => {
            caps.remove(&cap);
        }
        other => {
            caps.insert(cap.clone(), other);
        }
    }
    if caps.is_empty() {
        store.remove(&app_id);
    }
    save(&app, store)?;
    let _ = tauri::Emitter::emit(
        &app,
        "lumen-permissions",
        serde_json::json!({ "appId": app_id, "cap": cap }),
    );
    Ok(())
}

/// Oublie tout ce qui a été accordé à une app. Appelé à la désinstallation :
/// réinstaller une app ne doit pas ressusciter les droits de l'ancienne.
#[tauri::command]
pub fn perm_reset(app: tauri::AppHandle, app_id: String) -> Result<(), String> {
    let mut store = load(&app);
    store.remove(&app_id);
    save(&app, store)?;
    let _ = tauri::Emitter::emit(
        &app,
        "lumen-permissions",
        serde_json::json!({ "appId": app_id, "cap": null }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_known;

    #[test]
    fn capacites_connues_et_interop_parametre() {
        assert!(is_known("ai"));
        assert!(is_known("interop:notes"));
        // « interop » tout court n'est pas une permission : il faut dire vers QUI.
        assert!(!is_known("interop"));
        assert!(!is_known("interop:"));
        assert!(!is_known("ai:everything"));
        assert!(!is_known("rm-rf"));
    }
}
