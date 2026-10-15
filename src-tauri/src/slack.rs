//! Passerelle **Slack** : un bot Lumen dans votre espace de travail Slack — en
//! message privé ou par @mention dans un canal — avec les mêmes outils, le même
//! profil et les mêmes agents que la passerelle Telegram.
//!
//! ## Pourquoi ce design (mêmes principes que `telegram.rs`)
//!
//! * **Aucun port entrant — Socket Mode.** Pas d'URL publique ni de webhook :
//!   Lumen ouvre lui-même une WebSocket SORTANTE (`apps.connections.open`,
//!   rustls) et Slack y pousse les évènements. Rien à exposer, rien à router.
//! * **Les jetons ne quittent jamais le backend.** Jeton de bot (`xoxb-…`) et
//!   jeton d'app (`xapp-…`) vivent dans `profiles/<id>/slack/slack.json` (0600)
//!   et ne sont jamais renvoyés au front (aperçu masqué seulement).
//! * **Liste blanche d'utilisateurs.** Un espace Slack compte des collègues :
//!   Lumen n'obéit qu'aux utilisateurs appairés par un code à usage unique
//!   (`!appairer CODE` en message privé, ou `/lumen appairer CODE`). Un inconnu
//!   est ignoré en silence — y compris dans un canal où le bot est mentionné.
//! * **Contenu entrant = donnée.** Sortie du modèle échappée pour Slack (`<`,
//!   `>`, `&`) : un modèle ne peut pas y glisser un `<!channel>` ni un lien
//!   déguisé ; secrets connus retirés (`redact`).
//!
//! ## Le cerveau est celui de Telegram
//!
//! Contrat d'outils, prompts système + profil Lumen, choix du moteur : tout est
//! repris de `telegram.rs` (`all_tool_specs`, `exec_tool_to` avec
//! `Dest::Slack`, `llm_config`…). Seul le transport change — et une touche
//! propre à Slack : un agent répond **sous son propre nom**, avec l'émoji de la
//! couleur de son avatar (`chat:write.customize`).

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use crate::telegram::{self as tg, Dest, Route, TgConfig};

/// Endpoint Slack, en dur : la cible des requêtes n'est jamais configurable.
const API: &str = "https://slack.com/api";
/// Slack accepte ~40 000 caractères, mais les messages longs se lisent mal.
const CHUNK: usize = 3500;
const MAX_IN: usize = 4000;
const RATE_WINDOW: u64 = 60;
const RATE_MAX: usize = 20;
const PAIR_TTL: u64 = 600;
const PAIR_MAX_FAILS: u32 = 5;
const MAX_TOOL_ROUNDS: usize = 6;
const HISTORY_MAX: usize = 12;

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ===================== Configuration persistée =====================

