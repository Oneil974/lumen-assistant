//! Rappels datés (calendrier). Un rappel = un titre, une note optionnelle, une
//! échéance horodatée (`due_at`, ms epoch) et une récurrence facultative. Un
//! ticker d'arrière-plan (cf. `lib.rs`) appelle `check_due` régulièrement : tout
//! rappel arrivé à terme déclenche une notification (réutilise le canal du
//! Heartbeat : évènement `heartbeat-result` → centre de notifications + orbe).
//!
//! Persistance « opaque » comme `inbox.rs`/`kanban.rs` : un blob JSON (tableau de
//! rappels) dans `app_data_dir/reminders.json`, rediffusé via `reminders-updated`
//! pour garder l'app Calendrier et la barre synchronisées.
//!
//! Les rappels peuvent être créés par l'utilisateur (app Calendrier), par l'IA
//! (outil `create_reminder` de la barre) ou par un agent/bloc Fluxo (route
//! loopback `POST /reminders`).

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct Reminder {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    /// Échéance en millisecondes depuis l'epoch.
    pub due_at: u64,
    /// Récurrence : `none` | `daily` | `weekly` | `monthly`.
    #[serde(default = "recur_none")]
    pub recur: String,
    #[serde(default)]
    pub done: bool,
    /// Déjà notifié (rappels ponctuels). Les rappels récurrents repassent à
    /// `false` après avancement de l'échéance.
    #[serde(default)]
    pub fired: bool,
    /// Origine : `user` | `ai` | `agent`.
    #[serde(default = "source_user")]
    pub source: String,
    #[serde(default)]
    pub created_at: u64,
    /// Champs additionnels posés par l'app Calendrier (durée, catégorie,
    /// participants, projet…). Conservés tels quels : sans ce `flatten`, la
    /// réécriture du fichier par `check_due` les effacerait au premier
    /// déclenchement.
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn recur_none() -> String {
    "none".to_string()
}
fn source_user() -> String {
    "user".to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn reminders_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("reminders.json"))
}

