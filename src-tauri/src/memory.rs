// ===== MemoryStore : mémoire partagée, persistante et optionnelle =====
//
// Lumen met à disposition une mémoire clé/valeur que trois acteurs voient à
// l'identique :
//
//   • les raccourcis macOS / l'Action Router, via HTTP sur la boucle locale
//     (`127.0.0.1:8765` — GET/PUT/POST/DELETE `/mem/*`) ;
//   • le heartbeat, qui lit l'état AVANT un tick et écrit le résultat APRÈS ;
//   • l'UI (onglet « Mémoire » + injection dans les discussions), via des
//     commandes Tauri.
//
// Principes de conception :
//   • OPTIONNELLE et NON-CASSANTE. Le store vit dans son propre fichier
//     (`app_data_dir/memory.json`), séparé de toute config existante. S'il est
//     absent, vide ou corrompu, Lumen démarre normalement : aucun chemin de code
//     critique n'en dépend.
//   • Namespaces par convention de préfixe : `todo/`, `state/`, `user/`,
//     `store/`. Aucune n'est imposée — ce sont de simples clés.
//   • `rev` (révision) permet une écriture conditionnelle (anti-collision entre
//     deux écrivains, ex. deux ticks). `expires_at` permet un TTL (ex. verrou).
//
// Toute écriture émet l'évènement `memory-changed` vers la WebView pour
// rafraîchir l'UI en direct, quelle que soit l'origine (HTTP, heartbeat, UI).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Une entrée de la mémoire.
#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    /// Valeur libre (objet, tableau, chaîne, nombre…).
    pub value: Value,
    /// Compteur de révision, incrémenté à chaque écriture. Sert aux écritures
    /// conditionnelles (`expected_rev`).
    pub rev: u64,
    /// Horodatage de la dernière écriture (epoch ms).
    pub updated_at: u64,
    /// Expiration optionnelle (epoch ms). Une entrée expirée est ignorée en
    /// lecture et purgée paresseusement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

impl Entry {
    fn is_expired(&self, now: u64) -> bool {
        self.expires_at.map(|e| e <= now).unwrap_or(false)
    }
}

/// Une clé + son entrée, pour les listings.
#[derive(Clone, Serialize)]
pub struct KeyedEntry {
    pub key: String,
    #[serde(flatten)]
    pub entry: Entry,
}

/// Erreur d'écriture conditionnelle : la révision attendue ne correspond pas.
pub struct RevConflict {
    pub current: Option<Entry>,
}

/// Le magasin. `Clone` bon marché (tout est derrière `Arc`) : on le `manage`
/// côté Tauri et on en clone une poignée dans l'état du serveur HTTP.
#[derive(Clone, Default)]
pub struct MemoryStore {
    inner: Arc<Mutex<HashMap<String, Entry>>>,
    path: Arc<Mutex<Option<PathBuf>>>,
    app: Arc<Mutex<Option<tauri::AppHandle>>>,
}

/// Valide une clé : non vide, taille bornée, caractères sûrs. Les namespaces
/// (`todo/ma-tache`) sont autorisés via `/`. Pas de `..` ni de chemins absolus
/// (la clé n'est qu'une clé de map, mais on reste strict par hygiène).
pub fn valid_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 256 {
        return false;
    }
    if key.contains("..") || key.starts_with('/') {
        return false;
    }
    key.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.' | ':'))
}

impl MemoryStore {
    /// Initialise le store : fixe le chemin de persistance et charge le contenu
    /// existant. Tolérant aux pannes — n'échoue jamais le démarrage.
    pub async fn init(&self, app: &tauri::AppHandle) {
        *self.app.lock().await = Some(app.clone());

        let path = crate::paths::shared_data_dir(app.path())
            .ok()
            .map(|d| d.join("memory.json"));

        if let Some(ref p) = path {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(txt) = std::fs::read_to_string(p) {
                if let Ok(map) = serde_json::from_str::<HashMap<String, Entry>>(&txt) {
                    *self.inner.lock().await = map;
                }
            }
        }
        *self.path.lock().await = path;
    }

    /// Écrit le contenu sur disque de façon atomique (tmp + rename). Les entrées
    /// expirées ne sont pas persistées.
    async fn persist(&self) {
        let path = { self.path.lock().await.clone() };
        let Some(path) = path else { return };

        let now = now_ms();
        let snapshot: HashMap<String, Entry> = {
            let map = self.inner.lock().await;
            map.iter()
                .filter(|(_, e)| !e.is_expired(now))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };

        if let Ok(txt) = serde_json::to_string_pretty(&snapshot) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, txt.as_bytes()).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    /// Émet `memory-changed` vers la WebView (rafraîchissement live de l'UI).
    async fn notify(&self, key: &str, action: &str) {
        if let Some(app) = self.app.lock().await.as_ref() {
            let _ = app.emit(
                "memory-changed",
                serde_json::json!({ "key": key, "action": action }),
            );
        }
    }

    /// Lecture d'une entrée (None si absente ou expirée). Purge paresseusement
    /// une entrée expirée rencontrée.
    pub async fn get(&self, key: &str) -> Option<Entry> {
        let now = now_ms();
        let mut expired = false;
        let res = {
            let map = self.inner.lock().await;
            match map.get(key) {
                Some(e) if e.is_expired(now) => {
                    expired = true;
                    None
                }
                Some(e) => Some(e.clone()),
                None => None,
            }
        };
        if expired {
            self.inner.lock().await.remove(key);
            self.persist().await;
        }
        res
    }