fn def_lumen() -> String {
    "lumen".into()
}
fn def_tools() -> String {
    "tools".into()
}
fn def_true() -> bool {
    true
}
fn def_bonsai() -> String {
    "bonsai".into()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SlackUser {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub added_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SlackConfig {
    #[serde(default)]
    pub enabled: bool,
    /// SECRET — jeton de bot `xoxb-…` (Web API).
    #[serde(default)]
    pub bot_token: String,
    /// SECRET — jeton d'app `xapp-…` (Socket Mode, `connections:write`).
    #[serde(default)]
    pub app_token: String,
    #[serde(default)]
    pub users: Vec<SlackUser>,
    #[serde(default)]
    pub pair_code: String,
    #[serde(default)]
    pub pair_expires: u64,
    #[serde(default)]
    pub pair_fails: u32,
    #[serde(default = "def_lumen")]
    pub backend: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub llama_model: String,
    #[serde(default)]
    pub api_model: String,
    #[serde(default)]
    pub applefm_model: String,
    #[serde(default = "def_tools")]
    pub mode: String,
    #[serde(default = "def_true")]
    pub allow_tools: bool,
    #[serde(default = "def_true")]
    pub allow_agents: bool,
    #[serde(default = "def_true")]
    pub allow_images: bool,
    #[serde(default = "def_true")]
    pub show_tool_calls: bool,
    #[serde(default = "def_bonsai")]
    pub image_provider: String,
    #[serde(default)]
    pub image_model: String,
    /// Un agent répond sous son nom et l'émoji de son avatar.
    #[serde(default = "def_true")]
    pub agent_personas: bool,
    /// Répondre aux @mentions dans les canaux (utilisateurs appairés seulement).
    #[serde(default = "def_true")]
    pub channels: bool,
}

impl Default for SlackConfig {
    fn default() -> Self {
        serde_json::from_value(json!({})).expect("défauts serde")
    }
}

impl SlackConfig {
    /// Vue « Telegram » de la config : c'est elle que consomment les outils et
    /// le choix du moteur partagés. `token` = jeton de bot, pour que `redact`
    /// le retire de toute sortie.
    fn as_tg(&self) -> TgConfig {
        TgConfig {
            enabled: self.enabled,
            token: self.bot_token.clone(),
            backend: self.backend.clone(),
            model: self.model.clone(),
            llama_model: self.llama_model.clone(),
            api_model: self.api_model.clone(),
            applefm_model: self.applefm_model.clone(),
            mode: self.mode.clone(),
            allow_tools: self.allow_tools,
            allow_agents: self.allow_agents,
            allow_images: self.allow_images,
            show_tool_calls: self.show_tool_calls,
            image_provider: self.image_provider.clone(),
            image_model: self.image_model.clone(),
            ..Default::default()
        }
    }
}

fn profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("profiles")
        .join(crate::session::active_profile_id(app))
        .join("slack");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn read_config(app: &tauri::AppHandle) -> SlackConfig {
    profile_dir(app)
        .ok()
        .and_then(|d| fs::read_to_string(d.join("slack.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_private(path: &PathBuf, body: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn write_config(app: &tauri::AppHandle, cfg: &SlackConfig) -> Result<(), String> {
    let path = profile_dir(app)?.join("slack.json");
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    write_private(&path, &body)
}

/// Forme d'un jeton Slack : préfixe attendu + alphabet sûr (il finit dans un
/// en-tête HTTP, jamais dans une URL).
fn valid_token(t: &str, prefix: &str) -> bool {
    t.starts_with(prefix)
        && (20..=300).contains(&t.len())
        && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn mask(t: &str) -> String {
    let t = t.trim();
    if t.is_empty() {
        return String::new();
    }
    let head: String = t.chars().take(5).collect();
    let tail: String = t.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}…{tail}")
}

/// Manifeste d'app Slack : à coller dans « Create New App → From a manifest ».
/// Tout ce qu'il faut, rien de plus : Socket Mode, DM + @mention, `/lumen`.
pub fn manifest(en: bool) -> Value {
    json!({
        "display_information": {
            "name": "Lumen",
            "description": if en { "Your Lumen assistant and its agents, right in Slack." } else { "Votre assistant Lumen et ses agents, directement dans Slack." },
            "background_color": "#1d1b26"
        },
        "features": {
            "app_home": { "home_tab_enabled": false, "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
            "bot_user": { "display_name": "Lumen", "always_online": true },
            "slash_commands": [{
                "command": "/lumen",
                "description": if en { "Drive Lumen: help, status, mode, agents…" } else { "Piloter Lumen : aide, état, mode, agents…" },
                "usage_hint": if en { "help | status | mode tools | agent <name> <task>" } else { "aide | etat | mode outils | agent <nom> <tâche>" },
                "should_escape": false
            }]
        },
        "oauth_config": { "scopes": { "bot": [
            "app_mentions:read", "chat:write", "chat:write.customize", "commands", "files:write",
            "im:history", "im:read", "im:write", "reactions:write", "users:read"
        ] } },
        "settings": {
            "event_subscriptions": { "bot_events": ["app_mention", "message.im"] },
            "interactivity": { "is_enabled": false },
            "org_deploy_enabled": false,
            "socket_mode_enabled": true,
            "token_rotation_enabled": false
        }
    })
}

// ===================== État d'exécution =====================

#[derive(Default, Clone, Serialize)]
pub struct RunStatus {
    pub running: bool,
    pub team: String,
    pub bot_name: String,
    pub bot_user_id: String,
    pub last_error: String,
    pub last_event: u64,
    pub rejected: u64,
}

#[derive(Default)]
struct Session {
    history: Vec<Value>,
    busy: bool,
    hits: Vec<u64>,
}

#[derive(Default, Clone)]
pub struct SlackState {
    status: Arc<std::sync::Mutex<RunStatus>>,
    generation: Arc<AtomicU64>,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// Identifiants d'évènements déjà traités : Slack REJOUE un évènement non
    /// acquitté à temps, il ne doit pas déclencher deux réponses.
    seen: Arc<std::sync::Mutex<VecDeque<String>>>,
}

impl SlackState {
    fn set_status(&self, f: impl FnOnce(&mut RunStatus)) {
        if let Ok(mut st) = self.status.lock() {
            f(&mut st);
        }
    }
    fn first_time(&self, id: &str) -> bool {
        if id.is_empty() {
            return true;
        }
        let Ok(mut seen) = self.seen.lock() else { return true };
        if seen.iter().any(|x| x == id) {
            return false;
        }
        seen.push_back(id.to_string());
        if seen.len() > 300 {
            seen.pop_front();
        }
        true
    }
}

// ===================== Web API (sortant) =====================

fn client(timeout: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .unwrap_or_default()
}

async fn call(token: &str, method: &str, body: Value) -> Result<Value, String> {
    let resp = client(30)
        .post(format!("{API}/{method}"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Slack injoignable : {e}"))?;
    let v: Value = resp.json().await.map_err(|e| format!("Réponse Slack illisible : {e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
        return Err(v.get("error").and_then(|d| d.as_str()).unwrap_or("erreur Slack").to_string());
    }
    Ok(v)
}

/// Variante en formulaire (certaines méthodes n'acceptent pas le JSON).
async fn call_form(token: &str, method: &str, form: &[(&str, String)]) -> Result<Value, String> {
    let resp = client(30)
        .post(format!("{API}/{method}"))
        .bearer_auth(token)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("Slack injoignable : {e}"))?;
    let v: Value = resp.json().await.map_err(|e| format!("Réponse Slack illisible : {e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
        return Err(v.get("error").and_then(|d| d.as_str()).unwrap_or("erreur Slack").to_string());
    }
    Ok(v)
}

/// Échappement obligatoire de Slack, appliqué à TOUT texte venu d'un modèle :
/// neutralise `<!channel>`, `<@U…>` et les liens déguisés.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Markdown « modèle » → mrkdwn Slack, APRÈS échappement : gras, titres,
/// liens `[texte](https://…)`. Le reste passe tel quel (Slack lit déjà les
/// listes, le code et les citations).
fn to_mrkdwn(md: &str) -> String {
    let text = escape(md);
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim_start();
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        let line = if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            format!("*{}*", trimmed[hashes..].trim())
        } else {
            line.to_string()
        };
        out.push_str(&line.replace("**", "*"));
        out.push('\n');
    }
    // Liens Markdown → <url|texte>, uniquement http(s).
    let mut result = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(start) = rest.find('[') {
        let (before, after) = rest.split_at(start);
        result.push_str(before);
        let parsed = after.find("](").and_then(|mid| {
            let label = &after[1..mid];
            let tail = &after[mid + 2..];
            let end = tail.find(')')?;
            let url = &tail[..end];
            (!label.contains('\n') && (url.starts_with("https://") || url.starts_with("http://")) && !url.contains(' '))
                .then(|| (format!("<{url}|{label}>"), mid + 2 + end + 1))
        });
        match parsed {
            Some((link, used)) => {
                result.push_str(&link);
                rest = &after[used..];
            }
            None => {
                result.push('[');
                rest = &after[1..];
            }
        }
    }
    result.push_str(rest);
    result.trim_end().to_string()
}

fn chunks(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return vec![];
    }
    chars.chunks(CHUNK).map(|c| c.iter().collect()).collect()
}

/// Identité d'un message : Lumen, ou un agent qui parle en son nom.
#[derive(Clone, Default)]
struct Persona {
    name: String,
    emoji: String,
}

/// Publie un message (texte déjà au format Slack). Renvoie son `ts`.
async fn post(
    token: &str,
    channel: &str,
    thread_ts: &str,
    text: &str,
    persona: Option<&Persona>,
) -> Result<String, String> {
    let mut last = String::new();
    for part in chunks(text) {
        let mut body = json!({ "channel": channel, "text": part, "unfurl_links": false, "unfurl_media": false });
        if !thread_ts.is_empty() {
            body["thread_ts"] = json!(thread_ts);
        }
        if let Some(p) = persona {
            body["username"] = json!(p.name);
            if !p.emoji.is_empty() {
                body["icon_emoji"] = json!(p.emoji);
            }
        }
        let res = match call(token, "chat.postMessage", body.clone()).await {
            // Portée `chat:write.customize` absente : on publie sous le nom du
            // bot, en signant le message, plutôt que de perdre la réponse.
            Err(e) if persona.is_some() && e.contains("missing_scope") => {
                let p = persona.unwrap();
                body.as_object_mut().map(|o| {
                    o.remove("username");
                    o.remove("icon_emoji");
                });
                body["text"] = json!(format!("*{}* :\n{}", escape(&p.name), part));
                call(token, "chat.postMessage", body).await
            }
            other => other,
        }?;
        last = res.get("ts").and_then(|v| v.as_str()).unwrap_or("").to_string();
    }
    Ok(last)
}

async fn update(token: &str, channel: &str, ts: &str, text: &str) -> Result<(), String> {
    let first = chunks(text).into_iter().next().unwrap_or_default();
    call(token, "chat.update", json!({ "channel": channel, "ts": ts, "text": first })).await.map(|_| ())
}

async fn react(token: &str, channel: &str, ts: &str, name: &str, add: bool) {
    if ts.is_empty() {
        return;
    }
    let method = if add { "reactions.add" } else { "reactions.remove" };
    let _ = call(token, method, json!({ "channel": channel, "timestamp": ts, "name": name })).await;
}

/// Envoi de fichier (PDF, image) par le flux actuel de Slack :
/// `files.getUploadURLExternal` → dépôt des octets → `files.completeUploadExternal`.
pub(crate) async fn upload_file(
    app: &tauri::AppHandle,
    channel: &str,
    thread_ts: &str,
    bytes: Vec<u8>,
    filename: &str,
    title: &str,
) -> Result<(), String> {
    let cfg = read_config(app);
    let token = cfg.bot_token.as_str();
    let v = call_form(
        token,
        "files.getUploadURLExternal",
        &[("filename", filename.to_string()), ("length", bytes.len().to_string())],
    )
    .await?;
    let url = v.get("upload_url").and_then(|x| x.as_str()).ok_or("URL de dépôt absente")?.to_string();
    let file_id = v.get("file_id").and_then(|x| x.as_str()).ok_or("identifiant de fichier absent")?.to_string();
    // L'URL de dépôt est fournie par Slack (hôte files.slack.com) : on vérifie
    // tout de même qu'elle reste chez Slack avant d'y pousser les octets.
    if !url.starts_with("https://files.slack.com/") {
        return Err("URL de dépôt inattendue".into());
    }
    client(120)
        .post(&url)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Dépôt du fichier échoué : {e}"))?;
    let mut body = json!({ "files": [{ "id": file_id, "title": title }], "channel_id": channel });
    if !thread_ts.is_empty() {
        body["thread_ts"] = json!(thread_ts);
    }
    call(token, "files.completeUploadExternal", body).await.map(|_| ())
}

// ===================== Socket Mode =====================

pub async fn start(app: tauri::AppHandle, state: SlackState) -> Result<(), String> {
    let cfg = read_config(&app);
    if !cfg.enabled {
        return Err("Passerelle Slack désactivée.".into());
    }
    if !valid_token(&cfg.bot_token, "xoxb-") {
        return Err("Jeton de bot absent ou mal formé (xoxb-…).".into());
    }
    if !valid_token(&cfg.app_token, "xapp-") {
        return Err("Jeton d'app absent ou mal formé (xapp-…).".into());
    }
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    // `auth.test` valide le jeton de bot tout de suite (erreur utile dans l'UI).
    let me = call(&cfg.bot_token, "auth.test", json!({})).await?;
    let team = me.get("team").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let bot_name = me.get("user").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let bot_id = me.get("user_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    state.set_status(|st| {
        st.running = true;
        st.team = team;
        st.bot_name = bot_name;
        st.bot_user_id = bot_id;
        st.last_error = String::new();
    });
    let _ = app.emit("slack-updated", ());
    let (app2, state2, app_token) = (app.clone(), state.clone(), cfg.app_token.clone());
    std::thread::Builder::new()
        .name("lumen-slack".into())
        .spawn(move || socket_loop(app2, state2, gen, app_token))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn stop(state: &SlackState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.set_status(|st| st.running = false);
}

fn open_socket_url(app_token: &str) -> Result<String, String> {
    let v: Value = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{API}/apps.connections.open"))
        .bearer_auth(app_token)
        .send()
        .map_err(|e| format!("Slack injoignable : {e}"))?
        .json()
        .map_err(|e| format!("Réponse Slack illisible : {e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
        return Err(v.get("error").and_then(|d| d.as_str()).unwrap_or("apps.connections.open").to_string());
    }
    v.get("url").and_then(|u| u.as_str()).map(String::from).ok_or_else(|| "URL de socket absente".into())
}

/// Boucle Socket Mode (thread dédié, tungstenite bloquant). Se reconnecte seule
/// (Slack demande régulièrement une reconnexion) et s'arrête dès que sa
/// génération devient obsolète — SANS acquitter : un évènement reçu par une
/// boucle mourante est ainsi rejoué par Slack sur la connexion suivante.
fn socket_loop(app: tauri::AppHandle, state: SlackState, gen: u64, app_token: String) {
    let alive = |s: &SlackState| s.generation.load(Ordering::SeqCst) == gen;
    let mut backoff = 2u64;
    while alive(&state) {
        let url = match open_socket_url(&app_token) {
            Ok(u) => u,
            Err(e) => {
                state.set_status(|st| st.last_error = e);
                let _ = app.emit("slack-updated", ());
                std::thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(60);
                continue;
            }
        };
        let mut socket = match tungstenite::connect(url.as_str()) {
            Ok((s, _)) => s,
            Err(e) => {
                state.set_status(|st| st.last_error = format!("socket : {e}"));
                std::thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(60);
                continue;
            }
        };
        // Lecture bornée : sans ça, un arrêt ne serait vu qu'au prochain message.
        let timeout = Some(Duration::from_secs(2));
        match socket.get_mut() {
            tungstenite::stream::MaybeTlsStream::Plain(s) => {
                let _ = s.set_read_timeout(timeout);
            }
            tungstenite::stream::MaybeTlsStream::Rustls(s) => {
                let _ = s.sock.set_read_timeout(timeout);
            }
            _ => {}
        }
        backoff = 2;
        state.set_status(|st| st.last_error = String::new());
        loop {
            if !alive(&state) {
                let _ = socket.close(None);
                return;
            }
            match socket.read() {
                Ok(tungstenite::Message::Text(text)) => {
                    let Ok(env) = serde_json::from_str::<Value>(&text) else { continue };
                    let kind = env.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if kind == "disconnect" {
                        break; // Slack demande de rouvrir une connexion
                    }
                    if !alive(&state) {
                        return; // pas d'acquittement : Slack rejouera ailleurs
                    }
                    if let Some(id) = env.get("envelope_id").and_then(|v| v.as_str()) {
                        let ack = json!({ "envelope_id": id });
                        let _ = socket.send(tungstenite::Message::Text(ack.to_string()));
                    }
                    let payload = env.get("payload").cloned().unwrap_or(Value::Null);
                    match kind {
                        "events_api" => {
                            let (a, s) = (app.clone(), state.clone());
                            tauri::async_runtime::spawn(async move { on_event(a, s, payload).await });
                        }
                        "slash_commands" => {
                            let (a, s) = (app.clone(), state.clone());
                            tauri::async_runtime::spawn(async move { on_slash(a, s, payload).await });
                        }
                        _ => {}
                    }
                }
                Ok(tungstenite::Message::Ping(p)) => {
                    let _ = socket.send(tungstenite::Message::Pong(p));
                }
                Ok(tungstenite::Message::Close(_)) => break,
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(e) => {
                    state.set_status(|st| st.last_error = format!("socket : {e}"));
                    break;
                }
            }
        }
    }
}

// ===================== Réception =====================

/// Où répondre : le canal, et le fil (vide en message privé hors fil).
#[derive(Clone)]
struct Where {
    channel: String,
    thread_ts: String,
    /// Message de l'utilisateur (pour les réactions « je regarde » / « fait »).
    msg_ts: String,
    user: String,
}

impl Where {
    fn key(&self) -> String {
        format!("{}:{}", self.channel, self.thread_ts)
    }
}

async fn on_event(app: tauri::AppHandle, state: SlackState, payload: Value) {
    let event_id = payload.get("event_id").and_then(|v| v.as_str()).unwrap_or("");
    if !state.first_time(event_id) {
        return;
    }
    let ev = payload.get("event").cloned().unwrap_or(Value::Null);
    let kind = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
    // Jamais nos propres messages ni ceux d'autres bots ; ni les éditions,
    // suppressions et autres sous-types : seul le texte tapé par un humain.
    if ev.get("bot_id").is_some() || ev.get("subtype").is_some() {
        return;
    }
    let cfg = read_config(&app);
    let user = ev.get("user").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let channel = ev.get("channel").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ts = ev.get("ts").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let thread = ev.get("thread_ts").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut text = ev.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if user.is_empty() || channel.is_empty() {
        return;
    }
    let is_dm = kind == "message" && ev.get("channel_type").and_then(|v| v.as_str()) == Some("im");
    let is_mention = kind == "app_mention";
    if !is_dm && !is_mention {
        return;
    }
    if is_mention {
        if !cfg.channels {
            return;
        }
        // Retire la mention du bot (`<@U123>`) en tête de message.
        let bot = state.status.lock().map(|s| s.bot_user_id.clone()).unwrap_or_default();
        text = text.replace(&format!("<@{bot}>"), "").trim().to_string();
    }
    state.set_status(|st| st.last_event = now_secs());

    let at = Where {
        channel,
        // En canal, on répond toujours en fil : on ne pollue pas la discussion.
        thread_ts: if !thread.is_empty() { thread } else if is_mention { ts.clone() } else { String::new() },
        msg_ts: ts,
        user: user.clone(),
    };

    if !cfg.users.iter().any(|u| u.id == user) {
        // Seule porte d'entrée : le code d'appairage, en message privé.
        if is_dm {
            if let Some(code) = pair_code_in(&text) {
                try_pair(&app, &state, &at, &code).await;
                return;
            }
        }
        state.set_status(|st| st.rejected += 1);
        return;
    }
    let text: String = text.trim().chars().take(MAX_IN).collect();
    if text.is_empty() {
        return;
    }
    dispatch(app, state, cfg, at, text).await;
}

/// `/lumen …` : même porte que les messages (appairage, liste blanche).
async fn on_slash(app: tauri::AppHandle, state: SlackState, payload: Value) {
    let user = payload.get("user_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let channel = payload.get("channel_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let cfg = read_config(&app);
    // Une commande slash n'a pas de message à qui répondre : on écrit en privé
    // à l'utilisateur (conversations.open), jamais dans le canal courant.
    let dm = match call(&cfg.bot_token, "conversations.open", json!({ "users": user })).await {
        Ok(v) => v.pointer("/channel/id").and_then(|x| x.as_str()).unwrap_or(channel.as_str()).to_string(),
        Err(_) => return,
    };
    let at = Where { channel: dm, thread_ts: String::new(), msg_ts: String::new(), user: user.clone() };
    if !cfg.users.iter().any(|u| u.id == user) {
        if let Some(code) = pair_code_in(&format!("!{text}")) {
            try_pair(&app, &state, &at, &code).await;
        } else {
            state.set_status(|st| st.rejected += 1);
        }
        return;
    }
    let text = if text.is_empty() { "!aide".to_string() } else { format!("!{text}") };
    dispatch(app, state, cfg, at, text).await;
}

fn pair_code_in(text: &str) -> Option<String> {
    let t = text.trim().trim_start_matches(['!', '/']);
    let mut it = t.split_whitespace();
    let verb = it.next()?.to_lowercase();
    if !["appairer", "pair", "start", "code"].contains(&verb.as_str()) {
        return None;
    }
    it.next().map(|c| c.trim().to_uppercase())
}

fn constant_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn try_pair(app: &tauri::AppHandle, state: &SlackState, at: &Where, code: &str) {
    let mut cfg = read_config(app);
    let valid = !cfg.pair_code.is_empty() && cfg.pair_expires > now_secs();
    if !valid || !constant_eq(&cfg.pair_code, code) {
        // Pas de réponse : aucun oracle pour qui tâtonne.
        if valid {
            cfg.pair_fails += 1;
            if cfg.pair_fails >= PAIR_MAX_FAILS {
                cfg.pair_code = String::new();
                cfg.pair_expires = 0;
            }
            let _ = write_config(app, &cfg);
        }
        state.set_status(|st| st.rejected += 1);
        return;
    }
    let name = call(&cfg.bot_token, "users.info", json!({ "user": at.user }))
        .await
        .ok()
        .and_then(|v| {
            v.pointer("/user/real_name")
                .or_else(|| v.pointer("/user/name"))
                .and_then(|x| x.as_str())
                .map(String::from)
        })
        .unwrap_or_default();
    cfg.pair_code = String::new();
    cfg.pair_expires = 0;
    cfg.pair_fails = 0;
    if !cfg.users.iter().any(|u| u.id == at.user) {
        cfg.users.push(SlackUser { id: at.user.clone(), name: name.clone(), added_at: now_secs() });
    }
    let _ = write_config(app, &cfg);
    let _ = app.emit("slack-updated", ());
    let en = tg::is_en(app);
    let hello = if en {
        format!("✅ Paired{}. I'm Lumen — write to me here, or mention me in a channel.\n\n{}", if name.is_empty() { String::new() } else { format!(", {name}") }, help(app, &cfg, en))
    } else {
        format!("✅ Appairé{}. Je suis Lumen — écris-moi ici, ou mentionne-moi dans un canal.\n\n{}", if name.is_empty() { String::new() } else { format!(", {name}") }, help(app, &cfg, en))
    };
    let _ = post(&cfg.bot_token, &at.channel, &at.thread_ts, &hello, None).await;
}

// ===================== Aiguillage =====================

async fn dispatch(app: tauri::AppHandle, state: SlackState, cfg: SlackConfig, at: Where, text: String) {
    let key = at.key();
    {
        let mut sessions = state.sessions.lock().await;
        let s = sessions.entry(key.clone()).or_default();
        let now = now_secs();
        s.hits.retain(|t| now.saturating_sub(*t) < RATE_WINDOW);
        if s.hits.len() >= RATE_MAX {
            return;
        }
        s.hits.push(now);
        if s.busy {
            let en = tg::is_en(&app);
            let _ = post(&cfg.bot_token, &at.channel, &at.thread_ts, if en { "⏳ Still on the previous request…" } else { "⏳ Je termine la demande précédente…" }, None).await;
            return;
        }
        s.busy = true;
    }
    log_turn(&app, &at, "user", &text);
    handle(&app, &state, &cfg, &at, &text).await;
    if let Some(s) = state.sessions.lock().await.get_mut(&key) {
        s.busy = false;
    }
}

async fn handle(app: &tauri::AppHandle, state: &SlackState, cfg: &SlackConfig, at: &Where, text: &str) {
    let en = tg::is_en(app);
    if let Some(cmd) = text.strip_prefix('!') {
        // `Some("")` = commande traitée qui a déjà répondu (agent, image).
        if let Some(reply) = command(app, state, at, cmd).await {
            if !reply.is_empty() {
                say(app, cfg, at, &reply, None).await;
            }
            return;
        }
    }
    // « Veilleur web : fais la revue de presse » → l'agent en personne.
    if cfg.allow_agents {
        let agents = crate::agents::agent_list(app.clone());
        if let Some((agent, task)) = agent_prefix(text, &agents) {
            run_agent(app, cfg, at, &agent, &task).await;
            return;
        }
    }
    let route = Route { backend: cfg.backend.clone(), model: tg::model_for(&cfg.as_tg(), &cfg.backend), mode: cfg.mode.clone() };
    match cfg.mode.as_str() {
        "agent" if cfg.allow_agents => {
            let agents = crate::agents::agent_list(app.clone());
            match agents.iter().find(|a| a.enabled).or_else(|| agents.first()) {
                Some(a) => run_agent(app, cfg, at, a, text).await,
                None => say(app, cfg, at, if en { "No agent configured in Lumen yet." } else { "Aucun agent n'est encore configuré dans Lumen." }, None).await,
            }
        }
        "image" if cfg.allow_images => image(app, cfg, at, text).await,
        "chat" => turn(app, state, cfg, at, &route, text, false).await,
        _ => turn(app, state, cfg, at, &route, text, cfg.allow_tools).await,
    }
}

/// Publie une réponse de modèle (Markdown → mrkdwn, secrets retirés).
async fn say(app: &tauri::AppHandle, cfg: &SlackConfig, at: &Where, text: &str, persona: Option<&Persona>) {
    let clean = redact(app, cfg, text);
    let _ = post(&cfg.bot_token, &at.channel, &at.thread_ts, &to_mrkdwn(&clean), persona).await;
    log_turn(app, at, persona.map(|p| p.name.as_str()).unwrap_or("lumen"), &clean);
}

fn redact(app: &tauri::AppHandle, cfg: &SlackConfig, text: &str) -> String {
    let mut out = tg::redact(app, &cfg.as_tg(), text);
    if cfg.app_token.len() >= 8 && out.contains(&cfg.app_token) {
        out = out.replace(&cfg.app_token, "[secret masqué]");
    }
    out
}

/// Un tour de conversation, avec ou sans outils. Un message provisoire
/// (« Lumen réfléchit… ») est mis à jour au fil des appels d'outils, puis
/// remplacé par la réponse : un seul message, qui vit.
async fn turn(
    app: &tauri::AppHandle,
    state: &SlackState,
    cfg: &SlackConfig,
    at: &Where,
    route: &Route,
    prompt: &str,
    with_tools: bool,
) {
    let en = tg::is_en(app);
    let tgc = cfg.as_tg();
    let token = cfg.bot_token.as_str();
    react(token, &at.channel, &at.msg_ts, "eyes", true).await;
    let placeholder = post(token, &at.channel, &at.thread_ts, if en { "_Lumen is thinking…_" } else { "_Lumen réfléchit…_" }, None)
        .await
        .unwrap_or_default();

    let llm = tg::llm_config(app, route);
    // Moteur de décision (Tev1) : une réponse directe n'a pas besoin du
    // catalogue d'outils — un petit modèle s'y perdait (salut → météo).
    // Un « direct » contredit par un signal fort (météo, mail…) reste outils.
    let with_tools = with_tools && {
        let prev = state.sessions.lock().await.get(&at.key())
            .and_then(|s| s.history.iter().rev().find(|m| m["role"] == "user").and_then(|m| m["content"].as_str()).map(str::to_string))
            .unwrap_or_default();
        match crate::llama::auto_route(app, prompt, &prev, true).await {
            Some(r) if r == "direct" => crate::messenger::strong_signal(prompt),
            _ => true,
        }
    };
    let tools = if with_tools { tg::all_tool_specs(app, &tgc).await } else { vec![] };
    let base = if with_tools { tool_prompt(en) } else { chat_prompt(en) };
    let id = if with_tools { "slack.tools" } else { "slack.chat" };
    let mut messages = vec![json!({ "role": "system", "content": tg::system_prompt(app, id, base, en).await })];
    if let Some(s) = state.sessions.lock().await.get(&at.key()) {
        messages.extend(s.history.iter().cloned());
    }
    messages.push(json!({ "role": "user", "content": prompt }));

    let dest = Dest::Slack { channel: at.channel.clone(), thread_ts: at.thread_ts.clone() };
    let mut trace: Vec<String> = Vec::new();
    let mut answer: Option<String> = None;
    for _ in 0..MAX_TOOL_ROUNDS {
        let (app2, llm2, msgs, tools2) = (app.clone(), llm.clone(), messages.clone(), tools.clone());
        let step = tokio::task::spawn_blocking(move || {
            crate::agents::chat_messages(&app2, &llm2, &msgs, if tools2.is_empty() { None } else { Some(tools2.as_slice()) })
        })
        .await
        .unwrap_or_else(|e| Err(format!("Tâche interrompue : {e}")));
        let msg = match step {
            Ok(m) => m,
            Err(e) => {
                answer = Some(format!("⚠️ {e}"));
                break;
            }
        };
        let calls = msg.get("tool_calls").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        if calls.is_empty() {
            let text = msg.get("content").and_then(|c| c.as_str()).unwrap_or("").trim().to_string();
            answer = Some(if text.is_empty() { if en { "(no answer)".into() } else { "(pas de réponse)".into() } } else { text });
            break;
        }
        messages.push(msg.clone());
        for call in calls {
            let name = call.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let raw = call.pointer("/function/arguments").cloned().unwrap_or(json!({}));
            let args = match &raw {
                Value::String(s) => serde_json::from_str(s).unwrap_or(json!({})),
                other => other.clone(),
            };
            if cfg.show_tool_calls {
                trace.push(tg::truncate(&tg::format_call(&name, &args), 160));
                if !placeholder.is_empty() {
                    let live = format!("{}\n{}", if en { "_Working…_" } else { "_Au travail…_" }, trace.iter().map(|l| format!("> {}", escape(l))).collect::<Vec<_>>().join("\n"));
                    let _ = update(token, &at.channel, &placeholder, &live).await;
                }
            }
            let result = tg::exec_tool_to(app, &tgc, &dest, &name, &args).await;
            let mut tool_msg = json!({ "role": "tool", "name": name, "content": tg::truncate(&result, 4000) });
            if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                tool_msg["tool_call_id"] = json!(id);
            }
            messages.push(tool_msg);
        }
    }
    let answer = answer.unwrap_or_else(|| {
        if en { "⚠️ Too many steps for this request — try phrasing it more simply.".into() } else { "⚠️ Trop d'étapes pour cette demande — reformule-la plus simplement.".into() }
    });
    if !answer.starts_with("⚠️") {
        remember(state, &at.key(), prompt, &answer).await;
    }
    let clean = redact(app, cfg, &answer);
    let mut body = to_mrkdwn(&clean);
    if !trace.is_empty() {
        let quoted = trace.iter().map(|l| format!("> {}", escape(l))).collect::<Vec<_>>().join("\n");
        body = format!("{quoted}\n\n{body}");
    }
    // Réponse longue : le provisoire devient le premier morceau, la suite part
    // en messages ordinaires.
    let parts = chunks(&body);
    let mut rest = parts.iter();
    let replaced = match (placeholder.is_empty(), rest.next()) {
        (false, Some(first)) => update(token, &at.channel, &placeholder, first).await.is_ok(),
        _ => false,
    };
    if !replaced {
        let _ = post(token, &at.channel, &at.thread_ts, &body, None).await;
    } else {
        for p in rest {
            let _ = post(token, &at.channel, &at.thread_ts, p, None).await;
        }
    }
    log_turn(app, at, "lumen", &clean);
    react(token, &at.channel, &at.msg_ts, "eyes", false).await;
    react(token, &at.channel, &at.msg_ts, "white_check_mark", true).await;
}

async fn remember(state: &SlackState, key: &str, user: &str, assistant: &str) {
    let mut sessions = state.sessions.lock().await;
    let s = sessions.entry(key.to_string()).or_default();
    s.history.push(json!({ "role": "user", "content": user }));
    s.history.push(json!({ "role": "assistant", "content": assistant }));
    let len = s.history.len();
    if len > HISTORY_MAX {
        s.history.drain(0..len - HISTORY_MAX);
    }
}

fn chat_prompt(en: bool) -> &'static str {
    if en {
        "You are Lumen, the user's personal assistant, reached from Slack.\n\
         Reply in their language, naturally and briefly. Slack formatting: *bold*, bullet lists, `code`.\n\
         Never quote a token, key or password."
    } else {
        "Tu es Lumen, l'assistant personnel de l'utilisateur, qui t'écrit depuis Slack.\n\
         Réponds dans sa langue, naturellement et brièvement. Mise en forme Slack : *gras*, listes à puces, `code`.\n\
         Ne cite jamais de jeton, clé ni mot de passe."
    }
}

fn tool_prompt(en: bool) -> &'static str {
    if en {
        "You are Lumen, the user's personal assistant, reached from Slack.\n\
         You have tools that really act on their machine: call them when useful, and report what they actually returned, never inventing a result.\n\
         Then answer briefly in the user's language (Slack formatting: *bold*, bullet lists).\n\
         Never reveal a token, key or password."
    } else {
        "Tu es Lumen, l'assistant personnel de l'utilisateur, joint depuis Slack.\n\
         Tu as des outils qui agissent vraiment sur sa machine : appelle-les quand ils sont utiles, et rapporte ce qu'ils ont renvoyé, sans jamais inventer de résultat.\n\
         Réponds ensuite brièvement dans la langue de l'utilisateur (mise en forme Slack : *gras*, listes à puces).\n\
         Ne révèle jamais de jeton, de clé ni de mot de passe."
    }
}

// ===================== Agents =====================

/// Émoji Slack de la couleur de l'avatar (cf. `AVATAR_COLORS` dans
/// src/lib/agent-avatar.js — même table, même défaut).
fn agent_emoji(agent: &crate::agents::Agent) -> String {
    let color = if agent.avatar.color.is_empty() {
        // Même tirage déterministe que le front (FNV-1a 32 bits sur l'id).
        let mut h: u32 = 2166136261;
        for ch in (if agent.id.is_empty() { &agent.name } else { &agent.id }).chars() {
            h ^= ch as u32;
            h = h.wrapping_mul(16777619);
        }
        ["blue", "purple", "pink", "red", "yellow", "green"][(h % 6) as usize].to_string()
    } else {
        agent.avatar.color.clone()
    };
    match color.as_str() {
        "purple" => ":large_purple_circle:",
        "pink" => ":cherry_blossom:",
        "red" => ":red_circle:",
        "yellow" => ":large_yellow_circle:",
        "green" => ":large_green_circle:",
        _ => ":large_blue_circle:",
    }
    .to_string()
}

/// « Nom : tâche », « Nom, tâche » ou « @Nom tâche » en tête de message.
fn agent_prefix(text: &str, agents: &[crate::agents::Agent]) -> Option<(crate::agents::Agent, String)> {
    let t = text.trim();
    let low = t.to_lowercase();
    let mut best: Option<(&crate::agents::Agent, usize)> = None;
    for a in agents {
        let name = a.name.trim().to_lowercase();
        if name.is_empty() {
            continue;
        }
        for lead in [format!("@{name}"), name.clone()] {
            if let Some(rest) = low.strip_prefix(&lead) {
                // « Nom: », « Nom : » (typographie française), « Nom, » ou
                // « @Nom tâche ».
                let after = rest.trim_start();
                let ok = after.starts_with(':')
                    || after.starts_with(',')
                    || (lead.starts_with('@') && rest.starts_with(char::is_whitespace));
                if ok && best.map(|(_, n)| lead.len() > n).unwrap_or(true) {
                    best = Some((a, lead.len()));
                }
            }
        }
    }
    let (agent, n) = best?;
    // Découpe sur la chaîne d'origine : `to_lowercase` peut changer la longueur
    // en octets, on repart donc du nombre de caractères.
    let chars = t.chars().count().min(low[..n].chars().count());
    let rest: String = t.chars().skip(chars).collect();
    let task = rest.trim_start().trim_start_matches([':', ',']).trim().to_string();
    (!task.is_empty()).then(|| (agent.clone(), task))
}

async fn run_agent(app: &tauri::AppHandle, cfg: &SlackConfig, at: &Where, agent: &crate::agents::Agent, task: &str) {
    let en = tg::is_en(app);
    let persona = cfg.agent_personas.then(|| Persona { name: agent.name.clone(), emoji: agent_emoji(agent) });
    let token = cfg.bot_token.as_str();
    react(token, &at.channel, &at.msg_ts, "eyes", true).await;
    let hello = if en { format!("On it: _{}_", escape(&tg::truncate(task, 200))) } else { format!("Je m'en occupe : _{}_", escape(&tg::truncate(task, 200))) };
    let hello = if persona.is_some() { hello } else { format!("🤖 *{}* — {hello}", escape(&agent.name)) };
    let _ = post(token, &at.channel, &at.thread_ts, &hello, persona.as_ref()).await;
    let args = json!({ "agent": agent.name, "task": task });
    let dest = Dest::Slack { channel: at.channel.clone(), thread_ts: at.thread_ts.clone() };
    let report = tg::exec_tool_to(app, &cfg.as_tg(), &dest, "lumen_agent_task", &args).await;
    let report = if persona.is_some() { report } else { format!("**{}** : {report}", agent.name) };
    say(app, cfg, at, &report, persona.as_ref()).await;
    react(token, &at.channel, &at.msg_ts, "eyes", false).await;
    react(token, &at.channel, &at.msg_ts, "white_check_mark", true).await;
}

async fn image(app: &tauri::AppHandle, cfg: &SlackConfig, at: &Where, prompt: &str) {
    let en = tg::is_en(app);
    let token = cfg.bot_token.as_str();
    let _ = post(token, &at.channel, &at.thread_ts, if en { "🎨 Generating the image…" } else { "🎨 Génération de l'image…" }, None).await;
    match tg::image_bytes(app, &cfg.as_tg(), prompt).await {
        Ok(bytes) => {
            if let Err(e) = upload_file(app, &at.channel, &at.thread_ts, bytes, "lumen.png", &tg::truncate(prompt, 200)).await {
                say(app, cfg, at, &format!("⚠️ {e}"), None).await;
            }
        }
        Err(e) => say(app, cfg, at, &format!("⚠️ {e}"), None).await,
    }
}

// ===================== Commandes (sans LLM) =====================

fn help(app: &tauri::AppHandle, cfg: &SlackConfig, en: bool) -> String {
    let _ = app;
    let agents = if cfg.allow_agents {
        if en { "\n• `Agent name: task` — hand a task to one of your agents (it answers under its own name)" } else { "\n• `Nom de l'agent : tâche` — confier une tâche à l'un de tes agents (il répond en son nom)" }
    } else {
        ""
    };
    if en {
        format!("*What I can do*\n• Write to me normally: I use Lumen's tools, memory and documents.{agents}\n• `!status` — engine, mode, capabilities\n• `!mode tools|chat|agent|image` — how I handle messages\n• `!backend lumen|ollama|api|llama [model]`\n• `!agents` — your agents\n• `!image <description>`\n• `!reset` — forget this conversation\n• `!stop` — revoke your access\nThe same commands work with `/lumen …`.")
    } else {
        format!("*Ce que je sais faire*\n• Écris-moi normalement : j'utilise les outils, la mémoire et les documents de Lumen.{agents}\n• `!etat` — moteur, mode, capacités\n• `!mode outils|chat|agent|image` — façon de traiter les messages\n• `!backend lumen|ollama|api|llama [modèle]`\n• `!agents` — tes agents\n• `!image <description>`\n• `!oubli` — oublier cette conversation\n• `!stop` — révoquer ton accès\nLes mêmes commandes marchent avec `/lumen …`.")
    }
}

async fn command(app: &tauri::AppHandle, state: &SlackState, at: &Where, cmd: &str) -> Option<String> {
    let en = tg::is_en(app);
    let mut parts = cmd.trim().splitn(2, char::is_whitespace);
    let verb = parts.next().unwrap_or("").to_lowercase();
    let arg = parts.next().unwrap_or("").trim().to_string();
    let mut cfg = read_config(app);
    let onoff = |b: bool| if b { "✅" } else { "—" };
    Some(match verb.as_str() {
        "aide" | "help" | "" => help(app, &cfg, en),
        "etat" | "état" | "status" => {
            let model = tg::model_for(&cfg.as_tg(), &cfg.backend);
            let model = if model.is_empty() { if en { "Lumen's Settings".to_string() } else { "celui des Réglages".to_string() } } else { model };
            if en {
                format!("*Status*\n• Engine: `{}` · model: `{}`\n• Mode: `{}`\n• Tools {} · Agents {} · Images {} · Agent personas {}", cfg.backend, model, cfg.mode, onoff(cfg.allow_tools), onoff(cfg.allow_agents), onoff(cfg.allow_images), onoff(cfg.agent_personas))
            } else {
                format!("*État*\n• Moteur : `{}` · modèle : `{}`\n• Mode : `{}`\n• Outils {} · Agents {} · Images {} · Agents en personne {}", cfg.backend, model, cfg.mode, onoff(cfg.allow_tools), onoff(cfg.allow_agents), onoff(cfg.allow_images), onoff(cfg.agent_personas))
            }
        }
        "mode" => {
            if arg.is_empty() {
                let list = tg::modes(en).iter().map(|(m, d)| format!("• `{m}` — {d}")).collect::<Vec<_>>().join("\n");
                return Some(format!("{} `{}`\n{list}", if en { "Current mode:" } else { "Mode actuel :" }, cfg.mode));
            }
            let raw = match arg.to_lowercase().as_str() {
                "outils" => "tools".to_string(),
                "discussion" => "chat".to_string(),
                other => other.to_string(),
            };
            match tg::normalize_mode(&raw) {
                Some(m) => {
                    cfg.mode = m.clone();
                    let _ = write_config(app, &cfg);
                    let _ = app.emit("slack-updated", ());
                    if en { format!("Mode: `{m}`") } else { format!("Mode : `{m}`") }
                }
                None => if en { "Unknown mode — `!mode` lists them.".into() } else { "Mode inconnu — `!mode` les liste.".into() },
            }
        }
        "backend" | "moteur" => {
            let mut it = arg.split_whitespace();
            let Some(b) = it.next().and_then(|b| tg::normalize_backend(&b.to_lowercase())) else {
                return Some(if en { "Usage: `!backend lumen|ollama|api|llama [model]`".into() } else { "Usage : `!backend lumen|ollama|api|llama [modèle]`".into() });
            };
            cfg.backend = b.to_string();
            if let Some(m) = it.next() {
                match b {
                    "api" => cfg.api_model = m.to_string(),
                    "llama" => cfg.llama_model = m.to_string(),
                    "applefm" => cfg.applefm_model = m.to_string(),
                    "ollama" => cfg.model = m.to_string(),
                    _ => {}
                }
            }
            let _ = write_config(app, &cfg);
            let _ = app.emit("slack-updated", ());
            if en { format!("Engine: `{b}`") } else { format!("Moteur : `{b}`") }
        }
        "modele" | "modèle" | "model" => {
            if arg.is_empty() {
                return Some(format!("`{}`", tg::model_for(&cfg.as_tg(), &cfg.backend)));
            }
            match cfg.backend.as_str() {
                "api" => cfg.api_model = arg.clone(),
                "llama" => cfg.llama_model = arg.clone(),
                "applefm" => cfg.applefm_model = arg.clone(),
                _ => cfg.model = arg.clone(),
            }
            let _ = write_config(app, &cfg);
            let _ = app.emit("slack-updated", ());
            if en { format!("Model: `{arg}`") } else { format!("Modèle : `{arg}`") }
        }
        "agents" => {
            let list = crate::agents::agent_list(app.clone());
            if list.is_empty() {
                if en { "No agent yet — create one in Lumen's Agents app.".into() } else { "Aucun agent — crée-en un dans l'app Agents de Lumen.".into() }
            } else {
                let lines = list
                    .iter()
                    .map(|a| format!("{} *{}* — {}", agent_emoji(a), escape(&a.name), escape(&tg::truncate(if a.description.is_empty() { &a.instruction } else { &a.description }, 90))))
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("{lines}\n\n{}", if en { "_Write `Agent name: task` to hand one a task._" } else { "_Écris `Nom de l'agent : tâche` pour lui confier une tâche._" })
            }
        }
        "agent" => {
            if !cfg.allow_agents {
                return Some(if en { "Agent tasks are disabled in Lumen's Settings.".into() } else { "Les tâches d'agent sont désactivées dans les Réglages de Lumen.".into() });
            }
            let agents = crate::agents::agent_list(app.clone());
            let found = agent_prefix(&format!("@{arg}"), &agents).or_else(|| agent_prefix(&arg, &agents));
            match found {
                Some((agent, task)) => {
                    run_agent(app, &cfg, at, &agent, &task).await;
                    String::new()
                }
                None => if en { "Usage: `!agent <name> <task>` — see `!agents`.".into() } else { "Usage : `!agent <nom> <tâche>` — voir `!agents`.".into() },
            }
        }
        "image" if cfg.allow_images => {
            if arg.is_empty() {
                return Some(if en { "Usage: `!image <description>`".into() } else { "Usage : `!image <description>`".into() });
            }
            image(app, &cfg, at, &arg).await;
            String::new()
        }
        "oubli" | "reset" => {
            state.sessions.lock().await.remove(&at.key());
            if en { "History of this conversation cleared.".into() } else { "Historique de cette conversation effacé.".into() }
        }
        "stop" => {
            cfg.users.retain(|u| u.id != at.user);
            let _ = write_config(app, &cfg);
            let _ = app.emit("slack-updated", ());
            if en { "Access revoked. Ask for a new pairing code in Lumen to come back.".into() } else { "Accès révoqué. Demande un nouveau code d'appairage dans Lumen pour revenir.".into() }
        }
        _ => return None,
    })
}

// ===================== Journal visible dans Lumen =====================

#[derive(Serialize, Deserialize, Clone, Default)]
struct Thread {
    #[serde(default)]
    channel: String,
    #[serde(default)]
    thread_ts: String,
    #[serde(default)]
    user: String,
    #[serde(default)]
    turns: Vec<Value>,
    #[serde(default)]
    updated: u64,
}

static THREAD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn threads_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(profile_dir(app)?.join("slack_threads.json"))
}

fn read_threads(app: &tauri::AppHandle) -> HashMap<String, Thread> {
    threads_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn log_turn(app: &tauri::AppHandle, at: &Where, role: &str, text: &str) {
    let _guard = THREAD_LOCK.lock();
    let mut all = read_threads(app);
    let t = all.entry(at.key()).or_default();
    t.channel = at.channel.clone();
    t.thread_ts = at.thread_ts.clone();
    if t.user.is_empty() {
        t.user = at.user.clone();
    }
    t.turns.push(json!({ "role": role, "text": tg::truncate(text, 4000), "ts": now_secs() }));
    let n = t.turns.len();
    if n > 200 {
        t.turns.drain(0..n - 200);
    }
    t.updated = now_secs();
    if let (Ok(p), Ok(body)) = (threads_path(app), serde_json::to_string(&all)) {
        let _ = write_private(&p, &body);
    }
    let _ = app.emit("slack-thread-updated", json!({ "key": at.key() }));
}

// ===================== Commandes Tauri =====================

#[tauri::command]
pub fn slack_status(app: tauri::AppHandle, state: tauri::State<'_, SlackState>) -> Value {
    let cfg = read_config(&app);
    let st = state.status.lock().map(|s| s.clone()).unwrap_or_default();
    let en = tg::is_en(&app);
    json!({
        "botConfigured": !cfg.bot_token.is_empty(),
        "appConfigured": !cfg.app_token.is_empty(),
        "botHint": mask(&cfg.bot_token),
        "appHint": mask(&cfg.app_token),
        "enabled": cfg.enabled,
        "running": st.running,
        "team": st.team,
        "botName": st.bot_name,
        "lastError": st.last_error,
        "lastEvent": st.last_event,
        "rejected": st.rejected,
        "users": cfg.users,
        "backend": cfg.backend,
        "model": tg::model_for(&cfg.as_tg(), &cfg.backend),
        "mode": cfg.mode,
        "allowTools": cfg.allow_tools,
        "allowAgents": cfg.allow_agents,
        "allowImages": cfg.allow_images,
        "showToolCalls": cfg.show_tool_calls,
        "agentPersonas": cfg.agent_personas,
        "channels": cfg.channels,
        "imageProvider": cfg.image_provider,
        "imageModel": cfg.image_model,
        "pairCode": if cfg.pair_expires > now_secs() { cfg.pair_code.clone() } else { String::new() },
        "pairExpiresIn": cfg.pair_expires.saturating_sub(now_secs()),
        "manifest": serde_json::to_string_pretty(&manifest(en)).unwrap_or_default(),
    })
}

/// Enregistre les jetons (champ vide ⇒ inchangé). Ne renvoie jamais un jeton.
#[tauri::command]
pub async fn slack_set_tokens(
    app: tauri::AppHandle,
    state: tauri::State<'_, SlackState>,
    bot_token: Option<String>,
    app_token: Option<String>,
) -> Result<(), String> {
    let mut cfg = read_config(&app);
    if let Some(t) = bot_token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        if !valid_token(&t, "xoxb-") {
            return Err("Jeton de bot invalide (format attendu : xoxb-…).".into());
        }
        cfg.bot_token = t;
    }
    if let Some(t) = app_token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        if !valid_token(&t, "xapp-") {
            return Err("Jeton d'app invalide (format attendu : xapp-…).".into());
        }
        cfg.app_token = t;
    }
    write_config(&app, &cfg)?;
    if cfg.enabled {
        let inner = state.inner().clone();
        stop(&inner);
        if let Err(e) = start(app, inner.clone()).await {
            inner.set_status(|st| st.last_error = e);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn slack_clear_tokens(app: tauri::AppHandle, state: tauri::State<'_, SlackState>) -> Result<(), String> {
    let mut cfg = read_config(&app);
    cfg.bot_token = String::new();
    cfg.app_token = String::new();
    cfg.enabled = false;
    write_config(&app, &cfg)?;
    stop(state.inner());
    Ok(())
}

#[tauri::command]
pub async fn slack_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, SlackState>,
    enabled: bool,
) -> Result<(), String> {
    let mut cfg = read_config(&app);
    cfg.enabled = enabled;
    write_config(&app, &cfg)?;
    let inner = state.inner().clone();
    stop(&inner);
    if enabled {
        start(app, inner).await
    } else {
        Ok(())
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn slack_set_options(
    app: tauri::AppHandle,
    backend: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    allow_tools: Option<bool>,
    allow_agents: Option<bool>,
    allow_images: Option<bool>,
    show_tool_calls: Option<bool>,
    agent_personas: Option<bool>,
    channels: Option<bool>,
    image_provider: Option<String>,
    image_model: Option<String>,
) -> Result<(), String> {
    let mut cfg = read_config(&app);
    if let Some(b) = backend.as_deref().and_then(tg::normalize_backend) {
        cfg.backend = b.to_string();
    }
    if let Some(m) = model {
        let m = m.trim().to_string();
        match cfg.backend.as_str() {
            "api" => cfg.api_model = m,
            "llama" => cfg.llama_model = m,
            "applefm" => cfg.applefm_model = m,
            _ => cfg.model = m,
        }
    }
    if let Some(m) = mode.as_deref().and_then(tg::normalize_mode) {
        cfg.mode = m;
    }
    if let Some(v) = allow_tools {
        cfg.allow_tools = v;
    }
    if let Some(v) = allow_agents {
        cfg.allow_agents = v;
    }
    if let Some(v) = allow_images {
        cfg.allow_images = v;
    }
    if let Some(v) = show_tool_calls {
        cfg.show_tool_calls = v;
    }
    if let Some(v) = agent_personas {
        cfg.agent_personas = v;
    }
    if let Some(v) = channels {
        cfg.channels = v;
    }
    if let Some(p) = image_provider {
        if ["bonsai", "ollama", "openai"].contains(&p.as_str()) {
            cfg.image_provider = p;
        }
    }
    if let Some(m) = image_model {
        cfg.image_model = m.trim().to_string();
    }
    write_config(&app, &cfg)
}

#[tauri::command]
pub fn slack_new_pair_code(app: tauri::AppHandle) -> Result<Value, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut raw = [0u8; 10];
    getrandom::getrandom(&mut raw).map_err(|_| "source d'entropie indisponible")?;
    let code: String = raw.iter().map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect();
    let mut cfg = read_config(&app);
    cfg.pair_code = code.clone();
    cfg.pair_expires = now_secs() + PAIR_TTL;
    cfg.pair_fails = 0;
    write_config(&app, &cfg)?;
    Ok(json!({ "code": code, "expiresIn": PAIR_TTL }))
}

#[tauri::command]
pub fn slack_revoke_user(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    let mut cfg = read_config(&app);
    cfg.users.retain(|u| u.id != user_id);
    write_config(&app, &cfg)
}

/// Message de test, en privé, à chaque utilisateur appairé.
#[tauri::command]
pub async fn slack_test(app: tauri::AppHandle) -> Result<usize, String> {
    let cfg = read_config(&app);
    if !valid_token(&cfg.bot_token, "xoxb-") {
        return Err("Aucun jeton de bot configuré.".into());
    }
    if cfg.users.is_empty() {
        return Err("Aucun utilisateur appairé.".into());
    }
    let msg = if tg::is_en(&app) { "🔔 Test from Lumen: the Slack gateway works." } else { "🔔 Test depuis Lumen : la passerelle Slack fonctionne." };
    let mut sent = 0;
    for u in &cfg.users {
        let open = call(&cfg.bot_token, "conversations.open", json!({ "users": u.id })).await?;
        if let Some(ch) = open.pointer("/channel/id").and_then(|x| x.as_str()) {
            post(&cfg.bot_token, ch, "", msg, None).await?;
            sent += 1;
        }
    }
    Ok(sent)
}

/// Conversations Slack journalisées (les plus récentes d'abord).
#[tauri::command]
pub fn slack_threads(app: tauri::AppHandle) -> Vec<Value> {
    let cfg = read_config(&app);
    let mut list: Vec<(String, Thread)> = read_threads(&app).into_iter().collect();
    list.sort_by(|a, b| b.1.updated.cmp(&a.1.updated));
    list.into_iter()
        .map(|(key, t)| {
            let name = cfg.users.iter().find(|u| u.id == t.user).map(|u| u.name.clone()).unwrap_or_default();
            json!({
                "key": key,
                "channel": t.channel,
                "threadTs": t.thread_ts,
                "user": name,
                "updated": t.updated,
                "count": t.turns.len(),
                "last": t.turns.last().and_then(|x| x.get("text")).cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

#[tauri::command]
pub fn slack_thread(app: tauri::AppHandle, key: String) -> Vec<Value> {
    read_threads(&app).remove(&key).map(|t| t.turns).unwrap_or_default()
}

// ===================== Cycle de vie =====================

/// Changement de profil de session : jetons, liste blanche et historique
/// appartenaient au profil précédent.
pub fn on_profile_switch(app: &tauri::AppHandle) {
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app2.state::<SlackState>().inner().clone();
        stop(&state);
        state.sessions.lock().await.clear();
        state.set_status(|st| *st = RunStatus::default());
        let _ = app2.emit("slack-updated", ());
        if read_config(&app2).enabled {
            if let Err(e) = start(app2.clone(), state.clone()).await {
                state.set_status(|st| st.last_error = e);
            }
        }
    });
}

pub fn autostart(app: &tauri::AppHandle) {
    let cfg = read_config(app);
    if !cfg.enabled || !valid_token(&cfg.bot_token, "xoxb-") || !valid_token(&cfg.app_token, "xapp-") {
        return;
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app2.state::<SlackState>().inner().clone();
        if let Err(e) = start(app2.clone(), state.clone()).await {
            state.set_status(|st| st.last_error = e);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_sortie_du_modele_ne_peut_pas_mentionner_tout_le_canal() {
        let out = to_mrkdwn("Salut <!channel> et <@U123>");
        assert!(!out.contains("<!channel>"));
        assert!(!out.contains("<@U123>"));
    }

    #[test]
    fn markdown_converti_pour_slack() {
        assert_eq!(to_mrkdwn("## Titre\n**gras**"), "*Titre*\n*gras*");
        assert_eq!(to_mrkdwn("voir [doc](https://ex.com/a)"), "voir <https://ex.com/a|doc>");
        // Seuls les liens http(s) deviennent cliquables.
        assert_eq!(to_mrkdwn("[x](javascript:alert)"), "[x](javascript:alert)");
    }

    #[test]
    fn code_d_appairage_reconnu() {
        assert_eq!(pair_code_in("!appairer abcd1234"), Some("ABCD1234".into()));
        assert_eq!(pair_code_in("pair XYZ"), Some("XYZ".into()));
        assert_eq!(pair_code_in("bonjour"), None);
    }

    #[test]
    fn nom_d_agent_en_tete() {
        let a: crate::agents::Agent = serde_json::from_value(json!({ "id": "a1", "name": "Veilleur web" })).unwrap();
        let list = vec![a];
        assert_eq!(agent_prefix("Veilleur web : la revue", &list).map(|x| x.1), Some("la revue".into()));
        assert_eq!(agent_prefix("@veilleur web fais ça", &list).map(|x| x.1), Some("fais ça".into()));
        assert!(agent_prefix("Veilleur webcam", &list).is_none());
    }

    #[test]
    fn jetons_valides() {
        assert!(valid_token(concat!("xoxb-", "example-token-for-tests"), "xoxb-"));
        assert!(!valid_token("xapp-1234567890-abcdefghijkl", "xoxb-"));
        assert!(!valid_token("xoxb-12 34", "xoxb-"));
    }
}
