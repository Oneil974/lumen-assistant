//! Abonnements aux rapports d'« Analyse de données » : envoi automatique d'un
//! rapport par email, chaque jour, semaine ou mois, à l'heure choisie.
//!
//! Le rapport lui-même ne peut être CALCULÉ que dans l'app : ses sources (CSV,
//! bases, requêtes paramétrées) et ses graphiques (ECharts) vivent côté page.
//! Ce module ne fait donc que trois choses :
//!   1. garder la liste des abonnements (`report-subscriptions.json`) ;
//!   2. réveiller l'app à l'échéance : évènement `report-subscription-due`,
//!      que le bureau traduit en intention `report_send` (l'app s'ouvre au
//!      besoin, calcule, exporte et envoie) ;
//!   3. marquer l'échéance « en attente » tant que l'app n'a pas confirmé
//!      l'envoi (`report_subs_mark`) — une échéance manquée (bureau fermé,
//!      session verrouillée) est rattrapée à la prochaine ouverture de l'app,
//!      et une notification le dit au bout de 5 minutes.
//!
//! L'horloge est locale (chrono::Local) et vérifiée chaque minute : pas de
//! CRON en UTC à traduire, et un Mac sorti de veille rattrape son retard.

use chrono::{Datelike, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Emitter;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportRef {
    pub sandbox_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Subscription {
    pub id: String,
    pub name: String,
    pub report: ReportRef,
    pub to: String,
    pub cc: String,
    pub subject: String,
    /// "daily" | "weekdays" | "weekly" | "monthly"
    pub freq: String,
    /// "HH:MM", heure locale.
    pub time: String,
    /// 0 = dimanche … 6 = samedi (hebdomadaire).
    pub weekday: u32,
    /// 1 … 28 (mensuel).
    pub monthday: u32,
    /// "pdf" | "html"
    pub format: String,
    pub message: String,
    pub enabled: bool,
    /// Dernière échéance traitée (secondes UNIX), envoyée ou non.
    pub last_due: i64,
    /// Dernier envoi réussi (secondes UNIX).
    pub last_run: i64,
    pub last_status: String,
    /// Échéance atteinte, envoi pas encore confirmé par l'app.
    pub pending: bool,
    /// Rappel « en attente » déjà notifié pour l'échéance courante.
    pub reminded: bool,
}

impl Default for Subscription {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            report: ReportRef::default(),
            to: String::new(),
            cc: String::new(),
            subject: String::new(),
            freq: "weekly".into(),
            time: "08:00".into(),
            weekday: 1,
            monthday: 1,
            format: "pdf".into(),
            message: String::new(),
            enabled: true,
            last_due: 0,
            last_run: 0,
            last_status: String::new(),
            pending: false,
            reminded: false,
        }
    }
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_config_dir(tauri::Manager::path(app)).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("report-subscriptions.json"))
}

fn read_all(app: &tauri::AppHandle) -> Vec<Subscription> {
    store_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_all(app: &tauri::AppHandle, subs: &[Subscription]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(subs).map_err(|e| e.to_string())?;
    fs::write(store_path(app)?, raw).map_err(|e| e.to_string())
}

fn hm(time: &str) -> (u32, u32) {
    let mut it = time.split(':');
    let h = it.next().and_then(|s| s.trim().parse().ok()).unwrap_or(8).min(23);
    let m = it.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0).min(59);
    (h, m)
}

/// Dernière échéance (secondes UNIX) au plus tard à `now`, ou None.
pub fn last_due_before(sub: &Subscription, now: chrono::DateTime<Local>) -> Option<i64> {
    let (h, m) = hm(&sub.time);
    // On remonte jour par jour (au plus 62 jours) jusqu'à un jour qui convient.
    for back in 0..62 {
        let day = now.date_naive() - chrono::Duration::days(back);
        let ok = match sub.freq.as_str() {
            "daily" => true,
            "weekdays" => (1..=5).contains(&day.weekday().num_days_from_sunday()),
            "monthly" => day.day() == sub.monthday.clamp(1, 28),
            _ => day.weekday().num_days_from_sunday() == sub.weekday.min(6),
        };
        if !ok {
            continue;
        }
        let naive = day.and_hms_opt(h, m, 0)?;
        let at = Local.from_local_datetime(&naive).earliest()?;
        if at <= now {
            return Some(at.timestamp());
        }
    }
    None
}

/// Prochaine échéance (pour l'affichage).
pub fn next_due_after(sub: &Subscription, now: chrono::DateTime<Local>) -> Option<i64> {
    for ahead in 0..62 {
        let probe = now + chrono::Duration::days(ahead);
        let end_of_day = probe.with_hour(23).and_then(|d| d.with_minute(59)).unwrap_or(probe);
        if let Some(t) = last_due_before(sub, end_of_day) {
            if t > now.timestamp() {
                return Some(t);
            }
        }
    }
    None
}

