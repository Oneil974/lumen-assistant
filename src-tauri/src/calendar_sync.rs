//! Synchronisation de l'Agenda : abonnements iCal et Google Agenda.
//!
//! **iCal** (`ical_fetch`) : la plupart des ENT, Moodle, ADE, Pronote,
//! Outlook et Google Agenda publient un emploi du temps sous forme d'adresse
//! `.ics`. Le front parse le texte (calendar/ical.js) ; Rust ne fait que le
//! téléchargement — une WebView ne peut pas lire une autre origine (CORS).
//!
//! **Google Agenda** (lecture ET écriture) : OAuth 2.0 « application
//! installée » avec PKCE et redirection sur 127.0.0.1 (RFC 8252). Lumen n'a
//! pas de compte développeur Google partagé : l'utilisateur crée son propre
//! identifiant client (type « Application de bureau ») et le colle dans
//! l'Agenda. Les jetons restent dans `google-calendar.json` et ne remontent
//! JAMAIS à la WebView — elle ne voit que l'état (connecté, adresse).

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const API: &str = "https://www.googleapis.com/calendar/v3";
const SCOPE: &str = "https://www.googleapis.com/auth/calendar openid email";
const MAX_ICS_BYTES: usize = 12 * 1024 * 1024;

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Lumen-Agenda/0.2")
        .build()
        .map_err(|e| e.to_string())
}

// ===== iCal ===================================================================

/// Télécharge un agenda `.ics` (http, https ou webcal) et renvoie son texte.
#[tauri::command]
pub async fn ical_fetch(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_ics(&url))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_ics(url: &str) -> Result<String, String> {
    let url = url.trim();
    let url = if let Some(rest) = url.strip_prefix("webcal://") {
        format!("https://{rest}")
    } else if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        return Err("Adresse invalide : elle doit commencer par https://, http:// ou webcal://".into());
    };
    let resp = http()?.get(&url).send().map_err(|e| format!("Téléchargement impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Le serveur a répondu {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    if bytes.len() > MAX_ICS_BYTES {
        return Err("Agenda trop volumineux (plus de 12 Mo).".into());
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    if !text.contains("BEGIN:VCALENDAR") {
        return Err("Ce n'est pas un agenda iCal (BEGIN:VCALENDAR absent). Vérifiez l'adresse d'export de votre ENT.".into());
    }
    Ok(text)
}

// ===== Google : configuration et jetons ========================================

#[derive(Serialize, Deserialize, Default, Clone)]
struct GoogleState {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    expires_at: u64,
    #[serde(default)]
    email: String,
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("google-calendar.json"))
}

fn read_state(app: &tauri::AppHandle) -> GoogleState {
    state_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_state(app: &tauri::AppHandle, st: &GoogleState) -> Result<(), String> {
    let p = state_path(app)?;
    fs::write(&p, serde_json::to_string_pretty(st).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// État visible par l'interface : jamais de secret ni de jeton.
#[tauri::command]
pub fn gcal_status(app: tauri::AppHandle) -> serde_json::Value {
    let st = read_state(&app);
    serde_json::json!({
        "configured": !st.client_id.is_empty(),
        "connected": !st.refresh_token.is_empty(),
        "email": st.email,
        "client_id_hint": st.client_id.chars().take(12).collect::<String>(),
    })
}

#[tauri::command]
pub fn gcal_configure(app: tauri::AppHandle, client_id: String, client_secret: String) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if !client_id.ends_with(".apps.googleusercontent.com") {
        return Err("Identifiant client inattendu : il se termine normalement par « .apps.googleusercontent.com ».".into());
    }
    let mut st = read_state(&app);
    if st.client_id != client_id {
        // Nouveau client : les anciens jetons ne sont plus valables.
        st = GoogleState::default();
    }
    st.client_id = client_id;
    st.client_secret = client_secret.trim().to_string();
    write_state(&app, &st)
}

#[tauri::command]
pub fn gcal_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    let mut st = read_state(&app);
    if !st.refresh_token.is_empty() {
        // Révocation best effort : même hors ligne, on oublie localement.
        let _ = http().and_then(|c| {
            c.post("https://oauth2.googleapis.com/revoke")
                .form(&[("token", st.refresh_token.as_str())])
                .send()
                .map_err(|e| e.to_string())
        });
    }
    st.refresh_token.clear();
    st.access_token.clear();
    st.expires_at = 0;
    st.email.clear();
    write_state(&app, &st)
}

fn b64url(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    URL_SAFE_NO_PAD.encode(bytes)
}

fn random_token(n: usize) -> Result<String, String> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    Ok(b64url(&buf))
}