fn read_all(app: &tauri::AppHandle) -> Vec<Reminder> {
    reminders_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_all(app: &tauri::AppHandle, items: &[Reminder]) -> Result<(), String> {
    let data = serde_json::to_string(items).map_err(|e| e.to_string())?;
    fs::write(reminders_path(app)?, &data).map_err(|e| e.to_string())?;
    let _ = app.emit("reminders-updated", ());
    Ok(())
}

const DAY_MS: u64 = 86_400_000;

/// Prochaine occurrence d'un rappel récurrent, strictement postérieure à `now`.
/// `monthly` est approximé à 30 jours (suffisant pour des rappels). `none` →
/// aucune occurrence.
fn next_occurrence(due_at: u64, recur: &str, now: u64) -> Option<u64> {
    let step = match recur {
        "daily" => DAY_MS,
        "weekly" => 7 * DAY_MS,
        "monthly" => 30 * DAY_MS,
        _ => return None,
    };
    let mut next = due_at;
    // Avance jusqu'à dépasser `now` (rattrape les échéances manquées hors-ligne).
    while next <= now {
        next += step;
    }
    Some(next)
}

/// Ajoute un rappel (helper interne, réutilisé par l'IA et le loopback). Renvoie
/// le rappel créé. Borne la liste à 500 entrées.
pub fn add_reminder(
    app: &tauri::AppHandle,
    title: &str,
    note: &str,
    due_at: u64,
    recur: &str,
    source: &str,
) -> Result<Reminder, String> {
    let recur = match recur {
        "daily" | "weekly" | "monthly" => recur,
        _ => "none",
    };
    let r = Reminder {
        id: format!("rem-{}", now_ms()),
        title: title.trim().to_string(),
        note: note.trim().to_string(),
        due_at,
        recur: recur.to_string(),
        done: false,
        fired: false,
        source: source.to_string(),
        created_at: now_ms(),
        extra: serde_json::Map::new(),
    };
    if r.title.is_empty() {
        return Err("Titre du rappel vide".into());
    }
    let mut items = read_all(app);
    items.insert(0, r.clone());
    items.truncate(500);
    write_all(app, &items)?;
    Ok(r)
}

/// Parcourt les rappels et déclenche ceux arrivés à terme. Renvoie le nombre de
/// rappels déclenchés à cet appel. Appelé par le ticker d'arrière-plan.
pub fn check_due(app: &tauri::AppHandle) -> usize {
    let now = now_ms();
    let mut items = read_all(app);
    let mut fired_count = 0usize;
    let mut changed = false;

    for r in items.iter_mut() {
        if r.done || r.fired || r.due_at > now {
            continue;
        }
        // Déclenchement : notification (canal Heartbeat) + pulsation de l'orbe.
        let _ = app.emit("heartbeat-tick", ());
        crate::emit_center(
            app,
            json!({
                "shortcut": "⏰ Rappel",
                // Clic sur la capsule : le rappel vit dans le Calendrier.
                "app": "calendar",
                "output": if r.note.is_empty() { r.title.clone() } else { format!("{}\n{}", r.title, r.note) },
                "success": true,
                "timestamp": now,
            }),
        );
        let _ = app.emit("reminder-fired", json!({ "id": r.id, "title": r.title }));
        fired_count += 1;
        changed = true;

        // Récurrent : on avance l'échéance et on garde `fired=false`. Ponctuel :
        // on marque `fired=true` pour ne plus re-notifier.
        match next_occurrence(r.due_at, &r.recur, now) {
            Some(next) => {
                r.due_at = next;
                r.fired = false;
            }
            None => r.fired = true,
        }
    }

    if changed {
        let _ = write_all(app, &items);
    }
    fired_count
}

/// Charge les rappels (JSON brut). Vide si rien encore.
#[tauri::command]
pub fn reminders_load(app: tauri::AppHandle) -> Result<String, String> {
    Ok(fs::read_to_string(reminders_path(&app)?).unwrap_or_default())
}

/// Remplace l'intégralité des rappels (l'app Calendrier gère l'édition).
#[tauri::command]
pub fn reminders_save(app: tauri::AppHandle, data: String) -> Result<(), String> {
    serde_json::from_str::<Vec<Reminder>>(&data).map_err(|e| format!("JSON invalide : {e}"))?;
    fs::write(reminders_path(&app)?, &data).map_err(|e| e.to_string())?;
    let _ = app.emit("reminders-updated", ());
    Ok(())
}

/// Ajoute un rappel depuis le front (app Calendrier, outil IA local).
#[tauri::command]
pub fn reminder_add(
    app: tauri::AppHandle,
    title: String,
    note: Option<String>,
    due_at: u64,
    recur: Option<String>,
    source: Option<String>,
) -> Result<Reminder, String> {
    add_reminder(
        &app,
        &title,
        &note.unwrap_or_default(),
        due_at,
        &recur.unwrap_or_else(recur_none),
        &source.unwrap_or_else(source_user),
    )
}

/// Supprime un rappel par id.
#[tauri::command]
pub fn reminder_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut items = read_all(&app);
    let before = items.len();
    items.retain(|r| r.id != id);
    if items.len() != before {
        write_all(&app, &items)?;
    }
    Ok(())
}

/// Marque un rappel comme fait / à faire.
#[tauri::command]
pub fn reminder_set_done(app: tauri::AppHandle, id: String, done: bool) -> Result<(), String> {
    let mut items = read_all(&app);
    let mut changed = false;
    for r in items.iter_mut() {
        if r.id == id {
            r.done = done;
            changed = true;
        }
    }
    if changed {
        write_all(&app, &items)?;
    }
    Ok(())
}

/// Déclenche un balayage immédiat des rappels échus (utilisé par le ticker et
/// disponible au front pour un rafraîchissement à la demande).
#[tauri::command]
pub fn reminders_check_now(app: tauri::AppHandle) -> usize {
    check_due(&app)
}