fn tick(app: &tauri::AppHandle) {
    let mut subs = read_all(app);
    if subs.is_empty() {
        return;
    }
    let now = Local::now();
    let mut changed = false;
    for s in subs.iter_mut().filter(|s| s.enabled) {
        if let Some(due) = last_due_before(s, now) {
            // Un abonnement créé après sa dernière échéance n'envoie rien
            // rétroactivement : `last_due` est initialisé à la création.
            if due > s.last_due {
                s.last_due = due;
                s.pending = true;
                s.reminded = false;
                changed = true;
                let _ = app.emit("report-subscription-due", serde_json::json!({ "id": s.id, "name": s.name }));
            }
        }
        if s.pending && !s.reminded && now.timestamp() - s.last_due > 5 * 60 {
            s.reminded = true;
            changed = true;
            crate::push_notification(
                app,
                serde_json::json!({
                    "kind": "info",
                    "title": "Rapport en attente d'envoi",
                    "body": format!("« {} » n'a pas pu partir : ouvrez Analyse de données (session déverrouillée) pour l'envoyer.", s.name),
                    "app": "dataanalysis",
                    "source": "center",
                }),
            );
        }
    }
    if changed {
        let _ = write_all(app, &subs);
    }
}

/// Boucle de fond : une vérification par minute.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        tick(&app);
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionView {
    #[serde(flatten)]
    pub sub: Subscription,
    pub next_due: Option<i64>,
}

#[tauri::command]
pub fn report_subs_list(app: tauri::AppHandle) -> Vec<SubscriptionView> {
    let now = Local::now();
    read_all(&app)
        .into_iter()
        .map(|sub| SubscriptionView { next_due: if sub.enabled { next_due_after(&sub, now) } else { None }, sub })
        .collect()
}

/// Remplace la liste. Les champs d'état (dernière échéance, envoi, attente)
/// sont conservés pour les abonnements existants ; un nouvel abonnement part
/// de « maintenant » (pas d'envoi rétroactif).
#[tauri::command]
pub fn report_subs_save(app: tauri::AppHandle, subs: Vec<Subscription>) -> Result<Vec<SubscriptionView>, String> {
    let old = read_all(&app);
    let now = Local::now();
    let mut out = Vec::with_capacity(subs.len());
    for mut s in subs {
        if s.id.trim().is_empty() {
            return Err("abonnement sans identifiant".into());
        }
        if s.to.trim().is_empty() {
            return Err(format!("« {} » : aucun destinataire", s.name));
        }
        match old.iter().find(|o| o.id == s.id) {
            Some(o) => {
                s.last_due = o.last_due;
                s.last_run = o.last_run;
                s.last_status = o.last_status.clone();
                s.pending = o.pending;
                s.reminded = o.reminded;
            }
            None => {
                s.last_due = last_due_before(&s, now).unwrap_or(0);
                s.pending = false;
            }
        }
        out.push(s);
    }
    write_all(&app, &out)?;
    Ok(report_subs_list(app))
}

/// L'app confirme (ou non) l'envoi de l'échéance en attente.
#[tauri::command]
pub fn report_subs_mark(app: tauri::AppHandle, id: String, ok: bool, status: String) -> Result<(), String> {
    let mut subs = read_all(&app);
    let Some(s) = subs.iter_mut().find(|s| s.id == id) else { return Err("abonnement introuvable".into()) };
    s.pending = false;
    s.last_status = status;
    if ok {
        s.last_run = Local::now().timestamp();
    }
    write_all(&app, &subs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap()
    }

    #[test]
    fn weekly_due_is_last_matching_weekday() {
        // Jeudi 8 octobre 2026, 10 h ; abonnement le lundi (1) à 8 h.
        let s = Subscription { freq: "weekly".into(), weekday: 1, time: "08:00".into(), ..Default::default() };
        let due = last_due_before(&s, at(2026, 10, 8, 10, 0)).unwrap();
        assert_eq!(due, at(2026, 10, 5, 8, 0).timestamp());
    }

    #[test]
    fn daily_before_time_falls_on_yesterday() {
        let s = Subscription { freq: "daily".into(), time: "18:30".into(), ..Default::default() };
        let due = last_due_before(&s, at(2026, 10, 8, 9, 0)).unwrap();
        assert_eq!(due, at(2026, 10, 7, 18, 30).timestamp());
        let next = next_due_after(&s, at(2026, 10, 8, 9, 0)).unwrap();
        assert_eq!(next, at(2026, 10, 8, 18, 30).timestamp());
    }

    #[test]
    fn monthly_clamps_day() {
        let s = Subscription { freq: "monthly".into(), monthday: 31, time: "07:00".into(), ..Default::default() };
        let due = last_due_before(&s, at(2026, 10, 8, 9, 0)).unwrap();
        assert_eq!(due, at(2026, 9, 28, 7, 0).timestamp());
    }
}