    /// Écriture (ou remplacement). Si `expected_rev` est fourni, l'écriture
    /// n'aboutit que si la révision courante correspond (0 = doit être absente).
    /// `ttl_ms` fixe une expiration relative optionnelle.
    pub async fn set(
        &self,
        key: &str,
        value: Value,
        expected_rev: Option<u64>,
        ttl_ms: Option<u64>,
    ) -> Result<Entry, RevConflict> {
        let now = now_ms();
        let entry = {
            let mut map = self.inner.lock().await;

            // Une entrée expirée est traitée comme absente.
            let current = map.get(key).filter(|e| !e.is_expired(now));
            let current_rev = current.map(|e| e.rev).unwrap_or(0);

            if let Some(exp) = expected_rev {
                if exp != current_rev {
                    return Err(RevConflict {
                        current: current.cloned(),
                    });
                }
            }

            let entry = Entry {
                value,
                rev: current_rev + 1,
                updated_at: now,
                expires_at: ttl_ms.map(|t| now + t),
            };
            map.insert(key.to_string(), entry.clone());
            entry
        };
        self.persist().await;
        self.notify(key, "set").await;
        Ok(entry)
    }

    /// Ajoute un élément à une entrée-tableau (la crée comme `[value]` si
    /// absente). Pratique pour empiler une tâche ou un log atomiquement.
    pub async fn append(&self, key: &str, value: Value) -> Result<Entry, RevConflict> {
        let now = now_ms();
        let entry = {
            let mut map = self.inner.lock().await;
            let current = map.get(key).filter(|e| !e.is_expired(now)).cloned();
            let prev_rev = current.as_ref().map(|e| e.rev).unwrap_or(0);
            let prev_exp = current.as_ref().and_then(|e| e.expires_at);

            let mut arr = match current.as_ref().map(|e| &e.value) {
                Some(Value::Array(a)) => a.clone(),
                Some(_) => return Err(RevConflict { current }), // pas un tableau
                None => Vec::new(),
            };
            arr.push(value);

            let entry = Entry {
                value: Value::Array(arr),
                rev: prev_rev + 1,
                updated_at: now,
                expires_at: prev_exp,
            };
            map.insert(key.to_string(), entry.clone());
            entry
        };
        self.persist().await;
        self.notify(key, "append").await;
        Ok(entry)
    }

    /// Supprime une entrée. Renvoie `true` si quelque chose a été retiré.
    pub async fn delete(&self, key: &str) -> bool {
        let removed = { self.inner.lock().await.remove(key).is_some() };
        if removed {
            self.persist().await;
            self.notify(key, "delete").await;
        }
        removed
    }

    /// Liste les entrées (filtre par préfixe de namespace si fourni), triées par
    /// clé. Les entrées expirées sont exclues.
    pub async fn list(&self, prefix: Option<&str>) -> Vec<KeyedEntry> {
        let now = now_ms();
        let map = self.inner.lock().await;
        let mut out: Vec<KeyedEntry> = map
            .iter()
            .filter(|(k, e)| !e.is_expired(now) && prefix.map(|p| k.starts_with(p)).unwrap_or(true))
            .map(|(k, e)| KeyedEntry {
                key: k.clone(),
                entry: e.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }
}

// ===== Commandes Tauri (accès depuis l'UI / les discussions) =====

/// Redirige les clés de profil vers le profil de session actif. `pub(crate)` :
/// la passerelle Telegram lit le même profil que la barre (cf. `telegram.rs`).
pub(crate) fn resolve_profile_key(app: &tauri::AppHandle, key: &str) -> String {
    match key {
        "user/profile" => format!(
            "user/profiles/{}/profile",
            crate::session::active_profile_id(app)
        ),
        "user/memories" => format!(
            "user/profiles/{}/memories",
            crate::session::active_profile_id(app)
        ),
        _ => key.to_string(),
    }
}

#[tauri::command]
pub async fn memory_get(
    app: tauri::AppHandle,
    store: tauri::State<'_, MemoryStore>,
    key: String,
) -> Result<Option<Entry>, String> {
    let original_key = key.clone();
    let key = resolve_profile_key(&app, &key);
    if !valid_key(&key) {
        return Err("clé invalide".into());
    }
    let entry = store.get(&key).await;
    if entry.is_none()
        && crate::session::active_profile_uses_legacy_workspace(&app)
        && matches!(original_key.as_str(), "user/profile" | "user/memories")
    {
        return Ok(store.get(&original_key).await);
    }
    Ok(entry)
}

#[tauri::command]
pub async fn memory_set(
    app: tauri::AppHandle,
    store: tauri::State<'_, MemoryStore>,
    key: String,
    value: Value,
    expected_rev: Option<u64>,
    ttl_ms: Option<u64>,
) -> Result<Entry, String> {
    let key = resolve_profile_key(&app, &key);
    if !valid_key(&key) {
        return Err("clé invalide".into());
    }
    store
        .set(&key, value, expected_rev, ttl_ms)
        .await
        .map_err(|c| {
            format!(
                "conflit de révision (rev actuelle : {})",
                c.current.map(|e| e.rev).unwrap_or(0)
            )
        })
}

#[tauri::command]
pub async fn memory_delete(
    app: tauri::AppHandle,
    store: tauri::State<'_, MemoryStore>,
    key: String,
) -> Result<bool, String> {
    let key = resolve_profile_key(&app, &key);
    if !valid_key(&key) {
        return Err("clé invalide".into());
    }
    Ok(store.delete(&key).await)
}

#[tauri::command]
pub async fn memory_list(
    store: tauri::State<'_, MemoryStore>,
    prefix: Option<String>,
) -> Result<Vec<KeyedEntry>, String> {
    Ok(store.list(prefix.as_deref()).await)
}