fn pct(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// Ouvre la page de consentement Google dans le navigateur, attend le retour
/// sur 127.0.0.1 (5 minutes au plus) puis échange le code contre des jetons.
#[tauri::command]
pub async fn gcal_connect(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || connect(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn connect(app: &tauri::AppHandle) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use tauri_plugin_opener::OpenerExt;
    let mut st = read_state(app);
    if st.client_id.is_empty() {
        return Err("Renseignez d'abord votre identifiant client Google.".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_token(48)?;
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let csrf = random_token(16)?;
    let url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        pct(&st.client_id), pct(&redirect), pct(SCOPE), challenge, csrf
    );
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;

    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let (code, returned_state) = loop {
        if Instant::now() > deadline {
            return Err("Délai dépassé : la connexion Google n'a pas été confirmée dans le navigateur.".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
                let params: std::collections::HashMap<String, String> =
                    url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
                if params.is_empty() {
                    // Requête parasite (favicon…) : on attend la vraie.
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                    continue;
                }
                let ok = params.contains_key("code");
                let body = if ok {
                    "<html><meta charset=utf-8><body style=\"font-family:-apple-system,sans-serif;padding:40px\"><h2>Lumen est connecté à Google Agenda.</h2><p>Vous pouvez fermer cet onglet.</p></body></html>"
                } else {
                    "<html><meta charset=utf-8><body style=\"font-family:-apple-system,sans-serif;padding:40px\"><h2>Connexion annulée.</h2><p>Vous pouvez fermer cet onglet et réessayer depuis l'Agenda de Lumen.</p></body></html>"
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                if !ok {
                    return Err(format!("Google a refusé la connexion : {}", params.get("error").cloned().unwrap_or_default()));
                }
                break (params.get("code").cloned().unwrap_or_default(), params.get("state").cloned().unwrap_or_default());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(e.to_string()),
        }
    };
    if returned_state != csrf {
        return Err("Réponse Google inattendue (jeton anti-rejeu différent) : connexion refusée.".into());
    }
    let resp: serde_json::Value = http()?
        .post(TOKEN_URL)
        .form(&[
            ("code", code.as_str()),
            ("client_id", st.client_id.as_str()),
            ("client_secret", st.client_secret.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .and_then(|r| r.json())
        .map_err(|e| e.to_string())?;
    if let Some(err) = resp.get("error") {
        return Err(format!("Échange du code refusé : {err} {}", resp.get("error_description").and_then(|v| v.as_str()).unwrap_or("")));
    }
    st.access_token = resp["access_token"].as_str().unwrap_or("").to_string();
    st.refresh_token = resp["refresh_token"].as_str().unwrap_or("").to_string();
    st.expires_at = now_secs() + resp["expires_in"].as_u64().unwrap_or(3000).saturating_sub(60);
    st.email = resp["id_token"].as_str().and_then(email_from_id_token).unwrap_or_default();
    if st.refresh_token.is_empty() {
        return Err("Google n'a pas fourni de jeton durable. Retirez l'accès de Lumen dans votre compte Google puis réessayez.".into());
    }
    write_state(app, &st)?;
    Ok(st.email.clone())
}

/// Adresse e-mail lue dans l'id_token (JWT) — pour l'affichage seulement.
fn email_from_id_token(jwt: &str) -> Option<String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let payload = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("email").and_then(|e| e.as_str()).map(String::from)
}

fn access_token(app: &tauri::AppHandle) -> Result<String, String> {
    let mut st = read_state(app);
    if st.refresh_token.is_empty() {
        return Err("Google Agenda n'est pas connecté.".into());
    }
    if !st.access_token.is_empty() && now_secs() < st.expires_at {
        return Ok(st.access_token);
    }
    let resp: serde_json::Value = http()?
        .post(TOKEN_URL)
        .form(&[
            ("client_id", st.client_id.as_str()),
            ("client_secret", st.client_secret.as_str()),
            ("refresh_token", st.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .and_then(|r| r.json())
        .map_err(|e| e.to_string())?;
    if resp.get("error").is_some() {
        return Err("Accès Google expiré ou révoqué : reconnectez Google Agenda.".into());
    }
    st.access_token = resp["access_token"].as_str().unwrap_or("").to_string();
    st.expires_at = now_secs() + resp["expires_in"].as_u64().unwrap_or(3000).saturating_sub(60);
    write_state(app, &st)?;
    Ok(st.access_token)
}

fn api_get(app: &tauri::AppHandle, url: &str) -> Result<serde_json::Value, String> {
    let token = access_token(app)?;
    let resp = http()?.get(url).bearer_auth(token).send().map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Google Agenda : {}", v["error"]["message"].as_str().unwrap_or(status.as_str())));
    }
    Ok(v)
}

// ===== Google : agendas et évènements ==========================================

#[tauri::command]
pub async fn gcal_calendars(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v = api_get(&app, &format!("{API}/users/me/calendarList?maxResults=250"))?;
        Ok(v["items"].as_array().cloned().unwrap_or_default().into_iter().map(|c| serde_json::json!({
            "id": c["id"], "name": c["summaryOverride"].as_str().or(c["summary"].as_str()).unwrap_or(""),
            "color": c["backgroundColor"], "primary": c["primary"].as_bool().unwrap_or(false),
            "writable": matches!(c["accessRole"].as_str(), Some("owner") | Some("writer")),
        })).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn rfc3339(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

/// Évènements d'un agenda Google entre deux instants (ms), récurrences dépliées.
#[tauri::command]
pub async fn gcal_events(app: tauri::AppHandle, calendar_id: String, time_min: i64, time_max: i64) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut page = String::new();
        for _ in 0..10 {
            let url = format!(
                "{API}/calendars/{}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin={}&timeMax={}{}",
                pct(&calendar_id), pct(&rfc3339(time_min)), pct(&rfc3339(time_max)),
                if page.is_empty() { String::new() } else { format!("&pageToken={}", pct(&page)) }
            );
            let v = api_get(&app, &url)?;
            for e in v["items"].as_array().cloned().unwrap_or_default() {
                if e["status"] == "cancelled" { continue; }
                let all_day = e["start"]["date"].is_string();
                out.push(serde_json::json!({
                    "uid": e["id"], "title": e["summary"].as_str().unwrap_or(""),
                    "location": e["location"].as_str().unwrap_or(""),
                    "description": e["description"].as_str().unwrap_or(""),
                    "start": e["start"]["dateTime"].as_str().or(e["start"]["date"].as_str()).unwrap_or(""),
                    "end": e["end"]["dateTime"].as_str().or(e["end"]["date"].as_str()).unwrap_or(""),
                    "allDay": all_day,
                    "link": e["htmlLink"],
                }));
            }
            match v["nextPageToken"].as_str() {
                Some(t) => page = t.to_string(),
                None => break,
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct NewEvent {
    title: String,
    start: i64,
    end: i64,
    #[serde(default)]
    all_day: bool,
    #[serde(default)]
    description: String,
    #[serde(default)]
    location: String,
    /// Identifiant Google déjà attribué : mise à jour plutôt que doublon.
    #[serde(default)]
    google_id: String,
}

/// Crée (ou met à jour) un évènement dans un agenda Google ; renvoie son id.
#[tauri::command]
pub async fn gcal_upsert(app: tauri::AppHandle, calendar_id: String, event: NewEvent) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = access_token(&app)?;
        let when = |ms: i64| {
            if event.all_day {
                serde_json::json!({ "date": rfc3339(ms).get(0..10).unwrap_or("") })
            } else {
                serde_json::json!({ "dateTime": rfc3339(ms) })
            }
        };
        let body = serde_json::json!({
            "summary": event.title, "description": event.description, "location": event.location,
            "start": when(event.start), "end": when(event.end.max(event.start + 60_000)),
            "source": { "title": "Lumen", "url": "https://github.com/Oneil974/lumen-assistant" },
        });
        let client = http()?;
        let base = format!("{API}/calendars/{}/events", pct(&calendar_id));
        let req = if event.google_id.is_empty() {
            client.post(&base)
        } else {
            client.put(format!("{base}/{}", pct(&event.google_id)))
        };
        let resp = req.bearer_auth(token).json(&body).send().map_err(|e| e.to_string())?;
        let status = resp.status();
        let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Google Agenda : {}", v["error"]["message"].as_str().unwrap_or(status.as_str())));
        }
        Ok(v["id"].as_str().unwrap_or("").to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gcal_delete(app: tauri::AppHandle, calendar_id: String, event_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = access_token(&app)?;
        let resp = http()?
            .delete(format!("{API}/calendars/{}/events/{}", pct(&calendar_id), pct(&event_id)))
            .bearer_auth(token)
            .send()
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() || resp.status().as_u16() == 410 {
            Ok(())
        } else {
            Err(format!("Google Agenda : suppression refusée ({})", resp.status()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_is_read_from_id_token() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let payload = URL_SAFE_NO_PAD.encode(br#"{"email":"etu@exemple.fr"}"#);
        assert_eq!(email_from_id_token(&format!("h.{payload}.s")).as_deref(), Some("etu@exemple.fr"));
    }

    #[test]
    fn rfc3339_is_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
    }
}
